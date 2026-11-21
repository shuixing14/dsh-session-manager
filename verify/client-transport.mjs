// Round 2 addition: client transport selection (A remote -> B service -> C global
// host -> D http bridge -> E error) and error rendering, including RemoteError
// (structural, cross-realm) and HTTP non-2xx bodies.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import reactStub from './react-stub.cjs'
const { React, mount } = reactStub

const __dirname = path.dirname(new URL(import.meta.url).pathname.slice(1));
const CLIENT = path.join(__dirname, '..', 'client.js')
const SRC = fs.readFileSync(CLIENT, 'utf8')
const OPEN_EVENT = 'dsh-session-manager:open'
const TARGET = '33333333-3333-4333-8333-333333333333'

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
    results.push({ id, ok: false, detail: e && e.message ? e.message : String(e) })
    console.log(`FAIL  ${id}\n      -> ${e && e.message ? e.message : e}`)
  }
}

/* ---------- script eval (classic script, registers a factory) ---------- */
let registration = null
const sandbox = {
  window: {},
  console: { log() {}, warn() {}, error() {}, info() {} },
  setTimeout,
  clearTimeout,
  Promise,
  Date,
  JSON,
}
sandbox.window.__ModuleLoader__ = {
  load(reg) {
    if (registration !== null) throw new Error('duplicate registration')
    registration = reg
  },
}
vm.createContext(sandbox)
new vm.Script(SRC, { filename: 'client.js' }).runInContext(sandbox)

/* ---------- fake DOM on BOTH the sandbox and globalThis ---------- */
function installDom() {
  const listeners = new Map()
  const win = {
    addEventListener(t, f) {
      if (!listeners.has(t)) listeners.set(t, new Set())
      listeners.get(t).add(f)
    },
    removeEventListener(t, f) {
      listeners.get(t)?.delete(f)
    },
  }
  const doc = {
    body: { style: {} },
    head: { appendChild() {}, append() {} },
    createElement() {
      return { dataset: {}, style: {}, textContent: '', remove() {}, setAttribute() {}, appendChild() {} }
    },
    addEventListener() {},
    removeEventListener() {},
  }
  sandbox.window = win
  sandbox.document = doc
  globalThis.window = win
  globalThis.document = doc
  return { win, listeners }
}
let dom = installDom()
function setFetch(fn) {
  // The client runs INSIDE the vm sandbox, so its globals must be set there.
  if (fn === undefined) {
    delete sandbox.fetch
    delete globalThis.fetch
  } else {
    sandbox.fetch = fn
    globalThis.fetch = fn
  }
}
function freshDom() { dom = installDom(); return dom }
function fireOpen() {
  for (const f of [...(dom.listeners.get(OPEN_EVENT) || [])]) f({})
}

/* ---------- ctx stubs for each transport path ---------- */
function makeCtx({ remote = null, service = null, slotsSeat = true } = {}) {
  const registered = []
  const services = {}
  if (slotsSeat) {
    services.slots = {
      inject(n, f) {
        f()
        return () => {}
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {}
      },
    }
  }
  if (remote !== null) services.remote = remote
  if (service !== null) services.dshSessionManager = service
  const ctx = {
    get: (n) => services[n],
    provide() {},
    effect(fn) {
      const d = fn()
      return () => typeof d === 'function' && d()
    },
    on() {
      return () => {}
    },
  }
  return {
    ctx: new Proxy(ctx, {
      get(t, p, r) {
        if (typeof p === 'string' && p in services && !(p in t)) return services[p]
        return Reflect.get(t, p, r)
      },
    }),
    registered,
  }
}

