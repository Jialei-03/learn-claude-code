// 第 9 章：Skill。
//
// 对应 Claude Code 2.1.88 里的几处，正文都有 @cc 摘录：
//   skills/loadSkillsDir.ts                         目录 → 命令：扫描 .claude/skills 和 .claude/commands，解析 frontmatter
//   commands.ts（findCommand）                      按名字查找，先到先得
//   tools/SkillTool/prompt.ts                       模型平时看到的“目录”：一条一行，有字符预算
//   utils/attachments.ts                            目录作为附件发送，只发没发过的
//   tools/SkillTool/SkillTool.ts                    Skill 工具：校验 → 权限（带授权的要批准）→ 内联展开 / fork
//   utils/processUserInput/processSlashCommand.tsx  用户输入 /名字 走的另一扇门
//   utils/argumentSubstitution.ts                   $ARGUMENTS、$0、具名参数
//   utils/promptShellExecution.ts                   !`命令`：正文交给模型之前先在本地执行
//   services/compact/compact.ts                     压缩之后重新附上用过的 Skill
//
// 一个 Skill 是什么：
//   · 一个目录里的 SKILL.md（或者旧式的 commands/名字.md）：开头的 frontmatter 是元数据，其余是正文；
//   · 身份是目录名，frontmatter 里的 name 只是显示名，两个都能用来查找；
//   · 平时只有“名字: 描述”这一行在模型的上下文里；正文在调用时才读出来、渲染、交给模型。
//
// 相对原版的简化：
//   · frontmatter 只认单行的 `key: value`（不是完整的 YAML），重复的键直接报错；
//   · 只扫描项目里的两个目录，没有用户目录、托管目录、插件、MCP、内置 Skill，也没有 paths 条件激活；
//   · 不处理 hooks、model、effort、shell、${CLAUDE_SESSION_ID}；
//   · 工具结果只有一个 text 通道：原版是 tool_result 里一句 “Launching skill”，正文作为另一条 meta 用户消息，
//     coda 直接把渲染后的正文当作工具结果；
//   · 授权（allowed-tools）记在 Skills 实例上，由宿主在每一轮开始时 resetGrants()；
//     原版记在这一轮的权限上下文里，下一轮自然失效；
//   · 每次 load() 都重读文件；原版在启动时把正文捕获进闭包，靠文件监听器清缓存来热更新。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { workspacePath } from "../../runtime/files.mjs";
import { runProcess } from "../../runtime/process.mjs";
import { parseRule, wildcardMatch } from "./permissions.mjs";

// ───────────────────────── 一、frontmatter ─────────────────────────

