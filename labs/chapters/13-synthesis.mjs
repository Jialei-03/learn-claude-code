// 第 13 章：总装。在一个临时项目里修一个真实失败的测试，把第 1～12 章的部件一起跑一遍。
//   node labs/chapters/13-synthesis.mjs
// 模型是脚本，它只决定“要求什么”；CLAUDE.md、Skill、子 Agent、文件版本检查、权限、Hook、测试进程、
// MCP 进程、会话文件、压缩、命令行退出码，全是真实运行的。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lesson, ROOT } from "./harness.mjs";
import { runJourney, shorten, stepTable } from "../ch13/journey.mjs";
import { Session } from "../../coda/src/session.mjs";
import { readFrames } from "../../coda/src/io.mjs";
import { createCoda } from "../../coda/src/app.mjs";
import { scripted } from "../../coda/src/engine.mjs";
import { Hooks } from "../../coda/src/hooks.mjs";

const CLI = join(ROOT, "coda/src/cli.mjs");
const FIXTURE = join(ROOT, "labs/fixtures/mcp-server.mjs");

// 起一个 coda 子进程，发一个提问，读它的全部输出
function runCli(dir, frame) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, dir], { cwd: dir, env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const frames = [];
    const reading = (async () => {
      for await (const f of readFrames(child.stdout)) frames.push(f);
    })();
    const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.stdin.end((typeof frame === "string" ? frame : JSON.stringify(frame)) + "\n");
    child.on("error", reject);
    child.on("close", async (code) => {
      clearTimeout(killer);
      await reading;
      resolve({ code, frames, stderr });
    });
  });
}

