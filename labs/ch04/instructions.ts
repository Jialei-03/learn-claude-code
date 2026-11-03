// 第 4 章：每个说明文件进入了哪个请求的哪个位置（离线分析金丝雀的位置）。
//   node labs/ch04/instructions.ts [where|hooks]
import { loadRecording } from '../../lab/cc.ts';

const r = loadRecording(new URL('./recorded/instructions.json', import.meta.url).pathname);
const files: [string, string][] = [
  ['CANARY-USER-CLAUDEMD', '用户级 CLAUDE.md（配置目录里）'], ['CANARY-PROJECT-CLAUDEMD', '项目的 CLAUDE.md'], ['CANARY-IMPORTED', '被 @docs/conventions.md 导入的文件'],
  ['CANARY-LOCAL-MD', 'CLAUDE.local.md'], ['CANARY-AGENTS-MD', 'AGENTS.md'], ['CANARY-SUBDIR-CLAUDEMD', 'src/CLAUDE.md（子目录）'],
  ['CANARY-PATH-RULE', '.claude/rules/api.md（paths: src/api/**）'], ['CANARY-IN-HTML-COMMENT', 'CLAUDE.md 里 HTML 注释中的文字'],
];
const part = process.argv[2] ?? 'where';
if (part === 'where') {
  const reqs = r.requests.filter((q: any) => q.messages?.length && q.system?.length > 2);
  console.log(`两个请求：第 1 个在读文件之前，第 2 个在读了 src/api/handler.js 和 src/util.js 之后。\n`);
  console.log(`| 文件 | ${reqs.map((_: any, i: number) => `第 ${i + 1} 个请求`).join(' | ')} |`);
  console.log(`| --- | ${reqs.map(() => '---').join(' | ')} |`);
  for (const [canary, label] of files) {
    console.log(`| ${label} | ${reqs.map((q: any) => (q.markers?.[canary] ?? []).join('、') || '—').join(' | ')} |`);
  }
  const first = reqs[0].messages[0].blocks[0];
  console.log(`\n第一条用户消息的第一个内容块：${first.chars} 个字符，以 ${first.firstLine} 开头。`);
  const late = reqs[1].messages.findIndex((m: any) => m.role === 'system' && m.blocks[0].firstLine.startsWith('Contents of'));
  console.log(`按需加载的两个文件，出现在第 2 个请求的 messages[${late}]，一条 system 角色的消息。`);
}
if (part === 'hooks') {
  console.log('| 文件 | memory_type | load_reason | 由谁引起 |');
  console.log('| --- | --- | --- | --- |');
  for (const h of r.hooks.filter((x: any) => x.event === 'InstructionsLoaded')) {
    const p = h.payload;
    console.log(`| ${p.file_path.replace('<project>/', '')} | ${p.memory_type} | ${p.load_reason} | ${p.parent_file_path ? `被 ${p.parent_file_path.replace('<project>/', '')} 导入` : p.trigger_file_path ? `读了 ${p.trigger_file_path.replace('<project>/', '')}` : '会话开始'} |`);
  }
}
