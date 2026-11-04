// 第 5 章实验：会话与压缩。八个小实验，各回答一个问题：
//   session      会话文件里到底存了什么？回退、分叉、崩溃之后，文件和“当前分支”是什么关系？
//   resume       恢复一个被打断的会话时，哪些记录会被整理？（对照 Claude Code 的原函数）
//   threshold    自动压缩在多大的时候触发？（运行 Claude Code 里真正的阈值函数，并对照两份录制）
//   microcompact 不请求模型的压缩是什么？（运行真正的 maybeTimeBasedMicrocompact）
//   cache        写摘要的请求怎样借用主对话的缓存？
//   compact      压缩之后的请求里剩下什么？它在会话文件里是怎么记的？
//   breaker      摘要连续失败、压缩完又很快满了，各自怎样停下来？（运行真正的 autoCompactIfNeeded）
//
//   node --disable-warning=ExperimentalWarning labs/chapters/05-sessions-compaction.mjs              全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/05-sessions-compaction.mjs resume       只运行一个
import { lesson, ROOT } from "./harness.mjs";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Session, projectHistory, restore } from "../../coda/src/session.mjs";
import {
  Compactor,
  CLEARED,
  buildPostCompact,
  effectiveWindow,
  estimate,
  formatSummary,
  microcompact,
  summaryRequest,
  threshold,
} from "../../coda/src/compact.mjs";
import { buildRequest } from "../../coda/src/request.mjs";
import { upstream } from "../engineering/run.mjs";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;
const plain = (value) => JSON.parse(JSON.stringify(value)); // 去掉 vm 沙箱里的原型，便于比较
const recording = (name) =>
  JSON.parse(readFileSync(join(ROOT, "labs/ch05/recorded", `${name}.json`), "utf8"));

