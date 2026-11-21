// Shared helper for the Round-2 harnesses: boot the plugin on a stub Cordis ctx with
// a captured webServer, and expose its two capabilities through the REAL production
// channel (the HTTP routes) instead of the removed ctx.provide seam.
//
//   const api = await bootPlugin({ ctx })
//   await api.call('sessions.list')            -> listing object
//   await api.call('deleteSessions', request)  -> { results, backupDir, restartRecommended }
//
// Requests are built as same-origin loopback requests so the trust fence passes;
// that is exactly what the browser half sends.
export const LIST_PATH = '/dsh-session-manager/list'
export const DELETE_PATH = '/dsh-session-manager/delete'

export function makeReq({ method = 'GET', headers = {}, body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

export function makeRes() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      res.statusCode = code
      res.headers = headers
      return res
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk)
    },
  }
  return res
}

const OK_HEADERS = { host: '127.0.0.1:5471', origin: 'http://127.0.0.1:5471', 'sec-fetch-site': 'same-origin' }

/**
 * @param {object} options
 * @param {object} options.ctx  the already-built stub ctx (must expose get()/effect()/provide())
 * @param {object} options.plugin the imported plugin module (default export or named apply)
 * @returns {{ list, delete, routes, call }}
 */
export function bootPlugin({ ctx, plugin }) {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  // Make `ctx.get('webServer')` answer even for Proxies that forward to a services map.
  const services = ctx._services ?? null
  if (services) services.webServer = webServer
  else if (typeof ctx.get === 'function') {
    const original = ctx.get.bind(ctx)
    ctx.get = (name) => (name === 'webServer' ? webServer : original(name))
  }

  const mod = plugin.default ?? plugin
  mod.apply(ctx)

  const routeOf = (p) => {
    const r = routes.find((x) => x.path === p)
    if (!r) throw new Error(`route ${p} was not registered (got: ${routes.map((x) => x.path).join(', ')})`)
    return r
  }

  const callRaw = async (path, req) => {
    const res = makeRes()
    await routeOf(path).handler(req, res)
    if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`)
    return JSON.parse(res.body)
  }

  return {
    routes,
    async list() {
      return callRaw(LIST_PATH, makeReq({ method: 'GET', headers: { ...OK_HEADERS } }))
    },
    async delete(request) {
      return callRaw(
        DELETE_PATH,
        makeReq({
          method: 'POST',
          headers: { ...OK_HEADERS, 'content-type': 'application/json' },
          body: JSON.stringify(request ?? {}),
        }),
      )
    },
    async call(method, args) {
      if (method === 'sessions.list') return this.list()
      if (method === 'deleteSessions') return this.delete(args)
      throw new Error('unknown method: ' + String(method))
    },
  }
}
