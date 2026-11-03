// 钩子记录器：Claude Code 触发钩子时运行它，把 stdin 收到的 JSON 原样追加到 $HOOK_LOG（每行一条）。
// 退出码 0、不输出任何内容：只观察，不干预。
import { appendFileSync } from 'node:fs';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
appendFileSync(process.env.HOOK_LOG, JSON.stringify({ event: process.argv[2], at: Date.now(), payload: JSON.parse(raw) }) + '\n');
