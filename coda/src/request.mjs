import { digest } from "../../runtime/files.mjs";
import { projectHistory } from "./session.mjs";

export function effectivePrompt({
  override,
  agent,
  custom,
  defaults = [],
  append,
}) {
  if (override) return [override];
  return [
    ...(agent ? [agent] : custom ? [custom] : defaults),
    ...(append ? [append] : []),
  ];
}
export function buildRequest(
  messages,
  { prompt = {}, tools = [], memories = [] } = {},
) {
  const system = [...effectivePrompt(prompt), ...memories];
  const schema = tools.map(({ name, description, schema }) => ({
    name,
    description,
    schema,
  }));
  const projected = projectHistory(messages);
  return Object.freeze({
    system,
    messages: projected,
    tools: schema,
    prefixHash: digest({ system, tools: schema }),
  });
}
// Optional live adapter; no course verification calls it. It accepts explicit
// credentials and never discovers private local CLI configuration.
export function anthropicModel({ baseURL, apiKey, model, maxTokens = 1024 }) {
  return async (wire, signal) => {
    const messages = wire.messages.map((m) =>
      m.role === "tool"
        ? {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: m.id,
                content: m.text,
                is_error: !!m.error,
              },
            ],
          }
        : {
            role: m.role,
            content: [
              ...(m.text ? [{ type: "text", text: m.text }] : []),
              ...(m.calls ?? []).map((c) => ({
                type: "tool_use",
                id: c.id,
                name: c.name,
                input: c.input,
              })),
            ],
          },
    );
    const response = await fetch(
      new URL("v1/messages", baseURL.endsWith("/") ? baseURL : baseURL + "/"),
      {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: wire.system.join("\n\n"),
          messages,
          tools: wire.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.schema,
          })),
        }),
      },
    );
    if (!response.ok) throw Error(`provider HTTP ${response.status}`);
    const body = await response.json();
    return {
      text: body.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      calls: body.content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      stop: body.stop_reason === "max_tokens" ? "length" : "stop",
    };
  };
}
