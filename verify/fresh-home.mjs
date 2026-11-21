// Minimal reproducer: first delete on a FRESH home (no <home>/session-delete-backup yet)
// must succeed and create the backup chain.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bootPlugin } from './boot-helper.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'lib', 'index.js')
const HOME = path.join(HERE, `tmpfresh-${Date.now()}`)
const ID = 'cccccccc-0000-4000-8000-00000000000c'

fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(path.join(HOME, 'sessions', '--D-proj--', ID), { recursive: true })
fs.writeFileSync(path.join(HOME, 'sessions', '--D-proj--', ID, 'session.v4.jsonl.zstd'), 'abc')
process.env.DSH_HOME = HOME

const mod = await import(pathToFileURL(PLUGIN).href + '?v=' + Date.now())
const plugin = mod.default ?? mod
const services = { sessionPersistence: { async list() { return [{ header: { id: ID, cwd: 'D:\\proj', createdAt: 1 }, sizeBytes: 3 }] } } }
const store = new Map()
const ctx = new Proxy(
  {
    get: (n) => services[n],
    provide: (n, v) => store.set(n, v),
    effect: (fn) => { const d = fn(); return () => typeof d === 'function' && d() },
    logger: { warn() {}, info() {}, error() {} },
  },
  {
    get(t, p, r) {
      if (typeof p === 'string' && p in services && !(p in t)) return services[p]
      return Reflect.get(t, p, r)
    },
  },
)
// Round 2: drive the production HTTP routes instead of the removed provide seam.
const api = bootPlugin({ ctx, plugin })

console.log('home:', HOME)
console.log('<home>/session-delete-backup exists before:', fs.existsSync(path.join(HOME, 'session-delete-backup')))
const out = await api.call('deleteSessions', { sessionIds: [ID], backup: true })
console.log('result:', JSON.stringify(out.results))
console.log('<home>/session-delete-backup exists after :', fs.existsSync(path.join(HOME, 'session-delete-backup')))
console.log('session dir removed:', !fs.existsSync(path.join(HOME, 'sessions', '--D-proj--', ID)))
console.log('backupDir:', out.backupDir)
if (out.backupDir) {
  const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name), rel + e.name + '/') : [rel + e.name])
  console.log('backup contents:', JSON.stringify(walk(out.backupDir)))
}
const ok = out.results[0].ok === true && !!out.backupDir && fs.existsSync(out.backupDir)
console.log(ok ? '\nPASS: first delete on a fresh home works' : '\nFAIL: first delete on a fresh home FAILS (regression)')
fs.rmSync(HOME, { recursive: true, force: true })
process.exitCode = ok ? 0 : 1
