// 第 10 章：子 Agent。
//
// 对应 Claude Code 2.1.88 的这些位置：
//   tools/AgentTool/AgentTool.tsx        call()：选定义 → 装配工具池 → 前台等结果 / 后台立刻返回
//   tools/AgentTool/runAgent.ts          runAgent()：给子 Agent 装配上下文，然后跑同一个 query()
//   tools/AgentTool/agentToolUtils.ts    filterToolsForAgent / resolveAgentTools 缩小工具池；
//                                        finalizeAgentTool 决定交回哪一段文字
//   tools/AgentTool/built-in/*.ts        general-purpose、Explore 这些内置定义
//   tasks/LocalAgentTask/                后台子 Agent 的登记、取消，以及结束后的 <task-notification>
//
// 本章实现的机制（正文里每一条都有对应的 @cc 摘录）：
//   1. 子 Agent 由一份“定义”描述：系统提示、工具清单、要不要带项目说明；
//   2. 工具池分三层缩小：所有子 Agent 共用的禁用清单（不嵌套）→ 定义的禁用清单 → 定义的允许清单；
//   3. 上下文默认隔离：只看到任务说明；文件版本记录也是一份新的；fork 才带上父历史；
//   4. 权限只收紧不放宽：每次调用走父 Agent 同一套规则，后台没有人可以问，要问人的一律拒绝；
//   5. 只交回最后一条有文字的回复，再附一行统计；
//   6. 取消：前台共用父 Agent 的信号；后台独立运行，要单独停，停下来也交回已经做出的部分。
//
// 和原版相比的简化：
//   · 没有 SubagentStart / SubagentStop 事件、frontmatter 里的 hooks / mcpServers / skills、worktree 隔离；
//   · 没有用 SendMessage 继续一个已经结束的子 Agent；
//   · 前台不会在运行中途被“转入后台”；
//   · 原版 2.1.88 发布版里 fork 被编译掉了，这里保留这个选项，是为了让读者看到“带上父历史”的后果。
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Engine, collect } from "./engine.mjs";
import { Toolset } from "./tools.mjs";
import { buildRequest } from "./request.mjs";
import { permissionGate } from "./permissions.mjs";
import { Session } from "./session.mjs";

// ───────────────────────── 一、子 Agent 的定义 ─────────────────────────
//
// 原版的 AgentDefinition。内置的写在代码里，自定义的来自 .claude/agents/*.md 的 frontmatter。
//   type             名字。Agent 工具的 subagent_type 填它
//   prompt           系统提示。子 Agent 用自己的，不继承父 Agent 的
//   tools            允许清单。["*"] 或者不写，表示父工具池里（被禁用的除外）全部
//   disallowedTools  禁用清单，从池里减掉
//   omitMemory       不带项目说明（原版叫 omitClaudeMd）：只读的搜索用不着提交规范，省 token
//   model            "inherit"（缺省）或者一个别名，别名对应哪个模型由调用者的 models 表决定
//   permissionMode   覆盖权限模式（父 Agent 已经放开时不覆盖，见 childGate）
//   oneShot          只跑一次、不会被继续：交回的报告不用附 agentId 和统计
//   maxTurns         最多几轮；不写就用 Engine 的默认安全阀
export const BUILT_IN_AGENTS = {
  "general-purpose": {
    type: "general-purpose",
    prompt:
      "你是一个子 Agent，负责独立完成交给你的任务。调用你的 Agent 看不到你中间做过的事，" +
      "只会读到你最后一条回复，所以用一份简短的报告收尾：做了什么、关键发现、相关文件的路径。",
    tools: ["*"],
  },
  Explore: {
    type: "Explore",
    prompt:
      "你是代码库的搜索专家，只读：不创建、不修改、不删除任何文件。" +
      "先搜索定位，再读关键的片段，尽量一次发出多个互不依赖的调用。" +
      "最后的报告写清楚：结论、相关文件的路径和行号。",
    disallowedTools: ["Edit", "Write"],
    omitMemory: true,
    model: "haiku", // 外部用户默认用便宜的小模型：搜索不需要最强的推理
    oneShot: true,
  },
};

