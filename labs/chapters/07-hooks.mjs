// 第 7 章实验：Hook。七个小实验，各回答一个问题：
//   matcher      matcher 怎么写、匹配什么？（运行 Claude Code 里真正的 matchesPattern）
//   outputs      一个 Hook 的“退出码 + stdout”怎样变成放行或拦下？
//   json         JSON 输出里的每个字段会变成什么？（运行 parseHookOutput 和 processHookJSONOutput）
//   parallel     多个 Hook 同时匹配：并行、合并、去重
//   pipeline     Hook 接进工具流水线：拦下、改写参数、补充信息、抹掉密钥
//   stop         Stop Hook 怎样让循环再来一圈，又怎样防止停不下来
//   prompt       用户提交提示、会话开始，以及“没被信任的工作区”
//
//   node --disable-warning=ExperimentalWarning labs/chapters/07-hooks.mjs            全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/07-hooks.mjs outputs    只运行一个
import { lesson, ROOT } from "./harness.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Hooks, commandHook, matches, shellHook } from "../../coda/src/hooks.mjs";
import { Engine, collect, scripted } from "../../coda/src/engine.mjs";
import { Toolset } from "../../coda/src/tools.mjs";
import { codingTools } from "../../coda/src/files.mjs";
import { runProcess } from "../../runtime/process.mjs";
import { upstream } from "../engineering/run.mjs";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;
const MOX = process.env.MOX_SRC ?? join(ROOT, "../learn-pi-agent");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (value, n = 70) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
};

