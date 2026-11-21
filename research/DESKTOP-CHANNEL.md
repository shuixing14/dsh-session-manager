# Desktop renderer → Host channel for `dsh-session-manager`

Read-only research. Sources: `D:\DeepSeek Harness\resources\app.asar`
(`lib/main.js` 13,197 lines, `lib/preload-app.cjs`, `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`),
plus **live HTTP probes** against the running host on `127.0.0.1:3931`.
Line numbers below are 1-based lines of the dumped `lib/main.js` unless stated otherwise.

---

## 1. Renderer capabilities

The main window's `webPreferences` (main.js **6843–6848**, and the duplicate at 10158–10161 /
10554–10560 / 11556–11559 / 11962–11965):

```js
preload: this.preload,
sandbox: true,
contextIsolation: true,
nodeIntegration: false,
webSecurity: true
// plus nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
//      allowRunningInsecureContent: false on the main window
```

Consequences:

| question | answer |
|---|---|
| `require`/`process`/node built-ins in the page | **No** — `nodeIntegration: false`, `sandbox: true` |
| `contextIsolation` | **true** → preload and page share no JS objects; only `contextBridge` surfaces |
| `fetch` in the page | **Yes** — it is a normal Chromium page; `fetch` exists and `webSecurity: true` means normal CORS applies |
| page can read the host cookie / add it to requests | **No** — `HttpOnly`-style cookie is not script-visible, and a cross-origin request would not carry it |
| page origin | **`dsh-app://app`** |

Preload globals exposed via `contextBridge.exposeInMainWorld` (preload-app.cjs):

```
dshOnboarding, dshDesktopBoot, dshDesktop, dshPlatform,
__DSH_DIRECTORY_PICKER__, __DSH_HOST_PATHS__, __DSH_LOCALE__
```

`dshDesktopBoot` (preload-app.cjs **863–866**) is the only interesting one:

```js
electron.contextBridge.exposeInMainWorld("dshDesktopBoot", {
  ready: () => electron.ipcRenderer.invoke(DESKTOP_IPC.boot),
  failed: (message) => electron.ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message)
});
```

and its main-side handler (main.js **12424–12432**) returns `{ injections, streamBaseUrl }`
where `streamBaseUrl` is `new URL(hostUrl).origin` — i.e. **`http://127.0.0.1:3931`**.
The page therefore *knows* the host origin, but that is only a base URL; it is not a proxy and
carries no credential.

There is **no** generic `ipcRenderer.invoke` passthrough exposed to the page. The bridges are closed:
every `ipcMain.handle` asserts its sender frame (`assertDesktopSender`, `assertProductSender`,
`assertMainApplication` — main.js **12472**: sender frame URL must start with `dsh-app://app/`), and
none of them forwards arbitrary fetch/RPC calls.

### Is there a CORS bypass installed for the renderer?

**No.** `session.defaultSession` is touched in exactly two ways:

- main.js **12447–12469** — `webRequest.onBeforeSendHeaders` for `ws://127.0.0.1/*` / `wss://127.0.0.1/*` only.
  It injects `origin: target.origin`, `cookie: hostCookie`, `sec-fetch-site: same-origin` — **for WebSocket
  upgrades only**, and only when `details.webContentsId === mainWindow?.webContents.id`.
- main.js **12417** — `installMicrophonePermissions(...)`; permission handlers at 6814 / 7067 / 10108 / 10624
  deny by default.

There is **no** `onHeadersReceived` CORS rewrite anywhere (grep for `onHeadersReceived` and
`Access-Control-Allow-` in main.js returns nothing for the renderer). So a plain page `fetch` to
`http://127.0.0.1:3931/...` is an ordinary cross-origin request from a `dsh-app://` origin and must satisfy
real CORS.

---

## 2. Protocol handler — and the same-origin proxy that already exists

The custom scheme is registered privileged (main.js **11880–11890**):

```js
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,                       // "dsh-app"  (main.js:7009)
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,              // <- the page may fetch() dsh-app:// URLs
    corsEnabled: true,
    stream: true,
    codeCache: true
  }
}]);
```

Because `standard: true` + `secure: true`, `dsh-app://app` is treated as a **secure, standard origin**:
service-worker/`fetch` work, and PNA ("private network access") treats it as secure. This matters for
candidate (a) below: a `dsh-app://` → `http://127.0.0.1` request is *not* blocked as mixed content.

