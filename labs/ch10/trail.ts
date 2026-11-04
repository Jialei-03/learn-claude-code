// 第 10 章：子 Agent 留下的账，和交回父 Agent 的东西（离线分析录制，不调用模型）。
//   node labs/ch10/trail.ts sidechain     三个会话文件各记了什么：子 Agent 的十几次工具调用，父 Agent 的会话里有吗？
//   node labs/ch10/trail.ts return        前台、后台两种路径，父 Agent 分别收到什么
//   node labs/ch10/trail.ts timing        同一条回复里的两个 Agent 调用：钩子事件的时间线
//   node labs/ch10/trail.ts denied        子 Agent 的工具调用同样要过权限：-p 模式下没人可确认，被拒绝的是谁
import assert from 'node:assert/strict';
import { loadRecording } from '../../lab/cc.ts';
import { short } from '../ch06/calls.ts';

const load = (name: string) => loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname);
const part = process.argv[2] ?? 'sidechain';

/** 一个会话文件里 assistant 发出的工具调用，按名字计数：Bash×7、Read×2 */
function toolUses(entries: any[]) {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    for (const b of e.message.content ?? []) if (b.type === 'tool_use') counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join('、');
}

if (part === 'sidechain') {
  const r = load('fg');
  // task_started 事件告诉我们每个子 Agent 的 id 对应哪个类型，以及父 Agent 当时写给它的 prompt
  const started = new Map<string, { type: string; prompt: string }>(
    r.events.filter((e: any) => e.subtype === 'task_started').map((e: any) => [e.task_id, { type: e.subagent_type, prompt: e.prompt }]),
  );
  const rows: string[][] = [];
  for (const t of r.transcripts) {
    const entries = t.entries as any[];
    const sub = /agent-([0-9a-f]+)\.jsonl$/.exec(t.file);
    const who = sub ? `子 Agent ${started.get(sub[1])!.type}` : '父 Agent（主会话）';
    const first = entries.find((e) => e.type === 'user' && e.message);
    const leaked = JSON.stringify(entries).includes('CANARY-PARENT-ONLY');
    const sidechain = [...new Set(entries.map((e) => e.isSidechain))].filter((x) => x !== undefined).join('/');
    rows.push([who, sub ? `subagents/agent-${sub[1].slice(0, 6)}….jsonl` : '主会话 .jsonl', String(entries.length), sidechain || '—', toolUses(entries) || '—', leaked ? '有' : '没有', short(String(first?.message.content), 28)]);
    if (sub) {
      // 子 Agent 会话的第一行，就是父 Agent 在 Agent 调用里写的 prompt，一个字都不多
      assert.equal(first.parentUuid, null);
      // 会话文件里的长字符串在录制时被截断过（结尾带“…[共 N 字符]”），所以比较开头
      assert.ok(started.get(sub[1])!.prompt.startsWith(String(first.message.content).replace(/…\[共 \d+ 字符\]$/, '')));
      assert.equal(leaked, false);
    }
  }
  rows.sort((a, b) => Number(b[0].startsWith('父')) - Number(a[0].startsWith('父'))); // 父 Agent 排第一
  console.log('| 谁 | 文件 | 行数 | isSidechain | 记下的工具调用 | 出现父对话的暗号 | 第一条用户消息 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
  const uses = (entries: any[]) => entries.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content).filter((b: any) => b.type === 'tool_use');
  const parent = r.transcripts.find((t: any) => !/subagents\//.test(t.file));
  const total = r.transcripts.filter((t: any) => /subagents\//.test(t.file)).reduce((n: number, t: any) => n + uses(t.entries).length, 0);
  const own = uses(parent.entries);
  console.log(`\n两个子 Agent 一共调用了 ${total} 次工具，这些调用和它们的结果只在各自的会话文件里；父 Agent 会话里的工具调用只有它自己的 ${own.length} 次（${own.map((b: any) => b.name).join('、')}）。`);
  assert.ok(total >= 10);
  assert.equal(own.filter((b: any) => b.name === 'Grep' || b.name === 'Glob').length, 0);
}

if (part === 'return') {
  const rows: string[][] = [];
  // 前台：报告作为 Agent 工具的结果，在同一轮里回来
  const fg = load('fg');
  const fgResults = fg.events
    .filter((e: any) => e.type === 'user' && !e.parent_tool_use_id && Array.isArray(e.message.content))
    .flatMap((e: any) => e.message.content)
    .filter((b: any) => b.type === 'tool_result' && JSON.stringify(b.content).includes('Subagent hand-back'));
  assert.equal(fgResults.length, 2);
  for (const [i, kind] of ['reviewer', 'Explore'].entries()) {
    const text: string = fgResults[i].content[0].text;
    rows.push([`前台 ${kind}`, 'Agent 工具的 tool_result（同一轮）', short(text.split('\n')[0], 58), `${text.match(/共 (\d+) 字符/)?.[1] ?? text.length} 字符`]);
  }
  // 后台：先是“已启动”，报告随后以新的一条用户消息送达
  const bg = load('bg');
  const launched = bg.events
    .filter((e: any) => e.type === 'user' && !e.parent_tool_use_id && Array.isArray(e.message.content))
    .flatMap((e: any) => e.message.content)
    .filter((b: any) => b.type === 'tool_result' && JSON.stringify(b.content).includes('Async agent launched'));
  assert.equal(launched.length, 2);
  rows.push(['后台 reviewer / Explore', 'Agent 工具的 tool_result（立刻）', short(launched[0].content[0].text.split('\n')[0], 58), `${launched[0].content[0].text.match(/共 (\d+) 字符/)?.[1]} 字符`]);
  const main = bg.transcripts.find((t: any) => !/subagents\//.test(t.file));
  const notes = main.entries.filter((e: any) => e.type === 'queue-operation' && e.operation === 'enqueue' && String(e.content).startsWith('<task-notification>'));
  assert.equal(notes.length, 2);
  for (const note of notes) {
    const id = /<task-id>([^<]+)/.exec(note.content)![1];
    rows.push([`后台 ${id.slice(0, 6)}… 完成`, '排进消息队列，作为新的一条用户消息', short(String(note.content).split('\n')[0] + ' ' + String(note.content).split('\n')[1], 58), `${note.content.match(/共 (\d+) 字符/)?.[1]} 字符`]);
  }
  console.log('| 路径 | 父 Agent 在哪里收到 | 开头 | 大小 |');
  console.log('| --- | --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
  // stream-json 里，每个后台子 Agent 的完成还有一个专门的事件，带着状态和统计
  const done = bg.events.find((e: any) => e.subtype === 'task_notification');
  console.log(`\nstream-json 的 task_notification 事件字段：${Object.keys(done).join('、')}`);
}

if (part === 'timing') {
  const r = load('fg');
  const t0 = r.hooks[0].at;
  const at = (h: any) => `${((h.at - t0) / 1000).toFixed(1)}s`;
  const rows: string[][] = [];
  for (const h of r.hooks) {
    const p = h.payload;
    if (h.event === 'PreToolUse' && p.tool_name === 'Agent') rows.push([at(h), '父 Agent', `PreToolUse：Agent（${p.tool_input.subagent_type}）`]);
    if (h.event === 'SubagentStart') rows.push([at(h), `子 Agent ${p.agent_type}`, 'SubagentStart']);
    if (h.event === 'SubagentStop') rows.push([at(h), `子 Agent ${p.agent_type}`, 'SubagentStop']);
  }
  // 子 Agent 全部结束以后，父 Agent 才继续它自己的下一步（读两个文件）
  const next = r.hooks.find((h: any) => h.event === 'PreToolUse' && !h.payload.agent_id && h.payload.tool_name === 'Read');
  rows.push([at(next), '父 Agent', 'PreToolUse：Read（子 Agent 的报告到手以后的下一步）']);
  console.log('| 时间 | 谁 | 事件 |');
  console.log('| --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
  const stops = r.hooks.filter((h: any) => h.event === 'SubagentStop').map((h: any) => (h.at - t0) / 1000);
  const starts = r.hooks.filter((h: any) => h.event === 'SubagentStart').map((h: any) => (h.at - t0) / 1000);
  const serial = stops.reduce((sum: number, stop: number, i: number) => sum + (stop - starts[i]), 0);
  console.log(`\n两个子 Agent 各自用了 ${stops.map((stop: number, i: number) => (stop - starts[i]).toFixed(1)).join('s、')}s，加起来 ${serial.toFixed(1)}s；它们重叠着跑，父 Agent 实际等了 ${(Math.max(...stops) - Math.min(...starts)).toFixed(1)}s。`);
  assert.ok(starts[1] < stops[0], '第二个子 Agent 在第一个结束之前就开始了');
  assert.ok((next.at - t0) / 1000 >= Math.max(...stops), '父 Agent 等两个都结束才继续');
}

if (part === 'denied') {
  const r = load('fg');
  const kinds = new Map<string, string>(r.events.filter((e: any) => e.subtype === 'task_started').map((e: any) => [e.task_id, e.subagent_type]));
  const denied = r.events.filter((e: any) => e.subtype === 'permission_denied');
  console.log('| 被拒绝的工具 | 发起调用的 | 拒绝的原因 |');
  console.log('| --- | --- | --- |');
  for (const e of denied) console.log(`| ${e.tool_name} | ${e.agent_id ? `子 Agent ${kinds.get(e.agent_id)}` : '父 Agent'} | ${short(e.message, 80)} |`);
  assert.ok(denied.length >= 1 && denied.every((e: any) => kinds.get(e.agent_id) === 'Explore'), '被拒绝的都是 Explore 自己的 Bash 调用');
  const asked = r.hooks.filter((h: any) => h.event === 'PermissionRequest' && h.payload.agent_type);
  console.log(`\n同一时刻，PermissionRequest 钩子收到了 ${asked.length} 次请求，payload 里带着 agent_type（${[...new Set(asked.map((h: any) => h.payload.agent_type))].join('、')}）：子 Agent 的权限请求和父 Agent 的走同一条路。`);
}
