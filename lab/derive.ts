// 把截下来的请求变成“结构摘要”再保存。
// 原始请求里有 Claude Code 的系统提示和工具描述——那是 Anthropic 写的文字。课程只需要它们的结构
// （有几块、多长、有哪些小节、缓存断点在哪、有哪些参数），不保存、也不发布原文；需要引用时最多留一行。
import { createHash } from 'node:crypto';
import type { Captured } from './proxy.ts';

/** 内容的指纹：可以比较两次请求的某一部分是否逐字相同，又不保存内容本身 */
const hash = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex').slice(0, 12);

const head = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s);
const firstLine = (s: string) => head(s.split('\n').find(l => l.trim()) ?? '', 100);

export interface RequestSummary {
  id: number;
  path: string;
  status?: number;
  ms?: number;
  betas: string[];
  userAgent?: string;
  model?: string;
  maxTokens?: number;
  thinking?: unknown;
  contextManagement?: unknown;
  outputConfig?: unknown;
  /** 系统提示的每一块：长度、是否标了缓存、Markdown 小节标题、第一行 */
  system: { chars: number; cache?: unknown; headings: string[]; firstLine: string; hash: string }[];
  tools: { name: string; descChars: number; params: string[]; required: string[]; deferred?: boolean }[];
  toolsChars: number;
  toolsHash: string;
  /** 消息：角色、每个内容块的类型和长度、是否标了缓存；system-reminder 之类的注入只记长度和第一行 */
  messages: { role: string; blocks: { type: string; chars: number; cache?: boolean; name?: string; firstLine?: string; hash?: string; ref?: string; input?: string }[] }[];
  /** 金丝雀字符串出现在请求的哪些位置（system[i] 或 messages[i]） */
  markers?: Record<string, string[]>;
  /** 响应：内容块类型、停止原因、用量；text 是模型输出的文字开头（实验模型的输出，不是 Anthropic 的文字） */
  response?: { blocks: string[]; stopReason?: string; usage?: Record<string, number>; text?: string; error?: string };
  /** 是否流式请求 */
  stream?: boolean;
}

function blocksOf(content: unknown): RequestSummary['messages'][number]['blocks'] {
  if (typeof content === 'string') return [{ type: 'text', chars: content.length, firstLine: firstLine(content), hash: hash(content) }];
  if (!Array.isArray(content)) return [];
  return content.map((b: any) => {
    const text = typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x.text ?? '').join('') : b.input ? JSON.stringify(b.input) : '';
    // ref：工具调用和工具结果靠 id 配对，记下 id 的末尾几位就能看出谁对应谁；input：模型给工具的参数（模型的输出，不是 Anthropic 的文字）
    const ref = b.type === 'tool_use' ? b.id : b.type === 'tool_result' ? b.tool_use_id : undefined;
    return {
      type: b.type, chars: text.length, ...(b.cache_control ? { cache: true } : {}), ...(b.name ? { name: b.name } : {}),
      ...(b.type === 'text' ? { firstLine: firstLine(text), hash: hash(text) } : {}),
      ...(ref ? { ref: String(ref).slice(-6) } : {}), ...(b.type === 'tool_use' ? { input: head(JSON.stringify(b.input ?? {}), 160) } : {}),
    };
  });
}

function parseSse(text: string | undefined): RequestSummary['response'] {
  if (!text) return undefined;
  // 非流式的请求（比如自动模式的分类器）返回一整个 JSON
  if (text.trimStart().startsWith('{')) {
    let j: any;
    try { j = JSON.parse(text); } catch { return { blocks: [] }; }
    if (j.error) return { blocks: [], error: head(String(j.error.message ?? j.error.type ?? j.error), 160) };
    const out = (j.content ?? []).map((b: any) => b.text ?? '').join('');
    return { blocks: (j.content ?? []).map((b: any) => b.type), stopReason: j.stop_reason, usage: numeric(j.usage), ...(out ? { text: head(out, 300) } : {}) };
  }
  const blocks: string[] = [];
  let stopReason: string | undefined;
  let out = '';
  const usage: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let e: any;
    try { e = JSON.parse(line.slice(5)); } catch { continue; }
    if (e.type === 'content_block_start') blocks.push(e.content_block?.type);
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && out.length < 400) out += e.delta.text;
    if (e.type === 'message_start') Object.assign(usage, numeric(e.message?.usage));
    if (e.type === 'message_delta') { stopReason = e.delta?.stop_reason ?? stopReason; Object.assign(usage, numeric(e.usage)); }
  }
  return { blocks, stopReason, usage, ...(out ? { text: head(out, 300) } : {}) };
}
const numeric = (o: any) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => typeof v === 'number')) as Record<string, number>;

/** 在请求里找金丝雀字符串：只记录位置，不记录周围的文字 */
function locate(b: any, markers: string[]): Record<string, string[]> {
  const where: Record<string, string[]> = {};
  const check = (label: string, value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    for (const m of markers) if (text.includes(m)) (where[m] ??= []).push(label);
  };
  (Array.isArray(b.system) ? b.system : [b.system]).forEach((s: any, i: number) => check(`system[${i}]`, s?.text ?? s));
  (b.messages ?? []).forEach((m: any, i: number) => check(`messages[${i}](${m.role})`, m.content));
  (b.tools ?? []).forEach((t: any) => check(`tools.${t.name}`, t));
  return where;
}

export function summarizeRequest(c: Captured, markers: string[] = []): RequestSummary {
  const b = typeof c.body === 'object' && c.body ? c.body : {};
  const system = (Array.isArray(b.system) ? b.system : b.system ? [{ type: 'text', text: b.system }] : []).map((s: any) => ({
    chars: (s.text ?? '').length,
    ...(s.cache_control ? { cache: s.cache_control } : {}),
    headings: [...String(s.text ?? '').matchAll(/^#{1,3} (.+)$/gm)].map(m => m[1]),
    firstLine: firstLine(s.text ?? ''),
    hash: hash(s.text ?? ''),
  }));
  const tools = (b.tools ?? []).map((t: any) => ({
    name: t.name, descChars: (t.description ?? '').length,
    params: Object.keys(t.input_schema?.properties ?? {}), required: t.input_schema?.required ?? [],
    ...(t.defer_loading ? { deferred: true } : {}),
  }));
  return {
    id: c.id, path: c.path, status: c.status, ms: c.ms,
    betas: (c.headers['anthropic-beta'] ?? '').split(',').filter(Boolean),
    userAgent: c.headers['user-agent'],
    model: b.model, maxTokens: b.max_tokens, thinking: b.thinking, contextManagement: b.context_management, outputConfig: b.output_config,
    system, tools, toolsChars: JSON.stringify(b.tools ?? []).length, toolsHash: hash(b.tools ?? []),
    messages: (b.messages ?? []).map((m: any) => ({ role: m.role, blocks: blocksOf(m.content) })),
    ...(typeof b.stream === 'boolean' ? { stream: b.stream } : {}),
    response: parseSse(c.response),
    ...(markers.length ? { markers: locate(b, markers) } : {}),
  };
}

/** 递归截断过长的字符串（事件、钩子数据、会话记录里也可能夹着注入的系统文字） */
export function truncateDeep(value: unknown, max = 1200): unknown {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…[共 ${value.length} 字符]` : value;
  if (Array.isArray(value)) return value.map(v => truncateDeep(v, max));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateDeep(v, max)]));
  return value;
}
