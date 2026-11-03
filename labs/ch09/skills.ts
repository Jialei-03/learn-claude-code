// 第 9 章：Skill 的目录、调用和渲染（离线分析）。
//   node labs/ch09/skills.ts [listing|invoke|render]
import { loadRecording } from '../../lab/cc.ts';
import { calls, short } from '../ch06/calls.ts';

const load = (name: string) => loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname);
const part = process.argv[2] ?? 'listing';

if (part === 'listing') {
  const r = load('auto');
  const init = r.events.find((e: any) => e.subtype === 'init');
  const first = r.requests[0];
  const at = (k: string) => (first.markers?.[k] ? first.markers[k].join('、') : '**不在请求里**');
  console.log(`init 事件列出的 Skill（${init.skills.length} 个）：${init.skills.join('、')}`);
  console.log(`斜杠命令里有：${init.slash_commands.filter((c: string) => ['release-notes', 'secret-helper', 'greet'].includes(c)).join('、')}\n`);
  console.log('第一个请求里：');
  console.log(`  release-notes 的描述（CANARY-SKILL-DESC）  → ${at('CANARY-SKILL-DESC')}`);
  console.log(`  旧式命令 greet 的描述（CANARY-COMMAND-DESC）→ ${at('CANARY-COMMAND-DESC')}`);
  console.log(`  secret-helper 的描述（disable-model-invocation）→ ${at('CANARY-HIDDEN-DESC')}`);
  console.log(`  release-notes 的正文（CANARY-SKILL-BODY）  → ${at('CANARY-SKILL-BODY')}`);
  const skill = first.tools.find((t: any) => t.name === 'Skill');
  console.log(`\nSkill 工具：参数 ${skill.params.join('、')}（必填 ${skill.required.join('、')}），描述 ${skill.descChars} 字符`);
}

if (part === 'invoke') {
  const runs: [string, string][] = [['denied', '模型调用（Skill 声明了 allowed-tools）'], ['plain', '模型调用（去掉 allowed-tools）'], ['auto', '模型调用 + 规则 Skill(release-notes)'], ['slash', '用户输入 /release-notes v2.0'], ['command', '用户输入 /greet 小明（旧式命令）']];
  console.log('| 方式 | Skill 工具 | 正文怎样进入对话 |');
  console.log('| --- | --- | --- |');
  for (const [name, label] of runs) {
    const r = load(name);
    const list = calls(r);
    const skill = list.filter(c => c.name === 'Skill');
    const tool = skill.map(c => `${c.decision?.decision === 'accept' ? '✓' : '✗ 要批准'} ${short(c.result, 40)}`).join('<br>') || '没有调用';
    const last = r.requests.at(-1);
    const bodyAt = (last.markers?.['CANARY-SKILL-BODY'] ?? last.markers?.['CANARY-COMMAND-BODY'] ?? []).find((w: string) => !w.endsWith('(assistant)'));
    const readRaw = list.some(c => c.name === 'Read' && String(c.input.file_path).endsWith('SKILL.md'));
    const how = readRaw ? '模型自己用 Read 读了 SKILL.md 原文' : bodyAt?.startsWith('messages[0]') ? '渲染后放进第一条用户消息' : bodyAt ? '渲染后附在 Skill 工具结果的同一条用户消息里' : '—';
    console.log(`| ${label} | ${tool} | ${how} |`);
  }
}

if (part === 'render') {
  const check = (r: any, msgFilter: (w: string) => boolean) => {
    const last = r.requests.at(-1);
    const has = (k: string) => (last.markers?.[k] ?? []).some(msgFilter);
    return [
      has('${CLAUDE_SKILL_DIR}') ? '原样' : '已替换',
      has('$ARGUMENTS') ? '原样' : '已替换',
      has('!`date') ? '**原样（没执行）**' : '已执行',
      has('!`echo') ? '原样（没执行）' : has('CANARY-SHELL-42') ? '已执行，输出 CANARY-SHELL-42' : '—',
      has('CANARY-SKILL-REF') ? '在上下文里' : '不在',
    ];
  };
  console.log('| 占位符 | 模型调用（auto） | 用户调用（slash） | 模型自己读原文（denied） |');
  console.log('| --- | --- | --- | --- |');
  const rows = ['`${CLAUDE_SKILL_DIR}`', '`$ARGUMENTS`', '日期那一行（感叹号前面是全角冒号）', '构建编号那一行（感叹号前面是空格）', 'template.md 的内容'];
  // 只看用户消息（渲染结果、工具结果），不算模型自己复述的部分
  const userOnly = (w: string) => w.endsWith('(user)');
  const a = check(load('auto'), userOnly), s = check(load('slash'), userOnly), d = check(load('denied'), userOnly);
  rows.forEach((row, i) => console.log(`| ${row} | ${a[i]} | ${s[i]} | ${d[i]} |`));
  const denied = calls(load('denied'));
  const shell = denied.filter(c => c.name === 'Bash' && /date|echo CANARY/.test(c.input.command));
  console.log(`\n读原文的那次，模型把两行动态注入当成了要执行的步骤，自己用 Bash 运行了：${shell.map(c => c.input.command).join('、')}`);
}
