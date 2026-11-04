// 第 4 章：项目记忆（CLAUDE.md）。
//
// 对应 Claude Code 2.1.88 里的四处源码：
//   utils/claudemd.ts      getMemoryFiles / processMemoryFile：找到哪些文件、展开 @引用、防止循环；
//                          getClaudeMds：把它们拼成一段文字
//   utils/attachments.ts   getNestedMemoryAttachments：模型读到子目录里的文件时，才加载那里的说明
//   context.ts             getUserContext：整个会话只算一次，结果缓存起来
//   utils/api.ts           prependUserContext：每次请求前，把它放进第一条用户消息
//
// 一份说明文件要经过三步：
//   发现  discoverMemories   有哪些文件，按什么顺序（越靠后越接近模型，越“优先”）
//   展开  readMemoryTree     一份文件，加上它用 @路径 引用的文件，依次排好
//   注入  contextMessage     变成请求里的第一条用户消息
// 子目录里的说明不在这条路上：模型每 Read 一个文件，NestedMemory 就检查一次它所在的目录。
//
// 和原版相比的简化：
//   · 向上找文件只走到 root，不一直走到文件系统根目录：实验不会读到你机器上真实的 CLAUDE.md；
//   · 不用 Markdown 词法分析器，自己处理围栏代码块、行内代码和 HTML 注释（labs 里用原函数逐项对照过）；
//   · 没有 claudeMdExcludes、--add-dir、团队记忆，也不处理 git worktree 里同一份文件出现两次；
//   · 指向 root 之外的 @引用（外部引用）默认不读。原版是弹窗让用户批准，这里用 includeExternal 表示“已批准”；
//   · 符号链接指向 root 之外，也算外部引用。原版的判断只比较路径字符串，不看符号链接指向哪里；
//   · 文件类型白名单只列了常见的扩展名；.claude/rules 里的文件按名字排序（原版用 readdir 的顺序）。
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

// 一条 @引用链最多这么多个文件：入口是第 0 层，第 5 层起不再读（与原版相同）。
export const MAX_INCLUDE_DEPTH = 5;
// MEMORY.md（模型写给自己的索引）的上限：行数和字符数，先到先截。
export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_CHARS = 25_000;
// @引用只读文本文件，免得把图片、PDF 塞进上下文。没有扩展名的文件放行。
export const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".go", ".rs", ".sh", ".css", ".html", ".sql",
]);

const MEMORY_TYPES = {
  Managed: "instructions set by the organization",
  User: "the user's own instructions, applied to every project",
  Project: "instructions checked into this project",
  Local: "the user's private notes for this project, not checked in",
  AutoMem: "notes the assistant saved in earlier sessions",
};

// ───────────────────────── 一、把一份文件读成 MemoryFile ─────────────────────────
// 对应 parseMemoryFileContent。读出来的东西叫 MemoryFile：
//   { file, path, type, parent, text, globs, differsFromDisk, raw }
//   file 是绝对路径，path 是给人看的路径（在 root 里就用相对路径）；
//   text 是将要交给模型的内容，raw 是磁盘上的原样（两者不同才会有 raw）。

// 围栏代码块里的内容不是 Markdown：@引用和注释都不能碰。先把文本切成“代码”和“其他”两种片段。
function splitFences(text) {
  const segments = [];
  let current = { code: false, text: "" };
  let fence; // 正在围栏里：记下开头用的是 ``` 还是 ~~~
  const flush = () => current.text && segments.push(current);
  for (const line of text.split(/(?<=\n)/)) {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (!fence && mark) {
      flush();
      current = { code: true, text: line };
      fence = mark[0];
    } else if (fence && mark?.[0] === fence) {
      current.text += line;
      flush();
      current = { code: false, text: "" };
      fence = undefined;
    } else {
      current.text += line;
    }
  }
  flush();
  return segments;
}

