---
motto: 沿固定源码解释机制，用对应版本证据验证判断。
prereq: 熟悉 Agent 循环与工具调用
time: 按需阅读
---

## 先看调度，再看单个工具

@ccsrc tool-partition

`partitionToolCalls` 把相邻的并发安全工具组成一批。是否安全依赖工具查找、schema 解析和 `isConcurrencySafe`，解析或判断抛错会保守地视为不安全。它并不是“所有 read-only 名称都可以并行”的硬编码名单。

`runTools` 对安全批次并发执行，但会把 context modifier 按原调用块顺序应用。输出完成顺序与共享上下文修改顺序因此可以不同。非安全操作走串行路径，避免副作用随 promise 调度漂移。

## 参数不合法时，可以根本到不了执行器

@ccsrc tool-validate

toolExecution 先做 schema 检查，再调用工具特有的 validateInput。失败会构造带相应 tool_use id 的错误结果，随后模型才能在下一轮修正参数。权限检查、PreToolUse 与实际 call 的相对位置，需要继续沿同文件核对，不能从 Hook 名字推断。

这种层次关系解释了一个常见现象：注册了 Hook 却没看到某次调用，不一定是 Hook 系统坏了，可能调用在更早的参数检查处已经终止。

## Edit 的先读后改是状态契约

@ccsrc edit-read-state

Edit 检查 readFileState；没有读取记录或只有 partial view 会拒绝。若修改时间更新，完整读取情况下还会比较内容，避免只因时间戳变化而误报。之后才判断 old string 是否存在、多处匹配是否需要 replace_all。

所以“文件读过”应具体到标准化路径、读取范围和内容版本。只把一个布尔值设成 true 不足以表达这个契约。测试也应检查失败时文件字节保持原样，而不是仅匹配错误文案。

::: interview 工具并发输出乱序，为什么不一定代表历史状态也乱序？
执行器可以让独立任务并行完成、及时流出结果，再按确定的调用顺序提交共享上下文修改。需要区分执行顺序、事件交付顺序和状态应用顺序；回归测试应分别检查，而不能只截一张终端日志。
:::

@observation 03-tools
