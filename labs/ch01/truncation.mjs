// 第 1 章：输出被截断时，Pi 和 Claude Code 各自怎么办？
//   node --disable-warning=ExperimentalWarning labs/ch01/truncation.mjs
// 第一部分：“半截的工具参数”到了 Claude Code 的解析函数手里是什么。
//   运行的是固定提交里真正的 normalizeContentFromAPI 和严格解析 parseJSONUncached
//   （构建时从 git 对象里取出来执行，不复制进仓库；日志、工具查找等外围依赖是占位端口）。
// 第二部分：同一份模型脚本，两个循环：
//   · mox 的 runLoop：行为与 Pi 的 runLoop 一致（Learn Pi Agent 第 3 章逐项对照过）；
//   · coda 的 Engine：本章写的，对应 Claude Code 的 queryLoop。
import assert from 'node:assert/strict';
import { Engine, collect } from '../../coda/src/engine.mjs';
import { Toolset } from '../../coda/src/tools.mjs';
import { runLoop } from '../../../learn-pi-agent/mox/src/loop.ts';
import { scripted as moxScripted } from '../../../learn-pi-agent/mox/src/providers/scripted.ts';
import { upstream } from '../engineering/run.mjs';

// ── 第一部分：半截的参数 ────────────────────────────────────────
const parseJSONUncached = upstream('json-parse-strict', 'parseJSONUncached', { stripBOM: (s) => s, logError() {} });
// 和 utils/json.ts 的 safeParseJSON 同样的外壳：空串是 null，解析失败也是 null
const safeParseJSON = (text) => {
  if (!text) return null;
  const result = parseJSONUncached(text, false);
  return result.ok ? result.value : null;
};
const logged = [];
const normalizeContent = upstream('tool-input-normalize', 'normalizeContentFromAPI', {
  isObject: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
  safeParseJSON,
  logEvent: (name) => logged.push(name),
  sanitizeToolNameForAnalytics: (name) => name,
  logForDebugging() {},
  logError() {},
  findToolByName: () => undefined,
  normalizeToolInput: (_tool, input) => input,
  process: { env: {} },
});
const plain = (value) => JSON.parse(JSON.stringify(value)); // 去掉 vm 沙箱里的原型，便于比较
const inputOf = (raw) => {
  logged.length = 0;
  const [block] = normalizeContent([{ type: 'tool_use', id: 'x', name: 'Write', input: raw }], []);
  return { input: plain(block.input), parseFailed: logged.includes('tengu_tool_input_json_parse_fail') };
};

const stream = '{"file_path":"INSTALL.md","content":"## 安装\\n1. 克隆仓库"}';
const inString = stream.slice(0, stream.indexOf('## ') + 3); // 值写到一半
const afterKey = stream.slice(0, stream.indexOf('"content":') + 10); // 键写完了，值还没开始
const noBrace = stream.slice(0, -1); // 只差最后一个 }
const cases = [
  ['完整的参数', stream],
  ['值写到一半被截断', inString],
  ['键写完，值还没开始', afterKey],
  ['只差最后一个 }', noBrace],
  ['空字符串（没有参数的工具）', ''],
];
console.log('**半截的参数到了 normalizeContentFromAPI 手里**\n');
console.log('| 情形 | JSON 文本的结尾 | 解析出的 input | 记了 parse_fail 事件 |');
console.log('| --- | --- | --- | --- |');
for (const [label, raw] of cases) {
  const { input, parseFailed } = inputOf(raw);
  const tail = raw ? '`…' + raw.slice(-14).replace(/\n/g, '\\n') + '`' : '（空）';
  console.log(`| ${label} | ${tail} | \`${JSON.stringify(input)}\` | ${parseFailed ? '是' : '否'} |`);
}
assert.deepEqual(inputOf(inString), { input: {}, parseFailed: true });
assert.deepEqual(inputOf(afterKey), { input: {}, parseFailed: true });
assert.deepEqual(inputOf(noBrace), { input: {}, parseFailed: true }, '只差一个括号也解析失败：没有“差不多完整”这回事');
assert.deepEqual(inputOf(''), { input: {}, parseFailed: false });
const CUT_INPUT = inputOf(inString).input; // 后面所有“被截断的调用”都用它：{}

// ── 第二部分：同一份脚本，两个循环 ────────────────────────────────
// 脚本是一个函数 plan(n, world, resumeAsked)：n 是第几次请求，world 是磁盘，
// resumeAsked 表示这次请求的最后一条用户消息是不是“请接着写”。它返回这次回复的内容。
const A = { path: 'A.md', content: 'AAA' };
const B = { path: 'B.md', content: 'BBB' };
const scenarios = {
  text: {
    title: '一、文字回复被截断（没有工具调用）',
    plan: (n, _world, resumeAsked) => {
      if (n === 1) return { text: '安装步骤：先克隆仓库，再运行 np', truncated: true };
      return resumeAsked ? { text: 'm install。' } : { text: '（没有人请我继续）' };
    },
  },
  calls: {
    title: '二、一条回复里写两个文件，第二个的参数被截断',
    plan: (n, world) => {
      if (n === 1) return { writes: [A, { ...B, cut: true }], truncated: true };
      const remaining = [A, B].filter((w) => !(w.path in world.files)); // 还没写成功的，模型重发
      return remaining.length ? { writes: remaining } : { text: '两个文件都写好了。' };
    },
  },
  endless: {
    title: '三、每一次回复都被截断',
    plan: (n) => {
      assert.ok(n <= 6, '循环不该一直请求下去');
      return { text: `第 ${n} 段……`, truncated: true };
    },
  },
};

