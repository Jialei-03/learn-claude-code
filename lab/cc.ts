// 实验台：用一个开放模型驱动真实的 Claude Code，把能观察到的一切都记下来。
//   · 在临时目录里布置项目文件；
//   · CLAUDE_CONFIG_DIR 指向临时目录：不读你的 ~/.claude，也不往里写；
//   · 干净的环境变量：只带模型服务的地址和密钥（不继承当前终端里的任何 Claude 相关变量）；
//   · 本地记录代理（lab/proxy.ts）截下每一个发给模型的请求；
//   · 每个钩子事件都挂上记录器（lab/hook-logger.mjs），记下 Claude Code 交给钩子的数据；
//   · stream-json 输出的每一个事件，以及运行后留下的会话文件。
// 模型服务：任何兼容 Anthropic Messages 接口的服务（第 0 章）。环境变量 LCC_BASE_URL、LCC_API_KEY、LCC_MODEL。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProxy, type Captured } from './proxy.ts';
import { summarizeRequest, truncateDeep } from './derive.ts';

const LAB = dirname(fileURLToPath(import.meta.url));
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'SessionEnd'];

export interface RunOptions {
  prompt: string;
  /** 项目里的文件：相对路径 → 内容 */
  files?: Record<string, string>;
  /** 用户级配置目录（CLAUDE_CONFIG_DIR）里的文件，比如 CLAUDE.md、skills/x/SKILL.md、agents/x.md */
  configFiles?: Record<string, string>;
  /** 额外的设置，会和钩子记录器的设置合并 */
  settings?: Record<string, any>;
  /** 额外的命令行参数 */
  args?: string[];
  /** 要记录的钩子事件；默认全部 */
  hookEvents?: string[];
  /** 继续使用之前的项目目录和配置目录（会话恢复的实验用） */
  reuse?: { cwd: string; configDir: string };
  /** 额外的环境变量（比如把上下文窗口调小，好触发自动压缩） */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunResult {
  cwd: string;
  configDir: string;
  events: any[];
  hooks: { event: string; at: number; payload: any }[];
  requests: Captured[];
  exitCode: number | null;
  stderr: string;
  /** 运行后会话目录里的 JSONL 文件（解析后） */
  transcripts: { file: string; entries: any[] }[];
}

export function modelConfig() {
  const base = process.env.LCC_BASE_URL ?? process.env.MOX_BASE_URL?.replace(/\/v1\/?$/, '');
  const key = process.env.LCC_API_KEY ?? process.env.MOX_API_KEY;
  const model = process.env.LCC_MODEL ?? process.env.MOX_MODEL;
  if (!base || !key || !model) throw new Error('需要 LCC_BASE_URL、LCC_API_KEY、LCC_MODEL（一个兼容 Anthropic Messages 接口的服务），见第 0 章');
  return { base, key, model };
}

const write = (root: string, files: Record<string, string> = {}) => {
  // 以 #! 开头的文件是脚本，给它执行权限
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content, { mode: content.startsWith('#!') ? 0o755 : 0o644 }); }
};

export async function runClaude(options: RunOptions): Promise<RunResult> {
  const { base, key, model } = modelConfig();
  const cwd = options.reuse?.cwd ?? join(mkdtempSync(join(tmpdir(), 'lcc-')), 'project');
  const configDir = options.reuse?.configDir ?? join(dirname(cwd), 'config');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  write(cwd, options.files);
  write(configDir, options.configFiles);
  const hookLog = join(dirname(cwd), `hooks-${Date.now()}.jsonl`);
  const hookEvents = options.hookEvents ?? HOOK_EVENTS;
  const hooks = Object.fromEntries(hookEvents.map(e => [e, [{ hooks: [{ type: 'command', command: `node ${join(LAB, 'hook-logger.mjs')} ${e}` }] }]]));
  const settingsFile = join(dirname(cwd), `settings-${Date.now()}.json`);
  const extraHooks = options.settings?.hooks ?? {};
  for (const [e, matchers] of Object.entries<any[]>(extraHooks)) hooks[e] = [...(hooks[e] ?? []), ...matchers];
  writeFileSync(settingsFile, JSON.stringify({ ...options.settings, hooks }, null, 2));

  const proxy = await startProxy(base);
  const env = {
    HOME: homedir(), PATH: process.env.PATH ?? '', TERM: 'dumb', LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: configDir, HOOK_LOG: hookLog,
    ANTHROPIC_BASE_URL: proxy.url, ANTHROPIC_API_KEY: key, ANTHROPIC_MODEL: model, ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...options.env,
  };
  const claude = existsSync(join(homedir(), '.local/bin/claude')) ? join(homedir(), '.local/bin/claude') : 'claude';
  const args = ['-p', options.prompt, '--output-format', 'stream-json', '--verbose', '--settings', settingsFile, '--strict-mcp-config', ...(options.args ?? [])];
  const child = spawn(claude, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 300_000);
  const exitCode = await new Promise<number | null>(resolve => child.on('close', resolve));
  clearTimeout(timer);
  await new Promise(r => setTimeout(r, 300));       // 等最后一个响应写完
  await proxy.close();

  const events = stdout.split('\n').filter(l => l.trim().startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return { type: 'unparsed', line: l }; } });
  const hookEntries = existsSync(hookLog) ? readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const transcripts: RunResult['transcripts'] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.jsonl')) transcripts.push({ file: p, entries: readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { unparsed: l }; } }) });
    }
  };
  walk(join(configDir, 'projects'));
  return { cwd, configDir, events, hooks: hookEntries, requests: proxy.captured, exitCode, stderr, transcripts };
}

