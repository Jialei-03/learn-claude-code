// 第 6 章：直接运行 Claude Code 2.1.88 里的权限函数（运行时从固定提交取出，不复制进仓库）。
//   node labs/ch06/upstream.mjs order     同一个决策函数，不同的“规则 × 模式 × 工具自己的意见”
//   node labs/ch06/upstream.mjs grammar   规则字符串怎样解析
//   node labs/ch06/upstream.mjs bash      Bash 规则的匹配：放行侧和拒绝侧的差别
//   node labs/ch06/upstream.mjs decide    单条命令的完整决策，对照真实录制
import { SCENARIOS, parseRuleString, parseShellRule, realBash, realBashMatches, realDecision } from './real.mjs';
import { calls, load, verdict } from './calls.ts';

const part = process.argv[2] ?? 'order';
const zh = { allow: '放行', ask: '问用户', deny: '拒绝' };
const code = (text) => `\`${String(text).replace(/\|/g, '\\|')}\``;
const ruleText = (rules = {}) => ['deny', 'ask', 'allow'].filter((b) => rules[b]?.length).map((b) => `${b}: ${rules[b].map(code).join('、')}`).join('；') || '（无）';
const LOCAL_ZH = { passthrough: '没有意见', allow: 'allow', deny: 'deny', ask: '普通 ask', 'content-ask': '内容 ask 规则', 'safety-check': '受保护路径' };

if (part === 'order') {
  console.log('| # | 场景 | 模式 | 规则 | 工具自己的检查 | 真实函数的决定 | 依据 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  let n = 0;
  for (const scenario of SCENARIOS) {
    const result = await realDecision(scenario);
    console.log(`| ${++n} | ${scenario.title} | ${scenario.mode} | ${ruleText(scenario.rules)} | ${LOCAL_ZH[scenario.local ?? 'passthrough']} | **${zh[result.behavior]}** | ${result.why} |`);
  }
}

if (part === 'grammar') {
  console.log('| 规则字符串 | 工具名 | 内容 | 作为命令规则时 |');
  console.log('| --- | --- | --- | --- |');
  const rows = ['Bash', 'Bash()', 'Bash(*)', 'Bash(npm run *)', 'Bash(npm:*)', 'Bash(git status)', 'Read(.env)', 'Edit(/src/**)', 'Bash(python -c "print\\(1\\)")', 'mcp__gh__search'];
  for (const text of rows) {
    const parsed = parseRuleString(text);
    const shell = parsed.ruleContent === undefined || parsed.toolName !== 'Bash' ? '—' : { prefix: '前缀（旧写法）', wildcard: '通配符', exact: '精确匹配' }[parseShellRule(parsed.ruleContent).type];
    console.log(`| ${code(text)} | ${parsed.toolName} | ${parsed.ruleContent === undefined ? '（整个工具）' : code(parsed.ruleContent)} | ${shell} |`);
  }
}

if (part === 'bash') {
  console.log('同一条规则写在 allow 里和写在 deny 里，能匹配到的命令不一样：\n');
  console.log('| 命令 | 规则 | 写在 allow 里 | 写在 deny 里 |');
  console.log('| --- | --- | --- | --- |');
  const cases = [
    ['npm test', 'npm test *'],
    ['NODE_ENV=prod npm test', 'npm test *'],
    ['NODE_OPTIONS=--require=x npm test', 'npm test *'],
    ['FOO=bar rm -f tmp.txt', 'rm *'],
    ['timeout 5 rm tmp.txt', 'rm *'],
    ['nohup FOO=bar timeout 5 rm tmp.txt', 'rm *'],
    ['xargs rm tmp.txt', 'rm *'],
    ['xargs rm tmp.txt', 'rm:*'],
    ['lsof -i', 'ls:*'],
    ['lsof -i', 'ls*'],
    ['git', 'git *'],
    ['gitk', 'git *'],
  ];
  for (const [command, rule] of cases) {
    const hit = (behavior) => (realBashMatches(command, { rules: { [behavior]: [rule] } })[behavior].length ? '匹配' : '不匹配');
    console.log(`| ${code(command)} | ${code(rule)} | ${hit('allow')} | ${hit('deny')} |`);
  }
}

if (part === 'decide') {
  // 和第 6 章开头的录制用同一组规则（只取 Bash 的部分）；录制来自 2.1.296，函数来自 2.1.88
  const rules = { allow: ['echo *', 'npm test *'], ask: ['git push *'], deny: ['rm *'] };
  const recordedRules = calls(load('rules'));
  const recordedModes = { default: calls(load('mode-default')), acceptEdits: calls(load('mode-acceptEdits')) };
  const recordedOf = (list, command) => list.find((c) => c.input.command === command);
  console.log('| 命令 | 模式 | 2.1.88 的函数 | 依据 | 2.1.296 的录制 |');
  console.log('| --- | --- | --- | --- | --- |');
  const rows = [
    ['echo hello', 'default', recordedRules], ['timeout 5 echo wrapped', 'default', recordedRules], ['FOO=bar rm -f tmp.txt', 'default', recordedRules],
    ['/bin/rm -f tmp.txt', 'default', recordedRules], ['git push origin main', 'default', recordedRules], ['ls src', 'default', recordedRules],
    ['mkdir build', 'default', recordedModes.default], ['mkdir build', 'acceptEdits', recordedModes.acceptEdits],
    ['node -e "console.log(42)"', 'acceptEdits', recordedModes.acceptEdits],
  ];
  for (const [command, mode, record] of rows) {
    const result = realBash(command, { mode, rules: mode === 'default' && record === recordedRules ? rules : {} });
    const recorded = recordedOf(record, command);
    console.log(`| ${code(command)} | ${mode} | **${zh[result.behavior]}** | ${result.why} | ${recorded ? zh[verdict(recorded)] : '—'} |`);
  }
}
