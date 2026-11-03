// 第 7 章：钩子自己出了故障，Claude Code 和 mox 各怎么处理（离线分析；mox 一侧现场运行同一个钩子脚本）。
//   node labs/ch07/failures.ts
import { fileURLToPath } from 'node:url';
import { loadRecording } from '../../lab/cc.ts';
import { interpret, runHooks } from '../../../learn-pi-agent/extensions/hooks/protocol.ts';

const r = loadRecording(new URL('./recorded/failures.json', import.meta.url).pathname);
const script = fileURLToPath(new URL('./failing-hook.mjs', import.meta.url));
const what: Record<string, string> = { case1: '退出码 1（脚本出错）', case2: 'stdout 不是 JSON', case3: '运行 5 秒，超时设 2 秒', case4: '退出码 2', case5: '正常，不输出' };
const calls = r.events.filter((e: any) => e.type === 'assistant').flatMap((e: any) => e.message.content).filter((b: any) => b.type === 'tool_use');
const results = new Map(r.events.filter((e: any) => e.type === 'user' && Array.isArray(e.message.content)).flatMap((e: any) => e.message.content).filter((b: any) => b.type === 'tool_result').map((b: any) => [b.tool_use_id, b]));
// 会话文件里，每次钩子运行都留下一条附件：hook_success、hook_non_blocking_error、hook_cancelled……
const attachments = r.transcripts[0].entries.filter((e: any) => e.attachment?.toolUseID).map((e: any) => e.attachment);

console.log('| 钩子的情况 | Claude Code | 会话文件里的记录 | mox |');
console.log('| --- | --- | --- | --- |');
for (const c of calls) {
  const tag = c.input.command.match(/case\d/)?.[0] ?? '';
  const res: any = results.get(c.id);
  const att = attachments.filter((a: any) => a.toolUseID === c.id && a.command?.includes('failing-hook') !== false && a.hookEvent === 'PreToolUse');
  const note = att.map((a: any) => `${a.type}${a.timedOut ? `（${a.durationMs} ms 时被取消）` : a.exitCode !== undefined ? `（退出码 ${a.exitCode}）` : ''}`).join('、') || '—';
  const runs = await runHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${script}`, timeout: 2 }] }] }, 'PreToolUse', { tool_name: 'Bash', tool_input: c.input }, { cwd: process.cwd(), projectDir: process.cwd(), toolName: 'Bash' });
  const v = interpret('PreToolUse', runs);
  console.log(`| ${what[tag]} | ${res?.is_error ? '**被阻止**' : '照常执行'} | ${note} | ${v.block ? '**被阻止**' : '照常执行'}${v.notices.length ? '，并提示钩子出错' : ''} |`);
}
