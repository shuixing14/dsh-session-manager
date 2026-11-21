// Push the current working tree to GitHub through the REST API.
// api.github.com is reachable from this machine; github.com:443 is not reliable.
//
// usage: node api-push.mjs --repo owner/name [--branch main] --message "..." [--root .]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const REPO = arg('repo')
const BRANCH = arg('branch', 'main')
const MESSAGE = arg('message', 'chore: update')
const ROOT = path.resolve(arg('root', '.'))
const TOKEN = process.env.GH_TOKEN || ''

if (!REPO || !TOKEN) {
  console.error('missing --repo or GH_TOKEN')
  process.exit(2)
}

const API = 'https://api.github.com'
const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${TOKEN}`,
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
  'user-agent': 'dsh-session-manager-api-push',
}

async function call(method, url, body) {
  let lastError = null
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${API}${url}`, {
        method,
        headers,
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
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
  }
  throw lastError
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\u0000').filter(Boolean)
}

const files = trackedFiles()
if (files.length === 0) {
  console.error('no tracked files (run from a git checkout)')
  process.exit(2)
}

const head = await call('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`)
const headSha = head.object.sha
const headCommit = await call('GET', `/repos/${REPO}/git/commits/${headSha}`)
const baseTree = headCommit.tree.sha

const local = new Map()
for (const file of files) {
  try {
    local.set(file, fs.readFileSync(path.join(ROOT, file)))
  } catch {}
}

const remoteTree = await call('GET', `/repos/${REPO}/git/trees/${baseTree}?recursive=1`)
const remoteByPath = new Map()
for (const entry of remoteTree.tree ?? []) if (entry.type === 'blob') remoteByPath.set(entry.path, entry.sha)

const entries = []
let changed = 0
for (const [file, buffer] of local) {
  const blob = await call('POST', `/repos/${REPO}/git/blobs`, { content: buffer.toString('base64'), encoding: 'base64' })
  if (remoteByPath.get(file) === blob.sha) continue
  entries.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
  changed += 1
}
const removed = [...remoteByPath.keys()].filter((file) => !local.has(file))
for (const file of removed) entries.push({ path: file, mode: '100644', type: 'blob', sha: null })

if (entries.length === 0) {
  console.log('nothing to push (remote already matches)')
  process.exit(0)
}

const tree = await call('POST', `/repos/${REPO}/git/trees`, { base_tree: baseTree, tree: entries })
const commit = await call('POST', `/repos/${REPO}/git/commits`, { message: MESSAGE, tree: tree.sha, parents: [headSha] })
await call('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false })

console.log(JSON.stringify({ branch: BRANCH, previous: headSha, commit: commit.sha, changed, removed: removed.length }))
