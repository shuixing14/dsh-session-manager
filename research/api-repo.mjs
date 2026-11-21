// Update the repo description/homepage/topics through the REST API.
// usage: node api-repo.mjs --repo owner/name [--description "..."] [--homepage "..."] [--topics a,b,c]
const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const REPO = arg('repo')
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
  'user-agent': 'dsh-session-manager-api-repo',
}

async function call(method, url, body) {
  const response = await fetch(`${API}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${text.slice(0, 300)}`)
  return text === '' ? null : JSON.parse(text)
}

const patch = {}
const description = arg('description')
const homepage = arg('homepage')
if (description !== undefined) patch.description = description
if (homepage !== undefined) patch.homepage = homepage
if (Object.keys(patch).length > 0) {
  await call('PATCH', `/repos/${REPO}`, patch)
  console.log('patched', JSON.stringify(patch))
}

const topics = arg('topics')
if (topics !== undefined) {
  const names = topics.split(',').map((name) => name.trim()).filter(Boolean)
  const result = await call('PUT', `/repos/${REPO}/topics`, { names })
  console.log('topics', JSON.stringify(result.names))
}
