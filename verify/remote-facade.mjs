// Round 2 (rev 2): Remote facade harness for the new design — a real Cordis
// `SessionManagerRemote extends TypertRemoteService` installed via a dynamic
// `import('@deepseek-ai/dsh-typert-protocol')`.
//
// Two scenarios:
//   A. the protocol package is NOT resolvable (the real state on this machine) ->
//      installRemote must skip silently, apply() must not throw, HTTP still works.
//   B. the protocol package IS resolvable -> we preload a real copy, extracted
//      read-only from the asar, into a temp node_modules so the dynamic import
//      succeeds, then assert the facade's marker shape against the Gateway's own
//      readBinding / methodParameterNames algorithms.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'lib', 'index.js')

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

/* ---------------- extract the real protocol package from the asar ---------------- */
const ASAR = 'D:\\DeepSeek Harness\\resources\\app.asar'
function extractPackage(pkgName, destRoot) {
  const fd = fs.openSync(ASAR, 'r')
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  const jb = Buffer.alloc(jsonLen)
  fs.readSync(fd, jb, 0, jsonLen, 16)
  const header = JSON.parse(jb.toString('utf8'))
  const base = 16 + jsonLen
  const out = []
  const walk = (node, prefix) => {
    for (const [n, c] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + '/' + n : n
      if (c.files) walk(c, p)
      else out.push({ path: p, size: Number(c.size), offset: Number(c.offset) })
    }
  }
  walk(header, '')
  const PREFIX = `dsh/node_modules/${pkgName}/`
  let count = 0
  for (const f of out) {
    if (!f.path.startsWith(PREFIX)) continue
    const dest = path.join(destRoot, pkgName, f.path.slice(PREFIX.length))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const buf = Buffer.alloc(f.size)
    fs.readSync(fd, buf, 0, f.size, base + f.offset)
    fs.writeFileSync(dest, buf)
    count += 1
  }
  fs.closeSync(fd)
  return count
}

// Node only walks ancestors literally named `node_modules`, so the scratch tree
// must be `<something>/node_modules/...`.
const NM = path.join(HERE, 'r2deps', 'node_modules')
fs.rmSync(path.join(HERE, 'r2deps'), { recursive: true, force: true })
// typert-protocol needs cordis (peer); cordis needs cosmokit. Extract the closure.
const wanted = ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/cordis', '@deepseek-ai/cosmokit', '@deepseek-ai/dsh-brand']
for (const pkg of wanted) {
  const n = extractPackage(pkg, NM)
  console.log(`  ${pkg}: ${n} files`)
}
const extracted = wanted.length

/* ---------------- fixture ---------------- */
const TARGET = '33333333-3333-4333-8333-333333333333'
const CWD = 'D:\\proj'
const RUN = path.join(HERE, `r2facade2-${Date.now()}`)
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

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
const plugin = mod.default ?? mod

function makeCtx() {
  const provided = new Map()
  const warnings = []
  const registered = []
  const services = {
    sessionPersistence: {
      async list() {
        return [{ header: { id: TARGET, cwd: CWD, createdAt: 1 }, sizeBytes: 3 }]
      },
    },
    webServer: {
      register(route) {
        registered.push(route)
        return () => {}
      },
    },
  }
  const ctx = {
    get: (n) => services[n],
    provide: (n, v) => {
      provided.set(n, v)
      return () => {}
    },
    effect: (fn) => {
      const d = fn()
      return () => typeof d === 'function' && d()
    },
    logger: { warn: (...a) => warnings.push(a.join(' ')), error: (...a) => warnings.push(a.join(' ')), info() {} },
  }
  return {
    ctx: new Proxy(ctx, {
      get(t, p, r) {
        if (typeof p === 'string' && p in services && !(p in t)) return services[p]
        return Reflect.get(t, p, r)
      },
    }),
    provided,
    warnings,
    registered,
  }
}

