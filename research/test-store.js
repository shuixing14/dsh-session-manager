// Unit test for lib/store.js → refreshAfterDelete, against a stubbed ctx
// and a FAKE home under research/tmphome. NEVER touches C:\Users\shuixing\.dsh.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMPHOME = path.join(HERE, 'tmphome')
process.env.DSH_HOME = TMPHOME // defensive: nothing here should read the real home

const { refreshAfterDelete, CACHE_SKIP } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'store.js')).href)

let failures = 0
function ok(label, cond, extra) {
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`) }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}\n        actual   ${a}\n        expected ${e}`) }
}

const A = 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'cccccccc-3333-4333-8333-cccccccccccc'

/* ---------- fake home: a workspace.json + a per-record projcache dir ---------- */
async function buildFakeHome() {
  await fsp.rm(TMPHOME, { recursive: true, force: true })
  fs.mkdirSync(path.join(TMPHOME, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  fs.writeFileSync(
    path.join(TMPHOME, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [A], pinnedSessionIds: [B] },
      tables: { workspaces: { 'ws-1': { path: 'D:\\dsh', title: 'dsh', sessionIds: [A, B], createdAt: 'x', updatedAt: 'y' } } },
    }, null, 2),
  )
  const mirrorDir = path.join(TMPHOME, 'storages', 'session_projcache', 'sessions')
  for (const id of [A, B]) {
    fs.writeFileSync(path.join(mirrorDir, `${id}.json`),
      JSON.stringify({ version: 3, record: { identity: { createdAt: 1, cwd: 'D:\\dsh' }, rows: {} } }))
  }
  return { mirrorDir }
}

/* ---------- stubs ---------- */
function stubRegistry(opts = {}) {
  const calls = []
  const reg = {
    calls,
    async unarchiveSession(id) {
      calls.push(['unarchiveSession', id])
      if (opts.throwOn === 'unarchiveSession' && id === opts.throwFor) throw new Error('boom')
      if (opts.missing) throw new TypeError('unarchiveSession is not a function')
    },
    async unpinSession(id) {
      calls.push(['unpinSession', id])
      if (opts.throwOn === 'unpinSession' && id === opts.throwFor) throw new Error('boom')
    },
  }
  return reg
}

console.log('=== fixture ===')
const { mirrorDir } = await buildFakeHome()
console.log('  fake home:', TMPHOME)
console.log('  note: refreshAfterDelete does NOT touch these files; they exist to prove it leaves disk alone')

/* ---------- 1. happy path ---------- */
console.log('\n=== 1. refreshAfterDelete: both ids, both methods, ctx.<service> access ===')
{
  const reg = stubRegistry()
  const cache = { recordFor() {}, put() {} } // real public surface: no row-drop
  const refreshed = await refreshAfterDelete({ workspaceRegistry: reg, sessionProjectionCache: cache }, [A, B])
  eq('returns workspaceRegistry', refreshed.includes('workspaceRegistry'), true)
  eq('does NOT claim projectionCache refreshed', refreshed.includes('projectionCache'), false)
  eq('reports the skip reason', refreshed.includes(CACHE_SKIP), true)
  eq('called unarchive+unpin for each id (4 calls)', reg.calls.length, 4)
  eq('call set', reg.calls, [
    ['unarchiveSession', A], ['unpinSession', A],
    ['unarchiveSession', B], ['unpinSession', B],
  ])
}

/* ---------- 2. ctx.get(name) accessor ---------- */
console.log('\n=== 2. services resolved through ctx.get(name) instead of ctx.<name> ===')
{
  const reg = stubRegistry()
  const ctx = { get: (name) => (name === 'workspaceRegistry' ? reg : name === 'sessionProjectionCache' ? { put() {} } : undefined) }
  const refreshed = await refreshAfterDelete(ctx, [A])
  eq('workspaceRegistry refreshed via ctx.get', refreshed.includes('workspaceRegistry'), true)
  eq('calls made', reg.calls.length, 2)
}

