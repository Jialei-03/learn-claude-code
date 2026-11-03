// 第 12 章：Agent SDK 和 Claude Code 进程之间的协议（离线分析）。
//   node labs/ch12/sdk.ts [argv|protocol|callbacks|prompt|source]
import { loadRecording } from '../../lab/cc.ts';
import { short } from '../ch06/calls.ts';

const r = loadRecording(new URL('./recorded/sdk.json', import.meta.url).pathname);
const part = process.argv[2] ?? 'argv';
const kind = (m: any) => (m.type === 'control_request' ? `control_request · ${m.request?.subtype}` : m.type === 'control_response' ? 'control_response' : m.type === 'system' ? `system · ${m.subtype}` : m.type);

if (part === 'argv') {
  console.log(`SDK 启动的命令行：claude ${r.argv.join(' ')}\n`);
  const init = r.wire.find((w: any) => w.msg.request?.subtype === 'initialize').msg.request;
  console.log('第一条消息（SDK → Claude Code）：control_request · initialize');
  console.log(`  hooks：${JSON.stringify(init.hooks)}`);
  console.log(`  sdkMcpServers：${JSON.stringify(init.sdkMcpServers)}，附带工具清单：${init.sdkMcpServerManifests.tickets.toolsListResult.tools.map((t: any) => t.name).join('、')}`);
  console.log(`  systemPrompt：${JSON.stringify(init.systemPrompt)}`);
  const resp = r.wire.find((w: any) => w.dir === 'cli→sdk' && w.msg.type === 'control_response').msg.response.response;
  console.log(`Claude Code 的回答带着：${Object.keys(resp).slice(0, 10).join('、')}……`);
  const user = r.wire.find((w: any) => w.dir === 'sdk→cli' && w.msg.type === 'user').msg;
  console.log(`\n然后才是用户的提问，同样走 stdin：{"type":"user","message":{"role":"user","content":[{"type":"text","text":"${short(user.message.content[0].text, 20)}"}]}}`);
}

