// coda 的权限层。对应 Claude Code 的 utils/permissions/permissions.ts，三个函数各管一段：
//
//   ruleStage       ≈ checkRuleBasedPermissions   只回答“有没有规则或安全检查拦住这次调用”；没有异议返回 null
//   decide          ≈ hasPermissionsToUseTool     把一次调用变成 allow / ask / deny（含 dontAsk 对 ask 的转换）
//   permissionGate  ≈ canUseTool                  再把 ask 交给人；等待期间能被取消
//
// 决策顺序：deny 最先，ask 其次，allow 最后；模式只处理“规则没说话”的部分。右边是 Claude Code 里的对应台阶。
//
//   1. 整个工具的 deny 规则                                 → deny      1a
//   2. 整个工具的 ask 规则                                  → ask       1b
//   3. 工具自己的检查（toolCheck）：内容 deny → deny；
//      内容 ask 规则、受保护路径 → ask                                    1c～1g
//   4. bypassPermissions 模式                               → allow     2a（1～3 都没有异议才走到这里）
//   5. 整个工具的 allow 规则                                → allow     2b
//   6. 工具自己的 allow（acceptEdits、内容 allow 规则、只读）→ allow      1c 返回的 allow
//   7. 其余 → ask；dontAsk 和 plan 把 ask 变成 deny                      3，以及外层包装
//
// 相对 Claude Code 的简化：
//   - 规则只有一个来源。多个来源用 mergeRules 取并集：来源之间没有优先级，只有 deny > ask > allow。
//   - 内容规则 `Tool(模式)` 只匹配输入里的 path 或 command（没有 Bash 的命令拆分，没有 gitignore 语法）。
//   - 没有分类器（auto 模式）；plan 模式直接拒绝需要询问的调用。
//   - 工作区边界是硬边界（越界直接报错），Claude Code 则把“目录之外”变成一次询问。
import { workspacePath } from "../../runtime/files.mjs";

export const MODES = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];

const EDIT_TOOLS = new Set(["Edit", "Write"]);
// 这些目录和文件即使在 acceptEdits、bypassPermissions 下也要问：改动它们可以让后续命令带上别人的代码
// （Claude Code 的 DANGEROUS_DIRECTORIES / DANGEROUS_FILES，这里只取最常见的几个）
const PROTECTED_DIRS = [".git", ".vscode", ".idea", ".claude"];
const PROTECTED_FILES = [".bashrc", ".zshrc", ".gitconfig"];

// ── 规则的写法 ──────────────────────────────────────────────

// "Edit(src/*)" → { tool: "Edit", content: "src/*" }
// "Edit"、"Edit()"、"Edit(*)" 都表示整个工具（Claude Code 的 permissionRuleValueFromString 同样处理）
export function parseRule(text) {
  const match = /^([^()]+)\((.*)\)$/.exec(text);
  if (!match) return { tool: text, text };
  const [, tool, content] = match;
  if (content === "" || content === "*") return { tool, text };
  return { tool, content, text };
}

// 规则里的工具名和这次调用的工具名对得上吗？MCP 有服务器级规则：mcp__gh 管 mcp__gh__ 开头的全部工具
function toolMatches(ruleTool, name) {
  if (ruleTool === name) return true;
  const server = ruleTool.replace(/__\*$/, "");
  return server.startsWith("mcp__") && name.startsWith(server + "__");
}

// 通配符：* 匹配任意文本；结尾的 " *" 让参数可以省略（"git *" 也匹配单独的 "git"）
export function wildcardMatch(pattern, text) {
  const parts = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  let source = parts.join(".*");
  const onlyTrailingStar = parts.length === 2 && pattern.endsWith(" *");
  if (onlyTrailingStar) source = source.replace(/ \.\*$/, "( .*)?");
  return new RegExp(`^${source}$`, "s").test(text);
}

// 内容规则匹配的“对象”：文件工具看 path，命令类工具看 command
const subjectOf = (input) => (typeof input.path === "string" ? input.path : input.command);

const wholeToolRule = (list = [], name) =>
  list.map(parseRule).find((rule) => rule.content === undefined && toolMatches(rule.tool, name));

const contentRule = (list = [], name, subject) =>
  subject === undefined
    ? undefined
    : list
        .map(parseRule)
        .find((rule) => rule.content !== undefined && toolMatches(rule.tool, name) && wildcardMatch(rule.content, subject));

// 把几个来源（用户、项目、本地、会话……）的规则合并。Claude Code 对每种行为取所有来源的并集，
// 所以“项目里 deny、用户设置里 allow”的结果是 deny，和来源的先后无关。
export function mergeRules(...sources) {
  const merged = { allow: [], ask: [], deny: [] };
  for (const source of sources)
    for (const behavior of Object.keys(merged)) merged[behavior].push(...(source?.[behavior] ?? []));
  return merged;
}

// ── 第一段：规则和安全检查 ──────────────────────────────────

