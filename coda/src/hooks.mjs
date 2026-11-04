// 第 7 章：Hook。
//
// 对应 Claude Code 2.1.88：
//   utils/hooks.ts  matchesPattern          matcher 的三种写法
//   utils/hooks.ts  getMatchingHooks        这一次事件该运行哪些 Hook：看哪个字段匹配、去重、信任检查
//   utils/hooks.ts  execCommandHook         Hook 是一条命令：事件写成 JSON 送进它的 stdin
//   utils/hooks.ts  executeHooks            并行运行；把每个 Hook 的“退出码 + stdout”变成一条结果；再合并
//   utils/hooks.ts  processHookJSONOutput   JSON 输出里每个字段的含义
//   services/tools/toolHooks.ts             工具流水线怎样使用结果：拦下、改参数、补充信息
//   query/stopHooks.ts                      Stop Hook：把即将结束的循环再推一圈
//
// 一个 Hook 运行完，结果只有四种（原版的 outcome）：
//   success             正常结束
//   blocking            退出码 2，或 JSON 里的 decision: "block"：要求拦下
//   non_blocking_error  出了问题：别的退出码、JSON 不符合格式……只提示用户，不拦
//   cancelled           超时，或运行被取消
// 只有 blocking 能拦下东西。其余三种都“失败时放行”：Hook 是用户自己写的脚本，经常出小问题，
// 不能因此让整个 Agent 动不了。代价是安全类的 Hook 必须自己保证出错时也退出 2。
//
// 和原版相比的简化：
//   · 只实现 command 一种 Hook（原版还有 prompt、agent、http）；没有 async、once、if 字段；
//   · 只实现 5 个事件：PreToolUse、PostToolUse、UserPromptSubmit、SessionStart、Stop
//     （工具抛错时 Toolset 不会通知我们，所以没有 PostToolUseFailure；原版一共 27 个事件）；
//   · 多个 Hook 的结果按注册顺序合并。原版按“谁先跑完”处理，两个 Hook 同时改参数时结果取决于快慢；
//   · 没有配置来源的合并与托管策略，只有一个 trusted 开关：工作区没被信任，所有 Hook 都不运行。
import { runProcess } from "../../runtime/process.mjs";

// 旧写法 before / after 是 PreToolUse / PostToolUse 的别名（Toolset 和第 13 章的实验在用）
const EVENT_ALIASES = { before: "PreToolUse", after: "PostToolUse" };
const canonical = (event) => EVENT_ALIASES[event] ?? event;

const DEFAULT_TIMEOUT_MS = 10_000; // 原版缺省 10 分钟，教学里太久了
const MAX_CONTEXT_CHARS = 10_000; // 补充信息的长度上限（原版对 UserPromptSubmit 的输出同样截到一万字符）
const RANK = { allow: 1, ask: 2, deny: 3 }; // 多个 Hook 意见不一致：deny > ask > allow
const TEXT_EVENTS = ["SessionStart", "UserPromptSubmit"]; // 只有这两个事件，纯文本的 stdout 会交给模型

// ───────────────────────── 一、选出要运行的 Hook ─────────────────────────

// matcher 的三种写法：
//   空、省略或 "*"                  全部匹配
//   只含字母、数字、下划线和 |        精确匹配其中之一（"Edit|Write"），区分大小写
//   其他                            当作正则表达式，不锚定（"mcp__github__.*"）；写坏了的正则当作不匹配
export function matches(matcher, query) {
  if (!matcher || matcher === "*") return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").includes(query);
  try {
    return new RegExp(matcher).test(query);
  } catch {
    return false;
  }
}

// ───────────────────────── 二、读懂一个 Hook 的回答 ─────────────────────────

// 退出码 + stdout + stderr → 一条结果 { outcome, patch?, notice? }。顺序和原版一致：
//   1. 超时或被取消            → cancelled，其余都不看
//   2. stdout 以 { 开头        → 当 JSON 解读。解析不了，当纯文本；解析得了但格式不对，是 non_blocking_error。
//                               JSON 解读成功就以它为准，退出码不再参与——退出码 2 配上 JSON，听 JSON 的
//   3. 退出码 0               → success；纯文本只在 SessionStart、UserPromptSubmit 里变成补充信息
//   4. 退出码 2               → blocking，理由是 stderr
//   5. 其他退出码              → non_blocking_error
// patch 是这个 Hook 想做的事，词汇见 mergeResults。
export function readHookOutput(event, { reason = "exit", code, stdout = "", stderr = "", command = "hook" }) {
  if (reason !== "exit") {
    return { outcome: "cancelled", notice: `Hook ${reason === "timeout" ? "超时" : "被取消"}：${command}` };
  }
  const text = stdout.trim();
  if (text.startsWith("{")) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // 以 { 开头却解析不了：当作普通文本，不算错误
    }
    if (json) {
      const problem = checkShape(json);
      if (problem) return { outcome: "non_blocking_error", notice: `Hook 的 JSON 输出不符合格式：${problem}` };
      return readJson(event, json);
    }
  }
  if (code === 0) return { outcome: "success", patch: TEXT_EVENTS.includes(event) && text ? { context: text } : {} };
  if (code === 2) {
    const why = stderr.trim() || "No stderr output";
    return { outcome: "blocking", patch: { block: true, reason: `[${command}]: ${why}` } };
  }
  return { outcome: "non_blocking_error", notice: `Hook 以退出码 ${code} 结束：${stderr.trim() || "没有 stderr"}` };
}

