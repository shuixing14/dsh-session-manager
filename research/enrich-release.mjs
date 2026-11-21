// Enrich the v0.2.0 release page: screenshot + highlights.
const TOKEN = process.env.GH_TOKEN || ''
if (!TOKEN) {
  console.error('missing GH_TOKEN')
  process.exit(2)
}

const REPO = 'shuixing14/dsh-session-manager'
const RAW = `https://raw.githubusercontent.com/${REPO}/main/docs`

const body = [
  '## 🗑️ dsh-session-manager 0.2.0',
  '',
  '**在 DeepSeek Harness 里真正删除聊天会话** —— 备份优先，删完自动刷新列表。',
  '',
  `![删除会话对话框](${RAW}/screenshot-dialog.png)`,
  '',
  '### 本版亮点',
  '',
  '- **最后使用时间**：每行显示「最后使用 + 创建于」两个本地绝对时间，按最后使用排序，搜索可匹配时间。',
  '- **删除后不再暂存到「未分组」**：宿主先删磁盘 → `Workspace.detachSession()` → 清 pinned/archived → 广播 `api-session/removed`，页面立即少一行。',
  '- **强制刷新会话列表**：前端用 `ctx.inject([\'sessions\'])` 取得刷新入口，删除后立即 `sessions.refresh()`，并在 700 ms 后补一次。',
  '- 修复：收起「不在侧边栏」作用域时会清理刚被隐藏的选择（避免误删看不见的会话）。',
  '- 修复：刷新提示条不再被随后的列表加载抹掉；空删除请求不再创建空备份目录。',
  '',
  '### 界面',
  '',
  '| 会话行「⋯」菜单 | 删除结果 |',
  '| --- | --- |',
  `| ![menu](${RAW}/screenshot-menu.png) | ![result](${RAW}/screenshot-result.png) |`,
  '',
  '### 安装',
  '',
  '```bash',
  'plugin_manager install_bundle  target: <本仓库目录>',
  '# 或',
  'dsh plugin --profile desktop add ./dsh-session-manager-0.2.0.tgz',
  '```',
  '',
  '装完刷新一次页面。详细说明见 [README](https://github.com/shuixing14/dsh-session-manager#readme)，变更见 [CHANGELOG](https://github.com/shuixing14/dsh-session-manager/blob/main/CHANGELOG.md)。',
  '',
  '### 附件',
  '',
  '- `dsh-session-manager-0.2.0.tgz` — npm 包（9 个文件，约 62 KB）',
  '',
].join('\n')

const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'user-agent': 'dsh-session-manager-release-edit',
}

const found = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v0.2.0`, { headers })
if (!found.ok) {
  console.error('release not found', found.status)
  process.exit(1)
}
const release = await found.json()
const patched = await fetch(`https://api.github.com/repos/${REPO}/releases/${release.id}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ body }),
})
console.log('patch release', patched.status)
