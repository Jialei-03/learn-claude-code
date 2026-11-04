// 第 1 章：一次回车到底请求了几次模型？
//   node labs/ch01/iterations.ts
// 读录制下来的 stream-json 事件和代理截下的请求（离线运行），回答三个问题：
//   1. 模型被请求了几次？每次回复里有什么、为什么还要继续？
//   2. 事件流里的 assistant 事件按“内容块”切，一次回复的工具结果什么时候回来？
//   3. result 事件里的 num_turns 数的是什么？
import assert from 'node:assert/strict';
import { loadRecording } from '../../lab/cc.ts';

const r = loadRecording(new URL('./recorded/run.json', import.meta.url).pathname);
const events: any[] = r.events;
const short = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

// 一次模型回复的所有内容块共享同一个 message.id：按它分组，就得到“第几次请求”。
const replies: { id: string; blocks: any[] }[] = [];
for (const e of events.filter(e => e.type === 'assistant')) {
  let reply = replies.find(x => x.id === e.message.id);
  if (!reply) replies.push((reply = { id: e.message.id, blocks: [] }));
  reply.blocks.push(...e.message.content);
}
const resultsOf = (reply: { blocks: any[] }) => {
  const ids = new Set(reply.blocks.filter(b => b.type === 'tool_use').map(b => b.id));
  return events.filter(e => e.type === 'user' && e.message.content.some((b: any) => ids.has(b.tool_use_id)));
};

console.log('**每一次模型请求**\n');
console.log('| 请求 | 请求里的消息条数（含注入的 system 提醒） | 回复里的内容块 | stop_reason | 工具结果 | 输出 token |');
console.log('| --- | --- | --- | --- | --- | --- |');
replies.forEach((reply, i) => {
  const request: any = r.requests[i];
  const blocks = reply.blocks.map(b => (b.type === 'tool_use' ? `${b.name}` : b.type)).join(' + ');
  console.log(`| ${i + 1} | ${request.messages.length} | ${blocks} | ${request.response.stopReason} | ${resultsOf(reply).length} | ${request.response.usage.output_tokens} |`);
});

// 每条工具结果到达时，它所属的那次回复已经输出了几个块？
console.log('\n**工具结果什么时候回来**\n');
console.log('| 工具调用 | 所属回复 | 结果到达时，该回复已输出的块 |');
console.log('| --- | --- | --- |');
let streamedEarly = 0;
const seenBlocks = new Map<string, number>();
for (const e of events) {
  if (e.type === 'assistant') seenBlocks.set(e.message.id, (seenBlocks.get(e.message.id) ?? 0) + e.message.content.length);
  if (e.type !== 'user') continue;
  for (const b of e.message.content) {
    const owner = replies.findIndex(x => x.blocks.some(c => c.id === b.tool_use_id));
    const use = replies[owner].blocks.find(c => c.id === b.tool_use_id);
    const total = replies[owner].blocks.length;
    const seen = seenBlocks.get(replies[owner].id)!;
    if (seen < total) streamedEarly++;
    const input = use.input.file_path ?? use.input.command ?? '';
    console.log(`| ${use.name} ${short(String(input).replace(/^.*\//, ''))} | 第 ${owner + 1} 次 | ${seen} / ${total}${seen < total ? '（回复还没结束）' : ''} |`);
  }
}

const toolResults = events.filter(e => e.type === 'user').reduce((n, e) => n + e.message.content.length, 0);
const result = events.at(-1);
console.log('\n**result 事件**\n');
console.log(`模型请求 ${replies.length} 次，工具结果 ${toolResults} 条。`);
console.log(`result.num_turns = ${result.num_turns}（= 1 + ${toolResults}：每收到一条工具结果就加一）。`);
console.log(`result.terminal_reason = ${result.terminal_reason}，result.stop_reason = ${result.stop_reason}。`);

assert.equal(replies.length, r.requests.length, '每一次模型回复对应代理截到的一个请求');
assert.equal(result.num_turns, 1 + toolResults, 'num_turns 是 1 + 工具结果条数');
assert.notEqual(result.num_turns, replies.length, 'num_turns 不是模型请求的次数');
assert.ok(streamedEarly > 0, '至少有一条工具结果在它所属的回复结束之前就回来了');
assert.equal(result.terminal_reason, 'completed');
