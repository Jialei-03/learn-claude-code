// 第 3 章：每一次工具调用的输入、结果，以及钩子有没有看到它（离线分析）。
//   node labs/ch03/tools.ts [calls|shapes]
import { loadRecording } from '../../lab/cc.ts';

const r = loadRecording(new URL('./recorded/tools.json', import.meta.url).pathname);
const calls = r.events.flatMap((e: any) => (e.type === 'assistant' ? e.message.content.filter((b: any) => b.type === 'tool_use') : []));
const results = new Map<string, any>(r.events.flatMap((e: any) => (e.type === 'user' ? e.message.content.filter((b: any) => b.type === 'tool_result').map((b: any) => [b.tool_use_id, b]) : [])));
const hooksFor = (id: string) => r.hooks.filter((h: any) => h.payload.tool_use_id === id).map((h: any) => h.event);
const text = (b: any) => (typeof b?.content === 'string' ? b.content : JSON.stringify(b?.content ?? '')).replace(/<\/?tool_use_error>/g, '');
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ').replace(/\|/g, '\\|');
const part = process.argv[2] ?? 'calls';

if (part === 'calls') {
  console.log('| # | 调用 | 结果 | 钩子看到了吗 |');
  console.log('| --- | --- | --- | --- |');
  calls.forEach((c: any, i: number) => {
    const res = results.get(c.id);
    const input = c.name === 'Edit' ? `Edit "${c.input.old_string}" → "${c.input.new_string}"（${c.input.file_path.split('/').pop()}）` : c.name === 'Bash' ? `Bash \`${c.input.command}\`` : `${c.name} ${c.input.file_path.split('/').pop()}`;
    const hooks = hooksFor(c.id);
    console.log(`| ${i + 1} | ${input} | ${res?.is_error ? '**错误**：' : '成功：'}${short(text(res), 70)} | ${hooks.length ? hooks.join('、') : '**没有**'} |`);
  });
}

if (part === 'shapes') {
  console.log('PostToolUse 钩子收到的 tool_response（结构化的工具结果，模型看到的是另一份文本）：\n');
  const seen = new Set<string>();
  for (const h of r.hooks.filter((h: any) => h.event === 'PostToolUse')) {
    const name = h.payload.tool_name;
    if (seen.has(name)) continue;
    seen.add(name);
    const tr = h.payload.tool_response;
    const shape = (v: any): string => (Array.isArray(v) ? `[${v.length ? shape(v[0]) : ''}]` : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'object' && x ? shape(x) : typeof x}`).join(', ')} }` : typeof v);
    console.log(`${name}：${shape(tr)}`);
  }
}
