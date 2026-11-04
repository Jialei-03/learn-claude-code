// 第 13 章：一次完整的修复旅程。实验（labs/chapters/13-synthesis.mjs）和回放（labs/ch13/trace.mjs）共用这里的场景。
//
// 项目：src/slug.cjs 只把单个空格换成连字符，连续空格会产生 "a--b"；test/slug.test.cjs 是真正会失败的测试。
// 模型是脚本：它决定“要求什么”，其余——CLAUDE.md、Skill、子 Agent、文件版本检查、权限、Hook、测试进程、
// MCP 进程、会话文件——全是 coda 的真实代码在运行。
//
// 旅程分三段：
//   第一次运行  Skill → 子 Agent 定位 → 真实失败的测试 → 没读过就改（被拦）→ 并行 Read（带出子目录说明）
//              → 改测试（被 Hook 拦）→ 改实现（问用户）→ 想收工（Stop Hook 拦下）→ 测试通过 → MCP → 收尾
//   重开会话    新进程、同一个会话文件：历史原样回来；Skill 授予的权限只管上一次运行，所以 Test 要重新问
//   压缩        历史超过触发线：摘要写进会话文件，新的根；再次重开，只剩摘要之后的部分
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createCoda } from "../../coda/src/app.mjs";
import { Compactor } from "../../coda/src/compact.mjs";
import { scripted } from "../../coda/src/engine.mjs";
import { Hooks, commandHook } from "../../coda/src/hooks.mjs";
import { Session } from "../../coda/src/session.mjs";
import { runProcess } from "../../runtime/process.mjs";

const PROMPT = "src/slug.cjs 的 slug() 遇到连续空格会产生多个连字符，test/slug.test.cjs 失败了。请修好它，并确认测试通过。";

// ───────────────────────── 项目 ─────────────────────────

const FILES = {
  "CLAUDE.md": "# 项目约定\n改动要最小。收工前必须运行 Test 并看到 tests passed。\n",
  "src/CLAUDE.md": "src 下的模块一律用 CommonJS，不引入第三方依赖。\n",
  "src/slug.cjs": 'module.exports = (text) => text.trim().replace(/ /g, "-");\n',
  "test/slug.test.cjs":
    'const assert = require("node:assert/strict");\nconst slug = require("../src/slug.cjs");\nassert.equal(slug(" a  b "), "a-b");\nconsole.log("tests passed");\n',
  ".claude/skills/verify/SKILL.md":
    "---\nname: verify\ndescription: 修完 bug 之后怎样验收\nallowed-tools: Read, Test\n---\n改完代码以后运行 Test，看到 tests passed 才能说修好了。\n",
  // PreToolUse：测试是验收标准，Edit / Write 不许碰 test/ 下的文件。退出码 2 就是“拦下”，stderr 是给模型看的理由
  ".claude/hooks/guard-tests.cjs": [
    'let raw = "";',
    'process.stdin.on("data", (chunk) => (raw += chunk));',
    'process.stdin.on("end", () => {',
    "  const event = JSON.parse(raw);",
    '  if (String(event.tool_input.path).startsWith("test/")) {',
    '    process.stderr.write("测试是验收标准，不要改测试；去改 src 里的实现。");',
    "    process.exit(2);",
    "  }",
    "});",
    "",
  ].join("\n"),
  // PostToolUse：文件改完以后，往模型的上下文里补一句话（JSON 输出的 additionalContext）
  ".claude/hooks/after-edit.cjs": [
    'process.stdin.on("data", () => {});',
    'process.stdin.on("end", () => {',
    "  process.stdout.write(JSON.stringify({",
    '    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "改动已记录。收尾前请运行 Test。" },',
    "  }));",
    "});",
    "",
  ].join("\n"),
};

