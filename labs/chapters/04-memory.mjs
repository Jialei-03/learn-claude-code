// 第 4 章实验：项目记忆。九个小实验，各回答一个问题：
//   discover   哪些文件会被找到，按什么顺序？和真实 Claude Code 录下的顺序一样吗？
//   syntax     正文里的哪些 @写法 会被当成引用？（运行 Claude Code 里真正的 extractIncludePathsFromTokens）
//   include    引用怎样展开、怎样防循环、怎样防失控？（运行真正的 processMemoryFile，再做 400 张随机图的对照）
//   inject     找到的文件怎样拼成文字、包成一条消息？（运行真正的 getClaudeMds 和 prependUserContext）
//   placement  放在系统提示里和放在第一条消息里，改一行 CLAUDE.md 的代价有什么不同？会话中途改了文件会怎样？
//   triggers   子目录里的说明由谁触发加载？（在固定提交的源码里搜）
//   nested     子目录和带 paths 的规则，什么时候才被加载？和真实录制对照；压缩之后呢？
//   attach     按需加载的文件怎样去重，怎样记进 readFileState？（运行真正的 memoryFilesToAttachments）
//   auto       模型写给自己的 MEMORY.md，怎样进入下一个会话？太长怎么办？
//
//   node --disable-warning=ExperimentalWarning labs/chapters/04-memory.mjs            全部运行
//   node --disable-warning=ExperimentalWarning labs/chapters/04-memory.mjs include    只运行一个
import { lesson, ROOT } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize, parse, relative, resolve } from "node:path";
import { Lexer } from "marked";
import {
  MAX_INCLUDE_DEPTH,
  NestedMemory,
  TEXT_EXTENSIONS,
  contextMessage,
  directoriesFor,
  discoverMemories,
  extractIncludes,
  filterInjected,
  formatMemories,
  loadMemories,
  memoryPrompt,
  readMemoryTree,
  sessionMemory,
  truncateIndex,
} from "../../coda/src/memory.mjs";
import { Engine, scripted } from "../../coda/src/engine.mjs";
import { codingTools } from "../../coda/src/files.mjs";
import { Toolset } from "../../coda/src/tools.mjs";
import { buildRequest } from "../../coda/src/request.mjs";
import { upstream } from "../engineering/run.mjs";
import { SOURCE_DIR } from "../../lab/sourcemap.ts";
import { CC_SOURCE } from "../../course/syllabus.ts";

const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const wants = (name) => !only || only === name;

// 下面所有“原函数”都是从固定提交里装载出来的，没有改动；只替换它依赖的外部东西（端口）。
// 装载要读一次 git，所以只在用到的实验里才做。
const expandPath = (path, base) =>
  path.startsWith("~/") ? join(homedir(), path.slice(2)) : isAbsolute(path) ? normalize(path) : resolve(base, path);
let extractTokens;
const original = (text, from) => {
  extractTokens ??= upstream("memory-include-paths", "extractIncludePathsFromTokens", { expandPath, dirname });
  return extractTokens(new Lexer({ gfm: false }).lex(text), from);
};

// 装载真正的 processMemoryFile（以及它用的 parseMemoryFileContent、stripHtmlCommentsFromTokens）。
// 端口只有：文件系统、扩展名白名单、frontmatter（这些实验的文件都没有）、以及“是不是在项目目录里”的字符串判断。
const originalTree = (root) => {
  original("", "/"); // 保证 extractTokens 已装载
  const stripHtmlCommentsFromTokens = upstream("memory-strip-comments", "stripHtmlCommentsFromTokens", {});
  const parseMemoryFileContent = upstream("memory-parse", "parseMemoryFileContent", {
    extname,
    TEXT_FILE_EXTENSIONS: TEXT_EXTENSIONS,
    logForDebugging() {},
    parseFrontmatterPaths: (raw) => ({ content: raw }),
    Lexer,
    stripHtmlCommentsFromTokens,
    extractIncludePathsFromTokens: extractTokens,
    truncateEntrypointContent: (raw) => ({ content: raw }),
  });
  const processMemoryFile = upstream("memory-include", "processMemoryFile", {
    normalizePathForComparison: normalize,
    MAX_INCLUDE_DEPTH,
    isClaudeMdExcluded: () => false,
    safeResolvePath: (_fs, path) => {
      try {
        const real = realpathSync(path);
        return { resolvedPath: real, isSymlink: real !== path };
      } catch {
        return { resolvedPath: path, isSymlink: false };
      }
    },
    getFsImplementation: () => ({}),
    safelyReadMemoryFileAsync: async (file, type, includeBase) => {
      try {
        return parseMemoryFileContent(await readFile(file, "utf8"), file, type, includeBase);
      } catch {
        return { info: null, includePaths: [] };
      }
    },
    // 原版的 pathInOriginalCwd 只比较路径字符串，不看符号链接；这里照样写
    pathInOriginalCwd: (path) => {
      const rel = relative(root, path);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    },
  });
  return async (entry, includeExternal = false, seen = new Set()) =>
    JSON.parse(JSON.stringify(await processMemoryFile(entry, "Project", seen, includeExternal))).map((f) => ({
      path: relative(root, f.path),
      parent: f.parent && relative(root, f.parent),
    }));
};

