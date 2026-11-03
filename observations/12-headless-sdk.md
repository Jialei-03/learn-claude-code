---
motto: SDK 不是另一个 Agent，而是同一个 Claude Code 进程，加上一条双向的协议。
learn:
  - 用 Agent SDK 驱动 Claude Code，并窃听 SDK 和 Claude Code 进程之间的每一行消息
  - 这条协议的两个方向：事件流出去，审批、钩子、MCP 的“回调请求”进来
  - 审批回调的拒绝理由会交给模型：它是一条反馈通道
  - 读开源的 Python 版 SDK：同一套协议在宿主程序一侧是怎么实现的
  - SDK 默认不用 Claude Code 的系统提示：同一个进程，两种默认
  - 和 mox 的 RPC 模式对照：单向的命令和事件，还是双向的回调
prereq: 第 1、6、7、8 章；Learn Pi Agent 第 19 章
time: 45 分钟
build: labs/ch12 —— 一个冒充 Claude Code 可执行文件的窃听器、一次 SDK 运行的录制、协议分析，以及和 Python 版 SDK 源码的对照
---

## 把 Claude Code 当部件

前面所有的实验都用 `claude -p ... --output-format stream-json`：一次性的任务，事件流从 stdout 出来（第 1 章）。要把 Claude Code 嵌进自己的程序——一个审批界面、一个 CI 任务、一个聊天机器人——还需要反方向的通道：程序要能回答“这个调用可以执行吗”，要能提供自己的工具和钩子。这就是 Agent SDK（[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)）。

SDK 怎样和 Claude Code 通信？SDK 有一个选项 `pathToClaudeCodeExecutable`，指定要启动的 Claude Code 可执行文件。把它指向一个“冒充者”：启动真正的 `claude`，原样转发 stdin 和 stdout，同时把每一行记下来——和第 8 章窃听 MCP 是同一个办法。

@code labs/ch12/cli-tap.mjs

SDK 的版本选的是和本课的 Claude Code 配套的 0.3.296（它的 `package.json` 写明了对应的 Claude Code 版本 2.1.296）。实验在 SDK 里注册三样东西：一个审批回调 `canUseTool`（拒绝 `rm -rf`，其余放行）、一个 PreToolUse 钩子（就是一个 JS 函数），和一个在 SDK 进程里运行的 MCP 工具 `lookup_ticket`：

@code labs/ch12/record.ts#region:sdk

## 启动和握手

@lab node labs/ch12/sdk.ts argv

- **SDK 启动的就是 `claude` 命令**，参数和本课的实验几乎一样：stream-json 的输出、`--verbose`。不同之处有三个：`--input-format stream-json`（提问也从 stdin 用 JSON 送进去，于是可以连续对话）、`--permission-prompt-tool=stdio`（要问用户的时候，通过 stdio 问 SDK），以及没有 `-p`。
- **第一条消息是 `initialize`**：SDK 告诉 Claude Code 它注册了哪些钩子（只有一个回调 id，函数本身留在 SDK 里）、哪些进程内的 MCP 服务器（连工具清单都提前带上了），以及系统提示。Claude Code 回答可用的命令、子 Agent、模型、当前的权限模式等等。
- 然后才是用户的提问——一条 `{"type":"user", ...}`，和 stream-json 输出里的用户消息是同一个格式。

## 协议的两个方向

整次运行，按方向和类型统计：

@lab node labs/ch12/sdk.ts protocol

**Claude Code → SDK** 有两类消息。一类是第 1 章就见过的事件流：`system`、`assistant`、`user`、`result`，外加 `session_state_changed`。另一类是 **`control_request`——Claude Code 反过来向 SDK 提问**：

- `can_use_tool`：这个调用按权限规则需要用户批准（第 6 章的“要问用户”），现在改为问 SDK 的回调。请求里带着工具名、参数、给界面用的显示名和描述、“以后都允许”的规则建议。
- `hook_callback`：触发了 SDK 注册的钩子。请求里只有回调 id 和钩子的输入（和第 7 章命令式钩子收到的 JSON 相同）；SDK 找到对应的函数执行，把结果作为 `control_response` 送回。
- `mcp_message`：模型调用了进程内 MCP 服务器的工具。Claude Code 把那条 JSON-RPC 的 `tools/call` 原样转交给 SDK，SDK 在自己的进程里执行，把 JSON-RPC 的结果送回——MCP 协议被装进了这条通道里，不需要单独的子进程。

**SDK → Claude Code** 则是 `initialize`、用户消息，以及对每个 `control_request` 的回答。

这是一个**双向的 RPC**：两边都可以发起请求，用 `request_id` 配对回答。命令式钩子要启动一个子进程、通过 stdin 和退出码通信；SDK 的钩子只是一次函数调用，可以直接访问应用程序的状态。

