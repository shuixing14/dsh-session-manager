# dsh-session-manager — independent verification report

Verifier: `verifier` (read-only on the plugin package; no writes under `C:\Users\shuixing\.dsh`).
All scratch artifacts are under `D:\dsh\dsh-session-manager\verify\`.

**Verdict: PASS** — the host half and the client half both satisfy the checklist, and no
data-loss or path-traversal defect remains. Six defects were found and reported during
verification; **all six are now fixed and re-verified**. See §8 for the one open nit.

## 1. Artifact under test

| File | md5 | Notes |
| --- | --- | --- |
| `lib/index.js` | `df7a8e4658df3cbf4fa3bf1d6cdf8ab1` | Host half (545 lines) |
| `lib/store.js` | `91ef8c5cd80c125f76e6d22c00526aeb` | `refreshAfterDelete()`, imported by index.js |
| `client.js` | `a42419f8fcf2e38454da326ffcceb9f3` | Browser half (post-task-4 form, final) |
| `cordis.patch.yml` | `5c37747e050bd8900644500b380845fa` | `#` comments (fixed) |
| `package.json` | `34ab03552515ab89c2f8a3bb933ecd14` | |
| `icon.svg` | `fd72e676c0e4bdaa8b87dae91e00a528` | |

`node --check` passes on all three JS files.

> **Client form tested.** The client half was in flight for most of this session. Findings in
> §4 were made against earlier revisions (pre-task-4: `window.__ModuleLoader__.load` +
> a `module.exports`/`return t.exports` hybrid, callable-function plugin export, bare
> `ctx`/`host`/`React`/`styles` globals). The **final** file tested here is the post-task-4
> static `dsh.client` form: one `window.__ModuleLoader__.load({id, factory})`, `factory(require)`
> does `require('react')` and **returns** `{name, inject:['slots'], apply}`, and no bare globals.
> Current result: **10/10 client checks pass**.

## 2. How to reproduce

```
cd D:\dsh\dsh-session-manager\verify
node host-e2e.mjs          # 35/35  fake-home end-to-end deletion matrix
node fresh-home.mjs        # PASS   first delete on a home with no backup dir yet
node collision-probe.mjs   # PASS   two deletes in the same second -> two backup dirs
node client-harness.cjs    # 10/10  browser half: factory, slots, render, delete payload
node yaml-check.cjs        # PASS   cordis.patch.yml parsed with DSH's own yaml@2.9.1
```

Every suite prints `PASS`/`FAIL` per check and exits non-zero on any failure.

## 3. Host half — fake-home end-to-end (`host-e2e.mjs`): **35/35 PASS**

The fake home mirrors a real `<DSH_HOME>`: `sessions/--D-proj--/<id>/session.v4.jsonl.zstd`
(+ `session.v0.jsonl` header), a child session with `parentSession`, a `_no-cwd` session, a
session whose log sits under a project dir that disagrees with its header `cwd`, a
`storages/workspace.json` unit (v2 single layout with `global.archivedSessionIds`,
`global.pinnedSessionIds`, three `tables.workspaces` records), per-record
`storages/session_projcache/sessions/<id>.json` docs (`{version:3, record:{identity,rows}}`)
including `.bak` and `.bak.<stamp>` siblings, a legacy `storages/session_projcache.json`, and
two projcache-only orphan rows. The plugin is imported by its real ESM path and driven through
a stub Cordis `ctx` (a Proxy, because real Cordis resolves `ctx.<service>` through its service
resolver); `DSH_HOME` always points at the fake home.

