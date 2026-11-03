import { Engine } from "./engine.mjs";
import { codingTools } from "./files.mjs";
import { Toolset } from "./tools.mjs";
import { permissionGate } from "./permissions.mjs";
import { buildRequest } from "./request.mjs";
import { Hooks } from "./hooks.mjs";
import { loadMemories, memoryPrompt } from "./memory.mjs";
import { Skills } from "./skills.mjs";
import { runChild } from "./subagents.mjs";
import { Session } from "./session.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function createCoda({
  root,
  model,
  hooks = new Hooks(),
  rules = {},
  mode = "default",
  ask,
  extraTools = [],
  prompt = {},
  sessionFile,
  onEvent,
  cleanup,
  compactor,
  skillPaths = [],
  childModel,
  sandbox = false,
}) {
  const definitions = [...codingTools(root, { sandbox }), ...extraTools];
  if (skillPaths.length) {
    const skills = new Skills(root, skillPaths);
    definitions.push({
      name: "Skill",
      readOnly: true,
      description: "Load a named study skill",
      schema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      validate(input) {
        skills.load(input.name);
      },
      execute(input) {
        const skill = skills.load(input.name);
        return {
          text: skill.body,
          details: { allowedTools: skill.allowedTools, fork: skill.fork },
        };
      },
    });
  }
  if (childModel)
    definitions.push({
      name: "Agent",
      description: "Run a read-only exploration in its own context",
      schema: {
        type: "object",
        properties: { task: { type: "string" } },
        required: ["task"],
      },
      validate(input) {
        if (typeof input.task !== "string") throw Error("task required");
      },
      async execute(input, context) {
        const child = await runChild(
          {
            model: childModel(),
            tools: definitions,
            context: { root },
            signal: context.signal,
          },
          input.task,
        );
        return {
          text: child.text,
          error: child.terminal.status !== "completed",
          details: { agentId: child.id },
        };
      },
    });
  const tools = new Toolset(definitions, {
    gate: permissionGate({ root, rules, mode, ask }),
    hooks,
  });
  const memories = existsSync(join(root, "CLAUDE.md"))
    ? memoryPrompt(loadMemories(root))
    : [];
  const session = sessionFile ? new Session(sessionFile) : undefined;
  const engine = new Engine({
    model,
    tools,
    request: async (messages) => {
      const view = compactor
        ? (await compactor.compact(messages)).messages
        : messages;
      return buildRequest(view, { prompt, tools: definitions, memories });
    },
    onEvent,
    onCleanup: cleanup,
  });
  return {
    engine,
    tools,
    session,
    async run(text, options = {}) {
      const frames = [];
      const initial = session?.history() ?? [];
      for await (const frame of engine.run(text, {
        ...options,
        history: initial,
        context: { root },
      })) {
        frames.push(frame);
        if (frame.type === "terminal")
          for (const message of frame.messages.slice(initial.length))
            session?.append(message);
      }
      return { frames, terminal: frames.at(-1) };
    },
  };
}