## 回调做了什么

SDK 一侧，每个回调被调用的顺序：

@lab node labs/ch12/sdk.ts callbacks

- **钩子先于审批**（第 6 章的顺序）：每个调用都先触发 PreToolUse 钩子，需要批准的才接着问 `canUseTool`。只读的 Bash 命令（第 4、5 行）没有问。
- **MCP 工具的执行发生在 SDK 进程里**（第 3 行），在审批之后。
- **拒绝理由会交给模型。** 第 9 行，回调拒绝了 `rm -rf`，理由是“请改用 rm -r 并逐个确认”。模型接下来先删了文件，再删空目录——都被放行了。`canUseTool` 不只是一个“是/否”的开关，它的 `message` 是写给模型的反馈；回答 `allow` 时还可以带上 `updatedInput` 改写参数。这和第 7 章钩子的拒绝理由、改写参数是同一种能力，只是换成了应用程序的代码来做。

## 读源码：Python 版 SDK

录制用的 TypeScript 版 SDK 没有开源许可，但 Python 版 SDK（`claude-agent-sdk-python`）是 MIT 许可的开源项目，它实现的是同一套协议。这里固定在 v0.2.165：它捆绑的 Claude Code 是 2.1.294，和本课观察的 2.1.296 只差两个小版本（没有正好捆绑 2.1.296 的版本）。先拿录制和它的源码对照：

@lab node labs/ch12/sdk.ts source

请求的类型完全一致；`hook_callback` 的字段一个不差；`can_use_tool` 里 Python 版读取的字段比这次录到的多几个（`agent_id`、`decision_reason`、`title`），它们只在特定的场景才出现——比如请求来自子 Agent。两边的差别在一些细节上：TypeScript 版在回答里多带了一个 `toolUseID`，不设系统提示时的表达方式也不同（下文）。

**启动。** 和录制里看到的参数一样，固定先写 stream-json 输出和 `--verbose`；没有设置系统提示时，加上 `--system-prompt ""`——这就是 SDK“默认没有系统提示”在命令行上的样子：

@oss agent-sdk-python src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L570-L589

传了审批回调，就把权限提示交给 stdio：

@oss agent-sdk-python src/claude_agent_sdk/types.py#_configure_can_use_tool collapse=true

**握手。** `initialize` 把每个钩子函数登记成一个 `hook_N` 的回调 id，函数本身留在 SDK 进程里，发出去的只有 id 和匹配条件——录制里的 `{"hookCallbackIds":["hook_0"]}` 就是这样来的：

@oss agent-sdk-python src/claude_agent_sdk/_internal/query.py#initialize collapse=true

**发请求、等回答。** SDK 主动发起的请求（`initialize`、中断、切换模式……）生成一个 `request_id`，然后等待带着同一个 id 的 `control_response`，超时就报错：

@oss agent-sdk-python src/claude_agent_sdk/_internal/query.py#_send_control_request collapse=true

**读消息、分流。** 从 Claude Code 的 stdout 读到的每一行，按类型分成三路：对自己请求的回答（唤醒等待者），对方的请求（交给处理函数，并发执行），以及普通的事件（交给使用者）：

@oss agent-sdk-python src/claude_agent_sdk/_internal/query.py#L397-L418

**回答对方的请求。** 整个协议的核心就是这一个函数：`can_use_tool` 调用审批回调，把结果转换成 `behavior` 加 `updatedInput` 或 `message`；`hook_callback` 按 id 找到钩子函数执行；`mcp_message` 把 JSON-RPC 消息交给进程内的 MCP 服务器。出错时回答 `error`，而不是让 Claude Code 一直等下去：

@oss agent-sdk-python src/claude_agent_sdk/_internal/query.py#_handle_control_request collapse=true

读完会发现，这套协议没有任何魔法：每行一个 JSON，两边都能发请求，用 id 配对，所有“回调”都是跨进程的请求和回答。Learn Pi Agent 第 19 章给 mox 写的 RPC 模式，只要再加上“mox 向客户端发请求、等回答”这一个方向，就能支持同样的审批和钩子。

## 同一个进程，两种默认

SDK 会话的第一个请求，和 `claude -p` 的比较：

@lab node labs/ch12/sdk.ts prompt

