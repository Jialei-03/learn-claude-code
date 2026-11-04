// 第 8 章：MCP 客户端。把别人写的服务器变成 Toolset 能直接用的工具。
//
// 对应 Claude Code 2.1.88 里的几处（路径相对于 restored-src/src/）：
//   services/mcp/config.ts、utils.ts      配置有几个来源、怎么合并；项目里的 .mcp.json 要先批准   → resolveMcpConfig
//   services/mcp/client.ts connectToServer  启动传输、握手（有超时）；失败返回 failed，不抛异常      → connectMcp / connectMcpServers
//   services/mcp/client.ts fetchToolsForClient  tools/list → 清洗 → 起名字 → 包装成 Tool           → wrapTool
//   services/mcp/client.ts callMCPTool      tools/call：超时、取消、进度；isError 变成异常            → wrapTool 里的 execute
//   services/mcp/client.ts processMCPResult 结果转换：structuredContent 优先；太大就存成文件         → convertResult
//   services/mcp/client.ts cleanup          退出时 SIGINT → SIGTERM → SIGKILL（在 runtime/rpc.mjs）   → close
//   services/mcp/normalization.ts、mcpStringUtils.ts  mcp__服务器__工具 这个名字怎么来的、怎么拆回去  → mcpToolName / parseMcpToolName
//
// 一个 MCP 工具被包装成和 Read、Edit 一样的普通工具对象（name / description / schema / validate / execute），
// 所以它自动经过第 3 章的流水线、第 6 章的权限、第 7 章的 Hook，不需要任何旁路。
//
// 和原版相比的简化：
//   · 只有 stdio 传输，也没有 OAuth、断线重连（原版对 stdio 也不重连：进程退出就标成 failed）；
//   · 只处理 tools。原版还把 prompts 变成斜杠命令、把 resources 变成两个辅助工具；
//   · 没有工具搜索（推迟加载）：原版默认只把 MCP 工具的名字告诉模型，需要时再加载定义（正文“工具太多怎么办”一节）；
//   · 结果里的图片不交给模型，换成一行占位文字（coda 的工具结果只有文本）；
//   · “结果太大”用字符数除以 4 估算 token。原版超过一半阈值后，还会调用 API 数准确的 token 数；
//   · 工具参数不在本地按 JSON Schema 校验，只检查是个对象——原版也是这样，校验交给服务器。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StdioRpc } from "../../runtime/rpc.mjs";

const CONNECT_TIMEOUT_MS = 30_000; //          握手最多等多久（原版：环境变量 MCP_TIMEOUT，缺省 30 秒）
const TOOL_TIMEOUT_MS = 100_000_000; //        一次工具调用最多等多久（原版：MCP_TOOL_TIMEOUT，缺省约 27.8 小时，等于不设限）
const DESCRIPTION_MAX_CHARS = 2048; //         给模型看的描述最长多少（原版同样是 2048，工具描述和服务器说明都适用）
const MAX_OUTPUT_TOKENS = 25_000; //           一次结果最多多少 token（原版：MAX_MCP_OUTPUT_TOKENS，缺省 25000）
const CHARS_PER_TOKEN = 4; //                  估算用

// ───────────────────────── 名字 ─────────────────────────

// 模型服务商只接受 ^[a-zA-Z0-9_-]{1,64}$ 的工具名，所以不在这个集合里的字符都换成下划线。
// 代价：不同的名字可能被归一化成同一个（两个全中文的工具名都会变成纯下划线）。
export const normalizeMcpName = (name) => String(name).replace(/[^a-zA-Z0-9_-]/g, "_");

// mcp__服务器__工具。前缀的作用有两个：不会和 Read、Bash 这些内置工具重名；两个服务器都有 search 也不冲突。
export const mcpToolName = (server, tool) => `mcp__${normalizeMcpName(server)}__${normalizeMcpName(tool)}`;