The handler itself (main.js **12406–12415**):

```js
protocol.handle(SCHEME, (request) => {
  const url = new URL(request.url);
  if (url.hostname === "shell") return serveWebDocument(request, join(app.getAppPath(), "renderer"));
  if (url.hostname === "app") {
    if (url.pathname === "/" || url.pathname === "/index.html"
        || url.pathname.startsWith("/assets/")
        || ["/favicon.svg", "/manifest.webmanifest"].includes(url.pathname))
      return serveWebDocument(request, join(resources.dsh, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist"));
    if (backend.host === void 0 || hostUrl === void 0 || hostCookie === void 0)
      return Promise.resolve(new Response(null, { status: 503 }));
    return forwardWebRequest(request, hostUrl, hostCookie);   // <-- EVERYTHING ELSE IS PROXIED
  }
  return Promise.resolve(new Response(null, { status: 404 }));
});
```

**This is the key discovery: any `dsh-app://app/<path>` that is not one of the five static
paths is reverse-proxied to the Host with the Host's own auth cookie attached.**

`forwardWebRequest` (main.js **8268–8299**):

```js
async function forwardWebRequest(request, host, cookie) {
  const source = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "dsh-app://app") return new Response(null, { status: 403 });
  const target = new URL(host);
  target.pathname = source.pathname;
  target.search = source.search;
  const headers = new Headers(request.headers);
  for (const name of ["host", "origin", "cookie", "sec-fetch-site"]) headers.delete(name);
  headers.set("cookie", cookie);
  const init = { method: request.method, headers, body: request.body, signal: request.signal,
                 duplex: "half", redirect: "manual" };
  const response = await fetch(target, init);
  const outgoing = new Headers(response.headers);
  for (const name of WITHHELD_RESPONSE_HEADERS) outgoing.delete(name);   // set-cookie, content-encoding,
  if (PLUGIN_BUNDLE_PATH.test(source.pathname)) outgoing.set("cache-control", "no-store");  // content-length, ...
  return new Response(response.body, { status: response.status, headers: outgoing });
}
```

Note precisely what is **deleted** before forwarding: `host`, `origin`, `cookie`, `sec-fetch-site`.
Body, method, other headers (including any custom `x-*` header you set) and streaming pass through.
`WITHHELD_RESPONSE_HEADERS` (main.js **8243–8254**) = `set-cookie, content-encoding, content-length,
transfer-encoding, connection, keep-alive, te, trailer, upgrade, proxy-authenticate, proxy-authorization`.

`PLUGIN_BUNDLE_PATH` (main.js **8257**) = `/^\/plugins\//u`.

---

## 3. What a plugin can actually call — measured

The plugin's own fence (`lib/index.js` **712–745**) is the thing that decides:

```js
function requestRejection(req, { write, token }) {
  const pageToken = String(headerOf(req, 'x-dsh-session-manager-token') || '')
  const pagePresented = typeof token === 'string' && token.length > 0 && pageToken === token
  ...
  const site = String(headerOf(req, 'sec-fetch-site') || '').toLowerCase()
  if (site === 'cross-site') return 403
  if (write && !pagePresented) {
    if (site !== 'same-origin' && site !== 'same-site') return 403   // <-- the decisive line
  }
  ...
}
```

Live probes against `http://127.0.0.1:3931` (token read from the token file only to *send* it; nothing written):

| request | result |
|---|---|
| `GET /dsh-session-manager/status` — no auth | **200** (reads are loopback-only, no token needed) |
| `POST /resolve {}` — no headers | **403** `{"error":"请求被拒绝（非本机同源）"}` |
| `POST /resolve` + `Origin: dsh-app://app` + `sec-fetch-site: same-origin` | **403** (origin ≠ host authority) |
| `POST /resolve` + `sec-fetch-site: same-origin` (origin absent) | **200** ✅ |
| `POST /resolve` + `x-dsh-session-manager-token: <token>` | **200** ✅ |
| `POST /resolve` with **origin and sec-fetch-site both deleted**, no token — *exactly what `forwardWebRequest` sends* | **403** ❌ |

