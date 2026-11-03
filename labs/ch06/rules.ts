// 第 6 章：同一组规则下十个调用的命运；再把同样的规则和调用交给 mox 的权限扩展，比较两边的判断（离线分析）。
//   node labs/ch06/rules.ts [cc|compare]
import { decidePermission, parseRule, type Rule } from '../../../learn-pi-agent/extensions/permissions/rules.ts';
import { calls, describe, load, short, verdict } from './calls.ts';

const r = load('rules');
const list = calls(r);
const part = process.argv[2] ?? 'cc';
const zh: Record<string, string> = { allow: '放行', deny: '拒绝', ask: '要问用户' };

if (part === 'cc') {
  console.log('| # | 调用 | Claude Code 的决定 | 触发的钩子 | 模型看到的结果 |');
  console.log('| --- | --- | --- | --- | --- |');
  list.forEach((c, i) => {
    const d = c.decision ? `${c.decision.decision}（${c.decision.source}${c.decision.reason_type ? ` / ${c.decision.reason_type}` : ''}）` : '（没有记录）';
    console.log(`| ${i + 1} | ${short(describe(c), 44)} | ${d} | ${c.hooks.filter(h => h !== 'PostToolUse').join('、') || '**没有**'} | ${c.isError ? '✗ ' : ''}${short(c.result, 60)} |`);
  });
}

if (part === 'compare') {
  // mox 的权限扩展（Learn Pi Agent 第 14 章）用的是同样的规则语法
  const cwd = '/project';
  const rules: Rule[] = (['deny', 'ask', 'allow'] as const).flatMap(b => r.rules[b].map((t: string) => parseRule(t, b, cwd)));
  const fix = (v: any) => JSON.parse(JSON.stringify(v).replaceAll('<project>', cwd));
  console.log('| 调用 | Claude Code | mox | 一致？ |');
  console.log('| --- | --- | --- | --- |');
  for (const c of list) {
    const mox = decidePermission(c.name, fix(c.input), { cwd, mode: 'default', rules, home: '/home/user' });
    const cc = verdict(c);
    console.log(`| ${short(describe(c), 44)} | ${zh[cc]} | ${zh[mox.behavior]}：${short(mox.reason, 34)} | ${cc === mox.behavior ? '✓' : '**✗**'} |`);
  }
}
