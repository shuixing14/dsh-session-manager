// Create an annotated tag through the GitHub REST API (github.com:443 is flaky here).
// usage: node api-tag.mjs --repo owner/name --tag vX.Y.Z [--commit sha] --message "..." [--target main]
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const REPO = arg('repo')
const TAG = arg('tag')
const MESSAGE = arg('message', TAG)
const TARGET = arg('target', 'main')
const TOKEN = process.env.GH_TOKEN || ''
if (!REPO || !TAG || !TOKEN) {
  console.error('missing --repo/--tag/GH_TOKEN')
  process.exit(2)
}

const API = 'https://api.github.com'
const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${TOKEN}`,
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
  'user-agent': 'dsh-session-manager-api-tag',
}

async function call(method, url, body) {
  let lastError = null
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${API}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await response.text()
      if (!response.ok) {
        lastError = new Error(`${method} ${url} -> ${response.status} ${text.slice(0, 300)}`)
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

let commitSha = arg('commit')
if (!commitSha) {
  const ref = await call('GET', `/repos/${REPO}/git/ref/heads/${TARGET}`)
  commitSha = ref.object.sha
}

const existing = await call('GET', `/repos/${REPO}/git/ref/tags/${TAG}`).catch(() => null)
if (existing) {
  console.log(JSON.stringify({ tag: TAG, already: true, sha: existing.object.sha }))
  process.exit(0)
}

const tagObject = await call('POST', `/repos/${REPO}/git/tags`, {
  tag: TAG,
  message: MESSAGE,
  object: commitSha,
  type: 'commit',
})
await call('POST', `/repos/${REPO}/git/refs`, { ref: `refs/tags/${TAG}`, sha: tagObject.sha })
console.log(JSON.stringify({ tag: TAG, commit: commitSha, tagObject: tagObject.sha }))