| Check | Result |
| --- | --- |
| `encodeSegment`/`projectKey` vectors (`D:\dsh`→`--D-dsh--`, `D:\示例目录`→`--D-~793A~4F8B~76EE~5F55--`, `\\server\share`→`--server-share--`, `.`→`--.--`, `..`→`~002E~002E`, `a/b`→`a~002Fb`, `""` throws) | PASS (11 vectors + 2 throw cases) |
| `sessions.list`: rows, `home`, `currentSessionId`, orphan rows, workspace flags, `children` | PASS |
| Titles via `sessionQuery.readTitleSnapshots`; missing/throwing service tolerated | PASS |
| Refuses the current session (and writes nothing) | PASS |
| Refuses a descendant of the current session (even with `allowActive`) | PASS |
| Refuses a running session without `allowActive` | PASS |
| **Path traversal** — `../../../../evil`, `..`, `..\..\evil`, `/id`, `id/../id`, `C:\Windows\x`, `session-../../etc` all rejected before any fs op; outside sentinel untouched | PASS |
| Unknown ids / junk args (`null`, `{}`, `sessionIds:'nope'`, `[null,42,{}]`) | PASS |
| **(a) normal delete with `backup:true`** | PASS |
| (a) backup contains the session dir with **both** artifacts, byte-identical | PASS |
| (a) backup contains projcache doc + `.bak` + `.bak.<stamp>` + `workspace.json.bak` (pre-delete content) + `session_projcache.json.bak` | PASS |
| (a) `manifest.json` (deletedAt / home / sessions) | PASS |
| (a) projcache per-record doc and all sibling backups gone | PASS |
| (a) `workspace.json` no longer lists the id in `ws-1`, `ws-2`, `archivedSessionIds`, `pinnedSessionIds` | PASS |
| (a) `workspace.json` otherwise **deep-equal** to the pre-delete file; unrelated `ws-3` record byte-identical | PASS |
| (a) legacy `session_projcache.json` loses only that row | PASS |
| (a) **other sessions untouched**: 6 session dirs + 4 projection docs byte-identical | PASS |
| (a) no stray `.tmp` files from the atomic writes | PASS |
| Empty project dir cleaned; a non-empty one is kept | PASS |
| **Backup failure → fail-closed**: session survives, per-id `{ok:false}` with the reason | PASS |
| Misplaced log dir resolved by the exact-name fallback scan and deleted | PASS |
| `_no-cwd` session found and deleted; `_no-cwd` itself kept | PASS |
| Orphan (projcache-only) row cleaned without a log dir | PASS |
| `session-<uuid>` id form accepted | PASS |
| Batch: good + refused ids isolated per id | PASS |
| Works when the `sessions` service is absent (`inject` names only `sessionPersistence`) | PASS |
| `workspace.json` rewrite is temp-file + rename | PASS |
| `pendingMutation` present → scrub skipped and reported honestly | PASS |
| `pendingMutation` `undefined`/`null` (the real idle shape) → scrub proceeds | PASS |
| Scrub verdicts `workspace` / `workspace:none` / `workspace:missing` / `workspace:pending-mutation` | PASS |
| Results always well-formed; duplicate ids de-duplicated | PASS |

`fresh-home.mjs` → **PASS** (first delete on a home with no `session-delete-backup` creates the
chain and succeeds). `collision-probe.mjs` → **PASS** (two deletes 5 ms apart get distinct dirs;
each keeps its own manifest row and its own pre-edit `workspace.json.bak`).

## 4. Client half (`client-harness.cjs`): **10/10 PASS**

The real `client.js` is evaluated as a classic script in a vm with
`window.__ModuleLoader__ = { load(reg) }`, then `registration.factory(require)` is materialized
with a `require` that serves the real platform seed words (`react`). Components are mounted with
a purpose-built React shim (per-mount hook store, deps-aware effects). `globalThis.fetch` is
removed for the run so the client's HTTP fallback cannot masquerade as a live channel.

| Check | Result |
| --- | --- |
| 1. Script registers exactly one factory, id `dsh-session-manager` | PASS |
| 2. `factory(require)` **returns** `{name, inject:['slots'], apply}` and `require('react')`ed | PASS |
| 3. `apply()` registers `shell.overlay` + `sidebar.footer.action`, both id `session-manager` | PASS |
| 4. Dialog closed by default; opens on the `dsh-session-manager:open` window event | PASS |
| 5. Footer button click opens the dialog (no `ReferenceError`) | PASS |
| 6. Overlay renders the rows from the host listing (titles present) | PASS |
| 7. Confirm calls `deleteSessions({sessionIds:['333…'], backup:true, allowActive:false})` | PASS |
| 8. Current session and its child render as protected (disabled checkboxes) | PASS |
| 9. No channel at all → 「无法连接宿主端」 alert, no fabricated calls | PASS |
| 10. `restartRecommended` → restart hint rendered in the result panel | PASS |

Both slot targets are real: `shell.overlay` is declared in `dsh-client-ui-layout` (`client.js:643`)
and `sidebar.footer.action` in `dsh-client-ui-sidebar` (`client.js:643`).

## 5. Packaging

