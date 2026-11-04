// 第 6 章的“真货”：在运行时从固定提交（Claude Code 2.1.88）里取出权限相关的函数，原样执行。
// 代码不复制进仓库，每个函数的位置登记在 course/source-references.json（键以 perm- 开头）。
//
// 被取出来执行的函数：
//   permissions.ts      hasPermissionsToUseToolInner、hasPermissionsToUseTool（外层）、整工具规则的查找
//   permissionRuleParser.ts   permissionRuleValueFromString（规则字符串 → 工具名 + 内容）
//   shellRuleMatching.ts      matchWildcardPattern、parsePermissionRule
//   bashPermissions.ts        stripSafeWrappers、stripAllLeadingEnvVars、matchingRulesForInput、bashToolCheckPermission
//   modeValidation.ts         checkPermissionMode（acceptEdits 下的文件系统命令）
//
// 假依赖（都是“和决策无关的外围”，在每个 upstream() 调用旁标出）：
//   日志、遥测、沙箱开关、权限提示文案、命令拆分器（用一个简化版）、路径约束（关闭）、只读命令判断（一个很短的名单）。
import { upstream } from '../engineering/run.mjs';

// stripTypeScriptTypes 是实验特性，第一次调用会往 stderr 打一条警告；关掉它，让实验输出只有表格
process.removeAllListeners('warning');

// 规则的八个来源（真实代码里是 SETTING_SOURCES 加上 cliArg、command、session）
const SOURCES = ['userSettings', 'projectSettings', 'localSettings', 'flagSettings', 'policySettings', 'cliArg', 'command', 'session'];

// ── 规则的解析和整工具规则的查找 ───────────────────────────────
const mcpInfoFromString = upstream('perm-mcp-info', 'mcpInfoFromString');
const toolMatchesRule = upstream('perm-tool-matches', 'toolMatchesRule', {
  getToolNameForPermissionCheck: (tool) => tool.name, // 本实验的工具都不带 mcpInfo
  mcpInfoFromString,
});
export const parseRuleString = upstream('perm-rule-parse', 'permissionRuleValueFromString', {
  findFirstUnescapedChar: upstream('perm-rule-first-paren', 'findFirstUnescapedChar'),
  findLastUnescapedChar: upstream('perm-rule-last-paren', 'findLastUnescapedChar'),
  unescapeRuleContent: upstream('perm-rule-unescape', 'unescapeRuleContent'),
  normalizeLegacyToolName: (name) => name, // 旧工具名别名表，和决策无关
});
const rulePorts = { PERMISSION_RULE_SOURCES: SOURCES, permissionRuleValueFromString: parseRuleString };
const getAllowRules = upstream('perm-allow-rules', 'getAllowRules', rulePorts);
const getDenyRules = upstream('perm-deny-rules', 'getDenyRules', rulePorts);
const getAskRules = upstream('perm-ask-rules', 'getAskRules', rulePorts);
const getRuleByContentsForToolName = upstream('perm-rules-by-contents', 'getRuleByContentsForToolName', { getAllowRules, getDenyRules, getAskRules });
const getRuleByContentsForTool = upstream('perm-rules-by-contents-tool', 'getRuleByContentsForTool', {
  getRuleByContentsForToolName,
  getToolNameForPermissionCheck: (tool) => tool.name,
});

// ── 决策函数本体 ──────────────────────────────────────────────
class AbortError extends Error {}
class APIUserAbortError extends Error {}
const requestMessage = (toolName) => `Claude requested permissions to use ${toolName}, but you haven't granted it yet.`; // 提示文案，和决策无关
const inner = upstream('permission-inner', 'hasPermissionsToUseToolInner', {
  AbortError,
  APIUserAbortError,
  getDenyRuleForTool: upstream('perm-deny-for-tool', 'getDenyRuleForTool', { getDenyRules, toolMatchesRule }),
  getAskRuleForTool: upstream('perm-ask-for-tool', 'getAskRuleForTool', { getAskRules, toolMatchesRule }),
  toolAlwaysAllowedRule: upstream('perm-allow-for-tool', 'toolAlwaysAllowedRule', { getAllowRules, toolMatchesRule }),
  getUpdatedInputOrFallback: upstream('perm-updated-input', 'getUpdatedInputOrFallback'),
  BASH_TOOL_NAME: 'Bash',
  SandboxManager: { isSandboxingEnabled: () => false, isAutoAllowBashIfSandboxedEnabled: () => false }, // 沙箱关闭（第 11 章）
  shouldUseSandbox: () => false,
  createPermissionRequestMessage: requestMessage,
  logError: () => {},
  logForDebugging: () => {},
  jsonStringify: JSON.stringify,
});
const outer = upstream('perm-outer', 'hasPermissionsToUseTool', {
  feature: () => false, // 编译期开关 TRANSCRIPT_CLASSIFIER：这里不演示 auto 模式
  hasPermissionsToUseToolInner: inner,
  DONT_ASK_REJECT_MESSAGE: (toolName) => `Permission to use ${toolName} has been denied because Claude Code is running in don't ask mode.`,
  AUTO_REJECT_MESSAGE: (toolName) => `Permission to use ${toolName} has been denied (prompts unavailable).`,
  runPermissionRequestHooksForHeadlessAgent: async () => null, // 没有配置 PermissionRequest 钩子
  recordSuccess: (state) => state,
  persistDenialState: () => {},
  AbortError,
  APIUserAbortError,
});

