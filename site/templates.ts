// 页面模板。所有页面共用同一套外壳：顶栏、课程目录、正文、本页目录。
import { CC, CC_SOURCE, OSS, PI, chapters, parts, type ChapterInfo, type PartInfo } from '../course/syllabus.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number) => String(n).padStart(2, '0');
const REPO = 'https://github.com/Jialei-03/learn-claude-code';

export function moxMark(size = 28) {
  return `<svg class="mox-mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><circle cx="30" cy="6" r="4" fill="var(--signal)"/><path d="M30 10v6" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><rect x="8" y="16" width="44" height="42" rx="19" fill="var(--paper)" stroke="currentColor" stroke-width="3.5"/><ellipse cx="30" cy="35" rx="15" ry="10.5" fill="currentColor"/><ellipse cx="24.5" cy="35" rx="2.8" ry="4" fill="var(--paper)"/><ellipse cx="35.5" cy="35" rx="2.8" ry="4" fill="var(--paper)"/><rect x="49" y="30" width="11" height="13" rx="3.5" fill="currentColor"/><path d="M52.5 34l4 5M56.5 34l-4 5" stroke="var(--signal)" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

export interface PageMeta {
  chapter: ChapterInfo & { part: PartInfo };
  frontmatter: Record<string, string | string[]>;
  headings: { level: number; id: string; text: string }[];
}

function head(title: string, description: string, base: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="icon" href="${base}static/product-icon.png" type="image/png">
<link rel="stylesheet" href="${base}static/style.css">
<script>document.documentElement.dataset.theme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');</script>
</head>`;
}

function topbar(base: string) {
  return `<header class="topbar">
  <button class="icon-btn nav-toggle" type="button" aria-label="打开课程目录"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
  <a class="brand" href="${base}index.html"><img class="product-icon" src="${base}static/product-icon.png" width="30" height="30" alt="Claude Code 原始图标"><span class="brand-name">Learn Claude Code</span></a>
  <div class="topbar-actions">
    <button class="search-btn" type="button" data-search-open><svg viewBox="0 0 24 24" width="16" height="16"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>搜索课程</span><kbd>⌘K</kbd></button>
    <a class="top-link" href="${base}interview.html">面试题库</a>
    <a class="top-link" href="${base}sources.html">源码索引</a>
    <a class="top-link" href="${base}map.html">工程地图</a>
    <button class="icon-btn theme-toggle" type="button" aria-label="切换深色模式"><svg class="sun" viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><svg class="moon" viewBox="0 0 24 24" width="18" height="18"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>
    <a class="icon-btn" href="${REPO}" target="_blank" rel="noopener" aria-label="GitHub 仓库"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 3 .8.1-.6.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg></a>
  </div>
</header>`;
}

function sidebar(base: string, current?: string) {
  const groups = parts.map(part => `<div class="nav-part">
    <div class="nav-part-title">${esc(part.title)}</div>
    <ol>${part.chapters.map(c => {
      const ready = c.status === 'ready';
      const cls = [c.slug === current ? 'current' : '', ready ? '' : 'planned'].filter(Boolean).join(' ');
      const inner = `<span class="nav-num">${num(c.n)}</span><span class="nav-title">${esc(c.title.split('：')[0])}</span>`;
      return `<li class="${cls}">${ready ? `<a href="${base}chapters/${c.slug}.html"${c.slug === current ? ' aria-current="page"' : ''}>${inner}</a>` : `<span class="nav-disabled" title="编写中">${inner}</span>`}</li>`;
    }).join('')}</ol>
  </div>`).join('');
  return `<nav class="sidebar" aria-label="课程目录"><div class="sidebar-inner">${groups}
  <p class="nav-pin">源码 Claude Code ${CC_SOURCE.version}<br>独立实验 ${CC.version}<br>对照 <a href="${PI.repo}/tree/${PI.commit}" target="_blank" rel="noopener">Pi ${PI.version}</a> · <a href="https://github.com/Jialei-03/learn-pi-agent" target="_blank" rel="noopener">mox</a></p></div></nav>`;
}

function searchDialog() {
  return `<div class="search-dialog" hidden role="dialog" aria-label="搜索课程"><div class="search-panel">
  <input type="search" placeholder="搜索章节、概念、源码文件……" aria-label="搜索">
  <ol class="search-results"></ol>
  <p class="search-hint"><kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 打开 · <kbd>Esc</kbd> 关闭</p>
</div></div>`;
}

function shell(base: string, current: string | undefined, main: string, toc = '', wide = false) {
  return `<body${wide ? ' class="wide"' : ''}>
${topbar(base)}
<div class="shell${toc ? ' has-toc' : ''}">
${sidebar(base, current)}
<main id="main">${main}</main>
${toc}
</div>
${searchDialog()}
<div class="scrim" hidden></div>
<script type="module" src="${base}static/app.js"></script>
</body>
</html>`;
}

const asList = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

