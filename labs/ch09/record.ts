// 第 9 章：Skills 与命令（需要模型服务）。
//   denied  —— 模型自己决定调用 Skill，但手动模式下 Skill 工具也要批准
//   auto    —— 同上，加一条允许规则 Skill(release-notes)
//   slash   —— 用户用 /release-notes v2.0 直接调用（带参数）
//   command —— 旧式的 .claude/commands/greet.md
//   plain   —— 对照：一个没有 allowed-tools 的 Skill，模型调用它要不要批准
//   node labs/ch09/record.ts [denied|auto|slash|command|plain]
import { runClaude, saveRecording } from '../../lab/cc.ts';

const which = process.argv[2];
// #region files
export const FILES = {
  '.claude/skills/release-notes/SKILL.md': [
    '---',
    'name: release-notes',
    'description: CANARY-SKILL-DESC 根据提交列表写发布说明。用户要求写发布说明、更新日志、changelog 时使用。',
    'allowed-tools: Bash(cat *)',
    '---',
    'CANARY-SKILL-BODY',
    '写发布说明的步骤：',
    '1. 用 Read 读 ${CLAUDE_SKILL_DIR}/template.md，按它的格式写。',
    '2. 读 commits.txt，把提交按 feat / fix 分组。',
    '3. 输出 Markdown，标题里写上版本号。',
    '',
    // 动态注入：!`命令` 只在行首或空白之后才被识别——第一行前面是全角冒号，第二行前面是空格
    '今天的日期：!`date +%Y-%m-%d`',
    '构建编号： !`echo CANARY-SHELL-$((40+2))`',
    '版本号：$ARGUMENTS',
  ].join('\n'),
  '.claude/skills/release-notes/template.md': 'CANARY-SKILL-REF\n# 版本 <版本号>（<日期>）\n## 新功能\n## 修复\n',
  // 只能由用户调用、模型看不到的 Skill
  '.claude/skills/secret-helper/SKILL.md': '---\nname: secret-helper\ndescription: CANARY-HIDDEN-DESC 只给人用的内部工具。\ndisable-model-invocation: true\n---\nCANARY-HIDDEN-BODY\n',
  // 旧式命令
  '.claude/commands/greet.md': '---\ndescription: CANARY-COMMAND-DESC 向某人问好\n---\nCANARY-COMMAND-BODY 用一句话向 $ARGUMENTS 问好。\n',
  'commits.txt': 'feat: 支持 MCP 服务器\nfix: 压缩后丢失文件列表\nfeat: 工具搜索\nfix: Ctrl+C 不退出\n',
};
// #endregion
export const MARKERS = ['CANARY-SKILL-DESC', 'CANARY-SKILL-BODY', 'CANARY-SKILL-REF', 'CANARY-HIDDEN-DESC', 'CANARY-HIDDEN-BODY', 'CANARY-COMMAND-DESC', 'CANARY-COMMAND-BODY', '${CLAUDE_SKILL_DIR}', '!`date', '!`echo', 'CANARY-SHELL-42', '$ARGUMENTS'];
const hookEvents = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PermissionRequest'];
const save = (name: string, r: any, extra: Record<string, unknown>) => {
  saveRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname, r, extra, MARKERS);
  console.log(`${name}：请求 ${r.requests.length} 个；${String(r.events.at(-1)?.result ?? '').replace(/\s+/g, ' ').slice(0, 90)}`);
};
const args = ['--permission-mode', 'default'];

const ask = '根据 commits.txt 写一份 v2.0 的发布说明。';
if (!which || which === 'denied') save('denied', await runClaude({ prompt: ask, files: FILES, hookEvents, args }), { prompt: ask });
if (!which || which === 'auto') save('auto', await runClaude({ prompt: ask, files: FILES, hookEvents, args, settings: { permissions: { allow: ['Skill(release-notes)'] } } }), { prompt: ask, allow: ['Skill(release-notes)'] });
if (!which || which === 'slash') save('slash', await runClaude({ prompt: '/release-notes v2.0', files: FILES, hookEvents, args }), { prompt: '/release-notes v2.0' });
if (!which || which === 'command') save('command', await runClaude({ prompt: '/greet 小明', files: FILES, hookEvents, args }), { prompt: '/greet 小明' });

// #region plain
// 和 release-notes 一样的内容，只是去掉了 allowed-tools
const plainFiles = { ...FILES, '.claude/skills/release-notes/SKILL.md': FILES['.claude/skills/release-notes/SKILL.md'].replace('allowed-tools: Bash(cat *)\n', '') };
// #endregion
if (!which || which === 'plain') save('plain', await runClaude({ prompt: ask, files: plainFiles, hookEvents, args }), { prompt: ask, note: '去掉 allowed-tools' });
