import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { loadMemories, memoryPrompt } from "../../coda/src/memory.mjs";
await lesson(4, "递归指令与实际注入", async (t) => {
  writeFileSync(join(t.root, "CLAUDE.md"), "Use tests.\n@include child.md\n");
  writeFileSync(
    join(t.root, "child.md"),
    "Keep exports.\n@include CLAUDE.md\n",
  );
  const files = loadMemories(t.root);
  t.equal(
    "include cycle visits each physical file once",
    files.map((f) => f.path),
    ["CLAUDE.md", "child.md"],
  );
  t.equal("parent provenance is preserved", files[1].parent, "CLAUDE.md");
  t.equal(
    "depth cap is independent of cycle detection",
    loadMemories(t.root, "CLAUDE.md", { maxDepth: 1 }).length,
    1,
  );
  t.equal(
    "feature filter can remove found auto-memory",
    loadMemories(t.root, "CLAUDE.md", { type: "AutoMem", skipIndex: true }),
    [],
  );
  writeFileSync(join(t.temp, "outside.md"), "outside");
  symlinkSync(join(t.temp, "outside.md"), join(t.root, "link.md"));
  t.throws(
    "symlinked external instruction cannot escape workspace",
    () => loadMemories(t.root, "link.md"),
    /outside workspace/,
  );
  t.observations.injected = memoryPrompt(files);
});
