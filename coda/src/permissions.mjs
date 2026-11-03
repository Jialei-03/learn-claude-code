import { workspacePath } from "../../runtime/files.mjs";

export function ruleStage(name, rules, local = {}) {
  if (rules.deny?.includes(name))
    return { behavior: "deny", source: "explicit-deny" };
  if (rules.ask?.includes(name))
    return { behavior: "ask", source: "explicit-ask" };
  if (local.behavior === "deny" || local.source === "safetyCheck") return local;
  return null; // No objection here. This is not final authorization.
}
export function permissionGate({
  mode = "default",
  rules = {},
  ask = async () => false,
  root,
} = {}) {
  return async (call, tool, signal) => {
    signal?.throwIfAborted();
    if (call.input.path && root) workspacePath(root, call.input.path);
    const stage = ruleStage(
      call.name,
      rules,
      tool.permission?.(call.input) ?? {},
    );
    if (stage?.behavior === "deny") return false;
    const needsAsk = stage?.behavior === "ask";
    if (
      !needsAsk &&
      (rules.allow?.includes(call.name) ||
        tool.readOnly ||
        (mode === "acceptEdits" && ["Edit", "Write"].includes(call.name)))
    )
      return true;
    if (mode === "plan" || mode === "dontAsk") return false;
    // Remove the abort listener on every exit; do not leak waiters across tools.
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason ?? Error("aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => ask(call))
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener("abort", abort));
      if (signal?.aborted) abort();
    });
  };
}
