// 第 7 章：场景实验的分析（离线）。
//   node labs/ch07/scenario.ts [steps|where|envrule]
//   steps   —— 模型的每一步，以及是哪一道关在起作用
//   where   —— 每个钩子的输出，最终出现在发给模型的请求的什么位置
//   envrule —— 换成 Read(./.env) 的 deny 规则之后，三种读法的结果
import { loadRecording } from '../../lab/cc.ts';
import { calls, short } from '../ch06/calls.ts';

const load = (name: string) => loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname);
const part = process.argv[2] ?? 'steps';
const show = (c: any) => (c.name === 'Bash' ? `\`${short(String(c.input.command), 50).replace(/`/g, "'")}\`` : `${c.name} ${String(c.input.file_path).replace('<project>/', '')}`);

if (part === 'steps') {
  const r = load('scenario');
  const guard = (c: any) => {
    if (c.result.includes('PreToolUse:Bash hook error')) return '钩子 block-dangerous.sh 拦下';
    if (c.result.includes('--dry-run')) return '钩子 dry-run-deploy.mjs 改写参数';
    if (c.result.includes('[REDACTED]')) return `钩子 redact-secrets.mjs 抹掉密钥${/DB_PASSWORD/.test(c.result) ? '；**.env 的内容原样交给了模型**' : ''}`;
    if (c.hooks.includes('PermissionRequest')) return '权限：需要批准（-p 下等于拒绝）';
    if (c.hooks.includes('PostToolUseFailure')) return '命令本身失败（PostToolUseFailure）';
    return '';
  };
  console.log('| # | 调用 | 结果 | 起作用的是 |');
  console.log('| --- | --- | --- | --- |');
  calls(r).forEach((c, i) => console.log(`| ${i + 1} | ${show(c)}${c.input.dangerouslyDisableSandbox ? '（dangerouslyDisableSandbox）' : ''} | ${c.isError ? '✗' : '✓'} | ${guard(c)} |`));
  const stop = r.hooks.filter((h: any) => h.event === 'Stop').map((h: any) => `stop_hook_active=${h.payload.stop_hook_active}`);
  console.log(`\nStop 钩子触发 ${stop.length} 次：${stop.join('，')}。`);
}

if (part === 'where') {
  const r = load('scenario');
  const items: [string, string][] = [
    ['项目信息（来自 SessionStart 钩子）', 'SessionStart 的输出'],
    ['禁止执行破坏性命令', 'PreToolUse 退出码 2 的理由'],
    ['部署命令已被钩子自动加上', 'PreToolUse 的 additionalContext'],
    ['[REDACTED]', 'PostToolUse 改写后的输出'],
    ['sk-live-9f8e7d6c5b4a', '被抹掉的原始密钥'],
    ['结束之前请先运行 npm test', 'Stop 钩子的理由'],
  ];
  console.log('| 钩子的输出 | 第一次出现在 | 位置 |');
  console.log('| --- | --- | --- |');
  for (const [marker, label] of items) {
    const q = r.requests.find((x: any) => x.markers?.[marker]);
    if (!q) { console.log(`| ${label} | **从未发给模型** | — |`); continue; }
    const at = q.markers[marker].filter((w: string) => !w.endsWith('(assistant)'));
    const describe = (w: string) => {
      const [, i, role] = w.match(/messages\[(\d+)\]\((\w+)\)/)!;
      const m = q.messages[Number(i)];
      const kind = m.blocks.some((b: any) => b.type === 'tool_result') ? '工具结果' : role === 'system' ? 'system 消息' : `${role} 消息`;
      return `${kind}（第 ${i} 条${m.blocks[0]?.firstLine ? `，开头“${short(m.blocks[0].firstLine, 24)}”` : ''}）`;
    };
    console.log(`| ${label} | 第 ${q.id} 个请求 | ${at.map(describe).join('；')} |`);
  }
  const pw = load('password');
  console.log(`\n带密码的提示：UserPromptSubmit 钩子拦下后，这次运行一共发出 ${pw.requests.length} 个请求。`);
}

if (part === 'envrule') {
  const r = load('envrule');
  console.log('规则：`deny: ["Read(./.env)"]`，模式 bypassPermissions（除了 deny 规则，什么都不问）\n');
  console.log('| 读法 | 结果 | 模型看到的 |');
  console.log('| --- | --- | --- |');
  for (const c of calls(r)) console.log(`| ${show(c)} | ${c.isError ? '✗ 被拒绝' : '**✓ 读到了**'} | ${short(c.result, 60)} |`);
}