export function layout(meta: PageMeta, content: string) {
  const { chapter, frontmatter: fm, headings } = meta;
  const ready = chapters.filter(c => c.status === 'ready');
  const index = ready.findIndex(c => c.slug === chapter.slug);
  const prev = ready[index - 1];
  const next = ready[index + 1];
  const learn = asList(fm.learn);
  const metaLine = [
    fm.time ? `<span>约 ${esc(String(fm.time).replace(/^约\s*/, ''))}</span>` : '',
    fm.prereq ? `<span>前置：${esc(String(fm.prereq))}</span>` : '',
  ].filter(Boolean).join('');
  const toc = headings.length
    ? `<aside class="toc" aria-label="本页目录"><div class="toc-inner"><div class="toc-title">本页内容</div><ol>${headings.map(h => `<li class="lvl-${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ol></div></aside>`
    : '';
  const pager = `<nav class="pager">${prev ? `<a class="prev" href="${prev.slug}.html"><small>← 上一章</small><span>${esc(prev.title)}</span></a>` : '<span></span>'}${next ? `<a class="next" href="${next.slug}.html"><small>下一章 →</small><span>${esc(next.title)}</span></a>` : '<span></span>'}</nav>`;
  const main = `<article class="chapter">
<header class="chapter-head">
  <p class="eyebrow">第 ${num(chapter.n)} 章<span>·</span>${esc(chapter.part.title)}${chapter.extend ? '<span>·</span>扩展章节' : ''}</p>
  <h1>${esc(chapter.title)}</h1>
  <p class="lede">${esc(chapter.summary)}</p>
  ${fm.motto ? `<p class="motto">${esc(String(fm.motto))}</p>` : ''}
  ${learn.length ? `<div class="objectives"><p class="objectives-title">本章目标</p><ul>${learn.map(l => `<li>${esc(l)}</li>`).join('')}</ul>${fm.build ? `<p class="objectives-build"><span>动手产出</span>${esc(String(fm.build))}</p>` : ''}</div>` : ''}
  ${metaLine ? `<p class="chapter-meta">${metaLine}</p>` : ''}
</header>
<div class="prose">
${content}
</div>
${pager}
</article>`;
  return head(`${num(chapter.n)} ${chapter.title} · Learn Claude Code`, chapter.summary, '../') + shell('../', chapter.slug, main, toc);
}

export function homePage() {
  const total = chapters.length;
  const done = chapters.filter(c => c.status === 'ready').length;
  const roadmap = parts.map(part => `<section class="road-part">
    <h3>${esc(part.title)}<small>${esc(part.subtitle)}</small></h3>
    <ol>${part.chapters.map(c => {
      const ready = c.status === 'ready';
      const body = `<span class="road-num">${num(c.n)}</span><span class="road-text"><strong>${esc(c.title)}</strong><span>${esc(c.summary)}</span></span>${c.extend ? '<span class="road-tag">扩展</span>' : ''}`;
      return `<li class="${ready ? 'ready' : 'planned'}">${ready ? `<a href="chapters/${c.slug}.html">${body}</a>` : `<div title="编写中">${body}</div>`}</li>`;
    }).join('')}</ol>
  </section>`).join('');

  const main = `<div class="home">
<section class="hero">
  <div class="hero-copy">
    <p class="eyebrow">Agent 工程课 · 第二部<span>·</span>源码 Claude Code ${CC_SOURCE.version}</p>
    <h1>拆开 Claude Code<br><span class="hero-sub">沿源码，读懂工程取舍</span></h1>
    <p class="hero-lead">以指定的 2.1.88 sourcemap 还原源码为主线，沿入口、状态和失败路径解释机制。每章定位到固定提交的函数与行号，再把 2.1.296 的实验观察单独对照。</p>
    <div class="hero-actions">
      <a class="btn primary" href="chapters/00-method.html">开始学习</a>
      <a class="btn-link" href="chapters/01-one-run.html">先看一次运行的全貌 →</a>
    </div>
  </div>
  <aside class="source-hero"><p>SOURCE READING · ${CC_SOURCE.version}</p><pre>CLI bootstrap
  ↓
query / queryLoop
  ↓
request → tools → context
  ↓
session · hooks · permissions</pre><p><a href="map.html">打开工程思维导图 →</a></p></aside>
</section>

<section class="pillars">
  <article><span class="pillar-num">01</span><h3>以源码为主线</h3><p>固定提交、函数与行号；还原文件逐字核对 sourcesContent。</p></article>
  <article><span class="pillar-num">02</span><h3>分清证据版本</h3><p>2.1.88 源码与 2.1.296 录制分区阅读，避免混淆实现和观察。</p></article>
  <article><span class="pillar-num">03</span><h3>三方对照</h3><p>同一个机制，Claude Code、Pi、mox 各怎么做，取舍在哪里。</p></article>
  <article><span class="pillar-num">04</span><h3>讲得出取舍</h3><p>每章附面试题和回答要点，汇总在<a href="interview.html">面试题库</a>。</p></article>
</section>

<section class="quickstart">
  <h2>先修课</h2>
  <p>这门课假设你学过（或者手边有）<a href="https://github.com/Jialei-03/learn-pi-agent">Learn Pi Agent</a>：Agent 循环、工具、上下文、会话这些概念那里有从零的实现。先准备指定还原源码，再读每章调用链。原有真实模型录制保留在可展开的 2.1.296 对照分区，构建只做离线分析，不启动模型服务。</p>
  <pre><code>git clone ${REPO}.git
cd learn-claude-code &amp;&amp; npm install
npm run setup:source
npm run build &amp;&amp; npm run serve</code></pre>
</section>

<section class="roadmap">
  <div class="roadmap-head"><h2>课程路线</h2><p>${done === total ? `全部 ${total} 章` : `已完成 ${done} / ${total} 章 · 灰色章节正在编写`}</p></div>
  ${roadmap}
</section>
</div>`;
  return head('Learn Claude Code · 拆开 Claude Code', '依据固定 sourcemap 还原源码与分版本实验，研究 Claude Code 的工程设计。', '') + shell('', undefined, main, '', true);
}

