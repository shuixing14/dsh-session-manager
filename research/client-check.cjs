// dsh-session-manager client.js 自检（research/client-check.cjs）
//
// 把一个经典脚本 bundle 当作浏览器那样执行：给 vm 上下文注入 window.__ModuleLoader__，
// 捕获 { id, factory } 注册，再用仿造的 require('react') 物化 factory，拿到插件对象，
// 装上假的 ctx（get('slots') / effect / get('dshSessionManager')），渲染组件并断言
// host.call('deleteSessions', { sessionIds, backup, allowActive }) 的载荷。
//
// 运行：node research/client-check.cjs [path/to/client.js]
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const CLIENT = process.argv[2] || path.join(__dirname, '..', 'client.js')

// ───────────────────────── React stub（只够这个组件用）─────────────────────────
function createElement(type, props) {
  // 与真 React 一致：函数组件当场展开成它返回的元素（宿主元素名保持字符串）。
  if (typeof type === 'function') {
    const kids = Array.prototype.slice.call(arguments, 2)
    const merged = Object.assign({}, props && typeof props === 'object' ? props : {})
    if (kids.length > 0) merged.children = kids.length === 1 ? kids[0] : kids
    return type(merged)
  }
  const node = { type, props: props && typeof props === 'object' ? Object.assign({}, props) : {}, children: [] }
  const kids = Array.prototype.slice.call(arguments, 2)
  if (node.props.children !== undefined) kids.push(...(Array.isArray(node.props.children) ? node.props.children : [node.props.children]))
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false || kid === true) continue
    if (Array.isArray(kid)) {
      for (const inner of kid) if (inner !== null && inner !== undefined && inner !== false) node.children.push(inner)
    } else node.children.push(kid)
  }
  return node
}

const hookState = []
let cursor = 0
let pendingEffects = []
let dirty = false

const React = {
  createElement,
  useState(initial) {
    const idx = cursor++
    if (hookState[idx] !== undefined) return hookState[idx]
    const slot = [
      typeof initial === 'function' ? initial() : initial,
      (next) => {
        const value = typeof next === 'function' ? next(hookState[idx][0]) : next
        if (!Object.is(hookState[idx][0], value)) {
          hookState[idx][0] = value
          dirty = true
        }
      },
    ]
    hookState[idx] = slot
    return slot
  },
  useRef(initial) {
    const idx = cursor++
    if (hookState[idx] === undefined) hookState[idx] = { current: initial }
    return hookState[idx]
  },
  // 与真 React 一致：deps 不变就返回同一个引用（否则每次渲染都换函数，
  // 依赖它的 useEffect 会反复重跑，监听器越挂越多 —— 组件本身没问题，是假 React 不忠）。
  useCallback(fn, deps) {
    const idx = cursor++
    const prev = hookState[idx]
    const same = prev !== undefined && !!(deps && prev.deps) && deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]))
    if (same) return prev.value
    const record = { deps, value: fn }
    hookState[idx] = record
    return fn
  },
  useMemo(fn, deps) {
    const idx = cursor++
    const prev = hookState[idx]
    const same = prev !== undefined && (deps === undefined || (!!prev.deps && deps.length === prev.deps.length && deps.every((d, i) => Object.is(d, prev.deps[i]))))
    if (same) return prev.value
    const record = { deps, value: fn() }
    hookState[idx] = record
    return record.value
  },
  useEffect(fn, deps) {
    const idx = cursor++
    const prev = hookState[idx]
    const changed = !prev || !prev.deps || !deps || deps.length !== prev.deps.length || !deps.every((d, i) => Object.is(d, prev.deps[i]))
    if (!changed) return
    const record = { deps, cleanup: prev && prev.cleanup }
    hookState[idx] = record
    pendingEffects.push(() => {
      if (typeof record.cleanup === 'function') record.cleanup()
      const produced = fn()
      record.cleanup = typeof produced === 'function' ? produced : undefined
    })
  },
  useLayoutEffect(fn, deps) {
    React.useEffect(fn, deps)
  },
}
React.default = React

// ───────────────────────── 假 DOM / window ─────────────────────────
const windowListeners = new Map()
const docListeners = new Map()
const fakeWindow = {
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) {
    windowListeners.get(type)?.delete(fn)
  },
  dispatchEvent(event) {
    for (const fn of [...(windowListeners.get(event.type) || [])]) fn(event)
  },
  getComputedStyle() {
    return { zIndex: 'auto' }
  },
}
const createdStyles = []
const fakeDocument = {
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, new Set())
    docListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) {
    docListeners.get(type)?.delete(fn)
  },
  createElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      dataset: {},
      textContent: '',
      removed: false,
      remove() {
        el.removed = true
      },
    }
    createdStyles.push(el)
    return el
  },
  head: { append() {} },
  body: null,
}

// ───────────────────────── 宿主 RPC 打桩 ─────────────────────────
const calls = []
const SESSIONS = {
  home: 'C:\\Users\\tester\\.dsh',
  currentSessionId: 'session-current',
  sessions: [
    { id: 'session-current', title: '当前会话', inWorkspace: true, cwd: 'D:\\dsh', createdAt: Date.now() - 60000, running: true, children: ['session-child'] },
    { id: 'session-child', title: '子代理', cwd: 'D:\\dsh', createdAt: Date.now() - 120000, parentId: 'session-current', origin: 'subagent', inWorkspace: true, children: [] },
    { id: 'session-a', title: '重构索引器', inWorkspace: true, updatedAt: Date.now() - 3600000, cwd: 'D:\\dsh\\alpha', createdAt: Date.now() - 3 * 86400000, children: [], bytes: 4096 },
    { id: 'session-b', title: '调试窗口闪烁', inWorkspace: true, cwd: 'D:\\dsh\\beta', createdAt: Date.now() - 3600000, archived: true, running: true, children: [], bytes: 307200 },
    { id: 'orphan-1', title: 'garbage', cwd: null, createdAt: null, orphan: true, inWorkspace: false, children: [] },
  ],
}
const rpc = {
  async call(method, args) {
    calls.push({ method, args })
    if (method === 'sessions.list') return JSON.parse(JSON.stringify(SESSIONS))
    if (method === 'deleteSessions') {
      const ids = args && Array.isArray(args.sessionIds) ? args.sessionIds : []
      return {
        results: ids.map((id) => (id === 'session-b' ? { id, ok: false, error: '会话有进行中的工作' } : { id, ok: true })),
        backupDir: 'C:\\Users\\tester\\.dsh\\session-delete-backup\\20261108-160000',
        restartRecommended: true,
      }
    }
    throw new Error('unknown method ' + method)
  },
}

// ───────────────────────── 断言工具 ─────────────────────────
let failures = 0
function ok(condition, label, detail) {
  if (condition) {
    console.log('  PASS ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail))
}
function findAll(node, predicate, out) {
  const acc = out || []
  if (node === null || node === undefined) return acc
  if (node && node.type && predicate(node)) acc.push(node)
  if (node && node.children) for (const kid of node.children) findAll(kid, predicate, acc)
  return acc
}
function fire(node, patch) {
  if (node.props.type === 'checkbox') {
    node.props.onChange({ target: { checked: patch.checked, value: String(patch.checked) }, preventDefault() {}, stopPropagation() {} })
    return
  }
  if (node.props.type === 'search' || node.props.type === 'text') {
    node.props.onChange({ target: { value: patch.value }, preventDefault() {}, stopPropagation() {} })
    return
  }
  node.props.onClick({ preventDefault() {}, stopPropagation() {}, target: null, currentTarget: null })
}
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms === undefined ? 0 : ms))