const LISTING = {
  sessions: [{ id: TARGET, title: 'Normal target', cwd: 'D:\\proj', createdAt: Date.now() - 5000, children: [], archived: false, running: false, bytes: 300, parentId: null }],
  home: 'D:\\fakehome',
  currentSessionId: null,
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Mount the overlay, open it, and return the rendered text blob. */
async function openAndRead(c, extraTicks = 40) {
  const overlay = c.registered.find((r) => r.spec.name === 'shell.overlay')
  assert(overlay, 'no shell.overlay registration')
  const view = mount(overlay.component, {})
  fireOpen()
  await sleep(extraTicks)
  view.rerender()
  const rendered = view.tree()
  if (process.env.DBG) {
    const out = []
    const walk = (n) => {
      if (!n) return
      if (Array.isArray(n)) return n.forEach(walk)
      if (typeof n !== 'object') {
        if (typeof n === 'string') out.push(n)
        return
      }
      if (Array.isArray(n.children)) n.children.forEach((x) => (typeof x === 'string' ? out.push(x) : walk(x)))
      if (n.props && n.props.children) walk(n.props.children)
    }
    walk(rendered)
    console.log('  [dbg] rendered strings:', JSON.stringify(out).slice(0, 500))
  }
  return { view, text: JSON.stringify(rendered) }
}

function roots() {
  // each scenario needs a fresh factory instance (module-level state is per-factory)
  return registration.factory((spec) => {
    if (spec === 'react') return React
    throw new Error('client-modules: require("' + spec + '") missed the module table')
  })
}

/* ================= A. remote namespace ================= */
await check('A. ctx.remote.dshSessionManager.{list,delete} is used first', async () => {
  const calls = []
  const remote = {
    dshSessionManager: {
      list: async (...args) => {
        calls.push(['list', args])
        return LISTING
      },
      delete: async (req) => {
        calls.push(['delete', req])
        return { results: [{ id: TARGET, ok: true, scrubbed: ['workspace'] }], backupDir: 'D:\\b\\2026', restartRecommended: true }
      },
    },
  }
  let fetchUsed = 0
  setFetch(async () => { fetchUsed += 1; return { ok: true, status: 200, text: async () => JSON.stringify(LISTING) } })
  const c = makeCtx({ remote })
  freshDom()
  if (process.env.DBG) console.log('  [dbg] c.ctx.get("remote") ->', typeof c.ctx.get('remote'), 'ns:', typeof c.ctx.get('remote')?.dshSessionManager)
  const plugin = roots()
  plugin.apply(c.ctx)
  const { text } = await openAndRead(c)
  assert(text.includes('Normal target'), 'rows not rendered via the remote transport')
  assert(calls.length === 1 && calls[0][0] === 'list', 'remote.list not called exactly once: ' + JSON.stringify(calls))
  assert(fetchUsed === 0, 'fell through to the HTTP bridge instead of using the remote namespace (fetch calls=' + fetchUsed + ')')
  return 'remote namespace used (A), rows rendered, 0 fetch calls'
})

/* ================= B. service seam ================= */
await check('B. ctx.get("dshSessionManager") service is used when remote is absent', async () => {
  let used = 0
  const service = {
    call: async (method) => {
      used += 1
      if (method === 'sessions.list') return LISTING
      return { results: [] }
    },
  }
  const c = makeCtx({ service })
  freshDom()
  roots().apply(c.ctx)
  const { text } = await openAndRead(c)
  assert(text.includes('Normal target'), 'rows not rendered via the service seam')
  assert(used >= 1, 'service.call was never used')
  return 'service seam used (B)'
})

/* ================= C. globalThis.host ================= */
await check('C. globalThis.host.call is used when no remote/service exists', async () => {
  let used = 0
  globalThis.host = {
    call: async (method) => {
      used += 1
      if (method === 'sessions.list') return LISTING
      return { results: [] }
    },
  }
  sandbox.host = globalThis.host
  try {
    const c = makeCtx({})
    roots().apply(c.ctx)
    const { text } = await openAndRead(c)
    assert(text.includes('Normal target'), 'rows not rendered via global host')
    assert(used >= 1, 'globalThis.host.call never used')
    return 'global host used (C)'
  } finally {
    delete globalThis.host
    delete sandbox.host
  }
})

/* ================= D. HTTP bridge ================= */
await check('D. fetch bridge GET /list + POST /delete with same-origin credentials', async () => {
  const calls = []
  setFetch(async (url, init) => {
    calls.push([url, init])
    if (init.method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify(LISTING) }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ id: TARGET, ok: true, scrubbed: ['workspace'] }], backupDir: 'D:\\b\\2026' }) }
  })
  try {
    const c = makeCtx({})
    roots().apply(c.ctx)
    const { view, text } = await openAndRead(c)
    assert(text.includes('Normal target'), 'rows not rendered via the fetch bridge')
    const get = calls.find(([u, i]) => i.method === 'GET')
    assert(get, 'no GET issued')
    assert(get[0] === '/dsh-session-manager/list', 'GET url=' + get[0])
    assert(get[1].credentials === 'same-origin', 'GET credentials not same-origin')
    // now delete: select the row and press the danger button
    const flat = []
    const walk = (n) => {
      if (!n) return
      if (Array.isArray(n)) return n.forEach(walk)
      if (typeof n !== 'object') return
      if (n.type) flat.push(n)
      if (Array.isArray(n.children)) n.children.forEach(walk)
      if (n.props && n.props.children) walk(n.props.children)
    }
    walk(view.tree())
    const box = flat.find((n) => n.type === 'input' && n.props.type === 'checkbox' && String(n.props['aria-label'] || '').includes('Normal target'))
    assert(box, 'target checkbox not found')
    box.props.onChange()
    view.rerender()
    const flat2 = []
    walk.call(null, view.tree())
    // re-collect
    const collect = (n, out) => {
      if (!n) return out
      if (Array.isArray(n)) return n.forEach((x) => collect(x, out))
      if (typeof n !== 'object') return out
      if (n.type) out.push(n)
      if (Array.isArray(n.children)) n.children.forEach((x) => collect(x, out))
      if (n.props && n.props.children) collect(n.props.children, out)
      return out
    }
    const nodes = collect(view.tree(), [])
    const del = nodes.find((n) => n.type === 'button' && String(n.props.className || '').includes('dsm-btn-danger'))
    assert(del, 'delete button not found')
    del.props.onClick()
    await sleep(60)
    const post = calls.find(([u, i]) => i.method === 'POST')
    assert(post, 'no POST issued')
    assert(post[0] === '/dsh-session-manager/delete', 'POST url=' + post[0])
    assert(String(post[1].headers['content-type']).includes('application/json'), 'POST content-type not JSON')
    assert(post[1].credentials === 'same-origin', 'POST credentials not same-origin')
    const body = JSON.parse(post[1].body)
    assert(Array.isArray(body.sessionIds) && body.sessionIds[0] === TARGET, 'POST body sessionIds wrong: ' + post[1].body)
    assert(body.backup === true && body.allowActive === false, 'POST body flags wrong: ' + post[1].body)
    return 'GET+POST on the right routes with JSON body and same-origin credentials'
  } finally {
    setFetch(undefined)
  }
})

