import { lesson, ROOT } from "./harness.mjs";
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { effectivePrompt, buildRequest } from "../../coda/src/request.mjs";
import { upstream } from "../engineering/run.mjs";
await lesson(2, "提示优先级与请求稳定前缀", async (t) => {
  const original = upstream("system-prompt", "buildEffectiveSystemPrompt", {
    feature: () => false,
    isBuiltInAgent: () => false,
    asSystemPrompt: (x) => x,
    logEvent() {},
    process: { env: {} },
  });
  const rows = [];
  for (const options of [
    {},
    { custom: "custom" },
    { agent: "agent", custom: "custom" },
    { override: "override" },
  ]) {
    const input = { defaults: ["default"], append: "append", ...options };
    const actual = effectivePrompt(input),
      upstreamResult = original({
        defaultSystemPrompt: input.defaults,
        customSystemPrompt: input.custom,
        appendSystemPrompt: input.append,
        overrideSystemPrompt: input.override,
        mainThreadAgentDefinition: input.agent
          ? { getSystemPrompt: () => input.agent }
          : undefined,
        toolUseContext: { options: {} },
      });
    t.equal(
      "prompt branch " + JSON.stringify(options),
      actual,
      JSON.parse(JSON.stringify(upstreamResult)),
    );
    rows.push({ input, actual });
  }
  const first = buildRequest([{ role: "user", text: "A" }], {
    prompt: { defaults: ["rules"] },
  });
  const next = buildRequest([{ role: "user", text: "B" }], {
    prompt: { defaults: ["rules"] },
  });
  t.equal(
    "changing history preserves stable prefix hash",
    first.prefixHash,
    next.prefixHash,
  );
  t.ok(
    "changing instructions changes prefix",
    first.prefixHash !==
      buildRequest([], { prompt: { defaults: ["other"] } }).prefixHash,
  );
  t.observations.branches = rows;
});
