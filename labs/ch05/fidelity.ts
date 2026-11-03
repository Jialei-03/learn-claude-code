// 第 5 章：摘要忠实吗？把三处说法和文件的真实内容放在一起（离线分析）。
//   node labs/ch05/fidelity.ts
import { loadRecording } from '../../lab/cc.ts';

const load = (name: string) => loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname);
const [one, two, three] = ['1-read', '2-compact', '3-after'].map(load);
const truth: Record<string, string> = { 'a.js': 'EXPORT_ALPHA', 'b.js': 'EXPORT_BETA', 'c.js': 'EXPORT_GAMMA' };

// 从一段文字里找“文件 … EXPORT_X”的配对
const pairs = (text: string) => {
  const found: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const file = line.match(/\b([abc])\.js\b/)?.[1];
    const name = line.match(/EXPORT_[A-Z]+/)?.[0];
    if (file && name && !found[`${file}.js`]) found[`${file}.js`] = name;
  }
  return found;
};
const first = pairs(one.events.at(-1).result);
// 摘要的第 3 节（Files and Code Sections）里，文件路径在一行、代码在下一行
const summary: Record<string, string> = {};
two.summaryLines.forEach((l: string, i: number) => {
  const file = l.match(/src\/([abc])\.js`?$/)?.[1];
  const code = two.summaryLines[i + 1]?.match(/^export const (EXPORT_[A-Z]+)/)?.[1];
  if (file && code) summary[`${file}.js`] = code;
});
const after = three.events.at(-1).result as string;

console.log('| 文件 | 文件里真实的导出 | ① 第一次回答 | ② 摘要里“引用”的代码 |');
console.log('| --- | --- | --- | --- |');
for (const f of Object.keys(truth)) {
  const mark = (v?: string) => (v === truth[f] ? v : `**${v}** ✗`);
  console.log(`| src/${f} | ${truth[f]} | ${mark(first[f])} | ${mark(summary[f])} |`);
}
console.log(`\n摘要（${two.summaryChars} 字符）里关于 a.js 的原话：`);
const i = two.summaryLines.findIndex((l: string) => /src\/a\.js`?$/.test(l));
for (const l of two.summaryLines.slice(i, i + 3)) console.log(`  ${l}`);
// 按显示宽度折行（中文占两格），免得输出框横向滚动
const wrap = (line: string, width = 84) => {
  const out: string[] = [];
  let cur = '', w = 0;
  for (const token of line.match(/[\x21-\x7E]+|\s+|./gu) ?? []) {      // 英文单词不拆开
    const tw = [...token].reduce((n, ch) => n + (/[\u2E80-\uFFFF]/.test(ch) ? 2 : 1), 0);
    if (w + tw > width && cur) { out.push(cur); cur = ''; w = 0; }
    cur += token; w += tw;
  }
  return [...out, cur];
};
console.log('\n③ 压缩之后再问 c.js，模型的回答：');
const lines = after.split('\n').filter((l: string) => l.trim() && !l.startsWith('```')).map((l: string) => l.replace(/\*\*/g, ''));
console.log(lines.flatMap((l: string) => wrap(l)).map((l: string) => `  ${l}`).join('\n'));