export function writeProject(root) {
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

// 用同一个运行时跑一次测试，得到“它确实会失败”的第一手输出（不经过 agent）
export async function runTestOnce(root) {
  const result = await runProcess(process.execPath, [join(root, "test/slug.test.cjs")], { cwd: root });
  const failure = /Expected values to be strictly equal:\s*\n\s*\n(.*)/.exec(result.stderr)?.[1];
  return { ...result, summary: result.code === 0 ? result.stdout.trim() : `AssertionError：${failure ?? result.stderr.split("\n")[0]}` };
}

// ───────────────────────── 脚本 ─────────────────────────

const call = (name, input, id) => ({ id, name, input });

// 每一步：模型的回复 + 这一步想让读者看到什么
export const STEPS = [
  { reply: { calls: [call("Skill", { name: "verify" }, "skill")] }, note: "调用 Skill：它的 allowed-tools 会扩大权限，所以调用本身要用户批准；目录早在第一个请求里就以一条消息的形式给了模型" },
  { reply: { calls: [call("Agent", { task: "找出实现 slug() 的文件，以及测试怎样调用它" }, "agent")] }, note: "只读子 Agent：自己的上下文、自己的文件版本记录，只把最后一段话交回来" },
  { reply: { calls: [call("Test", { path: "test/slug.test.cjs" }, "test-1")] }, note: "先跑一次测试，得到真实的失败。权限来自 Skill 刚授予的 Test，不用问用户" },
  { reply: { calls: [call("Edit", { path: "src/slug.cjs", old: "/ /g", next: "/ +/g" }, "edit-unread")] }, note: "子 Agent 读过这个文件，但那是它自己的记录：主 Agent 没读过就改，校验一关就拦下，Hook 和权限都看不到" },
  { reply: { calls: [call("Read", { path: "src/slug.cjs" }, "read-src"), call("Read", { path: "test/slug.test.cjs" }, "read-test")] }, note: "同一条回复里两个 Read 并行；读到 src/ 下的文件，src/CLAUDE.md 紧跟在工具结果后面送出去" },
  { reply: { calls: [call("Edit", { path: "test/slug.test.cjs", old: '"a-b"', next: '"a--b"' }, "edit-test")] }, note: "模型想改测试来“通过”：校验过了，PreToolUse Hook（一个真实的子进程）以退出码 2 拦下" },
  { reply: { calls: [call("Edit", { path: "src/slug.cjs", old: "/ /g", next: "/ +/g" }, "edit-src")] }, note: "改实现：默认模式下 Edit 要问用户；改完 PostToolUse Hook 往上下文里补一句话" },
  { reply: { text: "已经修好了。" }, note: "模型没跑测试就想收工：Stop Hook 发现改过文件之后没有通过的测试，把它推回循环" },
  { reply: { calls: [call("Test", { path: "test/slug.test.cjs" }, "test-2")] }, note: "再跑一次：这次是真的通过" },
  { reply: { calls: [call("mcp__fixture__echo", { text: "slug fixed" }, "mcp")] }, note: "本地 MCP 服务器（一个真实子进程）：工具名是 mcp__服务器__工具，规则 mcp__fixture 一条管全部" },
  { reply: { text: "修好了：slug() 现在把连续的空格合并成一个连字符，测试通过。" }, note: "没有工具调用，Stop Hook 放行：运行结束，对话写进会话文件" },
];

const CHILD_REPLIES = [
  { calls: [call("Read", { path: "test/slug.test.cjs" }, "c-1"), call("Read", { path: "src/slug.cjs" }, "c-2")] },
  { text: "实现在 src/slug.cjs，导出一个函数；测试 test/slug.test.cjs 用 slug(' a  b ') 断言得到 'a-b'。" },
];

// ───────────────────────── 旅程 ─────────────────────────

const asText = (message) => message.text.replace(/\s+/g, " ").trim();

export async function runJourney(root, { fixture, onStage } = {}) {
  writeProject(root);
  const sessionFile = join(root, ".coda/session.jsonl");
  const result = { root, sessionFile };
  result.failingTest = await runTestOnce(root);

  // ── Hook：两个真实子进程 + 两个进程内回调（Stop 要看“改过没有、测过没有”）
  const state = { dirty: false, failures: 0 };
  const hooks = new Hooks([
    { event: "PreToolUse", matcher: "Edit|Write", run: commandHook(join(root, ".claude/hooks/guard-tests.cjs")) },
    { event: "PostToolUse", matcher: "Edit", run: commandHook(join(root, ".claude/hooks/after-edit.cjs")) },
    { event: "PostToolUse", matcher: "Edit", label: "mark-dirty", run: async () => void (state.dirty = true) },
    { event: "PostToolUseFailure", label: "count-failures", run: async () => void state.failures++ },
    { event: "PostToolUse", matcher: "Test", label: "mark-clean", run: async (input) => void (input.tool_response.error || (state.dirty = false)) },
    {
      event: "Stop",
      label: "require-green-test",
      run: async () => (state.dirty ? { block: true, reason: "你改过文件，但之后没有运行通过的 Test。先运行测试再收尾。" } : {}),
    },
  ]);

  const asked = [];
  const decisions = [];
  const events = [];
  const marks = []; // 每个 request 事件发生时 Hook 日志有多长：两个 request 之间的日志就是这一圈里 Hook 做的事
  const pidFile = join(root, ".coda/mcp.pid");
  const build = (overrides = {}) =>
    createCoda({
      root,
      hooks,
      rules: { allow: ["Agent", "mcp__fixture"] },
      sessionFile,
      now: new Date(2026, 10, 4),
      ask: async (c) => (asked.push(`${c.name}${c.input.path ? ` ${c.input.path}` : c.input.name ? ` ${c.input.name}` : ""}`), true),
      onDecision: (c, decision) => decisions.push({ id: c.id, tool: c.name, ...decision }),
      onEvent: (frame) => {
        events.push(frame);
        if (frame.type === "request") marks.push(hooks.log.length);
      },
      ...overrides,
    });

  // ═══ 第一次运行 ═══
  const mcpServers = fixture
    ? { fixture: { command: "sh", args: ["-c", `echo $$ > "${pidFile}"; exec "${process.execPath}" "${fixture}"`] } }
    : undefined;
  const app = build({
    model: scripted(STEPS.map((step) => step.reply)),
    childModel: () => scripted(CHILD_REPLIES),
    mcpServers,
  });
  const run1 = await app.run(PROMPT, { maxTurns: 30 });
  const mcpPid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : undefined;
  const mcpAliveBeforeClose = mcpPid ? isAlive(mcpPid) : undefined;
  await app.close();
  const mcpAliveAfterClose = mcpPid ? await goneWithin(mcpPid, 2000) === false : undefined;
  Object.assign(result, { state, run1, asked: [...asked], decisions: [...decisions], hookLog: [...hooks.log], marks: [...marks], events1: [...events], mcpPid, mcpAliveBeforeClose, mcpAliveAfterClose });
  result.files = {
    slug: readFileSync(join(root, "src/slug.cjs"), "utf8"),
    test: readFileSync(join(root, "test/slug.test.cjs"), "utf8"),
  };
  onStage?.("run1", result);

  // ═══ 重开会话，继续 ═══
  asked.length = 0;
  const reopened = build({ model: scripted([{ calls: [call("Test", { path: "test/slug.test.cjs" }, "test-3")] }, { text: "再次确认：测试通过。" }]) });
  const before = new Session(sessionFile).history().length;
  const run2 = await reopened.run("再确认一遍测试还是绿的。");
  await reopened.close();
  Object.assign(result, { run2, asked2: [...asked], historyBefore2: before });
  onStage?.("run2", result);

  // ═══ 压缩：窗口小到装不下这段历史 ═══
  let summaries = 0;
  const compactor = new Compactor({
    window: 1400,
    buffer: 100,
    summarize: async (messages) => {
      summaries++;
      return `修复了 src/slug.cjs 里 slug() 对连续空格的处理（/ /g 改成 / +/g）；测试通过。共 ${messages.length} 条旧消息被摘要。`;
    },
  });
  const rowsBefore = new Session(sessionFile).log.read().length;
  const compacting = build({
    model: scripted([{ calls: [call("Read", { path: "src/slug.cjs" }, "read-again")] }, { text: "读完了，实现没有问题。" }]),
    compactor,
  });
  const run3 = await compacting.run("最后看一眼 src/slug.cjs。");
  await compacting.close();
  const afterSession = new Session(sessionFile);
  const rows = afterSession.log.read();
  Object.assign(result, { run3, summaries, rowsBefore, rowsAfter: rows.length, compactRow: rows.find((row) => row.logicalParent !== undefined), historyAfter: afterSession.history() });
  onStage?.("run3", result);

  // ═══ 再次重开：只加载压缩之后的部分 ═══
  const final = build({ model: scripted([{ text: "收到。" }]) });
  const run4 = await final.run("好的，到此为止。");
  await final.close();
  Object.assign(result, { run4 });
  return result;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 等到进程消失，返回 true；超时返回 false
async function goneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

// ───────────────────────── 给人看的整理 ─────────────────────────

export const shorten = (text, n = 60) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

export const describeCall = (c) => {
  const arg = c.input.path ?? c.input.name ?? c.input.task ?? c.input.text ?? "";
  return `${c.name}(${shorten(arg, 28)})`;
};

// 一个工具结果，压成表格里一格能放下的话（项目路径换成 . ，免得表格里全是临时目录）
export function describeResult(call, message, root) {
  const text = message.text.split(root).join(".");
  if (call?.name === "Skill") return `Skill 正文（${text.length} 字符）`;
  if (/AssertionError/.test(text)) return `✗ 测试失败：${/Expected values to be strictly equal:\s*\n\s*\n(.*)/.exec(text)?.[1] ?? "断言不成立"}`;
  const blocked = /^PreToolUse:\w+ hook error: \[[^\]]*\]: (.*)$/s.exec(text);
  if (blocked) return `✗ 被 Hook 拦下：${shorten(blocked[1], 30)}`;
  return `${message.error ? "✗ " : ""}${shorten(text, 50)}`;
}

// 第一次运行的逐步表：每个 request 一行
export function stepTable(result) {
  const { frames } = result.run1;
  const requests = frames.filter((f) => f.type === "request");
  const callById = new Map();
  return requests.map((request, index) => {
    const assistantAt = frames.indexOf(request) + 1;
    const assistant = frames[assistantAt].message;
    assistant.calls.forEach((c) => callById.set(c.id, c));
    const nextAt = index + 1 < requests.length ? frames.indexOf(requests[index + 1]) : frames.length;
    const results = frames.slice(assistantAt + 1, nextAt).filter((f) => f.type === "tool_result").map((f) => f.message);
    const hooks = result.hookLog
      .slice(result.marks[index], result.marks[index + 1] ?? result.hookLog.length)
      .map((h) => `${h.event.replace("ToolUse", "")}:${basename(h.hook)}→${h.outcome}`);
    const gates = assistant.calls
      .map((c) => result.decisions.find((d) => d.id === c.id))
      .filter(Boolean)
      .map((d) => `${d.behavior}/${d.source}`);
    return {
      "#": index + 1,
      模型要求: assistant.calls.length ? assistant.calls.map(describeCall).join(" + ") : `（文字）${shorten(assistant.text, 14)}`,
      结果: results.length
        ? results.map((m) => describeResult(callById.get(m.id), m, result.root)).join(" ｜ ")
        : frames[nextAt]?.type === "request" && frames[nextAt].transition.reason === "stop_hook_blocking"
          ? "被 Stop Hook 拦下，再来一圈"
          : "运行结束",
      权限: gates.join(" ") || "—",
      Hook: hooks.join(" ") || "—",
    };
  });
}
