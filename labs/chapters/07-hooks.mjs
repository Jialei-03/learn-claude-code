import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { Hooks, commandHook } from "../../coda/src/hooks.mjs";
import { Toolset } from "../../coda/src/tools.mjs";
import { codingTools } from "../../coda/src/files.mjs";
await lesson(7, "真实 Hook 进程与输入重检", async (t) => {
  const policy = join(t.root, "policy.mjs");
  writeFileSync(
    policy,
    "process.stderr.write('blocked by policy');process.exit(2)",
  );
  const hook = commandHook(policy),
    block = await hook({ tool_name: "Edit" }, { root: t.root });
  t.equal("exit 2 becomes explicit policy block", block.block, true);
  const bad = join(t.root, "bad.mjs");
  writeFileSync(bad, "process.stdout.write('{broken')");
  await t.rejects(
    "malformed JSON is execution failure",
    commandHook(bad)({}, { root: t.root }),
    /JSON/,
  );
  const hang = join(t.root, "hang.mjs");
  writeFileSync(hang, "setInterval(()=>{},1000)");
  await t.rejects(
    "timeout kills hook process and rejects",
    commandHook(hang, { timeout: 100 })({}, { root: t.root }),
    /timeout/,
  );
  const tools = new Toolset(codingTools(t.root), {
    hooks: new Hooks([
      {
        event: "before",
        tool: "Write",
        run: async () => ({ input: { path: "../outside", text: "bad" } }),
      },
    ]),
  });
  const result = await tools.execute(
    { id: "w", name: "Write", input: { path: "safe", text: "ok" } },
    { root: t.root },
  );
  t.ok("rewritten path is revalidated", result.error);
  t.equal(
    "blocked rewrite has no filesystem effect",
    existsSync(join(t.temp, "outside")),
    false,
  );
  const order = [];
  const chain = new Hooks([
    {
      event: "after",
      run: async (_, ctx) => {
        order.push("first");
        return { text: "first" };
      },
    },
    {
      event: "after",
      run: async (input) => {
        order.push(input.tool_response.text);
        return { text: "second" };
      },
    },
  ]);
  t.equal(
    "after hooks see the prior patch",
    (await chain.after({ name: "x", id: "x" }, { text: "original" }, {})).text,
    "second",
  );
  t.equal("ordered patch consumption", order, ["first", "first"]);
  t.observations.block = block;
});
