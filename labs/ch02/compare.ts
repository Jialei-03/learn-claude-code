// 第 2 章：两个项目、两个任务，请求的哪些部分逐字相同（离线比较内容指纹）。
//   node labs/ch02/compare.ts
import { loadRecording } from '../../lab/cc.ts';

const a = loadRecording(new URL('./recorded/a.json', import.meta.url).pathname).requests[0];
const b = loadRecording(new URL('./recorded/b.json', import.meta.url).pathname).requests[0];
const same = (x: string, y: string) => (x === y ? '相同' : '**不同**');
console.log('按 Anthropic 计算提示缓存的顺序（工具 → 系统提示 → 消息）列出：\n');
console.log('| 部分 | 字符数 | 两个项目之间 |');
console.log('| --- | --- | --- |');
console.log(`| tools（${a.tools.length} 个工具定义） | ${a.toolsChars} | ${same(a.toolsHash, b.toolsHash)} |`);
a.system.forEach((s: any, i: number) => console.log(`| system 第 ${i + 1} 块${s.cache ? '（缓存标记）' : ''} | ${s.chars} | ${same(s.hash, b.system[i].hash)} |`));
const envA = a.messages[1].blocks[0], envB = b.messages[1].blocks[0];
console.log(`| messages[0]：开头的 system-reminder | ${a.messages[0].blocks[0].chars} | ${same(a.messages[0].blocks[0].hash, b.messages[0].blocks[0].hash)} |`);
console.log(`| messages[0]：用户的提问 | ${a.messages[0].blocks[1].chars} / ${b.messages[0].blocks[1].chars} | ${same(a.messages[0].blocks[1].hash, b.messages[0].blocks[1].hash)} |`);
console.log(`| messages[1]：环境信息（system 角色的消息） | ${envA.chars} / ${envB.chars} | ${same(envA.hash, envB.hash)} |`);
