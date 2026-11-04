// 第 11 章的“真货”：在运行时从固定提交（Claude Code 2.1.88）里取出沙箱适配层的函数，原样执行。
// 代码不复制进仓库，每个函数的位置登记在 course/source-references.json（键以 sandbox- 开头，加上第 6 章登记的几个 perm- 键）。
//
// 被取出来执行的函数：
//   sandbox-adapter.ts   convertToSandboxRuntimeConfig（权限规则 → 沙箱配置）、resolvePathPatternForSandbox、
//                        resolveSandboxFilesystemPath、shouldAllowManagedSandboxDomainsOnly、permissionRuleValueFromString
//   shouldUseSandbox.ts  shouldUseSandbox、containsExcludedCommand（要不要进沙箱）
//   bashPermissions.ts   stripAllLeadingEnvVars、stripSafeWrappers（excludedCommands 匹配用）
//
// 假依赖（都是“和决策无关的外围”）：
//   设置的读取（用一个写死的、分来源的设置夹具）、路径展开、当前目录、临时目录、命令拆分器（一个简化版）、特性开关。
import { isAbsolute, join, resolve } from "node:path";
import { upstream } from "../engineering/run.mjs";

// stripTypeScriptTypes 是实验特性，第一次调用会往 stderr 打一条警告；关掉它，让实验输出干净
process.removeAllListeners("warning");

const SETTING_SOURCES = ["userSettings", "projectSettings", "localSettings", "flagSettings", "policySettings"];
const HOME = "/home/dev";

/** 一份“设置夹具”：每个来源的配置文件在哪，目录是哪里。 */
function fixture(project) {
  return {
    roots: {
      userSettings: `${HOME}/.claude`,
      projectSettings: project,
      localSettings: project,
      flagSettings: project,
      policySettings: "/etc/claude-code",
    },
    files: {
      userSettings: `${HOME}/.claude/settings.json`,
      projectSettings: `${project}/.claude/settings.json`,
      localSettings: `${project}/.claude/settings.local.json`,
      flagSettings: undefined,
      policySettings: "/etc/claude-code/managed-settings.json",
    },
  };
}

/** 路径展开的端口：~ 展开到主目录，相对路径相对于配置文件所在目录。 */
const expandPath = (pattern, root) => (pattern.startsWith("~/") ? join(HOME, pattern.slice(2)) : isAbsolute(pattern) ? pattern : resolve(root, pattern));

/**
 * 用真实的 convertToSandboxRuntimeConfig 把一份设置翻译成沙箱配置。
 *   sources   { userSettings: {...}, projectSettings: {...}, policySettings: {...} }，每个来源一份 settings.json 的内容
 *   project   项目目录（也是启动目录）
 *   options   { existing: 已经存在的“裸仓库文件”, extraDirs: --add-dir 加进来的目录 }
 * 返回 { config, scrub }：config 是 JSON 化的配置，字段和 sandbox-runtime 收到的一样；
 * scrub 是“当前不存在、命令结束后要清理”的裸仓库文件路径。
 */
export function realSandboxConfig(sources, project, { existing = [], extraDirs = [] } = {}) {
  const env = fixture(project);
  const scrub = [];
  const getSettingsRootPathForSource = (source) => env.roots[source];
  const getSettingsForSource = (source) => sources[source];
  const shouldAllowManagedSandboxDomainsOnly = upstream("sandbox-managed-only", "shouldAllowManagedSandboxDomainsOnly", { getSettingsForSource });
  const shouldAllowManagedReadPathsOnly = upstream("sandbox-managed-read-only", "shouldAllowManagedReadPathsOnly", { getSettingsForSource });
  const convert = upstream("sandbox-config", "convertToSandboxRuntimeConfig", {
    shouldAllowManagedSandboxDomainsOnly,
    shouldAllowManagedReadPathsOnly,
    permissionRuleValueFromString: upstream("sandbox-rule-parse", "permissionRuleValueFromString"),
    resolvePathPatternForSandbox: upstream("sandbox-path-pattern", "resolvePathPatternForSandbox", { getSettingsRootPathForSource, resolve }),
    resolveSandboxFilesystemPath: upstream("sandbox-fs-path", "resolveSandboxFilesystemPath", { getSettingsRootPathForSource, expandPath }),
    getSettingsForSource,
    getSettingsFilePathForSource: (source) => env.files[source],
    SETTING_SOURCES,
    WEB_FETCH_TOOL_NAME: "WebFetch",
    FILE_EDIT_TOOL_NAME: "Edit",
    FILE_READ_TOOL_NAME: "Read",
    getClaudeTempDir: () => "/tmp/claude-501", // 每个用户一个：claude-<uid>
    getManagedSettingsDropInDir: () => "/etc/claude-code/managed-settings.d",
    getCwdState: () => project,
    getOriginalCwd: () => project,
    getAdditionalDirectoriesForClaudeMd: () => extraDirs,
    resolve,
    // “某个裸仓库文件现在存在吗”：存在的进 denyWrite，不存在的留着命令结束后清理
    statSync: (path) => {
      if (!existing.includes(path)) throw Error("ENOENT");
    },
    bareGitRepoScrubPaths: scrub,
    worktreeMainRepoPath: null,
    ripgrepCommand: () => ({ rgPath: "rg", rgArgs: [], argv0: undefined }),
  });
  // 合并后的设置：权限规则和网络域名取各来源的并集（真实代码里由设置系统合并）
  const merged = { permissions: { allow: [], deny: [] }, sandbox: { network: { allowedDomains: [] } } };
  for (const source of SETTING_SOURCES) {
    const s = sources[source];
    merged.permissions.allow.push(...(s?.permissions?.allow ?? []));
    merged.permissions.deny.push(...(s?.permissions?.deny ?? []));
    merged.sandbox.network.allowedDomains.push(...(s?.sandbox?.network?.allowedDomains ?? []));
  }
  return { config: JSON.parse(JSON.stringify(convert(merged))), scrub: [...scrub] };
}

