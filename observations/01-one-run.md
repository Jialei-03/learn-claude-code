---
motto: 同一次运行，从三个窗口看：事件流、钩子、会话文件。
learn:
  - stream-json 的事件：init、assistant、user、result，以及那些 system 子类型
  - 会话文件的结构：一棵按 uuid / parentUuid 连起来的树，每个内容块一条记录
  - “附件”：注入上下文的东西也被记进了会话文件，并标明以什么身份进入请求
  - 和 mox、Pi 的会话格式对照：同一个问题的三种答案
prereq: 第 0 章；Learn Pi Agent 第 3、7、19 章
time: 40 分钟
build: labs/ch01 —— 一次运行的录制和两个离线分析脚本
---

## 一个小任务

让 Claude Code 修一个 bug：`add.js` 里把加号写成了减号，修好之后运行 `node test.js` 确认。命令行参数让它不必询问就能编辑文件、运行 `node`（权限是第 6 章的话题）：

@code labs/ch01/record.ts

这一次运行留下了三份记录：stdout 上的**事件流**、钩子记录器收到的**钩子数据**、配置目录里的**会话文件**。它们描述的是同一件事，但视角不同。

## 事件流

`claude -p --output-format stream-json --verbose` 把运行过程写成一行一个 JSON 的事件（Learn Pi Agent 第 19 章的 JSON 模式是同一个思路）：

@lab node labs/ch01/events.ts

逐类看：

- **`system:init`**：一切开始之前的“自我介绍”：模型、工具列表、权限模式、斜杠命令、Skills、子 Agent 类型、MCP 服务器。我们的配置目录是空的，可还是有 16 个 Skill、5 种子 Agent——它们是 Claude Code 自带的。这个事件是了解一个版本有哪些能力最快的办法。
- **`system:hook_started` / `hook_response`**：钩子运行的前后。钩子不只是“在后台跑一下”，它的执行本身就是可观察的事件（第 7 章）。
- **`assistant`**：注意它的粒度——**一个内容块一个事件**。模型的一次回复里如果有一段文字和三个工具调用，事件流里就是四个 `assistant` 事件。第 5、6 行是同一次回复里并行的 Bash 和两个 Read。
- **`user`**：工具结果。名字叫 user，是因为在 Anthropic 的消息格式里，工具结果放在用户消息中（Learn Pi Agent 第 2 章）。
- **`system:thinking_tokens`**：模型思考期间的 token 计数，界面用它显示“正在思考”的进度。
- **`result`**：最后的总结：轮数、耗时（以及其中等待模型的时间）、被拒绝的工具调用、费用估算。注意 `total_cost_usd` 是按 Claude 的价格估算的，实验用的不是 Claude，这个数字没有意义。

## 会话文件

运行结束后，配置目录的 `projects/<项目路径>/` 下多了一个以会话 ID 命名的 `.jsonl` 文件，这就是 `claude --resume` 恢复会话时读取的东西（文档：[Manage sessions](https://code.claude.com/docs/en/sessions)）：

@lab node labs/ch01/transcript.ts

### 一棵树

除了几种元数据记录，每条记录都有 `uuid` 和 `parentUuid`，整个文件是一棵树——和 Learn Pi Agent 第 7 章 mox 的会话树是同一个设计。`last-prompt` 记录里的 `leafUuid` 指向当前的叶子，从叶子沿着 `parentUuid` 往回走，就得到当前分支上的完整对话。分支、回退（第 5 章）都建立在这棵树上。

### 每个内容块一条记录

助手的回复不是存成一条消息，而是**每个内容块一条记录**，用 `apiBlockIndex` 标明它在原回复里的位置。工具结果记录则用 `sourceToolAssistantUUID` 指回发起调用的那个块，还带着 `permissionDecision`：这次调用是怎么被允许的（这里是 `config`，来自命令行参数）。

为什么拆这么细？一个合理的推测是：流式输出时，每个块一完成就可以写盘，不必等整条回复结束——进程在回复中途崩溃，已经完成的块不会丢（Learn Pi Agent 第 18 章的问题）。

### 附件：注入的上下文也是记录

最有意思的是 `attachment` 记录。环境信息、模型信息、可用的 Skills 和子 Agent 列表、日期、剩余 token 的提醒……这些都不是用户说的话，也不是模型的回复，而是 Claude Code 在请求前**注入**的上下文。它们被记成树上的节点，并且标明了 `renderedRole`：以 `system` 还是 `user` 的身份进入请求（第 2 章会在请求里找到它们）。

这样做的好处是：**会话文件完整描述了模型看到过什么**。恢复会话时，不需要重新计算“当时注入了什么”——那可能已经变了（日期变了、Skills 改了）——直接按记录重建。代价是会话文件比纯对话大得多：这次运行 41 条记录里，真正的对话不到一半。

## 三种会话格式

同一个问题——“怎样把一次对话存下来，以后还能接着做”——三个 Agent 的答案：

| | mox（Learn Pi Agent 第 7 章） | Pi | Claude Code |
| --- | --- | --- | --- |
| 文件 | JSONL，只追加 | JSONL，只追加 | JSONL，只追加 |
| 结构 | 树：id / parentId | 树：id / parentId | 树：uuid / parentUuid |
| 当前位置 | 最后一条记录 | 最后一条记录 | `last-prompt` 记录的 leafUuid |
| 一条消息 | 一条记录 | 一条记录 | 每个内容块一条记录 |
| 注入的上下文 | 不记录（每次重新组装） | 自定义消息、系统提示小节的补丁 | `attachment` 记录，标明进入请求的身份 |
| 其他 | 压缩记录 | 压缩、标签、自定义数据 | 队列操作、费用状态等元数据 |

mox 的会话类：

@mox mox/src/session.ts#Session collapse=true

mox 只记录消息，系统提示每次运行时重新组装（Learn Pi Agent 第 6 章）；Claude Code 把注入的内容也记下来。前者简单，但恢复旧会话时，模型看到的上下文可能和当时不同；后者精确，但文件里混着大量“不是对话”的记录。

## 面试题

::: interview Claude Code（或任何 coding agent）的会话应该怎么持久化？
只追加的 JSONL：每条记录一行，写盘便宜，崩溃时最多丢最后一行。用 id / 父 id 组成树，支持分支和回退，用一个指针（或最后一条记录）表示当前位置。粒度可以细到每个内容块，流式输出时边生成边写。注入的上下文（环境、可用工具、提醒）是否记录，决定了恢复时能否精确重现模型当时看到的内容。再加上压缩记录、元数据，并且读取时要容忍半行的损坏数据。
:::

::: interview -p 模式的事件流里有哪些信息？可以用来做什么？
开始时的 init（模型、工具、权限模式、可用的命令、Skills、子 Agent、MCP 服务器），每个内容块一个 assistant 事件，工具结果，钩子执行，思考进度，最后的 result（轮数、耗时、被拒绝的调用、用量）。可以用来在 CI 里监控 Agent 的行为、统计成本和耗时、检测被拒绝的操作、做评测时提取轨迹；init 事件本身也是了解一个版本有哪些能力最快的方法。
:::
