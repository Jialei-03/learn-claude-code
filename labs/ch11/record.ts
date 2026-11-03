// 第 11 章：沙箱（需要模型服务；macOS 上是 Seatbelt）。
// 打开 Claude Code 的沙箱，用 Bash 依次试探文件和网络的边界。
//   node labs/ch11/record.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude, saveRecording } from '../../lab/cc.ts';

// 项目之外的一个目录：放一个“机密”文件，也用来试探能不能往外写
const outside = mkdtempSync(join(tmpdir(), 'lcc-outside-'));
writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n');
// 自己先建好项目目录，沙箱规则里才能写项目里文件的绝对路径
const base = mkdtempSync(join(tmpdir(), 'lcc-'));
const project = { cwd: join(base, 'project'), configDir: join(base, 'config') };

// #region settings
const settings = {
  sandbox: {
    enabled: true,                                   // autoAllowBashIfSandboxed 默认为 true：沙箱里的命令不再逐条询问
    filesystem: { denyRead: [join(outside, 'secret.txt'), join(project.cwd, '.env')] },
    network: { allowedDomains: ['example.com'] },
  },
};
// #endregion
// #region steps
export const STEPS = [
  'echo inside > inside.txt && cat inside.txt',
  `echo outside > ${outside}/written.txt`,
  'echo hook > .git/hooks/pre-commit',
  `python3 -c "print(open('${outside}/secret.txt').read())"`,
  `python3 -c "print(open('.env').read())"`,
  'env | grep -i _proxy | sort',
  'curl -s -o /dev/null -w "%{http_code}" https://example.com',
  'curl -s -o /dev/null -w "%{http_code}" https://example.org',
];
// #endregion
const files = { '.env': 'DB_PASSWORD=hunter2\n', '.git/hooks/README': 'git hooks\n', 'README.md': '# demo\n' };
const prompt = `严格按顺序用 Bash 运行下面 ${STEPS.length} 条命令，每条只运行一次，原样运行；不管成功还是失败都直接运行下一条，不要换写法重试，也不要使用 dangerouslyDisableSandbox。全部运行完后，逐条说出结果。\n${STEPS.map((s, i) => `${i + 1}. \`${s}\``).join('\n')}`;
const r = await runClaude({ prompt, files, settings, reuse: project, args: ['--permission-mode', 'default'], hookEvents: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'] });
// 把外部目录的路径换成 <outside>；沙箱代理地址里带着一次性的密码，换掉（用户名留着：第 11 章要解码它）
const fix = (v: any) => JSON.parse(JSON.stringify(v).replaceAll(outside.replace(/^\/var\//, '/private/var/'), '<outside>').replaceAll(outside, '<outside>').replace(/(srt(?:\.[^:@\s"\\]*)?):[^@\s"\\]+@/g, '$1:<一次性凭据>@').replace(/(PROXY_PASSWORD=)[0-9a-f]+/g, '$1<一次性凭据>'));
saveRecording(new URL('./recorded/run.json', import.meta.url).pathname, fix(r) as any, { steps: fix(STEPS) }, ['OUTSIDE-SECRET', 'DB_PASSWORD']);
console.log(`请求 ${r.requests.length} 个；${String(r.events.at(-1)?.result ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
