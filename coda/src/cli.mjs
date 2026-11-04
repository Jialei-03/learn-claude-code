// coda 的命令行入口：无界面运行（第 12、13 章）。
//
// 对应 Claude Code 的 `claude -p --input-format stream-json --output-format stream-json`：
//   · stdin 一行一条 JSON，stdout 一行一条 JSON，stdout 上只有协议（cli/print.ts、cli/structuredIO.ts）；
//   · 运行到一半需要人回答的问题（能不能写这个文件）走 permission_request / permission_response；
//   · 退出码看最后一次运行的结果：出错就是 1，否则 0（runHeadless 末尾看最后一条 result 的 is_error）。
//
// 协议（宿主 → coda）：
//   {type:"user", text, replies?, rules?, mode?, maxTurns?}   提问。replies 是脚本模型的回复，演示用；一个进程只接一次提问
//   {type:"permission_response", id, allow, message?}         回答 coda 的提问
//   {type:"cancel"}                                           取消当前运行
// coda → 宿主：运行中的各种事件（started、request、assistant、tool_result、terminal……），
//   以及 {type:"permission_request", id, call}、{type:"control_cancel_request", id}、{type:"protocol_error"}。
//
// 用法：node coda/src/cli.mjs [工作目录]，然后在 stdin 上写 JSON 行。
import { join, resolve } from "node:path";
import { createCoda } from "./app.mjs";
import { scripted } from "./engine.mjs";
import { ControlIO, encodeFrame, guardStdout, readFrames } from "./io.mjs";

// 哪些结局算成功。completed 是正常答完；Stop Hook 主动叫停是用户配置的结果，也不算出错。
// 其余——轮数用完、被取消、模型请求失败、提示被 Hook 拦下——退出码都是 1：
// Claude Code 判断的是“最后一条消息是不是一次成功的回答”（isResultSuccessful），这几种都不是。
const SUCCESS_REASONS = new Set(["completed", "stop_hook_prevented"]);
const exitCodeFor = (terminal) => (terminal && SUCCESS_REASONS.has(terminal.reason) ? 0 : 1);

const root = resolve(process.argv[2] ?? ".");

// 在任何输出之前装上守卫：依赖库的 console.log 之类混进 stdout，会被改道到 stderr，不会毁掉宿主的逐行解析
const restoreStdout = guardStdout();
const send = (frame) => process.stdout.write(encodeFrame(frame));

const controller = new AbortController();
const io = new ControlIO(send);
let job;
let exitCode = 0;

// 读 stdin。不用 readline：它按 JavaScript 的规则切行，U+2028 之类也算换行；readFrames 只认 \n，坏行变成 protocol_error 帧
for await (const frame of readFrames(process.stdin)) {
  if (frame.type === "protocol_error") {
    // 和 Claude Code 一样：stdin 上出现坏行，说明宿主和我们的约定已经乱了，不再往下读
    send(frame);
    controller.abort(Error("protocol error"));
    exitCode = 1;
    break;
  }
  if (frame.type === "permission_response") {
    io.reply(frame);
    continue;
  }
  if (frame.type === "cancel") {
    controller.abort(Error("user cancelled"));
    continue;
  }
  if (frame.type !== "user" || job) {
    send({ type: "protocol_error", error: "one active input per process" });
    continue;
  }
  job = runOnce(frame);
}

io.close(); //  输入结束：还在等回答的提问一起被拒绝，否则运行会永远挂着
await job; //   EOF 不是中断：已经开始的运行照样做完
restoreStdout();
process.exitCode = exitCode;

// 一次运行：创建应用，跑完，按最后的结局决定退出码，最后一定关闭应用（MCP 服务器进程）
async function runOnce(frame) {
  let app;
  try {
    app = createCoda({
      root,
      model: scripted(frame.replies ?? [{ text: "ready", stop: "stop" }]),
      rules: frame.rules ?? {},
      mode: frame.mode ?? "default",
      sessionFile: join(root, ".coda/session.jsonl"),
      ask: (call) => io.ask(call, controller.signal),
      onEvent: send,
    });
    const { terminal } = await app.run(frame.text, { signal: controller.signal, maxTurns: frame.maxTurns });
    exitCode ||= exitCodeFor(terminal);
  } catch (error) {
    send({ type: "error", error: String(error.message ?? error) });
    exitCode = 1;
  } finally {
    await app?.close();
  }
}
