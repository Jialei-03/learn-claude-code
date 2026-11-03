// 第 6 章：从一次录制里取出每个工具调用，以及 Claude Code 对它的权限决定。
import { loadRecording } from '../../lab/cc.ts';

export interface Call {
  id: string; name: string; input: any;
  /** Claude Code 的决定：stream-json 里工具结果附带的 tool_result_meta.permission_decision */
  decision?: { decision: string; source: string; reason_type?: string };
  isError: boolean; result: string;
  /** 这个调用触发了哪些钩子（PermissionRequest 表示“本来要弹窗问用户”） */
  hooks: string[];
}

export const load = (name: string) => loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname);

export function calls(r: any): Call[] {
  const out: Call[] = [];
  for (const e of r.events) {
    if (e.type === 'assistant') for (const b of e.message.content) if (b.type === 'tool_use') out.push({ id: b.id, name: b.name, input: b.input, isError: false, result: '', hooks: [] });
    if (e.type === 'user' && Array.isArray(e.message.content)) for (const b of e.message.content) {
      if (b.type !== 'tool_result') continue;
      const c = out.find(x => x.id === b.tool_use_id);
      if (!c) continue;
      c.isError = !!b.is_error;
      // 内容块数组：文本块取文字，其他块（tool_reference 等）保留 JSON
      const content = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => (x.type === 'text' ? x.text : JSON.stringify(x))).join('') : JSON.stringify(b.content);
      c.result = content.replace(/<\/?tool_use_error>/g, '');
      c.decision = e.tool_result_meta?.find((m: any) => m.id === b.tool_use_id)?.permission_decision;
    }
  }
  // 钩子的数据里，PreToolUse、PermissionDenied 带 tool_use_id；PermissionRequest 没有，只能按参数对上
  for (const h of r.hooks) {
    const p = h.payload;
    const c = out.find(x => x.id === p.tool_use_id) ?? out.find(x => !x.hooks.includes(h.event) && JSON.stringify(x.input) === JSON.stringify(p.tool_input));
    c?.hooks.push(h.event);
  }
  return out;
}

export const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ').replace(/\|/g, '\\|');
export const describe = (c: Call) => (c.name === 'Bash' ? `Bash \`${c.input.command}\`` : `${c.name} ${String(c.input.file_path).replace('<project>/', '')}`);
/** 把 Claude Code 的结果归成三类：放行、拒绝、“要问用户”（-p 模式下没人回答，等于拒绝） */
export const verdict = (c: Call) => (c.decision?.decision === 'accept' || (!c.isError && !c.decision) ? 'allow' : c.hooks.includes('PermissionRequest') ? 'ask' : 'deny');
