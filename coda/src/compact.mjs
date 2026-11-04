// 第 5 章（下半）：压缩——上下文快满时，把旧的对话换成一份更短的“交接”。
//
// 对应 Claude Code 2.1.88 里的四处：
//   services/compact/autoCompact.ts   什么时候压缩：有效窗口、缓冲、触发线，以及连续失败的熔断（autoCompactIfNeeded）
//   services/compact/microCompact.ts  不请求模型的压缩：很久没说话以后，把旧工具结果换成一句话
//   services/compact/compact.ts       compactConversation：请求摘要 → 重新附上最近读过的文件 → 重建消息
//   services/compact/prompt.ts        摘要的格式：<analysis> 草稿被剥掉，只留 <summary> 的正文
//
// 一次 compact() 依次做这些事（和 query.ts 里每一圈的顺序一致：先微压缩，再自动压缩）：
//   ① 熔断：连续失败太多次，这一轮不再尝试；
//   ② 微压缩：闲置超过一小时，旧工具结果换成占位文字（便宜，不请求模型）；
//   ③ 估算大小，没到触发线就返回；
//   ④ 在合法的位置切开：前面的交给摘要，后面的原样保留；
//   ⑤ 请求摘要（summarize 是端口，实验里用脚本代替模型）；
//   ⑥ 按固定顺序重建：摘要 → 保留的消息 → 重新附上的文件 → Hook 结果。
//
// 和原版相比的简化：
//   · 大小用“字符数 ÷ 4”估算。原版是“上一次回复的真实用量 + 之后新增消息的估算”（tokenCountWithEstimation），
//     coda 的消息里没有用量字段；
//   · 摘要请求由调用者提供（summarize）。原版把上一个请求原样重发、末尾追加压缩指令，
//     好让摘要请求命中提示缓存，summaryRequest() 演示了这个形状；
//   · 原版的边界标记（compact_boundary）是一条模型看不到的 system 消息，这里并进了摘要消息的开头；
//   · 原版 compactConversation 把整个对话交给摘要，保留尾巴是部分压缩、会话记忆压缩这两条路径的做法；
//     coda 保留“当前这一轮”：自动压缩发生在一次运行的中间，模型得知道自己正在做什么；
//   · 没有会话记忆压缩（服务端灰度开关控制，默认关）和压缩请求自己撑爆窗口时的“丢掉最旧的一组再试”。
import { projectHistory } from "./session.mjs";

// ───────────────────────── 常量（数字都来自原版） ─────────────────────────

export const SUMMARY_RESERVE = 20_000; // 给“写摘要”这次请求的输出预留（autoCompact.ts）
export const AUTOCOMPACT_BUFFER = 13_000; // 触发线再往下留的缓冲（autoCompact.ts）
export const MAX_FAILURES = 3; // 连续失败这么多次就不再尝试（autoCompact.ts）
// 压缩后最多重新附上几个文件、每个文件最多多少 token、总共最多多少 token（compact.ts）
export const POST_COMPACT = { maxFiles: 5, perFileTokens: 5_000, budgetTokens: 50_000 };
// 微压缩：闲置超过这么久才触发；触发后保留最近几个工具结果（timeBasedMCConfig.ts）
export const MICRO = { idleMs: 60 * 60_000, keepRecent: 5 };
// 只有这几类工具的结果会被微压缩：读、搜、抓取、Shell、编辑（microCompact.ts）。Test 是 coda 里的 Shell。
const COMPACTABLE = new Set(["Read", "Bash", "Grep", "Glob", "WebSearch", "WebFetch", "Edit", "Write", "Test"]);
export const CLEARED = "[Old tool result cleared to save context]";

// ───────────────────────── 大小与触发线 ─────────────────────────

export const estimate = (messages) =>
  Math.ceil(JSON.stringify(messages).length / 4);

// 有效窗口 = 模型窗口 − 给摘要输出的预留。压缩本身要产出一份摘要，这部分空间必须先让出来。
// maxOutput 是模型的最大输出；原版取它和 20000 中较小的一个。
export function effectiveWindow(window, maxOutput = SUMMARY_RESERVE) {
  return window - Math.min(maxOutput, SUMMARY_RESERVE);
}

// 触发线 = 有效窗口 − 缓冲。percent 是测试用的覆盖：提早触发可以，推迟不行（取较小者）。
// 这里的 window 传“有效窗口”；Compactor 会先调用 effectiveWindow。
export function threshold(window, buffer, percent) {
  const normal = Math.max(0, window - buffer);
  const p = parseFloat(percent);
  return p > 0 && p <= 100
    ? Math.min(normal, Math.floor((window * p) / 100))
    : normal;
}

// ───────────────────────── 微压缩：不请求模型的压缩 ─────────────────────────

