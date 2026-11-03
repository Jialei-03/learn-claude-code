// Chapter 1: one durable user task may require many model/tool iterations.
export class Engine {
  constructor({
    model,
    tools,
    request = (messages) => ({ messages }),
    onEvent = () => {},
    onCleanup = async () => {},
    onCompleted = () => {},
  }) {
    Object.assign(this, {
      model,
      tools,
      request,
      onEvent,
      onCleanup,
      onCompleted,
    });
    this.steering = [];
    this.followups = [];
    this.running = false;
  }
  steer(text) {
    this.steering.push({ role: "user", text });
  }
  follow(text) {
    this.followups.push({ role: "user", text });
  }
  async *run(text, { history = [], context = {}, signal, maxTurns = 8 } = {}) {
    if (this.running) throw Error("engine busy");
    this.running = true;
    const messages = [...structuredClone(history), { role: "user", text }];
    let cleaned = false;
    const cleanup = async () => {
      if (!cleaned) {
        cleaned = true;
        await this.onCleanup();
      }
    };
    const emit = (frame) => {
      this.onEvent(structuredClone(frame));
      return frame;
    };
    try {
      yield emit({ type: "started" });
      for (let iteration = 1; iteration <= maxTurns; iteration++) {
        signal?.throwIfAborted();
        const wire = await this.request(structuredClone(messages));
        yield emit({ type: "request", iteration, wire });
        const reply = await this.model(wire, signal);
        signal?.throwIfAborted();
        if (reply.stop === "error")
          throw Error(reply.text || "provider failed");
        const assistant = {
          role: "assistant",
          text: reply.text ?? "",
          calls: reply.calls ?? [],
        };
        messages.push(assistant);
        yield emit({ type: "assistant", message: assistant });
        if (reply.stop === "length") {
          // Never execute a possibly truncated plan, including earlier calls.
          for (const call of assistant.calls)
            messages.push({
              role: "tool",
              id: call.id,
              error: true,
              text: "Response truncated; resend the complete call.",
            });
          continue;
        }
        if (assistant.calls.length) {
          const results = await this.tools.runCalls(assistant.calls, {
            ...context,
            signal,
            emit,
          });
          messages.push(...results);
          for (const message of results)
            yield emit({ type: "tool_result", message });
        }
        signal?.throwIfAborted();
        messages.push(...this.steering.splice(0));
        if (assistant.calls.length || messages.at(-1)?.role === "user")
          continue;
        if (this.followups.length) {
          messages.push(...this.followups.splice(0));
          continue;
        }
        await cleanup();
        this.onCompleted();
        const terminal = {
          type: "terminal",
          status: "completed",
          iterations: iteration,
          messages,
        };
        yield emit(terminal);
        return terminal;
      }
      await cleanup();
      const terminal = { type: "terminal", status: "budget", messages };
      yield emit(terminal);
      return terminal;
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        error = new AggregateError(
          [error, cleanupError],
          "execution and cleanup failed",
        );
      }
      const terminal = {
        type: "terminal",
        status: signal?.aborted ? "cancelled" : "failed",
        error: String(error.message ?? error),
        messages,
      };
      yield emit(terminal);
      return terminal;
    } finally {
      this.running = false;
      await cleanup();
    }
  }
}
export function scripted(replies) {
  const remaining = [...replies];
  return async () => {
    if (!remaining.length) throw Error("script exhausted");
    return structuredClone(remaining.shift());
  };
}
export async function collect(engine, text, options) {
  const frames = [];
  for await (const frame of engine.run(text, options)) frames.push(frame);
  return frames;
}
