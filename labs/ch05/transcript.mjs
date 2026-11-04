// 第 5 章：真实的会话文件长什么样？恢复时是怎么把它读回一条对话的？（离线分析）
//   node --disable-warning=ExperimentalWarning labs/ch05/transcript.mjs [kinds|dag|compacted]
//
// 材料是 labs/ch05/recorded 里用 Claude Code 2.1.296 录下的会话文件（JSONL），
// 读回对话用的是固定提交（2.1.88）里真正的函数——构建时从 git 对象里取出来执行，不复制进仓库：
//   findLatestMessage                  选出“最近的叶子”
//   buildConversationChain             从叶子沿 parentUuid 走回根
//   recoverOrphanedParallelToolResults 把单链遍历走丢的并行工具调用补回来
//   applyPreservedSegmentRelinks       压缩之后，把“原样保留”的消息接到摘要后面
// 外围依赖（日志、事件上报）是占位端口。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { upstream } from '../engineering/run.mjs';

const part = process.argv[2] ?? 'kinds';
const load = (name) => JSON.parse(readFileSync(new URL(`./recorded/${name}.json`, import.meta.url), 'utf8')).transcripts[0].entries;
const short = (id) => String(id ?? '').slice(0, 6);
const CHAIN_TYPES = new Set(['user', 'assistant', 'attachment', 'system']); // isTranscriptMessage

// ── 原函数（占位端口：日志、事件上报什么都不做）──────────────────────
const isCompactBoundaryMessage = upstream('compact-boundary-check', 'isCompactBoundaryMessage');
const recoverOrphanedParallelToolResults = upstream('orphaned-parallel-results', 'recoverOrphanedParallelToolResults', { logEvent() {} });
const buildConversationChain = upstream('conversation-chain', 'buildConversationChain', { logError() {}, logEvent() {}, recoverOrphanedParallelToolResults });
const findLatestMessage = upstream('latest-message', 'findLatestMessage', { Date, Infinity });
const applyPreservedSegmentRelinks = upstream('preserved-segment-relinks', 'applyPreservedSegmentRelinks', { isCompactBoundaryMessage, logEvent() {} });

const describe = (e) => {
  if (e.type === 'attachment') return `附件 ${e.attachment?.type}`;
  if (e.subtype === 'compact_boundary') return '压缩边界 compact_boundary';
  const content = e.message?.content;
  if (typeof content === 'string') return `${e.isCompactSummary ? '压缩摘要：' : ''}${content.replace(/\s+/g, ' ').slice(0, 24)}…`;
  const block = content?.[0];
  if (block?.type === 'tool_use') return `调用 ${block.name}(${Object.values(block.input ?? {})[0] ?? ''})`;
  if (block?.type === 'tool_result') return `结果 ← ${short(block.tool_use_id.slice(-8))}`;
  if (block?.type === 'text') return `文字：${block.text.replace(/\s+/g, ' ').slice(0, 20)}…`;
  if (block?.type === 'thinking') return '思考';
  return e.type;
};

