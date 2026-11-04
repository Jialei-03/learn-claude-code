// 第 4 章：录制里，模型自己怎么回答“你的上下文里有哪些关于这个项目的规则”（离线分析）。
//   node labs/ch04/answer.ts
// 提问是录制时的最后一句话：让模型逐条列出它看到的规则，并说明每条来自哪里。
// 下面是模型的原话；金丝雀实验看的是请求里有什么，这里看的是模型怎么转述。
import { loadRecording } from '../../lab/cc.ts';

const recording = loadRecording(new URL('./recorded/instructions.json', import.meta.url).pathname);
console.log(recording.events.at(-1).result);
