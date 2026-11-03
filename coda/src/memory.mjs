import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { workspacePath } from "../../runtime/files.mjs";

export function loadMemories(
  root,
  entry = "CLAUDE.md",
  { maxDepth = 8, type = "Project", skipIndex = false } = {},
) {
  const visited = new Set(),
    found = [];
  const visit = (input, depth, parent) => {
    if (depth >= maxDepth) return;
    const file = workspacePath(root, input);
    if (visited.has(file)) return;
    visited.add(file);
    const text = readFileSync(file, "utf8");
    found.push({
      path: relative(root, file),
      parent,
      type,
      text: text.replace(/^@include .+$/gm, "").trim(),
    });
    for (const match of text.matchAll(/^@include (.+)$/gm)) {
      const child = new URL(match[1], "file://" + file).pathname;
      visit(child, depth + 1, relative(root, file));
    }
  };
  visit(entry, 0, undefined);
  return found.filter(
    (f) => f.text && !(skipIndex && ["AutoMem", "TeamMem"].includes(f.type)),
  );
}
export function memoryPrompt(files) {
  return files.map(
    (f) => `Instructions from ${f.path} (${f.type}):\n${f.text}`,
  );
}
