// 第 1 章：主循环的状态与出口。
//   node labs/chapters/01-one-run.mjs
// 用脚本化的模型（每一次回复都由脚本决定）驱动 coda 的 Engine，只改变模型说什么，
// 观察循环每一圈为什么继续（transition）、最后为什么停（reason）。
import { lesson } from "./harness.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine, scripted, collect } from "../../coda/src/engine.mjs";
import { Toolset } from "../../coda/src/tools.mjs";

await lesson(1, "主循环的状态与出口", async (t) => {
  const file = join(t.root, "result.txt");
  const call = (id, name, input) => ({ id, name, input });
  const need = (key) => (input) => {
    if (typeof input[key] !== "string") throw Error(`参数缺失：需要 ${key}`);
  };

  // 三个最小的工具：Read（只读、可并行）、Write（校验参数、写磁盘）、Wait（一直等到被中止）。
  // Write 把每次真正写入的内容记在 writes 里，这样“没有写”也看得见。
  function makeToolset(hooks) {
    return new Toolset([
      { name: "Read", parallel: true, validate: need("path"), execute: (i) => (hooks.onRead?.(), { text: `内容：${i.path}` }) },
      {
        name: "Write",
        validate: need("text"),
        execute: (i) => {
          hooks.writes.push(i.text);
          writeFileSync(file, i.text);
          return { text: "已写入" };
        },
      },
      {
        name: "Wait",
        validate() {},
        execute: (_i, { signal }) =>
          new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("工具被中止")), { once: true })),
      },
    ]);
  }

  // 跑一个场景：返回它产生的帧、被询问的次数等。
  async function scenario(name, replies, { onStop, onRead, run = {}, abortAfter } = {}) {
    const hooks = { writes: [], onRead: undefined };
    const seen = { cleaned: 0, notified: [], stop: [] };
    const controller = new AbortController();
    const engine = new Engine({
      tools: makeToolset(hooks),
      model: scripted(replies),
      onStop: onStop && (async (input) => (seen.stop.push(input.stopHookActive), onStop(input))),
      onCleanup: async () => seen.cleaned++,
      onCompleted: (terminal) => seen.notified.push(terminal.reason),
    });
    hooks.onRead = onRead && (() => onRead(engine));
    if (abortAfter) setTimeout(() => controller.abort(Error("用户按下了 Esc")), abortAfter);
    const frames = await collect(engine, "开始", { signal: controller.signal, ...run });
    const requests = frames.filter((f) => f.type === "request");
    return { name, frames, requests, terminal: frames.at(-1), writes: hooks.writes, ...seen };
  }

  // 连续重复的原因折叠成 “原因 ×n”，表格才放得下。
  const chain = (reasons) =>
    reasons
      .reduce((groups, reason) => (groups.at(-1)?.reason === reason ? groups.at(-1).n++ : groups.push({ reason, n: 1 }), groups), [])
      .map((g) => (g.n > 1 ? `${g.reason} ×${g.n}` : g.reason))
      .join(" → ");

  // ── 先把所有场景跑一遍 ─────────────────────────────────────────
  const plain = await scenario("普通：读文件，再回答", [
    { calls: [call("r1", "Read", { path: "a.txt" })] },
    { text: "文件里是 a.txt 的内容。" },
  ]);
  const resumed = await scenario("文字被截断一次", [
    { text: "安装步骤：先克隆仓库，再运行 np", stop: "length" },
    { text: "m install。" },
  ]);
  const stuck = await scenario("文字一直被截断", Array.from({ length: 6 }, (_, i) => ({ text: `第 ${i + 1} 段……`, stop: "length" })));
  const withCall = await scenario("截断，但带着完整的 Write 调用", [
    { text: "我来写文件", calls: [call("w1", "Write", { text: "COMPLETE" })], stop: "length" },
    { text: "写好了。" },
  ]);
  const cut = await scenario("截断，Write 的参数解析成了 {}", [
    { calls: [call("w1", "Write", {})], stop: "length" },
    { calls: [call("w2", "Write", { text: "COMPLETE" })] },
    { text: "写好了。" },
  ]);
  const hooked = await scenario("Stop Hook 拦住一次结束", [{ text: "做完了。" }, { text: "补上了测试，这次真的做完了。" }], {
    onStop: async ({ stopHookActive }) => (stopHookActive ? undefined : { block: "还没有运行测试" }),
  });
  const looping = await scenario("工具一直调用，maxTurns=3", Array.from({ length: 8 }, (_, i) => ({ calls: [call(`r${i}`, "Read", { path: "x" })] })), {
    run: { maxTurns: 3 },
  });
  let blocked = 0;
  const pingPong = await scenario("Stop Hook 连拦 5 次，maxTurns=2", Array.from({ length: 8 }, (_, i) => ({ text: `第 ${i + 1} 次想结束` })), {
    run: { maxTurns: 2 },
    onStop: async () => (++blocked <= 5 ? { block: "再检查一遍" } : undefined),
  });
  let queuedOnce = false;
  const queued = await scenario(
    "运行中排了两条消息",
    [{ calls: [call("r1", "Read", { path: "a.txt" })] }, { text: "读完了。" }, { text: "收到补充的任务。" }],
    {
      onRead(engine) {
        if (queuedOnce) return;
        queuedOnce = true;
        engine.steer("只用一句话回答");
        engine.follow("再帮我写个测试");
      },
    },
  );
  const aborted = await scenario("工具执行期间被中止", [{ calls: [call("a", "Wait", {}), call("b", "Read", { path: "b.txt" })] }], { abortAfter: 20 });
  const failing = await scenario("模型请求抛错", []);

  // 调用者提前离开：没有 terminal 帧，所以单独算一行。
  let earlyCleaned = 0;
  let earlyCompleted = 0;
  const early = new Engine({
    tools: makeToolset({ writes: [] }),
    model: scripted([{ text: "a" }]),
    onCleanup: async () => earlyCleaned++,
    onCompleted: () => earlyCompleted++,
  });
  const iterator = early.run("调用者中途离开");
  await iterator.next();
  await iterator.return();

  // ── 汇总 ─────────────────────────────────────────────────────
  t.log("同一个 Engine，十二种脚本。每一行是一次完整的运行。\n");
  const runs = [plain, resumed, stuck, withCall, cut, hooked, looping, pingPong, queued, aborted, failing];
  t.table([
    ...runs.map((r) => ({
      场景: r.name,
      模型请求: r.requests.length,
      每一圈为什么继续: chain(r.requests.map((f) => f.transition.reason)),
      出口: r.terminal.reason + (r.terminal.outputTruncated ? "（仍被截断）" : ""),
      清理: r.cleaned,
      完成通知: r.notified.length,
    })),
    { 场景: "调用者提前 .return()", 模型请求: 1, 每一圈为什么继续: "initial", 出口: "（生成器被关闭，没有 terminal）", 清理: earlyCleaned, 完成通知: earlyCompleted },
  ]);

  // ── 逐项看细节 ────────────────────────────────────────────────
  t.log("【1】有工具调用就再请求，没有就结束");
  t.equal("普通任务的两圈：initial、next_turn", plain.requests.map((f) => f.transition.reason), ["initial", "next_turn"]);

  t.log("\n【2】文字被截断：保留半截，追加一条元消息请它接着写。第二次请求实际带上的消息：");
  const resumeWire = resumed.requests[1].wire.messages;
  t.table(resumeWire.map((m, i) => ({ "#": i + 1, role: m.role, 元消息: m.meta ? "是" : "", 内容: m.text })));
  t.equal("半截回复留在历史里，后面跟着一条元消息", resumeWire.map((m) => `${m.role}${m.meta ? "(meta)" : ""}`), ["user", "assistant", "user(meta)"]);
  t.equal("续写不算新的一轮", resumed.requests.map((f) => f.turn), [1, 1]);
  t.equal("续写最多 3 次，所以一共请求 4 次", stuck.requests.length, 4);
  t.ok("续写用尽后，terminal 标出“仍被截断”", stuck.terminal.outputTruncated === true && stuck.terminal.reason === "completed");

  t.log("\n【3】截断的回复里有工具调用：不续写，走工具路径");
  t.equal("完整的 Write 被执行了", withCall.writes, ["COMPLETE"]);
  t.ok("第二次请求里没有续写提示", !withCall.requests[1].wire.messages.some((m) => m.meta));
  const cutError = cut.frames.find((f) => f.type === "tool_result").message;
  t.equal("参数成了 {} 的调用被校验拦下：结果是错误，磁盘上没有半个文件", [cutError.error, cutError.text], [true, "参数缺失：需要 text"]);
  t.equal("模型看到错误后重发，磁盘上只出现过完整内容", [cut.writes, readFileSync(file, "utf8")], [["COMPLETE"], "COMPLETE"]);

  t.log("\n【4】Stop Hook：拦得住结束，但 maxTurns 拦不住 Hook");
  t.equal("Hook 第一次被问时 stopHookActive 为假，第二次为真", hooked.stop, [false, true]);
  t.equal("被拦住的那一圈叫 stop_hook_blocking", hooked.requests.map((f) => f.transition.reason), ["initial", "stop_hook_blocking"]);
  t.equal("maxTurns=3：请求 3 次后停下", [looping.requests.length, looping.terminal.reason, looping.terminal.status], [3, "max_turns", "budget"]);
  t.equal("Hook 连拦 5 次、maxTurns=2：照样请求了 6 次，正常结束", [pingPong.requests.length, pingPong.terminal.reason], [6, "completed"]);

  t.log("\n【5】运行中排队的消息：steer 在工具之后进来，follow 等这一轮结束");
  const userTexts = queued.requests.map((f) => f.wire.messages.filter((m) => m.role === "user").map((m) => m.text));
  t.table(userTexts.map((texts, i) => ({ 请求: i + 1, 这次请求里的用户消息: texts.join(" ｜ "), 为什么继续: queued.requests[i].transition.reason })));
  t.equal("steer 的消息出现在工具结果之后的那次请求里", userTexts[1], ["开始", "只用一句话回答"]);
  t.equal("follow 的消息要等到这一轮结束才出现", userTexts[2], ["开始", "只用一句话回答", "再帮我写个测试"]);

  t.log("\n【6】中止：每个工具调用都必须有结果");
  const history = aborted.terminal.messages;
  t.table(history.map((m) => ({ role: m.role, 内容: m.calls?.length ? m.calls.map((c) => `调用 ${c.name}（${c.id}）`).join("，") : `${m.id ? m.id + "：" : ""}${m.text}` })));
  t.equal("两个调用都有结果（被中止的是错误结果）", history.filter((m) => m.role === "tool").map((m) => [m.id, m.error]), [["a", true], ["b", true]]);
  t.equal("出口是 aborted_tools，对外的 status 是 cancelled", [aborted.terminal.reason, aborted.terminal.status], ["aborted_tools", "cancelled"]);

  t.log("\n【7】三种结束方式，三种通知");
  t.equal("提前 .return()：资源释放了一次，没有完成通知", [earlyCleaned, earlyCompleted], [1, 0]);
  t.equal("模型请求抛错：生成器正常返回 model_error，资源释放，完成通知照发", [failing.terminal.reason, failing.cleaned, failing.notified], ["model_error", 1, ["model_error"]]);
  t.equal("正常结束：资源释放一次，完成通知一次", [plain.cleaned, plain.notified], [1, ["completed"]]);

  t.observations.exits = runs.map((r) => ({ scenario: r.name, requests: r.requests.length, exit: r.terminal.reason, status: r.terminal.status }));
});
