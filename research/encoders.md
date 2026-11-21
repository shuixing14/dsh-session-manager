# DSH session-path encoders — verbatim source + test vectors

Extracted **read-only** from the desktop app bundle. This is the exact code that decides where a
session's directory lives, so a plugin must reproduce it byte-for-byte rather than guess.

## Where it lives inside the asar

```
D:\DeepSeek Harness\resources\app.asar
└─ dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js
   (147,273 bytes)
   function encodeSegment  @ byte offset 35672
   function projectKey     @ byte offset 36608
   function projectDir     @ byte offset 37621
   function sessionDir     @ byte offset 38070
```

Adjacent definitions, same file:

```js
function projectDir(root, cwd) {
	if (cwd === void 0) return join(root, "_no-cwd");
	return join(root, projectKey(cwd));
}
function sessionDir(root, cwd, id) {
	return join(projectDir(root, cwd), encodeSegment(id));
}
```

The public entry point, in the same module also authoritative for the artifact filename, is:

```js
sessionDir(<home>/sessions, header.cwd, header.id)  ->  <home>/sessions/<projectKey(cwd)>/<encodeSegment(id)>
```

and the artifact is `session.v<version>.jsonl.<compression>` beneath it (v4 → `session.v4.jsonl.zstd`).

## Verbatim source (reproduce exactly)

```js
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}
/**
* Build the readable directory key for a project path.
* Filesystem separators and drive separators become `-`; unsafe code units use
* the same `~XXXX` escape as session ids. The key is bounded for filesystem
* component limits. Separator replacement and truncation are intentionally
* lossy, following the common human-navigable project-directory convention.
* @param cwd - the session's project directory.
* @returns a single filesystem-safe project directory name.
*/
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
```

### Behaviour notes (read these before "improving" the code)

- **`encodeSegment`**: only `[A-Za-z0-9._-]` stay literal; `~` itself is escaped; everything else
  becomes `~XXXX` where `XXXX` is the **uppercase, zero-padded-to-4** hex of the UTF-16 **code unit**
  (`charCodeAt`, not code points — astral characters produce two escapes, lone surrogates survive).
  `.` and `..` are special-cased **before** the loop, otherwise they would stay literal and enable
  traversal. Empty string throws.
