// Definitive receiver-identity check: run the Gateway's OWN originalOf/readBinding
// logic (copied verbatim from the shipped asar) against a real Cordis Context.
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const VERIFY = path.dirname(new URL(import.meta.url).pathname.slice(1))
const NM = path.join(VERIFY, 'r2deps', 'node_modules')

const cordisEntry = path.join(NM, '@deepseek-ai', 'cordis', 'lib', 'index.js')
const { Context, symbols } = await import(pathToFileURL(cordisEntry).href)

const pluginFile = path.join(NM, 'plugin-copy', 'lib', 'index.js')
const mod = await import(pathToFileURL(pluginFile).href + '?v=' + Date.now())

const TARGET = '33333333-3333-4333-8333-333333333333'
const HOME = path.join(VERIFY, 'r2idhome')
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(path.join(HOME, 'sessions', '--D-proj--', TARGET), { recursive: true })
fs.mkdirSync(path.join(HOME, 'storages'), { recursive: true })
fs.writeFileSync(path.join(HOME, 'storages', 'workspace.json'), JSON.stringify({ version: 2, global: {}, tables: { workspaces: {} } }))
process.env.DSH_HOME = HOME

const app = new Context()
app.provide('sessionPersistence', { async list() { return [] } })
app.provide('webServer', { register: () => () => {} })
mod.default.apply(app)
await new Promise((r) => setTimeout(r, 300))

/* ---- verbatim from dsh-api-gateway/lib/index.js ---- */
function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
// :1712
function originalOf(receiver) {
  const original = Reflect.get(receiver, symbols.original)
  return isObject(original) ? original : receiver
}
// :1707
function readBinding(value, original, serviceKey, endpoint, namespace) {
  if (
    !isObject(value) ||
    Reflect.get(value, 'service') !== original ||
    Reflect.get(value, 'serviceKey') !== serviceKey ||
    typeof Reflect.get(value, 'namespace') !== 'string' ||
    (namespace !== undefined && Reflect.get(value, 'namespace') !== namespace)
  ) {
    return { ok: false, error: 'gateway/binding-invalid: inconsistent typertRemote binding' }
  }
  return { ok: true, binding: value }
}

const receiver = app.get('dshSessionManager')
console.log("=== receiver identity (the lead's question) ===")
const installed = receiver !== undefined && receiver !== null
console.log('receiver exists                 :', installed)
if (!installed) {
  fs.rmSync(HOME, { recursive: true, force: true })
  process.exit(1)
}
console.log('receiver ctor name              :', Object.getPrototypeOf(receiver)?.constructor?.name)
const original = originalOf(receiver)
console.log('originalOf(receiver) ctor       :', Object.getPrototypeOf(original)?.constructor?.name)
console.log('original === receiver           :', original === receiver, '(Cordis wraps the Service in a proxy)')
const value = Reflect.get(original, 'typertRemote')
console.log('typertRemote on the ORIGINAL    :', value !== undefined)
if (value) {
  console.log('  binding.service === original  :', value.service === original)
  console.log('  binding.serviceKey            :', value.serviceKey)
  console.log('  binding.namespace             :', value.namespace)
  const rb = readBinding(value, original, 'dshSessionManager', 'test')
  console.log('  readBinding(...)              :', rb.ok ? 'ACCEPTED' : 'REJECTED - ' + rb.error)
}
console.log('')
console.log('NOTE: the naive check `binding.service === app.get(...)` is FALSE by design -')
console.log("app.get returns Cordis's Service proxy; binding.service is the raw Service.")
console.log('originalOf() is exactly what bridges them, and the Gateway always calls it first.')

console.log('')
console.log('=== resolveSrcDescriptor discovery walk (gateway :1230) ===')
let found = null
for (const [serviceKey, definition] of Object.entries(app.reflect?.props ?? {})) {
  if (definition.type !== 'service') continue
  const recv = app.get(serviceKey)
  if (!isObject(recv)) continue
  const orig = originalOf(recv)
  const binding = Reflect.get(orig, 'typertRemote')
  if (binding === undefined) continue
  const rb = readBinding(binding, orig, serviceKey, 'walk')
  if (!rb.ok) {
    console.log('  ' + serviceKey + ': binding REJECTED - ' + rb.error)
    continue
  }
  console.log('  ' + serviceKey + ': discovered, namespace=' + binding.namespace)
  if (serviceKey === 'dshSessionManager') found = binding
}
console.log('our service discovered          :', found !== null)

fs.rmSync(HOME, { recursive: true, force: true })
process.exitCode = found ? 0 : 1
