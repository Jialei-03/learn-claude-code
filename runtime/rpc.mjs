// 第 8 章：stdio 上的 JSON-RPC 对端（客户端一侧）。
//
// Claude Code 的 services/mcp/client.ts 自己不写 JSON-RPC：它把这一层交给官方的 MCP SDK，
// 自己只负责“选传输、定超时、包装工具、转换结果”。这个文件就是那一层的最小版本，对应 SDK 里三处：
//
//   StdioClientTransport   启动子进程，按行分帧，stderr 单独接管
//   Protocol.request       按 id 配对请求和响应；超时、取消时给服务器发 notifications/cancelled；进度令牌
//   Client.connect         initialize 握手，再发 notifications/initialized
//
// 外加 client.ts 的 cleanup()：退出时先 SIGINT，不行再 SIGTERM，最后 SIGKILL。
//
// 和原版相比的简化：
//   · 只有 stdio，没有 HTTP / SSE / WebSocket，也就没有 OAuth 和断线重连；
//   · 子进程只拿到 PATH 和配置里写明的环境变量。原版把整个环境都传了下去；
//   · 关闭时只给直接子进程发信号。真正干活的如果是孙进程（npx 启动的服务器就是这样），它们不会收到。
//   · 超时用的是一个固定的毫秒数；SDK 还支持“收到进度就重新计时”，原版调用工具时没有打开这个选项。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// 客户端愿意说的协议版本，从新到旧。握手时用第一个，服务器回复一个不在表里的就拒绝（SDK 同样检查）。
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const MAX_FRAME_CHARS = 1_000_000; // 单行超过这个长度当作垃圾丢掉
const STDERR_TAIL_CHARS = 4096; //    只留 stderr 的最后一段：连接失败时，原因通常就在这里

// 客户端要不要支持别人发来的某个请求？支持就回结果，不支持必须回“方法不存在”，
// 否则对方会一直等一个永远不会来的回复。
const METHOD_NOT_FOUND = -32601;