// 最小的格式检查（原版用 zod schema）：只管几个会被误写的枚举值
function checkShape(json) {
  if (json.decision !== undefined && !["approve", "block"].includes(json.decision))
    return `decision 只能是 approve 或 block，收到 ${JSON.stringify(json.decision)}`;
  const decision = json.hookSpecificOutput?.permissionDecision;
  if (decision !== undefined && !RANK[decision])
    return `permissionDecision 只能是 allow、ask 或 deny，收到 ${JSON.stringify(decision)}`;
  if (json.continue !== undefined && typeof json.continue !== "boolean") return "continue 必须是布尔值";
}

// JSON 输出 → patch。对应 processHookJSONOutput 里最常用的字段：
//   continue: false + stopReason      整个运行都停下（preventContinuation）
//   decision: "block" + reason        拦下；"approve" 相当于 allow
//   systemMessage                     只给用户看的提示
//   hookSpecificOutput.permissionDecision / permissionDecisionReason   PreToolUse 的权限意见
//   hookSpecificOutput.updatedInput   PreToolUse 改写参数
//   hookSpecificOutput.additionalContext   补充信息，交给模型
//   hookSpecificOutput.updatedToolOutput   PostToolUse 替换工具输出（原版 2.1.88 只认 updatedMCPToolOutput，且只对 MCP 工具生效）
function readJson(event, json) {
  const specific = json.hookSpecificOutput;
  // Hook 在 PostToolUse 里却回答了 PreToolUse 的格式：多半是脚本写错了，不能照字面执行
  if (specific && event && specific.hookEventName !== event)
    return { outcome: "non_blocking_error", notice: `Hook 返回的事件名是 ${specific.hookEventName}，但当前是 ${event}` };

  const patch = {};
  if (json.continue === false) patch.stop = json.stopReason ?? "Hook 要求停止";
  if (json.systemMessage) patch.notice = json.systemMessage;
  if (json.decision === "approve") patch.permission = "allow";
  if (json.decision === "block") Object.assign(patch, { block: true, reason: json.reason ?? "Blocked by hook" });

  if (specific?.additionalContext) patch.context = String(specific.additionalContext).slice(0, MAX_CONTEXT_CHARS);
  if (event === "PreToolUse" && specific) {
    const decision = specific.permissionDecision;
    if (decision) patch.permission = decision;
    if (decision === "deny") {
      const why = specific.permissionDecisionReason ?? json.reason ?? "Blocked by hook";
      Object.assign(patch, { block: true, reason: why });
    }
    if (specific.updatedInput) patch.input = specific.updatedInput;
  }
  if (event === "PostToolUse" && specific) {
    const output = specific.updatedToolOutput ?? specific.updatedMCPToolOutput;
    if (output !== undefined) patch.output = typeof output === "string" ? output : (output.text ?? output.stdout ?? JSON.stringify(output));
  }
  return { outcome: patch.block ? "blocking" : "success", patch };
}

// ───────────────────────── 三、把命令变成 Hook ─────────────────────────

// 非 blocking 的失败用异常表示：Hooks 会接住它，记成 non_blocking_error 或 cancelled，并且放行
class HookFailure extends Error {
  constructor(message, outcome) {
    super(message);
    this.outcome = outcome;
  }
}

// 运行一个子进程，把事件的 JSON（加一个换行，和原版一样）写进 stdin，再按 readHookOutput 解读。
// 返回的 run(input, { root, signal }) 可以直接放进 Hooks 的条目；blocking 返回 patch，其余失败抛 HookFailure。
function processHook({ command, args, label, timeout }) {
  const run = async (input, { root, signal } = {}) => {
    const out = await runProcess(command, args, {
      cwd: root,
      signal,
      timeout,
      input: JSON.stringify(input) + "\n",
      env: root ? { CLAUDE_PROJECT_DIR: root } : {},
    });
    const result = readHookOutput(input.hook_event_name, { ...out, command: label });
    if (result.outcome === "success" || result.outcome === "blocking") return result.patch;
    throw new HookFailure(result.notice, result.outcome);
  };
  run.label = label;
  return run;
}

