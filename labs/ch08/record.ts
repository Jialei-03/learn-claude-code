// 第 8 章：接上 Learn Pi Agent 第 12 章的 issue 服务器（需要模型服务）。
//   upfront —— 默认设置：工具定义一开始就全部放进请求；逐个调用几个有代表性的工具
//   search  —— ENABLE_TOOL_SEARCH=true：工具定义推迟加载，模型要先搜索
//   node labs/ch08/record.ts [upfront|search]
// 服务器前面夹了一个窃听器（mcp-tap.mjs），记下 Claude Code 和服务器之间的每一条 JSON-RPC 消息。
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, saveRecording, type RunOptions } from '../../lab/cc.ts';
import { truncateDeep } from '../../lab/derive.ts';

const which = process.argv[2];
const server = fileURLToPath(new URL('../../../learn-pi-agent/labs/fixtures/mcp-server.ts', import.meta.url));
const tap = fileURLToPath(new URL('./mcp-tap.mjs', import.meta.url));
export const MARKERS = ['新建 issue 之前先用 search_issues 查重', '按关键词搜索 issue', 'compile src/module-2999', '#42 [open]', 'mcp__issues__slow_count', 'CronCreate'];

async function run(name: string, options: Omit<RunOptions, 'args'>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lcc-mcp-'));
  const log = join(dir, 'wire.jsonl');
  const config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { issues: { command: 'node', args: [tap, 'node', server], env: { MCP_TAP_LOG: log } } } }));
  const r = await runClaude({ ...options, env, args: ['--mcp-config', config, '--permission-mode', 'default'] });
  const wire = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
  saveRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname, r, { prompt: options.prompt, env, wire: truncateDeep(wire, 400) }, MARKERS);
  console.log(`${name}：请求 ${r.requests.length} 个，JSON-RPC 消息 ${wire.length} 条；${String(r.events.at(-1)?.result ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
}

// #region upfront
export const STEPS = [
  '用 search_issues 搜索所有 open 的 issue（query 用空字符串）',
  '用 create-issue 新建一个 issue，标题是“MCP 工具搜索”',
  '调用 enable_admin_tools',
  '调用 dump_log，告诉我构建日志的最后一行',
  '调用 fail',
];
// 只允许搜索；其余 MCP 工具在手动模式下要问用户
const allowSearch = { permissions: { allow: ['mcp__issues__search_issues', 'mcp__issues__enable_admin_tools', 'mcp__issues__dump_log', 'mcp__issues__fail'] } };
// #endregion
if (!which || which === 'upfront') {
  await run('upfront', {
    prompt: `用 issues 服务器的工具，严格按顺序做下面 ${STEPS.length} 步，每一步只调用一次工具；不管成功还是失败都直接做下一步，不要重试。最后逐条报告结果。\n${STEPS.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    settings: allowSearch, hookEvents: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'],
  });
}

// #region search
// 这个版本的 Claude Code 在 ANTHROPIC_BASE_URL 指向网关时默认不开工具搜索（文档：v2.1.304 起才默认开启），这里显式打开
// #endregion
if (!which || which === 'search') {
  await run('search', { prompt: 'issue 系统里有哪些和压缩有关的 open issue？', settings: allowSearch, hookEvents: ['PreToolUse', 'PostToolUse'] }, { ENABLE_TOOL_SEARCH: 'true' });
}
