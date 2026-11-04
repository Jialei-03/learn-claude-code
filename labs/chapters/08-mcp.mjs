// 第 8 章实验：MCP。十一个小实验，各回答一个问题（大部分用真实的子进程，不用假数据）：
//   config     一个服务器怎么从配置走到“要连接”？谁说了算？
//   names      mcp__服务器__工具 这个名字怎么来的？拆得回去吗？
//   wire       握手到调用，线上到底说了什么？连接是双向的吗？
//   wrap       包装成工具以后，调度器看到什么？服务器的“只读”声明有什么后果？
//   validate   参数错了，谁来拦？Hook 看得到吗？
//   poison     工具描述里藏了肉眼看不见的字符
//   call       一次 tools/call：isError、超时、取消
//   convert    结果怎么变成给模型的文字？太大怎么办？
//   failures   连不上、卡住、中途崩溃
//   shutdown   退出时怎么收拾子进程？
//   deferred   工具太多：推迟加载是怎么记账的？
//
//   node --disable-warning=ExperimentalWarning labs/chapters/08-mcp.mjs            全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/08-mcp.mjs convert    只运行一个
//
// 标着“原函数”的地方，是从固定提交里装载的 Claude Code 真函数，没有改动；只替换它依赖的外部东西（端口），
// 每处都写明替换了什么。
import { lesson, ROOT } from "./harness.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codingTools } from "../../coda/src/files.mjs";
import { Hooks } from "../../coda/src/hooks.mjs";
import { decide } from "../../coda/src/permissions.mjs";
import {
  connectMcp,
  connectMcpServers,
  convertResult,
  mcpToolName,
  parseMcpToolName,
  resolveMcpConfig,
  expandEnv,
  sanitizeUnicode,
} from "../../coda/src/mcp.mjs";
import { Toolset, partition } from "../../coda/src/tools.mjs";
import { StdioRpc } from "../../runtime/rpc.mjs";
import { upstream } from "../engineering/run.mjs";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SERVER = join(ROOT, "labs/ch08/issues-server.mjs"); //     本章的 issue 服务器
const MINIMAL = join(ROOT, "labs/fixtures/mcp-server.mjs"); //   最小的服务器：只有一个 echo 工具
const plain = (value) => JSON.parse(JSON.stringify(value)); //   跨过 vm 的边界：原函数在另一个 realm 里造对象
const short = (text, n = 60) => {
  const line = String(text).replace(/\s+/g, " ");
  return line.length > n ? `${line.slice(0, n)}…` : line;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 原函数里常用的一组小零件，几个实验共用
class TelemetrySafeError extends Error {}
const originalNames = () => {
  // 端口：模块顶部的常量 CLAUDEAI_SERVER_PREFIX（claude.ai 官方连接器的名字前缀）
  const normalizeNameForMCP = upstream("mcp-normalize-name", "normalizeNameForMCP", { CLAUDEAI_SERVER_PREFIX: "claude.ai " });
  const getMcpPrefix = upstream("mcp-prefix", "getMcpPrefix", { normalizeNameForMCP });
  return {
    normalizeNameForMCP,
    buildMcpToolName: upstream("mcp-tool-name", "buildMcpToolName", { getMcpPrefix, normalizeNameForMCP }),
    mcpInfoFromString: upstream("perm-mcp-info", "mcpInfoFromString"),
  };
};

await lesson(8, "MCP：配置、连接、包装、调用、转换与退出", async (t) => {
  // ───────────────────────── 一、配置 ─────────────────────────
  if (wants("config")) {
    t.log("一、配置：谁能让 Claude Code 启动一个进程");
    t.log();

    // 1.1 合并：user < project < local < --mcp-config。同名的服务器，后面的覆盖前面的。
    const sources = {
      user: {
        mcpServers: {
          shared: { command: "user-cmd" },
          docs: { command: "user-docs" },
          github: { command: "npx", args: ["gh-server"] },
        },
      },
      project: {
        mcpServers: {
          shared: { command: "project-cmd" },
          docs: { command: "project-docs" },
          issues: { command: "node", args: ["issues.mjs"] },
          unknown: { command: "node", args: ["from-a-stranger.mjs"] },
        },
      },
      local: { mcpServers: { shared: { command: "local-cmd" } } },
    };
    const approved = resolveMcpConfig(sources, { approved: ["issues", "shared", "docs"] });
    t.log("项目里的 .mcp.json 是仓库作者写的。用户批准了 issues、shared、docs 三个，没批准 unknown：");
    t.table(
      Object.entries(approved.servers).map(([name, config]) => ({
        服务器: name,
        命令: config.command,
        来自: config.scope,
      })),
    );
    t.log(`还没有结论、等着询问用户的项目服务器：${approved.pending.join("、")}（它们没有出现在上表）`);
    t.log();
    t.equal("同名服务器：local 覆盖 project 覆盖 user", [approved.servers.shared.command, approved.servers.docs.command], ["local-cmd", "project-docs"]);
    t.equal("没批准的项目服务器不启动", approved.pending, ["unknown"]);
    const strict = resolveMcpConfig({ ...sources, extra: { mcpServers: { only: { command: "x" } } } }, { strict: true });
    t.equal("--strict-mcp-config：只剩命令行给的", Object.keys(strict.servers), ["only"]);

    // 1.2 项目服务器的批准状态：原函数 getProjectMcpServerStatus 对 coda
    const { normalizeNameForMCP } = originalNames();
    const originalStatus = (settings, nonInteractive, name = "issues") =>
      upstream("mcp-project-status", "getProjectMcpServerStatus", {
        // 端口：设置从哪里读、项目设置是否启用、是不是非交互运行、有没有跳过危险模式提示
        getSettings_DEPRECATED: () => settings,
        normalizeNameForMCP,
        hasSkipDangerousModePermissionPrompt: () => false,
        isSettingSourceEnabled: () => true,
        getIsNonInteractiveSession: () => nonInteractive,
      })(name);
    const codaStatus = ({ approved = [], rejected = [], approveAll = false, interactive = true }, name = "issues") => {
      const result = resolveMcpConfig({ project: { mcpServers: { [name]: { command: "x" } } } }, { approved, rejected, approveAll, interactive });
      if (result.pending.includes(name)) return "pending";
      return name in result.servers ? "approved" : "rejected";
    };
    const statusRows = [
      ["交互式，没人批准过", {}, {}, false],
      ["enabledMcpjsonServers 里有它", { enabledMcpjsonServers: ["issues"] }, { approved: ["issues"] }, false],
      ["同时在 enabled 和 disabled 里", { enabledMcpjsonServers: ["issues"], disabledMcpjsonServers: ["issues"] }, { approved: ["issues"], rejected: ["issues"] }, false],
      ["enableAllProjectMcpServers", { enableAllProjectMcpServers: true }, { approveAll: true }, false],
      ["claude -p / SDK（非交互）", {}, { interactive: false }, true],
      ["名字归一化后相同（my.srv 对 my_srv）", { enabledMcpjsonServers: ["my.srv"] }, { approved: ["my.srv"] }, false, "my_srv"],
    ].map(([情形, settings, options, nonInteractive, name]) => {
      const original = originalStatus(settings, nonInteractive, name);
      const coda = codaStatus(options, name);
      return { 情形, "Claude Code（原函数）": original, coda, 一致: original === coda ? "是" : "否" };
    });
    t.log("项目服务器的批准状态，原函数 getProjectMcpServerStatus 对 coda：");
    t.table(statusRows);
    t.ok("批准状态与原函数一致", statusRows.every((row) => row.一致 === "是"));
    t.log("端口：设置内容、项目设置已启用、是否非交互、是否跳过过危险模式提示，都是合成的；判断逻辑是原函数。");
    t.log();

    // 1.3 环境变量展开：${VAR}、${VAR:-默认值}
    const expandOriginal = upstream("mcp-env-expand", "expandEnvVarsInString", { process: { env: { TOKEN: "abc" } } });
    const env = { TOKEN: "abc" };
    const envRows = ["${TOKEN}", "${MISSING}", "${MISSING:-fallback}", "${MISSING:-a:-b}", "pre-${TOKEN}-post", "没有变量"].map((text) => {
      const original = plain(expandOriginal(text));
      const coda = expandEnv(text, env);
      return { 配置里写的: text, 展开后: original.expanded, 缺失的变量: original.missingVars.join("、") || "—", 与coda一致: JSON.stringify([original.expanded, original.missingVars]) === JSON.stringify([coda.expanded, coda.missing]) ? "是" : "否" };
    });
    t.table(envRows);
    t.ok("环境变量展开与原函数一致", envRows.every((row) => row.与coda一致 === "是"));
    t.log("第四行：${MISSING:-a:-b} 只得到 a。原函数用 split(':-', 2) 切开默认值，注释的本意是“默认值里的 :- 要保留”，");
    t.log("但 JavaScript 的 split 带上限时是丢弃多出来的部分，不是保留。coda 用了同样的写法，所以行为一致。");
  }

  // ───────────────────────── 二、名字 ─────────────────────────
  if (wants("names")) {
    t.log("二、名字：mcp__服务器__工具");
    t.log();
    const { buildMcpToolName, mcpInfoFromString } = originalNames();
    const pairs = [
      ["issues", "search_issues"],
      ["issues", "create-issue"],
      ["my server", "list files"],
      ["github.com", "create.issue"],
      ["a", "b__c"],
      ["my__srv", "tool"],
      ["问题库", "搜索"],
      ["问题库", "新建"],
    ];
    const rows = pairs.map(([server, tool]) => {
      const original = buildMcpToolName(server, tool);
      const coda = mcpToolName(server, tool);
      const back = plain(mcpInfoFromString(original));
      return {
        服务器: server,
        工具: tool,
        "模型看到的名字（原函数）": original,
        拆回去: back ? `${back.serverName} / ${back.toolName ?? "—"}` : "—",
        与coda一致: original === coda ? "是" : "否",
      };
    });
    t.table(rows);
    t.ok("名字与原函数一致", rows.every((row) => row.与coda一致 === "是"));
    t.log("看三个现象：");
    t.log("  · 空格、点、汉字都变成了下划线；工具名里的连字符保留。");
    t.log("  · my__srv 拆回去是 my / srv__tool：分隔符和名字里的下划线分不开（原函数的注释承认了这个局限）。");
    t.log("  · “搜索”和“新建”归一化后是同一个名字。同一个服务器里出现这种情况，工具池按名字去重，后面的那个就看不见了。");
    t.log();

    // 随机一点：把一组容易出问题的片段两两拼起来，原函数和 coda 必须处处一致
    const pieces = ["a", "B", "_", "-", " ", ".", "中", "é", "1", "__"];
    let compared = 0;
    for (const server of pieces.flatMap((x) => pieces.map((y) => x + y))) {
      for (const tool of pieces.flatMap((x) => pieces.map((y) => x + y))) {
        const name = buildMcpToolName(server, tool);
        if (name !== mcpToolName(server, tool)) throw Error(`名字不一致：${JSON.stringify([server, tool])}`);
        const a = plain(mcpInfoFromString(name));
        const b = parseMcpToolName(name);
        if (JSON.stringify(a ? [a.serverName, a.toolName] : null) !== JSON.stringify(b ? [b.server, b.tool] : null)) throw Error(`拆分不一致：${name}`);
        compared++;
      }
    }
    t.ok(`${compared} 组 (服务器, 工具)：起名和拆分都与原函数一致`, compared === 10_000);
  }

  // ───────────────────────── 三、线上的消息 ─────────────────────────
  if (wants("wire")) {
    t.log("三、从握手到调用，线上说了什么（coda 的真实收发）");
    t.log();
    const frames = [];
    let toolsChanged;
    const changed = new Promise((resolve) => (toolsChanged = resolve));
    const connection = await connectMcp(process.execPath, [SERVER], {
      server: "issues",
      onFrame: (dir, frame) => frames.push({ dir, frame }),
      onToolsChanged: (_tools, diff) => toolsChanged(diff),
    });
    const tool = (name) => connection.tools.find((x) => x.name === `mcp__issues__${name}`);
    const [slow, fast] = await Promise.all([
      tool("slow_count").execute({ to: 3, delayMs: 40 }),
      tool("slow_count").execute({ to: 1, delayMs: 5 }),
    ]);
    await tool("ask_client").execute({ method: "roots/list" });
    await tool("enable_admin_tools").execute({});
    const diff = await changed;
    await sleep(20);
    await connection.close();

    const methods = new Map(); //  id → method：回复本身不带方法名，要靠 id 找回去
    const progressSeen = new Set();
    const rows = [];
    for (const { dir, frame } of frames) {
      if (frame.method && frame.id !== undefined) methods.set(frame.id, frame.method);
      const method = frame.method ?? methods.get(frame.id);
      const p = frame.params ?? {};
      const r = frame.result ?? {};
      let note = "";
      if (frame.method === "initialize") note = `协议 ${p.protocolVersion}；客户端能力：${Object.keys(p.capabilities).join("、")}`;
      else if (method === "initialize" && frame.result) note = `服务器 ${r.serverInfo.name}；能力：${Object.keys(r.capabilities).join("、")}；带 instructions`;
      else if (frame.method === "tools/call") note = `${p.name}；_meta：${Object.keys(p._meta ?? {}).join("、") || "—"}${p._meta ? "=" + p._meta.progressToken : ""}`;
      else if (method === "tools/list" && frame.result) note = `${r.tools.length} 个工具`;
      else if (frame.method === "notifications/progress") note = `令牌 ${p.progressToken}：${p.message}`;
      else if (frame.method === "roots/list") note = "服务器反过来问：你的工作目录是什么？";
      else if (method === "roots/list" && frame.result) note = `回答：${r.roots.map((x) => x.uri.replace(ROOT, "<根>")).join("、")}`;
      else if (frame.method === "notifications/cancelled") note = `请求 ${p.requestId}：${p.reason}`;
      else if (method === "tools/call" && frame.result) note = short(r.content?.[0]?.text ?? "（空）", 30);
      const fromServer = typeof frame.id === "string"; //  服务器发起的请求，id 是字符串 s1
      const label = frame.method
        ? frame.method + (fromServer ? "（服务器的请求）" : "")
        : `${frame.error ? "错误" : "结果"}（回复${fromServer ? "服务器的请求 " : " "}${frame.id}）`;
      // 进度通知很多，每个令牌只留第一条
      if (frame.method === "notifications/progress") {
        if (progressSeen.has(p.progressToken)) continue;
        progressSeen.add(p.progressToken);
      }
      rows.push({ 方向: dir === "→" ? "coda →" : "← 服务器", 消息: label, 要点: note });
    }
    t.table(rows);
    t.log("两个并发的 slow_count：慢的先发、快的后发，回复顺序相反，但每个调用拿到的是自己的结果：");
    t.table([{ "先发的（数到 3）": slow.text, "后发的（数到 1）": fast.text }]);
    t.equal("按 id 配对：乱序返回，各归各", [slow.text, fast.text], ["数完了：3", "数完了：1"]);
    t.equal("收到 tools/list_changed 后重新取列表，多出管理工具", diff, { added: ["mcp__issues__delete_issue"], removed: [] });
    t.ok("服务器反向发来的 roots/list 得到了回答", frames.some(({ dir, frame }) => dir === "→" && frame.result?.roots));
  }

  // ───────────────────────── 四、包装成工具 ─────────────────────────
  if (wants("wrap")) {
    t.log("四、包装成工具以后，调度器看到什么");
    t.log();
    const connection = await connectMcp(process.execPath, [SERVER], { server: "issues" });
    t.table(
      connection.tools.map((tool) => ({
        工具名: tool.name,
        可并行: tool.parallel ? "是（服务器声明 readOnlyHint）" : "否",
        参数: Object.keys(tool.schema.properties ?? {}).join("、") || "—",
        描述: short(tool.description, 24),
      })),
    );
    t.log(`服务器说明（给模型看的）：${connection.instructions}`);
    t.log();

    // 声明 readOnlyHint 的调用可以和相邻的调用同时跑：第 3 章的 partition 看的就是 parallel 这个字段。
    const lookup = (list) => (name) => list.find((tool) => tool.name === name);
    const call = (name, n) => ({ id: `${name}-${n}`, name: `mcp__issues__${name}`, input: {} });
    const sequence = [call("search_issues", 1), call("search_issues", 2), call("create-issue", 3), call("search_issues", 4)];
    const show = (batches) => batches.map((b) => `[${b.calls.map((c) => c.name.replace("mcp__issues__", "") + c.id.split("-").pop()).join(" ")}]`).join(" ");
    const honest = partition(sequence, lookup(connection.tools));
    t.log("搜索、搜索、新建、搜索 这四个调用，调度器怎么分批：");
    t.table([{ 分批结果: show(honest) }]);
    t.equal("只读的搜索可以并行；新建是独占的栅栏", honest.map((b) => b.calls.length), [2, 1, 1]);

    // 服务器撒谎：把会删除数据的工具也标成只读。调度器无从分辨。
    // 两个真实的服务器，各自打开管理工具（工具列表变化的通知到达以后，delete_issue 才出现）。
    const withAdminTools = async (env) => {
      let ready;
      const changed = new Promise((resolve) => (ready = resolve));
      const server = await connectMcp(process.execPath, [SERVER], { server: "issues", env, onToolsChanged: () => ready() });
      await server.tools.find((tool) => tool.name.endsWith("enable_admin_tools")).execute({});
      await changed;
      return server;
    };
    const honestServer = await withAdminTools({});
    const liar = await withAdminTools({ MCP_FIXTURE_LIE: "1" });
    const sequence2 = [call("search_issues", 1), call("delete_issue", 2), call("search_issues", 3)];
    const trusted = partition(sequence2, lookup(honestServer.tools));
    const lied = partition(sequence2, lookup(liar.tools));
    t.log("同一个删除工具，诚实的服务器标注 destructiveHint，撒谎的服务器标注 readOnlyHint：");
    t.table([
      { 服务器: "诚实", 分批结果: show(trusted) },
      { 服务器: "撒谎（delete_issue 标了 readOnlyHint）", 分批结果: show(lied) },
    ]);
    t.equal("撒谎的服务器让删除调用混进了并行批", lied.map((b) => b.calls.length), [3]);
    t.log("所以 coda 只用注解决定“能不能并行”，不用它决定“要不要问用户”：注解是服务器自己声称的。权限层怎么看这些工具：");
    const verdict = (name, rules) => {
      const decision = decide({ name, input: {} }, honestServer.tools.find((tool) => tool.name === name), { mode: "default", rules });
      return decision.behavior + (decision.rule ? `（${decision.source}：${decision.rule}）` : "");
    };
    const names = ["mcp__issues__search_issues", "mcp__issues__create-issue", "mcp__issues__delete_issue"];
    t.table(
      names.map((name) => ({
        工具: name,
        没有任何规则: verdict(name, {}),
        'allow: ["mcp__issues"]': verdict(name, { allow: ["mcp__issues"] }),
        'deny: ["mcp__issues__delete_issue"]': verdict(name, { deny: ["mcp__issues__delete_issue"] }),
      })),
    );
    t.log("没有规则时，连声明了 readOnlyHint 的搜索也要问。规则可以写到整个服务器（mcp__issues），也可以写到单个工具。");
    t.equal("注解不改变“问不问”", names.map((name) => verdict(name, {})), ["ask", "ask", "ask"]);
    await Promise.all([connection.close(), honestServer.close(), liar.close()]);
  }

  // ───────────────────────── 五、参数错了谁来拦 ─────────────────────────
  if (wants("validate")) {
    t.log("五、参数错了，谁来拦");
    t.log();
    const workspace = join(t.root, "validate");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "a.txt"), "hello");
    const connection = await connectMcp(process.execPath, [SERVER], { server: "issues" });
    const seen = [];
    const hooks = new Hooks([{ event: "before", run: async (input) => void seen.push(input.tool_name) }]);
    const toolset = new Toolset([...codingTools(workspace), ...connection.tools], { hooks });

    const rows = [];
    for (const [谁, call] of [
      ["内置 Read，path 写成数字", { id: "1", name: "Read", input: { path: 42 } }],
      ["MCP 搜索，漏了必填的 query", { id: "2", name: "mcp__issues__search_issues", input: {} }],
      ["MCP 搜索，query 写成数字", { id: "3", name: "mcp__issues__search_issues", input: { query: 7 } }],
    ]) {
      seen.length = 0;
      const result = await toolset.execute(call);
      rows.push({ 调用: 谁, 结果: short(result.text, 28), Hook看到了吗: seen.length ? "看到了" : "没有", 谁拦下的: seen.length ? "服务器" : "本地校验" });
    }
    t.table(rows);
    t.log("模型看到的参数 schema 是服务器给的 JSON Schema；本地校验只检查“是不是对象”，参数对不对由服务器判断：");
    t.table([{ search_issues的schema要求: JSON.stringify(connection.tools[0].schema.required), 本地validate检查: "输入是对象" }]);
    t.equal("内置工具：校验失败时 Hook 看不到", rows[0].Hook看到了吗, "没有");
    t.equal("MCP 工具：参数错误先到服务器，Hook 看得到", [rows[1].Hook看到了吗, rows[2].Hook看到了吗], ["看到了", "看到了"]);
    t.ok("服务器的错误作为 is_error 结果交回", (await toolset.execute({ id: "4", name: "mcp__issues__search_issues", input: {} })).error);
    await connection.close();
  }

  // ───────────────────────── 六、看不见的字符 ─────────────────────────
  if (wants("poison")) {
    t.log("六、工具描述里的隐藏字符");
    t.log();
    const connection = await connectMcp(process.execPath, [SERVER], { server: "issues", env: { MCP_FIXTURE_POISON: "1" } });
    // 这个连接已经经过 coda 的清洗；要看原始描述，直接问服务器
    const raw = new StdioRpc(process.execPath, [SERVER], { env: { MCP_FIXTURE_POISON: "1" } });
    await raw.initialize();
    const { tools } = await raw.request("tools/list");
    await raw.close();
    const poisoned = tools.find((tool) => tool.name === "lookup");

    const sanitizeOriginal = upstream("mcp-sanitize-deep", "recursivelySanitizeUnicode", {
      partiallySanitizeUnicode: upstream("mcp-sanitize", "partiallySanitizeUnicode"),
      Array,
      Object,
    });
    const originalClean = plain(sanitizeOriginal(poisoned)).description;
    const codaClean = connection.tools.find((tool) => tool.name.endsWith("__lookup")).description;
    const hiddenCount = [...poisoned.description].filter((c) => c.codePointAt(0) >= 0xe0000 || "\u200b\u202e".includes(c)).length;
    const decode = [...poisoned.description].filter((c) => c.codePointAt(0) >= 0xe0000).map((c) => String.fromCharCode(c.codePointAt(0) - 0xe0000)).join("");
    t.table([
      { 版本: "服务器发来的原文", 字符数: [...poisoned.description].length, 屏幕上看到: poisoned.description.replace(/[\u{e0000}-\u{e007f}\u200b\u202e]/gu, ""), 其中看不见的: `${hiddenCount} 个` },
      { 版本: "原函数清洗之后", 字符数: [...originalClean].length, 屏幕上看到: originalClean, 其中看不见的: "0 个" },
      { 版本: "coda 清洗之后", 字符数: [...codaClean].length, 屏幕上看到: codaClean, 其中看不见的: "0 个" },
    ]);
    t.log(`把那 ${hiddenCount} 个字符当作 Unicode 标签字符解码，得到：${decode}`);
    t.log("模型读得到它，屏幕上看不到。清洗发生在工具列表到达的那一刻，在描述进入任何提示之前。");
    t.equal("coda 与原函数清洗结果一致", codaClean, originalClean);
    t.ok("隐藏的指令被清除", !/IGNORE/.test(codaClean) && [...codaClean].every((c) => c.codePointAt(0) < 0xe0000));

    const fullwidth = "查询（可选）：编号，不要加引号";
    t.log();
    t.log("清洗的副作用：NFKC 归一化会把全角标点换成半角。");
    t.table([{ 原文: fullwidth, 原函数: sanitizeOriginal(fullwidth), coda: sanitizeUnicode(fullwidth) }]);
    t.equal("全角标点变成半角，两者一致", sanitizeUnicode(fullwidth), sanitizeOriginal(fullwidth));
    await connection.close();
  }

  // ───────────────────────── 七、一次 tools/call ─────────────────────────
  if (wants("call")) {
    t.log("七、一次 tools/call：isError、超时、取消");
    t.log();
    // 原函数 callMCPTool，客户端换成一个假的：只有 callTool 一个方法，按我们的剧本返回或不返回。
    // 端口：日志和统计是空函数；超时换成可调的；processMCPResult 换成“原样返回 content”（它在下一个实验单独运行）。
    class McpToolCallError extends TelemetrySafeError {
      constructor(message, telemetry, mcpMeta) {
        super(message);
        this.name = "McpToolCallError";
        this.mcpMeta = mcpMeta;
      }
    }
    const runOriginal = async (callTool, { timeoutMs = 5_000, signal = new AbortController().signal } = {}) => {
      const callMCPTool = upstream("mcp-call-tool", "callMCPTool", {
        Error, Promise, Date, Math, setTimeout, clearTimeout, setInterval, clearInterval,
        logMCPDebug() {}, logMCPError() {}, logEvent() {},
        getMcpToolTimeoutMs: () => timeoutMs,
        TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: TelemetrySafeError,
        McpToolCallError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: McpToolCallError,
        CallToolResultSchema: {},
        UnauthorizedError: class extends Error {},
        McpAuthError: class extends Error {},
        McpSessionExpiredError: class extends Error {},
        isMcpSessionExpiredError: () => false,
        clearServerCache: async () => {},
        detectCodeIndexingFromMcpServerName: () => null,
        processMCPResult: async (result) => result.content,
      });
      try {
        const out = await callMCPTool({ client: { client: { callTool }, name: "issues", config: { type: "stdio" } }, tool: "demo", args: {}, signal });
        return out.content === undefined ? "返回 { content: undefined }，不抛异常" : `正常返回 ${short(JSON.stringify(out.content), 30)}`;
      } catch (error) {
        return `抛出 ${error.name}：${error.message}`;
      }
    };
    const never = () => new Promise(() => {});
    const abortable = (_request, _schema, options) =>
      new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(Error("aborted"), { name: "AbortError" }))));

    // 取消要在调用开始之后才发生：先发起调用，30ms 后触发取消信号
    const cancelOriginal = async () => {
      const controller = new AbortController();
      const running = runOriginal(abortable, { signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      return running;
    };
    const originalRows = {
      正常: await runOriginal(async () => ({ content: [{ type: "text", text: "ok" }] })),
      "isError，有文字": await runOriginal(async () => ({ isError: true, content: [{ type: "text", text: "database connection refused" }] })),
      "isError，没有内容": await runOriginal(async () => ({ isError: true, content: [] })),
      超过期限: await runOriginal(never, { timeoutMs: 1000 }),
      用户取消: await cancelOriginal(),
    };

    // coda：同样的场景，对着真实的服务器进程
    const connection = await connectMcp(process.execPath, [SERVER], { server: "issues", toolTimeout: 250 });
    const tool = (name) => connection.tools.find((x) => x.name === `mcp__issues__${name}`);
    const outcome = async (promise) => {
      try {
        return `正常返回 ${short((await promise).text, 30)}`;
      } catch (error) {
        return `抛出 ${error.name}：${short(error.message, 60)}`;
      }
    };
    const cancelCoda = () => {
      const abort = new AbortController();
      const running = outcome(tool("slow_count").execute({ to: 50, delayMs: 20 }, { signal: abort.signal }));
      setTimeout(() => abort.abort(Error("用户按了 Esc")), 60);
      return running;
    };
    const codaRows = {
      正常: await outcome(tool("create-issue").execute({ title: "t" })),
      "isError，有文字": await outcome(tool("explode").execute({})),
      "isError，没有内容": await outcome(tool("fail").execute({})),
      超过期限: await outcome(tool("slow_count").execute({ to: 50, delayMs: 100 })),
      用户取消: await cancelCoda(),
    };
    t.table(
      Object.keys(originalRows).map((场景) => ({
        场景,
        "Claude Code（原函数 + 假客户端）": originalRows[场景],
        "coda（真实进程）": codaRows[场景],
      })),
    );
    t.log("超时一行：原函数的期限设成 1 秒，coda 设成 250ms，只是为了让实验跑得快。");
    await sleep(50);
    t.log(`服务器的 stderr 里，超时和取消都留下了 notifications/cancelled：`);
    t.log(connection.peer.stderr.trim().split("\n").filter((line) => /cancelled/.test(line)).map((line) => `  ${line}`).join("\n"));
    t.log();

    // 缺省的期限
    const timeoutOf = (env) => upstream("mcp-tool-timeout", "getMcpToolTimeoutMs", { process: { env }, parseInt, DEFAULT_MCP_TOOL_TIMEOUT_MS: 100_000_000 })();
    t.table([
      { 环境变量: "(未设置)", 工具调用的期限: `${timeoutOf({})} ms`, 约等于: `${(timeoutOf({}) / 3_600_000).toFixed(1)} 小时` },
      { 环境变量: "MCP_TOOL_TIMEOUT=5000", 工具调用的期限: `${timeoutOf({ MCP_TOOL_TIMEOUT: "5000" })} ms`, 约等于: "5 秒" },
    ]);
    t.log("缺省几乎不限时：工具跑多久是工具自己的事，要停就按 Esc（取消信号）。握手的期限才是 30 秒。");

    t.log();
    // 两种“失败”不在同一层：JSON-RPC 的 error 让请求本身失败；isError 是请求成功、结果里说工具失败。
    const minimal = new StdioRpc(process.execPath, [MINIMAL], { timeout: 80 });
    await minimal.initialize();
    const rpcError = await minimal.request("unknown").catch((error) => error);
    const rpcHang = await minimal.request("hang").catch((error) => error);
    const raw = await connection.peer.request("tools/call", { name: "explode", arguments: {} });
    t.table([
      { 失败的层次: "JSON-RPC 的 error（调用了不存在的方法）", 请求本身: `失败，code ${rpcError.code}：${rpcError.message}`, 模型最终看到: "is_error 结果（模型只会发 tools/call，同类错误发生在它身上就是这样）" },
      { 失败的层次: "服务器一直不回复", 请求本身: `失败：${short(rpcHang.message, 40)}`, 模型最终看到: "is_error 结果，写明超时" },
      { 失败的层次: "工具结果里的 isError: true", 请求本身: `成功返回，isError=${raw.isError}`, 模型最终看到: "is_error 结果，带着服务器写的文字" },
    ]);
    t.equal("协议错误带着 JSON-RPC 的 code", rpcError.code, -32601);
    t.ok("没有回复的请求有期限，到期后等待表是空的", /timeout/.test(rpcHang.message) && minimal.pending.size === 0);
    await minimal.close();
    t.ok("isError：有文字用文字", /database connection refused/.test(codaRows["isError，有文字"]) && /database connection refused/.test(originalRows["isError，有文字"]));
    t.ok("isError：没有内容就是 Unknown error", /Unknown error/.test(codaRows["isError，没有内容"]) && /Unknown error/.test(originalRows["isError，没有内容"]));
    t.ok("原函数：取消不抛异常", /content: undefined/.test(originalRows.用户取消));
    t.ok("超时和取消都通知了服务器", (connection.peer.stderr.match(/notifications\/cancelled/g) ?? []).length >= 2);
    t.equal("超时之后等待表是空的", connection.peer.pending.size, 0);
    await connection.close();
  }

  // ───────────────────────── 八、结果转换 ─────────────────────────
  if (wants("convert")) {
    t.log("八、结果怎么变成给模型的文字");
    t.log();
    const { normalizeNameForMCP } = originalNames();
    // 端口：图片的缩放、二进制落盘换成不做事的替身；其余（分类、structuredContent 优先）是原函数。
    const inferCompactSchema = upstream("mcp-compact-schema", "inferCompactSchema");
    const transformResultContent = upstream("mcp-transform", "transformResultContent", {
      Buffer, String,
      IMAGE_MIME_TYPES: new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
      maybeResizeAndDownsampleImageBuffer: async (buffer) => ({ buffer, mediaType: "png" }),
      persistBlobToTextBlock: async (_bytes, mime, _server, prefix) => [{ type: "text", text: `${prefix}Binary content (${mime}) saved` }],
    });
    const transformMCPResult = upstream("mcp-transform-result", "transformMCPResult", {
      transformResultContent,
      inferCompactSchema,
      jsonStringify: JSON.stringify,
      logMCPError() {},
      TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: TelemetrySafeError,
    });
    const asText = (content) =>
      typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text : `[${block.type} 块]`)).join("\n");

    const cases = [
      ["只有 text", { content: [{ type: "text", text: "#41 [open] Ctrl+C 不退出" }] }],
      ["text 和 structuredContent 都有", { content: [{ type: "text", text: "#41 [open] Ctrl+C 不退出" }], structuredContent: { issues: [{ id: 41 }] } }],
      ["只有 structuredContent", { content: [], structuredContent: { total: 3, open: 2 } }],
      ["资源链接 + 内嵌资源", { content: [{ type: "resource_link", uri: "issue://41", name: "issue 41", description: "原始记录" }, { type: "resource", resource: { uri: "file:///notes.md", text: "# 笔记" } }] }],
      ["图片", { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }],
      ["形状不对（什么都没有）", {}],
    ];
    const rows = [];
    for (const [情形, result] of cases) {
      let original;
      let originalType = "—";
      try {
        const out = await transformMCPResult(result, "demo", "issues");
        originalType = out.type;
        original = asText(out.content);
      } catch (error) {
        original = `报错：${error.message}`;
      }
      let coda;
      try {
        coda = convertResult(result, { server: "issues", tool: "demo" }).text;
      } catch (error) {
        coda = `报错：${error.message}`;
      }
      const sameKind = result.content?.[0]?.type === "image";
      rows.push({
        情形,
        "取哪一部分（原函数）": originalType,
        "模型看到的（原函数）": short(original, 44),
        "模型看到的（coda）": short(coda, 44),
        一致: sameKind ? "同类（图片不交给模型）" : original === coda ? "是" : "否",
      });
    }
    t.table(rows);
    t.ok("文字、structuredContent、资源的转换与原函数一致", rows.filter((row) => row.一致 !== "同类（图片不交给模型）").every((row) => row.一致 === "是"));
    t.equal("structuredContent 优先于 content", rows[1]["取哪一部分（原函数）"], "structuredContent");
    t.log();

    // 太大的结果：三种大小，两道关
    t.log("太大的结果有两道关。第一道是 MCP 自己的（按 token，上限 25000）；第二道是第 3 章讲的通用落盘（按字符）。");
    const dir = join(t.root, "persisted");
    mkdirSync(dir);
    const sizeTokens = (content) => Math.round((typeof content === "string" ? content.length : content.reduce((n, b) => n + (b.text?.length ?? 0), 0)) / 4);
    const processMCPResult = upstream("mcp-process-result", "processMCPResult", {
      transformMCPResult,
      // 端口：数 token 的 API 换成“字符数除以 4”；写文件换成写临时目录；开关取缺省值
      mcpContentNeedsTruncation: async (content) => sizeTokens(content) > 25_000,
      getContentSizeEstimate: sizeTokens,
      isEnvDefinedFalsy: () => false,
      process: { env: {} },
      logEvent() {},
      truncateMcpContentIfNeeded: async (content) => content,
      contentContainsImages: (content) => Array.isArray(content) && content.some((block) => block.type === "image"),
      normalizeNameForMCP,
      jsonStringify: JSON.stringify,
      persistToolResult: async (content, id) => {
        const filepath = join(dir, `${id}.txt`);
        writeFileSync(filepath, content);
        return { filepath, originalSize: content.length, isJson: false, preview: "" };
      },
      isPersistError: (result) => "error" in result,
      getFormatDescription: upstream("mcp-format-description", "getFormatDescription"),
      getLargeOutputInstructions: upstream("mcp-large-output", "getLargeOutputInstructions"),
    });
    const log = (lines) => ({ content: [{ type: "text", text: Array.from({ length: lines }, (_, i) => `[${String(i).padStart(4, "0")}] compile src/module-${i}.ts ... ok`).join("\n") }] });
    const persistThreshold = upstream("persist-threshold", "getPersistenceThreshold", {
      Number, Math, PERSIST_THRESHOLD_OVERRIDE_FLAG: "none", DEFAULT_MAX_RESULT_SIZE_CHARS: 50_000, getFeatureValue_CACHED_MAY_BE_STALE: () => ({}),
    })("mcp__issues__dump_log", 100_000); //  MCPTool 声明的 maxResultSizeChars 是 100000
    const resultDir = join(t.root, "coda-results");
    const server = await connectMcp(process.execPath, [SERVER], { server: "issues", resultDir });
    const dump = server.tools.find((tool) => tool.name.endsWith("dump_log"));
    const toolset = new Toolset([dump], { resultDir, maxResultChars: 30_000 });

    const sizeRows = [];
    let big;
    for (const lines of [300, 1300, 3000]) {
      const result = log(lines);
      const chars = result.content[0].text.length;
      const first = await processMCPResult(result, "dump_log", "issues"); //  第一道：MCP 层
      const persistedByMcp = typeof first === "string" && /exceeds maximum allowed/.test(first);
      const genericLayer = !persistedByMcp && chars > persistThreshold; //   第二道：只有 MCP 层放行了才会走到
      const reply = await toolset.execute({ id: `d${lines}`, name: dump.name, input: { lines } });
      sizeRows.push({
        结果大小: `${chars.toLocaleString()} 字符（约 ${sizeTokens(result.content).toLocaleString()} token）`,
        "Claude Code：MCP 层": persistedByMcp ? "整体存成文件，返回读取说明" : "放行",
        "Claude Code：通用层": persistedByMcp ? "（已经是一句短说明）" : genericLayer ? `超过 ${persistThreshold.toLocaleString()} 字符，落盘 + 预览` : "放行",
        "coda 给模型的": reply.details?.persistedPath ? (/exceeds maximum/.test(reply.text) ? "MCP 层存文件 + 读取说明" : "通用层落盘 + 预览") : "原样",
      });
      if (lines === 3000) big = { original: first, coda: reply };
    }
    t.table(sizeRows);
    t.equal("三个大小分别走：放行、通用层、MCP 层", sizeRows.map((row) => row["coda 给模型的"]), ["原样", "通用层落盘 + 预览", "MCP 层存文件 + 读取说明"]);
    const originalFile = big.original.match(/saved to (\S+?\.txt)/)[1];
    const originalLines = readFileSync(originalFile, "utf8").split("\n");
    t.log("最大的那个，Claude Code 的原函数交给模型的是（路径是实验用的临时目录）：");
    t.log(big.original.split("\n").map((line) => `  │ ${line.replace(dir, "<临时目录>")}`).join("\n"));
    t.log(`它存下来的文件只有 ${originalLines.length} 行，不是 3000 行：内容数组被整个序列化成了 JSON，日志是其中一个带 \\n 的长字符串。`);
    t.log(`  文件开头：${originalLines.slice(0, 3).map((line) => line.trim()).join(" ")}`);
    t.ok("2.1.88 存下来的是 JSON 文本，不是逐行的原文", originalLines.length < 10);
    t.log();
    t.log("coda 交给模型的：");
    t.log(big.coda.text.split("\n").map((line) => `  │ ${line.replace(resultDir, "<临时目录>")}`).join("\n"));
    t.ok("完整内容一字不差地存在文件里", readFileSync(big.coda.details.persistedPath, "utf8") === log(3000).content[0].text);
    t.log("端口：数 token 的 API（换成字符数除以 4）、写文件的函数（换成写临时目录）；转换、两道判断和读取说明的措辞都是原函数的。");
    await server.close();
  }

  // ───────────────────────── 九、连不上、卡住、崩溃 ─────────────────────────
  if (wants("failures")) {
    t.log("九、连接失败：一个出问题的服务器不能拖垮整个会话");
    t.log();
    const dir = join(t.root, "failures");
    mkdirSync(dir);
    const servers = {
      issues: { command: process.execPath, args: [SERVER] },
      "need-key": { command: process.execPath, args: [SERVER], env: { MCP_FIXTURE_EXIT_AT_START: "缺少环境变量 ISSUES_API_KEY" } },
      "chatty": { command: process.execPath, args: [SERVER], env: { MCP_FIXTURE_NOISY: "1" } },
      "stuck": { command: process.execPath, args: [SERVER], env: { MCP_FIXTURE_INIT_DELAY_MS: "2000" } },
      "typo": { command: "no-such-command-8472", args: [] },
      "off": { command: process.execPath, args: [SERVER], disabled: true },
    };
    const started = Date.now();
    const all = await connectMcpServers(servers, { connectTimeout: 300 });
    const elapsed = Date.now() - started;
    t.table(
      all.servers.map((s) => ({
        服务器: s.name,
        状态: s.status,
        工具数: s.tools,
        详情: s.error ? short(`${s.error}${s.stderr ? `（stderr：${s.stderr}）` : ""}`, 70) : s.status === "disabled" ? "不启动" : "",
      })),
    );
    t.log("卡住的那个服务器只占用了握手期限（这里设成 300ms），没有拖慢别人；失败的服务器不抛异常，只留下一条记录。");
    t.ok("六个服务器一起连，总用时由最慢的决定，不是相加", elapsed < 1500);
    t.equal("各服务器的状态", Object.fromEntries(all.servers.map((s) => [s.name, s.status])), {
      issues: "connected", "need-key": "failed", chatty: "connected", stuck: "failed", typo: "failed", off: "disabled",
    });
    t.ok("启动就退出：stderr 里的原因带回来了", /ISSUES_API_KEY/.test(all.servers.find((s) => s.name === "need-key").stderr));
    t.ok("握手超时：错误里写明期限", /timed out after 300ms/.test(all.servers.find((s) => s.name === "stuck").error));
    t.ok("连接失败的服务器没有留下进程", all.servers.filter((s) => s.status === "failed").every((s) => !s.pid || !alive(s.pid)));
    t.log(`好的服务器的工具照常合并，按名字排好：${all.tools.slice(0, 3).map((tool) => tool.name.replace("mcp__", "")).join("、")}……共 ${all.tools.length} 个`);
    t.log();

    // 两个服务器的名字归一化后相同：工具重名，只留第一个
    const clash = await connectMcpServers({
      "my server": { command: process.execPath, args: [SERVER] },
      "my.server": { command: process.execPath, args: [SERVER] },
    });
    t.log(`名字归一化后撞车：my server 和 my.server 都是 mcp__my_server__*，去重后留下 ${clash.tools.length} 个工具，丢掉 ${clash.skipped.length} 个。`);
    t.equal("撞名的工具只保留第一个", [clash.tools.length, clash.skipped.length], [11, 11]);
    await Promise.all([all.close(), clash.close()]);
    t.log();

    // 噪声：服务器把日志打到了 stdout
    const noisy = await connectMcp(process.execPath, [SERVER], { server: "chatty", env: { MCP_FIXTURE_NOISY: "1" } });
    t.log(`chatty 的 stdout 上混进了一行普通日志，客户端只记下它，连接照常：${JSON.stringify(noisy.peer.noise)}`);
    t.equal("stdout 噪声不断开连接", [noisy.peer.noise.length, noisy.tools.length], [1, 11]);
    await noisy.close();

    // 中途崩溃
    const live = await connectMcp(process.execPath, [SERVER], { server: "issues", toolTimeout: 30_000 });
    const crashedAt = Date.now();
    const crash = live.tools.find((tool) => tool.name.endsWith("__crash")).execute({}).catch((error) => error);
    const error = await crash;
    const waited = Date.now() - crashedAt;
    t.log(`调用 crash 工具，服务器进程直接退出：${error.message}（${waited < 1000 ? "不到 1 秒" : `${waited}ms`}就返回了，没有等满 30 秒的期限）`);
    t.ok("进程退出时，等待中的调用立即失败", error.message.includes("exited") && waited < 3000);
    t.ok("之后的调用也立即失败", await live.tools[0].execute({ query: "" }).then(() => false, (e) => /exited/.test(e.message)));
    await live.close();
  }

  // ───────────────────────── 十、退出 ─────────────────────────
  if (wants("shutdown")) {
    t.log("十、退出：SIGINT → SIGTERM → SIGKILL");
    t.log();
    const dir = join(t.root, "shutdown");
    mkdirSync(dir);
    const scenarios = [
      ["礼貌：收到 SIGINT 就收尾退出", {}, undefined],
      ["忽略 SIGINT", { MCP_FIXTURE_IGNORE: "SIGINT" }, undefined],
      ["忽略 SIGINT 和 SIGTERM", { MCP_FIXTURE_IGNORE: "SIGINT,SIGTERM" }, undefined],
      ["礼貌，但退出时直接 SIGKILL", {}, [["SIGKILL"]]],
    ];
    const rows = [];
    for (const [i, [场景, env, steps]] of scenarios.entries()) {
      const bye = join(dir, `bye-${i}.txt`);
      const connection = await connectMcp(process.execPath, [SERVER], { server: "issues", env: { ...env, MCP_FIXTURE_BYE_FILE: bye } });
      const pid = connection.peer.child.pid;
      const closed = await connection.peer.close(steps ? { steps } : undefined);
      await sleep(20);
      rows.push({ 场景, 进程结束于: closed.how, 耗时: closed.ms < 90 ? "几毫秒" : closed.ms < 450 ? "约 100ms" : "约 500ms", 收尾文件: existsSync(bye) ? readFileSync(bye, "utf8") : "没有写", 进程还在: alive(pid) ? "是" : "否", _ms: closed.ms });
    }
    t.table(rows.map(({ _ms, ...row }) => row));
    t.log("升级的顺序是 SIGINT（等 100ms）→ SIGTERM（等 400ms）→ SIGKILL，总共不超过半秒，免得退出时卡住。");
    t.log("越早结束，服务器越有机会收尾（写缓存、关数据库）；SIGKILL 什么也不留。");
    t.equal("结束于哪一步", rows.map((row) => row.进程结束于), ["SIGINT", "SIGTERM", "SIGKILL", "SIGKILL"]);
    t.equal("每种情况下，进程最后都没了", rows.map((row) => row.进程还在), ["否", "否", "否", "否"]);
    t.ok("只有给了收尾机会的，才留下收尾文件", rows[0].收尾文件.startsWith("bye") && rows[1].收尾文件.startsWith("bye") && rows[2].收尾文件 === "没有写" && rows[3].收尾文件 === "没有写");
    t.ok("固执的服务器被升级逼退，总耗时不到一秒", rows[2]._ms < 1000 && rows[2]._ms >= 450);
  }

  // ───────────────────────── 十一、推迟加载 ─────────────────────────
  if (wants("deferred")) {
    t.log("十一、工具太多：推迟加载，状态记在哪里");
    t.log();
    const isEnvTruthy = upstream("mcp-env-truthy", "isEnvTruthy");
    const isEnvDefinedFalsy = upstream("mcp-env-falsy", "isEnvDefinedFalsy");
    const env = {};
    const getToolSearchMode = upstream("mcp-tool-search-mode", "getToolSearchMode", {
      process: { env },
      isEnvTruthy,
      isEnvDefinedFalsy,
      parseAutoPercentage: upstream("mcp-auto-percentage", "parseAutoPercentage", { Math, isNaN, parseInt, logForDebugging() {} }),
      isAutoToolSearchMode: upstream("mcp-auto-mode", "isAutoToolSearchMode"),
    });
    const modeOf = (value) => {
      env.ENABLE_TOOL_SEARCH = value;
      return getToolSearchMode();
    };
    const modeRows = [undefined, "true", "false", "auto", "auto:20", "auto:0", "auto:100"].map((value) => ({
      ENABLE_TOOL_SEARCH: value ?? "(未设置)",
      模式: modeOf(value),
      含义: { tst: "总是推迟 MCP 工具", "tst-auto": "工具定义超过上下文的 N% 才推迟", standard: "不推迟，全部直接放进请求" }[modeOf(value)],
    }));
    t.table(modeRows);
    t.equal("未设置时是 tst；auto:0 等于 true；auto:100 等于 false", [modeRows[0].模式, modeRows[5].模式, modeRows[6].模式], ["tst", "tst", "standard"]);
    t.log("（原函数 getToolSearchMode。注意：没设置时是“总是推迟”，但在 ANTHROPIC_BASE_URL 指向第三方网关时，另一个函数会把它关掉，见录制。）");
    t.log();

    const isDeferredTool = upstream("mcp-is-deferred", "isDeferredTool", {
      feature: () => false, isReplBridgeActive: () => false, getFeatureValue_CACHED_MAY_BE_STALE: () => false,
      TOOL_SEARCH_TOOL_NAME: "ToolSearch", AGENT_TOOL_NAME: "Agent", BRIEF_TOOL_NAME: null, SEND_USER_FILE_TOOL_NAME: null,
    });
    const toolKinds = [
      ["Read", { name: "Read" }],
      ["WebFetch（shouldDefer）", { name: "WebFetch", shouldDefer: true }],
      ["ToolSearch 自己", { name: "ToolSearch" }],
      ["mcp__issues__search_issues", { name: "mcp__issues__search_issues", isMcp: true }],
      ["同上，服务器声明了 alwaysLoad", { name: "mcp__issues__search_issues", isMcp: true, alwaysLoad: true }],
    ];
    t.table(toolKinds.map(([工具, tool]) => ({ 工具, 推迟加载: isDeferredTool(tool) ? "是" : "否" })));
    t.log();

    // 已经加载了哪些推迟的工具？不另存状态：每次请求，从对话里的 tool_reference 块重新算
    const extract = upstream("mcp-discovered-tools", "extractDiscoveredToolNames", {
      Set,
      Array,
      logForDebugging() {},
      isToolResultBlockWithContent: (block) => block?.type === "tool_result" && Array.isArray(block.content),
      isToolReferenceWithName: (item) => item?.type === "tool_reference" && typeof item.tool_name === "string",
    });
    const user = (...content) => ({ type: "user", message: { content } });
    const assistant = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
    const loaded = (...names) => user({ type: "tool_result", tool_use_id: "t", content: names.map((tool_name) => ({ type: "tool_reference", tool_name })) });
    const histories = [
      ["刚开始，还没搜索过", [user({ type: "text", text: "有哪些和压缩有关的 issue？" })]],
      ["ToolSearch 返回了 search_issues 的引用", [user({ type: "text", text: "…" }), assistant("先加载工具"), loaded("mcp__issues__search_issues")]],
      ["又加载了 create-issue", [user({ type: "text", text: "…" }), loaded("mcp__issues__search_issues"), assistant("…"), loaded("mcp__issues__create-issue")]],
      ["压缩之后：旧消息没了，边界记号带着名单", [{ type: "system", subtype: "compact_boundary", compactMetadata: { preCompactDiscoveredTools: ["mcp__issues__search_issues", "mcp__issues__create-issue"] } }, user({ type: "text", text: "摘要…" })]],
    ];
    const pool = ["Read", "Bash", "ToolSearch", "mcp__issues__search_issues", "mcp__issues__create-issue", "mcp__issues__dump_log"];
    const deferredNames = new Set(pool.filter((name) => name.startsWith("mcp__")));
    const sent = (history) => {
      const discovered = new Set(plain([...extract(history)]));
      //（claude.ts 里的过滤规则，按它的意思写）没推迟的都带；推迟的只带“已经加载过”的
      return pool.filter((name) => !deferredNames.has(name) || discovered.has(name));
    };
    t.table(
      histories.map(([时刻, history]) => ({
        时刻,
        "这次请求带上的工具": sent(history).join("、"),
      })),
    );
    t.equal("加载状态完全由对话内容决定", histories.map(([, h]) => sent(h).length), [3, 4, 5, 5]);
    t.log("没有一个单独的“已加载工具”变量：对话里有 tool_reference，就带上它；压缩时把名单写进边界记号。");
    t.log("端口：对话消息是手写的几条；判断“这是不是 tool_reference 块”的两个小函数是合成的。");
  }
});
