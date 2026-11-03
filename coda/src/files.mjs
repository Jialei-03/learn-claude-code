import { readFileSync } from "node:fs";
import {
  workspacePath,
  atomicWrite,
  fileVersion,
} from "../../runtime/files.mjs";
import { runSandboxed } from "../../runtime/sandbox.mjs";
import { runProcess } from "../../runtime/process.mjs";

export function codingTools(root, { sandbox = false } = {}) {
  const reads = new Map();
  const shape = (properties) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
  });
  const pathInput = (input) => {
    if (typeof input.path !== "string") throw Error("path must be string");
    workspacePath(root, input.path);
  };
  const validateEdit = (input) => {
    pathInput(input);
    if (
      typeof input.old !== "string" ||
      !input.old ||
      typeof input.next !== "string"
    )
      throw Error("invalid edit strings");
    const file = workspacePath(root, input.path),
      before = reads.get(file),
      current = fileVersion(file);
    if (!before || before.partial) throw Error("read full file before edit");
    if (before.hash !== current.hash) throw Error("file changed since read");
    const matches = current.text.split(input.old).length - 1;
    if (matches !== 1)
      throw Error(matches ? "ambiguous edit" : "old text missing");
  };
  return [
    {
      name: "Read",
      description: "Read a workspace file",
      readOnly: true,
      parallel: true,
      schema: shape({ path: { type: "string" } }),
      validate: pathInput,
      execute: (input) => {
        const file = workspacePath(root, input.path),
          version = fileVersion(file);
        const partial =
          version.text.length > 50000 || input.limit !== undefined;
        const text =
          input.limit === undefined
            ? version.text.slice(0, 50000)
            : version.text.split("\n").slice(0, input.limit).join("\n");
        reads.set(file, { ...version, partial });
        return { text, details: { hash: version.hash, partial } };
      },
    },
    {
      name: "Edit",
      description: "Replace one unique string after full read",
      schema: shape({
        path: { type: "string" },
        old: { type: "string" },
        next: { type: "string" },
      }),
      validate: validateEdit,
      execute: (input) => {
        validateEdit(input);
        const file = workspacePath(root, input.path),
          before = readFileSync(file, "utf8");
        atomicWrite(file, before.replace(input.old, input.next));
        reads.delete(file);
        return {
          text: "edited",
          details: { before, after: readFileSync(file, "utf8") },
        };
      },
    },
    {
      name: "Write",
      description: "Write a workspace file",
      schema: shape({ path: { type: "string" }, text: { type: "string" } }),
      validate: (input) => {
        pathInput(input);
        if (typeof input.text !== "string") throw Error("text must be string");
      },
      execute: (input) => {
        atomicWrite(workspacePath(root, input.path), input.text);
        return { text: "written" };
      },
    },
    {
      name: "Test",
      description: "Run the fixture test using Node argv, without a shell",
      schema: shape({ path: { type: "string" } }),
      validate: pathInput,
      execute: async (input, { signal }) => {
        const result = sandbox
          ? await runSandboxed(
              root,
              process.execPath,
              [workspacePath(root, input.path)],
              { signal },
            )
          : await runProcess(
              process.execPath,
              [workspacePath(root, input.path)],
              { cwd: root, signal },
            );
        return {
          text: result.stdout + result.stderr,
          error: result.code !== 0,
          details: result,
        };
      },
    },
  ];
}
