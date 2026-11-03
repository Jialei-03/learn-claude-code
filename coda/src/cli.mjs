import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { createCoda } from "./app.mjs";
import { scripted } from "./engine.mjs";
import { ControlIO } from "./io.mjs";

const root = resolve(process.argv[2] ?? ".");
const output = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const controller = new AbortController(),
  io = new ControlIO(output);
const lines = createInterface({ input: process.stdin });
let job;
for await (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.type === "permission_response") {
    io.reply(frame);
    continue;
  }
  if (frame.type === "cancel") {
    controller.abort(Error("user cancelled"));
    continue;
  }
  if (frame.type !== "user" || job) {
    output({ type: "protocol_error", error: "one active input per process" });
    continue;
  }
  const model = scripted(frame.replies ?? [{ text: "ready", stop: "stop" }]);
  const app = createCoda({
    root,
    model,
    rules: frame.rules ?? {},
    sessionFile: join(root, ".coda/session.jsonl"),
    ask: (call) => io.ask(call, controller.signal),
    onEvent: output,
  });
  job = app
    .run(frame.text, { signal: controller.signal })
    .catch((error) => output({ type: "error", error: error.message }));
}
io.close();
await job;
