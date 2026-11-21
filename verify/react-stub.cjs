// Minimal fake React for mounting function components as plain trees.
// Every mount() gets its own hook storage (like a React instance), so state never
// leaks between tests. setState schedules a synchronous rerender once the render finishes.
function makeHookStore() {
  return { slots: [], cursor: 0 }
}

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}

// The currently-rendering hook store + rerender hook (set by mount()).
let active = null

function slotAt(n) {
  const store = active.store
  if (store.slots[n] === undefined) store.slots[n] = {}
  return store.slots[n]
}

const React = {
  createElement(type, props, ...children) {
    let kids = children
    if (kids.length === 0 && props && props.children !== undefined) kids = Array.isArray(props.children) ? props.children : [props.children]
    return { type, props: props || {}, children: kids }
  },
  useState(initial) {
    const slot = slotAt(active.store.cursor++)
    if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial
    const context = active
    const set = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      // Bind to the mount that created this state, even if it settles after render.
      context.scheduleRerender()
    }
    return [slot.value, set]
  },
  useEffect(fn, deps) {
    const slot = slotAt(active.store.cursor++)
    const first = slot.ran !== true
    if (!first && sameDeps(slot.deps, deps)) return
    if (typeof slot.cleanup === 'function') {
      const c = slot.cleanup
      slot.cleanup = undefined
      c()
    }
    slot.ran = true
    slot.deps = deps
    const result = fn()
    slot.cleanup = typeof result === 'function' ? result : undefined
  },
  useMemo(fn, deps) {
    const slot = slotAt(active.store.cursor++)
    if (slot.ran !== true || !sameDeps(slot.deps, deps)) {
      slot.ran = true
      slot.deps = deps
      slot.value = fn()
    }
    return slot.value
  },
  useCallback(fn, deps) {
    const slot = slotAt(active.store.cursor++)
    if (slot.ran !== true || !sameDeps(slot.deps, deps)) {
      slot.ran = true
      slot.deps = deps
      slot.value = fn
    }
    return slot.value
  },
  useRef(initial) {
    const slot = slotAt(active.store.cursor++)
    if (!('value' in slot)) slot.value = { current: initial }
    return slot.value
  },
}

function mount(component, props) {
  const store = makeHookStore()
  let tree = null
  let rendering = false

  const render = () => {
    rendering = true
    store.cursor = 0
    const previous = active
    active = context
    try {
      tree = component(props || {})
    } finally {
      active = previous
      store.cursor = 0
      rendering = false
    }
  }

  const context = {
    store,
    scheduleRerender() {
      // Nested/queued setState during render is deferred to the next render tick.
      if (!rendering) render()
    },
  }
  active = context
  render()
  active = null

  return {
    tree: () => tree,
    rerender: () => {
      render()
      return tree
    },
    unmount() {
      for (const slot of store.slots) {
        if (typeof slot.cleanup === 'function') {
          const c = slot.cleanup
          slot.cleanup = undefined
          c()
        }
      }
    },
    hookCount: () => store.slots.length,
  }
}

module.exports = { React, mount }
