import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { verifySourcemap } from "../../lab/sourcemap.ts";
import { upstream } from "../engineering/run.mjs";
await lesson(0, "证据与可达性", async (t) => {
  const refs = verifySourcemap();
  t.ok(
    "all cited source files match sourcesContent",
    Object.values(refs).every((r) => r.sourceMapMatch),
  );
  t.equal("versioned reference count", Object.keys(refs).length, 30);
  const query = upstream("sdk-stub", "query");
  t.throws(
    "a type entrypoint is not an executable SDK",
    () => query(),
    /not implemented/,
  );
  t.observations.source = {
    references: Object.keys(refs).length,
    commit: refs.query.url.split("/blob/")[1].split("/")[0],
    stub: "throws before any model execution",
  };
});
