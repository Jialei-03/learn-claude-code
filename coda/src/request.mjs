// 第 2 章：请求构造。
//
// 对应 Claude Code 的五处源码（正文里都有 @cc 摘录和逐段讲解）：
//   · utils/systemPrompt.ts 的 buildEffectiveSystemPrompt()：五种提示来源按优先级只选一种做底座，再追加 append；
//   · context.ts 的 getUserContext / getSystemContext，加上 utils/api.ts 的 prependUserContext / appendSystemContext：
//     会话级上下文只取一次快照，一份挂在 system 末尾，一份做成第一条 user 消息；
//   · constants/prompts.ts 的动态边界 + utils/api.ts 的 splitSysPromptPrefix()：
//     system 以边界为界，分成“所有会话都一样”的静态段和“因会话而异”的动态段，两段的缓存范围不同；
//   · services/api/claude.ts 的 addCacheBreakpoints()：消息上只打一个缓存断点，打在最后一条的最后一块上；
//   · services/api/promptCacheBreakDetection.ts：给 system、工具、模型各算一个指纹，前后两次一比，就知道缓存为什么断了。
//
// 本章实现的机制：
//   1. 提示优先级：override > agent > custom > defaults，append 在最后，但 override 会把 append 一起丢掉；
//   2. 两个上下文槽位：systemContext 追加在 system 末尾，userContext 做成第一条 user 消息（meta）；
//   3. 会变的东西不改开头：日期变了，只在末尾追加一条提醒；工具定义在会话内只渲染一次；
//   4. system 的静态/动态分界，以及 global / org 两种缓存范围；
//   5. 内部消息 → 协议消息：相邻的同角色消息合并，tool_result 排在最前，最后一块打缓存断点；
//   6. 缓存断了以后，怎样用指纹找出原因。
//
// 刻意没有做的事：betas、thinking、max_tokens 的按模型取值、context_management、
// 工具搜索（defer_loading）和 1 小时 TTL。这些是 paramsFromContext 里的条件分支，coda 的模型没有对应的能力。

import { digest } from "../../runtime/files.mjs";
import { projectHistory } from "./session.mjs";

// ── 一、系统提示：只选一个底座 ──────────────────────────────────────

// 静态段和动态段之间的分界标记。真实源码里它就是 system 数组里的一个字符串，
// 只有默认提示才会放进去：自定义提示没有“所有人都一样”的部分，也就没有边界。
export const DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

// 返回 { base, source, append }：
//   base   选中的那一层（数组，因为 defaults 本身是好几段）
//   source 选中的是哪一层，buildRequest 要靠它决定有没有静态段
//   append 追加在最后的内容
function promptLayers({ override, agent, custom, defaults = [], append }) {
  // override 是“整体替换”：前面所有层都不要，append 也不要。
  if (override) return { base: [override], source: "override", append: [] };
  // 其余三层互斥：Agent 的提示 > 用户用 --system-prompt 给的 > 默认提示。
  const [source, base] = agent ? ["agent", [agent]] : custom ? ["custom", [custom]] : ["defaults", defaults];
  return { base, source, append: append ? [append] : [] };
}

// 对应 buildEffectiveSystemPrompt。真实函数还有 coordinator 和 proactive 两个功能开关控制的分支，这里不实现。
export function effectivePrompt(prompt) {
  const { base, append } = promptLayers(prompt);
  return [...base, ...append];
}

// ── 二、上下文的两个槽位 ───────────────────────────────────────────

// 会话开始时取一次快照，之后每个请求都用同一份。
// 真实源码里 getUserContext / getSystemContext 用 memoize 包着：整个会话只算一次，
// 所以 git 状态是“会话开始时的快照”，日期是“会话开始那天的日期”。
//   claudeMd、currentDate → userContext（做成第一条 user 消息）
//   gitStatus             → systemContext（追加在 system 末尾）
export function snapshotContext({ claudeMd, gitStatus, now = new Date() } = {}) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return Object.freeze({
    date,
    userContext: Object.freeze({ ...(claudeMd && { claudeMd }), currentDate: `Today's date is ${date}.` }),
    systemContext: Object.freeze({ ...(gitStatus && { gitStatus }) }),
  });
}