await lesson(7, "Hook：匹配、运行、合并与失败", async (t) => {
  // 一个 Node 脚本形式的 Hook：写进临时目录，返回路径。脚本从 stdin 读事件 JSON。
  const script = (name, body) => {
    const file = join(t.temp, name);
    writeFileSync(file, `let raw = "";\nfor await (const chunk of process.stdin) raw += chunk;\nconst event = JSON.parse(raw);\n${body}\n`);
    return file;
  };

  // Learn Pi Agent 第 13 章的 Hook 协议实现（matches / runHooks / interpret）。找不到那个仓库就省掉对应的列。
  const piFile = join(MOX, "extensions/hooks/protocol.ts");
  const pi = existsSync(piFile) ? await import(pathToFileURL(piFile)) : undefined;

  // ───────────────────────── 一、matcher ─────────────────────────
  if (wants("matcher")) {
    t.log("一、matcher 怎么写，匹配什么");
    t.log();
    // 原函数 matchesPattern：从固定提交里装载。它依赖的“旧工具名映射”和日志换成最小替身。
    const legacy = { Task: "Agent" };
    const original = upstream("hook-matcher", "matchesPattern", {
      normalizeLegacyToolName: (name) => legacy[name] ?? name,
      getLegacyToolNames: (name) => Object.entries(legacy).filter(([, now]) => now === name).map(([old]) => old),
      logForDebugging: () => {},
    });
    const cases = [
      ["Bash", "Bash"],
      ["Edit|Write", "Write"],
      ["Edit|Write", "Read"],
      ["Edit,Write", "Write"],
      ["bash", "Bash"],
      ["Notebook", "NotebookEdit"],
      ["Notebook.*", "NotebookEdit"],
      ["mcp__github", "mcp__github__create_issue"],
      ["mcp__github__.*", "mcp__github__create_issue"],
      ["*", "Anything"],
      ["", "Anything"],
      ["(", "Bash"],
    ];
    const mark = (value) => (value ? "匹配" : "不匹配");
    t.table(
      cases.map(([matcher, query]) => ({
        "matcher 写法": matcher ? "`" + matcher + "`" : "（空）",
        "工具名": query,
        "Claude Code 原函数": mark(original(query, matcher)),
        "coda": mark(matches(matcher, query)),
        // Pi 扩展的 matches 参数顺序和原函数相反：(matcher, 工具名)
        ...(pi ? { "Pi 扩展": mark(pi.matches(matcher, query)) } : {}),
      })),
    );
    const disagreements = cases.filter(([matcher, query]) => original(query, matcher) !== matches(matcher, query));
    t.equal("coda 的 matches 与原函数在这些写法上完全一致", disagreements, []);
    t.equal("原函数不认逗号分隔：`Edit,Write` 匹配不到 Write", original("Write", "Edit,Write"), false);
    t.equal("只含字母数字的 matcher 是精确匹配：`mcp__github` 匹配不到它的工具", original("mcp__github__create_issue", "mcp__github"), false);

    // 同一个 matcher “Bash”：不同事件看不同的字段，没有匹配字段的事件干脆不看 matcher
    const probe = (event, matcher, query) => new Hooks([{ event, matcher, run: async () => ({}) }]).select(event, query).length > 0;
    const fieldRows = [
      ["PreToolUse", "Bash", "Bash", "tool_name"],
      ["PreToolUse", "Bash", "Read", "tool_name"],
      ["SessionStart", "startup|resume", "clear", "source"],
      ["SessionStart", "startup|resume", "resume", "source"],
      ["Stop", "Bash", undefined, "（没有匹配字段）"],
      ["UserPromptSubmit", "Bash", undefined, "（没有匹配字段）"],
    ];
    t.log("不同事件，matcher 匹配的字段也不同：");
    t.log();
    t.table(
      fieldRows.map(([event, matcher, query, field]) => ({
        事件: event,
        "matcher": "`" + matcher + "`",
        匹配字段: field,
        这次的值: query ?? "—",
        "Hook 会运行吗": probe(event, matcher, query) ? "运行" : "不运行",
      })),
    );
    t.equal("Stop 没有匹配字段，matcher 写了 Bash 也照样运行", probe("Stop", "Bash", undefined), true);
    t.equal("SessionStart 匹配的是 source，不是工具名", probe("SessionStart", "startup|resume", "clear"), false);
  }

  // ───────────────────────── 二、退出码与 stdout ─────────────────────────
  if (wants("outputs")) {
    t.log("二、一个 Hook 的回答：退出码 + stdout → 放行还是拦下");
    t.log();
    const preToolUse = (decision, extra = "") =>
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, ...(extra && { permissionDecisionReason: extra }) } });
    const cases = [
      ["退出码 0，什么都不输出", `exit 0`],
      ["退出码 0，输出一行普通文字", `echo "格式化完成"`],
      ["退出码 2，stderr 写了原因", `echo "不许运行 rm -rf" >&2; exit 2`],
      ["退出码 1（脚本自己出错）", `echo "jq: 出错" >&2; exit 1`],
      ["命令不存在（shell 返回 127）", `jq-not-installed --version`],
      ["运行太久（0.3 秒超时）", `sleep 5`],
      ["JSON：permissionDecision = deny", `echo '${preToolUse("deny", "禁止")}'`],
      ["JSON：decision = block", `echo '{"decision":"block","reason":"提示里有密码"}'`],
      ["JSON：permissionDecision = ask", `echo '${preToolUse("ask")}'`],
      ["先打一行欢迎语，再输出 deny 的 JSON", `echo "Welcome back!"; echo '${preToolUse("deny", "禁止")}'`],
      ["以 { 开头，但不是合法 JSON", `echo '{broken'`],
      ["合法 JSON，但 decision 写成 maybe", `echo '{"decision":"maybe"}'`],
      ["输出 allow 的 JSON，同时退出码 2", `echo '${preToolUse("allow")}'; echo "拦下" >&2; exit 2`],
    ];
    const expected = ["success", "success", "blocking", "non_blocking_error", "non_blocking_error", "cancelled", "blocking", "blocking", "success", "success", "success", "non_blocking_error", "success"];
    // 同一条命令交给 Pi 扩展：退出码优先，JSON 只在退出码为 0 时才解析
    const piDecision = async (command) => {
      const hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 0.3 }] }] };
      const runs = await pi.runHooks(hooks, "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }, { cwd: t.root, projectDir: t.root, toolName: "Bash" });
      const verdict = pi.interpret("PreToolUse", runs);
      return verdict.permission === "ask" ? "询问用户" : verdict.block ? "**拦下**" : "放行";
    };
    const rows = [];
    for (const [label, command] of cases) {
      const hooks = new Hooks([{ event: "PreToolUse", matcher: "Bash", run: shellHook(command, { timeout: 300 }) }], { root: t.root });
      const verdict = await hooks.before({ id: "c1", name: "Bash", input: { command: "ls" } }, {});
      const { outcome } = hooks.log.at(-1);
      rows.push({
        "Hook 的表现": label,
        结果: outcome,
        工具调用: verdict.block ? "**拦下**" : "放行",
        ...(pi ? { "Pi 扩展": await piDecision(command) } : {}),
        模型看到: verdict.block ? short(verdict.reason, 90) : verdict.permission ? `权限意见 ${verdict.permission}，交给权限 gate` : "—",
        用户看到: short(verdict.notices.join("；") || "—", 56),
      });
    }
    t.table(rows);
    t.equal("每种表现对应的结果类别", rows.map((r) => r.结果), expected);
    t.equal("只有 blocking 拦下了工具调用", rows.filter((r) => r.工具调用.includes("拦下")).length, 3);
    t.ok("JSON 先于退出码：allow 的 JSON 配退出码 2，调用照样放行", rows.at(-1).工具调用 === "放行");
  }

  // ───────────────────────── 三、JSON 字段 ─────────────────────────
  if (wants("json")) {
    t.log("三、JSON 输出：先分类，再逐字段解读（运行 Claude Code 里真正的两个函数）");
    t.log();
    // 两个原函数。zod schema 换成一个只检查 decision 枚举的替身；附件消息换成最简单的记录。
    const schema = () => ({
      safeParse: (value) =>
        value.decision === undefined || ["approve", "block"].includes(value.decision)
          ? { success: true, data: value }
          : { success: false, error: { issues: [{ path: ["decision"], message: "Invalid option" }] } },
    });
    const validateHookJson = upstream("hook-validate-json", "validateHookJson", {
      jsonParse: JSON.parse,
      jsonStringify: JSON.stringify,
      hookJSONOutputSchema: schema,
      logForDebugging: () => {},
    });
    const parseHookOutput = upstream("hook-parse-output", "parseHookOutput", {
      validateHookJson,
      jsonStringify: JSON.stringify,
      logForDebugging: () => {},
    });
    const processHookJSONOutput = upstream("hook-json-output", "processHookJSONOutput", {
      createAttachmentMessage: (attachment) => ({ type: "attachment", attachment }),
      jsonStringify: JSON.stringify,
    });

    const classify = (stdout) => {
      const parsed = parseHookOutput(stdout);
      return parsed.validationError ? "格式错误（non_blocking_error）" : parsed.json ? "JSON" : "纯文本";
    };
    const stdouts = [
      ["空", ""],
      ["一行普通文字", "格式化完成"],
      ["欢迎语 + JSON", 'Welcome back!\n{"decision":"block"}'],
      ["以 { 开头但解析不了", "{broken"],
      ["合法 JSON，decision 是 maybe", '{"decision":"maybe"}'],
      ["合法 JSON，decision 是 block", '{"decision":"block","reason":"提示里有密码"}'],
    ];
    t.table(stdouts.map(([label, stdout]) => ({ stdout: label, "parseHookOutput 的分类": classify(stdout) })));
    t.equal("以 { 开头却解析不了的输出，原函数当作纯文本", classify("{broken"), "纯文本");
    t.equal("欢迎语在前，整段输出被当作纯文本", classify('Welcome back!\n{"decision":"block"}'), "纯文本");

    const run = (json, hookEvent) => processHookJSONOutput({ json, command: "hook.sh", hookName: `${hookEvent}:Bash`, toolUseID: "t1", hookEvent, expectedHookEvent: hookEvent });
    const pre = (decision, extra = {}) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, ...extra } });
    const fields = [
      ["PreToolUse：allow + updatedInput + additionalContext", "PreToolUse", pre("allow", { updatedInput: { command: "./deploy.sh --dry-run" }, additionalContext: "已加 --dry-run" })],
      ["PreToolUse：deny + permissionDecisionReason", "PreToolUse", pre("deny", { permissionDecisionReason: "禁止读 .env" })],
      ["PreToolUse：ask", "PreToolUse", pre("ask")],
      ["顶层 decision = approve", "PreToolUse", { decision: "approve" }],
      ["顶层 decision = block + reason", "UserPromptSubmit", { decision: "block", reason: "提示里有密码" }],
      ["Stop：decision = block + reason", "Stop", { decision: "block", reason: "先跑 npm test" }],
      ["continue = false + stopReason", "PostToolUse", { continue: false, stopReason: "预算用完" }],
      ["PostToolUse：additionalContext + updatedMCPToolOutput", "PostToolUse", { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "已脱敏", updatedMCPToolOutput: "[REDACTED]" } }],
      ["systemMessage", "PreToolUse", { systemMessage: "提醒：这个目录是生产环境" }],
    ];
    const cell = (value) => (value === undefined ? "—" : short(value, 40));
    t.table(
      fields.map(([label, event, json]) => {
        const r = run(json, event);
        return {
          "JSON 的内容": label,
          权限意见: cell(r.permissionBehavior),
          阻止: cell(r.blockingError?.blockingError),
          改写参数: cell(r.updatedInput),
          补充信息: cell(r.additionalContext),
          停止继续: r.preventContinuation ? `是（${r.stopReason}）` : "—",
          其他: cell(r.systemMessage ?? (r.updatedMCPToolOutput !== undefined ? `改写 MCP 输出` : undefined)),
        };
      }),
    );
    const results = fields.map(([, event, json]) => run(json, event));
    t.equal("deny 同时产生阻止信息，理由取 permissionDecisionReason", [results[1].permissionBehavior, results[1].blockingError.blockingError], ["deny", "禁止读 .env"]);
    t.equal("allow 只带来权限意见和改写，没有阻止", [results[0].permissionBehavior, results[0].blockingError, results[0].updatedInput.command], ["allow", undefined, "./deploy.sh --dry-run"]);
    t.equal("Stop 的 decision = block 变成阻止信息", results[5].blockingError.blockingError, "先跑 npm test");
    t.equal("continue = false 变成停止继续", results[6].preventContinuation, true);
    // Hook 在 PreToolUse 里回答了 PostToolUse 的格式：原函数直接抛错，上层把它记成 non_blocking_error
    t.throws("hookEventName 与当前事件不符会抛错", () => run({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } }, "PreToolUse"), /incorrect event name/);
  }

  // ───────────────────────── 四、并行、合并、去重 ─────────────────────────
  if (wants("parallel")) {
    t.log("四、多个 Hook 同时匹配");
    t.log();
    // 5.1 并行：三个各睡 200ms 的 Hook
    const slow = (n) => ({ event: "PreToolUse", matcher: "Bash", run: shellHook(`sleep 0.2; exit 0`, { timeout: 2000 }), key: `slow-${n}` });
    const timed = new Hooks([slow(1), slow(2), slow(3)], { root: t.root });
    const started = Date.now();
    await timed.before({ id: "p", name: "Bash", input: { command: "ls" } }, {});
    const elapsed = Date.now() - started;
    t.log(`三个各睡 0.2 秒的 Hook：一起运行，总共用了 ${elapsed} 毫秒（串行至少要 600 毫秒）。`);
    t.log();
    t.ok("三个 0.2 秒的 Hook 并行运行，总耗时远小于 0.6 秒", elapsed < 500);

    // 5.2 合并：每个 Hook 给出自己的意见，先后顺序不影响结果
    const opinion = (patch, delay = 0) => ({
      event: "PreToolUse",
      run: async () => {
        await sleep(delay);
        return patch;
      },
    });
    const cases = [
      ["allow（快）+ ask（慢）", [opinion({ permission: "allow" }), opinion({ permission: "ask" }, 60)]],
      ["ask（快）+ allow（慢）", [opinion({ permission: "ask" }), opinion({ permission: "allow" }, 60)]],
      ["allow + deny + ask", [opinion({ permission: "allow" }), opinion({ permission: "deny", block: true, reason: "规则 B 拒绝" }), opinion({ permission: "ask" })]],
      ["两个 Hook 都说“拦下”", [opinion({ block: true, reason: "原因一" }), opinion({ block: true, reason: "原因二" }, 30)]],
      ["两个 Hook 都改参数", [opinion({ input: { command: "A" } }, 60), opinion({ input: { command: "B" } })]],
    ];
    const rows = [];
    for (const [label, entries] of cases) {
      const merged = await new Hooks(entries).before({ id: "m", name: "Bash", input: { command: "ls" } }, {});
      rows.push({
        "Hook 的意见": label,
        合并结果: merged.block ? `拦下：${merged.reason.replace(/^PreToolUse:Bash hook error: /, "").replace(/\n/g, " / ")}` : `权限意见 ${merged.permission ?? "无"}；参数 ${JSON.stringify(merged.input)}`,
      });
    }
    t.table(rows);
    t.equal("deny > ask > allow，与谁先跑完无关", [rows[0].合并结果.includes("ask"), rows[1].合并结果.includes("ask"), rows[2].合并结果.includes("拦下")], [true, true, true]);
    t.ok("两个 Hook 都拦下时，两条理由都留给模型", rows[3].合并结果.includes("原因一") && rows[3].合并结果.includes("原因二"));
    t.ok("两个 Hook 都改参数：按注册顺序，靠后的生效", rows[4].合并结果.includes('"command":"B"'));

    // 5.3 去重：用户级和项目级配置里写了同一条命令，只运行一次
    const counter = join(t.temp, "counter.txt");
    const same = { type: "command", command: `echo run >> ${counter}` };
    const config = { PreToolUse: [{ matcher: "Bash", hooks: [same] }, { matcher: "Bash|Read", hooks: [same, { type: "command", command: `echo other >> ${counter}` }] }] };
    await Hooks.fromConfig(config, { root: t.root }).before({ id: "d", name: "Bash", input: { command: "ls" } }, {});
    const lines = readFileSync(counter, "utf8").trim().split("\n");
    t.log(`同一条命令出现在两个配置组里，另有一条不同的命令：共运行了 ${lines.length} 次（${lines.join("、")}）。`);
    t.log();
    t.equal("相同的命令只运行一次，不同的命令各运行一次", lines.sort(), ["other", "run"]);
  }

  // ───────────────────────── 五、接进工具流水线 ─────────────────────────
  if (wants("pipeline")) {
    t.log("五、Hook 接进工具流水线：拦下、改写参数、补充信息、抹掉密钥");
    t.log();
    const workspace = join(t.root, "pipeline");
    mkdirSync(join(workspace, "build"), { recursive: true });
    writeFileSync(join(workspace, "deploy.sh"), '#!/bin/sh\necho "deploy $@"\n', { mode: 0o755 });
    writeFileSync(join(workspace, "config.txt"), "region=cn-north\napi_key=sk-live-9f8e7d6c5b4a\n");
    // 一个会真的运行 shell 命令的 Bash 工具
    const bash = {
      name: "Bash",
      validate(input) {
        if (typeof input.command !== "string") throw Error("command must be string");
      },
      async execute(input, { root }) {
        const out = await runProcess("sh", ["-c", input.command], { cwd: root });
        return { text: out.stdout + out.stderr, error: out.code !== 0 };
      },
    };
    const blockDangerous = shellHook(`if cat | grep -q "rm -rf"; then echo "禁止执行破坏性命令（rm -rf）。请换一种更安全的做法。" >&2; exit 2; fi`);
    const dryRun = commandHook(
      script(
        "dry-run.mjs",
        `const input = event.tool_input;
if (input.command.startsWith("./deploy.sh") && !input.command.includes("--dry-run"))
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { ...input, command: input.command + " --dry-run" }, additionalContext: "部署命令已被 Hook 加上 --dry-run，没有真正部署。" } }));`,
      ),
    );
    const redact = commandHook(
      script(
        "redact.mjs",
        `const text = event.tool_response.text;
const clean = text.replace(/sk-[A-Za-z0-9-]{8,}/g, "[REDACTED]");
if (clean !== text) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: clean } }));`,
      ),
    );
    const entries = [
      { event: "PreToolUse", matcher: "Bash", run: blockDangerous },
      { event: "PreToolUse", matcher: "Bash", run: dryRun },
      { event: "PostToolUse", matcher: "Bash", run: redact },
    ];
    const toolset = (hooks) => new Toolset([bash, ...codingTools(workspace)], { hooks });
    const hooks = new Hooks(entries, { root: workspace });
    const tools = toolset(hooks);

    const rows = [];
    for (const [label, command] of [
      ["清理构建目录", "rm -rf build"],
      ["部署到生产环境", "./deploy.sh production"],
      ["看配置文件", "cat config.txt"],
    ]) {
      const result = await tools.execute({ id: label, name: "Bash", input: { command } }, { root: workspace });
      rows.push({ 模型的调用: "`" + command + "`", 结果: result.error ? "错误" : "成功", 模型收到: short(result.text.replace(/\n+/g, " ⏎ "), 110) });
    }
    t.table(rows);
    t.ok("rm -rf 被拦下，build 目录还在", rows[0].结果 === "错误" && existsSync(join(workspace, "build")));
    t.ok("部署命令被改写成 --dry-run，补充信息附在结果后面", rows[1].模型收到.includes("deploy production --dry-run") && rows[1].模型收到.includes("Hook 补充信息"));
    t.ok("密钥在进入模型之前就被抹掉", rows[2].模型收到.includes("[REDACTED]") && !rows[2].模型收到.includes("sk-live"));

    // Hook 把参数改成越界的路径：Toolset 在 Hook 之后会再校验一次（第 3 章），改写不能绕过校验。
    const rewrite = commandHook(
      script("rewrite.mjs", `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { path: "../outside", text: "bad" } } }));`),
    );
    const sneaky = toolset(new Hooks([{ event: "PreToolUse", matcher: "Write", run: rewrite }], { root: workspace }));
    const result = await sneaky.execute({ id: "w", name: "Write", input: { path: "safe", text: "ok" } }, { root: workspace });
    t.log(`Hook 把 Write 的路径改成 ../outside：${result.error ? "被校验挡下" : "写入了"}（${short(result.text, 60)}）`);
    t.log();
    t.ok("改写后的越界路径被重新校验挡下，文件系统没有变化", result.error && !existsSync(join(t.root, "outside")));

    // 以及 Hook 自己崩了：调用照常执行，故障记在日志里
    const broken = toolset(new Hooks([{ event: "PreToolUse", matcher: "Bash", run: shellHook("exit 1") }], { root: workspace }));
    const survived = await broken.execute({ id: "b", name: "Bash", input: { command: "echo still-running" } }, { root: workspace });
    t.equal("Hook 以退出码 1 结束：工具照常执行", survived.text.trim(), "still-running");
  }

  // ───────────────────────── 六、Stop Hook ─────────────────────────
  if (wants("stop")) {
    t.log("六、Stop Hook：让循环再来一圈，以及它怎样停不下来");
    t.log();
    const requireTests = script(
      "require-tests.mjs",
      `if (!event.stop_hook_active && !/测试通过/.test(event.last_assistant_message))
  console.log(JSON.stringify({ decision: "block", reason: "结束之前请先运行 npm test，并报告结果。" }));`,
    );
    const alwaysNo = script("always-no.mjs", `console.log(JSON.stringify({ decision: "block", reason: "还不行。" }));`);
    const halt = script("halt.mjs", `console.log(JSON.stringify({ continue: false, stopReason: "预算用完" }));`);
    const crash = script("crash.mjs", `console.error("boom"); process.exit(1);`);

    async function scenario(file, replies, options = {}) {
      const hooks = new Hooks([{ event: "Stop", run: commandHook(file) }], { root: t.root });
      const seen = [];
      const engine = new Engine({
        model: scripted(replies.map((text) => ({ text }))),
        tools: new Toolset([]),
        onStop: async (input) => {
          seen.push(input.stopHookActive);
          return hooks.stop(input);
        },
      });
      const frames = await collect(engine, "收尾", options);
      const terminal = frames.at(-1);
      return {
        seen,
        requests: frames.filter((f) => f.type === "request"),
        terminal,
        hooks,
        feedback: terminal.messages.filter((m) => m.meta && m.text.startsWith("Stop Hook")).map((m) => m.text.split("\n")[1]),
      };
    }

    const careful = await scenario(requireTests, ["都处理好了。", "测试通过（12 passed），全部完成。"]);
    const endless = await scenario(alwaysNo, ["好了。", "好了。", "好了。", "好了。", "好了。"], { maxTurns: 3 });
    const stopped = await scenario(halt, ["好了。"]);
    const crashed = await scenario(crash, ["好了。"]);

    // 连续相同的原因合并成“×N”
    const runs = (items) => items.reduce((out, item) => (out.at(-1)?.[0] === item ? (out.at(-1)[1]++, out) : [...out, [item, 1]]), []).map(([item, n]) => (n > 1 ? `${item}（×${n}）` : item)).join(" → ");
    const describe = (s) => ({
      "Stop Hook 被问了": `${s.seen.length} 次（stop_hook_active：${s.seen.join("、")}）`,
      "每一圈为什么继续": runs(s.requests.map((r) => r.transition.reason)),
      终态: `${s.terminal.reason}${s.terminal.error ? `：${s.terminal.error}` : ""}`,
    });
    t.table([
      { 场景: "检查 stop_hook_active 的 Hook", ...describe(careful) },
      { 场景: "一直说“还不行”的 Hook（maxTurns 设为 3）", ...describe(endless) },
      { 场景: "Hook 输出 continue: false", ...describe(stopped) },
      { 场景: "Hook 自己崩了（退出码 1）", ...describe(crashed) },
    ]);
    t.equal("第一次想结束被拦下，第二次 stop_hook_active 为真，放行", [careful.seen, careful.terminal.reason], [[false, true], "completed"]);
    t.equal("Hook 的理由以一条 meta 用户消息的形式交给模型", careful.feedback, ["结束之前请先运行 npm test，并报告结果。"]);
    t.ok("Hook 逼出来的重试不算新的一轮：maxTurns 管不住它，一直到脚本模型耗尽", endless.seen.length === 5 && endless.terminal.reason === "model_error");
    t.equal("continue: false 直接终止", [stopped.terminal.reason, stopped.terminal.status], ["stop_hook_prevented", "stopped"]);
    t.equal("Hook 崩溃按放行处理，运行照常完成", [crashed.terminal.reason, crashed.hooks.log[0].outcome], ["completed", "non_blocking_error"]);
  }

  // ───────────────────────── 七、用户提示、会话开始、信任 ─────────────────────────
  if (wants("prompt")) {
    t.log("七、UserPromptSubmit、SessionStart，以及没被信任的工作区");
    t.log();
    const guard = commandHook(
      script(
        "prompt-guard.mjs",
        `if (/密码(是|:|：)/.test(event.prompt))
  console.log(JSON.stringify({ decision: "block", reason: "提示里似乎包含密码，已拦下。请改用环境变量。" }));
else
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "当前分支 main；提交前必须运行 npm test。" } }));`,
      ),
    );
    const sessionInfo = shellHook(`echo "项目信息：部署脚本是 ./deploy.sh"`);
    const makeHooks = (options) =>
      new Hooks(
        [
          { event: "UserPromptSubmit", run: guard },
          { event: "SessionStart", matcher: "startup|resume", run: sessionInfo },
        ],
        { root: t.root, ...options },
      );

    // 把“提交一条提示”接成：先问 UserPromptSubmit Hook；没被拦下，才请求模型，并把补充信息放在提示前面
    async function submit(hooks, prompt) {
      const verdict = await hooks.userPromptSubmit(prompt);
      if (verdict.blocked) return { requests: 0, text: `被拦下：${verdict.reason}` };
      const history = verdict.context.map((text) => ({ role: "user", text: `<system-reminder>${text}</system-reminder>`, meta: true }));
      const engine = new Engine({ model: scripted([{ text: "好的" }]), tools: new Toolset([]) });
      const frames = await collect(engine, prompt, { history });
      const wire = frames.find((f) => f.type === "request").wire;
      return { requests: 1, text: `发出，请求里有 ${wire.messages.length} 条消息：${wire.messages.map((m) => m.text).join(" | ")}` };
    }
    const trusted = makeHooks();
    const secret = await submit(trusted, "我的密码是 hunter2，帮我登录服务器");
    const normal = await submit(trusted, "帮我改一下 README");
    t.table([
      { 提示: "我的密码是 hunter2，帮我登录服务器", 发给模型的请求数: secret.requests, 结果: secret.text },
      { 提示: "帮我改一下 README", 发给模型的请求数: normal.requests, 结果: normal.text },
    ]);
    t.equal("被 UserPromptSubmit 拦下的提示，一个请求都没有发出", secret.requests, 0);
    t.ok("没被拦下的提示带着 Hook 的补充信息一起发出", normal.text.includes("npm test"));

    const startup = await trusted.sessionStart("startup");
    const cleared = await trusted.sessionStart("clear");
    t.table([
      { "source（SessionStart 的匹配字段）": "startup", "matcher 为 startup 或 resume": "运行", 补充信息: startup.context.join("") || "—" },
      { "source（SessionStart 的匹配字段）": "clear", "matcher 为 startup 或 resume": "不运行", 补充信息: cleared.context.join("") || "—" },
    ]);
    t.equal("SessionStart 的纯文本 stdout 成为补充信息", startup.context, ["项目信息：部署脚本是 ./deploy.sh"]);
    t.equal("matcher 看的是 source", cleared.context, []);

    // 没被信任的工作区：所有 Hook 都不运行（克隆一个陌生仓库，它带来的 Hook 不能自动执行）
    const untrusted = makeHooks({ trusted: false });
    const risky = await untrusted.userPromptSubmit("我的密码是 hunter2，帮我登录服务器");
    t.log(`同一条带密码的提示，在没被信任的工作区里：Hook 没有运行，blocked = ${risky.blocked}，运行记录 ${untrusted.log.length} 条。`);
    t.log();
    t.equal("没被信任的工作区里，Hook 一个都不运行", [risky.blocked, untrusted.log.length], [false, 0]);
  }
});
