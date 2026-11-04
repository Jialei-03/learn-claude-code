// 第 12 章：无界面运行的 IO 层。
//
// 终端没有了，剩下一根进来的管道（stdin）和一根出去的管道（stdout）。这一层要解决三件事：
//   1. 怎么把管道切成一条一条的消息（一行一个 JSON）；
//   2. 运行到一半需要“人”来回答的问题（能不能写这个文件？），怎么变成一次带 id 的请求和回答；
//   3. 管道关了、用户取消了、回答迟到了，这些没人回答的情形怎么收场。
//
// 对应 Claude Code 的源码：
//   cli/structuredIO.ts            StructuredIO：读 stdin、sendRequest / createCanUseTool、EOF 时拒绝等待中的请求
//   cli/ndjsonSafeStringify.ts     写出去的时候转义 U+2028 / U+2029，保证“一行一条”
//   utils/streamJsonStdoutGuard.ts stdout 上混进非 JSON 的行，改道 stderr
//   cli/print.ts getStructuredIO   把字符串形式的提示统一成消息流（normalizeInput）
//
// coda 的线上协议（形状和 Claude Code 的 stream-json 一样，字段少得多）：
//   宿主 → coda   {type:"user", text}                                  提问
//                 {type:"permission_response", id, allow, message?}    回答 coda 提的问题
//                 {type:"cancel"}                                      取消当前运行（对应 control_request: interrupt）
//   coda → 宿主   {type:"started" | "assistant" | "tool_result" | "terminal" ...}   事件
//                 {type:"permission_request", id, call}                提问：这个调用可以执行吗？
//                 {type:"control_cancel_request", id}                  刚才那个问题不用回答了
//
// 相对 Claude Code 的简化：
//   - 需要回答的请求只有权限确认一种。Claude Code 还有 hook_callback、mcp_message、elicitation，走的是同一套机制。
//   - 回答只有“允许 / 拒绝（可带理由）”。Claude Code 的允许还能带 updatedInput（改写参数）和 updatedPermissions。
//     coda 的权限闸门（第 6 章）只返回真假，没有地方放它们。
//   - 没有“PermissionRequest 钩子和宿主赛跑”：谁先回答听谁的，那一段在 createCanUseTool 里。

import { StringDecoder } from "node:string_decoder";

// 已经回答（或撤销）的 id 记多少个。对应 StructuredIO 的 MAX_RESOLVED_TOOL_USE_IDS：长会话里不能无限增长。
const MAX_SETTLED = 1000;

export class ControlIO {
  // write：把一帧写给宿主的函数（cli.mjs 里是往 stdout 写一行 JSON）
  constructor(write) {
    this.write = write;
    this.pending = new Map(); // id → 正在等回答的请求；对应 StructuredIO.pendingRequests
    this.settled = new Map(); // 已经回答或撤销的 id → "answered" / "cancelled"，用来认出重复、迟到的回答
    this.ignored = []; // 被忽略的回答和原因（unknown / duplicate / late），实验里拿来观察
    this.counter = 0;
    this.closed = false; // 输入关闭以后为 true；对应 StructuredIO.inputClosed
  }

