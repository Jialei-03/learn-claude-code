// 第 12 章：录制真实 claude 可执行文件在“无界面”下的协议行为。
//
//   node labs/ch12/record-headless.mjs            录制全部场景，写入 labs/ch12/recorded/headless.json
//   node labs/ch12/record-headless.mjs --only eof 只录一个场景并打印（调试用）
//
// 做法：把 ANTHROPIC_BASE_URL 指向本机的假模型服务（fake-model.mjs），每一轮该做什么由剧本决定；
// 本脚本扮演“宿主程序”——和 Agent SDK 站在同一个位置：启动 claude 子进程，往 stdin 写 JSON 行，
// 从 stdout 读 JSON 行，并把两个方向的每一行都记下来。不需要密钥，不读也不写你自己的 ~/.claude
// （CLAUDE_CONFIG_DIR 指向临时目录）。需要本机装有 claude（录制用的是 2.1.296）。
//
// 每个场景回答一个问题：
//   stdio-allow   宿主批准，并且改写了参数：改写生效吗？
//   stdio-deny    宿主拒绝并写了理由：理由到了模型那里吗？
//   wrong-id      宿主先回了一个不认识的 id，又把正确的回答发了两遍：Claude Code 怎么处理？
//   eof-pending   宿主还没回答就关闭了 stdin：等待中的请求怎么办？
//   eof-early     宿主发完提问立刻关闭 stdin：运行会被打断吗？
//   eof-then-ask  同上，但模型的调用需要确认：请求还问得出去吗？
//   interrupt     宿主在审批请求还没回答时发 interrupt：请求会被撤销吗？
//   print-only    不用 stdio 通道，只有 -p：需要确认的调用会怎样？
//   print-stdin-open  -p 的 stdin 是一根没人写也没人关的管道：会发生什么？
//   format-text / format-json / no-verbose   三种输出格式，以及 stream-json 为什么要 --verbose
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startFakeModel } from './fake-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const claudeBin = existsSync(join(homedir(), '.local/bin/claude')) ? join(homedir(), '.local/bin/claude') : 'claude';

/** 写文件的剧本：第一轮调用 Write，第二轮收尾 */
const writeNote = (cwd, content = 'hello from the model\n') => [
  { text: '我来写一个笔记文件。', tools: [{ name: 'Write', input: { file_path: join(cwd, 'notes.txt'), content } }] },
  { text: '处理完了。' },
];

const user = (text) => ({ type: 'user', session_id: '', message: { role: 'user', content: text }, parent_tool_use_id: null });
const initialize = () => ({ type: 'control_request', request_id: 'host-init-1', request: { subtype: 'initialize' } });
const answer = (request_id, response) => ({ type: 'control_response', response: { subtype: 'success', request_id, response } });

