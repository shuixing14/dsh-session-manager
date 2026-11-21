// Regenerate the README screenshots with FICTIONAL content — never the user's real sessions.
// Renders three HTML mocks with headless Edge at 2x.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve('.')
const OUT = path.join(ROOT, 'research', 'mock')
fs.mkdirSync(OUT, { recursive: true })

// ---------- 1. extract the real dialog stylesheet from client.js ----------
const source = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
const start = source.indexOf('const STYLESHEET = [')
const end = source.indexOf('].join', start)
const chunk = source.slice(start, end)
const rules = []
let index = 0
while (index < chunk.length) {
  const open = chunk.indexOf("'", index)
  if (open === -1) break
  let cursor = open + 1
  let value = ''
  while (cursor < chunk.length) {
    const ch = chunk[cursor]
    if (ch === '\\') {
      value += chunk[cursor + 1]
      cursor += 2
      continue
    }
    if (ch === "'") break
    value += ch
    cursor += 1
  }
  rules.push(value)
  index = cursor + 1
}
fs.writeFileSync(path.join(OUT, 'dialog.css'), rules.join('\n'))

const BASE_CSS = `
  :root {
    --dsw-alias-bg-base: #ffffff; --dsw-alias-bg-layer-1: #ffffff; --dsw-alias-bg-layer-2: #f7f8fa;
    --dsw-alias-label-primary: #1f2328; --dsw-alias-label-secondary: #6b7280;
    --dsw-alias-border-l2: rgba(0,0,0,.10); --dsw-alias-brand-primary: #4f7cff;
    --dsw-alias-brand-bg-subtle: rgba(79,124,255,.14);
    --dsw-alias-state-error-primary: #dc2626; --dsw-alias-state-success-primary: #16a34a;
    --dsw-alias-state-warning-primary: #b45309; --dsw-alias-interactive-bg-hover: #eceef2;
  }
  html, body { margin: 0; height: 100%; }
  body { background: radial-gradient(1200px 600px at 20% 0%, #eef2ff 0%, #f6f7f9 45%, #eef0f3 100%);
    font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, -apple-system, sans-serif;
    display: flex; align-items: center; justify-content: center; padding: 46px 40px; box-sizing: border-box; }
  .stage { width: 980px; }
  .window { border-radius: 14px; background: #fff; overflow: hidden;
    box-shadow: 0 30px 80px rgba(15,23,42,.22), 0 2px 6px rgba(15,23,42,.08);
    border: 1px solid rgba(15,23,42,.08); }
  .titlebar { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
    background: #f7f8fa; border-bottom: 1px solid rgba(15,23,42,.07); }
  .dot { width: 11px; height: 11px; border-radius: 50%; }
  .dot.r { background: #ff6058; } .dot.y { background: #ffbd2e; } .dot.g { background: #28c941; }
  .titlebar .app { margin-left: 8px; font-size: 12px; color: #8b93a1; }
  .body { padding: 18px 20px 16px; }
  .caption { margin: 18px 4px 0; font-size: 12.5px; color: #5b6472; }
  .caption b { color: #1f2328; }
  .caption .kbd { font: 11px/1.4 ui-monospace, Menlo, monospace; background:#fff;
    border:1px solid rgba(15,23,42,.14); border-bottom-width:2px; border-radius:5px; padding:1px 5px; color:#3b4250; }
  .dsm-list { list-style: none; margin: 0; padding: 0; overflow: auto; max-height: 372px; }
  .dsm-results-list { list-style: none; margin: 0; padding: 0; }
  .dsm-result-mark.ok { color: var(--dsw-alias-state-success-primary); }
  .dsm-results-title { margin: 0 0 4px; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary); }
  .dsm-results-summary { margin: 0 0 6px; font-size: 12px; }
  .dsm-results-backup { margin: 8px 0 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
  .dsm-result-row { padding: 2px 0; }
`

