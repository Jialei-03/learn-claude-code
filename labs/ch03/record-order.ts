// 第 3 章：并行读四个大小不同的文件，看工具结果以什么顺序回到请求里（需要模型服务）。
// 同样的任务跑三次——顺序取决于谁先读完，每次可能不一样。
//   node labs/ch03/record-order.ts
import { runClaude, saveRecording } from '../../lab/cc.ts';

const pad = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join('\n');
// a 最大、d 最小：如果结果按完成顺序回来，a 往往排在后面
export const FILES: Record<string, number> = { a: 4000, b: 10, c: 2000, d: 5 };
const files = Object.fromEntries(Object.entries(FILES).map(([k, n]) => [`src/${k}.js`, `${pad(n)}\nexport const X_${k.toUpperCase()} = 1;\n`]));

for (let i = 1; i <= 3; i++) {
  const r = await runClaude({ prompt: '同时（并行）读 src/a.js、src/b.js、src/c.js、src/d.js，只告诉我每个文件导出的名字。', files, hookEvents: ['PreToolUse', 'PostToolUse'] });
  saveRecording(new URL(`./recorded/order-${i}.json`, import.meta.url).pathname, r, { prompt: '并行读四个文件' });
  console.log(`第 ${i} 次：${r.events.at(-1)?.result?.replace(/\s+/g, ' ').slice(0, 120)}`);
}
