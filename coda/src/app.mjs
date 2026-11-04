// 第 13 章：总装。把第 1～12 章的模块按 Claude Code 的方式接成一个能干活的 Coding Agent。
//
// Claude Code 里这件事分在三个地方，coda 把它们压进 createCoda 一个函数：
//   main.tsx          参数 → 权限上下文 → getTools() → 连接 MCP → 加载 Agent 定义 → 交给 runHeadless
//   QueryEngine.ts    submitMessage()：取系统提示和上下文、把提问先写进会话文件、组出 ToolUseContext、调用 query()
//   query.ts          每一圈：压缩 → 带着上下文请求模型 → 执行工具 → 附件（排队的消息、子目录说明）→ Stop Hook
//
// 下面每个小节对应其中一件事，注释里写明它在哪一章讲过：
//   一、规则和权限闸门   规则是“活”的：Skill 授予的工具规则随调用出现；Hook 的 allow / ask 意见并入闸门
//   二、工具池           内置工具 + MCP + Skill + Agent；按名字排序（前缀稳定）；被整体禁用的工具模型看不到
//   三、对话与会话文件   先写后发；压缩的结果写回文件，下一次请求从新的根接着走
//   四、一次运行         SessionStart → 斜杠命令 → UserPromptSubmit → Skill 目录 → Engine 主循环
//
// 和 Claude Code 相比的简化：
//   · 没有配置文件的来源合并，规则、模式、Hook 都由调用者直接传入；
//   · 没有 git 状态、日期变更提醒、自动记忆；项目说明只读工作区里的 CLAUDE.md（和子目录里按需加载的那些）；
//   · 子 Agent 只有前台一种；它的项目说明仍放在 system 里（runChild 的接口如此），主 Agent 则放在第一条用户消息里；
//   · 一次只处理一个提问：Engine 的队列（steer / follow）可以在运行中追加，但 app 不排队多个 run()。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Engine } from "./engine.mjs";
import { codingTools } from "./files.mjs";
import { Toolset } from "./tools.mjs";
import { mergeRules, permissionGate, ruleStage } from "./permissions.mjs";
import { buildRequest, snapshotContext } from "./request.mjs";
import { Hooks } from "./hooks.mjs";
import { NestedMemory, formatMemories, memoryPrompt, sessionMemory } from "./memory.mjs";
import { Skills, discoverSkillFiles } from "./skills.mjs";
import { BUILT_IN_AGENTS, reportForParent, runChild } from "./subagents.mjs";
import { Session, restore } from "./session.mjs";
import { estimate } from "./compact.mjs";
import { connectMcpServers } from "./mcp.mjs";
import { detectBackend } from "../../runtime/sandbox.mjs";
import { workspacePath } from "../../runtime/files.mjs";

// 默认的系统提示：稳定、不随项目变化。项目说明（CLAUDE.md）不放这里，放在第一条用户消息里（第 2、4 章）
const DEFAULT_PROMPT =
  "你是 coda，一个在用户的工作区里读代码、改代码、运行测试的助手。先读后改，改动要小，收工前用 Test 验证。" +
  "用户消息里的项目说明是用户的要求，优先于你的习惯。";

const reminder = (text) => `<system-reminder>\n${text}\n</system-reminder>`;
const metaMessage = (text, extra = {}) => ({ role: "user", meta: true, text: reminder(text), ...extra });

// ───────────────────────── 一、规则和权限闸门 ─────────────────────────

// 规则是一个“活”的对象：每次读 allow，都会把 Skill 此刻授予的工具规则并进去。
// Skill 的 allowed-tools 是授权，不是限制（第 9 章）；它只在这一次运行里有效（run() 开头 resetGrants）。
function liveRules(rules, getSkills) {
  return {
    get allow() {
      return [...(rules.allow ?? []), ...(getSkills()?.grantedRules() ?? [])];
    },
    get ask() {
      return rules.ask ?? [];
    },
    get deny() {
      return rules.deny ?? [];
    },
  };
}

