# Learn Claude Code

**沿源码，读懂 Claude Code 的工程取舍。**

Claude Code 2.1.88 的 npm 包附带了 source map，从里面能还原出一千九百个 TypeScript 文件、五十多万行代码。真正的 Agent 机制——主循环、请求构造、工具编排、权限、Hook、记忆、压缩、MCP、Skill、子 Agent、沙箱、无界面协议——藏在其中几十个文件里。这门课每章挑一个具体问题，沿调用链把源码摆出来逐段讲，用真实运行的录制验证，再在贯穿项目 **coda** 里用最小的代码亲手实现一遍。

这是 [Learn Pi Agent](https://github.com/Jialei-03/learn-pi-agent) 之后的第二门课：Agent 循环、工具、上下文、会话的基础在那里从零实现过，这里经常拿 Pi 和 mox 做对照。

## 章节

| | 章 | 读什么 |
| --- | --- | --- |
| 00 | 导读：怎样读五十万行还原源码 | 源码从哪来、缺什么；从 `claude` 追到 `query()`；认出编译期开关 |
| 01 | 主循环：queryLoop 的状态与出口 | State、七个继续位置、十个出口；截断续写、Stop Hook、中止、排队 |
| 02 | 请求构造：模型每一轮收到的是什么 | 系统提示分段、上下文槽位、缓存断点、消息归一化 |
| 03 | 工具执行：分批、关卡与文件版本 | 相邻分批、流式执行、校验 → Hook → 权限 → 执行、先读后改、大输出 |
| 04 | 项目记忆：从 CLAUDE.md 到第一条消息 | 分层发现、`@` 引用、按需加载、为什么放在第一条用户消息 |
| 05 | 会话与压缩：文件只追加，请求靠重建 | JSONL 会话树、恢复、自动压缩触发线、microcompact |
| 06 | 权限：allow、ask 还是 deny | 决策台阶、规则来源、Bash 规则、模式、无人可问时 |
| 07 | Hook：事件、匹配与失败时放行 | 事件位置、并行执行、输出协议、Stop Hook、失败放行 |
| 08 | MCP：配置、连接、包装与退出 | 配置信任、握手期限、工具包装、结果转换、信号升级 |
| 09 | Skill：常驻一行目录，调用时才渲染 | 目录预算、两扇门、渲染、allowed-tools、fork |
| 10 | 子 Agent：任务单进去，报告出来 | 工具池过滤、上下文隔离、前后台、取消传递 |
| 11 | 沙箱：规则变成配置，配置变成拒绝 | 规则 → 沙箱配置、seatbelt / bubblewrap、网络代理 |
| 12 | 无界面运行：请求配对、EOF 与取消 | `-p`、stream-json、`can_use_tool` 往返、Agent SDK |
| 13 | 总装 | 机制挂在主循环哪里；coda 修复一个真实失败的项目；三方对照 |

## 快速开始

需要 Node.js 22.19+。所有实验离线运行，不需要 API Key，不读你的个人配置。

```bash
git clone https://github.com/Jialei-03/learn-claude-code.git
cd learn-claude-code && npm ci
npm run setup:source     # 把还原源码 checkout 到 ../claude-code-sourcemap-source（固定提交 a8a678c）
npm run setup:study      # 准备对照用的 Pi v1.5.0、learn-pi-agent 和两个 Anthropic 开源组件
npm run lesson -- 3      # 运行第 3 章的实验，终端里打印实验过程
npm run build && npm run serve   # 本地阅读站 http://127.0.0.1:4322/
```

`npm run verify:course` 顺序运行全部章节的 coda 实验；`node site/build.ts --only 03-tools` 只检查一章。

## 仓库里有什么

| 路径 | 内容 |
| --- | --- |
| `course/` | 各章正文、目录 `syllabus.ts`、coda 的阶段表 `progression.json`、实验用到的源码锚点 `source-references.json` |
| `coda/src/` | 贯穿全课的小型 coding agent：每章一个模块，对应 Claude Code 里的一部分 |
| `runtime/` | coda 共用的底层：工作区路径、追加日志、子进程、JSON-RPC、沙箱 |
| `labs/chapters/` | 每章的 coda 实验（读者模式打印过程，`--json` 给构建用） |
| `labs/chNN/` | 每章的其他实验，以及用真实 Claude Code 2.1.296 录制的运行记录（`recorded/`） |
| `labs/engineering/run.mjs` | 在运行时从固定提交里取出单个 Claude Code 函数执行 |
| `lab/` | 录制实验台：隔离配置目录、记录代理、Hook 记录器 |
| `site/` | 阅读站生成器 |

## 源码与版权

还原源码的版权属于 Anthropic，不是开源项目。本仓库**不包含**还原源码：正文里只写文件、函数和行号，阅读站上的代码摘录是本地构建时从你自己的固定 checkout 读出来的；实验同样在运行时从固定提交取函数执行。请不要把构建好的 `site/dist` 公开发布。

对照用的 [sandbox-runtime](https://github.com/anthropics/sandbox-runtime)（Apache-2.0）和 [claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python)（MIT）是 Anthropic 的开源组件；Pi 源码为 MIT。课程原创内容与 coda 采用 MIT。

## 版本

| | |
| --- | --- |
| 还原源码 | [ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap) · 2.1.88 · `a8a678c` |
| 录制实验 | Claude Code 2.1.296（和源码版本不同的地方，各章正文里逐处指出） |
| 对照 | Pi v1.5.0 · `f9a2636`；learn-pi-agent 的 mox |