  // 问宿主：这个调用可以执行吗？
  //   允许            → resolve(true)
  //   拒绝，没写理由   → resolve(false)；Toolset 会给模型一句 "permission denied"
  //   拒绝，写了理由   → reject(Error(理由))。权限闸门只返回真假，没有地方放理由；
  //                     但 Toolset 会把抛出的错误原文变成 tool_result，所以理由就这样交到了模型手里。
  //                     Claude Code 里是 PermissionDecision.message 直接成为 tool_result 的内容。
  //   输入已关闭、等待时被取消、等待时输入关闭 → reject
  ask(call, signal) {
    // 对应 sendRequest 开头的两个检查：管道已经关了，或者已经取消了，就不要再去问
    if (this.closed) return Promise.reject(Error("input closed: no one can answer"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? Error("cancelled"));

    return new Promise((resolve, reject) => {
      const id = `permission-${++this.counter}`; // 请求自己的 id，和模型的工具调用 id（call.id）是两回事

      // 等待期间被取消：撤销这个请求，并告诉宿主不用回答了（对应 sendRequest 里的 aborted()）。
      // 宿主那边可能正弹着一个确认框，不撤销的话它会一直挂着。
      const onAbort = () => {
        this.settle(id, "cancelled");
        this.write({ type: "control_cancel_request", id });
        reject(signal.reason ?? Error("cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        // 每条结束路径都要摘掉取消监听，否则监听器会随着请求越积越多
        detach: () => signal?.removeEventListener("abort", onAbort),
        answer(frame) {
          const allowed = frame.allow === true || frame.behavior === "allow";
          if (allowed) resolve(true);
          else if (frame.message) reject(Error(frame.message));
          else resolve(false);
        },
        reject,
      });
      this.write({ type: "permission_request", id, call });
    });
  }

  // 宿主的回答到了。返回 true 表示这个回答被收下了。
  // 对应 processLine 里处理 control_response 的那一段：
  //   id 对得上 → 取出等待者、只完成一次；
  //   id 不认识 → 忽略（不报错，也不能让任何等待者被误解开）；
  //   id 回答过了 → 同样忽略（WebSocket 重连一类的场景会重复投递）；
  //   id 已经被撤销 → 忽略（宿主还没收到撤销通知，回答就发出来了）。
  reply(frame) {
    const waiter = this.pending.get(frame.id);
    if (!waiter) {
      const before = this.settled.get(frame.id);
      this.ignored.push({ id: frame.id, why: before === "answered" ? "duplicate" : before === "cancelled" ? "late" : "unknown" });
      return false;
    }
    this.settle(frame.id, "answered");
    waiter.detach();
    waiter.answer(frame);
    return true;
  }

  // 输入结束（EOF）：再也不会有回答了，所有等待中的请求一起拒绝，否则运行会永远挂在那里。
  // 对应 StructuredIO.read() 在输入读完之后做的事。
  // 这不是“中断”：正在运行的任务继续往下跑，只是这些问题得不到回答——模型会看到一条错误结果。
  close() {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      waiter.detach();
      waiter.reject(Error("input closed before permission answer"));
    }
    this.pending.clear();
  }

  // 一个 id 结束了（回答、撤销都算）：从等待表里拿掉，记进已结束的集合；集合有上限，满了丢最老的
  settle(id, how) {
    this.pending.delete(id);
    this.settled.set(id, how);
    if (this.settled.size > MAX_SETTLED) this.settled.delete(this.settled.keys().next().value);
  }
}

// 字符串形式的提示 → 消息流。对应 getStructuredIO 开头：
// 非空字符串变成一条 user 消息，空白字符串变成空流（后面不用再区分提示最初是什么形状），已经是消息流的原样放行。
export function normalizeInput(input) {
  return typeof input === "string"
    ? input.trim()
      ? [{ type: "user", text: input }]
      : []
    : input;
}

// ── 一行一条 JSON ───────────────────────────────────────────

const LINE_SEPARATORS = /\u2028|\u2029/g;

// 写出一帧：JSON 加一个换行。对应 ndjsonSafeStringify。
// JSON.stringify 会把 U+2028、U+2029 原样写出来（合法的 JSON），但按 JavaScript 的行结束符规则切行的接收方
// 会在这里把一条消息切成两半。转义成 \u2028、\u2029 的写法是等价的 JSON，任何接收方都不会把它当成换行。
export function encodeFrame(frame) {
  const json = JSON.stringify(frame);
  return json.replace(LINE_SEPARATORS, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029")) + "\n";
}

// 一行文字 → 一帧；空行返回 undefined（管道里偶尔有多余的换行）。
// 解析失败不抛错，而是产生一个 protocol_error 帧，由调用者决定怎么办：
// Claude Code 在 stdin 上遇到坏行会直接退出（exit 1），Pi 的 RPC 模式回一个错误响应继续运行。
export function parseLine(line) {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line);
  } catch (error) {
    return { type: "protocol_error", error: `cannot parse input line: ${error.message}`, line };
  }
}

// 读 stdin：数据块可以在任何位置断开，所以先攒着，只按 "\n" 切成行（不用 readline，它的“行”不止 \n）。
// 对应 StructuredIO.read()：最后一行没有换行也要处理；多字节字符可能被拆在两个数据块里，交给 StringDecoder。
export async function* readFrames(input) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const frame = parseLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (frame) yield frame;
    }
  }
  const tail = parseLine(buffer + decoder.end());
  if (tail) yield tail;
}

// stdout 只放协议。任何一行不是 JSON 的输出（依赖库的 console.log、调试打印）都会毁掉宿主的逐行解析，
// 而且宿主没有办法恢复。守卫把 stream.write 换成一个按行检查的版本：JSON 行放行，其他行改走 stderr。
// 对应 installStreamJsonStdoutGuard。返回一个还原函数。
export function guardStdout(stream = process.stdout, errors = process.stderr) {
  const original = stream.write.bind(stream);
  let buffer = "";
  const isJson = (line) => {
    if (!line) return true; // 空行无害
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  };
  stream.write = (chunk, ...rest) => {
    buffer += String(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (isJson(line)) original(line + "\n");
      else errors.write(`[stdout-guard] ${line}\n`);
    }
    rest.find((arg) => typeof arg === "function")?.();
    return true; // 无论放行还是改道，调用者的意图都算达成
  };
  return () => {
    if (buffer) errors.write(`[stdout-guard] ${buffer}\n`); // 没有换行结尾的残片也别悄悄丢掉
    stream.write = original;
  };
}
