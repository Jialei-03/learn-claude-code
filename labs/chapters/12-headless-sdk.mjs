import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { ControlIO, normalizeInput } from "../../coda/src/io.mjs";
import { runProcess } from "../../runtime/process.mjs";
await lesson(12, "真实子进程协议与确认生命周期", async (t) => {
  const frames = [],
    io = new ControlIO((frame) => frames.push(frame));
  const answer = io.ask({ id: "tool", name: "Write" });
  t.equal(
    "unknown response cannot unblock request",
    io.reply({ id: "wrong", allow: true }),
    false,
  );
  io.reply({ id: frames[0].id, allow: true });
  t.equal("matching response resolves permission", await answer, true);
  const pending = io.ask({ id: "second" });
  io.close();
  await t.rejects(
    "EOF rejects unresolved confirmation",
    pending,
    /input closed/,
  );
  t.equal("blank strings become empty streams", normalizeInput("  "), []);
  const child = await runProcess(
    process.execPath,
    [join(ROOT, "coda/src/cli.mjs"), t.root],
    {
      cwd: t.root,
      input:
        JSON.stringify({
          type: "user",
          text: "hello",
          replies: [{ text: "hello from child" }],
        }) + "\n",
      maxBytes: 100000,
    },
  );
  t.equal("real CLI exits cleanly", child.code, 0);
  const output = child.stdout.trim().split("\n").map(JSON.parse);
  t.equal("child emits completed terminal", output.at(-1).status, "completed");
  t.ok(
    "session transcript is written",
    existsSync(join(t.root, ".coda/session.jsonl")),
  );
  t.observations.protocol = output.map((f) => ({
    type: f.type,
    status: f.status,
  }));
});
