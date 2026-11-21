# DSH Session-Delete Plugin — Research Findings

Read-only research. Nothing under `<DSH_HOME>` was modified.
Evidence: live `cordis_inspect_query` (platform=host, provider=Service), read-only asar parsing of
`D:\DeepSeek Harness\resources\app.asar` (18,234 entries), and read-only inspection of `~/.dsh`.

DSH version in the desktop app: `@deepseek-ai/*` packages at **0.2.1-rc.5**; session format **v4**.

---

## 1. Session log layout under `<home>\sessions`

### Path scheme (from `dsh-session-persistence-jsonl/lib/index.js`)

```js
projectDir(root, cwd)  = cwd === undefined ? join(root, "_no-cwd") : join(root, projectKey(cwd))
sessionDir(root, cwd, id) = join(projectDir(root, cwd), encodeSegment(id))
// artifact: <sessionDir>/session.v<version>.jsonl.<compression>  -> session.v4.jsonl.zstd
```

`encodeSegment(raw)` — one safe path segment; `[A-Za-z0-9._-]` stay literal, everything else becomes
`~XXXX` (uppercase hex of the UTF-16 code unit). `"."` → `~002E`, `".."` → `~002E~002E`; empty throws.

`projectKey(cwd)` — runs of `/`, `\`, `:` collapse to a single `-`; other unsafe chars `~XXXX`;
wrapped as `--<readable>--`, leading dashes stripped, truncated to 251 chars. Empty cwd → `_no-cwd`.

Verified live layout:

```
sessions/--D-dsh--/<sessionId>/session.v4.jsonl.zstd          (9 sessions)
sessions/--D-~793A~4F8B~76EE~5F55--/<sessionId>/session.v4.jsonl.zstd   (cwd = D:\示例目录)
sessions/--D-~793A~4F8B~76EE~5F55--/<sessionId>/session.jsonl.zstd      (legacy pre-v4 artifact, same dir!)
```

Live id shapes: `session-<uuid>` **and** bare `<uuid>` (e.g. `44444444-3333-4222-8111-000000000000`).
Both occur — do not assume the `session-` prefix. Also note 4 project dirs exist that are **empty**
(`--D-Plugins-craft-anything-...--`, `--D-craft~0020anything--`, `--D-you-Documents--`).

### RISK: multiple artifact files per session dir

One session directory may contain **both** `session.jsonl.zstd` (format v0) and
`session.v4.jsonl.zstd`. Count files, not dirs. Delete = remove the whole session directory, never a
single file.

### Header line (frame 0, decompressed in memory with `zlib.zstdDecompressSync`)

Exact raw text of the first frame (plain JSON, one trailing `\n`):

```json
{"type":"session","version":4,"id":"session-11111111-2222-4333-8444-555555555555","createdAt":1794048565330,"cwd":"D:\\dsh","parentSession":"session-23232323-4545-4000-8222-bbbbbbbbbbbb","isSeeded":true,"delegationDepth":0,"agentPreset":"cordis"}
```

That object is the canonical `SessionHeader` shape (`type:"session"` discriminator; `parentSession` and
`createdAt` present only when applicable):

```ts
export interface SessionHeader {
    readonly version: typeof SESSION_FORMAT_VERSION;
    readonly id: SessionId;
    readonly createdAt: number;      // epoch ms
    readonly cwd?: string;
    readonly parentSession?: SessionId;
    readonly isSeeded: boolean;
    readonly origin?: 'subagent';
    readonly delegationDepth?: number;
    readonly agentPreset?: string;
}
```

Legacy v0 same dir (plain values, no `isSeeded`):
`{"type":"session","version":0,"id":"session-00000000-...","createdAt":1787824047027,"cwd":"D:\\示例目录","delegationDepth":0,"agentPreset":"cordis"}`

Event lines after the header (line 1, 2, …):

```
line 0 keys type,version,id,createdAt,cwd,parentSession,isSeeded,delegationDepth,agentPreset  type "session"
line 1 keys type,seq,time,data                    type "permission/preset"
line 2 keys type,seq,time,data                    type "sandbox/mode"
```

### TRAP: these files are MULTI-FRAME zstd

`zlib.zstdDecompressSync(buffer)` decodes **only the first zstd frame** and stops silently — no error.
For `session.v4.jsonl.zstd` (1,841,827 bytes) that returns **247 bytes / 1 line** (just the header)
instead of the true 11,079,851 bytes / 4,354 event lines. The file contains **359 concatenated zstd
frames** (magic `28 b5 2f fd`).

If the plugin only needs the header this does not matter, but any "peek the title / count events" step
will silently see an empty session. To read a whole log either loop over frames:

```js
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = []; let i = 0;
while ((i = buf.indexOf(MAGIC, i)) !== -1) { starts.push(i); i += 4; }
const parts = starts.map((s, k) =>
  zlib.zstdDecompressSync(buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length)));
