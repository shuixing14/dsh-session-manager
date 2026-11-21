// Round 2: HTTP endpoint harness for lib/index.js installRoutes().
// Stubs ctx.get('webServer').register to capture the two routes, then drives each
// handler with a fake req (async iterable body + headers) and a recording res.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'lib', 'index.js')
const RUN = path.join(HERE, `r2home-${Date.now()}`)
const OUTSIDE = path.join(HERE, `r2outside-${Date.now()}`)

const results = []
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
async function check(id, fn) {
  try {
    const detail = await fn()
    results.push({ id, ok: true, detail })
    console.log(`PASS  ${id}${detail ? '\n      ' + detail : ''}`)
  } catch (error) {
    results.push({ id, ok: false, detail: error.message })
    console.log(`FAIL  ${id}\n      ${error.message}`)
  }
}

/* ---------------- fixture ---------------- */
const KEEP = '11111111-1111-4111-8111-111111111111'
const TARGET = '33333333-3333-4333-8333-333333333333'
const CWD = 'D:\\proj'

function buildHome() {
  fs.rmSync(RUN, { recursive: true, force: true })
  for (const id of [KEEP, TARGET]) {
    const dir = path.join(RUN, 'sessions', '--D-proj--', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('z'.repeat(64)))
  }
  fs.mkdirSync(path.join(RUN, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  for (const id of [KEEP, TARGET]) {
    fs.writeFileSync(
      path.join(RUN, 'storages', 'session_projcache', 'sessions', `${id}.json`),
      JSON.stringify({ version: 3, record: { identity: { id, cwd: CWD, createdAt: 1 }, rows: [] } }),
    )
  }
  fs.writeFileSync(
    path.join(RUN, 'storages', 'workspace.json'),
    JSON.stringify({
      version: 2,
      global: { archivedSessionIds: [TARGET], pinnedSessionIds: [] },
      tables: { workspaces: { 'ws-1': { id: 'ws-1', path: CWD, sessionIds: [KEEP, TARGET] } } },
    }),
  )
  fs.rmSync(OUTSIDE, { recursive: true, force: true })
  fs.mkdirSync(OUTSIDE, { recursive: true })
  fs.writeFileSync(path.join(OUTSIDE, 'sentinel.txt'), 'do-not-touch')
}
buildHome()
process.env.DSH_HOME = RUN

/* ---------------- stubs ---------------- */
function makeCtx({ webServer = true, typert = false } = {}) {
  const routes = []
  const provided = new Map()
  const warnings = []
  const services = {
    sessionPersistence: {
      async list() {
        return [
          { header: { id: KEEP, cwd: CWD, createdAt: 1 }, sizeBytes: 64 },
          { header: { id: TARGET, cwd: CWD, createdAt: 2 }, sizeBytes: 64 },
        ]
      },
    },
  }
  if (webServer) {
    services.webServer = {
      register(route) {
        routes.push(route)
        return () => {}
      },
    }
  }
  if (typert) services.typert = {}
  const ctx = {
    get: (n) => services[n],
    provide: (n, v) => provided.set(n, v),
    effect: (fn) => {
      const d = fn()
      return () => typeof d === 'function' && d()
    },
    logger: {
      warn: (...a) => warnings.push(a.join(' ')),
      error: (...a) => warnings.push(a.join(' ')),
      info() {},
    },
  }
  return {
    ctx: new Proxy(ctx, {
      get(t, p, r) {
        if (typeof p === 'string' && p in services && !(p in t)) return services[p]
        return Reflect.get(t, p, r)
      },
    }),
    routes,
    provided,
    warnings,
  }
}

/** Fake req: async iterable of body chunks plus headers/method. */
function makeReq({ method = 'POST', headers = {}, body = null }) {
  const chunks = body === null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}
function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    raw: [], // exact bytes as written; `body` stays a utf8 string for the JSON checks
    ended: false,
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
      return res
    },
    end(chunk) {
      if (chunk !== undefined) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
        res.raw.push(bytes)
        res.body += bytes.toString('utf8')
      }
      res.ended = true
    },
  }
  return res
}

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
const plugin = mod.default ?? mod
console.log('=== plugin:', PLUGIN, ' md5-checked externally ===')
console.log('=== fake home:', RUN, '\n')

function routeOf(routes, p) {
  const r = routes.find((x) => x.path === p)
  if (!r) throw new Error(`route ${p} not registered; got ${routes.map((x) => x.path).join(', ')}`)
  return r
}