/* ---------------- Gateway algorithm replays (cited to the asar) ---------------- */
const REMOTE_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** api-gateway.js:1712 originalOf */
function originalOf(receiver) {
  const original = receiver?.__dsh_original__
  return original !== null && typeof original === 'object' ? original : receiver
}
/** api-gateway.js:1707 readBinding */
function readBinding(value, original, serviceKey, namespace) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (
    !isObject(value) ||
    value.service !== original ||
    value.serviceKey !== serviceKey ||
    typeof value.namespace !== 'string' ||
    (namespace !== undefined && value.namespace !== namespace)
  ) {
    return { ok: false, error: 'gateway/binding-invalid' }
  }
  return { ok: true, binding: value }
}
/** typert-protocol.js:424 remoteMethods */
function remoteMethods(service) {
  const prototype = Object.getPrototypeOf(service)
  if (prototype === null) return []
  const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_DESCRIPTOR)
  if (property === undefined) return []
  const descriptor = property.value
  if (Reflect.get(descriptor, 'version') !== 1) throw new Error('unsupported Remote method descriptor version')
  if (!Array.isArray(Reflect.get(descriptor, 'methods'))) throw new Error('remote method descriptor methods must be an array')
  return descriptor.methods.map((m) => ({ ...m }))
}
/** api-gateway.js:1715 methodParameterNames */
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
  if (implementation === undefined) return { ok: false, error: `gateway/method-unavailable: Remote marker has no prototype method "${method}"` }
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

console.log('=== plugin:', PLUGIN, '===')
console.log('=== fake home:', RUN, '\n')

/* ================= Scenario A: protocol NOT resolvable ================= */
await check('A1. protocol package absent -> apply() does not throw, only logs', async () => {
  const c = makeCtx()
  plugin.apply(c.ctx) // not awaited on purpose: apply is sync and must not throw
  await new Promise((r) => setTimeout(r, 60))
  assert(c.registered.length === 7, 'HTTP routes missing: ' + c.registered.length)
  assert([...c.warnings].every((w) => !/Remote 命名空间未安装/.test(w)), 'an install error was logged rather than a clean skip: ' + c.warnings.join(' | '))
  // The clean-skip warning is intentional (FINDING 1): the failure must never be silent again.
  assert(c.warnings.some((w) => /Remote 命名空间不可用/.test(w)), 'the clean-skip warning was not logged')
  return 'apply() clean; 7 HTTP routes; one explicit "Remote 不可用" warning'
})

await check('A2. protocol absent -> HTTP endpoints still fully functional', async () => {
  const c = makeCtx()
  plugin.apply(c.ctx)
  const list = c.registered.find((r) => r.path === '/dsh-session-manager/list')
  assert(list, 'list route missing')
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code) {
      res.statusCode = code
      return res
    },
    end(chunk) {
      res.body += String(chunk || '')
    },
  }
  const req = {
    method: 'GET',
    headers: { host: '127.0.0.1:5471' },
    async *[Symbol.asyncIterator]() {},
  }
  await list.handler(req, res)
  assert(res.statusCode === 200, 'list route status ' + res.statusCode + ': ' + res.body)
  const body = JSON.parse(res.body)
  assert(Array.isArray(body.sessions), 'listing malformed')
  return 'GET /list 200 with ' + body.sessions.length + ' session(s)'
})

/* ================= Scenario B: protocol IS resolvable ================= */
// Make the dynamic import resolve: place the plugin copy so that its ancestor
// `node_modules` contains @deepseek-ai/dsh-typert-protocol (Node walks ancestors).
const LOCAL = path.join(NM, 'plugin-copy')
fs.mkdirSync(path.join(LOCAL, 'lib'), { recursive: true })
for (const f of ['index.js', 'store.js']) {
  fs.copyFileSync(path.join(HERE, '..', 'lib', f), path.join(LOCAL, 'lib', f))
}
fs.writeFileSync(path.join(LOCAL, 'package.json'), JSON.stringify({ name: 'plugin-copy', type: 'module', main: 'lib/index.js' }))
const probe = await import(pathToFileURL(path.join(NM, '@deepseek-ai', 'dsh-typert-protocol', 'lib', 'index.js')).href)
console.log('protocol exports:', typeof probe.Remote, typeof probe.TypertRemoteService, typeof probe.bindTypertRemote)
const localMod = await import(pathToFileURL(path.join(LOCAL, 'lib', 'index.js')).href + '?v=' + Date.now())

await check('B1. protocol resolvable -> facade installed as a real Cordis Service', async () => {
  const c = makeCtx()
  localMod.default.apply(c.ctx)
  await new Promise((r) => setTimeout(r, 120))
  const facade = c.provided.get('dshSessionManager')
  assert(facade !== undefined, 'nothing provided; warnings=' + c.warnings.join(' | '))
  assert(typeof facade.list === 'function' && typeof facade.delete === 'function', 'facade lacks list/delete')
  const protoName = Object.getPrototypeOf(facade).constructor?.name
  assert(protoName === 'SessionManagerRemote', 'facade is not a SessionManagerRemote instance: ' + protoName)
  return 'Service subclass instance: ' + protoName
})