// 调用者没有指定 agent 时的缺省定义：只读，只给 allow 里列的工具（缺省只有 Read）。
// 这是本章之前 runChild 一直的行为，保留下来保证向后兼容。
function legacyDefinition(allow = ["Read"]) {
  return { type: "read-only", tools: allow };
}

function resolveDefinition(agent, allow) {
  if (agent === undefined) return legacyDefinition(allow);
  const found = typeof agent === "string" ? BUILT_IN_AGENTS[agent] : agent;
  if (!found) throw Error(`unknown agent type: ${agent}`);
  return allow ? { ...found, tools: allow } : found;
}

// ───────────────────────── 二、缩小工具池 ─────────────────────────
//
// 对应 filterToolsForAgent + resolveAgentTools。三层，顺序不能换：
//   ① 所有子 Agent 共用的禁用清单；
//   ② 定义里的 disallowedTools；
//   ③ 定义里的 tools 允许清单（["*"] 表示不再收缩）。
// 同一个工具被多层拦下时，只记第一层——这样 removed 里的“原因”是确定的。
//
// ① 在 2.1.88 发布版里包括 Agent：子 Agent 不能再派子 Agent。
// 源码里这一条写成“只有 USER_TYPE === 'ant' 才放行”，所以对外部用户永远成立。
const NEVER_FOR_CHILD = new Set(["Agent"]);

export function resolveChildTools(definition, parentTools) {
  const disallowed = new Set(definition.disallowedTools ?? []);
  const allowed = new Set(definition.tools ?? []);
  const keepAll = !definition.tools || allowed.has("*");
  const tools = [];
  const removed = [];
  for (const tool of parentTools) {
    if (NEVER_FOR_CHILD.has(tool.name)) removed.push({ name: tool.name, layer: "① 所有子 Agent 共用的禁用清单" });
    else if (disallowed.has(tool.name)) removed.push({ name: tool.name, layer: "② 定义的禁用清单" });
    else if (!keepAll && !allowed.has(tool.name)) removed.push({ name: tool.name, layer: "③ 不在定义的允许清单里" });
    else tools.push(tool);
  }
  return { tools, removed };
}

// ───────────────────────── 三、权限、模型、历史 ─────────────────────────

// 子 Agent 的权限闸门。对应 runAgent 里的 agentGetAppState：
//   · 规则和父 Agent 是同一套，所以子 Agent 不会成为绕过审批的后门；
//   · 定义可以指定自己的模式（比如 plan），但父 Agent 已经是 bypassPermissions / acceptEdits 时，
//     以父 Agent 为准——父 Agent 更宽松的授权不会被子 Agent 的定义收回去；
//   · 后台子 Agent 没有界面、没有人可以问：需要问人的调用一律按拒绝处理。
export function childGate(definition, permissions, { background = false } = {}) {
  if (!permissions) return undefined;
  const { mode = "default", rules = {}, ask, root } = permissions;
  const parentIsLoose = mode === "bypassPermissions" || mode === "acceptEdits";
  const childMode = definition.permissionMode && !parentIsLoose ? definition.permissionMode : mode;
  return permissionGate({ root, rules, mode: childMode, ask: background ? async () => false : ask });
}

// 对应 getAgentModel：调用参数 > 定义里的 model > 继承父 Agent。
// 别名（haiku、sonnet……）在 models 表里找；表里没有就退回父 Agent 的模型。
// 原版还有一个环境变量 CLAUDE_CODE_SUBAGENT_MODEL 排在最前面，这里没有。
export function resolveChildModel({ definition, requested, parentModel, models = {} }) {
  const choice = requested ?? definition.model ?? "inherit";
  return choice === "inherit" ? parentModel : (models[choice] ?? parentModel);
}

// 对应 filterIncompleteToolCalls：父历史里可能有还没拿到结果的工具调用（正在执行的那几个）。
// 把这样的 assistant 消息整条去掉，免得子 Agent 的第一次请求里出现没有结果的 tool_use，被 API 拒绝。
export function trimDanglingCalls(history) {
  const answered = new Set(history.filter((m) => m.role === "tool").map((m) => m.id));
  return history.filter((m) => !(m.role === "assistant" && m.calls?.some((call) => !answered.has(call.id))));
}

// ───────────────────────── 四、交回什么 ─────────────────────────