// Boot ONE plugin instance with a webServer and keep the captured routes.
const boot = makeCtx({ webServer: true })
plugin.apply(boot.ctx)
const LIST_PATH = '/dsh-session-manager/list'
const DELETE_PATH = '/dsh-session-manager/delete'
const STATUS_PATH = '/dsh-session-manager/status'
const RESOLVE_PATH = '/dsh-session-manager/resolve'
const TOKEN_PATH = '/dsh-session-manager/token'
/** The page token the plugin generated for this fake home on boot. */
const PAGE_TOKEN = fs.readFileSync(path.join(RUN, '.dsh-session-manager.token'), 'utf8').trim()

const dirExists = (id) => fs.existsSync(path.join(RUN, 'sessions', '--D-proj--', id))
function resetTarget() {
  const dir = path.join(RUN, 'sessions', '--D-proj--', id(TARGET))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('z'.repeat(64)))
  fs.mkdirSync(path.join(RUN, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  fs.writeFileSync(
    path.join(RUN, 'storages', 'session_projcache', 'sessions', `${TARGET}.json`),
    JSON.stringify({ version: 3, record: { identity: { id: TARGET, cwd: CWD, createdAt: 2 }, rows: [] } }),
  )
  fs.rmSync(path.join(RUN, 'session-delete-backup'), { recursive: true, force: true })
}
function id(x) {
  return x
}

/* ================= 0. route registration ================= */
await check('0. apply() registers the seven exact routes', async () => {
  assert(boot.routes.length === 7, `expected 7 routes, got ${boot.routes.length}: ${boot.routes.map((r) => r.path).join(', ')}`)
  for (const p of ['/dsh-session-manager/status', '/dsh-session-manager/token', '/dsh-session-manager/list', '/dsh-session-manager/resolve', '/dsh-session-manager/delete', '/dsh-session-manager/client.js', '/dsh-session-manager/boot.js']) {
    assert(boot.routes.find((r) => r.path === p), `route ${p} was not registered`)
  }
  assert(boot.routes.every((r) => r.kind === 'exact' && typeof r.handler === 'function'), 'a route is not kind:"exact" with a handler')
  return boot.routes.map((r) => `${r.kind} ${r.path}`).join(' + ')
})

/* ================= (a) GET /list ================= */
await check('(a) GET /list with loopback Host -> 200 + listing JSON', async () => {
  const res = makeRes()
  await routeOf(boot.routes, LIST_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  assert(res.statusCode === 200, `status ${res.statusCode}: ${res.body}`)
  const body = JSON.parse(res.body)
  assert(Array.isArray(body.sessions) && body.sessions.length === 2, `sessions=${JSON.stringify(body.sessions && body.sessions.length)}`)
  assert(body.home === RUN, `home mismatch: ${body.home}`)
  assert(res.headers['Cache-Control'] === 'no-store', 'no-store cache header missing')
  assert(String(res.headers['Content-Type']).includes('application/json'), 'content-type not JSON')
  return `200, sessions=${body.sessions.length}, home ok`
})

/* ================= (f) same-origin allowed ================= */
await check('(f) Host 127.0.0.1:5471 + Origin http://127.0.0.1:5471 is allowed', async () => {
  const res = makeRes()
  await routeOf(boot.routes, LIST_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  assert(res.statusCode === 200, `status ${res.statusCode}: ${res.body}`)
  return '200'
})

/* ================= (b) cross-site / foreign origin -> 403, no deletion ================= */
const rejectCases = [
  ['b1 cross-site sec-fetch-site', { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'cross-site' }],
  ['b2 foreign Origin', { host: '127.0.0.1:5471', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' }],
  ['b3 Origin with foreign port', { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:9999' }],
  ['g evil.example Host, no Origin', { host: 'evil.example' }],
  ['h1 Origin: null + foreign host', { host: 'evil.example', origin: 'null' }],
  ['h4 Host localhost.evil.com', { host: 'localhost.evil.com' }],
  ['h5 Host 127.0.0.1.evil.com', { host: '127.0.0.1.evil.com' }],
  ['h6 missing Host', {}],
  ['h7 non-loopback Host, no fetch-site', { host: '192.168.1.10:5471' }],
  ['h8 malformed Host', { host: 'not a host:::' }],
]
for (const [label, headers] of rejectCases) {
  await check(`(b/g/h) POST /delete rejected: ${label} -> 403, NO deletion`, async () => {
    resetTarget()
    const res = makeRes()
    await routeOf(boot.routes, DELETE_PATH).handler(
      makeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ sessionIds: [TARGET], backup: false, allowActive: true }),
      }),
      res,
    )
    assert(res.statusCode === 403, `expected 403, got ${res.statusCode}: ${res.body.slice(0, 160)}`)
    let parsed = null
    try {
      parsed = JSON.parse(res.body)
    } catch {}
    assert(parsed && typeof parsed.error === 'string', 'body is not {error}: ' + res.body.slice(0, 120))
    assert(dirExists(TARGET), 'SESSION WAS DELETED by a rejected request')
    assert(!fs.existsSync(path.join(RUN, 'session-delete-backup')), 'backup dir was created by a rejected request')
    return `403 {error:"${parsed.error}"}; session intact`
  })
}

/* ================= (h) duplicate Host header (array) ================= */
await check('(h) duplicate Host header (array value) does not bypass the fence', async () => {
  resetTarget()
  const res = makeRes()
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: ['evil.example', '127.0.0.1:5471'], 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: [TARGET], backup: false, allowActive: true }),
    }),
    res,
  )
  // Node folds duplicates into a comma-joined string; either way it must not be treated as loopback.
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`)
  assert(dirExists(TARGET), 'SESSION WAS DELETED via a duplicate Host header')
  return `403 (host array -> ${JSON.stringify(['evil.example', '127.0.0.1:5471'])})`
})

/* ================= (h) uppercase Host ================= */
await check('(h) uppercase Host (LOCALHOST / 127.0.0.1) is still a valid loopback Host', async () => {
  resetTarget()
  const res = makeRes()
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: 'LOCALHOST:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: [TARGET], backup: true, allowActive: true }),
    }),
    res,
  )
  assert(res.statusCode === 200, `uppercase loopback Host rejected: ${res.statusCode} ${res.body}`)
  return '200 (loopback, case-insensitive)'
})

/* ================= (d) text/plain -> 415 ================= */
await check('(d) POST with content-type text/plain -> 415, NO deletion', async () => {
  resetTarget()
  const res = makeRes()
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
      body: JSON.stringify({ sessionIds: [TARGET], backup: false, allowActive: true }),
    }),
    res,
  )
  assert(res.statusCode === 415, `expected 415, got ${res.statusCode}: ${res.body.slice(0, 120)}`)
  const parsed = JSON.parse(res.body)
  assert(typeof parsed.error === 'string', 'body is not {error}')
  assert(dirExists(TARGET), 'SESSION WAS DELETED with text/plain content-type')
  return `415 {error:"${parsed.error}"}; session intact`
})

await check('(h) Application/JSON; charset=utf-8 content-type IS accepted', async () => {
  const res = makeRes()
  await routeOf(boot.routes, LIST_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', 'content-type': 'text/plain' } }),
    res,
  )
  assert(res.statusCode === 200, 'GET must not require application/json: ' + res.statusCode)
  resetTarget()
  const res2 = makeRes()
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'Application/JSON; charset=utf-8' },
      body: JSON.stringify({ sessionIds: [TARGET], backup: true, allowActive: true }),
    }),
    res2,
  )
  assert(res2.statusCode === 200, `mixed-case JSON content-type rejected: ${res2.statusCode} ${res2.body}`)
  return 'GET needs no content-type; POST accepts case-insensitive application/json with parameters'
})

/* ================= (e) malformed JSON -> 500 ================= */
await check('(e) POST with malformed JSON body -> 500 {error}, NO deletion', async () => {
  resetTarget()
  const res = makeRes()
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{ this is not json',
    }),
    res,
  )
  assert(res.statusCode === 500, `expected 500, got ${res.statusCode}: ${res.body.slice(0, 120)}`)
  const parsed = JSON.parse(res.body)
  assert(typeof parsed.error === 'string' && parsed.error.length > 0, 'body is not {error}')
  assert(dirExists(TARGET), 'SESSION WAS DELETED on a malformed body')
  return `500 {error:"${parsed.error.slice(0, 60)}"}; session intact`
})

/* ================= (h) oversized body -> 500 + no deletion ================= */
await check('(h) oversized body (>64KB) -> 500 {"error":"请求体过大"}, NO deletion', async () => {
  resetTarget()
  const res = makeRes()
  const big = Buffer.alloc(70 * 1024, 0x41)
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: big,
    }),
    res,
  )
  assert(res.statusCode === 500, `expected 500, got ${res.statusCode}`)
  const parsed = JSON.parse(res.body)
  assert(parsed.error === '请求体过大', `unexpected error text: ${parsed.error}`)
  assert(dirExists(TARGET), 'SESSION WAS DELETED on an oversized body')
  return '500 请求体过大; session intact'
})

/* ================= (h) wrong method on /delete -> 405 ================= */
await check('(h) GET on /delete -> 405 {error}, NO deletion', async () => {
  resetTarget()
  const res = makeRes()
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({
      method: 'GET',
      headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: null,
    }),
    res,
  )
  assert(res.statusCode === 405, `expected 405, got ${res.statusCode}: ${res.body.slice(0, 120)}`)
  const parsed = JSON.parse(res.body)
  assert(typeof parsed.error === 'string', 'body is not {error}')
  assert(dirExists(TARGET), 'SESSION WAS DELETED on GET')
  return `405 {error:"${parsed.error}"}; session intact`
})

/* ================= (c) the happy path ================= */
await check('(c) POST same-origin + JSON body -> 200 + per-id results + real backup dir', async () => {
  resetTarget()
  const res = makeRes()
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: [TARGET], backup: true, allowActive: false }),
    }),
    res,
  )
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${res.body.slice(0, 200)}`)
  const body = JSON.parse(res.body)
  assert(Array.isArray(body.results) && body.results.length === 1, 'results missing')
  const r0 = body.results[0]
  assert(r0.id === TARGET && r0.ok === true, `per-id result wrong: ${JSON.stringify(r0)}`)
  assert(typeof body.backupDir === 'string' && fs.existsSync(body.backupDir), 'backupDir not on disk: ' + body.backupDir)
  assert(body.backupDir.startsWith(path.join(RUN, 'session-delete-backup')), 'backupDir outside the fake home: ' + body.backupDir)
  assert(fs.existsSync(path.join(body.backupDir, 'manifest.json')), 'manifest.json missing')
  assert(fs.existsSync(path.join(body.backupDir, 'sessions', TARGET, 'session.v4.jsonl.zstd')), 'session dir not backed up')
  assert(!dirExists(TARGET), 'session dir was NOT deleted')
  assert(!fs.existsSync(path.join(RUN, 'storages', 'session_projcache', 'sessions', `${TARGET}.json`)), 'projection doc not removed')
  const ws = JSON.parse(fs.readFileSync(path.join(RUN, 'storages', 'workspace.json'), 'utf8'))
  assert(!ws.tables.workspaces['ws-1'].sessionIds.includes(TARGET), 'workspace.json still lists the id')
  assert(!ws.global.archivedSessionIds.includes(TARGET), 'archived list still has the id')
  assert(dirExists(KEEP), 'the other session was touched')
  return `200 ok:true scrubbed=${JSON.stringify(r0.scrubbed)} backupDir=${path.basename(body.backupDir)}`
})