const PAGE = (title, extraCss, body) =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>${title}</title>` +
  `<link rel="stylesheet" href="dialog.css" /><style>${BASE_CSS}${extraCss}</style></head><body>${body}</body></html>`

const WINDOW = (inner) =>
  `<div class="window"><div class="titlebar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="app">DeepSeek Harness · 插件预览</span></div><div class="body">${inner}</div></div>`

const MODAL = (inner) => `<div class="dsm-modal" role="dialog" aria-modal="true" style="width:100%;max-height:none;box-shadow:none;border:0;padding:0">${inner}</div>`

const HEAD = `<div class="dsm-head"><h2 class="dsm-title">删除会话</h2><button class="dsm-iconbtn dsm-close" type="button" aria-label="关闭">✕</button></div>`

const DESC = (backup) =>
  `<p class="dsm-desc">勾选要永久删除的会话。删除会移除会话日志、索引缓存与工作区记录；默认先备份到 <code>${backup}</code>，之后可从备份里还原。</p>`

// ---------- 2. dialog (list state) ----------
const row = ({ title, id, badges = '', metas = [], child = false, parent = false, checked = false }) =>
  `<li class="dsm-row${parent ? ' dsm-row-parent' : ''}${child ? ' dsm-row-child' : ''}${checked ? ' dsm-row-on' : ''}">
    <label class="dsm-row-label">
      <span class="dsm-check"><input type="checkbox" class="dsm-check-input"${checked ? ' checked' : ''} /><span class="dsm-check-mark" aria-hidden="true">✓</span></span>
      <span class="dsm-row-body">
        <span class="dsm-row-titleline">
          <span class="dsm-row-title">${title}</span>
          <span class="dsm-row-id">${id}</span>
          ${badges}
        </span>
        <span class="dsm-row-meta">${metas.join('')}</span>
      </span>
    </label>
  </li>`

const meta = (text, kind) => `<span class="dsm-meta-part${kind ? ' ' + kind : ''}">${text}</span>`

const dialogRows = [
  row({
    title: '示例项目 · 索引重构',
    id: 'session-7f3a91c2…',
    badges: '<span class="dsm-badge dsm-badge-parent">含 2 个子会话</span>',
    checked: true,
    parent: true,
    metas: [
      meta('最后使用 2026-11-21 20:52 · 12 分钟前', 'dsm-meta-time dsm-meta-lastused'),
      meta('创建于 2026-11-02 09:14', 'dsm-meta-time dsm-meta-created'),
      meta('D:/work/example'),
      meta('1.9 MB'),
    ],
  }),
  row({
    title: '梳理索引构建流程',
    id: 'session-2b8d4e6f…',
    child: true,
    badges: '<span class="dsm-badge dsm-badge-child">↳ 子会话</span>',
    metas: [
      meta('最后使用 2026-11-21 20:48 · 16 分钟前', 'dsm-meta-time dsm-meta-lastused'),
      meta('父会话：示例项目 · 索引重构', 'dsm-meta-parent'),
    ],
  }),
  row({
    title: '文档整理批处理',
    id: 'session-9c1e5a7b…',
    checked: true,
    badges: '<span class="dsm-badge dsm-badge-archived">已归档</span>',
    metas: [
      meta('最后使用 2026-11-21 20:33 · 31 分钟前', 'dsm-meta-time dsm-meta-lastused'),
      meta('创建于 2026-10-18 21:06', 'dsm-meta-time dsm-meta-created'),
      meta('817 KB'),
    ],
  }),
  row({
    title: 'API 迁移计划',
    id: 'session-4e6b2a8d…',
    metas: [
      meta('最后使用 2026-11-20 22:27 · 22 小时前', 'dsm-meta-time dsm-meta-lastused'),
      meta('创建于 2026-10-31 20:08', 'dsm-meta-time dsm-meta-created'),
      meta('381 KB'),
    ],
  }),
  row({
    title: '（未命名会话）',
    id: 'session-0d3c7b1e…',
    badges: '<span class="dsm-badge dsm-badge-orphan">残留记录</span>',
    metas: [meta('最后使用 2026-10-17 12:24', 'dsm-meta-time'), meta('394 B')],
  }),
  row({
    title: '发布检查清单',
    id: 'session-6a9f3e2c…',
    child: true,
    badges: '<span class="dsm-badge dsm-badge-child">↳ 子会话</span>',
    metas: [
      meta('最后使用 2026-11-07 18:49', 'dsm-meta-time dsm-meta-lastused'),
      meta('父会话：示例项目 · 索引重构', 'dsm-meta-parent'),
    ],
  }),
]

