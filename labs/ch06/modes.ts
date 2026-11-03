// 第 6 章：同样五个动作，在六种权限模式下的结果（离线分析）。
//   node labs/ch06/modes.ts
import { calls, load } from './calls.ts';

const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const LABELS = ['Read README.md', 'Write out.txt', '`mkdir build`', '`node -e …`', 'Write .vscode/settings.json'];
const runs = MODES.map(m => calls(load(`mode-${m}`)));
// 第几步：按调用的参数对上（计划模式下模型还多写了一份计划文件）
const stepOf = (c: any) => {
  const s = `${c.input.file_path ?? ''} ${c.input.command ?? ''}`;
  return s.includes('README.md') ? 0 : s.includes('out.txt') ? 1 : s.includes('mkdir build') ? 2 : s.includes('node -e') ? 3 : s.includes('.vscode') ? 4 : -1;
};
const cell = (c: any) => {
  if (!c) return '—';
  if (c.decision?.decision === 'accept') return `✓ ${c.decision.reason_type === 'classifier' ? '**分类器**' : c.decision.reason_type === 'mode' ? '模式' : c.decision.reason_type === 'subcommandResults' ? '命令规则' : c.decision.reason_type ?? ''}`;
  if (/plan mode/.test(c.result)) return '✗ 计划模式拒绝';
  if (c.hooks.includes('PermissionRequest')) return '✗ 要问';
  return `✗ ${c.decision?.reason_type === 'mode' ? '模式拒绝' : '拒绝'}`;
};
console.log(`| 动作 | ${MODES.join(' | ')} |`);
console.log(`| --- | ${MODES.map(() => '---').join(' | ')} |`);
LABELS.forEach((label, i) => console.log(`| ${label} | ${runs.map(list => cell(list.find(c => stepOf(c) === i))).join(' | ')} |`));
const extra = runs[MODES.indexOf('plan')].filter(c => stepOf(c) === -1);
for (const c of extra) console.log(`\n计划模式下模型还调用了 ${c.name}：${String(c.input.file_path).replace(/[^/]+\.md$/, '<名字>.md')}（${c.decision?.decision}）`);
console.log('\n✗ 要问：这个动作触发了 PermissionRequest 钩子——交互模式下会弹出确认；-p 模式下没有人回答，等于拒绝。');
