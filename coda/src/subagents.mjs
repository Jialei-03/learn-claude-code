import { randomUUID } from "node:crypto";
import { Engine, collect } from "./engine.mjs";
import { Toolset } from "./tools.mjs";
import { buildRequest } from "./request.mjs";

export async function runChild(
  {
    parentHistory = [],
    tools,
    allow = ["Read"],
    model,
    signal,
    fork = false,
    context = {},
  },
  task,
) {
  const controller = new AbortController(),
    id = randomUUID();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  // Tool availability is reduced before request construction, not just hidden
  // in the description. Permission gates still apply inside each execution.
  const selected = tools.filter((tool) => allow.includes(tool.name));
  const engine = new Engine({
    model,
    tools: new Toolset(selected),
    request: (messages) => buildRequest(messages, { tools: selected }),
  });
  try {
    const frames = await collect(engine, task, {
      context,
      signal: controller.signal,
      history: fork ? parentHistory : [],
      maxTurns: 4,
    });
    return {
      id,
      frames,
      terminal: frames.at(-1),
      text: frames
        .filter((f) => f.type === "assistant")
        .map((f) => f.message.text)
        .join("\n"),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