**Conclusion: the `dsh-app://app` proxy correctly carries the Host's *DSH* credential, but it
strips `sec-fetch-site`, and it cannot add the plugin's own token header. So every plugin **write**
endpoint is unreachable through the proxy unless the client half supplies the token itself** —
which it can, because the token is already injected into the page as
`window.__DSH_SESSION_MANAGER_TOKEN__` by `injectPageToken` (lib/index.js **800–817**).

Read endpoints (`GET /status`, `GET /list`) work through the proxy with no extra work, since reads need
only a loopback Host.

---

## 4. Recommended shape (ranked)

### (1) ✅ RECOMMENDED — same-origin `dsh-app://app/...` fetch + the injected token header

The page fetches its **own origin**, so there is no CORS, no PNA, no mixed content, and no cookie handling.
The Host cookie is added by the Electron main process; the plugin token is added by the page from the
already-injected global. This is the only candidate that satisfies both fences without weakening either.

```js
// client half (browser) — runs on the dsh-app://app page
const BASE = new URL('./dsh-session-manager/', location.href)   // stays on dsh-app://app
const TOKEN = () => (typeof window.__DSH_SESSION_MANAGER_TOKEN__ === 'string'
  ? window.__DSH_SESSION_MANAGER_TOKEN__ : '')

async function api(pathname, body) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    headers['x-dsh-session-manager-token'] = TOKEN()   // <-- required by the write gate
  }
  const res = await fetch(new URL(pathname, BASE), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
  return res.json()
}

const list    = await api('list')
const target  = await api('resolve', { sessionIds: ['…'] })
const deleted = await api('delete',  { sessionIds: ['…'], backup: true, allowActive: false })
```

Why the token is mandatory rather than optional here: the proxy deletes `sec-fetch-site`, so the
`write && !pagePresented` branch will always reject. With the token present, `pagePresented` is true and
the `sec-fetch-site` requirement is skipped entirely (lib/index.js:736).

Two things must hold for this to work — **both already do**, but verify before shipping:
- the plugin's routes are registered on the same Host the proxy forwards to (they are: it is `ctx.webServer`);
- `<pathname>` does not collide with the five static prefixes (`/`, `/index.html`, `/assets/*`,
  `/favicon.svg`, `/manifest.webmanifest`) — `/dsh-session-manager/*` does not.

**Caveat — token delivery on the Desktop shell (VERIFIED GAP, see §6).** `injectPageToken` uses
`webServer.tapIndex` *and* `ctx.on('webserver/index-inject')`. On the **Web** form, `GET /` currently
does **not** contain `__DSH_SESSION_MANAGER_TOKEN__` (grep of the live index is empty) even though the tap is
installed — so the tap path is already not landing. On Desktop the page is rendered from disk and only the
`webserver/index-inject` table is applied. `boot.js`/`client.js` both read the token defensively:

```js
const token = pageToken()                       // window.__DSH_SESSION_MANAGER_TOKEN__ or ''
if (token !== '') headers[TOKEN_HEADER] = token // silently omitted when empty
```

so a missing injection row degrades to **silent 403 on every write**, not a visible error. Fix: add a
read-only `GET /dsh-session-manager/token` guarded by the loopback fence (reads need no token), or have
`boot.js` call it when the global is absent. This is safe — the value is already meant to be in the page.

### (2) ⚠️ WORKS BUT WORSE — direct `fetch('http://127.0.0.1:3931/...')` with the token

Technically viable: `dsh-app://app` is a `secure`/`standard` origin (main.js 11880–11890), so PNA does not
block loopback, and the plugin already mirrors `Origin` in `Access-Control-Allow-Origin` plus a
`Vary: Origin` and an `OPTIONS` 204 (lib/index.js 819–866). It needs the token for **every** call
(reads included, because `Origin: dsh-app://app` fails the origin-equals-authority check at line 731).

Cost: you now depend on CORS behaviour, on the preflight surviving, and on the page knowing the port
(discoverable via `dshDesktopBoot.ready().streamBaseUrl`). More moving parts, same privilege.
Only choose this if probe (1) fails because the token is not injected.

### (3) ❌ NOT AVAILABLE — an existing IPC bridge

The preload surface is a closed list (see §1). No bridge performs arbitrary HTTP or invokes host RPCs on
the page's behalf, and every handler asserts `event.senderFrame.url.startsWith('dsh-app://app/')`. There is
nothing to reuse, and adding one would require modifying `lib/main.js` / the preload inside the
installed app — out of scope for a plugin and outside this task's write scope.

