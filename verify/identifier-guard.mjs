// Permanent guard against "referenced but never defined" identifiers — the class of
// bug that cost four rounds (deleteSessions, openRequest, resolveHost,
// REMOTE_DESCRIPTOR).
//
// Layers:
//   1. the plugin's own `undefinedNames()` self-check (as the lead asked)
//   2. a symbol-resolution check for everything the new code paths call
//   3. a runtime probe that surfaces errors the fire-and-forget installRemote catch
//      would otherwise swallow as an unhandled rejection
//
// A full static free-variable analysis was attempted and abandoned: correct JS
// scope analysis needs a real parser, and a regex approximation produced only
// false positives (identifiers inside template literals and comments). The
// runtime probe below catches the real failure mode more directly.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'lib', 'index.js')
const SRC = fs.readFileSync(PLUGIN, 'utf8')

const results = []
function assert(c, m) {
  if (!c) throw new Error(m)
}
async function check(id, fn) {
  try {
    const d = await fn()
    results.push({ id, ok: true, detail: d })
    console.log(`PASS  ${id}${d ? '\n      ' + d : ''}`)
  } catch (e) {
    results.push({ id, ok: false, detail: e.message })
    console.log(`FAIL  ${id}\n      ${e.message}`)
  }
}

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())

await check('1. plugin self-check undefinedNames([...]) returns []', () => {
  assert(typeof mod.undefinedNames === 'function', 'undefinedNames is not exported')
  const names = ['encodeSegment', 'projectKey', 'locateSessionDir', 'listSessionInfos', 'deleteSessions', 'installRoutes', 'installRemote', 'REMOTE_DESCRIPTOR']
  const missing = mod.undefinedNames(names)
  assert(Array.isArray(missing) && missing.length === 0, 'undefinedNames reports: ' + JSON.stringify(missing))
  return names.length + ' known names resolve'
})

await check('2. undefinedNames detects a bogus name (guard is live, not vacuous)', () => {
  const bogus = mod.undefinedNames(['zzzNotDefinedAnywhere'])
  assert(bogus.length === 1, 'did not flag a bogus name: ' + JSON.stringify(bogus))
  return 'bogus name flagged'
})

await check('3. every symbol the routes/facade call is defined or imported', () => {
  const needed = ['deleteSessions', 'listSessionInfos', 'installRoutes', 'installRemote', 'requestRejection', 'sendJson', 'readJsonBody', 'uniqueBackupDir', 'deleteOne', 'scrubWorkspace', 'removeProjectionRecords', 'removeSessionDir', 'backupEverything', 'encodeSegment', 'projectKey', 'descendantsOf', 'refreshAfterDelete', 'REMOTE_DESCRIPTOR', 'ROUTE_BASE', 'ID_RE']
  const missing = needed.filter((n) => {
    const defined =
      new RegExp('(?:^|\\s)(?:async\\s+)?function\\s+' + n + '\\b').test(SRC) ||
      new RegExp('\\b(?:const|let|var)\\s+' + n + '\\b').test(SRC)
    const imported = new RegExp('import\\s*\\{[^}]*\\b' + n + '\\b', 'm').test(SRC)
    return !defined && !imported
  })
  assert(missing.length === 0, 'not defined anywhere in the module: ' + JSON.stringify(missing))
  return needed.length + ' referenced symbols resolve'
})

await check('4. apply() raises no unhandled rejection and swallows no ReferenceError', async () => {
  const rejected = []
  const onRejection = (e) => rejected.push(e)
  process.on('unhandledRejection', onRejection)
  const HOME = path.join(HERE, `tmpguard-${Date.now()}`)
  fs.rmSync(HOME, { recursive: true, force: true })
  fs.mkdirSync(path.join(HOME, 'storages'), { recursive: true })
  fs.writeFileSync(path.join(HOME, 'storages', 'workspace.json'), JSON.stringify({ version: 2, global: {}, tables: { workspaces: {} } }))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = HOME
  try {
    const services = {
      sessionPersistence: {
        async list() {
          return []
        },
      },
      webServer: { register: () => () => {} },
    }
    const warns = []
    const ctx = new Proxy(
      {
        get: (n) => services[n],
        provide() {},
        effect: (fn) => {
          const d = fn()
          return () => typeof d === 'function' && d()
        },
        logger: {
          warn: (...a) => warns.push(a.join(' ')),
          error: (...a) => warns.push(a.join(' ')),
          info() {},
        },
      },
      {
        get(t, p, r) {
          if (typeof p === 'string' && p in services && !(p in t)) return services[p]
          return Reflect.get(t, p, r)
        },
      },
    )
    mod.default.apply(ctx)
    await new Promise((r) => setTimeout(r, 400))
    assert(rejected.length === 0, 'unhandled rejection during apply(): ' + rejected.map((e) => (e && e.message) || String(e)).join(' | '))
    const refWarn = warns.find((w) => /is not defined/.test(w))
    assert(!refWarn, 'installRemote swallowed a ReferenceError: ' + refWarn)
    return 'apply() clean; no unhandled rejection; ' + warns.length + ' warning(s)'
  } finally {
    process.off('unhandledRejection', onRejection)
    process.env.DSH_HOME = prev
    fs.rmSync(HOME, { recursive: true, force: true })
  }
})

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} undefined-identifier checks passed`)
if (passed !== results.length) {
  console.log('\nFAILURES:')
  for (const r of results.filter((x) => !x.ok)) console.log(' - ' + r.id + ': ' + r.detail)
}
process.exitCode = passed === results.length ? 0 : 1