// ── 场景的构造 ────────────────────────────────────────────────

/** 规则按行为分到不同来源：deny 在项目配置、allow 在用户配置、ask 在本地配置——来源不影响结果。 */
const SOURCE_OF = { deny: 'projectSettings', ask: 'localSettings', allow: 'userSettings' };
const bySource = (rules, behavior) => (rules[behavior]?.length ? { [SOURCE_OF[behavior]]: rules[behavior] } : {});

/** 工具自己的检查（checkPermissions）可能返回的几种结果；content-ask 是 Bash(git push *) 这类内容 ask 规则的产物。 */
const LOCAL_RESULTS = {
  passthrough: { behavior: 'passthrough', message: 'no opinion' },
  allow: { behavior: 'allow' },
  deny: { behavior: 'deny', message: 'denied by a content rule', decisionReason: { type: 'rule', rule: { ruleBehavior: 'deny', source: 'projectSettings', ruleValue: { toolName: 'Write', ruleContent: 'secrets/**' } } } },
  ask: { behavior: 'ask', message: 'plain ask (e.g. path outside the working directory)' },
  'content-ask': { behavior: 'ask', message: 'content ask rule', decisionReason: { type: 'rule', rule: { ruleBehavior: 'ask', source: 'localSettings', ruleValue: { toolName: 'Write', ruleContent: 'docs/**' } } } },
  'safety-check': { behavior: 'ask', message: 'protected path', decisionReason: { type: 'safetyCheck', reason: 'protected path', classifierApprovable: true } },
};
export const LOCAL_KINDS = Object.keys(LOCAL_RESULTS);

/** 一次完整的决策：返回 { behavior, why }，why 是真实函数给出的 decisionReason 的一行概括。 */
export async function realDecision({ tool = 'Write', mode = 'default', rules = {}, local = 'passthrough', headless = false }) {
  const stub = {
    name: tool,
    inputSchema: { parse: (input) => input },
    checkPermissions: async () => ({ ...LOCAL_RESULTS[local], updatedInput: { path: 'a.txt' } }),
  };
  const context = {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: {
        mode,
        alwaysAllowRules: bySource(rules, 'allow'),
        alwaysDenyRules: bySource(rules, 'deny'),
        alwaysAskRules: bySource(rules, 'ask'),
        shouldAvoidPermissionPrompts: headless,
      },
    }),
  };
  const result = await outer(stub, { path: 'a.txt' }, context, { message: { id: 'm' } }, 'tool-use-1');
  const reason = result.decisionReason;
  const rule = reason?.rule?.ruleValue;
  const why = !reason ? (result.behavior === 'allow' ? '工具自己返回 allow' : 'passthrough 转成 ask') : reason.type === 'rule' ? `规则 ${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ''}` : reason.type === 'mode' ? `模式 ${reason.mode}` : reason.type;
  return { behavior: result.behavior, why };
}