// 最多等 ms 毫秒：promise 先完成就返回 true，先到时间就返回 false。计时器用完即清，不会拖住进程退出。
async function settlesWithin(promise, ms) {
  if (ms === undefined) return promise.then(() => true);
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, false);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class StdioRpc {
  // options.timeout   单个请求默认等多久（毫秒）。Infinity 表示不设超时。
  // options.env       传给服务器的环境变量（在 PATH 之上叠加）。
  // options.roots     服务器问“工作目录是什么”（roots/list）时的回答，缺省是 [cwd]。
  // options.onFrame   (方向, 帧) => void，每一条收发的 JSON-RPC 消息都会过一遍，实验用它画时序。
  constructor(command, args = [], { cwd, env = {}, timeout = 60_000, roots, onFrame } = {}) {
    this.next = 0; //               下一个请求的 id
    this.pending = new Map(); //    id → { method, resolve, reject, timer, onProgress, cleanup }
    this.timeout = timeout;
    this.closed = false; //         连接已经不可用（进程退出、被关闭、写入失败）
    this.failure = undefined; //    不可用的原因，之后的请求都用它来拒绝
    this.stderr = ""; //            stderr 的最后一段
    this.noise = []; //             stdout 上不是 JSON-RPC 的行（服务器把日志打到了协议通道）
    this.requestHandlers = new Map(); //      服务器发来的请求 → 我们怎么回答
    this.notificationHandlers = new Map(); // 服务器发来的通知 → 谁来处理
    this.onFrame = onFrame;
    this.serverInfo = undefined;
    this.capabilities = {};
    this.instructions = undefined;

    // 默认能回答的两个服务器请求：ping，以及“你的工作目录在哪”。其余一律回方法不存在。
    this.onRequest("ping", () => ({}));
    this.onRequest("roots/list", () => ({
      roots: (roots ?? [cwd ?? process.cwd()]).map((dir) => ({ uri: `file://${dir}` })),
    }));

    this.child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.receive(line));

    // exited：进程确实没了（正常退出，或者根本没能启动）。close() 等的就是它。
    this.exited = new Promise((resolve) => {
      this.child.once("exit", resolve);
      this.child.once("error", resolve);
    });
    this.child.on("error", (error) => this.fail(error)); // 例如命令不存在（ENOENT）
    // 用 close 而不是 exit：close 在 stdout 读完以后才触发，
    // 服务器“回复完马上退出”时，最后一条回复不会被误判成“进程已经死了”。
    this.child.on("close", (code, signal) =>
      this.fail(Error(`RPC peer exited (${signal ?? `code ${code}`})`)),
    );
    this.child.stdin.on("error", (error) => this.fail(error));
  }

  // ───────────────────────── 收 ─────────────────────────

  // 一行 stdout 到达。三种合法的消息：响应（有 id，没有 method）、通知（有 method，没有 id）、
  // 服务器发来的请求（两者都有）。解析不了的行只记下来，不断开连接。
  receive(line) {
    if (!line.trim()) return;
    let frame;
    try {
      if (line.length > MAX_FRAME_CHARS) throw Error("oversized RPC frame");
      frame = JSON.parse(line);
      if (frame === null || typeof frame !== "object") throw Error("not an object");
    } catch (error) {
      // 一行坏数据不该毁掉整个会话。最常见的原因：服务器把日志 console.log 到了 stdout。
      this.noise.push(line.slice(0, 200));
      this.noise = this.noise.slice(-20);
      return;
    }
    this.onFrame?.("←", frame);

    if (frame.method !== undefined && frame.id !== undefined) return void this.answer(frame);
    if (frame.method !== undefined) return this.notified(frame);
    this.settle(frame);
  }

  // 响应：按 id 找到等待者。找不到说明它已经超时或被取消了，迟到的响应直接丢弃。
  settle(frame) {
    const waiter = this.pending.get(frame.id);
    if (!waiter) return;
    this.pending.delete(frame.id);
    waiter.cleanup();
    if (frame.error) {
      // JSON-RPC 层面的失败（方法不存在、参数格式不对……），和工具自己报告的 isError 是两回事
      waiter.reject(Object.assign(Error(frame.error.message), { code: frame.error.code, data: frame.error.data }));
    } else waiter.resolve(frame.result);
  }

  // 通知。进度通知按令牌找到对应的请求；其余交给注册的处理函数。
  notified(frame) {
    if (frame.method === "notifications/progress") {
      const waiter = this.pending.get(frame.params?.progressToken);
      waiter?.onProgress?.(frame.params);
      return;
    }
    this.notificationHandlers.get(frame.method)?.(frame.params ?? {});
  }

  // 服务器发来的请求：连接是双向的。必须回复，哪怕只是“不支持”。
  async answer(frame) {
    const handler = this.requestHandlers.get(frame.method);
    try {
      if (!handler) throw Object.assign(Error(`Method not found: ${frame.method}`), { code: METHOD_NOT_FOUND });
      this.write({ jsonrpc: "2.0", id: frame.id, result: await handler(frame.params ?? {}) });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: error.code ?? -32603, message: error.message },
      });
    }
  }

  onRequest(method, handler) {
    this.requestHandlers.set(method, handler);
  }
  onNotification(method, handler) {
    this.notificationHandlers.set(method, handler);
  }

  // ───────────────────────── 发 ─────────────────────────

  write(frame) {
    if (this.closed) return;
    this.onFrame?.("→", frame);
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  // 连接不可用了：所有还在等的请求立刻失败，而不是各自等满超时。
  fail(error) {
    if (!this.closed) this.failure = error;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      waiter.cleanup();
      waiter.reject(this.failure);
    }
    this.pending.clear();
  }

  // 发一个请求，返回 result。
  //   timeout    这个请求等多久；缺省用构造时的 this.timeout
  //   signal     被取消（比如用户按了 Esc）就放弃等待，并通知服务器
  //   onProgress 给了它，请求里就带上 progressToken，服务器报告进度时回调
  request(method, params = {}, { timeout = this.timeout, signal, onProgress } = {}) {
    if (this.closed) return Promise.reject(this.failure ?? Error("RPC closed"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? Error("aborted"));

    const id = ++this.next;
    const body = onProgress
      ? { ...params, _meta: { ...params._meta, progressToken: id } }
      : params;

    return new Promise((resolve, reject) => {
      const waiter = { method, resolve, reject, onProgress };
      const timer = Number.isFinite(timeout)
        ? setTimeout(
            () => this.cancel(id, Error(`RPC timeout: ${method} 超过 ${timeout}ms 没有响应`), "timeout"),
            timeout,
          )
        : undefined;
      const onAbort = () => this.cancel(id, signal.reason ?? Error("aborted"), "aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      waiter.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      this.pending.set(id, waiter);
      this.write({ jsonrpc: "2.0", id, method, params: body });
    });
  }

  // 超时或被取消：本地立刻让请求失败，同时告诉服务器“别再算了”（否则它会在后台白白干活）。
  // 规范规定 initialize 不能取消。
  cancel(id, error, reason) {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    waiter.cleanup();
    if (waiter.method !== "initialize") {
      this.notify("notifications/cancelled", { requestId: id, reason });
    }
    waiter.reject(error);
  }

  notify(method, params = {}) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  // 握手：initialize → 检查服务器选的协议版本 → notifications/initialized。
  // 客户端声明的能力只有 roots（告诉服务器工作目录）；Claude Code 还声明了 elicitation（服务器可以反过来向用户要信息）。
  async initialize({ timeout } = {}) {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSIONS[0],
        capabilities: { roots: {} },
        clientInfo: { name: "coda", version: "1" },
      },
      { timeout },
    );
    if (!PROTOCOL_VERSIONS.includes(result?.protocolVersion)) {
      throw Error(`server protocol version not supported: ${result?.protocolVersion}`);
    }
    this.serverInfo = result.serverInfo;
    this.capabilities = result.capabilities ?? {};
    this.instructions = result.instructions;
    this.notify("notifications/initialized");
    return result;
  }

  // ───────────────────────── 关 ─────────────────────────

  // 退出时的信号升级。原版 cleanup() 的节奏：
  //   SIGINT（等价于 Ctrl+C，大多数服务器会借机收尾）→ 最多等 100ms
  //   SIGTERM                                              → 最多等 400ms
  //   SIGKILL                                              → 一定会死
  // 总共不超过半秒，免得退出 Claude Code 时卡住。
  // 返回进程是在哪一步结束的，以及用了多久，实验用它对比“礼貌的服务器”和“固执的服务器”。
  async close({ steps = [["SIGINT", 100], ["SIGTERM", 400], ["SIGKILL"]] } = {}) {
    const started = Date.now();
    const alive = () => this.child.exitCode === null && this.child.signalCode === null && this.child.pid;
    this.fail(Error("RPC closed")); // 先让所有等待者结束，之后的请求也都失败
    this.lines.close();

    let how = alive() ? undefined : "already-exited";
    for (const [signal, waitMs] of steps) {
      if (how) break;
      try {
        this.child.kill(signal);
      } catch {
        // 进程恰好在这一刻没了
      }
      if (await settlesWithin(this.exited, waitMs)) how = signal;
    }
    await this.exited;
    this.child.stdin.destroy(); // 管道不关，Node 进程会一直等着它而无法退出
    return { how: how ?? "exited", ms: Date.now() - started };
  }
}