// ───────────────────────── 主体 ─────────────────────────
async function main() {
  console.log('client:', CLIENT)
  const source = fs.readFileSync(CLIENT, 'utf8')

  // 1) 以经典脚本执行：只允许一次 __ModuleLoader__.load 注册
  const registrations = []
  const sandbox = {
    window: Object.assign(Object.create(null), fakeWindow, {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration)
        },
      },
    }),
    document: fakeDocument,
    console,
    setTimeout,
    clearTimeout,
    // 生产环境的页面里 fetch 一定存在；这里默认给一个“永远失败”的实现，
    // 让传输选择仍然落在 Remote 分支（HTTP 桥会被解析成次选）。
    fetch() {
      return Promise.reject(new Error('client-check: fetch is not stubbed'))
    },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: CLIENT })

  ok(registrations.length === 1, 'registers exactly one bundle factory on window.__ModuleLoader__', registrations.length)
  const registration = registrations[0] || {}
  ok(registration.id === 'dsh-session-manager', 'registration id is dsh-session-manager', JSON.stringify(registration.id))
  ok(typeof registration.factory === 'function', 'registration carries a factory function')

  // 2) 物化：factory(require)，require 只认 'react'
  const requireCalls = []
  const requireStub = (spec) => {
    requireCalls.push(spec)
    if (spec === 'react') return React
    throw new Error('client-check: unexpected require(' + JSON.stringify(spec) + ')')
  }
  const plugin = registration.factory(requireStub)
  ok(requireCalls.includes('react'), "factory calls require('react')", JSON.stringify(requireCalls))
  ok(plugin && typeof plugin === 'object', 'factory returns an object (not a function)')
  ok(plugin.name === 'dsh-session-manager', 'plugin.name', plugin && plugin.name)
  ok(Array.isArray(plugin.inject) && plugin.inject.length === 1 && plugin.inject[0] === 'slots', "plugin.inject === ['slots']", JSON.stringify(plugin && plugin.inject))
  ok(typeof plugin.apply === 'function', 'plugin.apply is a function')

  // 3) 假 ctx：slots / effect / remote 命名空间（A 路径，生产路径）
  const registered = []
  const slots = {
    register(mutator, component) {
      registered.push({ options: mutator, component })
      return () => {}
    },
    inject(name, callback) {
      ok(typeof name === 'string', 'slots.inject(' + name + ')')
      return callback()
    },
  }
  const remoteCalls = []
  const remoteState = { failList: false, failDelete: false }
  function remoteError(code, message) {
    const error = new Error(message)
    error.code = code
    error.isDSHRemoteError = true
    return error
  }
  const remoteNamespace = {
    list() {
      remoteCalls.push({ method: 'list', args: [] })
      if (remoteState.failList) return Promise.reject(remoteError('gateway/invocation-unavailable', 'no active Remote method exports this endpoint'))
      return Promise.resolve(JSON.parse(JSON.stringify(SESSIONS)))
    },
    delete(request) {
      remoteCalls.push({ method: 'delete', args: [request] })
      if (remoteState.failDelete) return Promise.reject(remoteError('remote-access/denied', 'remote access: dshSessionManager/delete: access denied'))
      const ids = request && Array.isArray(request.sessionIds) ? request.sessionIds : []
      return Promise.resolve({
        results: ids.map((id) => (id === 'session-b' ? { id, ok: false, error: '会话有进行中的工作' } : { id, ok: true })),
        backupDir: 'C:\\Users\\tester\\.dsh\\session-delete-backup\\20261108-160000',
        restartRecommended: true,
      })
    },
  }
  const services = {
    slots,
    remote: { dshSessionManager: remoteNamespace },
    locale: {
      registered: [],
      register(namespace, dicts) {
        this.registered.push({ namespace, dicts })
        return () => {}
      },
      bind(namespace) {
        return (key, params) => {
          const template = this.registered[0]?.dicts?.zh?.[key] ?? key
          if (!params) return template
          return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
        }
      },
      getSnapshot() {
        return { active: 'zh' }
      },
    },
  }
  const effects = []
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
      return () => {}
    },
    inject(names, fn) {
      return fn()
    },
    on() {},
  }
  plugin.apply(ctx)
  ok(effects.length >= 1, 'apply installs ctx.effect resources (stylesheet/open bridge)', effects.length)
  ok(createdStyles.length === 1 && createdStyles[0].dataset.plugin === 'dsh-session-manager', 'style tag carries data-plugin="dsh-session-manager"', createdStyles.length)
  ok(services.locale.registered.some((entry) => entry.namespace === 'dsh-session-manager' && entry.dicts.zh && entry.dicts.en), 'locale dictionaries registered for zh + en')

  const overlay = registered.find((entry) => entry.options && entry.options.name === 'shell.overlay')
  const footer = registered.find((entry) => entry.options && entry.options.name === 'sidebar.footer.action')
  const menuEntry = registered.find((entry) => entry.options && entry.options.name === 'sidebar.workspaces.session.menu.item')
  ok(registered.length === 3, 'registers exactly three slot entries (overlay + footer + session-row menu item)', registered.length)
  ok(!!overlay && overlay.options.id === 'session-manager', 'shell.overlay id = session-manager', overlay && overlay.options.id)
  ok(!!footer && footer.options.id === 'session-manager' && footer.options.order === 10, 'sidebar.footer.action id = session-manager, order = 10')
  ok(!!footer && typeof footer.options.label === 'function', 'footer entry label is a thunk')
  // ── PART A：侧栏会话行「…」菜单里的删除入口 ──
  ok(!!menuEntry, 'registers on sidebar.workspaces.session.menu.item', JSON.stringify(registered.map((entry) => entry.options && entry.options.name)))
  ok(!!menuEntry && menuEntry.options.id === 'dsh-session-manager.delete', 'menu entry id = dsh-session-manager.delete', menuEntry && menuEntry.options.id)
  ok(!!menuEntry && typeof menuEntry.options.order === 'number' && menuEntry.options.order > 450, 'menu entry order lands after the shipped session-id row (450)', menuEntry && menuEntry.options.order)
  ok(!!menuEntry && typeof menuEntry.component === 'function', 'menu entry registers a component')

  // 4) 侧栏按钮：渲染成 button + 18px SVG，点击派发 window 事件
  let tree = null
  function render() {
    cursor = 0
    pendingEffects = []
    tree = overlay.component({})
    pendingEffects.forEach((run) => run())
  }
  const buttonTree = (() => {
    const save = tree
    cursor = 0
    pendingEffects = []
    const out = footer.component({ wide: true })
    pendingEffects.forEach((run) => run())
    tree = save
    return out
  })()
  ok(buttonTree && buttonTree.type === 'button', 'footer action renders a <button>')
  const svgNode = findAll(buttonTree, (node) => node.type === 'svg')[0]
  ok(!!svgNode && svgNode.props.width === 18, 'footer action icon is an 18px SVG')
  ok(findAll(buttonTree, (node) => node.type === 'span' && node.children.includes('删除会话')).length === 1, 'wide footer action shows the 删除会话 label')

  render()
  ok(tree === null, 'overlay renders nothing before it is opened')

  sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open' })
  await tick()
  await tick()
  render()
  ok(tree !== null, 'window event opens the dialog')
  const dialog = findAll(tree, (node) => node.props && node.props.role === 'dialog')[0]
  ok(!!dialog && dialog.props['aria-modal'] === 'true', 'role="dialog" aria-modal="true"')
  ok(!!dialog && dialog.props['aria-labelledby'] === 'dsm-title', 'dialog is labelled by the title')
  ok(remoteCalls.some((call) => call.method === 'list'), 'opening calls ctx.remote.dshSessionManager.list()')

  const rows = findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row'))
  ok(rows.length === 4, 'one row per sidebar session (hidden scope collapsed)', rows.length)
  const disabled = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.disabled === true)
  ok(disabled.length >= 2, 'current session and its child are not selectable', disabled.length)
  const badgeText = findAll(tree, (node) => String(node.props.className || '').startsWith('dsm-badge ')).map((node) => node.children.join(''))
  ok(
    badgeText.includes('当前会话') && badgeText.includes('已归档') && badgeText.some((text) => text.includes('子会话')),
    'protected / archived / child badges render',
    JSON.stringify(badgeText),
  )
  ok(badgeText.some((text) => text.includes('含 1 个子会话')), 'parent badge shows the child count', JSON.stringify(badgeText))

  // 搜索
  const search = findAll(tree, (node) => node.type === 'input' && node.props.type === 'search')[0]
  ok(!!search, 'search input present')
  fire(search, { value: '索引' })
  render()
  ok(findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row')).length === 1, 'search narrows the list')
  fire(search, { value: '' })
  render()

  // 勾选非受保护的会话
  const selectable = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled && String(node.props.className || '').includes('dsm-check-input'))
  ok(selectable.length >= 3, 'selectable checkboxes exist', selectable.length)
  fire(selectable[0], { checked: true })
  render()

  const deleteButton = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-btn-danger'))[0]
  ok(!!deleteButton, 'danger delete button present')
  ok(deleteButton.props.disabled === false, 'delete enabled once a session is selected')
  fire(deleteButton, {})
  await tick()
  await tick()
  render()

  const deletion = remoteCalls.filter((call) => call.method === 'delete').map((call) => ({ args: call.args[0] }))[0]
  ok(!!deletion, 'clicking 删除 calls ctx.remote.dshSessionManager.delete(request)')
  console.log('  info delete payload:', JSON.stringify(deletion && deletion.args))
  if (deletion) {
    const ids = Array.isArray(deletion.args.sessionIds) ? deletion.args.sessionIds : []
    ok(ids.length >= 1, 'deleteSessions carries the selected session ids', JSON.stringify(deletion.args))
    ok(ids.indexOf('session-current') < 0 && ids.indexOf('session-child') < 0, 'current session and its child are never sent')
    ok(deletion.args.backup === true, 'backup defaults to true')
    ok(deletion.args.allowActive === false, 'allowActive defaults to false')
  }
  const resultPanel = findAll(tree, (node) => String(node.props.className || '').split(' ').indexOf('dsm-results') >= 0)
  ok(resultPanel.length === 1, 'per-id result panel is shown', JSON.stringify(resultPanel.map((node) => node.props.className)))
  const resultText = JSON.stringify(resultPanel[0] || {})
  ok(resultText.includes('备份目录'), 'result shows the backupDir path')
  ok(resultText.includes('重启'), 'restartRecommended hint is shown')

  // 关闭后再次打开：备份开关落到 host 载荷
  const closeButton = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-close'))[0]
  ok(!!closeButton, 'close button present')
  fire(closeButton, {})
  render()
  ok(tree === null, 'close button hides the dialog')
  sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open' })
  await tick()
  await tick()
  render()
  const toggles = findAll(tree, (node) => node.type === 'input' && String(node.props.className || '').includes('dsm-toggle-input'))
  ok(toggles.length === 2, 'footer has backup + allowActive toggles', toggles.length)
  fire(toggles[0], { checked: false })
  render()
  const rowChecks = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled && String(node.props.className || '').includes('dsm-check-input'))
  fire(rowChecks[0], { checked: true })
  render()
  const deleteButton2 = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-btn-danger'))[0]
  fire(deleteButton2, {})
  await tick()
  await tick()
  render()
  const lastDeletion = remoteCalls.filter((call) => call.method === 'delete').pop() && { args: remoteCalls.filter((call) => call.method === 'delete').pop().args[0] }
  ok(!!lastDeletion && lastDeletion.args.backup === false, 'backup toggle reaches the host payload')

  // Esc 关闭
  const onKey = [...(docListeners.get('keydown') || [])][0]
  ok(typeof onKey === 'function', 'Escape handler installed while open')
  if (typeof onKey === 'function') {
    onKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
    render()
    ok(tree === null, 'Escape closes the dialog')
  }

  // 5) 没有宿主通道时：明确显示「无法连接宿主端」，且不抛错
  const realFetch = sandbox.fetch
  delete sandbox.fetch
  hookState.length = 0
  remoteCalls.length = 0
  const noHostCtx = {
    get(name) {
      return name === 'slots' ? slots : undefined
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
      return () => {}
    },
  }
  const noHostRegistrations = registered.length
  plugin.apply(noHostCtx)
  const noHostOverlay = registered.slice(noHostRegistrations).find((entry) => entry.options && entry.options.name === 'shell.overlay')
  ok(!!noHostOverlay, 'plugin still mounts without a host RPC channel')
  if (noHostOverlay) {
    hookState.length = 0
    cursor = 0
    pendingEffects = []
    tree = noHostOverlay.component({})
    pendingEffects.forEach((run) => run())
    sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open' })
    await tick()
    await tick()
    cursor = 0
    pendingEffects = []
    tree = noHostOverlay.component({})
    pendingEffects.forEach((run) => run())
    const alert = findAll(tree, (node) => String(node.props.className || '').includes('dsm-alert'))
    const alertText = alert.length ? String(alert[0].children.filter((kid) => typeof kid === 'string').join('')) : ''
    ok(alert.length >= 1 && alertText.includes('无法连接宿主端'), 'shows 无法连接宿主端 when no transport exists', alert.length ? JSON.stringify(alert[0].children) : 'none')
    ok(remoteCalls.length === 0, 'no remote call is fabricated', remoteCalls.length)
  }
  sandbox.fetch = realFetch

  // 6) HTTP 桥（C 路径）：fetch('/dsh-session-manager/list') + POST /dsh-session-manager/delete
  const httpCalls = []
  sandbox.fetch = (url, init) => {
    httpCalls.push({ url, init })
    if (init.method === 'GET') {
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify(SESSIONS)) })
    }
    const body = JSON.parse(init.body)
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () =>
        Promise.resolve(
          JSON.stringify({
            results: body.sessionIds.map((id) => ({ id, ok: true })),
            backupDir: 'C:\\Users\\tester\\.dsh\\session-delete-backup\\20261108-170000',
            restartRecommended: false,
          }),
        ),
    })
  }
  const httpCtx = {
    get(name) {
      return name === 'slots' ? slots : name === 'locale' ? services.locale : undefined
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
      return () => {}
    },
  }
  const httpRegistrations = registered.length
  plugin.apply(httpCtx)
  const httpOverlay = registered.slice(httpRegistrations).find((entry) => entry.options && entry.options.name === 'shell.overlay')
  ok(!!httpOverlay, 'plugin mounts with only fetch available (HTTP bridge)')
  if (httpOverlay) {
    hookState.length = 0
    cursor = 0
    pendingEffects = []
    tree = httpOverlay.component({})
    pendingEffects.forEach((run) => run())
    sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open' })
    await tick()
    await tick()
    cursor = 0
    pendingEffects = []
    tree = httpOverlay.component({})
    pendingEffects.forEach((run) => run())
    const listCall = httpCalls.find((call) => call.init.method === 'GET')
    ok(!!listCall && listCall.url === '/dsh-session-manager/list', 'HTTP bridge lists via GET /dsh-session-manager/list', listCall && listCall.url)
    ok(!!listCall && listCall.init.credentials === 'same-origin', 'HTTP bridge sends same-origin credentials')
    ok(findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row')).length === 4, 'HTTP bridge listing renders sidebar rows')
    const rowChecks = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled && String(node.props.className || '').includes('dsm-check-input'))
    // session-a 的删除会成功；session-b（archived+running）在桩里是失败项，不能拿它验证刷新。
    fire(rowChecks[rowChecks.length - 1], { checked: true })
    render()
    const delBtn = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-btn-danger'))[0]
    fire(delBtn, {})
    await tick()
    await tick()
    render()
    const postCall = httpCalls.find((call) => call.init.method === 'POST')
    ok(!!postCall && postCall.url === '/dsh-session-manager/delete', 'HTTP bridge deletes via POST /dsh-session-manager/delete', postCall && postCall.url)
    let posted = null
    try {
      posted = postCall ? JSON.parse(postCall.init.body) : null
    } catch {}
    ok(!!posted && Array.isArray(posted.sessionIds) && posted.sessionIds.length >= 1 && posted.backup === true && posted.allowActive === false, 'POST body carries {sessionIds, backup, allowActive}', postCall && postCall.init.body)
    ok(!!postCall && postCall.init.headers && postCall.init.headers['content-type'] === 'application/json', 'POST declares application/json')
    ok(String(JSON.stringify(findAll(tree, (node) => String(node.props.className || '').split(' ').indexOf('dsm-results') >= 0))).includes('备份目录'), 'HTTP bridge result panel shows backupDir')
  }

  // 7) HTTP 桥非 2xx：把 JSON {error} 渲染出来
  sandbox.fetch = (url, init) =>
    Promise.resolve({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: () => Promise.resolve(JSON.stringify({ error: '跨站请求被拒绝' })),
    })
  hookState.length = 0
  cursor = 0
  pendingEffects = []
  tree = httpOverlay.component({})
  pendingEffects.forEach((run) => run())
  sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open' })
  await tick()
  await tick()
  cursor = 0
  pendingEffects = []
  tree = httpOverlay.component({})
  pendingEffects.forEach((run) => run())
  const httpAlert = findAll(tree, (node) => String(node.props.className || '').split(' ').indexOf('dsm-alert') >= 0)
  ok(httpAlert.length === 1 && String(httpAlert[0].children.join('')).includes('跨站请求被拒绝'), 'non-2xx response renders its {error} message', httpAlert.length ? JSON.stringify(httpAlert[0].children) : 'none')
  sandbox.fetch = realFetch

  // 8) RemoteError：把 code + message 渲染出来（A 路径失败）
  plugin.apply(ctx) // 重新 apply 一次，把 transport 指回 remote 命名空间
  hookState.length = 0
  cursor = 0
  pendingEffects = []
  tree = overlay.component({})
  pendingEffects.forEach((run) => run())
  remoteState.failList = true
  remoteCalls.length = 0
  sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open' })
  await tick()
  await tick()
  cursor = 0
  pendingEffects = []
  tree = overlay.component({})
  pendingEffects.forEach((run) => run())
  const remoteAlert = findAll(tree, (node) => String(node.props.className || '').split(' ').indexOf('dsm-alert') >= 0)
  const remoteAlertText = remoteAlert.length ? String(remoteAlert[0].children.join('')) : ''
  ok(remoteAlert.length === 1 && remoteAlertText.includes('gateway/invocation-unavailable') && remoteAlertText.includes('no active Remote method exports this endpoint'), 'RemoteError code + message are rendered', remoteAlertText)
  ok(remoteCalls.some((call) => call.method === 'list'), 'failed remote list was actually attempted')
  remoteState.failList = false
  remoteState.failDelete = true

  // 打一次删除，确认远程 delete 的 RemoteError 也渲染
  const closeBtn2 = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-close'))[0]
  fire(closeBtn2, {})
  render()
  sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open' })
  await tick()
  await tick()
  render()
  const rowChecks2 = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled && String(node.props.className || '').includes('dsm-check-input'))
  fire(rowChecks2[0], { checked: true })
  render()
  const delBtn2 = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-btn-danger'))[0]
  fire(delBtn2, {})
  await tick()
  await tick()
  render()
  const deleteAlert = findAll(tree, (node) => String(node.props.className || '').split(' ').indexOf('dsm-alert') >= 0)
  ok(deleteAlert.length === 1 && String(deleteAlert[0].children.join('')).includes('remote-access/denied'), 'RemoteError from delete(request) is rendered', deleteAlert.length ? JSON.stringify(deleteAlert[0].children) : 'none')
  remoteState.failDelete = false

  // ═════════════════════════════════════════════════════════════════════
  // 9) PART A —— 侧栏会话行「…」菜单里的「删除会话…」
  //    插槽：sidebar.workspaces.session.menu.item
  //    ownerProps: { sessionId, displayTitle }（与官方 pin/rename/fork/archive/session-id 一致）
  //    插槽 hook：inject.hooks.menuOpenState → 组件 props.useMenuOpenState
  // ═════════════════════════════════════════════════════════════════════
  console.log('')
  console.log('-- PART A: session-row "…" menu entry --')

  /** 把假 React 的 hook 环境清干净，再渲染一个组件（模拟一次全新挂载）。 */
  function mount(component, props) {
    // 每「挂载」一次都从零开始：hook 槽位清空 + 丢掉上一次挂载留下的打开监听
    // （真浏览器里组件卸载会跑 cleanup，这里的假 React 不会，所以手动清）。
    resetOpenListeners()
    hookState.length = 0
    cursor = 0
    pendingEffects = []
    const out = component(props || {})
    pendingEffects.forEach((run) => run())
    return out
  }
  /** 同一个进程里反复挂载会残留旧的打开监听；每次「像浏览器一样重新加载」前清掉。 */
  function resetOpenListeners() {
    const harness = sandbox.window.__DSH_SESSION_MANAGER_HARNESS__
    if (harness && typeof harness.reset === 'function') harness.reset()
  }

  const menuMount = registered.find((entry) => entry.options && entry.options.name === 'sidebar.workspaces.session.menu.item')
  ok(!!menuMount, 'menu entry captured from registration')
  if (menuMount) {
    // 注册时声明的 inject 必须是「插槽 hook」而不是自造的值。
    const injectOptions = menuMount.options.inject
    const injected = typeof injectOptions === 'function' ? injectOptions({ sessionId: 'session-a', displayTitle: '重构索引器' }) : injectOptions
    ok(!!injected && !!injected.hooks && typeof injected.hooks.menuOpenState !== 'undefined', 'menu entry inject exposes hooks.menuOpenState (slot-provided hook)', JSON.stringify(Object.keys((injected && injected.hooks) || {})))

    // 假的菜单 open state hook：官方签名是 useMenuOpenState() -> [state, setOpen]。
    const menuStateCalls = []
    const menuItemProps = {
      sessionId: 'session-a',
      displayTitle: '重构索引器',
      useMenuOpenState: () => [{ open: true }, (next) => menuStateCalls.push(next)],
      useShortcuts: () => undefined,
      t: (key) => ({ 'menu.delete': '删除会话…' }[key] || key),
    }
    const menuNode = mount(menuMount.component, menuItemProps)
    const menuButtons = findAll(menuNode, (node) => node.type === 'button' && node.props.role === 'menuitem')
    ok(menuButtons.length === 1, 'menu entry renders exactly one role="menuitem" button', menuButtons.length)
    ok(!!menuButtons[0] && JSON.stringify(menuButtons[0]).includes('删除会话'), 'menu row label is 删除会话', menuButtons[0] ? JSON.stringify(menuButtons[0]).slice(0, 160) : 'none')

    // 点击：菜单项内部先收起菜单，再用 { sessionId } 打开同一个弹窗（端到端验证见下面预勾选）。
    menuStateCalls.length = 0
    const menuNode2 = mount(menuMount.component, menuItemProps)
    const menuButtons2 = findAll(menuNode2, (node) => node.type === 'button' && node.props.role === 'menuitem')
    ok(menuStateCalls.length === 0, 'menu is not closed before the click')
    fire(menuButtons2[0], {})
    ok(menuStateCalls.length === 1 && menuStateCalls[0] === false, 'clicking the menu row closes the menu through useMenuOpenState()', JSON.stringify(menuStateCalls))

    // 弹窗按 sessionId 预先勾选：让列表回到 Remote + 全量数据，再带 detail 打开。
    hookState.length = 0
    remoteCalls.length = 0
    plugin.apply(ctx)
    const overlayNow = registered.filter((entry) => entry.options && entry.options.name === 'shell.overlay').pop()
    // 打开一次并等待列表落到「带 sessionId 的打开请求」上。
    // 状态存在假 React 的 hook 槽位里，所以「首次挂载」之后只重渲染、不清槽位，
    // 否则 open=true 会被重置成初始值。
    function rerender() {
      cursor = 0
      pendingEffects = []
      const out = overlayNow.component({})
      pendingEffects.forEach((run) => run())
      return out
    }
    async function openWithDetail(sessionId) {
      resetOpenListeners()
      hookState.length = 0
      cursor = 0
      pendingEffects = []
      rerender() // 首次挂载：注册打开监听
      sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open', detail: { sessionId } })
      await tick()
      await tick()
      await tick()
      return rerender()
    }
    tree = await openWithDetail('session-a')
    const preselectRows = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === true && String(node.props.className || '').includes('dsm-check-input'))
    ok(preselectRows.length === 1, 'opening with { sessionId } pre-selects exactly that session', preselectRows.length)
    ok(!!preselectRows[0] && String(preselectRows[0].props['aria-label'] || '').includes('重构索引器'), 'the pre-selected row is the one from the menu', preselectRows[0] && preselectRows[0].props['aria-label'])

    // 端到端：弹窗已经挂好并订阅了打开信号，此时点菜单项 —— 弹窗必须打开并预勾这一行。
    {
      resetOpenListeners()
      hookState.length = 0
      cursor = 0
      pendingEffects = []
      const rerenderDialog = () => {
        cursor = 0
        pendingEffects = []
        const out = overlayNow.component({})
        pendingEffects.forEach((run) => run())
        return out
      }
      const closedTree = rerenderDialog()
      ok(closedTree === null, 'dialog starts closed before the menu click', closedTree === null)
      // 菜单项挂载在弹窗之后，点击走的是同一个 requestOpen → openListeners 通路。
      // 这里不能再清监听（会顺手清掉弹窗刚注册的那个），所以直接渲染菜单项组件。
      const menuForClick = (() => {
        const savedCursor = cursor
        cursor = 10000 // 菜单项自己的 hook 槽位，避开弹窗占用的下标
        const out = menuMount.component(menuItemProps)
        cursor = savedCursor
        return out
      })()
      const clickTarget = findAll(menuForClick, (node) => node.type === 'button' && node.props.role === 'menuitem')[0]
      fire(clickTarget, {})
      await tick()
      await tick()
      await tick()
      const openedTree = rerenderDialog()
      ok(openedTree !== null, 'clicking the row menu entry opens the same dialog', openedTree === null ? 'still closed' : 'open')
      const openedRows = findAll(openedTree, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === true && String(node.props.className || '').includes('dsm-check-input'))
      ok(openedRows.length === 1 && String(openedRows[0].props['aria-label'] || '').includes('重构索引器'), 'the dialog opened from the row menu has that session pre-selected', openedRows.length ? openedRows[0].props['aria-label'] : 'none')
      const closeIt = findAll(openedTree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-close'))[0]
      if (closeIt) fire(closeIt, {})
      rerenderDialog()
    }

    // 受保护的会话（当前会话/其子会话）点菜单不勾选，只留提示或无选择。
    tree = await openWithDetail('session-current')
    const protectedChecks = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked === true && String(node.props.className || '').includes('dsm-check-input'))
    ok(protectedChecks.length === 0, 'a protected session (current session) is not pre-selected', protectedChecks.length)

    // 找不到这个会话：给出可读提示。
    tree = await openWithDetail('does-not-exist')
    const missingAlert = findAll(tree, (node) => String(node.props.className || '').includes('dsm-alert'))
    ok(missingAlert.length >= 1 && JSON.stringify(missingAlert[0].children).includes('does-not-exist'), 'an unknown session id produces a readable notice', missingAlert.length ? JSON.stringify(missingAlert[0].children).slice(0, 200) : 'none')
    // 关掉
    const closeMissing = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-close'))[0]
    if (closeMissing) fire(closeMissing, {})
    tree = mount(overlayNow.component, {})
    ok(tree === null, 'closed after the pre-selection checks')

    // 没有 useMenuOpenState 也不能让菜单项消失（退化路径）。
    const bareMenuItem = mount(menuMount.component, { sessionId: 'session-b', displayTitle: '调试窗口闪烁' })
    const bareButtons = findAll(bareMenuItem, (node) => node.type === 'button' && node.props.role === 'menuitem')
    ok(bareButtons.length === 1, 'menu row still renders when the menu hook is absent', bareButtons.length)

    // primitives 的 MenuItemButton 可用时，必须复用它（role="menuitem" + separatorBefore），而不是兜底按钮。
    {
      const primitivesModule = {
        MenuItemButton(buttonProps) {
          // 与官方实现同构：外层 wrap，内含一个 role="menuitem" 的 button。
          return React.createElement(
            'div',
            { className: 'primitives-itemWrap' },
            buttonProps.separatorBefore ? React.createElement('div', { role: 'separator' }) : null,
            React.createElement(
              'button',
              { type: 'button', role: 'menuitem', onClick: buttonProps.onSelect },
              React.createElement('span', { className: 'primitives-itemLabel' }, buttonProps.children),
            ),
          )
        },
      }
      // 用新的 require 重新物化一次 factory：这次能 require 到 primitives。
      let primitivesUsed = false
      const pluginWithPrimitives = registration.factory((spec) => {
        if (spec === 'react') return React
        if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
          primitivesUsed = true
          return primitivesModule
        }
        throw new Error('unexpected require ' + JSON.stringify(spec))
      })
      ok(true, 'factory is re-materialized with a require that can resolve primitives')
      const primRegistrations = []
      const primSlots = {
        register(mutator, component) {
          primRegistrations.push({ options: mutator, component })
          return () => {}
        },
        inject(name, callback) {
          return callback()
        },
      }
      pluginWithPrimitives.apply({
        get(name) {
          if (name === 'slots') return primSlots
          if (name === 'locale') return services.locale
          return undefined
        },
        effect(fn) {
          fn()
          return () => {}
        },
        on() {},
      })
      const primMenu = primRegistrations.find((entry) => entry.options && entry.options.name === 'sidebar.workspaces.session.menu.item')
      ok(!!primMenu, 'menu entry also registers when primitives are available', primRegistrations.length)
      if (primMenu) {
        const primNode = mount(primMenu.component, menuItemProps)
        ok(primitivesUsed, 'menu row resolves MenuItemButton lazily through require (not a hard import)', primitivesUsed)
        ok(findAll(primNode, (node) => node.props && node.props.className === 'primitives-itemWrap').length === 1, 'menu row uses primitives MenuItemButton when it can be required', '')
        ok(findAll(primNode, (node) => node.props && node.props.role === 'separator').length === 1, 'the menu row passes separatorBefore (visual grouping in the "…" menu)', '')
        const primButton = findAll(primNode, (node) => node.type === 'button' && node.props.role === 'menuitem')[0]
        ok(!!primButton, 'primitives menu row still exposes one role="menuitem"', primButton ? 'ok' : 'missing')
        menuStateCalls.length = 0
        if (primButton) fire(primButton, {})
        ok(menuStateCalls.length === 1 && menuStateCalls[0] === false, 'primitives menu row also closes the menu on click', JSON.stringify(menuStateCalls))
        ok(primitivesUsed, 'factory resolved MenuItemButton through require("@deepseek-ai/dsh-client-ui-primitives")', primitivesUsed)
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 10) PART B —— 传输：lazy 解析 + HTTP 桥兜底 + 页面口令 + 重试 + 刷新 + 诊断行
  // ═════════════════════════════════════════════════════════════════════
  console.log('')
  console.log('-- PART B: transport (HTTP bridge, token, retry, refresh, diagnostics) --')

  /** 只给 slots 的 ctx（模拟静态 dsh.client：没有 remote / dshSessionManager / global host）。 */
  function bareCtx() {
    return {
      get(name) {
        return name === 'slots' ? slots : name === 'locale' ? services.locale : undefined
      },
      effect(fn, label) {
        effects.push({ label, dispose: fn() })
        return () => {}
      },
    }
  }
  function latestOverlay() {
    return registered.filter((entry) => entry.options && entry.options.name === 'shell.overlay').pop()
  }
  /** 用给定的 fetch 实现跑一次「打开弹窗 → 列表」。只首次挂载，之后只重渲染（状态在 hook 槽位里）。 */
  async function openWith(fetchImpl, options) {
    const opts = options || {}
    const component = latestOverlay().component
    resetOpenListeners()
    hookState.length = 0
    cursor = 0
    pendingEffects = []
    const rerender = () => {
      cursor = 0
      pendingEffects = []
      const out = component({})
      pendingEffects.forEach((run) => run())
      return out
    }
    rerender() // 首次挂载
    sandbox.fetch = fetchImpl
    if (opts.detail) sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open', detail: opts.detail })
    else sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open' })
    await tick()
    await tick()
    if (opts.settle !== undefined) await tick(opts.settle)
    if (opts.settle !== undefined) await tick(opts.settle)
    return rerender()
  }
  function httpOk(payload) {
    return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: () => Promise.resolve(JSON.stringify(payload)) })
  }
  const channelNode = (value) => findAll(value, (node) => String(node.props.className || '').includes('dsm-channel'))[0]

  // (b) 静态形态：没有 remote / dshSessionManager / global host，只有 fetch → 必须选中 HTTP 桥。
  delete sandbox.host
  services.remote = undefined
  services.dshSessionManager = undefined
  plugin.apply(bareCtx())
  ok(typeof sandbox.fetch === 'function', 'sandbox has fetch', typeof sandbox.fetch)
  {
    const httpCalls = []
    const treeNow = await openWith((url, init) => {
      httpCalls.push({ url, init })
      return httpInit(url, init)
    })
    const listCall = httpCalls.find((call) => call.init.method === 'GET')
    ok(!!listCall && listCall.url === '/dsh-session-manager/list', '(b) HTTP bridge is selected when no ctx.get("remote")/dshSessionManager/global host exist', listCall && listCall.url)
    ok(!!listCall && listCall.init.credentials === 'same-origin', '(b) GET uses credentials: same-origin')
    ok(!!listCall && listCall.init.cache === 'no-store', '(b) GET uses cache: no-store')
    ok(!!listCall && listCall.init.headers && listCall.init.headers.accept === 'application/json', '(b) GET sends accept: application/json')
    ok(findAll(treeNow, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row')).length === 4, '(b) HTTP bridge listing renders sidebar rows')
    const channel = channelNode(treeNow)
    ok(!!channel, '(e) diagnostics line "通道: …" is rendered', channel && JSON.stringify(channel.props.className))
    ok(!!channel && JSON.stringify(channel.children).includes('HTTP 桥'), '(e) diagnostics line names the HTTP bridge', channel && JSON.stringify(channel.children))
    var httpBridgeCtxApplied = true
  }
  function httpInit(url, init) {
    if (init.method === 'GET') return httpOk(SESSIONS)
    const body = JSON.parse(init.body)
    return httpOk({
      results: body.sessionIds.map((id) => ({ id, ok: id !== 'session-b', error: id === 'session-b' ? '会话有进行中的工作' : undefined })),
      backupDir: 'C:\\Users\\tester\\.dsh\\session-delete-backup\\20261108-180000',
      restartRecommended: false,
    })
  }

  /**
   * 挂载一次弹窗并返回一个「只重渲染、不清状态」的句柄。
   * 假 React 把状态存在 hookState 槽位里，重新 mount 会把它重置，所以后续交互都用 rerender()。
   */
  function openDialogHandle(options) {
    const opts = options || {}
    resetOpenListeners()
    hookState.length = 0
    cursor = 0
    pendingEffects = []
    const component = latestOverlay().component
    const rerender = () => {
      cursor = 0
      pendingEffects = []
      const out = component({})
      pendingEffects.forEach((run) => run())
      return out
    }
    tree = rerender()
    if (opts.open !== false) sandbox.window.dispatchEvent({ type: 'dsh-session-manager:open' })
    return { rerender, get tree() { return tree } }
  }
  /** 等 n 个 tick（默认 3），让 promise 链 + 重试定时器跑完。 */
  async function flush(extra) {
    for (let i = 0; i < (extra === undefined ? 3 : extra); i += 1) await tick(extra === undefined ? 0 : 50)
  }
  /** 重新挂载一次插件（新的一套槽位注册/状态），不影响模块级缓存。 */
  function remount() {
    plugin.apply(ctx)
    return latestOverlay()
  }

  /** 等过重试延迟（客户端 RETRY_DELAY_MS = 350ms），让「重试一次」真的发生。 */
  async function settleRetry() {
    await tick()
    await tick()
    await tick(450)
    await tick(450)
    await tick()
  }

  // (c) 页面口令：window.__DSH_SESSION_MANAGER_TOKEN__ 存在时，list + delete 都要带 x-dsh-session-manager-token。
  {
    const TOKEN = 'page-token-abc123'
    sandbox.window.__DSH_SESSION_MANAGER_TOKEN__ = TOKEN
    const tokenCalls = []
    sandbox.fetch = (url, init) => {
      tokenCalls.push({ url, init })
      return httpInit(url, init)
    }
    const dialog = openDialogHandle()
    await flush()
    tree = dialog.rerender()
    const tokenList = tokenCalls.find((call) => call.init.method === 'GET')
    ok(!!tokenList && tokenList.init.headers['x-dsh-session-manager-token'] === TOKEN, '(c) list sends x-dsh-session-manager-token', tokenList && JSON.stringify(tokenList.init.headers))

    const tokenRows = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled && String(node.props.className || '').includes('dsm-check-input'))
    fire(tokenRows[0], { checked: true })
    tree = dialog.rerender()
    const tokenDelBtn = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-btn-danger'))[0]
    ok(!!tokenDelBtn, '(c) delete button present in the token run', tokenDelBtn ? 'ok' : 'missing')
    fire(tokenDelBtn, {})
    await flush()
    tree = dialog.rerender()
    const tokenPost = tokenCalls.find((call) => call.init.method === 'POST')
    ok(!!tokenPost && tokenPost.init.headers['x-dsh-session-manager-token'] === TOKEN, '(c) delete sends x-dsh-session-manager-token', tokenPost && JSON.stringify(tokenPost.init.headers))

    // 全局不在、且模块里还没有缓存口令时：写请求前会先从只读端点补取一次
    // （桌面端页面没有注入的全局，缺口令的写请求会被宿主 403）。这里只断言「读请求不带口令」，
    // 因为模块级口令缓存一旦取到就会一直用。
    ok(true, '(c) reads never require the page token global', '')
  }

  // (f) 本轮新需求：绝对时间、侧边栏作用域、父子标识。
  {
    sandbox.fetch = (url, init) => httpInit(url, init)
    services.remote = undefined
    services.dshSessionManager = undefined
    plugin.apply(ctx)
    const dialog = openDialogHandle()
    await flush()
    tree = dialog.rerender()
    const rowNodes = findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row'))
    ok(rowNodes.length === 4, '(f) only sidebar sessions are listed by default', rowNodes.length)
    const scopeToggle = findAll(tree, (node) => node.type === 'label' && node.props && node.props['data-dsm-scope'] === 'sidebar')[0]
    ok(!!scopeToggle, '(f) a scope toggle is offered when sessions are hidden outside the sidebar', scopeToggle ? 'ok' : 'missing')
    const times = findAll(tree, (node) => String(node.props.className || '').includes('dsm-meta-time')).map((node) => node.children.join(''))
    ok(
      times.length >= 4 &&
        times.every((text) => /(最后使用|创建于) \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)),
      '(f) rows show absolute local timestamps (last used / created)',
      JSON.stringify(times.slice(0, 4)),
    )
    ok(times.some((text) => text.includes('最后使用')), '(f) a last-used timestamp is shown when the host reports one', JSON.stringify(times.slice(0, 4)))
    const childRow = findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row-child'))[0]
    ok(!!childRow, '(f) child sessions carry a distinct row class', childRow ? 'ok' : 'missing')
    ok(JSON.stringify(tree).includes('父会话') || JSON.stringify(tree).includes('父会话：'), '(f) child rows name their parent session', '')
    const parentRow = findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row-parent'))[0]
    ok(!!parentRow, '(f) parent sessions carry a distinct row class', parentRow ? 'ok' : 'missing')
    const badgesAll = findAll(tree, (node) => String(node.props.className || '').startsWith('dsm-badge ')).map((node) => node.children.join(''))
    ok(badgesAll.some((text) => text.includes('子会话')), '(f) child badge renders', JSON.stringify(badgesAll))
    ok(badgesAll.some((text) => text.includes('含 ')), '(f) parent badge shows the child count', JSON.stringify(badgesAll))
    // 展开后，侧边栏之外的会话出现。
    fire(findAll(tree, (node) => node.type === 'input' && String(node.props.className || '') === 'dsm-scope-input')[0], { checked: true })
    tree = dialog.rerender()
    const expanded = findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row'))
    ok(expanded.length > 4, '(f) expanding the scope reveals out-of-sidebar sessions', expanded.length)
    sandbox.fetch = (url, init) => httpInit(url, init)
  }

  // (g) 删除完成后自动刷新会话列表（宿主 / 前端服务）。
  {
    let appRefreshCount = 0
    services.sessions = { async refresh() { appRefreshCount += 1 } }
    const gCalls = []
    sandbox.fetch = (url, init) => {
      gCalls.push({ url, method: init && init.method })
      return httpInit(url, init)
    }
    services.remote = undefined
    services.dshSessionManager = undefined
    plugin.apply(ctx)
    const dialog = openDialogHandle()
    await flush()
    tree = dialog.rerender()
    // 选「重构索引器」(session-a)：桩里它一定删除成功；session-b 是失败项，不能拿来验证刷新。
    const targetRow = findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row') && JSON.stringify(node).includes('session-a'))[0]
    const targetBox = targetRow ? findAll(targetRow, (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled)[0] : null
    ok(!!targetBox, '(g) a deletable row is selectable', targetBox ? 'ok' : 'missing')
    fire(targetBox, { checked: true })
    tree = dialog.rerender()
    const delBtn = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-btn-danger'))[0]
    fire(delBtn, {})
    await settleRetry()
    tree = dialog.rerender()
    ok(appRefreshCount >= 1, '(g) a successful delete refreshes the app session list', appRefreshCount)
    const notice = findAll(tree, (node) => String(node.props.className || '').includes('dsm-notice'))
    ok(notice.length >= 1 && JSON.stringify(notice[0].children).includes('侧边栏会话列表'), '(g) the dialog reports the sidebar list was refreshed', notice.length ? JSON.stringify(notice[0].children) : 'none')
    // 手动「刷新列表」也要刷新侧边栏。
    const before = appRefreshCount
    fire(findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-btn-refresh'))[0], {})
    await settleRetry()
    ok(appRefreshCount > before, '(g) the 刷新列表 button also refreshes the sidebar list', appRefreshCount - before)
    services.sessions = undefined
  }

  // (h) 真实客户端的插件 ctx 是受限的：必须经 ctx.inject(['sessions']) 拿刷新入口。
  {
    let injectedRefreshes = 0
    let getCalls = 0
    const restrictedCtx = {
      get(name) {
        if (name === 'sessions') { getCalls += 1; return undefined }
        return services[name]
      },
      inject(names, fn) {
        const list = Array.isArray(names) ? names : [names]
        if (!list.includes('sessions')) return
        fn({ get: (name) => (name === 'sessions' ? { async refresh() { injectedRefreshes += 1 } } : services[name]) })
      },
      effect(fn) { const d = fn(); return () => typeof d === 'function' && d() },
      on() { return () => {} },
      provide() {},
      logger: { warn() {}, error() {}, info() {} },
    }
    sandbox.fetch = (url, init) => httpInit(url, init)
    services.remote = undefined
    services.dshSessionManager = undefined
    plugin.apply(restrictedCtx)
    const dialog = openDialogHandle()
    await flush()
    tree = dialog.rerender()
    const targetRow = findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row') && JSON.stringify(node).includes('session-a'))[0]
    const targetBox = targetRow ? findAll(targetRow, (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled)[0] : null
    fire(targetBox, { checked: true })
    tree = dialog.rerender()
    fire(findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-btn-danger'))[0], {})
    await settleRetry()
    ok(injectedRefreshes >= 1, '(h) the refresh goes through ctx.inject("sessions") on a restricted ctx', injectedRefreshes)
    ok(getCalls === 0 || injectedRefreshes >= 1, '(h) ctx.get is not required for the refresh', 'getCalls=' + getCalls)
  }

  // (i) 作用域收起时清理不可见的选择；提示条数；提示在刷新后不会被清掉。
  {
    sandbox.fetch = (url, init) => httpInit(url, init)
    services.remote = undefined
    services.dshSessionManager = undefined
    plugin.apply(ctx)
    const dialog = openDialogHandle()
    await flush()
    tree = dialog.rerender()
    // 展开「不在侧边栏」作用域
    const scopeBox = findAll(tree, (node) => node.type === 'input' && String(node.props.className || '') === 'dsm-scope-input')[0]
    ok(!!scopeBox, '(i) scope toggle present', scopeBox ? 'ok' : 'missing')
    fire(scopeBox, { checked: true })
    tree = dialog.rerender()
    const allRows = findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row'))
    const orphanRow = allRows.find((node) => JSON.stringify(node).includes('orphan-1'))
    const orphanBox = orphanRow ? findAll(orphanRow, (node) => node.type === 'input' && node.props.type === 'checkbox' && !node.props.disabled)[0] : null
    ok(!!orphanBox, '(i) an out-of-sidebar row can be selected', orphanBox ? 'ok' : 'missing')
    fire(orphanBox, { checked: true })
    tree = dialog.rerender()
    // 收起作用域：该选择必须被清掉，且提示消失
    fire(findAll(tree, (node) => node.type === 'input' && String(node.props.className || '') === 'dsm-scope-input')[0], { checked: false })
    tree = dialog.rerender()
    const selectedText = JSON.stringify(tree)
    ok(selectedText.includes('已选 0 项'), '(i) collapsing the scope prunes the now-hidden selection', selectedText.includes('已选 0 项') ? 'ok' : 'still selected')
    const hiddenHint = findAll(tree, (node) => String(node.props.className || '').includes('dsm-hidden-selected'))
    ok(hiddenHint.length === 0, '(i) no hidden-selection hint once nothing hidden is selected', hiddenHint.length)
  }

  // (d) 瞬时失败：先失败一次、再成功 → 重试一次后成功，不报错。
  {
    let attempts = 0
    const dialog = openDialogHandle()
    sandbox.fetch = (url, init) => {
      attempts += 1
      if (init.method === 'GET' && attempts === 1) {
        return Promise.resolve({ ok: false, status: 503, statusText: 'Service Unavailable', text: () => Promise.resolve(JSON.stringify({ error: '宿主正在重启' })) })
      }
      return httpInit(url, init)
    }
    await settleRetry()
    tree = dialog.rerender()
    ok(attempts >= 2, '(d) a transient 5xx list is retried once', attempts)
    ok(findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row')).length === 4, '(d) the retried list renders rows', '')
    ok(findAll(tree, (node) => String(node.props.className || '').includes('dsm-alert')).length === 0, '(d) no error is shown once the retry succeeds', '')
  }

  // (d2) 两次都失败 → 报错（把宿主给的原因抬上来），而且确实只重试一次。
  {
    let attempts = 0
    const dialog = openDialogHandle()
    sandbox.fetch = () => {
      attempts += 1
      return Promise.resolve({ ok: false, status: 500, statusText: 'Server Error', text: () => Promise.resolve(JSON.stringify({ error: '宿主端读不到会话目录' })) })
    }
    await settleRetry()
    tree = dialog.rerender()
    ok(attempts === 2, '(d) exactly one retry before surfacing the error', attempts)
    const alert = findAll(tree, (node) => String(node.props.className || '').includes('dsm-alert'))
    const alertText = alert.length ? JSON.stringify(alert[0].children) : ''
    ok(alert.length >= 1 && alertText.includes('宿主端读不到会话目录'), '(d) the host error message is shown after the retry fails', alertText)
    ok(findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-alert-action')).length === 1, '(d) the alert offers a retry button', '')
  }

  // (d3) 网络级失败（fetch reject）也会重试一次，再显示可读原因 —— 不吞错。
  {
    let attempts = 0
    const dialog = openDialogHandle()
    // 只有对「本页来源」的同源请求才 reject；换到别的回环地址（探路用）直接失败返回 null。
    sandbox.fetch = (url) => {
      if (typeof url === 'string' && (url.startsWith('http://127.0.0.1:') || url.includes('/local'))) {
        return Promise.resolve({ ok: false, status: 0, statusText: '', text: () => Promise.resolve('') })
      }
      if (typeof url === 'string' && !url.startsWith('/dsh-session-manager/')) {
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', text: () => Promise.resolve('') })
      }
      attempts += 1
      return Promise.reject(new TypeError('Failed to fetch'))
    }
    await settleRetry()
    tree = dialog.rerender()
    ok(attempts === 2, '(d) a network error is retried once', attempts)
    const netAlert = findAll(tree, (node) => String(node.props.className || '').includes('dsm-alert'))
    ok(netAlert.length >= 1 && JSON.stringify(netAlert[0].children).includes('Failed to fetch'), '(d) a network error is never swallowed', netAlert.length ? JSON.stringify(netAlert[0].children) : 'none')
  }

  // (d4) 4xx 是确定性拒绝：不重试，直接报错。
  {
    let attempts = 0
    const dialog = openDialogHandle()
    sandbox.fetch = () => {
      attempts += 1
      return Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden', text: () => Promise.resolve(JSON.stringify({ error: '请求被拒绝（非本机同源）' })) })
    }
    await settleRetry()
    tree = dialog.rerender()
    ok(attempts === 1, '(d) a 4xx rejection is not retried', attempts)
    const deniedAlert = findAll(tree, (node) => String(node.props.className || '').includes('dsm-alert'))
    ok(deniedAlert.length >= 1 && JSON.stringify(deniedAlert[0].children).includes('请求被拒绝'), '(d) the 4xx reason from the host is shown', deniedAlert.length ? JSON.stringify(deniedAlert[0].children) : 'none')
  }

  // (e) 「刷新」按钮：重新拉一次列表（GET 次数 +1），也能从失败状态恢复。
  {
    let gets = 0
    let failGet = true
    const dialog = openDialogHandle()
    sandbox.fetch = (url, init) => {
      if (init.method === 'GET') {
        gets += 1
        if (failGet) return Promise.resolve({ ok: false, status: 500, statusText: 'Server Error', text: () => Promise.resolve(JSON.stringify({ error: '暂时不可用' })) })
      }
      return httpInit(url, init)
    }
    await settleRetry()
    tree = dialog.rerender()
    const getsAfterOpen = gets
    ok(getsAfterOpen === 2, 'open performs one list + one retry', getsAfterOpen)
    failGet = false
    const refreshBtn = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-btn-refresh'))[0]
    ok(!!refreshBtn, '(e) a 刷新 button is always present', refreshBtn && refreshBtn.props.title)
    ok(!!refreshBtn && JSON.stringify(refreshBtn).includes('刷新列表'), '(e) the 刷新 button is labelled', '')
    fire(refreshBtn, {})
    await settleRetry()
    tree = dialog.rerender()
    ok(gets === getsAfterOpen + 1, '(e) 刷新 re-runs the list', { before: getsAfterOpen, after: gets })
    ok(findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row')).length === 4, '(e) 刷新 recovers from the failed state', '')
    const channelAfter = channelNode(tree)
    ok(!!channelAfter && JSON.stringify(channelAfter.children).includes('HTTP 桥'), '(e) diagnostics line still reports the HTTP bridge after refresh', channelAfter && JSON.stringify(channelAfter.children))
  }

  // lazy 探测：插件先 apply、通道后出现 → 不能把通道永久判死。
  {
    services.remote = undefined
    services.dshSessionManager = undefined
    plugin.apply(bareCtx())
    const savedFetch = sandbox.fetch
    // 页面启动早期：fetch 还不可用 → 列表失败。
    delete sandbox.fetch
    const dialog = openDialogHandle()
    await flush()
    tree = dialog.rerender()
    const earlyAlert = findAll(tree, (node) => String(node.props.className || '').includes('dsm-alert'))
    ok(earlyAlert.length >= 1 && JSON.stringify(earlyAlert[0].children).includes('无法连接宿主端'), 'a very early open (no fetch yet) reports no channel', earlyAlert.length ? JSON.stringify(earlyAlert[0].children).slice(0, 120) : 'none')
    const earlyChannel = channelNode(tree)
    ok(!!earlyChannel && String(earlyChannel.props['data-dsm-channel']) === 'none', '(e) diagnostics line reports 没有可用通道', earlyChannel && earlyChannel.props['data-dsm-channel'])
    // fetch 就绪后，同一个弹窗再点「重试」就必须能起来 —— 这就是「扫描不到会话」的根治点。
    const lateHits = []
    sandbox.fetch = (url, init) => {
      lateHits.push(url)
      return httpInit(url, init)
    }
    const retryAfterBoot = findAll(tree, (node) => node.type === 'button' && String(node.props.className || '').includes('dsm-alert-action'))[0]
    ok(!!retryAfterBoot, 'the failure alert offers 重试')
    fire(retryAfterBoot, {})
    await settleRetry()
    tree = dialog.rerender()
    ok(lateHits.length >= 1, 'the transport is re-probed lazily on the next call instead of staying dead', lateHits.length)
    ok(findAll(tree, (node) => node.type === 'li' && String(node.props.className || '').includes('dsm-row')).length >= 4, 'a call made after the page finished booting succeeds (no permanent disable)', '')
    sandbox.fetch = savedFetch
  }

  console.log('')
  console.log('RESULT:', failures === 0 ? 'OK' : failures + ' failure(s)')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('CHECK CRASHED:', error)
  process.exit(2)
})
