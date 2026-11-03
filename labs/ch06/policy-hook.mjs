// 第 6 章的 PreToolUse 钩子：命令里有 danger 就拒绝；touch、mkdir 开头的直接放行；其余不表态。
// Claude Code 从标准输入传入 JSON（tool_name、tool_input……），钩子从标准输出返回决定。
let raw = '';
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  const command = JSON.parse(raw).tool_input?.command ?? '';
  const decide = (permissionDecision, permissionDecisionReason) =>
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } }));
  if (command.includes('danger')) decide('deny', '策略钩子：命令里出现了 danger');
  else if (/^(touch|mkdir)\b/.test(command)) decide('allow', '策略钩子：touch / mkdir 一律放行');
});
