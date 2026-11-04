// 沙箱（第 11 章）：把“权限规则”落到真实进程上。
//
// Claude Code 里这件事分在四个地方，这个文件把它们压成一个模块：
//
//   utils/sandbox/sandbox-adapter.ts    权限规则 → 沙箱配置                sandboxPolicy
//   tools/BashTool/shouldUseSandbox.ts  这条命令要不要进沙箱                sandboxDecision
//   sandbox-runtime（开源组件）         配置 → seatbelt 配置 / bwrap 参数   seatbeltProfile、bwrapArgs
//   sandbox-runtime 的网络代理          一个域名能不能放行                  networkDecision
//
// 数据流：规则 { allow, deny } ─ sandboxPolicy → 策略 ─ seatbeltProfile / bwrapArgs → 外壳命令 ─ runProcess → 真实进程。
//
// 相对原版的简化：
//   - 只包 argv 形式的命令（不经过 shell），所以没有“shell 快照 + eval”那一层；
//   - 读：整台机器可读，只禁止 denyRead；写：只有工作目录和一个专用临时目录；
//   - 网络：完全断开，或者只允许连本机的一个代理端口。代理本身（按域名放行）在 Learn Pi Agent 第 15 章写过，这里只保留它的决策函数；
//   - Linux 上不做“代理经 unix socket 接进网络命名空间”，也没有 seccomp；
//   - 没有后端时 runSandboxed 直接抛错。Claude Code 默认只警告然后不加沙箱运行（failIfUnavailable 才会退出），coda 固定取后一种。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isIP } from "node:net";
import { runProcess } from "./process.mjs";

// ───────────────────────── 一、权限规则 → 沙箱策略 ─────────────────────────

/**
 * 工作目录里“写进去的东西会在沙箱之外被执行或信任”的位置，沙箱里一律不许写。
 * 对应 sandbox-runtime 的 DANGEROUS_FILES、getDangerousDirectories、.git/hooks、.git/config，
 * 以及适配层额外强加的 .claude 配置和 skills。每一项在工作目录的任意深度都生效。
 */
export const PROTECTED_PATHS = [
  ".git/hooks", // 下一次在沙箱外 git commit 时运行
  ".git/config", // core.fsmonitor 可以指定任意程序
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json", // 会启动新的 MCP 服务器
  ".vscode",
  ".idea",
  ".claude/commands",
  ".claude/agents",
  ".claude/skills",
  ".claude/settings.json", // 沙箱自己的配置：不能让命令改写自己的牢笼
  ".claude/settings.local.json",
];

