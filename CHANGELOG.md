# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-21

### Added

- **「最后使用」时间**：每一行同时显示 **最后使用**（会话日志最后写入时间，取 `session.v4.jsonl.zstd`
  的 mtime）与 **创建于** 时间，都是本地绝对时间（`YYYY-MM-DD HH:mm`），悬停显示精确到秒；
  「最后使用」还带相对时间提示（`· 3 小时前`）。宿主侧 `list`/`resolve` 行新增 `updatedAt` 字段，
  列表也改为按最后使用排序（与侧边栏一致）。
- 搜索框现在也能匹配时间文本（例如输入 `2026-11`）。
- 会话标题为空时不再把 id 当标题显示，改为「未命名会话」占位 + 单独的等宽 id 徽标。

### Fixed

- **误删看不见的会话**：勾选「不在侧边栏」展开后选中的会话，在收起该作用域后仍留在选择集里，
  点删除会删掉**当前不可见**的会话。现在收起作用域会清理这些选择；若选择集里仍有被搜索条件
  隐藏的项，底部会显示「（N 项不在当前筛选）」提示。
- 提示条不再被随后的列表刷新立即抹掉（先 `load()` 再 `setNotice()`）。
- 空删除请求（`sessionIds: []`）不再创建一个只有 `manifest.json` 的空备份目录。
- 「找不到这个会话」的错误信息补充了可能原因（已删除 / 不属于当前 DSH_HOME）。

### Tests

- `host-e2e` **38/38**（新增：所有真实会话都必须带 `updatedAt`、列表按最后使用排序、空请求不建备份目录）。
- `client-check` 全绿（新增：最后使用时间渲染、作用域收起时清理选择）。

## [0.1.3] — 2026-11-15

### Fixed

- **强制刷新会话/工作区列表**：客户端插件 ctx 是**受限上下文**，直接 `ctx.get('sessions')`
  在真实客户端里拿不到会话服务，因此 0.1.1/0.1.2 的「删完自动刷新」可能被静默跳过，
  被删的会话就留在侧边栏的「未分组」里。现在改为官方注入方式
  `ctx.inject(['sessions'], …)` 取得刷新入口，删除后立即 `sessions.refresh()`
  （并再补一次 +700 ms 的延迟刷新），让被删会话从列表里彻底消失。
- 刷新不可用时不再静默：对话框会显示「（侧边栏刷新不可用，刷新页面即可）」。

### 测试

- 新增 `(h)` 组：在受限 ctx（`ctx.get('sessions')` 返回 undefined）下，刷新仍必须经
  `ctx.inject(['sessions'])` 成功执行。

## [0.1.2] — 2026-11-14

### Fixed

- **删除后的会话不再「暂存」到未分组（未设定工作区）。** 侧边栏把所有「不属于任何工作区」的会话
  收进未分组，而旧顺序是「先摘工作区、再删文件」：客户端缓存的列表还没刷新时，这条会话会先跳进
  未分组再消失。现在删除顺序改为
  **删磁盘 → 摘工作区 → 清 archived/pinned → 广播 `api-session/removed`**：
  - 文件先消失，宿主的会话清单（读取时实时扫描磁盘）不再包含它；
  - 再通过官方 `Workspace.detachSession()` 更新工作区（内存 + `workspace.json` + `domain/changed`）；
  - 最后广播 `api-session/removed`，所有已连接页面立即把该行从会话列表里删掉，
    不需要等刷新、更不需要重启。
- 前端在删除成功后额外做一次延迟刷新（+700ms），覆盖宿主索引/清单的异步收敛。

### 测试

- `host-e2e` 新增断言：删除后必须广播 `api-session/removed` 且携带被删 id（36/36）。

## [0.1.1] — 2026-11-14

### Added

- **删除后自动刷新会话列表。** 删除成功后：
  - 宿主通过官方的 `Workspace.detachSession()`（workspace domain 的写链）把会话从工作区摘掉，
    内存快照与 `workspace.json` 同步更新并派发 `domain/changed` —— 子会话/会话行**不需要重启**
    就会从侧边栏消失（之前只清磁盘文件，界面要等重启）。
  - 前端再主动调用客户端的 `sessions.refresh()` 拉一次列表（覆盖事件丢失、页面在后台等情况），
    弹窗内列表同样自动重载。
  - 对话框会显示「已刷新侧边栏会话列表」的状态提示；手动「刷新列表」按钮也会同时刷新侧边栏。
  - 删除结果里的 `scrubbed` 新增 `workspace:detached` / `registry-refreshed` 标记。

### Fixed

- 刷新助手早期在模块作用域里引用了 `hostCtx()`（那只在对话框作用域内可用），导致自动刷新静默
  失效；现在由调用方传入当前插件上下文。

## [0.1.0] — 2026-11-14

First public release. A DeepSeek Harness plugin that permanently deletes chat
sessions, with backup-first safety and a searchable multi-select UI.

