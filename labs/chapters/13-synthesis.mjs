import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createCoda } from "../../coda/src/app.mjs";
import { scripted } from "../../coda/src/engine.mjs";
import { connectMcp } from "../../coda/src/mcp.mjs";
import { Hooks } from "../../coda/src/hooks.mjs";
import { Session } from "../../coda/src/session.mjs";
await lesson(13, "完整项目修复与会话恢复", async (t) => {
  writeFileSync(
    join(t.root, "slug.cjs"),
    "module.exports=s=>s.trim().replace(/ /g,'-');\n",
  );
  writeFileSync(
    join(t.root, "test.cjs"),
    "const assert=require('node:assert/strict');assert.equal(require('./slug.cjs')(' a  b '),'a-b');console.log('tests passed');\n",
  );
  writeFileSync(join(t.root, "CLAUDE.md"), "Fix minimally and run test.cjs.");
  writeFileSync(
    join(t.root, "SKILL.md"),
    "---\nname: verify\ndescription: Verify repairs\nallowed-tools: Read, Test\n---\nRun the regression before claiming success.",
  );
  const mcp = await connectMcp(process.execPath, [
    join(ROOT, "labs/fixtures/mcp-server.mjs"),
  ]);
  const call = (name, input, id) => ({ calls: [{ name, input, id }] });
  let tests = 0;
  const replies = [
    call("Skill", { name: "verify" }, "s"),
    call("Agent", { task: "locate slug" }, "a"),
    call("Read", { path: "slug.cjs" }, "r"),
    call("Edit", { path: "slug.cjs", old: "/ /g", next: "/ +/g" }, "e"),
    call("Test", { path: "test.cjs" }, "t"),
    call("mcp__echo", { text: "verified" }, "m"),
    { text: "Repair verified." },
  ];
  const app = createCoda({
    root: t.root,
    model: scripted(replies),
    skillPaths: ["SKILL.md"],
    childModel: () =>
      scripted([
        call("Read", { path: "slug.cjs" }, "child-read"),
        { text: "slug.cjs contains implementation" },
      ]),
    rules: { allow: ["Test", "Agent", "mcp__echo"] },
    mode: "acceptEdits",
    extraTools: mcp.tools,
    sessionFile: join(t.root, "session.jsonl"),
    hooks: new Hooks([
      {
        event: "after",
        tool: "Test",
        run: async (input) => {
          if (!input.tool_response.error) tests++;
        },
      },
    ]),
  });
  try {
    const result = await app.run("Fix normalizeSlug", { maxTurns: 12 });
    t.equal(
      "all layers complete one repair",
      result.terminal.status,
      "completed",
    );
    t.equal("real node regression ran and passed", tests, 1);
    t.ok(
      "filesystem has complete fix",
      readFileSync(join(t.root, "slug.cjs"), "utf8").includes("/ +/g"),
    );
    const request = result.frames.find((f) => f.type === "request").wire;
    t.ok(
      "project instruction reaches model request",
      request.system.some((s) => s.includes("Fix minimally")),
    );
    t.equal(
      "MCP result reaches history",
      result.terminal.messages.find((m) => m.id === "m").text,
      "verified",
    );
    const saved = new Session(join(t.root, "session.jsonl"));
    t.equal(
      "reopened session preserves terminal answer",
      saved.history().at(-1).text,
      "Repair verified.",
    );
    t.equal(
      "every tool intent has a result",
      result.terminal.messages.filter((m) => m.role === "tool").length,
      6,
    );
    t.observations.journey = result.frames.map((f) => ({
      type: f.type,
      status: f.status,
      iteration: f.iteration,
      toolId: f.message?.id,
      message: f.message,
      request: f.wire && {
        system: f.wire.system,
        tools: f.wire.tools.map((tool) => tool.name),
        messageCount: f.wire.messages.length,
        prefixHash: f.wire.prefixHash,
      },
      messageCount: f.messages?.length,
    }));
    t.observations.repairedFile = readFileSync(join(t.root, "slug.cjs"), "utf8");
    t.observations.restoredHistory = saved.history();
  } finally {
    await mcp.close();
  }
});