await lesson(13, "总装：修复一个真正失败的项目", async (t) => {
  // ═══════════ 跑完整段旅程（后面每一节都从这份结果里取数）═══════════
  const result = await runJourney(t.root, { fixture: FIXTURE });
  const { run1, run2, run3, run4 } = result;
  const frames1 = run1.frames;
  const requests1 = frames1.filter((f) => f.type === "request");

  const toolResult = (id) => frames1.find((f) => f.type === "tool_result" && f.message.id === id).message;
  const only = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const wants = (name) => !only.length || only.includes(name);

  if (wants("steps")) {
    // ═══════════ 一、起点 ═══════════
    t.log("一、起点：一个真实会失败的测试");
    t.log();
    t.table([
      { 文件: "CLAUDE.md", 作用: "项目约定：改动要最小，收工前必须运行 Test" },
      { 文件: "src/CLAUDE.md", 作用: "子目录里的说明：读到 src/ 下的文件才加载" },
      { 文件: "src/slug.cjs", 作用: "有 bug 的实现：只把单个空格换成连字符" },
      { 文件: "test/slug.test.cjs", 作用: "验收：slug(' a  b ') 应该得到 'a-b'" },
      { 文件: ".claude/skills/verify/SKILL.md", 作用: "Skill：allowed-tools 是 Read、Test" },
      { 文件: ".claude/hooks/*.cjs", 作用: "两个 Hook 脚本：拦下对 test/ 的修改；改完补一句提醒" },
    ]);
    t.log(`直接运行测试：${result.failingTest.summary}（退出码 ${result.failingTest.code}）`);
    t.log();
    t.ok("测试在修复之前真的会失败", result.failingTest.code !== 0 && /a--b/.test(result.failingTest.summary));

    // ═══════════ 二、第一次运行 ═══════════
    t.log();
    t.log("二、第一次运行：十一次请求，一步一行");
    t.log();
    const table = stepTable(result);
    t.table(table);
    t.log(`询问过用户：${result.asked.join("；")}。其余调用要么只读，要么被规则、Skill 授予的权限放行，要么没走到这一关。`);
    t.log(`终态：${run1.terminal.status}（${run1.terminal.reason}），共 ${run1.terminal.iterations} 次模型请求。`);
    t.log();
    t.equal("第一次运行以 completed 结束，十一次请求", [run1.terminal.status, requests1.length], ["completed", 11]);
    t.equal("真实测试跑了两次：先失败，后通过", [toolResult("test-1").error, toolResult("test-2").error, toolResult("test-2").text.trim()], [true, false, "tests passed"]);
    t.equal("磁盘上的实现被改对了，测试文件没有动", [result.files.slug.includes("/ +/g"), result.files.test.includes('"a-b"')], [true, true]);
    t.equal("Skill 和 Edit 问了用户；Test 靠 Skill 授予的权限直接放行", result.asked, ["Skill verify", "Edit src/slug.cjs"]);

  }

  if (wants("request")) {
    // ═══════════ 三、请求里装了什么 ═══════════
    t.log();
    t.log("三、第一个请求里装了什么");
    t.log();
    const first = requests1[0].wire;
    const second = requests1[1].wire;
    const where = (text) => (first.system.some((s) => s.includes(text)) ? "system" : first.messages.some((m) => m.text.includes(text)) ? "消息" : "没有");
    t.table([
      { 位置: "system", 内容: shorten(first.system.join(" "), 56), 变不变: "整个会话不变" },
      { 位置: "消息 1（meta）", 内容: "claudeMd：CLAUDE.md 的内容；currentDate", 变不变: "会话开始取一次快照" },
      { 位置: "消息 2（meta）", 内容: "Skill 目录：verify 一行", 变不变: "只发没发过的" },
      { 位置: "消息 3", 内容: shorten(first.messages[2].text, 34), 变不变: "用户的提问" },
      { 位置: "tools", 内容: first.tools.map((tool) => tool.name).join("、"), 变不变: "内置按名字排序，MCP 排在后面" },
    ]);
    t.log(`CLAUDE.md 的内容在：${where("改动要最小")}；src/CLAUDE.md 的内容在第一个请求里：${where("CommonJS")}（读到 src/ 之后才附上）。`);
    t.log();
    t.equal("CLAUDE.md 在第一条用户消息里，不在 system 里", [where("改动要最小"), where("CommonJS")], ["消息", "没有"]);
    t.equal("第一个请求的前缀（system + tools）在后面所有请求里逐字不变", requests1.every((f) => f.wire.prefixHash === first.prefixHash), true);
    t.equal("Skill 目录只发了一次", requests1.at(-1).wire.messages.filter((m) => m.kind === "skill-listing").length, 1);
    const afterRead = requests1[5].wire.messages;
    t.equal("读到 src/slug.cjs 之后，src/CLAUDE.md 排在那批工具结果后面", [afterRead.at(-1).role, afterRead.at(-1).text.includes("CommonJS"), afterRead.at(-2).role], ["user", true, "tool"]);
    t.equal("工具按名字排序，内置在前，MCP 在最后", first.tools.map((tool) => tool.name), ["Agent", "Edit", "Read", "Skill", "Test", "Write", "mcp__fixture__echo"]);

  }

  if (wants("gates")) {
    // ═══════════ 四、几道关各拦下了什么 ═══════════
    t.log();
    t.log("四、几道关各拦下了什么");
    t.log();
    const hookNames = result.hookLog.map((h) => `${h.event}:${h.hook.split("/").pop()}:${h.outcome}`);
    t.table([
      { 关: "校验", 事件: "没读过就 Edit", 谁拦的: "文件版本检查（子 Agent 读过也不算）", 模型收到: toolResult("edit-unread").text },
      { 关: "PreToolUse Hook", 事件: "Edit test/slug.test.cjs", 谁拦的: "guard-tests.cjs（真实子进程，退出码 2）", 模型收到: shorten(toolResult("edit-test").text.split(result.root).join("."), 70) },
      { 关: "权限", 事件: "Edit src/slug.cjs", 谁拦的: "默认模式：Edit 要问；回调批准", 模型收到: toolResult("edit-src").text.split("\n")[0] },
      { 关: "Stop Hook", 事件: "模型说“已经修好了”", 谁拦的: "require-green-test：改过文件却没测过", 模型收到: shorten(requests1[8].wire.messages.at(-1).text, 40) },
    ]);
    t.equal("没读过就改：校验一关拦下，Hook 和权限都没看到这次调用", [toolResult("edit-unread").error, result.decisions.some((d) => d.id === "edit-unread")], [true, false]);
    t.ok("改测试被 PreToolUse Hook 拦下，测试文件没有变", toolResult("edit-test").error && /测试是验收标准/.test(toolResult("edit-test").text) && result.files.test.includes('"a-b"'));
    t.ok("改完之后 PostToolUse Hook 的补充信息跟在结果后面", /改动已记录/.test(toolResult("edit-src").text));
    t.ok("Stop Hook 把想收工的运行推回循环：下一圈的原因是 stop_hook_blocking", requests1[8].transition.reason === "stop_hook_blocking" && /没有运行通过的 Test/.test(requests1[8].wire.messages.at(-1).text));
    const failures = result.hookLog.filter((h) => h.event === "PostToolUseFailure");
    t.equal("PostToolUseFailure 只在 Test 失败时触发；校验就失败的 Edit 它看不到", [failures.map((h) => h.query), result.state.failures], [["Test"], 1]);
    t.equal("Hook 日志里每个 Hook 都留下了结局", hookNames.filter((h) => /blocking$/.test(h)), ["PreToolUse:guard-tests.cjs:blocking", "Stop:require-green-test:blocking"]);

    const child = toolResult("agent");
    t.ok("子 Agent 只把最后一段话交回来", /src\/slug\.cjs/.test(child.text) && !child.error && !/c-1|assert/.test(child.text));
    t.ok("MCP 工具的结果回到了历史", toolResult("mcp").text === "slug fixed");
    t.log();

    // ═══════════ 五、进程 ═══════════
    t.log("五、MCP 进程");
    t.log();
    t.table([
      { 时刻: "运行之后、close() 之前", "MCP 服务器进程": result.mcpAliveBeforeClose ? `pid 存活` : "已退出" },
      { 时刻: "close() 之后", "MCP 服务器进程": result.mcpAliveAfterClose ? "还在" : "已退出" },
    ]);
    t.equal("app.close() 之后 MCP 服务器进程真的退出了", [result.mcpAliveBeforeClose, result.mcpAliveAfterClose], [true, false]);

  }

  if (wants("resume")) {
    // ═══════════ 六、重开会话 ═══════════
    t.log();
    t.log("六、保存会话，重新打开，继续");
    t.log();
    const reopenedFirst = run2.frames.find((f) => f.type === "request").wire;
    const resumedIds = reopenedFirst.messages.filter((m) => m.role === "tool").map((m) => m.id);
    t.table([
      { 项目: "会话文件里的消息数（第一次运行之后）", 值: result.historyBefore2 },
      { 项目: "新进程第一个请求带着的工具结果", 值: resumedIds.length },
      { 项目: "其中包含第一次运行里的 mcp / agent", 值: ["mcp", "agent"].every((id) => resumedIds.includes(id)) ? "是" : "否" },
      { 项目: "第二次运行里 Test 被问了吗（Skill 的授权已经过期）", 值: result.asked2.length ? `问了：${result.asked2.join("、")}` : "没问" },
      { 项目: "Skill 目录有没有再发一遍", 值: reopenedFirst.messages.filter((m) => m.kind === "skill-listing").length === 1 ? "没有，历史里已经有了" : "重发了" },
    ]);
    t.equal("重开之后第一次运行的全部工具结果都在请求里", [resumedIds.includes("mcp"), resumedIds.includes("agent"), resumedIds.includes("edit-src")], [true, true, true]);
    t.equal("Skill 授予的权限只管上一次运行：重开后 Test 要重新问", result.asked2, ["Test test/slug.test.cjs"]);
    t.equal("重开后继续做完", [run2.terminal.status, run2.terminal.messages.at(-1).text], ["completed", "再次确认：测试通过。"]);

  }

  if (wants("compact")) {
    // ═══════════ 七、压缩写回 ═══════════
    t.log();
    t.log("七、压缩：摘要写回会话文件");
    t.log();
    const compactRequest = run3.frames.filter((f) => f.type === "request");
    const restored = result.historyAfter.filter((m) => m.text.startsWith("[restored file]")).map((m) => m.text.split("\n")[0].replace("[restored file] ", ""));
    t.table([
      { 项目: "会话文件的记录数（压缩前 → 后）", 值: `${result.rowsBefore} → ${result.rowsAfter}（旧记录一条没删）` },
      { 项目: "摘要请求的次数（第三次运行有两个模型请求）", 值: result.summaries },
      { 项目: "压缩边界", 值: result.compactRow ? "新的根（parent 为空），logicalParent 指回压缩前的叶子" : "没有" },
      { 项目: "重开后的历史", 值: `${result.historyAfter.length} 条，第一条是${result.historyAfter[0].text.startsWith("[compact boundary]") ? "摘要" : "压缩之前的旧消息"}` },
      { 项目: "压缩后重新附上的文件", 值: restored.join("、") },
      { 项目: "第四次运行的第一个请求（重开后）", 值: `${run4.frames.find((f) => f.type === "request").wire.messages.length} 条消息` },
    ]);
    t.equal("完整压缩只请求了一次摘要，后面的请求沿用写回的结果", [compactRequest.length, result.summaries], [2, 1]);
    t.ok("压缩边界是新的根，旧记录原样保留", result.compactRow?.parent === null && result.rowsAfter > result.rowsBefore && Boolean(new Session(result.sessionFile).history(result.compactRow.logicalParent).length));
    t.ok("重开之后，历史从摘要开始", result.historyAfter[0].text.startsWith("[compact boundary]") && run4.terminal.status === "completed");
    t.ok("压缩后重新读了最近读过的文件，而不是沿用旧结果", restored.includes("src/slug.cjs"));

  }

  if (wants("hooks")) {
    // ═══════════ 八、Hook 的意见与生命周期事件 ═══════════
    t.log();
    t.log("八、Hook 的权限意见，以及提示和会话开始的 Hook");
    t.log();
    const write = { calls: [{ id: "w", name: "Write", input: { path: "out.txt", text: "hi" } }] };
    const mini = async (name, { entries = [], rules = {}, mode = "default", replies = [write, { text: "done" }], text = "写一个文件", sessionFile, twice = false }) => {
      const dir = join(t.temp, name);
      mkdirSync(dir);
      const asked = [];
      const open = (script) =>
        createCoda({ root: dir, model: scripted(script), hooks: new Hooks(entries), rules, mode, sessionFile, ask: async (c) => (asked.push(c.name), true) });
      const app = open(replies);
      const out = await app.run(text);
      await app.close();
      let again;
      if (twice) {
        const second = open([{ text: "好" }]);
        again = await second.run("继续");
        await second.close();
      }
      return { dir, asked, out, again, written: existsSync(join(dir, "out.txt")) };
    };
    const opinion = (permission) => [{ event: "PreToolUse", run: async () => (permission === "deny" ? { permission, block: true, reason: "Hook 说不行" } : { permission }) }];
    const permissionCases = [
      ["没有 Hook", [], {}, "default"],
      ["Hook 说 allow", opinion("allow"), {}, "default"],
      ["Hook 说 allow，规则说 ask", opinion("allow"), { ask: ["Write(out.txt)"] }, "default"],
      ["Hook 说 allow，规则说 deny", opinion("allow"), { deny: ["Write(out.txt)"] }, "default"],
      ["Hook 说 ask，模式本来放行", opinion("ask"), {}, "acceptEdits"],
      ["Hook 说 deny", opinion("deny"), {}, "default"],
    ];
    const permissionRows = [];
    for (const [name, entries, rules, mode] of permissionCases) {
      const run = await mini(`perm-${permissionRows.length}`, { entries, rules, mode });
      permissionRows.push({ 场景: name, 模式: mode, 问用户: run.asked.length ? "问了" : "没问", 文件: run.written ? "写了" : "没写" });
    }
    t.table(permissionRows);
    t.equal(
      "Hook 的 allow 只能省掉询问；ask 规则和 deny 规则仍然优先，Hook 的 ask 能让放行的模式也去问",
      permissionRows.map((r) => `${r.问用户}/${r.文件}`),
      ["问了/写了", "没问/写了", "问了/写了", "没问/没写", "问了/写了", "没问/没写"],
    );

    const blocked = await mini("submit", { entries: [{ event: "UserPromptSubmit", run: async () => ({ block: true, reason: "提示里带着密钥" }) }], replies: [], sessionFile: join(t.temp, "submit", "s.jsonl") });
    t.log(`UserPromptSubmit 拦下提示：terminal 是 ${blocked.out.terminal.status}（${blocked.out.terminal.reason}），模型请求 ${blocked.out.frames.filter((f) => f.type === "request").length} 次，会话文件里 ${new Session(join(t.temp, "submit", "s.jsonl")).history().length} 条消息。`);
    t.equal("被 UserPromptSubmit 拦下的提示不发给模型，也不写进会话文件", [blocked.out.terminal.reason, blocked.out.frames.filter((f) => f.type === "request").length, new Session(join(t.temp, "submit", "s.jsonl")).history().length], ["prompt_blocked", 0, 0]);

    const start = await mini("start", { entries: [{ event: "SessionStart", matcher: "startup", run: async () => ({ context: "当前发布分支：release-1" }) }], replies: [{ text: "好" }], sessionFile: join(t.temp, "start", "s.jsonl"), twice: true });
    const seen = (out) => out.frames.find((f) => f.type === "request").wire.messages.filter((m) => m.text.includes("release-1")).length;
    t.log(`SessionStart(startup) 的补充信息：第一次运行的第一个请求里有 ${seen(start.out)} 条；重开会话（source 是 resume）之后的请求里仍是 ${seen(start.again)} 条——来自历史，没有再加。`);
    t.equal("SessionStart 的补充信息按 source 匹配：startup 加一次，resume 不重复加", [seen(start.out), seen(start.again)], [1, 1]);

  }

  if (wants("big")) {
    // ═══════════ 九、大输出落盘 ═══════════
    t.log();
    t.log("九、大输出：落盘，模型只收到路径和预览");
    t.log();
    const bigDir = join(t.temp, "big");
    mkdirSync(bigDir);
    const big = createCoda({
      root: bigDir,
      model: scripted([{ calls: [{ id: "big", name: "mcp__fixture__echo", input: { text: "x".repeat(40_000) } }] }, { text: "ok" }]),
      mcpServers: { fixture: { command: process.execPath, args: [FIXTURE] } },
      rules: { allow: ["mcp__fixture"] },
    });
    const bigRun = await big.run("回显一大段文字");
    await big.close();
    const bigResult = bigRun.terminal.messages.find((m) => m.id === "big");
    const saved = bigResult.details?.persistedPath;
    t.table([
      { 项目: "工具输出", 值: "40000 个字符" },
      { 项目: "模型收到", 值: `${bigResult.text.length} 个字符：${bigResult.text.split("\n")[0].replace(bigDir, ".").slice(0, 70)}` },
      { 项目: "完整内容", 值: saved ? `${readFileSync(saved, "utf8").length} 个字符，在 ${saved.replace(bigDir, ".")}` : "没有保存" },
    ]);
    t.ok("createCoda 默认打开大结果落盘：完整内容在文件里，模型只收到路径和预览", Boolean(saved) && readFileSync(saved, "utf8").length === 40_000 && bigResult.text.length < 3000);

  }

  if (wants("exit")) {
    // ═══════════ 十、退出码 ═══════════
    t.log();
    t.log("十、命令行：按最后的结局给退出码，stdout 上只有协议");
    t.log();
    const mk = (name, files = {}) => {
      const dir = join(t.temp, name);
      mkdirSync(dir);
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
      return dir;
    };
    const read = { calls: [{ id: "r", name: "Read", input: { path: "a.txt" } }] };
    const cases = [
      ["答完", { text: "ok", replies: [{ text: "ok" }] }, { "a.txt": "x" }],
      ["轮数用完", { text: "读", replies: [read, read, { text: "完" }], maxTurns: 1 }, { "a.txt": "x" }],
      ["模型请求失败", { text: "你好", replies: [] }, {}],
      ["输入里有坏行", "not json", {}],
    ];
    const rows = [];
    for (const [name, input, files] of cases) {
      const dir = mk(name, files);
      const run = await runCli(dir, typeof input === "string" ? input : { type: "user", ...input });
      const end = run.frames.findLast((f) => f.type === "terminal" || f.type === "protocol_error");
      rows.push({ 场景: name, 最后一帧: end ? `${end.type}${end.reason ? `（${end.reason}）` : ""}` : "—", 退出码: run.code, stderr: run.stderr ? "有" : "空" });
      run.name = name;
      cases.find((c) => c[0] === name).run = run;
    }
    t.table(rows);
    const exits = Object.fromEntries(cases.map((c) => [c[0], c.run.code]));
    t.equal("答完是 0，轮数用完、模型失败、坏输入都是 1", exits, { 答完: 0, 轮数用完: 1, 模型请求失败: 1, 输入里有坏行: 1 });
    t.ok("stdout 上只有协议帧，stderr 是空的", cases.every((c) => c.run.stderr === "" && c.run.frames.every((f) => typeof f.type === "string")));

  }

  t.observations.summary = { requests: requests1.length, asked: result.asked, summaries: result.summaries };
});