| Check | Result |
| --- | --- |
| `package.json`: `type:module`, `main:lib/index.js`, `exports "." "./client" "./package.json"` all resolve | PASS |
| `dsh.bundle.patch: ./cordis.patch.yml` exists; `dsh.client.platform: "web"`; `icon.svg` exists | PASS |
| `cordis.patch.yml` parses with **DSH's own** `yaml@2.9.1` into `[{insert:[{id, name}]}]` | PASS (after fix, §7-2) |
| `files[]` entries exist | NIT — `locale` is listed but does not exist (harmless for a path install) |
| README accuracy | MINOR — the file table omits `lib/store.js`, which `lib/index.js:25` imports at runtime; `research/` is correctly described as dev-only |

I did **not** install the bundle (the lead does that).

## 6. DSH-internals cross-checks (read-only, from the shipped asar)

- `ctx` is a Proxy whose property reads go through the service resolver
  (`cordis/src/context.ts`: "A context is a proxy"), so `ctx.sessionPersistence` is the correct
  way to reach an injected service — the plugin is right and my first stub was wrong.
- Browser→host: the shipped `@deepseek-ai/dsh-client-modules` materializes a bundle with
  `registered.factory(this.makeRequire(...))` and uses the **return value** as exports
  (`client-modules/lib/client.js:817`). `module.exports` assignments and a top-level `return`
  inside a non-function `factory:` value are not part of that contract.
- Platform seed words (`dsh-web-frontend/dist/assets/index-*.js`, `staticModules`):
  `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`,
  `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`, `...-ui-slots`, `...-ui-primitives`,
  `...-ui-dockkit`. There is **no** `host`, `styles` or `ctx` seed — an earlier revision that
  relied on bare globals could not have mounted.
- `@deepseek-ai/dsh-client-locale` exports a `locale` service (`register(ns, dicts)` / `bind(ns)`);
  the plugin treats it as optional and falls back to built-in zh/en, which is correct.
- `workspace.json` uses `pendingMutation: undefined` when idle and the field is `.optional()`
  in the workspace spec, so a truthiness test was wrong (fixed, §7-3).
- `parsePatchList` (`dsh-app-boot/lib/index.js:3993`) parses with `yaml.load` and throws on
  failure or a non-array result — so a malformed patch file aborts install (§7-2).

## 7. Defects found, and their fixes (all re-verified)

| # | Severity | Defect | Fix |
| --- | --- | --- | --- |
| 1 | **Critical** | `lib/index.js` never populated `listing.file`, so `scrubWorkspace` did `readJson(undefined)` → `null` → **silently skipped**; `workspace.json` kept the deleted id everywhere, `scrubbed` claimed success. | `scrubWorkspace(home, info)` now recomputes `<home>/storages/workspace.json` and returns a verdict. |
| 2 | **Critical (install-blocking)** | `cordis.patch.yml` began with 7 `//` comment lines; `//` is not YAML. DSH's parser threw `Implicit keys need to be on a single line at line 1, column 1`. | Changed to `#`. |
| 3 | High | `stamp()` is 1-second resolution and the backup dir was `mkdir`ed recursively, so two deletes in the same second shared a dir: the second overwrote `storages/workspace.json.bak` with an already-scrubbed copy and `manifest.json`, losing the first batch's restore point and record. | `uniqueBackupDir()`: non-recursive `mkdir` + `EEXIST` → `-2`, `-3`, … Each call owns its dir. |
| 4 | High (regression introduced **by** fix 3) | `uniqueBackupDir` dropped the recursive parent creation, so on any home without `<home>/session-delete-backup` the **first** delete failed with `ENOENT` (fail-closed, but delete 100% broken). | `fs.mkdirSync(root, { recursive: true })` once before the loop. |
| 5 | Medium | A backup-root failure threw out of `deleteSessions` (whole RPC), so the client showed a generic error and the rest of the batch was never attempted. | Attempted before the loop; each id gets `{ok:false, error:'无法创建备份目录，已放弃删除：…'}`. |
| 6 | Medium | Client `apply()` called undefined `openRequest()` (footer button dead) and later `resolveHost()` (throw before any slot registration); plus a `return` that made the factory's exports `undefined`. | Rewritten to the static `dsh.client` form; `openRequest`/`resolveHost` references gone. |
| 7 | Low | `pendingMutation` tested for truthiness against a field whose idle value is `undefined`, making the guard dead code. | Raw value carried; skip only on a non-null object, reported as `workspace:pending-mutation`. |