if (part === 'protocol') {
  const counts = new Map<string, number>();
  for (const w of r.wire) {
    if (typeof w.msg !== 'object') continue;
    const k = `${w.dir}｜${kind(w.msg)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const what: Record<string, string> = {
    'sdk→cli｜control_request · initialize': '注册钩子回调、进程内的 MCP 服务器、系统提示',
    'sdk→cli｜user': '用户的提问',
    'sdk→cli｜control_response': '回答 Claude Code 的提问（审批、钩子、MCP）',
    'cli→sdk｜control_response': '回答 initialize：可用的命令、子 Agent、模型、权限模式……',
    'cli→sdk｜control_request · can_use_tool': '这个调用要用户批准——问 canUseTool 回调',
    'cli→sdk｜control_request · hook_callback': '触发了 SDK 注册的钩子——执行那个 JS 函数',
    'cli→sdk｜control_request · mcp_message': '调用进程内 MCP 服务器的工具——JSON-RPC 消息转交给 SDK',
    'cli→sdk｜system · init': '和 -p 模式相同的事件流（第 1 章）',
    'cli→sdk｜system · session_state_changed': '会话状态变化（运行中、等待审批、空闲……）',
    'cli→sdk｜system · thinking_tokens': '同上',
    'cli→sdk｜assistant': '同上',
    'cli→sdk｜user': '同上（工具结果）',
    'cli→sdk｜result': '同上',
  };
  console.log('| 方向 | 消息 | 条数 | 作用 |');
  console.log('| --- | --- | --- | --- |');
  for (const [k, n] of counts) {
    const [dir, msg] = k.split('｜');
    console.log(`| ${dir === 'sdk→cli' ? 'SDK → Claude Code' : 'Claude Code → SDK'} | ${msg} | ${n} | ${what[k] ?? ''} |`);
  }
}

if (part === 'callbacks') {
  // 把 SDK 一侧回调被调用的顺序，和协议里对应的请求、回答放在一起
  console.log('| # | SDK 里发生的事 | 工具 | 结果 |');
  console.log('| --- | --- | --- | --- |');
  const responses = r.wire.filter((w: any) => w.dir === 'sdk→cli' && w.msg.type === 'control_response' && w.msg.response?.response?.behavior);
  let k = 0;
  r.callbacks.forEach((c: any, i: number) => {
    let result = '';
    if (c.kind === 'canUseTool') {
      const resp = responses[k++]?.msg.response.response;
      result = resp?.behavior === 'deny' ? `**deny**：${resp.message}` : `allow${c.tool === 'Bash' ? `：\`${short(String(c.input.command), 40)}\`` : ''}`;
    }
    console.log(`| ${i + 1} | ${c.kind} | ${c.tool} | ${result} |`);
  });
}

if (part === 'prompt') {
  const cli = loadRecording(new URL('../ch06/recorded/rules.json', import.meta.url).pathname).requests[0];
  const sdk = r.requests[0];
  console.log('| | claude -p（第 6 章的录制） | Agent SDK，不设 systemPrompt |');
  console.log('| --- | --- | --- |');
  console.log(`| 系统提示 | ${cli.system.map((s: any) => s.chars).join(' + ')} 字符 | ${sdk.system.map((s: any) => s.chars).join(' + ')} 字符 |`);
  console.log(`| 工具 | ${cli.tools.length} 个 | ${sdk.tools.length} 个 |`);
  const extra = sdk.tools.map((t: any) => t.name).filter((n: string) => !cli.tools.some((t: any) => t.name === n));
  console.log(`| SDK 多出的工具 | | ${extra.join('、')} |`);
  console.log(`| 环境信息（system 消息） | ${cli.messages[1].blocks[0].chars} 字符 | ${sdk.messages[1].blocks[0].chars} 字符 |`);
}

if (part === 'source') {
  // 录制用的是 TypeScript 版 SDK（闭源），这里拿开源的 Python 版 SDK 的源码来对照同一套协议
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { OSS } = await import('../../course/syllabus.ts');
  const dir = process.env[OSS['agent-sdk-python'].env] ?? new URL(`../../${OSS['agent-sdk-python'].dir}/`, import.meta.url).pathname;
  const query = readFileSync(join(dir, 'src/claude_agent_sdk/_internal/query.py'), 'utf8');
  const cli = readFileSync(join(dir, 'src/claude_agent_sdk/_internal/transport/subprocess_cli.py'), 'utf8');
  const handler = query.slice(query.indexOf('async def _handle_control_request'), query.indexOf('async def _send_control_request'));

  const recorded = r.wire.filter((w: any) => w.dir === 'cli→sdk' && w.msg.type === 'control_request').map((w: any) => w.msg.request);
  const recordedTypes = [...new Set(recorded.map((q: any) => q.subtype))];
  const handled = [...handler.matchAll(/subtype == "(\w+)"/g)].map(m => m[1]);
  console.log('| | 录制（TypeScript SDK + Claude Code 2.1.296） | Python SDK 源码 |');
  console.log('| --- | --- | --- |');
  console.log(`| Claude Code 发给 SDK 的请求类型 | ${recordedTypes.join('、')} | 处理 ${handled.join('、')}，其余回答“不支持” |`);
  const fieldsOf = (sub: string) => [...new Set(recorded.filter((q: any) => q.subtype === sub).flatMap((q: any) => Object.keys(q)))].filter(k => k !== 'subtype');
  const readIn = (block: string) => [...new Set([...block.matchAll(/(?:permission_request|hook_callback_request|request_data)(?:\.get\(|\[)"(\w+)"/g)].map(m => m[1]))];
  const perm = handler.slice(handler.indexOf('"can_use_tool"'), handler.indexOf('"hook_callback"'));
  console.log(`| can_use_tool 请求的字段 | ${fieldsOf('can_use_tool').join('、')} | 读取 ${readIn(perm).join('、')} |`);
  const hook = handler.slice(handler.indexOf('"hook_callback"'), handler.indexOf('"mcp_message"'));
  console.log(`| hook_callback 请求的字段 | ${fieldsOf('hook_callback').join('、')} | 读取 ${readIn(hook).join('、')} |`);
  const allowResp = r.wire.find((w: any) => w.dir === 'sdk→cli' && w.msg.response?.response?.behavior === 'allow')?.msg.response.response;
  const denyResp = r.wire.find((w: any) => w.dir === 'sdk→cli' && w.msg.response?.response?.behavior === 'deny')?.msg.response.response;
  console.log(`| 审批的回答 | allow：${Object.keys(allowResp).join('、')}；deny：${Object.keys(denyResp).join('、')} | allow：behavior、updatedInput（可选 updatedPermissions）；deny：behavior、message（可选 interrupt） |`);
  const base = cli.match(/cmd = \[self\._cli_path, ([^\]]+)\]/)?.[1].replace(/"/g, '').replace(/, /g, ' ') ?? '';
  console.log(`| 启动参数 | ${r.argv.join(' ')} | 先是 ${base}，最后追加 --input-format stream-json；有审批回调时 --permission-prompt-tool stdio |`);
  const emptyPrompt = /if self\._options\.system_prompt is None:\s*\n\s*cmd\.extend\(\["--system-prompt", ""\]\)/.test(cli);
  const init = r.wire.find((w: any) => w.msg.request?.subtype === 'initialize').msg.request;
  console.log(`| 不设系统提示时 | initialize 里带 systemPrompt: ${JSON.stringify(init.systemPrompt)} | ${emptyPrompt ? '命令行加 --system-prompt ""' : '?'} |`);
}
