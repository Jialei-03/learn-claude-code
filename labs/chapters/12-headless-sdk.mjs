// 第 12 章实验：无界面运行。三个小实验，各回答一个问题：
//   pairing   同一组输入，Claude Code 的 StructuredIO（2.1.88 的原函数）和 coda 的 ControlIO 怎么反应？
//   session   一个宿主脚本通过 stdin / stdout 驱动真实的 coda 子进程：批准、拒绝、不回答就关闭输入、取消
//   framing   “一行一条 JSON”：写出时转义、读入时只按 \n 切、stdout 上的杂音改道
//
//   node --disable-warning=ExperimentalWarning labs/chapters/12-headless-sdk.mjs             全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/12-headless-sdk.mjs session     只运行一个
import { lesson, ROOT } from "./harness.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codingTools } from "../../coda/src/files.mjs";
import { permissionGate } from "../../coda/src/permissions.mjs";
import { Toolset } from "../../coda/src/tools.mjs";
import { ControlIO, encodeFrame, guardStdout, normalizeInput, readFrames } from "../../coda/src/io.mjs";
import { loadStructuredIO, start } from "../ch12/real.mjs";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLI = join(ROOT, "coda/src/cli.mjs");

await lesson(12, "无界面运行：请求配对、输入结束与一行一条 JSON", async (t) => {
  // ───────────────────────── 一、配对：真货 vs coda ─────────────────────────
  if (wants("pairing")) {
    t.log("一、同一组输入：Claude Code 的 StructuredIO（原函数）和 coda 的 ControlIO");
    t.log();
    t.log("左边是从 2.1.88 里取出来原样执行的 StructuredIO，右边是 coda 的 ControlIO 接在真正的 Toolset + 权限闸门上。");
    t.log("两边都在“Write 一个文件，需要宿主回答”的处境里，宿主做了不同的事：");
    t.log();

    const workspace = join(t.root, "pairing");
    mkdirSync(workspace);

    // coda 一侧：ControlIO → permissionGate → Toolset，和 cli.mjs 的接法一样
    const coda = () => {
      const frames = [];
      const controller = new AbortController();
      const io = new ControlIO((frame) => frames.push(frame));
      const tools = new Toolset(codingTools(workspace), {
        gate: permissionGate({ root: workspace, ask: (call) => io.ask(call, controller.signal) }),
      });
      const write = (id) => tools.execute({ id, name: "Write", input: { path: `${id}.txt`, text: "x" } }, { signal: controller.signal });
      return { io, frames, controller, write, requestId: () => frames.find((f) => f.type === "permission_request")?.id };
    };

    const rows = [];
    const row = (scene, real, ours) => rows.push({ 宿主做了什么: scene, "Claude Code 2.1.88": real, coda: ours });
    const asText = (message) => message.text;

    // 1. 回答的 id 不认识
    {
      const r = start();
      const pending = r.ask();
      await sleep(5);
      r.answer("no-such-request", { behavior: "allow", updatedInput: {}, toolUseID: "other" });
      await sleep(5);
      const stillWaiting = r.io.getPendingPermissionRequests().length === 1;
      r.answer(r.out[0].request_id, { behavior: "deny", message: "x", toolUseID: "tu-1" });
      await pending;

      const c = coda();
      const result = c.write("w1");
      await sleep(5);
      const accepted = c.io.reply({ id: "no-such-request", allow: true });
      await sleep(5);
      const stillWaitingCoda = c.io.pending.size === 1;
      c.io.reply({ id: c.requestId(), allow: false });
      await result;
      row("回答里的 id 不认识", stillWaiting ? "忽略，请求继续等待" : "?", stillWaitingCoda && !accepted ? `忽略（${c.io.ignored[0].why}），请求继续等待` : "?");
      t.ok("两边都忽略不认识的 id，请求仍在等待", stillWaiting && stillWaitingCoda && !accepted);
    }

    // 2. 同一个 id 回答两次
    {
      const r = start();
      const pending = r.ask();
      await sleep(5);
      const id = r.out[0].request_id;
      r.answer(id, { behavior: "allow", updatedInput: { path: "a" }, toolUseID: "tu-1" });
      const first = await pending;
      r.answer(id, { behavior: "deny", message: "重复", toolUseID: "tu-1" });
      await sleep(5);

      const c = coda();
      const result = c.write("w2");
      await sleep(5);
      const cid = c.requestId();
      c.io.reply({ id: cid, allow: true });
      const done = await result;
      const second = c.io.reply({ id: cid, allow: false });
      row("同一个 id 回答两次（第二次是 deny）", `第一次生效（${first.behavior}），第二次被吃掉`, `第一次生效（${done.error ? "错误" : "已执行"}），第二次忽略（${c.io.ignored.at(-1).why}）`);
      t.ok("重复的回答不会改变已经做出的决定", first.behavior === "allow" && !done.error && !second && r.orphans.length === 0);
    }

    // 3. 请求被取消以后，回答才到
    {
      const r = start();
      const pending = r.ask();
      await sleep(5);
      const id = r.out[0].request_id;
      r.abort.abort();
      const decision = await pending;
      r.answer(id, { behavior: "allow", updatedInput: { path: "a" }, toolUseID: "tu-1" });
      await sleep(5);
      const sent = r.out.map((m) => m.type);

      const c = coda();
      const result = c.write("w3");
      await sleep(5);
      const cid = c.requestId();
      c.controller.abort(Error("用户按了 Esc"));
      const cancelled = await result;
      const late = c.io.reply({ id: cid, allow: true });
      row("取消了请求，回答才姗姗来迟", `写出 \`${sent.at(-1)}\`；决定 ${decision.behavior}；迟到的回答被忽略`, `写出 \`${c.frames.at(-1).type}\`；工具结果是错误；迟到的回答忽略（${c.io.ignored.at(-1).why}）`);
      t.equal("取消时，两边都告诉宿主“这个问题不用回答了”", [sent.at(-1), c.frames.at(-1).type], ["control_cancel_request", "control_cancel_request"]);
      t.ok("取消之后的回答没有任何效果", decision.behavior === "deny" && cancelled.error && !late && r.orphans.length === 0);
    }

    // 4. 带理由的拒绝
    {
      const r = start();
      const pending = r.ask();
      await sleep(5);
      r.answer(r.out[0].request_id, { behavior: "deny", message: "宿主说：这个目录只读。", toolUseID: "tu-1" });
      const decision = await pending;

      const c = coda();
      const result = c.write("w4");
      await sleep(5);
      c.io.reply({ id: c.requestId(), allow: false, message: "宿主说：这个目录只读。" });
      const message = await result;
      row("拒绝，并写了理由", `决定 deny，message 就是理由：“${decision.message}”`, `工具结果（给模型的）：“${asText(message)}”`);
      t.equal("拒绝的理由原样到了模型手里（Claude Code 是 message，coda 是工具结果文本）", [decision.message, asText(message)], ["宿主说：这个目录只读。", "宿主说：这个目录只读。"]);
    }

    // 5. 输入结束时有请求在等
    {
      const r = start();
      const pending = r.ask();
      await sleep(5);
      r.input.end();
      const decision = await pending;

      const c = coda();
      const result = c.write("w5");
      await sleep(5);
      c.io.close();
      const message = await result;
      row("还没回答，输入就结束了（EOF）", `决定 ${decision.behavior}：“${decision.message}”`, `工具结果（错误）：“${asText(message)}”`);
      t.ok("EOF 让等待中的请求立刻结束，而且是拒绝，不是放行", decision.behavior === "deny" && message.error && /input closed/.test(asText(message)));
    }

    // 6. 输入结束以后又来了新的调用
    {
      const r = start();
      r.input.end();
      await sleep(5);
      const decision = await r.ask("tu-2");

      const c = coda();
      c.io.close();
      const message = await c.write("w6");
      row("输入已经结束，才轮到下一个调用", `决定 ${decision.behavior}：“${decision.message}”`, `工具结果（错误）：“${asText(message)}”`);
      t.ok("管道关了以后，新的请求连问都不问", decision.behavior === "deny" && message.error && c.frames.length === 0);
    }

    t.table(rows);
    t.log("EOF 之后的请求，在 Claude Code 里走 sendRequest 开头的 inputClosed 检查，在 coda 里是 ask 开头的 closed 检查。");
    t.log();
  }

  // ───────────────────────── 二、真实子进程会话 ─────────────────────────
  if (wants("session")) {
    t.log("二、一个宿主脚本驱动真实的 coda 子进程（node coda/src/cli.mjs）");
    t.log();

    // 宿主：启动子进程，按行读它的 stdout（用 coda 自己的 readFrames），对每一帧可以回话
    const drive = async (name, { replies, files = {}, onFrame, begin }) => {
      const dir = join(t.root, name);
      mkdirSync(dir);
      for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
      const child = spawn(process.execPath, [CLI, dir], { cwd: dir, env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
      const timeline = [];
      const host = {
        send(frame) {
          timeline.push(["宿主", frame]);
          child.stdin.write(encodeFrame(frame));
        },
        eof() {
          timeline.push(["宿主", { type: "(关闭 stdin)" }]);
          child.stdin.end();
        },
      };
      child.stdin.on("error", () => {});
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const frames = [];
      const reading = (async () => {
        for await (const frame of readFrames(child.stdout)) {
          frames.push(frame);
          timeline.push(["coda", frame]);
          onFrame?.(frame, host);
        }
      })();
      const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
      begin(host, replies);
      const code = await new Promise((resolve) => child.on("close", resolve));
      clearTimeout(killer);
      await reading;
      return { dir, timeline, frames, code, stderr, terminal: frames.findLast((f) => f.type === "terminal") };
    };

    // 把一帧压缩成一句话；request / tool_start / tool_end 与本实验无关，不显示
    const say = (who, frame) => {
      switch (frame.type) {
        case "user": return `user “${frame.text}”`;
        case "permission_request": return `permission_request ${frame.id}：${frame.call.name} ${JSON.stringify(frame.call.input)}`;
        case "permission_response": return `permission_response ${frame.id}：${frame.allow ? "allow" : "deny"}${frame.message ? `，理由“${frame.message}”` : ""}`;
        case "control_cancel_request": return `control_cancel_request ${frame.id}`;
        case "assistant": return `assistant ${frame.message.text ? `“${frame.message.text}”` : frame.message.calls.map((c) => `调用 ${c.name}`).join("、")}`;
        case "tool_result": return `tool_result${frame.message.error ? "（错误）" : ""} “${frame.message.text}”`;
        case "terminal": return `terminal ${frame.status}（${frame.reason}）`;
        default: return frame.type;
      }
    };
    const shown = (item) => !["request", "tool_start", "tool_end"].includes(item[1].type);

    const write = { calls: [{ id: "w1", name: "Write", input: { path: "notes.txt", text: "hello" } }] };
    const finish = { text: "处理完了。" };
    const ask = (frame, host, reply) => frame.type === "permission_request" && host.send({ type: "permission_response", id: frame.id, ...reply });
    const user = (replies) => (host) => host.send({ type: "user", text: "写一个笔记文件 notes.txt", replies });

    // 1. 批准：完整的时间线
    const allow = await drive("allow", {
      replies: [write, finish],
      begin: user([write, finish]),
      onFrame: (frame, host) => {
        ask(frame, host, { allow: true });
        if (frame.type === "terminal") host.eof(); // 做完了，关闭输入，进程自己退出
      },
    });
    t.log("2.1 批准：宿主回答 allow，完整的时间线");
    t.log();
    t.table(allow.timeline.filter(shown).map(([who, frame]) => ({ 谁: who, 内容: say(who, frame) })));
    t.ok("批准以后文件真的写了，运行以 completed 结束，进程自己退出", existsSync(join(allow.dir, "notes.txt")) && allow.terminal.status === "completed" && allow.code === 0);
    t.equal("写出的内容是模型要求的", readFileSync(join(allow.dir, "notes.txt"), "utf8"), "hello");

    // 2~6. 宿主的另外五种做法
    const cases = [];
    const record = (name, description, run, extra = {}) => cases.push({ name, description, run, ...extra });

    record("deny", "拒绝，并写了理由", await drive("deny", {
      replies: [write, finish],
      begin: user([write, finish]),
      onFrame: (frame, host) => {
        ask(frame, host, { allow: false, message: "宿主说：这个目录只读。" });
        if (frame.type === "terminal") host.eof();
      },
    }));

    record("wrong-id", "先回一个不认识的 id，再回正确的", await drive("wrong-id", {
      replies: [write, finish],
      begin: user([write, finish]),
      onFrame: (frame, host) => {
        if (frame.type === "permission_request") {
          host.send({ type: "permission_response", id: "no-such-request", allow: false });
          setTimeout(() => host.send({ type: "permission_response", id: frame.id, allow: true }), 100);
        }
        if (frame.type === "terminal") host.eof();
      },
    }));

    record("eof-pending", "不回答，直接关闭 stdin", await drive("eof-pending", {
      replies: [write, finish],
      begin: user([write, finish]),
      onFrame: (frame, host) => frame.type === "permission_request" && host.eof(),
    }));

    record("eof-early", "发完提问立刻关闭 stdin（模型只读文件，不需要确认）", await drive("eof-early", {
      replies: [{ calls: [{ id: "r1", name: "Read", input: { path: "a.txt" } }] }, { text: "读完了。" }],
      files: { "a.txt": "alpha\n" },
      begin: (host, replies) => {
        host.send({ type: "user", text: "读一下 a.txt", replies });
        host.eof();
      },
    }));

    record("cancel", "收到提问后发 cancel", await drive("cancel", {
      replies: [write, finish],
      begin: user([write, finish]),
      onFrame: (frame, host) => {
        if (frame.type === "permission_request") host.send({ type: "cancel" });
        if (frame.type === "terminal") host.eof();
      },
    }));

    t.log();
    t.log("2.2 宿主的另外五种做法");
    t.log();
    const outcome = (c) => {
      const result = c.run.frames.findLast((f) => f.type === "tool_result");
      const file = join(c.run.dir, "notes.txt");
      return {
        场景: `\`${c.name}\``,
        宿主做了什么: c.description,
        工具结果: result ? `${result.message.error ? "（错误）" : ""}“${result.message.text}”` : "—",
        "terminal": `${c.run.terminal.status}（${c.run.terminal.reason}）`,
        退出码: c.run.code,
        "notes.txt": existsSync(file) ? "已写入" : "没有",
        协议帧: c.run.frames.filter((f) => ["permission_request", "control_cancel_request"].includes(f.type)).map((f) => f.type.replace("permission_request", "问").replace("control_cancel_request", "撤销")).join("、") || "—",
      };
    };
    t.table(cases.map(outcome));

    const get = (name) => cases.find((c) => c.name === name).run;
    const lastResult = (run) => run.frames.findLast((f) => f.type === "tool_result").message;
    t.equal("拒绝的理由成为工具结果，文件没有写", [lastResult(get("deny")).text, existsSync(join(get("deny").dir, "notes.txt"))], ["宿主说：这个目录只读。", false]);
    t.ok("不认识的 id 被忽略，随后正确的回答照样生效", existsSync(join(get("wrong-id").dir, "notes.txt")) && get("wrong-id").terminal.status === "completed");
    t.ok("不回答就关闭输入：请求被拒绝，运行照常走完，进程自己退出", /input closed/.test(lastResult(get("eof-pending")).text) && get("eof-pending").terminal.status === "completed" && get("eof-pending").code === 0);
    t.ok("EOF 不是中断：提问发完立刻关闭输入，已经开始的运行照样做完", get("eof-early").terminal.status === "completed" && /alpha/.test(lastResult(get("eof-early")).text));
    t.ok("取消：宿主收到撤销通知，运行以 cancelled 结束", get("cancel").frames.some((f) => f.type === "control_cancel_request") && get("cancel").terminal.status === "cancelled");
    t.ok("所有子进程都自己退出了，没有被强制杀掉；退出码看最后的结局：只有被取消的那次是 1", cases.every((c) => c.run.code === (c.name === "cancel" ? 1 : 0)) && allow.code === 0);
    t.ok("子进程的 stderr 是空的：stdout 以外没有杂音，stdout 上全是协议帧", [allow, ...cases.map((c) => c.run)].every((r) => r.stderr === "" && r.frames.every((f) => f.type !== "protocol_error")));
    t.log();
    t.log("退出码按最后一次运行的结局设置（第 13 章总装时补上）：取消的那次是 1，和 Claude Code 的 -p 在最后一个 result 的 is_error 为真时退出 1 一致。");
    t.log();
  }

  // ───────────────────────── 三、一行一条 JSON ─────────────────────────
  if (wants("framing")) {
    t.log("三、一行一条 JSON：写出、读入、杂音");
    t.log();

    // 写出：coda 的 encodeFrame 和 Claude Code 的 ndjsonSafeStringify（原函数）逐个对比
    const { ndjsonSafeStringify } = loadStructuredIO();
    const lineTerminators = /[\n\r\u2028\u2029]/; // ECMAScript 对“一行”的定义
    const samples = [
      ["普通文本", { text: "hello" }],
      ["中文", { text: "你好" }],
      ["含 U+2028", { text: "前\u2028后" }],
      ["含 U+2029", { text: "前\u2029后" }],
      ["含换行", { text: "第一行\n第二行" }],
    ];
    // 原样写出的 U+2028 / U+2029 画成 ⟨U+2028⟩；转义过的写法本来就是普通字符 \u2028，原样显示
    const visible = (text) => text.replace(/[\u2028\u2029]/g, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase()}⟩`).replace(/\n/g, "\\n");
    const writeRows = samples.map(([label, value]) => {
      const naive = JSON.stringify(value);
      const safe = encodeFrame(value);
      t.equal(`encodeFrame 与 ndjsonSafeStringify 输出一致：${label}`, safe, ndjsonSafeStringify(value) + "\n");
      return {
        内容: label,
        "JSON.stringify 的结果": visible(naive),
        "按 ECMAScript 行规则切成": `${naive.split(lineTerminators).length} 段`,
        "encodeFrame 的结果": visible(safe.trimEnd()),
        "切成": `${safe.trimEnd().split(lineTerminators).length} 段`,
      };
    });
    t.log("3.1 写出：JSON.stringify 会把 U+2028 / U+2029 原样写出，按 ECMAScript 规则切行的接收方会把一条消息切成两半");
    t.log();
    t.table(writeRows);
    t.equal("encodeFrame 写出的每一帧都只含一个换行，在结尾", samples.map(([, v]) => (encodeFrame(v).match(/\n/g) ?? []).length), samples.map(() => 1));

    // 读入：数据块在任意位置断开
    const bytes = Buffer.from('{"type":"user","text":"你好"}\n\n{"type":"cancel"}\nnot json\n{"type":"user","text":"没有换行"}');
    const cut = bytes.indexOf(Buffer.from("好")) + 1; // 恰好切在“好”的三个字节中间
    const frames = [];
    for await (const frame of readFrames([bytes.subarray(0, cut), bytes.subarray(cut)])) frames.push(frame);
    t.log("3.2 读入：一个字符的三个字节被拆在两个数据块里，中间有空行，有一行坏掉，最后一行没有换行");
    t.log();
    t.table(frames.map((f, i) => ({ "#": i + 1, 读到的帧: f.type === "protocol_error" ? `protocol_error：${f.line}` : JSON.stringify(f) })));
    t.equal("拆开的字符完整还原，空行跳过，坏行变成 protocol_error，没有换行的最后一行也处理", frames.map((f) => f.type), ["user", "cancel", "protocol_error", "user"]);
    t.equal("拆在中间的字符没有变成乱码", frames[0].text, "你好");

    // 杂音：stdout 上混进了不是 JSON 的行
    const out = [], err = [];
    const fake = { write: (chunk) => (out.push(String(chunk)), true) };
    const restore = guardStdout(fake, { write: (chunk) => err.push(String(chunk)) });
    fake.write(encodeFrame({ type: "started" }));
    fake.write("debug: 某个依赖库的 console.log\n");
    fake.write('{"type":"term');
    fake.write('inal"}\n');
    restore();
    t.log("3.3 杂音：往 stdout 写了一行调试输出，还有一条分两次写完的 JSON");
    t.log();
    t.table([
      { 去向: "stdout（宿主能读到的）", 内容: out.map((s) => s.trimEnd()).join("  ｜  ") },
      { 去向: "stderr（改道）", 内容: err.map((s) => s.trimEnd()).join("  ｜  ") },
    ]);
    t.equal("JSON 行留在 stdout，调试输出改道 stderr，分两次写的 JSON 拼完整后才判断", [out.length, err.length], [2, 1]);

    t.equal("normalizeInput：非空字符串变成一条 user 消息，空白字符串变空流，消息流原样放行", [normalizeInput("你好"), normalizeInput("   "), normalizeInput([{ type: "user", text: "x" }])], [[{ type: "user", text: "你好" }], [], [{ type: "user", text: "x" }]]);
  }
});
