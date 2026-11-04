// 第 2 章：录制里的 anthropic-beta 请求头，哪些在 2.1.88 的源码里能找到（离线运行）。
//   node labs/ch02/betas.ts
// 录制来自 Claude Code 2.1.296，源码是 2.1.88。对每一个 beta 名字，到固定提交里的 constants/betas.ts 查它是哪个常量；
// 找不到，说明这个功能是两个版本之间新增的。
import { execFileSync } from 'node:child_process';
import { loadRecording } from '../../lab/cc.ts';
import { SOURCE_DIR } from '../../lab/sourcemap.ts';
import { CC_SOURCE } from '../../course/syllabus.ts';

const first = loadRecording(new URL('../ch01/recorded/run.json', import.meta.url).pathname).requests.find((q: any) => q.path.startsWith('/v1/messages') && q.messages?.length);
const file = 'restored-src/src/constants/betas.ts';
const text = execFileSync('git', ['-C', SOURCE_DIR, 'show', `${CC_SOURCE.commit}:${file}`], { encoding: 'utf8' });

// 谁决定要不要发：这几条是读 utils/betas.ts 和 services/api/claude.ts 的结论。
const decidedBy: Record<string, string> = {
  'claude-code-20250219': '所有非 Haiku 模型都发（getAllModelBetas）',
  'interleaved-thinking-2025-05-14': '模型支持交错思考时发',
  'context-management-2025-06-27': '模型支持保留思考块时发；请求体里的 context_management 字段要有它才会写出',
  'prompt-caching-scope-2026-01-05': '第一方 API 一律发；没有 scope 字段时它什么也不做',
  'effort-2025-11-24': '模型支持 effort 参数时，由 configureEffortParams 加入',
};

console.log('| anthropic-beta | 2.1.88 里的常量 | 谁决定要不要发 |');
console.log('| --- | --- | --- |');
let missing = 0;
for (const beta of first.betas as string[]) {
  const at = text.indexOf(`'${beta}'`);
  const constant = at < 0 ? undefined : [...text.slice(0, at).matchAll(/export const (\w+)/g)].at(-1)?.[1];
  if (!constant) missing++;
  console.log(`| \`${beta}\` | ${constant ? `\`${constant}\`` : '**找不到**'} | ${constant ? (decidedBy[beta] ?? '（未展开）') : '2.1.88 之后新增'} |`);
}
console.log(`\n${first.betas.length} 个 beta 里有 ${missing} 个在 2.1.88 的源码里找不到。`);
