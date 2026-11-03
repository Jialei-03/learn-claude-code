// 第 5 章：自动压缩。把 Claude Code 假设的上下文窗口调小（CLAUDE_CODE_MAX_CONTEXT_TOKENS），
// 让一个“依次读六个大文件”的任务在中途触发自动压缩（需要模型服务）。
//   node labs/ch05/record-auto.ts
// 两次运行：窗口 75K（压缩一次，任务做完）；窗口 60K（每读一个文件就又满了——看 Claude Code 怎么办）。
import { runClaude, saveRecording } from '../../lab/cc.ts';

export const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
// 每个文件 300 个函数，大约 8K token
const body = (k: string) => Array.from({ length: 300 }, (_, i) => `export function ${k}_${i}(x) { return x * ${i} + ${k.length}; } // helper ${k} number ${i}`).join('\n');
const files = Object.fromEntries(NAMES.map(k => [`lib/${k}.js`, body(k)]));
const prompt = '依次读 lib/ 下的六个文件（alpha、beta、gamma、delta、epsilon、zeta，一次读一个），每读完一个说一句它有多少个函数。最后告诉我总数。';

for (const [file, window] of [['4-auto', '75000'], ['5-thrash', '60000']]) {
  const r = await runClaude({ prompt, files, hookEvents: ['SessionStart', 'PreCompact', 'PostCompact'], env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: window } });
  saveRecording(new URL(`./recorded/${file}.json`, import.meta.url).pathname, r, { prompt: '依次读六个大文件', window: Number(window) }, NAMES.map(k => `${k}_299`));
  const compacts = r.events.filter(e => e.subtype === 'compact_boundary').length;
  console.log(`${file}（窗口 ${window}）：请求 ${r.requests.length} 个，压缩 ${compacts} 次；${String(r.events.at(-1)?.result).replace(/\s+/g, ' ').slice(0, 100)}`);
}
