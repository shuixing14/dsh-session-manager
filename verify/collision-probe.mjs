// Deterministic probe: two deleteSessions calls within the same wall-clock second
// (stamp granularity is 1s) share one backup dir. Does the second overwrite the first?
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bootPlugin } from './boot-helper.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..', 'lib', 'index.js')
const HOME = path.join(HERE, `collide-${Date.now()}`)

const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const CWD = 'D:\\proj'

fs.rmSync(HOME, { recursive: true, force: true })
for (const id of [A, B]) {
  const dir = path.join(HOME, 'sessions', '--D-proj--', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from(id.slice(0, 8)))
}
fs.mkdirSync(path.join(HOME, 'storages'), { recursive: true })
fs.writeFileSync(path.join(HOME, 'storages', 'workspace.json'), '{"version":2,"global":{},"tables":{"workspaces":{}}}\n')
process.env.DSH_HOME = HOME

const mod = await import(pathToFileURL(PLUGIN).href)
const plugin = mod.default ?? mod
const snapshots = [
  { header: { id: A, cwd: CWD, createdAt: 1 }, sizeBytes: 8 },
  { header: { id: B, cwd: CWD, createdAt: 2 }, sizeBytes: 8 },
]
const services = { sessionPersistence: { async list() { return snapshots } } }
const store = new Map()
const ctx = new Proxy(
  {
    get: (n) => services[n],
    provide: (n, v) => store.set(n, v),
    effect: (fn) => {
      const d = fn()
      return () => typeof d === 'function' && d()
    },
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

const out1 = await api.call('deleteSessions', { sessionIds: [A], backup: true })
const out2 = await api.call('deleteSessions', { sessionIds: [B], backup: true })
console.log('call1 backupDir:', out1.backupDir)
console.log('call2 backupDir:', out2.backupDir)
console.log('same dir?', out1.backupDir === out2.backupDir)

const dir = out1.backupDir
const present = []
if (dir) {
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) walk(p, r)
      else present.push(r)
    }
  }
  walk(dir)
}
console.log('backup contents after both calls:', JSON.stringify(present, null, 2))
const aBackup = path.join(dir, 'sessions', A, 'session.v4.jsonl.zstd')
const bBackup = path.join(dir, 'sessions', B, 'session.v4.jsonl.zstd')
console.log('A session backup still present?', fs.existsSync(aBackup))
console.log('B session backup present?', fs.existsSync(bBackup))
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
const dir2 = out2.backupDir
const present2 = fs.existsSync(dir2) ? fs.readdirSync(path.join(dir2, 'sessions')) : []
console.log('call2 backup dir sessions:', JSON.stringify(present2))
console.log('call2 manifest has B?', fs.existsSync(path.join(dir2,'manifest.json')) && JSON.parse(fs.readFileSync(path.join(dir2,'manifest.json'),'utf8')).sessions.some(s=>s.id===B))
console.log('manifest.sessions:', JSON.stringify(manifest.sessions.map((s) => s.id)))
console.log(
  manifest.sessions.some((s) => s.id === A) ? 'MANIFEST: A still recorded (stale, A was deleted)' : 'MANIFEST: A lost entirely',
)
console.log(fs.existsSync(aBackup) ? 'RESULT: first backup intact' : 'RESULT: FIRST BACKUP WAS OVERWRITTEN/LOST')
fs.writeFileSync(path.join(HERE, 'collision-probe.json'), JSON.stringify({ out1, out2, present, aBackupPresent: fs.existsSync(aBackup) }, null, 2))
