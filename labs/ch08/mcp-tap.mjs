// 第 8 章：夹在 Claude Code 和 MCP 服务器之间的“窃听器”。
// 原样转发 stdin → 服务器、服务器 stdout → stdout，同时把每一行 JSON-RPC 消息记到 $MCP_TAP_LOG。
//   node mcp-tap.mjs <服务器命令> [参数...]
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const record = (dir, line) => { try { appendFileSync(process.env.MCP_TAP_LOG, JSON.stringify({ dir, at: Date.now(), msg: JSON.parse(line) }) + '\n'); } catch {} };
createInterface({ input: process.stdin }).on('line', line => { record('→', line); child.stdin.write(line + '\n'); });
createInterface({ input: child.stdout }).on('line', line => { record('←', line); process.stdout.write(line + '\n'); });
process.stdin.on('end', () => child.stdin.end());
child.on('exit', code => process.exit(code ?? 0));
