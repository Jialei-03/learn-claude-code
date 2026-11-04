// 第 12 章的“真货”：在运行时从固定提交（Claude Code 2.1.88）里取出 StructuredIO，原样执行。
// 代码不复制进仓库，位置登记在 course/source-references.json（键以 headless- 开头）。
//
//   node labs/ch12/real.mjs [pairing|closing|abort|race|framing]
//
// 原样执行的部分：
//   cli/structuredIO.ts   StructuredIO 整个类（读 stdin、sendRequest、createCanUseTool……）
//   utils/stream.ts       Stream：出站队列
//   cli/ndjsonSafeStringify.ts   写出前转义 U+2028 / U+2029
//   utils/permissions/PermissionPromptToolResultSchema.ts   permissionPromptToolResultToPermissionDecision
//   utils/errors.ts       AbortError
//
// 换成假的部分（都标在 loadStructuredIO 里）：
//   权限判断本身（hasPermissionsToUseTool，总是回答“要问人”）、PermissionRequest 钩子（脚本控制它是否抢先决定）、
//   zod 校验（手写一个同形状的检查）、日志和遥测、真正的 stdout。
import { upstream } from '../engineering/run.mjs';

// stripTypeScriptTypes 是实验特性，第一次调用会往 stderr 打一条警告；关掉它，让实验输出只有表格
process.removeAllListeners('warning');

/** 一条可以从外面推数据的输入：模拟 stdin。push 一段文字，end 表示 EOF */
export function channel() {
  const queue = [];
  let wake;
  let done = false;
  return {
    push(text) { queue.push(text); wake?.(); },
    end() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift(); continue; }
        if (done) return;
        await new Promise((resolve) => { wake = resolve; });
      }
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 装配一个真的 StructuredIO。
 *   hook：PermissionRequest 钩子的脚本，async () => 决定 | undefined；不给就是“没配置钩子”
 *   decision：宿主以外的权限判断结果，默认“要问人”
 */
export function loadStructuredIO({ hook, decision = { behavior: 'ask', suggestions: [] } } = {}) {
  const exits = [];
  const errors = [];
  const orphans = [];
  const AbortError = upstream('headless-abort-error', 'AbortError');
  const Stream = upstream('headless-stream', 'Stream');
  const ndjsonSafeStringify = upstream('headless-ndjson', 'ndjsonSafeStringify', {
    escapeJsLineTerminators: upstream('headless-ndjson-escape', 'escapeJsLineTerminators', { JS_LINE_TERMINATORS: new RegExp('\\u2028|\\u2029', 'g') }),
    jsonStringify: JSON.stringify,
  });
  // 宿主回答的校验。真实代码是 zod：allow 必须带 updatedInput，deny 必须带 message。这里手写同样的形状检查。
  const permissionToolOutputSchema = () => ({
    parse(value) {
      if (value?.behavior === 'allow' && value.updatedInput && typeof value.updatedInput === 'object') return value;
      if (value?.behavior === 'deny' && typeof value.message === 'string') return value;
      throw Error('malformed permission response');
    },
  });
  const toDecision = upstream('headless-permission-decision', 'permissionPromptToolResultToPermissionDecision', {
    logForDebugging() {}, applyPermissionUpdates: (context) => context, persistPermissionUpdates() {},
  });
  const StructuredIO = upstream('headless-structured-io', 'StructuredIO', {
    Stream, AbortError, AbortController, process: { exit: (code) => exits.push(code), env: {} }, console: { error: (...a) => errors.push(a.join(' ')) },
    randomUUID: (() => { let n = 0; return () => `req-${++n}`; })(),
    jsonParse: JSON.parse, jsonStringify: JSON.stringify, ndjsonSafeStringify,
    normalizeControlMessageKeys: (value) => value, notifyCommandLifecycle() {}, notifySessionStateChanged() {},
    logForDebugging() {}, logForDiagnosticsNoPII() {}, writeToStdout() {},
    hasPermissionsToUseTool: async () => decision,
    executePermissionRequestHooksForSDK: async () => hook?.(),
    permissionToolOutputSchema, permissionPromptToolResultToPermissionDecision: toDecision,
    buildRequiresActionDetails: () => ({}), serializeDecisionReason: () => undefined,
    exitWithMessage: (message) => { errors.push(message); exits.push(1); },
    MAX_RESOLVED_TOOL_USE_IDS: 1000, SDKControlElicitationResponseSchema: () => ({}), z: {},
  });
  return { StructuredIO, ndjsonSafeStringify, exits, errors, orphans };
}

