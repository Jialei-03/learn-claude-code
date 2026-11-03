// 第 1 章：录制一次完整的运行（需要模型服务，不在网站构建时运行）。
//   node labs/ch01/record.ts
import { runClaude, saveRecording } from '../../lab/cc.ts';

const result = await runClaude({
  prompt: 'add.js 里的 add 函数写错了。修好它，然后运行 node test.js 确认测试通过。',
  files: {
    'package.json': '{"type":"module"}\n',
    'add.js': 'export const add = (a, b) => a - b;\n',
    'test.js': "import { add } from './add.js';\nif (add(2, 3) !== 5) { console.error('FAIL: add(2, 3) = ' + add(2, 3)); process.exit(1); }\nconsole.log('PASS');\n",
  },
  args: ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(node *)'],
});
saveRecording(new URL('./recorded/run.json', import.meta.url).pathname, result, { prompt: 'add.js 里的 add 函数写错了。修好它，然后运行 node test.js 确认测试通过。' });
console.log(`退出码 ${result.exitCode}；事件 ${result.events.length} 个；钩子 ${result.hooks.length} 次；请求 ${result.requests.length} 个；会话文件 ${result.transcripts.length} 个`);
console.log(result.events.map(e => `${e.type}${e.subtype ? ':' + e.subtype : ''}`).join(' → '));
if (result.stderr.trim()) console.log('stderr:', result.stderr.slice(0, 500));