// 去掉一对包住整个值的引号
const unquote = (value) => value.replace(/^(["'])(.*)\1$/, "$2").trim();

// allowed-tools 的写法：逗号或空格分隔，但括号里的逗号和空格不算分隔符——
// `Bash(git commit -m "x, y"), Read` 是两个工具，不是四个。
export function splitToolList(text) {
  const tools = [];
  let current = "";
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth = Math.max(0, depth - 1);
    const separator = depth === 0 && (char === "," || /\s/.test(char));
    if (!separator) current += char;
    else if (current) {
      tools.push(current);
      current = "";
    }
  }
  if (current) tools.push(current);
  return tools;
}

// 解析一个 Skill 文件。frontmatter 是可选的：旧式命令常常整个文件就是一段正文。
// 刻意不支持 YAML 的列表、嵌套、锚点：不是 `key: value` 的行直接报错，重复的键也报错，不去猜。
export function parseSkill(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  const fields = {};
  for (const line of (match?.[1] ?? "").split(/\r?\n/).filter((l) => l.trim())) {
    const pair = line.match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
    if (!pair) throw Error(`invalid skill field: ${line}`);
    if (Object.hasOwn(fields, pair[1])) throw Error(`duplicate skill field: ${pair[1]}`);
    fields[pair[1]] = unquote(pair[2]);
  }
  const userInvocable = fields["user-invocable"];
  return {
    name: fields.name || undefined, //                   frontmatter 里的 name；身份由 Skills 按目录名决定
    description: fields.description || undefined, //     没写就由 Skills 取正文的第一行
    whenToUse: fields.when_to_use,
    argumentHint: fields["argument-hint"],
    argumentNames: (fields.arguments ?? "").split(/\s+/).filter((n) => n && !/^\d+$/.test(n)),
    allowedTools: splitToolList(fields["allowed-tools"] ?? ""),
    disableModelInvocation: fields["disable-model-invocation"] === "true", // 只有字面的 true 才算
    userInvocable: userInvocable === undefined ? true : userInvocable === "true",
    fork: fields.context === "fork",
    agent: fields.agent,
    body: (match ? match[2] : text).trim(),
  };
}

// 没写 description 时用正文的第一行（去掉 # 标题记号，最长 100 个字符）
function firstLine(body, fallback) {
  const line = body.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return fallback;
  const text = line.replace(/^#+\s+/, "");
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

// ───────────────────────── 二、发现：目录 → 文件列表 ─────────────────────────

// 扫描约定的目录，返回按优先级排好的来源列表：先出现的先赢。
//   .claude/skills/<名字>/SKILL.md   一个目录一个 Skill（目录里的其他文件是它的附带资料，不会被当成 Skill）
//   .claude/commands/**/*.md          旧式命令：一个文件一个命令，子目录是命名空间（ops/deploy.md → ops:deploy）
export function discoverSkillFiles(root, { skills = [".claude/skills"], commands = [".claude/commands"] } = {}) {
  const sources = [];
  const list = (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : []);
  for (const dir of skills)
    for (const entry of list(dir)) {
      const path = join(dir, entry.name, "SKILL.md");
      if (entry.isDirectory() && existsSync(join(root, path))) sources.push({ path, kind: "skill" });
    }
  const walk = (base, dir) => {
    for (const entry of list(dir)) {
      if (entry.isDirectory()) walk(base, join(dir, entry.name));
      else if (entry.name.endsWith(".md")) sources.push({ path: join(dir, entry.name), kind: "command", base });
    }
  };
  for (const dir of commands) walk(dir, dir);
  return sources;
}

// 命令的身份：skills 里是目录名；commands 里是文件名，子目录用冒号连起来。
// 直接放在工作区根目录的 SKILL.md 没有目录名可用，退回 frontmatter 的 name。
function identityOf({ path, kind, base }, frontmatterName) {
  if (kind === "command") return relative(base, path).replace(/\.md$/, "").split(sep).join(":");
  const parent = dirname(path);
  return parent === "." ? frontmatterName || "SKILL" : basename(parent);
}

// 读一个来源文件，得到完整的 Skill（含正文）。发现阶段和调用阶段都走这里。
function readSkill(root, source) {
  const file = workspacePath(root, source.path);
  const parsed = parseSkill(readFileSync(file, "utf8"));
  const name = identityOf(source, parsed.name);
  return {
    ...parsed,
    name,
    displayName: parsed.name && parsed.name !== name ? parsed.name : undefined,
    description: parsed.description ?? firstLine(parsed.body, source.kind === "skill" ? "Skill" : "Custom command"),
    descriptionFrom: parsed.description ? "frontmatter" : "body",
    kind: source.kind,
    path: source.path,
    dir: source.kind === "skill" ? dirname(file) : undefined, // 只有目录形式的 Skill 有“基准目录”
  };
}

// ───────────────────────── 三、模型平时看到的目录 ─────────────────────────

const CHARS_PER_TOKEN = 4;
const BUDGET_SHARE = 0.01; //   目录最多占上下文窗口的 1%
const MAX_ENTRY_CHARS = 250; // 每一条的描述最长这么多
const MIN_DESCRIPTION_WIDTH = 20; // 平均分到的描述不足这么宽，就只列名字

// 终端里占几列：中日韩的字符占两列，其余一列。原版用 stringWidth，这里是它的近似。
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u;
export const displayWidth = (text) => [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);

// 截到不超过 max 列，超出的部分换成省略号
function clipToWidth(text, max) {
  if (displayWidth(text) <= max) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const width = displayWidth(char);
    if (used + width > max - 1) break;
    out += char;
    used += width;
  }
  return `${out}…`;
}

// 一条目录项的描述 = description，有 when_to_use 就接在后面；整体最长 250 个字符
function describe({ description, whenToUse }) {
  const text = whenToUse ? `${description} - ${whenToUse}` : description;
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS - 1)}…` : text;
}

// 把一组 Skill 排成目录。三档，逐档降级：
//   1. 预算够，每条都带完整描述；
//   2. 不够，把扣掉“- 名字: ”之后剩下的预算平均分给每条，描述各自截短；
//   3. 平均每条分不到 20 列，只列名字。
// （原版另有一条：内置 Skill 永远保留完整描述，只截其余的。coda 没有内置 Skill。）
export function formatListing(skills, contextWindow = 200_000) {
  if (!skills.length) return "";
  const budget = Math.floor(contextWindow * CHARS_PER_TOKEN * BUDGET_SHARE);

  const full = skills.map((s) => `- ${s.name}: ${describe(s)}`);
  const fullWidth = full.reduce((sum, line) => sum + displayWidth(line), 0) + (full.length - 1);
  if (fullWidth <= budget) return full.join("\n");

  const fixed = skills.reduce((sum, s) => sum + displayWidth(s.name) + 4, 0) + (skills.length - 1);
  const each = Math.floor((budget - fixed) / skills.length);
  if (each < MIN_DESCRIPTION_WIDTH) return skills.map((s) => `- ${s.name}`).join("\n");
  return skills.map((s) => `- ${s.name}: ${clipToWidth(describe(s), each)}`).join("\n");
}

// ───────────────────────── 四、渲染：正文在到达模型之前被改写 ─────────────────────────

// 参数按 shell 的习惯切分：空白分隔，引号里的空白不算
export function splitArgs(text) {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 参数替换。分几遍，依次做（和原版一样，前一遍的结果会被后一遍再扫一次）：
//   $名字（frontmatter 的 arguments 声明）→ $ARGUMENTS[n] → $n（从 0 开始）→ $ARGUMENTS（整串）
// args 是 undefined 表示“没有传参数”，正文原样返回；传了空串也会把占位符替换成空。
// 正文里一个占位符都没有、而参数不为空时，把参数附在最后，免得参数丢掉。
export function substitute(content, args, names = []) {
  if (args === undefined || args === null) return content;
  const list = splitArgs(args);
  const passes = [
    ...names.map((name, i) => [new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, "g"), () => list[i] ?? ""]),
    [/\$ARGUMENTS\[(\d+)\]/g, (_, n) => list[Number(n)] ?? ""],
    [/\$(\d+)(?!\w)/g, (_, n) => list[Number(n)] ?? ""],
    [/\$ARGUMENTS/g, () => args], //                       函数形式的替换值：参数里的 $$、$& 不会被当成特殊写法
  ];
  let out = content;
  for (const [pattern, replacement] of passes) out = out.replace(pattern, replacement);
  return out === content && args ? `${content}\n\nARGUMENTS: ${args}` : out;
}

// 动态注入的两种写法。行内的 !`命令` 只在行首或空白之后才算：
// 前面是全角冒号、反引号、字母……都不触发，免得误伤 Markdown 里的普通行内代码。
const INLINE_SHELL = /(?<=^|\s)!`([^`]+)`/gm;
const BLOCK_SHELL = /```!\s*\n?([\s\S]*?)\n?```/g;

// 执行正文里的 !`命令`，用输出替换命令本身。任何一条不被允许、或者执行失败，整个渲染都失败：
// 带着半截结果继续，模型会以为 Skill 就是这个样子。
//   allow(command)  这一条命令被允许吗？是在“参数替换之后”问的，问的是最终要执行的那一串
//   run(command)    执行并返回输出
export async function injectShell(text, { allow, run }) {
  const matches = [...text.matchAll(BLOCK_SHELL), ...(text.includes("!`") ? text.matchAll(INLINE_SHELL) : [])];
  let out = text;
  for (const match of matches) {
    const command = match[1].trim();
    if (!command) continue;
    if (!(await allow(command))) throw Error(`shell command not allowed for pattern "${match[0]}": ${command}`);
    const output = await run(command);
    out = out.replace(match[0], () => output); // 函数形式：命令输出里的 $& 之类不能被当成替换写法
  }
  return out;
}

// 渲染一个 Skill：基准目录 → 参数 → ${CLAUDE_SKILL_DIR} → 动态注入。顺序和原版的 getPromptForCommand 一致。
export async function renderSkill(skill, args, { allow, run }) {
  let text = skill.dir ? `Base directory for this skill: ${skill.dir}\n\n${skill.body}` : skill.body;
  text = substitute(text, args, skill.argumentNames);
  if (skill.dir) text = text.replaceAll("${CLAUDE_SKILL_DIR}", () => skill.dir);
  return injectShell(text, { allow, run });
}

// ───────────────────────── 五、谁需要用户批准 ─────────────────────────

// 白名单：这些字段不会放大权限，Skill 带着它们也不必问。名单之外的字段只要有“有意义的值”就要问，
// 所以将来给 Skill 加了新字段（hooks、能改写权限的任何东西），默认就是要批准的，审查过再加进来。
// 原版的 SAFE_SKILL_PROPERTIES 是同一个思路（SkillTool.ts）；它的名单里有 context: fork，没有 allowedTools 和 hooks。
const SAFE_FIELDS = new Set([
  "name", "displayName", "description", "descriptionFrom", "whenToUse", "argumentHint", "argumentNames",
  "disableModelInvocation", "userInvocable", "fork", "agent", "model", "effort", "paths", "body", "path", "kind", "dir",
]);
const isEmpty = (v) => v == null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

export function needsApproval(skill) {
  return Object.entries(skill).some(([key, value]) => !SAFE_FIELDS.has(key) && !isEmpty(value));
}

// Skill(名字) 规则：精确匹配，或者 `前缀:*` 匹配所有以前缀开头的名字
function skillRuleMatches(content, name) {
  const rule = content.replace(/^\//, "");
  return rule === name || (rule.endsWith(":*") && name.startsWith(rule.slice(0, -2)));
}

// ───────────────────────── 六、Skills ─────────────────────────

// 只给了一个路径字符串时，按文件名猜它是目录形式的 Skill，还是旧式命令
const sourceOf = (path) =>
  /(^|[\\/])SKILL\.md$/i.test(path) ? { path, kind: "skill" } : { path, kind: "command", base: dirname(path) };

const stripSlash = (name) => String(name ?? "").trim().replace(/^\//, "");
const TRUNCATED = "\n\n[……压缩时被截断；需要全文，请重新调用这个 Skill]";

export class Skills {
  // paths：来源文件，相对 root；每项是字符串（路径），或 discoverSkillFiles 返回的 { path, kind, base }。顺序就是优先级。
  // options（都有安全的缺省值）：
  //   run(command, skill)         怎样执行动态注入的命令；缺省用 sh -c，在 Skill 所在目录
  //   mayRunShell(command, skill) 额外放行哪些命令；缺省只认 Skill 自己的 allowed-tools 里的 Bash(...) 规则
  //   fork({ skill, prompt, grants, signal })  context: fork 的 Skill 怎样在子 Agent 里运行；返回子 Agent 的最后一段话
  constructor(root, paths, options = {}) {
    this.root = root;
    this.options = options;
    this.entries = new Map(); //   名字 → 元数据（不含正文：正文要到调用时才读）
    this.shadowed = []; //          因为重名而被前面的盖掉的
    this.problems = []; //          读不出来的文件：一个坏文件不能拖垮其他 Skill
    this.grants = new Set(); //     调用过的 Skill 授予的工具规则
    this.invoked = new Map(); //    名字 → { text, at }：压缩之后要重新附上的
    this.announced = new Set(); //  已经告诉过模型的名字
    this.clock = 0;
    for (const source of paths.map((p) => (typeof p === "string" ? sourceOf(p) : p))) {
      try {
        const { body, ...meta } = readSkill(root, source);
        if (this.entries.has(meta.name)) this.shadowed.push({ name: meta.name, path: meta.path, by: this.entries.get(meta.name).path });
        else this.entries.set(meta.name, meta);
      } catch (error) {
        this.problems.push({ path: source.path, error: String(error.message ?? error) });
      }
    }
  }

  // 扫描项目约定的目录并创建 Skills
  static discover(root, dirs, options) {
    return new Skills(root, discoverSkillFiles(root, dirs), options);
  }

  // 按名字查找：身份或显示名对得上就算，先出现的先赢（commands.ts 的 findCommand）。开头的斜杠忽略。
  find(name) {
    const key = stripSlash(name);
    return [...this.entries.values()].find((s) => s.name === key || s.displayName === key);
  }

  // 所有 Skill 的“名片”：用户的 / 菜单用它。模型看到的是 listing()，那里要去掉 disable-model-invocation 的。
  descriptions() {
    return [...this.entries.values()].map(({ name, description }) => ({ name, description }));
  }

  // 读出完整的 Skill（含正文）。每次都重读文件。
  load(name) {
    const entry = this.find(name);
    if (!entry) throw Error(`unknown skill: ${stripSlash(name)}`);
    return { ...entry, ...readSkill(this.root, entry), name: entry.name };
  }

  // 模型能看到的那部分：去掉 disable-model-invocation，按预算排成目录
  visibleToModel() {
    return [...this.entries.values()].filter((s) => !s.disableModelInvocation);
  }

  listing({ contextWindow } = {}) {
    return formatListing(this.visibleToModel(), contextWindow);
  }

  // 目录是对话里的一条附件，不是系统提示的一部分，所以只发“没发过的”：
  // 第一次发全部，之后有新 Skill 才再发一条增量，没有新的就什么也不发。
  announce({ contextWindow } = {}) {
    const fresh = this.visibleToModel().filter((s) => !this.announced.has(s.name));
    for (const s of fresh) this.announced.add(s.name);
    return formatListing(fresh, contextWindow);
  }

  // 一条命令此刻允许执行吗？Skill 自己的 allowed-tools 里有匹配的 Bash(模式) 规则，或者宿主额外放行。
  // 含 ; & | 反引号、换行、$(…) 的命令其实是好几条命令拼在一起。原版会逐条拆开检查，coda 没有这个能力，
  // 所以这样的命令一律不按规则放行——否则 `Bash(echo *)` 会放过 `echo hi; rm -rf x`。
  #mayRunShell(skill) {
    return (command) => {
      const single = !/[;&|`\n]|\$\((?!\()/.test(command);
      const granted = single && skill.allowedTools.map(parseRule).some((r) => r.tool === "Bash" && r.content !== undefined && wildcardMatch(r.content, command));
      return granted || Boolean(this.options.mayRunShell?.(command, skill));
    };
  }

  #runShell(skill) {
    return async (command) => {
      if (this.options.run) return this.options.run(command, skill);
      const result = await runProcess("/bin/sh", ["-c", command], { cwd: skill.dir ?? this.root });
      if (result.code !== 0) throw Error(`shell command failed (exit ${result.code}): ${command}${(result.stderr || result.stdout).trim() ? `\n${(result.stderr || result.stdout).trim()}` : ""}`);
      return result.stdout.trim();
    };
  }

  // 两扇门（模型调用的 Skill 工具、用户输入的 /名字）共用的展开：
  // 渲染 → 记下“调用过” → 授权或者交给子 Agent。对应原版的 getMessagesForPromptSlashCommand 和 executeForkedSkill。
  async expand(name, args = "", { signal } = {}) {
    const skill = this.load(name);
    const text = await renderSkill(skill, args, { allow: this.#mayRunShell(skill), run: this.#runShell(skill) });
    this.invoked.set(skill.name, { text, at: ++this.clock });
    if (skill.fork) {
      // fork：正文只给子 Agent；授权只加给子 Agent（grants 交给 fork 回调，不记进自己）；父亲只收到结果
      if (!this.options.fork) throw Error(`skill ${skill.name} needs fork, but no fork runner was provided`);
      const result = await this.options.fork({ skill, prompt: text, grants: skill.allowedTools, signal });
      return { skill, forked: true, text: `Skill "${skill.name}" completed (forked execution).\n\nResult:\n${result}` };
    }
    for (const rule of skill.allowedTools) this.grants.add(rule);
    return { skill, forked: false, text };
  }

  // 用户输入的 /名字 参数。不是 Skill 就返回 undefined（宿主当普通输入处理）。
  // 用户亲自输入的命令本身就是授权，所以这一扇门不问权限；但 userInvocable: false 的只能由模型调用。
  async slash(input, options) {
    const match = input.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
    const skill = match && this.find(match[1]);
    if (!skill) return undefined;
    const label = `<command-name>/${skill.name}</command-name>`;
    if (!skill.userInvocable) return { skill, label, rejected: true, text: `Skill ${skill.name} can only be invoked by the model, not typed by the user.` };
    const { text, forked } = await this.expand(skill.name, match[2]?.trim() ?? "", options);
    return { skill, label, forked, text };
  }

  // 已经授予的工具规则（例如 "Bash(cat *)"）。宿主把它们并进权限规则的 allow 列表。
  grantedRules() {
    return [...this.grants];
  }

  // 一轮结束，授权随之失效
  resetGrants() {
    this.grants.clear();
  }

  // 压缩之后要重新附上的 Skill 正文：最近调用的优先，每个最多 perSkill 个 token，总共不超过 total。
  recall({ perSkill = 5_000, total = 25_000 } = {}) {
    const tokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);
    let used = 0;
    const parts = [];
    for (const [name, { text }] of [...this.invoked].sort((a, b) => b[1].at - a[1].at)) {
      const body = tokens(text) > perSkill ? text.slice(0, perSkill * CHARS_PER_TOKEN - TRUNCATED.length) + TRUNCATED : text;
      if (used + tokens(body) > total) continue; // 放不下的跳过，后面更小的还有机会
      used += tokens(body);
      parts.push(`### Skill: ${name}\n\n${body}`);
    }
    return parts.length ? `本会话里调用过下面这些 Skill，请继续遵守：\n\n${parts.join("\n\n---\n\n")}` : "";
  }

  // Skill 工具的定义，交给 Toolset。rules 是权限规则的“活”对象（读它的时候才取 allow / deny），
  // 这样 Skill(名字) 规则和 Skill 授予的规则能在运行中变化。
  tool({ rules = {} } = {}) {
    const matching = (list, name) =>
      (list ?? []).map(parseRule).find((r) => r.tool === "Skill" && r.content !== undefined && skillRuleMatches(r.content, name));
    return {
      name: "Skill",
      description: "Load a skill by name and follow its instructions. The available skills are announced separately.",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, args: { type: "string" } },
        required: ["name"],
      },
      // 校验先于一切：名字对不对、模型有没有资格调用。不通过的调用，权限和 Hook 都看不到
      validate: (input) => {
        const name = stripSlash(input.name);
        if (!name) throw Error(`Invalid skill format: ${input.name}`);
        if (input.args !== undefined && typeof input.args !== "string") throw Error("args must be a string");
        const skill = this.find(name);
        if (!skill) throw Error(`Unknown skill: ${name}`);
        if (skill.disableModelInvocation) throw Error(`Skill ${name} cannot be used with the Skill tool due to disable-model-invocation`);
      },
      // 权限：deny 规则 → allow 规则 → 不会放大权限的 Skill 直接放行 → 其余要问
      permission: (input) => {
        const skill = this.find(input.name);
        const name = skill?.name ?? stripSlash(input.name);
        const denied = matching(rules.deny, name);
        if (denied) return { behavior: "deny", source: "rule", rule: denied.text };
        const allowed = matching(rules.allow, name);
        if (allowed) return { behavior: "allow", source: "rule", rule: allowed.text };
        if (skill && !needsApproval(skill)) return { behavior: "allow", source: "skill" };
        return { behavior: "ask", source: "skill", reason: `Execute skill: ${name}` };
      },
      execute: async (input, context = {}) => {
        const { skill, forked, text } = await this.expand(input.name, input.args ?? "", { signal: context.signal });
        return { text, details: { skill: skill.name, allowedTools: skill.allowedTools, fork: forked } };
      },
    };
  }
}