/** 一次完整的装配：输入通道、读取循环（真实代码里是 print.ts 的 for await）、出站队列的记录 */
export function start(options) {
  const { StructuredIO, exits, errors, orphans } = loadStructuredIO(options);
  const input = channel();
  const io = new StructuredIO(input);
  const seen = []; // 读到的消息（不含被吃掉的控制回答）
  const out = []; // 写给宿主的消息
  io.setUnexpectedResponseCallback(async (message) => { orphans.push(message.response.request_id); });
  void (async () => { for await (const message of io.structuredInput) seen.push(message); })();
  void (async () => { for await (const message of io.outbound) out.push(message); })();
  const abort = new AbortController();
  const context = { abortController: abort, agentId: undefined, getAppState: () => ({ toolPermissionContext: { mode: 'default' } }), setAppState() {} };
  const canUseTool = io.createCanUseTool();
  const ask = (toolUseID = 'tu-1', input = { path: 'notes.txt' }) => canUseTool({ name: 'Write', userFacingName: () => 'Write' }, input, context, {}, toolUseID);
  const answer = (request_id, response, extra = {}) => input.push(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response, ...extra } }) + '\n');
  return { io, input, seen, out, exits, errors, orphans, abort, ask, answer };
}

const brief = (value) => JSON.stringify(value);
// U+2028 / U+2029 直接打印出来，会被某些 Markdown 渲染器当成换行：显示成它们的转义写法
const visible = (text) => String(text).replace(new RegExp('[\\u2028\\u2029]', 'g'), (c) => '\\u' + c.charCodeAt(0).toString(16));
const row = (...cells) => `| ${cells.join(' | ')} |`;
const table = (head, rows) => [row(...head), row(...head.map(() => '---')), ...rows.map((r) => row(...r.map((c) => String(c).replace(/\|/g, '\\|'))))].join('\n');