/* ---------- 3. tolerant of missing services ---------- */
console.log('\n=== 3. missing services are tolerated ===')
{
  eq('empty ctx -> []', await refreshAfterDelete({}, [A]), [])
  eq('null ctx -> []', await refreshAfterDelete(null, [A]), [])
  eq('registry alone works', (await refreshAfterDelete({ workspaceRegistry: stubRegistry() }, [A])).includes('workspaceRegistry'), true)
  eq('cache alone -> only skip note',
    await refreshAfterDelete({ sessionProjectionCache: { put() {} } }, [A]), [CACHE_SKIP])
}

/* ---------- 4. empty / malformed input ---------- */
console.log('\n=== 4. empty and malformed input ===')
{
  const reg = stubRegistry()
  eq('empty array -> []', await refreshAfterDelete({ workspaceRegistry: reg }, []), [])
  eq('undefined ids -> []', await refreshAfterDelete({ workspaceRegistry: reg }, undefined), [])
  eq('no registry calls for empty input', reg.calls.length, 0)
  const reg2 = stubRegistry()
  const refreshed = await refreshAfterDelete({ workspaceRegistry: reg2 }, [A, '', null, undefined, 42, { id: B }])
  eq('accepts {id} objects and drops junk', reg2.calls, [
    ['unarchiveSession', A], ['unpinSession', A],
    ['unarchiveSession', B], ['unpinSession', B],
  ])
}

/* ---------- 5. individual failures do not abort ---------- */
console.log('\n=== 5. a throwing method does not stop the others ===')
{
  const reg = stubRegistry({ throwOn: 'unarchiveSession', throwFor: A })
  const refreshed = await refreshAfterDelete({ workspaceRegistry: reg }, [A, B])
  eq('still reports workspaceRegistry (unpin + B succeeded)', refreshed.includes('workspaceRegistry'), true)
  eq('attempted all four', reg.calls.length, 4)
}

/* ---------- 6. a method that is absent ---------- */
console.log('\n=== 6. registry missing one method ===')
{
  const calls = []
  const partial = { async unpinSession(id) { calls.push(['unpinSession', id]) } } // no unarchiveSession
  const refreshed = await refreshAfterDelete({ workspaceRegistry: partial }, [A])
  eq('unpin still called', calls, [['unpinSession', A]])
  eq('reports workspaceRegistry', refreshed.includes('workspaceRegistry'), true)
}

/* ---------- 7. future-proofing: if a row-drop ever appears, use it ---------- */
console.log('\n=== 7. if projection cache ever exposes a row-drop, it is used ===')
{
  const dropped = []
  const cache = { async dropRecord(id) { dropped.push(id) } }
  const refreshed = await refreshAfterDelete({ sessionProjectionCache: cache }, [A, B])
  eq('dropRecord called for each id', dropped, [A, B])
  eq('projectionCache reported', refreshed.includes('projectionCache'), true)
  eq('skip note NOT reported', refreshed.includes(CACHE_SKIP), false)
}

/* ---------- 8. disk is untouched by the refresh ---------- */
console.log('\n=== 8. refreshAfterDelete does not modify disk ===')
{
  const wsBefore = fs.readFileSync(path.join(TMPHOME, 'storages', 'workspace.json'), 'utf8')
  const mirrorBefore = fs.readdirSync(mirrorDir).sort()
  const reg = stubRegistry()
  await refreshAfterDelete({ workspaceRegistry: reg, sessionProjectionCache: { put() {} } }, [A])
  eq('workspace.json byte-identical', fs.readFileSync(path.join(TMPHOME, 'storages', 'workspace.json'), 'utf8'), wsBefore)
  eq('projcache mirror untouched', fs.readdirSync(mirrorDir).sort(), mirrorBefore)
  eq('no .bak files created', fs.readdirSync(path.join(TMPHOME, 'storages')).filter((n) => n.includes('.bak')).length, 0)
}

console.log(`\n=== RESULT: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ===`)
await fsp.rm(TMPHOME, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