// 对应 maybeTimeBasedMicrocompact。服务端的提示缓存大约一小时过期；闲置超过这么久，
// 下一个请求反正要整个重写前缀，不如先把旧工具结果清掉，让重写的内容少一点。
//   idleMs   距离最近一条助手消息过了多久，调用者算好传进来；不传就不触发
//   保留最近 keepRecent 个“可压缩”工具的结果（至少 1 个），更早的内容换成 CLEARED
// 返回 { messages, cleared, savedTokens }；没有东西可清时 messages 原样返回。
export function microcompact(
  messages,
  { idleMs, thresholdMs = MICRO.idleMs, keepRecent = MICRO.keepRecent } = {},
) {
  const untouched = { messages, cleared: 0, savedTokens: 0 };
  if (idleMs === undefined || idleMs < thresholdMs) return untouched;

  // 可压缩的调用 id，按出现的先后排列。tool 消息里没有工具名，要回头看发起它的那个调用。
  const compactable = messages
    .flatMap((m) => (m.role === "assistant" ? (m.calls ?? []) : []))
    .filter((call) => COMPACTABLE.has(call.name))
    .map((call) => call.id);
  const keep = new Set(compactable.slice(-Math.max(1, keepRecent)));
  const clear = new Set(compactable.filter((id) => !keep.has(id)));

  let cleared = 0;
  let savedTokens = 0;
  const result = messages.map((m) => {
    if (m.role !== "tool" || !clear.has(m.id) || m.text === CLEARED) return m;
    cleared++;
    savedTokens += estimate(m.text);
    return { ...m, text: CLEARED };
  });
  return cleared ? { messages: result, cleared, savedTokens } : untouched;
}

// ───────────────────────── 摘要 ─────────────────────────

// 摘要请求要借用主对话的缓存：system、tools、已有的消息逐字不变，只在最后追加一条指令。
// （原版的工具定义照样发送，哪怕指令里写着“不许调用工具”——去掉工具，整个前缀都变了，缓存全部失效。）
export function summaryRequest(wire, instruction) {
  return { ...wire, messages: [...wire.messages, { role: "user", text: instruction }] };
}

// 模型写的摘要先写一段 <analysis> 草稿整理思路，再写 <summary> 正文；草稿不进上下文。
// 没有标签的输出（比如实验里的脚本摘要）原样使用。
export function formatSummary(raw) {
  const body = /<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1];
  if (body === undefined) return raw.replace(/<analysis>[\s\S]*?<\/analysis>/, "").trim();
  return `Summary:\n${body.trim()}`;
}

// 摘要放进上下文的样子：一条用户消息。末尾告诉模型完整记录在哪个文件里——
// 摘要会丢细节，但事实没丢，要原话、要精确的报错信息，可以去读 transcript。
function summaryMessage(summary, transcript) {
  const where = transcript ? `\n\nFull transcript before compaction: ${transcript}` : "";
  return {
    role: "user",
    text: `[compact boundary] The conversation so far was compacted into this summary.\n\n${summary}${where}`,
  };
}

// ───────────────────────── 压缩后重新附上的内容 ─────────────────────────

// 历史里 Read 过哪些文件，最近的在前，每个路径只算一次。
// 原版看的是 readFileState（Read、Edit、Write 都会更新它，按时间戳排序）；coda 从历史里翻。
export function recentReads(history) {
  const paths = [];
  for (const m of history.toReversed()) {
    for (const call of (m.calls ?? []).toReversed())
      if (call.name === "Read" && call.input?.path && !paths.includes(call.input.path))
        paths.push(call.input.path);
  }
  return paths;
}

// 对应 createPostCompactFileAttachments：摘要替掉了原来的工具结果，模型刚读过的文件就看不到了。
// 把最近读过的几个文件重新读一遍（读磁盘上现在的内容，不是旧结果），附在摘要后面：
//   · 最多 maxFiles 个；单个文件超过 perFileTokens 就只给路径，让模型需要时自己再读；
//   · 总量不超过 budgetTokens；
//   · skip 里是保留下来的消息：那里面已经读过的文件模型看得见，不必重复附上。
// readFile(path) 返回文本，文件没了就返回 undefined。
export async function fileAttachments(
  history,
  readFile,
  { skip = [], ...limits } = {},
) {
  const { maxFiles, perFileTokens, budgetTokens } = { ...POST_COMPACT, ...limits };
  const visible = new Set(recentReads(skip));
  const paths = recentReads(history).filter((p) => !visible.has(p)).slice(0, maxFiles);

  const attachments = [];
  let used = 0;
  for (const path of paths) {
    const text = await readFile(path);
    if (text === undefined) continue;
    const tooBig = estimate(text) > perFileTokens;
    const body = tooBig
      ? `[file reference] ${path} was read before compaction but is too large to restore; Read it again if you need it.`
      : `[restored file] ${path}\n${text}`;
    if (used + estimate(body) > budgetTokens) continue;
    used += estimate(body);
    attachments.push({ role: "user", text: body, restored: path });
  }
  return attachments;
}

// ───────────────────────── 重建 ─────────────────────────