/* ================= refused sessions over HTTP ================= */
await check('POST /delete for a non-existent / malformed id -> 200 with per-id ok:false', async () => {
  const res = makeRes()
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ['../../evil', 'deadbeef-dead-4ead-8ead-deadbeefdead'], backup: false }),
    }),
    res,
  )
  assert(res.statusCode === 200, `expected 200 with per-id errors, got ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert(body.results.every((r) => r.ok === false), 'crafted ids accepted over HTTP: ' + JSON.stringify(body.results))
  assert(fs.existsSync(path.join(OUTSIDE, 'sentinel.txt')), 'outside sentinel touched')
  return body.results.map((r) => r.error).join(' | ')
})

/* ================= missing webServer path ================= */
await check('no webServer: apply() only warns, never throws, deletion is unchanged', async () => {
  const noWeb = makeCtx({ webServer: false })
  let threw = null
  try {
    plugin.apply(noWeb.ctx)
  } catch (error) {
    threw = error
  }
  assert(threw === null, 'apply() threw without a webServer: ' + (threw && threw.message))
  assert(noWeb.routes.length === 0, 'routes registered without a webServer')
  assert(noWeb.warnings.some((w) => /webServer/.test(w)), 'no warning logged about the missing webServer')
  // The Remote facade is now gated on the protocol package resolving (async installRemote),
  // not on ctx.get('typert'). On a host where it does not resolve, nothing is provided and
  // that is a clean skip, not a failure.
  await new Promise((r) => setTimeout(r, 150))
  return 'warned: ' + noWeb.warnings[0].slice(0, 70) + ' | facade provided=' + noWeb.provided.has('dshSessionManager') + ' (protocol resolvable here: no)' 
})

/* ================= NEW: /status ================= */
await check('NEW GET /status -> 200 {ok,version,home,pid,endpoints}', async () => {
  const res = makeRes()
  await routeOf(boot.routes, STATUS_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  assert(res.statusCode === 200, `status ${res.statusCode}: ${res.body}`)
  const body = JSON.parse(res.body)
  assert(body.ok === true, 'ok is not true')
  assert(typeof body.version === 'string' && body.version.length > 0, 'version missing: ' + body.version)
  assert(body.home === RUN, 'home mismatch: ' + body.home)
  assert(typeof body.pid === 'number' && body.pid > 0, 'pid missing')
  assert(Array.isArray(body.endpoints) && body.endpoints.length === 7, 'endpoints list wrong: ' + JSON.stringify(body.endpoints))
  assert(res.headers['Cache-Control'] === 'no-store', 'no-store missing')
  return `200 ok:true version=${body.version} pid=${body.pid} endpoints=${body.endpoints.length}`
})

await check('NEW GET /status is rejected cross-site (fence also covers reads)', async () => {
  const res = makeRes()
  await routeOf(boot.routes, STATUS_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}: ${res.body.slice(0, 120)}`)
  return '403 for a foreign Origin'
})