/* ================= HTTP non-2xx rendering ================= */
await check('D-err. HTTP non-2xx {error} body is rendered to the user', async () => {
  setFetch(async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: '请求被拒绝（非本机同源）' }),
  }))
  try {
    const c = makeCtx({})
    roots().apply(c.ctx)
    const { text } = await openAndRead(c)
    assert(/请求被拒绝/.test(text), 'server error text not surfaced; tree=' + text.slice(0, 300))
    return '403 {error} rendered'
  } finally {
    setFetch(undefined)
  }
})

/* ================= RemoteError rendering ================= */
await check('E-err. RemoteError (structural isDSHRemoteError) rendered with its code', async () => {
  const remote = {
    dshSessionManager: {
      list: async () => {
        const error = new Error('session store unavailable')
        error.isDSHRemoteError = true
        error.code = 'unavailable'
        throw error
      },
      delete: async () => ({ results: [] }),
    },
  }
  let fetchUsed = 0
  setFetch(async () => { fetchUsed += 1; return { ok: true, status: 200, text: async () => JSON.stringify(LISTING) } })
  const c = makeCtx({ remote })
  freshDom()
  roots().apply(c.ctx)
  const { text } = await openAndRead(c)
  assert(/unavailable/.test(text), 'RemoteError code not rendered; tree=' + text.slice(0, 400))
  return 'RemoteError code rendered'
})

/* ================= E. no channel ================= */
await check('E. no transport at all -> 无法连接宿主端, zero fabricated calls', async () => {
  const savedFetch = globalThis.fetch
  setFetch(undefined)
  delete globalThis.host
  try {
    const c = makeCtx({})
    roots().apply(c.ctx)
    const { text } = await openAndRead(c)
    assert(/无法连接宿主端/.test(text), 'no-host message missing; tree=' + text.slice(0, 300))
    return 'E: explicit host-unavailable'
  } finally {
    if (savedFetch !== undefined) setFetch(savedFetch)
  }
})

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} transport checks passed`)
fs.writeFileSync(path.join(__dirname, 'r2-transport-results.json'), JSON.stringify({ results }, null, 2))
if (passed !== results.length) {
  console.log('\nFAILURES:')
  for (const r of results.filter((x) => !x.ok)) console.log(' - ' + r.id + ': ' + r.detail)
}
process.exitCode = passed === results.length ? 0 : 1