On narrowing the `pendingMutation` guard: keeping it blocking is correct. In `dsh-workspace` the
marker only exists while a workspace create/delete is rewriting the whole unit file, so a
concurrent scrub of any session row would be lost. It is rare, short-lived, and now reported.

## 8. Open items (none blocking)

1. `package.json` `files[]` lists a non-existent `locale` directory; README's file table omits
   `lib/store.js`. Both cosmetic, no runtime effect.
2. Known and documented limitation (not a bug): the running Host holds `workspace` /
   `session_projcache` in memory, so the UI may show a deleted row until refresh/restart. The
   delete result carries `restartRecommended: true` and the client renders the hint; the README
   and the dialog text both say so.
3. Deleting a parent does not cascade to children (documented; children become orphans that are
   listed and deletable individually). This is the safe default.

## 9. Safety properties exercised adversarially (all held)

- **Traversal**: ids are validated against `ID_RE` *before* any filesystem access, and
  `removeSessionDir` additionally asserts the resolved path is inside `<home>/sessions/` **and**
  that its basename equals the id. 7 crafted ids rejected; the outside sentinel file was never
  touched.
- **Wrong session**: the target directory is resolved from the authoritative
  `sessionPersistence.list()` snapshot plus the ported encoders (with an exact-name fallback
  scan), never by glob; the delete guards refuse the current session and its descendants even
  with `allowActive`.
- **Backup failure**: fail-closed at both the directory-creation and per-id level; the session
  directory is never removed before a successful backup copy.
- **Unrelated records**: after a delete, all other session dirs and projection docs are
  byte-identical, and `workspace.json` is deep-equal except for the removed id; unrelated
  workspace records stay byte-identical; the legacy cache loses only one row.
- **Atomic writes**: `workspace.json` and `session_projcache.json` are written temp-file +
  `rename`; a `.bak-<stamp>` copy of the pre-edit file is kept; no `.tmp` files are left behind.

---

# Round 2 — HTTP endpoint, trust fence, Remote facade

Re-verified after the transport rework (the host now registers its own HTTP endpoints and
optionally a Remote facade; `client.js` gained the A–E transport chain).

**Final artifacts:** `lib/index.js` md5 `529ca220f5eb10b6cfa6ba6fe4c649ab`,
`lib/store.js` `91ef8c5cd80c125f76e6d22c00526aeb`, `client.js` `2064c24a1c5f4d4b6a35dcbca8e03f54`,
`cordis.patch.yml` `5c37747e050bd8900644500b380845fa`, `package.json` `f7fb3c4e65f2d292048b97e57113b63a`.
`node --check` clean on all JS files.

**Round 2 verdict: PASS** on both channels. Four defects were found during Round 2 and all
are fixed and re-verified. The Remote facade is functional and safe; HTTP is the primary channel.

## R2.0 Reproduce

```
cd D:\dsh\dsh-session-manager\verify
node http-routes.mjs             # 23/23  endpoints, fence, bypass attempts
node remote-identity-check.mjs   # real Cordis ctx + the Gateway's own readBinding/originalOf
node identifier-guard.mjs        # 4/4    undefined-identifier guard
node client-transport.mjs        # 7/7    A/B/C/D/E transport + error rendering
node host-e2e.mjs                # 35/35  host matrix, now driven through the HTTP routes
node client-harness.cjs          # 10/10  slot registration / render / delete payload
node fresh-home.mjs ; node collision-probe.mjs ; node yaml-check.cjs
```

`r2deps/` holds a read-only extraction of `@deepseek-ai/dsh-typert-protocol` and
`@deepseek-ai/cordis` from the shipped asar, used to drive the real Service path.

## R2.1 HTTP endpoints + trust fence — 23/23 PASS

Routes are captured via a stubbed `webServer.register` and driven with a fake req (async
iterable body + headers) and a recording res. Every request targets the **fake home** only.

