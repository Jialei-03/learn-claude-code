import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { codingTools } from "../../coda/src/files.mjs";
import { Toolset, partition } from "../../coda/src/tools.mjs";
import { upstream } from "../engineering/run.mjs";
await lesson(3, "并发屏障与编辑契约", async (t) => {
  writeFileSync(join(t.root, "a.txt"), "old");
  const definitions = codingTools(t.root),
    map = new Map(definitions.map((d) => [d.name, d]));
  const calls = ["Read", "Read", "Edit", "Read"].map((name, i) => ({
    id: String(i),
    name,
    input:
      name === "Edit"
        ? { path: "a.txt", old: "old", next: "new" }
        : { path: "a.txt" },
  }));
  const catalogue = Object.fromEntries(
    definitions.map((d) => [
      d.name,
      {
        inputSchema: { safeParse: (input) => ({ success: true, data: input }) },
        isConcurrencySafe: () => !!d.parallel,
      },
    ]),
  );
  const sourcePartition = upstream("tool-partition", "partitionToolCalls", {
    findToolByName: (_, name) => catalogue[name],
  });
  const groups = partition(calls, (name) => map.get(name)).map((b) =>
    b.calls.map((c) => c.name),
  );
  t.equal(
    "source and implementation use adjacent batches",
    groups,
    JSON.parse(
      JSON.stringify(sourcePartition(calls, { options: { tools: [] } })),
    ).map((b) => b.blocks.map((c) => c.name)),
  );
  const tools = new Toolset(definitions),
    edit = calls[2];
  t.ok("edit before read is rejected", (await tools.execute(edit)).error);
  await tools.execute(calls[0]);
  t.equal("read then edit succeeds", (await tools.execute(edit)).error, false);
  t.equal(
    "file changed exactly once",
    readFileSync(join(t.root, "a.txt"), "utf8"),
    "new",
  );
  await tools.execute(calls[0]);
  writeFileSync(join(t.root, "a.txt"), "external");
  t.ok(
    "external update invalidates cached observation",
    (
      await tools.execute({
        ...edit,
        input: { path: "a.txt", old: "external", next: "lost" },
      })
    ).error,
  );
  t.equal(
    "failed edit preserves external bytes",
    readFileSync(join(t.root, "a.txt"), "utf8"),
    "external",
  );
  t.observations.batches = groups;
});
