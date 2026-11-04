// 第 5 章（上半）：会话——把对话存成只追加的树，进程退出、崩溃之后还能接着用。
//
// 对应 Claude Code 2.1.88 里的三处：
//   utils/sessionStorage.ts        写：recordTranscript / insertMessageChain，每条记录带 uuid 和 parentUuid；
//                                  读：loadTranscriptFile / buildConversationChain，从叶子沿 parentUuid 走回根
//   utils/conversationRecovery.ts  恢复时的整理：丢掉没有结果的工具调用，判断上一轮是不是被打断了
//   utils/messages.ts              ensureToolResultPairing：每次请求之前补齐 / 去掉工具结果
//
// 三层，各管一件事：
//   Journal（runtime/journal.mjs）  一行一条、带哈希链的追加日志。保证写下去的内容不会悄悄变，
//                                  崩溃时最多损坏最后一行，下次追加前先把残缺的尾巴截掉；
//   Session                        在日志上加一个 parent 字段：每条记录指向它的前一条，于是日志成了一棵树；
//   restore / projectHistory       读出来的历史怎么整理：恢复时整理一次，每次请求前再投影一次——
//                                  两者都只改“拿到的副本”，不回头改文件。
//
// 和原版相比的简化：
//   · 一个进程、一个写入者，同步写盘（原版有一条每 100ms 刷一批的写队列，写盘不阻塞界面）；
//   · 一条消息一条记录。原版按内容块拆记录：模型一次回复里有三个并行的 Read，文件里就是三条 assistant 记录，
//     各自的 tool_result 又指回自己那一条——于是并行调用在文件里是有向无环图，而不是链。
//     原版因此需要“把单链遍历走丢的兄弟记录补回来”这一步（labs/ch05/transcript.mjs 用真实录制演示）；
//     coda 的一条 assistant 消息自带 calls 数组，一棵树就够了；
//   · 没有 sidechain（子 Agent 的记录）、标题、标签这类元数据记录，也没有 --resume 的会话选择界面。
import { randomUUID } from "node:crypto";
import { Journal } from "../../runtime/journal.mjs";

// 恢复时发现“工具执行到一半被打断”，补一条用户消息让模型接着做。
export const CONTINUE_PROMPT = "Continue the work that was interrupted.";
// 请求前发现某个调用没有结果，补的错误结果。
const NO_RESULT = "Interrupted before result was recorded.";

// ───────────────────────── 写：一棵只追加的树 ─────────────────────────

export class Session {
  constructor(file) {
    this.log = new Journal(file);
    // 当前分支的叶子 = 文件里最后一条记录。新分支的记录一定是最后追加的，
    // 所以“当前在哪个分支”不用另外存——重新打开文件，最后写下的那一支就是当前分支。
    // （原版是同一个思路：找时间戳最新的、没有孩子的消息，见 getLastSessionLog。）
    this.head = this.log.read().at(-1)?.id ?? null;
  }

  // 追加一条消息，父节点默认是当前叶子。父节点必须已经在文件里：
  // 一条没写进去的记录不能当别人的父亲，否则文件里会出现悬空的 parent，整棵树从那里断开。
  append(message, parent = this.head) {
    const rows = this.log.read();
    if (parent && !rows.some((row) => row.id === parent))
      throw Error("missing parent");
    const row = { id: randomUUID(), parent, message: structuredClone(message) };
    this.log.append(row);
    this.head = row.id;
    return row.id;
  }

  // 回到过去的某一条：只移动叶子，什么都不删。之后追加的记录以它为父亲，自然长出新分支。
  branch(id) {
    if (!this.log.read().some((row) => row.id === id))
      throw Error("unknown branch");
    this.head = id;
  }

  // 从 id 沿着 parent 走回根，反转，就是发给模型的那条路径。
  // 兄弟分支上的记录还在文件里，但不在这条路径上，所以不会进入历史。
  history(id = this.head) {
    const byId = new Map(this.log.read().map((row) => [row.id, row]));
    const path = [];
    const seen = new Set();
    while (id) {
      if (seen.has(id) || !byId.has(id)) throw Error("broken session ancestry");
      seen.add(id);
      const row = byId.get(id);
      path.unshift(row.message);
      id = row.parent;
    }
    return path;
  }