// 运行一个 Node 脚本文件
export function commandHook(file, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return processHook({ command: process.execPath, args: [file], label: file, timeout });
}

// 运行一条 shell 命令。settings.json 里 { "type": "command", "command": "..." } 就是这样运行的
export function shellHook(command, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return processHook({ command: "sh", args: ["-c", command], label: command, timeout });
}

// ───────────────────────── 四、合并多个 Hook 的结果 ─────────────────────────

// 每个 Hook 的 patch 可以包含：
//   block: true, reason     拦下（PreToolUse 拦工具，UserPromptSubmit 拦提示，Stop 不让停）
//   permission              'allow' | 'ask' | 'deny'（PreToolUse）
//   input                   改写后的工具参数（PreToolUse）
//   context                 补充信息，交给模型
//   output                  替换工具输出（PostToolUse）
//   stop                    让整个运行停下的原因
//   notice                  只给用户看的提示
//   其他字段                 PostToolUse 时合并进工具结果（比如 text、details）
const RESERVED = ["block", "reason", "permission", "input", "context", "output", "stop", "notice"];

function mergeResults(results) {
  const merged = {
    blocked: false,
    reason: undefined,
    permission: undefined,
    input: undefined,
    output: undefined,
    stop: undefined,
    context: [],
    notices: [],
    patch: {},
    outcomes: results.map((r) => r.outcome),
  };
  const reasons = [];
  for (const { patch = {}, notice } of results) {
    if (notice) merged.notices.push(notice);
    if (patch.notice) merged.notices.push(patch.notice);
    if (patch.block) {
      merged.blocked = true;
      reasons.push(patch.reason ?? "Blocked by hook");
    }
    if (patch.permission && (!merged.permission || RANK[patch.permission] > RANK[merged.permission]))
      merged.permission = patch.permission;
    if (patch.input !== undefined) merged.input = patch.input; // 多个 Hook 都改参数：注册靠后的生效
    if (patch.output !== undefined) merged.output = patch.output;
    if (patch.context) merged.context.push(patch.context);
    merged.stop ??= patch.stop;
    for (const [key, value] of Object.entries(patch)) if (!RESERVED.includes(key)) merged.patch[key] = value;
  }
  if (merged.blocked) merged.permission = "deny"; // 拦下就是 deny
  merged.reason = reasons.join("\n") || undefined;
  return merged;
}

// ───────────────────────── 五、Hooks ─────────────────────────

// 一个条目是 { event, matcher?, tool?, run }：
//   event    事件名（PreToolUse……）；旧写法 "before" / "after" 也认
//   matcher  按 matches() 的规则匹配事件的“匹配字段”：工具事件是工具名，SessionStart 是 source……
//   tool     旧写法：工具名精确相等
//   run      async (input, { root, signal }) => patch；抛异常等于一次 non_blocking_error
//   key      去重用：同一个 key 在一次事件里只运行一次（fromConfig 用命令文本）
export class Hooks {
  constructor(entries = [], { trusted = true, root } = {}) {
    this.entries = entries;
    this.trusted = trusted;
    this.root = root;
    this.log = []; // 每次运行留下一条：{ event, query, hook, outcome, ms }，相当于原版写进会话文件的 hook_* 附件
    this.pendingContext = new Map(); // PreToolUse 的补充信息，要等工具结果出来才能附上（按 call.id 暂存）
  }

