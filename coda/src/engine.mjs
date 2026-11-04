// 第 1 章：主循环 Engine。
//
// 对应 Claude Code 的两处源码：
//   · query.ts 的 query() 和 queryLoop()：一个带显式 State 的 async generator。
//     每一次“再请求一次模型”都用一个新的 State 表达，并记下 transition——为什么会有这一圈。
//   · QueryEngine.ts 的 submitMessage()：消费 query() 产出的消息，决定哪些交给调用者。
//     coda 里调用者直接消费 run() 产出的帧，所以这一层被折叠掉了。
//
// 本章实现的机制（每一条在正文里都有对应的 @cc 摘录）：
//   1. 要不要再请求，只看“这次回复里有没有工具调用”（needsFollowUp），不看 stop_reason；
//   2. 回复被截断且没有工具调用：保留半截回复，追加一条“请接着写”，最多续写 3 次；
//   3. 没有工具调用时，先问 Stop Hook：可以拦住结束（继续），也可以直接终止；
//   4. 用户在运行中追加的消息排进同一个队列：工具执行完后取走一部分，其余等这一轮结束再处理；
//   5. 中止：每个工具调用都必须有结果，否则下一次请求会被 API 拒绝；
//   6. 十种出口各有一个 reason（这里实现其中和本章有关的六种）。
//
// 刻意没有做的事：流式输出、压缩（第 5 章）、fallback 模型、token budget、
// 以及会把输出上限升到 64k 的“escalate”（它由服务端灰度开关控制）。

const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3; // 与 query.ts 相同：连续续写最多 3 次

// 出口的 reason → 对外的 status。status 是旧接口，其他章节的实验在用，所以保留。
const STATUS = {
  completed: "completed",
  max_turns: "budget",
  aborted_streaming: "cancelled",
  aborted_tools: "cancelled",
  model_error: "failed",
  stop_hook_prevented: "stopped",
};

const priorityRank = { now: 0, next: 1, later: 2 };

export class Engine {
  constructor({
    model,
    tools,
    request = (messages) => ({ messages }),
    onEvent = () => {},
    onCleanup = async () => {},
    onCompleted = () => {},
    // Stop Hook：模型不再调用工具、本来要结束时被询问。
    // 返回 { block: "反馈文字" } 让循环带着反馈再来一圈，返回 { prevent: "原因" } 直接终止。
    onStop = async () => undefined,
  }) {
    Object.assign(this, { model, tools, request, onEvent, onCleanup, onCompleted, onStop });
    // 一个队列，两个出口（messageQueueManager.ts）：
    //   steer() 排进 next：这一轮工具执行完之后就会被取走；
    //   follow() 排进 later：要等这一轮结束，才作为新的一轮处理。
    this.queue = [];
    this.running = false;
  }

  steer(text) {
    this.queue.push({ role: "user", text, priority: "next" });
  }

  follow(text) {
    this.queue.push({ role: "user", text, priority: "later" });
  }

  // 取出优先级不低于 maxPriority 的命令（对应 getCommandsByMaxPriority + removeFromQueue）。
  takeQueued(maxPriority) {
    const taken = this.queue.filter((c) => priorityRank[c.priority] <= priorityRank[maxPriority]);
    this.queue = this.queue.filter((c) => !taken.includes(c));
    return taken.map(({ role, text }) => ({ role, text }));
  }

  // 对应 query()：外壳。yield* 把 queryLoop 的所有帧原样转出来，
  // 只有 queryLoop 正常返回（拿到 terminal）才执行后面的 onCompleted。
  // queryLoop 抛错，异常穿过 yield*，这里不会执行；调用者提前 .return()，两层生成器一起关闭，同样不会执行。
  async *run(text, options) {
    const terminal = yield* this.queryLoop(text, options);
    this.onCompleted(terminal);
    return terminal;
  }

  // 对应 queryLoop()。maxTurns 默认 8：真实产品默认不设上限，这里给脚本化的实验一个安全阀。
  async *queryLoop(text, { history = [], context = {}, signal, maxTurns = 8 } = {}) {
    if (this.running) throw Error("engine busy");
    this.running = true;

    // 对应 using pendingMemoryPrefetch：不管哪条路退出，资源都只释放一次。
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      await this.onCleanup();
    };
    const emit = (frame) => {
      this.onEvent(structuredClone(frame));
      return frame;
    };