// 对应 resolveHookPermissionDecision（第 6、7 章）：PreToolUse Hook 的意见不能越过规则。
//   Hook 说 allow  相当于多一条整个工具的 allow 规则：跳过询问，但 deny / ask 规则和受保护路径仍然优先；
//   Hook 说 ask    相当于多一条整个工具的 ask 规则：即使模式本来放行，也要问；
//   Hook 说 deny   Hooks.before 已经拦下，走不到这里。
// Toolset 的闸门只收到 (call, tool, signal)，看不到 Hook 的意见，所以由 before 把意见按 call.id 记下来，闸门再取。
function hookAwareGate({ root, rules, mode, ask, onDecision, opinions }) {
  return async (call, tool, signal) => {
    const opinion = opinions.get(call.id);
    opinions.delete(call.id);
    const effective = mergeRules(rules, {
      allow: opinion === "allow" ? [call.name] : [],
      ask: opinion === "ask" ? [call.name] : [],
    });
    return permissionGate({ root, rules: effective, mode, ask, onDecision })(call, tool, signal);
  };
}

// 包一层，让 Toolset 看到的 hooks 只多做一件事：把 PreToolUse 的权限意见留给闸门。
function recordingHooks(hooks, opinions) {
  return {
    async before(call, context) {
      const result = await hooks.before(call, context);
      if (result.permission) opinions.set(call.id, result.permission);
      return result;
    },
    after: (call, result, context) => hooks.after(call, result, context),
  };
}

// ───────────────────────── 二、工具池 ─────────────────────────

// 对应 assembleToolPool：内置工具和 MCP 工具各自按名字排序，内置的排在前面；重名时内置的赢。
// 排序是为了请求的前缀稳定（第 2 章）：MCP 工具的名字插进内置工具中间，后面所有缓存都要重算。
function assembleToolPool(builtIn, extra) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const pool = new Map();
  for (const tool of [...[...builtIn].sort(byName), ...[...extra].sort(byName)]) if (!pool.has(tool.name)) pool.set(tool.name, tool);
  return [...pool.values()];
}

// 对应 filterToolsByDenyRules：被整个禁用的工具，模型根本看不到（不是调用时才拒绝）。
function visibleTools(pool, rules) {
  return pool.filter((tool) => ruleStage(tool.name, rules)?.source !== "explicit-deny");
}

// 工具的 execute 外面包一层：失败时触发 PostToolUseFailure，成功时让调用者看一眼结果。
// Toolset 把工具抛出的错误直接变成错误结果，Hook 一侧不会收到通知，所以在工具这一层补上（第 7 章）。
function instrumented(tool, { hooks, afterResult }) {
  return {
    ...tool,
    async execute(input, context) {
      const failed = (error) =>
        hooks
          .fire("PostToolUseFailure", { tool_name: tool.name, tool_input: input, error }, { query: tool.name, context })
          .catch(() => {});
      let result;
      try {
        result = await tool.execute(input, context);
      } catch (error) {
        await failed(String(error.message ?? error));
        throw error;
      }
      if (result?.error) await failed(result.text);
      afterResult?.(tool, input, result);
      return result;
    },
  };
}

// Agent 工具（第 10 章）。三件事要接对：
//   makeTools    子 Agent 拿一套全新的内置工具，文件版本记录不和父 Agent 共用：
//                子 Agent 读过的文件，父 Agent 没读过就不能改；
//   permissions  走父 Agent 同一套规则（活对象），子 Agent 不是绕过审批的后门；
//   默认 Explore  只读的搜索专家，用便宜的小模型（这里是 childModel() 给的那个）。
function agentTool({ root, childModel, makeTools, permissions, hooks, memories }) {
  return {
    name: "Agent",
    description: "Delegate a task to a sub-agent that works in its own context. agent: Explore (read-only search, default) or general-purpose.",
    parallel: true,
    schema: {
      type: "object",
      properties: { task: { type: "string" }, agent: { type: "string", enum: Object.keys(BUILT_IN_AGENTS) } },
      required: ["task"],
    },
    validate(input) {
      if (typeof input.task !== "string" || !input.task.trim()) throw Error("task required");
      if (input.agent !== undefined && !BUILT_IN_AGENTS[input.agent]) throw Error(`unknown agent type: ${input.agent}`);
    },
    async execute(input, context) {
      const child = await runChild(
        {
          agent: input.agent ?? "Explore",
          model: childModel(),
          makeTools,
          permissions,
          hooks,
          memories: memories(),
          context: { root },
          signal: context.signal,
        },
        input.task,
      );
      const finished = ["completed", "budget"].includes(child.terminal.status);
      return {
        text: reportForParent(child),
        error: !finished,
        details: { agentId: child.id, toolUses: child.toolUses, tools: child.toolNames },
      };
    },
  };
}

