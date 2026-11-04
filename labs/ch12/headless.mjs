// 第 12 章：真实 claude 可执行文件在无界面下的行为（离线分析 recorded/headless.json）。
// 录制方法见 record-headless.mjs：一个假模型服务按剧本回答，宿主程序（脚本）通过 stdin/stdout 驱动 claude 子进程。
//
//   node labs/ch12/headless.mjs [formats|stdin|outcomes|timeline <场景>]
import { arrow, load, short, summarize } from './wirelib.mjs';

const data = load('headless');
const by = Object.fromEntries(data.recordings.map((r) => [r.name, r]));
const part = process.argv[2] ?? 'formats';
const cc = (r) => r.wire.filter((w) => w.dir === 'cc→host');
const result = (r) => cc(r).map((w) => w.msg).find((m) => m?.type === 'result');
const table = (head, rows) => {
  console.log(`| ${head.join(' | ')} |`);
  console.log(`| ${head.map(() => '---').join(' | ')} |`);
  for (const row of rows) console.log(`| ${row.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
};

if (part === 'formats') {
  // 同一个脚本化的回答，三种输出格式；以及 stream-json 少了 --verbose 的下场
  const stdout = (r) => cc(r).map((w) => w.raw ?? w.msg);
  const text = by['format-text'], js = by['format-json'], stream = by['print-only'], quiet = by['no-verbose'];
  const events = stdout(stream).map((m) => m.type + (m.subtype && m.type !== 'result' ? `/${m.subtype}` : '')).join('、');
  table(['命令（共同部分省略）', 'stdout', '退出码'], [
    ['`claude -p "…"`', `一行文字：${JSON.stringify(stdout(text)[0])}`, text.exit.code],
    ['`claude -p "…" --output-format json`', `一个 JSON：\`type=result\`，\`result=${JSON.stringify(result(js).result)}\`，\`num_turns=${result(js).num_turns}\``, js.exit.code],
    ['`claude -p "…" --output-format stream-json --verbose`', `${stdout(stream).length} 行 JSON：${events}`, stream.exit.code],
    ['`claude -p "…" --output-format stream-json`', `（空）；stderr：${quiet.stderr}`, quiet.exit.code],
  ]);
}

if (part === 'stdin') {
  // -p 的 stdin：重定向到 /dev/null 和“一根没人写的管道”的区别
  const a = by['print-only'], b = by['print-stdin-open'];
  const first = (r) => cc(r)[0].ms;
  table(['stdin', '第一行输出出现在', 'stderr'], [
    ['关闭（等价于 `< /dev/null`）', `${first(a)} ms`, a.stderr || '（空）'],
    ['一根没人写、也没人关的管道', `${first(b)} ms`, b.stderr],
  ]);
}

if (part === 'outcomes') {
  // 宿主的八种做法，各自的下场
  const host = {
    'stdio-allow': '批准，并把 content 改写成别的内容',
    'stdio-deny': '拒绝，理由写成一句话',
    'wrong-id': '先回一个不认识的 id，再把正确的回答发两遍（第二遍是 deny）',
    'eof-pending': '不回答，直接关闭 stdin',
    'eof-then-ask': '发完提问立刻关闭 stdin（之后模型才要写文件）',
    'eof-early': '发完提问立刻关闭 stdin（模型只读文件，不需要确认）',
    'interrupt': '不回答，发一个 interrupt 请求',
    'print-only': '没有宿主，只有 -p',
  };
  const rows = Object.keys(host).map((name) => {
    const r = by[name];
    const res = result(r);
    return [
      `\`${name}\``,
      host[name],
      `“${short(r.modelSaw?.content ?? '（模型没有再收到任何东西）', 100)}”`,
      `${res.subtype}${res.is_error ? '，is_error' : ''}，拒绝 ${res.permission_denials.length} 次`,
      r.exit.code,
      r.notes === null ? '没有' : `“${r.notes.trim()}”`,
    ];
  });
  table(['场景', '宿主做了什么', '模型收到的工具结果', 'result 帧', '退出码', 'notes.txt'], rows);
}

if (part === 'timeline') {
  const name = process.argv[3];
  const r = by[name];
  if (!r) throw Error(`没有这个场景：${name}（可选：${Object.keys(by).join('、')}）`);
  console.log(`场景 ${name}：${r.question}`);
  console.log(`命令行：claude ${r.argv.join(' ')}`);
  console.log();
  table(['#', 'ms', '谁写的', '内容'], r.wire.filter((w) => !(w.msg?.type === 'system' && w.msg.subtype === 'init')).map((w, i) => [i + 1, w.ms, arrow(w.dir), summarize(w.msg ?? w.raw, 96)]));
  console.log();
  console.log(`进程退出码 ${r.exit.code}${r.notes === null ? '，notes.txt 不存在' : `，notes.txt 的内容是“${r.notes.trim()}”`}`);
}
