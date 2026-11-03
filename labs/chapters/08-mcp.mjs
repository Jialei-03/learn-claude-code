import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { connectMcp } from "../../coda/src/mcp.mjs";
await lesson(8, "真实 stdio MCP 发现、调用和收尾", async (t) => {
  const connection = await connectMcp(process.execPath, [
    join(ROOT, "labs/fixtures/mcp-server.mjs"),
  ]);
  try {
    t.equal(
      "initialize and tools/list expose fixture tool",
      connection.tools[0].name,
      "mcp__echo",
    );
    const [a, b] = await Promise.all(
      ["A", "B"].map((text) => connection.tools[0].execute({ text })),
    );
    t.equal(
      "interleaved RPC ids preserve request ownership",
      [a.text, b.text],
      ["A", "B"],
    );
    await t.rejects(
      "remote error preserves protocol failure",
      connection.peer.request("unknown"),
      /unknown method/,
    );
    connection.peer.timeout = 60;
    await t.rejects(
      "unanswered request is bounded",
      connection.peer.request("hang"),
      /timeout/,
    );
    t.equal("timed out waiter removed", connection.peer.pending.size, 0);
    t.observations.results = [a, b];
  } finally {
    await connection.close();
  }
  t.ok(
    "server process has exited",
    connection.peer.child.exitCode !== null ||
      connection.peer.child.signalCode !== null,
  );
});