const newWorld = () => ({ files: {}, writes: [], atRequest: [], asked: [] });
// 被截断的调用，参数就是第一部分里真实函数给出的 {}
const callOf = (n, i, write) => ({
  id: `w${n}_${i}`,
  name: 'write_file',
  input: write.cut ? CUT_INPUT : { path: write.path, content: write.content },
});

async function runMox(plan) {
  const world = newWorld();
  let requests = 0;
  const model = moxScripted((context, n) => {
    requests = n;
    world.atRequest[n] = Object.keys(world.files); // 这次请求发出时，磁盘上已经有什么
    const lastUser = context.messages.findLast((m) => m.role === 'user')?.content ?? '';
    const reply = plan(n, world, /被截断/.test(lastUser));
    world.asked[n] = reply.writes ?? [];
    return {
      text: reply.text,
      toolCalls: reply.writes?.map((write, i) => {
        const call = callOf(n, i, write);
        return { id: call.id, name: call.name, arguments: call.input };
      }),
      stopReason: reply.truncated ? 'length' : undefined,
    };
  });
  const tools = [
    {
      name: 'write_file',
      description: '写文件',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      execute({ path, content }) {
        world.files[path] = content;
        world.writes.push(path);
        return '已写入';
      },
    },
  ];
  const { reason, messages } = await runLoop([], [{ role: 'user', content: '开始' }], { model, systemPrompt: '', tools });
  const text = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => b.text))
    .join('');
  return { requests, world, text, lastStop: messages.at(-1).stopReason, ending: reason === 'done' ? '正常结束' : reason };
}

async function runCoda(plan) {
  const world = newWorld();
  let requests = 0;
  let lastStop = '';
  const tools = new Toolset([
    {
      name: 'write_file',
      validate(input) {
        if (typeof input.path !== 'string' || typeof input.content !== 'string') throw Error('参数缺失：需要 path 和 content');
      },
      execute(input) {
        world.files[input.path] = input.content;
        world.writes.push(input.path);
        return { text: '已写入' };
      },
    },
  ]);
  const model = async (wire) => {
    const n = ++requests;
    world.atRequest[n] = Object.keys(world.files);
    const lastUser = wire.messages.findLast((m) => m.role === 'user')?.text ?? '';
    const reply = plan(n, world, /被截断/.test(lastUser));
    world.asked[n] = reply.writes ?? [];
    lastStop = reply.truncated ? 'length' : 'stop';
    return { text: reply.text, calls: reply.writes?.map((write, i) => callOf(n, i, write)), stop: reply.truncated ? 'length' : undefined };
  };
  const frames = await collect(new Engine({ tools, model }), '开始', { maxTurns: 12 });
  const terminal = frames.at(-1);
  const text = frames.filter((f) => f.type === 'assistant').map((f) => f.message.text).join('');
  return { requests, world, text, lastStop, ending: terminal.reason + (terminal.outputTruncated ? '（仍被截断，交给用户）' : '') };
}

const results = {};
for (const [name, { title, plan }] of Object.entries(scenarios)) {
  const mox = await runMox(plan);
  const coda = await runCoda(plan);
  results[name] = { mox, coda };
  const rows = [
    ['模型请求次数', (r) => String(r.requests)],
    ['最后一次回复的 stop reason', (r) => r.lastStop],
    ['结局', (r) => r.ending],
    ['用户最终看到的文字', (r) => r.text || '（没有文字）'],
  ];
  if (name === 'calls') {
    rows.push(
      ['第二次请求发出时，磁盘上有', (r) => r.world.atRequest[2]?.join('、') || '（空）'],
      ['第二次回复里重新生成的调用数', (r) => String(r.world.asked[2]?.length ?? 0)],
      ['真正执行的写入', (r) => r.world.writes.join('、') || '（无）'],
    );
  }
  console.log(`\n**${title}**\n`);
  console.log('| | mox（≈ Pi） | coda（≈ Claude Code） |');
  console.log('| --- | --- | --- |');
  for (const [label, pick] of rows) console.log(`| ${label} | ${pick(mox)} | ${pick(coda)} |`);
}

// 守住结论
assert.equal(results.text.mox.requests, 1);
assert.equal(results.text.mox.text, '安装步骤：先克隆仓库，再运行 np', 'Pi/mox 不续写：半截文字就是最终回答');
assert.equal(results.text.coda.text, '安装步骤：先克隆仓库，再运行 npm install。', 'Claude Code 续写：拼出完整回答');
assert.deepEqual(results.calls.mox.world.atRequest[2], [], 'Pi/mox：被截断的回复里，完整的 A 也没有执行');
assert.deepEqual(results.calls.coda.world.atRequest[2], ['A.md'], 'Claude Code：完整的 A 已经执行，B 被校验拦下');
assert.equal(results.calls.coda.world.asked[2].length, 1);
assert.equal(results.calls.mox.world.asked[2].length, 2);
assert.equal(results.endless.coda.requests, 4);
assert.equal(results.endless.mox.requests, 1);
