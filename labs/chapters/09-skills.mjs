import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { Skills, parseSkill } from "../../coda/src/skills.mjs";
await lesson(9, "Skill 发现与展开的两份材料", async (t) => {
  const text =
    "---\nname: review\ndescription: Review slug code\nallowed-tools: Read, Test\ncontext: fork\n---\nRead code and give counterexamples.";
  writeFileSync(join(t.root, "SKILL.md"), text);
  const skills = new Skills(t.root, ["SKILL.md"]);
  t.equal("discovery exposes metadata only", skills.descriptions(), [
    { name: "review", description: "Review slug code" },
  ]);
  t.equal(
    "explicit invocation loads body",
    skills.load("/review").body,
    "Read code and give counterexamples.",
  );
  t.equal(
    "parsed allowed tools are separate fields",
    skills.load("review").allowedTools,
    ["Read", "Test"],
  );
  t.throws(
    "unknown skill has a precise failure",
    () => skills.load("missing"),
    /unknown/,
  );
  t.throws(
    "duplicate fields rejected",
    () => parseSkill(text.replace("description:", "name:")),
    /duplicate/,
  );
  t.observations.metadata = skills.descriptions();
  t.observations.loaded = skills.load("review");
});
