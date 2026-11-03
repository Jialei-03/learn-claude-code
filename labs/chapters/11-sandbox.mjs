import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { sandboxCommand, runSandboxed } from "../../runtime/sandbox.mjs";
await lesson(11, "配置与实际系统隔离", async (t) => {
  const spec = sandboxCommand(t.root, process.execPath, ["-e", "0"]);
  t.ok(
    "platform capability reported explicitly",
    spec === undefined || ["seatbelt", "bubblewrap"].includes(spec.backend),
  );
  if (spec) {
    const inside = await runSandboxed(t.root, process.execPath, [
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(join(t.root, "inside"))},'ok')`,
    ]);
    if (inside.code === 0) {
      t.equal(
        "allowed write really happens",
        readFileSync(join(t.root, "inside"), "utf8"),
        "ok",
      );
      const outside = await runSandboxed(t.root, process.execPath, [
        "-e",
        `require('fs').writeFileSync(${JSON.stringify(join(t.temp, "outside"))},'bad')`,
      ]);
      t.ok(
        "outside write is denied by actual child process",
        outside.code !== 0,
      );
      t.equal(
        "outside bytes do not exist",
        existsSync(join(t.temp, "outside")),
        false,
      );
      t.observations.osProbe = { status: "enforced", backend: spec.backend };
    } else {
      t.ok("unsupported execution is visible", inside.stderr.length > 0);
      t.equal(
        "failed preflight wrote nothing",
        existsSync(join(t.root, "inside")),
        false,
      );
      t.observations.osProbe = {
        status: "unavailable-in-environment",
        stderr: inside.stderr,
      };
    }
  } else {
    await t.rejects(
      "no implicit unsandboxed fallback",
      runSandboxed(t.root, process.execPath, ["-e", "0"]),
      /unavailable/,
    );
    t.equal(
      "no child effect on unsupported platform",
      existsSync(join(t.root, "inside")),
      false,
    );
    t.observations.osProbe = { status: "unsupported" };
  }
});