// 反过来拆：权限规则 mcp__服务器 或 mcp__服务器__工具 就靠它判断“这个工具属于哪个服务器”。
// 已知的局限（原版的注释里也写了）：服务器名本身带 "__" 就会拆错，因为分隔符和名字里的下划线分不开。
export function parseMcpToolName(name) {
  const [prefix, server, ...rest] = name.split("__");
  if (prefix !== "mcp" || !server) return null;
  return { server, tool: rest.length ? rest.join("__") : undefined };
}

// ───────────────────────── 清洗 ─────────────────────────

// 工具的名字、描述、参数说明都会原样进入模型的上下文，而它们是服务器作者写的。
// “ASCII 走私”把一句指令编码成 Unicode 标签字符（U+E0000 区）藏在描述里：用户看不见，模型却读得懂。
// 办法：NFKC 归一化，再删掉格式字符（Cf，含标签字符和方向控制）、私用区（Co）、未分配码点（Cn）。
// 反复做到不再变化为止，因为归一化可能把“看不见的组合”变成新的可清除字符。
export function sanitizeUnicode(value) {
  if (typeof value === "string") {
    let current = value;
    for (let round = 0; round < 10; round++) {
      const next = current.normalize("NFKC").replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "");
      if (next === current) break;
      current = next;
    }
    return current;
  }
  if (Array.isArray(value)) return value.map(sanitizeUnicode);
  if (value && typeof value === "object") {
    // 键也要清洗：属性名同样会进入模型的上下文
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitizeUnicode(k), sanitizeUnicode(v)]));
  }
  return value;
}

const limitText = (text, max = DESCRIPTION_MAX_CHARS) =>
  text.length > max ? `${text.slice(0, max)}… [truncated]` : text;

// ───────────────────────── 结果 ─────────────────────────

// 工具自己报告的失败（isError: true）。Claude Code 把它当异常抛出，所以走的是“call 抛错”那条失败出口：
// 模型收到 is_error 的结果。服务器没说原因就是 "Unknown error"。
export class McpToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpToolError";
  }
}

// 一个内容块变成给模型看的文字。
function blockText(block, server) {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `[image ${block.mimeType ?? "unknown"} from ${server}: coda 的工具结果只有文本，图片没有交给模型]`;
    case "audio":
      return `[audio ${block.mimeType ?? "unknown"} from ${server} omitted]`;
    case "resource_link":
      return `[Resource link: ${block.name}] ${block.uri}${block.description ? ` (${block.description})` : ""}`;
    case "resource": {
      const { uri, text, mimeType } = block.resource ?? {};
      const prefix = `[Resource from ${server} at ${uri}]`;
      return text !== undefined ? `${prefix} ${text}` : `${prefix} (binary ${mimeType ?? "unknown"} omitted)`;
    }
    default:
      return undefined;
  }
}

// MCP 的 CallToolResult → 给模型的文本。三个来源，按这个顺序取第一个有的：
//   structuredContent   有它就用它（序列化成 JSON），哪怕同时有 content。这是 Claude Code 的选择，Pi 正好相反
//   content 数组        逐块转成文字
//   都没有              服务器返回的形状不对，报错
// isError 单独处理：错误信息只取第一个内容块的文字，没有就是 "Unknown error"。
// 太大的结果不塞进上下文：整体存成文件，告诉模型路径和怎么读；没有目录可存时退而求其次，截断并说明。
export function convertResult(result, { server = "mcp", tool = "tool", maxOutputTokens = MAX_OUTPUT_TOKENS, resultDir } = {}) {
  if (result?.isError) {
    const first = result.content?.[0];
    throw new McpToolError(first && typeof first.text === "string" ? first.text : "Unknown error");
  }

  let text;
  let format;
  if (result?.structuredContent !== undefined) {
    text = JSON.stringify(result.structuredContent);
    format = "JSON";
  } else if (Array.isArray(result?.content)) {
    text = result.content.map((block) => blockText(block, server)).filter((part) => part !== undefined).join("\n");
    format = "text";
  } else {
    throw new McpToolError(`MCP server "${server}" tool "${tool}": unexpected response format`);
  }

  const estimatedTokens = Math.round(text.length / CHARS_PER_TOKEN);
  const details = { server, tool, structuredContent: result.structuredContent };
  if (estimatedTokens <= maxOutputTokens) return { text, details };

  if (!resultDir) {
    const kept = text.slice(0, maxOutputTokens * CHARS_PER_TOKEN);
    return {
      text: `${kept}\n\n[OUTPUT TRUNCATED: 超过 ${maxOutputTokens} token 的上限，没有目录可以存放完整结果]`,
      details: { ...details, truncated: true },
    };
  }
  mkdirSync(resultDir, { recursive: true });
  const file = join(resultDir, `mcp-${normalizeMcpName(server)}-${normalizeMcpName(tool)}-${Date.now()}.txt`);
  writeFileSync(file, text);
  return {
    text:
      `Error: result (${text.length.toLocaleString()} characters) exceeds maximum allowed tokens. Saved to ${file}\n` +
      `Format: ${format}\n` +
      `Read the file in chunks (offset / limit) or search it; do not summarize before you have read all of it.`,
    details: { ...details, persistedPath: file },
  };
}