- **系统提示只剩两行**：计费信息和身份声明，Claude Code 那五千多字符的主体不见了。这不是实验的偶然：文档（[Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)）写明，不设置 `systemPrompt` 时 SDK 使用“只覆盖工具调用的最小提示”，**不包括 Claude Code 预设里的安全指引**，这和 `claude -p` 默认使用完整的系统提示不同；要和命令行一致，设置 `systemPrompt: { type: "preset", preset: "claude_code" }`。
- **环境信息、工具定义照旧**：第 2 章说过，大部分行为规则写在工具描述里，所以即使没有系统提示，工具怎么用模型还是知道的。
- **多了三个工具**：`AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`——有了审批通道，就可以向“用户”提问、进出计划模式了；`-p` 没有这条通道，这些工具也就不提供。进程内 MCP 工具是预先加载的，没有被推迟（第 8 章）。

这个默认值的含义值得面试时讲清楚：SDK 面向的是“各种各样的 Agent”，不一定是编程助手，不一定有人在旁边看着，所以默认给一张白纸，由开发者写自己的系统提示；代价是开发者要自己补上安全方面的指引。文档还提到一个和本课方法一致的建议：SDK 的消息流里看不到系统提醒，要知道模型实际收到了什么，**把 `ANTHROPIC_BASE_URL` 指向一个记录请求的代理**——这正是本课从第 0 章开始的做法。

## 和 mox 的 RPC 模式对照

Learn Pi Agent 第 19 章为 mox 写了 `--mode json` 和 `--mode rpc`：

| | Claude Code + Agent SDK | mox `--mode rpc`（Learn Pi Agent 第 19 章） |
| --- | --- | --- |
| 传输 | stdin / stdout，每行一条 JSON | 相同 |
| 输入 | 用户消息；`control_request`（本次录制里是 initialize，SDK 的中断、切换权限模式等也走这条路） | 命令：prompt、abort、get_state、get_messages |
| 输出 | 事件流；`control_request`（can_use_tool、hook_callback、mcp_message） | 事件流；命令的回答 |
| 审批 | `can_use_tool` 回调，可以拒绝并说明理由、改写参数 | 没有确认通道：要问的一律拒绝（第 6 章） |
| 钩子 | 可以是 SDK 进程里的函数 | 只能是命令式钩子（扩展） |
| 自定义工具 | 进程内 MCP 服务器，经由同一条通道 | 扩展（在 mox 进程里） |
| 方向 | **双向**：两边都能发起请求 | 单向：客户端发命令，mox 发事件 |

差别在于“谁可以先开口”。mox 的 RPC 是一个经典的“命令—事件”接口：客户端控制 Agent，Agent 报告进展。Claude Code 的 SDK 协议让 Agent 也能在运行中向宿主程序提问——审批、钩子、工具执行都变成了跨进程的回调。要让 mox 在 RPC 模式下也能确认危险操作，需要的正是这样一个反向请求（`ExtensionContext.select` 目前只在交互模式下接上了，第 6 章的对照表里提过）。

## 面试题

::: interview Agent SDK 和 CLI 是什么关系？宿主程序的回调是怎么被调用的？
SDK 启动的就是 Claude Code 命令行进程，用 stdin/stdout 上逐行的 JSON 通信：用户消息和事件流在两个方向上流动；此外两边都可以发 `control_request`，用 `request_id` 配对回答。SDK 在握手时注册钩子回调的 id 和进程内 MCP 服务器；运行中 Claude Code 遇到需要批准的调用、触发了 SDK 的钩子、模型调用了进程内的 MCP 工具时，就发一个 `can_use_tool`、`hook_callback`、`mcp_message` 请求，SDK 执行对应的函数后回答。所以 SDK 的回调是跨进程的 RPC，不是同一个进程里的函数调用。
:::

::: interview 用 SDK 做一个审批界面，审批回调除了“允许/拒绝”还应该提供什么？
拒绝时的理由（会交给模型，告诉它该怎么换一种做法——实验里模型按理由改用了更安全的命令）；允许时可以改写参数（比如把路径限制在某个目录里）；可以返回“以后都允许”的规则建议，让用户一次批准一类调用；界面需要的信息（工具的显示名、描述、关键参数）也要随请求一起给出。还要考虑超时和中断：用户迟迟不回答时怎么办。
:::

::: interview 为什么 SDK 默认不使用 Claude Code 的系统提示？这会带来什么风险？
SDK 面向各种各样的 Agent，不一定是编程助手、不一定有人在旁边看着，Claude Code 那套面向终端编程的提示可能和产品的需求冲突，所以默认给一个只覆盖工具调用的最小提示，让开发者自己写。风险是安全指引也一起没了（文档明确提到），开发者要自己补上，或者使用 `claude_code` 预设再追加自己的说明。另一个容易忽略的点：项目说明、环境信息、钩子输出等是以系统提醒的形式放在对话里的，它们不受系统提示设置的影响，用自定义提示时最好告诉模型这些提醒来自应用程序而不是用户。
:::
