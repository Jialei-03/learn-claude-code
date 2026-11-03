// 第 6 章：规则和 PreToolUse 钩子意见不同时，听谁的（离线分析）。
//   node labs/ch06/hooks.ts
import { calls, load, short } from './calls.ts';

const r = load('hooks');
const ruleSays = (cmd: string) => (cmd.startsWith('touch') ? 'deny：`Bash(touch *)`' : cmd.startsWith('echo') ? 'allow：`Bash(echo *)`' : '没有规则（默认要问）');
const hookSays = (cmd: string) => (cmd.includes('danger') ? 'deny' : /^(touch|mkdir)\b/.test(cmd) ? 'allow' : '不表态');
console.log('| 命令 | 规则 | 钩子 | 结果 | 谁决定的（source） |');
console.log('| --- | --- | --- | --- | --- |');
for (const c of calls(r)) {
  const cmd = c.input.command;
  console.log(`| \`${cmd}\` | ${ruleSays(cmd)} | ${hookSays(cmd)} | ${c.decision?.decision === 'accept' ? '✓ 执行了' : `✗ ${short(c.result, 46)}`} | ${c.decision?.source}${c.decision?.reason_type ? ` / ${c.decision.reason_type}` : ''} |`);
}
