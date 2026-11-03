// 第 11 章：沙箱里的八条命令，以及打开沙箱后请求的变化（离线分析）。
//   node labs/ch11/sandbox.ts [steps|request|source]
import { loadRecording } from '../../lab/cc.ts';
import { calls, short } from '../ch06/calls.ts';

const r = loadRecording(new URL('./recorded/run.json', import.meta.url).pathname);
const part = process.argv[2] ?? 'steps';

if (part === 'steps') {
  const who = (c: any) => {
    if (/sandbox_violations/.test(c.result)) return '网络代理拒绝';
    if (/operation not permitted|Operation not permitted|PermissionError/.test(c.result)) return '内核（Seatbelt）拒绝';
    return c.isError ? '命令失败' : '';
  };
  const out = (c: any) => {
    const m = c.result.match(/<sandbox_violations>\s*([^<]+?)\s*<\/sandbox_violations>/);
    if (m) return `\`${m[1]}\``;
    if (/PermissionError/.test(c.result)) return 'PermissionError: Operation not permitted';
    if (/_proxy/i.test(c.input.command)) {
      const names = [...new Set(c.result.split('\n').map((l: string) => l.split('=')[0]).filter((n: string) => /^[A-Z_]+$/.test(n)))];
      return `${names.join('、')}……都指向 \`localhost\` 上的代理`;
    }
    return short(c.result.replace(/^Exit code \d+\s*/, '').replace(/\(eval\):1: /, ''), 50);
  };
  console.log('| # | 命令 | 结果 | 谁拦下的 |');
  console.log('| --- | --- | --- | --- |');
  const show = (cmd: string) => (cmd.startsWith('curl') ? `curl … ${cmd.split(' ').at(-1)}` : short(cmd, 52)).replace(/`/g, "'");
  calls(r).forEach((c, i) => console.log(`| ${i + 1} | \`${show(c.input.command)}\` | ${c.isError ? '✗' : '✓'} ${out(c)} | ${who(c)} |`));
  const reasons = [...new Set(calls(r).map(c => `${c.decision?.decision}/${c.decision?.reason_type}`))];
  console.log(`\n权限决定：${reasons.join('、')}——手动模式下，这些命令一条都没有问用户（autoAllowBashIfSandboxed）。`);
  console.log(`泄露检查：OUTSIDE-SECRET ${r.requests.some((q: any) => q.markers?.['OUTSIDE-SECRET']) ? '进入了' : '没有进入'}请求；.env 里的 DB_PASSWORD ${r.requests.some((q: any) => q.markers?.['DB_PASSWORD']) ? '进入了' : '没有进入'}请求。`);
}

if (part === 'request') {
  // 对照：第 6 章的录制，同一个版本，没开沙箱
  const plain = loadRecording(new URL('../ch06/recorded/rules.json', import.meta.url).pathname).requests[0];
  const sb = r.requests[0];
  const bash = (q: any) => q.tools.find((t: any) => t.name === 'Bash');
  console.log('| | 没开沙箱（第 6 章的录制） | 打开沙箱 |');
  console.log('| --- | --- | --- |');
  console.log(`| Bash 工具的参数 | ${bash(plain).params.join('、')} | ${bash(sb).params.join('、')} |`);
  console.log(`| Bash 工具的描述 | ${bash(plain).descChars} 字符 | ${bash(sb).descChars} 字符 |`);
  console.log(`| 环境信息（第 1 条 system 消息） | ${plain.messages[1].blocks[0].chars} 字符 | ${sb.messages[1].blocks[0].chars} 字符 |`);
}

if (part === 'source') {
  // 拿录制里观察到的东西，去 sandbox-runtime 的源码里找出处（源码位置见 course/syllabus.ts 的 OSS）
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { OSS } = await import('../../course/syllabus.ts');
  const dir = process.env[OSS['sandbox-runtime'].env] ?? new URL(`../../${OSS['sandbox-runtime'].dir}/`, import.meta.url).pathname;
  const src = (f: string) => readFileSync(join(dir, f), 'utf8');
  const utils = src('src/sandbox/sandbox-utils.ts');
  const manager = src('src/sandbox/sandbox-manager.ts');
  const mac = src('src/sandbox/macos-sandbox-utils.ts');

  // ① 代理环境变量：录制里的变量名，是不是都由 generateProxyEnvVars 生成
  const envCall = calls(r).find(c => /_proxy/i.test(c.input.command))!;
  const seen = [...new Set(envCall.result.split('\n').map((l: string) => l.split('=')[0]).filter((n: string) => /^[A-Za-z_]+$/.test(n)))];
  const generated = new Set([...utils.matchAll(/envVars\.push\(\s*`([A-Za-z_]+)=/g)].map(m => m[1]));
  const missing = seen.filter(n => !generated.has(n));
  console.log(`① 录制里的 ${seen.length} 个代理变量，${missing.length ? `有 ${missing.length} 个不在源码里：${missing.join('、')}` : '全部能在 generateProxyEnvVars 里找到'}（源码一共会生成 ${generated.size} 种）`);

  // ② 代理用户名 srt.<编码>：解码出来是什么
  const user = envCall.result.match(/srt\.([A-Za-z0-9%=+/]+)[:@]/)?.[1] ?? '';
  const decoded = Buffer.from(decodeURIComponent(user), 'base64').toString('utf8');
  console.log(`② 代理用户名 srt.${user.slice(0, 12)}… 解码得到 ${decoded}——正是这条 Bash 调用的 id：${decoded === envCall.id ? '一致' : `不一致（调用 id 是 ${envCall.id}）`}。源码 proxyUsernameFor 的注释说，这是为了把被拒绝的连接归到触发它的那次调用`);

  // ③ 写 .git/hooks 被拒：强制拒写的清单
  const hooks = mac.includes("entries.push(literal('.git/hooks'))");
  const files = utils.match(/export const DANGEROUS_FILES = \[([\s\S]*?)\]/)?.[1].match(/'[^']+'/g)?.map(s => s.slice(1, -1)) ?? [];
  console.log(`③ .git/hooks ${hooks ? '在' : '不在'} macGetMandatoryDenyEntries 的强制拒写清单里；同一份清单还有：${files.join('、')}，以及 .vscode、.idea、.claude/commands、.claude/agents`);

  // ④ 网络被拒的说明
  const violation = calls(r).find(c => /sandbox_violations/.test(c.result))!;
  console.log(`④ 模型看到的 <sandbox_violations> 由 annotateStderrWithSandboxFailures 追加在 stderr 后面（源码里${manager.includes("'<sandbox_violations>'") ? '有' : '没有'}这个标签）；“user denied” 来自 filterNetworkRequest：${manager.includes("denied('user denied')") ? '询问回调返回了拒绝' : '?'}——-p 模式下 Claude Code 没人可问`);
  console.log(`   录制里的原文：${violation.result.match(/<sandbox_violations>\s*([^<]+?)\s*<\/sandbox_violations>/)?.[1]}`);
}
