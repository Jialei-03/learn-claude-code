import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { Session, projectHistory } from "../../coda/src/session.mjs";
import { Compactor, threshold } from "../../coda/src/compact.mjs";
await lesson(5, "会话分支、断尾恢复与压缩", async (t) => {
  const file = join(t.root, "session.jsonl"),
    session = new Session(file);
  const anchor = session.append({ role: "user", text: "goal" });
  session.append({ role: "assistant", text: "branch A" });
  session.branch(anchor);
  session.append({ role: "assistant", text: "branch B" });
  t.equal(
    "branch traversal excludes sibling conversation",
    session.history().map((m) => m.text),
    ["goal", "branch B"],
  );
  appendFileSync(file, '{"unfinished":');
  const restored = new Session(file);
  restored.append({ role: "user", text: "continued" });
  t.equal(
    "torn final fragment is repaired before next append",
    new Session(file).history().at(-1).text,
    "continued",
  );
  const history = [
    { role: "assistant", calls: [{ id: "x", name: "Read", input: {} }] },
    { role: "tool", id: "orphan", text: "stray" },
  ];
  const view = projectHistory(history);
  t.equal("missing result is repaired in request view", view[1].id, "x");
  t.equal("canonical history remains unchanged", history[1].id, "orphan");
  t.equal(
    "100 percent cannot erase reserve",
    threshold(100000, 13000, "100"),
    87000,
  );
  let calls = 0;
  const compact = new Compactor({
    summarize: async () => {
      calls++;
      throw Error("summary offline");
    },
  });
  const long = [
    { role: "user", text: "old" },
    { role: "assistant", text: "done" },
    { role: "user", text: "next" },
  ];
  await compact.compact(long, { force: true });
  await compact.compact(long, { force: true });
  const third = await compact.compact(long, { force: true });
  t.equal("breaker stops repeated failed summarization", calls, 2);
  t.equal("breaker reason", third.reason, "circuit-open");
  const good = await new Compactor({
    summarize: async () => "goal and progress",
  }).compact(long, { force: true });
  t.equal(
    "retained user boundary follows summary",
    good.messages.at(-1).text,
    "next",
  );
  t.observations.projected = view;
  t.observations.compacted = good.messages;
});
