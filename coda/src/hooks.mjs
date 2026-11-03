import { runProcess } from "../../runtime/process.mjs";

export class Hooks {
  constructor(entries = []) {
    this.entries = entries;
  }
  async before(call, context) {
    let input = structuredClone(call.input);
    for (const hook of this.entries.filter(
      (h) => h.event === "before" && (!h.tool || h.tool === call.name),
    )) {
      const patch = await hook.run(
        { tool_name: call.name, tool_use_id: call.id, tool_input: input },
        context,
      );
      if (patch?.block)
        return { block: true, reason: patch.reason ?? "hook denied" };
      if (patch?.input !== undefined) input = structuredClone(patch.input);
    }
    return { input };
  }
  async after(call, result, context) {
    let current = { ...result };
    for (const hook of this.entries.filter(
      (h) => h.event === "after" && (!h.tool || h.tool === call.name),
    )) {
      const patch = await hook.run(
        { tool_name: call.name, tool_use_id: call.id, tool_response: current },
        context,
      );
      if (patch) current = { ...current, ...patch };
    }
    return current;
  }
}
export function commandHook(file, { timeout = 1000 } = {}) {
  return async (input, { root, signal } = {}) => {
    const output = await runProcess(process.execPath, [file], {
      cwd: root,
      signal,
      timeout,
      input: JSON.stringify(input),
    });
    if (output.reason !== "exit") throw Error(`hook ${output.reason}`);
    if (output.code === 2)
      return { block: true, reason: output.stderr.trim() || "policy blocked" };
    if (output.code !== 0)
      throw Error(`hook execution failed (${output.code})`);
    return output.stdout.trim() ? JSON.parse(output.stdout) : {};
  };
}
