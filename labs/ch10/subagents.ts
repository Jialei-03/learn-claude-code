// 第 10 章：子 Agent 收到了什么、交回了什么（离线分析）。
//   node labs/ch10/subagents.ts [requests|handback|timeline]
import { loadRecording } from '../../lab/cc.ts';
import { short } from '../ch06/calls.ts';

const load = (name: string) => loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname);
const part = process.argv[2] ?? 'requests';

if (part === 'requests') {
  const r = load('fg');
  // 区分三方的第一个请求：父 Agent 有 Agent 工具；reviewer 的系统提示以定义文件的正文开头；Explore 有 Bash 却没有 Agent
  const first = (pred: (q: any) => boolean) => r.requests.find((q: any) => q.tools.length && pred(q));
  const parent = first(q => q.tools.some((t: any) => t.name === 'Agent'));
  const reviewer = first(q => q.system.some((s: any) => s.firstLine.startsWith('CANARY-AGENT-PROMPT')));
  const explore = first(q => !q.tools.some((t: any) => t.name === 'Agent') && q.tools.some((t: any) => t.name === 'Bash'));
  const cols = [['父 Agent', parent], ['reviewer（自定义）', reviewer], ['Explore（内置）', explore]] as const;
  const has = (q: any, k: string) => (q.markers?.[k]?.some((w: string) => !w.endsWith('(assistant)')) ? '有' : '**没有**');
  const rows: [string, (q: any) => string][] = [
    ['系统提示主体', q => `${q.system.at(-1).chars} 字符：“${short(q.system.at(-1).firstLine, 26)}”`],
    ['工具', q => (q.tools.length > 12 ? `${q.tools.length} 个` : `${q.tools.length} 个：${q.tools.map((t: any) => t.name).join('、')}`)],
    ['和父 Agent 的工具相比', q => {
      if (q === parent) return '—';
      const names = (x: any) => x.tools.map((t: any) => t.name);
      const fewer = names(parent).filter((n: string) => !names(q).includes(n));
      const more = names(q).filter((n: string) => !names(parent).includes(n));
      return `少了 ${fewer.length} 个${fewer.length <= 8 ? `（${fewer.join('、')}）` : ''}；${more.length ? `**多了** ${more.join('、')}` : '没有多出来的'}`;
    }],
    ['项目的 CLAUDE.md', q => has(q, 'CANARY-SUBAGENT-CLAUDEMD')],
    ['父对话里的暗号', q => has(q, 'CANARY-PARENT-ONLY')],
    ['子 Agent 的目录', q => has(q, 'CANARY-AGENT-DESC')],
    ['第一条用户消息', q => `${q.messages[0].blocks.map((b: any) => b.chars).join(' + ')} 字符`],
    ['环境信息（system 消息）', q => `${q.messages[1]?.blocks[0]?.chars ?? 0} 字符`],
    ['模型 / 思考', q => `${q.model} / ${q.thinking?.type ?? '—'}`],
  ];
  console.log(`| | ${cols.map(c => c[0]).join(' | ')} |`);
  console.log(`| --- | ${cols.map(() => '---').join(' | ')} |`);
  for (const [label, f] of rows) console.log(`| ${label} | ${cols.map(c => f(c[1])).join(' | ')} |`);
}

if (part === 'handback') {
  for (const mode of ['fg', 'bg']) {
    const r = load(mode);
    console.log(`━━ ${mode === 'fg' ? '前台（run_in_background: false）' : '后台（run_in_background: true）'} ━━`);
    // 父 Agent 的最后一个请求里，Agent 工具的结果和之后送来的通知
    const last = r.requests.filter((q: any) => q.tools.some((t: any) => t.name === 'Agent')).at(-1);
    const where = (k: string, i: number) => (last.markers?.[k] ?? []).some((w: string) => w.startsWith(`messages[${i}]`));
    last.messages.forEach((m: any, i: number) => {
      if (m.role !== 'user' || i === 0) return;
      const results = m.blocks.filter((b: any) => b.type === 'tool_result');
      const texts = m.blocks.filter((b: any) => b.type === 'text');
      const note = where('.output', i) ? '带着输出文件的路径' : '报告全文就在这里';
      if (results.length && where('agentId', i)) console.log(`  第 ${i} 条（用户消息）：工具结果 ${results.map((b: any) => `${b.chars}`).join(' + ')} 字符（包括同一轮的其他工具）；${note}`);
      else if (texts.length && texts[0].chars > 1000) console.log(`  第 ${i} 条（用户消息）：一段 ${texts[0].chars} 字符的 ${texts[0].firstLine}；${note}`);
    });
  }
  const fg = load('fg');
  const first = fg.events.filter((e: any) => e.type === 'user' && !e.parent_tool_use_id && Array.isArray(e.message.content)).flatMap((e: any) => e.message.content).find((b: any) => b.type === 'tool_result' && JSON.stringify(b.content).includes('hand-back'));
  console.log(`
前台结果的第一行：“${short(first.content[0].text.split('\n')[0], 120)}”`);
  const r = load('bg');
  const stop = r.hooks.find((h: any) => h.event === 'SubagentStop');
  console.log(`SubagentStop 钩子的字段：${Object.keys(stop.payload).join('、')}`);
  console.log(`子 Agent 的会话文件：${r.transcripts.filter((t: any) => t.file.includes('/subagents/')).map((t: any) => t.file.replace(/^.*\/([^/]+\/subagents\/)/, '<会话>/subagents/')).join('、')}`);
}

if (part === 'timeline') {
  const r = load('bg');
  const t0 = r.hooks[0]?.at ?? 0;
  console.log('| 事件 | 内容 |');
  console.log('| --- | --- |');
  for (const e of r.events) {
    if (e.type === 'assistant' && !e.parent_tool_use_id) for (const b of e.message.content) {
      if (b.type === 'tool_use' && b.name === 'Agent') console.log(`| 父 Agent 调用 Agent | ${b.input.subagent_type}，run_in_background: ${b.input.run_in_background} |`);
      if (b.type === 'text' && b.text.trim()) console.log(`| 父 Agent 回复 | ${short(b.text, 60)} |`);
    }
    if (e.subtype === 'task_notification' && e.task_type !== 'local_bash' && e.summary) console.log(`| **子 Agent 完成**（task_notification） | ${short(e.summary, 50)} |`);
    if (e.type === 'result') console.log(`| result 事件 | ${e.num_turns} 轮，${e.terminal_reason ?? e.subtype} |`);
  }
}
