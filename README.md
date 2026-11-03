# Learn Claude Code

**沿源码，读懂 Claude Code 的工程取舍。**

课程主线依据 [ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap)，固定 **2.1.88 · `a8a678cb6244e6770e1e421767ff0987a1d95549`**。按入口、状态、调用链和失败路径解读，每章至少两处固定源码依据。

该仓库通过公开 npm 包的 source map 还原文件，是非官方整理材料；版权仍归 Anthropic，不代表官方内部仓库或官方开源授权。课程以原创分析、函数和行号索引为主，不把整份还原源码再复制到这里。

原来的 **Claude Code 2.1.296** 实验与真实模型记录保留在各章后半部的完整实验对照。源码版本与实验版本明确分开：后续版本的一次观察不能直接证明 2.1.88 的行为。

## 贯穿全课的实现

课程已按 **14 个递进阶段**重写，主线是 `coda/src/`。每章围绕一个具体失败，给出固定源码的分支与状态分析、真实行号注解、本章接入代码、独立实验、结果解释和动手验收。

- [实现主线与阶段契约](course/progression.json)
- [第 0 章](course/00-method.md)
- [核心代码](coda/src)
- [逐章实验](labs/chapters)
- [源码工程地图](docs/engineering-map.md)与 [Obsidian Canvas](engineering/architecture.canvas)

## 安装、逐章运行与阅读

Node.js 22.19+。默认实验不需要 API Key，不读取个人 CLI 配置，不调用收费模型。

```bash
npm ci
npm run setup:source
npm run setup:study
npm run lesson -- 0       # 单独运行第 0 章
npm run lesson -- 3       # 单独运行第 3 章
npm run verify:course    # 顺序运行全部阶段
npm run build            # 再运行全部阶段、检查源码注解并生成网页
npm run serve
```

网页顶部“实现主线”提供所有章节、模块、依赖与实际断言数量。每章的实现块来自本仓库真实文件；实验表由构建时运行生成，不手写 PASS。完整结果与实现 SHA256 在 `site/dist/course-evidence.json`。

## 最后一章怎样验收

coda 在临时项目中加载指令与 Skill，委派只读子任务，Read、Edit、运行真实 Node 回归、调用真实本地 MCP，再保存和重新打开会话。模型回复确定，文件、进程、协议与日志真实执行。

可选 `coda/src/request.mjs` 中的 Anthropic adapter 接受显式 baseURL、apiKey、model；课程验证不会调用它。系统沙箱单独做允许/拒绝的 OS 探针，不可用时如实报告，不当作已生效。

## 两个版本怎样阅读

源码主线固定 2.1.88；14 章后半部保留 2.1.296 的独立录制与完整实验。原始还原源码不复制到此仓库；30 个定位文件与 sourcesContent 逐字核对。57 处源码阅读注解再校验实际行号。

对照课程与开源组件由 `study.lock.json` 固定；`setup:study` 不覆盖已有不同版本目录。

## 边界与验证

[验证记录](VERIFICATION.md)说明实际运行范围。源码阅读、真实上游纯模块、原创 `coda`、合成模型回复和 OS 探针分别标注。未验证的真实 Provider、完整产品模式或其他平台不会写成 PASS。

源码目录保持只读；图标沿用产品原始图标，来源在 `site/static/brand-source.json`。Mermaid 本地分发，保留其许可。
