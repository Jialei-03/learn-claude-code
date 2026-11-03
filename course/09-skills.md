---
motto: 从状态、边界与失败路径读工程。
prereq: 已读第 1 章的主循环
time: 按需阅读
---

## Skill 是被读取、解析并参与运行的能力

@ccsrc skill-fields

`parseSkillFrontmatterFields` 不只提取名称和简介，还解析 allowed tools、用户/模型可调用性、模型、参数提示、Hook、effort、shell 与 fork context。每个字段都可能改变运行方式，所以 Skill 不只是一个长 prompt 文件。

字段存在也不保证所有分支启用；应继续看 createSkillCommand、加载来源和实际调用者。尤其要检查缺省值与非法值的处理，避免把字符串形式的 false 当成真。

## 模型调用 Skill 仍经过工具入口

@ccsrc skill-tool

`SkillTool` 校验名称、处理兼容的前导斜杠并在 command registry 中查找。特定远程发现分支受 feature 条件约束。只有找到可用命令后，才能谈正文怎样展开、参数怎样替换或是否在 fork 中执行。

运行入口和命令定义分开，让用户调用、模型调用与其他分发方式共享能力描述，但它们的授权条件仍要具体检查。不能因为名称相同就假定所有入口都跳过审批。

## 安装代码解读 Skill，也是一次能力接入

本工作区已配备 Understand Anything、JSON Canvas 与 Mermaid 图示指南。它们分别帮助组织调用邻域、编辑思维导图和选择图类型。安装文件只意味着方法可用，不能代替读源码和验证图里的每条边。

本课程工程地图采用“主题 → 实现入口”的边，不把概念分类冒充函数 calls。真正的调用关系必须在调用者中找到对应语句；功能开关和未验证分支要单独标识。

## 需要验证的边界

可用的 Skill 实验应分别观察 metadata 发现、正文读取、参数展开、权限变化和最终执行上下文。动态命令或 shell 内容还涉及当前目录与真实进程环境，不能用静态渲染替代执行证据。

::: interview Skill 和普通提示模板的关键区别是什么？
具体实现可能让 Skill 参与发现、调用权限、工具授权、Hook 和子上下文执行，而模板主要提供文本组合。应依据该版本 loader 与执行入口解释能力，不能仅根据文件后缀或产品名称分类。
:::

@observation 09-skills
