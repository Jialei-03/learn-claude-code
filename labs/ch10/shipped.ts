// 第 10 章：源码里写着的路，在发布的 2.1.88 里走得到几条？
//   node labs/ch10/shipped.ts gates     编译开关与灰度：fork、Explore / Plan、verification、嵌套
//   node labs/ch10/shipped.ts tools     发布版里两张工具清单的真实内容
//   node labs/ch10/shipped.ts versions  录制（2.1.296）里出现、2.1.88 的包里没有的说明文字
// 只在 cli.js 里查找和计数（见 bundle.ts），不复制源码。
import assert from 'node:assert/strict';
import { loadRecording } from '../../lab/cc.ts';
import { bundle, shippedGates, shippedToolLists } from './bundle.ts';

const part = process.argv[2] ?? 'gates';
const g = shippedGates();
const lists = shippedToolLists();

if (part === 'gates') {
  const rows: [string, string, string, string][] = [
    ['隐式 fork（不写 subagent_type，继承父对话）', "feature('FORK_SUBAGENT')", `判断函数被折叠成恒为 false；fork 的提示词字符串还留在包里（${g.forkPromptStillInBundle ? '有' : '无'}）`, g.forkOff ? '走不到' : '走得到'],
    ['Explore、Plan', "feature('BUILTIN_EXPLORE_PLAN_AGENTS') 加灰度 tengu_amber_stoat", `编译开关保留，只剩灰度判断，缺省值 true`, g.exploreGate ? '默认有，服务端可以关' : '走不到'],
    ['verification（验证 Agent）', "feature('VERIFICATION_AGENT') 加灰度 tengu_hive_evidence", `灰度名${g.verificationGateName ? '在' : '不在'}包里；提示词字符串还留在包里（${g.verificationPromptStillInBundle ? '有' : '无'}）`, g.verificationGateName ? '走得到' : '走不到'],
    ['协调者模式替换内置清单', "feature('COORDINATOR_MODE') 加环境变量", `环境变量名${g.coordinatorEnv ? '在' : '不在'}包里`, g.coordinatorEnv ? '走得到' : '走不到'],
    ['claude-code-guide', '入口不是 sdk-ts / sdk-py / sdk-cli', `字符串${g.guideAgent ? '在' : '不在'}包里`, '交互式 CLI 里有，SDK 里没有'],
    ['子 Agent 再派子 Agent', "process.env.USER_TYPE === 'ant'", `禁用清单里${lists.allDisallowed.includes('Agent') ? '有' : '没有'} Agent`, lists.allDisallowed.includes('Agent') ? '外部用户不能嵌套' : '可以嵌套'],
  ];
  console.log('| 机制 | 源码里的开关 | 发布的 cli.js 里 | 走得到吗 |');
  console.log('| --- | --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
  assert.ok(g.forkOff, 'FORK_SUBAGENT 被编译成恒为 false');
  assert.ok(g.exploreGate, 'Explore / Plan 只剩灰度判断');
  assert.ok(!g.verificationGateName, 'verification 的灰度名不在包里');
  assert.ok(!g.coordinatorEnv, '协调者模式的环境变量名不在包里');
  assert.ok(lists.allDisallowed.includes('Agent'), '外部版本的子 Agent 拿不到 Agent 工具');
}

if (part === 'tools') {
  console.log('**所有子 Agent 共用的禁用清单**（发布版里的实际内容）\n');
  console.log(lists.allDisallowed.map((name) => `\`${name}\``).join('、'));
  console.log('\n**后台子 Agent 的允许清单**（不在清单里的工具，后台子 Agent 一律拿不到；MCP 工具不受这条限制）\n');
  console.log(lists.asyncAllowed.map((name) => `\`${name}\``).join('、'));
  assert.deepEqual(lists.allDisallowed, ['TaskOutput', 'ExitPlanMode', 'EnterPlanMode', 'Agent', 'AskUserQuestion', 'TaskStop']);
  assert.ok(!lists.asyncAllowed.includes('AskUserQuestion') && !lists.asyncAllowed.includes('SendMessage'));
  assert.ok(lists.asyncAllowed.every((name) => !name.startsWith('?')), '清单里的每个标识符都解析出了名字');
}

if (part === 'versions') {
  const recorded = (name: string) => JSON.stringify(loadRecording(new URL(`./recorded/${name}.json`, import.meta.url).pathname).events);
  const fg = recorded('fg');
  const bg = recorded('bg');
  const rows: [string, boolean, boolean][] = [
    ['前台报告外面的说明：这是模型输出，不是用户的话（[Subagent hand-back]）', fg.includes('Subagent hand-back'), bundle.includes('Subagent hand-back')],
    ['后台“已启动”里的提醒：通知到来之前，你对结果一无所知', bg.includes('You know nothing about its results'), bundle.includes('You know nothing about its results')],
  ];
  console.log('| 子 Agent 交回结果时的文字 | 2.1.296 的录制里 | 2.1.88 的 cli.js 里 |');
  console.log('| --- | --- | --- |');
  for (const [what, inRecording, inBundle] of rows) console.log(`| ${what} | ${inRecording ? '有' : '没有'} | ${inBundle ? '有' : '没有'} |`);
  assert.ok(rows.every(([, inRecording, inBundle]) => inRecording && !inBundle));
}
