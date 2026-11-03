// 第 1 章：读 Claude Code 留下的会话文件（离线运行）。
//   node labs/ch01/transcript.ts
import { loadRecording } from '../../lab/cc.ts';

const r = loadRecording(new URL('./recorded/run.json', import.meta.url).pathname);
const t = r.transcripts.find((x: any) => !x.file.includes('/subagents/'));
console.log(`会话文件：${t.file}（${t.entries.length} 行，每行一条 JSON）\n`);

const kind = (e: any) => (e.type === 'attachment' ? `attachment:${e.attachment?.type}` : e.type);
const counts = new Map<string, number>();
for (const e of t.entries) counts.set(kind(e), (counts.get(kind(e)) ?? 0) + 1);
console.log('| 记录类型 | 条数 |');
console.log('| --- | --- |');
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`| ${k} | ${n} |`);

// 沿着 parentUuid 从最后一条往回走，就是当前分支上的对话
const byId = new Map(t.entries.filter((e: any) => e.uuid).map((e: any) => [e.uuid, e]));
const leaf = [...t.entries].reverse().find((e: any) => e.type === 'last-prompt')?.leafUuid ?? [...t.entries].reverse().find((e: any) => e.uuid)?.uuid;
const path: any[] = [];
for (let e: any = byId.get(leaf); e; e = byId.get(e.parentUuid)) path.unshift(e);
const label = (e: any) => {
  if (e.type === 'attachment') return `附件 ${e.attachment?.type}${e.renderedRole ? `（以 ${e.renderedRole} 身份进入请求）` : '（不进入请求）'}`;
  const c = e.message?.content;
  if (e.type === 'user') return typeof c === 'string' ? `用户：${c.slice(0, 40)}` : Array.isArray(c) && c[0]?.type === 'tool_result' ? `工具结果${e.permissionDecision ? `（权限：${typeof e.permissionDecision === 'string' ? e.permissionDecision : JSON.stringify(e.permissionDecision).slice(0, 40)}）` : ''}` : `用户：${(c?.find?.((b: any) => b.type === 'text')?.text ?? '').slice(0, 40)}`;
  if (e.type === 'assistant') return `助手的第 ${e.apiBlockIndex ?? 0} 个内容块：${c?.map((b: any) => (b.type === 'tool_use' ? `调用 ${b.name}` : b.type)).join('、')}`;
  return e.type;
};
console.log(`\n从叶子（last-prompt 记录的 leafUuid）沿 parentUuid 往回走，当前分支上有 ${path.length} 条记录：`);
for (const e of path) console.log(`  ${e.uuid.slice(0, 8)} ← ${String(e.parentUuid ?? 'null').slice(0, 8)}  ${label(e)}`);