await lesson(5, "会话与压缩", async (t) => {
  // ───────────────────────── 一、会话文件 ─────────────────────────
  if (wants("session")) {
    t.log("一、会话文件：一棵只追加的树");
    t.log();
    const file = join(t.root, "session.jsonl");
    const session = new Session(file);
    const U0 = session.append({ role: "user", text: "读一下 slug.js" });
    const A0 = session.append({ role: "assistant", text: "它导出 slugify" });
    const U1 = session.append({ role: "user", text: "用 Python 重写" });
    const A1 = session.append({ role: "assistant", text: "已用 Python 重写" });
    // 觉得不对，回到 A0，换一个方向
    session.branch(A0);
    const U2 = session.append({ role: "user", text: "保持 JS，给它加上类型" });
    const A2 = session.append({ role: "assistant", text: "已加上类型标注" });

    const label = new Map([U0, A0, U1, A1, U2, A2].map((id, i) => [id, `r${i + 1}`]));
    const onBranch = new Set(session.history().map((m) => m.text));
    const rows = session.log.read();
    t.log("文件里的每一行（回退没有删除任何东西）：");
    t.table(
      rows.map((row) => ({
        行: label.get(row.id),
        parent: label.get(row.parent) ?? "—",
        角色: row.message.role,
        内容: row.message.text,
        在当前分支上: onBranch.has(row.message.text) ? "是" : "否",
      })),
    );
    t.equal("文件有 6 行，回退一行都没少", rows.length, 6);
    t.equal(
      "当前分支只含走过的那条路",
      session.history().map((m) => m.text),
      ["读一下 slug.js", "它导出 slugify", "保持 JS，给它加上类型", "已加上类型标注"],
    );
    t.equal("A0 有两个孩子，所以有两个叶子", session.leaves().length, 2);
    t.equal(
      "旧分支用它的叶子仍然取得回来",
      session.history(A1).map((m) => m.text).at(-1),
      "已用 Python 重写",
    );

    // 重新打开：叶子指针没有单独存，最后写下的那一行就是叶子
    const reopened = new Session(file);
    t.equal("重新打开，当前分支是最后写入的那一支", reopened.history(), session.history());

    // 分叉成独立会话（--fork-session）
    const forkFile = join(t.root, "forked.jsonl");
    const fork = session.fork(forkFile);
    fork.append({ role: "user", text: "再加一个单元测试" });
    t.equal("分叉出来的会话有自己的文件", [fork.log.read().length, session.log.read().length], [5, 6]);

    // 崩溃：写到一半进程被杀，文件末尾多了半行
    t.log();
    t.log("崩溃与修复（文件末尾写了半行）：");
    const state = () => {
      const scan = session.log.scan();
      return { 完整记录: scan.records.length, 文件字节: statSync(file).size, 末尾有残缺: scan.tail ? "有" : "没有" };
    };
    const before = state();
    appendFileSync(file, '{"seq":7,"prev":"ab12","value":{"id":"half');
    const torn = state();
    const afterCrash = new Session(file); // 重新打开不会失败
    afterCrash.append({ role: "user", text: "崩溃之后继续" });
    const repaired = state();
    t.table([
      { 时刻: "崩溃前", ...before },
      { 时刻: "崩溃后（半行）", ...torn },
      { 时刻: "重新打开并追加一条后", ...repaired },
    ]);
    t.equal("残缺的尾巴被识别，完整记录一条没丢", [before.完整记录, torn.完整记录], [6, 6]);
    t.equal("追加前先截掉残缺的尾巴，新记录接在完整记录后面", repaired.完整记录, 7);
    t.equal("修复后末尾干净", repaired.末尾有残缺, "没有");

    // 中间被改过则不是崩溃，而是出了更严重的事：拒绝继续
    const text = readFileSync(file, "utf8").split("\n");
    text[2] = text[2].replace("Python", "Rust  ");
    writeFileSync(file, text.join("\n"));
    t.throws("中间的记录被改过：哈希链校验拒绝加载", () => new Session(file), /integrity/);
    t.log();
  }

  // ───────────────────────── 二、恢复时的整理 ─────────────────────────
  if (wants("resume")) {
    t.log("二、恢复一个被打断的会话");
    t.log();
    const call = (id, name = "Read") => ({ id, name, input: { path: `${id}.txt` } });
    const A = (text, ...calls) => ({ role: "assistant", text, ...(calls.length ? { calls } : {}) });
    const T = (id, text = "ok") => ({ role: "tool", id, text });
    const U = (text) => ({ role: "user", text });
    const scenarios = [
      ["上一轮正常结束", [U("读 a"), A("", call("c1")), T("c1"), A("读完了")]],
      ["提问发出去，进程就被杀了", [U("读 a"), A("", call("c1")), T("c1"), A("读完了"), U("再读 b")]],
      ["调用写进文件，结果还没来", [U("读 a 和 b"), A("先读两个文件", call("c1"), call("c2"))]],
      ["两个调用只有一个有结果", [U("读 a 和 b"), A("", call("c1"), call("c2")), T("c1")]],
      ["工具都跑完了，模型还没看到", [U("读 a"), A("", call("c1")), T("c1")]],
    ];

    // 原版按内容块存记录：文字、每个 tool_use 各占一条；merged 是发给 API 之前合并后的样子。
    const toOriginal = (history, { merge = false } = {}) => {
      const out = [];
      history.forEach((m, i) => {
        if (m.role === "user") return out.push({ type: "user", message: { content: m.text } });
        if (m.role === "tool") {
          const block = { type: "tool_result", tool_use_id: m.id, content: m.text };
          const last = out.at(-1);
          if (merge && last?.type === "user" && Array.isArray(last.message.content)) last.message.content.push(block);
          else out.push({ type: "user", message: { content: [block] } });
          return;
        }
        const blocks = [
          ...(m.text ? [{ type: "text", text: m.text }] : []),
          ...(m.calls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
        ];
        if (merge) out.push({ type: "assistant", message: { id: `m${i}`, content: blocks } });
        else for (const block of blocks) out.push({ type: "assistant", message: { id: `m${i}`, content: [block] } });
      });
      return out;
    };
    const isToolResult = (m) =>
      Array.isArray(m.message.content) && m.message.content.some((b) => b.type === "tool_result");
    const filterUnresolved = upstream("unresolved-tool-uses", "filterUnresolvedToolUses");
    const detect = upstream("detect-turn-interruption", "detectTurnInterruption", {
      isToolUseResultMessage: isToolResult,
      isTerminalToolResult: () => false,
    });
    const brief = (m) =>
      m.role === "assistant" ? `A${m.calls ? `(${m.calls.map((c) => c.id)})` : ""}` : m.role === "tool" ? `T(${m.id})` : "U";

    const outcomes = scenarios.map(([name, history]) => {
      const { messages, interruption } = restore(history);
      const original = filterUnresolved(toOriginal(history));
      return { name, history, messages, interruption, original, kind: detect(original).kind };
    });
    t.table(
      outcomes.map((o) => ({
        场景: o.name,
        文件里: o.history.map(brief).join(" "),
        "coda 的判断": o.interruption,
        恢复后的消息: o.messages.map(brief).join(" "),
        "原函数过滤后的记录数": o.original.length,
        "原函数的判断": o.kind,
      })),
    );
    for (const o of outcomes)
      t.equal(`「${o.name}」：coda 与原函数对上一轮状态的判断一致`, o.interruption, o.kind);

    // 第二层：每次请求之前的配对修复。这一层补出来的东西不会被存回文件。
    t.log("每次请求之前的配对修复（工具调用必须有结果，结果必须有调用）：");
    const pairing = upstream("tool-result-pairing", "ensureToolResultPairing", {
      SYNTHETIC_TOOL_RESULT_PLACEHOLDER: "[original placeholder]",
      createUserMessage: ({ content }) => ({ type: "user", message: { content } }),
      NO_CONTENT_MESSAGE: "(no content)",
      checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
      smooshSystemReminderSiblings: (m) => m,
      getStrictToolResultPairing: () => false,
      logEvent() {},
      logError() {},
    });
    const resultsOf = (messages) =>
      messages.flatMap((m) => (Array.isArray(m.message.content) ? m.message.content : []))
        .filter((b) => b.type === "tool_result")
        .map((b) => `${b.tool_use_id}${b.is_error ? "(错误)" : ""}`);
    const broken = [
      ["缺一个结果", [U("读"), A("", call("c1"), call("c2")), T("c1")]],
      ["多一个孤立的结果", [U("读"), A("", call("c1")), T("c1"), T("zzz", "stray")]],
    ];
    const repaired = broken.map(([name, history]) => {
      const mineIds = projectHistory(history)
        .filter((m) => m.role === "tool")
        .map((m) => `${m.id}${m.error ? "(错误)" : ""}`);
      const theirIds = resultsOf(plain(pairing(toOriginal(history, { merge: true }))));
      return { name, history, mineIds, theirIds };
    });
    t.table(
      repaired.map((r) => ({
        场景: r.name,
        文件里的结果: r.history.filter((m) => m.role === "tool").map((m) => m.id).join(" "),
        "coda 请求里的结果": r.mineIds.join(" "),
        "原函数请求里的结果": r.theirIds.join(" "),
      })),
    );
    for (const r of repaired) {
      t.equal(`「${r.name}」：coda 的投影与原函数留下同一组结果`, [...r.mineIds].sort(), [...r.theirIds].sort());
      t.equal(`「${r.name}」：投影只改请求，文件里的历史原样`, r.history.length, r.name === "缺一个结果" ? 3 : 4);
    }
    t.log();
  }

  // ───────────────────────── 三、触发线 ─────────────────────────
  if (wants("threshold")) {
    t.log("三、自动压缩的触发线");
    t.log();
    // 原函数：有效窗口 = 窗口 − min(模型最大输出, 20000)；触发线 = 有效窗口 − 13000。
    // 端口：模型的窗口和最大输出换成可调的数字，环境变量换成给定的对象。
    const original = (window, env = {}) => {
      const effective = upstream("effective-window", "getEffectiveContextWindowSize", {
        getMaxOutputTokensForModel: () => 32_000,
        MAX_OUTPUT_TOKENS_FOR_SUMMARY: 20_000,
        getContextWindowForModel: () => window,
        getSdkBetas: () => [],
        process: { env },
      });
      const trigger = upstream("compact-threshold", "getAutoCompactThreshold", {
        getEffectiveContextWindowSize: effective,
        AUTOCOMPACT_BUFFER_TOKENS: 13_000,
        process: { env },
      });
      return { effective: effective("model"), trigger: trigger("model") };
    };
    const mine = (window, percent) => {
      const effective = effectiveWindow(window, 32_000);
      return { effective, trigger: threshold(effective, 13_000, percent) };
    };

    const windows = [200_000, 1_000_000, 75_000, 60_000];
    const lines = windows.map((window) => ({ window, theirs: original(window), mine: mine(window) }));
    t.table(
      lines.map(({ window, theirs }) => ({
        模型窗口: window,
        "有效窗口（−20000）": theirs.effective,
        "触发线（−13000）": theirs.trigger,
        占窗口的比例: `${((theirs.trigger / window) * 100).toFixed(1)}%`,
      })),
    );
    for (const { window, theirs, mine } of lines)
      t.equal(`窗口 ${window}：coda 与原函数的有效窗口、触发线一致`, mine, theirs);

    t.log("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 只能让触发线更低（模型窗口 200000，有效窗口 180000）：");
    const overrides = [undefined, "50", "100", "0", "abc"].map((value) => ({
      value,
      theirs: original(200_000, value === undefined ? {} : { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: value }),
      mine: mine(200_000, value),
    }));
    t.table(overrides.map(({ value, theirs }) => ({ 覆盖值: value ?? "(未设置)", 触发线: theirs.trigger })));
    for (const { value, theirs, mine } of overrides)
      t.equal(`覆盖值 ${value ?? "(未设置)"}：coda 与原函数一致`, mine.trigger, theirs.trigger);

    // 两份录制（Claude Code 2.1.296，窗口用环境变量调小）能不能和这个公式对上？
    const auto = recording("4-auto");
    const total = (u = {}) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const mainRequests = auto.requests.filter((q) => q.tools.length && !q.path.includes("count_tokens"));
    const lastQuiet = mainRequests.find((q) => q.id === 8);
    const boundary = auto.events.find((e) => e.subtype === "compact_boundary").compact_metadata;
    const trigger = original(auto.window).trigger;
    t.log(`窗口 ${auto.window} 的录制：第 8 个请求的输入是 ${total(lastQuiet.response.usage)} token，之后读入 delta.js，上下文到 ${boundary.pre_tokens} 时压缩。`);
    t.log(`公式给出的触发线是 ${trigger}：落在 (${total(lastQuiet.response.usage)}, ${boundary.pre_tokens}] 之间。`);
    t.ok("录制没触发的最大值 < 公式 ≤ 触发时的值", total(lastQuiet.response.usage) < trigger && trigger <= boundary.pre_tokens);
    const thrash = recording("5-thrash");
    const firstPre = thrash.events.find((e) => e.subtype === "compact_boundary").compact_metadata.pre_tokens;
    t.ok(`窗口 ${thrash.window}：第一次压缩时的 ${firstPre} 超过触发线 ${original(thrash.window).trigger}`, firstPre >= original(thrash.window).trigger);
    t.log();
  }

  // ───────────────────────── 四、微压缩 ─────────────────────────
  if (wants("microcompact")) {
    t.log("四、微压缩：不请求模型的压缩");
    t.log();
    const NOW = Date.parse("2026-11-04T12:00:00Z");
    // 原函数：时间触发的微压缩。时钟换成固定的，配置换成“已开启，闲置 60 分钟，保留最近 5 个”。
    const withClock = (now) => class extends Date { static now() { return now; } };
    const originalMicro = (now) => {
      const evaluate = upstream("time-based-trigger", "evaluateTimeBasedTrigger", {
        getTimeBasedMCConfig: () => ({ enabled: true, gapThresholdMinutes: 60, keepRecent: 5 }),
        isMainThreadSource: upstream("main-thread-source", "isMainThreadSource"),
        Date: withClock(now),
        Number,
      });
      return upstream("time-based-microcompact", "maybeTimeBasedMicrocompact", {
        evaluateTimeBasedTrigger: evaluate,
        collectCompactableToolIds: upstream("compactable-tool-ids", "collectCompactableToolIds", {
          COMPACTABLE_TOOLS: new Set(["Read", "Bash", "Grep", "Glob", "WebSearch", "WebFetch", "Edit", "Write"]),
        }),
        calculateToolResultTokens: upstream("tool-result-tokens", "calculateToolResultTokens", {
          roughTokenCountEstimation: (s) => Math.round(s.length / 4),
          IMAGE_MAX_TOKEN_SIZE: 2000,
        }),
        TIME_BASED_MC_CLEARED_MESSAGE: "[original placeholder]",
        logEvent() {}, logForDebugging() {}, suppressCompactWarning() {}, resetMicrocompactState() {},
        notifyCacheDeletion() {}, feature: () => false, Math,
      });
    };

    // 8 轮工具调用：t1～t7 是 Read，t8 是 Agent（不在可压缩的名单里）
    const rounds = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i + 1}`,
      name: i === 7 ? "Agent" : "Read",
      result: `第 ${i + 1} 个结果：${"x".repeat(400 * (i + 1))}`,
    }));
    const coda = [{ role: "user", text: "开始" }].concat(
      rounds.flatMap((r) => [
        { role: "assistant", calls: [{ id: r.id, name: r.name, input: {} }] },
        { role: "tool", id: r.id, text: r.result },
      ]),
    );
    const lastAssistantAt = (idleMinutes) => NOW - idleMinutes * 60_000;
    const theirsFor = (idleMinutes) =>
      rounds.flatMap((r, i) => [
        { type: "assistant", timestamp: new Date(lastAssistantAt(idleMinutes) - (8 - i) * 1000).toISOString(), message: { content: [{ type: "tool_use", id: r.id, name: r.name, input: {} }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: r.id, content: r.result }] } },
      ]);
    const clearedIds = (messages, placeholder) =>
      messages.filter((m) => (m.role === "tool" ? m.text === placeholder : false)).map((m) => m.id);

    const runs = [5, 59, 61, 180].map((idle) => {
      const original = originalMicro(NOW)(theirsFor(idle), "repl_main_thread");
      const theirs = original
        ? plain(original.messages).filter((m) => m.type === "user").flatMap((m) => m.message.content)
            .filter((b) => b.content === "[original placeholder]").map((b) => b.tool_use_id)
        : [];
      const result = microcompact(coda, { idleMs: idle * 60_000 });
      return { idle, theirs, mine: clearedIds(result.messages, CLEARED), saved: result.savedTokens };
    });
    t.table(
      runs.map((r) => ({
        闲置: `${r.idle} 分钟`,
        原函数清掉的: r.theirs.join(" ") || "（没触发）",
        "coda 清掉的": r.mine.join(" ") || "（没触发）",
        "coda 估算省下": r.saved ? `${r.saved} token` : "—",
      })),
    );
    for (const r of runs) t.equal(`闲置 ${r.idle} 分钟：coda 与原函数清掉同一批结果`, r.mine, r.theirs);
    const after = microcompact(coda, { idleMs: 61 * 60_000 }).messages;
    t.equal("保留的是最近 5 个可压缩结果，以及不在名单里的 Agent 结果", after.filter((m) => m.role === "tool" && m.text !== CLEARED).map((m) => m.id), ["t3", "t4", "t5", "t6", "t7", "t8"]);
    t.equal("微压缩没有改传入的历史", coda.filter((m) => m.text === CLEARED).length, 0);
    t.log();
  }

  // ───────────────────────── 五、摘要请求与缓存 ─────────────────────────
  if (wants("cache")) {
    t.log("五、写摘要的请求怎样借用缓存");
    t.log();
    const read = { name: "Read", description: "Read a file", schema: { type: "object", properties: { path: { type: "string" } } } };
    const edit = { name: "Edit", description: "Edit a file", schema: { type: "object", properties: { path: { type: "string" } } } };
    const history = [];
    for (let i = 1; i <= 6; i++)
      history.push(
        { role: "user", text: `第 ${i} 步：看看 file${i}.js` },
        { role: "assistant", text: "", calls: [{ id: `c${i}`, name: "Read", input: { path: `file${i}.js` } }] },
        { role: "tool", id: `c${i}`, text: `// file${i}.js\n${"export const value = 1;\n".repeat(40)}` },
      );
    const main = buildRequest(history, {
      prompt: { defaults: ["You are a coding agent. Follow the project rules."] },
      tools: [read, edit],
    });
    const instruction = "Summarize the conversation so far. Do not call any tools.";

    // 做法 A（Claude Code）：同一个请求，末尾追加一条指令
    const shared = summaryRequest(main, instruction);
    // 做法 B（Pi）：把旧对话序列化成文字，配一个专门写摘要的系统提示，不带工具
    const separate = {
      system: ["You summarize conversations. Output only the summary."],
      tools: [],
      messages: [{ role: "user", text: `<conversation>\n${main.messages.map((m) => `${m.role}: ${m.text ?? ""}`).join("\n")}\n</conversation>\n${instruction}` }],
    };

    // 缓存按“工具 → 系统提示 → 消息”的顺序匹配前缀：从头开始逐段比较，第一处不同之后全部要重新处理
    const segments = (wire) => [
      ...wire.tools.map((x) => ["tool", JSON.stringify(x)]),
      ...wire.system.map((x) => ["system", x]),
      ...wire.messages.map((x) => ["message", JSON.stringify(x)]),
    ];
    const reference = segments(main);
    const overlap = (wire) => {
      const mine = segments(wire);
      let same = 0;
      let cached = 0;
      while (same < mine.length && same < reference.length && mine[same][1] === reference[same][1]) cached += estimate(mine[same++][1]);
      const total = mine.reduce((sum, [, text]) => sum + estimate(text), 0);
      return { same, cached, total };
    };
    const rows = [
      ["主请求自己（对照）", main],
      ["A. 重发主请求 + 追加一条指令", shared],
      ["B. 序列化成文字，另配系统提示", separate],
    ].map(([name, wire]) => {
      const o = overlap(wire);
      return {
        做法: name,
        "与主请求逐字相同的前缀": `${o.same} 段`,
        "命中缓存的 token（估算）": o.cached,
        "全部输入": o.total,
        "命中比例": `${Math.round((100 * o.cached) / o.total)}%`,
      };
    });
    t.table(rows);
    const a = overlap(shared);
    const b = overlap(separate);
    t.ok("A 只有最后追加的那一段不在缓存里", a.same === reference.length);
    t.ok("A 的命中比例在 90% 以上", a.cached / a.total > 0.9);
    t.equal("B 从第一段（工具）就对不上，缓存一点也用不上", b.cached, 0);
    t.equal("A 的工具定义照样发送（去掉它们，整个前缀都变）", shared.tools.length, 2);
    t.log();
  }

  // ───────────────────────── 六、压缩之后剩下什么 ─────────────────────────
  if (wants("compact")) {
    t.log("六、压缩之后，请求里剩下什么");
    t.log();
    const workspace = join(t.root, "ws");
    mkdirSync(workspace);
    const files = {
      "slug.js": "module.exports = (s) => s.trim().replace(/ /g, '-');\n",
      "test.js": "const assert = require('node:assert/strict');\nassert.equal(require('./slug.js')(' a  b '), 'a-b');\n",
      "build.log": "warning: something noisy\n".repeat(900), // 约 5400 token，超过单个文件的 5000
      "README.md": "# slug\n\nUsage: slug(' a b ')\n",
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(workspace, name), text);
    const R = (id, path) => ({ id, name: "Read", input: { path } });
    const history = [
      { role: "user", text: "修一下 slug 的 bug：多个空格要合成一个横线" },
      { role: "assistant", text: "先看相关文件", calls: [R("c1", "slug.js"), R("c2", "test.js"), R("c3", "build.log")] },
      { role: "tool", id: "c1", text: files["slug.js"] },
      { role: "tool", id: "c2", text: files["test.js"] },
      { role: "tool", id: "c3", text: files["build.log"] },
      { role: "assistant", text: "正则只匹配单个空格", calls: [{ id: "c4", name: "Edit", input: { path: "slug.js", old: "/ /g", next: "/ +/g" } }] },
      { role: "tool", id: "c4", text: "edited slug.js" },
      { role: "assistant", text: "", calls: [{ id: "c5", name: "Test", input: { path: "test.js" } }] },
      { role: "tool", id: "c5", text: "tests passed" },
      { role: "user", text: "好，再把 README 里的用法也检查一下" },
      { role: "assistant", text: "", calls: [R("c6", "README.md")] },
      { role: "tool", id: "c6", text: files["README.md"] },
    ];

    const seen = [];
    const compactor = new Compactor({
      window: 1000, // 很小的窗口，让这段历史超过触发线
      buffer: 0,
      summarize: async (old, options) => {
        seen.push({ messages: old.length, instructions: options.instructions });
        return "<analysis>先按时间顺序过一遍……</analysis>\n<summary>\n1. 任务：修 slug.js，多个空格合成一个横线\n2. 已完成：正则改成 / +/g，test.js 通过\n3. 文件：slug.js（已改）、test.js、build.log\n</summary>";
      },
      readFile: (path) => {
        try { return readFileSync(join(workspace, path), "utf8"); } catch { return undefined; }
      },
    });
    const hook = { role: "user", text: "[SessionStart hook] 项目约定：改完要跑 test.js" };
    const result = await compactor.compact(history, { hookResults: [hook], transcript: "~/.claude/projects/demo/session.jsonl", instructions: "重点保留文件和测试" });

    const origin = (m, index) => {
      if (index === 0) return "摘要";
      if (m.restored) return m.text.startsWith("[file reference]") ? "重新附上（只有路径）" : "重新附上（全文）";
      if (m === hook || m.text === hook.text) return "SessionStart Hook 的结果";
      return "原样保留";
    };
    const brief = (m) => {
      const head = (m.text || (m.calls ? `调用 ${m.calls.map((c) => `${c.name}(${c.input.path ?? ""})`)}` : m.id ? `结果 ${m.id}` : "")).replace(/\n/g, " ");
      return head.length > 46 ? head.slice(0, 46) + "…" : head;
    };
    t.log(`压缩前 ${history.length} 条消息，约 ${estimate(history)} token；触发线 ${compactor.limit()}。压缩后：`);
    t.table(
      result.messages.map((m, i) => ({
        "#": i,
        角色: m.role,
        来自: origin(m, i),
        内容: brief(m),
        "约 token": estimate(m),
      })),
    );
    t.log(`压缩后 ${result.messages.length} 条，约 ${result.tokensAfter} token。写摘要的模型收到 ${seen[0].messages} 条旧消息，用户的侧重点“${seen[0].instructions}”随请求一起交给了它。`);

    t.equal("消息顺序：摘要 → 保留的 → 重新附上的 → Hook", result.messages.map((m, i) => origin(m, i)), ["摘要", "原样保留", "原样保留", "原样保留", "重新附上（只有路径）", "重新附上（全文）", "重新附上（全文）", "SessionStart Hook 的结果"]);
    t.equal("当前回合（最后一条用户消息起）原样保留：提问、调用、结果", result.messages.slice(1, 4), history.slice(9));
    t.equal("重新附上最近读过的文件，最近的在前；README 在保留的消息里，不重复附上", result.restored, ["build.log", "test.js", "slug.js"]);
    t.ok("超过 5000 token 的 build.log 只给路径", result.messages.some((m) => m.restored === "build.log" && m.text.startsWith("[file reference]")));
    t.ok("较小的文件重新读磁盘，附全文", result.messages.some((m) => m.restored === "slug.js" && m.text.includes("replace(/ /g")));
    t.ok("摘要的 <analysis> 草稿没有进入上下文", !result.messages[0].text.includes("先按时间顺序"));
    t.ok("摘要末尾告诉模型完整记录在哪", result.messages[0].text.includes("session.jsonl"));
    t.ok("压缩后明显变小", result.tokensAfter < estimate(history));

    // 对照原函数：重建的顺序，以及 <analysis> 的剥离
    const rebuild = upstream("compact-rebuild", "buildPostCompactMessages");
    const labelled = plain(rebuild({ boundaryMarker: "边界", summaryMessages: ["摘要"], messagesToKeep: ["保留"], attachments: ["附件"], hookResults: ["Hook"] }));
    const mine = buildPostCompact({ summary: "摘要", kept: ["保留"], attachments: ["附件"], hookResults: ["Hook"] });
    t.equal("重建顺序与 buildPostCompactMessages 一致（原版多一个模型看不到的边界标记）", mine, labelled.slice(1));
    const originalFormat = upstream("format-compact-summary", "formatCompactSummary");
    const raw = "<analysis>草稿</analysis>\n\n<summary>\n1. 请求\n2. 进展\n</summary>";
    t.equal("摘要的格式化与 formatCompactSummary 一致", formatSummary(raw), originalFormat(raw));
    t.log();

    // 会话文件里的样子：压缩是一个新的根，旧记录一条没删
    t.log("压缩在会话文件里的样子：");
    const session = new Session(join(t.root, "compacted.jsonl"));
    for (const m of history) session.append(m);
    const oldLeaf = session.head;
    const rowsBefore = session.log.read().length;
    session.appendCompaction(result.messages);
    const rows = session.log.read();
    t.table([
      { 项目: "文件里的记录", 压缩前: rowsBefore, 压缩后: rows.length },
      { 项目: "当前分支（发给模型的）", 压缩前: history.length, 压缩后: session.history().length },
      { 项目: "用旧叶子取回的完整历史", 压缩前: history.length, 压缩后: session.history(oldLeaf).length },
    ]);
    const root = rows[rowsBefore];
    t.equal("压缩边界是一个新的根（parent 为空），logicalParent 指回旧叶子", [root.parent, root.logicalParent === oldLeaf], [null, true]);
    t.equal("压缩后的当前分支就是压缩后的消息", session.history(), plain(result.messages));
    t.equal("旧记录一条没少：用旧叶子仍能取回压缩前的完整历史", session.history(oldLeaf), history);
    t.equal("重新打开文件，恢复的是压缩之后的视图", new Session(join(t.root, "compacted.jsonl")).history().length, result.messages.length);
    t.log();
  }

  // ───────────────────────── 七、两种停下来的办法 ─────────────────────────
  if (wants("breaker")) {
    t.log("七、压缩失败、压缩完又很快满了");
    t.log();
    // (a) 摘要连续失败：运行真正的 autoCompactIfNeeded，compactConversation 换成一定失败的函数
    let upstreamCalls = 0;
    const autoCompact = upstream("compact-breaker", "autoCompactIfNeeded", {
      isEnvTruthy: () => false,
      process: { env: {} },
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES: 3,
      shouldAutoCompact: async () => true,
      getAutoCompactThreshold: () => 100,
      trySessionMemoryCompaction: async () => null,
      setLastSummarizedMessageId() {},
      runPostCompactCleanup() {},
      feature: () => false,
      notifyCompaction() {},
      markPostCompaction() {},
      compactConversation: async () => { upstreamCalls++; throw Error("summary offline"); },
      logError() {},
      hasExactErrorMessage: () => false,
      ERROR_MESSAGE_USER_ABORT: "aborted",
      logForDebugging() {},
    });
    let tracking;
    const context = { options: { mainLoopModel: "model" } };

    let summaryCalls = 0;
    const failing = new Compactor({ window: 100, buffer: 0, summarize: async () => { summaryCalls++; throw Error("summary offline"); } });
    const long = [
      { role: "user", text: "old ".repeat(300) },
      { role: "assistant", text: "done" },
      { role: "user", text: "next" },
    ];
    const attempts = [];
    for (let turn = 1; turn <= 5; turn++) {
      const before = { upstream: upstreamCalls, coda: summaryCalls };
      const outcome = await autoCompact([], context, {}, "repl_main_thread", tracking, 0);
      if (outcome.consecutiveFailures !== undefined) tracking = { compacted: false, turnId: "", turnCounter: 0, consecutiveFailures: outcome.consecutiveFailures };
      const mine = await failing.compact(long);
      attempts.push({
        第几圈: turn,
        "原版：请求了摘要吗": upstreamCalls > before.upstream ? "请求了，失败" : "没有（熔断）",
        "原版：连续失败": tracking?.consecutiveFailures ?? 0,
        "coda：请求了摘要吗": summaryCalls > before.coda ? "请求了，失败" : "没有（熔断）",
        "coda：返回": mine.reason,
      });
    }
    t.table(attempts);
    t.equal("原版：前三圈请求了摘要，之后不再请求", upstreamCalls, 3);
    t.equal("coda：同样前三圈，之后不再请求", summaryCalls, 3);
    t.equal("熔断之后 coda 的返回原因", (await failing.compact(long)).reason, "circuit-open");
    t.equal("手动压缩（force）不受熔断限制", (await failing.compact(long, { force: true })).reason, "summary-failed");

    // (b) 压缩成功，但每一圈都立刻又满了。2.1.88 的源码里没有对付它的东西，录制的 2.1.296 有
    t.log();
    t.log("压缩完又很快满了（每一圈模型都读一个大文件）：");
    const bigRound = (i) => [
      { role: "assistant", text: "", calls: [{ id: `r${i}`, name: "Read", input: { path: `f${i}.js` } }] },
      { role: "tool", id: `r${i}`, text: `// f${i}.js\n${"x".repeat(2600)}` },
    ];
    const simulate = async (refillGuard) => {
      let summaries = 0;
      const compactor = new Compactor({ window: 1000, buffer: 0, refillGuard, summarize: async () => { summaries++; return "short summary"; } });
      let messages = [{ role: "user", text: "读完 8 个文件" }];
      const log = [];
      for (let turn = 1; turn <= 8; turn++) {
        messages = [...messages, ...bigRound(turn)];
        const outcome = await compactor.compact(messages);
        log.push(outcome.changed ? "压缩" : outcome.reason === "rapid-refill" ? "停下" : "—");
        if (outcome.changed) messages = outcome.messages;
        if (outcome.reason === "rapid-refill") break;
      }
      return { summaries, log };
    };
    const off = await simulate(undefined);
    const on = await simulate({ within: 3, times: 3 });
    t.table([
      { 保护: "没有（2.1.88 的源码）", 每一圈的结果: off.log.join(" → "), 付了几次摘要的钱: off.summaries },
      { 保护: "refillGuard {within: 3, times: 3}", 每一圈的结果: on.log.join(" → "), 付了几次摘要的钱: on.summaries },
    ]);
    t.equal("没有保护：从第 2 圈起圈圈压缩，8 圈付了 7 次摘要的钱", off.summaries, 7);
    t.equal("有保护：压缩 3 次后停下，不再付摘要的钱", [on.summaries, on.log.at(-1)], [3, "停下"]);
    t.log();
  }
});
