// 第 9 章实验：Skill。六个小实验，各回答一个问题：
//   discovery   一个目录怎样变成一条命令？名字从哪来？重名谁赢？一个坏文件会怎样？
//   listing     模型平时看到的目录，预算不够时怎样降级？（运行 Claude Code 里真正的 formatCommandsWithinBudget）
//   render      正文在到达模型之前怎样被改写：参数、目录变量、动态注入的 shell 命令
//   permission  哪些 Skill 调用要批准？批准以后授予了什么？
//   fork        context: fork 把正文和授权留在子 Agent 里
//   compaction  压缩之后，用过的 Skill 怎样回来
//
//   node --disable-warning=ExperimentalWarning labs/chapters/09-skills.mjs              全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/09-skills.mjs render       只运行一个
import { lesson, ROOT } from "./harness.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { Engine, collect, scripted } from "../../coda/src/engine.mjs";
import { Toolset } from "../../coda/src/tools.mjs";
import { permissionGate } from "../../coda/src/permissions.mjs";
import { Skills, displayWidth, formatListing, needsApproval, parseSkill, splitArgs, substitute } from "../../coda/src/skills.mjs";
import { upstream } from "../engineering/run.mjs";
import { SOURCE_DIR } from "../../lab/sourcemap.ts";
import { CC_SOURCE } from "../../course/syllabus.ts";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;