// 对应 appendSystemContext：键值对拼成 "key: value" 的几行，作为 system 的最后一项。
export function appendSystemContext(system, context = {}) {
  const lines = Object.entries(context).map(([key, value]) => `${key}: ${value}`).join("\n");
  return [...system, lines].filter(Boolean); // 没有上下文时 lines 是空串，被 filter 掉
}

// 对应 prependUserContext：键值对做成一条 meta 用户消息，放在整个对话的最前面。
// meta 表示“不是用户敲的”：界面不显示它，但它会随请求一起发给模型。
export function prependUserContext(messages, context = {}) {
  const entries = Object.entries(context);
  if (!entries.length) return messages;
  const body = entries.map(([key, value]) => `# ${key}\n${value}`).join("\n");
  return [{ role: "user", meta: true, text: reminder(`Background for this session. Use it only when it helps with the task.\n${body}`) }, ...messages];
}

const reminder = (text) => `<system-reminder>\n${text}\n</system-reminder>`;

// 日期变了怎么办？不去改第一条消息（那会让整个对话的缓存作废），而是在对话末尾补一条提醒消息。
// announced 是模型最近一次被告知的日期；没变就返回 undefined。
// 调用者要把返回的消息追加进对话历史，之后的每个请求都带着它——它在历史里的位置是固定的。
// 对应 attachments.ts 的 getDateChangeAttachments。
export function dateChange(announced, today) {
  if (announced === today) return undefined;
  return { role: "user", meta: true, text: reminder(`The date has changed. Today's date is now ${today}.`) };
}

// ── 三、工具定义 ────────────────────────────────────────────────

// 模型只看得到名字、描述和参数 schema；execute 不会出现在请求里。
// schemaCache 是会话级的：同一个工具的定义只渲染一次，之后无论源头怎么变，发出去的字节都不变。
// 对应 toolToAPISchema + toolSchemaCache。不传 schemaCache 就每次重新渲染。
export function renderTools(tools, schemaCache = new Map()) {
  return tools.map(({ name, description, schema }) => {
    if (!schemaCache.has(name)) schemaCache.set(name, Object.freeze({ name, description, schema }));
    return schemaCache.get(name);
  });
}

// ── 四、内部请求：buildRequest ────────────────────────────────────

// 对话历史 + 各种来源 → 一份冻结的“请求”。后面的 toApiBody 再把它翻译成 Anthropic 协议。
//   prompt        { override, agent, custom, defaults, append }，见 effectivePrompt
//   memories      项目说明，追加在 system 的动态段（第 4 章；Claude Code 里它走 userContext.claudeMd）
//   userContext / systemContext   snapshotContext 的结果
//   schemaCache   会话级的工具定义缓存
//   global        服务端是否支持跨组织的全局缓存。只有支持时，默认提示里才会放边界标记
export function buildRequest(
  messages,
  { prompt = {}, tools = [], memories = [], userContext = {}, systemContext = {}, schemaCache, global = false } = {},
) {
  const { base, source, append } = promptLayers(prompt);
  // 动态段 = append、项目说明、systemContext，都排在边界之后。
  const dynamic = appendSystemContext([...append, ...memories], systemContext);
  // 只有默认提示才有静态段，也只有后面确实跟着动态内容时才需要边界。
  const boundary = global && source === "defaults" && base.length && dynamic.length ? [DYNAMIC_BOUNDARY] : [];
  const system = [...base, ...boundary, ...dynamic];

  const renderedTools = renderTools(tools, schemaCache);

  return Object.freeze({
    system,
    messages: prependUserContext(projectHistory(messages), userContext),
    tools: renderedTools,
    // 只覆盖 system 和工具：这两部分在缓存里排在最前面，变一个字，后面的一切都要重算。
    prefixHash: digest({ system, tools: renderedTools }),
  });
}

// ── 五、缓存块与断点 ───────────────────────────────────────────