// 去掉“单独占行”的 HTML 注释：这是写给维护者的备注，不该占模型的上下文。
// 行内的注释、代码块里的注释都保留；没有闭合的注释也保留，免得一个手误吞掉后面整个文件。
// 注释后面同一行的文字保留（<!-- 备注 --> 用 bun 之后还剩“ 用 bun”）。
export function stripHtmlComments(text) {
  if (!text.includes("<!--")) return text;
  return splitFences(text)
    .map((part) =>
      part.code
        ? part.text
        : part.text.replace(/^ {0,3}<!--[\s\S]*?-->[^\n]*(?:\n+|$)/gm, (block) => {
            const rest = block.replace(/<!--[\s\S]*?-->/g, "");
            return rest.trim() ? rest : "";
          }),
    )
    .join("");
}

// 文件开头的 --- ... --- 是 frontmatter。coda 只认其中的 paths：这条规则只对哪些路径生效。
function splitFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { body: raw, paths: undefined };
  const lines = match[1].split(/\r?\n/);
  const at = lines.findIndex((line) => /^paths\s*:/.test(line));
  if (at < 0) return { body: raw.slice(match[0].length), paths: undefined };
  const values = [...splitTopLevel(lines[at].replace(/^paths\s*:/, ""))];
  for (const line of lines.slice(at + 1)) {
    const item = line.match(/^\s+-\s*(.+?)\s*$/);
    if (!item) break;
    values.push(...splitTopLevel(item[1]));
  }
  // "src/api/**" 和 "src/api" 对目录的效果相同，统一去掉结尾的 /**；
  // 全是 ** 就等于没写 paths（对所有文件生效）。
  const globs = values
    .map((v) => v.replace(/^["']|["']$/g, "").replace(/\/\*\*$/, ""))
    .filter(Boolean);
  const everything = globs.every((g) => g === "**");
  return { body: raw.slice(match[0].length), paths: everything ? undefined : globs };
}

// 按逗号拆开，但大括号里的逗号不算：src/*.{ts,tsx} 是一个模式。
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

// @后面跟的得像一个路径：./x、~/x、/x，或者以字母数字开头的裸路径（docs/a.md）。
// 邮箱 me@example.com 里的 @ 前面不是空白，根本不会走到这里。
function looksLikePath(text) {
  if (text === "/") return false;
  return /^(\.\/|~\/|\/)/.test(text) || /^[A-Za-z0-9._-]/.test(text);
}

// 从正文里找 @路径，返回绝对路径。只认“正文”：代码块、行内代码、HTML 注释里的 @ 都不算。
// 路径相对于“引用它的那个文件所在的目录”；#片段会被去掉；空格要写成 "\ "。
export function extractIncludes(text, fromFile, home = homedir()) {
  const prose = splitFences(text)
    .filter((part) => !part.code)
    .map((part) => part.text)
    .join("")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`[^`\n]*`/g, "");
  const found = new Set();
  for (const match of prose.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
    const path = match[1].split("#")[0].replace(/\\ /g, " ");
    if (!path || !looksLikePath(path)) continue;
    if (path.startsWith("~/")) found.add(join(home, path.slice(2)));
    else found.add(isAbsolute(path) ? normalize(path) : resolve(dirname(fromFile), path));
  }
  return [...found];
}

// MEMORY.md 太长就截断：先按行数，再按字符数（在最后一个换行处切），并附一句说明。
export function truncateIndex(raw) {
  const text = raw.trim();
  const lines = text.split("\n");
  const tooManyLines = lines.length > MAX_INDEX_LINES;
  const tooLong = text.length > MAX_INDEX_CHARS;
  if (!tooManyLines && !tooLong) return { text, truncated: false };
  let kept = tooManyLines ? lines.slice(0, MAX_INDEX_LINES).join("\n") : text;
  if (kept.length > MAX_INDEX_CHARS) {
    const cut = kept.lastIndexOf("\n", MAX_INDEX_CHARS);
    kept = kept.slice(0, cut > 0 ? cut : MAX_INDEX_CHARS);
  }
  const why = tooManyLines ? `${lines.length} lines, limit ${MAX_INDEX_LINES}` : `${text.length} characters, limit ${MAX_INDEX_CHARS}`;
  return { text: `${kept}\n\n> WARNING: MEMORY.md was cut (${why}). Only the start was loaded; keep one line per entry.`, truncated: true };
}

// 返回 { info, includes }：info 为 null 表示这个文件不用（不是文本文件）。
// 注意正文里的 @路径 原样保留，被引用的文件是另外一条记录，不是把内容贴进来。
export function parseMemoryFile(raw, file, type, { withIncludes = true, home, base = file } = {}) {
  const ext = extname(file).toLowerCase();
  if (ext && !TEXT_EXTENSIONS.has(ext)) return { info: null, includes: [] };
  const { body, paths } = splitFrontmatter(raw);
  let text = stripHtmlComments(body);
  if (type === "AutoMem") text = truncateIndex(text).text;
  const differsFromDisk = text !== raw;
  return {
    info: { file, type, text, globs: paths, differsFromDisk, raw: differsFromDisk ? raw : undefined },
    includes: withIncludes ? extractIncludes(body, base, home) : [],
  };
}

// ───────────────────────── 二、展开 @引用 ─────────────────────────

// 一次发现过程里共用的状态。seen 是整个过程共用的一个集合：同一个文件不管从几条路径到达，只读一次。
function newContext(root, options = {}) {
  return {
    root: resolve(root),
    seen: new Set(),
    includeExternal: options.includeExternal ?? false,
    maxDepth: options.maxDepth ?? MAX_INCLUDE_DEPTH,
    home: options.home ?? homedir(),
  };
}

const isInside = (path, dir) => {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
};
const realOrSelf = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const show = (ctx, file) => (isInside(file, ctx.root) ? relative(ctx.root, file) || "." : file);

// 指向 root 之外就是外部引用。路径字符串和符号链接指向的真实位置，有一个在外面就算。
function isExternal(ctx, file) {
  return !isInside(file, ctx.root) || !isInside(realOrSelf(file), realOrSelf(ctx.root));
}

// 对应 processMemoryFile：读一份文件，再依次读它引用的文件。
// 返回数组：父文件在前，它引用的文件紧跟在后面（深度优先）。
// 这里每一行 if 都在防一种失控：
//   · seen 命中：已经读过（环、重复引用，或者符号链接指向读过的文件）；
//   · depth 到顶：一条没有环、但特别长的引用链；
//   · 内容为空：不存在、读不了、不是文本、或者去掉注释后什么都不剩的文件，连带它的引用一起忽略；
//   · 外部引用：项目里的文件不能悄悄把 root 之外的东西拉进上下文。
export function readMemoryTree(file, type, ctx, depth = 0, parent) {
  const key = normalize(file);
  if (ctx.seen.has(key) || depth >= ctx.maxDepth) return [];
  const real = realOrSelf(file);
  ctx.seen.add(key);
  ctx.seen.add(real); // 符号链接的两个名字都记下，别名不会让同一份内容注入两遍

  let raw;
  try {
    raw = readFileSync(real, "utf8");
  } catch {
    return []; // 不存在（ENOENT）、是目录（EISDIR）、没有权限……都当作没有这个文件
  }
  // 扩展名看原来的名字；@引用相对于“真实位置”所在的目录（符号链接指到别处，引用就跟着走）
  const { info, includes } = parseMemoryFile(raw, key, type, { home: ctx.home, base: real });
  if (!info || !info.text.trim()) return [];

  const found = [{ ...info, file: key, path: show(ctx, key), parent: parent && show(ctx, parent) }];
  for (const target of includes) {
    if (isExternal(ctx, target) && !ctx.includeExternal) continue;
    found.push(...readMemoryTree(target, type, ctx, depth + 1, key));
  }
  return found;
}

// .claude/rules 目录：里面的 .md 文件都是规则，子目录递归。
// 没有 paths 的规则（conditional=false）会话开始就加载；带 paths 的要等模型读到匹配的文件才加载。
function readRules(dir, type, ctx, conditional, visited = new Set()) {
  const real = realOrSelf(dir);
  if (visited.has(real) || !existsSync(real)) return [];
  visited.add(real);
  const found = [];
  let entries;
  try {
    entries = readdirSync(real, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return []; // 不是目录，或者没有权限
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    let stat;
    try {
      stat = statSync(path); // 跟随符号链接
    } catch {
      continue;
    }
    if (stat.isDirectory()) found.push(...readRules(path, type, ctx, conditional, visited));
    else if (stat.isFile() && entry.name.endsWith(".md")) {
      // 注意：每个文件都读了（也记进 seen），只是返回时按有没有 paths 挑一半
      found.push(...readMemoryTree(path, type, ctx).filter((f) => (conditional ? f.globs : !f.globs)));
    }
  }
  return found;
}

// ───────────────────────── 三、发现：有哪些文件，什么顺序 ─────────────────────────

// 对应 getMemoryFiles。顺序就是优先级：越靠后的越接近模型，越“优先”。
//   1. 托管（组织统一下发）  2. 用户级  3. 从 root 往下走到 cwd，每一层依次是
//      CLAUDE.md、.claude/CLAUDE.md、.claude/rules/*.md（无 paths 的）、CLAUDE.local.md
//   4. 自动记忆 MEMORY.md（模型自己写的索引）
// 所以离 cwd 越近、越私人的文件越靠后；同一层里 Local 排在 Project 后面。
export function discoverMemories({ cwd, root = cwd, userDir, managedDir, autoMemory, includeExternal = false, home, maxDepth }) {
  const ctx = newContext(root, { includeExternal, home, maxDepth });
  if (!isInside(resolve(cwd), ctx.root)) throw Error(`cwd ${cwd} is outside root`);
  const files = [];

  if (managedDir) {
    files.push(...readMemoryTree(join(managedDir, "CLAUDE.md"), "Managed", ctx));
    files.push(...readRules(join(managedDir, ".claude", "rules"), "Managed", ctx, false));
  }
  if (userDir) {
    // 用户自己的文件可以引用任何地方：它是用户写的，不是仓库里别人写的
    const userCtx = { ...ctx, includeExternal: true };
    files.push(...readMemoryTree(join(userDir, "CLAUDE.md"), "User", userCtx));
    files.push(...readRules(join(userDir, "rules"), "User", userCtx, false));
  }

  // 从 cwd 往上收集目录，再反过来：根在前，cwd 在后
  const here = resolve(cwd);
  const dirs = [];
  for (let dir = here; isInside(dir, ctx.root); dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === ctx.root || dirname(dir) === dir) break;
  }
  for (const dir of dirs.reverse()) {
    files.push(...readMemoryTree(join(dir, "CLAUDE.md"), "Project", ctx));
    files.push(...readMemoryTree(join(dir, ".claude", "CLAUDE.md"), "Project", ctx));
    files.push(...readRules(join(dir, ".claude", "rules"), "Project", ctx, false));
    files.push(...readMemoryTree(join(dir, "CLAUDE.local.md"), "Local", ctx));
  }

  if (autoMemory && existsSync(autoMemory) && !ctx.seen.has(normalize(autoMemory))) {
    ctx.seen.add(normalize(autoMemory));
    // MEMORY.md 不展开 @引用：它是模型写的索引，不是人写的指令
    const { info } = parseMemoryFile(readFileSync(autoMemory, "utf8"), autoMemory, "AutoMem", { withIncludes: false });
    if (info?.text.trim()) files.push({ ...info, file: normalize(autoMemory), path: show(ctx, autoMemory) });
  }
  return files;
}

// 只读一个入口文件和它引用的文件（第 4 章最早的接口，app.mjs 在用）。
// type: "AutoMem" 且 skipIndex: true 的组合用来演示“找到了，但这次不注入”。
export function loadMemories(root, entry = "CLAUDE.md", { maxDepth = MAX_INCLUDE_DEPTH, type = "Project", skipIndex = false, includeExternal = false } = {}) {
  const ctx = newContext(root, { maxDepth, includeExternal });
  const file = resolve(ctx.root, entry);
  if (!isInside(file, ctx.root)) throw Error(`entry ${entry} is outside root`);
  return filterInjected(readMemoryTree(file, type, ctx), { skipIndex });
}

// ───────────────────────── 四、注入：变成请求里的一条消息 ─────────────────────────

// 对应 filterInjectedMemoryFiles：找到了，不等于注入。
// 原版里这是一个服务端灰度开关：开着的时候，MEMORY.md 索引不再整份放进上下文，改成按需检索相关的记忆。
export function filterInjected(files, { skipIndex = false } = {}) {
  return files.filter((f) => f.text.trim() && !(skipIndex && f.type === "AutoMem"));
}

// 对应 getClaudeMds 里每个文件那一段：标题行写明路径和来源类型，空一行，再是正文。
const entryText = (f) => `Contents of ${f.path} (${MEMORY_TYPES[f.type]}):\n\n${f.text.trim()}`;

// 兼容旧接口：每个文件一个字符串。app.mjs 把它们放进 system 数组。
export function memoryPrompt(files) {
  return files.map(entryText);
}

// 对应 getClaudeMds：全部文件拼成一段，前面一句总的提醒。没有文件就是空字符串。
export function formatMemories(files) {
  if (!files.length) return "";
  const intro = "The files below hold instructions from the user and from this project. Follow them over your defaults.";
  return `${intro}\n\n${files.map(entryText).join("\n\n")}`;
}

// 对应 getUserContext + prependUserContext：说明文件（和日期）放进第一条用户消息，
// 用 <system-reminder> 包起来，标成 meta（给模型看，不是用户说的话）。
// 没有任何内容就不生成消息。注意它不在历史里：每次请求前现拼一份放在最前面。
export function contextMessage(files, { date } = {}) {
  const context = [];
  const claudeMd = formatMemories(files);
  if (claudeMd) context.push(["claudeMd", claudeMd]);
  if (date) context.push(["currentDate", `Today's date is ${date}.`]);
  if (!context.length) return undefined;
  const body = context.map(([key, value]) => `# ${key}\n${value}`).join("\n");
  const note = "This context comes with the session. Use it when it helps with the request; it may not matter for every task.";
  return { role: "user", meta: true, text: `<system-reminder>\n${note}\n${body}\n</system-reminder>` };
}

// 对应 getUserContext 的 memoize：一个会话只读一次磁盘。
// 会话中途改了 CLAUDE.md，要等 clear()（压缩或 /clear 之后）才会读到新内容。
export function sessionMemory(options) {
  let cached;
  return {
    get: () => (cached ??= discoverMemories(options)),
    clear: () => {
      cached = undefined;
    },
  };
}

// ───────────────────────── 五、按需加载：读到哪里，加载哪里的说明 ─────────────────────────

// 带 paths 的规则用 gitignore 的写法：不含 / 的模式匹配任意层级的名字（*.ts），
// 含 / 的从目录开头算起（src/api）；匹配到一个目录，目录里的文件也算匹配。
function globToRegExp(glob) {
  let source = "";
  let braces = 0; // 在不在 {a,b} 里面：里面的逗号是“或”
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "{") {
      braces++;
      source += "(?:";
    } else if (ch === "}" && braces) {
      braces--;
      source += ")";
    } else if (ch === "," && braces) source += "|";
    else source += ch.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesGlobs(globs, relPath) {
  const parts = relPath.split("/");
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join("/")); // src、src/api、src/api/a.js
  return globs.some((glob) => {
    const re = globToRegExp(glob.replace(/^\//, ""));
    const anchored = glob.includes("/");
    return anchored ? prefixes.some((p) => re.test(p)) : parts.some((p) => re.test(p));
  });
}

// 对应 getDirectoriesToProcess：模型读了 file，要检查哪些目录？
//   nested     cwd 之下、到 file 所在目录为止的每一层（不含 cwd）：这里的 CLAUDE.md 和全部规则都可能是新的
//   ancestors  root 到 cwd 的每一层：会话开始时已经加载过它们的 CLAUDE.md，只需要再看带 paths 的规则
export function directoriesFor(file, cwd, root = cwd) {
  const nested = [];
  for (let dir = dirname(resolve(file)); dir !== cwd && dir !== dirname(dir); dir = dirname(dir)) {
    if (isInside(dir, cwd)) nested.push(dir);
  }
  const ancestors = [];
  for (let dir = cwd; isInside(dir, root); dir = dirname(dir)) {
    ancestors.push(dir);
    if (dir === root || dirname(dir) === dir) break;
  }
  return { nested: nested.reverse(), ancestors: ancestors.reverse() };
}

// 用法：Read 工具每读完一个文件，调用 noteRead(路径)；在下一次请求之前调用 collect()，
// 得到该追加到对话里的消息（排在工具结果后面，不改动开头的内容，缓存不受影响）。
export class NestedMemory {
  constructor({ cwd, root = cwd, userDir, managedDir, home }) {
    Object.assign(this, { cwd: resolve(cwd), root: resolve(root), userDir, managedDir, home });
    this.triggers = new Set(); // 对应 nestedMemoryAttachmentTriggers：这一轮读过哪些文件
    this.loaded = new Set(); //  对应 loadedNestedMemoryPaths：已经附上过的说明，不重复附
  }

  noteRead(file) {
    this.triggers.add(resolve(this.cwd, file));
  }

  // 压缩把历史换成了摘要，之前附上的说明也一起没了：下次读到相关文件，要重新附上。
  reset() {
    this.loaded.clear();
  }

  // 返回 [{ role, meta, text, file, reason, trigger, memory }]。
  // reason 的取值和 InstructionsLoaded 钩子的 load_reason 一致；memory 是读出来的 MemoryFile。
  collect() {
    const messages = [];
    for (const target of this.triggers) {
      if (!isInside(target, this.cwd)) continue; // 工作目录之外的文件不触发
      for (const f of this.#filesFor(target)) {
        if (this.loaded.has(f.file)) continue;
        this.loaded.add(f.file);
        const reason = f.globs ? "path_glob_match" : f.parent ? "include" : "nested_traversal";
        const text = `<system-reminder>\nContents of ${f.file}:\n\n${f.text}\n</system-reminder>`;
        messages.push({ role: "user", meta: true, text, file: f.file, reason, trigger: target, memory: f });
      }
    }
    this.triggers.clear();
    return messages;
  }

  // 一个文件触发时，按固定顺序找出所有相关的说明（对应 getNestedMemoryAttachmentsForFile 的四个阶段）。
  #filesFor(target) {
    const ctx = newContext(this.root, { home: this.home }); // 每次触发一个新的 seen；按需加载不允许外部引用
    const { nested, ancestors } = directoriesFor(target, this.cwd, this.root);
    const found = [];

    // 阶段一：托管和用户级的规则，只看带 paths 的，模式相对 cwd
    for (const [dir, type, base] of [
      [this.managedDir && join(this.managedDir, ".claude", "rules"), "Managed", this.cwd],
      [this.userDir && join(this.userDir, "rules"), "User", this.cwd],
    ]) {
      if (dir) found.push(...this.#matching(readRules(dir, type, ctx, true), base, target));
    }
    // 阶段二：cwd 到目标所在目录之间的每一层，从浅到深：CLAUDE.md、Local、无条件规则、匹配的条件规则
    for (const dir of nested) {
      found.push(...readMemoryTree(join(dir, "CLAUDE.md"), "Project", ctx));
      found.push(...readMemoryTree(join(dir, ".claude", "CLAUDE.md"), "Project", ctx));
      found.push(...readMemoryTree(join(dir, "CLAUDE.local.md"), "Local", ctx));
      const rules = join(dir, ".claude", "rules");
      found.push(...readRules(rules, "Project", { ...ctx, seen: new Set(ctx.seen) }, false));
      found.push(...this.#matching(readRules(rules, "Project", ctx, true), dir, target));
    }
    // 阶段三：root 到 cwd 的每一层：它们的 CLAUDE.md 开头已经加载，这里只补带 paths 的规则
    for (const dir of ancestors) {
      found.push(...this.#matching(readRules(join(dir, ".claude", "rules"), "Project", ctx, true), dir, target));
    }
    return found;
  }

  // 条件规则的模式相对“放 .claude 的那个目录”（托管和用户级的相对 cwd）
  #matching(rules, baseDir, target) {
    const rel = relative(baseDir, target);
    if (!rel || rel.startsWith("..")) return [];
    return rules.filter((rule) => matchesGlobs(rule.globs, rel.split(sep).join("/")));
  }
}