// 对应 finalizeAgentTool：只取最后一条“有文字的”assistant 回复。
// 最后一条如果只有工具调用（比如被轮数上限截住了），就往前找最近一条有文字的。
// 中间的每一次搜索、每一份读到的文件，都不会交回去——这才是“独立上下文”的意义。
export function summarizeRun(frames) {
  const replies = frames.filter((f) => f.type === "assistant").map((f) => f.message);
  const lastWithText = replies.findLast((m) => m.text?.trim());
  return {
    text: lastWithText?.text ?? "",
    toolUses: replies.reduce((count, m) => count + m.calls.length, 0),
  };
}

// 对应 mapToolResultToToolResultBlockParam 的“completed”分支：父 Agent 的 tool_result 里放什么。
//   · 空报告换成一句话：一条什么都没有的 tool_result 放在末尾，有的模型会以为这一轮已经说完（第 3 章同一个坑）；
//   · 会被继续的 Agent 附上 agentId 和统计；Explore 这类只跑一次的不附，每次省下一小段 token。
export function reportForParent(child) {
  const body = child.text.trim() || "(子 Agent 完成了，但没有给出任何文字。)";
  if (child.definition.oneShot) return body;
  return `${body}\nagentId: ${child.id}\n<usage>tool_uses: ${child.toolUses}\nrequests: ${child.terminal.iterations ?? 0}</usage>`;
}

// ───────────────────────── 五、运行一个子 Agent（前台）─────────────────────────

// options:
//   agent          内置类型名或一份定义；不给就是只读的缺省定义
//   allow          覆盖定义的 tools 允许清单（旧接口，缺省 ["Read"]）
//   tools          父 Agent 的工具；子 Agent 从中挑选
//   makeTools      工厂函数，给子 Agent 一套全新的工具。传了它，tools 就不用传。
//                  （区别见 runChild 里“文件版本记录”那一段）
//   model          父 Agent 的模型；models / requestedModel 见 resolveChildModel
//   permissions    父 Agent 的权限配置 { mode, rules, ask, root }；gate 是现成的闸门，优先于 permissions
//   hooks          父 Agent 的 Hook：对子 Agent 的每次工具调用同样生效
//   memories       父 Agent 注入的项目说明（memoryPrompt 的结果）；定义 omitMemory 时不带
//   parentHistory  fork 时才用到
//   signal         父 Agent 的取消信号。前台子 Agent 直接共用它
//   transcriptDir  给了就把子 Agent 的完整对话写成 agent-<id>.jsonl（原版的 sidechain 会话文件）
//   id             调用者预先分配的 id（后台登记用）
//   background     是不是后台运行：影响权限（没人可问），其余和前台一样
export async function runChild(options, task) {
  const {
    agent,
    allow,
    tools,
    makeTools,
    model,
    models,
    requestedModel,
    permissions,
    gate,
    hooks,
    memories = [],
    parentHistory = [],
    signal,
    fork = false,
    context = {},
    maxTurns,
    transcriptDir,
    id = randomUUID(),
    background = false,
  } = options;
  const definition = resolveDefinition(agent, allow);
  const startedAt = Date.now();

  // 文件版本记录（第 3 章的 readFileState）是“这个模型看到过什么”的记忆。
  // 原版给非 fork 的子 Agent 一份全新的空记录；coda 的记录藏在 codingTools() 的闭包里，
  // 所以要隔离就得让子 Agent 拿一套新建的工具（makeTools）。
  // 如果直接共用父 Agent 的 tools：子 Agent 读过的文件，父 Agent 没读过也能改——它根本没看过那份内容。
  const pool = makeTools ? makeTools() : tools;
  const { tools: selected } = resolveChildTools(definition, pool);
  const toolset = new Toolset(selected, {
    gate: gate ?? childGate(definition, permissions, { background }),
    hooks,
  });

  // 系统提示是定义自己的；项目说明默认带，定义要求省掉就不带。
  const prompt = definition.prompt ? { agent: definition.prompt } : {};
  const inheritedMemories = definition.omitMemory ? [] : memories;
  const engine = new Engine({
    model: resolveChildModel({ definition, requested: requestedModel, parentModel: model, models }),
    tools: toolset,
    request: (messages) => buildRequest(messages, { prompt, tools: selected, memories: inheritedMemories }),
  });

  // signal 直接交给子 Engine：前台子 Agent 和父 Agent 共用同一个信号，父 Agent 按 Esc，
  // 子 Agent 的模型请求和工具调用一起收到取消。后台子 Agent 的 signal 由 BackgroundChildren 另外创建。
  const frames = await collect(engine, task, {
    context,
    signal,
    history: fork ? trimDanglingCalls(parentHistory) : [],
    maxTurns: maxTurns ?? definition.maxTurns,
  });
  const terminal = frames.at(-1);

  // 子 Agent 自己的账本：完整对话写进单独的文件，父 Agent 的会话里只有 Agent 工具的那一条结果。
  if (transcriptDir) {
    const log = new Session(join(transcriptDir, `agent-${id}.jsonl`));
    for (const message of terminal.messages) log.append(message);
  }

  return {
    id,
    agent: definition.type,
    definition,
    frames,
    terminal,
    toolNames: selected.map((tool) => tool.name),
    durationMs: Date.now() - startedAt,
    ...summarizeRun(frames),
  };
}

