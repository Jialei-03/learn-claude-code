// 第 12 章实验的共用小工具：把协议里的一行 JSON 压缩成一句人读得懂的话。
// 数据来自两份录制：recorded/sdk.json（Agent SDK 驱动的一次真实会话）和 recorded/headless.json（本章录的七个场景）。
import { readFileSync } from 'node:fs';

export const load = (name) => JSON.parse(readFileSync(new URL(`./recorded/${name}.json`, import.meta.url), 'utf8'));

export const short = (text, n = 48) => {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
const id8 = (id) => (id ? String(id).slice(0, 8) : '');
const json = (value, n) => short(JSON.stringify(value), n);

/** 一行协议消息 → 一句话。 */
export function summarize(msg, n = 70) {
  if (msg == null) return '';
  if (msg.note) return msg.note;
  if (typeof msg !== 'object') return `（不是 JSON）${short(msg, n)}`;
  const { type } = msg;
  if (type === 'control_request') {
    const r = msg.request;
    const detail = r.subtype === 'can_use_tool' ? `${r.tool_name} ${json(r.input, 36)}`
      : r.subtype === 'hook_callback' ? `${r.callback_id} ${r.input?.hook_event_name ?? ''}`
      : r.subtype === 'mcp_message' ? `${r.server_name} ${r.message?.method ?? ''}`
      : r.subtype === 'initialize' ? json({ hooks: r.hooks ? Object.keys(r.hooks) : undefined, sdkMcpServers: r.sdkMcpServers }, 50) : '';
    return `control_request · ${r.subtype} ${detail} [${id8(msg.request_id)}]`;
  }
  if (type === 'control_response') {
    const r = msg.response;
    const body = r.response ?? {};
    const detail = r.subtype === 'error' ? `error: ${r.error}` : body.behavior ? `${body.behavior}${body.message ? `：${body.message}` : ''}${body.updatedInput ? ` updatedInput=${json(body.updatedInput, 36)}` : ''}` : json(body, 40);
    return `control_response · ${r.subtype} ${detail} [${id8(r.request_id)}]`;
  }
  if (type === 'control_cancel_request') return `control_cancel_request [${id8(msg.request_id)}]`;
  if (type === 'assistant') {
    return 'assistant · ' + msg.message.content.map((b) => b.type === 'text' ? `“${short(b.text, 24)}”` : b.type === 'tool_use' ? `tool_use ${b.name} ${json(b.input, 36)}` : b.type).join('、');
  }
  if (type === 'user') {
    const c = Array.isArray(msg.message.content) ? msg.message.content : [{ type: 'text', text: msg.message.content }];
    return 'user · ' + c.map((b) => b.type === 'tool_result' ? `tool_result${b.is_error ? '(错误)' : ''} “${short(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 48)}”` : `“${short(b.text, 28)}”`).join('、');
  }
  if (type === 'system') return `system · ${msg.subtype}${msg.state ? ` ${msg.state}` : ''}${msg.subtype === 'init' ? ` permissionMode=${msg.permissionMode ?? ''}` : ''}${msg.message ? ` “${short(msg.message, 40)}”` : ''}`;
  if (type === 'result') return `result · ${msg.subtype}${msg.is_error ? '（is_error）' : ''}${msg.terminal_reason ? ` ${msg.terminal_reason}` : ''}`;
  return `${type}${msg.subtype ? ' · ' + msg.subtype : ''}`;
}

export const arrow = (dir) => (dir.startsWith('host→') || dir === 'sdk→cli' ? '宿主 → claude' : dir === 'host' ? '宿主' : 'claude → 宿主');