/* ================= NEW: /resolve ================= */
const RESOLVE_CASES = [
  ['array body', { sessionIds: [KEEP, TARGET] }],
  ['bare array', [KEEP, TARGET]],
  ['comma-separated string', { sessionIds: `${KEEP}, ${TARGET}` }],
]
for (const [label, payload] of RESOLVE_CASES) {
  await check(`NEW POST /resolve accepts ${label} -> 200 rows for both ids`, async () => {
    const res = makeRes()
    await routeOf(boot.routes, RESOLVE_PATH).handler(
      makeReq({
        method: 'POST',
        headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      res,
    )
    assert(res.statusCode === 200, `status ${res.statusCode}: ${res.body.slice(0, 160)}`)
    const body = JSON.parse(res.body)
    assert(Array.isArray(body.sessions) && body.sessions.length === 2, 'expected 2 rows, got ' + (body.sessions && body.sessions.length))
    const ids = body.sessions.map((r) => r.id).sort()
    assert(ids.join(',') === [KEEP, TARGET].sort().join(','), 'wrong ids: ' + ids.join(','))
    assert(Array.isArray(body.rejected) && body.rejected.length === 0, 'unexpected rejected: ' + JSON.stringify(body.rejected))
    for (const row of body.sessions) {
      for (const f of ['id', 'title', 'cwd', 'createdAt', 'parentId', 'origin', 'agentPreset', 'eventCount', 'bytes', 'dir', 'archived', 'pinned', 'open', 'running', 'orphan', 'missing', 'children']) {
        assert(Object.hasOwn(row, f), `row missing field ${f}`)
      }
      assert(row.missing === false, 'existing id reported missing')
    }
    return `200 ${label}: ${ids.join(', ')}; all 17 fields present`
  })
}

await check('NEW POST /resolve: invalid ids go to rejected[], never throw the whole call', async () => {
  const res = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: [KEEP, '../../evil', '..', '', 'not-an-id'] }),
    }),
    res,
  )
  assert(res.statusCode === 200, `expected 200 with rejected[], got ${res.statusCode}: ${res.body.slice(0, 140)}`)
  const body = JSON.parse(res.body)
  assert(body.sessions.length === 1 && body.sessions[0].id === KEEP, 'valid id was not resolved')
  const reasons = body.rejected.map((r) => r.reason).sort()
  assert(body.rejected.length === 4, 'expected 4 rejected, got ' + body.rejected.length + ': ' + JSON.stringify(body.rejected))
  assert(reasons.includes('invalid-id') && reasons.includes('empty'), 'unexpected reasons: ' + reasons.join(','))
  assert(fs.existsSync(path.join(OUTSIDE, 'sentinel.txt')), 'outside sentinel touched')
  return `200 rows=1 rejected=${JSON.stringify(body.rejected.map((r) => r.reason))}`
})