// ───────────────────────── 三、对话与会话文件 ─────────────────────────

// 对应 QueryEngine 里的 mutableMessages + recordTranscript，以及压缩之后“从新的根接着走”。
//
// 三条规则：
//   1. 先写后发：每次请求之前，把还没写进文件的消息追加进去。进程在模型思考时被杀，文件里也有提问和之前的全部结果
//      （QueryEngine 在进入 query() 之前就 recordTranscript，注释写明原因：否则 --resume 找不到这次对话）；
//   2. 压缩写回：完整压缩的结果作为新的根写进文件（Session.appendCompaction）。之后的请求用
//      “压缩结果 + 压缩之后新增的消息”作为视图，不再重复请求摘要；
//   3. 没有会话文件时退化成内存里的一份历史，同一个 app 的多次 run() 仍然接得上。
class Conversation {
  constructor(session) {
    this.session = session;
    this.held = []; //        没有会话文件时，上一次运行结束时的对话
    this.started = false; //  这个 app 是否已经触发过 SessionStart
    this.reset([]);
  }

  // 新的一次运行开始：history 是已经在文件里的部分
  reset(history) {
    this.persisted = history.length; // engine.messages 里前这么多条已经写过了
    this.base = undefined; //          完整压缩之后：{ upTo, view }
  }

  history() {
    return this.session ? restore(this.session.history()).messages : structuredClone(this.held);
  }

  // engine 给出的完整消息列表 → 把没写过的追加进文件
  flush(messages) {
    if (this.session) for (const message of messages.slice(this.persisted)) this.session.append(message);
    this.persisted = messages.length;
  }

  // 请求用的视图：压缩过就是“压缩结果 + 之后新增的”，否则就是 engine 的消息本身
  view(messages) {
    return this.base ? [...this.base.view, ...messages.slice(this.base.upTo)] : messages;
  }

  adoptCompaction(messages, result) {
    this.flush(messages);
    this.session?.appendCompaction(result);
    this.base = { upTo: messages.length, view: result };
  }

  finish(messages) {
    this.flush(messages);
    this.held = this.view(messages);
  }
}

// ───────────────────────── 四、createCoda ─────────────────────────

/**
 * 参数（带 * 的是总装新增的）：
 *   root, model                   工作区，模型端口（Engine 的 model）
 *   rules, mode, ask              权限：规则 { allow, ask, deny }，模式，询问用户的回调
 *   hooks                         Hooks 实例（第 7 章）
 *   extraTools                    额外的工具对象（比如自己连好的 MCP 工具）
 *   mcpServers *                  { 名字: { command, args, env } }：由 app 连接，工具名是 mcp__名字__工具；close() 时一并退出
 *   skillPaths, childModel        Skill 来源文件；子 Agent 的模型工厂（不给就没有 Agent 工具）
 *   compactor                     Compactor 实例（第 5 章）；压缩的结果会写回会话文件
 *   sessionFile                   会话文件；不给就只在内存里保留历史
 *   resultDir *                   大结果落盘的目录，缺省在会话文件旁边的 tool-results/
 *   sandbox, sandboxRequired *    Test 要不要进沙箱；沙箱起不来时缺省警告后不加沙箱运行（和 Claude Code 一致），sandboxRequired 才抛错
 *   now *, onDecision *           固定“今天”的日期；观察每次权限决定
 */