const text = Buffer.concat(parts).toString('utf8');
```

or better, do not parse the log at all — use `ctx.sessionQuery.readTitle*()` /
`readSession()` / `sessionPersistence.stat().sizeBytes`, which read it correctly.

---

## 2. Storage units

Two on-disk unit files under `<home>\storages\` (both JSON `{unit, global, tables}`):

### `workspace.json` — unit `workspace` **v2**

```js
const workspaceDomainSpec = defineDomain({
  name: 'workspace', version: 2,
  global: { schema: workspaceDomainState, initial: { initialized:false, workspaceIds:[],
                                                     archivedSessionIds:[], pinnedSessionIds:[] } },
  tables: { workspaces: domainTable(workspaceRecord) },
});
// global: { initialized, defaultWorkspaceId?, workspaceIds[], archivedSessionIds[] [default []],
//           pinnedSessionIds[] [default []], pendingMutation? }
// record: { path, title, sessionIds: SessionId[], createdAt, updatedAt }
```

Live sample key: `6fb8e483-dea4-489e-b573-8364de08c78c` → `{path:"D:\dsh", title:"dsh",
sessionIds:[7 ids], createdAt, updatedAt}`; `global.archivedSessionIds` had 1 id, `pinnedSessionIds` `[]`.

### `session_projcache.json` — on disk **v3**, code expects **v7**

```js
const projectionCacheDomainSpec = defineDomain({
  name: "session_projcache", version: 7,
  compatibleVersions: [3, 4, 5, 6],
  invalidRecords: "backup-and-skip",
  layout: "per-record",                        // -> one file per record under the domain root
  tables: { sessions: domainTable(checkpointRecord) },
});
// checkpointRecord = { identity: checkpointIdentity, rows: Record<string, checkpointRow> }
// identity = { formatVersion, createdAt, cwd?, isSeeded, inheritedEventCount }
```

Live file declares `unit = {"name":"session_projcache","version":3}` and **has no `global` key**.
`layout: 'per-record'` explains the mirror directory:
`storages/session_projcache/sessions/<sessionId>.json` (9 files present; the domain root is the
mirror dir, so the `.json` aggregate file is a separate/legacy unit document).
Sample record: `{identity:{createdAt:1787824047027,cwd:"D:\\示例目录"},
rows:{sessionStats,title,goal,tokenUsage,contextPressure,contextBreakdown,subagentTiming,
subagent,permissions,sessionListMetadata,imageLimits,todos,plan}}`.

**This is derived cache data, never an authority.** Its own docs say a stale/unreadable record costs a
longer tail replay, "never a wrong value", and malformed records are moved aside as
`<key>.json.bak.<stamp>`. Safe to delete wholesale for a session.

### Every file under `<home>` that references a session id

Systematic grep of `<DSH_HOME>` (excluding `sessions/` payloads and
`profiles/desktop/node_modules/`) for `session-00000000-1111-4222-8333-444444444444`:

```
./storages/workspace.json                                  <- authority: sessionIds / archived / pinned
./storages/session_projcache.json                          <- derived cache
./storages/session_projcache/sessions/<id>.json            <- derived cache (per-record mirror)
./storages/*.bak-<stamp>  (5 files)                        <- pre-existing timestamped backups
./session-delete-backup/2026-11-08T07-35-55/*.json.bak     <- a previous run's own backup dir
                                                        (proves this pattern already in use)
sessions/--D-<proj>--/<id>/                                <- the session directory itself
```

**No** hits in `attachments/`, `cache/`, `dsh-ops/`, `dsh-runtimes/`, `llm-deepseek/`, `redteam/`,
`whale-*/`, `.credentials.yaml`, schedules, goals or team tasks. Goals/schedules/session titles are all
folded from the **session log itself**, so they die with the log.

### CRITICAL: workspace.json is NOT the session index

Set comparison of live data:

```
disk sessions (10) : 55555555-…, 44444444-…, session-eeeeeeee-…, session-ffffffff-…,
                     session-dddddddd-…, session-bbbbbbbb-…, session-11111111-…,
                     session-cccccccc-…, session-aaaaaaaa-…, session-00000000-…
