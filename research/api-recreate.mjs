// Recreate the GitHub repository from the current working tree, with clean history.
//
//   1. delete the repository (needs the `delete_repo` scope),
//   2. create it again with the same description/topics,
//   3. push the current tree as a single root commit,
//   4. recreate tag v<version>, the release and its tarball asset.
//
// usage: node api-recreate.mjs --repo owner/name --version 0.2.0 --tarball ./x.tgz
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const REPO = arg('repo')
const VERSION = arg('version')
const TARBALL = arg('tarball')
const ROOT = path.resolve(arg('root', '.'))
const TOKEN = process.env.GH_TOKEN || ''
if (!REPO || !VERSION || !TARBALL || !TOKEN) {
  console.error('missing --repo/--version/--tarball/GH_TOKEN')
  process.exit(2)
}

const [OWNER, NAME] = REPO.split('/')
const API = 'https://api.github.com'
const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${TOKEN}`,
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
  'user-agent': 'dsh-session-manager-recreate',
}

async function call(method, url, body, extraHeaders) {
  let lastError = null
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${API}${url}`, {
        method,
        headers: { ...headers, ...(extraHeaders || {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      if (!response.ok) {
        lastError = new Error(`${method} ${url} -> ${response.status} ${text.slice(0, 400)}`)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) throw lastError
      } else {
        return text === '' ? null : JSON.parse(text)
      }
    } catch (error) {
      lastError = error
      if (/-> 4\d\d /.test(String(error.message))) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 1200 * attempt))
  }
  throw lastError
}

// ---------- 1. remember metadata ----------
let description = 'DeepSeek Harness 插件'
let topics = ['dsh', 'dsh-plugin']
try {
  const repo = await call('GET', `/repos/${REPO}`)
  description = repo.description ?? description
  topics = Array.isArray(repo.topics) && repo.topics.length > 0 ? repo.topics : topics
  console.log('remembered description/topics from the existing repository')
} catch {
  console.log('repository does not exist yet, continuing')
}

// ---------- 2. delete ----------
const deleted = await call('DELETE', `/repos/${REPO}`).catch((error) => {
  console.error('DELETE failed:', error.message)
  process.exit(1)
})
console.log('deleted (expected null):', deleted)

// Give GitHub a moment to release the name.
await new Promise((resolve) => setTimeout(resolve, 4000))

// ---------- 3. create ----------
const created = await call('POST', '/user/repos', {
  name: NAME,
  description,
  private: false,
  has_issues: true,
  has_projects: false,
  has_wiki: false,
  auto_init: false,
})
console.log('created', created.html_url)

// ---------- 4. single root commit with the current tree ----------
const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\u0000')
  .filter(Boolean)

const entries = []
for (const file of files) {
  const buffer = fs.readFileSync(path.join(ROOT, file))
  const blob = await call('POST', `/repos/${REPO}/git/blobs`, { content: buffer.toString('base64'), encoding: 'base64' })
  entries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
}
const tree = await call('POST', `/repos/${REPO}/git/trees`, { tree: entries })
const commit = await call('POST', `/repos/${REPO}/git/commits`, {
  message: `dsh-session-manager ${VERSION}\n\nClean-history import: DeepSeek Harness 插件，用于真正删除聊天会话（备份优先、删完自动刷新列表）。`,
  tree: tree.sha,
  parents: [],
})
await call('POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/main', sha: commit.sha })
console.log('root commit', commit.sha, 'files', entries.length)

// ---------- 5. tag ----------
const tagObject = await call('POST', `/repos/${REPO}/git/tags`, {
  tag: `v${VERSION}`,
  message: `dsh-session-manager ${VERSION}`,
  object: commit.sha,
  type: 'commit',
})
await call('POST', `/repos/${REPO}/git/refs`, { ref: `refs/tags/v${VERSION}`, sha: tagObject.sha })
console.log('tag', `v${VERSION}`)

// ---------- 6. release + asset ----------
const README_RAW = `https://raw.githubusercontent.com/${REPO}/main/docs`
const body = [
  `## 🗑️ dsh-session-manager ${VERSION}`,
  '',
  '**在 DeepSeek Harness 里真正删除聊天会话** —— 备份优先，删完自动刷新列表。',
  '',
  `![删除会话对话框](${README_RAW}/screenshot-dialog.png)`,
  '',
  '### 亮点',
  '',
  '- **最后使用时间**：每行显示「最后使用 + 创建于」，按最后使用排序，搜索可匹配时间。',
  '- **按会话 ID 删除**：搜索 / 多选 / 粘贴 id；父子会话有明确标识。',
  '- **默认先备份**：会话目录、投影缓存、存储单位文件 → `session-delete-backup/<timestamp>/`，备份失败即中止。',
  '- **删完自动刷新**：`Workspace.detachSession()` + `api-session/removed` + `sessions.refresh()`，侧边栏无需重启。',
  '',
  '### 安装',
  '',
  '```bash',
  'plugin_manager install_bundle  target: <本仓库目录>',
  '# 或',
  `dsh plugin --profile desktop add ./dsh-session-manager-${VERSION}.tgz`,
  '```',
  '',
  '### 附件',
  '',
  `- \`dsh-session-manager-${VERSION}.tgz\` — npm 包`,
  '',
  '详细说明见 [README](https://github.com/' + REPO + '#readme)，变更见 [CHANGELOG](https://github.com/' + REPO + '/blob/main/CHANGELOG.md)。',
].join('\n')

const release = await call('POST', `/repos/${REPO}/releases`, {
  tag_name: `v${VERSION}`,
  name: `v${VERSION} — dsh-session-manager`,
  body,
  draft: false,
  prerelease: false,
})
console.log('release', release.html_url)

const assetBytes = fs.readFileSync(path.resolve(TARBALL))
const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(path.basename(TARBALL))}`
for (let attempt = 1; attempt <= 6; attempt += 1) {
  try {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/octet-stream',
        'user-agent': 'dsh-session-manager-recreate',
      },
      body: assetBytes,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`upload -> ${response.status} ${text.slice(0, 200)}`)
    const asset = JSON.parse(text)
    console.log('asset', asset.name, asset.size)
    break
  } catch (error) {
    if (attempt === 6) throw error
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
  }
}

// ---------- 7. topics ----------
const topicResult = await call('PUT', `/repos/${REPO}/topics`, { names: topics })
console.log('topics', JSON.stringify(topicResult.names))
console.log('DONE', `https://github.com/${REPO}`)