// ── Bash：从规则字符串到匹配 ───────────────────────────────────
// 这几个函数是纯文本处理，几乎不需要假依赖
export const matchWildcard = upstream('perm-shell-wildcard', 'matchWildcardPattern', {
  // 转义占位符：任何不会出现在规则里的字符串都行
  ESCAPED_STAR_PLACEHOLDER: '\0S\0',
  ESCAPED_BACKSLASH_PLACEHOLDER: '\0B\0',
  ESCAPED_STAR_PLACEHOLDER_RE: /\0S\0/g,
  ESCAPED_BACKSLASH_PLACEHOLDER_RE: /\0B\0/g,
});
export const parseShellRule = upstream('perm-shell-parse', 'parsePermissionRule', {
  permissionRuleExtractPrefix: upstream('perm-shell-prefix', 'permissionRuleExtractPrefix'),
  hasWildcards: upstream('perm-shell-has-wildcards', 'hasWildcards'),
});
const stripCommentLines = upstream('perm-bash-strip-comments', 'stripCommentLines');
/** 放行侧的剥离：只去掉“安全”的环境变量和 timeout、time、nice、nohup 之类的包装。安全变量清单是本实验自己选的几个。 */
export const stripForAllow = upstream('perm-bash-strip-wrappers', 'stripSafeWrappers', {
  stripCommentLines,
  SAFE_ENV_VARS: new Set(['NODE_ENV', 'TZ', 'LANG']),
  ANT_ONLY_SAFE_ENV_VARS: new Set(),
  process: { env: {} },
});
/** 拒绝侧的剥离：去掉所有前置环境变量。 */
export const stripForDeny = upstream('perm-bash-strip-env', 'stripAllLeadingEnvVars', { stripCommentLines });

// 命令拆分器的简化版：只按 && || ; | 切开（真实代码用 shell 语法分析，第 12 章之后再谈它的复杂度）
const splitCommand = (command) => command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
const BashTool = {
  name: 'Bash',
  // “只读命令”的判断在真实代码里是一千多行的 readOnlyValidation.ts；这里用一个很短的名单顶替
  isReadOnly: (input) => /^(ls|cat|echo|pwd|git (status|diff|log))\b/.test(input.command),
};
const matchingRulesForInput = upstream('perm-bash-matching-rules', 'matchingRulesForInput', {
  getRuleByContentsForTool,
  BashTool,
  filterRulesByContentsMatchingInput: upstream('perm-bash-filter-rules', 'filterRulesByContentsMatchingInput', {
    extractOutputRedirections: (command) => ({ commandWithoutRedirections: command, redirections: [] }), // 示例命令里没有重定向
    stripSafeWrappers: stripForAllow,
    stripAllLeadingEnvVars: stripForDeny,
    splitCommand,
    bashPermissionRule: parseShellRule,
    matchWildcardPattern: matchWildcard,
  }),
});
const bashCheckPermission = upstream('perm-bash-check', 'bashToolCheckPermission', {
  bashToolCheckExactMatchPermission: upstream('perm-bash-exact', 'bashToolCheckExactMatchPermission', {
    matchingRulesForInput,
    BashTool,
    createPermissionRequestMessage: requestMessage,
    suggestionForExactCommand: () => [],
  }),
  matchingRulesForInput,
  checkPathConstraints: () => ({ behavior: 'passthrough' }), // 路径约束层关闭：这里只看命令文本的规则
  checkSedConstraints: () => ({ behavior: 'passthrough' }),
  getCwd: () => '/project',
  checkPermissionMode: upstream('perm-bash-mode', 'checkPermissionMode', {
    splitCommand_DEPRECATED: splitCommand,
    validateCommandForMode: upstream('perm-bash-mode-one', 'validateCommandForMode', {
      isFilesystemCommand: upstream('perm-bash-is-fs', 'isFilesystemCommand', {
        ACCEPT_EDITS_ALLOWED_COMMANDS: ['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed'], // 名单见正文里的摘录
      }),
    }),
  }),
  BashTool,
  createPermissionRequestMessage: requestMessage,
  suggestionForExactCommand: () => [],
});

/** 规则内容 → Bash(内容)：下面两个函数的 rules 只写括号里的部分，比如 { deny: ['rm *'] }。 */
const bashRules = (rules) => Object.fromEntries(Object.entries(rules).map(([behavior, list]) => [behavior, list.map((content) => `Bash(${content})`)]));

/** 一个子命令（不含 && 和 |）在给定规则和模式下的决定，来自上游 bashToolCheckPermission。 */
export function realBash(command, { mode = 'default', rules = {} } = {}) {
  const wrapped = bashRules(rules);
  const result = bashCheckPermission(
    { command },
    { mode, alwaysAllowRules: bySource(wrapped, 'allow'), alwaysDenyRules: bySource(wrapped, 'deny'), alwaysAskRules: bySource(wrapped, 'ask') },
  );
  const reason = result.decisionReason;
  const rule = reason?.rule?.ruleValue;
  const why = result.behavior === 'passthrough' ? '没有规则说话' : reason?.type === 'rule' ? `规则 Bash(${rule.ruleContent})` : reason?.type === 'mode' ? `模式 ${reason.mode}` : (reason?.reason ?? reason?.type ?? '');
  return { behavior: result.behavior === 'passthrough' ? 'ask' : result.behavior, why };
}

