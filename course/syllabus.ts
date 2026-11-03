// 课程目录：网站导航、首页路线图和章节编号都来自这里。
// status: 'ready' 表示正文已完成；'planned' 会在路线图上显示为“编写中”。

/** 观察的对象：实验用的 Claude Code 版本 */
export const CC = { version: '2.1.296', docs: 'https://code.claude.com/docs' };

/** 用户指定的非官方 sourcemap 还原版本，作为课程源码主线。 */
export const CC_SOURCE = {
  repo: 'https://github.com/ChinaSiro/claude-code-sourcemap',
  commit: 'a8a678cb6244e6770e1e421767ff0987a1d95549',
  version: '2.1.88', dir: '../claude-code-sourcemap-source', env: 'CC_SOURCE_DIR',
};

/** 对照的 Pi 源码（与 Learn Pi Agent 相同的固定版本） */
export const PI = {
  version: 'v1.5.0',
  commit: 'f9a26365568127461c47a07a37dcb42c140a3ac5',
  repo: 'https://github.com/earendil-works/pi',
};

/**
 * Anthropic 以开源许可发布的组件（@oss 摘录）。和 Pi 一样固定在一个提交上，构建时校验。
 * 版本按“发布时间在本课观察的 Claude Code 2.1.296（2026-10-09）之前最近”来选：
 *   sandbox-runtime：Claude Code 的沙箱建在它上面（文档原话），Claude Code 捆绑的具体版本无法从外部确认；
 *   claude-agent-sdk-python：v0.2.165 捆绑的 Claude Code 是 2.1.294（没有正好捆绑 2.1.296 的版本）。
 */
export const OSS = {
  'sandbox-runtime': {
    label: 'sandbox-runtime', version: 'v0.0.79', commit: 'd9aac2098351ca17f3743fbaf6ecbd0051b7e00e',
    repo: 'https://github.com/anthropics/sandbox-runtime', license: 'Apache-2.0', dir: '../sandbox-runtime-v0.0.79', env: 'SRT_SRC',
  },
  'agent-sdk-python': {
    label: 'claude-agent-sdk-python', version: 'v0.2.165', commit: 'f7529348747235da34af3ed202251228ff31db08',
    repo: 'https://github.com/anthropics/claude-agent-sdk-python', license: 'MIT', dir: '../claude-agent-sdk-python-v0.2.165', env: 'SDKPY_SRC',
  },
} as const;
export type OssName = keyof typeof OSS;

export interface ChapterInfo { n: number; slug: string; title: string; summary: string; status: 'ready' | 'planned'; extend?: boolean }
export interface PartInfo { id: string; title: string; subtitle: string; chapters: ChapterInfo[] }

export const parts: PartInfo[] = [
  {
    id: 'p0', title: '开始之前', subtitle: '沿还原源码读懂一个产品级 Agent',
    chapters: [
      { n: 0, slug: '00-method', title: '证据与入口：先确定要重建什么', summary: '把源码文本、入口可达性、局部执行和端到端结果分开，给后面所有实验提供可追溯的基础。', status: 'ready' },
    ],
  },
  {
    id: 'p1', title: '一次运行', subtitle: '从输入到结束',
    chapters: [
      { n: 1, slug: '01-one-run', title: '主循环：让一次任务正确地结束', summary: '接过第 0 章的证据约束，写出所有后续能力共同使用的 Engine。工具、权限和持久化都通过这里的边界接入。', status: 'ready' },
      { n: 2, slug: '02-request', title: '请求构造：从提示来源到模型协议', summary: '循环只管什么时候请求；本章增加 request 回调，让提示、历史和工具定义通过同一个边界进入模型。', status: 'ready' },
      { n: 3, slug: '03-tools', title: '工具执行：并发、校验与文件版本', summary: '上一章让模型知道工具；本章让调用真的产生受控效果，并把失败作为带 id 的结果交回循环。', status: 'ready' },
    ],
  },
  {
    id: 'p2', title: '上下文', subtitle: '记住什么、忘掉什么',
    chapters: [
      { n: 4, slug: '04-memory', title: '项目指令：发现、递归与最终注入', summary: 'Engine 和文件工具已能工作；本章让它知道这个项目要求什么，并保留每份指令的来源。', status: 'ready' },
      { n: 5, slug: '05-sessions-compaction', title: '会话与压缩：保留事实，重建视图', summary: '前面消息只存在内存里；本章把它们变成持久事实，同时允许模型使用压缩后的请求副本。', status: 'ready' },
    ],
  },
  {
    id: 'p3', title: '控制与扩展', subtitle: '谁能决定 Agent 做什么',
    chapters: [
      { n: 6, slug: '06-permissions', title: '权限：谁有权决定一次效果', summary: '工具先完成参数校验，再把具体调用交给权限 gate；读取、编辑、未知效果和无界面等待各有明确结果。', status: 'ready' },
      { n: 7, slug: '07-hooks', title: 'Hook：扩展流水线的输入与失败', summary: '第 6 章已经知道谁授权；本章让团队策略在明确阶段参与处理，同时保留权限和工具验证的最终边界。', status: 'ready' },
      { n: 8, slug: '08-mcp', title: 'MCP：真实连接、发现、调用与退出', summary: '模型循环不关心工具来自哪里；本章把外部工具变成 Toolset 能消费的定义，并承担连接的整个生命周期。', status: 'ready' },
      { n: 9, slug: '09-skills', title: 'Skill：描述、正文与执行范围', summary: '工具解决能做什么，Skill 提供何时以及怎样做；本章将元数据与正文分开给模型消费。', status: 'ready' },
    ],
  },
  {
    id: 'p4', title: '多 Agent 与长任务', subtitle: '把工作分出去，让它一直做下去',
    chapters: [
      { n: 10, slug: '10-subagents', title: '子 Agent：缩小工具池并独立记账', summary: '用前面相同的 Engine 与 Toolset 创建子任务，明确它继承什么、隔离什么，以及取消从哪条信号链传递。', status: 'ready' },
      { n: 11, slug: '11-sandbox', title: '沙箱：把规则落到真实进程', summary: '权限决定是否接受调用，本章另做平台配置与系统探针，验证允许和禁止的效果是否真实发生。', status: 'ready' },
    ],
  },
  {
    id: 'p5', title: '工程化', subtitle: '把 Claude Code 当部件用',
    chapters: [
      { n: 12, slug: '12-headless-sdk', title: '无界面运行：输入、确认与 EOF', summary: '前面从函数调用驱动 Agent，本章让脚本通过 JSONL 驱动相同实现，并处理未完成确认和输入结束。', status: 'ready' },
      { n: 13, slug: '13-synthesis', title: '总装：修复一个真正失败的项目', summary: '复用所有前章接口，以真实项目、真实测试和真实 MCP 连接验收完整任务，最后重开会话检查恢复。', status: 'ready' },
    ],
  },
];

export const chapters = parts.flatMap(p => p.chapters.map(c => ({ ...c, part: p })));