- **`projectKey`**: `separatorRun` collapses a *run* of `/`, `\`, `:` into a single `-`
  (so `D:\` → `D-`, and `D:/mixed\sep` → `D-mixed-sep`, not `D--mixed-sep`). Note `separatorRun`
  is set but only ever consumed as a latch — the first separator of a run emits `-`, later ones emit
  nothing.
- The `^-+` strip plus `|| "root"` means a cwd that starts with separators (`\\server\share`, `/home/x`)
  loses the rendered leading run entirely: `\\server\share` → `--server-share--`. A cwd that is
  *only* separators would become `root` → `--root--`.
- **Truncation to 251** happens on the inner `readable` only, so the total component is ≤ 255 chars
  (`--` + 251 + `--`). Truncation is lossy: two long cwds sharing a 251-char prefix collide. That is
  accepted upstream; do not "fix" it here or paths will stop matching the host.
- `projectKey` throws on `cwd === ""` but the **caller never passes `""`**: `projectDir` maps
  `cwd === undefined` to `_no-cwd` *before* calling it. Reproduce that branch order.

## Test vectors (computed by running the verbatim source above)

`projectKey(cwd)`:

| input | output |
|---|---|
| `D:\dsh` | `--D-dsh--` |
| `D:\示例目录` | `--D-~793A~4F8B~76EE~5F55--` |
| `D:\dsh\dsh-session-manager` | `--D-dsh-dsh-session-manager--` |
| `/home/user/proj` | `--home-user-proj--` |
| `D:/mixed\sep` | `--D-mixed-sep--` |
| `C:\a~b` | `--C-a~007Eb--` |
| `\\server\share` | `--server-share--` |
| `.` | `--.--` |
| `..` | `--..--` |
| `` (empty) | **throws** `cannot encode an empty project path` |

`encodeSegment(id)`:

| input | output |
|---|---|
| `session-11111111-2222-4333-8444-555555555555` | `session-11111111-2222-4333-8444-555555555555` |
| `44444444-3333-4222-8111-000000000000` | `44444444-3333-4222-8111-000000000000` |
| `..` | `~002E~002E` |
| `.` | `~002E` |
| `a/b` | `a~002Fb` |
| `a\b` | `a~005Cb` |
| `a~b` | `a~007Eb` |
| `~002E~002E` | `~007E002E~007E002E` |
| `` (empty) | **throws** `cannot encode an empty path segment` |

Cross-checked against the real tree: `D:\dsh` → directory `--D-dsh--` and `D:\示例目录` →
`--D-~793A~4F8B~76EE~5F55--` both exist under `C:\Users\shuixing\.dsh\sessions\`. The vectors above are
therefore validated against ground truth, not just self-consistent.

`_no-cwd` branch: `cwd === undefined` → `join(root, "_no-cwd")` → `<home>/sessions/_no-cwd/<encodeSegment(id)>`.
No such directory exists in the live tree today, but the branch is live code — handle it.

## Re-implementation used by `lib/store.js`

```js
// Identical logic; only the throw messages and formatting differ.
export function encodeSegment(raw) { /* ...verbatim body... */ }
export function projectKey(cwd)    { /* ...verbatim body... */ }
export function sessionPath(home, cwd, id) {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd);
  return path.join(home, 'sessions', project, encodeSegment(id));
}
```

Because `encodeSegment` is injective and cannot emit a separator, and `projectKey` cannot emit one
either, the built path is guaranteed to be exactly two components below `<home>/sessions` — no
`..` can survive. `lib/store.js` still re-asserts this defensively (basename === id, resolved path
inside `<home>/sessions`) before any removal, and falls back to an **exact-name** scan when the
predicted path does not exist (e.g. a log written by an older encoder or a `cwd` recorded with
different casing).

---

# Accessors needed for the listing (Task B)

## Live-session accessor (corrected)

`ctx.sessions` — the in-memory store — **does** provide exactly the two accessors the task assumed:

```ts
// ctx.sessions  ("In-memory session store")
get(id: SessionId): Session | undefined        // -> "Look up a live session."
list(): Session[]                              // -> "All live sessions, in creation order."
async flush(session: Session): Promise<boolean> // THE flush entry point (awaits `session/flush`)
```

Note `flush` takes the **`Session` object**, not an id, and returns `boolean` (whether any durability
listener participated) — it does not reject on "nothing to flush". So the live check and the flush are:

```js
const session = ctx.sessions?.get?.(id);          // Session | undefined  == is it live?
if (session) await ctx.sessions.flush(session);   // durability barrier before touching files
```

`Session` exposes its id as **`session.id`** (`SessionId` branded string) and its header as
`session.header`. If you need it from the Agent side instead, `ctx.agents.get(id)` returns
`Agent | undefined`; `ctx.agents.list()` gives every live agent. Both routes are valid — prefer
`ctx.sessions.get(id)` because it is the store the log writer is attached to.

The previous draft of this document claimed `ctx.sessions` had no `get`/`flush`; that was wrong.
`lib/store.js` uses `ctx.sessions.get(id)` / `ctx.sessions.flush(session)` directly, with `?.`
guards and a fallback to `ctx.sessionPersistence.flush()` only if the store accessor is absent.

## Title snapshot shape

```ts
interface SessionTitleSnapshot extends SessionTitleEventData {
    readonly eventSeq: SessionSeq;
    readonly updatedAt: number;
}
interface SessionTitleEventData {
    readonly title: string;              // <-- the string field
    readonly messageSeqs: SessionSeq[];
    readonly source: SessionTitleSource; // {kind:'fallback'} | {kind:'provider',...} | {kind:'user'}
}
```

The field is **`.title`** (a plain `string`), *not* `.value` / `.text`.

Batch read returns a discriminated union that isolates per-session failures:

```ts
readTitleSnapshots(sessionIds, signal?): Promise<SessionTitleObservationResult[]>
type SessionTitleObservationResult =
  | { sessionId: SessionId; status: 'fulfilled'; value: SessionTitleObservation }  // value.title?: SessionTitleSnapshot
  | { sessionId: SessionId; status: 'rejected';  reason: unknown }
```

So the title is at **`result.value.title`**, and it is **optional** — a session with no title event
yields `value.title === undefined` even on `fulfilled`. Results preserve first-occurrence input order.
`readTitle(id)` returns the snapshot directly (`SessionTitleSnapshot | undefined`), throwing on
operational failure; `readTitleSnapshots` is the right call for a list view.

## Listing fields recap (authoritative source)

```ts
ctx.sessionPersistence.list(options?: {signal?}) : Promise<readonly SessionPersistenceSnapshot[]>
interface SessionPersistenceSnapshot {
    readonly header: SessionHeader;      // header.id / .cwd / .createdAt / .parentSession / .origin / .agentPreset
    readonly formatStatus?: 'current' | 'migration-required';
    readonly revision: SessionPersistenceRevision;
    readonly eventCount?: number;
    readonly sizeBytes?: number;         // <-- "bytes"
}
```

There is **no** top-level `id`/`cwd`/`mtime`/`bytes` and no `mtime` anywhere — the snapshot carries
`sizeBytes` and the header's `createdAt`. `list()` is in "no promised order"; `sessionQuery.listSessions()`
is the newest-first variant. `archived`/`pinned` are in `storages/workspace.json`
`global.archivedSessionIds` / `global.pinnedSessionIds`.
