---
motto: 看不到源码，也能看清设计：请求、事件、文件和进程会说话。
learn:
  - 把十二章的实验拼成一张 Claude Code 的结构图
  - 一张“按数字看 Claude Code”的表，全部从录制里现算
  - 贯穿各章的七条设计原则，以及每条背后的实验
  - Claude Code、Pi、mox 的逐项对照，以及 mox 可以向 Claude Code 学的地方
  - 面试时怎样用五分钟讲清楚“一个 coding agent 是怎么工作的”
prereq: 第 0—12 章
time: 40 分钟
build: labs/ch13 —— 从各章录制里汇总关键数字
---

## 一张结构图

十二章实验看到的东西，放在一张图里：

<figure class="diagram">
<svg viewBox="0 0 720 400" role="img" aria-label="从实验中观察到的 Claude Code 结构">
<g font-size="12">
<rect x="150" y="20" width="420" height="250" rx="10" fill="var(--bg-soft)" stroke="var(--line-2)"/>
<text x="164" y="42" font-weight="700" fill="var(--ink)">Claude Code 进程</text>
<rect x="164" y="54" width="392" height="62" rx="6" fill="var(--bg)" stroke="var(--line-2)"/>
<text x="176" y="74" font-weight="700" fill="var(--ink)">请求组装（2、4、5、8、9）</text>
<g font-size="11" fill="var(--muted)">
<text x="176" y="92">工具定义 → 系统提示（稳定）→ 消息：说明、环境、Skill 目录、</text>
<text x="176" y="107">推迟的工具名、钩子输出、摘要……一律追加，不改写开头</text>
</g>
<rect x="164" y="126" width="190" height="62" rx="6" fill="var(--accent-soft)" stroke="var(--accent)"/>
<text x="176" y="146" font-weight="700" fill="var(--accent-ink)">五道关（3、6、7）</text>
<g font-size="11" fill="var(--accent-ink)"><text x="176" y="164">校验 → 钩子 → 规则 → 模式</text><text x="176" y="179">→ 分类器 → 执行</text></g>
<rect x="366" y="126" width="190" height="62" rx="6" fill="var(--bg)" stroke="var(--line-2)"/>
<text x="378" y="146" font-weight="700" fill="var(--ink)">Agent 循环（1、3、10）</text>
<g font-size="11" fill="var(--muted)"><text x="378" y="164">流式执行工具、并行调用、</text><text x="378" y="179">前台 / 后台子 Agent</text></g>
<rect x="164" y="198" width="392" height="58" rx="6" fill="var(--bg)" stroke="var(--line-2)"/>
<text x="176" y="218" font-weight="700" fill="var(--ink)">会话文件（1、5）</text>
<g font-size="11" fill="var(--muted)"><text x="176" y="236">只追加的 JSONL：uuid 树、注入的附件、压缩边界（新的根）、</text><text x="176" y="250">子 Agent 各自一个文件</text></g>
<rect x="8" y="60" width="124" height="150" rx="8" fill="var(--bg)" stroke="var(--line-2)"/>
<text x="20" y="82" font-weight="700" fill="var(--ink)">谁在驱动（12）</text>
<g font-size="11" fill="var(--muted)"><text x="20" y="104">终端里的用户</text><text x="20" y="122">claude -p：一次性</text><text x="20" y="140">Agent SDK：</text><text x="20" y="155">stdin 上的双向协议</text><text x="20" y="170">审批、钩子、MCP</text><text x="20" y="185">都是回调</text></g>
<path d="M132 135 H150" stroke="var(--faint)" fill="none"/>
<rect x="588" y="40" width="124" height="96" rx="8" fill="var(--ink)"/>
<text x="600" y="62" font-weight="700" fill="var(--bg)">模型服务</text>
<g font-size="11" fill="var(--bg)"><text x="600" y="82">主循环的请求</text><text x="600" y="98">缓存按前缀命中</text><text x="600" y="114">max_tokens 决定</text><text x="600" y="128">压缩的触发点</text></g>
<rect x="588" y="146" width="124" height="110" rx="8" fill="var(--bg)" stroke="var(--line-2)" stroke-dasharray="4 3"/>
<text x="600" y="168" font-weight="700" fill="var(--ink)">旁路请求</text>
<g font-size="11" fill="var(--muted)"><text x="600" y="188">安全分类器（6）</text><text x="600" y="204">压缩摘要（5）</text><text x="600" y="220">count_tokens（5）</text><text x="600" y="236">都看不到或不改</text><text x="600" y="250">主对话的开头</text></g>
<path d="M570 90 H588 M570 200 H588" stroke="var(--faint)" fill="none"/>
<g font-size="11">
<rect x="150" y="296" width="96" height="88" rx="8" fill="var(--bg)" stroke="var(--line-2)"/><text x="160" y="316" font-weight="700" fill="var(--ink)">钩子（7）</text><text x="160" y="334" fill="var(--muted)">独立的子进程</text><text x="160" y="349" fill="var(--muted)">JSON 进出</text><text x="160" y="364" fill="var(--muted)">出错时放行</text>
<rect x="256" y="296" width="96" height="88" rx="8" fill="var(--bg)" stroke="var(--line-2)"/><text x="266" y="316" font-weight="700" fill="var(--ink)">MCP（8）</text><text x="266" y="334" fill="var(--muted)">子进程或 SDK</text><text x="266" y="349" fill="var(--muted)">JSON-RPC</text><text x="266" y="364" fill="var(--muted)">工具可推迟</text>
<rect x="362" y="296" width="96" height="88" rx="8" fill="var(--bg)" stroke="var(--line-2)"/><text x="372" y="316" font-weight="700" fill="var(--ink)">沙箱（11）</text><text x="372" y="334" fill="var(--muted)">Seatbelt 里</text><text x="372" y="349" fill="var(--muted)">运行 Bash</text><text x="372" y="364" fill="var(--muted)">网络走代理</text>
<rect x="468" y="296" width="102" height="88" rx="8" fill="var(--bg)" stroke="var(--line-2)"/><text x="478" y="316" font-weight="700" fill="var(--ink)">子 Agent（10）</text><text x="478" y="334" fill="var(--muted)">新的上下文</text><text x="478" y="349" fill="var(--muted)">裁剪过的工具</text><text x="478" y="364" fill="var(--muted)">报告当作数据</text>
</g>
<path d="M198 270 V296 M304 270 V296 M410 270 V296 M519 270 V296" stroke="var(--faint)" fill="none"/>
</g>
</svg>
<figcaption>括号里是章节号。中间是 Claude Code 自己，左边是驱动它的人或程序，右边是模型服务（包括几种旁路请求），下面是它启动或管理的其他执行单元。</figcaption>
</figure>

