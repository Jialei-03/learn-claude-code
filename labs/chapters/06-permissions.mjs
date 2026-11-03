import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { permissionGate, ruleStage } from "../../coda/src/permissions.mjs";
await lesson(6, "局部结论与最终权限", async (t) => {
  const call = { id: "a", name: "Edit", input: { path: "safe.txt" } },
    tool = {};
  let asked = 0;
  t.equal(
    "local allow is not final allow",
    ruleStage("Edit", {}, { behavior: "allow" }),
    null,
  );
  const deny = permissionGate({
    root: t.root,
    rules: { allow: ["Edit"], deny: ["Edit"] },
  });
  t.equal("explicit deny wins over allow", await deny(call, tool), false);
  const ask = permissionGate({
    root: t.root,
    mode: "acceptEdits",
    rules: { ask: ["Edit"] },
    ask: async () => {
      asked++;
      return false;
    },
  });
  t.equal(
    "explicit ask survives acceptEdits mode",
    await ask(call, tool),
    false,
  );
  t.equal("ask is actually invoked", asked, 1);
  t.equal(
    "noninteractive policy rejects unknown effect",
    await permissionGate({ root: t.root, mode: "dontAsk" })(call, tool),
    false,
  );
  const controller = new AbortController(),
    waiting = permissionGate({
      root: t.root,
      ask: () => new Promise(() => {}),
    })(call, tool, controller.signal);
  controller.abort(Error("cancel wait"));
  await t.rejects(
    "permission wait observes cancellation",
    waiting,
    /cancel wait/,
  );
  await t.rejects(
    "workspace boundary is checked before execution",
    permissionGate({ root: t.root })(
      { ...call, input: { path: "../outside" } },
      tool,
    ),
    /outside/,
  );
  t.observations.rules = [
    "deny > ask > final mode",
    "null means no objection at one stage",
  ];
});
