// 第 2 章：2.1.296 的会话文件里，每条附件以什么身份进入请求（离线运行）。
//   node labs/ch02/attachments.ts
// 第 1 章那次运行留下的会话文件里，除了对话，还有一批 attachment 记录：它们不是用户或模型说的话，
// 是 Claude Code 在每次请求前塞进去的背景信息。渲染后的结果写在 rendered / renderedRole 里。
import { loadRecording } from '../../lab/cc.ts';

const r = loadRecording(new URL('../ch01/recorded/run.json', import.meta.url).pathname);
const t = r.transcripts.find((x: any) => !x.file.includes('/subagents/'));
const attachments = t.entries.filter((e: any) => e.type === 'attachment' && e.attachment?.type !== 'prompt_snapshot');

// 第一条有内容的行，去掉 <system-reminder> 标签本身
const head = (e: any) => {
  const text: string = e.rendered?.[0]?.content ?? '';
  return (text.split('\n').map(l => l.trim()).find(l => l && l !== '<system-reminder>') ?? '').slice(0, 42);
};
const rows = new Map<string, { n: number; role: string; head: string }>();
for (const e of attachments) {
  const type = e.attachment.type;
  const row = rows.get(type) ?? { n: 0, role: e.renderedRole ? `${e.renderedRole}` : '（不进入请求）', head: head(e) };
  row.n++;
  rows.set(type, row);
}
console.log(`会话文件里共 ${t.entries.length} 行，其中 ${attachments.length} 行是附件（不含 prompt_snapshot）：\n`);
console.log('| 附件类型 | 条数 | 以什么角色进入请求 | 渲染后的第一行 |');
console.log('| --- | --- | --- | --- |');
for (const [type, row] of rows) console.log(`| ${type} | ${row.n} | ${row.role} | ${row.head ? '`' + row.head.replace(/\|/g, '\\|') + '`' : '—'} |`);