// ───────────────────────── 工具 ─────────────────────────

// tools/list 的一项 → Toolset 能用的工具对象。
function wrapTool(spec, { server, peer, toolTimeout, maxOutputTokens, resultDir }) {
  const name = server === undefined ? `mcp__${spec.name}` : mcpToolName(server, spec.name);
  return {
    name,
    description: limitText(spec.description ?? ""),
    schema: spec.inputSchema ?? { type: "object", properties: {} },
    // 服务器说自己只读，这一次调用就能和相邻的只读调用并行（第 3 章的 partition 看的是这个字段）。
    // 注意只给 parallel，不给 readOnly：readOnly 会让权限层直接放行，而注解是服务器自己声称的，不可信。
    parallel: spec.annotations?.readOnlyHint === true,
    // 原版给 MCP 工具的本地校验只有“是个对象”（z.object({}).passthrough()），参数对不对由服务器判断。
    // 好处是不会把服务器的校验规则复制一份并过时；代价是参数错误要走一趟服务器才发现，Hook 也会先看到这个错误的调用。
    validate(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw Error("MCP tool input must be an object");
    },
    async execute(input, context = {}) {
      const result = await peer.request(
        "tools/call",
        { name: spec.name, arguments: input },
        {
          signal: context.signal,
          timeout: toolTimeout,
          // 带上进度令牌；服务器报告进度时，作为事件交给界面（原版显示成 mcp_progress）
          onProgress: (progress) => context.emit?.({ type: "mcp_progress", server, tool: spec.name, ...progress }),
        },
      );
      const { text, details } = convertResult(result, { server: server ?? "mcp", tool: spec.name, maxOutputTokens, resultDir });
      return { text, details: { ...details, serverTool: spec.name } };
    },
    mcp: { server, tool: spec.name }, // 对应原版的 mcpInfo：知道自己来自哪个服务器的哪个工具
  };
}

// tools/list，沿着 nextCursor 取完。原版 2.1.88 的 fetchToolsForClient 只请求一次，不处理分页；
// 这里按规范取全，同一个游标出现两次说明服务器有问题，直接停下，免得死循环。
async function listTools(peer) {
  const specs = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await peer.request("tools/list", cursor ? { cursor } : {});
    specs.push(...(page.tools ?? []));
    cursor = page.nextCursor || undefined;
    if (cursor && seen.has(cursor)) throw Error(`tools/list returned the same cursor twice: ${cursor}`);
    seen.add(cursor);
  } while (cursor);
  return specs;
}

// ───────────────────────── 连接 ─────────────────────────