// 在 dir 下按 { 相对路径: 内容 } 建立文件
function put(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

await lesson(4, "项目记忆：发现、展开、注入与按需加载", async (t) => {
  // 实验里的路径都在随机的临时目录下；打印时换成固定的名字，输出才好读
  const scrub = (text) => String(text).replaceAll(t.temp, "<tmp>");

  // ───────────────────────── 一、发现 ─────────────────────────
  if (wants("discover")) {
    t.log("一、哪些文件会被找到，按什么顺序");
    t.log();

    // 先对照真实录制。文件布局与 labs/ch04/record.ts 完全相同：
    // 那次录制用 Claude Code 2.1.296 跑了一遍，会话文件里的 instructions 附件记着它加载了哪些文件、什么顺序。
    const project = join(t.root, "recorded", "project");
    const config = join(t.root, "recorded", "config");
    put(project, {
      "CLAUDE.md": "# 项目说明\nCANARY-PROJECT-CLAUDEMD：提交说明用中文写。\n<!-- CANARY-IN-HTML-COMMENT：这是给维护者的备注 -->\n@docs/conventions.md\n",
      "docs/conventions.md": "CANARY-IMPORTED：函数名用驼峰。\n",
      "CLAUDE.local.md": "CANARY-LOCAL-MD：我本机的数据库在 5433 端口。\n",
      "AGENTS.md": "CANARY-AGENTS-MD：这是给其他 Agent 的说明。\n",
    });
    put(config, { "CLAUDE.md": "CANARY-USER-CLAUDEMD：回答尽量简短。\n" });

    const recording = JSON.parse(readFileSync(join(ROOT, "labs/ch04/recorded/instructions.json"), "utf8"));
    const attachments = recording.transcripts[0].entries.filter((e) => e.type === "attachment").map((e) => e.attachment);
    const recorded = attachments.find((a) => a.type === "instructions").files;
    const name = (path) => path.replace("<project>/", "").replace("<config>/", "~/.claude/");

    const mine = discoverMemories({ cwd: project, userDir: config });
    const mineName = (f) => (f.file.startsWith(config) ? `~/.claude/${relative(config, f.file)}` : f.path);
    t.table(
      recorded.map((r, i) => ({
        序: i + 1,
        "Claude Code 2.1.296（会话文件）": `${r.type}　${name(r.path)}`,
        "coda discoverMemories": mine[i] ? `${mine[i].type}　${mineName(mine[i])}` : "—",
        正文是否一致: mine[i] && mine[i].text.trim() === r.content ? "一致" : "不同",
      })),
    );
    t.log("AGENTS.md 两边都没有读；CLAUDE.md 里的 HTML 注释在两边都被删掉了。");
    t.log();
    t.equal(
      "coda 找到的文件、类型、顺序与真实录制一致",
      mine.map((f) => `${f.type} ${mineName(f)}`),
      recorded.map((r) => `${r.type} ${name(r.path)}`),
    );
    t.equal(
      "每份文件交给模型的正文与录制逐字一致（含删注释、保留 @ 行）",
      mine.map((f) => f.text.trim()),
      recorded.map((r) => r.content),
    );

    // 再看一个更大的仓库：从仓库根往下走到当前目录，每一层都有自己的文件。
    // 目录按真实机器上的样子摆：/etc/claude-code 是托管目录，~ 是用户主目录。
    const machine = join(t.root, "big");
    const repo = join(machine, "me", "repo");
    const cwd = join(repo, "packages", "app");
    put(machine, {
      "etc/claude-code/CLAUDE.md": "组织规定：提交前必须经过评审。",
      "me/.claude/CLAUDE.md": "我的偏好：回答用中文。",
      "me/.claude/rules/style.md": "我的规则：函数不超过 40 行。",
      "me/repo/CLAUDE.md": "仓库约定：用 pnpm。",
      "me/repo/CLAUDE.local.md": "我在这个仓库的私人备注：数据库在 5433 端口。",
      "me/repo/.claude/rules/testing.md": "规则：改完要运行测试。",
      "me/repo/.claude/rules/api.md": "---\npaths:\n  - src/api/**\n---\n规则：处理函数必须校验输入。",
      "me/repo/packages/CLAUDE.md": "packages 约定：每个包自己带测试。",
      "me/repo/packages/app/CLAUDE.md": "app 约定：界面文案放在 locales/。",
      "me/repo/packages/app/.claude/CLAUDE.md": "app 的第二份说明（.claude 目录里）。",
      "me/repo/packages/app/CLAUDE.local.md": "我在 app 里的私人备注。",
      "me/repo/packages/app/src/CLAUDE.md": "src 约定：不写分号。",
      "me/.claude/projects/repo/memory/MEMORY.md": "- [测试命令](test.md) — 用 pnpm test:unit",
    });
    const files = discoverMemories({
      cwd,
      root: repo,
      userDir: join(machine, "me", ".claude"),
      managedDir: join(machine, "etc", "claude-code"),
      autoMemory: join(machine, "me", ".claude", "projects", "repo", "memory", "MEMORY.md"),
    });
    const place = (f) => f.file.replace(join(machine, "etc"), "/etc").replace(join(machine, "me"), "~");
    const why = {
      "/etc/claude-code/CLAUDE.md": "最先：组织统一下发的规定",
      "~/.claude/CLAUDE.md": "然后是用户级：对所有项目生效",
      "~/.claude/rules/style.md": "用户级的规则目录紧跟其后",
      "~/repo/CLAUDE.md": "从仓库根开始往下走：根最靠前",
      "~/repo/.claude/rules/testing.md": "同一层里，规则目录排在 CLAUDE.md 之后",
      "~/repo/CLAUDE.local.md": "私人备注排在这一层的最后，所以比同层的项目说明更“近”",
      "~/repo/packages/CLAUDE.md": "往下一层",
      "~/repo/packages/app/CLAUDE.md": "cwd 这一层：最具体",
      "~/repo/packages/app/.claude/CLAUDE.md": "同一层的第二个位置",
      "~/repo/packages/app/CLAUDE.local.md": "cwd 这一层的私人备注",
      "~/.claude/projects/repo/memory/MEMORY.md": "最后：模型自己写的索引",
    };
    t.table(files.map((f, i) => ({ 序: i + 1, 类型: f.type, 文件: place(f), 位置的原因: why[place(f)] ?? "" })));
    t.log("没有出现的两份：~/repo/.claude/rules/api.md（带 paths，要等模型读到 src/api 下的文件）、");
    t.log("~/repo/packages/app/src/CLAUDE.md（在 cwd 之下，要等模型读到 src 下的文件）。它们怎么加载，后面的实验再看。");
    t.log();
    t.equal(
      "顺序：托管 → 用户 → 根到 cwd 逐层（CLAUDE.md、规则、Local）→ 自动记忆",
      files.map(place),
      Object.keys(why),
    );
    t.ok("带 paths 的规则和 cwd 之下的 CLAUDE.md 开头不加载", !files.some((f) => f.globs || place(f).endsWith("src/CLAUDE.md")));
  }

  // ───────────────────────── 二、@引用的写法 ─────────────────────────
  if (wants("syntax")) {
    t.log("二、哪些 @写法 会被当成引用");
    t.log();

    // 十几种写法：哪些会被当成引用？
    const base = join(t.root, "proj", "CLAUDE.md");
    const shorten = (path) => path.replace(dirname(base) + "/", "").replace(homedir(), "~");
    const samples = [
      ["普通引用", "@docs/a.md"],
      ["句子中间", "详见 @docs/a.md 的说明"],
      ["带 #片段", "@docs/a.md#install"],
      ["裸路径", "@README.md"],
      ["相对路径 ./", "@./b.md"],
      ["用户主目录", "@~/notes.md"],
      ["绝对路径", "@/etc/hosts"],
      ["列表里", "- @docs/a.md\n- @docs/b.md"],
      ["引用块里", "> @docs/q.md"],
      ["空格要转义", "@my\\ notes.md"],
      ["行内代码里", "`@docs/a.md`"],
      ["代码块里", "```\n@docs/a.md\n```"],
      ["HTML 注释里", "<!-- @docs/a.md -->"],
      ["邮箱地址", "联系 me@example.com"],
      ["不像路径", "@@x @#y @%z"],
    ];
    const rows = samples.map(([label, text]) => {
      const real = original(text, base).map(shorten);
      const coda = extractIncludes(text, base).map(shorten);
      return { 写法: label, 内容: JSON.stringify(text).replaceAll("`", "｀"), 原函数认出: real.join("　") || "—", "coda 认出": coda.join("　") || "—", 一致: JSON.stringify(real) === JSON.stringify(coda) ? "是" : "否" };
    });
    t.table(rows);
    t.ok("coda 的 extractIncludes 与原函数在这 15 种写法上结果相同", rows.every((r) => r.一致 === "是"));
  }

  // ───────────────────────── 三、展开 ─────────────────────────
  if (wants("include")) {
    t.log("三、引用怎样展开：顺序、去重、深度和外部引用");
    t.log();

    const chain = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`c${i}.md`, i < 6 ? `第 ${i} 层\n@c${i + 1}.md` : "第 6 层"]));
    const cases = [
      { 场景: "钻石：a、b 都引用 shared", files: { "CLAUDE.md": "@a.md\n@b.md", "a.md": "A\n@shared.md", "b.md": "B\n@shared.md", "shared.md": "S" } },
      { 场景: "环：a 又引用回 CLAUDE.md", files: { "CLAUDE.md": "@a.md", "a.md": "A\n@CLAUDE.md" } },
      { 场景: "自己引用自己", files: { "CLAUDE.md": "你好\n@CLAUDE.md" } },
      { 场景: "七层长链", files: { "CLAUDE.md": "@c0.md", ...chain } },
      { 场景: "引用不存在的文件和目录", files: { "CLAUDE.md": "@missing.md\n@docs\n@ok.md", "docs/readme.md": "D", "ok.md": "OK" } },
      { 场景: "引用的文件去掉注释后是空的", files: { "CLAUDE.md": "@note.md\n@real.md", "note.md": "<!-- 只有备注 -->\n", "real.md": "R" } },
      { 场景: "引用图片等非文本文件", files: { "CLAUDE.md": "@logo.png\n@ok.md", "logo.png": "not really a png", "ok.md": "OK" } },
      { 场景: "引用项目之外的文件", files: { "CLAUDE.md": "@../outside.md\n@ok.md", "../outside.md": "外面的内容", "ok.md": "OK" } },
      { 场景: "……同上，用户批准了外部引用", files: { "CLAUDE.md": "@../outside2.md\n@ok.md", "../outside2.md": "外面的内容", "ok.md": "OK" }, external: true },
    ];
    const show = (list) => list.map((f) => (f.parent ? `${f.path}←${f.parent}` : f.path)).join("　");
    const results = [];
    for (const [index, c] of cases.entries()) {
      const root = join(t.root, "include", `case${index}`, "project");
      put(root, c.files);
      const originalRun = originalTree(root);
      const theirs = await originalRun(join(root, "CLAUDE.md"), !!c.external);
      const mine = loadMemories(root, "CLAUDE.md", { includeExternal: !!c.external }).map((f) => ({
        path: relative(root, f.file),
        parent: f.parent && relative(root, resolve(root, f.parent)),
      }));
      results.push({ 场景: c.场景, "原函数（路径←引用它的文件）": show(theirs), "coda 的 loadMemories": show(mine), 一致: show(theirs) === show(mine) ? "是" : "否" });
    }
    t.table(results);
    t.ok("九个场景里，coda 与原函数加载的文件、顺序、引用关系完全相同", results.every((r) => r.一致 === "是"));
    t.equal("钻石：shared 只加载一次，归先到达它的 a", results[0]["coda 的 loadMemories"], "CLAUDE.md　a.md←CLAUDE.md　shared.md←a.md　b.md←CLAUDE.md");
    t.equal(`七层长链：只读到第 ${MAX_INCLUDE_DEPTH} 个文件`, results[3]["coda 的 loadMemories"].split("　").length, MAX_INCLUDE_DEPTH);

    // 符号链接：原版只比较路径字符串，coda 连符号链接指向哪里也看
    const linkRoot = join(t.root, "include", "link", "project");
    put(linkRoot, { "CLAUDE.md": "@link.md\n@ok.md", "ok.md": "OK" });
    writeFileSync(join(t.root, "include", "link", "secret.md"), "项目之外的内容");
    symlinkSync(join(t.root, "include", "link", "secret.md"), join(linkRoot, "link.md"));
    const linkOriginal = await originalTree(linkRoot)(join(linkRoot, "CLAUDE.md"));
    const linkMine = loadMemories(linkRoot).map((f) => ({ path: f.path }));
    t.table([
      { 场景: "@link.md，它是指向项目之外的符号链接", 原函数: show(linkOriginal), coda: show(linkMine) },
    ]);
    t.log("（原函数这一行取决于端口 pathInOriginalCwd：它照原版 pathInWorkingPath 的写法只比较路径字符串。）");
    t.log();
    t.equal("符号链接：字符串比较放行，coda 按真实位置拦下", [linkOriginal.length, linkMine.length], [3, 2]);

    // 同一个文件被两条路径到达：CLAUDE.md 引用了 .claude/rules/x.md，规则目录稍后又会扫到它
    const shared = join(t.root, "include", "twice", "project");
    put(shared, { "CLAUDE.md": "@.claude/rules/x.md", ".claude/rules/x.md": "规则 X" });
    const seen = new Set();
    const run = originalTree(shared);
    const firstPass = await run(join(shared, "CLAUDE.md"), false, seen);
    const secondPass = await run(join(shared, ".claude/rules/x.md"), false, seen);
    const viaDiscover = discoverMemories({ cwd: shared }).map((f) => f.path);
    t.table([
      { 路径: "先读 CLAUDE.md（它引用了 x.md）", 加载结果: show(firstPass) },
      { 路径: "再读规则目录里的 x.md（共用同一个 seen）", 加载结果: show(secondPass) || "（空：已经读过）" },
      { 路径: "coda 的 discoverMemories", 加载结果: viaDiscover.join("　") },
    ]);
    t.equal("规则文件被 @引用之后，规则目录不会再注入一遍", [secondPass.length, viaDiscover], [0, ["CLAUDE.md", ".claude/rules/x.md"]]);

    // 随机对照：400 张随机的引用图（有环、有自引用、有空文件、有代码块里的假引用），逐张比较
    let seed = 20240401;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (n) => Math.floor(random() * n);
    const fuzzRoot = join(t.root, "include", "fuzz", "project");
    mkdirSync(fuzzRoot, { recursive: true });
    const fuzzOriginal = originalTree(fuzzRoot);
    let different = 0;
    let longest = 0;
    for (let round = 0; round < 400; round++) {
      const files = { "CLAUDE.md": `@f${pick(6)}.md\n@f${pick(6)}.md` };
      for (let i = 0; i < 6; i++) {
        const kind = pick(10);
        const refs = Array.from({ length: pick(4) }, () => `@f${pick(7)}.md`); // f6.md 不存在
        files[`f${i}.md`] =
          kind === 0 ? "" : kind === 1 ? `\`${refs[0] ?? "@f0.md"}\`` : kind === 2 ? `<!-- ${refs.join(" ")} -->` : `文件 ${i}\n${refs.join("\n")}`;
      }
      put(fuzzRoot, files);
      const theirs = show(await fuzzOriginal(join(fuzzRoot, "CLAUDE.md")));
      const mine = show(loadMemories(fuzzRoot).map((f) => ({ path: f.path, parent: f.parent })));
      longest = Math.max(longest, mine.split("　").length);
      if (theirs !== mine) different++;
    }
    t.log(`随机生成 400 张引用图（每张 7 个文件，最长的一张展开成 ${longest} 个文件），coda 与原函数不同的有 ${different} 张。`);
    t.log();
    t.equal("400 张随机引用图上，coda 与原函数的加载结果一致", different, 0);
  }

  // ───────────────────────── 四、注入 ─────────────────────────
  // 两个实验共用的项目：用户级、项目级（引用了另一个文件）、本机私有、自动记忆各一份
  const injectFixture = (name) => {
    const home = join(t.root, name); // 当作用户的主目录，打印时写成 ~
    const project = join(home, "project");
    put(home, {
      ".claude/CLAUDE.md": "回答尽量简短。",
      "project/CLAUDE.md": "提交说明用中文写。\n@docs/conventions.md",
      "project/docs/conventions.md": "函数名用驼峰。",
      "project/CLAUDE.local.md": "我本机的数据库在 5433 端口。",
      ".claude/projects/app/memory/MEMORY.md": "- [测试命令](test.md) — 用 pnpm test:unit",
    });
    const options = { cwd: project, userDir: join(home, ".claude"), autoMemory: join(home, ".claude/projects/app/memory/MEMORY.md") };
    return { home, project, options, files: discoverMemories(options), tilde: (text) => String(text).replaceAll(home, "~") };
  };

  if (wants("inject")) {
    t.log("四、找到的文件怎样拼成文字，包成一条消息");
    t.log();
    const { files, tilde } = injectFixture("inject");

    // 原版的 getClaudeMds：从固定提交里装载。端口只有两个：功能开关（全关）和开头那句总的提醒（用占位符，不在这里复制原文）。
    const getClaudeMds = upstream("memory-inject", "getClaudeMds", {
      getFeatureValue_CACHED_MAY_BE_STALE: () => false,
      feature: () => false,
      MEMORY_INSTRUCTION_PROMPT: "〈开头那句总的提醒〉",
    });
    const asOriginal = files.map((f) => ({ path: f.file, type: f.type, content: f.text })); // 原版的 path 是绝对路径
    const theirs = tilde(getClaudeMds(asOriginal));
    t.log("原版 getClaudeMds 的输出：");
    t.log();
    t.log(theirs.split("\n").map((line) => `  │ ${line}`).join("\n"));
    t.log();
    const headings = (text) => tilde(text).split("\n").filter((line) => line.startsWith("Contents of "));
    const mineText = formatMemories(files);
    t.log("coda 的 formatMemories 的标题行：");
    t.log();
    t.log(headings(mineText).map((line) => `  │ ${line}`).join("\n"));
    t.log();
    const pathOf = (line) => line.replace(/^Contents of /, "").replace(/ \(.*\):$/, "");
    const theirHeadings = headings(theirs).map(pathOf);
    t.equal(
      "标题行里的文件和顺序相同（原版写绝对路径，coda 对项目里的文件写相对路径；来源说明的措辞各写各的）",
      headings(mineText).map((line, i) => theirHeadings[i]?.endsWith(pathOf(line))),
      theirHeadings.map(() => true),
    );

    // 再包一层：prependUserContext。原函数装载运行，端口只有“造一条用户消息”和环境变量。
    const prependUserContext = upstream("memory-user-context", "prependUserContext", {
      createUserMessage: ({ content, isMeta }) => ({ type: "user", isMeta, message: { role: "user", content } }),
      process: { env: {} },
      Object,
    });
    const history = [{ type: "user", message: { role: "user", content: "修复登录页的 bug" } }];
    const [injected, ...rest] = JSON.parse(
      JSON.stringify(prependUserContext(history, { claudeMd: "〈claudeMd：上面那一大段〉", currentDate: "Today's date is 2026-11-03." })),
    );
    t.table([
      { 位置: "messages[0]", 来源: "prependUserContext 在请求前加的", isMeta: String(injected.isMeta), 开头: injected.message.content.split("\n")[0], 内容的段落: [...injected.message.content.matchAll(/^# (\w+)$/gm)].map((m) => m[1]).join("、") },
      { 位置: "messages[1]", 来源: "用户真正输入的", isMeta: "undefined", 开头: rest[0].message.content, 内容的段落: "" },
    ]);
    t.log("原函数生成的这条消息，末尾还有一句话说明“这些内容不一定和任务有关”：");
    t.log();
    t.log(injected.message.content.split("\n").filter((line) => line.includes("IMPORTANT")).map((line) => `  │ ${line.trim()}`).join("\n"));
    t.log();
    const mine = contextMessage(files, { date: "2026-11-03" });
    t.ok("coda 的 contextMessage 同样是一条 meta 用户消息，包在 system-reminder 里，claudeMd 在日期之前", mine.meta && mine.text.startsWith("<system-reminder>") && mine.text.indexOf("# claudeMd") < mine.text.indexOf("# currentDate"));

    // 找到了，不等于注入：功能开关可以让 MEMORY.md 索引不进上下文
    const flagRows = [false, true].map((flag) => {
      const filter = upstream("memory-filter", "filterInjectedMemoryFiles", { getFeatureValue_CACHED_MAY_BE_STALE: () => flag });
      return {
        "开关 tengu_moth_copse": flag ? "开" : "关",
        "原函数注入的类型": JSON.parse(JSON.stringify(filter(files.map((f) => ({ type: f.type }))))).map((f) => f.type).join("、"),
        "coda 的 filterInjected": filterInjected(files, { skipIndex: flag }).map((f) => f.type).join("、"),
      };
    });
    t.table(flagRows);
    t.ok("开关两种状态下，coda 与原函数注入的类型相同", flagRows.every((r) => r.原函数注入的类型 === r["coda 的 filterInjected"]));
  }

  if (wants("placement")) {
    t.log("五、放在哪里，改一行 CLAUDE.md 要付什么代价");
    t.log();
    const { project, options, files } = injectFixture("placement");

    const system = ["你是 coda。"];
    const wireOf = (list, how) =>
      how === "system"
        ? buildRequest([{ role: "user", text: "修复登录页的 bug" }], { prompt: { defaults: system }, memories: memoryPrompt(list) })
        : buildRequest([contextMessage(list, { date: "2026-11-03" }), { role: "user", text: "修复登录页的 bug" }], { prompt: { defaults: system } });
    const before = { system: wireOf(files, "system"), message: wireOf(files, "message") };
    writeFileSync(join(project, "CLAUDE.md"), "提交说明用中文写。\n@docs/conventions.md\n改完必须运行测试。");
    const changed = discoverMemories(options);
    const after = { system: wireOf(changed, "system"), message: wireOf(changed, "message") };
    t.table([
      {
        做法: "拼进 system（app.mjs 现在的做法）",
        "改 CLAUDE.md 之后：系统提示+工具声明": before.system.prefixHash === after.system.prefixHash ? "不变" : "变了",
        "改 CLAUDE.md 之后：messages[0]": JSON.stringify(before.system.messages[0]) === JSON.stringify(after.system.messages[0]) ? "不变" : "变了",
      },
      {
        做法: "第一条用户消息（Claude Code 的做法）",
        "改 CLAUDE.md 之后：系统提示+工具声明": before.message.prefixHash === after.message.prefixHash ? "不变" : "变了",
        "改 CLAUDE.md 之后：messages[0]": JSON.stringify(before.message.messages[0]) === JSON.stringify(after.message.messages[0]) ? "不变" : "变了",
      },
    ]);
    t.equal("放进 system：改说明会改变系统提示；放进第一条消息：系统提示和工具声明纹丝不动", [before.system.prefixHash !== after.system.prefixHash, before.message.prefixHash === after.message.prefixHash], [true, true]);

    // 会话中途改文件：缓存住的那一份不会变，直到清掉
    writeFileSync(join(project, "CLAUDE.md"), "提交说明用中文写。");
    const memory = sessionMemory(options);
    const first = memory.get();
    writeFileSync(join(project, "CLAUDE.md"), "提交说明用英文写。");
    const stale = memory.get();
    memory.clear();
    const fresh = memory.get();
    const line = (list) => list.find((f) => f.path === "CLAUDE.md").text;
    t.table([
      { 时刻: "会话开始（第一次 get）", "项目的 CLAUDE.md": line(first) },
      { 时刻: "磁盘上改了，再 get", "项目的 CLAUDE.md": line(stale) },
      { 时刻: "clear() 之后（压缩或 /clear）", "项目的 CLAUDE.md": line(fresh) },
    ]);
    t.equal("会话中途改文件，要等清掉缓存才读到", [line(first), line(stale), line(fresh)], ["提交说明用中文写。", "提交说明用中文写。", "提交说明用英文写。"]);
  }

  // ───────────────────────── 六、谁来触发按需加载 ─────────────────────────
  if (wants("triggers")) {
    t.log("六、谁来触发按需加载");
    t.log();

    // 谁会触发按需加载？直接在固定提交的源码里搜。只打印位置（文件:行号）和我们的分类，不打印源码行。
    const where = (pattern) =>
      execFileSync("git", ["-C", SOURCE_DIR, "grep", "-n", "-F", pattern, CC_SOURCE.commit, "--", "restored-src/src"], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => {
          const [, file, no, text] = line.match(/^[^:]+:restored-src\/src\/([^:]+):(\d+):(.*)$/);
          return { file, line: Number(no), text };
        });
    const triggers = where("nestedMemoryAttachmentTriggers").filter((hit) => hit.text.includes(".add("));
    const resets = where("loadedNestedMemoryPaths").filter((hit) => hit.text.includes(".clear()"));
    const attachmentReads = where("FileReadTool.call(").filter((hit) => hit.file === "utils/attachments.ts");
    const group = (hits) => Object.entries(Object.groupBy(hits, (hit) => hit.file)).map(([file, list]) => `${file}：${list.map((hit) => `第 ${hit.line} 行`).join("、")}`).join("；");
    t.table([
      { 动作: "登记触发（把读过的文件路径放进集合）", 出现的位置: group(triggers) },
      { 动作: "清空“已加载”集合（压缩、/clear 之后重新允许附上）", 出现的位置: group(resets) },
      { 动作: "附件系统里经由 FileReadTool.call 读文件（@提及的文件、改动检测）", 出现的位置: group(attachmentReads) },
    ]);
    t.equal("全部源码里，只有 FileReadTool 登记触发", [...new Set(triggers.map((hit) => hit.file))], ["tools/FileReadTool/FileReadTool.ts"]);
    t.equal("两条压缩路径和 /clear 都会清空已加载的集合", [...new Set(resets.map((hit) => hit.file))].sort(), ["commands/clear/conversation.ts", "services/compact/compact.ts"]);
  }

  // ───────────────────────── 七、按需加载 ─────────────────────────
  if (wants("nested")) {
    t.log("七、子目录和带 paths 的规则，什么时候才被加载");
    t.log();

    // 先对照真实录制：读了 src/api/handler.js 之后，会话文件里多了两个 nested_memory 附件。
    const cwd = join(t.root, "nested", "recorded");
    put(cwd, {
      "CLAUDE.md": "# 项目说明\n@docs/conventions.md\n",
      "docs/conventions.md": "CANARY-IMPORTED：函数名用驼峰。\n",
      "src/CLAUDE.md": "CANARY-SUBDIR-CLAUDEMD：src 目录下的代码不要加分号。\n",
      ".claude/rules/api.md": '---\npaths:\n  - "src/api/**"\n---\nCANARY-PATH-RULE：API 处理函数必须校验输入。\n',
      "src/api/handler.js": "export function handle(req) { return req.body }\n",
      "src/util.js": "export const id = x => x\n",
    });
    const recording = JSON.parse(readFileSync(join(ROOT, "labs/ch04/recorded/instructions.json"), "utf8"));
    const recordedNested = recording.transcripts[0].entries.filter((e) => e.type === "attachment" && e.attachment.type === "nested_memory").map((e) => e.attachment);
    const hooks = recording.hooks.filter((h) => h.event === "InstructionsLoaded" && h.payload.trigger_file_path).map((h) => h.payload);
    const memory = new NestedMemory({ cwd });
    memory.noteRead(join(cwd, "src/api/handler.js"));
    memory.noteRead(join(cwd, "src/util.js"));
    const attached = memory.collect();
    const rel = (path) => relative(cwd, path);
    t.table(
      recordedNested.map((r, i) => ({
        序: i + 1,
        "Claude Code 2.1.296：附件": r.displayPath,
        "load_reason（钩子）": hooks.find((h) => h.file_path.endsWith(r.displayPath))?.load_reason,
        "coda NestedMemory": attached[i] ? rel(attached[i].file) : "—",
        "coda 的 reason": attached[i]?.reason ?? "—",
      })),
    );
    t.equal(
      "读 handler.js 和 util.js 之后，coda 附上的文件、顺序、reason 与录制一致",
      attached.map((m) => [rel(m.file), m.reason]),
      recordedNested.map((r) => [r.displayPath, hooks.find((h) => h.file_path.endsWith(r.displayPath)).load_reason]),
    );
    const rule = recordedNested.find((r) => r.displayPath.endsWith("api.md")).content;
    t.log(`带 paths 的规则：录制里 globs = ${JSON.stringify(rule.globs)}，contentDiffersFromDisk = ${rule.contentDiffersFromDisk}（frontmatter 被去掉了，所以磁盘上的原文和注入的不同）。`);
    t.log();

    // 要检查哪些目录：原函数 getDirectoriesToProcess 对照 coda 的 directoriesFor
    const getDirectories = upstream("memory-nested-dirs", "getDirectoriesToProcess", { dirname, resolve, parse });
    const repo = join(t.root, "nested", "monorepo");
    const appDir = join(repo, "packages", "app");
    const targets = [
      ["packages/app/src/api/handler.js", join(appDir, "src/api/handler.js")],
      ["packages/app/README.md（就在 cwd）", join(appDir, "README.md")],
      ["packages/shared/x.js（在 cwd 之外）", join(repo, "packages/shared/x.js")],
    ];
    const names = (dirs) => dirs.map((d) => relative(repo, d) || "（仓库根）").join(" → ") || "—";
    const inRepo = (dirs) => dirs.filter((d) => !relative(repo, d).startsWith(".."));
    const dirRows = targets.map(([label, file]) => {
      const theirs = JSON.parse(JSON.stringify(getDirectories(file, appDir)));
      const mine = directoriesFor(file, appDir, repo);
      const same = JSON.stringify([theirs.nestedDirs, inRepo(theirs.cwdLevelDirs)]) === JSON.stringify([mine.nested, mine.ancestors]);
      return { 读的文件: label, "cwd 之下的每一层：加载 CLAUDE.md 和全部规则": names(theirs.nestedDirs), "仓库根到 cwd 的每一层：只补带 paths 的规则": names(inRepo(theirs.cwdLevelDirs)), 一致: same ? "是" : "否" };
    });
    t.table(dirRows);
    t.ok("coda 的 directoriesFor 与原函数在三个目标上要检查的目录相同", dirRows.every((r) => r.一致 === "是"));

    // 端到端：一个会读文件的模型，跑在 coda 的 Engine 上。每次 Read 完，NestedMemory 把该附的说明排进队列。
    const work = join(t.root, "nested", "work");
    put(work, {
      "CLAUDE.md": "提交说明用中文写。",
      "src/CLAUDE.md": "src 下不写分号。",
      "src/api/CLAUDE.md": "API 处理函数必须校验输入。",
      "src/api/handler.js": "export const handle = (req) => req.body\n",
      "src/api/users.js": "export const users = []\n",
      "src/api/handler.test.js": "test('handle', () => {})\n",
      "src/util.js": "export const id = (x) => x\n",
      "lib/CLAUDE.md": "lib 下一律用 ESM。",
      "lib/x.js": "export const x = 1\n",
      ".claude/rules/api.md": "---\npaths:\n  - src/api/**\n---\nAPI 返回统一的错误格式。",
      ".claude/rules/tests.md": "---\npaths: '**/*.test.js'\n---\n测试里不要 mock 数据库。",
    });
    const nested = new NestedMemory({ cwd: work });
    const log = [];
    let engine;
    let turn = 0;
    const definitions = codingTools(work).map((tool) => ({
      ...tool,
      execute(input, context) {
        const result = tool.execute(input, context);
        let attached = [];
        if (tool.name === "Read") {
          // 对应 FileReadTool：读完就把路径登记为触发者。真正的附件在下一次请求前才生成，这里一并算好排进队列
          nested.noteRead(input.path);
          attached = nested.collect();
          for (const m of attached) engine.queue.push({ role: "user", text: m.text, priority: "next" });
        }
        log.push({ 请求: turn, 调用: `${tool.name} ${input.path}`, 追加: attached.map((m) => `${relative(work, m.file)}（${m.reason}）`).join("、") || "—" });
        return result;
      },
    }));
    const call = (name, input, id) => ({ calls: [{ name, input, id }] });
    const replies = [
      call("Read", { path: "src/util.js" }, "r1"),
      { calls: [{ name: "Read", input: { path: "src/api/handler.js" }, id: "r2" }, { name: "Read", input: { path: "src/api/users.js" }, id: "r3" }] },
      call("Write", { path: "lib/new.js", text: "export const y = 2\n" }, "w1"),
      call("Read", { path: "lib/x.js" }, "r4"),
      call("Read", { path: "src/api/handler.test.js" }, "r5"),
      { text: "完成。" },
    ];
    engine = new Engine({
      model: async (wire, signal) => {
        turn++;
        return scripted([replies[turn - 1]])(wire, signal);
      },
      tools: new Toolset(definitions, { gate: async () => true }),
      request: (messages) => buildRequest(messages),
    });
    const frames = [];
    for await (const frame of engine.run("检查接口代码", { context: { root: work }, maxTurns: 10 })) frames.push(frame);
    t.table(log.map((row, i) => ({ 序: i + 1, "第几次回复里的调用": row.请求, 模型的调用: row.调用, "紧接着追加到对话里的说明": row.追加 })));
    t.equal(
      "每份说明只在第一次相关的 Read 之后追加一次；Write 不触发；规则按 paths 匹配",
      log.filter((r) => r.追加 !== "—").map((r) => r.追加),
      ["src/CLAUDE.md（nested_traversal）", "src/api/CLAUDE.md（nested_traversal）、.claude/rules/api.md（path_glob_match）", "lib/CLAUDE.md（nested_traversal）", ".claude/rules/tests.md（path_glob_match）"],
    );
    // 追加的消息在请求里的位置：紧跟在触发它的工具结果后面
    const requests = frames.filter((f) => f.type === "request");
    const layout = (wire) => wire.messages.map((m) => (m.role === "tool" ? "tool" : m.role === "assistant" ? "assistant" : m.text.startsWith("<system-reminder>") ? "说明(meta)" : "user")).join(" → ");
    t.table([
      { 请求: "第 2 个", 消息顺序: layout(requests[1].wire) },
      { 请求: "第 3 个", 消息顺序: layout(requests[2].wire) },
    ]);
    t.equal("第 2 个请求里，说明紧跟在 Read 的结果后面，开头的消息没有动", layout(requests[1].wire), "user → assistant → tool → 说明(meta)");

    // 压缩之后：历史被换成摘要，之前附过的说明也没了，要允许再附一次
    nested.noteRead(join(work, "src/util.js"));
    const withoutReset = nested.collect().length;
    nested.reset();
    nested.noteRead(join(work, "src/util.js"));
    const afterReset = nested.collect().map((m) => relative(work, m.file));
    t.table([
      { 场景: "再读 src/util.js（没有压缩）", 追加了: withoutReset ? "有" : "没有" },
      { 场景: "压缩之后（调用了 reset()）再读 src/util.js", 追加了: afterReset.join("、") },
    ]);
    t.equal("压缩前不重复，压缩后重新附上", [withoutReset, afterReset], [0, ["src/CLAUDE.md"]]);

  }

  // ───────────────────────── 八、去重，以及记进 readFileState 的是什么 ─────────────────────────
  if (wants("attach")) {
    t.log("八、按需加载的说明怎样去重，又怎样记进 readFileState");
    t.log();
    const work = join(t.root, "attach", "work");
    put(work, {
      "src/CLAUDE.md": "src 下不写分号。",
      "src/api/CLAUDE.md": "API 处理函数必须校验输入。",
      ".claude/rules/api.md": "---\npaths:\n  - src/api/**\n---\nAPI 返回统一的错误格式。",
      "src/api/handler.js": "export const handle = (req) => req.body\n",
    });
    // 原函数 memoryFilesToAttachments：去重，并把“模型看到的不是磁盘原文”记进 readFileState（第 3 章的 isPartialView）
    const memoryFilesToAttachments = upstream("memory-attachments", "memoryFilesToAttachments", {
      hasInstructionsLoadedHook: () => false,
      isInstructionsMemoryType: () => true,
      executeInstructionsLoadedHooks() {},
      relative,
      getCwd: () => work,
    });
    const toolUseContext = { loadedNestedMemoryPaths: new Set(), readFileState: new Map() };
    const check = new NestedMemory({ cwd: work });
    const found = [];
    check.noteRead(join(work, "src/api/handler.js"));
    for (const m of check.collect()) {
      // 换成原函数认得的形状（MemoryFileInfo）
      const info = m.memory;
      found.push({ path: m.file, type: info.type, content: info.text, contentDiffersFromDisk: info.differsFromDisk, rawContent: info.raw, globs: info.globs });
    }
    const first = memoryFilesToAttachments(found, toolUseContext, "src/api/handler.js");
    const second = memoryFilesToAttachments(found, toolUseContext, "src/api/handler.js");
    t.table(
      found.map((f) => {
        const state = toolUseContext.readFileState.get(f.path);
        const disk = readFileSync(f.path, "utf8");
        return { 文件: relative(work, f.path), "注入的文字与磁盘不同": f.contentDiffersFromDisk ? "是（去掉了 frontmatter）" : "否", "readFileState 里记的 content": state.content === disk ? "磁盘原文" : "注入的文字", isPartialView: String(state.isPartialView) };
      }),
    );
    t.equal("原函数：第一次附上全部，第二次一份也不附（loadedNestedMemoryPaths 去重）", [first.length, second.length], [found.length, 0]);
    t.equal("原函数：frontmatter 被去掉的规则标 isPartialView，普通 CLAUDE.md 不标", found.map((f) => toolUseContext.readFileState.get(f.path).isPartialView), found.map((f) => f.contentDiffersFromDisk));
  }

  // ───────────────────────── 九、自动记忆 ─────────────────────────
  if (wants("auto")) {
    t.log("九、模型写给自己的 MEMORY.md，怎样进入下一个会话");
    t.log();

    // 对照真实录制：第二个会话的 instructions 附件里，只有一份 AutoMem
    const recall = JSON.parse(readFileSync(join(ROOT, "labs/ch04/recorded/recall.json"), "utf8"));
    const recordedFiles = recall.transcripts[0].entries.find((e) => e.type === "attachment" && e.attachment.type === "instructions").attachment.files;
    const project = join(t.root, "auto", "project");
    const memoryFile = join(t.root, "auto", "memory", "MEMORY.md");
    put(project, { "package.json": '{"name":"demo"}\n' });
    put(join(t.root, "auto"), { "memory/MEMORY.md": `${recordedFiles[0].content}\n` });
    const files = discoverMemories({ cwd: project, autoMemory: memoryFile });
    t.table([
      { 来源: "Claude Code 2.1.296 的第二个会话（会话文件）", 注入的文件: recordedFiles.map((f) => f.type).join("、"), 内容: recordedFiles[0].content },
      { 来源: "coda discoverMemories", 注入的文件: files.map((f) => f.type).join("、"), 内容: files[0]?.text.trim() },
    ]);
    t.equal("新会话里，MEMORY.md 的索引作为 AutoMem 注入，内容与录制一致", [files.map((f) => f.type), files[0].text.trim()], [["AutoMem"], recordedFiles[0].content]);
    t.ok("注入的是索引（一行一个指针），不是记忆文件的正文", files[0].text.trim().split("\n").every((line) => line.startsWith("- [")));

    // 索引太长会被截断：原函数 truncateEntrypointContent 对照 coda 的 truncateIndex
    const truncate = upstream("memory-index-truncate", "truncateEntrypointContent", {
      MAX_ENTRYPOINT_LINES: 200,
      MAX_ENTRYPOINT_BYTES: 25000,
      ENTRYPOINT_NAME: "MEMORY.md",
      formatFileSize: (n) => `${(n / 1024).toFixed(1)}KB`,
    });
    const lines = (n, width = 20) => Array.from({ length: n }, (_, i) => `- [记忆 ${i + 1}](m${i + 1}.md) — ${"x".repeat(width)}`).join("\n");
    const inputs = [
      ["150 行，每行短", lines(150)],
      ["260 行，每行短", lines(260)],
      ["120 行，每行 300 字符", lines(120, 300)],
    ];
    const rows = inputs.map(([label, text]) => {
      const theirs = JSON.parse(JSON.stringify(truncate(text)));
      const mine = truncateIndex(text);
      const body = (s) => s.split("\n\n> WARNING")[0];
      const keptLines = (s) => body(s).split("\n").length;
      return {
        输入: label,
        "原函数：保留行数": keptLines(theirs.content),
        "原函数：触发的上限": theirs.wasLineTruncated ? "行数" : theirs.wasByteTruncated ? "字符数" : "没有截断",
        "coda：保留行数": keptLines(mine.text),
        一致: body(theirs.content) === body(mine.text) && (theirs.wasLineTruncated || theirs.wasByteTruncated) === mine.truncated ? "是" : "否",
      };
    });
    t.table(rows);
    t.ok("三种输入上，coda 与原函数截出的正文完全相同", rows.every((r) => r.一致 === "是"));
    t.log(`被截断的索引末尾多一句警告，告诉模型“只加载了一部分”：${scrub(truncate(inputs[1][1]).content.split("\n").at(-1)).slice(0, 80)}……`);
    t.log();
  }
});