/** 会话文件里有些附件直接夹着 Anthropic 写的文字：prompt_snapshot 是整份系统提示和工具定义，agent_listing_delta、skill_listing 是内置子 Agent 和 Skill 的说明。只留长度、名字和开头 */
export function scrubEntry(e: any): any {
  const a = e?.attachment;
  if (a?.type === 'prompt_snapshot') return { ...e, attachment: {
    ...a,
    ...(Array.isArray(a.systemPrompt) ? { systemPrompt: a.systemPrompt.map((x: unknown) => (/^\[(\d+ 字符|省略)\]$/.test(String(x)) ? x : `[${String(x).length} 字符]`)) } : {}),
    ...(Array.isArray(a.tools) ? { tools: a.tools.map((t: any) => t?.name ?? '?') } : {}),
  } };
  if (a?.type === 'agent_listing_delta' && Array.isArray(a.addedLines)) return { ...e, attachment: { ...a, addedLines: a.addedLines.map((x: unknown) => String(x).slice(0, 60)) } };
  if (a?.type === 'skill_listing' && typeof a.content === 'string') return { ...e, attachment: { ...a, content: a.content.split('\n').map((l: string) => l.match(/^- ([^:]+):/)?.[1]).filter(Boolean).map((n?: string) => `- ${n}`).join('\n') } };
  return e;
}

/** 保存一次运行的记录，供网站构建时离线分析。临时路径、家目录、密钥都替换掉 */
export function saveRecording(file: string, result: RunResult, extra: Record<string, unknown> = {}, markers: string[] = []) {
  // macOS 上临时目录有两种写法（/var/… 和 /private/var/…），先替换长的那种
  const variants = (p: string) => [p.replace(/^\/var\//, '/private/var/'), p];
  // 请求只保存结构摘要（lab/derive.ts），其余内容截断过长的字符串
  const recording = {
    ...extra,
    events: truncateDeep(result.events, 800),
    hooks: truncateDeep(result.hooks, 800),
    requests: result.requests.map(r => summarizeRequest(r, markers)),
    // 会话记录里夹着系统注入的附件（工具定义、提醒……），只保留开头
    transcripts: result.transcripts.map(t => ({ file: t.file.slice(result.configDir.length), entries: truncateDeep(t.entries.map(scrubEntry), 300) })),
  };
  let masked = JSON.stringify(recording, null, 1);
  for (const [path, label] of [[result.cwd, '<project>'], [result.configDir, '<config>'], [dirname(result.cwd), '<lab>']] as const) {
    for (const v of variants(path)) {
      masked = masked.replaceAll(v, label);
      // 会话目录的名字是把路径里的非字母数字字符换成 -
      masked = masked.replaceAll(v.replace(/[^A-Za-z0-9]/g, '-'), `${label.slice(0, -1)}-escaped>`);
    }
  }
  // 课程仓库自己的路径（钩子命令里会出现），Claude Code 有时会把家目录写成 ~
  const repo = dirname(LAB);
  const pi = join(dirname(repo), 'learn-pi-agent');   // 对照用的 Learn Pi Agent（钩子脚本等从那里借用）
  for (const [path, label] of [[pi, '<learn-pi-agent>'], [repo, '<repo>']]) for (const v of [path, `~${path.slice(homedir().length)}`]) masked = masked.replaceAll(v, label);
  masked = masked.replaceAll(homedir(), '~').replace(new RegExp(`\\b${userInfo().username}\\b`, 'g'), 'user');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, masked);
}

export function loadRecording(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}
