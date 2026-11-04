// 第 3 章：工具流水线。
//
// 对应 Claude Code 2.1.88 里的两个文件：
//   services/tools/toolOrchestration.ts   一条回复里有多个工具调用时怎么分批（partitionToolCalls、runTools）
//   services/tools/toolExecution.ts       一个调用从“参数到达”到“结果交回”要过的关卡（checkPermissionsAndCallTool）
//
// 和原版相比，这里做了几处简化：
//   · 没有 StreamingToolExecutor：回复完整到达以后才开始执行（流式执行见第 3 章正文）；
//   · 原版先用 zod 检查参数的形状、再调用工具自己的 validateInput；这里合成一个 validate()；
//   · 并发批次里的结果按“调用的顺序”排列（原版按完成的先后，Pi 和 mox 也按调用顺序）；
//   · 大结果落盘只管“单个结果多大”，没有“一条消息里所有结果加起来多大”的总预算。
//
// 一个工具定义是普通对象：
//   name, description, schema   发给模型的部分
//   parallel: true              声明“和其他并发安全的调用同时跑没问题”；不写就是 false（宁可串行）
//   readOnly: true              给权限 gate 用（第 6 章）
//   validate(input)             检查参数；不合法就抛错。必须没有副作用，因为分批时也会调用它
//   execute(input, context)     干活；返回 { text, error?, details?, applyContext? }
//   maxResultChars              结果超过这么多字符就落盘，缺省 30000；Infinity 表示永不落盘
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hooks } from "./hooks.mjs";

const DEFAULT_MAX_RESULT_CHARS = 30_000;
const PREVIEW_CHARS = 2_000;

// ───────────────────────── 分批 ─────────────────────────

// 一个调用能不能和别的调用同时跑？三个条件缺一不可：
// 工具存在、工具声明了 parallel、这一次的输入通得过校验。
// 判断过程出错就当“不能”——和原版一样，拿不准的时候宁可串行。
function canRunInParallel(tool, input) {
  if (!tool?.parallel) return false;
  try {
    tool.validate?.(input);
    return true;
  } catch {
    return false;
  }
}

// 把一条回复里的调用切成批次，每批是 { safe, calls }。
// 能并发的调用只会并进“紧挨着的上一批”，而且那一批也得是能并发的；
// 其余调用各自单独成批，同时成为后面所有调用的顺序屏障。
// 所以 Read、Edit、Read 是三批，而不是“两个 Read 一起 + 一个 Edit”。
export function partition(calls, lookup) {
  const batches = [];
  for (const call of calls) {
    const safe = canRunInParallel(lookup(call.name), call.input);
    const last = batches.at(-1);
    if (safe && last?.safe) last.calls.push(call);
    else batches.push({ safe, calls: [call] });
  }
  return batches;
}

// ───────────────────────── 结果整形 ─────────────────────────

const kb = (chars) => `${(chars / 1024).toFixed(1)} KB`;

// 预览尽量截在换行处，免得半行话；但换行位置太靠前（不到一半）就硬切。
function previewOf(text) {
  const head = text.slice(0, PREVIEW_CHARS);
  const cut = head.lastIndexOf("\n");
  return cut > PREVIEW_CHARS / 2 ? head.slice(0, cut) : head;
}

// 把完整输出存成文件，返回要交给模型的文字：文件在哪、有多大、开头长什么样。
// 模型需要更多内容时，可以用 Read 分段读这个文件，或者搜索它。
function persistLargeResult(call, text, dir) {
  // call.id 来自模型，只留字母数字，免得有人把它写成 "../../x"
  const file = join(dir, `${String(call.id).replace(/[^\w.-]/g, "_")}.txt`);
  mkdirSync(dir, { recursive: true });
  // 原版用 "wx" 写入，同一个 id 只写一次，因为压缩（microcompact）会重放旧消息；
  // coda 不重放，直接覆盖。
  writeFileSync(file, text);
  const notice =
    `[output too large: ${kb(text.length)}; full text saved to ${file}]\n` +
    `Preview (first ${PREVIEW_CHARS} characters):\n${previewOf(text)}`;
  return { notice, file };
}

