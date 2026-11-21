// Title-resolution harness for dsh-session-manager.
//
// Proves the layered title source order in lib/index.js#readTitles:
//   1. live   — ctx.sessionTitle.get(session)
//   2. query  — sessionQuery.readTitleSnapshots(ids)
//               (value.title is a SessionTitleSnapshot OBJECT whose text is .title.title —
//                the old code compared that object to 'string' and dropped every title)
//   3. cache  — storages/session_projcache/sessions/<id>.json  record.rows.title.val
//               (val may be a bare string OR { title } — mirror dsh-context's tolerance)
//   4. cache  — the legacy whole-unit storages/session_projcache.json
//   5. none   — ''
//
// Never touches the real ~/.dsh: DSH_HOME always points at a fake home.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'lib', 'index.js')
const RUN = path.join(HERE, `titles-${Date.now()}`)
const CWD = 'D:\\proj'

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

/* ---------------- fixtures ---------------- */
const CACHE_BARE = '11111111-1111-4111-8111-111111111111' // doc val = bare string
const CACHE_OBJ = '22222222-2222-4222-8222-222222222222' // doc val = { title }
const LEGACY = '33333333-3333-4333-8333-333333333333' // title only in the legacy unit
const NO_TITLE = '44444444-4444-4444-8444-444444444444' // doc val = null
const VIA_QUERY = '55555555-5555-4555-8555-555555555555' // only via sessionQuery
const VIA_LIVE = '66666666-6666-4666-8666-666666666666' // only via sessionTitle

const ALL_IDS = [CACHE_BARE, CACHE_OBJ, LEGACY, NO_TITLE, VIA_QUERY, VIA_LIVE]
const PROJECT = path.join(RUN, 'sessions', '--D-proj--')
const MIRROR = path.join(RUN, 'storages', 'session_projcache', 'sessions')
const warnings = []

function writeSession(id) {
  const dir = path.join(PROJECT, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'z'.repeat(32))
}
function writeMirror(id, val) {
  fs.mkdirSync(MIRROR, { recursive: true })
  fs.writeFileSync(
    path.join(MIRROR, `${id}.json`),
    JSON.stringify({ version: 3, record: { identity: { id, cwd: CWD, createdAt: 1 }, rows: { title: { ver: 1, seq: 3, val } } } }),
  )
}

function buildHome() {
  fs.rmSync(RUN, { recursive: true, force: true })
  for (const id of ALL_IDS) writeSession(id)
  writeMirror(CACHE_BARE, '测试会话')
  writeMirror(CACHE_OBJ, { title: '对象形状的标题' })
  writeMirror(NO_TITLE, null)
  fs.mkdirSync(path.join(RUN, 'storages'), { recursive: true })
  const legacyUnit = {
    unit: 'session_projcache',
    version: 3,
    global: {},
    tables: {
      sessions: {
        [LEGACY]: { identity: { id: LEGACY, cwd: CWD, createdAt: 1 }, rows: { title: { ver: 1, seq: 2, val: '旧格式标题' } } },
      },
    },
  }
  fs.writeFileSync(path.join(RUN, 'storages', 'session_projcache.json'), JSON.stringify(legacyUnit))
  fs.writeFileSync(path.join(RUN, 'storages', 'workspace.json'), JSON.stringify({ version: 2, global: {}, tables: { workspaces: {} } }))
}

buildHome()
process.env.DSH_HOME = RUN

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
const plugin = mod.default ?? mod

