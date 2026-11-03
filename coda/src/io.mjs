export class ControlIO {
  constructor(write) {
    this.write = write;
    this.pending = new Map();
    this.counter = 0;
    this.closed = false;
  }
  ask(call, signal) {
    if (this.closed) return Promise.reject(Error("IO closed"));
    return new Promise((resolve, reject) => {
      const id = `permission-${++this.counter}`;
      const abort = () => {
        this.pending.delete(id);
        reject(signal.reason ?? Error("cancelled"));
      };
      const finish = (answer) => {
        signal?.removeEventListener("abort", abort);
        resolve(answer);
      };
      this.pending.set(id, { resolve: finish, reject, abort, signal });
      signal?.addEventListener("abort", abort, { once: true });
      this.write({ type: "permission_request", id, call });
      if (signal?.aborted) abort();
    });
  }
  reply(frame) {
    const waiter = this.pending.get(frame.id);
    if (!waiter) return false;
    this.pending.delete(frame.id);
    waiter.resolve(frame.allow === true);
    return true;
  }
  close() {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(Error("input closed before permission answer"));
    }
    this.pending.clear();
  }
}
export function normalizeInput(input) {
  return typeof input === "string"
    ? input.trim()
      ? [{ type: "user", text: input }]
      : []
    : input;
}