// 工具返回的是 { text, details }：text 给模型，details 给程序（Hook、界面、日志）。
// 这里只改给模型的那一份：空结果换成一句说明，超大结果换成“路径 + 预览”。
function shapeResult(call, tool, result, { maxResultChars, resultDir }) {
  let text = result.text ?? "";
  let details = result.details;
  // 空的 tool_result 会让一些模型误以为这一轮已经结束
  if (text.trim() === "") text = `(${call.name} completed with no output)`;
  const limit = tool.maxResultChars ?? maxResultChars;
  if (resultDir && text.length > limit) {
    const { notice, file } = persistLargeResult(call, text, resultDir);
    text = notice;
    details = { ...details, persistedPath: file };
  }
  return {
    role: "tool",
    id: call.id,
    text,
    error: !!result.error,
    details,
    applyContext: result.applyContext,
  };
}

// ───────────────────────── 流水线 ─────────────────────────

export class Toolset {
  // gate：权限（第 6 章）；hooks：执行前后的 Hook（第 7 章）；
  // resultDir：大结果存放的目录，不给就不落盘（结果原样交给模型）。
  constructor(
    tools,
    {
      gate = async () => true,
      hooks = new Hooks(),
      resultDir,
      maxResultChars = DEFAULT_MAX_RESULT_CHARS,
    } = {},
  ) {
    this.tools = new Map();
    this.gate = gate;
    this.hooks = hooks;
    this.resultDir = resultDir;
    this.maxResultChars = maxResultChars;
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw Error("duplicate tool");
      this.tools.set(tool.name, tool);
    }
  }

  // 一个调用依次过这些关；任何一关出错，都会变成一条带着同一个 id 的错误结果，
  // 后面的关卡不再执行。每个调用恰好得到一条结果，模型才知道每个请求的下场。
  async execute(call, context = {}) {
    try {
      const tool = this.tools.get(call.name);
      if (!tool) throw Error(`unknown tool: ${call.name}`);
      if (
        !call.id ||
        !call.input ||
        typeof call.input !== "object" ||
        Array.isArray(call.input)
      )
        throw Error("invalid call envelope");
      context.signal?.throwIfAborted(); //         已经取消了，就别开始

      tool.validate?.(call.input); //              ① 校验：先于 Hook，所以校验失败的调用 Hook 根本看不到
      const before = await this.hooks.before(call, context); //  ② 执行前 Hook：可以拦下，也可以改写参数
      if (before.block) throw Error(before.reason);
      const checked = { ...call, input: structuredClone(before.input) };
      tool.validate?.(checked.input); //           Hook 改写过的参数要重新校验，不能绕过去
      if (!(await this.gate(checked, tool, context.signal)))
        throw Error("permission denied"); //       ③ 权限
      context.signal?.throwIfAborted(); //         问用户可能等了很久，期间也许已经取消

      context.emit?.({ type: "tool_start", id: call.id, name: call.name });
      const raw = await tool.execute(checked.input, context); //  ④ 执行
      const result = await this.hooks.after(checked, raw, context); //  ⑤ 执行后 Hook
      context.emit?.({ type: "tool_end", id: call.id });
      return shapeResult(call, tool, result, this); //  ⑥ 结果整形
    } catch (error) {
      return {
        role: "tool",
        id: call.id,
        error: true,
        text: String(error.message ?? error),
      };
    }
  }

  // 执行一条回复里的全部调用：分批以后，批与批之间串行，并发批内部同时跑。
  async runCalls(calls, context = {}) {
    const messages = [];
    for (const batch of partition(calls, (name) => this.tools.get(name))) {
      const results = batch.safe
        ? await Promise.all(batch.calls.map((c) => this.execute(c, context)))
        : [await this.execute(batch.calls[0], context)];
      for (const result of results) {
        // 工具想改上下文（比如切换工作目录），等整批结束后按调用顺序依次生效
        result.applyContext?.(context);
        const { applyContext, ...message } = result;
        messages.push(message);
      }
    }
    return messages;
  }
}
