// 第 5 章：同一个会话恢复两次——一次手动压缩，一次压缩之后继续提问（需要模型服务）。
//   node labs/ch05/record.ts
import { runClaude, saveRecording } from '../../lab/cc.ts';

export const MARKERS = ['CANARY-ROOT-CLAUDEMD', 'EXPORT_ALPHA', 'EXPORT_BETA', 'EXPORT_GAMMA', 'CANARY-SUBDIR-RULE'];
const pad = (n: number) => Array.from({ length: n }, (_, i) => `// 填充第 ${i + 1} 行，让文件有一定的长度`).join('\n');
const files = {
  'CLAUDE.md': 'CANARY-ROOT-CLAUDEMD：回答时注明文件名。\n',
  'src/CLAUDE.md': 'CANARY-SUBDIR-RULE：src 下的文件都是 ES 模块。\n',
  'src/a.js': `${pad(40)}\nexport const EXPORT_ALPHA = 1;\n`,
  'src/b.js': `${pad(40)}\nexport const EXPORT_BETA = 2;\n`,
  'src/c.js': `${pad(40)}\nexport const EXPORT_GAMMA = 3;\n`,
};
const hookEvents = ['SessionStart', 'PreCompact', 'PostCompact', 'InstructionsLoaded'];

const one = await runClaude({ prompt: '分别读 src/a.js、src/b.js、src/c.js，告诉我它们各自导出了什么。', files, hookEvents });
const sessionId = one.events.find(e => e.subtype === 'init').session_id;
saveRecording(new URL('./recorded/1-read.json', import.meta.url).pathname, one, { prompt: '读三个文件' }, MARKERS);
console.log(`① 会话 ${sessionId}：请求 ${one.requests.length} 个`);

const two = await runClaude({ prompt: '/compact 重点保留每个文件导出了什么', args: ['--resume', sessionId], reuse: { cwd: one.cwd, configDir: one.configDir }, hookEvents });
// 摘要是实验模型写的（不是 Anthropic 的文字），保存其中提到文件和导出的那几行，用来核对摘要是否忠实
const summary: string = two.transcripts.flatMap(t => t.entries).find(e => e.isCompactSummary)?.message.content ?? '';
const summaryLines = summary.split('\n').map(l => l.trim()).filter(l => /EXPORT_|src\/\w\.js/.test(l));
saveRecording(new URL('./recorded/2-compact.json', import.meta.url).pathname, two, { prompt: '/compact 重点保留每个文件导出了什么', summaryChars: summary.length, summaryLines }, MARKERS);
console.log(`② /compact：请求 ${two.requests.length} 个，事件 ${two.events.map(e => e.subtype ?? e.type).join(' ')}`);

const three = await runClaude({ prompt: 'c.js 导出了什么？', args: ['--resume', sessionId], reuse: { cwd: one.cwd, configDir: one.configDir }, hookEvents });
saveRecording(new URL('./recorded/3-after.json', import.meta.url).pathname, three, { prompt: 'c.js 导出了什么？' }, MARKERS);
console.log(`③ 压缩之后：${three.events.at(-1)?.result}`);