/* ---------------- stub ctx ---------------- */
function buildServices({ withQuery = true, withLive = false, overrideQuery } = {}) {
  const services = {
    sessionPersistence: {
      async list() {
        return ALL_IDS.map((id, i) => ({ header: { id, cwd: CWD, createdAt: 100 + i }, sizeBytes: 32 }))
      },
      async stat(id) {
        if (!ALL_IDS.includes(id)) return undefined
        return { header: { id, cwd: CWD, createdAt: 100 }, sizeBytes: 32 }
      },
    },
  }
  if (withQuery) {
    services.sessionQuery = {
      async readTitleSnapshots(ids) {
        // Documented shape: value = { session, title?: SessionTitleSnapshot };
        // the snapshot is an OBJECT and its text lives at .title.
        return ids.map((sessionId) =>
          sessionId === VIA_QUERY
            ? {
                sessionId,
                status: 'fulfilled',
                value: {
                  session: { id: sessionId, cwd: CWD },
                  title: { title: '查询出来的标题', messageSeqs: [], source: { kind: 'user' }, eventSeq: 7, updatedAt: 1 },
                },
              }
            : { sessionId, status: 'fulfilled', value: { session: { id: sessionId, cwd: CWD } } },
        )
      },
    }
  }
  if (withLive) {
    services.sessionTitle = { get: (session) => (session?.id === VIA_LIVE ? '活会话标题' : undefined) }
    services.sessions = { get: (id) => (id === VIA_LIVE ? { id, header: { id } } : undefined) }
  }
  if (overrideQuery !== undefined) services.sessionQuery = overrideQuery
  return services
}

/**
 * Build a plugin-facing ctx over a services map. Real Cordis resolves ctx.<service>
 * through its service resolver, so the proxy must answer get(name) from the map.
 */