workspace.sessionIds (7) ; projcache rows (1) ; archived (1)
on disk but NOT in workspace: 55555555-…, 44444444-…, session-00000000-…
on disk but NOT in projcache: 9 of 10
```

Three real sessions exist only on disk — invisible in `workspace.json`. The authoritative listing is
**`ctx.sessionPersistence.list()`** (or `ctx.sessionQuery.listSessions()`), filtered by
`workspaceRegistry.list()[i].sessionIds` only for display grouping. A lister built on
`workspace.json` would silently miss 30% of this user's sessions.

---

## 3. Does any delete API exist? **No.**

Searched the entire 18,234-entry asar for `deleteSession|removeSession|purgeSession|destroySession|
trashSession` across every `@deepseek-ai/dsh-*/lib/*.js`: **0 hits**. The only `delete*` identifiers in
`dsh-api-session-controller/lib/index.js` are text-editing key names (`deleteContentBackward` etc.).

### What *does* exist (all verified)

| Surface | Method | Deletes a session? |
|---|---|---|
| `sessionPersistence` | `create`, `open`, `flush`, `stat`, `list` | no (**no `delete`**) |
| `sessionQuery` | `listSessions`, `filterSessions`, `readSession`, `readTitle*`, `traceSession`, … | no |
| `sessionProjectionCache` | `recordFor`, `put` (+ internal `write`/`flushSoft`) | no |
| `workspaceRegistry` | `delete(id: WorkspaceId)` | **workspace registration ONLY** — docs: "while retaining its directory and **every session log**" |
| `workspaceRegistry` | `archiveSession`, `unarchiveSession`, `pinSession`, `unpinSession` | no — hides/badges only |
| `workspaceController` (`@Remote`) | `'delete'`, `'archiveSession'`, `'unarchiveSession'`, `'pinSession'`, `'unpinSession'` | same as above; typert host method list confirms **no** `deleteSession` remote |

The in-memory `sessions` store (`create`/`prepare`/`enter`/… ) also has no removal.

**Conclusion:** permanent deletion must be a file-system operation. There is no seam to call, and no
existing CLI command either. Archive is the only built-in "hide it" and it is fully reversible /
file-preserving — a genuine plugin needs its own delete path.

---

## 4. Exact Host Service signatures a plugin needs

### `sessionPersistence` (the authoritative lister)

```ts
abstract list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]>
abstract stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined>
abstract flush(): Promise<void>
readonly identity: symbol = Symbol('sessionPersistence')

interface SessionPersistenceListOptions  { readonly signal?: AbortSignal }
interface SessionPersistenceStatOptions  { readonly signal?: AbortSignal }
interface SessionPersistenceSnapshot {
    readonly header: SessionHeader;
    readonly formatStatus?: 'current' | 'migration-required';
    readonly revision: SessionPersistenceRevision;
    readonly eventCount?: number;
    readonly sizeBytes?: number;
}
```

Note: **no `cwd`/`mtime`/`id` at top level** — they live on `snapshot.header`
(`header.id`, `header.cwd`, `header.createdAt`); size is `snapshot.sizeBytes`. "in no promised order".

### `sessionQuery` (titles + lineage; what the UI actually shows)

```ts
listSessions(signal?: AbortSignal): Promise<SessionRecord[]>          // newest-first
filterSessions(filters: readonly SessionResultFilter[], signal?): Promise<SessionRecord[]>
readTitle(sessionId: SessionId, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined>
readTitleSnapshots(sessionIds: readonly SessionId[], signal?): Promise<SessionTitleObservationResult[]>
traceSession(sessionId: SessionId, signal?): Promise<SessionLineageTrace>

interface SessionRecord { header: SessionHeader; live: boolean; persisted: boolean;
                          formatStatus?: 'current' | 'migration-required' }
```

`readTitleSnapshots` is the right batch call for a list view (results keep first-occurrence input order;
per-session failures isolated). `traceSession` gives `descendants: SessionLineageNode[]` — needed if
deleting a parent should offer to delete its subagent children.

### `storageDomain.open` — the generic KV/table API (has `delete`)

```ts
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
get(name: string): DomainImpl | undefined
async closeAll(): Promise<void>

interface Domain<S> {
    readonly name: string;
    readonly global: DomainGlobalHandleOf<S>;
    table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S,N>, TableValueOf<S,N>>;
    close(): Promise<void>;      // CALLER owns lifecycle
}
interface DomainGlobal<G> { get(): G; set(value: G): Promise<void>; }

interface KvTable<K extends string, V> {
    get(key: K): V | undefined;
    entries(): IterableIterator<[K, V]>;
    keys(): IterableIterator<K>;
    readonly size: number;
    put(key: K, value: V): Promise<void>;
    delete(key: K): Promise<boolean>;                  // <-- exists, and does exist on tables
    update(key: K, fn: (current: V) => V): Promise<V>;
}
```

`open()` steps, each failing the whole call: `already-open` (single open per domain name),
`backend-not-found`, `facet-unsupported`, unit errors (`version-mismatch` / `malformed-medium`),
`invalid-record` (with table + key) unless the spec declares `invalidRecords: 'backup-and-skip'`.

**Do not re-declare these domains.** `open` rejects with `already-open` because the owning plugins
(`dsh-workspace`, `dsh-session-projection-cache`) already hold them for the process lifetime. The
realistic choices are (a) write the JSON files directly, or (b) `ctx.storageDomain.get('workspace')`
for an untyped `DomainImpl` diagnostic handle — but its `.table()` returns
`KvTable<string, unknown>` **unvalidated**, and writes bypass the registry's in-memory projection, so
the running Host would keep serving stale `Workspace.sessionIds` until restart. Direct file editing has
the same staleness property. Treat "the UI updates without a restart" as a known limitation.

### `workspaceRegistry` (works)

```ts
list(): Workspace[]                                   // synchronous
get(id: WorkspaceId): Workspace | undefined
delete(id: WorkspaceId): Promise<boolean>             // workspace only, keeps sessions
archiveSession(sessionId: SessionId, options?: ArchiveSessionOptions): Promise<void>
unarchiveSession(sessionId: SessionId): Promise<void>
pinSession(sessionId: SessionId) / unpinSession(sessionId): Promise<void>
resolveByPath(path: string): Promise<Workspace | undefined>

interface ArchiveSessionOptions { readonly stopActivity?: boolean }
interface Workspace { readonly id; readonly path; readonly title; readonly createdAt;
                      readonly updatedAt; readonly sessionIds: readonly SessionId[];
                      setTitle(t): Promise<void>; attachSession(id): Promise<void>;
                      insertSessionBefore(id, before?): Promise<void>;
                      detachSession(id): Promise<void>; status(): Promise<'ok'|'missing-dir'>; }
```

`Workspace.sessionIds` is already filtered by the canonical-cwd header index. `archiveSession` without
`stopActivity` **rejects** if the session is active (`workspace/session-activity` waterfall).

### `sessions` / `sessionTitle` (live, in-memory)

```ts
// ctx.sessions
create(id?: SessionId, options?: CreateSessionOptions): Session
prepare(id?: SessionId, options?: PrepareSessionOptions): Session
enter(session: Session): () => void
// ctx.sessionTitle
get(session: Session): SessionTitleSnapshot | undefined
rename(session: Session, title: string): SessionTitleSnapshot
```

**Refuse to delete a live session.** `ctx.sessions` / `ctx.agents.get(sessionId)` tell you whether it is
open; `sessionPersistence.flush()` is the durability barrier to call before touching files. Deleting the
log out from under a live agent will corrupt its next append.

---

## 5. Host → browser RPC for a custom plugin

### Option A — typert / `ctx.remote` — NOT usable for a hand-written plugin

Typert is the shipped mechanism (`@Remote` decorators on Host services → `ctx.remote.<ns>.method()` in the
browser), but it is **generated**: every `@deepseek-ai/*` package ships `lib/typert.host.js` and
`lib/typert.remote-client.js` that begin with

```
/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */
```

and are exposed via `package.json` `exports` keys `"./typert"` and `"./remote"`. `dsh-typert-loader`
discovers them from Loader entries; a package without the export is "skipped silently", and
resolution verdicts are cached for the process lifetime. Using typert means running the code generator
over a FaceModel — out of scope for a plugin that should just work when dropped in.

### Option B — `webServer.register` + `connection.requestRejection` — RECOMMENDED

This is exactly what the user's own installed plugin `dsh-whale-widget@0.4.2` does, and it works today in
this desktop build. It needs no code generation and no Gateway changes.

```ts
// ctx.webServer
register(route: WebRoute): () => void                    // returns disposer; dup (kind,path) throws
tapIndex(transform: (html: string) => string): () => void
collectIndexInjections(): IndexInjection[]
getOrigin(): string