/** 某条命令命中了哪些规则（只看规则文本的匹配，不做决策）。rules 的写法同 realBash。 */
export function realBashMatches(command, { rules = {} } = {}) {
  const wrapped = bashRules(rules);
  const matched = matchingRulesForInput(
    { command },
    { mode: 'default', alwaysAllowRules: bySource(wrapped, 'allow'), alwaysDenyRules: bySource(wrapped, 'deny'), alwaysAskRules: bySource(wrapped, 'ask') },
    'prefix',
  );
  const names = (list) => list.map((rule) => rule.ruleValue.ruleContent);
  return { deny: names(matched.matchingDenyRules), ask: names(matched.matchingAskRules), allow: names(matched.matchingAllowRules) };
}

// ── 第一组实验用的场景：同一个决策函数，不同的“规则 × 模式 × 工具自己的意见” ─────────────
// coda: 'same' 表示 coda 的 decide 应该给出同样的结论；'differs' 表示已知的差异；'skip' 表示 coda 没有对应的概念
export const SCENARIOS = [
  { id: 'plain', title: '没有规则，工具没有意见', mode: 'default', coda: 'same' },
  { id: 'sources', title: '一处写了 deny，另一处写了 allow', mode: 'default', rules: { deny: ['Write'], allow: ['Write'] }, coda: 'same' },
  { id: 'bypass-deny', title: 'bypassPermissions + deny 规则', mode: 'bypassPermissions', rules: { deny: ['Write'] }, coda: 'same' },
  { id: 'bypass-ask', title: 'bypassPermissions + ask 规则', mode: 'bypassPermissions', rules: { ask: ['Write'] }, coda: 'same' },
  { id: 'bypass-content-ask', title: 'bypassPermissions + 内容级 ask 规则', mode: 'bypassPermissions', local: 'content-ask', coda: 'same' },
  { id: 'bypass-safety', title: 'bypassPermissions + 受保护路径', mode: 'bypassPermissions', local: 'safety-check', coda: 'same' },
  { id: 'bypass-ask-plain', title: 'bypassPermissions + 普通的“要确认”', mode: 'bypassPermissions', local: 'ask', coda: 'same' },
  { id: 'allow-over-ask', title: 'allow 规则 + 工具自己说“要确认”', mode: 'default', rules: { allow: ['Write'] }, local: 'ask', coda: 'same' },
  { id: 'allow-vs-local-deny', title: 'allow 规则 + 工具自己 deny', mode: 'default', rules: { allow: ['Write'] }, local: 'deny', coda: 'same' },
  { id: 'ask-vs-local-allow', title: 'ask 规则 + 工具自己 allow', mode: 'default', rules: { ask: ['Write'] }, local: 'allow', coda: 'same' },
  { id: 'local-allow', title: '工具自己 allow（比如读工作目录里的文件）', mode: 'default', local: 'allow', coda: 'same' },
  { id: 'dontask', title: 'dontAsk，没有规则', mode: 'dontAsk', coda: 'same' },
  { id: 'dontask-allow', title: 'dontAsk + allow 规则', mode: 'dontAsk', rules: { allow: ['Write'] }, coda: 'same' },
  { id: 'dontask-ask', title: 'dontAsk + ask 规则', mode: 'dontAsk', rules: { ask: ['Write'] }, coda: 'same' },
  { id: 'mcp-server', title: 'allow mcp__gh（服务器级规则）→ 工具 mcp__gh__search', mode: 'default', tool: 'mcp__gh__search', rules: { allow: ['mcp__gh'] }, coda: 'same' },
  { id: 'star', title: 'deny 写成 Bash(*)', mode: 'default', tool: 'Bash', rules: { deny: ['Bash(*)'] }, coda: 'same' },
  { id: 'content-rule', title: '内容级 deny 规则 Bash(rm *)，工具没有意见', mode: 'default', tool: 'Bash', rules: { deny: ['Bash(rm *)'] }, coda: 'skip' },
  { id: 'plan', title: 'plan 模式，没有规则', mode: 'plan', coda: 'differs' },
  { id: 'headless-agent', title: '没有界面的后台 Agent，没有规则', mode: 'default', headless: true, coda: 'skip' },
];
