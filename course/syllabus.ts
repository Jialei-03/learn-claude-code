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
      { n: 0, slug: '00-method', title: '方法：源码、版本与证据', summary: '固定 sourcemap 2.1.88 的提交，建立函数与调用链证据；把 2.1.296 实验单独标记。', status: 'ready' },
    ],
  },
  {
    id: 'p1', title: '一次运行', subtitle: '从输入到结束',
    chapters: [
      { n: 1, slug: '01-one-run', title: '一次运行：启动、主循环与状态', summary: '从 CLI 快速分支追到 queryLoop，区分迭代状态、事件交付和持久记录。', status: 'ready' },
      { n: 2, slug: '02-request', title: '模型请求：提示合成与 API 参数', summary: '读 system prompt 来源优先级与最终 messages、tools、缓存参数构造。', status: 'ready' },
      { n: 3, slug: '03-tools', title: '工具：调度、校验与编辑契约', summary: '并发批次如何划分，参数在哪一层被拒绝，Edit 怎样保证先读后改。', status: 'ready' },
    ],
  },
  {
    id: 'p2', title: '上下文', subtitle: '记住什么、忘掉什么',
    chapters: [
      { n: 4, slug: '04-memory', title: 'CLAUDE.md 与记忆注入', summary: '从 include 递归和去重，到类型过滤与最终上下文投影。', status: 'ready' },
      { n: 5, slug: '05-sessions-compaction', title: '会话、恢复与压缩', summary: '转录存储、窗口阈值、失败断路器和压缩后消息重建。', status: 'ready' },
    ],
  },
  {
    id: 'p3', title: '控制与扩展', subtitle: '谁能决定 Agent 做什么',
    chapters: [
      { n: 6, slug: '06-permissions', title: '权限：规则阶段与最终决策', summary: '追踪 deny、ask、工具专用检查和模式分支，避免把局部结果当最终授权。', status: 'ready' },
      { n: 7, slug: '07-hooks', title: 'Hooks：匹配、输入与失败边界', summary: '把工具校验顺序、Hook 选择与真实执行阶段连起来。', status: 'ready' },
      { n: 8, slug: '08-mcp', title: 'MCP：发现、调用与结果适配', summary: '检查配置、连接、工具发现、模型可见性和多模态结果转换。', status: 'ready' },
      { n: 9, slug: '09-skills', title: 'Skills：metadata 与执行入口', summary: '解析工具权限、模型、fork 等字段，再追 SkillTool 如何查找和展开。', status: 'ready' },
    ],
  },
  {
    id: 'p4', title: '多 Agent 与长任务', subtitle: '把工作分出去，让它一直做下去',
    chapters: [
      { n: 10, slug: '10-subagents', title: '子 Agent：上下文与生命周期', summary: '读子任务 schema、工具池、模型选择、前后台和取消边界。', status: 'ready' },
      { n: 11, slug: '11-sandbox', title: '沙箱：配置适配与命令包装', summary: '从产品权限规则到 sandbox runtime 参数，分清配置与系统执行证据。', status: 'ready' },
    ],
  },
  {
    id: 'p5', title: '工程化', subtitle: '把 Claude Code 当部件用',
    chapters: [
      { n: 12, slug: '12-headless-sdk', title: '无界面与 SDK：协议和实现边界', summary: '读 Headless 与 StructuredIO，并识别 SDK 类型入口中的占位实现。', status: 'ready' },
      { n: 13, slug: '13-synthesis', title: '总结：源码地图与工程面试', summary: '对照三项目的源码版本、验证范围和架构取舍，用一个反例讲清机制。', status: 'ready' },
    ],
  },
];

export const chapters = parts.flatMap(p => p.chapters.map(c => ({ ...c, part: p })));
