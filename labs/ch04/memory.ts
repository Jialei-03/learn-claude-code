// 第 4 章：自动记忆——第一个会话写下了什么，第二个会话里它出现在哪里（离线分析）。
//   node labs/ch04/memory.ts
import { loadRecording } from '../../lab/cc.ts';

const remember = loadRecording(new URL('./recorded/remember.json', import.meta.url).pathname);
const recall = loadRecording(new URL('./recorded/recall.json', import.meta.url).pathname);
console.log('━━ 会话一：“记住：这个项目的测试命令是 pnpm test:unit，以后都用这个。” ━━');
for (const e of remember.events) {
  if (e.type !== 'assistant') continue;
  for (const b of e.message.content) {
    if (b.type !== 'tool_use') continue;
    if (b.name === 'Write') console.log(`Write ${b.input.file_path.replace('<config>/projects/<project-escaped>/memory/', '<记忆目录>/')}\n${b.input.content.split('\n').map((l: string) => `    │ ${l}`).join('\n')}`);
    else console.log(`${b.name} ${(b.input.command ?? '').replace(/<config>\/projects\/<project-escaped>\//g, '<项目的会话目录>/').slice(0, 90)}`);
  }
}
const q = recall.requests.find((x: any) => x.messages?.length);
console.log('\n━━ 会话二（新会话，同一个项目）：“这个项目的测试命令是什么？” ━━');
console.log(`“pnpm test:unit” 出现在第一个请求的：${q.markers['pnpm test:unit'].join('、')}`);
console.log(`回答：${recall.events.at(-1).result}`);
