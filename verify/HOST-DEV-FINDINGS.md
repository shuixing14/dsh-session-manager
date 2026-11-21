# HOST-DEV ANALYSIS (task-8) — findings that change the strategy

## 1. The Remote (Gateway SRC) channel is NOT reachable from this plugin

Hard evidence from the shipped runtime (`D:\DeepSeek Harness\resources\app.asar`, DSH 0.2.1-rc.5).

### 1a. `ctx.remote` does not exist; Remote is exposed through `typertRemote` (this part works)
`dsh-api-gateway/lib/index.js`:
- `collectSrcClaims()` / `resolveSrcDescriptor()` walk `ctx.reflect.props` for `definition.type === 'service'`,
  take `originalOf(receiver)`, read `typertRemote`, `readBinding(...)`, then
  `remoteMethods(original)` → `{version:1, methods:[{method, invocation:{kind:'direct'}}]}` from the prototype.
  `methodParameterNames()` requires plain identifier params on the prototype method.
- Access: `prepareInvocation` → `if (request.peer.principal.kind !== 'owner') { remoteAccess.decide(...) }`.
  `RemoteAccessService.decide`: `if (principal.kind === 'owner' || action === FOLLOW_ACTION) return ALLOW`.
  So **owner peers bypass resources entirely** — no `@Remote({resources})` needed.
- Discovery: `srcDescriptor.parameters` are resolved through `ctx.typert.lookups.definitions()` and the only
  built-in `ctx.typert.resources` kinds are ones other packages register; a method with no parameters
  (`list()`) reads `global` only if a resource kind is being resolved — for owner peers this never runs.
- The existing shape in `lib/index.js#installRemote` is therefore **correct and verifiable**, matches
  `verify/remote-facade.mjs` (9/9) and `verify/remote-identity-check.mjs`.

### 1b. But the plugin's `import('@deepseek-ai/cordis')` / `'@deepseek-ai/dsh-typert-protocol'` never resolves
`dsh-app-boot/lib/worker/profile-resolution-bootstrap.js` installs an **interception for every importer inside
the profiles tree** (`findInterceptionLayer`: `profilePaths` = `<home>/profiles/`), and for imports from a
*symlinked root* it routes them through the **installation** tree (`entries` built from the runtime
`node_modules`, i.e. inside `app.asar`) before Node's own lookup:

```
routeLinked(request, name, parent, ...):
  target = resolution.entries.get(name)                 // installation copy inside app.asar
  -> { kind: 'interception', entry: target }
```

`@deepseek-ai/cordis` and `@deepseek-ai/dsh-typert-protocol` are both in `resolution.entries`
(`apps/web/../dsh/node_modules/@deepseek-ai/...`, from `dsh/package.json`), so any bare `import()` of them
from `D:\dsh\dsh-session-manager` is **forced into the asar**. Node cannot load it (no asar
compatibility in plain Node), the dynamic import rejects, `installRemote` silently returns, and
`ctx.get('dshSessionManager')` stays undefined → **Gateway never sees the service**.

This also means `verify/remote-facade.mjs` scenario B only passes because it copies the plugin into
`verify/r2deps/node_modules/plugin-copy` (outside the profiles tree, and with a real node_modules next
door) — not because the installed plugin resolves the packages.

### 1c. The registration side is also unreachable
`dsh-typert-registry` explicitly requires `ctx.typert.register(...)` / `ctx.typert.remotes.register(...)`
from a plugin *inside the host process*, reachable by importing `@deepseek-ai/dsh-typert-protocol`.
A third-party plugin resolves its own dependencies when it does `import(mainEntry)` of a built bundle
inside the profile's node_modules, so it *can* import packages installed **locally** into the profile —
but not `dsh-typert-protocol` unless it is a dependency of the plugin (currently only an optional peer).

### 1d. Even with a local copy, the instance must be identical to the host's
`readBinding`/`originalOf`/`remoteMethods` compare by identity, but the marker is a plain property bag,
and `bindTypertRemote`/`Service` are only convenience wrappers. The pieces that genuinely need the
protocol package are `Object.freeze({version:1, methods:[...]})` (plain JS) and the `Symbol` used by
`originalOf` — `symbols.original` from `@deepseek-ai/cordis`, which must be **the same module instance** the
host uses. Cordis is a shared installation entry, so a *local* copy would not be identical. Verified:
`verify/remote-identity-check.mjs` runs with the extracted copy and succeeds because both the plugin copy
and the check import the same extracted modules.

## 2. Conclusion for the strategy

The Remote/Gateway channel cannot be made live from a third-party plugin bundle on this runtime without
either (a) the Desktop Host shipping the plugin inside the runtime tree, or (b) the Host exposing
`typertRemote` services to plugins through a Service (it does not). The **only** live channel the plugin
can own is HTTP from the page.

## 3. What the page-side HTTP *can* use (measured live, port 3931)
- The Desktop page is `dsh-app://app/...` (renderer with `--standard-schemes=dsh-app`); the main process
  `protocol.handle('dsh-app')` forwards non-document paths to the Host's HTTP server with the session
  cookie. So `fetch('/dsh-session-manager/...')` from the page is *proxied* to the Host — but the Host
  answers `401` before the plugin's route (measured: `GET /dsh-session-manager/list` → `404` after a
  cookie-less request, `GET /` → `401`). The `404` proves the Host is reachable.
- The Host's own `connection/admitConnection` gate needs the Host-issued cookie; the page has it.
- So the page CAN reach plugin HTTP endpoints **through the dsh-app protocol handler**, not through a
  page-origin HTTP port.

## 4. Decision needed from lead
Given (1), `POST /resolve` + `GET /status` + `GET /list` remain the only way to serve the user's
"使用读取 sessionid" requirement in the Desktop client; the Remote namespace stays installed (fail-soft,
harmless, and correct on hosts where the package resolves) but cannot be the live channel.

Proceeding with: refactor to `base` {list, resolve, del}, add `/status`, `/resolve`, CORS/OPTIONS,
keep every guard, re-run harnesses, reinstall, and verify the live port.
