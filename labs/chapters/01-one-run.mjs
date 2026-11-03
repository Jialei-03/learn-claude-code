import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { Engine, scripted, collect } from "../../coda/src/engine.mjs";
import { Toolset } from "../../coda/src/tools.mjs";
await lesson(1, "循环、截断与退出", async (t) => {
  const file = join(t.root, "result.txt");
  let completed = 0,
    cleaned = 0;
  const tools = new Toolset([
    {
      name: "Write",
      validate() {},
      execute: (input) => {
        writeFileSync(file, input.text);
        return { text: "written" };
      },
    },
  ]);
  const truncated = {
    calls: [{ id: "half", name: "Write", input: { text: "HALF" } }],
    stop: "length",
  };
  // The deliberately broken baseline ignores the stop reason.
  writeFileSync(file, truncated.calls[0].input.text);
  const naive = readFileSync(file, "utf8");
  const engine = new Engine({
    tools,
    model: scripted([
      truncated,
      { calls: [{ id: "full", name: "Write", input: { text: "COMPLETE" } }] },
      { text: "done" },
    ]),
    onCompleted: () => completed++,
    onCleanup: async () => cleaned++,
  });
  const frames = await collect(engine, "write");
  t.equal("naive baseline writes an incomplete plan", naive, "HALF");
  t.equal(
    "repaired loop only executes complete response",
    readFileSync(file, "utf8"),
    "COMPLETE",
  );
  t.equal("normal terminal", frames.at(-1).status, "completed");
  t.equal("business completion exactly once", completed, 1);
  const iterator = engine.run("closed early");
  await iterator.next();
  await iterator.return();
  t.equal("early generator return cleans resources", cleaned, 2);
  t.equal("early return does not mark business completion", completed, 1);
  const broken = new Engine({
    tools,
    model: async () => {
      throw Error("provider failed");
    },
  });
  t.equal(
    "provider error has failed terminal",
    (await collect(broken, "fail")).at(-1).status,
    "failed",
  );
  t.observations.trace = frames.map((f) => ({
    type: f.type,
    iteration: f.iteration,
    status: f.status,
  }));
});
