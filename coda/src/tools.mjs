import { Hooks } from "./hooks.mjs";
export function partition(calls, lookup) {
  const batches = [];
  for (const call of calls) {
    let safe = false;
    try {
      const tool = lookup(call.name);
      tool?.validate?.(call.input);
      safe = !!tool?.parallel;
    } catch {}
    if (safe && batches.at(-1)?.safe) batches.at(-1).calls.push(call);
    else batches.push({ safe, calls: [call] });
  }
  return batches;
}
export class Toolset {
  constructor(tools, { gate = async () => true, hooks = new Hooks() } = {}) {
    this.tools = new Map();
    this.gate = gate;
    this.hooks = hooks;
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw Error("duplicate tool");
      this.tools.set(tool.name, tool);
    }
  }
  async execute(call, context = {}) {
    const tool = this.tools.get(call.name);
    try {
      if (!tool) throw Error("unknown tool");
      if (
        !call.id ||
        !call.input ||
        typeof call.input !== "object" ||
        Array.isArray(call.input)
      )
        throw Error("invalid call envelope");
      context.signal?.throwIfAborted();
      tool.validate?.(call.input);
      const before = await this.hooks.before(call, context);
      if (before.block) throw Error(before.reason);
      const checked = { ...call, input: structuredClone(before.input) };
      tool.validate?.(checked.input); // A hook rewrite gets no unchecked shortcut.
      if (!(await this.gate(checked, tool, context.signal)))
        throw Error("permission denied");
      context.signal?.throwIfAborted();
      context.emit?.({ type: "tool_start", id: call.id, name: call.name });
      const raw = await tool.execute(checked.input, context);
      const result = await this.hooks.after(checked, raw, context);
      context.emit?.({ type: "tool_end", id: call.id });
      return {
        role: "tool",
        id: call.id,
        text: result.text ?? "",
        error: !!result.error,
        details: result.details,
        applyContext: result.applyContext,
      };
    } catch (error) {
      return {
        role: "tool",
        id: call.id,
        error: true,
        text: String(error.message ?? error),
      };
    }
  }
  async runCalls(calls, context = {}) {
    const output = [];
    for (const batch of partition(calls, (name) => this.tools.get(name))) {
      const results = batch.safe
        ? await Promise.all(batch.calls.map((c) => this.execute(c, context)))
        : [await this.execute(batch.calls[0], context)];
      for (const result of results) {
        result.applyContext?.(context);
        const { applyContext, ...message } = result;
        output.push(message);
      }
    }
    return output;
  }
}
