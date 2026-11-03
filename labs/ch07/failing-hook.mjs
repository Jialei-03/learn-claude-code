// 第 7 章：一个“出故障”的 PreToolUse 钩子。命令里的 caseN 决定它怎么坏：
//   case1 退出码 1（脚本自己出错）   case2 stdout 不是 JSON   case3 跑 5 秒（超过 2 秒的超时）
//   case4 退出码 2（正式的“拦下”）   case5 正常：什么也不输出
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const command = JSON.parse(raw).tool_input?.command ?? '';
if (command.includes('case1')) { console.error('jq: command not found'); process.exit(1); }
if (command.includes('case2')) { console.log('Welcome back!'); console.log('{"hookSpecificOutput":{"permissionDecision":"deny"}}'); }
if (command.includes('case3')) await new Promise(r => setTimeout(r, 5000));
if (command.includes('case4')) { console.error('策略：不允许运行 case4'); process.exit(2); }