await check('NEW POST /resolve: unknown but well-formed id -> row with missing:true', async () => {
  const ghost = 'deadbeef-dead-4ead-8ead-deadbeefdead'
  const res = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: [ghost] }),
    }),
    res,
  )
  assert(res.statusCode === 200, `status ${res.statusCode}: ${res.body.slice(0, 140)}`)
  const body = JSON.parse(res.body)
  assert(body.sessions.length === 1, 'expected 1 row')
  assert(body.sessions[0].id === ghost && body.sessions[0].missing === true, 'missing flag not set: ' + JSON.stringify(body.sessions[0]))
  return '200 missing:true for an id with no snapshot'
})

await check('NEW POST /resolve caps at 500 and reports the overflow in rejected[]', async () => {
  const ids = Array.from({ length: 505 }, (_, i) => `0000${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`)
  const res = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: ids }),
    }),
    res,
  )
  assert(res.statusCode === 200, `status ${res.statusCode}`)
  const body = JSON.parse(res.body)
  assert(body.sessions.length === 500, 'expected 500 rows, got ' + body.sessions.length)
  assert(body.rejected.filter((r) => r.reason === 'limit').length === 5, 'overflow not reported: ' + JSON.stringify(body.rejected.slice(0, 3)))
  return '500 rows + 5 rejected(limit)'
})