    // 跨圈状态。每个“继续”的位置都写成 state = { ... }，哪些字段保留、哪些清零一眼可见。
    let state = {
      messages: [...structuredClone(history), { role: "user", text }],
      turnCount: 1, // 一轮 = 一次请求 + 它的工具结果。只在 next_turn 时 +1，maxTurns 数的就是它
      recoveryCount: 0, // 连续因输出被截断而续写的次数
      stopHookActive: false, // 这一圈是不是 Stop Hook 逼出来的（会告诉 Hook，让它自己决定要不要放行）
      transition: { reason: "initial" }, // 上一圈为什么继续；第一圈没有
    };
    let requests = 0; // 模型请求的总次数：续写和 Hook 重试也算一次请求，但不算新的一“轮”

    // 出口：所有 return 都从这里走，reason 一目了然。
    // 先把 terminal 帧交给调用者，再把它作为返回值交给 run()（run() 靠它调用 onCompleted）。
    function* leave(reason, messages, extra = {}) {
      const status = STATUS[reason];
      const terminal = emit({ type: "terminal", status, reason, iterations: requests, messages, ...extra });
      yield terminal;
      return terminal;
    }

    try {
      yield emit({ type: "started" });

      while (true) {
        const { messages, turnCount, recoveryCount, stopHookActive, transition } = state;
        signal?.throwIfAborted();

        // ── 1. 请求模型 ────────────────────────────────────────────
        const wire = await this.request(structuredClone(messages));
        requests++;
        yield emit({ type: "request", iteration: requests, turn: turnCount, transition, wire });
        const reply = await this.model(wire, signal);
        if (reply.stop === "error") throw Error(reply.text || "provider failed");

        const assistant = { role: "assistant", text: reply.text ?? "", calls: reply.calls ?? [] };
        yield emit({ type: "assistant", message: assistant });

        // ── 2. 流结束时发现已经被中止 ───────────────────────────────
        // 回复里已经出现的工具调用必须配上结果，否则历史本身就不合法（tool_use 没有 tool_result）。
        if (signal?.aborted) {
          const missing = assistant.calls.map((call) => interrupted(call.id));
          const history = [...messages, assistant, ...missing, ...interruption(signal, false)];
          return yield* leave("aborted_streaming", history);
        }

        // ── 3. 要不要继续：只看有没有工具调用 ───────────────────────
        // stop_reason 不可靠（源码注释就是这个意思），而“有一个 tool_use 块到达”是确定的。
        const needsFollowUp = assistant.calls.length > 0;

        if (!needsFollowUp) {
          // 3a. 输出被截断、又没有工具调用：保留半截回复，请模型接着写。
          // 这个分支只在没有工具调用时才进：有工具调用的回复，走下面的工具路径（半截参数交给校验去拦）。
          if (reply.stop === "length") {
            if (recoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
              state = {
                messages: [...messages, assistant, resumePrompt()],
                turnCount, // 续写不算新的一轮
                recoveryCount: recoveryCount + 1,
                stopHookActive: false,
                transition: { reason: "max_output_tokens_recovery", attempt: recoveryCount + 1 },
              };
              continue;
            }
            // 续写用尽：把“仍被截断”这个事实交给调用者。和 API 错误一样，不再去问 Stop Hook——
            // 一个根本没有完整回复的回合，Hook 没有可评估的东西，还可能把循环拖成死循环。
            return yield* leave("completed", [...messages, assistant], { outputTruncated: true });
          }

          // 3b. Stop Hook：模型认为做完了，给 Hook 一次拦住它的机会。
          const verdict = yield* this.askStopHook({
            messages: [...messages, assistant],
            assistant,
            stopHookActive,
            signal,
          });
          if (verdict.prevent) {
            return yield* leave("stop_hook_prevented", [...messages, assistant], { detail: verdict.prevent });
          }
          if (verdict.block) {
            const feedback = { role: "user", text: `Stop Hook 反馈：\n${verdict.block}`, meta: true };
            state = {
              messages: [...messages, assistant, feedback],
              turnCount, // Hook 逼出来的重试也不算新的一轮：maxTurns 管不住它，只能靠 Hook 自己放行
              recoveryCount: 0,
              stopHookActive: true,
              transition: { reason: "stop_hook_blocking" },
            };
            continue;
          }

          // 3c. 这一轮结束时队列里还有人排队：当作新的一轮接着处理。
          // 在 Claude Code 里这不是 queryLoop 的事，而是 REPL 的 useQueueProcessor 在查询结束后做的；
          // coda 没有 REPL，所以放在 run() 的末尾。
          const queued = this.takeQueued("later");
          if (queued.length) {
            state = {
              messages: [...messages, assistant, ...queued],
              turnCount: 1, // 新的一轮用户输入：maxTurns 重新计数
              recoveryCount: 0,
              stopHookActive: false,
              transition: { reason: "queued_command", count: queued.length },
            };
            continue;
          }

          return yield* leave("completed", [...messages, assistant]);
        }

        // ── 4. 执行工具 ───────────────────────────────────────────
        const results = await this.tools.runCalls(assistant.calls, { ...context, signal, emit });
        for (const message of results) yield emit({ type: "tool_result", message });

        // 工具执行期间被中止：每个调用在 runCalls 里都已经得到一条结果（被中止的是错误结果）。
        if (signal?.aborted) {
          const history = [...messages, assistant, ...results, ...interruption(signal, true)];
          return yield* leave("aborted_tools", history);
        }

        // ── 5. 把工具执行期间排队的 next 级消息一起带进下一次请求 ──────
        const queued = this.takeQueued("next");
        const next = [...messages, assistant, ...results, ...queued];

        const nextTurn = turnCount + 1;
        if (maxTurns && nextTurn > maxTurns) return yield* leave("max_turns", next);

        state = {
          messages: next,
          turnCount: nextTurn,
          recoveryCount: 0, // 工具跑通了，截断计数清零
          stopHookActive, // 原样带过去
          transition: { reason: "next_turn", queued: queued.length },
        };
      }
    } catch (error) {
      // 对应 queryLoop 最外层的 catch：模型请求抛出的异常（或中止信号）变成 terminal，而不是炸穿调用者。
      try {
        await cleanup();
      } catch (cleanupError) {
        error = new AggregateError([error, cleanupError], "execution and cleanup failed");
      }
      const aborted = signal?.aborted;
      return yield* leave(aborted ? "aborted_streaming" : "model_error", state.messages, {
        error: String(error.message ?? error),
      });
    } finally {
      this.running = false;
      await cleanup();
    }
  }

  // Stop Hook 的调用方式对应 query/stopHooks.ts 的 handleStopHooks：
  // Hook 自己抛错只是一条警告，不会拦住结束，也不会让循环失败。
  async *askStopHook(input) {
    try {
      return (await this.onStop(structuredClone(input))) ?? {};
    } catch (error) {
      yield { type: "system", level: "warning", text: `Stop Hook 失败：${error.message ?? error}` };
      return {};
    }
  }
}

