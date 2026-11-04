// 第 5 章：Claude Code 2.1.88 里到底有几条“压缩”的路，发布的版本能走到哪几条？
//   node --disable-warning=ExperimentalWarning labs/ch05/gates.mjs
// 只统计和比对，不复制任何源码：
//   · 守着每条路的开关，是读 autoCompact.ts、microCompact.ts、sessionMemoryCompact.ts 等得出的（正文里有摘录）；
//   · 编译期开关 feature(...) 关掉的分支，字符串根本不会进发布的 cli.js，模块也不会出现在 source map 里；
//   · 服务端灰度开关（GrowthBook）的分支，字符串在包里，能不能走到取决于服务端给的值，下面写出源码里的缺省值。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCE_DIR } from '../../lab/sourcemap.ts';

const map = JSON.parse(readFileSync(join(SOURCE_DIR, 'package/cli.js.map'), 'utf8'));
const bundle = readFileSync(join(SOURCE_DIR, 'package/cli.js'), 'utf8');
const hasModule = (file) => map.sources.includes(`../src/${file}`);
const inBundle = (text) => bundle.includes(text);

const paths = [
  { name: '自动压缩（摘要）', where: 'autoCompact.ts → compact.ts', gate: '用户设置 autoCompactEnabled（缺省开）；环境变量 DISABLE_AUTO_COMPACT 可关', marker: 'tengu_auto_compact_succeeded', module: 'services/compact/compact.ts', expect: '走得到' },
  { name: '手动 /compact', where: 'commands/compact/compact.ts', gate: '无', marker: 'tengu_compact_cache_prefix', module: 'commands/compact/compact.ts', expect: '走得到' },
  { name: '时间触发的微压缩', where: 'microCompact.ts', gate: 'GrowthBook tengu_slate_heron，缺省 enabled: false', marker: 'tengu_time_based_microcompact', module: 'services/compact/timeBasedMCConfig.ts', expect: '默认关，服务端可开' },
  { name: '缓存编辑式微压缩', where: 'microCompact.ts → cachedMicrocompact', gate: "feature('CACHED_MICROCOMPACT')（内部构建）", marker: 'tengu_cached_microcompact', module: 'services/compact/cachedMicrocompact.ts', expect: '走不到' },
  { name: '会话记忆压缩', where: 'sessionMemoryCompact.ts', gate: 'GrowthBook tengu_session_memory 且 tengu_sm_compact，缺省都是 false', marker: 'tengu_sm_compact', module: 'services/compact/sessionMemoryCompact.ts', expect: '默认关，服务端可开' },
  { name: 'prompt 过长后的 reactive compact', where: 'query.ts / reactiveCompact', gate: "feature('REACTIVE_COMPACT')", marker: 'tengu_cobalt_raccoon', module: 'services/compact/reactiveCompact.ts', expect: '走不到' },
  { name: '上下文折叠 context collapse', where: 'query.ts / contextCollapse', gate: "feature('CONTEXT_COLLAPSE')", marker: 'marble_origami', module: 'services/contextCollapse/index.ts', expect: '走不到' },
  { name: '历史裁剪 snip', where: 'query.ts / snipCompact', gate: "feature('HISTORY_SNIP')", marker: 'snipCompactIfNeeded', module: 'services/compact/snipCompact.ts', expect: '走不到' },
  { name: '压缩完很快又满了的熔断', where: '（2.1.296 的录制里有）', gate: '源码里没有这个 terminal reason', marker: 'rapid_refill_breaker', module: undefined, expect: '2.1.88 里没有' },
];

console.log('| 路径 | 源码位置 | 谁控制它 | 模块在 source map 里 | 标志字符串在发布的 cli.js 里 | 2.1.88 里 |');
console.log('| --- | --- | --- | --- | --- | --- |');
const results = paths.map((p) => {
  const moduleThere = p.module ? hasModule(p.module) : undefined;
  const stringThere = inBundle(p.marker);
  console.log(`| ${p.name} | ${p.where} | ${p.gate} | ${moduleThere === undefined ? '—' : moduleThere ? '有' : '没有'} | ${stringThere ? '有' : '没有'} | ${p.expect} |`);
  return { ...p, moduleThere, stringThere };
});

// 时间触发的微压缩的缺省配置，直接从发布的包里读出来（只读那一个对象字面量里的三个值）
const config = bundle.match(/\{enabled:(!?[01]),gapThresholdMinutes:(\d+),keepRecent:(\d+)\}/);
console.log(`\n发布的 cli.js 里，tengu_slate_heron 的缺省配置：enabled=${config[1] === '!1' ? 'false' : 'true'}，闲置 ${config[2]} 分钟，保留最近 ${config[3]} 个结果。`);

for (const r of results) {
  if (r.expect === '走不到') assert.ok(!r.stringThere && !r.moduleThere, `${r.name} 应当被编译期开关去掉`);
  if (r.expect.startsWith('默认关') || r.expect === '走得到') assert.ok(r.stringThere, `${r.name} 的字符串应当在包里`);
  if (r.expect === '2.1.88 里没有') assert.ok(!r.stringThere);
}
assert.equal(config[1], '!1');
assert.equal(config[2], '60');