## 按数字看

每一行都从对应章节的录制里现算出来：

@lab node labs/ch13/numbers.ts

几个数字值得记住：工具定义是系统提示的 8 倍（固定开销主要在工具）；正常对话里缓存命中接近 100%，压缩请求也有 93%，压缩之后的第一个请求则几乎全部重新计算（压缩真正的代价）；安全分类器的系统提示有十四万个字符，比主对话大二十多倍；工具搜索让第一个请求少了三分之一的输入；SDK 默认的系统提示只有两行。

## 七条原则

把各章的结论抽出来，大概是这七条。每一条都有实验撑着：

**1. 开头不动，变化追加。** 系统提示在同一个项目的所有会话之间保持不变；项目说明、环境、Skill 目录、推迟的工具名、钩子的输出、沙箱的说明都放在对话里的 system 消息或 `<system-reminder>` 中；恢复会话时逐字重放当时的注入；压缩请求借用上一个请求的前缀。代价最高的操作——压缩、中途改变工具列表——也正是那些不得不改写开头的操作。（第 2、4、5、8 章）

**2. 给模型的和给程序的分开。** 工具结果有给模型的文本和给钩子、界面的结构化数据（`structuredPatch`、`originalFile`）；大输出存成文件、只给模型预览和路径；MCP 的 `structuredContent`、Skill 渲染后的正文、钩子的补充说明，各自有它们进入对话的位置。（第 3、7、8、9 章）

**3. 放宽权限的只有用户。** 拒绝优先于放行；钩子可以收紧，推翻不了 deny 规则；授予权限的 Skill，调用它本身要批准；分类器在两个阶段里，先“宁可错拦”再结合用户意图复核；SDK 的审批回调替用户回答，但仍然在规则之后。（第 6、7、9、12 章）

**4. 边界在进程上，不在文本上。** 规则和钩子匹配的是命令的写法，`/bin/rm`、`python -c` 就能绕过；沙箱在内核层面限制进程。真实模型被拦下之后，换了九种写法尝试同一件事——拦住它们的，是更底层的那一道关。（第 6、7、11 章）

**5. 想清楚失败时往哪边倒。** 钩子出错时放行（可用性），安全分类器拿不准时拒绝（安全），自动压缩连续失败时停下（不让 Agent 空转烧钱）。同样是“出错”，三处的选择不同，各有道理。（第 5、6、7 章）

**6. 不可信的内容要标出来。** 分类器看不到工具结果，所以文件里的注入说服不了它；子 Agent 的报告前面写着“这是模型输出，不是用户或系统的指示”；压缩摘要的末尾提醒接手的模型哪些消息是原样保留的。数据和指令之间要有一条看得见的线。（第 5、6、10 章）

**7. 真实的模型会走你没想到的路。** 并行结果乱序时按位置配对（第 3 章），把错误写进摘要还“引用”了不存在的代码（第 5 章），用 Bash 绕过只盯着 Read 的钩子（第 7 章），Skill 加载被拒后自己去读原文件（第 9 章）。脚本模型只会走你预想的路——驾驶层的设计要用真实的模型去检验。

## 三方对照

