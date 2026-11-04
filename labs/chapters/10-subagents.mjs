// 第 10 章实验：子 Agent。七个小实验，各回答一个问题：
//   pool         子 Agent 的工具池是怎么缩小的？（运行 Claude Code 里真正的 resolveAgentTools）
//   builtins     内置有哪几位，各自带什么？同名的定义谁说了算？（运行真正的 getBuiltInAgents）
//   context      子 Agent 带进去什么？项目说明、父历史、文件版本记录
//   permissions  权限只收紧、不放宽：后台没人可问
//   report       交回父 Agent 的是什么
//   cancel       前台、后台各被什么取消？停下来的子 Agent 还交回什么？
//   model        子 Agent 用哪个模型？（运行真正的 getAgentModel）
//
//   node --disable-warning=ExperimentalWarning labs/chapters/10-subagents.mjs              全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/10-subagents.mjs context      只运行一个
import { lesson } from "./harness.mjs";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codingTools } from "../../coda/src/files.mjs";
import { scripted } from "../../coda/src/engine.mjs";
import { Toolset } from "../../coda/src/tools.mjs";
import {
  BUILT_IN_AGENTS,
  BackgroundChildren,
  reportForParent,
  resolveChildModel,
  resolveChildTools,
  runChild,
} from "../../coda/src/subagents.mjs";
import { upstream } from "../engineering/run.mjs";
import { shippedGates, shippedToolLists } from "../ch10/bundle.ts";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;
const plain = (value) => JSON.parse(JSON.stringify(value));
const names = (tools) => tools.map((tool) => tool.name);
const list = (items) => (items.length ? items.join("、") : "（没有）");

// ───────────── 从固定提交里装载 Claude Code 的真实函数和真实定义 ─────────────
// 这些函数依赖的“外部世界”（工具名常量、开关、模型解析）用端口替换；函数本身和内置定义的字段不动。
// 发布版里的两张禁用 / 允许清单，从 cli.js 里读出来（见 labs/ch10/bundle.ts）。
const shipped = shippedToolLists();
const gates = shippedGates();
const TOOL_NAMES = {
  AGENT_TOOL_NAME: "Agent",
  EXIT_PLAN_MODE_TOOL_NAME: "ExitPlanMode",
  FILE_EDIT_TOOL_NAME: "Edit",
  FILE_WRITE_TOOL_NAME: "Write",
  NOTEBOOK_EDIT_TOOL_NAME: "NotebookEdit",
  FILE_READ_TOOL_NAME: "Read",
  BASH_TOOL_NAME: "Bash",
  GLOB_TOOL_NAME: "Glob",
  GREP_TOOL_NAME: "Grep",
  WEB_FETCH_TOOL_NAME: "WebFetch",
  WEB_SEARCH_TOOL_NAME: "WebSearch",
  SEND_MESSAGE_TOOL_NAME: "SendMessage",
};
// 定义文件顶部那些提示词、描述常量与本实验无关，用空串顶替；工具名、模型、开关等字段是真的。
const DEFINITION_PORTS = {
  ...TOOL_NAMES,
  hasEmbeddedSearchTools: () => false,
  process: { env: {} },
  EXPLORE_WHEN_TO_USE: "",
  CLAUDE_CODE_GUIDE_AGENT_TYPE: "claude-code-guide",
  STATUSLINE_SYSTEM_PROMPT: "",
  getGeneralPurposeSystemPrompt: () => "",
  getExploreSystemPrompt: () => "",
  getPlanV2SystemPrompt: () => "",
};
function loadDefinitions() {
  const explore = upstream("agent-def-explore", "EXPLORE_AGENT", DEFINITION_PORTS);
  return {
    "general-purpose": upstream("agent-def-general", "GENERAL_PURPOSE_AGENT", DEFINITION_PORTS),
    "statusline-setup": upstream("agent-def-statusline", "STATUSLINE_SETUP_AGENT", DEFINITION_PORTS),
    "claude-code-guide": upstream("agent-def-guide", "CLAUDE_CODE_GUIDE_AGENT", DEFINITION_PORTS),
    Explore: explore,
    Plan: upstream("agent-def-plan", "PLAN_AGENT", { ...DEFINITION_PORTS, EXPLORE_AGENT: explore }),
  };
}

