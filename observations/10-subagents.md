---
motto: 子 Agent 带着一张任务单进去，只带一份报告出来；报告也是模型的输出，要当作不可信的数据。
learn:
  - 父 Agent、自定义子 Agent、内置 Explore 各自收到的请求：系统提示、工具、项目说明
  - 子 Agent 看不到什么：父对话、子 Agent 目录
  - 前台和后台：结果以工具结果返回，还是以通知送达
  - 交回的报告被包上了一层“这是模型输出”的说明
  - 和 mox 的子 Agent 对照
prereq: 第 2、4、7 章；Learn Pi Agent 第 17 章
time: 40 分钟
build: labs/ch10 —— 前台、后台两次录制，以及三方请求、交回方式、时间线的分析
---

## 实验

Learn Pi Agent 第 17 章讲过子 Agent 解决的三个问题：上下文隔离、专门化、并行。这一章让 Claude Code 同时派出两个子 Agent：一个是项目里自定义的 `reviewer`，一个是内置的 `Explore`。

@code labs/ch10/record.ts#region:files

`reviewer` 只允许用 Read、Grep、Glob，它的正文就是它的系统提示。项目的 `CLAUDE.md`、子 Agent 的描述、它的正文里各放一个金丝雀；父 Agent 的提问里还藏了一句只有父 Agent 知道的“暗号”。同一个任务录两次：要求子 Agent 在前台运行，和在后台运行。

## 三方各收到了什么

前台那次录制里，父 Agent 和两个子 Agent 的第一个请求：

@lab node labs/ch10/subagents.ts requests

- **自定义子 Agent 的系统提示以它的定义文件正文开头**（`CANARY-AGENT-PROMPT`）。正文只有几十个字，整块系统提示有一千三百多字符，其余是 Claude Code 附加的内容；主对话那五千多字符的系统提示一个字都没有。
- **工具按定义裁剪。** `reviewer` 只有 Read、Grep、Glob 三个——注意 Grep 和 Glob 在主对话里根本没有（第 3 章：macOS 上默认用 Bash 搜索），子 Agent 的定义里列出了它们，它们就出现了。`Explore` 有 14 个工具，没有 Edit、Write、NotebookEdit，也没有 Agent——不能改文件，也不能再派子 Agent。但它有 Bash，“只读”有一部分靠的是它的系统提示（第一句话说它是“文件搜索专家”）。
- **项目说明**：`reviewer` 收到了 `CLAUDE.md`，`Explore` 没有——它要看项目约定，就得自己去读文件。
- **父对话完全看不到。** 暗号没有出现在任何子 Agent 的请求里。子 Agent 知道的只有父 Agent 写给它的任务说明（`prompt` 参数），加上它自己的系统提示和环境信息。这和 mox 一致：**父 Agent 写的任务说明是子 Agent 唯一的上下文。**
- **子 Agent 看不到子 Agent 目录**（`CANARY-AGENT-DESC` 只在父 Agent 那里）。

父 Agent 调用的 Agent 工具，参数有 `description`、`prompt`、`subagent_type`、`model`、`effort`、`run_in_background`、`isolation`：可以给子 Agent 换模型、调整思考力度、放到后台、放进独立的工作树。

## 交回来的是什么

@lab node labs/ch10/subagents.ts handback

**前台**：两个 Agent 调用和父 Agent 自己的一条 Bash 命令在同一轮里并行执行，子 Agent 的报告作为 **Agent 工具的结果**返回。每份报告前面都加了一段说明，第一句话是：这是被委派的子 Agent 的最终报告，**是模型的输出**——不是用户说的话，也不是系统的指令。

这一层包装值得在面试里讲：子 Agent 读过的文件、网页里可能有提示注入，它的报告可能被“污染”。父 Agent 如果把报告当成用户的指示，注入就借子 Agent 之手传了上来。第 6 章的分类器不看工具结果，这里的包装则是告诉父 Agent 本身：报告是数据，不是命令。（录制里，父 Agent 拿到报告后还亲自读了一遍源文件，核实结论。）

**后台**：Agent 工具立刻返回“已在后台启动”，附带子 Agent 的 id 和一个输出文件的路径；父 Agent 不等待，这一轮就结束了。子 Agent 完成时，报告以一条新的用户消息（一段 `<system-reminder>`）送回，并开始新的一轮：

