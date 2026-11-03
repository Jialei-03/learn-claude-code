// 第 10 章：子 Agent（需要模型服务）。
// 父 Agent 同时派出两个子 Agent：一个是项目里自定义的 reviewer，一个是内置的 Explore。
//   fg —— 前台：父 Agent 等两个子 Agent 都完成，结果作为工具结果返回
//   bg —— 后台：子 Agent 在后台运行，父 Agent 先拿到“已启动”，结果稍后以通知送达
//   node labs/ch10/record.ts [fg|bg]
import { runClaude, saveRecording } from '../../lab/cc.ts';

// #region files
export const FILES = {
  'CLAUDE.md': 'CANARY-SUBAGENT-CLAUDEMD：本项目的代码注释用中文。\n',
  '.claude/agents/reviewer.md': [
    '---',
    'name: reviewer',
    'description: CANARY-AGENT-DESC 只读的代码审查员。用户要求审查代码时使用。',
    'tools: Read, Grep, Glob',
    'model: inherit',
    '---',
    'CANARY-AGENT-PROMPT 你是一名严格的代码审查员。只报告问题，每个问题一行：文件:行号 问题。',
  ].join('\n'),
  'src/math.js': 'export function average(xs) {\n  let sum = 0;\n  for (let i = 0; i <= xs.length; i++) sum += xs[i];\n  return sum / xs.length;\n}\n\nexport function max(xs) {\n  return Math.max(xs);\n}\n',
  'src/text.js': 'export function title(s) {\n  return s[0].toUpperCase() + s.slice(1);\n}\nexport const VERSION = "1.0";\n',
};
const TASK = '（暗号 CANARY-PARENT-ONLY，只有你知道）请同时派两个子 Agent：一个用 reviewer 审查 src/math.js；另一个用 Explore 找出 src/ 下所有导出的名字。';
export const PROMPTS = {
  fg: `${TASK}两个都在前台运行（run_in_background 设为 false），都完成后汇总它们的结果。`,
  bg: `${TASK}两个都放到后台运行（run_in_background 设为 true）；它们完成后汇总结果。`,
};
// #endregion
// 后四个用来找子 Agent 的结果在父 Agent 的哪条消息里：审查报告会提到 NaN；通知里可能带着输出文件的路径
export const MARKERS = ['CANARY-SUBAGENT-CLAUDEMD', 'CANARY-AGENT-DESC', 'CANARY-AGENT-PROMPT', 'CANARY-PARENT-ONLY', 'i <= xs.length', 'NaN', 'task-notification', '.output', 'agentId'];

const which = process.argv[2];
for (const mode of ['fg', 'bg'] as const) {
  if (which && which !== mode) continue;
  const r = await runClaude({
    prompt: PROMPTS[mode], files: FILES, args: ['--permission-mode', 'default'],
    hookEvents: ['SubagentStart', 'SubagentStop', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'],
    settings: { permissions: { allow: ['Agent'] } },
  });
  saveRecording(new URL(`./recorded/${mode}.json`, import.meta.url).pathname, r, { prompt: PROMPTS[mode] }, MARKERS);
  console.log(`${mode}：请求 ${r.requests.length} 个，会话文件 ${r.transcripts.length} 个；${String(r.events.at(-1)?.result ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
}
