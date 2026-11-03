// 第 6 章：自动模式的安全分类器——它审查了哪些动作、看到了什么、怎样下结论（离线分析）。
//   node labs/ch06/classifier.ts [flow|request]
import { calls, load, short } from './calls.ts';

const r = load('classifier');
const part = process.argv[2] ?? 'flow';
// 分类器的请求：没有工具定义，消息是 <transcript> … </transcript> 加一段阶段说明
const isClassifier = (q: any) => !q.tools.length && q.messages.some((m: any) => m.blocks.some((b: any) => b.firstLine === '<transcript>'));
const transcriptOf = (q: any) => {
  const blocks = q.messages.at(-1).blocks;
  const start = blocks.findIndex((b: any) => b.firstLine === '<transcript>');
  const end = blocks.findIndex((b: any) => b.firstLine === '</transcript>');
  return { entries: blocks.slice(start + 1, end), after: blocks[end + 1] };
};
const verdict = (q: any) => {
  const t = q.response?.text ?? '';
  if (/<block>\s*no/.test(t)) return '放行';
  if (!t && q.response?.stopReason === 'max_tokens') return '没有结论（思考用完了 max_tokens）';
  if (/<block>\s*yes/.test(t)) return `**拦截** ${t.match(/<category>(.*?)<\/category>/)?.[1] ?? ''}`;
  return q.response?.stopReason === 'max_tokens' ? '没有结论（思考用完了 max_tokens）' : '—';
};

if (part === 'flow') {
  const list = calls(r);
  console.log('主循环里的每个工具调用，以及分类器为它发出的请求：\n');
  console.log('| # | 调用 | 分类器请求（max_tokens → 结论） | 最终 |');
  console.log('| --- | --- | --- | --- |');
  // 同一个动作的请求（重试、第二阶段）transcript 条数相同；每多审查一个动作，transcript 多一条
  const groups: any[][] = [];
  for (const q of r.requests.filter(isClassifier)) {
    const n = transcriptOf(q).entries.length;
    if (groups.at(-1)?.[0] && transcriptOf(groups.at(-1)![0]).entries.length === n) groups.at(-1)!.push(q); else groups.push([q]);
  }
  let k = 0;
  list.forEach((c, i) => {
    const last = groups[k] ? transcriptOf(groups[k][0]).entries.at(-1)?.firstLine ?? '' : '';
    const mine: any[] = c.name === 'Bash' && last.includes(JSON.stringify(String(c.input.command)).slice(1, 21)) ? groups[k++] : [];
    const d = c.decision;
    const final = d?.decision === 'accept' ? `✓ ${d.reason_type === 'classifier' ? '分类器放行' : d.reason_type === 'mode' ? '不需要审查' : '只读命令'}` : `✗ ${short(c.result, 40)}`;
    // 连续相同的结论合并成“×n”
    const lines: string[] = [];
    for (const q of mine) {
      const line = `${q.maxTokens} → ${verdict(q)}`;
      const prev = lines.at(-1)?.match(/^(.*?)(?: ×(\d+))?$/);
      if (prev && prev[1] === line) lines[lines.length - 1] = `${line} ×${Number(prev[2] ?? 1) + 1}`; else lines.push(line);
    }
    const what = c.name === 'Bash' ? `\`${short(String(c.input.command), 46).replace(/`/g, "'")}\`` : `${c.name} ${String(c.input.file_path).replace('<project>/', '')}`;
    console.log(`| ${i + 1} | ${what} | ${lines.join('<br>') || '—'} | ${final} |`);
  });
  console.log(`\n触发 PermissionDenied 钩子 ${r.hooks.filter((h: any) => h.event === 'PermissionDenied').length} 次。`);
}

if (part === 'request') {
  const q = r.requests.filter(isClassifier).at(-1);
  const sys = q.system.map((s: any) => `${s.chars} 字符${s.cache ? '（缓存）' : ''}`).join(' + ');
  console.log(`最后一次分类器请求（第 ${q.id} 个）：模型 ${q.model}，max_tokens ${q.maxTokens}，不带工具定义`);
  console.log(`系统提示：${sys}；第一行：“${q.system.at(-1).firstLine}”`);
  console.log('\n消息：');
  q.messages.forEach((m: any, i: number) => {
    console.log(`  [${i}] ${m.role}`);
    for (const b of m.blocks) console.log(`      ${String(b.chars).padStart(5)} 字符  ${(b.firstLine ?? '').slice(0, 76)}`);
  });
  console.log('\n金丝雀出现在哪里：');
  const main = r.requests.find((x: any) => x.tools.length && x.markers?.['CANARY-README-CONTENT']);
  for (const m of ['CANARY-CLASSIFIER-CLAUDEMD', 'CANARY-README-CONTENT']) console.log(`  ${m.padEnd(28)} 主循环：${main.markers[m] ? '有' : '没有'}    分类器：${q.markers?.[m] ? '有' : '**没有**'}`);
  const u = q.response?.usage ?? {};
  console.log(`\n用量：读缓存 ${u.cache_read_input_tokens ?? 0}、新输入 ${u.input_tokens ?? 0}、输出 ${u.output_tokens ?? 0} token`);
}