await check('NEW POST /resolve is fenced like a write (cross-site -> 403, text/plain -> 415)', async () => {
  const cross = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: [KEEP] }),
    }),
    cross,
  )
  assert(cross.statusCode === 403, `cross-site resolve got ${cross.statusCode}`)
  const plain = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
      body: JSON.stringify({ sessionIds: [KEEP] }),
    }),
    plain,
  )
  assert(plain.statusCode === 415, `text/plain resolve got ${plain.statusCode}`)
  return '403 cross-site, 415 text/plain'
})

await check('NEW GET on /resolve -> 405 (read route is POST-only)', async () => {
  const res = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  assert(res.statusCode === 405, `expected 405, got ${res.statusCode}`)
  return '405 请使用 POST'
})

/* ================= NEW: OPTIONS preflight ================= */
await check('NEW OPTIONS preflight -> 204 + mirrored Origin + allow-headers/methods + max-age', async () => {
  for (const p of [LIST_PATH, STATUS_PATH, TOKEN_PATH, RESOLVE_PATH, DELETE_PATH, '/dsh-session-manager/client.js', '/dsh-session-manager/boot.js']) {
    const res = makeRes()
    await routeOf(boot.routes, p).handler(
      makeReq({ method: 'OPTIONS', headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'access-control-request-method': 'POST' } }),
      res,
    )
    assert(res.statusCode === 204, `${p}: expected 204, got ${res.statusCode}`)
    assert(res.headers['Access-Control-Allow-Origin'] === 'http://127.0.0.1:5471', `${p}: allow-origin not mirrored: ${res.headers['Access-Control-Allow-Origin']}`)
    assert(res.headers.Vary === 'Origin', `${p}: Vary missing`)
    assert(res.headers['Access-Control-Allow-Headers'] === 'accept, content-type, x-dsh-session-manager-token', `${p}: allow-headers wrong`)
    assert(res.headers['Access-Control-Allow-Methods'] === 'GET,POST,OPTIONS', `${p}: allow-methods wrong`)
    assert(res.headers['Access-Control-Max-Age'] === '600', `${p}: max-age wrong`)
  }
  return '204 on all 7 routes; origin mirrored, Vary: Origin, headers+methods+max-age=600'
})