// 被中止时补上的工具结果（对应 yieldMissingToolResultBlocks）。
const interrupted = (id) => ({ role: "tool", id, error: true, text: "被用户中断，没有执行。" });

// 中止后追加一条用户消息，让下一次请求知道上一次是怎么结束的。
// 如果中止的原因是“用户又输入了一条新消息”（reason === 'interrupt'），这条新消息本身就足够说明，就不再追加。
function interruption(signal, duringTools) {
  if (signal?.reason === "interrupt") return [];
  const text = duringTools ? "（用户在工具执行期间中断了请求）" : "（用户中断了请求）";
  return [{ role: "user", text, meta: true }];
}

// 续写提示：自己的措辞。要点是三件事——直接接着写、不道歉不复述、把剩下的活拆小。
function resumePrompt() {
  const text = "上一条回复在输出长度上限处被截断。请直接从断开的地方继续，不必道歉或复述前文；剩下的工作请拆成更小的几步。";
  return { role: "user", text, meta: true };
}

export function scripted(replies) {
  const remaining = [...replies];
  return async () => {
    if (!remaining.length) throw Error("script exhausted");
    return structuredClone(remaining.shift());
  };
}

export async function collect(engine, text, options) {
  const frames = [];
  for await (const frame of engine.run(text, options)) frames.push(frame);
  return frames;
}
