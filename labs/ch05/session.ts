// 第 5 章：同一个会话的三次运行——读文件、手动压缩、压缩之后再问（离线分析）。
//   node labs/ch05/session.ts [file|resume|compact|after]
import { loadRecording } from '../../lab/cc.ts';

const load = (name: string) => loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname);
const [one, two, three] = ['1-read', '2-compact', '3-after'].map(load);
const part = process.argv[2] ?? 'file';
const sig = (m: any) => JSON.stringify([m.role, m.blocks.map((b: any) => [b.type, b.chars, b.hash, b.ref])]);
const kind = (e: any) => (e.type === 'attachment' ? `附件 ${e.attachment?.type}` : e.subtype ? `${e.type}:${e.subtype}` : e.type);
const usage = (q: any) => q.response?.usage ?? {};
const total = (u: any) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

if (part === 'file') {
  console.log('三次运行用的是同一个会话文件，每次在末尾追加：\n');
  console.log('| 运行 | 会话文件 | 行数 | 这次新增的记录 |');
  console.log('| --- | --- | --- | --- |');
  let before = 0;
  for (const [label, r] of [['① 读三个文件', one], ['② --resume，/compact', two], ['③ --resume，再提问', three]] as const) {
    const t = r.transcripts[0];
    const added = t.entries.slice(before).filter((e: any) => !['queue-operation', 'atis-latch', 'last-prompt', 'cost-state', 'mode'].includes(e.type));
    const counts = new Map<string, number>();
    for (const e of added.filter((e: any) => e.type !== 'attachment')) counts.set(kind(e), (counts.get(kind(e)) ?? 0) + 1);
    const attachments = [...new Set(added.filter((e: any) => e.type === 'attachment').map((e: any) => e.attachment?.type))];
    console.log(`| ${label} | \`…/${t.file.split('/').pop().slice(0, 8)}….jsonl\` | ${t.entries.length} | ${[...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join('、')}；附件：${attachments.join('、')} |`);
    before = t.entries.length;
  }
  console.log('\n每次启动时 SessionStart 钩子收到的 source：', [one, two, three].map((r: any) => r.hooks.filter((h: any) => h.event === 'SessionStart').map((h: any) => h.payload.source).join(' → ')).join(' ｜ '));
}

if (part === 'resume') {
  const a = one.requests.at(-1), b = two.requests[0];
  console.log('① 的最后一个请求 和 ② 恢复后的第一个请求，逐条比较消息（只比较指纹）：\n');
  console.log('| # | 角色 | ① | ② | 相同吗 |');
  console.log('| --- | --- | --- | --- | --- |');
  const desc = (m: any) => m.blocks.map((x: any) => `${x.type}(${x.chars})`).join(' ');
  for (let i = 0; i < Math.max(a.messages.length, b.messages.length); i++) {
    const x = a.messages[i], y = b.messages[i];
    console.log(`| ${i} | ${x?.role ?? y?.role} | ${x ? desc(x) : '—'} | ${y ? desc(y) : '—'} | ${x && y && sig(x) === sig(y) ? '相同' : '**不同**'} |`);
  }
  const u = usage(b);
  console.log(`\n系统提示相同：${a.system.map((s: any) => s.hash).join() === b.system.map((s: any) => s.hash).join()}；工具定义相同：${a.toolsHash === b.toolsHash}`);
  console.log(`② 的第一个请求：输入 ${total(u)} token，其中 ${u.cache_read_input_tokens} 来自缓存（${Math.round((100 * u.cache_read_input_tokens) / total(u))}%）`);
  const extra = b.messages[3].blocks.at(-1);
  console.log(`唯一的不同：第 3 条消息末尾多了一个 ${extra.chars} 字符的文本块，第一行是“${extra.firstLine.slice(0, 56)}”`);
}

if (part === 'compact') {
  console.log('钩子的顺序和关键字段：\n');
  for (const h of two.hooks) {
    const p = h.payload;
    const info = p.source ? `source=${p.source}` : p.trigger ? `trigger=${p.trigger}${p.custom_instructions ? `，custom_instructions=“${p.custom_instructions}”` : ''}${p.compact_summary ? `，compact_summary（${String(p.compact_summary).match(/共 (\d+) 字符/)?.[1] ?? String(p.compact_summary).length} 字符）` : ''}` : p.load_reason ? `${p.file_path}（${p.load_reason}）` : '';
    console.log(`  ${h.event.padEnd(18)} ${info}`);
  }
  const boundary = two.events.find((e: any) => e.subtype === 'compact_boundary').compact_metadata;
  console.log(`\ncompact_boundary 事件：trigger=${boundary.trigger}，压缩前 ${boundary.pre_tokens} token → 压缩后 ${boundary.post_tokens} token，用时 ${boundary.duration_ms} ms`);
  const entries = new Map(two.transcripts[0].entries.filter((e: any) => e.uuid).map((e: any) => [e.uuid, e]));
  console.log('原样保留、不参与摘要的消息（preserved_messages）：');
  for (const id of boundary.preserved_messages.uuids) {
    const e: any = entries.get(id);
    console.log(`  ${id.slice(0, 8)}  ${e?.type}：${(e?.message?.content ?? []).map((b: any) => (b.type === 'text' ? `text “${b.text.replace(/\s+/g, ' ').slice(0, 30)}…”` : b.type)).join('、')}`);
  }
}

if (part === 'after') {
  const q = three.requests[0];
  const what = (m: any, i: number) => {
    const first = m.blocks[0]?.firstLine ?? '';
    if (i === 0 && first.startsWith('This session is being continued')) return '压缩摘要（以用户消息的身份）';
    if (m.role === 'assistant') return '压缩前的最后一条回复，原样保留';
    if (m.role === 'user') return '系统提醒（项目说明等，重新从磁盘读）+ /compact 命令的记录 + 新的提问';
    return '重新读取的文件 + 环境信息等';
  };
  console.log('| # | 角色 | 内容块 | 是什么 | 出现的金丝雀 |');
  console.log('| --- | --- | --- | --- | --- |');
  q.messages.forEach((m: any, i: number) => {
    const found = Object.entries(q.markers).filter(([, where]: any) => where.some((w: string) => w.startsWith(`messages[${i}]`))).map(([k]) => k);
    console.log(`| ${i} | ${m.role} | ${m.blocks.map((b: any) => `${b.type}(${b.chars})`).join(' ')} | ${what(m, i)} | ${found.join('、') || '—'} |`);
  });
  const u = usage(q);
  console.log(`\n这个请求输入 ${total(u)} token，缓存命中 ${u.cache_read_input_tokens}：开头变了，缓存几乎全部失效。`);
  const t = two.transcripts[0].entries;
  const start = t.findIndex((e: any) => e.subtype === 'compact_boundary');
  console.log('\n会话文件里，压缩边界之后追加的记录：');
  for (const e of t.slice(start)) {
    if (['queue-operation', 'atis-latch', 'last-prompt', 'cost-state', 'mode'].includes(e.type)) continue;
    const a = e.attachment;
    const extra = a?.type === 'file' ? `（${String(a.filename).split('/').slice(-2).join('/')}）` : e.isCompactSummary ? '（isCompactSummary）' : e.subtype === 'compact_boundary' ? `（parentUuid=${e.parentUuid}，logicalParentUuid=${String(e.logicalParentUuid).slice(0, 8)}）` : '';
    console.log(`  ${kind(e)}${extra}`);
  }
}