const listBody =
  `<div class="stage">${WINDOW(MODAL(
    HEAD +
      DESC('C:\\Users\\you\\.dsh\\session-delete-backup\\&lt;timestamp&gt;/') +
      `<div class="dsm-search" style="margin-bottom:10px"><span class="dsm-search-icon" aria-hidden="true">⌕</span><input type="search" class="dsm-search-input" placeholder="按标题或路径搜索会话…" /></div>
      <div class="dsm-toolbar">
        <label class="dsm-all"><span class="dsm-check dsm-check-sm"><input type="checkbox" class="dsm-check-input" /><span class="dsm-check-mark" aria-hidden="true">✓</span></span><span class="dsm-all-text">全选</span></label>
        <label class="dsm-scope"><input type="checkbox" class="dsm-scope-input" /><span class="dsm-scope-text">不在侧边栏（7）</span></label>
        <span class="dsm-toolbar-note">已选 2 项<span class="dsm-channel">通道：HTTP 桥</span></span>
        <span class="dsm-toolbar-actions"><button class="dsm-btn dsm-btn-ghost" type="button">全不选</button><button class="dsm-btn dsm-btn-ghost dsm-btn-refresh" type="button">⟳ 刷新列表</button></span>
      </div>
      <ul class="dsm-list" role="group" aria-label="会话列表">${dialogRows.join('')}</ul>
      <footer class="dsm-foot">
        <div class="dsm-foot-left">
          <label class="dsm-toggle"><input type="checkbox" class="dsm-toggle-input" checked /><span class="dsm-toggle-track" aria-hidden="true"><span class="dsm-toggle-thumb"></span></span><span class="dsm-toggle-text">删除前备份</span></label>
          <label class="dsm-toggle"><input type="checkbox" class="dsm-toggle-input" /><span class="dsm-toggle-track" aria-hidden="true"><span class="dsm-toggle-thumb"></span></span><span class="dsm-toggle-text">强制删除运行中的会话</span></label>
        </div>
        <span class="dsm-foot-hint">删除后无法从列表中恢复，只能从备份目录还原。</span>
        <div class="dsm-foot-actions"><button class="dsm-btn dsm-btn-quiet" type="button">取消</button><button class="dsm-btn dsm-btn-danger" type="button">删除</button></div>
      </footer>`,
  ))}<div class="caption"><b>删除会话</b> · 搜索 + 多选 + 最后使用时间 + 父子关系 + 备份开关 <span class="kbd">⋯ → 删除会话</span></div></div>`

