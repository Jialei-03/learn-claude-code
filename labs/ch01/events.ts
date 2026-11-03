// 第 1 章：读录制下来的 stream-json 事件（离线运行，不需要模型服务）。
//   node labs/ch01/events.ts
import { loadRecording } from '../../lab/cc.ts';

const r = loadRecording(new URL('./recorded/run.json', import.meta.url).pathname);
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');
console.log(`任务：${r.prompt}\n`);
console.log('| # | 事件 | 内容 |');
console.log('| --- | --- | --- |');
let thinking = 0;
r.events.forEach((e: any, i: number) => {
  if (e.type === 'system' && e.subtype === 'thinking_tokens') { thinking++; return; }
  let what = '';
  if (e.type === 'system' && e.subtype === 'init') what = `模型 ${e.model}；${e.tools.length} 个工具；权限模式 ${e.permissionMode}；${e.slash_commands.length} 个斜杠命令、${e.skills.length} 个 Skill、${e.agents.length} 个子 Agent 类型`;
  else if (e.type === 'system') what = e.hook_event ? `钩子 ${e.hook_event}（${e.subtype}）` : e.subtype;
  else if (e.type === 'assistant') what = e.message.content.map((b: any) => (b.type === 'tool_use' ? `调用 ${b.name} ${short(JSON.stringify(b.input), 50)}` : b.type === 'text' ? `文字：${short(b.text)}` : b.type)).join('；');
  else if (e.type === 'user') what = e.message.content.map((b: any) => `工具结果${b.is_error ? '（错误）' : ''}：${short(typeof b.content === 'string' ? b.content : JSON.stringify(b.content), 50)}`).join('；');
  else if (e.type === 'result') what = `${e.subtype}；${e.num_turns} 轮；耗时 ${(e.duration_ms / 1000).toFixed(1)}s（其中等模型 ${(e.duration_api_ms / 1000).toFixed(1)}s）；被拒绝的工具调用 ${e.permission_denials.length} 个`;
  console.log(`| ${i + 1} | ${e.type}${e.subtype && e.type !== 'system' ? ':' + e.subtype : e.type === 'system' ? ':' + e.subtype : ''} | ${what.replace(/\|/g, '\\|')} |`);
});
console.log(`\n另有 ${thinking} 个 system:thinking_tokens 事件（模型思考时的 token 计数，省略）。`);
const init = r.events.find((e: any) => e.subtype === 'init');
console.log(`\ninit 事件列出的工具：${init.tools.join('、')}`);