function boot(options = {}) {
  const services = buildServices(options)
  const registered = []
  services.webServer = { register: (r) => (registered.push(r), () => {}) }
  const base = {
    get: (name) => services[name],
    provide() {},
    effect: (fn) => {
      const d = fn()
      return () => typeof d === 'function' && d()
    },
    logger: { warn: (...a) => warnings.push(a.join(' ')), error: (...a) => warnings.push(a.join(' ')), info() {} },
  }
  const ctx = new Proxy(base, {
    get(t, p, r) {
      if (typeof p === 'string' && p in services && !(p in t)) return services[p]
      return Reflect.get(t, p, r)
    },
  })
  plugin.apply(ctx)
  const routeOf = (p) => {
    const r = registered.find((x) => x.path === p)
    if (!r) throw new Error(`route ${p} not registered (got ${registered.map((x) => x.path).join(', ')})`)
    return r
  }
  const makeRes = () => ({
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(c, h) {
      this.statusCode = c
      this.headers = h
      return this
    },
    end(c) {
      if (c !== undefined) this.body += String(c)
    },
  })
  const OK = { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin' }
  return {
    routes: registered,
    async get(p) {
      const res = makeRes()
      await routeOf(p).handler({ method: 'GET', headers: { ...OK }, async *[Symbol.asyncIterator]() {} }, res)
      return res
    },
    async post(p, payload) {
      const res = makeRes()
      const chunks = [Buffer.from(JSON.stringify(payload ?? {}))]
      await routeOf(p).handler(
        { method: 'POST', headers: { ...OK, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } },
        res,
      )
      return res
    },
  }
}

const rowsOf = (res) => new Map(JSON.parse(res.body).sessions.map((r) => [r.id, r]))

console.log('=== plugin:', PLUGIN)
console.log('=== fake home:', RUN, '\n')

/* ---------------- checks ---------------- */
await check('1. projection-cache titles resolve for BOTH val shapes (bare string and {title})', async () => {
  mod.clearTitleCache()
  const b = boot({ withQuery: true })
  const res = await b.get('/dsh-session-manager/list')
  assert(res.statusCode === 200, `status ${res.statusCode}: ${res.body.slice(0, 200)}`)
  const rows = rowsOf(res)
  const bare = rows.get(CACHE_BARE)
  assert(bare && bare.title === '测试会话', `bare-string title lost: ${JSON.stringify(bare && bare.title)}`)
  assert(bare.titleSource === 'cache', `bare titleSource=${bare.titleSource}`)
  const obj = rows.get(CACHE_OBJ)
  assert(obj && obj.title === '对象形状的标题', `object-shaped title lost: ${JSON.stringify(obj && obj.title)}`)
  assert(obj.titleSource === 'cache', `object titleSource=${obj.titleSource}`)
  return `"${bare.title}" (cache) + "${obj.title}" (cache)`
})

await check('2. legacy whole-unit session_projcache.json is used as a fallback', async () => {
  mod.clearTitleCache()
  const b = boot({ withQuery: true })
  const rows = rowsOf(await b.get('/dsh-session-manager/list'))
  const row = rows.get(LEGACY)
  assert(row && row.title === '旧格式标题', `legacy title lost: ${JSON.stringify(row && row.title)}`)
  assert(row.titleSource === 'cache', `legacy titleSource=${row.titleSource}`)
  return `"${row.title}" (cache/legacy)`
})

await check('3. a session whose val is null and has no other source yields "" and titleSource "none"', async () => {
  mod.clearTitleCache()
  const b = boot({ withQuery: true })
  const rows = rowsOf(await b.get('/dsh-session-manager/list'))
  const row = rows.get(NO_TITLE)
  assert(row, 'row missing')
  assert(row.title === '', `expected empty title, got ${JSON.stringify(row.title)}`)
  assert(row.titleSource === 'none', `expected titleSource "none", got ${JSON.stringify(row.titleSource)}`)
  return 'title="" titleSource="none"'
})

await check('4. sessionQuery title is read from value.title.title (the original bug)', async () => {
  mod.clearTitleCache()
  const b = boot({ withQuery: true })
  const rows = rowsOf(await b.get('/dsh-session-manager/list'))
  const row = rows.get(VIA_QUERY)
  assert(row && row.title === '查询出来的标题', `query title lost: ${JSON.stringify(row && row.title)}`)
  assert(row.titleSource === 'query', `expected titleSource "query", got ${row.titleSource}`)
  return `"${row.title}" (query) — value.title is an object, text at .title.title`
})

await check('5. live sessionTitle.get wins over every other source', async () => {
  mod.clearTitleCache()
  writeMirror(VIA_LIVE, '缓存里的旧标题')
  const b = boot({ withQuery: true, withLive: true })
  const rows = rowsOf(await b.get('/dsh-session-manager/list'))
  const row = rows.get(VIA_LIVE)
  assert(row && row.title === '活会话标题', `live title lost: ${JSON.stringify(row && row.title)}`)
  assert(row.titleSource === 'live', `expected titleSource "live", got ${row.titleSource}`)
  return `"${row.title}" (live) beats the cached "缓存里的旧标题"`
})

await check('6. no sessionQuery / no sessionTitle: listing still 200, cache layer still works', async () => {
  mod.clearTitleCache()
  const b = boot({ withQuery: false })
  const res = await b.get('/dsh-session-manager/list')
  assert(res.statusCode === 200, `status ${res.statusCode}: ${res.body.slice(0, 200)}`)
  const rows = rowsOf(res)
  assert(rows.get(CACHE_BARE).title === '测试会话', 'cache layer must still work without sessionQuery')
  assert(rows.get(NO_TITLE).titleSource === 'none', 'missing source should report "none"')
  return `200 without sessionQuery; cache still supplies "${rows.get(CACHE_BARE).title}"`
})

await check('7. a THROWING sessionQuery is swallowed and falls back to cache', async () => {
  mod.clearTitleCache()
  const before = warnings.length
  const b = boot({ overrideQuery: { async readTitleSnapshots() { throw new Error('boom') } } })
  const res = await b.get('/dsh-session-manager/list')
  assert(res.statusCode === 200, `a throwing sessionQuery broke the listing: ${res.statusCode}`)
  const rows = rowsOf(res)
  assert(rows.get(CACHE_BARE).title === '测试会话', 'did not fall back to cache')
  assert(warnings.length > before, 'no warning was logged for the failed query read')
  return '200; cache used; warning logged'
})

await check('8. POST /resolve returns the same titles + titleSource as /list', async () => {
  mod.clearTitleCache()
  const b = boot({ withQuery: true })
  const res = await b.post('/dsh-session-manager/resolve', { sessionIds: [CACHE_BARE, CACHE_OBJ, LEGACY, NO_TITLE] })
  assert(res.statusCode === 200, `status ${res.statusCode}: ${res.body.slice(0, 200)}`)
  const rows = rowsOf(res)
  assert(rows.get(CACHE_BARE).title === '测试会话', 'resolve lost the bare-string title')
  assert(rows.get(CACHE_OBJ).title === '对象形状的标题', 'resolve lost the object-shaped title')
  assert(rows.get(LEGACY).title === '旧格式标题', 'resolve lost the legacy title')
  assert(rows.get(NO_TITLE).title === '' && rows.get(NO_TITLE).titleSource === 'none', 'resolve should return "" / none')
  return 'resolve matches list for all four cases'
})

await check('9. every row carries title and a valid titleSource', async () => {
  mod.clearTitleCache()
  const b = boot({ withQuery: true })
  const body = JSON.parse((await b.get('/dsh-session-manager/list')).body)
  for (const row of body.sessions) {
    assert(Object.hasOwn(row, 'title'), `row ${row.id} has no title field`)
    assert(Object.hasOwn(row, 'titleSource'), `row ${row.id} has no titleSource field`)
    assert(['live', 'query', 'cache', 'none'].includes(row.titleSource), `bad titleSource ${row.titleSource}`)
  }
  return `${body.sessions.length} rows all carry title + titleSource`
})

await check('10. the short TTL cache is honoured (second call does not re-read the mirror)', async () => {
  mod.clearTitleCache()
  const b = boot({ withQuery: true })
  const first = rowsOf(await b.get('/dsh-session-manager/list')).get(CACHE_BARE)
  assert(first.title === '测试会话', 'first read failed')
  // Blank the doc on disk; within the TTL the cached value must still be served.
  fs.writeFileSync(path.join(MIRROR, `${CACHE_BARE}.json`), JSON.stringify({ version: 3, record: { rows: {} } }))
  const second = rowsOf(await b.get('/dsh-session-manager/list')).get(CACHE_BARE)
  assert(second.title === '测试会话', `cache TTL not honoured: got ${JSON.stringify(second.title)}`)
  // After clearing, the (now empty) doc is re-read and the title disappears.
  mod.clearTitleCache()
  const third = rowsOf(await b.get('/dsh-session-manager/list')).get(CACHE_BARE)
  assert(third.title === '', `clearTitleCache did not force a re-read: ${JSON.stringify(third.title)}`)
  writeMirror(CACHE_BARE, '测试会话')
  return `cached within ${mod.TITLE_CACHE_TTL_MS ?? 2000}ms; re-read after clear`
})

await check('11. an EMPTY result is never cached (a later title still shows up immediately)', async () => {
  mod.clearTitleCache()
  // First call: no title anywhere for NO_TITLE.
  let b = boot({ withQuery: true })
  assert(rowsOf(await b.get('/dsh-session-manager/list')).get(NO_TITLE).title === '', 'precondition: expected empty')
  // Now give it a title and immediately re-list on the SAME plugin instance / same cache.
  writeMirror(NO_TITLE, '后来才有的标题')
  b = boot({ withQuery: true })
  const row = rowsOf(await b.get('/dsh-session-manager/list')).get(NO_TITLE)
  assert(row.title === '后来才有的标题', `empty result was cached and hid a new title: ${JSON.stringify(row.title)}`)
  writeMirror(NO_TITLE, null)
  return 'empty result not cached; new title visible on the next call'
})

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} title checks passed`)
fs.writeFileSync(path.join(HERE, 'titles-results.json'), JSON.stringify({ run: RUN, results }, null, 2))
if (passed !== results.length) {
  console.log('\nFAILURES:')
  for (const r of results.filter((x) => !x.ok)) console.log(' - ' + r.id + ': ' + r.detail)
}
process.exitCode = passed === results.length ? 0 : 1
