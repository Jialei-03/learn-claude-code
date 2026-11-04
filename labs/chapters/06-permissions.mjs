// 第 6 章：coda 的权限层。
//   node labs/chapters/06-permissions.mjs
// 一、同一组调用，在五种模式下的结果；二、规则怎样改变结果；三、拿 coda 的 decide 和 Claude Code 2.1.88 的真实函数对账；
// 四、闸门本身：问人、没人可问、等待时被取消。
import { lesson } from "./harness.mjs";
import { codingTools } from "../../coda/src/files.mjs";
import { MODES, decide, mergeRules, parseRule, permissionGate, ruleStage, wildcardMatch } from "../../coda/src/permissions.mjs";
import { SCENARIOS, matchWildcard, parseRuleString, realDecision } from "../ch06/real.mjs";

const zh = { allow: "放行", ask: "问用户", deny: "拒绝" };
const show = (decision) => `${zh[decision.behavior]}（${decision.rule ?? decision.source}）`;

await lesson(6, "权限：allow、ask、deny 的决策顺序", async (t) => {
  const tools = new Map(codingTools(t.root).map((tool) => [tool.name, tool]));
  const call = (name, input) => ({ id: name, name, input });
  const run = (c, options) => decide(c, tools.get(c.name), options);

  // ── 一、没有规则时：模式决定默认答案 ──
  t.log("一、没有任何规则：同样五个调用，在五种模式下");
  t.log();
  const calls = [
    ["Read README.md", call("Read", { path: "README.md" })],
    ["Edit src/a.js", call("Edit", { path: "src/a.js" })],
    ["Write notes.txt", call("Write", { path: "notes.txt" })],
    ["Write .vscode/settings.json", call("Write", { path: ".vscode/settings.json" })],
    ["Test test.cjs（运行代码）", call("Test", { path: "test.cjs" })],
  ];
  const byMode = Object.fromEntries(MODES.map((mode) => [mode, calls.map(([, c]) => run(c, { mode }))]));
  t.table(calls.map(([label], i) => ({ 调用: label, ...Object.fromEntries(MODES.map((mode) => [mode, show(byMode[mode][i])])) })));

  t.equal("读文件在任何模式下都不需要问", MODES.map((mode) => byMode[mode][0].behavior), MODES.map(() => "allow"));
  t.equal("default：除了读，其余都要问", byMode.default.slice(1).map((d) => d.behavior), ["ask", "ask", "ask", "ask"]);
  t.equal("acceptEdits：放行普通文件的修改，受保护路径和运行代码仍要问", byMode.acceptEdits.map((d) => d.behavior), ["allow", "allow", "allow", "ask", "ask"]);
  t.equal("受保护路径先于 acceptEdits：.vscode 照样要问", byMode.acceptEdits[3].source, "safetyCheck");
  t.equal("bypassPermissions 也绕不过受保护路径", byMode.bypassPermissions[3].behavior, "ask");
  t.equal("dontAsk 把所有“要问”变成拒绝", byMode.dontAsk.slice(1).map((d) => d.behavior), ["deny", "deny", "deny", "deny"]);

  // ── 二、规则：整工具、内容、合并 ──
  t.log();
  t.log("二、规则怎样改变结果（default 模式）");
  t.log();
  // 规则分散在三个来源里：合并是取并集，来源之间没有先后
  const rules = mergeRules(
    { allow: ["Edit(src/*)", "Test"] }, // 用户设置
    { deny: ["Edit(src/secret*)", "Write(*.pem)"] }, // 项目设置
    { ask: ["Test(slow*)"], allow: ["Write"] }, // 会话
  );
  const cases = [
    ["Edit src/a.js", call("Edit", { path: "src/a.js" }), "allow"],
    ["Edit src/secret.js", call("Edit", { path: "src/secret.js" }), "deny"],
    ["Edit docs/a.md", call("Edit", { path: "docs/a.md" }), "ask"],
    ["Write notes.txt", call("Write", { path: "notes.txt" }), "allow"],
    ["Write key.pem", call("Write", { path: "key.pem" }), "deny"],
    ["Write .git/config", call("Write", { path: ".git/config" }), "ask"],
    ["Test test.cjs", call("Test", { path: "test.cjs" }), "allow"],
    ["Test slow-suite.cjs", call("Test", { path: "slow-suite.cjs" }), "ask"],
  ];
  const results = cases.map(([, c]) => run(c, { rules }));
  t.log(`规则：${JSON.stringify(rules)}`);
  t.log();
  t.table(cases.map(([label], i) => ({ 调用: label, 决定: zh[results[i].behavior], 依据: results[i].rule ?? results[i].source })));
  t.equal("每个调用的结果", results.map((d) => d.behavior), cases.map(([, , expected]) => expected));
  t.equal("Write 整个工具被 allow，.git 里的文件仍然要问", results[5].source, "safetyCheck");
  t.equal("ruleStage：没有规则反对时返回 null，而不是 allow", ruleStage("Edit", {}, { behavior: "allow" }), null);
  t.equal("ruleStage：整工具 deny", ruleStage("Edit", { deny: ["Edit"], allow: ["Edit"] }).behavior, "deny");
  t.equal("MCP 服务器级规则覆盖它的全部工具", decide({ name: "mcp__gh__search", input: {} }, {}, { rules: { allow: ["mcp__gh"] } }).behavior, "allow");

  // ── 三、和 Claude Code 2.1.88 的真实函数对账 ──
  t.log();
  t.log("三、coda 的 decide 对账 Claude Code 2.1.88 的 hasPermissionsToUseTool（真实函数，运行时从固定提交取出）");
  t.log();
  const LOCAL = {
    passthrough: undefined,
    allow: { behavior: "allow" },
    deny: { behavior: "deny", source: "rule" },
    ask: { behavior: "ask" },
    "content-ask": { behavior: "ask", source: "rule" },
    "safety-check": { behavior: "ask", source: "safetyCheck" },
  };
  const rows = [];
  const same = { real: [], ours: [] };
  let planPair;
  for (const scenario of SCENARIOS) {
    const real = await realDecision(scenario);
    let ours = "—";
    if (scenario.coda !== "skip") {
      const stub = { readOnly: false, permission: () => LOCAL[scenario.local ?? "passthrough"] };
      const input = { name: scenario.tool ?? "Write", input: { path: "a.txt" } };
      ours = decide(input, stub, { mode: scenario.mode, rules: scenario.rules }).behavior;
    }
    if (scenario.coda === "same") (same.real.push(real.behavior), same.ours.push(ours));
    if (scenario.coda === "differs") planPair = [real.behavior, ours];
    const verdict = scenario.coda === "skip" ? "coda 没有对应的概念" : ours === real.behavior ? "一致" : "**差异**：2.1.88 的 plan 靠提示词约束，工具照常问；coda 直接拒绝";
    rows.push({ 场景: scenario.title, "2.1.88": zh[real.behavior], coda: zh[ours] ?? ours, 对账: verdict });
  }
  t.table(rows);
  t.equal(`${same.real.length} 个场景的结论和真实函数逐个一致`, same.ours, same.real);
  t.equal("已知的差异只有 plan：真实函数问用户，coda 拒绝", planPair, ["ask", "deny"]);

  // 规则语法和通配符：同样用真实函数对账
  const ruleTexts = ["Edit", "Edit()", "Edit(*)", "Edit(src/*)", "Bash(npm run *)", "mcp__gh__search"];
  t.equal(
    "规则解析和上游一致",
    ruleTexts.map((text) => { const { tool, content } = parseRule(text); return [tool, content]; }),
    ruleTexts.map((text) => { const { toolName, ruleContent } = parseRuleString(text); return [toolName, ruleContent]; }),
  );
  const patterns = [["git *", "git"], ["git *", "git status"], ["git *", "gitk"], ["src/*", "src/a/b.js"], ["*.pem", "key.pem"], ["rm *", "rm -rf /"], ["ls*", "lsof"], ["a.b", "axb"], ["npm run *", "npm run build"]];
  t.equal("通配符匹配和上游一致", patterns.map(([p, s]) => wildcardMatch(p, s)), patterns.map(([p, s]) => matchWildcard(p, s)));

  // ── 四、闸门：问人、没人可问、等待时被取消 ──
  t.log();
  t.log("四、permissionGate：ask 交给谁");
  t.log();
  const edit = call("Edit", { path: "a.txt" });
  const editTool = tools.get("Edit");
  const asked = [];
  const ask = (answer) => async (c) => (asked.push(c.name), answer);
  t.equal("问用户，用户说可以", await permissionGate({ root: t.root, ask: ask(true) })(edit, editTool), true);
  t.equal("问用户，用户说不行", await permissionGate({ root: t.root, ask: ask(false) })(edit, editTool), false);
  t.equal("每次都真的问了", asked, ["Edit", "Edit"]);
  t.equal("没有提供 ask（无界面）：按拒绝处理", await permissionGate({ root: t.root })(edit, editTool), false);
  t.equal("allow 规则不会去打扰用户", await permissionGate({ root: t.root, rules: { allow: ["Edit"] }, ask: ask(false) })(edit, editTool), true);
  t.equal("allow 之后 ask 没有被多调用一次", asked.length, 2);
  t.equal("deny 规则压过 allow 规则", await permissionGate({ root: t.root, rules: { allow: ["Edit"], deny: ["Edit"] } })(edit, editTool), false);
  t.equal("ask 规则压过 acceptEdits，并且真的去问", await permissionGate({ root: t.root, mode: "acceptEdits", rules: { ask: ["Edit"] }, ask: ask(false) })(edit, editTool), false);
  t.equal("ask 规则触发了一次询问", asked.length, 3);
  t.equal("dontAsk：连 ask 规则也只能拒绝，不会去问", await permissionGate({ root: t.root, mode: "dontAsk", rules: { ask: ["Edit"] }, ask: ask(true) })(edit, editTool), false);
  t.equal("dontAsk 没有询问用户", asked.length, 3);

  const decisions = [];
  const observed = permissionGate({ root: t.root, rules: { deny: ["Write(*.pem)"] }, onDecision: (c, d) => decisions.push(`${c.name} ${c.input.path} → ${d.behavior}`) });
  await observed(call("Write", { path: "key.pem" }), tools.get("Write"));
  await observed(call("Read", { path: "README.md" }), tools.get("Read"));
  t.log(`onDecision 记录：${decisions.join("；")}`);

  const controller = new AbortController();
  const waiting = permissionGate({ root: t.root, ask: () => new Promise(() => {}) })(edit, editTool, controller.signal);
  controller.abort(Error("用户按了 Esc"));
  await t.rejects("等待用户回答时被取消：闸门立即以取消结束，不再等", waiting, /Esc/);
  await t.rejects("工作区边界先于规则：越界路径直接报错", permissionGate({ root: t.root })(call("Edit", { path: "../outside" }), editTool), /outside/);
  t.throws("未知模式直接拒绝构造，而不是悄悄当成 default", () => permissionGate({ mode: "yolo" }), /unknown permission mode/);

  t.observations.order = ["deny > ask > bypassPermissions > allow", "受保护路径先于 acceptEdits 和 allow 规则", "dontAsk 在最后把 ask 变成 deny"];
});