// 每个场景：question 是它回答的问题；args 是 claude 的参数；script(cwd) 给出剧本；
// host(msg, io) 在每收到 claude 的一行时被调用，io.send 写一行，io.eof() 关闭 stdin。
const SCENARIOS = [
  {
    name: 'stdio-allow',
    question: '宿主批准并改写参数：改写生效吗？',
    args: ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
    script: (cwd) => writeNote(cwd),
    start: (io) => { io.send(initialize()); io.send(user('写一个笔记文件 notes.txt')); },
    host(msg, io) {
      if (msg.request?.subtype === 'can_use_tool')
        io.send(answer(msg.request_id, { behavior: 'allow', updatedInput: { ...msg.request.input, content: '宿主改写过的内容\n' } }));
      if (msg.type === 'result') io.eof();
    },
  },
  {
    name: 'stdio-deny',
    question: '宿主拒绝并写了理由：理由到了模型那里吗？',
    args: ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
    script: (cwd) => writeNote(cwd),
    start: (io) => io.send(user('写一个笔记文件 notes.txt')),
    host(msg, io) {
      if (msg.request?.subtype === 'can_use_tool')
        io.send(answer(msg.request_id, { behavior: 'deny', message: '宿主说：这个目录只读，不要写文件。' }));
      if (msg.type === 'result') io.eof();
    },
  },
  {
    name: 'wrong-id',
    question: '回答的 id 对不上，或者重复发送：Claude Code 怎么处理？',
    args: ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
    script: (cwd) => writeNote(cwd),
    start: (io) => io.send(user('写一个笔记文件 notes.txt')),
    host(msg, io) {
      if (msg.request?.subtype === 'can_use_tool') {
        io.send(answer('no-such-request', { behavior: 'allow', updatedInput: msg.request.input })); // 不认识的 id
        io.pause(300).then(() => {
          io.send(answer(msg.request_id, { behavior: 'allow', updatedInput: msg.request.input })); // 正确的回答
          io.send(answer(msg.request_id, { behavior: 'deny', message: '迟到的重复回答' })); // 同一个 id 再来一次
        });
      }
      if (msg.type === 'result') io.eof();
    },
  },
  {
    name: 'eof-pending',
    question: '审批请求还没有回答，宿主关闭了 stdin：等待中的请求怎么办？',
    args: ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
    script: (cwd) => writeNote(cwd),
    start: (io) => io.send(user('写一个笔记文件 notes.txt')),
    host(msg, io) {
      if (msg.request?.subtype === 'can_use_tool') io.eof(); // 既不批准也不拒绝，直接关门
    },
  },
  {
    name: 'eof-early',
    question: '提问一发完就关闭 stdin：已经开始的运行会被打断吗？',
    args: ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
    script: (cwd) => [
      { text: '先读一下文件。', tools: [{ name: 'Read', input: { file_path: join(cwd, 'a.txt') } }] },
      { text: '读完了，内容没有问题。' },
    ],
    files: { 'a.txt': 'alpha\n' },
    start: (io) => { io.send(user('读一下 a.txt')); io.eof(); },
    host() {},
  },
  {
    name: 'eof-then-ask',
    question: '提问发完立刻关闭 stdin，而模型的调用需要确认：请求还问得出去吗？',
    args: ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
    script: (cwd) => writeNote(cwd),
    start: (io) => { io.send(user('写一个笔记文件 notes.txt')); io.eof(); },
    host() {},
  },
  {
    name: 'interrupt',
    question: '审批请求等待回答时收到 interrupt：请求会被撤销吗？',
    args: ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'],
    script: (cwd) => writeNote(cwd),
    start: (io) => io.send(user('写一个笔记文件 notes.txt')),
    host(msg, io) {
      if (msg.request?.subtype === 'can_use_tool') io.send({ type: 'control_request', request_id: 'host-interrupt-1', request: { subtype: 'interrupt' } });
      if (msg.type === 'result') io.eof();
    },
  },
  {
    name: 'print-only',
    question: '没有 stdio 通道，只有 -p：需要确认的调用会怎样？',
    args: ['-p', '写一个笔记文件 notes.txt'],
    script: (cwd) => writeNote(cwd),
    start: (io) => io.eof(), // 等价于 shell 里的 < /dev/null
    host() {},
  },
  {
    name: 'print-stdin-open',
    question: '-p 的 stdin 是一根没人写也没人关的管道：会发生什么？',
    args: ['-p', '写一个笔记文件 notes.txt'],
    script: (cwd) => writeNote(cwd),
    start: () => {}, // 什么都不写，也不关
    host(msg, io) { if (msg.type === 'result') io.eof(); },
  },
  {
    name: 'format-text',
    question: '同一次运行，默认的文本输出长什么样？',
    format: 'text',
    args: ['-p', '随便说句话'],
    script: () => [{ text: '你好，这是剧本里的回答。' }],
    start: (io) => io.eof(),
    host() {},
  },
  {
    name: 'format-json',
    question: '--output-format json 输出什么？',
    format: 'json',
    args: ['-p', '随便说句话'],
    script: () => [{ text: '你好，这是剧本里的回答。' }],
    start: (io) => io.eof(),
    host() {},
  },
  {
    name: 'no-verbose',
    question: 'stream-json 不加 --verbose 会怎样？',
    format: 'stream-json-quiet',
    args: ['-p', '随便说句话'],
    script: () => [{ text: '你好，这是剧本里的回答。' }],
    start: (io) => io.eof(),
    host() {},
  },
];

const FORMAT_ARGS = {
  'stream-json': ['--output-format', 'stream-json', '--verbose'],
  'stream-json-quiet': ['--output-format', 'stream-json'],
  json: ['--output-format', 'json'],
  text: [],
};

const clean = (text, map) => Object.entries(map).reduce((s, [from, to]) => s.split(from).join(to), text);

/** 把一行 claude 的输出压缩成讲解需要的字段：路径换成占位符，去掉与协议无关的大块内容 */
function trim(msg, map) {
  const text = (value) => JSON.parse(clean(JSON.stringify(value), map));
  const m = text(msg);
  if (m.type === 'system' && m.subtype === 'init')
    return { type: 'system', subtype: 'init', cwd: m.cwd, session_id: '<session>', tools: m.tools?.length, model: m.model, permissionMode: m.permissionMode, apiKeySource: m.apiKeySource };
  if (m.type === 'control_response' && m.response?.response?.commands) {
    const r = m.response.response;
    return { type: 'control_response', response: { subtype: m.response.subtype, request_id: m.response.request_id, response: { commands: `${r.commands.length} 条`, agents: `${r.agents?.length ?? 0} 个`, models: `${r.models?.length ?? 0} 个`, output_style: r.output_style } } };
  }
  if (m.type === 'result')
    return { type: 'result', subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, result: m.result, stop_reason: m.stop_reason, permission_denials: m.permission_denials, terminal_reason: m.terminal_reason };
  if (m.type === 'assistant') return { type: 'assistant', message: { role: 'assistant', content: m.message.content } };
  if (m.type === 'user') return { type: 'user', message: m.message };
  return m;
}