export function createCoda({
  root,
  model,
  hooks = new Hooks(),
  rules = {},
  mode = "default",
  ask,
  extraTools = [],
  mcpServers,
  prompt = { defaults: [DEFAULT_PROMPT] },
  sessionFile,
  onEvent,
  cleanup,
  compactor,
  skillPaths = [],
  childModel,
  sandbox = false,
  sandboxRequired = false,
  resultDir = join(sessionFile ? dirname(sessionFile) : join(root, ".coda"), "tool-results"),
  now = new Date(),
  onDecision,
}) {
  hooks.root ??= root;

  // ── 沙箱：起不来怎么办（第 11 章）
  let useSandbox = Boolean(sandbox);
  if (useSandbox) {
    const backend = detectBackend();
    if (!backend.name) {
      if (sandboxRequired) throw Error(`sandbox unavailable: ${backend.reason}`);
      onEvent?.({ type: "warning", text: `沙箱不可用（${backend.reason}），改为不加沙箱运行` });
      useSandbox = false;
    }
  }

  // ── 规则与闸门
  let skills;
  const permissionRules = liveRules(rules, () => skills);
  const opinions = new Map(); // call.id → Hook 的权限意见
  const gate = hookAwareGate({ root, rules: permissionRules, mode, ask, onDecision, opinions });

  // ── 上下文：整个会话只取一次快照（第 2、4 章）
  const memory = sessionMemory({ cwd: root, root });
  const nested = new NestedMemory({ cwd: root, root });
  let context;
  const sessionContext = () =>
    (context ??= snapshotContext({ claudeMd: formatMemories(memory.get()), now }));

  // ── 工具池
  const makeTools = () => codingTools(root, { sandbox: useSandbox });
  const afterResult = (tool, input, result) => {
    // 模型读了一个文件：它所在的子目录里的说明，排在这批工具结果后面送出去（第 4 章）
    if (tool.name !== "Read" || result.error) return;
    nested.noteRead(input.path);
    for (const message of nested.collect()) engine.steer(message.text);
  };
  const builtIn = makeTools();
  const extra = [...extraTools];

  if (!skillPaths.length) skillPaths = discoverSkillFiles(root);
  if (skillPaths.length) {
    skills = new Skills(root, skillPaths, {
      // context: fork 的 Skill 在子 Agent 里运行，授权只加给子 Agent
      fork: childModel
        ? async ({ prompt: body, grants, signal }) => {
            const permissions = { root, mode, ask, rules: mergeRules(permissionRules, { allow: grants }) };
            const child = await runChild({ agent: "general-purpose", model: childModel(), makeTools, permissions, hooks, signal }, body);
            return child.text;
          }
        : undefined,
    });
    builtIn.push(skills.tool({ rules: permissionRules }));
  }
  if (childModel) {
    const permissions = { root, mode, ask, rules: permissionRules };
    const memories = () => memoryPrompt(memory.get());
    builtIn.push(agentTool({ root, childModel, makeTools, permissions, hooks, memories }));
  }

  let pool = [];
  const tools = new Toolset([], { gate, hooks: recordingHooks(hooks, opinions), resultDir });
  const install = () => {
    pool = assembleToolPool(builtIn, extra).map((tool) => instrumented(tool, { hooks, afterResult }));
    tools.tools = new Map(pool.map((tool) => [tool.name, tool]));
  };
  install();

  // ── 对话
  const session = sessionFile ? new Session(sessionFile) : undefined;
  const conversation = new Conversation(session);
  const schemaCache = new Map(); // 工具定义整个会话只渲染一次（第 2 章）

  // 每次请求：先写后发 → 压缩 → 组装请求。engine.queryLoop 每一圈都会调用它
  async function request(messages) {
    conversation.flush(messages);
    const view = await compactIfDue(conversation.view(messages), messages);
    return buildRequest(view, {
      prompt,
      tools: visibleTools(pool, permissionRules),
      userContext: sessionContext().userContext,
      systemContext: sessionContext().systemContext,
      schemaCache,
    });
  }

  async function compactIfDue(view, messages) {
    if (!compactor) return view;
    compactor.readFile ??= (path) => {
      try {
        return readFileSync(workspacePath(root, path), "utf8");
      } catch {
        return undefined;
      }
    };
    const due = estimate(view) >= compactor.limit();
    const extras = due ? await compactionExtras() : {};
    const result = await compactor.compact(view, { ...extras, transcript: sessionFile });
    if (!result.changed) return view;
    if (result.summarized === undefined) return result.messages; // 微压缩：只改这一次请求的视图，文件不动
    // 完整压缩：旧记录一条不删，新记录从摘要开始成为新的根。项目说明和子目录说明要重新加载
    conversation.adoptCompaction(messages, result.messages);
    memory.clear();
    context = undefined;
    nested.reset();
    return result.messages;
  }

  // 压缩之后要重新附上的内容：调用过的 Skill（第 9 章），以及 SessionStart(compact) Hook 的补充信息（第 7 章）
  async function compactionExtras() {
    const attachments = [];
    const recalled = skills?.recall();
    if (recalled) attachments.push(metaMessage(recalled));
    const start = await hooks.sessionStart("compact", { root });
    const hookResults = start.context.length ? [metaMessage(start.context.join("\n"))] : [];
    return { attachments, hookResults };
  }

  const engine = new Engine({
    model,
    tools,
    request,
    onEvent,
    onCleanup: cleanup,
    onStop: (input) => hooks.stop(input), // Stop Hook 能把“做完了”的运行再推一圈（第 7 章）
  });

  // ── MCP：第一次运行前连接（headless 模式也是等所有服务器连完再开始第一轮）
  let mcp;
  let started = false;
  async function start() {
    if (started) return mcp?.servers ?? [];
    started = true;
    if (mcpServers) {
      mcp = await connectMcpServers(mcpServers, { resultDir }); // 永远不抛：连不上的服务器记为 failed
      onEvent?.({ type: "mcp_status", servers: mcp.servers });
      extra.push(...mcp.tools);
      install();
    }
    return mcp?.servers ?? [];
  }

  // ── 一次运行开始前，要放进对话的额外消息
  async function preamble(text, history, signal) {
    const messages = [];
    let question = text;

    // SessionStart：这个 app 的第一次运行。已有历史就是 resume
    if (!conversation.started) {
      conversation.started = true;
      const begun = await hooks.sessionStart(history.length ? "resume" : "startup", { root, signal });
      if (begun.context.length) messages.push(metaMessage(begun.context.join("\n")));
    }

    // 用户输入的 /名字：Skill 的另一扇门，正文变成这一轮的提问
    const slash = await skills?.slash(text, { signal });
    if (slash?.rejected) return { refused: { reason: "slash_rejected", detail: slash.text } };
    if (slash) question = `${slash.label}\n\n${slash.text}`;

    // UserPromptSubmit：被拦下的提示不会发给模型，也不写进会话文件
    const submitted = await hooks.userPromptSubmit(text, { root, signal });
    if (submitted.blocked) return { refused: { reason: "prompt_blocked", detail: submitted.reason } };
    if (submitted.context.length) messages.push(metaMessage(submitted.context.join("\n")));

    // Skill 目录是对话里的一条附件，只发没发过的（第 9 章）；恢复的会话里已经有了就不重发
    const listing = skills?.announce();
    if (listing && !history.some((m) => m.kind === "skill-listing"))
      messages.push(metaMessage(`The following skills are available for use with the Skill tool:\n\n${listing}`, { kind: "skill-listing" }));

    return { messages, question };
  }

  return {
    engine,
    tools,
    session,
    start,

    async run(text, options = {}) {
      await start();
      skills?.resetGrants(); // Skill 的授权只管这一次运行
      opinions.clear();

      const history = conversation.history();
      const prepared = await preamble(text, history, options.signal);
      if (prepared.refused) {
        const terminal = { type: "terminal", status: "stopped", reason: prepared.refused.reason, iterations: 0, messages: history, detail: prepared.refused.detail };
        onEvent?.(terminal);
        return { frames: [terminal], terminal };
      }

      const base = [...history, ...prepared.messages];
      conversation.reset(history);
      const frames = [];
      for await (const frame of engine.run(prepared.question, { ...options, history: base, context: { root } })) {
        frames.push(frame);
      }
      const terminal = frames.at(-1);
      conversation.finish(terminal.messages);
      return { frames, terminal };
    },

    // 关闭 MCP 服务器进程。可以重复调用
    async close() {
      const closing = mcp;
      mcp = undefined;
      await closing?.close();
    },
  };
}
