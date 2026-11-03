# 完整重做验证记录

日期：2026-11-04（Asia/Singapore）。macOS，Node.js v22.22.3。

## 内容与实现

全部 14 章重新组织为具体问题、固定源码分支、实际行号注解、原创实现、执行顺序说明、独立实验、结果解释与动手验收。贯穿项目在 `coda/src/`；`course/progression.json` 绑定阶段依赖、真实导出符号与实验。网页直接读取实现文件，证据清单记录文件 SHA256。

2.1.88 / `a8a678cb6244e6770e1e421767ff0987a1d95549` 的 30 个定位点与 source map 核对，57 处阅读注解校验到固定引用范围内的真实行号。原有 2.1.296 完整观察保留在各章独立版本区域，不用来证明 2.1.88 行为。产品原始图标、工程地图与 Canvas 保留。

## 本机执行结果

| 检查 | 结果 |
| --- | --- |
| `npm run setup:study` | PASS，4 个对照仓库与 lock 一致 |
| `npm run lab:source` | PASS，8 组固定源码函数契约 |
| 逐章独立实验（构建时重跑） | PASS，14 份、83 项断言 |
| `npm run typecheck` | PASS，现有 TypeScript 站点与实验；新 `.mjs` 另做语法和执行检查 |
| `npm run check`、`npm run build` | PASS，19 页、57 道面试题 |
| 本地页面、资源与 fragment | 全量检查无缺失 |
| 浏览器逐章检查 | 14/14 章都有实现、独立实验、执行路径说明和行号注解；14 张机制图全部渲染 |
| 总装交互 | 代码展开、实验数据、逐步回放与事件 JSON 正常，console warn/error 为空 |
| `git diff --check` | PASS |

`site/dist/course-evidence.json` 保存实际断言、观察数据和实现摘要。页面 PASS 来自子进程退出结果及报告检查，断言失败会中止构建。

## 实验范围

新实验使用确定性模型回复，实际创建临时项目、读写文件、启动和结束 Node 工具进程、运行命令 hook、进行本地 stdio MCP 握手与调用、持久化并重新打开日志。第 13 章加载 Skill、调用只读子任务、修改 slug 文件并运行独立回归，随后重开 Session。模型只提供意图，不代写工具成功结果。

macOS 沙箱探针实际获得 enforced：工作区内允许写，工作区外拒绝写。其他平台没有后端或不能建立隔离时报告 unavailable，执行器拒绝无沙箱降级。课程配置不等于完整产品的机密读取与域名代理策略。

固定源码函数实验核对 source map 后装载审核过的函数体，依赖端口明确提供。coda 是原创教学实现，并非完整还原 CLI；Session 使用单进程日志，应用在终态保存本次消息，未实现全部崩溃窗口恢复。可选 Anthropic adapter 未做真实 Provider 验证，默认实验不使用私人凭据或付费服务。

GitHub Actions 从干净 checkout 准备固定源码与对照组件，运行源码实验、TypeScript 检查和完整构建。提交后的结果以对应 Actions run 为准。
