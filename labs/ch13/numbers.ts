// 第 13 章：把前面各章录制里的关键数字放在一起（离线分析，全部从录制里现算）。
//   node labs/ch13/numbers.ts
import { loadRecording } from '../../lab/cc.ts';

const load = (path: string) => loadRecording(new URL(`../${path}.json`, import.meta.url).pathname);
const total = (u: any = {}) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
const pct = (a: number, b: number) => `${Math.round((100 * a) / b)}%`;
const rows: [string, string, string][] = [];

// 第 2 章：一个请求的构成
const ch2 = load('ch02/recorded/a').requests;
const q0 = ch2[0];
rows.push(['2', '系统提示主体 / 工具定义', `${q0.system.at(-1).chars} 字符 / ${q0.toolsChars} 字符（${(q0.toolsChars / q0.system.at(-1).chars).toFixed(1)} 倍）`]);
const later = ch2.slice(1).filter((q: any) => q.tools.length).map((q: any) => q.response?.usage).filter(Boolean);
rows.push(['2', '第一个请求之后的缓存命中', later.map((u: any) => pct(u.cache_read_input_tokens ?? 0, total(u))).join('、')]);

// 第 3 章：并行调用的结果顺序
const order = [1, 2, 3].map(i => load(`ch03/recorded/order-${i}`).requests.at(-1));
const outOfOrder = order.filter((q: any) => {
  const uses = q.messages.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool_use').map((b: any) => b.ref));
  const results = q.messages.flatMap((m: any) => m.blocks.filter((b: any) => b.type === 'tool_result').map((b: any) => b.ref));
  return uses.join() !== results.join();
}).length;
rows.push(['3', '并行读四个文件，结果乱序的次数', `${outOfOrder} / 3`]);

// 第 5 章：压缩
const compact = load('ch05/recorded/2-compact').requests[0].response.usage;
rows.push(['5', '压缩请求读缓存的比例', pct(compact.cache_read_input_tokens, total(compact))]);
const after = load('ch05/recorded/3-after').requests[0].response.usage;
rows.push(['5', '压缩之后第一个请求读缓存的比例', pct(after.cache_read_input_tokens ?? 0, total(after))]);
const thrash = load('ch05/recorded/5-thrash').events.at(-1);
rows.push(['5', '窗口 60K 时连续压缩之后', `${thrash.terminal_reason}`]);

// 第 6 章：分类器
const cls = load('ch06/recorded/classifier').requests.filter((q: any) => !q.tools.length && q.system.length);
rows.push(['6', '安全分类器的系统提示', `${cls[0].system.at(-1).chars} 字符；一次运行里发出 ${cls.length} 个分类器请求`]);

// 第 7 章：被钩子拦下之后
const scenario = load('ch07/recorded/scenario');
const callsAfter = scenario.events.filter((e: any) => e.type === 'assistant').flatMap((e: any) => e.message.content).filter((b: any) => b.type === 'tool_use');
rows.push(['7', '场景实验里模型的工具调用', `${callsAfter.length} 次（其中 ${callsAfter.filter((c: any) => /build/.test(c.input.command ?? '') && /\b(rm|rmdir|mv|delete|rmtree)\b/.test(c.input.command ?? '')).length} 次在尝试删除 build）`]);

// 第 8 章：工具搜索
const up = load('ch08/recorded/upfront').requests[0], s = load('ch08/recorded/search').requests[0];
rows.push(['8', '工具搜索：第一个请求的工具数 / 输入', `${up.tools.length} → ${s.tools.length} 个；${total(up.response.usage)} → ${total(s.response.usage)} token（−${pct(total(up.response.usage) - total(s.response.usage), total(up.response.usage))}）`]);

// 第 11 章：沙箱
const sb = load('ch11/recorded/run').requests[0];
rows.push(['11', '打开沙箱后环境信息的长度', `${load('ch06/recorded/rules').requests[0].messages[1].blocks[0].chars} → ${sb.messages[1].blocks[0].chars} 字符`]);

// 第 12 章：SDK
const sdk = load('ch12/recorded/sdk');
rows.push(['12', 'Agent SDK 默认的系统提示', `${sdk.requests[0].system.map((x: any) => x.chars).join(' + ')} 字符（-p 是 ${q0.system.map((x: any) => x.chars).join(' + ')}）`]);
rows.push(['12', 'SDK 和 Claude Code 之间的控制请求', `${sdk.wire.filter((w: any) => w.msg?.type === 'control_request').length} 条（审批 ${sdk.wire.filter((w: any) => w.msg?.request?.subtype === 'can_use_tool').length}、钩子 ${sdk.wire.filter((w: any) => w.msg?.request?.subtype === 'hook_callback').length}、MCP ${sdk.wire.filter((w: any) => w.msg?.request?.subtype === 'mcp_message').length}）`]);

console.log('| 章 | 数字 | 录制里的值 |');
console.log('| --- | --- | --- |');
for (const [ch, what, value] of rows) console.log(`| ${ch} | ${what} | ${value} |`);