await lesson(10, "子 Agent：工具池、上下文、报告与取消", async (t) => {
  const real = loadDefinitions();

  // ───────────────────────── 一、工具池 ─────────────────────────
  if (wants("pool")) {
    t.log("一、子 Agent 的工具池：原函数 resolveAgentTools，对照 coda 的 resolveChildTools");
    t.log();
    const lists = {
      ALL_AGENT_DISALLOWED_TOOLS: new Set(shipped.allDisallowed),
      CUSTOM_AGENT_DISALLOWED_TOOLS: new Set(shipped.allDisallowed),
      ASYNC_AGENT_ALLOWED_TOOLS: new Set(shipped.asyncAllowed),
      IN_PROCESS_TEAMMATE_ALLOWED_TOOLS: new Set(),
      EXIT_PLAN_MODE_V2_TOOL_NAME: "ExitPlanMode",
      AGENT_TOOL_NAME: "Agent",
      toolMatchesName: (tool, name) => tool.name === name,
      isAgentSwarmsEnabled: () => false,
      isInProcessTeammate: () => false,
    };
    const filterToolsForAgent = upstream("agent-filter", "filterToolsForAgent", lists);
    // "Agent(a,b)" 写法的解析是权限模块的事（第 6 章），这里只需要把工具名和括号里的内容拆开
    const parseSpec = (spec) => {
      const match = /^([^()]+)\((.*)\)$/.exec(spec);
      return match ? { toolName: match[1], ruleContent: match[2] } : { toolName: spec };
    };
    const resolveAgentTools = upstream("agent-resolve", "resolveAgentTools", {
      AGENT_TOOL_NAME: "Agent",
      filterToolsForAgent,
      permissionRuleValueFromString: parseSpec,
    });
    // 一个接近发布版的工具目录（名字是真的，实现是空的）：外加一个 MCP 工具
    const catalogue = [
      "Agent", "TaskOutput", "Bash", "Glob", "Grep", "ExitPlanMode", "Read", "Edit", "Write", "NotebookEdit",
      "WebFetch", "TodoWrite", "WebSearch", "TaskStop", "AskUserQuestion", "Skill", "EnterPlanMode", "SendMessage",
      "mcp__github__search",
    ].map((name) => ({ name }));
    const reviewer = { tools: ["Read", "Grep", "Glob"], source: "projectSettings" }; // 第 10 章录制里的自定义 Agent
    const editor = { tools: ["Read", "Edit", "SendMessage"], source: "projectSettings" };
    const cases = [
      ["general-purpose（tools: *）", real["general-purpose"]],
      ["Explore（只有 disallowedTools）", real.Explore],
      ["自定义 reviewer（tools: Read, Grep, Glob）", reviewer],
      ["自定义 editor（tools: Read, Edit, SendMessage）", editor],
    ];
    const resolved = (definition, isAsync) => names(plain(resolveAgentTools(definition, catalogue, isAsync).resolvedTools));
    t.table(
      cases.map(([label, definition]) => ({
        定义: label,
        "前台拿到": list(resolved(definition, false)),
        "后台拿到": list(resolved(definition, true)),
      })),
    );
    const general = resolved(real["general-purpose"], false);
    t.log(`目录有 ${catalogue.length} 个工具；general-purpose 在前台少了 ${list(catalogue.map((x) => x.name).filter((n) => !general.includes(n)))}。`);
    t.log();
    t.ok("Agent 不在任何子 Agent 的工具池里", cases.every(([, d]) => !resolved(d, false).includes("Agent") && !resolved(d, true).includes("Agent")));
    t.ok("后台子 Agent 拿不到 SendMessage，前台可以", !resolved(real["general-purpose"], true).includes("SendMessage") && resolved(real["general-purpose"], false).includes("SendMessage"));
    t.ok("MCP 工具对 general-purpose 前台后台都放行", resolved(real["general-purpose"], true).includes("mcp__github__search"));
    t.ok("写了允许清单的 Agent 拿不到没列出的 MCP 工具（reviewer 没有 mcp__github__search）", !resolved(reviewer, false).includes("mcp__github__search"));

    // coda 的三层缩小：同样的定义，在 coda 自己的工具目录上
    const codaTools = [...codingTools(t.root), { name: "Agent" }, { name: "mcp__echo" }];
    const codaCases = [
      ["general-purpose", BUILT_IN_AGENTS["general-purpose"]],
      ["Explore", BUILT_IN_AGENTS.Explore],
      ["只读缺省（allow: Read）", { type: "read-only", tools: ["Read"] }],
    ];
    t.table(
      codaCases.map(([label, definition]) => {
        const { tools, removed } = resolveChildTools(definition, codaTools);
        return { 定义: label, 拿到: list(names(tools)), 去掉的和原因: removed.map((r) => `${r.name}（${r.layer}）`).join("；") };
      }),
    );

    // 两边在共有的工具上给出同样的池：coda 的 Test 在 Claude Code 里没有对应物，比较时去掉
    const shared = ["Agent", "Read", "Edit", "Write", "Skill", "mcp__github__search"];
    const sharedCatalogue = shared.map((name) => ({ name }));
    const pairs = [
      [real["general-purpose"], BUILT_IN_AGENTS["general-purpose"]],
      [real.Explore, BUILT_IN_AGENTS.Explore],
      [reviewer, { tools: ["Read", "Grep", "Glob"] }],
      [editor, { tools: ["Read", "Edit", "SendMessage"] }],
    ];
    for (const [original, mine] of pairs) {
      const expected = names(plain(resolveAgentTools(original, sharedCatalogue, false).resolvedTools));
      t.equal(`coda 与原函数的工具池一致：${original.agentType ?? original.tools.join("+")}`, names(resolveChildTools(mine, sharedCatalogue).tools), expected);
    }
    t.log();
  }

  // ───────────────────────── 二、内置的几位 ─────────────────────────
  if (wants("builtins")) {
    t.log("二、内置 Agent：真实的定义字段，以及发布版里它们出现的条件");
    t.log();
    t.table(
      Object.entries(real).map(([type, d]) => ({
        类型: type,
        模型: d.model ?? "（继承父 Agent）",
        "tools（允许清单）": d.tools ? d.tools.join("、") : "（不写：全部）",
        "disallowedTools（禁用清单）": d.disallowedTools ? d.disallowedTools.join("、") : "—",
        "不带 CLAUDE.md": d.omitClaudeMd ? "是" : "—",
        权限模式: d.permissionMode ?? "—",
      })),
    );

    // 真正的 getBuiltInAgents，在几种环境下各返回哪些
    const agentList = ({ flags = {}, env = {}, nonInteractive = false, amberStoat = true } = {}) => {
      const feature = (name) => Boolean(flags[name]);
      const getFeatureValue_CACHED_MAY_BE_STALE = (name, fallback) => (name === "tengu_amber_stoat" ? amberStoat : (flags[name] ?? fallback));
      const areExplorePlanAgentsEnabled = upstream("agent-explore-gate", "areExplorePlanAgentsEnabled", { feature, getFeatureValue_CACHED_MAY_BE_STALE });
      const getBuiltInAgents = upstream("agent-builtin-list", "getBuiltInAgents", {
        feature,
        getFeatureValue_CACHED_MAY_BE_STALE,
        areExplorePlanAgentsEnabled,
        isEnvTruthy: (value) => value === "1" || value === "true",
        getIsNonInteractiveSession: () => nonInteractive,
        process: { env },
        GENERAL_PURPOSE_AGENT: real["general-purpose"],
        STATUSLINE_SETUP_AGENT: real["statusline-setup"],
        EXPLORE_AGENT: real.Explore,
        PLAN_AGENT: real.Plan,
        CLAUDE_CODE_GUIDE_AGENT: real["claude-code-guide"],
        VERIFICATION_AGENT: { agentType: "verification" },
      });
      return plain(getBuiltInAgents()).map((agent) => agent.agentType);
    };
    // 发布版的开关取值，从 cli.js 里读出来：只有 Explore / Plan 的编译开关是开着的
    const releaseFlags = { BUILTIN_EXPLORE_PLAN_AGENTS: gates.exploreGate, VERIFICATION_AGENT: gates.verificationGateName, COORDINATOR_MODE: gates.coordinatorEnv };
    const scenarios = [
      ["发布版，交互式 CLI（缺省）", agentList({ flags: releaseFlags })],
      ["服务端把 tengu_amber_stoat 关掉", agentList({ flags: releaseFlags, amberStoat: false })],
      ["SDK 入口（CLAUDE_CODE_ENTRYPOINT=sdk-ts）", agentList({ flags: releaseFlags, env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" } })],
      ["SDK 里设了 CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", agentList({ flags: releaseFlags, env: { CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1" }, nonInteractive: true })],
      ["（假设）编译时打开了 VERIFICATION_AGENT 和灰度", agentList({ flags: { ...releaseFlags, VERIFICATION_AGENT: true, tengu_hive_evidence: true } })],
    ];
    t.table(scenarios.map(([场景, 清单]) => ({ 场景, 内置清单: list(清单) })));
    t.equal("发布版缺省的内置清单", scenarios[0][1], ["general-purpose", "statusline-setup", "Explore", "Plan", "claude-code-guide"]);
    t.equal("灰度关掉后 Explore 和 Plan 消失", scenarios[1][1], ["general-purpose", "statusline-setup", "claude-code-guide"]);
    t.ok("SDK 入口没有 claude-code-guide", !scenarios[2][1].includes("claude-code-guide"));
    t.equal("SDK 的环境变量可以把清单清空", scenarios[3][1], []);

    // 同名定义谁说了算：真正的 getActiveAgentsFromList，六个来源各有一个叫 reviewer 的定义
    const getActiveAgentsFromList = upstream("agent-active", "getActiveAgentsFromList", {});
    const sources = ["built-in", "plugin", "userSettings", "projectSettings", "flagSettings", "policySettings"];
    let candidates = sources.map((source) => ({ agentType: "reviewer", source }));
    const ranking = [];
    while (candidates.length) {
      const winner = plain(getActiveAgentsFromList(candidates))[0].source;
      ranking.push(winner);
      candidates = candidates.filter((candidate) => candidate.source !== winner);
    }
    t.log(`同名的 reviewer 出现在六个来源里，从胜出到落选依次是：${ranking.join(" > ")}`);
    t.log();
    t.equal("项目里的定义盖过用户目录里的，托管策略盖过一切", ranking, ["policySettings", "flagSettings", "projectSettings", "userSettings", "plugin", "built-in"]);
    t.log();
  }

  // ───────────────────────── 三、子 Agent 带进去什么 ─────────────────────────
  if (wants("context")) {
    t.log("三、上下文：同一份父对话，三种子 Agent 的第一次请求");
    t.log();
    const workspace = join(t.root, "context");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "slug.cjs"), "module.exports = (s) => s.trim();\n");
    const spy = (replies) => {
      const inner = scripted(replies);
      const wires = [];
      const model = async (wire, signal) => (wires.push(wire), inner(wire, signal));
      model.wires = wires;
      return model;
    };
    const parentHistory = [
      { role: "user", text: "PARENT-ONLY 我们在排查 slug 的 bug" },
      { role: "assistant", text: "好的，我先看看。", calls: [] },
      // 父 Agent 此刻正在执行 Agent 工具：这一条调用还没有结果
      { role: "assistant", text: "", calls: [{ id: "agent-1", name: "Agent", input: { task: "find slug" } }] },
    ];
    const memories = ["项目说明：代码注释用中文。"];
    const run = async (label, options) => {
      const model = spy([{ text: "done" }]);
      const child = await runChild({ model, tools: codingTools(workspace), memories, parentHistory, context: { root: workspace }, ...options }, "找出 slug 的实现");
      const wire = model.wires[0];
      return {
        label,
        child,
        wire,
        row: {
          子Agent: label,
          系统提示: wire.system.length ? `${wire.system[0].slice(0, 16)}…` : "（没有）",
          项目说明: wire.system.some((s) => s.includes("项目说明")) ? "有" : "**没有**",
          收到的消息数: wire.messages.length,
          第一条消息: wire.messages[0].text.slice(0, 18),
          父对话的暗号: JSON.stringify(wire.messages).includes("PARENT-ONLY") ? "有" : "没有",
          工具: list(wire.tools.map((tool) => tool.name)),
        },
      };
    };
    const general = await run("general-purpose", { agent: "general-purpose" });
    const explore = await run("Explore", { agent: "Explore" });
    const forked = await run("general-purpose + fork", { agent: "general-purpose", fork: true });
    t.table([general.row, explore.row, forked.row]);
    t.ok("默认只收到任务说明这一条消息", general.wire.messages.length === 1 && general.wire.messages[0].text === "找出 slug 的实现");
    t.ok("Explore 不带项目说明，general-purpose 带", explore.row.项目说明 === "**没有**" && general.row.项目说明 === "有");
    t.ok("Explore 有自己的系统提示", explore.wire.system[0].includes("搜索专家") && !explore.wire.system[0].includes("子 Agent，负责"));
    t.ok("fork 带上父历史，并去掉了还没有结果的 Agent 调用", forked.wire.messages.length === 3 && !JSON.stringify(forked.wire.messages).includes("agent-1"));
    t.ok("子 Agent 的工具池里没有 Agent", ![general, explore, forked].some((r) => r.child.toolNames.includes("Agent")));

    // 文件版本记录：谁读过的文件，谁才能改
    const target = join(workspace, "slug.cjs");
    const childReads = [{ calls: [{ id: "r", name: "Read", input: { path: "slug.cjs" } }] }, { text: "读完了" }];
    const outcomes = [];
    for (const [label, isolated] of [
      ["共用父 Agent 的工具对象", false],
      ["makeTools：子 Agent 用新建的一套", true],
    ]) {
      writeFileSync(target, "module.exports = (s) => s.trim();\n");
      const parentTools = codingTools(workspace); // 每一行都用一套全新的父 Agent 工具
      const wiring = isolated ? { makeTools: () => codingTools(workspace) } : { tools: parentTools };
      await runChild({ agent: "general-purpose", ...wiring, model: scripted(childReads), context: { root: workspace } }, "读 slug.cjs");
      // 此刻父 Agent 自己从来没有 Read 过 slug.cjs，直接 Edit
      const edit = await new Toolset(parentTools).execute(
        { id: "e", name: "Edit", input: { path: "slug.cjs", old: "s.trim()", next: "s.trim().toLowerCase()" } },
        { root: workspace },
      );
      outcomes.push({ 子Agent的工具: label, "父 Agent 没读过，直接 Edit": edit.error ? `被拒绝：${edit.text}` : "成功了" });
    }
    t.table(outcomes);
    t.ok("共用工具对象时，子 Agent 读过的文件父 Agent 不读就能改", outcomes[0]["父 Agent 没读过，直接 Edit"] === "成功了");
    t.ok("用 makeTools 隔离以后，父 Agent 必须自己先读", outcomes[1]["父 Agent 没读过，直接 Edit"].startsWith("被拒绝：file has not been read yet"));

    // 子 Agent 的账本写在自己的文件里
    const transcripts = join(t.root, "transcripts");
    const logged = await runChild(
      { agent: "general-purpose", tools: codingTools(workspace), model: scripted([{ text: "完成" }]), context: { root: workspace }, transcriptDir: transcripts },
      "只回答完成",
    );
    t.log(`transcriptDir 里生成的文件：${readdirSync(transcripts).map((name) => name.replace(logged.id, "<id>")).join("、")}`);
    t.log();
    t.ok("子 Agent 的对话写进了 agent-<id>.jsonl", existsSync(join(transcripts, `agent-${logged.id}.jsonl`)));
    t.log();
  }

  // ───────────────────────── 四、权限 ─────────────────────────
  if (wants("permissions")) {
    t.log("四、权限：同一套规则，后台没有人可问");
    t.log();
    const workspace = join(t.root, "permissions");
    mkdirSync(workspace);
    const rows = [];
    const attempt = async (label, { definition, background = false, mode = "default" }) => {
      let asked = 0;
      const file = `out-${rows.length}.txt`;
      const child = await runChild(
        {
          agent: { type: "writer", tools: ["Write"], ...definition },
          tools: codingTools(workspace),
          model: scripted([{ calls: [{ id: "w", name: "Write", input: { path: file, text: "hello" } }] }, { text: "写完了" }]),
          permissions: { mode, root: workspace, ask: async () => (asked++, true) },
          background,
          context: { root: workspace },
        },
        "写一个文件",
      );
      const result = child.frames.find((f) => f.type === "tool_result").message;
      rows.push({
        场景: label,
        "问了用户几次": asked,
        Write: result.error ? `拒绝：${result.text}` : "执行了",
        文件写出来了吗: existsSync(join(workspace, file)) ? "是" : "否",
      });
      return { asked, written: existsSync(join(workspace, file)) };
    };
    const foreground = await attempt("前台子 Agent，父 Agent 是 default 模式", {});
    const background = await attempt("后台子 Agent，同样的父 Agent 和同样的用户", { background: true });
    const planned = await attempt("定义要求 plan 模式，父 Agent 是 default", { definition: { permissionMode: "plan" } });
    const loose = await attempt("定义要求 plan 模式，父 Agent 是 acceptEdits", { definition: { permissionMode: "plan" }, mode: "acceptEdits" });
    t.table(rows);
    t.ok("前台的询问会到用户那里，同意后执行", foreground.asked === 1 && foreground.written);
    t.ok("后台不问用户，需要问的一律拒绝", background.asked === 0 && !background.written);
    t.ok("定义的 plan 模式把需要询问的调用变成拒绝", planned.asked === 0 && !planned.written);
    t.ok("父 Agent 已经是 acceptEdits 时，定义的模式不会把它收回去", loose.written);
    t.log();
  }

  // ───────────────────────── 五、报告 ─────────────────────────
  if (wants("report")) {
    t.log("五、交回什么：父 Agent 的 tool_result");
    t.log();
    const workspace = join(t.root, "report");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "a.txt"), "alpha");
    writeFileSync(join(workspace, "b.txt"), "beta");
    const read = (id, path) => ({ id, name: "Read", input: { path } });
    const run = (agent, replies, options = {}) =>
      runChild({ agent, tools: codingTools(workspace), model: scripted(replies), context: { root: workspace }, ...options }, "查一下");
    const narrated = await run("general-purpose", [
      { text: "让我先看看 a.txt。", calls: [read("1", "a.txt")] },
      { text: "再看 b.txt。", calls: [read("2", "b.txt")] },
      { text: "结论：a.txt 是 alpha，b.txt 是 beta。" },
    ]);
    const cut = await run(
      "general-purpose",
      [{ text: "发现：a.txt 是 alpha。", calls: [read("1", "a.txt")] }, { calls: [read("2", "b.txt")] }],
      { maxTurns: 2 },
    );
    const empty = await run("general-purpose", [{ text: "" }]);
    const quick = await run("Explore", [{ calls: [read("1", "a.txt")] }, { text: "a.txt 是 alpha。" }]);
    const clean = (text) => text.replace(/agentId: \S+/, "agentId: <id>").replace(/\n/g, " ⏎ ");
    t.table([
      { 场景: "中间每一步都有旁白，最后写了结论", 交回的正文: narrated.text, 工具调用: narrated.toolUses, "父 Agent 的 tool_result": clean(reportForParent(narrated)) },
      { 场景: "被轮数上限截住，最后一条回复只有工具调用", 交回的正文: cut.text, 工具调用: cut.toolUses, "父 Agent 的 tool_result": clean(reportForParent(cut)) },
      { 场景: "子 Agent 什么文字都没写", 交回的正文: JSON.stringify(empty.text), 工具调用: empty.toolUses, "父 Agent 的 tool_result": clean(reportForParent(empty)) },
      { 场景: "Explore（只跑一次，不会被继续）", 交回的正文: quick.text, 工具调用: quick.toolUses, "父 Agent 的 tool_result": clean(reportForParent(quick)) },
    ]);
    t.equal("只交回最后一条有文字的回复，旁白留在子 Agent 里", narrated.text, "结论：a.txt 是 alpha，b.txt 是 beta。");
    t.equal("最后一条只有工具调用时，往前找最近一条有文字的", cut.text, "发现：a.txt 是 alpha。");
    t.equal("被截住的子 Agent 终态是 budget", cut.terminal.status, "budget");
    t.ok("空报告换成一句说明", reportForParent(empty).startsWith("(子 Agent 完成了，但没有给出任何文字。)"));
    t.ok("Explore 的报告不附 agentId，general-purpose 的附", !reportForParent(quick).includes("agentId") && reportForParent(narrated).includes("agentId"));
    t.ok("父 Agent 的上下文里看不到子 Agent 读过的内容", !reportForParent(narrated).includes("alpha\nbeta"));
    t.log();
  }

  // ───────────────────────── 六、取消 ─────────────────────────
  if (wants("cancel")) {
    t.log("六、取消：前台共用父 Agent 的信号，后台要单独停");
    t.log();
    const workspace = join(t.root, "cancel");
    mkdirSync(workspace);
    // 一个会等 100ms 的工具；收到取消信号就立刻放弃。log 记下它的结局。
    const log = [];
    const wait = {
      name: "Wait",
      description: "等 100ms",
      schema: { type: "object", properties: {}, required: [] },
      validate() {},
      async execute(_input, { signal }) {
        const began = Date.now();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              log.push({ outcome: "被取消", ms: Date.now() - began });
              reject(signal.reason ?? Error("aborted"));
            },
            { once: true },
          );
        });
        log.push({ outcome: "等满了", ms: Date.now() - began });
        return { text: "waited" };
      },
    };
    const script = () => scripted([{ text: "开始，先等一等。", calls: [{ id: "w", name: "Wait", input: {} }] }, { text: "全部完成。" }]);
    const base = { agent: { type: "waiter", tools: ["Wait"] }, tools: [wait], context: { root: workspace } };
    const rows = [];

    // 1. 前台：父 Agent 按 Esc，共用的信号让子 Agent 的工具立刻停下
    const parent = new AbortController();
    setTimeout(() => parent.abort(Error("interrupt")), 20);
    const began = Date.now();
    const foreground = await runChild({ ...base, model: script(), signal: parent.signal }, "等一等");
    const interrupted = log.find((entry) => entry.outcome === "被取消");
    rows.push({
      场景: "前台子 Agent，父 Agent 在 20ms 时取消",
      子Agent终态: foreground.terminal.status,
      工具的结局: `${interrupted?.outcome ?? "（没有被打断）"}（${Date.now() - began < 90 ? "不到 90" : "90 以上"}ms）`,
      父Agent收到的通知: "没有：Agent 工具调用本身被打断",
    });

    // 2. 后台：父 Agent 按 Esc 不影响它，它自己做完，结果以通知送达
    const notes = [];
    const tasks = new BackgroundChildren({ notify: (text) => notes.push(text) });
    const escParent = new AbortController();
    const kept = tasks.launch({ ...base, model: script(), signal: escParent.signal }, "等一等", { description: "等一等" });
    setTimeout(() => escParent.abort(Error("interrupt")), 20);
    await tasks.tasks.get(kept.id).done;
    rows.push({ 场景: "后台子 Agent，父 Agent 在 20ms 时取消", 子Agent终态: tasks.tasks.get(kept.id).status, 工具的结局: log.at(-1).outcome, 父Agent收到的通知: `status=${/<status>(\w+)</.exec(notes[0])[1]}` });

    // 3. 后台：用 stop 单独停它，已经做出的部分仍然交回
    const stopped = tasks.launch({ ...base, model: script() }, "等一等", { description: "等一等" });
    setTimeout(() => tasks.stop(stopped.id), 20);
    await tasks.tasks.get(stopped.id).done;
    rows.push({ 场景: "后台子 Agent，20ms 时 stop(id)", 子Agent终态: tasks.tasks.get(stopped.id).status, 工具的结局: log.at(-1).outcome, 父Agent收到的通知: `status=${/<status>(\w+)</.exec(notes[1])[1]}，result=“${/<result>([^<]*)</.exec(notes[1])?.[1]}”` });
    t.table(rows);
    t.log("后台完成时父 Agent 收到的通知：");
    t.log();
    t.log(notes[0].replace(/<task-id>[^<]+/, `<task-id>${kept.id.slice(0, 8)}…`).split("\n").map((line) => `    ${line}`).join("\n"));
    t.log();
    t.equal("父 Agent 取消，前台子 Agent 跟着取消", foreground.terminal.status, "cancelled");
    t.equal("父 Agent 取消，后台子 Agent 照常完成", tasks.tasks.get(kept.id).status, "completed");
    t.ok("后台完成的通知带着子 Agent 的报告", notes[0].includes("<status>completed</status>") && notes[0].includes("<result>全部完成。</result>"));
    t.ok("停下的后台子 Agent 交回已经做出的部分", notes[1].includes("<status>killed</status>") && notes[1].includes("<result>开始，先等一等。</result>"));
    t.equal("第二次 stop 同一个任务不再生效", tasks.stop(stopped.id), false);

    // 4. 进程退出前 stopAll：不留孤儿
    const orphan = tasks.launch({ ...base, model: script() }, "等一等", { description: "孤儿" });
    await tasks.stopAll();
    t.equal("stopAll 把还在运行的后台子 Agent 全部停下", tasks.tasks.get(orphan.id).status, "killed");
    t.ok("被停的子 Agent 的工具收到了取消信号", log.at(-1).outcome === "被取消");
    t.log();
  }

  // ───────────────────────── 七、模型 ─────────────────────────
  if (wants("model")) {
    t.log("七、模型：原函数 getAgentModel，对照 coda 的 resolveChildModel");
    t.log();
    // 解析模型名属于别的模块：用 <名字> 表示“解析之后的模型”，看得清选了谁
    const build = (env = {}) =>
      upstream("agent-model", "getAgentModel", {
        process: { env },
        parseUserSpecifiedModel: (name) => `<${name}>`,
        getBedrockRegionPrefix: () => undefined,
        applyBedrockRegionPrefix: (model) => model,
        getAPIProvider: () => "firstParty",
        getRuntimeMainLoopModel: ({ mainLoopModel }) => mainLoopModel,
        getDefaultSubagentModel: upstream("agent-model-default", "getDefaultSubagentModel", {}),
        aliasMatchesParentTier: upstream("agent-model-tier", "aliasMatchesParentTier", { getCanonicalName: (model) => model.replace(/-\d.*$/, "") }),
      });
    const getAgentModel = build();
    const parentModel = "claude-sonnet-4-5";
    const cases = [
      ["general-purpose（不写 model）", real["general-purpose"].model, undefined, undefined],
      ["Explore（model: haiku）", real.Explore.model, undefined, undefined],
      ["Explore，调用参数 model: opus", real.Explore.model, "opus", undefined],
      ["general-purpose，调用参数 model: sonnet（和父 Agent 同档）", real["general-purpose"].model, "sonnet", undefined],
      ["Explore，设了 CLAUDE_CODE_SUBAGENT_MODEL=pinned", real.Explore.model, "opus", "pinned"],
    ];
    const rows = cases.map(([label, defined, requested, env]) => ({
      场景: label,
      "定义里的 model": defined ?? "—",
      "调用参数 model": requested ?? "—",
      "原函数选了": env ? build({ CLAUDE_CODE_SUBAGENT_MODEL: env })(defined, parentModel, requested) : getAgentModel(defined, parentModel, requested),
    }));
    t.table(rows);
    t.equal("不写 model：继承父 Agent", rows[0].原函数选了, parentModel);
    t.equal("Explore 缺省用定义里的 haiku", rows[1].原函数选了, "<haiku>");
    t.equal("调用参数盖过定义", rows[2].原函数选了, "<opus>");
    t.equal("写和父 Agent 同档的别名，沿用父 Agent 的完整模型名", rows[3].原函数选了, parentModel);
    t.equal("环境变量排在最前面", rows[4].原函数选了, "<pinned>");

    // coda 的 resolveChildModel：同样的优先级（没有环境变量和“同档”两条）
    const parentFn = () => "parent";
    const models = { haiku: () => "haiku", opus: () => "opus" };
    const pick = (definition, requested) => resolveChildModel({ definition, requested, parentModel: parentFn, models })();
    t.equal("coda：不写 model 继承父 Agent", pick({ type: "x" }), "parent");
    t.equal("coda：定义里的别名在 models 表里找", pick({ type: "x", model: "haiku" }), "haiku");
    t.equal("coda：调用参数盖过定义", pick({ type: "x", model: "haiku" }, "opus"), "opus");
    t.equal("coda：表里没有的别名退回父 Agent", pick({ type: "x", model: "sonnet" }), "parent");
  }
});