interface WebRoute {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

// ctx.connection — THE trust fence
requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection  // 401 | 403 | undefined
interface ConnectionTrustRequest { readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>> }
```

**Semantics that matter:** `requestRejection(headers-only request)` applies Connection's Host/Origin
checks *and* browser authentication. `undefined` = may accept. Non-undefined = reject with that status.

Minimal, correct pattern (distilled from the whale widget, which additionally layers its own
loopback/`Sec-Fetch-Site`/write-method checks because `requestRejection` is missing on older builds —
keep that defensiveness, and **fail closed** if it throws):

```js
export default {
  name: 'dsh-session-manager',
  // NOTE: do NOT use a top-level object-level `inject` for webServer/connection: on the desktop
  // shell the index-injection table is collected once at startup, and object-level inject defers
  // apply() past that collection, so nothing renders. Register injection rows first, then
  // root.inject([...], cb) for the rest. (issue #152/#153/#154 in the whale widget.)
  apply(root) {
    root.effect(() => () => { for (const d of routeDisposers) { try { d() } catch {} } })
    root.inject(['webServer', 'connection'], (ctx) => {
      const fence = () => {
        const c = ctx.get('connection') || ctx.connection;
        return c && typeof c.requestRejection === 'function' ? c : null;
      };
      function reject(req, res) {
        const deny = (code) => { res.statusCode = code || 403; res.end(); return true; };
        let code;
        try {
          const c = fence();
          if (!c) return deny(403);            // no fence -> fail closed on a write API
          code = c.requestRejection({ headers: req.headers });
        } catch { return deny(403); }          // fence threw -> fail closed
        if (code === undefined || code === null || code === false) return false;
        return deny(typeof code === 'number' ? code : 403);
      }
      const registerRoute = (route) => {
        const inner = route.handler;
        return ctx.webServer.register({ ...route, handler: async (req, res) => {
          if (reject(req, res)) return;
          return inner(req, res);
        }});
      };

      routeDisposers.push(registerRoute({
        kind: 'exact', path: '/dsh-session-manager/list',
        handler: async (req, res) => {
          const snapshots = await ctx.sessionPersistence.list();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                               'Cache-Control': 'no-store' });
          res.end(JSON.stringify(snapshots.map((s) => ({
            id: String(s.header.id), cwd: s.header.cwd ?? null,
            createdAt: s.header.createdAt, bytes: s.sizeBytes ?? null,
            formatStatus: s.formatStatus ?? 'current',
          }))));
        },
      }));

      // Tauri-style fetch from the browser half:
      //   const r = await fetch('/dsh-session-manager/list', { credentials: 'same-origin' });
    });
  },
};
```

Ship the browser half as a static file served by another `exact` route and injected via a
`webserver/index-inject` row (as `DESKTOP_WIDGET_ROW_TEXT` does) **plus** a `ctx.webServer.tapIndex`
transform for the non-desktop Web form — the desktop shell's `index.html` is read from disk
(`dsh-app://app/`) and never passes through `renderIndex()`, so `tapIndex` alone does not reach it.

