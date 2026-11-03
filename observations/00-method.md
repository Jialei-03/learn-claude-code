## 2.1.296 实验环境记录

## 实验环境

### 用开放模型驱动 Claude Code

Claude Code 支持通过 `ANTHROPIC_BASE_URL` 把请求发到任何兼容 Anthropic Messages 接口的服务（这是官方文档里的“LLM 网关”用法）。本课的实验用一个中转服务提供的开放模型（MiniMax-M3.1-Flash），原因很简单：便宜，而且实验要跑很多次。

这意味着：**我们研究的是 Claude Code 这个“驾驭层”**（它发什么请求、怎样执行工具、何时触发钩子、怎样管理会话），而不是 Claude 这个模型。凡是由驾驭层决定的行为，换了模型也一样；凡是由模型决定的行为（先读哪个文件、要不要验证），实验结果只代表这个模型。每一章会标明是哪一种。

### 完全隔离

实验不能碰你自己的 Claude Code 配置，你的配置也不能影响实验结果：

- `CLAUDE_CONFIG_DIR` 指向一个临时目录：不读你的 `~/.claude`（用户级的 CLAUDE.md、设置、记忆、Skills 都不会混进来），会话文件也写在那里；
- 子进程只带必要的环境变量：模型服务的地址和密钥。从 Claude Code 的终端里运行实验时，环境里有几十个它自己的变量（认证、会话相关），继承下来会让子进程的行为莫名其妙——本课在搭建时就踩过这个坑；
- `--settings` 指定一个临时的设置文件，`--strict-mcp-config` 不加载任何 MCP 配置。

@code lab/cc.ts#runClaude collapse=true

### 截下请求：记录代理

`ANTHROPIC_BASE_URL` 没有直接指向模型服务，而是指向本机的一个小代理。代理把请求原样转发，同时把请求和响应记下来：

@code lab/proxy.ts#startProxy collapse=true

这是研究任何网络程序的标准做法：看的是你自己电脑上的网络流量。

### 记下事件：钩子记录器

每个钩子事件都挂上同一个记录器，它把 Claude Code 交给钩子的 JSON 原样追加到一个文件里，不做任何干预：

@code lab/hook-logger.mjs

### 记录里不保存什么

截下的请求里有 Claude Code 的系统提示和工具描述——那是 Anthropic 写的文字，有版权。研究它的**结构**（有几块、多长、有哪些小节、缓存断点在哪、每个工具有哪些参数）是这门课需要的；把原文保存下来、发布出去则不是。所以实验记录只保存结构摘要，原文最多引用一行；事件和会话记录里过长的字符串也被截断：

@code lab/derive.ts#summarizeRequest collapse=true

### 后面几章还会用到的工具

| 手段 | 回答什么 | 第一次出现 |
| --- | --- | --- |
| **金丝雀字符串** | 某段内容（一个说明文件、一个 Skill 的正文、一段钩子输出）最终出现在请求的哪里，或者有没有出现 | 第 4 章 |
| **内容指纹** | 两次请求的某一部分是否逐字相同（只比较哈希，不保存内容） | 第 2 章 |
| **工具调用 id 的末尾几位** | 并行的调用和结果谁对应谁 | 第 3 章 |
| **窃听器** | 夹在 Claude Code 和另一个进程之间，原样转发并记下每一行：MCP 服务器（第 8 章）、Agent SDK（第 12 章） | 第 8 章 |
| **小窗口** | 把 Claude Code 假设的上下文窗口调小，让自动压缩在几分钟内发生 | 第 5 章 |

Anthropic 自己的文档也推荐了记录代理这个办法：SDK 的消息流里看不到系统提醒，想知道模型实际收到了什么，就把 `ANTHROPIC_BASE_URL` 指向一个记录请求的代理（[Modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)）。

## 一次实验长什么样

每一章的实验分两步：

1. **录制**（`labs/chNN/record.ts`）：调用 `runClaude`，让真实的 Claude Code 完成一个任务，把结果保存到 `labs/chNN/recorded/`。这一步需要模型服务和一点费用，网站构建时不运行。
2. **分析**（`labs/chNN/*.ts` 里的其他脚本）：读取录制下来的文件，整理成表格。这一步离线、确定，网站构建时真正运行，页面上的表格都是它的输出。

想复现或者在新版本上重做，设置三个环境变量后运行录制脚本：

```bash
export LCC_BASE_URL=https://你的服务        # 兼容 Anthropic Messages 接口
export LCC_API_KEY=...
export LCC_MODEL=...
node labs/ch01/record.ts
```

::: warn 结论的边界
实验观察到的是**一个版本**的 Claude Code、**一个模型**、**一次或几次运行**。驾驭层的行为（请求的结构、钩子的数据、会话文件的格式）很稳定，可以放心引用；模型的行为（调用了哪些工具、顺序如何）只是一个例子。Claude Code 更新后，部分细节可能改变——这也是为什么每个结论都配着可以重新运行的实验。
:::
