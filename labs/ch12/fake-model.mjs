// 第 12 章：一个按剧本回答的假模型服务（Anthropic Messages 接口的最小子集）。
//
// 为什么需要它：这一章要观察的是 Claude Code 的“无界面协议”，不是模型的智商。
// 让真实的 claude 可执行文件连到这个本机服务，每一轮该调用什么工具、说什么话，都由剧本决定，
// 于是协议里的每一行都可以重复录制，不需要密钥，也不花钱。
//
// 剧本是一个数组，第 N 个“主循环请求”（带工具定义的那种）取第 N 项：
//   { text: "说的话" }                           只说话，结束这一轮
//   { tools: [{ name, input }], text? }          调用工具（可以有好几个）
// 其他请求（标题、摘要之类的小请求）统一回答一句 "ok"。

import { createServer } from 'node:http';

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** 把一个剧本项编码成 Anthropic 的流式响应（SSE） */
function encode(step, n) {
  const content = [];
  if (step.text) content.push({ type: 'text', text: step.text });
  (step.tools ?? []).forEach((tool, i) => content.push({ type: 'tool_use', id: `toolu_${n}_${i}`, name: tool.name, input: tool.input }));

  let out = sse('message_start', { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', content: [], model: 'scripted', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    out += sse('content_block_stop', { type: 'content_block_stop', index });
  });
  const stop = step.tools?.length ? 'tool_use' : 'end_turn';
  out += sse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  out += sse('message_stop', { type: 'message_stop' });
  return out;
}

export async function startFakeModel(script) {
  const requests = [];
  let mainCalls = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const isMain = req.url?.startsWith('/v1/messages') && !req.url.includes('count_tokens') && body.tools?.some?.((t) => t.name === 'Bash');
      const step = isMain ? script[mainCalls++] ?? { text: '（剧本用完了）' } : { text: 'ok' };
      requests.push({ main: Boolean(isMain), messages: body.messages ?? [] });
      if (req.url?.includes('count_tokens')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 10 }));
      if (!body.stream) {
        const message = { id: 'msg_x', type: 'message', role: 'assistant', model: 'scripted', content: [{ type: 'text', text: step.text ?? 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(encode(step, mainCalls));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** 收到的请求；main 为 true 的是带工具定义的主循环请求 */
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