Because `requestRejection` returns 401/403 based on a signed browser credential, a plain
`fetch(url, { credentials: 'same-origin' })` from the page satisfies it. Do **not** roll your own auth.

---

## 6. Recommended deletion procedure (with backup)

The only correct order, given there is no transaction spanning files + in-memory state:

1. **List**: `ctx.sessionPersistence.list()` → `{header.id, header.cwd, sizeBytes}`. Batch titles via
   `ctx.sessionQuery.readTitleSnapshots(ids)`. Never enumerate from `workspace.json`.
2. **Guard**: refuse ids where `ctx.sessions` has a live session / `ctx.agents.get(id)` is defined;
   `await ctx.sessionPersistence.flush()` first if you allow it at all.
3. **Resolve the directory** with the exact scheme in §1 — `encodeSegment(id)` + `projectKey(cwd)`, or
   simply `path.join(home, 'sessions', projectKey(cwd), encodeSegment(id))`. Never glob for `id*`.
   There is **no** `_no-cwd` in the live tree but the code supports it — handle `cwd === undefined`.
4. **Back up first** into `<home>\session-delete-backup\<ISO-stamp>\`: copy the whole session directory
   (all format artifacts), the `session_projcache/sessions/<id>.json` mirror, and the pre-edit
   `workspace.json` + `session_projcache.json`. A previous run's `2026-11-08T07-35-55` backup dir
   already contains exactly `workspace.json.bak` + `session_projcache.json.bak` — follow that shape.
5. **Unlink**: `fs.rm(sessionDir, { recursive: true, force: true })`. Remove the mirror
   `storages/session_projcache/sessions/<id>.json`, plus any `<id>.json.bak.<stamp>` siblings.
6. **Rewrite** `session_projcache.json` (`tables.sessions[id]` → remove; it is pure cache) and
   `workspace.json` (remove `id` from every `tables.workspaces[*].sessionIds`, from
   `global.archivedSessionIds`, and from `global.pinnedSessionIds`). Preserve `unit`, `global`
   keys and all other records byte-for-byte; write atomically (temp + rename).
   Watch `workspace.json`'s `global.pendingMutation` — if present, a registry mutation was mid-flight.
7. **Expect staleness**: the running Host's `workspaceRegistry` and `sessionProjectionCache` keep their
   in-memory copies; the UI may still show the row until a refresh/restart. Prefer also calling
   `ctx.workspaceRegistry.unarchiveSession(id)` / `unpinSession(id)` (both are no-ops on unknown ids and
   will not throw) so the durable registry at least agrees before the files are rewritten.

### Risks to carry into the implementation

- `delete` does not exist anywhere in the app — this is genuinely new behavior with no upstream safety net.
- **Session log files are multi-frame zstd (359 frames here).** `zstdDecompressSync` silently returns
  only the header frame. Never derive titles/event counts by decompressing yourself — use
  `ctx.sessionQuery.readTitleSnapshots()` or `sessionPersistence.stat().sizeBytes`.
- Two artifact generations can share one session dir; delete the directory, not a file.
- Session ids come in two shapes (`session-<uuid>` and bare `<uuid>`); never pattern-match the prefix.
- `workspace.json` misses ~30% of sessions here — listing must come from `sessionPersistence`.
- `session_projcache.json` is v3 on disk while code is v7 (`compatibleVersions` 3–6, per-record,
  `backup-and-skip`). Editing it by hand is low risk, but a whole-unit version bump by you would not be;
  only remove the one `tables.sessions[id]` key.
- Root session deletion orphans `parentSession` links in children and vice versa; `traceSession` exists
  if you want to offer cascade, but cascading deletes on a lineage are easy to get wrong — default to
  warn-only.
- Deleting the **currently open** session's log will corrupt the agent's next append.
- Every path operation must be `path.join`-built from `home` + the two encoders; the encoders are the
  traversal defense and are already proven by `dsh-session-persistence-jsonl`.