// 只返回“会拦住调用”的结论：deny、ask。没有异议返回 null——这不等于允许，后面还有模式和 allow 规则。
// local 是工具自己的检查结果（见 toolCheck）。其中只有三种会在这里被采纳：
//   deny；由内容 ask 规则产生的 ask（source: "rule"）；受保护路径的 ask（source: "safetyCheck"）。
// 单纯的“需要确认”（比如没人说过可以）不在这里拦：bypassPermissions 可以放行它，allow 规则也可以。
export function ruleStage(name, rules, local = {}) {
  if (wholeToolRule(rules.deny, name)) return { behavior: "deny", source: "explicit-deny" };
  if (wholeToolRule(rules.ask, name)) return { behavior: "ask", source: "explicit-ask" };
  if (local.behavior === "deny") return local;
  if (local.behavior === "ask" && (local.source === "rule" || local.source === "safetyCheck")) return local;
  return null;
}

// ── 工具自己的检查 ──────────────────────────────────────────

const isProtected = (path) => {
  const segments = path.split(/[\\/]/).map((segment) => segment.toLowerCase());
  return segments.some((segment) => PROTECTED_DIRS.includes(segment)) || PROTECTED_FILES.includes(segments.at(-1));
};

// 对应各个工具的 checkPermissions。工具可以自己声明 tool.permission(input)，没有就用这里的默认检查。
// 默认检查的顺序和 Claude Code 的 checkWritePermissionForTool 一致：
//   内容 deny → 受保护路径 → 内容 ask → acceptEdits → 内容 allow → 只读 → 没有意见（passthrough）
function toolCheck(call, tool, { mode, rules }) {
  const own = tool.permission?.(call.input);
  if (own) return own;

  const subject = subjectOf(call.input);
  const denied = contentRule(rules.deny, call.name, subject);
  if (denied) return { behavior: "deny", source: "rule", rule: denied.text };

  // 受保护路径先于 ask / allow / 模式：acceptEdits 和 allow 规则都不能把它变成放行
  const writes = !tool.readOnly;
  if (writes && typeof call.input.path === "string" && isProtected(call.input.path))
    return { behavior: "ask", source: "safetyCheck", reason: "受保护的路径" };

  const asked = contentRule(rules.ask, call.name, subject);
  if (asked) return { behavior: "ask", source: "rule", rule: asked.text };

  if (mode === "acceptEdits" && EDIT_TOOLS.has(call.name)) return { behavior: "allow", source: "mode" };
  const allowed = contentRule(rules.allow, call.name, subject);
  if (allowed) return { behavior: "allow", source: "rule", rule: allowed.text };
  if (tool.readOnly) return { behavior: "allow", source: "readOnly" };
  return { behavior: "passthrough" };
}

// ── 第二段：把一次调用变成 allow / ask / deny ────────────────

// 台阶 1～6：规则、安全检查、bypass、allow。结果只有三种：allow、deny，或者“需要问人”的 ask
// （对应 Claude Code 的 hasPermissionsToUseToolInner）
function decideInner(call, tool, { mode, rules }) {
  const local = toolCheck(call, tool, { mode, rules });

  const blocked = ruleStage(call.name, rules, local); // 台阶 1～3
  if (blocked) return blocked;

  if (mode === "bypassPermissions") return { behavior: "allow", source: "mode" }; // 台阶 4
  const allowRule = wholeToolRule(rules.allow, call.name); // 台阶 5
  if (allowRule) return { behavior: "allow", source: "rule", rule: allowRule.text };
  if (local.behavior === "allow") return local; // 台阶 6

  // 没有人说过可以，也没有人说过不可以：需要问人
  return { behavior: "ask", source: local.source ?? "default" };
}

// 台阶 7：模式处理“需要问人”的结果。dontAsk 和 plan 没有人可问，直接拒绝。
// 这一步放在最后，所以任何一种 ask（包括 ask 规则、受保护路径）都躲不过去。
// （对应 Claude Code 的 hasPermissionsToUseTool 外层包装；plan 的拒绝是 coda 的简化）
export function decide(call, tool, { mode = "default", rules = {} } = {}) {
  const decision = decideInner(call, tool, { mode, rules });
  if (decision.behavior === "ask" && (mode === "dontAsk" || mode === "plan"))
    return { behavior: "deny", source: "mode", mode };
  return decision;
}

// ── 第三段：把 ask 交给人 ───────────────────────────────────

// 等待用户回答的同时监听取消信号：用户按了 Esc，就不再等了。每条退出路径都摘掉监听器，不留下泄漏的等待者。
function askUser(ask, call, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => ask(call))
      .then(resolve, reject)
      .finally(() => signal?.removeEventListener("abort", onAbort));
    if (signal?.aborted) onAbort();
  });
}

// 返回给 Toolset 的闸门：true 放行，false 拒绝。没有提供 ask 回调时（无界面），ask 一律按拒绝处理。
// onDecision 只是观察口：实验用它打印每次决策的来源。
export function permissionGate({
  mode = "default",
  rules = {},
  ask = async () => false,
  root,
  onDecision,
} = {}) {
  if (!MODES.includes(mode)) throw Error(`unknown permission mode: ${mode}`);
  return async (call, tool, signal) => {
    signal?.throwIfAborted();
    // 工作区边界：越界、符号链接逃逸会直接抛错，先于任何规则
    if (call.input.path && root) workspacePath(root, call.input.path);

    const decision = decide(call, tool, { mode, rules });
    onDecision?.(call, decision);
    if (decision.behavior === "allow") return true;
    if (decision.behavior === "deny") return false;
    return Boolean(await askUser(ask, call, signal));
  };
}