// system 数组 → 带缓存范围的块。对应 splitSysPromptPrefix 的三种模式：
//   global 且找到边界且没有 MCP 工具：静态段标 "global"（跨组织共享），动态段不标（null，自己不设断点）
//   其余情况：整段合并成一块，标 "org"（组织内共享）
// 有 MCP 工具时放弃全局缓存：MCP 工具因人而异，而工具排在 system 前面，前缀不可能所有人一样。
export function splitSystem(system, { global = false, hasMcpTools = false } = {}) {
  const at = system.indexOf(DYNAMIC_BOUNDARY);
  const join = (parts) => parts.filter((s) => s && s !== DYNAMIC_BOUNDARY).join("\n\n");
  if (global && !hasMcpTools && at !== -1) {
    return [
      { text: join(system.slice(0, at)), scope: "global" },
      { text: join(system.slice(at + 1)), scope: null },
    ].filter((block) => block.text);
  }
  const text = join(system);
  return text ? [{ text, scope: "org" }] : [];
}

// 对应 getCacheControl：只有 global 范围才需要写出 scope，org 是缺省值；ttl 缺省 5 分钟，可选 "1h"。
const cacheControl = (scope, ttl) => ({ type: "ephemeral", ...(ttl === "1h" && { ttl }), ...(scope === "global" && { scope }) });

// 一条内部消息 → Anthropic 的内容块。
function toBlocks(m) {
  if (m.role === "tool") {
    return [{ type: "tool_result", tool_use_id: m.id, content: m.text, ...(m.error && { is_error: true }) }];
  }
  if (m.role === "assistant") {
    const text = m.text ? [{ type: "text", text: m.text }] : [];
    const calls = (m.calls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input }));
    return [...text, ...calls];
  }
  return [{ type: "text", text: m.text }];
}

// 内部消息 → Anthropic 的消息数组。对应 normalizeMessagesForAPI 里最关键的两件事：
//   1. 相邻的同角色消息合并成一条（工具结果、meta 消息和用户的提问都是 user 角色）；
//   2. 同一条 user 消息里，tool_result 必须排在最前面。
export function toApiMessages(messages) {
  const result = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = result.at(-1);
    if (last?.role === role) last.content.push(...toBlocks(m));
    else result.push({ role, content: toBlocks(m) });
  }
  for (const m of result) {
    // sort 是稳定的：tool_result 排到前面，其余块保持原来的顺序。
    if (m.role === "user") m.content.sort((a, b) => (b.type === "tool_result") - (a.type === "tool_result"));
    // API 不接受空内容的 assistant 消息，补一个占位（对应 ensureNonEmptyAssistantContent）。
    if (!m.content.length) m.content.push({ type: "text", text: "(no content)" });
  }
  return result;
}

// 整个请求里，消息上只打一个缓存断点：最后一条消息的最后一块。
// 每个请求都让“到目前为止的全部内容”成为下一个请求可以复用的前缀。
// skipCacheWrite 给“一次性的分叉请求”用：断点往前挪一条，不留下自己的尾巴。对应 addCacheBreakpoints。
export function markCacheBreakpoint(apiMessages, { skipCacheWrite = false, ttl } = {}) {
  const at = apiMessages.length - (skipCacheWrite ? 2 : 1);
  return apiMessages.map((message, i) => {
    if (i !== at) return message;
    const last = message.content.length - 1;
    const content = message.content.map((block, j) => (j === last ? { ...block, cache_control: cacheControl(undefined, ttl) } : block));
    return { ...message, content };
  });
}

// wire → 真正发给 Anthropic 的请求体。工具不设断点，system 的块按各自的范围设断点。
export function toApiBody(
  wire,
  { model, maxTokens = 1024, caching = true, global = false, hasMcpTools = false, skipCacheWrite = false, ttl } = {},
) {
  const system = splitSystem(wire.system, { global, hasMcpTools }).map(({ text, scope }) => ({
    type: "text",
    text,
    ...(caching && scope !== null && { cache_control: cacheControl(scope, ttl) }),
  }));
  const messages = toApiMessages(wire.messages);
  return {
    model,
    max_tokens: maxTokens,
    system,
    messages: caching ? markCacheBreakpoint(messages, { skipCacheWrite, ttl }) : messages,
    tools: wire.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
  };
}

