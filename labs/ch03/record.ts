// 第 3 章：让 Claude Code 按指定的顺序调用工具，故意触碰每个工具的边界（需要模型服务）。
//   node labs/ch03/record.ts
import { runClaude, saveRecording } from '../../lab/cc.ts';

const prompt = `这是一个测试工具行为的实验。严格按顺序做下面几步，每一步只调用一次指定的工具；某一步出错了也不要重试，直接做下一步：
1. 不要先读文件，直接用 Edit 工具把 add.js 里的 "a - b" 替换成 "a + b"。
2. 用 Read 读取 add.js。
3. 再用 Edit 把 add.js 里的 "a - b" 替换成 "a + b"。
4. 用 Read 读取 dup.txt，然后用 Edit 把 dup.txt 里的 "x" 替换成 "y"（不要设置 replace_all）。
5. 用 Read 读取 big.txt，不要指定 offset 和 limit。
6. 用 Bash 运行 seq 1 50000。
7. 不要先读，直接用 Write 把 notes.md 的内容写成 "hello"。
8. 最后用一句话说明哪几步出错了。`;

const result = await runClaude({
  prompt,
  files: {
    'add.js': 'export const add = (a, b) => a - b;\n',
    'dup.txt': 'x\nx\n',
    'big.txt': Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
    'notes.md': '# old notes\n',
  },
  args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(seq *)'],
});
saveRecording(new URL('./recorded/tools.json', import.meta.url).pathname, result, { prompt });
console.log(`退出码 ${result.exitCode}；工具调用 ${result.hooks.filter(h => h.event === 'PreToolUse').length} 次`);
