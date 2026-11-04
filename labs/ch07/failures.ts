// 第 7 章：钩子自己出了故障，Claude Code、mox 和 coda 各怎么处理（离线分析；mox 和 coda 一侧现场运行同一个钩子脚本）。
//   node labs/ch07/failures.ts
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadRecording } from '../../lab/cc.ts';
// @ts-ignore coda 是没有类型声明的 .mjs
import { Hooks, commandHook } from '../../coda/src/hooks.mjs';
import { interpret, runHooks } from '../../../learn-pi-agent/extensions/hooks/protocol.ts';

const r = loadRecording(new URL('./recorded/failures.json', import.meta.url).pathname);
const script = fileURLToPath(new URL('./failing-hook.mjs', import.meta.url));
const what: Record<string, string> = { case1: '退出码 1（脚本出错）', case2: 'stdout 不是 JSON', case3: '运行 5 秒，超时设 2 秒', case4: '退出码 2', case5: '正常，不输出' };
const calls = r.events.filter((e: any) => e.type === 'assistant').flatMap((e: any) => e.message.content).filter((b: any) => b.type === 'tool_use');
const results = new Map(r.events.filter((e: any) => e.type === 'user' && Array.isArray(e.message.content)).flatMap((e: any) => e.message.content).filter((b: any) => b.type === 'tool_result').map((b: any) => [b.tool_use_id, b]));
// 会话文件里，每次钩子运行都留下一条附件：hook_success、hook_non_blocking_error、hook_cancelled……
const attachments = r.transcripts[0].entries.filter((e: any) => e.attachment?.toolUseID).map((e: any) => e.attachment);

console.log('| 钩子的情况 | Claude Code | 会话文件里的记录 | mox | coda |');
console.log('| --- | --- | --- | --- | --- |');
for (const c of calls) {
  const tag = c.input.command.match(/case\d/)?.[0] ?? '';
  const res: any = results.get(c.id);
  const att = attachments.filter((a: any) => a.toolUseID === c.id && a.command?.includes('failing-hook') !== false && a.hookEvent === 'PreToolUse');
  const note = att.map((a: any) => `${a.type}${a.timedOut ? `（${a.durationMs} ms 时被取消）` : a.exitCode !== undefined ? `（退出码 ${a.exitCode}）` : ''}`).join('、') || '—';
  // mox 和 coda 同时运行同一个脚本（超时都是 2 秒）
  const coda = new Hooks([{ event: 'PreToolUse', matcher: 'Bash', run: commandHook(script, { timeout: 2000 }) }]);
  const [runs, verdict] = await Promise.all([
    runHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${script}`, timeout: 2 }] }] }, 'PreToolUse', { tool_name: 'Bash', tool_input: c.input }, { cwd: process.cwd(), projectDir: process.cwd(), toolName: 'Bash' }),
    coda.before({ id: c.id, name: 'Bash', input: c.input }, {}),
  ]);
  const v = interpret('PreToolUse', runs);
  // 三方必须一致：只有退出码 2 拦下调用
  assert.equal(Boolean(verdict.block), Boolean(res?.is_error), `${what[tag]}：coda 与 Claude Code 的录制不一致`);
  assert.equal(Boolean(v.block), Boolean(res?.is_error), `${what[tag]}：mox 与 Claude Code 的录制不一致`);
  const kind = coda.log[0].outcome;
  console.log(`| ${what[tag]} | ${res?.is_error ? '**被阻止**' : '照常执行'} | ${note} | ${v.block ? '**被阻止**' : '照常执行'}${v.notices.length ? '，并提示钩子出错' : ''} | ${verdict.block ? '**被阻止**' : '照常执行'}（${kind}） |`);
}