### Added

- **Host half** (`lib/index.js`, `lib/store.js`)
  - Authoritative session listing from `sessionPersistence` (not `workspace.json`,
    which misses sessions that are not part of a workspace).
  - Real session titles resolved through `sessionTitle` → `sessionQuery.readTitleSnapshots`
    → projection-cache record → legacy unit file, with `titleSource` reported per row.
  - Id-driven `resolve(sessionIds)`: metadata for exactly the ids the page already knows
    (accepts an array, `{ sessionIds }`, `{ ids }`, or a comma-separated string; invalid ids
    are returned in `rejected[]` instead of failing the call; capped at 500 per call).
  - Backup-before-delete: session directory, projection-cache document (plus `.bak` siblings)
    and the two storage unit files are copied to
    `<DSH_HOME>/session-delete-backup/<timestamp>/` with a `manifest.json`.
    A failed backup aborts the deletion (fail-closed).
  - Deletion: whole session directory (both `session.v4.jsonl.zstd` and legacy
    `session.jsonl.zstd`), per-record projection cache, legacy `session_projcache.json`
    row, and every reference in `workspace.json` (`sessionIds`,
    `archivedSessionIds`, `pinnedSessionIds`) with a `.bak-<stamp>` kept before rewriting.
  - Guards: the current session, its descendants, and running sessions (unless
    `allowActive`) are refused; session ids are validated and every path is contained
    inside `<DSH_HOME>/sessions`.
  - Refuses to rewrite `workspace.json` while `global.pendingMutation` is set, and reports
    the skip honestly (`workspace:pending-mutation`).
  - HTTP endpoints registered through `ctx.webServer`: `GET /status`, `GET /token`,
    `GET /list`, `POST /resolve`, `POST /delete`, plus `GET /client.js` and `GET /boot.js`
    for the UI bundle. Registration waits for the `webServer` service with
    `ctx.inject(['webServer'], …)` — a plugin row mounts before the web server exists, and a
    one-shot `ctx.get('webServer')` at apply time is the race that used to leave the routes
    missing until a restart.
  - Security fence on every route: loopback/same-origin only, `application/json` required for
    writes, 64 KB body cap, CORS mirrored only for loopback origins, and — for the Electron
    desktop shell, whose `dsh-app://app` proxy strips `Origin`/`Sec-Fetch-Site` and re-injects
    the host cookie — the host cookie is accepted as same-origin evidence.
  - Optional, fail-soft Remote namespace (`ctx.remote.dshSessionManager.list/resolve/delete`)
    for builds where the typert protocol package is resolvable from the plugin.

- **Client half** (`client.js`)
  - A classic-script bundle (`window.__ModuleLoader__.load({ id, factory })`) that also works
    when loaded as a plain `<script src="…/boot.js">` (no module loader present).
  - Entry points: a session-row **“…” menu item** (`sidebar.workspaces.session.menu.item`,
    id `dsh-session-manager.delete`, order 500) and a **sidebar footer action** for bulk cleanup.
  - Dialog with search, multi-select, select-all, an “outside the sidebar” scope toggle, manual
    session-id entry, a backup switch, a “force delete running sessions” switch, per-id results,
    the backup directory, and a restart hint.
  - Rows show the **real session name**, a monospace session id, an absolute local timestamp
    (`YYYY-MM-DD HH:mm`, full timestamp in the tooltip), size, cwd, and badges for
    running / archived / orphan / protected / **child of a parent session** / **parent with N
    children**. Parents are listed immediately followed by their children.
  - Sessions that are not in the sidebar (sub-conversations and orphan records) are hidden by
    default and revealed by the scope toggle.
  - Transport chain: same-origin HTTP (the Electron proxy path) → neighbouring loopback ports →
    known loopback bases → a local listing file; no fabricated calls and no silent failures.
  - Automatic retry (4 × 400 ms) when the host is up but the plugin routes are not registered yet,
    so the first open after a restart no longer shows an error.

### Known limitations

- The running Host keeps `workspace` and `session_projcache` in memory, so the UI may need a
  refresh (or restart) before a deleted session disappears from the sidebar, even though the
  files are removed immediately. The delete result carries `restartRecommended: true`.
- Deleting a parent does not cascade to its children; they become individually deletable orphans.
- Backup directories are never pruned automatically.
- The Remote namespace is optional and experimental; the HTTP channel is the verified path.

[0.2.0]: https://github.com/shuixing14/dsh-session-manager/releases/tag/v0.2.0
[0.1.3]: https://github.com/shuixing14/dsh-session-manager/releases/tag/v0.1.3
[0.1.2]: https://github.com/shuixing14/dsh-session-manager/releases/tag/v0.1.2
[0.1.1]: https://github.com/shuixing14/dsh-session-manager/releases/tag/v0.1.1
[0.1.0]: https://github.com/shuixing14/dsh-session-manager/releases/tag/v0.1.0
