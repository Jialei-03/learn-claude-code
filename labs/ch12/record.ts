// 第 12 章：用 Agent SDK 驱动 Claude Code，并窃听 SDK 和 Claude Code 进程之间的协议（需要模型服务）。
// SDK 里注册三样东西：审批回调 canUseTool、一个 PreToolUse 钩子（JS 函数），以及一个进程内的 MCP 工具。
//   node labs/ch12/record.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { modelConfig, saveRecording } from '../../lab/cc.ts';
import { startProxy } from '../../lab/proxy.ts';

const { base, key, model } = modelConfig();
const root = mkdtempSync(join(tmpdir(), 'lcc-'));
const cwd = join(root, 'project'), configDir = join(root, 'config');
mkdirSync(join(cwd, 'build'), { recursive: true });
mkdirSync(configDir, { recursive: true });
writeFileSync(join(cwd, 'build', 'out.js'), '// build output\n');
const tapLog = join(root, 'cli-tap.jsonl');
const proxy = await startProxy(base);
const claude = existsSync(join(homedir(), '.local/bin/claude')) ? join(homedir(), '.local/bin/claude') : 'claude';

// #region sdk
const callbacks: { kind: string; tool?: string; input?: unknown; decision?: string }[] = [];

// 一个在 SDK 进程里运行的 MCP 工具：Claude Code 调用它时，请求经过 stdio 送回 SDK
const tickets = createSdkMcpServer({
  name: 'tickets', version: '1.0.0',
  tools: [tool('lookup_ticket', '按编号查工单的状态。', { id: z.number() }, async ({ id }) => {
    callbacks.push({ kind: 'mcp 工具在 SDK 进程里执行', tool: 'lookup_ticket', input: { id } });
    return { content: [{ type: 'text', text: id === 7 ? '工单 #7：已修复，等待发布' : `工单 #${id}：不存在` }] };
  })],
});

const run = query({
  prompt: '查一下工单 7 的状态，把结果写进 status.txt；然后运行 `rm -rf build` 清理构建目录。',
  options: {
    cwd, model, permissionMode: 'default',
    pathToClaudeCodeExecutable: fileURLToPath(new URL('./cli-tap.mjs', import.meta.url)),
    env: { HOME: homedir(), PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_API_KEY: key, ANTHROPIC_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLI_TAP_LOG: tapLog, CLI_TAP_TARGET: claude },
    mcpServers: { tickets },
    // 审批回调：Claude Code 要问用户的时候，改为问这个函数
    canUseTool: async (toolName, input) => {
      const deny = toolName === 'Bash' && /rm\s+-rf/.test(String(input.command));
      callbacks.push({ kind: 'canUseTool', tool: toolName, input, decision: deny ? 'deny' : 'allow' });
      return deny ? { behavior: 'deny', message: 'SDK 回调：不允许 rm -rf，请改用 rm -r 并逐个确认' } : { behavior: 'allow', updatedInput: input };
    },
    // 钩子也可以是 JS 函数
    hooks: {
      PreToolUse: [{ hooks: [async (input: any) => {
        callbacks.push({ kind: 'PreToolUse 钩子', tool: input.tool_name });
        return {};
      }] }],
    },
  },
});
const messages: any[] = [];
for await (const m of run) messages.push(m);
// #endregion
await proxy.close();

const tap = readFileSync(tapLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const result = { cwd, configDir, events: messages, hooks: [], requests: proxy.captured, exitCode: 0, stderr: '', transcripts: [] };
saveRecording(new URL('./recorded/sdk.json', import.meta.url).pathname, result as any, { callbacks, argv: tap.find(t => t.argv)?.argv, wire: tap.filter(t => t.dir) });
console.log(`SDK 消息 ${messages.length} 条，协议消息 ${tap.length - 1} 行，回调 ${callbacks.length} 次；${String(messages.at(-1)?.result ?? '').replace(/\s+/g, ' ').slice(0, 100)}`);