// ── 要不要进沙箱 ───────────────────────────────────────────────

/** 命令拆分器的简化版：只按 && || ; | 切开（真实代码用 shell-quote 做词法分析，见第 6 章的说明）。 */
const splitCommand = (command) => command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);

const stripComments = upstream("perm-bash-strip-comments", "stripCommentLines");
const stripAllLeadingEnvVars = upstream("perm-bash-strip-env", "stripAllLeadingEnvVars", { stripCommentLines: stripComments });
const stripSafeWrappers = upstream("perm-bash-strip-wrappers", "stripSafeWrappers", {
  stripCommentLines: stripComments,
  SAFE_ENV_VARS: new Set(["NODE_ENV", "TZ", "LANG"]),
  ANT_ONLY_SAFE_ENV_VARS: new Set(),
  process: { env: {} },
});
const bashPermissionRule = upstream("perm-shell-parse", "parsePermissionRule", {
  permissionRuleExtractPrefix: upstream("perm-shell-prefix", "permissionRuleExtractPrefix"),
  hasWildcards: upstream("perm-shell-has-wildcards", "hasWildcards"),
});
const matchWildcardPattern = upstream("perm-shell-wildcard", "matchWildcardPattern", {
  ESCAPED_STAR_PLACEHOLDER: "\0S\0",
  ESCAPED_BACKSLASH_PLACEHOLDER: "\0B\0",
  ESCAPED_STAR_PLACEHOLDER_RE: /\0S\0/g,
  ESCAPED_BACKSLASH_PLACEHOLDER_RE: /\0B\0/g,
});

// 设置在每次调用时换一份：被取出来的函数通过这个变量读到“当前的”sandbox 设置
let currentSandboxSettings = {};
const containsExcludedCommand = upstream("sandbox-excluded", "containsExcludedCommand", {
  process: { env: {} }, // USER_TYPE 不是 ant：跳过内部的动态名单
  getFeatureValue_CACHED_MAY_BE_STALE: () => ({ commands: [], substrings: [] }),
  splitCommand_DEPRECATED: splitCommand,
  getSettings_DEPRECATED: () => ({ sandbox: currentSandboxSettings }),
  stripAllLeadingEnvVars,
  stripSafeWrappers,
  BINARY_HIJACK_VARS: /^(?:LD_|DYLD_)|^PATH$/, // 与源码里的同名常量含义相同：这几类变量会让命令换一个程序运行
  bashPermissionRule,
  matchWildcardPattern,
});
const shouldUseSandbox = upstream("sandbox-should-use", "shouldUseSandbox", {
  containsExcludedCommand,
  SandboxManager: {
    isSandboxingEnabled: () => currentSandboxSettings.enabled === true,
    areUnsandboxedCommandsAllowed: () => currentSandboxSettings.allowUnsandboxedCommands ?? true, // 适配层里的缺省值：允许
  },
});

/**
 * 用真实的 shouldUseSandbox 判断一条命令。
 *   settings  { enabled, allowUnsandboxedCommands, excludedCommands }，写法和 settings.json 里的 sandbox 一样
 */
export function realShouldUseSandbox(input, settings) {
  currentSandboxSettings = settings;
  return shouldUseSandbox(input);
}