await check('NEW OPTIONS preflight needs NO page token (preflight cannot carry one)', async () => {
  const res = makeRes()
  // Page token is unset in this fixture (no .dsh-session-manager.token for the fake home would
  // still be created); send no token header at all and assert the preflight still succeeds.
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({ method: 'OPTIONS', headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471' } }),
    res,
  )
  assert(res.statusCode === 204, `expected 204 without a token, got ${res.statusCode}`)
  const denied = makeRes()
  await routeOf(boot.routes, DELETE_PATH).handler(
    makeReq({ method: 'OPTIONS', headers: { host: '127.0.0.1:5471', origin: 'http://evil.example' } }),
    denied,
  )
  assert(denied.statusCode === 403, `foreign-origin preflight got ${denied.statusCode}`)
  return '204 without token; 403 for a non-loopback Origin'
})


/* ================= NEW: /client.js + /boot.js static assets ================= */
const CLIENT_JS_PATH = '/dsh-session-manager/client.js'
const BOOT_JS_PATH = '/dsh-session-manager/boot.js'
const CLIENT_FILE = path.join(HERE, '..', 'client.js')

await check('NEW GET /client.js -> 200, application/javascript, raw file bytes', async () => {
  const res = makeRes()
  await routeOf(boot.routes, CLIENT_JS_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  assert(res.statusCode === 200, `status ${res.statusCode}: ${String(res.body).slice(0, 160)}`)
  assert(res.headers['Content-Type'] === 'application/javascript; charset=utf-8', 'content-type = ' + res.headers['Content-Type'])
  assert(res.headers['Cache-Control'] === 'no-store', 'cache-control = ' + res.headers['Cache-Control'])
  const onDisk = fs.readFileSync(CLIENT_FILE)
  const served = Buffer.concat(res.raw)
  assert(served.equals(onDisk), 'served bytes differ from client.js on disk')
  assert(res.headers['Content-Length'] === String(onDisk.length), 'content-length mismatch')
  assert(onDisk.length > 80 * 1024, 'client.js is smaller than 80 KB: ' + onDisk.length)
  return `200 javascript, ${onDisk.length} bytes, byte-identical to client.js`
})

await check('NEW GET /boot.js -> 200, contains __ModuleLoader__, ends with the marker', async () => {
  const res = makeRes()
  await routeOf(boot.routes, BOOT_JS_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  assert(res.statusCode === 200, `status ${res.statusCode}`)
  assert(res.headers['Content-Type'] === 'application/javascript; charset=utf-8', 'content-type = ' + res.headers['Content-Type'])
  const served = Buffer.concat(res.raw)
  const onDisk = fs.readFileSync(CLIENT_FILE)
  assert(served.includes('__ModuleLoader__'), 'boot.js does not contain __ModuleLoader__')
  assert(served.slice(0, onDisk.length).equals(onDisk), 'boot.js does not start with client.js verbatim')
  const tail = served.slice(onDisk.length).toString('utf8')
  assert(tail === '\n;/*dsh-session-manager:loaded*/', 'unexpected suffix: ' + JSON.stringify(tail))
  return `200 javascript, ${served.length} bytes = client.js + ${tail.length}-byte marker`
})

await check('NEW static assets are fenced: cross-site 403, POST 405, OPTIONS 204', async () => {
  for (const p of [CLIENT_JS_PATH, BOOT_JS_PATH]) {
    const cross = makeRes()
    await routeOf(boot.routes, p).handler(
      makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' } }),
      cross,
    )
    assert(cross.statusCode === 403, `${p}: cross-site got ${cross.statusCode}`)
    const post = makeRes()
    await routeOf(boot.routes, p).handler(
      makeReq({ method: 'POST', headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' }),
      post,
    )
    assert(post.statusCode === 405, `${p}: POST got ${post.statusCode}`)
    const pre = makeRes()
    await routeOf(boot.routes, p).handler(
      makeReq({ method: 'OPTIONS', headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471' } }),
      pre,
    )
    assert(pre.statusCode === 204, `${p}: OPTIONS got ${pre.statusCode}`)
    assert(pre.headers['Access-Control-Allow-Origin'] === 'http://127.0.0.1:5471', `${p}: preflight did not mirror the Origin`)
  }
  return '403 cross-site / 405 POST / 204 OPTIONS(mirrored) on both asset routes'
})

await check('NEW /status advertises all seven endpoints including the assets', async () => {
  const res = makeRes()
  await routeOf(boot.routes, STATUS_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  const body = JSON.parse(String(res.body))
  assert(body.endpoints.length === 7, 'expected 7 endpoints, got ' + body.endpoints.length)
  assert(body.endpoints.some((e) => e.includes('/client.js')), 'client.js missing from endpoints')
  assert(body.endpoints.some((e) => e.includes('/boot.js')), 'boot.js missing from endpoints')
  assert(body.endpoints.some((e) => e.includes('/token')), '/token missing from endpoints')
  return body.endpoints.join(' | ')
})


/* ================= NEW: GET /token ================= */
await check('NEW GET /token loopback -> 200, value matches the token file, no-store', async () => {
  const res = makeRes()
  await routeOf(boot.routes, TOKEN_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  assert(res.statusCode === 200, `status ${res.statusCode}: ${res.body.slice(0, 140)}`)
  const body = JSON.parse(res.body)
  assert(typeof body.token === 'string' && body.token.length >= 32, 'token missing/short: ' + JSON.stringify(body.token))
  assert(body.token === PAGE_TOKEN, 'served token does not match .dsh-session-manager.token on disk')
  assert(res.headers['Cache-Control'] === 'no-store', 'cache-control = ' + res.headers['Cache-Control'])
  return `200 token matches file (${PAGE_TOKEN.length} chars), no-store`
})

await check('NEW GET /token refuses a cross-site Origin (403)', async () => {
  const res = makeRes()
  await routeOf(boot.routes, TOKEN_PATH).handler(
    makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' } }),
    res,
  )
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`)
  assert(!res.body.includes(PAGE_TOKEN), 'the token leaked in a rejected response')
  return '403, token not disclosed'
})

await check('NEW GET /token refuses a non-loopback Host (403)', async () => {
  const res = makeRes()
  await routeOf(boot.routes, TOKEN_PATH).handler(makeReq({ method: 'GET', headers: { host: '192.168.1.10:5471' } }), res)
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`)
  return '403'
})

/* ================= NEW: Electron dsh-app:// proxy shape ================= */
// The Electron proxy strips Origin and sec-fetch-site and cannot add our header,
// so the page authenticates writes with the token header alone.
await check('NEW proxy-shaped POST /resolve (no Origin, no sec-fetch-site, WITH token) -> 200', async () => {
  const res = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'content-type': 'application/json', 'x-dsh-session-manager-token': PAGE_TOKEN },
      body: JSON.stringify({ sessionIds: [KEEP] }),
    }),
    res,
  )
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${res.body.slice(0, 140)}`)
  const body = JSON.parse(res.body)
  assert(body.sessions.length === 1 && body.sessions[0].id === KEEP, 'resolved rows wrong')
  return '200 with token, no Origin / no sec-fetch-site'
})

await check('NEW proxy-shaped POST /resolve without token -> 403', async () => {
  const res = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds: [KEEP] }),
    }),
    res,
  )
  assert(res.statusCode === 403, `expected 403, got ${res.statusCode}`)
  return '403 without a token (loopback alone is not enough)'
})

await check('NEW sec-fetch-site: none is NOT browser evidence: write 403 without token, 200 with', async () => {
  const denied = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'content-type': 'application/json', 'sec-fetch-site': 'none' },
      body: JSON.stringify({ sessionIds: [KEEP] }),
    }),
    denied,
  )
  assert(denied.statusCode === 403, `sec-fetch-site:none without token returned ${denied.statusCode} (must be 403)`)
  const allowed = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'content-type': 'application/json', 'sec-fetch-site': 'none', 'x-dsh-session-manager-token': PAGE_TOKEN },
      body: JSON.stringify({ sessionIds: [KEEP] }),
    }),
    allowed,
  )
  assert(allowed.statusCode === 200, `sec-fetch-site:none with token returned ${allowed.statusCode}`)
  return '403 without token, 200 with token'
})

await check('NEW sec-fetch-site: none on GET /list stays readable (200)', async () => {
  const res = makeRes()
  await routeOf(boot.routes, LIST_PATH).handler(makeReq({ method: 'GET', headers: { host: '127.0.0.1:5471', 'sec-fetch-site': 'none' } }), res)
  assert(res.statusCode === 200, `expected 200, got ${res.statusCode}`)
  return '200 (reads are unaffected by sec-fetch-site:none)'
})

await check('NEW a WRONG token is not accepted on the proxy shape (403)', async () => {
  const res = makeRes()
  await routeOf(boot.routes, RESOLVE_PATH).handler(
    makeReq({
      method: 'POST',
      headers: { host: '127.0.0.1:5471', 'content-type': 'application/json', 'x-dsh-session-manager-token': 'x'.repeat(43) },
      body: JSON.stringify({ sessionIds: [KEEP] }),
    }),
    res,
  )
  assert(res.statusCode === 403, `expected 403 for a wrong token, got ${res.statusCode}`)
  return '403 for a wrong token'
})

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} route-fence checks passed`)
fs.writeFileSync(path.join(HERE, 'r2-routes-results.json'), JSON.stringify({ run: RUN, results }, null, 2))
if (passed !== results.length) {
  console.log('\nFAILURES:')
  for (const r of results.filter((x) => !x.ok)) console.log(' - ' + r.id + ': ' + r.detail)
}
process.exitCode = passed === results.length ? 0 : 1
