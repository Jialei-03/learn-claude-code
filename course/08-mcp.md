---
motto: 工具一多，问题就从“能不能调用”变成“要不要一开始就告诉模型”。
learn:
  - 在 Claude Code 和 MCP 服务器之间放一个窃听器：握手、列工具、调用、列表变化
  - MCP 工具进入请求的样子：名字、描述、服务器说明各放在哪里
  - 结果的处理：structuredContent 优先、太长存成文件、空的错误
  - 工具列表中途变化时，请求和缓存怎么变
  - 工具搜索：推迟加载的工具、ToolSearch 和 tool_reference
  - 和 Pi、mox 的 MCP 接入逐项对照
prereq: 第 2、6 章；Learn Pi Agent 第 12 章
time: 50 分钟
build: labs/ch08 —— 一个 JSON-RPC 窃听器，两次录制（工具全部预先加载、工具搜索），以及它们的分析
---

## 接上同一个服务器

Learn Pi Agent 第 12 章手写了一个假的 issue 系统作为 MCP 服务器：搜索、新建、慢慢数数、吐出一大段日志、总是失败、开启管理工具（会发出工具列表变化的通知）……这一章把它接到 Claude Code 上。

为了看到 Claude Code 和服务器之间说了什么，在两者之间夹一个“窃听器”：它原样转发两个方向的每一行，同时把 JSON-RPC 消息记下来。

@code labs/ch08/mcp-tap.mjs

实验配置通过 `--mcp-config` 传入（第 0 章的 `--strict-mcp-config` 保证只用这一个服务器）：

@code labs/ch08/record.ts collapse=true

## 线路上说了什么

第一次录制让模型按顺序调用五个工具。窃听器记下的全部消息：

@lab node labs/ch08/mcp.ts wire

- **先试探新协议。** Claude Code 第一条消息是 `server/discover`，带着一个比服务器支持的更新的协议版本；服务器回答“没有这个方法”，它就退回到标准的 `initialize`。对新旧服务器都能工作的客户端，就是这样一边试探一边降级的。
- **客户端声明了两种能力**：`roots`（告诉服务器工作目录在哪里）和 `elicitation`（服务器可以反过来向用户要信息）。
- **每次 `tools/call` 都带着 `_meta`**：Claude Code 内部的工具调用 id，和一个 `progressToken`（服务器可以凭它报告进度）。
- **工具列表会变。** `enable_admin_tools` 执行时，服务器先发出 `notifications/tools/list_changed`，Claude Code 立刻重新调用 `tools/list`，拿到 9 个工具。

这和 Learn Pi Agent 第 12 章 mox 的客户端是同一套协议，区别在细节：mox 不做新协议的试探，握手时声明的能力是空的。

## MCP 工具在请求里的样子

在截下的请求里，8 个 MCP 工具和 20 个内置工具并列在 `tools` 里，名字是 `mcp__issues__search_issues` 这样的格式（`mcp__服务器__工具`），描述就是服务器给的原文，没有加任何前缀。服务器的 `instructions`（“新建 issue 之前先用 search_issues 查重”）放在第 1 条消息——环境信息的那条 system 消息里（录制时把这句话当作金丝雀，在请求里找到了它的位置）。文档给出的长度上限是：服务器说明和预先加载的工具描述最多 4096 个字符，超过会被截断（[Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)）。

### 五次调用

@lab node labs/ch08/mcp.ts calls

- **`search_issues`：模型看到的是 JSON。** 服务器同时返回了文本（`#41 [open] …`）和 `structuredContent`，Claude Code 交给模型的是后者。录制里的金丝雀 `#42 [open]` 从未出现在任何请求中。Pi 的做法相反：有文本就用文本，只有 `structuredContent` 时才把它序列化成 JSON（Learn Pi Agent 第 12 章）。
- **`create-issue`：要问用户。** 允许规则里只写了另外四个工具。MCP 工具的权限和内置工具一样按名字匹配，规则可以写到单个工具，也可以写 `mcp__issues` 放行整个服务器。服务器自己标的 `readOnlyHint` 不会让 Claude Code 跳过确认——注解是服务器自己声称的。
- **`dump_log`：十二万个字符，存成文件。** 模型拿到的不是日志，而是一句说明：结果有多少字符、多少行，超过了上限，完整内容存在会话目录下的哪个文件里。模型随即用 Read 读了那个文件的末尾——和第 3 章 Bash 的大输出处理是同一个思路。文档的说法是：超过 1 万个 token 警告，默认上限 2.5 万个 token（`MAX_MCP_OUTPUT_TOKENS`），超过 5 万个字符的文本结果存成文件。Pi 的做法是保留开头和结尾、去掉中间。
- **`fail`：服务器返回了一个没有任何内容的错误**，模型看到的是 “Unknown error”。和 Pi 一样，不让模型面对一个空结果。

## 工具列表中途变化

`enable_admin_tools` 之后，下一个请求的工具列表多了一个：

@lab node labs/ch08/mcp.ts change