/** 内核看到的是真实路径：macOS 的 /tmp、/var 是 /private 下的符号链接，写进策略之前必须解析。不存在的路径解析到最近的存在的祖先。 */
export function real(path) {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

/** "Edit(src/**)" → { tool: "Edit", content: "src/**" }；"Edit" → { tool: "Edit" } */
function parseRule(text) {
  const match = /^([^()]+)\((.*)\)$/.exec(text);
  return match ? { tool: match[1], content: match[2] } : { tool: text };
}

/**
 * 权限规则里的路径写法（Edit(...)、Read(...)）：
 *   //abs/path  从文件系统根开始     /path  相对于配置文件所在的目录（这里是工作目录）
 *   ~/path      用户主目录           其余   相对于工作目录
 */
function rulePath(pattern, root) {
  if (pattern.startsWith("//")) return pattern.slice(1);
  if (pattern.startsWith("/")) return resolve(root, pattern.slice(1));
  if (pattern.startsWith("~/")) return join(homedir(), pattern.slice(2));
  return resolve(root, pattern);
}

/** sandbox.filesystem.* 配置里的路径写法：就是普通路径，/path 是绝对路径（和权限规则里的 /path 含义不同）。 */
function settingPath(pattern, root) {
  if (pattern.startsWith("//")) return pattern.slice(1);
  if (pattern.startsWith("~/")) return join(homedir(), pattern.slice(2));
  return resolve(root, pattern);
}

/** 沙箱只认目录前缀：去掉结尾的 /** 和 /*；中间还带通配符的路径不支持，交给调用者看 skipped。 */
function pathEntry(path, skipped) {
  const stripped = path.replace(/\/\*{1,2}$/, "");
  if (/[*?[\]]/.test(stripped)) {
    skipped.push(path);
    return undefined;
  }
  return real(stripped);
}

// 这两个工具的规则决定“哪里可写”（Claude Code 的适配层只看 Edit；coda 有单独的 Write 工具，一并算上）
const WRITE_TOOLS = new Set(["Edit", "Write"]);

/**
 * 权限规则 → 沙箱策略。对应 convertToSandboxRuntimeConfig。
 *
 *   rules    { allow: [...], deny: [...] }，写法和第 6 章的规则一样
 *   options  { allowWrite, denyWrite, denyRead }  相当于 sandbox.filesystem.*，与规则合并而不是替换
 *            { proxyPort }  有值时只允许连 localhost:proxyPort，没有就完全断网
 *            { extraDirs }  相当于 --add-dir；{ tmp }  专用临时目录
 *
 * 规则怎样变成策略：
 *   Edit / Write 的 allow → allowWrite     Edit / Write 的 deny → denyWrite
 *   Read 的 deny → denyRead                WebFetch(domain:x) 的 allow / deny → allowedDomains / deniedDomains
 *   其余的规则（比如 Bash(rm *)）不进策略：沙箱里没有“命令文本”这个概念。
 * 无条件的：工作目录和临时目录可写；PROTECTED_PATHS 不可写（在 seatbeltProfile / bwrapArgs 里加上，没有规则能放开）。
 */
export function sandboxPolicy(root, rules = {}, options = {}) {
  const base = real(root);
  const skipped = [];
  // 一组路径 → 沙箱认得的目录前缀；不支持的写法记进 skipped
  const toEntries = (paths) => paths.flatMap((path) => pathEntry(path, skipped) ?? []);
  const fromSettings = (paths = []) => toEntries(paths.map((path) => settingPath(path, base)));

  const policy = {
    root: base,
    tmp: real(options.tmp ?? join(tmpdir(), `coda-sandbox-${process.getuid?.() ?? 0}`)),
    allowWrite: [base],
    denyWrite: [],
    denyRead: [],
    allowedDomains: [],
    deniedDomains: [],
    proxyPort: options.proxyPort,
    skipped,
  };
  // 写根的起点：工作目录、--add-dir 加进来的目录、专用临时目录
  policy.allowWrite.push(...fromSettings(options.extraDirs), policy.tmp);

  // 一、权限规则
  const parsed = [
    ...(rules.allow ?? []).map((text) => ({ behavior: "allow", ...parseRule(text) })),
    ...(rules.deny ?? []).map((text) => ({ behavior: "deny", ...parseRule(text) })),
  ];
  for (const { behavior, tool, content } of parsed) {
    if (!content) continue; // 整个工具的规则（没有括号）不涉及路径和域名
    if (WRITE_TOOLS.has(tool)) {
      (behavior === "allow" ? policy.allowWrite : policy.denyWrite).push(...toEntries([rulePath(content, base)]));
    } else if (tool === "Read" && behavior === "deny") {
      policy.denyRead.push(...toEntries([rulePath(content, base)]));
    } else if (tool === "WebFetch" && content.startsWith("domain:")) {
      (behavior === "allow" ? policy.allowedDomains : policy.deniedDomains).push(content.slice("domain:".length));
    }
  }

  // 二、sandbox.filesystem.*：路径写法和权限规则里的不同（/path 是绝对路径）
  policy.allowWrite.push(...fromSettings(options.allowWrite));
  policy.denyWrite.push(...fromSettings(options.denyWrite));
  policy.denyRead.push(...fromSettings(options.denyRead));
  return policy;
}

// ───────────────────────── 二、策略 → macOS seatbelt 配置 ─────────────────────────

// 默认拒绝之后，运行一个普通程序仍然需要的最小集合：创建进程、读系统信息、几个系统服务。
// 原版（参照 Chrome 的沙箱）把 mach 服务和 sysctl 逐个列出；这里只留下 node、git、shell 跑起来必需的部分。
const SEATBELT_BASICS = [
  "(allow process-exec)",
  "(allow process-fork)",
  "(allow process-info* (target same-sandbox))", // 只能看同一个沙箱里的进程
  "(allow signal (target same-sandbox))", // 只能给同一个沙箱里的进程发信号
  "(allow user-preference-read)",
  "(allow mach-lookup",
  '  (global-name "com.apple.logd")',
  '  (global-name "com.apple.system.logger")',
  '  (global-name "com.apple.system.notification_center")',
  '  (global-name "com.apple.system.opendirectoryd.libinfo")',
  '  (global-name "com.apple.system.opendirectoryd.membership")',
  '  (global-name "com.apple.bsd.dirhelper")',
  '  (global-name "com.apple.securityd.xpc")',
  '  (global-name "com.apple.coreservices.launchservicesd")',
  '  (global-name "com.apple.SecurityServer"))',
  "(allow ipc-posix-shm)",
  "(allow ipc-posix-sem)",
  "(allow iokit-get-properties)",
  "(allow sysctl-read)",
  '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))',
];

// SBPL 的路径过滤器。路径先解析成真实路径：内核比较的是解析之后的路径。
const subpath = (path) => `(subpath ${JSON.stringify(real(path))})`;
const literal = (path) => `(literal ${JSON.stringify(real(path))})`;
const regexEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "a/b/c" → ["a", "a/b"]：一条相对路径的所有上级目录。 */
function parentDirs(relative) {
  const parts = relative.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * 工作目录下任意深度的某些名字：既匹配 root/name，也匹配 root/任意/层/name（sandbox-runtime 对每个名字各写一条字面量和一条 **\/name）。
 * tail 决定名字后面允许什么：`(/|$)` 连同名字底下的一切，`$` 只有名字本身。
 */
function anywhereUnder(root, names, tail) {
  const alternatives = names.map(regexEscape).join("|");
  return `(regex #"^${regexEscape(root)}/(.+/)?(${alternatives})${tail}")`;
}

/**
 * 策略 → seatbelt 配置（交给 sandbox-exec -p）。对应 sandbox-runtime 的 generateSandboxProfile。
 * seatbelt 的规则后写的优先，所以每一段都是“先放开，再收紧”：
 *   默认拒绝一切 → 放开运行程序必需的 → 读：放开所有，再禁止 denyRead
 *   → 写：只放开写根，再禁止 denyWrite 和受保护路径 → 网络：什么都不放，除了代理端口。
 */
export function seatbeltProfile(policy) {
  const { root } = policy;
  const insideRoot = (path) => path.startsWith(root + "/");

  const readRules = [
    "(allow file-read*)",
    ...(policy.denyRead.length ? [`(deny file-read* ${policy.denyRead.map(subpath).join(" ")})`] : []),
  ];

  // 写根里面仍然不能写的：规则里的 Edit(...) deny，加上受保护路径
  const noWrite = [...policy.denyWrite.map(subpath), anywhereUnder(root, PROTECTED_PATHS, "(/|$)")];

  // 搬走一个受保护路径的上级目录再放回来，就绕过了对它的禁止：所以这些上级目录不能被删除或改名，写根自己也一样
  const protectedParents = [...new Set(PROTECTED_PATHS.flatMap(parentDirs))];
  const deniedParents = policy.denyWrite
    .filter(insideRoot)
    .flatMap((path) => parentDirs(path.slice(root.length + 1)))
    .map((relative) => join(root, relative));
  const immovable = [literal(root), ...deniedParents.map(literal), anywhereUnder(root, protectedParents, "$")];

  const writeRules = [
    `(allow file-write* ${policy.allowWrite.map(subpath).join(" ")} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))`,
    `(deny file-write* ${noWrite.join(" ")})`,
    `(deny file-write-unlink ${immovable.join(" ")})`,
  ];

  const networkRules = policy.proxyPort ? [`(allow network-outbound (remote ip "localhost:${policy.proxyPort}"))`] : [];

  return [
    "(version 1)",
    "(deny default)",
    "",
    "; 运行程序必需的最小集合",
    ...SEATBELT_BASICS,
    "",
    "; 读：先放开，再禁止",
    ...readRules,
    "",
    "; 写：只放开写根，再在里面禁止",
    ...writeRules,
    "",
    "; 网络：默认拒绝；有代理时，只放开连代理端口",
    ...networkRules,
  ].join("\n");
}

// ───────────────────────── 三、策略 → Linux bubblewrap 参数 ─────────────────────────

/**
 * 策略 → bwrap 参数。bubblewrap 不写规则，而是为命令重新拼一个文件系统：
 * 整个根目录只读挂载，可写的目录再以读写方式挂一遍，禁读的路径用空目录或 /dev/null 盖住。
 * 对应 sandbox-runtime 的 wrapCommandWithSandboxLinux + generateFilesystemArgs。
 * 不存在的禁写路径没法挂载（原版会放一个 /dev/null 占位，再在命令结束后清理），这里直接跳过。
 */
export function bwrapArgs(policy) {
  const protectedPaths = PROTECTED_PATHS.map((name) => join(policy.root, name));
  const isDirectory = (path) => statSync(path).isDirectory();
  return [
    "--new-session", // 脱离控制终端，防止往终端里注入按键
    "--die-with-parent", // 父进程退出，沙箱里的进程一起退出
    "--unshare-net", // 空的网络命名空间：没有任何网卡（代理模式要把代理接进来，coda 没有实现，所以始终整体断网）
    "--ro-bind", "/", "/", // 整个文件系统只读
    ...policy.allowWrite.filter(existsSync).flatMap((p) => ["--bind", real(p), real(p)]), // 写根重新以读写方式挂上
    ...[...policy.denyWrite, ...protectedPaths].filter(existsSync).flatMap((p) => ["--ro-bind", real(p), real(p)]), // 写根里的受保护路径再改回只读
    ...policy.denyRead.filter(existsSync).flatMap((p) => (isDirectory(p) ? ["--tmpfs", real(p)] : ["--ro-bind", "/dev/null", real(p)])), // 禁读：目录换成空 tmpfs，文件换成 /dev/null
    "--dev", "/dev",
    "--unshare-pid", // 看不到沙箱外的进程，也杀不了它们
    "--proc", "/proc",
  ];
}

// ───────────────────────── 四、选后端、包装命令、运行 ─────────────────────────

/** 当前平台有没有可用的沙箱后端。没有时说明原因，调用者不能默默退回普通执行。 */
export function detectBackend(platform = process.platform) {
  if (platform === "darwin") {
    return existsSync("/usr/bin/sandbox-exec")
      ? { name: "seatbelt", command: "/usr/bin/sandbox-exec" }
      : { reason: "找不到 /usr/bin/sandbox-exec" };
  }
  if (platform === "linux") {
    return spawnSync("which", ["bwrap"]).status === 0
      ? { name: "bubblewrap", command: "bwrap" }
      : { reason: "没有安装 bubblewrap（bwrap）" };
  }
  return { reason: `${platform} 上没有可用的沙箱后端` };
}

/** 沙箱里的进程拿到的环境变量：专用临时目录；有代理时把常见工具认的代理变量都指向它（原版一共设置二十多个）。 */
export function sandboxEnv(policy) {
  const env = { CODA_SANDBOX: "1", TMPDIR: policy.tmp };
  if (policy.proxyPort) {
    const url = `http://localhost:${policy.proxyPort}`;
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[name] = url;
    env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
  }
  return env;
}

/**
 * 把 command + args 包进沙箱，返回真正要启动的程序。没有后端返回 undefined。
 * options: { rules, policy（已经算好的策略）, platform（测试用，假装在别的平台）, ...sandboxPolicy 的 options }
 */
export function sandboxCommand(root, command, args = [], options = {}) {
  const backend = detectBackend(options.platform);
  if (!backend.name) return undefined;
  const policy = options.policy ?? sandboxPolicy(root, options.rules, options);
  if (backend.name === "seatbelt") {
    return { command: backend.command, args: ["-p", seatbeltProfile(policy), command, ...args], backend: "seatbelt", policy };
  }
  return { command: backend.command, args: [...bwrapArgs(policy), "--", command, ...args], backend: "bubblewrap", policy };
}

/** 在沙箱里运行一个命令。没有后端就抛错，绝不退回普通执行。结果比 runProcess 多一个 backend 字段。 */
export async function runSandboxed(root, command, args, options = {}) {
  const wrapped = sandboxCommand(root, command, args, options);
  if (!wrapped) {
    const { reason } = detectBackend(options.platform);
    throw Error(`sandbox unavailable: ${reason}; refusing unsandboxed fallback`);
  }
  mkdirSync(wrapped.policy.tmp, { recursive: true, mode: 0o700 });
  const result = await runProcess(wrapped.command, wrapped.args, {
    ...options,
    cwd: root,
    env: { ...sandboxEnv(wrapped.policy), ...options.env },
  });
  return { ...result, backend: wrapped.backend };
}

// ───────────────────────── 五、哪些命令进沙箱 ─────────────────────────

// 开头的 LD_*、DYLD_*、PATH 会让命令换一个程序运行，不能当作无害的环境变量剥掉
const HIJACK_VARS = /^(?:LD_|DYLD_)|^PATH$/;
const WRAPPERS = /^(?:timeout\s+\S+|time|nice(?:\s+-n\s+\S+)?|nohup)\s+/;
const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=\S*\s+/;

/** 按 && || ; | 把复合命令切开（引号里的不算；单个 & 是重定向或后台符号，不切）。 */
function splitCommand(command) {
  const parts = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const pair = command.slice(i, i + 2);
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (pair === "&&" || pair === "||") {
      parts.push(current);
      current = "";
      i++;
      continue;
    } else if (ch === ";" || ch === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** 一个子命令的候选写法：原样，以及逐层剥掉开头的环境变量和 timeout / nice / nohup 之后的样子。 */
function candidates(command) {
  const out = [command];
  let current = command;
  while (true) {
    const env = ENV_ASSIGNMENT.exec(current);
    const strip = env && !HIJACK_VARS.test(env[1]) ? env : WRAPPERS.exec(current);
    if (!strip) return out;
    current = current.slice(strip[0].length);
    out.push(current);
  }
}

/** 排除规则三种写法：`npm:*`（前缀）、`npm run *`（通配符）、`docker ps`（精确）。 */
function matchesExcluded(pattern, candidate) {
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return candidate === prefix || candidate.startsWith(prefix + " ");
  }
  if (pattern.includes("*")) {
    return new RegExp(`^${pattern.split("*").map(regexEscape).join(".*")}$`, "s").test(candidate);
  }
  return candidate === pattern;
}

/**
 * 这条命令要不要进沙箱？对应 shouldUseSandbox，四个出口按顺序检查：
 *   1. 沙箱没开 → 不进        2. 模型带了 dangerouslyDisableSandbox，而策略允许 → 不进
 *   3. 没有命令 → 不进        4. 命中 excludedCommands → 不进        其余 → 进
 * settings: { enabled, allowUnsandboxedCommands（默认 true）, excludedCommands }
 * 返回 { sandboxed, why }，why 说明走了哪个出口。
 */
export function sandboxDecision(input, settings = {}) {
  if (!settings.enabled) return { sandboxed: false, why: "沙箱没有开启" };
  if (input.dangerouslyDisableSandbox && settings.allowUnsandboxedCommands !== false) {
    return { sandboxed: false, why: "模型要求不进沙箱（dangerouslyDisableSandbox），策略允许" };
  }
  if (!input.command) return { sandboxed: false, why: "没有命令" };
  // 复合命令逐个子命令检查：`docker ps && curl evil.com` 不能因为第一个子命令被排除就整条逃出去
  const excluded = (settings.excludedCommands ?? []).length > 0 &&
    splitCommand(input.command).some((part) =>
      candidates(part).some((c) => settings.excludedCommands.some((pattern) => matchesExcluded(pattern, c))),
    );
  if (excluded) return { sandboxed: false, why: "命中 excludedCommands" };
  return { sandboxed: true, why: input.dangerouslyDisableSandbox ? "带了 dangerouslyDisableSandbox，但策略禁止（allowUnsandboxedCommands: false）" : "默认进沙箱" };
}

export const shouldUseSandbox = (input, settings) => sandboxDecision(input, settings).sandboxed;

// ───────────────────────── 六、代理怎样决定一个域名 ─────────────────────────

/** 主机名只允许 DNS 标签的字符或 IP 字面量；带控制字符、空格、% 的一律不是主机名。 */
function isValidHost(host) {
  if (!host || host.length > 255) return false;
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare.includes("%")) return false;
  return isIP(bare) !== 0 || /^[A-Za-z0-9._-]+$/.test(bare);
}

/** 用 URL 解析器规范化：2852039166 和 169.254.169.254 是同一个地址，大小写和结尾的点也统一。 */
function canonicalHost(host) {
  try {
    return new URL(`http://${host}/`).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

/** `*` 匹配一切；`*.example.com` 匹配所有子域名（不含 example.com 本身，也不匹配 IP）；其余精确匹配。 */
export function matchesDomain(host, pattern) {
  const h = host.toLowerCase();
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return isIP(h) === 0 && h.endsWith("." + pattern.slice(2).toLowerCase());
  return h === pattern.toLowerCase();
}

/**
 * 沙箱里的命令想连 host:port，代理放不放行？对应 sandbox-runtime 的 filterNetworkRequest：
 *   主机名不合法 → 拒绝；规范化；deniedDomains 命中 → 拒绝；allowedDomains 命中 → 放行；
 *   都没命中：有 ask 回调就问（没人回答也算拒绝），没有就拒绝。
 * 返回 { allow, why }。
 */
export async function networkDecision(host, port, policy, ask) {
  const deny = (why) => ({ allow: false, why });
  // 先检查再比较：`evil.com\0.allowed.com` 用 endsWith 看像是 allowed.com 的子域名，DNS 解析时却在 \0 处截断，连的是 evil.com
  if (!isValidHost(host)) return deny("malformed host");
  const canonical = canonicalHost(host) ?? host.toLowerCase();
  if (policy.deniedDomains.some((pattern) => matchesDomain(canonical, pattern))) return deny("host is on the deny list");
  if (policy.allowedDomains.some((pattern) => matchesDomain(canonical, pattern))) return { allow: true, why: "host is on the allow list" };
  if (!ask) return deny("host is not on the allow list");
  try {
    return (await ask({ host: canonical, port })) ? { allow: true, why: "user allowed" } : deny("user denied");
  } catch {
    return deny("permission prompt failed");
  }
}