if (part === 'kinds') {
  const entries = load('1-read');
  console.log(`第一次运行（读三个文件）留下的会话文件，共 ${entries.length} 行：\n`);
  const kinds = (filter) => {
    const counts = new Map();
    for (const e of entries.filter(filter)) {
      const key = e.type === 'attachment' ? e.attachment?.type : e.type;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return { names: [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join('、'), total: [...counts.values()].reduce((a, b) => a + b, 0) };
  };
  const groups = [
    ['对话本身：在 parentUuid 链上', kinds((e) => e.type === 'user' || e.type === 'assistant' || e.type === 'system')],
    ['系统注入的附件：同样在链上（第 1、2 章说过它们）', kinds((e) => e.type === 'attachment')],
    ['记账用的行：没有 uuid，不在链上', kinds((e) => !CHAIN_TYPES.has(e.type))],
  ];
  console.log('| 这一类 | 具体是什么 | 行数 |');
  console.log('| --- | --- | --- |');
  for (const [name, g] of groups) console.log(`| ${name} | ${g.names} | ${g.total} |`);
  const chain = entries.filter((e) => CHAIN_TYPES.has(e.type));
  console.log(`\n在链上的 ${chain.length} 行里，第一行（用户的提问）的 parentUuid 是 ${chain[0].parentUuid}，其余每一行的 parentUuid 都指向文件里更早的一行。`);
  assert.equal(chain[0].parentUuid, null);
  assert.ok(chain.slice(1).every((e) => chain.some((p) => p.uuid === e.parentUuid)));
  const first = chain.find((e) => e.type === 'user');
  console.log(`每一行还带着 ${['sessionId', 'cwd', 'version', 'gitBranch', 'timestamp'].filter((k) => k in first).join('、')} 等字段：${first.version} 写下的这一行，另一个版本也读得懂。`);
}

if (part === 'dag') {
  const entries = load('1-read');
  const lines = entries.map((e, i) => ({ ...e, line: i + 1 })).filter((e) => CHAIN_TYPES.has(e.type));
  const byUuid = new Map(lines.map((e) => [e.uuid, e]));
  const line = (uuid) => byUuid.get(uuid)?.line ?? '—';
  const leaf = findLatestMessage(byUuid.values(), (m) => !m.isSidechain);

  // 单链遍历：从叶子一路 parentUuid 走到根，什么都不补
  const naive = [];
  for (let m = leaf; m; m = byUuid.get(m.parentUuid)) naive.unshift(m);
  const recovered = buildConversationChain(byUuid, leaf);
  const onNaive = new Set(naive.map((m) => m.uuid));
  const position = new Map(recovered.map((m, i) => [m.uuid, i + 1]));

  console.log('第一次运行里模型一次回复调用了三个 Read。下面是文件里的链上记录（只列和这三次调用有关的几行）：\n');
  console.log('| 文件第几行 | 是什么 | parentUuid 指向第几行 | 单链遍历走得到吗 | buildConversationChain 排在第几 |');
  console.log('| --- | --- | --- | --- | --- |');
  const interesting = lines.filter((e) => e.type === 'assistant' || e.message?.content?.[0]?.type === 'tool_result');
  for (const e of interesting.slice(0, 7)) {
    console.log(`| ${e.line} | ${describe(e)} | ${line(e.parentUuid)} | ${onNaive.has(e.uuid) ? '是' : '**否**'} | ${position.get(e.uuid) ?? '—'} |`);
  }
  const lost = lines.filter((e) => !onNaive.has(e.uuid));
  console.log(`\n叶子是第 ${leaf.line} 行（时间戳最新的那条）。单链遍历得到 ${naive.length} 行，buildConversationChain 得到 ${recovered.length} 行；走丢的是第 ${lost.map((e) => e.line).join('、')} 行。`);

  // 为什么：三个调用是同一次回复（message.id 相同）拆成的三条 assistant 记录
  const ids = interesting.filter((e) => e.type === 'assistant' && e.message.content[0].type === 'tool_use').map((e) => e.message.id);
  console.log(`三条 tool_use 记录的 message.id ${new Set(ids).size === 1 ? '完全相同' : '不同'}：原版按内容块写记录，每条 tool_result 的 parentUuid 指向发起它的那一条 assistant，于是出现了分叉。`);
  assert.equal(lost.length, 2);
  assert.ok(lost.some((e) => e.type === 'assistant') && lost.some((e) => e.type === 'user'));
  assert.equal(recovered.length, naive.length + lost.length);
  assert.equal(new Set(ids).size, 1);
}

if (part === 'compacted') {
  const entries = load('2-compact');
  const lines = entries.map((e, i) => ({ ...e, line: i + 1 })).filter((e) => CHAIN_TYPES.has(e.type));
  const loadMap = () => new Map(lines.map((e) => [e.uuid, structuredClone(e)]));
  const boundary = lines.find((e) => e.subtype === 'compact_boundary');
  const seg = boundary.compactMetadata.preservedSegment;

  console.log(`/compact 之后追加的记录，从第 ${boundary.line} 行开始：\n`);
  console.log('| 文件第几行 | 是什么 | parentUuid | logicalParentUuid |');
  console.log('| --- | --- | --- | --- |');
  const a = lines.filter((e) => e.line >= boundary.line).slice(0, 4);
  for (const e of a) console.log(`| ${e.line} | ${describe(e)} | ${e.parentUuid === null ? '**null（新的根）**' : `第 ${lines.find((x) => x.uuid === e.parentUuid)?.line} 行`} | ${e.logicalParentUuid ? `${short(e.logicalParentUuid)}…（压缩前内存里的最后一条）` : ''} |`);
  const head = lines.find((e) => e.uuid === seg.headUuid);
  const tail = lines.find((e) => e.uuid === seg.tailUuid);
  console.log(`\n边界上记着“原样保留”的消息：头 = 第 ${head.line} 行，尾 = 第 ${tail.line} 行，锚 = 第 ${lines.find((e) => e.uuid === seg.anchorUuid).line} 行（摘要）。它们还在文件里原来的位置，没有被复制。\n`);

  // 这份录制里时间戳最新的是 /compact 命令输出的那一行（第 39 行），它后面追加的附件时间戳反而更早；
  // 为了看到完整的链，这里取文件里链上的最后一行当叶子。
  const newest = findLatestMessage(loadMap().values(), (m) => !m.isSidechain);
  const leaf = lines.at(-1);
  console.log(`时间戳最新的是第 ${newest.line} 行；下面取文件里链上的最后一行（第 ${leaf.line} 行）当叶子，看压缩之后追加的内容也读不读得回来。\n`);
  const naiveMap = loadMap();
  const naive = [];
  for (let m = leaf; m; m = naiveMap.get(m.parentUuid)) naive.unshift(m);

  const messages = loadMap();
  applyPreservedSegmentRelinks(messages); // 就地修改：接上保留的消息，删掉边界之前其余的记录
  const loaded = buildConversationChain(messages, messages.get(leaf.uuid));

  console.log('恢复时读回的对话（左：只沿 parentUuid 走；右：先 applyPreservedSegmentRelinks 再走）：\n');
  console.log('| 读回来的第几条 | 只沿 parentUuid 走 | 先接上保留的消息再走 |');
  console.log('| --- | --- | --- |');
  const rows = Math.max(naive.length, loaded.length);
  for (let i = 0; i < Math.min(rows, 6); i++) console.log(`| ${i + 1} | ${naive[i] ? `${describe(naive[i])}（第 ${naive[i].line} 行）` : ''} | ${loaded[i] ? `${describe(loaded[i])}（第 ${loaded[i].line} 行）` : ''} |`);
  const before = lines.filter((e) => e.line < boundary.line).length;
  console.log(`\n文件里链上的记录共 ${lines.length} 行，其中边界之前 ${before} 行；压缩之后读回来 ${loaded.length} 行：边界、摘要、保留的 2 行，加上压缩之后追加的 ${loaded.length - 4} 行。边界之前其余的 ${before - 2} 行留在文件里，没有加载。`);

  assert.equal(naive[0].subtype, 'compact_boundary');
  assert.ok(!naive.some((m) => m.uuid === seg.headUuid), '只沿 parentUuid 走，保留的消息会丢');
  assert.deepEqual(Array.from(loaded, (m) => m.uuid).slice(0, 4), [boundary.uuid, lines.find((e) => e.uuid === seg.anchorUuid).uuid, seg.headUuid, seg.tailUuid]);
  assert.ok(loaded.every((m) => m.line >= boundary.line || m.uuid === seg.headUuid || m.uuid === seg.tailUuid));
}