// ───────────────────────── 六、后台子 Agent ─────────────────────────
//
// 对应 registerAsyncAgent / runAsyncAgentLifecycle / enqueueAgentNotification。
//   · launch() 立刻返回 id，子 Agent 在后台跑；
//   · 它有自己独立的 AbortController，不连父 Agent 的信号——父 Agent 按 Esc 停不了它，要用 stop(id)；
//   · 结束（完成、失败、被停）时，用 notify 把一段 <task-notification> 文字交给父 Agent。
//     原版把它排进消息队列，优先级是 later，等当前这一轮结束再作为新的一轮处理；
//     在 coda 里 notify 通常就是 engine.follow。
export class BackgroundChildren {
  constructor({ notify = () => {} } = {}) {
    this.notify = notify;
    this.tasks = new Map();
  }

  launch(options, task, { description = task.slice(0, 40) } = {}) {
    const id = randomUUID();
    const controller = new AbortController();
    const entry = { id, description, status: "running", controller };
    this.tasks.set(id, entry);
    entry.done = runChild({ ...options, id, signal: controller.signal, background: true }, task).then(
      (child) => this.finish(entry, child),
      (error) => this.finish(entry, undefined, error),
    );
    return { id };
  }

  // 对应 killAsyncAgent：只有还在运行的任务才能被停；标成 killed 和发取消信号在同一个同步块里完成。
  // 运行收尾时（finish）靠这个状态区分“被停的”和“失败的”。
  stop(id) {
    const entry = this.tasks.get(id);
    if (entry?.status !== "running") return false;
    entry.status = "killed";
    entry.controller.abort(Error("stopped by user"));
    return true;
  }

  // 对应进程退出时的清理钩子：父 Agent 都走了，后台子 Agent 不能变成孤儿。
  async stopAll() {
    for (const entry of this.tasks.values()) this.stop(entry.id);
    await Promise.all([...this.tasks.values()].map((entry) => entry.done));
  }

  finish(entry, child, error) {
    // 轮数用完（budget）在原版也算完成：循环就地结束，照常交回最后的文字。其余终态才是失败。
    const finished = child && ["completed", "budget"].includes(child.terminal.status);
    if (entry.status === "running") entry.status = finished ? "completed" : "failed";
    const summary = {
      completed: `Background agent "${entry.description}" finished`,
      failed: `Background agent "${entry.description}" failed: ${error?.message ?? child?.terminal.error ?? child?.terminal.status}`,
      killed: `Background agent "${entry.description}" was stopped`,
    }[entry.status];
    // 被停下的子 Agent 也交回已经做出的部分（最后一条有文字的回复），不白白丢掉
    const parts = [
      "<task-notification>",
      `<task-id>${entry.id}</task-id>`,
      `<status>${entry.status}</status>`,
      `<summary>${summary}</summary>`,
      child?.text ? `<result>${child.text}</result>` : undefined,
      "</task-notification>",
    ];
    entry.notification = parts.filter(Boolean).join("\n");
    this.notify(entry.notification);
  }
}