新工具 `delete_issue` 按名字排序插进了列表的**中间**。第 2 章讲过，工具定义排在请求的最前面，缓存按前缀匹配：插入点之前的部分还能命中，之后的全部失效。第 4 个请求只读到了一万三千个 token 的缓存，比上一个请求少了三千多——这就是工具列表变化的代价。

请求的 `anthropic-beta` 里有 `mid-conversation-tool-changes`（第 2 章）。Pi 1.5 的做法是把新工具作为对话里的事件追加在末尾，开头保持不变（Learn Pi Agent 第 12 章）；这次录制里的 Claude Code 则是直接改写了 `tools` 数组。

## 工具搜索

工具一多，每个请求都要带着所有定义。文档说工具搜索默认开启：MCP 工具推迟加载，需要时再找。但这个版本在 `ANTHROPIC_BASE_URL` 指向网关时默认不开（v2.1.304 起才默认开启，因为网关要能转发相关的字段），所以上面的录制里工具是全部预先加载的。第二次录制设置 `ENABLE_TOOL_SEARCH=true`，问一个不点名工具的问题：

@lab node labs/ch08/mcp.ts search

- **推迟的不只是 MCP 工具。** 18 个工具从请求里消失了：8 个 MCP 工具，还有 10 个不常用的内置工具（定时任务、工作树、网页抓取……）。第一个请求的输入从约 1.6 万个 token 降到约 1.06 万个，少了三分之一。
- **名字还在。** 被推迟的工具名字列在环境信息那条 system 消息里——它比默认模式下长了五百多个字符。模型知道有哪些工具存在，只是看不到它们的参数。
- **ToolSearch 返回的不是定义，而是引用。** 模型直接用 `select:` 加上工具名调用 ToolSearch，得到一个 `tool_reference` 块。下一个请求的 `tools` 里出现了这个工具的完整定义，标着 `defer_loading`，由模型服务把引用展开成可用的工具。
- **`DeferredToolPlaceholder`**：一个标着 `defer_loading` 的占位工具，文档提到即使所有工具都预先加载，请求里也可能有这样一个占位条目。

对照 Pi（Learn Pi Agent 第 12 章）：

| | Claude Code | Pi |
| --- | --- | --- |
| 推迟的范围 | MCP 工具和不常用的内置工具 | 按服务器配置：direct、deferred、codemode、hidden |
| 模型怎么知道有哪些工具 | 环境信息里列出名字 | 系统提示里列出服务器 |
| 怎么找 | ToolSearch：`select:名字` 直接选，或关键词搜索 | tool_search：BM25 关键词搜索 |
| 找到之后 | 返回 `tool_reference`，模型服务展开成定义 | 把匹配的工具加进可用列表，记成对话里的事件 |
| 组合多个调用 | 这两次实验里没有看到对应的机制，每个结果都回到上下文 | codemode：模型写脚本调用工具 |

`tool_reference` 是 Anthropic API 的功能：工具定义随请求发送但标为推迟，只有被引用时才真正进入模型的上下文。Pi 支持多家模型服务，只能在客户端自己管理“哪些工具现在可用”。

## 面试题

::: interview MCP 工具多了以后会有什么问题？怎么解决？
每个工具定义在每次请求里都要发送：几百个工具可能占掉几万个 token，用户还没开口；工具多了模型也更容易选错。解决思路是渐进式披露：一开始只告诉模型工具的名字或服务器的说明，用一个搜索工具按需加载定义（Claude Code 的 ToolSearch、Pi 的 tool_search）；更进一步可以让模型写脚本组合调用，只把结果交回上下文（Pi 的 codemode）。注意动态加载也有代价：工具列表变化会让缓存从变化点开始失效，所以新工具最好追加在后面而不是插在中间。
:::

::: interview MCP 工具返回了十几万字符的结果，客户端应该怎么处理？
不能直接塞进上下文。Claude Code 的做法：超过上限就把完整结果存成文件，告诉模型字符数、行数和文件路径，模型再分段读或搜索；Pi 的做法：保留开头和结尾、去掉中间，完整内容存进临时文件。两种都遵循“不把大输出塞进上下文，但让模型知道完整内容在哪里”。上限要可以配置，服务器也可以为自己的工具声明更大的上限。
:::

::: interview MCP 服务器给工具标了 readOnlyHint，客户端可以据此自动放行吗？
不应该据此放宽安全限制。注解是服务器自己声称的，一个恶意或有缺陷的服务器完全可以把破坏性的工具标成只读。Claude Code 的实验里，标了注解的工具照样按权限规则判断，没有规则就要问用户。注解适合用来改进体验（比如给只读工具更少的打扰、在界面上标出危险操作），放行要靠用户写的规则。
:::

::: interview 一个 MCP 客户端要处理哪些协议细节？
握手（协议版本协商、能力声明，Claude Code 还会先试探新版协议再降级）；工具列表的分页和变化通知（`list_changed` 后重新获取）；调用时的进度令牌和取消；结果的转换（文本、结构化内容、错误、空结果、超长结果）；服务器的说明怎样交给模型；子进程的生命周期（启动超时、崩溃、退出时清理进程组）；以及 stdout 只能用于协议、日志只能写 stderr 这类约定。
:::