// ---------- 3. result state ----------
const resultBody = `<div class="stage">${WINDOW(MODAL(
  HEAD +
    DESC('C:\\Users\\you\\.dsh\\session-delete-backup\\2026-11-21T21-04-12/') +
    `<div class="dsm-notice" role="status">已刷新侧边栏会话列表</div>
     <div class="dsm-results">
       <p class="dsm-results-title">删除结果</p>
       <p class="dsm-results-summary">成功 3 项，失败 1 项。</p>
       <ul class="dsm-results-list">
         <li class="dsm-result-row"><span class="dsm-result-mark ok">✓</span><span class="dsm-result-msg">session-7f3a91c2… · 已删除</span></li>
         <li class="dsm-result-row"><span class="dsm-result-mark ok">✓</span><span class="dsm-result-msg">session-9c1e5a7b… · 已删除</span></li>
         <li class="dsm-result-row"><span class="dsm-result-mark ok">✓</span><span class="dsm-result-msg">session-0d3c7b1e… · 已删除</span></li>
         <li class="dsm-result-row"><span class="dsm-result-mark">✗</span><span class="dsm-result-msg">session-4e6b2a8d… · 会话正在运行，请先停止它，或勾选“强制删除”</span></li>
       </ul>
       <p class="dsm-results-backup">备份目录：C:/Users/you/.dsh/session-delete-backup/2026-11-21T21-04-12</p>
       <p class="dsm-results-hint">界面列表可能需要刷新或重启后才会完全消失。</p>
     </div>
     <footer class="dsm-foot" style="margin-top:12px">
       <span class="dsm-foot-hint">删除后无法从列表中恢复，只能从备份目录还原。</span>
       <div class="dsm-foot-actions"><button class="dsm-btn dsm-btn-quiet" type="button">取消</button><button class="dsm-btn dsm-btn-primary" type="button">完成</button></div>
     </footer>`,
))}<div class="caption"><b>删除结果</b> · 每个 id 的成功 / 失败原因、备份目录、以及「已刷新侧边栏会话列表」提示</div></div>`

// ---------- 4. row menu state ----------
const MENU_CSS = `
  body { align-items: center; }
  .stage { display: flex; gap: 34px; align-items: flex-start; width: auto; }
  .side { width: 322px; background: #fbfbfd; border: 1px solid rgba(15,23,42,.09); border-radius: 14px;
    box-shadow: 0 24px 60px rgba(15,23,42,.16), 0 2px 6px rgba(15,23,42,.06); }
  .side-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid rgba(15,23,42,.09); }
  .brand { width: 18px; height: 18px; border-radius: 6px; background: linear-gradient(135deg, #5b8cff, #8b5cf6); }
  .side-head .name { font-size: 13px; font-weight: 600; color: #1f2328; }
  .side-head .spacer { flex: 1; } .side-head .plus { color: #6b7280; font-size: 16px; }
  .group { padding: 10px 10px 14px; }
  .group-title { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6b7280; padding: 6px; }
  .srow { position: relative; display: flex; align-items: center; gap: 8px; border-radius: 8px; padding: 7px 8px; font-size: 12.5px; color: #333a45; }
  .srow .sdot { width: 6px; height: 6px; border-radius: 50%; background: #c2c8d2; flex: none; }
  .srow .stitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow.active { background: #e9edf5; font-weight: 600; }
  .srow .stime { font-size: 11px; color: #6b7280; }
  .srow .more { color: #6b7280; font-size: 15px; letter-spacing: 1px; }
  .srow.hover .more { color: #1f2328; }
  .menu { position: absolute; top: 30px; right: 6px; z-index: 5; width: 208px; background: #fff;
    border: 1px solid rgba(15,23,42,.09); border-radius: 10px; padding: 5px;
    box-shadow: 0 18px 44px rgba(15,23,42,.22), 0 2px 8px rgba(15,23,42,.10); }
  .mitem { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 7px; font-size: 12.5px; color: #1f2328; }
  .mitem .ico { width: 15px; text-align: center; color: #6b7280; font-family: "Segoe UI Symbol", system-ui; }
  .mitem.hl { background: rgba(220,38,38,.08); color: #dc2626; font-weight: 600; }
  .mitem.hl .ico { color: #dc2626; }
  .msep { height: 1px; background: rgba(15,23,42,.09); margin: 5px 4px; }
  .mitem .kbd { margin-left: auto; font-size: 10.5px; color: #9aa2ae; }
  .hint { width: 420px; padding-top: 8px; }
  .hint h3 { margin: 0 0 8px; font-size: 15px; color: #1f2328; }
  .hint p { margin: 0 0 10px; font-size: 12.5px; line-height: 1.75; color: #4b5563; }
  .hint code { font: 11.5px/1.5 ui-monospace, Menlo, monospace; background: #fff; border: 1px solid rgba(15,23,42,.09); border-radius: 5px; padding: 1px 5px; color: #3b4250; }
  .badge { display: inline-flex; align-items: center; gap: 5px; margin-right: 6px; padding: 2px 8px; border-radius: 999px; background: rgba(79,124,255,.12); color: #4f7cff; font-size: 11.5px; font-weight: 600; }
`

