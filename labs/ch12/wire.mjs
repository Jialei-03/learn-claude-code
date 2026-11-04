// 第 12 章：Agent SDK 驱动 Claude Code 的一次真实会话（离线分析 recorded/sdk.json）。
// 录制时 SDK 把 claude 的 stdin / stdout 夹在中间窃听，所以这里看到的是进程之间真正传递的每一行。
//
//   node labs/ch12/wire.mjs [session|trip]
//   session   会话开头：握手、提问、第一次工具调用前后发生的事（一行一条）
//   trip      一次 can_use_tool 往返的完整 JSON：请求、回答，以及被拒绝的那一次
import { arrow, load, summarize } from './wirelib.mjs';

const r = load('sdk');
const part = process.argv[2] ?? 'session';
const noise = (m) => m.type === 'system' && ['thinking_tokens', 'init'].includes(m.subtype);

if (part === 'session') {
  // 从握手到第一次工具调用返回；省略 thinking_tokens 和 init 这类与协议无关的事件
  const rows = [];
  let hidden = 0;
  r.wire.slice(0, 25).forEach((w, i) => {
    if (noise(w.msg)) { hidden++; return; }
    rows.push([i, arrow(w.dir), summarize(w.msg, 110)]);
  });
  console.log('| # | 方向 | 内容 |');
  console.log('| --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  console.log();
  console.log(`（前 25 行里省略了 ${hidden} 行 thinking_tokens / init 事件。整次会话共 ${r.wire.length} 行。）`);
}

if (part === 'trip') {
  // 找到被拒绝的那一次审批：请求在前，回答在后，用 request_id 配对
  const reply = r.wire.find((w) => w.dir === 'sdk→cli' && w.msg.response?.response?.behavior === 'deny');
  const id = reply.msg.response.request_id;
  const ask = r.wire.find((w) => w.msg.request_id === id);
  const show = (title, w) => {
    console.log(`${title}（${arrow(w.dir)}）`);
    console.log(JSON.stringify(w.msg, null, 2));
    console.log();
  };
  show('请求', ask);
  show('回答', reply);
  const result = r.wire.slice(r.wire.indexOf(reply)).find((w) => w.msg.type === 'user' && JSON.stringify(w.msg).includes('tool_result'));
  console.log(`模型随后收到的工具结果（${arrow(result.dir)}）：`);
  console.log(JSON.stringify(result.msg.message.content[0], null, 2));
}
