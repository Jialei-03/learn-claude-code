# Learn Claude Code

**沿源码，读懂 Claude Code 的工程取舍。**

课程主线依据 [ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap)，固定 **2.1.88 · `a8a678cb6244e6770e1e421767ff0987a1d95549`**。按入口、状态、调用链和失败路径解读，每章至少两处固定源码依据。

该仓库通过公开 npm 包的 source map 还原文件，是非官方整理材料；版权仍归 Anthropic，不代表官方内部仓库或官方开源授权。课程以原创分析、函数和行号索引为主，不把整份还原源码再复制到这里。

原来的 **Claude Code 2.1.296** 实验与真实模型记录保留在各章后半部的完整实验对照。源码版本与实验版本明确分开：后续版本的一次观察不能直接证明 2.1.88 的行为。

## 从这里开始

- [第 0 章：源码、版本与证据](course/00-method.md)
- [源码工程思维导图](docs/engineering-map.md)，GitHub 可直接渲染 Mermaid
- [可编辑 JSON Canvas](engineering/architecture.canvas)，可放进 Obsidian
- [工程解读工具与方法](docs/engineering-workflow.md)

## 源码依据怎样校验

`course/source-references.json` 声明 30 个源码定位点。构建时会：

1. 校验还原仓库 HEAD 与 `source.lock.json` 的固定提交一致。
2. 校验 npm metadata 的版本为 2.1.88，以及 `cli.js.map` 的 Git blob 与提交一致。
3. 把每个引用文件与 map 中的 `sourcesContent` 逐字比较。
4. 校验函数/分支锚点唯一，生成带固定提交与行号的证据卡。
5. 运行独立版本的离线录制分析；不启动真实模型。

结果保存在构建产物 `site/dist/source-evidence.json`。源码存在、feature 分支可达、实际产品运行是不同证据层级，正文会逐项区分。例如 SDK 类型入口中的 query 是占位实现，不能当作真正执行器。

## 课程目录

| 章 | 工程问题与主要源码 |
| --- | --- |
| 0 | 方法：sourcemap、版本锁和 feature 边界 |
| 1 | 一次运行：bootstrap → query → queryLoop 的 State |
| 2 | 请求：system prompt 合成与最终 API params |
| 3 | 工具：并发批次、参数校验与先读后改 |
| 4 | 记忆：CLAUDE.md include、类型过滤与最终注入 |
| 5 | 会话与压缩：转录、阈值、断路器与消息重建 |
| 6 | 权限：规则阶段与最终决策 |
| 7 | Hooks：匹配、输入、阻塞与失败 |
| 8 | MCP：发现、工具投影与结果适配 |
| 9 | Skills：metadata、工具入口与 fork |
| 10 | 子 Agent：定义、工具池、前后台与生命周期 |
| 11 | 沙箱：产品规则到运行时配置与命令包装 |
| 12 | Headless / SDK：StructuredIO 与占位实现边界 |
| 13 | 三项目对照与实习面试的工程证据 |

## 构建与预览

需要 Node.js 22.19+。

```bash
npm install
npm run setup:source    # 准备旁边的固定 sourcemap 克隆；不覆盖已有不同版本目录
```

对照源码仍需放在旁边，已存在时直接复用：

```bash
git clone https://github.com/Jialei-03/learn-pi-agent.git ../learn-pi-agent
git clone --branch v1.5.0 https://github.com/earendil-works/pi.git ../pi-v1.5.0
git clone --branch v0.0.79 https://github.com/anthropics/sandbox-runtime.git ../sandbox-runtime-v0.0.79
git clone --branch v0.2.165 https://github.com/anthropics/claude-agent-sdk-python.git ../claude-agent-sdk-python-v0.2.165
npm run map:generate
npm run lab:source
npm run check
npm run build
npm run serve
```

可分别用 `CC_SOURCE_DIR`、`MOX_SRC`、`PI_SRC`、`SRT_SRC`、`SDKPY_SRC` 指定本地路径。还原文件并不是完整可重新构建的开发仓库，本课程不安装或执行其中的 CLI；局部源码实验仅在隔离测试端口下执行审核过的函数。

## 目录

| 路径 | 内容 |
| --- | --- |
| `course/` | 以 2.1.88 源码为主的正文、目录和证据定位点 |
| `observations/` | 2.1.296 的独立实验正文，网页完整展示并加入本页目录 |
| `lab/`、`labs/` | 原实验台与录制分析；8 组还原源码函数实验；`sourcemap.ts` 校验源码来源 |
| `engineering/` | 一份导图数据与可编辑 `.canvas` |
| `docs/` | Mermaid 工程地图与解读方法 |
| `site/` | 阅读站、源码索引、面试题库和可缩放工程地图 |

## 重做原实验

需要 Claude Code 2.1.296 与兼容 Anthropic Messages 的模型服务。设置 `LCC_BASE_URL`、`LCC_API_KEY`、`LCC_MODEL` 后运行相应 `labs/chNN/record*.ts`。录制会产生费用；构建不会运行这些脚本。实验隔离配置，记录只保留研究所需结构，不保存密钥和长段系统提示原文。

## 原始图标

左上角及 favicon 使用 Anthropic 官方 Claude Code VS Code 扩展图标；来源和文件哈希记录于 `site/static/brand-source.json`。此仓库是个人工程解读项目。

## 工程阅读与动手实验

14 章均有源码推导、反例、练习与动手目标，2.1.296 的完整实验在正文中分区呈现。Mermaid 随网站构建到本地，不依赖 CDN；机制图会直接渲染，支持深浅主题。

```bash
npm run lab:source
node --disable-warning=ExperimentalWarning labs/engineering/run.mjs lifecycle
node --disable-warning=ExperimentalWarning labs/engineering/run.mjs prompt
node --disable-warning=ExperimentalWarning labs/engineering/run.mjs partition
node --disable-warning=ExperimentalWarning labs/engineering/run.mjs memory
node --disable-warning=ExperimentalWarning labs/engineering/run.mjs compact
node --disable-warning=ExperimentalWarning labs/engineering/run.mjs permissions
node --disable-warning=ExperimentalWarning labs/engineering/run.mjs io
node --disable-warning=ExperimentalWarning labs/engineering/run.mjs sdk
```

这些实验从固定 Git 对象与已核对的 source map 提取原始函数体，运行在显式测试端口下；不保存或再分发函数源码。每组输出列明 fake 依赖与验证范围。它们检验局部行为，不代表完整 CLI、全部 feature 分支或真实模型集成通过。