  // 所有叶子：没有任何记录把它当父亲的那些。多于一个就说明文件里有分支。
  leaves() {
    const rows = this.log.read();
    const parents = new Set(rows.map((row) => row.parent));
    return rows.filter((row) => !parents.has(row.id)).map((row) => row.id);
  }

  // 把某条路径复制进一个新文件，得到一个独立的会话（--fork-session）。
  // 原来的文件不再追加，两边从此各走各的。
  fork(file, id = this.head) {
    const copy = new Session(file);
    for (const message of this.history(id)) copy.append(message);
    return copy;
  }

  // 压缩之后的新起点。对应 compact_boundary：
  //   · 第一条记录的 parent 是 null——一个新的根，history() 走到这里就停，所以恢复时只会加载压缩之后的部分；
  //   · logicalParent 指回压缩前的叶子，旧记录一条没删，用 history(旧叶子) 还能完整取回来审计、回退。
  // messages 是 Compactor 产出的“摘要 + 保留的消息 + 重新附上的内容”。
  appendCompaction(messages, previous = this.head) {
    let parent = null;
    messages.forEach((message, index) => {
      const row = { id: randomUUID(), parent, message: structuredClone(message) };
      if (index === 0) row.logicalParent = previous;
      this.log.append(row);
      parent = row.id;
    });
    if (parent) this.head = parent;
    return this.head;
  }
}

// ───────────────────────── 读：恢复时的整理 ─────────────────────────

// 对应 deserializeMessagesWithInterruptDetection 做的三件事：
//   1. 丢掉“所有工具调用都没有结果”的助手消息（进程在工具执行中被杀，调用写进了文件，结果没来得及写）。
//      原版按内容块存记录，文字块是独立的一条，所以留下来；coda 的一条消息里文字和调用在一起，
//      所以去掉 calls、保留文字，没有文字的整条丢掉。只有一部分调用缺结果的消息先留着，
//      请求前的 projectHistory 会给缺的那几个补错误结果；
//   2. 按最后一条消息判断上一轮的状态：
//        assistant            正常结束（none）
//        用户的提问           提问发出去了，模型还没回应（interrupted_prompt）
//        工具结果             工具跑完了，模型还没看到结果（interrupted_turn），补一句“接着做”；
//   3. 原版还会在末尾的用户消息后补一条占位的助手消息，让对话不继续也合法。coda 省略。
// 返回一个新数组，不改传入的 history，更不改文件。
export function restore(history) {
  const answered = new Set(
    history.filter((m) => m.role === "tool").map((m) => m.id),
  );
  const messages = [];
  for (const message of history) {
    const calls = message.role === "assistant" ? (message.calls ?? []) : [];
    const noneAnswered = calls.length > 0 && calls.every((c) => !answered.has(c.id));
    if (!noneAnswered) {
      messages.push(structuredClone(message));
      continue;
    }
    if (message.text?.trim()) {
      const { calls: _dropped, ...textOnly } = message;
      messages.push(structuredClone(textOnly));
    }
  }

  const last = messages.at(-1);
  let interruption = "none";
  if (last?.role === "user") interruption = "interrupted_prompt";
  if (last?.role === "tool") {
    interruption = "interrupted_turn";
    messages.push({ role: "user", text: CONTINUE_PROMPT, meta: true });
  }
  return { messages, interruption };
}

// ───────────────────────── 请求前的投影 ─────────────────────────

// 对应 ensureToolResultPairing：每次发请求之前，保证“每个工具调用恰好有一个紧随其后的结果”。
//   · 调用没有结果 → 补一条错误结果（服务商会拒绝没有结果的调用）；
//   · 结果找不到对应的调用 → 不放进请求；
//   · 结果的顺序按调用的顺序排。
// 返回的是副本。原始历史（和文件）里的孤立结果、缺失的结果都原样保留，这样存储永远只记事实。
export function projectHistory(history) {
  const output = [];
  for (let i = 0; i < history.length; i++) {
    const message = structuredClone(history[i]);
    if (message.role === "tool") continue; // 走到这里的结果都是孤立的：紧邻的结果在下面被收走了
    output.push(message);
    if (message.role !== "assistant" || !message.calls?.length) continue;

    const following = [];
    while (history[i + 1]?.role === "tool") following.push(history[++i]);
    for (const call of message.calls) {
      const result = following.find((r) => r.id === call.id);
      output.push(
        structuredClone(
          result ?? { role: "tool", id: call.id, error: true, text: NO_RESULT },
        ),
      );
    }
  }
  return output;
}