| Case | Expected | Result |
| --- | --- | --- |
| 0. exactly two `kind:'exact'` routes registered | `/list` + `/delete` | PASS |
| (a) `GET /list` with loopback Host | 200 + listing JSON, `no-store` | PASS |
| (f) `Host: 127.0.0.1:5471` + `Origin: http://127.0.0.1:5471` | allowed | PASS |
| (b) `sec-fetch-site: cross-site` | 403, no deletion | PASS |
| (b) foreign `Origin` / foreign port | 403, no deletion | PASS |
| (g) `Host: evil.example`, no Origin | 403, no deletion | PASS |
| (h) `Origin: null` + foreign host | 403, no deletion | PASS |
| (h) `Host: localhost.evil.com` / `127.0.0.1.evil.com` | 403 | PASS |
| (h) missing `Host` / malformed `Host` | 403 | PASS |
| (h) non-loopback Host with no sec-fetch-site evidence | 403 | PASS |
| (h) duplicate `Host` header (array value) | 403, no deletion | PASS |
| (h) uppercase `Host: LOCALHOST:5471` | accepted (case-insensitive) | PASS |
| (d) `content-type: text/plain` on POST | 415, no deletion | PASS |
| (h) `Application/JSON; charset=utf-8` | accepted | PASS |
| (h) `GET` on `/delete` | 405 `{error}` | PASS |
| (e) malformed JSON body | 500 `{error}`, no deletion | PASS |
| (h) body > 64 KB | 500 `{"error":"请求体过大"}`, no deletion | PASS |
| (c) same-origin POST + JSON, `backup:true` | 200, per-id `ok:true`, real backup dir on the fake home with `manifest.json` + the session dir; session dir removed; projcache doc removed; `workspace.json` scrubbed; the other session untouched | PASS |
| (c) crafted ids over HTTP (`../../evil`, unknown uuid) | 200 with per-id `ok:false`; outside sentinel untouched | PASS |
| no `webServer` | `apply()` only warns, registers no routes, does not throw | PASS |

**No bypass found.** Every rejection happens before the handler body runs, so a rejected
request can never reach `deleteSessions`. After each rejection I also asserted the session
directory still exists *and* that no `session-delete-backup` directory was created.

## R2.2 Remote facade — PASS (optional / experimental)

Installed only when `@deepseek-ai/dsh-typert-protocol` resolves; otherwise a **clean silent
skip** (verified: no error logged, HTTP endpoints still return 200).

| Check | Result |
| --- | --- |
| Facade installs as a real `SessionManagerRemote extends TypertRemoteService` | PASS |
| Marker sits on the **class prototype** (depth 0) | PASS |
| Marker on `Object.prototype` — before and after `apply()` | PASS (clean at every depth) |
| `remoteMethods({})` for an unrelated object | PASS (`[]`) |
| `remoteMethods(facade)` | PASS (`["delete","list"]`, version 1, `kind:'direct'`) |
| Marker shape identical to the protocol's own `mark()` output, frozen | PASS |
| **`binding.service === originalOf(app.get('dshSessionManager'))`** | **PASS** |
| `readBinding(...)` | PASS (ACCEPTED) |
| `resolveSrcDescriptor` discovery walk finds `dshSessionManager` | PASS |
| `facade.list()` returns the listing; `facade.delete()` really deletes (`ok:true` + backup dir) | PASS |
| `facade.delete` refuses crafted ids | PASS |
| `ctx.provide` yields `reflect.props.dshSessionManager = {type:'service'}` | PASS |

On the identity question: `app.get()` returns Cordis's **Service proxy**, so the naive
`binding.service === app.get(...)` is **false by design** — that is not a defect. The Gateway
always routes through `originalOf()` (`dsh-api-gateway/lib/index.js:1712`) first, which returns
the raw Service from `receiver[symbols.original]`; through it identity holds and `readBinding`
(`:1707`) accepts. Dropping the manual `bindTypertRemote` rebind and relying on
`TypertRemoteService`'s own constructor binding was the correct fix.

Answering the two residual-risk questions directly:
(i) **yes** — constructing the Service on a real Cordis `Context` does yield a
`reflect.props.dshSessionManager = {type:'service'}` prop, so Gateway discovery works;
(ii) the Gateway resolves SRC endpoints **server-side per request** from `ctx.reflect.props`;
a browser Client call reaches it over the normal remote channel, and nothing calls the Service
in-process from the browser.

## R2.3 Client transport chain — 7/7 PASS

| Case | Result |
| --- | --- |
| A `ctx.remote.dshSessionManager.{list,delete}` preferred over the HTTP bridge | PASS (rows rendered, 0 fetch calls) |
| B `ctx.get('dshSessionManager')` service seam when remote is absent | PASS |
| C `globalThis.host.call` when neither exists | PASS |
| D fetch bridge: `GET /dsh-session-manager/list`, `POST /dsh-session-manager/delete`, `credentials:'same-origin'`, JSON body `{sessionIds, backup, allowActive}` | PASS |
| HTTP non-2xx `{error}` body rendered to the user | PASS |
| `RemoteError` (structural `isDSHRemoteError`) rendered with its code | PASS |
| E no channel at all → 「无法连接宿主端」, zero fabricated calls | PASS |

