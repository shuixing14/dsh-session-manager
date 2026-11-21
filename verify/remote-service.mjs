// Round 2 (rev 3): drive the plugin with a REAL Cordis Context so the optional
// Remote facade (`SessionManagerRemote extends TypertRemoteService`) actually
// installs, then check its marker shape against the Gateway's own algorithms.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const NM = path.join(HERE, 'r2deps', 'node_modules')
const LOCAL = path.join(NM, 'plugin-copy')
const PLUGIN = path.join(HERE, '..', 'lib', 'index.js')

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

const REMOTE_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/* fixture */
const TARGET = '33333333-3333-4333-8333-333333333333'
const CWD = 'D:\\proj'
const RUN = path.join(HERE, `r2svc-${Date.now()}`)
function buildHome() {
  fs.rmSync(RUN, { recursive: true, force: true })
  const dir = path.join(RUN, 'sessions', '--D-proj--', TARGET)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'abc')
  fs.mkdirSync(path.join(RUN, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  fs.writeFileSync(
    path.join(RUN, 'storages', 'session_projcache', 'sessions', `${TARGET}.json`),
    JSON.stringify({ version: 3, record: { identity: { id: TARGET, cwd: CWD, createdAt: 1 }, rows: [] } }),
  )
  fs.writeFileSync(path.join(RUN, 'storages', 'workspace.json'), JSON.stringify({ version: 2, global: {}, tables: { workspaces: {} } }))
}
buildHome()
process.env.DSH_HOME = RUN

const { Context } = await import(pathToFileURL(path.join(NM, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
const localMod = await import(pathToFileURL(path.join(LOCAL, 'lib', 'index.js')).href + '?v=' + Date.now())

console.log('=== plugin (copy inside r2deps/node_modules):', path.join(LOCAL, 'lib', 'index.js'), '===\n')

/** Boot the plugin on a real Cordis app with stub services. */
async function boot() {
  const app = new Context()
  const warnings = []
  const routes = []
  // stub the injected services on the real ctx
  app.provide('sessionPersistence', {
    async list() {
      return [{ header: { id: TARGET, cwd: CWD, createdAt: 1 }, sizeBytes: 3 }]
    },
  })
  app.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => {}
    },
  })
  const realLogger = app.logger
  app.plugin({
    name: 'probe',
    apply(ctx) {
      const orig = ctx.logger
      localMod.default.apply(ctx)
    },
  })
  // give the async installRemote a tick
  await new Promise((r) => setTimeout(r, 150))
  return { app, routes, warnings }
}

// Simpler + fully synchronous: construct a real Context and hand it to the plugin directly.
const app = new Context()
const warnings = []
const routes = []
app.provide('sessionPersistence', {
  async list() {
    return [{ header: { id: TARGET, cwd: CWD, createdAt: 1 }, sizeBytes: 3 }]
  },
})
app.provide('webServer', {
  register(route) {
    routes.push(route)
    return () => {}
  },
})
// capture warnings from the ctx logger
const origWarn = app.logger.warn?.bind(app.logger)
try {
  app.effect(() => () => {})
} catch {}

localMod.default.apply(app)
await new Promise((r) => setTimeout(r, 200))

await check('B1. real Cordis ctx -> facade installed and provided', async () => {
  const facade = app.get('dshSessionManager')
  assert(facade !== undefined && facade !== null, 'app.get("dshSessionManager") is empty — the Remote facade did not install')
  const protoName = Object.getPrototypeOf(facade).constructor?.name
  assert(protoName === 'SessionManagerRemote', 'facade is not a SessionManagerRemote: ' + protoName)
  assert(typeof facade.list === 'function' && typeof facade.delete === 'function', 'facade lacks list/delete')
  return 'SessionManagerRemote instance provided under dshSessionManager'
})

await check('B2. Object.prototype is NOT polluted with the marker', async () => {
  const leaked = Object.getOwnPropertyDescriptor(Object.prototype, REMOTE_DESCRIPTOR)
  assert(leaked === undefined, 'marker installed on Object.prototype (global pollution)')
  return 'Object.prototype clean'
})

let facade = null
await check('B3. typertRemote binding satisfies readBinding (identity/key/namespace)', async () => {
  facade = app.get('dshSessionManager')
  const binding = facade.typertRemote
  assert(binding !== undefined, 'no typertRemote')
  assert(Object.isFrozen(binding), 'typertRemote not frozen')
  assert(binding.service === facade, 'binding.service !== facade')
  assert(binding.serviceKey === 'dshSessionManager', 'serviceKey=' + binding.serviceKey)
  assert(typeof binding.namespace === 'string', 'namespace not a string')
  return `serviceKey=${binding.serviceKey} namespace=${binding.namespace} frozen=true`
})

await check('B4. prototype carries version-1 marker with list+delete (direct)', async () => {
  const prototype = Object.getPrototypeOf(facade)
  const desc = Object.getOwnPropertyDescriptor(prototype, REMOTE_DESCRIPTOR)
  assert(desc !== undefined, 'marker is not an own property of the Service prototype')
  const value = desc.value
  assert(value.version === 1, 'version=' + value.version)
  const names = value.methods.map((m) => m.method).sort()
  assert(names.join(',') === 'delete,list', 'markers = ' + names.join(','))
  for (const m of value.methods) assert(m.invocation?.kind === 'direct', m.method + ' not direct')
  return 'version 1, [' + names.join(', ') + '] direct'
})

await check('B5. gateway methodParameterNames resolves both via the prototype', async () => {
  function methodParameterNames(service, method) {
    let prototype = Object.getPrototypeOf(service)
    let implementation
    while (prototype !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
      if (descriptor !== undefined) {
        if ('value' in descriptor && typeof descriptor.value === 'function') implementation = descriptor.value
        break
      }
      prototype = Object.getPrototypeOf(prototype)
    }
    if (implementation === undefined) return { ok: false, error: 'gateway/method-unavailable: no prototype method ' + method }
    const source = Function.prototype.toString.call(implementation)
    const open = source.indexOf('(')
    const close = source.indexOf(')', open + 1)
    const body = source.slice(open + 1, close).trim()
    if (body.length === 0) return { ok: true, names: [] }
    const names = new Set()
    for (const part of body.split(',').map((p) => p.trim())) {
      if (!/^[$A-Z_a-z][$\w]*$/u.test(part) || names.has(part)) return { ok: false, error: 'gateway/signature-invalid' }
      names.add(part)
    }
    return { ok: true, names: [...names] }
  }
  const l = methodParameterNames(facade, 'list')
  assert(l.ok, 'list: ' + l.error)
  const d = methodParameterNames(facade, 'delete')
  assert(d.ok, 'delete: ' + d.error)
  return `list(${l.names.join(',')}) delete(${d.names.join(',')})`
})

await check('B6. reflect props expose dshSessionManager as {type:"service"} for Gateway discovery', async () => {
  const props = app.reflect?.props ?? {}
  const def = props['dshSessionManager']
  assert(def !== undefined, 'dshSessionManager is not in reflect.props — resolveSrcDescriptor would never see it')
  assert(def.type === 'service', 'reflect prop type is ' + def.type)
  const receiver = app.get('dshSessionManager')
  assert(receiver === facade, 'app.get returns a different object than the facade')
  return 'reflect.props.dshSessionManager = {type:"service"}'
})

await check('B7. facade.list() resolves listing; facade.delete() deletes', async () => {
  buildHome()
  const listing = await facade.list()
  assert(Array.isArray(listing.sessions), 'list() did not resolve a listing')
  assert(listing.home === RUN, 'home mismatch')
  const out = await facade.delete({ sessionIds: [TARGET], backup: true, allowActive: false })
  assert(out.results[0].ok === true, 'delete failed: ' + JSON.stringify(out.results[0]))
  assert(!fs.existsSync(path.join(RUN, 'sessions', '--D-proj--', TARGET)), 'session dir not removed')
  return 'list ok; delete ok:true; dir removed; backupDir=' + path.basename(out.backupDir || '')
})

await check('B8. facade.delete refuses crafted ids', async () => {
  buildHome()
  const out = await facade.delete({ sessionIds: ['../../evil', '..'], backup: false })
  assert(out.results.every((r) => r.ok === false), 'crafted ids accepted')
  return out.results.map((r) => r.error).join(' | ')
})

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} real-Service facade checks passed`)
fs.writeFileSync(path.join(HERE, 'r2-service-results.json'), JSON.stringify({ run: RUN, results }, null, 2))
if (passed !== results.length) {
  console.log('\nFAILURES:')
  for (const r of results.filter((x) => !x.ok)) console.log(' - ' + r.id + ': ' + r.detail)
}
process.exitCode = passed === results.length ? 0 : 1