const parts = {
  // 一、请求和回答怎么配对：对的 id、不认识的 id、重复的回答
  async pairing() {
    const t = start();
    const pending = t.ask();
    await sleep(5);
    const request = t.out[0];
    const rows = [['Claude Code 写出', `\`${request.type}\` · \`${request.request.subtype}\``, `request_id=\`${request.request_id}\`，tool_use_id=\`${request.request.tool_use_id}\``]];

    t.answer('no-such-request', { behavior: 'allow', updatedInput: {}, toolUseID: 'tu-other' });
    await sleep(5);
    rows.push(['宿主回答了一个不认识的 id', '没有任何效果', `请求仍在等待（pendingRequests 里有 ${t.io.getPendingPermissionRequests().length} 个）；交给“孤儿回答”回调 ${brief(t.orphans)}`]);

    t.answer(request.request_id, { behavior: 'allow', updatedInput: { path: 'notes.txt', text: '宿主改写过' }, toolUseID: 'tu-1' });
    const decision = await pending;
    rows.push(['宿主回答了正确的 id', '请求完成', `决定 \`${decision.behavior}\`，updatedInput=${brief(decision.updatedInput)}`]);

    t.answer(request.request_id, { behavior: 'deny', message: '迟到的重复回答', toolUseID: 'tu-1' });
    await sleep(5);
    rows.push(['同一个 id 又回答了一次', '被吃掉', `不再影响任何东西，也没有交给孤儿回调（${brief(t.orphans)}）：tool_use_id 记在 resolvedToolUseIds 里`]);
    t.input.end();
    return table(['发生了什么', '结果', '细节'], rows);
  },

  // 二、输入结束（EOF）：等待中的请求怎么办，以后的请求怎么办
  async closing() {
    const t = start();
    const first = t.ask('tu-1');
    await sleep(5);
    t.input.end();
    const d1 = await first;
    const second = await t.ask('tu-2');
    return table(['时刻', '决定', '给模型看的话'], [
      ['EOF 时有一个请求在等待', d1.behavior, d1.message],
      ['EOF 之后又来一个调用', second.behavior, second.message],
    ]);
  },

  // 三、等待期间运行被中止：请求被撤销，宿主收到 control_cancel_request
  async abort() {
    const t = start();
    const pending = t.ask('tu-1');
    await sleep(5);
    t.abort.abort();
    const decision = await pending;
    await sleep(5);
    return table(['写给宿主的消息（按顺序）', '说明'], [
      [`\`${t.out[0].type}\` · ${t.out[0].request.subtype}`, '提问'],
      [`\`${t.out[1].type}\` request_id=\`${t.out[1].request_id}\``, '撤销同一个 id：宿主不必再回答'],
    ]) + `\n\n运行方拿到的决定：\`${decision.behavior}\`，${decision.message}`;
  },

  // 四、PermissionRequest 钩子和宿主赛跑
  async race() {
    const rows = [];
    for (const [label, hook, hostAnswer] of [
      ['钩子立刻决定 allow', async () => ({ behavior: 'allow', updatedInput: { path: 'from-hook.txt' }, decisionReason: { type: 'hook' } }), undefined],
      ['钩子没有意见（返回空），宿主回答 deny', async () => undefined, { behavior: 'deny', message: '宿主拒绝' }],
      ['钩子 100ms 后才决定，宿主 10ms 就回答 allow', async () => { await sleep(100); return { behavior: 'deny', message: '钩子太慢了' }; }, { behavior: 'allow', updatedInput: { path: 'notes.txt' } }],
    ]) {
      const t = start({ hook });
      const pending = t.ask();
      await sleep(10);
      if (hostAnswer) t.answer(t.out[0].request_id, hostAnswer);
      const decision = await pending;
      await sleep(5);
      rows.push([label, t.out.map((m) => m.type + (m.request?.subtype ? `:${m.request.subtype}` : '')).join(' → '), `\`${decision.behavior}\`${decision.message ? `：${decision.message}` : ''}`, decision.decisionReason?.type ?? '']);
      t.input.end();
    }
    return table(['场景', '写给宿主的消息', '最终决定', '决定来自'], rows);
  },

  // 五、读 stdin：数据块在任意位置断开，空行，没有换行的最后一行，坏行
  async framing() {
    const rows = [];
    const cases = [
      ['一条消息被拆在两个数据块里', ['{"type":"user","message":{"role":"user","content":"你', '好"},"session_id":"","parent_tool_use_id":null}\n']],
      ['一个数据块里有两条，中间夹着空行', ['{"type":"keep_alive"}\n\n{"type":"user","message":{"role":"user","content":"a"}}\n']],
      ['内容里有 U+2028（JSON 字符串里合法）', ['{"type":"user","message":{"role":"user","content":"前\u2028后"}}\n']],
      ['最后一行没有换行', ['{"type":"user","message":{"role":"user","content":"尾"}}']],
      ['一行不是 JSON', ['这不是 JSON\n']],
    ];
    for (const [label, chunks] of cases) {
      const t = start();
      for (const chunk of chunks) t.input.push(chunk);
      t.input.end();
      await sleep(10);
      const result = t.exits.length ? `**进程退出，exit(${t.exits[0]})**，stderr：${t.errors[0]}` : t.seen.length ? t.seen.map((m) => `\`${m.type}\`${m.message ? ` “${visible(m.message.content)}”` : ''}`).join('、') : '（没有产生消息）';
      rows.push([label, result]);
    }
    return table(['输入', 'StructuredIO 读到的'], rows) + '\n\n`keep_alive` 被默默吃掉；坏行直接让进程退出（Pi 的 RPC 模式则回一个错误响应继续运行）。';
  },
};

const isMain = new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  const only = process.argv[2];
  for (const [name, run] of Object.entries(parts)) {
    if (only && only !== name) continue;
    console.log(await run());
    if (!only) console.log();
  }
}
export { parts };
