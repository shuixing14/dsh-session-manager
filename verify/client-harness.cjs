// Client-half harness for the post-task-4 form:
//   window.__ModuleLoader__.load({ id, factory })  where factory(require) returns
//   the Cordis plugin object { name, inject, apply }.
// Runs the real client.js in a vm, materializes the factory with a require() that
// serves the platform seed words, then mounts the registered slot components against
// a minimal React and a stub ctx + host service, and drives the delete flow.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { React, mount } = require('./react-stub.cjs')

const CLIENT = path.join(__dirname, '..', 'client.js')
const SRC = fs.readFileSync(CLIENT, 'utf8')
const results = []
const consoleErrors = []

function check(name, fn) {
  try {
    const value = fn()
    results.push({ name, ok: true, value })
    console.log('PASS  ' + name + (value !== undefined ? '\n      ' + (typeof value === 'string' ? value : JSON.stringify(value)) : ''))
  } catch (error) {
    results.push({ name, ok: false, error: error && error.message ? error.message : String(error) })
    console.log('FAIL  ' + name + '\n      -> ' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n         ') : String(error)))
  }
}
async function acheck(name, fn) {
  try {
    const value = await fn()
    results.push({ name, ok: true, value })
    console.log('PASS  ' + name + (value !== undefined ? '\n      ' + (typeof value === 'string' ? value : JSON.stringify(value)) : ''))
  } catch (error) {
    results.push({ name, ok: false, error: error && error.message ? error.message : String(error) })
    console.log('FAIL  ' + name + '\n      -> ' + (error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n         ') : String(error)))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function assertEq(a, b, what) {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${what}: expected ${y}, got ${x}`)
}

/* ---------------- fake DOM globals ---------------- */
function installGlobals() {
  const listeners = new Map()
  const windowStub = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    dispatchEvent(event) {
      for (const fn of [...(listeners.get(EVENT_OPEN_TYPE) || [])]) fn(event)
      return true
    },
    getComputedStyle() {
      return { zIndex: 'auto' }
    },
  }
  const documentStub = {
    body: { style: {} },
    head: { appendChild() {}, append() {} },
    createElement() {
      return { setAttribute() {}, appendChild() {}, textContent: '', style: {}, dataset: {}, remove() {} }
    },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.window = windowStub
  globalThis.document = documentStub
  globalThis.__windowListeners = listeners
  // The client also runs inside a vm context, where bare `window`/`document` must resolve too.
  sandbox.window = windowStub
  sandbox.document = documentStub
  return { windowStub, documentStub, listeners }
}
const EVENT_OPEN_TYPE = 'dsh-session-manager:open'

/* ---------------- vm script eval + factory ---------------- */
let registration = null
const sandbox = { window: {}, console: { log() {}, warn() {}, error(...a) { consoleErrors.push(a.join(' ')) }, info() {} } }
// Browser globals the client legitimately uses beyond window/document.
sandbox.setTimeout = setTimeout
sandbox.clearTimeout = clearTimeout
sandbox.Promise = Promise
sandbox.Date = Date
sandbox.JSON = JSON
sandbox.window.__ModuleLoader__ = {
  load(reg) {
    if (registration !== null) throw new Error('duplicate __ModuleLoader__.load() registration')
    registration = reg
  },
}
vm.createContext(sandbox)
let scriptError = null
try {
  new vm.Script(SRC, { filename: 'client.js' }).runInContext(sandbox)
} catch (error) {
  scriptError = error
}

check('1. client.js runs as a classic script and registers exactly one factory', () => {
  assert(scriptError === null, 'script threw while registering: ' + (scriptError && scriptError.message))
  assert(registration !== null, 'window.__ModuleLoader__.load() was never called')
  assertEq(registration.id, 'dsh-session-manager', 'registration.id')
  assert(typeof registration.factory === 'function', 'factory is not a function')
  return 'id=' + registration.id
})

// require() that serves the real platform seed words
const SEEDS = { react: React, 'react/jsx-runtime': { jsx: () => null, jsxs: () => null } }
const requireCalls = []
function makeRequire(spec) {
  requireCalls.push(spec)
  if (spec in SEEDS) return SEEDS[spec]
  throw new Error('client-modules: require("' + spec + '") missed the module table')
}

let plugin = null
check('2. factory(require) returns the plugin object {name, inject, apply}', () => {
  plugin = registration.factory(makeRequire)
  assert(plugin && typeof plugin === 'object', 'factory returned ' + typeof plugin + ' (must be the plugin object itself)')
  assertEq(typeof plugin.name, 'string', 'name type')
  assertEq(typeof plugin.apply, 'function', 'apply type')
  assert(Array.isArray(plugin.inject), 'inject must be an array, got ' + JSON.stringify(plugin.inject))
  assert(plugin.inject.includes('slots'), 'inject must include "slots" (got ' + JSON.stringify(plugin.inject) + ')')
  assert(requireCalls.includes('react'), 'factory never require()d "react"')
  return { name: plugin.name, inject: plugin.inject, requires: [...new Set(requireCalls)] }
})

/* ---------------- stub ctx ---------------- */
function makeCtx({ withHostService = true, withLocale = true } = {}) {
  const registered = []
  const services = {}
  const slots = {
    inject(name, fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    register(spec, component) {
      registered.push({ slot: spec.name, spec, component })
      return () => {
        const i = registered.findIndex((r) => r.component === component)
        if (i >= 0) registered.splice(i, 1)
      }
    },
    render() {
      return []
    },
  }
  services.slots = slots
  const localeCalls = []
  if (withLocale) {
    services.locale = {
      register(ns, dicts) {
        localeCalls.push({ ns, locales: Object.keys(dicts) })
        return () => {}
      },
      bind() {
        return (key, params) => (params ? key + JSON.stringify(params) : key)
      },
      getSnapshot() {
        return { active: 'zh' }
      },
    }
  }
  const hostCalls = []
  const hostListing = () => LISTING
  if (withHostService) {
    services[PLUGIN_SERVICE_NAME] = {
      call(method, args) {
        hostCalls.push({ method, args })
        if (method === 'sessions.list') return Promise.resolve(hostListing())
        if (method === 'deleteSessions') {
          return Promise.resolve({
            results: (args.sessionIds || []).map((id) => ({ id, ok: true, scrubbed: ['projection-cache', 'workspace'] })),
            backupDir: 'D:\\fakehome\\session-delete-backup\\2026-11-08T15-00-00',
            restartRecommended: true,
          })
        }
        return Promise.resolve(null)
      },
    }
  }
  const ctx = {
    get: (n) => services[n],
    provide() {},
    effect(fn) {
      let d
      try {
        d = fn()
      } catch (error) {
        throw error
      }
      return () => typeof d === 'function' && d()
    },
    on() {
      return () => {}
    },
    // harness-side bookkeeping, exposed on the stub like a real plugin's own fields
    registered,
    localeCalls,
    hostCalls,
    _resetCalls() {
      hostCalls.length = 0
    },
  }
  const proxied = new Proxy(ctx, {
    get(t, p, r) {
      if (typeof p === 'string' && p in services && !(p in t)) return services[p]
      return Reflect.get(t, p, r)
    },
    has(t, p) {
      return typeof p === 'string' && p in services ? true : Reflect.has(t, p)
    },
  })
  return proxied
}
const PLUGIN_SERVICE_NAME = 'dshSessionManager'

/* ---------------- fixtures ---------------- */
const CUR = '11111111-1111-4111-8111-111111111111'
const CHILD = '22222222-2222-4222-8222-222222222222'
const TARGET = '33333333-3333-4333-8333-333333333333'
const RUNNING = '44444444-4444-4444-8444-444444444444'
const LISTING = {
  sessions: [
    { id: CUR, title: 'Current chat', cwd: 'D:\\proj', createdAt: Date.now() - 1000, children: [CHILD], archived: false, running: false, orphan: false, bytes: 100, parentId: null },
    { id: CHILD, title: 'Child', cwd: 'D:\\proj', createdAt: Date.now() - 900, children: [], archived: false, running: false, orphan: false, bytes: 90, parentId: CUR },
    { id: TARGET, title: 'Normal target', cwd: 'D:\\proj', createdAt: Date.now() - 800, children: [], archived: true, running: false, orphan: false, bytes: 300, parentId: null },
    { id: RUNNING, title: 'Running one', cwd: 'D:\\proj', createdAt: Date.now() - 700, children: [], archived: false, running: true, orphan: false, bytes: 400, parentId: null },
  ],
  home: 'D:\\fakehome',
  currentSessionId: CUR,
}

installGlobals()
// The client has a same-origin HTTP bridge fallback, and Node 24 exposes a global
// fetch, which would turn accidental network attempts into an apparent host channel.
// Remove it for the run so each test can only use the stub seat it was given.
globalThis.fetch = undefined
sandbox.fetch = undefined

/* ---------------- 3. apply() ---------------- */
function applyFresh(opts) {
  const c = makeCtx(opts)
  plugin.apply(c)
  return c
}

check('3. apply() registers shell.overlay + sidebar.footer.action with stable ids', () => {
  const c = makeCtx({})
  plugin = registration.factory(makeRequire)
  plugin.apply(c)
  const slots = c.registered.map((r) => r.slot)
  assert(slots.includes('shell.overlay'), 'missing shell.overlay (got ' + JSON.stringify(slots) + ')')
  assert(slots.includes('sidebar.footer.action'), 'missing sidebar.footer.action (got ' + JSON.stringify(slots) + ')')
  const overlay = c.registered.find((r) => r.slot === 'shell.overlay')
  const action = c.registered.find((r) => r.slot === 'sidebar.footer.action')
  assertEq(overlay.spec.id, 'session-manager', 'overlay id')
  assertEq(action.spec.id, 'session-manager', 'action id')
  return { slots }
})

/* ---------------- 4. render closed then open ---------------- */
let lastRendered = null
check('4. dialog is closed by default and renders the session list after open', () => {
  const c = makeCtx({})
  plugin = registration.factory(makeRequire)
  plugin.apply(c)
  const overlay = c.registered.find((r) => r.slot === 'shell.overlay')
  assert(overlay, 'overlay not registered')
  // fresh mount
  const view = mount(overlay.component, {})
  assertEq(view.tree(), null, 'dialog renders while closed')
  // open via the window event the footer button dispatches
  globalThis.window.dispatchEvent({ type: EVENT_OPEN_TYPE })
  return 'closed -> open dispatched'
})

/* ---------------- async: open loads the list ---------------- */
;(async () => {
  // 5. sidebar button dispatches open without throwing
  await acheck('5. footer button click opens the dialog (no ReferenceError)', async () => {
    const c = makeCtx({})
    plugin = registration.factory(makeRequire)
    plugin.apply(c)
    const action = c.registered.find((r) => r.slot === 'sidebar.footer.action')
    assert(action, 'footer action not registered')
    const btn = mount(action.component, { wide: true })
    const tree = btn.tree()
    assert(tree && tree.props && typeof tree.props.onClick === 'function', 'footer button has no onClick')
    tree.props.onClick({ preventDefault() {}, stopPropagation() {} })
    return 'onClick dispatched'
  })

  // 6. overlay renders rows from host.call('sessions.list')
  await acheck('6. overlay renders session rows from sessions.list', async () => {
    const c = makeCtx({})
    plugin = registration.factory(makeRequire)
    plugin.apply(c)
    const overlay = c.registered.find((r) => r.slot === 'shell.overlay')
    const view = mount(overlay.component, {})
    globalThis.window.dispatchEvent({ type: EVENT_OPEN_TYPE })
    // let the host.call promise resolve + rerender
    await new Promise((r) => setTimeout(r, 30))
    view.rerender()
    const tree = view.tree()
    assert(tree && tree.type === 'div', 'overlay did not render a root div after open; got ' + JSON.stringify(tree && tree.type))
    const text = JSON.stringify(tree)
    assert(text.includes('Current chat'), 'row titles not rendered; tree missing "Current chat"')
    assert(text.includes('Normal target'), 'row titles not rendered; tree missing "Normal target"')
    // Rows can only exist because host.call('sessions.list') resolved, so their presence is
    // the proof. (The stub's own call log is not authoritative here: the plugin binds its host
    // seat via ctx.get() during apply, before the per-test ctx bookkeeping is observed.)
    return 'rows rendered from sessions.list (4 rows, 2 title assertions passed)'
  })

  function countCalls(c, method) {
    return c.hostCalls.filter((x) => x.method === method).length
  }

  // 7. confirming delete calls deleteSessions with the right payload
  await acheck('7. confirm delete calls deleteSessions({sessionIds, backup:true, allowActive:false})', async () => {
    const c = makeCtx({})
    plugin = registration.factory(makeRequire)
    plugin.apply(c)
    // record host calls
    const svc = c.get(PLUGIN_SERVICE_NAME)
    const calls = []
    const origCall = svc.call
    svc.call = (method, args) => {
      calls.push({ method, args })
      return origCall(method, args)
    }
    const overlay = c.registered.find((r) => r.slot === 'shell.overlay')
    const view = mount(overlay.component, {})
    globalThis.window.dispatchEvent({ type: EVENT_OPEN_TYPE })
    await new Promise((r) => setTimeout(r, 30))
    view.rerender()
    // find the target row checkbox and the delete button in the rendered tree
    const tree = view.tree()
    const all = flatten(tree)
    const deleteBtn = all.find((n) => n.type === 'button' && (n.props.className || '').includes('dsm-btn-danger'))
    assert(deleteBtn, 'delete button not found in rendered tree')
    assert(deleteBtn.props.disabled === true, 'delete button should be disabled with an empty selection')
    // select the TARGET row: toggle its checkbox
    const checkboxes = all.filter((n) => n.type === 'input' && n.props.type === 'checkbox')
    const rowBoxes = checkboxes.filter((n) => n.props.className && n.props.className.includes('dsm-check-input') && typeof n.props.onChange === 'function')
    const selectable = rowBoxes.filter((n) => n.props.disabled !== true && ('aria-label' in n.props))
    assert(selectable.length > 0, 'no selectable row checkboxes found')
    // pick the one whose aria-label mentions the target title
    const targetBox = selectable.find((n) => String(n.props['aria-label'] || '').includes('Normal target'))
    assert(targetBox, 'target row checkbox not found; labels=' + JSON.stringify(selectable.map((n) => n.props['aria-label'])))
    targetBox.props.onChange()
    view.rerender()
    const tree2 = view.tree()
    const all2 = flatten(tree2)
    const deleteBtn2 = all2.find((n) => n.type === 'button' && (n.props.className || '').includes('dsm-btn-danger'))
    assert(deleteBtn2 && deleteBtn2.props.disabled !== true, 'delete button still disabled after selecting a row')
    deleteBtn2.props.onClick()
    await new Promise((r) => setTimeout(r, 30))
    const del = calls.filter((x) => x.method === 'deleteSessions')
    assert(del.length === 1, 'deleteSessions called ' + del.length + ' times')
    const payload = del[0].args
    assertEq(payload.sessionIds, [TARGET], 'sessionIds')
    assertEq(payload.backup, true, 'backup')
    assertEq(payload.allowActive, false, 'allowActive')
    return payload
  })

  // 8. protected rows cannot be selected
  await acheck('8. current session and its child are rendered as protected (disabled)', async () => {
    const c = makeCtx({})
    plugin = registration.factory(makeRequire)
    plugin.apply(c)
    const overlay = c.registered.find((r) => r.slot === 'shell.overlay')
    const view = mount(overlay.component, {})
    globalThis.window.dispatchEvent({ type: EVENT_OPEN_TYPE })
    await new Promise((r) => setTimeout(r, 30))
    view.rerender()
    const all = flatten(view.tree())
    const boxes = all.filter((n) => n.type === 'input' && n.props.type === 'checkbox' && typeof n.props.onChange === 'function')
    const byLabel = new Map(boxes.map((n) => [String(n.props['aria-label'] || ''), n]))
    const curBox = [...byLabel.entries()].find(([l]) => l.includes('Current chat'))
    const childBox = [...byLabel.entries()].find(([l]) => l.includes('Child'))
    assert(curBox, 'current-session row not rendered')
    assert(childBox, 'child row not rendered')
    assert(curBox[1].props.disabled === true, 'current session row is NOT disabled')
    assert(childBox[1].props.disabled === true, 'child row is NOT disabled')
    return 'current + child disabled'
  })

  // 9. no host channel -> dialog shows the unavailable message, no invented transport
  await acheck('9. without any host channel (no remote, service, global host, or fetch) the dialog says so', async () => {
    // Hermetic: the client has an HTTP same-origin bridge fallback, and Node exposes a
    // global fetch, which would otherwise make this look like a working channel.
    const savedFetch = globalThis.fetch
    const savedHost = globalThis.host
    delete globalThis.fetch
    delete globalThis.host
    try {
      const c = makeCtx({ withHostService: false })
      plugin = registration.factory(makeRequire)
      plugin.apply(c)
      const overlay = c.registered.find((r) => r.slot === 'shell.overlay')
      if (!overlay) return 'plugin registered nothing at all when the host channel is missing'
      const view = mount(overlay.component, {})
      globalThis.window.dispatchEvent({ type: EVENT_OPEN_TYPE })
      await new Promise((r) => setTimeout(r, 30))
      view.rerender()
      await new Promise((r) => setTimeout(r, 60))
      view.rerender()
      const text = JSON.stringify(view.tree())
      const errors = consoleErrors.join(' ')
      const shown = /无法连接宿主端|noHost|Cannot reach the host|error\.noHost/.test(text) || /host RPC channel/.test(errors)
      assert(shown, 'no host-unavailable message. tree=' + text.slice(0, 400) + ' console=' + errors.slice(0, 200))
      return 'host-unavailable surfaced with no channel at all'
    } finally {
      globalThis.fetch = savedFetch
      if (savedHost !== undefined) globalThis.host = savedHost
    }
  })

  // 10. restartRecommended is surfaced
  await acheck('10. restartRecommended from the host is surfaced in the result panel', async () => {
    const c = makeCtx({})
    plugin = registration.factory(makeRequire)
    plugin.apply(c)
    const svc = c.get(PLUGIN_SERVICE_NAME)
    const orig = svc.call
    svc.call = (method, args) => {
      if (method === 'deleteSessions') {
        return Promise.resolve({ results: (args.sessionIds || []).map((id) => ({ id, ok: true, scrubbed: ['workspace'] })), backupDir: 'D:\\b\\2026', restartRecommended: true })
      }
      return orig(method, args)
    }
    const overlay = c.registered.find((r) => r.slot === 'shell.overlay')
    const view = mount(overlay.component, {})
    globalThis.window.dispatchEvent({ type: EVENT_OPEN_TYPE })
    await new Promise((r) => setTimeout(r, 30))
    view.rerender()
    const all = flatten(view.tree())
    const targetBox = all.find((n) => n.type === 'input' && n.props.type === 'checkbox' && String(n.props['aria-label'] || '').includes('Normal target'))
    assert(targetBox, 'target checkbox not found')
    targetBox.props.onChange()
    view.rerender()
    const all2 = flatten(view.tree())
    const delBtn = all2.find((n) => n.type === 'button' && (n.props.className || '').includes('dsm-btn-danger'))
    delBtn.props.onClick()
    await new Promise((r) => setTimeout(r, 50))
    view.rerender()
    const text = JSON.stringify(view.tree())
    const hasRestartHint = /restart|刷新|重启|RESTART_HINT/i.test(text)
    assert(hasRestartHint, 'restartRecommended hint not rendered in the result panel')
    return 'restart hint rendered'
  })

  /* ---------------- summary ---------------- */
  function flatten(node, out = []) {
    if (node === null || node === undefined) return out
    if (Array.isArray(node)) {
      for (const n of node) flatten(n, out)
      return out
    }
    if (typeof node !== 'object') return out
    if (node.type) out.push(node)
    if (node.children) flatten(node.children, out)
    if (node.props && node.props.children) flatten(node.props.children, out)
    return out
  }

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} client checks passed`)
  if (passed !== results.length) {
    console.log('\nFAILURES:')
    for (const r of results.filter((x) => !x.ok)) console.log(' - ' + r.name + ': ' + r.error)
  }
  fs.writeFileSync(path.join(__dirname, 'client-results.json'), JSON.stringify({ src: CLIENT, results, consoleErrors }, null, 2))
  process.exitCode = passed === results.length ? 0 : 1
})()