### (4) ✅ WORKS, and it is what the plugin already does — own `client.js` + this HTTP API

The plugin **does** ship a client half: `client.js` (83,818 bytes) with `package.json`
`dsh.client = { "platform": "web", "inject": [], "external": [] }`, and the package is symlinked into
`~/.dsh/profiles/desktop/node_modules/dsh-session-manager`.

But it is **not** served by `dsh-client-modules`: `GET /plugins/dsh-session-manager/client.js` → **404**,
while the plugin's own route `GET /dsh-session-manager/client.js` → **200**. So the bundle reaches the page
through the plugin's own `exact` route (plus `/boot.js` and the index-injection row), not through
`/plugins/*`.

That means (4) is not an alternative to (1)/(2) — it is the *first half* of both. The client bundle still
needs a transport to the host half, and that transport is exactly (1). A host **event** alone cannot express
`list → select → delete` because it is one-directional and returns no result.

---

## 5. Risks

1. **`sec-fetch-site` stripping is load-bearing.** If a future DSH stops deleting it, nothing breaks.
   But if a future DSH starts *adding* `sec-fetch-site: cross-site`, the plugin's write gate would still
   reject — and (1) would break. The token path is the stable one; keep sending it on every write.
2. **The proxy forwards to whatever Host it is bound to.** If the Desktop Host is remote (`backend.host`
   set), the same `dsh-app://app/dsh-session-manager/*` path is forwarded to that Host — where the plugin
   may not be installed and the token will certainly differ. Gate the client half on
   `GET status` succeeding rather than assuming.
3. **`forwardWebRequest` streams the body with `duplex: "half"`.** Large JSON bodies are fine, but
   a client that sets `Content-Length` and then streams lazily can stall. Send fully-buffered JSON.
4. **Response headers are filtered** — `content-length` and `content-encoding` are dropped
   (main.js 8243–8254), so do not rely on `Content-Length` in the client; read `res.json()`.
5. **Origin spoofing is not the protection here.** `Origin: dsh-app://app` is requested-from-the-page and
   trivially forgeable by any local process; that is exactly why the token exists. The token is a
   32+ char base64url secret in `<home>/.dsh-session-manager.token` and is the real credential — treat the
   `injectPageToken` global as equivalent to that secret (it grants delete powers to any script on the page,
   including other plugins' client halves).
6. **`/dsh-session-manager/client.js` and `/boot.js` are served by plain `exact` routes**, so they are
   *static* prefixes only for `/assets/` — they are proxied correctly. But note the proxy's
   `PLUGIN_BUNDLE_PATH` special-case (`/plugins/`) does **not** apply to them, so they are cached by the
   browser normally. Serve them with `cache-control: no-store` (the plugin already sets no-store).
7. **This document does not change the security model.** Recommendation (1) keeps both the loopback fence
   and the token; it removes CORS from the path rather than bypassing any check.

---

## 6. Verified status of the client half as it stands today

Measured against the live host on `127.0.0.1:3931`:

| fact | evidence |
|---|---|
| `client.js` / `boot.js` exist and are served | `GET /dsh-session-manager/client.js` → **200**; `GET /dsh-session-manager/boot.js` → **200** |
| they are **not** served via client-modules | `GET /plugins/dsh-session-manager/client.js` → **404** |
| request routes are **relative** (same-origin) | boot.js **367–369**: `list: '/dsh-session-manager/list'`, `delete: '/dsh-session-manager/delete'`; used by `httpRequest` (boot.js **677–700**) |
| token is read from a page global, silently omitted if absent | boot.js **372–373, 427–428, 661–662, 680–681** |
| the Web index does **not** currently carry the token row | `GET /` grep for `__DSH_SESSION_MANAGER_TOKEN__` → no match |
| writes without the token are rejected | `POST /resolve` → 403 `非本机同源` |

**Bottom line:** the transport half is already correct (same-origin relative fetch, which is exactly
recommendation (1)) — on Desktop it will flow through `dsh-app://app/...` → Electron protocol handler →
`forwardWebRequest` → Host, with the Host cookie added by the main process. The **only** functional gap is
that the plugin token is not reliably present in the page, which makes every write 403. Everything else in
this document is about why the *other* three candidates are worse or unavailable.