// 对应 buildPostCompactMessages。顺序固定：摘要 → 保留的消息 → 重新附上的内容 → Hook 的结果。
// 摘要在最前面，是因为它代表“更早发生的事”；附件在后面，是因为它们是“现在的状态”。
export function buildPostCompact({ summary, kept = [], attachments = [], hookResults = [] }) {
  return [summary, ...kept, ...attachments, ...hookResults];
}

// 在哪里切。前面的交给摘要，从切点起原样保留。切点只能落在用户消息或助手消息上：
// 工具结果必须和发起它的那条助手消息一起，切在中间会留下没有调用的结果，请求会被拒绝。
function cutPoint(messages) {
  const lastUser = messages.findLastIndex((m) => m.role === "user");
  if (lastUser > 0) return lastUser; // 保留整个当前回合
  // 整段历史只有一个回合（一次提问之后模型自己干了很久）：在最后一组“调用 + 结果”前面切
  const lastAssistant = messages.findLastIndex((m) => m.role === "assistant");
  return Math.max(lastAssistant, 0);
}

// ───────────────────────── Compactor ─────────────────────────

export class Compactor {
  // window        模型的上下文窗口
  // reserve       给摘要输出预留的空间（原版 min(模型最大输出, 20000)；默认 0，方便用很小的窗口做实验）
  // buffer        触发线与有效窗口之间的缓冲
  // summarize     端口：(要总结的消息, { instructions }) → 摘要文本
  // maxFailures   连续失败几次后熔断
  // readFile      端口：压缩后重新附上文件时，怎么读磁盘上现在的内容；不给就不附
  // refillGuard   { within, times }：压缩后 within 次请求之内又满了，连续 times 次就停下。
  //               2.1.88 的源码里没有这道保护；录制的 2.1.296 有（terminal_reason: rapid_refill_breaker）。默认关闭。
  constructor({
    window = 2000,
    buffer = 200,
    reserve = 0,
    summarize,
    maxFailures = MAX_FAILURES,
    readFile,
    refillGuard,
  } = {}) {
    Object.assign(this, { window, buffer, reserve, summarize, maxFailures, readFile, refillGuard });
    this.failures = 0; //      连续失败次数；成功清零
    this.sinceCompact = Infinity; // 距上一次压缩过了几次请求
    this.rapid = 0; //         连续“压缩完很快又满了”的次数
  }

  limit(percent) {
    return threshold(effectiveWindow(this.window, this.reserve), this.buffer, percent);
  }

  // force 是用户手动的 /compact：不看熔断，也不看触发线。
  // 返回 { changed, reason?, messages, ... }。changed 为 false 时 messages 就是传入的 history。
  async compact(
    history,
    { force = false, percent, attachments = [], hookResults = [], idleMs, instructions, transcript } = {},
  ) {
    const unchanged = (reason) => ({ changed: false, reason, messages: history });
    this.sinceCompact++;

    // ① 熔断。原版把失败次数放在 query 循环的 State 里一圈圈传下去，这里放在实例上。
    if (!force && this.failures >= this.maxFailures) return unchanged("circuit-open");

    // ② 微压缩
    const micro = microcompact(history, { idleMs });
    const view = micro.messages;

    // ③ 没到触发线
    const tokens = estimate(view);
    const limit = this.limit(percent);
    if (!force && tokens < limit)
      return micro.cleared
        ? { changed: true, reason: "microcompact", messages: view, cleared: micro.cleared, tokens, limit }
        : { ...unchanged("below-threshold"), tokens, limit };

    // 压缩完很快又满了：连续几次就停下，别每一圈都付一次摘要的钱。
    // 停下以后 sinceCompact 归零，后面的请求都算“很快”，保护一直有效，直到调用者处理。
    if (!force && this.refillGuard) {
      const quick = this.sinceCompact <= this.refillGuard.within;
      this.rapid = quick ? this.rapid + 1 : 0;
      if (this.rapid >= this.refillGuard.times) {
        this.sinceCompact = 0;
        return unchanged("rapid-refill");
      }
    }

    // ④ 切开
    const projected = projectHistory(view);
    const cut = cutPoint(projected);
    if (cut === 0) return unchanged("one-atomic-group");
    const old = projected.slice(0, cut);
    const kept = projected.slice(cut);

    try {
      // ⑤ 摘要
      const raw = await this.summarize(old, { instructions });
      const summary = typeof raw === "string" ? formatSummary(raw) : "";
      if (!summary) throw Error("empty summary");

      // ⑥ 重建
      const restored = this.readFile
        ? await fileAttachments(projected, this.readFile, { skip: kept })
        : [];
      this.failures = 0;
      this.sinceCompact = 0;
      const messages = buildPostCompact({
        summary: summaryMessage(summary, transcript),
        kept,
        attachments: [...restored, ...attachments],
        hookResults,
      });
      return {
        changed: true,
        messages,
        summarized: old.length,
        kept: kept.length,
        restored: restored.map((a) => a.restored),
        tokens,
        tokensAfter: estimate(messages),
        limit,
      };
    } catch (error) {
      this.failures++;
      return { ...unchanged("summary-failed"), error: error.message };
    }
  }
}
