// 课程目录：网站导航、首页路线图和章节编号都来自这里。
// status: 'ready' 表示正文已完成；'planned' 会在路线图上显示为“编写中”。

/** 观察的对象：实验用的 Claude Code 版本 */
export const CC = { version: '2.1.296', docs: 'https://code.claude.com/docs' };

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
    id: 'p0', title: '开始之前', subtitle: '怎样研究一个看不到源码的 Agent',
    chapters: [
      { n: 0, slug: '00-method', title: '方法：文档、实验与对照', summary: '为什么不用泄露的源码；用开放模型驱动 Claude Code，截下它的请求，记下它的事件。', status: 'ready' },
    ],
  },
  {
    id: 'p1', title: '一次运行', subtitle: '从输入到结束',
    chapters: [
      { n: 1, slug: '01-one-run', title: '一次运行的全貌：事件流与会话文件', summary: 'stream-json 的每一种事件、会话 JSONL 的每一种记录，以及它们和 mox 的对应关系。', status: 'ready' },
      { n: 2, slug: '02-request', title: '发给模型的请求：系统提示、工具与缓存', summary: '用本地代理截下请求：里面有什么、多大、缓存断点放在哪里。', status: 'ready' },
      { n: 3, slug: '03-tools', title: '内置工具：每个工具的契约与边界', summary: '读、改、写、搜、执行：参数、结果的形状、限制和那些“必须先读再改”的规则。', status: 'ready' },
    ],
  },
  {
    id: 'p2', title: '上下文', subtitle: '记住什么、忘掉什么',
    chapters: [
      { n: 4, slug: '04-memory', title: 'CLAUDE.md 与自动记忆', summary: '哪些文件会被加载、以什么形式进入请求；自动记忆写在哪里。', status: 'ready' },
      { n: 5, slug: '05-sessions-compaction', title: '会话、恢复与压缩', summary: '恢复时逐字重放；压缩请求借用缓存；什么被保留、什么被重新读取；一次摘要出错的真实案例。', status: 'ready' },
    ],
  },
  {
    id: 'p3', title: '控制与扩展', subtitle: '谁能决定 Agent 做什么',
    chapters: [
      { n: 6, slug: '06-permissions', title: '权限与模式', summary: '五道关逐一验证：规则怎样匹配、钩子和规则谁说了算、六种模式、自动模式的两阶段分类器。', status: 'ready' },
      { n: 7, slug: '07-hooks', title: 'Hooks：每个事件的真实数据', summary: '同一份钩子配置交给真实模型：被拦下后它换了九种写法；钩子、规则、沙箱各能挡住什么。', status: 'ready' },
      { n: 8, slug: '08-mcp', title: 'MCP：工具搜索与推迟加载', summary: '在客户端和服务器之间窃听：握手、结果处理、列表变化对缓存的影响，以及工具搜索的 tool_reference。', status: 'ready' },
      { n: 9, slug: '09-skills', title: 'Skills 与命令', summary: '五种调用方式：正文怎样渲染、动态注入的坑、为什么授予权限的 Skill 调用前要批准。', status: 'ready' },
    ],
  },
  {
    id: 'p4', title: '多 Agent 与长任务', subtitle: '把工作分出去，让它一直做下去',
    chapters: [
      { n: 10, slug: '10-subagents', title: '子 Agent', summary: '三方的请求对比；前台的报告被标成“模型输出”，后台的完成后以通知开启新一轮。', status: 'ready' },
      { n: 11, slug: '11-sandbox', title: '沙箱', summary: '八条命令试探边界，再读开源的 sandbox-runtime：默认拒绝的 Seatbelt 策略、域名代理、藏在代理用户名里的调用 id。', status: 'ready' },
    ],
  },
  {
    id: 'p5', title: '工程化', subtitle: '把 Claude Code 当部件用',
    chapters: [
      { n: 12, slug: '12-headless-sdk', title: '无界面模式与 Agent SDK', summary: '窃听 SDK 与 Claude Code 之间的双向协议，再用开源的 Python 版 SDK 源码对照：审批、钩子、MCP 都是跨进程的回调。', status: 'ready' },
      { n: 13, slug: '13-synthesis', title: '总结：Claude Code、Pi 与 mox', summary: '一张结构图、一张数字表、七条原则、三方对照，以及五分钟讲清楚一个 coding agent。', status: 'ready' },
    ],
  },
];

export const chapters = parts.flatMap(p => p.chapters.map(c => ({ ...c, part: p })));