export function interviewPage(items: { chapter: string; title: string; question: string; answer: string }[]) {
  const byChapter = new Map<string, typeof items>();
  for (const item of items) byChapter.set(item.chapter, [...(byChapter.get(item.chapter) ?? []), item]);
  const sections = [...byChapter.entries()].map(([slug, list]) => {
    const c = chapters.find(ch => ch.slug === slug)!;
    return `<section class="iv-group"><h2 id="${slug}"><span class="h-num">${num(c.n)}</span>${esc(c.title)}</h2>${list.map(i => `<details class="interview"><summary><span class="iv-q">${esc(i.question)}</span></summary><div class="iv-a">${i.answer}</div></details>`).join('')}<p class="iv-back"><a href="chapters/${slug}.html">回到第 ${c.n} 章 →</a></p></section>`;
  }).join('');
  const main = `<article class="chapter plain-page"><header class="chapter-head"><p class="eyebrow">汇总</p><h1>面试题库</h1><p class="lede">每章末尾的面试题都汇总在这里，共 ${items.length} 道。先自己回答，再展开对照要点。要点不是标准答案，而是“回答里应该出现的关键判断”。</p></header><div class="prose">${sections}</div></article>`;
  return head('面试题库 · Learn Claude Code', 'Agent 工程面试题与回答要点', '') + shell('', undefined, main);
}

export function sourceIndexPage(citations: { source: string; chapter: string; title: string; file: string; start: number; end: number; url: string }[]) {
  // 三个来源：Pi（对照用的开源 Agent），以及 Anthropic 以开源许可发布的两个组件
  const sources = [
    { key: 'claude-code-sourcemap', name: `Claude Code ${CC_SOURCE.version} · sourcemap`, license: 'Anthropic 版权所有；非官方还原研究引用', repo: CC_SOURCE.repo, commit: CC_SOURCE.commit, note: '课程主源码；已核对 sourcesContent，一并标注 feature 和占位边界' },
    { key: 'pi', name: `Pi ${PI.version}`, license: 'MIT', repo: PI.repo, commit: PI.commit, note: '对照用的开源 Agent' },
    ...Object.entries(OSS).map(([key, o]) => ({ key, name: `${o.label} ${o.version}`, license: o.license, repo: o.repo, commit: o.commit, note: key === 'sandbox-runtime' ? 'Claude Code 的沙箱建在它上面' : 'Agent SDK 的 Python 实现，和第 12 章录制到的协议对照' })),
  ];
  const section = (src: typeof sources[number]) => {
    const list = citations.filter(c => c.source === src.key);
    if (!list.length) return '';
    const byFile = new Map<string, typeof citations>();
    for (const c of list) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
    const rows = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, cs]) =>
      `<tr><td><code>${esc(file)}</code></td><td>${cs.map(c => `<a href="${c.url}" target="_blank" rel="noopener">L${c.start}${c.end > c.start ? '–' + c.end : ''}</a>`).join(' ')}</td><td>${[...new Set(cs.map(c => c.chapter))].map(slug => { const ch = chapters.find(x => x.slug === slug)!; return `<a href="chapters/${slug}.html">${num(ch.n)}</a>`; }).join(' ')}</td></tr>`).join('');
    return `<h2>${esc(src.name)}</h2><p>${esc(src.note)} · ${esc(src.license)} · 固定提交 <a href="${src.repo}/tree/${src.commit}" target="_blank" rel="noopener">${src.commit.slice(0, 7)}</a></p><div class="table-wrap"><table class="source-table"><thead><tr><th>文件</th><th>定位行号</th><th>章节</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  const main = `<article class="chapter plain-page"><header class="chapter-head"><p class="eyebrow">汇总</p><h1>源码索引</h1><p class="lede">课程的主线是用户指定的 Claude Code 2.1.88 sourcemap 还原材料；开源组件与 Pi 是独立版本的对照。所有源码定位指向固定提交，主线文件还与 source map 的 sourcesContent 逐字核对。该还原材料不代表官方开源仓库。</p></header><div class="prose">${sources.map(section).join('')}</div></article>`;
  return head('源码索引 · Learn Claude Code', '课程摘录过的开源代码', '') + shell('', undefined, main);
}