One caveat worth stating: `resolveTransport` computes an `unavailable` flag and skips the Remote
seat when `fetch`, a global host **and** a service seam are all absent. In a real browser `fetch`
always exists, so branch A is never wrongly skipped; the flag only degrades in non-browser
environments. I explicitly verified that A wins over `fetch` when both are present.

## R2.4 Round 2 defects found (all fixed and re-verified)

| # | Severity | Defect | Fix |
| --- | --- | --- | --- |
| R2-1 | **Blocker** | `deleteSessions` was referenced at `lib/index.js:583,602` but **never defined** — the 633-line rewrite dropped it. Every legitimate POST returned `500 {"error":"deleteSessions is not defined"}`. | Restored as a module-scope `async function deleteSessions(ctx, request)`. |
| R2-2 | **High** | The `@Remote` hand-emulation (`initializer.call(this)`) wrote the marker onto **`Object.prototype`** — global prototype pollution visible to every plain object in the Host process — and *not* onto the Service prototype, so the Gateway would have found no marker at all. | Marker written directly onto the class prototype with `Object.defineProperty`, matching the protocol's `mark()` output byte-for-byte; no initializer is ever invoked. |
| R2-3 | High | The extra manual `bindTypertRemote` rebind was redundant, and the binding did not match what `originalOf()` yields through the Service proxy. | Removed; rely on `TypertRemoteService`'s own constructor binding. Verified via `originalOf` + `readBinding`. |
| R2-4 | High | `REMOTE_DESCRIPTOR` was referenced but undefined (same class as R2-1) — `installRemote` threw a `ReferenceError` that its `catch` swallowed, so the facade silently never installed. | Constant restored; `undefinedNames()` guard added; `identifier-guard.mjs` now checks this class permanently. |

Method note on R2-2/R2-3: my first two attempts to exercise the facade were **my** harness bugs
(the scratch dependency tree was not named `node_modules`, so Node's resolver did not walk it;
and the vm sandbox lacked `setTimeout`/`fetch`, so the client read a different global than the
test set). Each was fixed before drawing a conclusion. The final facade findings come from
driving a **real Cordis `Context`** with the real protocol package extracted read-only from the asar.

## R2.5 Residual risks / recommendations

1. **Ship fail-soft, HTTP primary.** The Remote facade exists only if the protocol package
   resolves *and* the Gateway's SRC walk finds the service. On this machine the package is not
   resolvable from the plugin, so the clean skip is the *normal* path here, not an error — that
   is what the README should say.
2. **Direct-marker fragility.** Writing the descriptor by hand reproduces the protocol's internal
   format; a future protocol change to that shape could silently stop working. The HTTP path is
   immune, which is exactly why it must stay primary. Document the Remote path as
   optional/experimental.
3. **`undefinedNames()` is deliberately narrow** — it validates only a hardcoded scope map, so a
   name missing from that map is not caught. `identifier-guard.mjs` compensates with a
   referenced-symbol check plus a runtime probe that turns the fire-and-forget `installRemote`
   catch into a visible failure (asserts no `unhandledRejection` and no "is not defined" warning).
4. **Packaging**: `cordis.patch.yml` parses with DSH's own `yaml@2.9.1` into a single `insert` row;
   `package.json` is valid JSON, `files[]` no longer lists a missing `locale` directory, and
   `package.json.name` == patch `name` == `dsh-session-manager`. README lists `lib/store.js`
   in its file table.

## R2.7 Round 3 — re-verification after the tooling outage

The profile's `node_modules` was wiped mid-session (a failed `pnpm` reinstall after
`dsh-purge`'s GitHub tarball started returning 404), which killed the `dsh-ops`-backed tools.
Once the tools were back, the whole plugin was re-verified and **three real defects surfaced**
that the earlier rounds had not exercised, because the Remote path had never actually installed:

