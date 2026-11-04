// 第 3 章实验：工具执行。五个小实验，各回答一个问题：
//   batches     一条回复里的多个调用，怎么分批？和 Pi / mox 有什么不同？
//   streaming   模型还没说完就开始执行，是怎么安排的？（运行 Claude Code 里真正的 StreamingToolExecutor）
//   pipeline    一个调用要过哪几道关？每一种失败停在哪一关？
//   file-state  “先读后改”到底在检查什么？
//   big-output  大输出怎么处理？
//
//   node --disable-warning=ExperimentalWarning labs/chapters/03-tools.mjs              全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/03-tools.mjs pipeline     只运行一个
import { lesson, ROOT } from "./harness.mjs";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { codingTools } from "../../coda/src/files.mjs";
import { Toolset, partition } from "../../coda/src/tools.mjs";
import { upstream } from "../engineering/run.mjs";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOX = process.env.MOX_SRC ?? join(ROOT, "../learn-pi-agent");

await lesson(3, "工具执行：分批、关卡、文件版本与大输出", async (t) => {
  // ───────────────────────── 一、分批 ─────────────────────────
  if (wants("batches")) {
    t.log("一、一条回复里的多个调用，怎么分批");
    t.log();
    const workspace = join(t.root, "batches");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "a.txt"), "old");
    const coda = new Map(codingTools(workspace).map((tool) => [tool.name, tool]));

    // 四种调用：正常的 Read、Edit，路径写成数字的 Read（参数解析不了），不存在的工具。
    const kinds = {
      Read: { name: "Read", input: { path: "a.txt" } },
      Edit: { name: "Edit", input: { path: "a.txt", old: "old", next: "new" } },
      "Read(坏参数)": { name: "Read", input: { path: 42 } },
      "Nope(未知工具)": { name: "Nope", input: {} },
    };
    const sequence = (labels) =>
      labels.map((label, idx) => ({ ...kinds[label], label, idx }));

    // 原版 partitionToolCalls：从固定提交里装载，只替换它依赖的“工具目录”。
    // 这里的目录用和 coda 同样的判断来回答“输入能解析吗”“这个工具并发安全吗”。
    const catalogue = {
      Read: {
        inputSchema: {
          safeParse: (input) =>
            typeof input.path === "string"
              ? { success: true, data: input }
              : { success: false },
        },
        isConcurrencySafe: () => true,
      },
      Edit: {
        inputSchema: { safeParse: (input) => ({ success: true, data: input }) },
        isConcurrencySafe: () => false,
      },
    };
    const original = upstream("tool-partition", "partitionToolCalls", {
      findToolByName: (_, name) => catalogue[name],
    });
    const originalGroups = (calls) =>
      original(calls, { options: { tools: [] } }).map((batch) =>
        batch.blocks.map((call) => call.idx),
      );
    const codaGroups = (calls) =>
      partition(calls, (name) => coda.get(name)).map((batch) =>
        batch.calls.map((call) => call.idx),
      );
    const show = (groups, calls) =>
      groups.map((g) => `[${g.map((i) => calls[i].label).join(" ")}]`).join(" ");

    const samples = [
      ["Read", "Read", "Read"],
      ["Read", "Read", "Edit", "Read", "Read"],
      ["Read", "Edit", "Edit", "Read"],
      ["Read", "Nope(未知工具)", "Read"],
      ["Read", "Read(坏参数)", "Read"],
    ];
    t.table(
      samples.map((labels) => {
        const calls = sequence(labels);
        return {
          调用序列: labels.join(" "),
          "Claude Code 原函数": show(originalGroups(calls), calls),
          "coda 的 partition": show(codaGroups(calls), calls),
          "Pi / mox（整批同时开始）": `[${labels.join(" ")}]`,
        };
      }),
    );

    // 不挑样本：四种调用拼成长度 1 到 5 的全部序列，逐个比较。
    const labels = Object.keys(kinds);
    let total = 0;
    let different = 0;
    const walk = (prefix) => {
      if (prefix.length) {
        total++;
        const calls = sequence(prefix);
        if (JSON.stringify(originalGroups(calls)) !== JSON.stringify(codaGroups(calls)))
          different++;
      }
      if (prefix.length < 5) for (const label of labels) walk([...prefix, label]);
    };
    walk([]);
    t.log(`把四种调用拼成长度 1～5 的全部 ${total} 种序列，coda 的分批与原函数不同的有 ${different} 种。`);
    t.log();
    t.equal(`coda 与原函数在 ${total} 种调用序列上分批一致`, different, 0);

    // 分批要保护的是什么：同一条回复 Read、Edit、Read，最后那个 Read 应该看到改过的内容。
    const outcome = [];
    const trio = [
      { id: "1", name: "Read", input: { path: "a.txt" } },
      { id: "2", name: "Edit", input: { path: "a.txt", old: "old", next: "new" } },
      { id: "3", name: "Read", input: { path: "a.txt" } },
    ];
    const codaTools = new Toolset(codingTools(workspace));
    const results = await codaTools.runCalls(trio, { root: workspace });
    outcome.push({
      实现: "coda runCalls（相邻分批）",
      分批: show(codaGroups(sequence(["Read", "Edit", "Read"])), sequence(["Read", "Edit", "Read"])),
      "第 3 个调用（Read）读到": JSON.stringify(results[2].text),
      磁盘上最后是: JSON.stringify(readFileSync(join(workspace, "a.txt"), "utf8")),
    });

    try {
      const loop = await import(pathToFileURL(join(MOX, "mox/src/tools.ts")).href);
      const coding = await import(pathToFileURL(join(MOX, "mox/src/coding/index.ts")).href);
      const moxRoot = join(t.root, "mox");
      mkdirSync(moxRoot);
      writeFileSync(join(moxRoot, "a.txt"), "old\n");
      const { results: moxResults } = await loop.runTools(
        [
          { id: "1", name: "read", arguments: { path: "a.txt" } },
          { id: "2", name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] } },
          { id: "3", name: "read", arguments: { path: "a.txt" } },
        ],
        coding.createCodingTools(moxRoot),
        { emit() {} },
      );
      outcome.push({
        实现: "mox runTools（整批并发）",
        分批: "[read edit read]",
        "第 3 个调用（Read）读到": JSON.stringify(moxResults[2].content.trim()),
        磁盘上最后是: JSON.stringify(readFileSync(join(moxRoot, "a.txt"), "utf8").trim()),
      });
    } catch (error) {
      t.log(`（没有找到 learn-pi-agent 里的 mox，跳过对照：${error.code ?? error.message}）`);
    }
    t.table(outcome);
    t.equal("coda：Edit 之后的 Read 读到的是改过的内容", results[2].text, "new");
  }

  // ───────────────────────── 二、流式执行 ─────────────────────────
  if (wants("streaming")) {
    t.log("二、模型还没说完就开始执行：运行真正的 StreamingToolExecutor");
    t.log();
    // 执行器类取自固定提交，没有改动。我们只替换它依赖的外部东西：
    // 工具目录、造消息的函数，以及 runToolUse（换成会睡几毫秒再返回的假工具）。
    const tools = [
      ["Read", true],
      ["Edit", false],
      ["Bash", true],
    ].map(([name, safe]) => ({
      name,
      inputSchema: { safeParse: (input) => ({ success: true, data: input }) },
      isConcurrencySafe: () => safe,
    }));
    const createUserMessage = ({ content }) => ({
      type: "user",
      message: { role: "user", content },
    });
    const makeExecutor = (log) => {
      const Executor = upstream("streaming-executor", "StreamingToolExecutor", {
        AbortController,
        findToolByName: (list, name) => list.find((tool) => tool.name === name),
        createUserMessage,
        REJECT_MESSAGE: "rejected",
        withMemoryCorrectionHint: (text) => text,
        BASH_TOOL_NAME: "Bash",
        createChildAbortController: (parent) => {
          const child = new AbortController();
          parent.signal.addEventListener("abort", () => child.abort(parent.signal.reason), { once: true });
          return child;
        },
        markToolUseAsComplete() {},
        runToolUse: async function* (block, _assistant, _canUseTool, context) {
          const signal = context.abortController.signal;
          log.push(`开始 ${block.input.label}`);
          await Promise.race([
            sleep(block.input.ms),
            new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
          ]);
          const failed = !!block.input.fail && !signal.aborted;
          log.push(`${signal.aborted ? "中止" : "结束"} ${block.input.label}`);
          yield {
            message: createUserMessage({
              content: [
                {
                  type: "tool_result",
                  tool_use_id: block.id,
                  content: failed ? "boom" : "ok",
                  is_error: failed,
                },
              ],
            }),
          };
        },
      });
      const context = {
        abortController: new AbortController(),
        setInProgressToolUseIDs() {},
        setHasInterruptibleToolInProgress() {},
      };
      return new Executor(tools, async () => ({ behavior: "allow" }), context);
    };
    const block = (i, call) => ({ id: `t${i}`, name: call.name, input: call });
    const assistant = { uuid: "a", message: { id: "m" } };
    const resultOf = (update) => update.message.message.content[0];

    // 四个调用，每隔 10ms 到达一个，就像模型一个块一个块地说出来。
    const calls = [
      { name: "Read", label: "R1", ms: 120 },
      { name: "Read", label: "R2", ms: 20 },
      { name: "Edit", label: "E", ms: 30 },
      { name: "Read", label: "R3", ms: 20 },
    ];
    const log = [];
    const executor = makeExecutor(log);
    const yielded = [];
    for (const [i, call] of calls.entries()) {
      executor.addTool(block(i, call), assistant);
      await sleep(10);
      for (const update of executor.getCompletedResults()) yielded.push(resultOf(update).tool_use_id);
    }
    for await (const update of executor.getRemainingResults()) yielded.push(resultOf(update).tool_use_id);
    const position = (list, item) => list.indexOf(item) + 1;
    const startOrder = log.filter((line) => line.startsWith("开始")).map((line) => line.slice(3));
    const endOrder = log.filter((line) => line.startsWith("结束")).map((line) => line.slice(3));
    t.table(
      calls.map((call, i) => ({
        调用: `${call.label}（${call.name}，${call.ms}ms）`,
        并发安全: tools.find((tool) => tool.name === call.name).isConcurrencySafe() ? "是" : "否",
        到达: `第 ${i + 1} 个`,
        开始执行: `第 ${position(startOrder, call.label)} 个`,
        执行结束: `第 ${position(endOrder, call.label)} 个`,
        结果交回: `第 ${position(yielded, `t${i}`)} 个`,
      })),
    );
    t.equal("E 要等 R1、R2 都结束才开始，R3 排在 E 之后", log, [
      "开始 R1", "开始 R2", "结束 R2", "结束 R1", "开始 E", "结束 E", "开始 R3", "结束 R3",
    ]);
    t.equal("并发安全的调用先完成先交回；独占的 E 之后才轮到 R3", yielded, ["t1", "t0", "t2", "t3"]);

    // 一个调用出错，同时在跑的其他调用怎么办？
    const siblings = async (calls) => {
      const executor = makeExecutor([]);
      calls.forEach((call, i) => executor.addTool(block(i, call), assistant));
      const outcomes = [];
      for await (const update of executor.getRemainingResults()) {
        const result = resultOf(update);
        outcomes.push([result.tool_use_id, result.content.replace(/<\/?tool_use_error>/g, "")]);
      }
      return Object.fromEntries(outcomes);
    };
    const bashFails = await siblings([
      { name: "Bash", command: "make build", label: "B1", ms: 20, fail: true },
      { name: "Read", file_path: "a.txt", label: "R", ms: 150 },
      { name: "Bash", command: "npm test", label: "B2", ms: 150 },
    ]);
    const readFails = await siblings([
      { name: "Read", file_path: "a.txt", label: "R1", ms: 20, fail: true },
      { name: "Read", file_path: "b.txt", label: "R2", ms: 150 },
      { name: "Bash", command: "npm test", label: "B", ms: 150 },
    ]);
    t.table([
      { 场景: "Bash 先失败", 三个调用的结果: `${bashFails.t0} / ${bashFails.t1} / ${bashFails.t2}` },
      { 场景: "Read 先失败", 三个调用的结果: `${readFails.t0} / ${readFails.t1} / ${readFails.t2}` },
    ]);
    t.equal("Bash 出错会取消同批的兄弟调用", [bashFails.t1, bashFails.t2], [
      "Cancelled: parallel tool call Bash(make build) errored",
      "Cancelled: parallel tool call Bash(make build) errored",
    ]);
    t.equal("Read 出错不影响兄弟调用", [readFails.t1, readFails.t2], ["ok", "ok"]);
  }

  // ───────────────────────── 三、关卡 ─────────────────────────
  if (wants("pipeline")) {
    t.log("三、一个调用要过哪几道关，每种失败停在哪一关");
    t.log();
    const workspace = join(t.root, "pipeline");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "a.txt"), "old");
    const trace = [];
    const echo = {
      name: "Echo",
      validate(input) {
        if (typeof input.text !== "string") throw Error("text must be string");
      },
      execute(input) {
        trace.push("执行");
        if (input.boom) throw Error("tool crashed");
        return { text: input.text };
      },
    };
    // Toolset 对 Hook 的全部要求就是这两个方法（第 7 章会换成真正的 Hook 实现）：
    // before 返回 { block, reason } 或 { input }，after 返回（可能被改过的）结果。
    const hooks = {
      async before(call) {
        trace.push("Hook");
        if (call.input.block) return { block: true, reason: "blocked by hook" };
        return { input: call.input.rewrite ? { text: 42 } : call.input };
      },
      async after(_call, result) {
        trace.push("PostHook");
        return result;
      },
    };
    const gate = async (call) => {
      trace.push("权限");
      return !call.input.deny;
    };
    const toolset = new Toolset([...codingTools(workspace), echo], { hooks, gate });
    const cancelled = new AbortController();
    cancelled.abort();

    const scenarios = [
      ["模型调用了不存在的工具", { name: "Nope", input: {} }],
      ["参数类型不对（text 是数字）", { name: "Echo", input: { text: 42 } }],
      ["Edit 一个没读过的文件", { name: "Edit", input: { path: "a.txt", old: "old", next: "new" } }],
      ["Hook 拦下这次调用", { name: "Echo", input: { text: "hi", block: true } }],
      ["Hook 把参数改成了不合法的", { name: "Echo", input: { text: "hi", rewrite: true } }],
      ["权限被拒绝", { name: "Echo", input: { text: "hi", deny: true } }],
      ["工具执行时抛错", { name: "Echo", input: { text: "hi", boom: true } }],
      ["运行已被取消", { name: "Echo", input: { text: "hi" } }, { signal: cancelled.signal }],
      ["一切正常", { name: "Echo", input: { text: "hi" } }],
    ];
    const rows = [];
    for (const [label, call, context] of scenarios) {
      trace.length = 0;
      const message = await toolset.execute({ id: `call-${rows.length}`, ...call }, context);
      rows.push({
        场景: label,
        经过的关卡: trace.join(" → ") || "（一关都没到）",
        模型收到: `${message.error ? "错误" : "成功"}：${message.text}`,
        id: message.id,
      });
    }
    t.table(rows);
    t.equal(
      "每个调用都恰好得到一条结果，id 原样带回",
      rows.map((row) => row.id),
      scenarios.map((_, i) => `call-${i}`),
    );
    const seen = (label) => rows.find((row) => row.场景 === label).经过的关卡;
    t.equal("校验失败的调用，Hook 和权限都没见过它", [seen("参数类型不对（text 是数字）"), seen("Edit 一个没读过的文件")], ["（一关都没到）", "（一关都没到）"]);
    t.equal("Hook 改坏的参数在权限之前就被拦下", seen("Hook 把参数改成了不合法的"), "Hook");
    t.equal("工具抛错后不再运行执行后 Hook", seen("工具执行时抛错"), "Hook → 权限 → 执行");
    t.equal("只有走完全程的调用才会运行执行后 Hook", seen("一切正常"), "Hook → 权限 → 执行 → PostHook");

    // 同一条回复里的所有调用，哪怕全部失败，也都有各自的结果
    trace.length = 0;
    const batch = await toolset.runCalls(
      [
        { id: "x1", name: "Echo", input: { text: "ok" } },
        { id: "x2", name: "Echo", input: { text: 1 } },
        { id: "x3", name: "Nope", input: {} },
      ],
      {},
    );
    t.equal("一批调用里每个 id 都有结果", batch.map((m) => m.id), ["x1", "x2", "x3"]);
  }

  // ───────────────────────── 四、先读后改 ─────────────────────────
  if (wants("file-state")) {
    t.log("四、“先读后改”在检查什么");
    t.log();
    const workspace = join(t.root, "files");
    mkdirSync(workspace);
    const path = (name) => join(workspace, name);
    writeFileSync(path("a.txt"), "x=1\ny=1\n");
    writeFileSync(path("dup.txt"), "x\nx\n");
    const toolset = new Toolset(codingTools(workspace));
    const rows = [];
    const expectations = [];
    let n = 0;
    const step = async (what, call, rejected) => {
      const message = await toolset.execute({ id: `s${++n}`, ...call });
      rows.push({
        步骤: what,
        结果: message.error ? `拒绝：${message.text}` : `成功：${message.text.slice(0, 20).replace(/\n/g, "⏎")}`,
        "a.txt 现在是": JSON.stringify(readFileSync(path("a.txt"), "utf8")),
      });
      expectations.push({ actual: !!message.error, expected: rejected });
    };
    const edit = (old, next) => ({ name: "Edit", input: { path: "a.txt", old, next } });
    await step("没读过就 Edit", edit("x=1", "x=2"), true);
    await step("Read a.txt", { name: "Read", input: { path: "a.txt" } }, false);
    await step("Edit x=1 → x=2", edit("x=1", "x=2"), false);
    await step("紧接着再 Edit x=2 → x=3（不重读）", edit("x=2", "x=3"), false);
    writeFileSync(path("a.txt"), readFileSync(path("a.txt"), "utf8") + "# 外部程序追加\n");
    rows.push({ 步骤: "（外部程序在文件末尾追加了一行）", 结果: "—", "a.txt 现在是": JSON.stringify(readFileSync(path("a.txt"), "utf8")) });
    await step("Edit x=3 → x=4（文件已被外部改过）", edit("x=3", "x=4"), true);
    await step("重新 Read a.txt", { name: "Read", input: { path: "a.txt" } }, false);
    await step("Edit x=3 → x=4", edit("x=3", "x=4"), false);
    await step("Read a.txt，只读第 1 行（limit: 1）", { name: "Read", input: { path: "a.txt", limit: 1 } }, false);
    await step("Edit y=1 → y=2（只读过第 1 行）", edit("y=1", "y=2"), false);
    await step("Write 覆盖 a.txt（刚改过，版本是新的）", { name: "Write", input: { path: "a.txt", text: "fresh\n" } }, false);
    await step("Write 新建 b.txt（不用读）", { name: "Write", input: { path: "b.txt", text: "new\n" } }, false);
    await step("Write 覆盖没读过的 dup.txt", { name: "Write", input: { path: "dup.txt", text: "z" } }, true);
    await step("Read dup.txt", { name: "Read", input: { path: "dup.txt" } }, false);
    const ambiguous = await toolset.execute({ id: "dup", name: "Edit", input: { path: "dup.txt", old: "x", next: "y" } });
    rows.push({ 步骤: "Edit dup.txt：x → y（出现两次）", 结果: `拒绝：${ambiguous.text}`, "a.txt 现在是": JSON.stringify(readFileSync(path("a.txt"), "utf8")) });
    t.table(rows);
    t.equal(
      "表里每一步，被拒绝的恰好是该被拒绝的",
      expectations.map((e) => e.actual),
      expectations.map((e) => e.expected),
    );
    t.ok("出现两次的 old 被拒绝，错误信息告诉模型怎么办", ambiguous.error && /2 times.*surrounding/.test(ambiguous.text));
    t.equal("被拒绝的编辑没有改动 dup.txt", readFileSync(path("dup.txt"), "utf8"), "x\nx\n");
  }

  // ───────────────────────── 五、大输出 ─────────────────────────
  if (wants("big-output")) {
    t.log("五、大输出怎么处理");
    t.log();
    // 5.1 每个工具声明自己的上限，实际阈值由原函数 getPersistenceThreshold 算出
    const threshold = upstream("persist-threshold", "getPersistenceThreshold", {
      Number,
      Math,
      PERSIST_THRESHOLD_OVERRIDE_FLAG: "none",
      DEFAULT_MAX_RESULT_SIZE_CHARS: 50_000,
      getFeatureValue_CACHED_MAY_BE_STALE: () => ({}),
    });
    const declared = [
      ["Bash", 30_000],
      ["Grep", 20_000],
      ["Edit", 100_000],
      ["Glob", 100_000],
      ["Read", Infinity],
    ];
    t.table(
      declared.map(([tool, limit]) => ({
        工具: tool,
        声明的上限: limit === Infinity ? "Infinity" : limit.toLocaleString("en-US"),
        实际落盘阈值: threshold(tool, limit) === Infinity ? "永不落盘" : threshold(tool, limit).toLocaleString("en-US"),
      })),
    );
    t.equal("声明 10 万的工具被全局 5 万封顶；Read 永不落盘", declared.map(([tool, limit]) => threshold(tool, limit)), [30_000, 20_000, 50_000, 50_000, Infinity]);

    // 5.2 一个输出 282KB 的工具（和录制里的 seq 1 50000 同样大）
    const resultDir = join(t.root, "tool-results");
    const big = Array.from({ length: 50_000 }, (_, i) => i + 1).join("\n");
    const toolset = new Toolset(
      [
        { name: "Dump", validate() {}, execute: () => ({ text: big, details: { lines: 50_000 } }) },
        { name: "Quiet", validate() {}, execute: () => ({ text: "" }) },
      ],
      { resultDir },
    );
    const message = await toolset.execute({ id: "call-1", name: "Dump", input: {} });
    const saved = join(resultDir, "call-1.txt");
    t.table([
      { 项目: "工具原本的输出", 大小: `${big.length.toLocaleString("en-US")} 字符` },
      { 项目: "模型收到的文字", 大小: `${message.text.length.toLocaleString("en-US")} 字符` },
      { 项目: "磁盘上保存的完整输出", 大小: `${readFileSync(saved, "utf8").length.toLocaleString("en-US")} 字符` },
    ]);
    t.log("模型收到的文字（节选）：");
    t.log(
      message.text
        .replaceAll(t.root, "<工作区>")
        .split("\n")
        .slice(0, 5)
        .map((line) => `    ${line}`)
        .join("\n") + "\n    …",
    );
    t.log();
    t.equal("完整输出一字不差地存在文件里", readFileSync(saved, "utf8"), big);
    t.equal("给程序的 details 带着文件路径，原有字段还在", message.details, { lines: 50_000, persistedPath: saved });
    t.ok("模型只看到路径和开头的预览", message.text.length < 2_300 && message.text.includes(saved));

    // 5.3 预览怎么截：和原函数 generatePreview 比较
    const generatePreview = upstream("persist-preview", "generatePreview");
    const originalPreview = generatePreview(big, 2_000).preview;
    const codaPreview = message.text.slice(message.text.indexOf("characters):\n") + "characters):\n".length);
    t.equal("coda 的预览与原函数 generatePreview 一致", codaPreview, originalPreview);

    // 5.4 Read 不落盘，而是自己限长，并告诉模型怎么继续
    const workspace = join(t.root, "big-read");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "big.txt"), Array.from({ length: 20_000 }, (_, i) => `line ${i + 1}`).join("\n"));
    const reader = new Toolset(codingTools(workspace), { resultDir });
    const whole = await reader.execute({ id: "r1", name: "Read", input: { path: "big.txt" } });
    const range = await reader.execute({ id: "r2", name: "Read", input: { path: "big.txt", offset: 10_000, limit: 3 } });
    t.table([
      { Read: "整个文件（20000 行）", 结果: `${whole.error ? "错误" : "成功"}：${whole.text}` },
      { Read: "offset 10000, limit 3", 结果: `${range.error ? "错误" : "成功"}：${range.text.replace(/\n/g, " / ")}` },
    ]);
    t.ok("过大的 Read 被拒绝并提示 offset / limit", whole.error && /offset and limit/.test(whole.text));
    t.equal("分段读取只返回要的那几行", range.text, "line 10000\nline 10001\nline 10002");

    // 5.5 空结果
    const quiet = await toolset.execute({ id: "q", name: "Quiet", input: {} });
    t.log(`工具什么都没输出时，模型收到：${quiet.text}`);
    t.log();
    t.equal("空结果换成一句说明", quiet.text, "(Quiet completed with no output)");
    t.equal("只有超限的结果落了盘", readdirSync(resultDir), ["call-1.txt"]);
  }
});