// 连接一个 stdio 服务器：启动 → 握手（有超时）→ tools/list → 包装。
//
// options:
//   server          服务器的名字，决定工具名 mcp__<server>__<tool>。不给就沿用旧写法 mcp__<tool>（第 13 章的实验在用）
//   cwd, env        子进程的工作目录和环境变量
//   timeout         普通请求（tools/list 等）默认等多久
//   connectTimeout  握手最多等多久
//   toolTimeout     一次工具调用最多等多久
//   maxOutputTokens, resultDir  结果太大怎么办
//   onToolsChanged  服务器通知“工具列表变了”以后，重新取到新列表时调用 (tools, { added, removed })
//   onFrame         每一条收发的 JSON-RPC 消息（实验用来画时序）
//
// 成功返回 { tools, peer, close, server, instructions, serverInfo }，失败抛出带 stderr 的错误；
// 想要“失败也不抛异常”的行为（原版的 connectToServer），用 connectMcpServers。
export async function connectMcp(command, args = [], options = {}) {
  const {
    server,
    connectTimeout = CONNECT_TIMEOUT_MS,
    toolTimeout = TOOL_TIMEOUT_MS,
    maxOutputTokens,
    resultDir,
    onToolsChanged,
    ...rpcOptions
  } = options;
  const label = server ?? command;
  const peer = new StdioRpc(command, args, rpcOptions);
  try {
    // 握手可能永远等不到回复（服务器卡在启动里）：给它一个期限，到点就放弃并清理进程。
    await peer.initialize({ timeout: connectTimeout }).catch((error) => {
      throw /RPC timeout/.test(error.message)
        ? Error(`MCP server "${label}" connection timed out after ${connectTimeout}ms`)
        : error;
    });
    const context = { server, peer, toolTimeout, maxOutputTokens, resultDir };
    const connection = {
      server,
      peer,
      instructions: peer.instructions ? limitText(peer.instructions) : undefined,
      serverInfo: peer.serverInfo,
      tools: (await listTools(peer)).map((spec) => wrapTool(sanitizeUnicode(spec), context)),
      close: () => peer.close(),
    };
    // 服务器声明了 listChanged 才会发这个通知。收到后重新取一遍，替换整个列表（原版也是整体替换）。
    if (peer.capabilities.tools?.listChanged) {
      peer.onNotification("notifications/tools/list_changed", async () => {
        try {
          const before = new Set(connection.tools.map((tool) => tool.name));
          const tools = (await listTools(peer)).map((spec) => wrapTool(sanitizeUnicode(spec), context));
          const after = new Set(tools.map((tool) => tool.name));
          connection.tools = tools;
          onToolsChanged?.(tools, {
            added: [...after].filter((n) => !before.has(n)),
            removed: [...before].filter((n) => !after.has(n)),
          });
        } catch {
          // 刷新失败就保留旧列表，不影响正在进行的调用
        }
      });
    }
    return connection;
  } catch (error) {
    await peer.close();
    // 连不上时，原因多半在服务器的 stderr 里：带在错误上，调用方决定怎么展示
    throw Object.assign(error, { stderr: peer.stderr.trim(), server: label, pid: peer.child.pid });
  }
}