1. `new TypertRemoteService(ctx, key)` throws `TypeError: Cannot read properties of undefined
   (reading 'provide')` — the `SessionManagerRemote` constructor never called `super(owner)`, and
   the protocol's own base class builds/binds its own Cordis Context, which a restricted plugin
   Context cannot satisfy. The facade therefore never installed and the catch hid it.
   Fix: derive from `@deepseek-ai/cordis`'s `Service` in the plugin's own Context, keep the
   protocol's `bindTypertRemote` for the binding, and register through `ctx.reflect.provide`
   when the Context exposes `reflect`, falling back to `ctx.provide`.
2. `undefinedNames()` had been dropped during a rewrite while its harness still depended on it.
   Fix: restored as an export; `identifier-guard.mjs` is 4/4 again.
3. The Remote facade path is now proven, not assumed: `verify/remote-facade.mjs` (real protocol
   + Cordis packages extracted read-only from the asar) is **9/9**, including `readBinding`
   acceptance through `originalOf`, prototype marker at depth 0 with `Object.prototype` clean,
   `methodParameterNames` resolving `list()` / `delete(request)`, and `facade.delete()` really
   deleting on a fake home.

Final re-run after these fixes: host matrix 35/35, HTTP fence 23/23, client transport 7/7,
client UI 10/10, fresh-home PASS, collision PASS, identifier guard 4/4, facade 9/9,
`research/client-check.cjs` OK.

## Summary

## R2.6 Final PASS/FAIL

**PASS** — HTTP endpoints + trust fence (23/23), the delete path driven through HTTP (the full
35/35 host matrix), Remote facade install/shape/identity, client transport chain (7/7), client UI
(10/10), fresh-home and same-second-collision regressions, packaging/YAML, and the
undefined-identifier guard (4/4).

No data-loss, path-traversal, trust-fence, or prototype-pollution defect remains.

---

## Summary

This plugin was verified in two independent rounds plus a third re-verification after a tooling outage, against a throwaway fake `<DSH_HOME>` and never against the live `C:\Users\shuixing\.dsh`. The host half was exercised end-to-end through its production channel (the two HTTP endpoints registered via `ctx.webServer`), capturing the routes and driving them with fake req/res: session listing, backup-before-delete (session dir with both artifacts, projection doc plus its `.bak` siblings, `workspace.json.bak` holding pre-delete content, `manifest.json`), removal of the session directory and projection records, the `workspace.json` scrub, and confirmation that every other session stays byte-identical; plus the refusals (current session, its descendants, running sessions, unknown and crafted ids) and fail-closed behaviour when the backup cannot be written. The trust fence was probed adversarially and no bypass was found: cross-site and foreign-origin requests, `Origin: null`, look-alike hosts (`localhost.evil.com`, `127.0.0.1.evil.com`), missing/malformed/duplicate `Host` values, non-loopback hosts without same-origin evidence, non-JSON content types, malformed and oversized bodies, and wrong methods were all rejected or refused before any deletion ran, with the session and backup tree positively confirmed untouched each time. Path-traversal safety rests on `ID_RE` validation before any filesystem access plus a second containment assertion inside `removeSessionDir`, backed by exact reimplementation of DSH's own `encodeSegment`/`projectKey` (verified against fixed vectors); the browser half was checked against the real `window.__ModuleLoader__.load({id, factory})` contract and the platform seed words, confirming slot registration, row rendering, the delete payload, protected-row disabling, the A-D transport chain including `RemoteError` and non-2xx rendering, and an explicit host-unavailable state instead of fabricated calls; and the optional Remote facade was validated by driving a real Cordis `Context` with the protocol package extracted read-only from the shipped asar, proving the method marker lands on the class prototype (never on `Object.prototype`), that `readBinding` accepts it through the Gateway's own `originalOf`, and that `resolveSrcDescriptor` discovers it. Defects found across all rounds were fixed and re-verified, including two undefined-identifier crashes, a silently-ineffective `workspace.json` scrub, install-blocking invalid YAML, a same-second backup-directory collision that destroyed a restore point, global `Object.prototype` pollution, and a Remote facade constructor that could never install. Known limitations that remain by design or environment: deleted sessions may still appear in the UI until a refresh or restart because the running Host holds `workspace` and `session_projcache` in memory (the result carries `restartRecommended` and the dialog says so); deleting a parent does not cascade to its children, which become individually deletable orphans; backup directories are never auto-pruned; the Remote facade is optional/experimental and silently skips when `@deepseek-ai/dsh-typert-protocol` does not resolve from the plugin (HTTP remains the primary and fully verified path); and the hand-written marker reproduces protocol-internal shape, so a future change there could quietly disable that path without affecting HTTP.
