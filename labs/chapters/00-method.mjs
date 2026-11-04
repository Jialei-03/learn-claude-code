// 第 0 章：给还原源码做一次“体检”。
//   node labs/chapters/00-method.mjs
// 读 npm 包里的 cli.js.map：一共还原出多少文件、各目录有多大、
// 有多少代码被编译期开关 feature() 包着，以及哪些开关包着的入口真的进了发布的 cli.js。
// 只统计和比对，不复制任何源码。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lesson } from "./harness.mjs";
import { SOURCE_DIR, verifySourcemap } from "../../lab/sourcemap.ts";

await lesson(0, "还原源码的体检", async (t) => {
  // 课程引用的每个源码文件都和 source map 里的 sourcesContent 逐字一致（lab/sourcemap.ts 负责校验）
  const refs = verifySourcemap();
  t.ok("课程引用的源码文件与 source map 逐字一致", Object.values(refs).every((r) => r.sourceMapMatch));

  const map = JSON.parse(readFileSync(join(SOURCE_DIR, "package/cli.js.map"), "utf8"));
  const bundle = readFileSync(join(SOURCE_DIR, "package/cli.js"), "utf8");

  // ── 1. source map 里有什么 ─────────────────────────────────────
  const kinds = { "Claude Code 自己的源码（src/）": 0, "第三方依赖（node_modules/）": 0, "其他（vendor 等）": 0 };
  const src = [];
  map.sources.forEach((name, i) => {
    if (name.startsWith("../src/")) { kinds["Claude Code 自己的源码（src/）"]++; src.push({ name: name.slice(7), text: map.sourcesContent[i] ?? "" }); }
    else if (name.includes("node_modules/")) kinds["第三方依赖（node_modules/）"]++;
    else kinds["其他（vendor 等）"]++;
  });
  t.log(`cli.js.map 里一共 ${map.sources.length} 个源文件：`);
  t.table(Object.entries(kinds).map(([kind, n]) => ({ 来源: kind, 文件数: n })));
  t.ok("源码部分超过一千个文件", kinds["Claude Code 自己的源码（src/）"] > 1000);

  // ── 2. 目录地图：每个顶层目录有多少文件、多少行 ───────────────────
  const dirs = new Map();
  let totalLines = 0;
  for (const file of src) {
    const top = file.name.includes("/") ? file.name.split("/")[0] + "/" : "（根目录文件）";
    const lines = file.text.split("\n").length;
    totalLines += lines;
    const row = dirs.get(top) ?? { 目录: top, 文件: 0, 行数: 0 };
    row.文件++;
    row.行数 += lines;
    dirs.set(top, row);
  }
  const biggest = [...dirs.values()].sort((a, b) => b.行数 - a.行数).slice(0, 12);
  t.log(`src/ 一共约 ${Math.round(totalLines / 1000)}k 行。最大的 12 个目录：`);
  t.table(biggest.map((r) => ({ ...r, 行数: r.行数.toLocaleString("en-US") })));

  // ── 3. 编译期开关：feature('X') ────────────────────────────────
  const flags = new Map();
  for (const file of src) {
    for (const [, flag] of file.text.matchAll(/\bfeature\('([A-Z0-9_]+)'\)/g)) {
      const set = flags.get(flag) ?? new Set();
      set.add(file.name);
      flags.set(flag, set);
    }
  }
  const gatedFiles = new Set([...flags.values()].flatMap((s) => [...s]));
  t.log(`有 ${gatedFiles.size} 个文件用到 feature()，一共 ${flags.size} 个不同的开关。出现在最多文件里的几个：`);
  t.table([...flags.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 6).map(([flag, files]) => ({ 开关: flag, 文件数: files.size })));
  t.ok("feature() 开关数量可观", flags.size > 50);

  // ── 4. 哪些被开关包着的启动入口真的进了 cli.js？ ────────────────────
  // cli.tsx 的每条快速路径都会先调用 profileCheckpoint('名字')。
  // 一条路径如果在构建时被 feature() 判为关闭，整段代码会被删掉，这个名字也就不会出现在 cli.js 里。
  const entry = src.find((f) => f.name === "entrypoints/cli.tsx").text;
  const paths = [];
  for (const m of entry.matchAll(/if \(([^\n{]*?)\) \{\s*(?:\/\/[^\n]*\s*)*profileCheckpoint\('([a-z_]+)'\)/g)) {
    const gate = m[1].match(/feature\('([A-Z0-9_]+)'\)/)?.[1];
    paths.push({ 检查点: m[2], 编译期开关: gate ?? "（无）", 发布包里有吗: bundle.includes(`"${m[2]}"`) || bundle.includes(`'${m[2]}'`) ? "有" : "没有" });
  }
  t.log("cli.tsx 里的启动快速路径：");
  t.table(paths);
  const shipped = paths.filter((p) => p.发布包里有吗 === "有");
  t.ok("没有开关的快速路径都在发布包里", paths.filter((p) => p.编译期开关 === "（无）").every((p) => p.发布包里有吗 === "有"));
  t.ok("有的开关路径被编译掉了", paths.some((p) => p.编译期开关 !== "（无）" && p.发布包里有吗 === "没有"));
  t.ok("也有开关路径留在了发布包里", shipped.some((p) => p.编译期开关 !== "（无）"));

  // 被编译掉的模块，连源文件都不会出现在 source map 里
  const missing = ["daemon/main.ts", "cli/bg.ts", "environment-runner/main.ts"].map((name) => ({ 被引用的模块: name, "在 source map 里": src.some((f) => f.name === name || f.name === name + "x") ? "有" : "没有" }));
  t.table(missing);
  t.ok("被关掉的模块不在 source map 里", missing.every((m) => m["在 source map 里"] === "没有"));

  t.observations.survey = { sources: map.sources.length, src: src.length, lines: totalLines, flags: flags.size, gatedFiles: gatedFiles.size, paths };
});