const menuBody = `<div class="stage">
  <div class="side">
    <div class="side-head"><span class="brand"></span><span class="name">DeepSeek Harness</span><span class="spacer"></span><span class="plus">＋</span></div>
    <div class="group">
      <div class="group-title"><span>▾</span> example</div>
      <div class="srow active"><span class="sdot"></span><span class="stitle">示例项目 · 索引重构</span><span class="more">⋯</span></div>
      <div class="srow"><span class="sdot"></span><span class="stitle">梳理索引构建流程</span><span class="stime">20:48</span></div>
      <div class="srow hover"><span class="sdot"></span><span class="stitle">文档整理批处理</span><span class="more">⋯</span>
        <div class="menu" role="menu">
          <div class="mitem"><span class="ico">⬆</span>置顶会话</div>
          <div class="mitem"><span class="ico">✎</span>重命名</div>
          <div class="mitem"><span class="ico">⑂</span>分叉会话</div>
          <div class="mitem"><span class="ico">▣</span>归档</div>
          <div class="msep"></div>
          <div class="mitem"><span class="ico">#</span>复制会话 ID</div>
          <div class="mitem hl"><span class="ico">⌫</span>删除会话<span class="kbd">插件</span></div>
        </div>
      </div>
      <div class="srow"><span class="sdot"></span><span class="stitle">API 迁移计划</span><span class="stime">昨天</span></div>
      <div class="srow"><span class="sdot"></span><span class="stitle">发布检查清单</span><span class="stime">11-07</span></div>
      <div class="srow"><span class="sdot"></span><span class="stitle">（未命名会话）</span><span class="stime">10-24</span></div>
    </div>
  </div>
  <div class="hint">
    <h3>入口就在会话行的「⋯」菜单里</h3>
    <p>点 <code>删除会话</code> 会打开对话框并<b>预先勾选这一条会话</b>；侧栏底部的按钮则用于批量清理。</p>
    <p><span class="badge">↳ 子会话</span>子代理/协作会话会标注父会话；<span class="badge" style="background:rgba(220,38,38,.09);color:#dc2626">含 N 个子会话</span>父会话显示子会话数量。</p>
    <p style="color:#6b7280">「未分组」里本来就是子代理会话 —— 它们从不属于某个工作区，不是删除残留。</p>
  </div>
</div>`

// ---------- 5. write + render ----------
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const pages = [
  { file: 'dialog.html', html: PAGE('dsh-session-manager · 删除会话', '', listBody), out: 'screenshot-dialog.png', size: '1080,900' },
  { file: 'result.html', html: PAGE('dsh-session-manager · 删除结果', '', resultBody), out: 'screenshot-result.png', size: '1020,700' },
  { file: 'menu.html', html: PAGE('dsh-session-manager · 会话行菜单', MENU_CSS, menuBody), out: 'screenshot-menu.png', size: '1120,720' },
]

for (const page of pages) {
  const htmlPath = path.join(OUT, page.file)
  fs.writeFileSync(htmlPath, page.html, 'utf8')
  const target = path.join(ROOT, 'docs', page.out)
  execFileSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      `--window-size=${page.size}`,
      `--screenshot=${target}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore' },
  )
  console.log('rendered', page.out, fs.statSync(target).size, 'bytes')
}