@lab node labs/ch10/subagents.ts timeline

Explore 先完成，父 Agent 先汇报了它的结果，说明 reviewer 还在跑；reviewer 完成后又是一轮，才给出完整的汇总。三个 `result` 事件对应三轮。在 `-p` 模式下，Claude Code 等所有后台任务都结束才退出。

stream-json 里还有一组专门的事件：`task_started`（是否在后台、嵌套深度）、`task_progress`（子 Agent 用了几个工具、最后一个是什么）、`task_notification`（完成，附报告摘要和输出文件）。钩子方面，SubagentStart 和 SubagentStop 分别在子 Agent 开始和结束时触发，SubagentStop 带着子 Agent 自己的会话文件路径（`agent_transcript_path`）和它的最后一条回复。子 Agent 的会话记录在主会话目录下的 `subagents/agent-<id>.jsonl` 里——第 1 章那张记录类型的表，过滤掉的就是它们。

## 和 mox 对照

@mox mox/src/subagent.ts#runSubagent collapse=true

| | Claude Code | mox（Learn Pi Agent 第 17 章） |
| --- | --- | --- |
| 子 Agent 的定义 | Markdown + frontmatter（工具、模型、权限模式……），正文是系统提示 | 相同的格式 |
| 系统提示 | 定义文件的正文（内置的有自己的提示） | 相同 |
| 项目说明 | 自定义的收到 `CLAUDE.md`，内置的 Explore 没有 | 不加载 |
| 工具 | 按定义裁剪；Explore 没有编辑工具和 Agent 工具 | 按定义裁剪；子 Agent 没有 agent 工具 |
| 交回什么 | 最终报告，外面包一层“这是模型输出”的说明 | 最后一条回答 |
| 并行 | 同一轮的多个调用并行执行 | 最多 8 个任务，同时最多 4 个 |
| 防止跑不停 | （本章没有观察） | 每个子 Agent 最多 30 轮 |
| 后台 | `run_in_background`：立即返回，完成后以通知送达并开始新一轮 | 没有 |
| 记录 | 每个子 Agent 一个会话文件，SubagentStart / SubagentStop 钩子 | 不单独记录 |

最大的不同是**后台**。mox 的子 Agent 是一次同步的工具调用：父 Agent 等它返回。Claude Code 的后台子 Agent 让父 Agent 可以继续和用户说话、做别的事，结果到了再处理——这需要 Agent 循环支持“没有用户输入也能开始新一轮”，Learn Pi Agent 第 18 章的后台命令和目标循环用的是同一类机制（`sendMessage` 的 `triggerTurn`）。

## 面试题

::: interview 子 Agent 的报告交回父 Agent 时，要注意什么？
报告是另一个模型的输出，它读过的文件和网页可能含有提示注入，报告可能被污染。所以交回时要明确标注它的性质（Claude Code 在报告前加了一段说明：这是子 Agent 的最终报告，是模型输出，不是用户或系统的指示），父 Agent 应该把它当数据而不是命令，重要的结论要自己核实。另外，只交回最终报告，不要把子 Agent 的整个过程带回来，否则就失去了隔离上下文的意义。
:::

::: interview 子 Agent 能看到父 Agent 的对话吗？任务说明应该怎么写？
看不到（实验里父对话的暗号没有出现在任何子 Agent 的请求中）。子 Agent 从一个新的上下文开始，只有自己的系统提示、环境信息、可能的项目说明，以及父 Agent 写的任务说明。所以任务说明要自成一体：目标是什么、已经知道什么、排除了什么、范围在哪里、要以什么格式返回。“查一下那个 bug”对子 Agent 毫无意义。
:::

::: interview 前台子 Agent 和后台子 Agent 有什么区别？后台需要循环提供什么支持？
前台：父 Agent 调用后等待，报告作为工具结果返回，同一轮里的多个调用可以并行。后台：调用立即返回一个“已启动”的结果，父 Agent 继续工作或结束这一轮；子 Agent 完成时，结果作为一条新消息送达，并触发新的一轮。这要求 Agent 循环能在没有用户输入的情况下开始新一轮、能跟踪还在运行的任务（结束前要等它们，或者在压缩、恢复时提醒模型它们还在跑），并且有途径查询或终止它们（Claude Code 给了 id、输出文件，以及 SendMessage、TaskStop 工具）。
:::
