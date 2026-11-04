// 第 2 章实验：请求构造。七个小实验，各回答一个问题：
//   priority   五种提示来源，按什么优先级选？（运行 Claude Code 里真正的 buildEffectiveSystemPrompt）
//   context    CLAUDE.md、日期、git 状态，分别从哪个位置进入请求？
//   blocks     system 数组怎样被切成缓存块？（运行真正的 splitSysPromptPrefix）
//   markers    消息上的缓存断点打在哪里？（运行真正的 addCacheBreakpoints）
//   midnight   跨过午夜，日期怎么更新才不会毁掉缓存？（运行真正的 getDateChangeAttachments）
//   pairing    发请求前，工具调用和工具结果怎样配对？（运行真正的 ensureToolResultPairing）
//   diagnose   缓存断了，怎样找原因？
//
//   node --disable-warning=ExperimentalWarning labs/chapters/02-request.mjs            全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/02-request.mjs blocks     只运行一个
import { lesson } from "./harness.mjs";
import {
  DYNAMIC_BOUNDARY,
  buildRequest,
  cacheFingerprint,
  dateChange,
  effectivePrompt,
  explainCacheBreak,
  isCacheBreak,
  markCacheBreakpoint,
  snapshotContext,
  splitSystem,
  toApiBody,
  toApiMessages,
} from "../../coda/src/request.mjs";
import { upstream } from "../engineering/run.mjs";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;
// upstream() 在另一个 JS 环境里执行原函数，返回的对象要先转成普通 JSON 才能和我们的结果比较。
const plain = (value) => JSON.parse(JSON.stringify(value));
const percent = (x) => `${Math.round(x * 100)}%`;
const label = (text) => text.replaceAll("\n\n", " + ").replace(DYNAMIC_BOUNDARY, "【边界】");
// 缓存按前缀匹配：两个字符串从头开始，相同的部分有多长。
const sharedPrefix = (a, b) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};
// 请求体按缓存的顺序（工具 → system → 消息）拼成一个字符串。断点标记不属于内容，不参与比较。
const inCacheOrder = (body) =>
  JSON.stringify([body.tools, body.system, body.messages], (key, value) => (key === "cache_control" ? undefined : value));