async function runScenario(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'ch12-'));
  const cwd = join(root, 'project'), config = join(root, 'config');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(config, { recursive: true });
  for (const [path, content] of Object.entries(scenario.files ?? {})) writeFileSync(join(cwd, path), content);
  const realCwd = (await import('node:fs')).realpathSync(cwd);
  const map = { [realCwd]: '<project>', [cwd]: '<project>', [config]: '<config>' };

  const fake = await startFakeModel(scenario.script(realCwd));
  const env = {
    HOME: homedir(), PATH: process.env.PATH ?? '', TERM: 'dumb', LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key',
    ANTHROPIC_MODEL: 'claude-sonnet-4-5', ANTHROPIC_SMALL_FAST_MODEL: 'claude-sonnet-4-5', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const args = [...FORMAT_ARGS[scenario.format ?? 'stream-json'], '--permission-mode', 'default', ...scenario.args];
  const child = spawn(claudeBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

  const wire = [];
  const t0 = Date.now();
  const log = (dir, msg) => wire.push({ dir, ms: Date.now() - t0, msg: dir === 'host→cc' ? text(msg) : trim(msg, map) });
  const text = (value) => JSON.parse(clean(JSON.stringify(value), map));
  const io = {
    send(obj) { log('host→cc', obj); child.stdin.write(JSON.stringify(obj) + '\n'); },
    eof() { wire.push({ dir: 'host', ms: Date.now() - t0, msg: { note: 'stdin 关闭（EOF）' } }); child.stdin.end(); },
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  child.stdin.on('error', () => {});
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { wire.push({ dir: 'cc→host', ms: Date.now() - t0, raw: line }); return; }
    if (msg.type === 'system' && msg.subtype === 'informational') return; // 与协议无关的提示
    log('cc→host', msg);
    scenario.host(msg, io);
  });
  scenario.start(io);

  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  const exit = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);

  const notes = join(cwd, 'notes.txt');
  const main = fake.requests.filter((r) => r.main);
  const hasToolResult = (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result');
  const seenByModel = (m) => {
    const block = text(m.content.find((b) => b.type === 'tool_result'));
    const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
    return { content: content.replace(/\n\n<system-reminder>[\s\S]*$/, ''), is_error: Boolean(block.is_error) };
  };
  const lastToolResult = main.flatMap((r) => r.messages).filter(hasToolResult).at(-1);
  const record = {
    name: scenario.name,
    question: scenario.question,
    argv: args,
    wire,
    exit,
    stderr: clean(stderr, map).trim().split('\n').filter((l) => !l.startsWith('[claude-code:unrecognized_model]')).join('\n'),
    notes: existsSync(notes) ? readFileSync(notes, 'utf8') : null,
    // 模型在请求里收到的最后一个工具结果：拒绝的理由、错误信息原样到了模型手里（去掉 Claude Code 自己附加的 system-reminder）
    modelSaw: lastToolResult ? seenByModel(lastToolResult) : null,
    modelRequests: main.length,
  };
  await fake.close();
  rmSync(root, { recursive: true, force: true });
  return record;
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const picked = SCENARIOS.filter((s) => !only || s.name === only);
const version = (await new Promise((resolve) => { const c = spawn(claudeBin, ['--version']); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => resolve(o.trim())); }));
const recordings = [];
for (const scenario of picked) {
  const record = await runScenario(scenario);
  recordings.push(record);
  if (only) {
    console.log(`# ${record.name}：${record.question}`);
    for (const w of record.wire) console.log(`${String(w.ms).padStart(5)}ms ${w.dir}`, JSON.stringify(w.msg ?? w.raw).slice(0, 400));
    console.log('exit', JSON.stringify(record.exit), 'stderr:', JSON.stringify(record.stderr), 'notes:', JSON.stringify(record.notes));
    console.log('modelSaw:', JSON.stringify(record.modelSaw), 'requests:', record.modelRequests);
  } else console.log(`${record.name}：${record.wire.length} 行，退出 ${record.exit.code ?? record.exit.signal}`);
}
if (!only) {
  const out = join(HERE, 'recorded/headless.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ version, recordings }, null, 1) + '\n');
  console.log(`已写入 ${out}`);
}