  // 从 settings.json 里 "hooks" 的写法创建：
  //   { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "sh x.sh", timeout: 5 }] }] }
  // timeout 的单位是秒（和原版配置一致）。
  static fromConfig(config, options = {}) {
    const entries = [];
    for (const [event, groups] of Object.entries(config)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          if (hook.type !== "command") throw Error(`不支持的 Hook 类型：${hook.type}`);
          const timeout = hook.timeout ? hook.timeout * 1000 : DEFAULT_TIMEOUT_MS;
          entries.push({ event, matcher: group.matcher, key: hook.command, run: shellHook(hook.command, { timeout }) });
        }
      }
    }
    return new Hooks(entries, options);
  }

  // 对应 getMatchingHooks：事件对得上、匹配字段对得上、同一条命令只留一个。
  // query 是这个事件的匹配字段；没有匹配字段的事件（Stop、UserPromptSubmit）传 undefined，matcher 写了也不起作用。
  select(event, query) {
    const seen = new Set();
    return this.entries.filter((entry) => {
      if (canonical(entry.event) !== event) return false;
      if (query !== undefined && !(entry.tool ? entry.tool === query : matches(entry.matcher, query))) return false;
      if (entry.key === undefined) return true;
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    });
  }

  // 对应 executeHooks：选出 Hook，并行运行，合并结果。
  // 并行意味着不能假设顺序，也意味着一个慢 Hook 只会拖慢自己那一份。
  async fire(event, input, { query, context = {} } = {}) {
    if (!this.trusted || context.signal?.aborted) return mergeResults([]);
    const run = { root: this.root, ...context };
    const chosen = this.select(event, query);
    const payload = { hook_event_name: event, cwd: run.root, ...input };
    const results = await Promise.all(chosen.map((entry) => this.runOne(entry, event, query, payload, run)));
    return mergeResults(results);
  }

  // 运行一个 Hook，永远不抛异常：出错就记成 non_blocking_error（或 cancelled），换一个空 patch 继续
  async runOne(entry, event, query, payload, context) {
    const started = Date.now();
    let outcome = "success";
    let patch = {};
    let notice;
    try {
      patch = (await entry.run(structuredClone(payload), context)) ?? {};
      if (patch.block) outcome = "blocking";
    } catch (error) {
      outcome = error.outcome ?? "non_blocking_error";
      notice = `${event} Hook 出错，已忽略：${error.message ?? error}`;
    }
    const hook = entry.label ?? entry.run.label ?? entry.key ?? "callback";
    this.log.push({ event, query, hook, outcome, ms: Date.now() - started });
    return { outcome, patch, notice };
  }

  // ── 下面是各个事件的入口 ──

  // 工具执行前（Toolset 调用）。返回 { block, reason } 或 { input }：
  // Hook 的 allow / ask 意见放在 permission 字段里；目前 Toolset 的 gate（第 6 章）总是自己决定，
  // 所以 allow 不会跳过询问——这是“Hook 的 allow 越不过规则”的最保守版本。
  async before(call, context) {
    const merged = await this.fire(
      "PreToolUse",
      { tool_name: call.name, tool_use_id: call.id, tool_input: structuredClone(call.input) },
      { query: call.name, context },
    );
    if (merged.blocked) {
      // 模型看到的就是这句话：谁拦的、为什么
      return { block: true, reason: `PreToolUse:${call.name} hook error: ${merged.reason}`, permission: "deny", notices: merged.notices };
    }
    if (merged.context.length) this.pendingContext.set(call.id, merged.context);
    return { input: merged.input ?? call.input, permission: merged.permission, notices: merged.notices };
  }

  // 工具执行后、结果交给模型前（Toolset 调用）。工具已经执行了，Hook 撤销不了：
  // 它能做的是替换输出文字、补充信息，或者把“不满意”的理由告诉模型（退出码 2 在这里就是这个意思）。
  async after(call, result, context) {
    const merged = await this.fire(
      "PostToolUse",
      { tool_name: call.name, tool_use_id: call.id, tool_input: call.input, tool_response: result },
      { query: call.name, context },
    );
    const current = { ...result, ...merged.patch };
    if (merged.output !== undefined) current.text = merged.output;
    const notes = [...(this.pendingContext.get(call.id) ?? []), ...merged.context];
    this.pendingContext.delete(call.id);
    if (merged.blocked) notes.push(`PostToolUse hook 反馈：${merged.reason}`);
    // 原版把补充信息放进单独的一条消息；Toolset 每个调用只有一条结果，所以附在文字后面
    if (notes.length) current.text = `${current.text ?? ""}\n\n[Hook 补充信息]\n${notes.join("\n")}`;
    if (merged.notices.length) current.details = { ...current.details, hookNotices: merged.notices };
    return current;
  }

  // Stop：直接作为 Engine 的 onStop 使用——new Engine({ onStop: (input) => hooks.stop(input) })。
  // Engine 会告诉我们这一圈是不是 Stop Hook 自己逼出来的（stopHookActive），我们原样转给 Hook。
  // 返回 { block: 理由 } 让循环带着理由再来一圈，{ prevent: 原因 } 直接终止，什么都不返回就放行。
  async stop({ assistant, stopHookActive }) {
    const merged = await this.fire("Stop", { stop_hook_active: stopHookActive, last_assistant_message: assistant.text });
    if (merged.stop) return { prevent: merged.stop };
    if (merged.blocked) return { block: merged.reason };
    return undefined;
  }

  // 用户提交提示、模型看到之前。blocked 为真时，提示不应该发给模型；context 是要补充给模型的话。
  userPromptSubmit(prompt, context) {
    return this.fire("UserPromptSubmit", { prompt }, { context });
  }

  // 会话开始。source 是 startup、resume、clear 或 compact，也是 matcher 匹配的字段。
  // 这里的拦截没有意义：原版直接忽略 blocking。
  sessionStart(source, context) {
    return this.fire("SessionStart", { source }, { query: source, context });
  }
}