// 在 root 下写一组文件：相对路径 → 内容
function put(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// 从固定提交里读一个“名单”常量（new Set([...]) 的字面量），和 upstream() 装载函数是同一个思路：运行时取，不复制进仓库。
function upstreamSet(key) {
  const ref = JSON.parse(readFileSync(join(ROOT, "course/source-references.json"), "utf8"))[key];
  const text = execFileSync("git", ["-C", SOURCE_DIR, "show", `${CC_SOURCE.commit}:${ref.file}`], { encoding: "utf8", maxBuffer: 4e6 });
  const start = text.indexOf(ref.anchor);
  return vm.runInNewContext(text.slice(start, text.indexOf("])", start) + 2).replace(/^const \w+ = /, ""));
}

// 一个项目，里面放了各种形态的 Skill 和旧式命令（前几个实验共用）
const PROJECT = {
  ".claude/skills/release-notes/SKILL.md": [
    "---",
    "name: release-notes",
    "description: 根据提交列表写发布说明。用户要求写发布说明、更新日志、changelog 时使用。",
    "allowed-tools: Bash(cat *), Bash(echo *), Bash(date *)",
    "---",
    "写发布说明的步骤：",
    "1. 读 ${CLAUDE_SKILL_DIR}/template.md，按它的格式写。",
    "2. 把提交按 feat / fix 分组。",
    "",
    "今天的日期：!`date +%Y-%m-%d`",
    "构建编号： !`echo build-$((40+2))`",
    "版本号：$ARGUMENTS",
  ].join("\n"),
  ".claude/skills/release-notes/template.md": "# 版本 <版本号>\n## 新功能\n## 修复\n",
  ".claude/skills/rn/SKILL.md": "---\nname: 发布说明\ndescription: 目录叫 rn，frontmatter 里的 name 是另一个名字。\n---\n简短的发布说明。\n",
  ".claude/skills/secret-helper/SKILL.md": "---\ndescription: 只给人用的内部工具。\ndisable-model-invocation: true\n---\n内部步骤。\n",
  ".claude/skills/deploy-check/SKILL.md": "# 部署前检查清单\n\n1. 跑测试\n2. 看迁移\n",
  ".claude/skills/broken/SKILL.md": "---\nname: a\nname: b\n---\n键重复了。\n",
  ".claude/skills/greet/SKILL.md": "---\ndescription: 目录形式的 greet\n---\n用目录形式向 $ARGUMENTS 问好。\n",
  ".claude/commands/greet.md": "---\ndescription: 旧式命令 greet\n---\n用一句话向 $ARGUMENTS 问好。\n",
  ".claude/commands/ops/deploy.md": "部署到预发环境，然后跑冒烟测试。\n",
};

await lesson(9, "Skill：发现、目录、渲染、授权与 fork", async (t) => {
  // ───────────────────────── 一、发现 ─────────────────────────
  if (wants("discovery")) {
    t.log("一、一个目录怎样变成一条命令");
    t.log();
    const root = join(t.root, "discovery");
    put(root, PROJECT);
    const skills = Skills.discover(root);

    t.table(
      [...skills.entries.values()].map((e) => ({
        来源文件: e.path,
        命令名: e.name,
        显示名: e.displayName ?? "—",
        描述来自: e.descriptionFrom === "frontmatter" ? "frontmatter" : "正文第一行",
        模型的目录里: e.disableModelInvocation ? "没有" : "有",
        "用户能输入 /名字": e.userInvocable ? "能" : "不能",
      })),
    );
    t.log("读不出来的文件（一个坏文件不拖垮别的）：");
    for (const p of skills.problems) t.log(`  ${p.path}  →  ${p.error}`);
    t.log("重名的，先出现的赢（skills 目录先于 commands 目录）：");
    for (const s of skills.shadowed) t.log(`  ${s.path} 被 ${s.by} 盖掉`);
    t.log();

    // 查找：原版 findCommand 和 coda 的 find，对同一批命令回答同一批问题
    const getCommandName = upstream("skill-command-name", "getCommandName");
    const findCommand = upstream("skill-find-command", "findCommand", { getCommandName });
    const commands = [...skills.entries.values()].map((e) => ({ name: e.name, userFacingName: () => e.displayName ?? e.name }));
    const keys = ["rn", "发布说明", "ops:deploy", "deploy", "greet", "secret-helper"];
    const rows = keys.map((key) => ({
      输入: key,
      "原版 findCommand": findCommand(key, commands)?.name,
      "coda find": skills.find(key)?.name,
    }));
    t.table(rows.map((r) => ({ ...r, "原版 findCommand": r["原版 findCommand"] ?? "（找不到）", "coda find": r["coda find"] ?? "（找不到）" })));
    t.equal("六个输入上，coda 的 find 和原版的 findCommand 回答一致", rows.map((r) => r["coda find"]), rows.map((r) => r["原版 findCommand"]));

    t.ok("目录形式的 greet 盖掉了旧式命令 greet", skills.find("greet").kind === "skill" && skills.shadowed.length === 1);
    t.equal("disable-model-invocation 的 Skill 不进模型的目录，但用户仍能找到它", [skills.visibleToModel().some((s) => s.name === "secret-helper"), Boolean(skills.find("secret-helper"))], [false, true]);
    t.equal("名字是目录名，frontmatter 的 name 只是显示名；两个都能查到", [skills.find("rn").name, skills.find("发布说明").name], ["rn", "rn"]);
    t.equal("坏文件被记录下来，其余照常加载", [skills.problems.length, skills.entries.has("release-notes")], [1, true]);
    t.equal("没有 description 时取正文第一行", skills.find("deploy-check").description, "部署前检查清单");

    // 最小用法：原来的接口
    put(join(t.root, "minimal"), {
      "SKILL.md": "---\nname: review\ndescription: Review slug code\nallowed-tools: Read, Test\ncontext: fork\n---\nRead code and give counterexamples.",
    });
    const minimal = new Skills(join(t.root, "minimal"), ["SKILL.md"]);
    t.equal("descriptions() 只返回名字和描述", minimal.descriptions(), [{ name: "review", description: "Review slug code" }]);
    t.equal("用 /名字 加载，拿到正文", minimal.load("/review").body, "Read code and give counterexamples.");
    t.equal("allowed-tools 和 fork 是单独的字段，不在正文里", [minimal.load("review").allowedTools, minimal.load("review").fork], [["Read", "Test"], true]);
    t.throws("未知的名字有明确的错误", () => minimal.load("missing"), /unknown skill/);
    t.throws("frontmatter 里重复的键直接报错", () => parseSkill("---\nname: a\nname: b\n---\nx"), /duplicate/);
    t.equal("括号里的逗号不是分隔符", parseSkill('---\nallowed-tools: Bash(git commit -m "x, y"), Read\n---\n').allowedTools, ['Bash(git commit -m "x, y")', "Read"]);
    t.log();
  }

  // ───────────────────────── 二、目录与预算 ─────────────────────────
  if (wants("listing")) {
    t.log("二、模型平时看到的目录：预算够不够，决定它长什么样");
    t.log();
    // 十四个 Skill，描述各约一百多列宽
    const topics = ["发布说明", "代码审查", "数据库迁移", "性能分析", "接口文档", "安全检查", "依赖升级", "日志排查", "测试补全", "回滚方案", "容量评估", "故障复盘", "变更公告", "新人引导"];
    const catalogue = topics.map((topic, i) => ({
      name: `skill-${String(i + 1).padStart(2, "0")}`,
      description: `负责${topic}：先读现有材料，再按团队模板整理成可以直接发布的文字。`,
      whenToUse: i % 3 === 0 ? `用户提到${topic}时使用` : undefined,
    }));

    // 原版 formatCommandsWithinBudget：从固定提交里装载。它依赖的几个小函数（算预算、拼一行、取描述、截断）也都是原版的；
    // 只有“一个字符占几列”（stringWidth）、环境变量和统计事件是我们提供的端口。
    const env = { process: { env: {} } };
    const stringWidth = displayWidth;
    const truncateToWidth = upstream("skill-truncate-width", "truncateToWidth", { stringWidth, getGraphemeSegmenter: () => new Intl.Segmenter() });
    const truncate = upstream("skill-truncate", "truncate", { stringWidth, truncateToWidth });
    const getCharBudget = upstream("skill-listing-char-budget", "getCharBudget", { ...env, CHARS_PER_TOKEN: 4, SKILL_BUDGET_CONTEXT_PERCENT: 0.01, DEFAULT_CHAR_BUDGET: 8000 });
    const getCommandDescription = upstream("skill-listing-description", "getCommandDescription", { MAX_LISTING_DESC_CHARS: 250 });
    const formatCommandDescription = upstream("skill-listing-line", "formatCommandDescription", { getCommandName: (c) => c.name, logForDebugging() {}, getCommandDescription });
    const original = upstream("skill-listing-budget", "formatCommandsWithinBudget", {
      ...env, getCharBudget, formatCommandDescription, getCommandDescription, stringWidth, truncate, logEvent() {},
      count: (list, test) => list.filter(test).length, MIN_DESC_LENGTH: 20,
    });
    const asCommands = (list) => list.map((s) => ({ type: "prompt", source: "projectSettings", ...s }));

    const tier = (text) => (text.includes("…") ? "描述被截短" : text.includes(": ") ? "完整描述" : "只剩名字");
    const windows = [200_000, 20_000, 8_000];
    const outputs = windows.map((window) => ({ window, theirs: original(asCommands(catalogue), window), ours: formatListing(catalogue, window) }));
    t.table(
      outputs.map(({ window, theirs }) => ({
        上下文窗口: `${window / 1000}K token`,
        "预算（列）": getCharBudget(window),
        档位: tier(theirs),
        目录实际占用: theirs.split("\n").reduce((n, l) => n + displayWidth(l), 0) + theirs.split("\n").length - 1,
      })),
    );
    for (const { window, theirs } of outputs) {
      t.log(`${window / 1000}K 的目录，前两行：`);
      t.log(theirs.split("\n").slice(0, 2).map((l) => `  ${l}`).join("\n"));
    }
    t.equal("三种预算下，coda 的目录和原版逐字一致", outputs.map((o) => o.ours), outputs.map((o) => o.theirs));
    t.equal("三种预算分别落在三档", outputs.map((o) => tier(o.theirs)), ["完整描述", "描述被截短", "只剩名字"]);
    t.log();

    // 单条描述的上限：250 个字符
    const long = [{ name: "long", description: "很长的描述。".repeat(80) }];
    const line = formatListing(long);
    t.equal("单条描述最长 250 个字符（含省略号）", [line.length - "- long: ".length, line.endsWith("…")], [250, true]);
    t.equal("原版同样的上限", original(asCommands(long), 200_000), line);

    // 目录是对话里的一条附件：只发没发过的
    const root = join(t.root, "listing");
    put(root, PROJECT);
    const skills = Skills.discover(root);
    const first = skills.announce().split("\n");
    const second = skills.announce();
    t.log(`第一次 announce：${first.length} 条（${first.map((l) => l.match(/^- (\S+?):\s/)[1]).join("、")}）`);
    t.log(`第二次 announce：${second === "" ? "什么也不发（没有新 Skill）" : second}`);
    t.equal("announce 只发没发过的；disable-model-invocation 的不在其中", [first.length, second, first.some((l) => l.includes("secret-helper"))], [skills.visibleToModel().length, "", false]);
    t.log();
  }

  // ───────────────────────── 三、渲染 ─────────────────────────
  if (wants("render")) {
    t.log("三、正文在到达模型之前被改写");
    t.log();
    // 3.1 参数替换：原版 substituteArguments（从固定提交里装载）和 coda 的 substitute 比较
    // parseArguments 里切分参数用的是 shell-quote；这里换成我们自己的 splitArgs（支持引号），这是唯一的端口。
    const parseArguments = upstream("skill-parse-arguments", "parseArguments", { tryParseShellCommand: (text) => ({ success: true, tokens: splitArgs(text) }) });
    const original = upstream("skill-substitute", "substituteArguments", { parseArguments });
    const cases = [
      ["版本号：$ARGUMENTS", "v2.0", [], "整串参数"],
      ["第一个：$0，第二个：$1", 'a "b c"', [], "$n 从 0 开始，引号里的空格不切开"],
      ["$who 要做 $what", "小明 写测试", ["who", "what"], "frontmatter 里声明的具名参数"],
      ["价格 $5 起", "", [], "正文里碰巧写了 $5"],
      ["没有占位符的正文", "v2.0", [], "参数不为空：附在最后"],
      ["没有占位符的正文", "", [], "参数为空：原样"],
      ["价格：$ARGUMENTS", "cost $$5", [], "参数里有 $$"],
      ["A=$ARGUMENTS[0] B=$1", "'$1' second", [], "参数的值里有 $1"],
    ];
    const rows = cases.map(([body, args, names, note]) => {
      const theirs = original(body, args, true, names);
      const ours = substitute(body, args, names);
      return { 正文: body, 参数: JSON.stringify(args), 原版的结果: JSON.stringify(theirs), coda: ours === theirs ? "同" : JSON.stringify(ours), 说明: note, theirs, ours };
    });
    t.table(rows.map(({ theirs, ours, ...show }) => show));
    t.equal("除“参数里有 $$”一行，coda 与原版逐字一致", rows.filter((r) => !r.说明.includes("$$")).map((r) => r.ours), rows.filter((r) => !r.说明.includes("$$")).map((r) => r.theirs));
    t.equal("“$$”一行：原版把 $$ 当成转义，coda 用函数形式保留", rows.filter((r) => r.说明.includes("$$")).map((r) => [r.theirs, r.ours]), [["价格：cost $5", "价格：cost $$5"]]);
    t.equal("没有传参数（undefined）时正文原样返回", [original("价格 $5 起", undefined, true, []), substitute("价格 $5 起", undefined)], ["价格 $5 起", "价格 $5 起"]);

    // 3.2 动态注入的几种情形
    t.log("动态注入的几种情形（每一行是同一个模板的一次渲染）：");
    const root = join(t.root, "render");
    const ALLOW = "allowed-tools: Bash(echo *), Bash(date *), Bash(false)";
    const skillFile = (body, header = ALLOW) => `---\ndescription: 实验\n${header}\n---\n${body}`;
    put(root, {
      ".claude/skills/colon/SKILL.md": skillFile("今天的日期：!`date +%Y`\n构建编号： !`echo build-$((40+2))`"),
      ".claude/skills/fence/SKILL.md": skillFile("前\n```!\necho from-block\n```\n后"),
      ".claude/skills/denied/SKILL.md": skillFile("先说一句\n清理： !`rm -rf data`"),
      ".claude/skills/failing/SKILL.md": skillFile("结果： !`false`"),
      ".claude/skills/args/SKILL.md": skillFile("你输入的是： !`echo $ARGUMENTS`"),
    });
    const skills = Skills.discover(root);
    const attempt = async (name, args = "") => {
      try {
        return { ok: true, text: (await skills.expand(name, args)).text.split("\n\n").slice(1).join("\n\n") };
      } catch (error) {
        return { ok: false, text: String(error.message) };
      }
    };
    const scenarios = [
      ["colon", "", "前面是全角冒号的写法不触发；前面是空格的触发"],
      ["fence", "", "围栏写法（三个反引号后面跟感叹号）也触发"],
      ["denied", "", "命令不在 allowed-tools 里：整个渲染失败"],
      ["failing", "", "命令退出码非 0：整个渲染失败"],
      ["args", "你好", "参数先替换进命令，再检查、执行"],
      ["args", "hi; touch pwned", "参数想夹带第二条命令：检查的是替换之后的整串"],
    ];
    const results = [];
    for (const [name, args] of scenarios) results.push(await attempt(name, args));
    t.table(
      scenarios.map(([name, args, note], i) => ({
        场景: note,
        参数: args ? JSON.stringify(args) : "—",
        结果: results[i].ok ? "渲染成功" : "渲染失败",
        "模型看到的 / 错误信息": results[i].text.replace(/\n/g, " ⏎ "),
      })),
    );
    t.ok("全角冒号后的 !`date` 原样保留，空格后的 !`echo` 执行了", results[0].text.includes("!`date +%Y`") && results[0].text.includes("build-42"));
    t.ok("围栏块里的命令执行了", results[1].ok && results[1].text.includes("from-block"));
    t.ok("不被允许的命令让整个渲染失败，错误里有命令本身", !results[2].ok && results[2].text.includes("rm -rf data"));
    t.ok("退出码非 0 让整个渲染失败", !results[3].ok && /exit 1/.test(results[3].text));
    t.ok("无害的参数照常执行", results[4].ok && results[4].text.includes("你输入的是： 你好"));
    t.ok("夹带命令的参数被拒绝，副作用没有发生", !results[5].ok && !existsSync(join(root, ".claude/skills/args/pwned")));

    // 3.3 完整渲染：基准目录、变量、参数、注入都在
    put(join(t.root, "render-full"), PROJECT);
    const full = Skills.discover(join(t.root, "render-full"));
    const rendered = (await full.expand("release-notes", "v2.0")).text;
    t.log("release-notes 带着参数 v2.0 渲染之后，模型看到的是：");
    t.log(rendered.replaceAll(full.root, "<项目>").split("\n").map((l) => `  │ ${l}`).join("\n"));
    t.ok("渲染后不再有占位符", !/\$ARGUMENTS|\$\{CLAUDE_SKILL_DIR\}/.test(rendered) && rendered.startsWith("Base directory for this skill:"));
    t.log();
  }

  // ───────────────────────── 四、权限与授权 ─────────────────────────
  if (wants("permission")) {
    t.log("四、谁需要批准，批准之后授予了什么");
    t.log();
    // 4.1 白名单：原版的 skillHasOnlySafeProperties（从固定提交里装载），名单本身（SAFE_SKILL_PROPERTIES）也是运行时读出来的。
    // 命令对象由原版的 createSkillCommand 创建；frontmatter → 字段的映射是我们按它的解析规则手写的。
    const createSkillCommand = upstream("skill-create-command", "createSkillCommand");
    const hasOnlySafe = upstream("skill-safe-check", "skillHasOnlySafeProperties", { SAFE_SKILL_PROPERTIES: upstreamSet("skill-safe-set") });
    const base = {
      skillName: "demo", displayName: undefined, description: "d", hasUserSpecifiedDescription: true, markdownContent: "正文", allowedTools: [],
      argumentHint: undefined, argumentNames: [], whenToUse: undefined, version: undefined, model: undefined, disableModelInvocation: false,
      userInvocable: true, source: "projectSettings", baseDir: "/tmp/demo", loadedFrom: "skills", hooks: undefined, executionContext: undefined,
      agent: undefined, paths: undefined, effort: undefined, shell: undefined,
    };
    const hooks = { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "./check.sh" }] }] };
    const variants = [
      ["只有 description", {}, {}, {}],
      ["allowed-tools: Bash(cat *)", { allowedTools: ["Bash(cat *)"] }, { allowedTools: ["Bash(cat *)"] }, {}],
      ["allowed-tools:（空）", { allowedTools: [] }, { allowedTools: [] }, {}],
      ["hooks: …", { hooks }, { hooks }, {}],
      ["context: fork", { executionContext: "fork" }, { fork: true }, {}],
      ["context: fork + agent: Explore", { executionContext: "fork", agent: "Explore" }, { fork: true, agent: "Explore" }, {}],
      ["model: opus", { model: "opus" }, { model: "opus" }, {}],
      ["paths: src/**/*.ts", { paths: ["src/**/*.ts"] }, { paths: ["src/**/*.ts"] }, {}],
      ["disable-model-invocation: true", { disableModelInvocation: true }, { disableModelInvocation: true }, {}],
      ["（代码里新增了一个字段 webhook）", {}, { webhook: { url: "https://example.com" } }, { webhook: { url: "https://example.com" } }],
    ];
    const rows = variants.map(([label, override, mine, extra]) => {
      const command = Object.assign(createSkillCommand({ ...base, ...override }), extra);
      return { label, theirs: !hasOnlySafe(command), ours: needsApproval({ name: "demo", description: "d", allowedTools: [], ...mine }) };
    });
    t.table(rows.map((r) => ({ "frontmatter 里写的": r.label, "原版 Skill 工具要问吗": r.theirs ? "要问" : "不问", coda: r.ours ? "要问" : "不问" })));
    t.equal("十种写法上，coda 与原版对“要不要问”的回答一致", rows.map((r) => r.ours), rows.map((r) => r.theirs));
    t.equal("只有 allowed-tools 和 hooks 以及未登记的新字段要问", rows.filter((r) => r.theirs).map((r) => r.label), ["allowed-tools: Bash(cat *)", "hooks: …", "（代码里新增了一个字段 webhook）"]);

    // 4.2 录制 vs coda：同样三种设置
    const recorded = (name) => {
      const r = JSON.parse(readFileSync(join(ROOT, `labs/ch09/recorded/${name}.json`), "utf8"));
      const use = r.events.flatMap((e) => (e.type === "assistant" ? e.message.content.filter((b) => b.type === "tool_use" && b.name === "Skill") : []))[0];
      const result = r.events.flatMap((e) => (e.type === "user" && Array.isArray(e.message.content) ? e.message.content : [])).find((b) => b.type === "tool_result" && b.tool_use_id === use.id);
      const asked = r.hooks.some((h) => h.event === "PermissionRequest" && h.payload.tool_name === "Skill");
      return { 输入: use.input.skill, 结果: String(result.content).replace(/\s+/g, " "), 弹了询问: asked, 出错: !!result.is_error };
    };
    const root = join(t.root, "permission");
    put(root, PROJECT);
    put(root, { ".claude/skills/plain/SKILL.md": "---\ndescription: 没有 allowed-tools 的版本\n---\n只是说明。\n" });
    const run = async (skillName, allow) => {
      const asked = [];
      const skills = Skills.discover(root);
      const rules = { allow, ask: [], deny: [] };
      const tool = skills.tool({ rules });
      const toolset = new Toolset([tool], { gate: permissionGate({ mode: "default", rules, ask: async (call) => (asked.push(call.name), false) }) });
      const result = await toolset.execute({ id: "t1", name: "Skill", input: { name: skillName } });
      return { asked: asked.length > 0, error: result.error, text: result.text, skills };
    };
    const denied = await run("release-notes", []);
    const auto = await run("release-notes", ["Skill(release-notes)"]);
    const plain = await run("plain", []);
    const cc = { denied: recorded("denied"), auto: recorded("auto"), plain: recorded("plain") };
    const verdict = (r) => (r.error ? (r.asked ? "询问，没人批准 → 失败" : "失败") : "成功");
    t.table([
      { 设置: "Skill 带 allowed-tools，没有规则", "Claude Code 录制（2.1.296）": `${cc.denied.弹了询问 ? "弹出询问，-p 模式没人批准 → 失败" : "?"}（“${cc.denied.结果}”）`, coda: verdict(denied) },
      { 设置: "同上，加规则 Skill(release-notes)", "Claude Code 录制（2.1.296）": `不询问 → ${cc.auto.出错 ? "失败" : "成功"}（“${cc.auto.结果}”）`, coda: verdict(auto) },
      { 设置: "去掉 allowed-tools，没有规则", "Claude Code 录制（2.1.296）": `不询问 → ${cc.plain.出错 ? "失败" : "成功"}（“${cc.plain.结果}”）`, coda: verdict(plain) },
    ]);
    t.ok("带 allowed-tools 的 Skill：询问了，没人批准，失败", denied.asked && denied.error && cc.denied.弹了询问 && cc.denied.出错);
    t.ok("加了 Skill(名字) 规则：不询问，成功", !auto.asked && !auto.error && !cc.auto.弹了询问 && !cc.auto.出错);
    t.ok("没有 allowed-tools：不询问，成功", !plain.asked && !plain.error && !cc.plain.弹了询问 && !cc.plain.出错);

    // 4.3 批准之后授予了什么：把 Skill 授予的规则并进权限规则，看后面的调用
    t.log("授权的范围和寿命：");
    const decisions = [];
    const asked = [];
    const skills = Skills.discover(root);
    const baseRules = { allow: ["Skill(release-notes)"], ask: [], deny: [] };
    const rules = { get allow() { return [...baseRules.allow, ...skills.grantedRules()]; }, ask: [], deny: [] };
    const bash = { name: "Bash", description: "实验用：只记录命令，不真正运行", schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, validate() {}, execute: (input) => ({ text: `（假装运行了 ${input.command}）` }) };
    const toolset = new Toolset([skills.tool({ rules }), bash], {
      gate: permissionGate({ mode: "default", rules, ask: async (call) => (asked.push(call), false), onDecision: (call, d) => decisions.push({ call, d }) }),
    });
    const poolBefore = [...toolset.tools.keys()];
    const step = async (label, call) => {
      const before = asked.length;
      const result = await toolset.execute({ id: `s${decisions.length}`, ...call });
      const d = decisions.at(-1).d;
      return { 步骤: label, 决定: d.behavior === "allow" ? `放行（${d.source}${d.rule ? `：${d.rule}` : ""}）` : "询问 → 拒绝", 结果: result.error ? "失败" : "成功", 问了用户: asked.length > before ? "问了" : "没问" };
    };
    const cat = { name: "Bash", input: { command: "cat notes.txt" } };
    const steps = [
      await step("① 调用 Skill 之前：cat notes.txt", cat),
      await step("② 调用 Skill（规则放行）", { name: "Skill", input: { name: "release-notes" } }),
      await step("③ cat notes.txt", cat),
      await step("④ rm notes.txt", { name: "Bash", input: { command: "rm notes.txt" } }),
    ];
    skills.resetGrants();
    steps.push(await step("⑤ 一轮结束 resetGrants() 之后：cat notes.txt", cat));
    t.table(steps);
    t.equal("① 之前要问；③ 被授权的命令不再问；④ 授权之外的命令照常问；⑤ 授权随这一轮结束而失效", steps.map((s) => s.问了用户), ["问了", "没问", "没问", "问了", "问了"]);
    t.equal("授权的是规则，不改变工具池", [...toolset.tools.keys()], poolBefore);
    t.log(`工具池在调用 Skill 前后都是：${poolBefore.join("、")}`);
    t.log();
  }

  // ───────────────────────── 五、fork ─────────────────────────
  if (wants("fork")) {
    t.log("五、context: fork —— 正文和授权留在子 Agent 里");
    t.log();
    const root = join(t.root, "fork");
    put(root, {
      "notes.txt": "第 1 行：登录接口没有限流\n第 2 行：密码用了 md5\n",
      ".claude/skills/audit/SKILL.md": "---\ndescription: 安全审计\ncontext: fork\nallowed-tools: Bash(cat *)\n---\n审计步骤：读 notes.txt，指出最严重的一条，只回报这一条。\n",
    });
    const runs = [];
    const childSaw = []; //  子 Agent 的对话里出现过的文字
    const childAsked = [];
    // 一个会记录命令的假 Bash
    const bash = { name: "Bash", description: "实验用", schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }, validate() {}, execute: (input) => ({ text: readFileSync(join(root, "notes.txt"), "utf8") }) };
    const fork = async ({ skill, prompt, grants, signal }) => {
      // 子 Agent：自己的 Engine，自己的对话；授权只加给它
      const rules = { allow: grants, ask: [], deny: [] };
      const toolset = new Toolset([bash], { gate: permissionGate({ mode: "default", rules, ask: async (call) => (childAsked.push(call), false) }) });
      const child = new Engine({
        model: scripted([{ calls: [{ id: "c1", name: "Bash", input: { command: "cat notes.txt" } }] }, { text: "最严重：密码用了 md5（第 2 行）" }]),
        tools: toolset,
      });
      const frames = await collect(child, prompt, { signal, context: { root } });
      const history = frames.at(-1).messages;
      childSaw.push(...history.map((m) => m.text ?? ""));
      runs.push({ skill: skill.name, turns: history.filter((m) => m.role === "assistant").length });
      return frames.filter((f) => f.type === "assistant").at(-1).message.text;
    };
    const skills = Skills.discover(root, undefined, { fork });
    const parentTools = new Toolset([skills.tool(), bash], { gate: async () => true });
    const parent = new Engine({
      model: scripted([{ calls: [{ id: "p1", name: "Skill", input: { name: "audit" } }] }, { text: "审计完成。" }]),
      tools: parentTools,
    });
    const frames = await collect(parent, "审计一下这个项目", { context: { root } });
    const parentSaw = frames.at(-1).messages.map((m) => m.text ?? "");

    const seen = (texts, part) => (texts.some((x) => x.includes(part)) ? "看到" : "—");
    t.table([
      { 内容: "Skill 的正文（审计步骤……）", 父: seen(parentSaw, "审计步骤"), 子: seen(childSaw, "审计步骤") },
      { 内容: "子 Agent 读到的 notes.txt", 父: seen(parentSaw, "登录接口没有限流"), 子: seen(childSaw, "登录接口没有限流") },
      { 内容: "子 Agent 的结论", 父: seen(parentSaw, "密码用了 md5"), 子: seen(childSaw, "密码用了 md5") },
      { 内容: "Skill 授予的 Bash(cat *)", 父: skills.grantedRules().length ? "有" : "—", 子: childAsked.length === 0 ? "有（cat 没有询问）" : "—" },
    ]);
    const result = frames.filter((f) => f.type === "tool_result").at(-1).message;
    t.log("父 Agent 收到的 Skill 工具结果：");
    t.log(result.text.split("\n").map((l) => `  │ ${l}`).join("\n"));
    t.ok("正文只在子 Agent 的对话里", seen(parentSaw, "审计步骤") === "—" && seen(childSaw, "审计步骤") === "看到");
    t.ok("子 Agent 的工具调用和读到的文件，父 Agent 看不到", seen(parentSaw, "登录接口没有限流") === "—");
    t.ok("只有结论回到父 Agent，包在工具结果里", result.text.includes("completed (forked execution)") && result.text.includes("密码用了 md5"));
    t.equal("授权只加给子 Agent：父亲没有，子 Agent 的 cat 没有询问", [skills.grantedRules(), childAsked.length], [[], 0]);
    t.log();
  }

  // ───────────────────────── 六、压缩之后 ─────────────────────────
  if (wants("compaction")) {
    t.log("六、压缩之后，用过的 Skill 怎样回来");
    t.log();
    const root = join(t.root, "compaction");
    const body = (mark, n) => `${mark}${"。内容".repeat(n)}`;
    put(root, {
      ".claude/skills/early/SKILL.md": `---\ndescription: 最早调用\n---\n${body("早", 40)}`,
      ".claude/skills/middle/SKILL.md": `---\ndescription: 中间调用，正文很长\n---\n${body("中", 400)}`,
      ".claude/skills/late/SKILL.md": `---\ndescription: 最近调用\n---\n${body("近", 40)}`,
    });
    const skills = Skills.discover(root);
    for (const name of ["early", "middle", "late"]) await skills.expand(name);
    // 真实的预算是每个 5000、总共 25000 个 token；这里缩小到 100 和 175，才看得见取舍
    const options = { perSkill: 100, total: 175 };
    const recalled = skills.recall(options);
    const sections = recalled.split("\n\n---\n\n").map((s) => s.replace(/^[\s\S]*?(?=### Skill)/, ""));
    t.table(
      ["early", "middle", "late"].map((name) => {
        const section = sections.find((s) => s.startsWith(`### Skill: ${name}`));
        const full = skills.invoked.get(name).text;
        return {
          Skill: name,
          调用顺序: skills.invoked.get(name).at,
          "渲染后约（token）": Math.ceil(full.length / 4),
          压缩后: !section ? "放不下，丢掉" : section.includes("压缩时被截断") ? "保留开头，其余截断" : "完整保留",
        };
      }),
    );
    t.equal("最近的优先；太长的截断开头；总预算用完，最早的被丢掉", sections.map((s) => s.match(/### Skill: (\w+)/)[1]), ["late", "middle"]);
    t.ok("截断的那个留下了重新调用的提示", sections[1].includes("重新调用"));
    t.equal("没有调用过的 Skill 不会出现", Skills.discover(root).recall(), "");
    t.log();
  }
});
