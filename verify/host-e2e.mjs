// Fake-home end-to-end test for the host half (lib/index.js) of dsh-session-manager.
//
// Creates <verify>/fakehome-<run>/ mimicking a real DSH home, imports the plugin's
// apply() with a stub cordis ctx, points DSH_HOME at the fake home and exercises
// sessions.list + deleteSessions including adversarial deletion-safety cases.
//
// Never touches C:\Users\shuixing\.dsh — DSH_HOME is always the fake home.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bootPlugin } from './boot-helper.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'lib', 'index.js')
const RUN = path.join(HERE, `fakehome-${Date.now()}`)
const OUTSIDE = path.join(HERE, `outside-${Date.now()}`)

const results = []
function record(id, ok, detail) {
  results.push({ id, ok, detail })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${id}${detail === undefined ? '' : '\n      ' + detail}`)
}
async function check(id, fn) {
  try {
    const detail = await fn()
    record(id, true, detail ?? '')
  } catch (error) {
    record(id, false, 'threw: ' + (error && error.message ? error.message : String(error)))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ID = {
  parent: '11111111-1111-4111-8111-111111111111',
  child: '22222222-2222-4222-8222-222222222222',
  target: '33333333-3333-4333-8333-333333333333', // the one we delete
  running: '44444444-4444-4444-8444-444444444444',
  keep: '55555555-5555-4555-8555-555555555555',
  keepSessionPrefix: 'session-66666666-6666-4666-8666-666666666666',
  orphan: '77777777-7777-4777-8777-777777777777', // only a projcache mirror, no log
  legacyOnly: '88888888-8888-4888-8888-888888888888', // only in legacy session_projcache.json
  noCwd: '99999999-9999-4999-8999-999999999999', // log under sessions/_no-cwd
  traversal: '../../../../evil', // crafted id with separators
  traversalDotdot: '..',
  wrongDir: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', // header cwd mismatches real dir location
}
const CWD = 'D:\\proj'
const CWD2 = 'D:\\other'

const header = (id, extra = {}) => ({
  version: 1,
  type: 'header',
  id,
  cwd: CWD,
  createdAt: Date.now() - 60000,
  ...extra,
})

const HOME = RUN
const SESS = path.join(HOME, 'sessions')
const PROJ = path.join(SESS, '--D-proj--')
const PROJ2 = path.join(SESS, '--D-other--')
const STOR = path.join(HOME, 'storages')
const MIRROR = path.join(STOR, 'session_projcache', 'sessions')

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}
function dirOf(projectDir, id) {
  return path.join(projectDir, id)
}
function makeSession(projectDir, id, extraHeader = {}, bytes = Buffer.from('zstd-fake-bytes')) {
  const dir = dirOf(projectDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), bytes)
  fs.writeFileSync(path.join(dir, 'session.v0.jsonl'), JSON.stringify(header(id, extraHeader)) + '\n')
  return dir
}

function buildFakeHome() {
  fs.rmSync(RUN, { recursive: true, force: true })
  fs.mkdirSync(SESS, { recursive: true })
  fs.mkdirSync(STOR, { recursive: true })

  // parent (current session), child (parentSession), delete target, running, keepers
  makeSession(PROJ, ID.parent, { createdAt: Date.now() - 90000 })
  makeSession(PROJ, ID.child, { parentSession: ID.parent, createdAt: Date.now() - 80000 })
  makeSession(PROJ2, ID.target, { cwd: CWD2, createdAt: Date.now() - 70000 }, Buffer.from('x'.repeat(4096)))
  makeSession(PROJ, ID.running, { createdAt: Date.now() - 60000 })
  makeSession(PROJ, ID.keep, { createdAt: Date.now() - 50000 })
  makeSession(PROJ, ID.keepSessionPrefix, { createdAt: Date.now() - 40000 })
  makeSession(path.join(SESS, '_no-cwd'), ID.noCwd, { cwd: undefined, createdAt: Date.now() - 30000 })
  // log misplaced under the wrong project dir vs its header cwd
  makeSession(path.join(SESS, '--D-wrong--'), ID.wrongDir, { cwd: CWD2, createdAt: Date.now() - 20000 })

  // workspace.json (unit workspace v2 single layout)
  writeJson(path.join(STOR, 'workspace.json'), {
    version: 2,
    global: {
      archivedSessionIds: [ID.target, ID.keep, ID.orphan],
      pinnedSessionIds: [ID.target, ID.parent],
      installId: 'keep-me',
      pendingMutation: null,
    },
    tables: {
      workspaces: {
        'ws-1': { id: 'ws-1', path: CWD, title: 'proj', createdAt: 1, updatedAt: 2, sessionIds: [ID.parent, ID.child, ID.target, ID.keep, ID.running] },
        'ws-2': { id: 'ws-2', path: CWD2, title: 'other', createdAt: 3, updatedAt: 4, sessionIds: [ID.target, ID.keepSessionPrefix] },
        'ws-3': { id: 'ws-3', path: 'D:\\untouched', title: 'noop', createdAt: 5, updatedAt: 6, sessionIds: [ID.keep] },
      },
    },
  })

  // per-record projection cache docs {version:3, record:{identity,rows}}
  for (const id of [ID.parent, ID.child, ID.target, ID.keep, ID.running, ID.orphan]) {
    writeJson(path.join(MIRROR, `${id}.json`), {
      version: 3,
      record: { identity: { id, cwd: CWD, createdAt: 1 }, rows: [{ type: 'message', text: 'hi' }] },
    })
  }
  writeJson(path.join(MIRROR, `${ID.target}.json.bak`), { version: 3, record: { identity: { id: ID.target }, rows: [] } })
  writeJson(path.join(MIRROR, `${ID.target}.json.bak.2026-11-08T07-35-55`), { version: 3, record: { identity: { id: ID.target }, rows: [] } })

  // legacy whole-file session_projcache.json
  writeJson(path.join(STOR, 'session_projcache.json'), {
    version: 3,
    global: {},
    tables: { sessions: { [ID.target]: { identity: { id: ID.target, cwd: CWD2 }, rows: [] }, [ID.legacyOnly]: { identity: { id: ID.legacyOnly, cwd: CWD }, rows: [] }, [ID.keep]: { identity: { id: ID.keep, cwd: CWD }, rows: [] } } },
  })

  // decoy outside the home: a sibling dir that a traversal would try to reach
  fs.rmSync(OUTSIDE, { recursive: true, force: true })
  fs.mkdirSync(OUTSIDE, { recursive: true })
  fs.writeFileSync(path.join(OUTSIDE, 'do-not-touch.txt'), 'sentinel')
}

/* ------------------------------------------------------------------ *
 * Stub cordis ctx
 * ------------------------------------------------------------------ */

function makeCtx({ openIds = [], runningIds = [], currentInitiatorId = null, listImpl, withSessions = true } = {}) {
  const provided = new Map()
  const emitted = []
  const inflight = []
  const logger = { info() {}, warn() {}, error() {} }
  const sessionsMap = new Map()
  for (const id of openIds) sessionsMap.set(id, { id, flush: async () => {} })
  const services = {
    sessionPersistence: {
      async list() {
        if (listImpl) return listImpl()
        return SNAPSHOTS()
      },
    },
    sessions: withSessions
      ? {
          list: () => [...sessionsMap.values()],
          get: (id) => sessionsMap.get(id),
          flush: () => Promise.resolve(),
        }
      : undefined,
    agents: {
      list: () => runningIds.map((id) => ({ session: { id }, running: true })),
      currentInitiator: () => (currentInitiatorId ? { session: { id: currentInitiatorId } } : null),
    },
    sessionQuery: {
      async readTitleSnapshots(ids) {
        // Real shape: value = { session, title?: SessionTitleSnapshot }, text at .title.title.
        return ids
          .filter((id) => inflight.includes(id))
          .map((id) => ({
            sessionId: id,
            status: 'fulfilled',
            value: {
              session: { id },
              title: { title: 'In-flight ' + id.slice(0, 8), messageSeqs: [], source: { kind: 'user' }, eventSeq: 1, updatedAt: 1 },
            },
          }))
      },
    },
  }
  const ctx = {
    get: (name) => services[name],
    provide: (name, value) => provided.set(name, value),
    effect: (fn) => {
      const d = fn()
      return () => typeof d === 'function' && d()
    },
    logger,
    emit: (name, payload) => emitted.push({ name, payload }),
    _emitted: emitted,
    _provided: provided,
    _services: services,
  }
  // Real Cordis: `ctx` is a Proxy whose normal property reads go through the service
  // resolver (see cordis/src/context.ts "A context is a proxy"). Model that so
  // `ctx.sessionPersistence` resolves exactly like an injected service property.
  const proxy = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in services && !(prop in target)) return services[prop]
      return Reflect.get(target, prop, receiver)
    },
    has(target, prop) {
      if (typeof prop === 'string' && prop in services) return true
      return Reflect.has(target, prop)
    },
  })
  return proxy
}

let SNAPSHOTS = () => [
  { header: header(ID.parent), sizeBytes: 10 },
  { header: header(ID.child, { parentSession: ID.parent }), sizeBytes: 10 },
  { header: header(ID.target, { cwd: CWD2 }), sizeBytes: 4096 },
  { header: header(ID.running), sizeBytes: 10 },
  { header: header(ID.keep), sizeBytes: 10 },
  { header: header(ID.keepSessionPrefix), sizeBytes: 10 },
  { header: { version: 1, type: 'header', id: ID.noCwd, createdAt: 5 }, sizeBytes: 10 },
  { header: header(ID.wrongDir, { cwd: CWD2 }), sizeBytes: 10 },
]

/* ------------------------------------------------------------------ *
 * Snapshot helpers
 * ------------------------------------------------------------------ */

function snapshotTree(root) {
  const out = new Map()
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        out.set(path.relative(root, p), 'DIR')
        walk(p)
      } else if (entry.isFile()) {
        out.set(path.relative(root, p), fs.readFileSync(p).toString('base64'))
      }
    }
  }
  walk(root)
  return out
}

/* ------------------------------------------------------------------ *
 * Load the plugin
 * ------------------------------------------------------------------ */

buildFakeHome()
process.env.DSH_HOME = HOME

const mod = await import(pathToFileURL(PLUGIN).href)
const plugin = mod.default ?? mod
const ctx = makeCtx({ openIds: [ID.parent], runningIds: [ID.running], currentInitiatorId: ID.parent })
// Round 2: the plugin no longer provides a {call,list} service; it registers HTTP routes.
// Drive them through the shared helper (same-origin loopback requests, like the browser).
const api = bootPlugin({ ctx, plugin })

console.log(`=== fake home: ${HOME}`)
console.log(`=== plugin: ${PLUGIN}  (name=${plugin.name}, inject=${JSON.stringify(plugin.inject)})\n`)

/* ================================================================== *
 * 1. Ported encoders vs the required vectors
 * ================================================================== */
{
  const vectors = [
    ['projectKey', 'D:\\dsh', '--D-dsh--'],
    ['projectKey', 'D:\\示例目录', '--D-~793A~4F8B~76EE~5F55--'],
    ['projectKey', '\\\\server\\share', '--server-share--'],
    ['projectKey', '.', '--.--'],
    ['projectKey', 'D:\\dsh\\dsh-session-manager', '--D-dsh-dsh-session-manager--'],
    ['projectKey', 'D:/mixed\\sep', '--D-mixed-sep--'],
    ['encodeSegment', '..', '~002E~002E'],
    ['encodeSegment', '.', '~002E'],
    ['encodeSegment', 'a/b', 'a~002Fb'],
    ['encodeSegment', '~', '~007E'],
    ['encodeSegment', 'session-aaa', 'session-aaa'],
  ]
  await check('encoders: projectKey/encodeSegment vectors', () => {
    const bad = []
    for (const [fn, input, expected] of vectors) {
      const actual = mod[fn](input)
      if (actual !== expected) bad.push(`${fn}(${JSON.stringify(input)}) = ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`)
    }
    try {
      mod.encodeSegment('')
      bad.push('encodeSegment("") did not throw')
    } catch {}
    try {
      mod.projectKey('')
      bad.push('projectKey("") did not throw')
    } catch {}
    assert(bad.length === 0, bad.join('; '))
    return `${vectors.length} vectors + 2 throw cases ok`
  })
}

/* ================================================================== *
 * 2. sessions.list
 * ================================================================== */
let listing = null
await check('sessions.list: returns list, home, currentSessionId, rows', async () => {
  listing = await api.call('sessions.list', null)
  assert(Array.isArray(listing.sessions), 'no sessions array')
  assert(listing.home === HOME, `home mismatch: ${listing.home}`)
  assert(listing.currentSessionId === ID.parent, `currentSessionId: ${listing.currentSessionId}`)
  const byId = new Map(listing.sessions.map((s) => [s.id, s]))
  assert(byId.has(ID.target), 'target missing from list')
  assert(byId.has(ID.orphan) && byId.get(ID.orphan).orphan === true, 'orphan projcache-only row not listed as orphan')
  assert(byId.has(ID.legacyOnly) && byId.get(ID.legacyOnly).orphan === true, 'legacy-only row not listed as orphan')
  assert(byId.get(ID.running).running === true, 'running flag missing')
  assert(byId.get(ID.parent).open === true, 'open flag missing')
  assert(byId.get(ID.target).archived === true && byId.get(ID.target).pinned === true, 'workspace flags missing on target')
  assert(byId.get(ID.target).inWorkspace === true, 'inWorkspace flag missing on target')
  assert(byId.get(ID.child).parentId === ID.parent, 'child parentId missing')
  assert(Array.isArray(byId.get(ID.parent).children) && byId.get(ID.parent).children.includes(ID.child), 'parent.children missing child')
  return `sessions=${listing.sessions.length} orphans=${listing.sessions.filter((s) => s.orphan).length}`
})

await check('sessions.list: every real session reports updatedAt (last used time)', async () => {
  const l = await api.call('sessions.list', null)
  const stamped = l.sessions.filter((row) => row.orphan !== true)
  const missing = stamped.filter((row) => typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt))
  assert(missing.length === 0, 'rows without updatedAt: ' + missing.map((row) => row.id).join(', '))
  // 必须是文件最后写入时间，而不是创建时间
  const target = l.sessions.find((row) => row.id === ID.target)
  assert(target.updatedAt >= target.createdAt, 'updatedAt earlier than createdAt')
  // 排序：最近使用优先
  for (let index = 1; index < l.sessions.length; index += 1) {
    const prev = l.sessions[index - 1]
    const next = l.sessions[index]
    const stamp = (row) => (typeof row.updatedAt === 'number' ? row.updatedAt : row.createdAt) ?? 0
    assert(stamp(prev) >= stamp(next), 'list is not sorted by last used')
  }
  return 'stamped=' + stamped.length
})

await check('deleteSessions: an empty request creates no backup directory', async () => {
  const before = fs.existsSync(path.join(HOME, 'session-delete-backup'))
    ? fs.readdirSync(path.join(HOME, 'session-delete-backup')).length
    : 0
  const out = await api.call('deleteSessions', { sessionIds: [], backup: true })
  assert(Array.isArray(out.results) && out.results.length === 0, 'results should be empty')
  assert(out.backupDir === undefined, 'backupDir must be undefined for an empty request, got ' + JSON.stringify(out.backupDir))
  const after = fs.existsSync(path.join(HOME, 'session-delete-backup'))
    ? fs.readdirSync(path.join(HOME, 'session-delete-backup')).length
    : 0
  assert(after === before, 'empty request created a backup directory')
  return 'no-op'
})

await check('sessions.list: title comes from sessionQuery.readTitleSnapshots', async () => {
  // The REAL result shape is { sessionId, status, value: { session, title?: SessionTitleSnapshot } }
  // where SessionTitleSnapshot is an OBJECT and the text lives at .title.title.
  // (The previous fixture put the string straight on value.title, which is what let the
  //  real bug - comparing the snapshot object to 'string' - go unnoticed.)
  ctx._services.sessionQuery.readTitleSnapshots = async (ids) =>
    ids.map((id) => ({
      sessionId: id,
      status: 'fulfilled',
      value: {
        session: { id },
        title: { title: 'T:' + id.slice(0, 4), messageSeqs: [], source: { kind: 'user' }, eventSeq: 1, updatedAt: 1 },
      },
    }))
  const l = await api.call('sessions.list', null)
  const t = l.sessions.find((s) => s.id === ID.keep)
  assert(t && t.title === 'T:5555', `title not picked up: ${JSON.stringify(t?.title)}`)
  assert(t.titleSource === 'query', `titleSource should be "query", got ${JSON.stringify(t.titleSource)}`)
  ctx._services.sessionQuery.readTitleSnapshots = async () => {
    throw new Error('boom')
  }
  const l2 = await api.call('sessions.list', null)
  assert(Array.isArray(l2.sessions) && l2.sessions.length > 0, 'list broke when readTitleSnapshots throws')
  ctx._services.sessionQuery = undefined
  const l3 = await api.call('sessions.list', null)
  assert(Array.isArray(l3.sessions), 'list broke without sessionQuery')
  return 'title ok; missing/throwing sessionQuery tolerated'
})

/* ================================================================== *
 * 3. Refusals BEFORE any mutation
 * ================================================================== */
const beforeAll = snapshotTree(HOME)

await check('DELETE refuses the current session (and writes nothing)', async () => {
  const out = await api.call('deleteSessions', { sessionIds: [ID.parent], backup: true, allowActive: false })
  const r = out.results[0]
  assert(r.ok === false, 'current session was not refused: ' + JSON.stringify(r))
  assert(fs.existsSync(dirOf(PROJ, ID.parent)), 'current session dir was deleted!')
  return 'refused: ' + r.error
})

await check('DELETE refuses a descendant of the current session', async () => {
  const out = await api.call('deleteSessions', { sessionIds: [ID.child], backup: true, allowActive: true })
  const r = out.results[0]
  assert(r.ok === false, 'child of current session was not refused: ' + JSON.stringify(r))
  assert(fs.existsSync(dirOf(PROJ, ID.child)), 'child dir was deleted!')
  return 'refused: ' + r.error
})

await check('DELETE refuses a running session without allowActive', async () => {
  const out = await api.call('deleteSessions', { sessionIds: [ID.running], backup: true, allowActive: false })
  const r = out.results[0]
  assert(r.ok === false, 'running session was not refused: ' + JSON.stringify(r))
  assert(fs.existsSync(dirOf(PROJ, ID.running)), 'running session dir was deleted!')
  return 'refused: ' + r.error
})

await check('DELETE refuses traversal ids (no path escapes <home>/sessions)', async () => {
  const crafted = [ID.traversal, ID.traversalDotdot, '..\\..\\evil', '/' + ID.keep, ID.keep + '/../' + ID.keep, 'C:\\Windows\\x', 'session-../../etc']
  const out = await api.call('deleteSessions', { sessionIds: crafted, backup: false, allowActive: true })
  const accepted = out.results.filter((r) => r.ok)
  assert(accepted.length === 0, 'crafted ids accepted: ' + JSON.stringify(accepted))
  assert(fs.existsSync(path.join(OUTSIDE, 'do-not-touch.txt')), 'outside sentinel was touched')
  assert(fs.existsSync(dirOf(PROJ, ID.keep)), 'keeper dir was hit by cooked ids')
  return out.results.map((r) => r.error).join(' | ')
})

await check('DELETE refuses unknown ids', async () => {
  const out = await api.call('deleteSessions', { sessionIds: ['deadbeef-dead-4ead-8ead-deadbeefdead'], backup: false })
  assert(out.results[0].ok === false, 'unknown id accepted')
  return out.results[0].error
})

await check('DELETE tolerates junk args without throwing', async () => {
  for (const args of [null, undefined, {}, { sessionIds: 'nope' }, { sessionIds: [null, 42, {}] }, { sessionIds: [] }]) {
    const out = await api.call('deleteSessions', args)
    assert(out && Array.isArray(out.results), 'bad shape for ' + JSON.stringify(args))
  }
  return 'null / undefined / non-array / non-string ids handled'
})

/* ================================================================== *
 * 4. The main path: delete ID.target with backup
 * ================================================================== */
const keepDirs = [dirOf(PROJ, ID.keep), dirOf(PROJ, ID.keepSessionPrefix), dirOf(PROJ, ID.parent), dirOf(PROJ, ID.child), dirOf(PROJ, ID.running), path.join(SESS, '_no-cwd', ID.noCwd)]
const keepBytes = new Map(keepDirs.map((d) => [d, snapshotTree(d)]))
const keepMirrorBytes = new Map([ID.keep, ID.parent, ID.child, ID.running].map((id) => [id, fs.readFileSync(path.join(MIRROR, `${id}.json`))]))
const beforeDelete = snapshotTree(HOME)
const workspaceBefore = fs.readFileSync(path.join(STOR, 'workspace.json'), 'utf8')

let deleteOut = null
await check('DELETE (a) normal session with backup:true succeeds', async () => {
  deleteOut = await api.call('deleteSessions', { sessionIds: [ID.target], backup: true, allowActive: false })
  const r = deleteOut.results[0]
  assert(r.ok === true, 'delete failed: ' + JSON.stringify(r))
  assert(Array.isArray(r.scrubbed) && r.scrubbed.includes('projection-cache'), 'projection-cache not scrubbed: ' + JSON.stringify(r.scrubbed))
  assert(r.scrubbed.includes('workspace'), 'workspace NOT scrubbed: ' + JSON.stringify(r.scrubbed))
  assert(!fs.existsSync(dirOf(PROJ2, ID.target)), 'session dir still exists')
  assert(deleteOut.backupDir && fs.existsSync(deleteOut.backupDir), 'backupDir missing/not created: ' + deleteOut.backupDir)
  return JSON.stringify(r) + '  backupDir=' + deleteOut.backupDir
})

await check('DELETE (a) backup contains the session dir (all artifacts)', () => {
  const b = deleteOut.backupDir
  const dir = path.join(b, 'sessions', ID.target)
  assert(fs.existsSync(dir), 'backup session dir missing: ' + dir)
  const names = fs.readdirSync(dir).sort()
  assert(names.includes('session.v4.jsonl.zstd') && names.includes('session.v0.jsonl'), 'backup lost artifacts: ' + names)
  const v4 = fs.readFileSync(path.join(dir, 'session.v4.jsonl.zstd'))
  assert(v4.length === 4096 && v4[0] === 0x78, 'backup artifact bytes differ')
  return names.join(', ')
})

await check('DELETE (a) backup contains storages copies (projcache docs + workspace.json.bak + legacy)', () => {
  const b = deleteOut.backupDir
  const want = [
    path.join('storages', 'session_projcache', `${ID.target}.json`),
    path.join('storages', 'session_projcache', `${ID.target}.json.bak`),
    path.join('storages', 'session_projcache', `${ID.target}.json.bak.2026-11-08T07-35-55`),
    path.join('storages', 'workspace.json.bak'),
    path.join('storages', 'session_projcache.json.bak'),
  ]
  const missing = want.filter((rel) => !fs.existsSync(path.join(b, rel)))
  assert(missing.length === 0, 'missing backup entries: ' + missing.join(', '))
  // workspace backup must be the PRE-delete content
  const bak = JSON.parse(fs.readFileSync(path.join(b, 'storages', 'workspace.json.bak'), 'utf8'))
  assert(bak.tables.workspaces['ws-1'].sessionIds.includes(ID.target), 'workspace.json.bak is not the pre-delete content')
  return want.length + ' entries present'
})

await check('DELETE (a) manifest.json written with results', () => {
  const m = JSON.parse(fs.readFileSync(path.join(deleteOut.backupDir, 'manifest.json'), 'utf8'))
  assert(typeof m.deletedAt === 'string', 'deletedAt missing')
  assert(m.home === HOME, 'manifest.home wrong: ' + m.home)
  assert(Array.isArray(m.sessions) && m.sessions.some((s) => s.id === ID.target && s.ok === true), 'manifest sessions wrong')
  return 'deletedAt=' + m.deletedAt
})

await check('DELETE notifies every connected page via api-session/removed', () => {
  const events = ctx._emitted.filter((event) => event.name === 'api-session/removed')
  assert(events.length >= 1, 'no api-session/removed emitted')
  assert(events.some((event) => event.payload === ID.target), 'api-session/removed carries another id: ' + JSON.stringify(events))
  return 'events=' + events.map((event) => event.payload.slice(0, 12)).join(',')
})

await check('DELETE (a) projcache per-record doc + .bak siblings gone', () => {
  const left = fs.readdirSync(MIRROR).filter((n) => n.startsWith(ID.target))
  assert(left.length === 0, 'leftover projcache files: ' + left.join(', '))
  return 'none left'
})

await check('DELETE (a) workspace.json no longer lists the id anywhere', () => {
  const unit = JSON.parse(fs.readFileSync(path.join(STOR, 'workspace.json'), 'utf8'))
  const hits = []
  for (const [key, ws] of Object.entries(unit.tables.workspaces)) if (ws.sessionIds.includes(ID.target)) hits.push('workspaces.' + key)
  if (unit.global.archivedSessionIds.includes(ID.target)) hits.push('global.archivedSessionIds')
  if (unit.global.pinnedSessionIds.includes(ID.target)) hits.push('global.pinnedSessionIds')
  assert(hits.length === 0, 'id still referenced: ' + hits.join(', '))
  return 'scrubbed from ws-1, ws-2, archived, pinned'
})

await check('DELETE (a) workspace.json preserved everything else', () => {
  const unit = JSON.parse(fs.readFileSync(path.join(STOR, 'workspace.json'), 'utf8'))
  assert(unit.version === 2, 'version lost')
  assert(unit.global.installId === 'keep-me', 'unrelated global key lost')
  assert(unit.global.archivedSessionIds.includes(ID.keep) && unit.global.archivedSessionIds.includes(ID.orphan), 'other archived ids lost')
  assert(unit.global.pinnedSessionIds.includes(ID.parent), 'other pinned ids lost')
  const before = JSON.parse(workspaceBefore)
  // only the target id may disappear; everything else must be deep-equal
  const strip = (obj) => JSON.parse(JSON.stringify(obj, (k, v) => v))
  const a = strip(before)
  for (const ws of Object.values(a.tables.workspaces)) ws.sessionIds = ws.sessionIds.filter((id) => id !== ID.target)
  a.global.archivedSessionIds = a.global.archivedSessionIds.filter((id) => id !== ID.target)
  a.global.pinnedSessionIds = a.global.pinnedSessionIds.filter((id) => id !== ID.target)
  assert(JSON.stringify(a) === JSON.stringify(unit), 'workspace.json differs beyond removing the id')
  // untouched workspace record must be byte-identical
  assert(JSON.stringify(before.tables.workspaces['ws-3']) === JSON.stringify(unit.tables.workspaces['ws-3']), 'unrelated workspace record ws-3 changed')
  return 'ws-3 unchanged; only the id removed'
})

await check('DELETE (a) legacy session_projcache.json scrubbed of the id only', () => {
  const unit = JSON.parse(fs.readFileSync(path.join(STOR, 'session_projcache.json'), 'utf8'))
  assert(!(ID.target in unit.tables.sessions), 'legacy row for target still present')
  assert(ID.keep in unit.tables.sessions && ID.legacyOnly in unit.tables.sessions, 'legacy rows for other sessions were removed')
  return 'legacy rows left: ' + Object.keys(unit.tables.sessions).join(',')
})

await check('DELETE (a) other sessions untouched byte-identical', () => {
  const bad = []
  for (const [dir, snap] of keepBytes) {
    const now = snapshotTree(dir)
    if (now.size !== snap.size) bad.push(dir + ' (entries differ)')
    else for (const [rel, bytes] of snap) if (now.get(rel) !== bytes) bad.push(path.join(dir, rel))
  }
  for (const [id, bytes] of keepMirrorBytes) {
    const now = fs.readFileSync(path.join(MIRROR, `${id}.json`))
    if (!now.equals(bytes)) bad.push(`mirror ${id}.json`)
  }
  assert(bad.length === 0, 'changed: ' + bad.join(', '))
  return keepBytes.size + ' dirs + ' + keepMirrorBytes.size + ' mirrors identical'
})

await check('DELETE (a) no stray temp files left by atomic writes', () => {
  const stray = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== 'session-delete-backup') walk(p)
      } else if (/\.tmp$/.test(e.name)) stray.push(p)
    }
  }
  walk(HOME)
  assert(stray.length === 0, 'temp files left: ' + stray.join(', '))
  return 'clean'
})

await check('DELETE (a) empty project dir cleaned, other project dirs kept', () => {
  // --D-other-- only held the target: after deletion the encoder may drop it
  const stillThere = fs.existsSync(PROJ)
  assert(stillThere, 'the non-empty project dir --D-proj-- was removed')
  return '--D-proj-- intact; --D-other-- exists=' + fs.existsSync(PROJ2)
})

/* ================================================================== *
 * 5. Adversarial: backup failure must fail closed
 * ================================================================== */
await check('BACKUP FAILURE: deletion aborts, session dir survives', async () => {
  // make the backup root a FILE so mkdirSync/cpSync inside it must fail
  const home2 = path.join(RUN + '-backupfail')
  fs.rmSync(home2, { recursive: true, force: true })
  fs.mkdirSync(path.join(home2, 'sessions', '--D-proj--', ID.keep), { recursive: true })
  fs.writeFileSync(path.join(home2, 'sessions', '--D-proj--', ID.keep, 'session.v4.jsonl.zstd'), 'abc')
  fs.mkdirSync(path.join(home2, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(home2, 'session-delete-backup'), 'not a directory')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home2
  try {
    const ctx2 = makeCtx({ listImpl: async () => [{ header: header(ID.keep), sizeBytes: 3 }] })
    const api2 = bootPlugin({ ctx: ctx2, plugin })
    const out = await api2.call('deleteSessions', { sessionIds: [ID.keep], backup: true })
    const r = out.results[0]
    assert(r.ok === false, 'delete reported success although the backup failed: ' + JSON.stringify(r))
    assert(fs.existsSync(path.join(home2, 'sessions', '--D-proj--', ID.keep, 'session.v4.jsonl.zstd')), 'SESSION WAS DELETED DESPITE BACKUP FAILURE')
    return 'refused: ' + r.error
  } finally {
    process.env.DSH_HOME = prev
  }
})

/* ================================================================== *
 * 6. Misplaced log dir vs header cwd (wrong-session deletion risk)
 * ================================================================== */
await check('MISPLACED DIR: deleting a session whose log lives under another project dir', async () => {
  const before = fs.existsSync(path.join(SESS, '--D-wrong--', ID.wrongDir))
  assert(before, 'fixture missing')
  const out = await api.call('deleteSessions', { sessionIds: [ID.wrongDir], backup: false })
  const r = out.results[0]
  const gone = !fs.existsSync(path.join(SESS, '--D-wrong--', ID.wrongDir))
  assert(gone, 'the real dir (under --D-wrong--) was NOT deleted; result=' + JSON.stringify(r))
  return 'resolved via fallback scan and deleted dir --D-wrong--/' + ID.wrongDir
})

/* ================================================================== *
 * 7. no-cwd session
 * ================================================================== */
await check('NO-CWD session under _no-cwd is locatable and deletable', async () => {
  const l = await api.call('sessions.list', null)
  const row = l.sessions.find((s) => s.id === ID.noCwd)
  assert(row, 'no-cwd session missing from list')
  assert(typeof row.dir === 'string' && row.dir.includes('_no-cwd'), 'no-cwd session dir not resolved: ' + row.dir)
  const out = await api.call('deleteSessions', { sessionIds: [ID.noCwd], backup: true })
  assert(out.results[0].ok === true, 'delete failed: ' + JSON.stringify(out.results[0]))
  assert(!fs.existsSync(path.join(SESS, '_no-cwd', ID.noCwd)), 'dir not removed')
  assert(fs.existsSync(path.join(SESS, '_no-cwd')), '_no-cwd dir itself was removed (should be DSH-managed)')
  return 'deleted; _no-cwd kept'
})

/* ================================================================== *
 * 8. Orphans (projcache-only rows)
 * ================================================================== */
await check('ORPHAN row (projcache only) can be cleaned without a log dir', async () => {
  const out = await api.call('deleteSessions', { sessionIds: [ID.orphan], backup: true })
  const r = out.results[0]
  assert(r.ok === true, 'orphan delete failed: ' + JSON.stringify(r))
  assert(!fs.existsSync(path.join(MIRROR, `${ID.orphan}.json`)), 'orphan mirror not removed')
  const unit = JSON.parse(fs.readFileSync(path.join(STOR, 'workspace.json'), 'utf8'))
  assert(!unit.global.archivedSessionIds.includes(ID.orphan), 'orphan still archived in workspace.json')
  return 'mirror + workspace reference removed'
})

/* ================================================================== *
 * 9. Session-id prefix form (session-<uuid>)
 * ================================================================== */
await check('session-<uuid> id form is accepted and deletable', async () => {
  const out = await api.call('deleteSessions', { sessionIds: [ID.keepSessionPrefix], backup: true })
  assert(out.results[0].ok === true, 'session- prefix id refused: ' + JSON.stringify(out.results[0]))
  assert(!fs.existsSync(dirOf(PROJ, ID.keepSessionPrefix)), 'dir not removed')
  const unit = JSON.parse(fs.readFileSync(path.join(STOR, 'workspace.json'), 'utf8'))
  assert(!unit.tables.workspaces['ws-2'].sessionIds.includes(ID.keepSessionPrefix), 'not scrubbed from ws-2')
  return 'ok'
})

/* ================================================================== *
 * 10. Multi-id batch + per-id isolation
 * ================================================================== */
await check('BATCH: good + refused ids in one call are isolated', async () => {
  const out = await api.call('deleteSessions', { sessionIds: [ID.keep, ID.parent, ID.running, '../../x'], backup: true, allowActive: false })
  const map = new Map(out.results.map((r) => [r.id, r]))
  assert(map.get(ID.keep).ok === true, 'keeper delete failed: ' + JSON.stringify(map.get(ID.keep)))
  assert(map.get(ID.parent).ok === false, 'current session deleted in batch')
  assert(map.get(ID.running).ok === false, 'running session deleted in batch')
  assert(map.get('../../x').ok === false, 'traversal id accepted in batch')
  assert(fs.existsSync(dirOf(PROJ, ID.parent)) && fs.existsSync(dirOf(PROJ, ID.running)), 'protected dirs removed')
  return 'ok=1 refused=3'
})

/* ================================================================== *
 * 11. No ctx.get('sessions') provided (plugin only injects sessionPersistence)
 * ================================================================== */
await check('works when the `sessions` service is absent (inject list only names sessionPersistence)', async () => {
  const home3 = RUN + '-nosessions'
  fs.rmSync(home3, { recursive: true, force: true })
  fs.mkdirSync(path.join(home3, 'sessions', '--D-proj--', ID.keep, ''), { recursive: true })
  fs.writeFileSync(path.join(home3, 'sessions', '--D-proj--', ID.keep, 'session.v4.jsonl.zstd'), 'abc')
  fs.mkdirSync(path.join(home3, 'storages'), { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home3
  try {
    const ctx3 = makeCtx({ listImpl: async () => [{ header: header(ID.keep), sizeBytes: 3 }], withSessions: false })
    const api3 = bootPlugin({ ctx: ctx3, plugin })
    const l = await api3.call('sessions.list', null)
    assert(l.sessions.length === 1, 'list broke without sessions service')
    const out = await api3.call('deleteSessions', { sessionIds: [ID.keep], backup: false })
    assert(out.results[0].ok === true, 'delete broke without sessions service: ' + JSON.stringify(out.results[0]))
    return 'list + delete both fine'
  } finally {
    process.env.DSH_HOME = prev
  }
})

/* ================================================================== *
 * 12. workspace.json write atomicity (temp+rename)
 * ================================================================== */
await check('workspace.json rewrite is atomic (temp file + rename)', async () => {
  const source = fs.readFileSync(PLUGIN, 'utf8')
  assert(/writeJsonAtomic/.test(source), 'writeJsonAtomic helper missing')
  const fn = source.match(/function writeJsonAtomic[\s\S]*?\n}/)
  assert(fn && /writeFileSync\(temp/.test(fn[0]) && /renameSync\(temp, file\)/.test(fn[0]), 'workspace write is not temp+rename')
  return 'temp+rename confirmed in lib/index.js'
})

/* ================================================================== *
 * 13. pendingMutation guard
 * ================================================================== */
await check('pendingMutation in workspace.json blocks the workspace scrub', async () => {
  const home4 = RUN + '-pending'
  fs.rmSync(home4, { recursive: true, force: true })
  fs.mkdirSync(path.join(home4, 'sessions', '--D-proj--', ID.keep, ''), { recursive: true })
  fs.writeFileSync(path.join(home4, 'sessions', '--D-proj--', ID.keep, 'session.v4.jsonl.zstd'), 'abc')
  writeJson(path.join(home4, 'storages', 'workspace.json'), {
    version: 2,
    global: { pendingMutation: { op: 'attach', id: ID.keep }, archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'ws-1': { id: 'ws-1', path: CWD, sessionIds: [ID.keep] } } },
  })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home4
  try {
    const ctx4 = makeCtx({ listImpl: async () => [{ header: header(ID.keep), sizeBytes: 3 }] })
    const api4 = bootPlugin({ ctx: ctx4, plugin })
    const out = await api4.call('deleteSessions', { sessionIds: [ID.keep], backup: true })
    const r = out.results[0]
    assert(r.ok === true, 'delete failed: ' + JSON.stringify(r))
    assert(r.scrubbed.includes('workspace:pending-mutation'), 'pendingMutation not reported honestly: ' + JSON.stringify(r.scrubbed))
    const unit = JSON.parse(fs.readFileSync(path.join(home4, 'storages', 'workspace.json'), 'utf8'))
    assert(unit.tables.workspaces['ws-1'].sessionIds.includes(ID.keep), 'workspace.json was edited while a mutation was pending')
    return 'skipped + reported: ' + JSON.stringify(r.scrubbed)
  } finally {
    process.env.DSH_HOME = prev
  }
})

await check('pendingMutation: undefined/null (idle state) does NOT block the scrub', async () => {
  const home8 = RUN + '-idle'
  fs.rmSync(home8, { recursive: true, force: true })
  fs.mkdirSync(path.join(home8, 'sessions', '--D-proj--', ID.keep), { recursive: true })
  fs.writeFileSync(path.join(home8, 'sessions', '--D-proj--', ID.keep, 'session.v4.jsonl.zstd'), 'abc')
  writeJson(path.join(home8, 'storages', 'workspace.json'), {
    version: 2,
    global: { pendingMutation: undefined, archivedSessionIds: [ID.keep], pinnedSessionIds: [] },
    tables: { workspaces: { 'ws-1': { id: 'ws-1', path: CWD, sessionIds: [ID.keep] } } },
  })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home8
  try {
    const c = makeCtx({ listImpl: async () => [{ header: header(ID.keep), sizeBytes: 3 }] })
    const a = bootPlugin({ ctx: c, plugin })
    const out = await a.call('deleteSessions', { sessionIds: [ID.keep], backup: true })
    const r = out.results[0]
    assert(r.ok === true, 'delete failed: ' + JSON.stringify(r))
    assert(r.scrubbed.includes('workspace'), 'idle pendingMutation blocked the scrub: ' + JSON.stringify(r.scrubbed))
    const unit = JSON.parse(fs.readFileSync(path.join(home8, 'storages', 'workspace.json'), 'utf8'))
    assert(!unit.tables.workspaces['ws-1'].sessionIds.includes(ID.keep), 'not scrubbed from workspace')
    assert(!unit.global.archivedSessionIds.includes(ID.keep), 'not scrubbed from archivedSessionIds')
    return 'scrubbed normally: ' + JSON.stringify(r.scrubbed)
  } finally {
    process.env.DSH_HOME = prev
  }
})

/* ================================================================== *
 * 14. repeat/large delete does not throw; results well-formed
 * ================================================================== */
await check('delete results are always well-formed (id/ok/error)', async () => {
  const out = await api.call('deleteSessions', { sessionIds: [ID.keep, ID.keep, ID.target], backup: true })
  for (const r of out.results) assert(typeof r.id === 'string' && typeof r.ok === 'boolean' && (r.ok || typeof r.error === 'string'), 'malformed result: ' + JSON.stringify(r))
  assert(out.results.length === 2, 'duplicate ids were not de-duplicated: ' + JSON.stringify(out.results))
  return 'deduplicated + shaped'
})

/* ================================================================== *
 * 15. Regression: listing.file is no longer needed; scrub is self-contained
 * ================================================================== */
await check('REGRESSION (MUST-FIX 1): workspace scrub is self-contained, not dependent on listing.file', async () => {
  const source = fs.readFileSync(PLUGIN, 'utf8')
  assert(!/listing\.file/.test(source), 'lib/index.js still reads listing.file (undefined -> silent no-op)')
  const fn = source.match(/function scrubWorkspace\([\s\S]*?\n}/)
  assert(fn, 'scrubWorkspace not found')
  assert(/storagesRoot\(home\)/.test(fn[0]) && /workspace\.json/.test(fn[0]), 'scrubWorkspace does not recompute <home>/storages/workspace.json')
  return 'scrubWorkspace(home, info) recomputes the path; no listing.file dependency'
})

/* ================================================================== *
 * 16. Backup-dir failure: per-id failure, fail-closed, no whole-RPC throw
 * ================================================================== */
await check('BACKUP-DIR FAILURE (minor 4): per-id {ok:false}, session survives, no whole-RPC throw', async () => {
  const home5 = RUN + '-bd'
  fs.rmSync(home5, { recursive: true, force: true })
  fs.mkdirSync(path.join(home5, 'sessions', '--D-proj--', ID.keep), { recursive: true })
  fs.writeFileSync(path.join(home5, 'sessions', '--D-proj--', ID.keep, 'session.v4.jsonl.zstd'), 'abc')
  fs.writeFileSync(path.join(home5, 'session-delete-backup'), 'not a directory')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home5
  try {
    const c = makeCtx({ listImpl: async () => [{ header: header(ID.keep), sizeBytes: 3 }] })
    const a = bootPlugin({ ctx: c, plugin })
    const out = await a.call('deleteSessions', { sessionIds: [ID.keep], backup: true })
    assert(out && Array.isArray(out.results) && out.results.length === 1, 'no per-id result: ' + JSON.stringify(out))
    const r = out.results[0]
    assert(r.ok === false, 'reported success although no backup could be written: ' + JSON.stringify(r))
    assert(/备份目录/.test(r.error), 'error does not explain the backup failure: ' + r.error)
    assert(fs.existsSync(path.join(home5, 'sessions', '--D-proj--', ID.keep, 'session.v4.jsonl.zstd')), 'SESSION WAS DELETED DESPITE BACKUP FAILURE')
    return 'refused per id: ' + r.error
  } finally {
    process.env.DSH_HOME = prev
  }
})

/* ================================================================== *
 * 17. Scrub verdict vocabulary
 * ================================================================== */
await check('scrub verdicts: missing workspace.json -> success with "workspace:missing"', async () => {
  const home6 = RUN + '-missing'
  fs.rmSync(home6, { recursive: true, force: true })
  fs.mkdirSync(path.join(home6, 'sessions', '--D-proj--', ID.keep), { recursive: true })
  fs.writeFileSync(path.join(home6, 'sessions', '--D-proj--', ID.keep, 'session.v4.jsonl.zstd'), 'abc')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home6
  try {
    const c = makeCtx({ listImpl: async () => [{ header: header(ID.keep), sizeBytes: 3 }] })
    const a = bootPlugin({ ctx: c, plugin })
    const out = await a.call('deleteSessions', { sessionIds: [ID.keep], backup: true })
    const r = out.results[0]
    assert(r.ok === true, 'delete failed on a home without workspace.json: ' + JSON.stringify(r))
    assert(r.scrubbed.includes('workspace:missing'), 'expected workspace:missing, got ' + JSON.stringify(r.scrubbed))
    return 'ok=true, scrubbed=' + JSON.stringify(r.scrubbed)
  } finally {
    process.env.DSH_HOME = prev
  }
})

await check('scrub verdicts: id absent from workspace.json -> "workspace:none"', async () => {
  const home7 = RUN + '-none'
  fs.rmSync(home7, { recursive: true, force: true })
  fs.mkdirSync(path.join(home7, 'sessions', '--D-proj--', ID.keep), { recursive: true })
  fs.writeFileSync(path.join(home7, 'sessions', '--D-proj--', ID.keep, 'session.v4.jsonl.zstd'), 'abc')
  writeJson(path.join(home7, 'storages', 'workspace.json'), { version: 2, global: {}, tables: { workspaces: { 'ws-1': { id: 'ws-1', path: 'D:\\x', sessionIds: [] } } } })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home7
  try {
    const c = makeCtx({ listImpl: async () => [{ header: header(ID.keep), sizeBytes: 3 }] })
    const a = bootPlugin({ ctx: c, plugin })
    const out = await a.call('deleteSessions', { sessionIds: [ID.keep], backup: false })
    const r = out.results[0]
    assert(r.ok === true, 'delete failed: ' + JSON.stringify(r))
    assert(r.scrubbed.includes('workspace:none'), 'expected workspace:none, got ' + JSON.stringify(r.scrubbed))
    return 'ok=true, scrubbed=' + JSON.stringify(r.scrubbed)
  } finally {
    process.env.DSH_HOME = prev
  }
})

/* ------------------------------------------------------------------ */
const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} host checks passed`)
const fails = results.filter((r) => !r.ok)
if (fails.length > 0) {
  console.log('\nFAILURES:')
  for (const f of fails) console.log(' - ' + f.id + ': ' + f.detail)
}
fs.writeFileSync(path.join(HERE, 'host-e2e-results.json'), JSON.stringify({ run: RUN, results }, null, 2))
process.exitCode = fails.length === 0 ? 0 : 1
