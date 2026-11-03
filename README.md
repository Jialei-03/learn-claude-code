# Learn Claude Code

**拆开 Claude Code：不看源码，看它做了什么。**

Claude Code 是闭源的。这门课不读它的源码（也不用网上流传的 sourcemap），而是用三类证据研究它的工程设计：

- **官方文档**：它承诺了什么行为，每个说法都给出链接；
- **可观察的接口**：`-p` 模式的事件流、钩子收到的数据、会话文件；
- **网络请求**：把 `ANTHROPIC_BASE_URL` 指向一个本地记录代理，截下它发给模型的每一个请求；
- **开源组件的源码**：Claude Code 的沙箱运行时 [sandbox-runtime](https://github.com/anthropics/sandbox-runtime)（Apache-2.0）和 [Python 版 Agent SDK](https://github.com/anthropics/claude-agent-sdk-python)（MIT）是 Anthropic 以开源许可发布的，课程固定版本摘录，并和录制逐项核对。

再和开源的 [Pi](https://github.com/earendil-works/pi)、以及你在 [Learn Pi Agent](https://github.com/Jialei-03/learn-pi-agent) 里亲手写的 mox 逐项对照。每一章都有可重复的实验、用真实模型录制的运行记录和面试题。

## 学到什么

| 章 | 内容 |
| --- | --- |
| 0 | 方法：文档、实验与对照；为什么不用泄露的源码 |
| 1 | 一次运行的全貌：stream-json 事件流与会话文件 |
| 2 | 发给模型的请求：三块系统提示、是它 8 倍大的工具定义、缓存断点 |
| 3 | 内置工具的契约：先读后改、大输出、校验先于钩子、并行结果按完成顺序回来 |
| 4 | CLAUDE.md 与自动记忆：金丝雀实验，按需加载 |
| 5 | 会话、恢复与压缩：借用缓存的摘要请求、摘要出错的真实案例、反复压缩的断路器 |
| 6 | 权限与模式：五道关、六种模式、自动模式的两阶段分类器 |
| 7 | Hooks：同一份钩子配置交给真实模型，被拦下后它换了九种写法 |
| 8 | MCP：窃听握手、结果处理、工具列表变化与工具搜索 |
| 9 | Skills 与命令：渲染、动态注入、为什么授予权限的 Skill 调用前要批准 |
| 10 | 子 Agent：三方的请求对比，前台与后台，报告被标为模型输出 |
| 11 | 沙箱：Seatbelt 与域名代理；读 sandbox-runtime 的源码，录制里看到的每一样东西都找到出处 |
| 12 | 无界面模式与 Agent SDK：窃听双向协议，再用开源的 Python 版 SDK 源码对照 |
| 13 | 总结：结构图、关键数字、七条原则、三方对照 |

## 快速开始

需要 Node.js 22.19 或更新版本。

```bash
npm install
npm run build          # 生成 site/dist：运行每一章的离线分析，把输出嵌进页面
npm run serve          # 本地预览
```

构建需要几个对照仓库放在本仓库旁边（可用环境变量 `MOX_SRC`、`PI_SRC`、`SRT_SRC`、`SDKPY_SRC` 修改路径）。源码摘录固定在下面的版本，构建时会校验提交：

```bash
git clone https://github.com/Jialei-03/learn-pi-agent.git ../learn-pi-agent
git clone --branch v1.5.0 https://github.com/earendil-works/pi.git ../pi-v1.5.0
git clone --branch v0.0.79 https://github.com/anthropics/sandbox-runtime.git ../sandbox-runtime-v0.0.79
git clone --branch v0.2.165 https://github.com/anthropics/claude-agent-sdk-python.git ../claude-agent-sdk-python-v0.2.165
```

`labs/*/recorded/` 里是用真实模型录制的运行记录，页面上的分析都由它们离线算出，**构建不需要模型服务，也不需要安装 Claude Code**。

## 自己重做实验

重做录制需要：

- Claude Code **v2.1.296**（课程固定在这个版本；换了版本，行为可能不同——第 6 章就有一例）；
- 一个兼容 Anthropic Messages 接口的模型服务（课程用的是一个中转服务上的 MiniMax-M3.1-Flash）：

```bash
export LCC_BASE_URL=https://你的服务地址
export LCC_API_KEY=...
export LCC_MODEL=...
node labs/ch05/record.ts      # 每章的 record*.ts 会覆盖 recorded/ 下的记录
```

实验完全隔离：`CLAUDE_CONFIG_DIR` 指向临时目录（不读也不写你的 `~/.claude`），子进程只带模型服务的变量，所有项目文件都在临时目录里。

## 目录

| 路径 | 内容 |
| --- | --- |
| `course/` | 课程正文（Markdown）与目录 `syllabus.ts` |
| `lab/` | 实验台：`cc.ts`（隔离地运行 Claude Code、保存记录）、`proxy.ts`（记录代理）、`derive.ts`（把请求变成结构摘要）、`hook-logger.mjs`（钩子记录器） |
| `labs/chNN/` | 每章的实验：`record*.ts` 录制（需要模型服务），其余脚本做离线分析；第 8、12 章各有一个“窃听器”（`mcp-tap.mjs`、`cli-tap.mjs`） |
| `site/` | 网站生成器：`@lab` 在构建时运行分析脚本，`@code`、`@mox`、`@pi`、`@oss` 从源码里摘录（Pi 固定在 v1.5.0，Anthropic 的开源组件见 `course/syllabus.ts` 的 `OSS`） |
| `assets/` | Mox 插画与角色设定 |

## 关于录制内容

请求里有 Anthropic 写的系统提示和工具描述。录制**只保存结构**：分几块、多长、有哪些小节、内容的指纹（用来比较两次请求是否相同）、金丝雀字符串出现的位置；正文最多保留一行。会话文件里夹带的系统提示快照、内置子 Agent 和 Skill 的说明同样只留长度和名字。临时路径、家目录、用户名、沙箱代理的一次性凭据都被替换掉了。