let facade = null
await check('B2. Object.prototype is NOT polluted with the marker', async () => {
  const c = makeCtx()
  localMod.default.apply(c.ctx)
  await new Promise((r) => setTimeout(r, 120))
  facade = c.provided.get('dshSessionManager')
  const leaked = Object.getOwnPropertyDescriptor(Object.prototype, REMOTE_DESCRIPTOR)
  assert(leaked === undefined, 'marker installed on Object.prototype (global pollution)')
  return 'Object.prototype clean'
})

await check('B3. typertRemote binding satisfies readBinding (identity + key + namespace)', async () => {
  const binding = facade.typertRemote
  assert(binding !== undefined, 'no typertRemote on the facade')
  assert(Object.isFrozen(binding), 'typertRemote is not frozen')
  assert(binding.service === facade, 'binding.service !== facade (readBinding requires identity)')
  assert(binding.serviceKey === 'dshSessionManager', 'serviceKey=' + binding.serviceKey)
  const rb = readBinding(binding, originalOf(facade), 'dshSessionManager', binding.namespace)
  assert(rb.ok, 'readBinding rejected the binding: ' + rb.error)
  return `serviceKey=${binding.serviceKey} namespace=${binding.namespace}`
})

await check('B4. prototype carries a version-1 marker with list+resolve+delete (direct)', async () => {
  const methods = remoteMethods(facade)
  assert(methods.length === 3, 'expected 3 markers, got ' + methods.length)
  const names = methods.map((m) => m.method).sort()
  assert(names.join(',') === 'delete,list,resolve', 'markers = ' + names.join(','))
  for (const m of methods) assert(m.invocation && m.invocation.kind === 'direct', m.method + ' invocation is not direct')
  return 'version 1, [' + names.join(', ') + '] direct'
})

await check('B5b. gateway methodParameterNames resolves resolve(sessionIds)', async () => {
  const fn = methodParameterNames(facade, 'resolve')
  assert(fn.ok, 'resolve: ' + fn.error)
  assert(fn.names.join(',') === 'sessionIds', 'resolve signature = ' + fn.names.join(','))
  return `resolve(${fn.names.join(',')})`
})

await check('B6b. facade.resolve(ids) returns only the requested rows', async () => {
  buildHome()
  const out = await facade.resolve([TARGET])
  assert(out && Array.isArray(out.sessions), 'resolve() did not return {sessions}')
  assert(out.sessions.length === 1 && out.sessions[0].id === TARGET, 'wrong rows: ' + JSON.stringify(out.sessions.map((r) => r.id)))
  assert(out.sessions[0].missing === false, 'existing id reported missing')
  assert(Array.isArray(out.rejected) && out.rejected.length === 0, 'unexpected rejected')
  return 'resolve([TARGET]) -> 1 row, missing:false'
})

await check('B5. gateway methodParameterNames resolves both methods via the prototype', async () => {
  const list = methodParameterNames(facade, 'list')
  assert(list.ok, 'list: ' + list.error)
  const del = methodParameterNames(facade, 'delete')
  assert(del.ok, 'delete: ' + del.error)
  return `list(${list.names.join(',')}) delete(${del.names.join(',')})`
})

await check('B6. facade.list() resolves the listing; facade.delete() deletes', async () => {
  buildHome()
  const listing = await facade.list()
  assert(listing && Array.isArray(listing.sessions), 'list() did not resolve a listing')
  assert(listing.home === RUN, 'home mismatch: ' + listing.home)
  const out = await facade.delete({ sessionIds: [TARGET], backup: true, allowActive: false })
  assert(out && Array.isArray(out.results), 'delete() did not return {results}')
  assert(out.results[0].ok === true, 'delete failed: ' + JSON.stringify(out.results[0]))
  assert(!fs.existsSync(path.join(RUN, 'sessions', '--D-proj--', TARGET)), 'session dir not removed')
  return 'list ok; delete ok:true; dir removed'
})

await check('B7. facade.delete refuses crafted ids (same guards)', async () => {
  buildHome()
  const out = await facade.delete({ sessionIds: ['../../evil', '..'], backup: false })
  assert(out.results.every((r) => r.ok === false), 'crafted ids accepted: ' + JSON.stringify(out.results))
  return out.results.map((r) => r.error).join(' | ')
})

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} facade checks passed`)
fs.writeFileSync(path.join(HERE, 'r2-facade-results.json'), JSON.stringify({ run: RUN, results }, null, 2))
if (passed !== results.length) {
  console.log('\nFAILURES:')
  for (const r of results.filter((x) => !x.ok)) console.log(' - ' + r.id + ': ' + r.detail)
}
process.exitCode = passed === results.length ? 0 : 1
