// 第 2 章：在两个不同的项目里各跑一个不同的任务，比较请求里哪些部分逐字相同（需要模型服务）。
//   node labs/ch02/record.ts
import { runClaude, saveRecording } from '../../lab/cc.ts';

const runs: { name: string; prompt: string; files: Record<string, string> }[] = [
  { name: 'a', prompt: '这个项目是做什么的？一句话回答。', files: { 'README.md': '# notes\n一个命令行笔记工具。\n', 'src/cli.js': 'console.log("notes");\n' } },
  { name: 'b', prompt: '列出 data 目录下的文件，不要做别的。', files: { 'data/2026-01.csv': 'a,b\n1,2\n', 'data/2026-02.csv': 'a,b\n3,4\n', 'Makefile': 'all:\n\techo hi\n' } },
];
for (const run of runs) {
  const result = await runClaude({ prompt: run.prompt, files: run.files, hookEvents: [] });
  saveRecording(new URL(`./recorded/${run.name}.json`, import.meta.url).pathname, result, { prompt: run.prompt });
  console.log(`${run.name}：退出码 ${result.exitCode}，请求 ${result.requests.length} 个`);
}