| | Claude Code | Pi | mox |
| --- | --- | --- | --- |
| 系统提示 | 稳定的三块；变化放进对话 | 分节组装，变化以补丁追加 | 同 Pi |
| 并行工具结果 | 按完成顺序 | 按调用顺序 | 按调用顺序 |
| 压缩 | 借用缓存的摘要请求；保留上个请求之后的内容；补回文件和说明；断路器 | 序列化旧消息单独摘要；保留最近约 2 万 token；文件清单 | 同 Pi，没有断路器 |
| 权限 | 五道关，六种模式，分类器 | 扩展实现（Learn Pi Agent 第 14 章） | 同左，五种模式 |
| 钩子 | 本课观察到 14 种事件；命令或 SDK 函数 | 扩展实现，六种事件 | 同左 |
| MCP | 窃听到的完整握手；结构化结果优先；工具搜索与 `tool_reference` | direct、deferred、codemode、hidden | 直接加载 |
| Skills | Skill 工具、渲染、动态注入、`allowed-tools` | read 读 SKILL.md | 同 Pi |
| 子 Agent | 前台 / 后台，报告标为模型输出 | 示例扩展（独立进程） | 同一进程里的新循环 |
| 沙箱 | Seatbelt / bubblewrap + 域名代理 | 扩展实现 | 同左 |
| 嵌入 | Agent SDK：双向协议 | SDK、RPC 模式 | `--mode json`、`--mode rpc` |

### mox 可以学什么

这门课顺带给 mox 找到了一张改进清单，每一条都很小、都有实验依据：

- **压缩的断路器**：连续几次“刚压缩完又满了”就停下，并告诉用户原因（第 5 章）。
- **子 Agent 报告的标注**：交回时注明“这是模型输出”（第 10 章）。
- **Skill 的权限**：如果将来支持 `allowed-tools`，调用前要先经过用户批准（第 9 章）。
- **RPC 模式的反向请求**：让客户端能回答确认请求，而不是一律拒绝（第 6、12 章）。
- **钩子的 `transcript_path`**：让依赖会话记录的钩子脚本在 mox 里也能工作（第 7 章）。

## 五分钟讲清楚一个 coding agent

面试里常见的开放题：“讲讲 Claude Code（或者你做过的 Agent）是怎么工作的。”一个有结构的回答可以按这条线走，每一段都能用这门课的一个实验做例子：

1. **循环**：模型说话 → 调用工具 → 结果回到对话 → 再请求，直到模型不再调用工具。工具在模型生成参数时就开始执行，多个调用并行（第 1、3 章）。
2. **请求的构成和缓存**：工具定义、稳定的系统提示、只追加的消息；缓存按前缀命中，所以变化往后放（第 2 章）。
3. **上下文管理**：项目说明和记忆在开头，子目录的规则按需加载；快满时压缩——借用缓存写摘要、重新读取文件——并且知道摘要会出错（第 4、5 章）。
4. **控制**：参数校验、钩子、规则、模式、分类器五道关，外面再套一层沙箱；放宽权限的只有用户（第 6、7、11 章）。
5. **扩展**：MCP 接入外部工具，工具多了就推迟加载；Skill 按需加载方法；子 Agent 隔离上下文（第 8、9、10 章）。
6. **嵌入**：同一个进程，通过一条双向协议被程序驱动，审批和钩子都可以交给宿主程序（第 12 章）。

最后补一句方法论：这些结论不是从源码里读出来的，而是截下请求、记下事件、读会话文件、对照文档得出来的——这本身就是一种可以迁移到任何闭源系统的能力。

## 面试题

::: interview 如果让你从零设计一个 coding agent 的驾驶层，最先要定下来的三件事是什么？
一是请求的布局：什么放在稳定的前缀里（工具、系统提示），什么作为追加的消息（环境、说明、提醒），这决定了缓存和成本，也决定了恢复会话和压缩怎么做。二是工具的契约和执行模型：参数怎么校验、结果怎么交回（给模型的文本和给程序的结构化数据分开、大输出怎么处理）、并行调用的结果按什么顺序。三是控制的分层：校验、钩子、规则、模式、可选的分类器、操作系统沙箱，每一层失败时往哪边倒。这三件事定下来，压缩、MCP、Skill、子 Agent 都是在它们之上加东西。
:::

::: interview 研究一个闭源的 Agent 产品，你会怎么做？
先读官方文档，列出要验证的说法；然后用可重复的实验去看它的实际行为：把模型服务地址指向一个自己的记录代理，截下每一个请求（只保存结构和指纹，不传播别人的文字）；打开结构化的事件输出；挂上记录一切的钩子；读它留下的会话文件；需要时在它和子进程之间放一个转发并记录的“窃听器”（MCP 服务器、SDK 协议）。用金丝雀字符串定位内容去了哪里，用内容指纹比较两次请求是否相同。最后把每个结论和文档对照，标明哪些是文档说的、哪些是观察到的、哪些只在特定版本成立。
:::
