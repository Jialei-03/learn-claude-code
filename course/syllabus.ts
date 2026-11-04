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
    id: 'p0', title: '开始之前', subtitle: '先学会读，再开始拆',
    chapters: [
      { n: 0, slug: '00-method', title: '导读：怎样读五十万行还原源码', summary: '这份源码从哪来、缺什么；从 claude 命令追到主循环；认出编译期开关；以及这门课用来验证结论的录制和实验。', status: 'ready' },
    ],
  },
  {
    id: 'p1', title: '一次运行', subtitle: '从输入到结束',
    chapters: [
      { n: 1, slug: '01-one-run', title: '主循环：queryLoop 的状态与出口', summary: '一次回车请求几次模型？沿 queryLoop 的 State 读懂七个继续位置和十个出口：工具结果、截断后的续写、Stop Hook、中止与运行中排队的消息，并和 Pi 的 runLoop 对照。', status: 'ready' },
      { n: 2, slug: '02-request', title: '请求构造：模型每一轮收到的是什么', summary: '把提示、上下文、工具定义和历史拼成一个请求，要同时回答放什么、放在哪里才不毁掉缓存。', status: 'ready' },
      { n: 3, slug: '03-tools', title: '工具执行：分批、关卡与文件版本', summary: '一条回复里的调用哪些能同时跑，一个调用执行前要过哪几道关，Edit 怎样确认文件没过期，大输出去了哪里。', status: 'ready' },
    ],
  },
  {
    id: 'p2', title: '上下文', subtitle: '记住什么、忘掉什么',
    chapters: [
      { n: 4, slug: '04-memory', title: '项目记忆：从 CLAUDE.md 到请求里的第一条消息', summary: '一份规则怎样被找到、展开 @ 引用、按需加载，最后放进请求的哪个位置。', status: 'ready' },
      { n: 5, slug: '05-sessions-compaction', title: '会话与压缩：文件只追加，请求靠重建', summary: '会话文件记下发生过的事，每次请求的消息从它重建；自动压缩、microcompact 和摘要请求只改变视图，不碰文件里的事实。', status: 'ready' },
    ],
  },
  {
    id: 'p3', title: '控制与扩展', subtitle: '谁能决定 Agent 做什么',
    chapters: [
      { n: 6, slug: '06-permissions', title: '权限：一次调用怎样得到 allow、ask 或 deny', summary: '沿 hasPermissionsToUseTool 读决策顺序（规则、安全检查、bypass、allow），再看钩子、模式和无人可问时的结局，并在 coda 里实现三段决策。', status: 'ready' },
      { n: 7, slug: '07-hooks', title: 'Hook：事件、匹配与失败时放行', summary: '读懂 Hook 怎样被匹配、并行运行，输出怎样拦下、改写或补话，以及它自己出错时为什么放行。', status: 'ready' },
      { n: 8, slug: '08-mcp', title: 'MCP：配置、连接、包装与退出', summary: '一个 MCP 服务器怎样被信任、连接、包装成工具、被调用并转换结果，最后被收走。', status: 'ready' },
      { n: 9, slug: '09-skills', title: 'Skill：常驻一行目录，调用时才渲染正文', summary: '模型平时只看到每个 Skill 的一行描述；调用时才渲染正文，并把 allowed-tools 变成这一轮的授权；fork 时交给子 Agent。', status: 'ready' },
    ],
  },
  {
    id: 'p4', title: '多 Agent 与长任务', subtitle: '把工作分出去，让它一直做下去',
    chapters: [
      { n: 10, slug: '10-subagents', title: '子 Agent：一张任务单进去，一份报告出来', summary: '拆开 Agent 工具怎样缩小工具池、隔离上下文、交回报告并传递取消，并确认发布版里 fork、verification 等路径走不走得到。', status: 'ready' },
      { n: 11, slug: '11-sandbox', title: '沙箱：规则变成配置，配置变成内核的拒绝', summary: '权限规则怎样被翻译成沙箱配置，Bash 命令怎样被包进 seatbelt 或 bubblewrap，网络怎样经代理按域名放行，以及沙箱在什么时候会被绕过。', status: 'ready' },
    ],
  },
  {
    id: 'p5', title: '工程化与总装', subtitle: '把 Claude Code 当部件用，再把部件装回去',
    chapters: [
      { n: 12, slug: '12-headless-sdk', title: '无界面运行：请求配对、EOF 与取消', summary: '无界面时没人可问，权限确认变成带 request_id 的跨进程请求；读 -p、stream-json 与 can_use_tool 往返，弄清 EOF、interrupt 各自怎么收场，再对照 Python SDK 与 Pi RPC。', status: 'ready' },
      { n: 13, slug: '13-synthesis', title: '总装与对照：十二个机制挂在主循环哪里', summary: '沿 main.tsx、QueryEngine、query() 读 Claude Code 怎样装配前十二章的机制；在 coda 里把各章的缝接上，修好一个真正失败的测试；最后用四方对照和十条原则收束。', status: 'ready' },
    ],
  },
];

export const chapters = parts.flatMap(p => p.chapters.map(c => ({ ...c, part: p })));