await lesson(2, "请求构造：优先级、上下文槽位与缓存断点", async (t) => {
  // ───────────────────────── 一、提示优先级 ─────────────────────────
  if (wants("priority")) {
    t.log("一、五种提示来源，按什么优先级选");
    t.log();
    // 原函数里有 coordinator、proactive 两个功能开关控制的分支。关掉开关，剩下的就是普通路径。
    const original = upstream("system-prompt", "buildEffectiveSystemPrompt", {
      feature: () => false,
      isBuiltInAgent: () => false,
      asSystemPrompt: (x) => x,
      logEvent() {},
      process: { env: {} },
    });
    const claudeCode = (layers) =>
      plain(
        original({
          defaultSystemPrompt: ["default"],
          customSystemPrompt: layers.custom,
          appendSystemPrompt: layers.append,
          overrideSystemPrompt: layers.override,
          mainThreadAgentDefinition: layers.agent ? { getSystemPrompt: () => layers.agent } : undefined,
          toolUseContext: { options: {} },
        }),
      );
    const names = ["override", "agent", "custom", "append"];
    const combos = Array.from({ length: 16 }, (_, mask) => names.filter((_, i) => mask & (1 << i)));
    const run = (set) => {
      const layers = Object.fromEntries(set.map((name) => [name, name]));
      return { theirs: claudeCode(layers), ours: effectivePrompt({ defaults: ["default"], ...layers }) };
    };

    const shown = [[], ["append"], ["custom"], ["custom", "append"], ["agent", "custom"], ["agent", "custom", "append"], ["override", "agent", "custom", "append"]];
    t.table(
      shown.map((set) => {
        const { theirs, ours } = run(set);
        return {
          "设置了哪些层（default 一直都在）": set.join(" + ") || "（都没设）",
          "Claude Code 的结果": theirs.join(" + "),
          "coda 的结果": ours.join(" + "),
        };
      }),
    );
    const different = combos.filter((set) => JSON.stringify(run(set).theirs) !== JSON.stringify(run(set).ours));
    t.log("读法：agent 压过 custom，custom 压过 default；append 总在最后，只有 override 会把它一起丢掉。");
    t.equal("override、agent、custom、append 的 16 种组合，coda 与原函数的结果一致", different, []);
    t.log();
  }

  // ───────────────────────── 二、上下文的两个槽位 ─────────────────────────
  if (wants("context")) {
    t.log("二、CLAUDE.md、日期、git 状态，分别从哪个位置进入请求");
    t.log();
    // 原函数 prependUserContext 要用到 createUserMessage；这里换成一个只做最少事情的版本。
    const original = {
      appendSystemContext: upstream("request-system-context", "appendSystemContext"),
      prependUserContext: upstream("request-user-context", "prependUserContext", {
        process: { env: {} },
        createUserMessage: ({ content, isMeta }) => ({ type: "user", message: { role: "user", content }, isMeta }),
      }),
    };
    // 会话开始的那一刻取一次快照：CLAUDE.md 的内容、今天的日期、git 状态。
    const snapshot = snapshotContext({
      claudeMd: "Run the tests before you finish.",
      gitStatus: "Current branch: main\nStatus: (clean)",
      now: new Date(2026, 10, 3, 9, 30),
    });
    t.log(`会话开始时的快照：userContext 的键是 [${Object.keys(snapshot.userContext)}]，systemContext 的键是 [${Object.keys(snapshot.systemContext)}]`);
    t.log();

    const theirSystem = plain(original.appendSystemContext(["RULES"], snapshot.systemContext));
    const theirMessages = plain(original.prependUserContext([{ type: "user", message: { role: "user", content: "fix the bug" } }], snapshot.userContext));
    const wire = buildRequest([{ role: "user", text: "fix the bug" }], { prompt: { defaults: ["RULES"] }, ...snapshot });

    // 两边的消息长得不一样（一边是内部消息，一边是 coda 的消息），先各自转成同样的几个观察项。
    const theirs = { system: theirSystem, count: theirMessages.length, meta: theirMessages[0].isMeta, text: theirMessages[0].message.content, userAt: theirMessages.findIndex((m) => m.message.content === "fix the bug") };
    const ours = { system: wire.system, count: wire.messages.length, meta: wire.messages[0].meta, text: wire.messages[0].text, userAt: wire.messages.findIndex((m) => m.text === "fix the bug") };
    const sections = (text) => [...text.matchAll(/^# (\w+)$/gm)].map((m) => m[1]).join("、");
    const rows = [
      ["system 数组的项数", (x) => x.system.length],
      ["system 的最后一项", (x) => x.system.at(-1).replaceAll("\n", "⏎")],
      ["messages 的条数（比原来多 1 条）", (x) => x.count],
      ["messages[0] 是 meta 消息吗", (x) => (x.meta ? "是" : "否")],
      ["messages[0] 以什么开头", (x) => x.text.slice(0, 17)],
      ["messages[0] 里有哪几段", (x) => sections(x.text)],
      ["用户的提问现在在", (x) => `messages[${x.userAt}]`],
    ];
    t.table(rows.map(([观察项, f]) => ({ 观察项, "Claude Code 原函数": f(theirs), coda: f(ours) })));

    for (const [name, f] of rows) t.equal(`${name}：coda 与原函数一致`, f(ours), f(theirs));
    t.log();
    t.log("所以 git 状态在 system 里，CLAUDE.md 和日期在第一条 user 消息里。快照只取一次：");
    const later = snapshotContext({ claudeMd: "Run the tests before you finish.", now: new Date(2026, 10, 3, 23, 59) });
    t.equal("同一天的第二次快照，userContext 一字不差", later.userContext, snapshot.userContext);
    t.log();
  }

  // ───────────────────────── 三、system 怎样切成缓存块 ─────────────────────────
  if (wants("blocks")) {
    t.log("三、system 数组怎样被切成缓存块");
    t.log();
    const splitWith = (global, prefixes = []) =>
      upstream("system-prompt-split", "splitSysPromptPrefix", {
        shouldUseGlobalCacheScope: () => global,
        SYSTEM_PROMPT_DYNAMIC_BOUNDARY: DYNAMIC_BOUNDARY,
        CLI_SYSPROMPT_PREFIXES: new Set(prefixes),
        logEvent() {},
      });
    const system = { defaults: ["STATIC-1", "STATIC-2"], append: "APPEND", memories: ["MEMORY"] };
    // 同一份提示，在四种环境里：真实的 getSystemPrompt 只在“全局缓存可用”时才放边界标记，buildRequest 照此办理。
    const cases = [
      { mode: "① 全局缓存不可用（Bedrock、Vertex，或关掉了实验功能）", global: false, prompt: { defaults: system.defaults, append: system.append } },
      { mode: "② 第一方，默认提示", global: true, prompt: { defaults: system.defaults, append: system.append } },
      { mode: "③ 第一方，连了 MCP 工具", global: true, mcp: true, prompt: { defaults: system.defaults, append: system.append } },
      { mode: "④ 第一方，自定义提示（--system-prompt）", global: true, prompt: { custom: "CUSTOM", append: system.append } },
    ];
    const rows = [];
    const mismatches = [];
    for (const c of cases) {
      const wire = buildRequest([], { prompt: c.prompt, memories: system.memories, global: c.global });
      const theirs = plain(splitWith(c.global)(wire.system, { skipGlobalCacheForSystemPrompt: !!c.mcp })).map((b) => ({ text: b.text, scope: b.cacheScope }));
      const ours = splitSystem(wire.system, { global: c.global, hasMcpTools: !!c.mcp });
      if (JSON.stringify(theirs) !== JSON.stringify(ours)) mismatches.push(c.mode);
      const body = toApiBody(wire, { model: "m", global: c.global, hasMcpTools: !!c.mcp });
      theirs.forEach((block, i) => {
        rows.push({
          环境: i === 0 ? c.mode : "",
          块: i + 1,
          缓存范围: block.scope ?? "不设断点",
          "cache_control（coda 的请求体）": JSON.stringify(body.system[i].cache_control ?? null),
          内容: label(block.text),
        });
      });
    }
    t.table(rows);
    t.equal("四种环境下，coda 切出的块与原函数完全一致", mismatches, []);

    // 真实请求里，数组前面还有计费头和身份声明两项，原函数按内容把它们认出来单独成块。
    const header = "x-anthropic-billing-header: cc_version=…";
    const identity = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
    const wire = buildRequest([], { prompt: system, global: true });
    const full = plain(splitWith(true, [identity])([header, identity, ...wire.system]));
    t.log();
    t.log("真实请求在数组前面还会加两项：计费头和身份声明。第一方、默认提示的情形下，原函数切出这几块：");
    t.table(full.map((b, i) => ({ 块: i + 1, 缓存范围: b.cacheScope ?? "不设断点", 内容: label(b.text) })));
    t.equal("计费头、身份声明、静态段、动态段，共四块", full.map((b) => b.cacheScope), [null, null, "global", null]);
    t.log();
  }

  // ───────────────────────── 四、消息上的缓存断点 ─────────────────────────
  if (wants("markers")) {
    t.log("四、消息上的缓存断点打在哪里");
    t.log();
    // 原函数 addCacheBreakpoints 依赖两个转换函数，它们也是原函数。getCacheControl 换成不带 1 小时 TTL 的版本。
    const getCacheControl = ({ scope } = {}) => ({ type: "ephemeral", ...(scope === "global" && { scope }) });
    const addCacheBreakpoints = upstream("cache-breakpoints", "addCacheBreakpoints", {
      logEvent() {},
      userMessageToMessageParam: upstream("cache-message-user", "userMessageToMessageParam", { getCacheControl }),
      assistantMessageToMessageParam: upstream("cache-message-assistant", "assistantMessageToMessageParam", { getCacheControl, feature: () => false, isConnectorTextBlock: () => false }),
    });

    // 一段典型的对话：提问 → 并行读两个文件 → 再读一个 → 工具结果刚回来，马上要发下一次请求。
    const history = [
      { role: "user", text: "fix add.js" },
      { role: "assistant", text: "Reading both files.", calls: [{ id: "a", name: "Read", input: {} }, { id: "b", name: "Read", input: {} }] },
      { role: "tool", id: "a", text: "add.js" },
      { role: "tool", id: "b", text: "test.js" },
      { role: "assistant", text: "", calls: [{ id: "c", name: "Read", input: {} }] },
      { role: "tool", id: "c", text: "package.json" },
    ];
    // Claude Code 内部的消息已经是合并好的形状（normalizeMessagesForAPI 的结果），照着写一份。
    const internal = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "fix add.js" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Reading both files." }, { type: "tool_use", id: "a", name: "Read", input: {} }, { type: "tool_use", id: "b", name: "Read", input: {} }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "add.js" }, { type: "tool_result", tool_use_id: "b", content: "test.js" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "c", name: "Read", input: {} }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "package.json" }] } },
    ];

    const summary = (messages) =>
      messages.map((m, i) => ({
        "#": i,
        role: m.role,
        内容块: (typeof m.content === "string" ? [{ type: "text" }] : m.content).map((b) => b.type + (b.cache_control ? " ←断点" : "")).join("，"),
      }));
    const theirs = plain(addCacheBreakpoints(internal, true, "sdk"));
    const ours = markCacheBreakpoint(toApiMessages(history));
    t.table(
      summary(theirs).map((row, i) => ({ ...row, "coda 的内容块": summary(ours)[i].内容块 })),
    );
    t.equal("coda 的请求体与原函数一致：断点在最后一条消息的最后一块", ours, theirs);

    const skipped = markCacheBreakpoint(toApiMessages(history), { skipCacheWrite: true });
    const at = (messages) => messages.findIndex((m) => m.content.some((b) => b.cache_control));
    const theirSkipped = plain(addCacheBreakpoints(internal, true, "sdk", false, null, [], true));
    t.log();
    t.table([
      { 请求: "普通请求", 原函数的断点在: `messages[${at(theirs)}]`, "coda 的断点在": `messages[${at(ours)}]` },
      { 请求: "一次性的分叉请求（skipCacheWrite）", 原函数的断点在: `messages[${at(theirSkipped)}]`, "coda 的断点在": `messages[${at(skipped)}]` },
    ]);
    t.equal("skipCacheWrite 时断点前移一条，两边一致", skipped, theirSkipped);
    t.equal("整个请求的消息里只有一个断点", ours.flatMap((m) => m.content).filter((b) => b.cache_control).length, 1);
    t.log();
  }

  // ───────────────────────── 五、跨过午夜 ─────────────────────────
  if (wants("midnight")) {
    t.log("五、跨过午夜，日期怎么更新才不会毁掉缓存");
    t.log();
    // 请求的尺寸参照第 2 章录下的真实请求：工具定义 46988 个字符，system 5878 个字符。内容用占位文字，只有长度有意义。
    const filler = (n, seed) => `${seed}:`.padEnd(n, "·");
    const tools = Array.from({ length: 20 }, (_, i) => ({ name: `Tool${i}`, description: filler(2349, `tool${i}`), schema: { type: "object" } }));
    const prompt = { defaults: [filler(5878, "rules")] };
    const longHistory = Array.from({ length: 20 }, (_, i) => [
      { role: "assistant", text: "", calls: [{ id: `h${i}`, name: "Tool0", input: {} }] },
      { role: "tool", id: `h${i}`, text: filler(20000, `result${i}`) },
    ]).flat();

    // 原函数：靠一个模拟的时钟，告诉我们它在每一次请求前会不会发出“日期变了”的附件。
    let clock = "2026-11-03";
    let lastEmitted = null;
    const getDateChangeAttachments = upstream("date-change", "getDateChangeAttachments", {
      getLocalISODate: () => clock,
      getLastEmittedDate: () => lastEmitted,
      setLastEmittedDate: (date) => (lastEmitted = date),
      feature: () => false,
    });

    const timeline = [
      { 时刻: "11-03 23:50", date: "2026-11-03", now: new Date(2026, 10, 3, 23, 50) },
      { 时刻: "11-03 23:58", date: "2026-11-03", now: new Date(2026, 10, 3, 23, 58) },
      { 时刻: "11-04 00:07", date: "2026-11-04", now: new Date(2026, 10, 4, 0, 7) },
      { 时刻: "11-04 00:09", date: "2026-11-04", now: new Date(2026, 10, 4, 0, 9) },
    ];

    const simulate = (preload) => {
      const open = snapshotContext({ claudeMd: "Run the tests.", gitStatus: "Current branch: main", now: timeline[0].now });
      const a = { history: [{ role: "user", text: "keep going" }, ...preload], previous: null };
      const b = { history: [{ role: "user", text: "keep going" }, ...preload], previous: null, announced: open.date };
      const rows = [];
      const decisions = [];
      let size = 0;
      timeline.forEach((tick, i) => {
        clock = tick.date;
        const attachments = plain(getDateChangeAttachments([]));
        // 每一轮对话：模型调用一个工具，结果回来。两种设计的历史同步增长。
        for (const side of [a, b]) {
          side.history.push({ role: "assistant", text: "", calls: [{ id: `t${i}`, name: "Tool0", input: {} }] }, { role: "tool", id: `t${i}`, text: filler(3000, `new${i}`) });
        }
        // 设计 A：每次请求都重新取上下文，日期随之更新。
        const fresh = snapshotContext({ claudeMd: "Run the tests.", gitStatus: "Current branch: main", now: tick.now });
        const bodyA = toApiBody(buildRequest(a.history, { prompt, tools, ...fresh }), { model: "m" });
        // 设计 B：用会话开始时的快照；日期变了，往历史里追加一条提醒。
        const note = dateChange(b.announced, tick.date);
        if (note) {
          b.history.push(note);
          b.announced = tick.date;
        }
        const bodyB = toApiBody(buildRequest(b.history, { prompt, tools, ...open }), { model: "m" });
        const [textA, textB] = [inCacheOrder(bodyA), inCacheOrder(bodyB)];
        const reuse = (previous, text) => (previous ? percent(sharedPrefix(previous, text) / text.length) : "（首个请求）");
        rows.push({
          时刻: tick.时刻,
          "原函数发出的附件": attachments.map((x) => x.type).join("") || "—",
          "B 追加了提醒": note ? "是" : "—",
          "A：每次重新取上下文": reuse(a.previous, textA),
          "B：快照 + 末尾提醒": reuse(b.previous, textB),
        });
        decisions.push({ original: attachments.length > 0, coda: !!note });
        a.previous = textA;
        b.previous = textB;
        size = textA.length;
      });
      return { rows, decisions, size };
    };

    const long = simulate(longHistory);
    clock = "2026-11-03";
    lastEmitted = null;
    const short = simulate([]);

    t.log(`长会话：午夜前历史里已经有 ${longHistory.length / 2} 轮工具调用，每次请求约 ${Math.round(long.size / 1000)}K 个字符。表里是“和上一次请求相同的前缀，占本次请求的多少”：`);
    t.table(long.rows);
    t.log("短会话：同样四个请求，但午夜前对话里只有一次提问。");
    t.table(short.rows);
    t.equal("原函数只在跨过午夜的那个请求发出日期附件", long.decisions.map((d) => d.original), [false, false, true, false]);
    t.equal("coda 的 dateChange 与原函数的决定一致", long.decisions.map((d) => d.coda), long.decisions.map((d) => d.original));
    const reuseOf = (rows, column, i) => parseInt(rows[i][column]);
    t.ok("B 在午夜前后，复用比例都在 95% 以上", [1, 2, 3].every((i) => reuseOf(long.rows, "B：快照 + 末尾提醒", i) >= 95));
    t.ok("A 在跨过午夜的那个请求里，长会话只能复用不到三成", reuseOf(long.rows, "A：每次重新取上下文", 2) < 30);
    t.log();
  }

  // ───────────────────────── 六、工具调用和结果的配对 ─────────────────────────
  if (wants("pairing")) {
    t.log("六、发请求前，工具调用和工具结果怎样配对");
    t.log();
    const createUserMessage = ({ content, isMeta }) => ({ type: "user", message: { role: "user", content }, isMeta });
    const ensure = upstream("request-pairing", "ensureToolResultPairing", {
      createUserMessage,
      NO_CONTENT_MESSAGE: "(no content)",
      SYNTHETIC_TOOL_RESULT_PLACEHOLDER: "[Tool result missing due to internal error]",
      getStrictToolResultPairing: () => false,
      checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
      smooshSystemReminderSiblings: (messages) => messages,
      logEvent() {},
      logError() {},
    });
    // 原函数的输入是内部消息，coda 的输入是自己的消息；两边用同一个故事：模型调用了 a、b 两个工具。
    const A = (...uses) => ({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "ok" }, ...uses.map((id) => ({ type: "tool_use", id, name: "Read", input: {} }))] } });
    const R = (...ids) => ({ type: "user", message: { content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "ok" })) } });
    const Q = { type: "user", message: { content: "go" } };
    const call = (id) => ({ id, name: "Read", input: {} });
    const Qc = { role: "user", text: "go" };
    const Ac = (...uses) => ({ role: "assistant", text: "ok", calls: uses.map(call) });
    const Rc = (id) => ({ role: "tool", id, text: "ok" });

    const cases = [
      { 情形: "完整：a、b 都有结果", theirs: [Q, A("a", "b"), R("a", "b")], ours: [Qc, Ac("a", "b"), Rc("a"), Rc("b")] },
      { 情形: "缺一个结果：b 没有", theirs: [Q, A("a", "b"), R("a")], ours: [Qc, Ac("a", "b"), Rc("a")] },
      { 情形: "中断：调用之后什么都没有", theirs: [Q, A("a")], ours: [Qc, Ac("a")] },
      { 情形: "孤立的结果：没有对应的调用", theirs: [Q, A(), R("zzz")], ours: [Qc, Ac(), Rc("zzz")] },
      { 情形: "重复的结果：a 的结果出现两次", theirs: [Q, A("a"), R("a", "a")], ours: [Qc, Ac("a"), Rc("a"), Rc("a")] },
    ];
    const describe = (messages) =>
      messages
        .map((m) => {
          const blocks = (m.message?.content ?? m.content).filter?.((b) => b.type) ?? [];
          const uses = blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
          const results = blocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id + (b.is_error ? "(错误)" : ""));
          const role = m.type ?? m.role;
          return role === "assistant" ? `assistant[调用 ${uses.join(",") || "—"}]` : `user[${results.length ? "结果 " + results.join(",") : "文本"}]`;
        })
        .join(" → ");
    const rows = cases.map((c) => {
      const theirs = plain(ensure(c.theirs));
      const ours = toApiMessages(buildRequest(c.ours).messages);
      return { 情形: c.情形, "原函数": describe(theirs), coda: describe(ours), theirs, ours };
    });
    t.table(rows.map(({ theirs, ours, ...row }) => row));

    // 不管怎么修，结果必须满足 API 的要求：每个调用都有且只有一个结果，没有孤立的结果。
    const valid = (messages) => {
      const blocks = messages.flatMap((m) => m.message?.content ?? m.content).filter((b) => typeof b === "object");
      const uses = blocks.filter((b) => b.type === "tool_use").map((b) => b.id);
      const results = blocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
      return uses.every((id) => results.filter((r) => r === id).length === 1) && results.every((id) => uses.includes(id));
    };
    t.ok("原函数修复后，每个调用恰好有一个结果", rows.every((r) => valid(r.theirs)));
    t.ok("coda 修复后同样如此", rows.every((r) => valid(r.ours)));
    t.log();
  }

  // ───────────────────────── 七、缓存断了，为什么 ─────────────────────────
  if (wants("diagnose")) {
    t.log("七、缓存断了，怎样找原因");
    t.log();
    const filler = (n, seed) => `${seed}:`.padEnd(n, "·");
    const tools = [
      { name: "Read", description: filler(800, "read"), schema: { type: "object" } },
      { name: "Edit", description: filler(400, "edit"), schema: { type: "object" } },
    ];
    const open = snapshotContext({ gitStatus: "Current branch: main\nStatus: (clean)", now: new Date(2026, 10, 3, 9, 0) });
    const history = [{ role: "user", text: "fix it" }];
    const base = { prompt: { defaults: [filler(3000, "rules")] }, tools, ...open };
    const request = (options = {}, messages = history, bodyOptions = {}) =>
      toApiBody(buildRequest(messages, { ...base, ...options }), { model: "claude-x", ...bodyOptions });
    const before = request();

    const changes = [
      { 改动: "对话里多了一轮", after: request({}, [...history, { role: "assistant", text: "ok" }, { role: "user", text: "next" }]) },
      { 改动: "Read 的描述多了一句", after: request({ tools: [{ ...tools[0], description: tools[0].description + " Extra." }, tools[1]] }) },
      { 改动: "连上 MCP 服务器，多了一个工具", after: request({ tools: [...tools, { name: "mcp__db", description: "query", schema: { type: "object" } }] }) },
      { 改动: "git 状态里多了三个改动的文件", after: request({ systemContext: { gitStatus: "Current branch: main\nStatus: M add.js\n M test.js\n?? notes.md" } }) },
      { 改动: "换了模型", after: request({}, history, { model: "claude-y" }) },
      { 改动: "缓存的 TTL 从 5 分钟改成 1 小时", after: request({}, history, { ttl: "1h" }) },
      { 改动: "第一条消息里的日期变了", after: request({ userContext: { ...open.userContext, currentDate: "Today's date is 2026-11-04." } }) },
      { 改动: "什么都没改，但隔了 7 分钟才发下一个请求", after: request(), idleMs: 7 * 60_000 },
      { 改动: "什么都没改，隔了 40 秒", after: request(), idleMs: 40_000 },
    ];
    // 文本内容有没有变：工具和 system 一字不差，旧的消息原样保留（只允许在后面追加）。
    const unmarked = (body) => JSON.parse(inCacheOrder(body));
    const textKept = (old, now) => {
      const [a, b] = [unmarked(old), unmarked(now)];
      return JSON.stringify(a.slice(0, 2)) === JSON.stringify(b.slice(0, 2)) && JSON.stringify(a[2]) === JSON.stringify(b[2].slice(0, a[2].length));
    };
    const rows = changes.map((c) => {
      const reasons = explainCacheBreak(cacheFingerprint(before), cacheFingerprint(c.after), c.idleMs);
      return {
        改动: c.改动,
        "请求的文本内容": textKept(before, c.after) ? "没变（至多在末尾追加）" : "变了",
        "explainCacheBreak 的结论": reasons.join("；") || "（没有客户端原因）",
      };
    });
    t.table(rows);
    t.log("换模型、改 TTL，文本一个字没变，缓存照样不能复用：缓存键不只是文本。“第一条消息里的日期变了”是诊断的盲区：它只给 system、工具、模型和 cache_control 算指纹，消息里的前缀变了，它看不见。最后两行是什么都没变的情形：先看间隔，再怪服务端。");
    const verdict = (i) => rows[i]["explainCacheBreak 的结论"];
    t.equal("追加对话不是原因：文本没变，指纹也没变", [rows[0]["请求的文本内容"], verdict(0)], ["没变（至多在末尾追加）", "（没有客户端原因）"]);
    t.ok("改工具描述、加工具、改 git 状态、换模型、改 TTL，诊断都指出了原因", [1, 2, 3, 4, 5].every((i) => verdict(i) !== "（没有客户端原因）"));
    t.equal("消息里的日期变了：前缀变了，但诊断说不出原因", [rows[6]["请求的文本内容"], verdict(6)], ["变了", "（没有客户端原因）"]);
    t.equal("什么都没变时，按间隔归因", [verdict(7), verdict(8)], ["possible 5min TTL expiry (prompt unchanged)", "likely server-side (prompt unchanged, <5min gap)"]);

    t.log();
    t.log("再看服务端返回的用量。读缓存的 token 数比上一次少 5% 以上，并且至少少 2000 个，才算“断了”：两个条件缺一不可。");
    t.table(
      [
        ["录制里第 2→3 个请求", 15376, 15827],
        ["少了 864 个（5.4%），不到 2000 个", 15964, 15100],
        ["少了 5000 个，但只占 2.5%", 200000, 195000],
        ["少了 2964 个（18.6%）", 15964, 13000],
        ["几乎全丢", 15964, 900],
      ].map(([情形, previous, read]) => ({ 情形, 上一次读缓存: previous, 这一次读缓存: read, 是断了吗: isCacheBreak(previous, read) ? "是" : "否" })),
    );
    t.equal("增长、小幅下降、占比很小的下降，都不算断", [isCacheBreak(15376, 15827), isCacheBreak(15964, 15100), isCacheBreak(200000, 195000)], [false, false, false]);
    t.equal("少 18.6% 和几乎全丢，算断了", [isCacheBreak(15964, 13000), isCacheBreak(15964, 900)], [true, true]);
    t.log();
  }

  // 保留旧版本的两条检查：改变历史不改前缀，改变提示就改前缀。
  const first = buildRequest([{ role: "user", text: "A" }], { prompt: { defaults: ["rules"] } });
  const next = buildRequest([{ role: "user", text: "B" }], { prompt: { defaults: ["rules"] } });
  t.equal("只改用户消息，prefixHash 不变", first.prefixHash, next.prefixHash);
  t.ok("改了系统规则，prefixHash 变了", first.prefixHash !== buildRequest([], { prompt: { defaults: ["other"] } }).prefixHash);
});
