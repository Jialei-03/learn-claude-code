// 第 8 章：Claude Code 和 MCP 服务器之间发生了什么（离线分析）。
//   node labs/ch08/mcp.ts [wire|calls|change|search]
import { loadRecording } from '../../lab/cc.ts';
import { calls, short } from '../ch06/calls.ts';

const load = (name: string) => loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname);
const part = process.argv[2] ?? 'wire';
const usage = (q: any) => q.response?.usage ?? {};
const total = (u: any) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

if (part === 'wire') {
  const r = load('upfront');
  console.log('| 方向 | 消息 | 要点 |');
  console.log('| --- | --- | --- |');
  for (const { dir, msg } of r.wire) {
    const kind = msg.method ?? (msg.error ? `错误（回复 ${msg.id}）` : `结果（回复 ${msg.id}）`);
    let note = '';
    const p = msg.params ?? {};
    if (msg.method === 'server/discover') note = `先试探新版协议 ${p._meta?.['io.modelcontextprotocol/protocolVersion']}`;
    else if (msg.error) note = short(msg.error.message, 50);
    else if (msg.method === 'initialize') note = `协议 ${p.protocolVersion}；客户端能力：${Object.keys(p.capabilities ?? {}).join('、')}`;
    else if (msg.method === 'tools/call') note = `${p.name}；_meta：${Object.keys(p._meta ?? {}).join('、')}`;
    else if (msg.result?.serverInfo) note = `服务器 ${msg.result.serverInfo.name}；能力：${Object.keys(msg.result.capabilities).join('、')}；带 instructions`;
    else if (msg.result?.tools) note = `${msg.result.tools.length} 个工具`;
    else if (msg.result?.content) note = `${msg.result.isError ? 'isError；' : ''}${msg.result.structuredContent ? '有 structuredContent；' : ''}${short(String(msg.result.content[0]?.text ?? '（空）'), 30)}`;
    console.log(`| ${dir === '→' ? 'Claude Code →' : '← 服务器'} | ${kind} | ${note} |`);
  }
}

if (part === 'calls') {
  const r = load('upfront');
  console.log('| 调用 | 权限 | 模型看到的结果 |');
  console.log('| --- | --- | --- |');
  for (const c of calls(r)) {
    const d = c.decision;
    const perm = d?.decision === 'accept' ? (d.reason_type === 'rule' ? '规则允许' : '允许') : c.hooks.includes('PermissionRequest') ? '**要问用户**' : '拒绝';
    console.log(`| ${c.name.replace('mcp__issues__', 'mcp__issues__')}${c.name === 'Read' ? '（读回存下来的输出）' : ''} | ${perm} | ${c.isError ? '✗ ' : ''}${short(c.result.replace(/<config>\/projects\/[^ ]+/, '<会话目录>/…'), 80)} |`);
  }
}

if (part === 'change') {
  const r = load('upfront');
  const main = r.requests.filter((q: any) => q.tools.length);
  console.log('| 请求 | 工具数 | 新出现的工具 | 输入 token | 其中读缓存 |');
  console.log('| --- | --- | --- | --- | --- |');
  let prev: string[] = [];
  for (const q of main) {
    const names = q.tools.map((t: any) => t.name);
    const added = prev.length ? names.filter((n: string) => !prev.includes(n)) : [];
    const u = usage(q);
    console.log(`| ${q.id} | ${names.length} | ${added.join('、') || '—'} | ${total(u)} | ${u.cache_read_input_tokens ?? 0} |`);
    prev = names;
  }
  const at = main.find((q: any) => q.tools.some((t: any) => t.name.endsWith('delete_issue')));
  const names = at.tools.map((t: any) => t.name);
  const i = names.indexOf('mcp__issues__delete_issue');
  console.log(`\n新工具排在第 ${i + 1} 位（共 ${names.length} 个，按名字排序），前一个是 ${names[i - 1]}，后一个是 ${names[i + 1]}。`);
}

if (part === 'search') {
  const up = load('upfront'), s = load('search');
  const a = up.requests[0], b = s.requests[0];
  const deferred = a.tools.map((t: any) => t.name).filter((n: string) => !b.tools.some((t: any) => t.name === n));
  console.log(`默认（工具全部放进请求）：${a.tools.length} 个工具，第一个请求输入 ${total(usage(a))} token`);
  console.log(`ENABLE_TOOL_SEARCH=true：${b.tools.length} 个工具，第一个请求输入 ${total(usage(b))} token`);
  console.log(`\n被推迟的 ${deferred.length} 个工具：${deferred.join('、')}`);
  console.log(`新出现的：${b.tools.filter((t: any) => !a.tools.some((x: any) => x.name === t.name)).map((t: any) => `${t.name}${t.deferred ? '（defer_loading）' : ''}`).join('、')}`);
  const env = b.messages[1].blocks[0];
  console.log(`被推迟的工具名字出现在哪里：${Object.entries(b.markers).filter(([k]) => ['mcp__issues__slow_count', 'CronCreate'].includes(k)).map(([k, w]: any) => `${k} → ${w.filter((x: string) => x.startsWith('messages')).join('、')}`).join('；')}（第 1 条消息就是环境信息，${env.chars} 字符，默认模式下是 ${a.messages[1].blocks[0].chars}）`);
  console.log('\n模型的调用：');
  const list = calls(s);
  for (const c of list) console.log(`  ${c.name} ${JSON.stringify(c.input)}  →  ${short(c.result, 70)}`);
  const second = s.requests[1];
  const t = second.tools.find((x: any) => x.name === 'mcp__issues__search_issues');
  console.log(`\n下一个请求的工具列表：${second.tools.length} 个，多了 ${t.name}（defer_loading: ${!!t.deferred}，参数 ${t.params.join('、')}）`);
}
