---
motto: 沿固定源码解释机制，用对应版本证据验证判断。
prereq: 熟悉 Agent 循环与工具调用
time: 按需阅读
---

## 先找到 system prompt 的合成规则

@ccsrc system-prompt

`buildEffectiveSystemPrompt` 是比“请求里有三块系统提示”更稳定的解释入口。它按 override、Agent 指令、自定义或默认提示、append 等分支构造最终 SystemPrompt。某些协调和主动模式还受 feature 与运行状态影响。

关键在于替换和追加的差别：追加保留原始层；替换选择另一来源。若只检查某段文本是否出现，却没有记录当前 Agent 定义与 override 条件，很容易把配置变化误判成模型行为。

## 最终发送参数还包含工具和缓存策略

@ccsrc api-params

沿 `services/api/claude.ts` 的参数构造，能看到 model、经过缓存断点处理的 messages、system、allTools、tool choice、输出上限和 thinking 等同时被装入请求。缓存与工具 schema 不是 UI 上的一行设置，而是最终请求形状的一部分。

因此分析 token 消耗时，至少分开用户文本、历史消息、系统提示、工具定义和图片等模态。工具列表变化可能改变缓存可复用前缀；只看用户文字长度无法解释输入规模。

## source 中的条件需要分层验证

先检查调用者给了什么，再检查参数构造是否保留，再观察服务实际收到了什么。这三个环节能分别失败：配置层选择错模型，适配层丢字段，供应商拒绝不兼容参数。

| 问题 | 先找哪层证据 |
| --- | --- |
| 自定义 prompt 未生效 | buildEffectiveSystemPrompt 的来源和优先级 |
| 工具定义过大 | allTools 构造与发现过滤 |
| 缓存命中变化 | 缓存断点和前缀变化 |
| thinking 或长度报错 | 最终请求参数与供应商响应 |

2.1.88 的源码解释构造机制；2.1.296 的记录代理提供另一个版本的实际结构样本。原课程测得的块数与长度只属于记录样本，不应改写成所有 Claude Code 版本的常数。

::: interview 研究请求构造时，为什么既要看配置函数又要看最终 params？
配置表达意图，中间层可能按模式或模型重写，最终 params 才接近网络契约。应沿完整调用链记录来源、优先级和转换，再用对应版本的代理或 fake transport 验证。静态源码与实际请求相互约束，不能互相替代。
:::

@observation 02-request
