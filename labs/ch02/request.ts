// 第 2 章：Claude Code 发给模型的请求长什么样（离线分析第 1 章录制的请求摘要）。
//   node labs/ch02/request.ts [overview|tools|messages|cache]
import { loadRecording } from '../../lab/cc.ts';

const r = loadRecording(new URL('../ch01/recorded/run.json', import.meta.url).pathname);
const reqs = r.requests.filter((q: any) => q.path.startsWith('/v1/messages') && q.messages?.length);
const first = reqs[0];
const part = process.argv[2] ?? 'overview';

if (part === 'overview') {
  console.log(`这次运行一共发了 ${reqs.length} 个请求，都是 POST ${first.path}\n`);
  console.log('| 字段 | 第一个请求里的值 |');
  console.log('| --- | --- |');
  console.log(`| model | ${first.model} |`);
  console.log(`| max_tokens | ${first.maxTokens} |`);
  console.log(`| thinking | \`${JSON.stringify(first.thinking)}\` |`);
  console.log(`| output_config | \`${JSON.stringify(first.outputConfig)}\` |`);
  console.log(`| context_management | \`${JSON.stringify(first.contextManagement)}\` |`);
  console.log(`| tools | ${first.tools.length} 个，定义共 ${first.toolsChars} 个字符 |`);
  console.log(`| messages | ${first.messages.length} 条 |`);
  console.log(`| user-agent | \`${first.userAgent}\` |`);
  console.log(`\nanthropic-beta 请求头（启用的测试功能）：\n${first.betas.map((b: string) => `  ${b}`).join('\n')}`);
  console.log(`\n系统提示（system 字段）分成 ${first.system.length} 块：`);
  console.log('| 块 | 字符数 | 缓存标记 | 小节标题 | 第一行 |');
  console.log('| --- | --- | --- | --- | --- |');
  first.system.forEach((s: any, i: number) => console.log(`| ${i + 1} | ${s.chars} | ${s.cache ? '有' : '—'} | ${s.headings.join('、') || '—'} | ${s.firstLine.replace(/\|/g, '\\|')} |`));
}

if (part === 'tools') {
  console.log('| 工具 | 描述字符数 | 参数（加粗的必填） |');
  console.log('| --- | --- | --- |');
  for (const t of [...first.tools].sort((a: any, b: any) => b.descChars - a.descChars)) {
    console.log(`| ${t.name} | ${t.descChars} | ${t.params.map((p: string) => (t.required.includes(p) ? `**${p}**` : p)).join(', ')} |`);
  }
  const total = first.tools.reduce((n: number, t: any) => n + t.descChars, 0);
  const sys = first.system.reduce((n: number, s: any) => n + s.chars, 0);
  console.log(`\n工具描述合计 ${total} 个字符；系统提示合计 ${sys} 个字符。工具定义（含参数 schema）是系统提示的 ${(first.toolsChars / sys).toFixed(1)} 倍。`);
}

if (part === 'messages') {
  const last = reqs.at(-1);
  console.log(`最后一个请求的 messages（共 ${last.messages.length} 条）：\n`);
  console.log('| # | role | 内容块 |');
  console.log('| --- | --- | --- |');
  last.messages.forEach((m: any, i: number) => {
    const blocks = m.blocks.map((b: any) => `${b.type}${b.name ? ` ${b.name}` : ''}（${b.chars} 字符${b.cache ? '，缓存标记' : ''}）${b.firstLine && m.role !== 'assistant' ? `：${b.firstLine.slice(0, 40).replace(/\|/g, '\\|')}` : ''}`).join('<br>');
    console.log(`| ${i} | ${m.role} | ${blocks} |`);
  });
}

if (part === 'cache') {
  console.log('| 请求 | messages 条数 | 缓存标记在第几条 | 输入 token | 读缓存 | 写缓存 | 命中率 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const q of reqs) {
    const marks = q.messages.flatMap((m: any, i: number) => (m.blocks.some((b: any) => b.cache) ? [i] : []));
    const u = q.response?.usage ?? {};
    const input = u.input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
    console.log(`| ${q.id} | ${q.messages.length} | ${marks.join('、') || '—'} | ${input} | ${read} | ${write} | ${input + read + write ? Math.round((read / (input + read + write)) * 100) + '%' : '—'} |`);
  }
}
