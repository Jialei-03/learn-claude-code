// 第 3 章：并行调用的结果按什么顺序回到请求里，模型又是怎么对上号的（离线分析）。
//   node labs/ch03/order.ts
import { loadRecording } from '../../lab/cc.ts';

const name = (input: string) => input.match(/src\/(\w)\.js/)?.[1] ?? '?';
console.log('| 运行 | 模型发出调用的顺序 | 请求里结果的顺序 | 会话文件里的先后 | 回答（文件 → 导出） |');
console.log('| --- | --- | --- | --- | --- |');
for (let i = 1; i <= 3; i++) {
  const r = loadRecording(new URL(`./recorded/order-${i}.json`, import.meta.url).pathname);
  const last = r.requests.at(-1);
  const uses = last.messages.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool_use'));
  const fileOf = new Map(uses.map((b: any) => [b.ref, name(b.input)]));
  const results = last.messages.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool_result')).map((b: any) => fileOf.get(b.ref));
  // 会话文件按发生的先后记录：调用和结果交错在一起
  const t = r.transcripts[0].entries;
  const seq = t.flatMap((e: any) => (Array.isArray(e.message?.content) ? e.message.content : []).flatMap((b: any) =>
    b.type === 'tool_use' ? [`调${name(JSON.stringify(b.input))}`] : b.type === 'tool_result' ? [`果${fileOf.get(String(b.tool_use_id).slice(-6))}`] : []));
  const answer: string = r.events.at(-1)?.result ?? '';
  const pairs = [...answer.matchAll(/src\/(\w)\.js`?\s*[→:：-]+\s*`?X_(\w)/g)].map(m => `${m[1]}→${m[2]}`);
  const wrong = pairs.some(p => p[0].toUpperCase() !== p.at(-1));
  console.log(`| ${i} | ${uses.map((b: any) => name(b.input)).join(' ')} | ${results.join(' ')} | ${seq.join(' ')} | ${pairs.join('，')}${wrong ? ' **错**' : ' 对'} |`);
}
