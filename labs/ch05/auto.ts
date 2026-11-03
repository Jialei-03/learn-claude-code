// 第 5 章：自动压缩的时间线，以及“压缩完又满了”时 Claude Code 怎么办（离线分析）。
//   node labs/ch05/auto.ts [timeline|thrash]
import { loadRecording } from '../../lab/cc.ts';

const load = (name: string) => loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname);
const part = process.argv[2] ?? 'timeline';
const total = (u: any = {}) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
const short = (k: string) => k.replace('_299', '');

/** 给每个请求分类：主循环、压缩、数 token、安全分类器（第 6 章） */
function classify(q: any) {
  if (q.path.includes('count_tokens')) return { kind: 'count', label: `数 token：${short(Object.keys(q.markers ?? {})[0] ?? '?')}.js 的内容` };
  if (!q.tools.length) return { kind: 'classifier', label: `自动模式的安全分类器（max_tokens ${q.maxTokens}，第 6 章）` };
  const last = q.messages.at(-2)?.blocks.at(-1);
  if (last?.firstLine?.startsWith('CRITICAL: Respond with TEXT ONLY')) return { kind: 'compact', label: '**压缩**：上一个请求原样重发，末尾追加压缩指令' };
  return { kind: 'main', label: '' };
}

if (part === 'timeline') {
  const r = load('4-auto');
  const threshold = r.window - 32000;
  console.log(`窗口设为 ${r.window}（CLAUDE_CODE_MAX_CONTEXT_TOKENS），每个请求的 max_tokens 是 32000。\n`);
  console.log('| # | 请求 | 消息数 | 输入 token | 上下文里有全文的文件 | 只在摘要里提到的 |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  let seen: string[] = [];
  for (const q of r.requests) {
    const c = classify(q);
    if (c.kind !== 'main') { console.log(`| ${q.id} | ${c.label} | ${q.messages.length} | ${c.kind === 'compact' ? total(q.response?.usage) : '—'} | | |`); continue; }
    const summarized = (q.messages[0].blocks[0].firstLine ?? '').startsWith('This session is being continued');
    // 文件的全文只会出现在工具结果里（用户消息）；摘要是第 0 条消息
    const where = Object.entries<string[]>(q.markers ?? {}).map(([k, w]) => [short(k), w.filter(x => x.endsWith('(user)') && !(summarized && x.startsWith('messages[0]')))] as const);
    const full = where.filter(([, w]) => w.length).map(([f]) => f);
    const mentioned = where.filter(([, w]) => !w.length).map(([f]) => f);
    console.log(`| ${q.id} | 主循环${summarized ? '（开头是摘要）' : ''} | ${q.messages.length} | ${total(q.response?.usage)} | ${full.map(f => (seen.includes(f) ? f : `**${f}**`)).join(' ') || '—'} | ${mentioned.join(' ') || ''} |`);
    seen = [...full, ...mentioned];
  }
  const b = r.events.find((e: any) => e.subtype === 'compact_boundary').compact_metadata;
  console.log(`\n观察到的阈值 ≈ 窗口 − max_tokens = ${r.window} − 32000 = ${threshold}。第 8 个请求之后读入 delta.js，上下文估计到 ${b.pre_tokens}，超过阈值，于是在发下一个请求之前压缩。`);
  console.log(`compact_boundary：trigger=${b.trigger}，压缩前 ${b.pre_tokens} → 压缩后 ${b.post_tokens} token；原样保留 ${b.preserved_messages.uuids.length} 条消息`);
  const t = r.transcripts[0].entries;
  const start = t.findIndex((e: any) => e.subtype === 'compact_boundary');
  const refs = t.slice(start).filter((e: any) => e.attachment?.type === 'compact_file_reference').map((e: any) => e.attachment.displayPath);
  console.log(`压缩之后附上的“文件引用”（compact_file_reference，只有文件名、没有内容）：${refs.join('、')}`);
  console.log(`钩子：${r.hooks.map((h: any) => `${h.event}(${h.payload.trigger ?? h.payload.source})`).join(' → ')}`);
  console.log(`结果：${r.events.at(-1).terminal_reason}，${String(r.events.at(-1).result).match(/总[数计][^\n]*/)?.[0].replace(/\*/g, '') ?? ''}`);
}

if (part === 'thrash') {
  const r = load('5-thrash');
  console.log(`窗口设为 ${r.window}。每压缩一次，模型接着读下一个文件（约 8K token），上下文立刻又超过阈值：\n`);
  const bounds = r.events.filter((e: any) => e.subtype === 'compact_boundary').map((e: any) => e.compact_metadata);
  const summaries = r.requests.filter((q: any) => classify(q).kind === 'main' && q.messages[0].blocks[0].firstLine?.startsWith('This session is being continued'));
  const firsts = summaries.filter((q: any, i: number, all: any[]) => i === 0 || q.messages[0].blocks[0].chars !== all[i - 1].messages[0].blocks[0].chars);
  console.log('| 第几次压缩 | 压缩前 token | 压缩后 token | 新摘要的长度（字符） | 累计丢弃的 token |');
  console.log('| --- | --- | --- | --- | --- |');
  bounds.forEach((b: any, i: number) => console.log(`| ${i + 1} | ${b.pre_tokens} | ${b.post_tokens} | ${firsts[i]?.messages[0].blocks[0].chars ?? '—'} | ${b.cumulative_dropped_tokens} |`));
  const end = r.events.at(-1);
  console.log(`\n结果：is_error=${end.is_error}，terminal_reason=${end.terminal_reason}`);
  console.log(`给用户的说明：“${String(end.result).split('. ')[0]}.”`);
}
