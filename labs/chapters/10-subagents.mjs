import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { runChild } from "../../coda/src/subagents.mjs";
import { codingTools } from "../../coda/src/files.mjs";
import { scripted } from "../../coda/src/engine.mjs";
await lesson(10, "独立消息与真实工具收缩", async (t) => {
  writeFileSync(join(t.root, "a.txt"), "content");
  const parent = [{ role: "user", text: "private parent context" }];
  const child = await runChild(
    {
      tools: codingTools(t.root),
      model: scripted([
        { calls: [{ id: "r", name: "Read", input: { path: "a.txt" } }] },
        {
          calls: [
            {
              id: "e",
              name: "Edit",
              input: { path: "a.txt", old: "content", next: "bad" },
            },
          ],
        },
        { text: "found" },
      ]),
      parentHistory: parent,
      context: { root: t.root },
    },
    "explore",
  );
  t.equal(
    "child can execute selected read",
    child.frames.filter((f) => f.type === "tool_result")[0].message.text,
    "content",
  );
  t.ok(
    "unavailable write cannot execute",
    child.frames.filter((f) => f.type === "tool_result")[1].message.error,
  );
  t.equal(
    "parent context does not leak by default",
    child.terminal.messages.some((m) => m.text === "private parent context"),
    false,
  );
  t.equal(
    "shared workspace bytes remain unchanged",
    readFileSync(join(t.root, "a.txt"), "utf8"),
    "content",
  );
  const controller = new AbortController();
  controller.abort(Error("cancelled parent"));
  const cancelled = await runChild(
    { tools: [], model: scripted([]), signal: controller.signal },
    "explore",
  );
  t.equal(
    "parent cancellation propagates",
    cancelled.terminal.status,
    "cancelled",
  );
  t.observations = {
    ...t.observations,
    childId: child.id,
    terminal: child.terminal.status,
  };
});
