// 第 1 章：queryLoop 有几个“继续”的位置、几个出口？哪些在发布的 2.1.88 里走得到？
//   node labs/ch01/transitions.ts
// 只统计和比对，不复制任何源码：
//   · 从 cli.js.map 的 sourcesContent 里读 query.ts，数出 transition 和 Terminal.reason 的名字；
//   · 在发布的 cli.js 里找这些名字（编译期开关关掉的分支，字符串根本不会进包）；
//   · 看守着它们的模块（reactiveCompact、contextCollapse）有没有出现在 source map 里。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_DIR } from '../../lab/sourcemap.ts';

const map = JSON.parse(readFileSync(join(SOURCE_DIR, 'package/cli.js.map'), 'utf8')) as { sources: string[]; sourcesContent: string[] };
const bundle = readFileSync(join(SOURCE_DIR, 'package/cli.js'), 'utf8');
const sourceOf = (file: string) => map.sourcesContent[map.sources.indexOf(`../src/${file}`)];
const hasModule = (file: string) => map.sources.includes(`../src/${file}`);
const query = sourceOf('query.ts');

// 一、继续的位置：state = { …, transition: { reason: 'xxx' } }
const transitions = [...query.matchAll(/transition: \{\s*reason: '([a-z_]+)'/g)].map(m => m[1]);

// 每个继续原因由什么控制：编译期开关 feature()、服务端灰度 GrowthBook，或者没有（读 query.ts 得出）
const guard: Record<string, { gate: string; module?: string }> = {
  collapse_drain_retry: { gate: "feature('CONTEXT_COLLAPSE')", module: 'services/contextCollapse/index.ts' },
  reactive_compact_retry: { gate: "feature('REACTIVE_COMPACT')", module: 'services/compact/reactiveCompact.ts' },
  max_output_tokens_escalate: { gate: 'GrowthBook：tengu_otk_slot_v1' },
  max_output_tokens_recovery: { gate: '无' },
  stop_hook_blocking: { gate: '无' },
  token_budget_continuation: { gate: "feature('TOKEN_BUDGET')" },
  next_turn: { gate: '无' },
};

console.log('**继续的位置（query.ts 里 transition 的每个取值）**\n');
console.log('| # | 继续的原因 | 谁控制它 | 守着它的模块在 source map 里 | 字符串在发布的 cli.js 里 | 2.1.88 里走得到吗 |');
console.log('| --- | --- | --- | --- | --- | --- |');
transitions.forEach((reason, i) => {
  const g = guard[reason];
  assert.ok(g, `没有登记 ${reason} 的开关`);
  const inBundle = bundle.includes(`reason:"${reason}"`);
  const moduleThere = g.module ? hasModule(g.module) : undefined;
  const reachable = g.gate.startsWith('feature(') ? (inBundle && moduleThere !== false ? '走得到' : '走不到') : g.gate.startsWith('GrowthBook') ? '取决于服务端灰度' : '走得到';
  console.log(`| ${i + 1} | \`${reason}\` | ${g.gate} | ${moduleThere === undefined ? '—' : moduleThere ? '有' : '没有'} | ${inBundle ? '有' : '没有'} | ${reachable} |`);
});

// 二、出口：return { reason: 'xxx' }，以及 isWithheldMedia ? 'image_error' : 'prompt_too_long' 这一处
const exits = [
  ...query.matchAll(/return \{ reason: '([a-z_]+)'/g),
  ...[...query.matchAll(/reason: isWithheldMedia \? '([a-z_]+)' : '([a-z_]+)'/g)].flatMap(m => [[null, m[1]], [null, m[2]]]),
].map(m => m[1] as string);
const unique = [...new Set(exits)];

console.log('\n**出口（Terminal.reason 的取值）**\n');
console.log('| # | reason | 字符串在发布的 cli.js 里 |');
console.log('| --- | --- | --- |');
unique.forEach((reason, i) => console.log(`| ${i + 1} | \`${reason}\` | ${bundle.includes(`reason:"${reason}"`) ? '有' : '没有'} |`));

const live = transitions.filter(r => bundle.includes(`reason:"${r}"`));
console.log(`\n${transitions.length} 个继续的位置，其中 ${live.length} 个的字符串留在了发布的 cli.js 里；${unique.length} 个出口。`);

assert.equal(transitions.length, 7, '一共七个继续的位置，和源码注释里说的 7 个 continue 站点一致');
assert.equal(unique.length, 10, '十个出口');
assert.ok(unique.every(r => bundle.includes(`reason:"${r}"`)), '所有出口都在发布包里');
assert.ok(!bundle.includes('reason:"token_budget_continuation"'), 'TOKEN_BUDGET 被编译掉了');
assert.ok(!hasModule('services/compact/reactiveCompact.ts'), 'reactiveCompact 模块不在 source map 里');