// ── 六、缓存断了，为什么 ────────────────────────────────────────

const withoutCacheControl = (items) => items.map(({ cache_control, ...rest }) => rest);

// 把一个请求体变成一组指纹。对应 recordPromptState：
// 内容的指纹要把 cache_control 去掉，否则范围一变、内容没变，就分不清是哪个原因；
// cache_control 单独算一个指纹，专门抓“范围变了”。
export function cacheFingerprint(body) {
  return {
    model: body.model,
    systemChars: body.system.reduce((n, block) => n + block.text.length, 0),
    system: digest(withoutCacheControl(body.system)),
    cacheControl: digest(body.system.map((block) => block.cache_control ?? null)),
    tools: Object.fromEntries(body.tools.map((t) => [t.name, digest(t)])),
  };
}

// 客户端什么都没变：缓存默认只活 5 分钟（有资格时可以是 1 小时），隔得久就先怪 TTL，隔得不久多半是服务端。
function idleReason(idleMs) {
  if (idleMs > 3600_000) return "possible 1h TTL expiry (prompt unchanged)";
  if (idleMs > 300_000) return "possible 5min TTL expiry (prompt unchanged)";
  return "likely server-side (prompt unchanged, <5min gap)";
}

// 比较前后两次的指纹，列出原因。不传 idleMs 就只报告客户端原因，可能返回空数组。
export function explainCacheBreak(before, after, idleMs) {
  const reasons = [];
  if (before.model !== after.model) reasons.push(`model changed (${before.model} → ${after.model})`);
  if (before.system !== after.system) {
    const delta = after.systemChars - before.systemChars;
    reasons.push(`system prompt changed${delta ? ` (${delta > 0 ? "+" : ""}${delta} chars)` : ""}`);
  }
  const names = (f) => Object.keys(f.tools);
  const added = names(after).filter((n) => !(n in before.tools));
  const removed = names(before).filter((n) => !(n in after.tools));
  const edited = names(after).filter((n) => n in before.tools && before.tools[n] !== after.tools[n]);
  if (added.length || removed.length) reasons.push(`tools changed (+${added.length}/-${removed.length})`);
  else if (edited.length) reasons.push(`tools changed (schema changed, same tool set: ${edited.join(",")})`);
  // 范围变化只在没有别的解释时才单独报告，否则它只是别的原因的后果。
  if (before.cacheControl !== after.cacheControl && !reasons.length) reasons.push("cache_control changed (scope or TTL)");
  if (!reasons.length && idleMs !== undefined) reasons.push(idleReason(idleMs));
  return reasons;
}

// 服务端返回的用量里，读缓存的 token 数突然少了：比上一次少 5% 以上，并且至少少 2000 个，才算“断了”。
// 小幅波动不报警。这两个数字和源码里的判断一致。
export function isCacheBreak(previousRead, read) {
  return read < previousRead * 0.95 && previousRead - read >= 2000;
}

// ── 七、可选的真实适配器 ──────────────────────────────────────────

// 课程验证不会调用它。需要显式传入 baseURL、apiKey、model；不会去读任何本地配置。
// 返回的 usage 里有 cacheRead / cacheWrite，可以配合 isCacheBreak 观察缓存有没有生效。
export function anthropicModel({ baseURL, apiKey, model, maxTokens = 1024, cache = true }) {
  return async (wire, signal) => {
    const response = await fetch(new URL("v1/messages", baseURL.endsWith("/") ? baseURL : baseURL + "/"), {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(toApiBody(wire, { model, maxTokens, caching: cache })),
    });
    if (!response.ok) throw Error(`provider HTTP ${response.status}`);
    const body = await response.json();
    return {
      text: body.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      calls: body.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input })),
      stop: body.stop_reason === "max_tokens" ? "length" : "stop",
      usage: {
        input: body.usage?.input_tokens ?? 0,
        output: body.usage?.output_tokens ?? 0,
        cacheRead: body.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: body.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  };
}
