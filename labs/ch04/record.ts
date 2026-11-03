// 第 4 章：CLAUDE.md、规则文件、自动记忆分别在什么时候、以什么形式进入请求（需要模型服务）。
//   node labs/ch04/record.ts
// 每个说明文件里放一个独一无二的“金丝雀”字符串，再看它出现在每个请求的哪个位置。
import { runClaude, saveRecording } from '../../lab/cc.ts';

export const CANARIES = {
  user: 'CANARY-USER-CLAUDEMD', project: 'CANARY-PROJECT-CLAUDEMD', imported: 'CANARY-IMPORTED', local: 'CANARY-LOCAL-MD',
  agents: 'CANARY-AGENTS-MD', subdir: 'CANARY-SUBDIR-CLAUDEMD', rule: 'CANARY-PATH-RULE', comment: 'CANARY-IN-HTML-COMMENT',
};
const C = CANARIES;

// ① 各种说明文件
const files = {
  'CLAUDE.md': `# 项目说明\n${C.project}：提交说明用中文写。\n<!-- ${C.comment}：这是给维护者的备注 -->\n@docs/conventions.md\n`,
  'docs/conventions.md': `${C.imported}：函数名用驼峰。\n`,
  'CLAUDE.local.md': `${C.local}：我本机的数据库在 5433 端口。\n`,
  'AGENTS.md': `${C.agents}：这是给其他 Agent 的说明。\n`,
  'src/CLAUDE.md': `${C.subdir}：src 目录下的代码不要加分号。\n`,
  '.claude/rules/api.md': `---\npaths:\n  - "src/api/**"\n---\n${C.rule}：API 处理函数必须校验输入。\n`,
  'src/api/handler.js': 'export function handle(req) { return req.body }\n',
  'src/util.js': 'export const id = x => x\n',
};
const run1 = await runClaude({
  prompt: '先读 src/api/handler.js，再读 src/util.js。然后告诉我：你的上下文里有哪些关于这个项目的规则？逐条列出，每条注明你认为它来自哪里。',
  files, configFiles: { 'CLAUDE.md': `${C.user}：回答尽量简短。\n` }, hookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'InstructionsLoaded'],
});
saveRecording(new URL('./recorded/instructions.json', import.meta.url).pathname, run1, { prompt: '读两个文件，列出上下文里的规则' }, Object.values(C));
console.log(`① 退出码 ${run1.exitCode}，请求 ${run1.requests.length} 个`);

// ② 让它记住一件事；③ 新会话，同一个项目
const run2 = await runClaude({ prompt: '记住：这个项目的测试命令是 pnpm test:unit，以后都用这个。', files: { 'package.json': '{"name":"demo"}\n' } });
saveRecording(new URL('./recorded/remember.json', import.meta.url).pathname, run2, { prompt: '记住测试命令' }, ['pnpm test:unit']);
console.log(`② 退出码 ${run2.exitCode}`);
const run3 = await runClaude({ prompt: '这个项目的测试命令是什么？只回答命令。', reuse: { cwd: run2.cwd, configDir: run2.configDir } });
saveRecording(new URL('./recorded/recall.json', import.meta.url).pathname, run3, { prompt: '新会话：测试命令是什么' }, ['pnpm test:unit']);
console.log(`③ 退出码 ${run3.exitCode}：${run3.events.at(-1)?.result}`);
