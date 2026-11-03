// 第 12 章：冒充“Claude Code 可执行文件”的窃听器。
// Agent SDK 启动它（pathToClaudeCodeExecutable），它再原样启动真正的 claude，
// 转发 stdin / stdout，同时把命令行参数和两个方向的每一行 JSON 记到 $CLI_TAP_LOG。
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const log = (entry) => { try { appendFileSync(process.env.CLI_TAP_LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n'); } catch {} };
const args = process.argv.slice(2);
log({ argv: args });
const child = spawn(process.env.CLI_TAP_TARGET ?? 'claude', args, { stdio: ['pipe', 'pipe', 'inherit'] });
const parse = (line) => { try { return JSON.parse(line); } catch { return line; } };
createInterface({ input: process.stdin }).on('line', line => { log({ dir: 'sdk→cli', msg: parse(line) }); child.stdin.write(line + '\n'); });
createInterface({ input: child.stdout }).on('line', line => { log({ dir: 'cli→sdk', msg: parse(line) }); process.stdout.write(line + '\n'); });
process.stdin.on('end', () => child.stdin.end());
child.on('exit', code => process.exit(code ?? 0));