// 连接一批服务器。对应原版的 getMcpToolsCommandsAndResources：
//   · 被禁用的服务器不启动，只留一条 disabled 记录；
//   · 本地服务器并发启动，但有上限（原版缺省 3 个），免得同时拉起一大堆进程；
//   · 一个服务器失败不影响其他：它变成 failed 记录，错误和 stderr 留着给用户看；永远不抛异常；
//   · 所有工具按名字排序合并——工具顺序稳定，请求前缀才稳定（第 2 章的缓存）；
//   · 归一化后重名的工具只保留第一个，其余记在 skipped 里（原版对工具池做 uniqBy）。
// servers 的形状和 .mcp.json 里的 mcpServers 一样：{ 名字: { command, args, env, cwd, disabled } }
export async function connectMcpServers(servers, { concurrency = 3, ...options } = {}) {
  const entries = Object.entries(servers);
  const records = new Array(entries.length);
  const connections = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex++;
      const [name, config] = entries[index];
      if (config.disabled) {
        records[index] = { name, status: "disabled", tools: 0 };
        continue;
      }
      try {
        const connection = await connectMcp(config.command, config.args ?? [], {
          ...options,
          cwd: config.cwd,
          env: config.env,
          server: name,
        });
        connections.push(connection);
        records[index] = { name, status: "connected", tools: connection.tools.length, instructions: connection.instructions, connection };
      } catch (error) {
        records[index] = { name, status: "failed", tools: 0, error: error.message, stderr: error.stderr ?? "", pid: error.pid };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));

  const tools = [];
  const skipped = [];
  const byName = new Map();
  for (const tool of records.flatMap((record) => record.connection?.tools ?? [])) {
    if (byName.has(tool.name)) skipped.push({ name: tool.name, server: tool.mcp.server, keptFrom: byName.get(tool.name).mcp.server });
    else byName.set(tool.name, tool);
  }
  tools.push(...[...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
  return {
    servers: records.map(({ connection, ...record }) => record),
    tools,
    skipped,
    close: () => Promise.all(connections.map((connection) => connection.close())),
  };
}

// ───────────────────────── 配置 ─────────────────────────

// ${VAR} 和 ${VAR:-默认值}。变量不存在又没有默认值：原样保留，并报告缺了哪些（原版同样不会因此拒绝整个服务器）。
export function expandEnv(text, env = process.env) {
  const missing = [];
  const expanded = text.replace(/\$\{([^}]+)\}/g, (whole, body) => {
    const [name, fallback] = body.split(":-", 2);
    if (env[name] !== undefined) return env[name];
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return whole;
  });
  return { expanded, missing };
}

// 把几个来源的配置合并成最终要连接的服务器。每个来源的形状都是 { mcpServers: { 名字: 配置 } }。
//
// 合并顺序（后面的覆盖前面的同名服务器）：user < project < local < extra。
//   user     用户级，所有项目共用
//   project  项目里的 .mcp.json，提交进仓库，所以是别人写的：克隆一个陌生仓库，它可以让你的机器启动任意命令
//   local    只对你自己、只在当前项目生效
//   extra    命令行 --mcp-config 给的，优先级最高
// 项目服务器要先批准才会生效：approved 里有、approveAll，或者非交互运行（-p / SDK：没法弹窗询问，原版直接视为批准）。
// rejected 里的永远不生效。还没有结论的放进 pending，交互界面据此询问用户。
// strict（--strict-mcp-config）：忽略所有自动发现的来源，只用 extra。
export function resolveMcpConfig(sources, { approved = [], rejected = [], approveAll = false, interactive = true, strict = false, env = process.env } = {}) {
  const errors = [];
  const pending = [];
  const withScope = (scope, file) =>
    Object.entries(file?.mcpServers ?? {}).map(([name, config]) => [name, { ...config, scope }]);

  const projectApproved = ([name]) => {
    const key = normalizeMcpName(name);
    if (rejected.some((n) => normalizeMcpName(n) === key)) return false;
    if (approveAll || !interactive || approved.some((n) => normalizeMcpName(n) === key)) return true;
    pending.push(name);
    return false;
  };

  const layers = strict
    ? [withScope("extra", sources.extra)]
    : [
        withScope("user", sources.user),
        withScope("project", sources.project).filter(projectApproved),
        withScope("local", sources.local),
        withScope("extra", sources.extra),
      ];

  const servers = {};
  for (const [name, config] of layers.flat()) {
    if (typeof config.command !== "string" || !config.command) {
      errors.push({ server: name, message: "缺少 command（coda 只支持 stdio 服务器）" }); // 一项写错，跳过它，不影响其他服务器
      continue;
    }
    const missing = [];
    const expand = (value) => {
      const { expanded, missing: names } = expandEnv(value, env);
      missing.push(...names);
      return expanded;
    };
    const expandedConfig = {
      ...config,
      command: expand(config.command),
      args: (config.args ?? []).map(expand),
      env: config.env && Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, expand(v)])),
    };
    if (missing.length) errors.push({ server: name, message: `Missing environment variables: ${[...new Set(missing)].join(", ")}` });
    servers[name] = expandedConfig; // 同名的后来者覆盖先来者
  }
  return { servers, pending, errors };
}
