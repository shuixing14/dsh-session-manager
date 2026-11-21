// dsh-session-manager —— Host half.
//
// 给浏览器半段（client.js）提供两个能力：
//
//   A. 本插件自己的 HTTP 端点（生产通道：浏览器半段是普通页面脚本，拿不到 Host 对象）
//        GET  /dsh-session-manager/status  -> { ok, version, home, pid, ... }
//        GET  /dsh-session-manager/list    -> { sessions, home, currentSessionId }
//        POST /dsh-session-manager/resolve <- { sessionIds } -> { sessions }（只读，不删）
//        POST /dsh-session-manager/delete  <- { sessionIds, backup, allowActive }
//                                         -> { results, backupDir, restartRecommended }
//      端点自带信任栅栏：只接受回环 / 同源请求；写请求还要求 application/json。
//      预检（OPTIONS）返回 204 + 镜像 Origin 的 CORS 头。
//
//   B. Remote 命名空间（若本 DSH 版本存在 typert 网关，则额外以 dshSessionManager 服务暴露）
//        list() / resolve(sessionIds) / delete(request)
//      注意：Remote 通道依赖插件能解析到 @deepseek-ai/cordis 与 @deepseek-ai/dsh-typert-protocol。
//      在 packaged Desktop 运行时里，app-boot 的 profile resolution 会把这两个「installation」
//      包从符号链接插件路由进 app.asar，普通 Node 加载不了 → 动态 import 被拒绝。因此 Remote
//      一律 fail-soft：解析不到就只记一条警告，HTTP 端点始终是主通道。
//
// “使用读取 sessionid”：界面侧只需要拿它已经知道的会话 id（侧栏 / 页面上已有的行）向宿主
// 要这些 id 的元数据，不必依赖一次完整 /list。POST /resolve 与 Remote resolve() 就是这条路径：
// 逐 id 用 sessionPersistence.stat()，缺失的 id 回 { id, missing: true }（外加残留的投影缓存
// 记录，即 orphan），这样界面不会因为一个 404 的 /list 而完全退化。
//
// 为什么需要自己实现删除：
//   DSH 目前没有删除会话的 API —— sessionPersistence 只有 create/open/flush/stat/list，
//   workspaceRegistry.delete() 只删“工作区登记”并显式保留会话日志，“归档”也只是可逆的隐藏。
//   所以删除只能是文件系统操作，顺序如下：
//     1. sessionPersistence.list() 拿权威清单（workspace.json 不是会话索引）
//     2. 拒绝当前会话及其子会话；默认拒绝还开着 / 正在跑的会话
//     3. 先把要动的一切复制进 <home>/session-delete-backup/<时间戳>/，失败即中止（fail-closed）
//     4. 删会话目录（同一目录可能同时有 v4 与旧 v0 两份日志），再删投影缓存文档
//     5. 最后摘掉 workspace 单位里对它的引用（并留 .bak-<时间戳>）
//
// 存储单位的真实布局（来自 dsh-storage-json）：
//   `workspace`            single 布局  -> <home>/storages/workspace.json（整份）
//   `session_projcache`    per-record  -> <home>/storages/session_projcache/sessions/<id>.json
//   旧的整体文件 <home>/storages/session_projcache.json 只在存在且含该键时才清理，且留备份。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { refreshAfterDelete } from './store.js'

export const name = 'dsh-session-manager'

// 只硬依赖持久化服务：它是会话清单的唯一权威来源。
export const inject = ['sessionPersistence']

const ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|session-[0-9a-f-]{8,})$/i

/* ------------------------------------------------------------------ *
 * 路径编码：与 dsh-session-persistence-jsonl 逐字一致（见 research/encoders.md）
 * ------------------------------------------------------------------ */

export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

const sessionsRoot = (home) => path.join(home, 'sessions')
const storagesRoot = (home) => path.join(home, 'storages')

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

function ensureBackup(file, backupDir, relative) {
  if (!backupDir || !fs.existsSync(file)) return
  const dest = path.join(backupDir, relative)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(file, dest)
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

/** 每次删除一个独占的备份目录：同一秒内的多次调用也不会互相覆盖清单与编辑前副本。 */
function uniqueBackupDir(home) {
  const root = path.join(home, 'session-delete-backup')
  fs.mkdirSync(root, { recursive: true })
  const base = stamp()
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-${attempt + 1}`
    const dir = path.join(root, name)
    try {
      fs.mkdirSync(dir) // 非递归：已存在就抛 EEXIST，换下一个名字
      return dir
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('无法创建备份目录：同一秒内冲突过多')
}

/**
 * 会话目录的体积与**最后写入时间**。后者就是「最后使用时间」的数据来源：
 * 每轮对话都会往 session.v4.jsonl.zstd 追加内容，文件 mtime 因此随使用而更新。
 * @returns {{ bytes: number, mtime: number | null }} mtime 为 0/null 表示拿不到
 */
function dirStats(dir) {
  let bytes = 0
  let mtime = null
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const nested = dirStats(p)
        bytes += nested.bytes
        if (nested.mtime !== null && (mtime === null || nested.mtime > mtime)) mtime = nested.mtime
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(p)
          bytes += stat.size
          const written = stat.mtimeMs
          if (typeof written === 'number' && Number.isFinite(written) && (mtime === null || written > mtime)) mtime = written
        } catch {}
      }
    }
  } catch {}
  return { bytes, mtime }
}

function dirBytes(dir) {
  return dirStats(dir).bytes
}

/** 由 cwd 精确推导会话目录；推导不到时在 sessions/ 下做“目录名完全相等”的兜底扫描。 */
export function locateSessionDir(home, sessionId, cwd) {
  const root = sessionsRoot(home)
  if (typeof cwd === 'string' && cwd.length > 0) {
    try {
      const candidate = path.join(root, projectKey(cwd), encodeSegment(sessionId))
      if (isDirectory(candidate)) return candidate
    } catch {}
  }
  const noCwd = path.join(root, '_no-cwd', encodeSegment(sessionId))
  if (isDirectory(noCwd)) return noCwd
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = path.join(root, entry.name, sessionId)
    if (isDirectory(child)) return child
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 会话清单
 * ------------------------------------------------------------------ */

function liveState(ctx) {
  const open = new Map()
  const running = new Set()
  let sessions = []
  try {
    sessions = ctx.get?.('sessions')?.list?.() ?? []
  } catch {}
  for (const session of sessions) {
    try {
      const id = session?.id ?? session?.header?.id
      if (typeof id === 'string') open.set(id, session)
    } catch {}
  }
  let agents = []
  try {
    agents = ctx.get?.('agents')?.list?.() ?? []
  } catch {}
  for (const agent of agents) {
    try {
      const id = agent?.session?.id ?? agent?.id
      if (typeof id !== 'string') continue
      if (agent.running === true || agent.status === 'running' || agent.busy === true) running.add(id)
    } catch {}
  }
  return { open, running }
}

/* ------------------------------------------------------------------ *
 * 会话标题
 * ------------------------------------------------------------------ */

/**
 * 从投影缓存的一条 title 行里取出标题文本。
 *
 * dsh-context 自己的读法是：
 *   typeof row?.rows?.title?.val?.title === 'string' ? row.rows.title.val.title : row.rows.title.val
 * 也就是说 `val` 既可能是 `{ title: '…' }`，也可能就是裸字符串。两种都要认。
 * 实测本机 14 个文档里 12 个是裸字符串、2 个是 `null`（从未改名的会话）。
 */
function titleOfVal(val) {
  if (typeof val === 'string') return val.trim()
  if (val && typeof val === 'object' && typeof val.title === 'string') return val.title.trim()
  return ''
}

/**
 * 标题读取的短缓存：resolve 分块调用时不会每块都重新读 200 个文件。
 * key = id，value = { title, source, at }。TTL 2s，够覆盖一次列表/分块的连续调用，
 * 又不至于让「刚改名」在界面上卡太久。
 */
const TITLE_CACHE_TTL_MS = 2000
const TITLE_CACHE_MAX = 4096
const titleCache = new Map()

function titleCacheGet(id) {
  const hit = titleCache.get(id)
  if (!hit) return undefined
  if (Date.now() - hit.at > TITLE_CACHE_TTL_MS) {
    titleCache.delete(id)
    return undefined
  }
  return hit
}

function titleCacheSet(id, title, source) {
  if (titleCache.size >= TITLE_CACHE_MAX) {
    // 简单的容量上限：丢掉最旧的一批，避免长期运行时无界增长。
    let drop = Math.ceil(TITLE_CACHE_MAX / 4)
    for (const key of titleCache.keys()) {
      titleCache.delete(key)
      if (--drop <= 0) break
    }
  }
  titleCache.set(id, { title, source, at: Date.now() })
}

/** 测试与调试用：清空标题缓存（导出便于 harness 断言缓存行为）。 */
export function clearTitleCache() {
  titleCache.clear()
}

/**
 * 按固定优先级读取一批会话的标题，返回 Map<id, { title, source }>。
 *
 * 优先级（第一个非空者胜出）：
 *   1. live  —— ctx.sessionTitle.get(session)：正在内存里的会话，最权威、最新；
 *   2. query —— sessionQuery.readTitleSnapshots(ids)：折叠日志得到的权威快照。
 *               注意结果形状是 { sessionId, status, value: { session, title? } }，
 *               而 value.title 是 **SessionTitleSnapshot 对象**（{title, messageSeqs, source, eventSeq, updatedAt}），
 *               不是字符串 —— 旧代码在这里 `typeof title === 'string'` 判断，于是每一行都被丢掉。
 *   3. cache —— 投影缓存 per-record 文档 <home>/storages/session_projcache/sessions/<id>.json
 *               的 record.rows.title.val（可能被折叠成空，见 titleOfVal）；
 *   4. cache —— 旧的整体文件 <home>/storages/session_projcache.json 的 tables.sessions[id].rows.title.val；
 *   5. none  —— 空字符串。
 *
 * 任何一步失败都只降级到下一层：标题缺失绝不能让列表/删除整体失败。
 */
async function readTitles(ctx, ids) {
  const out = new Map()
  if (!Array.isArray(ids) || ids.length === 0) return out
  const home = dshHome()
  const pending = []
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue
    const cached = titleCacheGet(id)
    if (cached !== undefined) {
      out.set(id, { title: cached.title, source: cached.source })
      continue
    }
    pending.push(id)
  }
  if (pending.length === 0) return out

  const resolved = new Map()

  // 1) 活会话：ctx.sessionTitle.get(session) 是最新的（刚改名立刻可见）。
  try {
    const sessionTitle = ctx.get?.('sessionTitle')
    const sessions = ctx.get?.('sessions')
    if (sessionTitle && typeof sessionTitle.get === 'function' && sessions && typeof sessions.get === 'function') {
      for (const id of pending) {
        try {
          const session = sessions.get(id)
          if (!session) continue
          const title = sessionTitle.get(session)
          if (typeof title === 'string' && title.trim()) resolved.set(id, { title: title.trim(), source: 'live' })
        } catch {}
      }
    }
  } catch {}

  // 2) 权威快照：sessionQuery.readTitleSnapshots
  const remaining = pending.filter((id) => !resolved.has(id))
  if (remaining.length > 0) {
    try {
      const query = ctx.get?.('sessionQuery')
      if (query && typeof query.readTitleSnapshots === 'function') {
        const results = await query.readTitleSnapshots(remaining)
        for (const result of results ?? []) {
          const id = result?.sessionId
          if (typeof id !== 'string' || resolved.has(id)) continue
          if (result?.status === 'rejected') continue
          // value = { session, title?: SessionTitleSnapshot }；title 是对象，真正的文本在 .title.title
          const snapshot = result?.value?.title
          const text = typeof snapshot === 'string' ? snapshot : snapshot && typeof snapshot === 'object' ? snapshot.title : undefined
          if (typeof text === 'string' && text.trim()) resolved.set(id, { title: text.trim(), source: 'query' })
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-session-manager] 读取会话标题失败（降级到投影缓存）：${String(error)}`)
    }
  }

  // 3) 投影缓存 per-record 文档
  const mirrorDir = path.join(storagesRoot(home), 'session_projcache', 'sessions')
  const stillMissing = pending.filter((id) => !resolved.has(id))
  for (const id of stillMissing) {
    try {
      const doc = readJson(path.join(mirrorDir, `${id}.json`))
      const title = titleOfVal(doc?.record?.rows?.title?.val)
      if (title) resolved.set(id, { title, source: 'cache' })
    } catch {}
  }

  // 4) 旧的整份 session_projcache.json（只在还有 id 没解出来时才读，避免每次全量解析）
  const afterMirror = pending.filter((id) => !resolved.has(id))
  if (afterMirror.length > 0) {
    const legacyRows = readJson(path.join(storagesRoot(home), 'session_projcache.json'))?.tables?.sessions
    if (legacyRows && typeof legacyRows === 'object') {
      for (const id of afterMirror) {
        try {
          const title = titleOfVal(legacyRows[id]?.rows?.title?.val)
          if (title) resolved.set(id, { title, source: 'cache' })
        } catch {}
      }
    }
  }

  // 5) 兜底：空标题。**空结果不缓存**——否则一次瞬时失败（服务还没就绪、日志刚写入
  //    标题、查询被 stub 掉）会把「没有标题」钉住整个 TTL，比不缓存更糟。
  //    只有真正读到的标题才进缓存。
  for (const id of pending) {
    const hit = resolved.get(id)
    if (hit === undefined) {
      out.set(id, { title: '', source: 'none' })
      continue
    }
    titleCacheSet(id, hit.title, hit.source)
    out.set(id, hit)
  }
  return out
}

function workspaceIndex(home) {
  const file = path.join(storagesRoot(home), 'workspace.json')
  const unit = readJson(file)
  const list = (value) => (Array.isArray(value) ? value : [])
  const inWorkspace = new Set()
  const workspaces = unit?.tables?.workspaces && typeof unit.tables.workspaces === 'object' ? unit.tables.workspaces : {}
  for (const record of Object.values(workspaces)) for (const id of list(record?.sessionIds)) inWorkspace.add(id)
  return {
    file,
    archived: new Set(list(unit?.global?.archivedSessionIds)),
    pinned: new Set(list(unit?.global?.pinnedSessionIds)),
    pendingMutation: unit?.global && typeof unit.global === 'object' ? unit.global.pendingMutation : undefined,
    inWorkspace,
  }
}

function projectionRecordIds(home) {
  const ids = new Set()
  try {
    const dir = path.join(storagesRoot(home), 'session_projcache', 'sessions')
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -'.json'.length)
      if (ID_RE.test(id)) ids.add(id)
    }
  } catch {}
  // 旧的整体文件里只在这一个会话才有记录的情况也列出来，保证可清理
  const legacy = readJson(path.join(storagesRoot(home), 'session_projcache.json'))
  const rows = legacy?.tables?.sessions
  if (rows && typeof rows === 'object') for (const id of Object.keys(rows)) if (ID_RE.test(id)) ids.add(id)
  return ids
}

/** 一行会话的完整字段集（list 与 resolve 共用）：client.js 只认这一种行形状。 */
function rowBase(id, workspace, live) {
  return {
    id,
    title: '',
    // 标题来源：'live' | 'query' | 'cache' | 'none'，界面可据此显示占位文案。
    titleSource: 'none',
    cwd: null,
    createdAt: null,
    // 最后使用时间（会话日志最后写入时间；拿不到时为 null）
    updatedAt: null,
    parentId: null,
    origin: null,
    agentPreset: null,
    eventCount: null,
    bytes: 0,
    dir: null,
    archived: workspace.archived.has(id),
    pinned: workspace.pinned.has(id),
    inWorkspace: workspace.inWorkspace.has(id),
    open: live.open.has(id),
    running: live.running.has(id),
    orphan: false,
    missing: false,
  }
}

/** 由 snapshot（sessionPersistence.list/stat 的返回值）填出一行。 */
function rowFromSnapshot(home, snapshot, workspace, live) {
  const header = snapshot?.header
  const id = typeof header?.id === 'string' ? header.id : undefined
  if (!id) return null
  const dir = locateSessionDir(home, id, typeof header.cwd === 'string' ? header.cwd : undefined)
  const stats = dir ? dirStats(dir) : { bytes: 0, mtime: null }
  return {
    ...rowBase(id, workspace, live),
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
    updatedAt: stats.mtime,
    parentId: typeof header.parentSession === 'string' ? header.parentSession : null,
    origin: typeof header.origin === 'string' ? header.origin : null,
    agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
    eventCount: typeof snapshot?.eventCount === 'number' ? snapshot.eventCount : null,
    bytes: typeof snapshot?.sizeBytes === 'number' ? snapshot.sizeBytes : stats.bytes,
    dir,
  }
}

/** 僵尸行：日志已不在，但投影缓存里还留着（可单独清理）。 */
function orphanRow(home, id, workspace, live) {
  const mirror = readJson(path.join(storagesRoot(home), 'session_projcache', 'sessions', `${id}.json`))
  const legacy = readJson(path.join(storagesRoot(home), 'session_projcache.json'))?.tables?.sessions
  const identity = mirror?.record?.identity ?? legacy?.[id]?.identity ?? null
  let stamp = null
  try {
    const stat = fs.statSync(path.join(storagesRoot(home), 'session_projcache', 'sessions', `${id}.json`))
    if (Number.isFinite(stat.mtimeMs)) stamp = stat.mtimeMs
  } catch {}
  return {
    ...rowBase(id, workspace, live),
    cwd: typeof identity?.cwd === 'string' ? identity.cwd : null,
    createdAt: typeof identity?.createdAt === 'number' ? identity.createdAt : null,
    updatedAt: stamp,
    orphan: true,
  }
}

/** 按 parentId 补 children（只在给定集合内互认，避免把范围外的 id 当成子行）。 */
function attachChildren(sessions) {
  const byId = new Map(sessions.map((info) => [info.id, info]))
  const children = new Map()
  for (const info of sessions) {
    if (!info.parentId || !byId.has(info.parentId)) continue
    if (!children.has(info.parentId)) children.set(info.parentId, [])
    children.get(info.parentId).push(info.id)
  }
  for (const info of sessions) info.children = children.get(info.id) ?? []
  return sessions
}

function currentSessionIdOf(ctx) {
  try {
    const initiator = ctx.get?.('agents')?.currentInitiator?.()
    return initiator?.session?.id ?? initiator?.id ?? null
  } catch {
    return null
  }
}

async function listSessionInfos(ctx) {
  const home = dshHome()
  const snapshots = (await ctx.sessionPersistence.list()) ?? []
  const workspace = workspaceIndex(home)
  const live = liveState(ctx)
  const byId = new Map()
  const ids = []

  for (const snapshot of snapshots) {
    const row = rowFromSnapshot(home, snapshot, workspace, live)
    if (!row) continue
    ids.push(row.id)
    byId.set(row.id, row)
  }

  const titles = await readTitles(ctx, ids)
  for (const [id, hit] of titles) {
    const info = byId.get(id)
    if (!info) continue
    info.title = hit.title
    info.titleSource = hit.source
  }

  for (const id of projectionRecordIds(home)) {
    if (byId.has(id)) continue
    byId.set(id, orphanRow(home, id, workspace, live))
  }

  const sessions = attachChildren([...byId.values()])
  // 最近使用优先：侧边栏本身按最后活动排序，这里保持一致。
  const recency = (row) => (typeof row.updatedAt === 'number' ? row.updatedAt : row.createdAt) ?? 0
  sessions.sort((a, b) => recency(b) - recency(a))
  return { sessions, home, currentSessionId: currentSessionIdOf(ctx), pendingMutation: workspace.pendingMutation }
}

/* ------------------------------------------------------------------ *
 * resolve —— “使用读取 sessionid”：只要给定 id 的元数据
 * ------------------------------------------------------------------ */

/** 单次 resolve 的上限（一次调用里最多查这么多 id）。 */
const RESOLVE_LIMIT = 500

/** 把任意入参规格化成 id 数组：数组 / { sessionIds } / 逗号分隔字符串。 */
function normalizeIds(input) {
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') {
    if (Array.isArray(input.sessionIds)) return input.sessionIds
    if (Array.isArray(input.ids)) return input.ids
    if (typeof input.sessionIds === 'string') return input.sessionIds.split(',')
  }
  if (typeof input === 'string') return input.split(',')
  return []
}

/**
 * 只查给定 id 的元数据，绝不整份扫描：
 *   - 每个 id 先过 ID_RE，非法 id 记进 rejected[]（单个坏 id 不会拖垮整个调用）
 *   - 去重、按出现顺序保留
 *   - 超过 RESOLVE_LIMIT 的部分进 rejected[]（reason: limit），不静默截断
 *   - ids <= 20 走 sessionPersistence.stat(id)（每 id 一次，便宜）；
 *     ids > 20 走一次 list() 再建索引（避免 500 次 stat）
 *   - 空快照 -> row.missing = true，并附带残留的投影缓存信息（orphan）
 */
async function resolveSessions(ctx, input) {
  const home = dshHome()
  const requested = normalizeIds(input)
  const seen = new Set()
  const ids = []
  const rejected = []
  for (const raw of requested) {
    const id = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim()
    if (id === '') {
      rejected.push({ id: String(raw ?? ''), reason: 'empty' })
      continue
    }
    if (!ID_RE.test(id)) {
      rejected.push({ id, reason: 'invalid-id' })
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    if (ids.length >= RESOLVE_LIMIT) {
      rejected.push({ id, reason: 'limit' })
      continue
    }
    ids.push(id)
  }

  const workspace = workspaceIndex(home)
  const live = liveState(ctx)
  const snapshots = new Map()
  const persistence = ctx.sessionPersistence
  // stat(id) 每 id 一次很便宜，但前提是这一版持久化服务确实提供了 stat；
  // 否则（或被 stub 掉）退回一次 list() 建索引。ids > 20 时 list 也更省。
  const useStat = ids.length <= 20 && typeof persistence?.stat === 'function'
  if (useStat) {
    for (const id of ids) {
      let snapshot
      try {
        snapshot = await persistence.stat(id)
      } catch {
        snapshot = undefined
      }
      if (snapshot) snapshots.set(id, snapshot)
    }
  } else {
    for (const snapshot of (await persistence.list()) ?? []) {
      const id = snapshot?.header?.id
      if (typeof id === 'string' && seen.has(id)) snapshots.set(id, snapshot)
    }
  }

  const rows = []
  const titleIds = []
  for (const id of ids) {
    const snapshot = snapshots.get(id)
    if (snapshot) {
      const row = rowFromSnapshot(home, snapshot, workspace, live)
      if (row) {
        titleIds.push(id)
        rows.push(row)
        continue
      }
    }
    // 没有快照：行依然要回（界面已经知道这个 id），标 missing；投影缓存残留时带 orphan
    const row = orphanRow(home, id, workspace, live)
    if (!snapshot) row.missing = true
    rows.push(row)
  }

  const titles = await readTitles(ctx, titleIds)
  for (const row of rows) {
    const hit = titles.get(row.id)
    if (hit === undefined) continue
    row.title = hit.title
    row.titleSource = hit.source
  }

  attachChildren(rows)
  return {
    sessions: rows,
    rejected,
    home,
    currentSessionId: currentSessionIdOf(ctx),
    pendingMutation: workspace.pendingMutation,
  }
}

function descendantsOf(sessions, rootId) {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const info = byId.get(queue.shift())
    for (const child of info?.children ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  return seen
}

/* ------------------------------------------------------------------ *
 * 备份 + 删除
 * ------------------------------------------------------------------ */

function backupEverything(home, info, backupDir) {
  // 会话目录（可能同时有 v0 / v4 两份日志）
  const dest = path.join(backupDir, 'sessions', path.basename(info.dir ?? info.id))
  if (info.dir) fs.cpSync(info.dir, dest, { recursive: true })
  else fs.mkdirSync(dest, { recursive: true })
  // 投影缓存的 per-record 文档（含 .bak 兄弟）
  const mirrorDir = path.join(storagesRoot(home), 'session_projcache', 'sessions')
  let names = []
  try {
    names = fs.readdirSync(mirrorDir)
  } catch {}
  for (const name of names) {
    if (name !== `${info.id}.json` && !name.startsWith(`${info.id}.json.bak`)) continue
    ensureBackup(path.join(mirrorDir, name), backupDir, path.join('storages', 'session_projcache', name))
  }
  // 两个存储单位的原始文件（workspace.json 是 single 布局；session_projcache.json 可能是旧的整份文件）
  for (const name of ['workspace.json', 'session_projcache.json']) {
    ensureBackup(path.join(storagesRoot(home), name), backupDir, path.join('storages', `${name}.bak`))
  }
  return dest
}

function removeProjectionRecords(home, info, backupDir) {
  let removed = 0
  const mirrorDir = path.join(storagesRoot(home), 'session_projcache', 'sessions')
  let names = []
  try {
    names = fs.readdirSync(mirrorDir)
  } catch {}
  for (const name of names) {
    if (name !== `${info.id}.json` && !name.startsWith(`${info.id}.json.bak`)) continue
    fs.rmSync(path.join(mirrorDir, name), { force: true })
    removed += 1
  }
  // 旧的整体文件：只有确实含这个会话的记录时才改写，改写前留 .bak-<时间戳>
  const legacy = path.join(storagesRoot(home), 'session_projcache.json')
  const unit = readJson(legacy)
  if (unit?.tables?.sessions && typeof unit.tables.sessions === 'object' && Object.hasOwn(unit.tables.sessions, info.id)) {
    delete unit.tables.sessions[info.id]
    ensureBackup(legacy, backupDir, path.join('storages', 'session_projcache.json.bak'))
    fs.copyFileSync(legacy, `${legacy}.bak-${stamp()}`)
    writeJsonAtomic(legacy, unit)
    removed += 1
  }
  return removed
}

function removeSessionDir(home, info) {
  if (!info.dir) return false
  const root = sessionsRoot(home) + path.sep
  const resolved = path.resolve(info.dir)
  if (!resolved.startsWith(root)) throw new Error(`拒绝删除 sessions 目录之外的路径：${resolved}`)
  if (path.basename(resolved) !== info.id) throw new Error(`目录名与会话 id 不一致：${resolved}`)
  if (!isDirectory(resolved)) return false
  fs.rmSync(resolved, { recursive: true, force: true })
  // 项目目录空了就顺手收掉（DSH 需要时会自己重建）；_no-cwd 留给 DSH 管理
  try {
    const projectDir = path.dirname(resolved)
    if (path.basename(projectDir) !== '_no-cwd' && projectDir.startsWith(root) && fs.readdirSync(projectDir).length === 0) fs.rmdirSync(projectDir)
  } catch {}
  return true
}

function scrubWorkspace(home, info) {
  const file = path.join(storagesRoot(home), 'workspace.json')
  const unit = readJson(file)
  if (!unit) return 'workspace:missing'
  // 正在进行的登记变更（例如工作区删除）会由 dsh-workspace 自己整份重写，这时别碰它。
  const pending = unit.global && typeof unit.global === 'object' ? unit.global.pendingMutation : undefined
  if (pending !== undefined && pending !== null) return 'workspace:pending-mutation'
  let changed = false
  if (unit.global && typeof unit.global === 'object') {
    for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
      const list = unit.global[key]
      if (!Array.isArray(list) || !list.includes(info.id)) continue
      unit.global[key] = list.filter((id) => id !== info.id)
      changed = true
    }
  }
  if (unit.tables?.workspaces && typeof unit.tables.workspaces === 'object') {
    for (const record of Object.values(unit.tables.workspaces)) {
      if (!record || typeof record !== 'object' || !Array.isArray(record.sessionIds)) continue
      if (!record.sessionIds.includes(info.id)) continue
      record.sessionIds = record.sessionIds.filter((id) => id !== info.id)
      changed = true
    }
  }
  if (!changed) return 'workspace:none'
  fs.copyFileSync(file, `${file}.bak-${stamp()}`)
  writeJsonAtomic(file, unit)
  return 'workspace'
}

/**
 * 把一条会话从它所属的工作区里摘掉。
 *
 * `Workspace.detachSession(id)` 是 workspace domain 的官方写路径：它经 storage-domain 的写链
 * **同时**更新内存快照与 `workspace.json`，并在提交后派发 `domain/changed`，所以运行中的宿主
 * 与前端列表会立刻看到变化（这也是「删完自动刷新会话列表」的实现方式）。
 * 它对未知 id 是幂等的，也不做存在性校验，因此放在删文件之前调用最稳。
 *
 * @returns 是否真的摘掉了一条归属（没有归属时返回 false）
 */
async function detachFromWorkspace(ctx, sessionId) {
  const registry = ctx.get?.('workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') return false
  let workspaces = []
  try {
    workspaces = registry.list() ?? []
  } catch {
    return false
  }
  for (const workspace of workspaces) {
    let ids = []
    try {
      ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
    } catch {
      ids = []
    }
    if (!ids.includes(sessionId)) continue
    if (typeof workspace.detachSession !== 'function') return false
    try {
      await workspace.detachSession(sessionId)
      return true
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-session-manager] 从工作区摘除 ${sessionId} 失败（稍后按文件清理）：${String(error)}`)
      return false
    }
  }
  return false
}

async function deleteOne(ctx, home, info, options) {
  const scrubbed = []
  if (info.open) {
    const session = ctx.get?.('sessions')?.get?.(info.id)
    if (session) {
      try {
        await ctx.get('sessions').flush(session)
      } catch {}
    }
    if (options.allowActive !== true) throw new Error('会话仍然打开着，请先关闭它再删除')
  }
  if (options.backup) backupEverything(home, info, options.backupDir)
  // 顺序很重要：先删磁盘（让宿主的会话清单下一次读取就不再包含它），
  // 再从工作区摘除并通知所有已连接的页面。
  //
  // 为什么不能先摘除：侧边栏把「不属于任何工作区」的会话收进「未分组」，
  // 若先摘除、文件还在，客户端缓存的列表里这条会话会先**跳到未分组**再消失 —— 显示的正是
  // 用户看到的「删除后的会话暂存在未设定工作区」。
  removeSessionDir(home, info)
  if (removeProjectionRecords(home, info, options.backupDir) > 0) scrubbed.push('projection-cache')
  scrubbed.push(scrubWorkspace(home, info))
  // 官方软接口：经 storage-domain 写链同时更新内存与 workspace.json，并派发 domain/changed。
  if (await detachFromWorkspace(ctx, info.id)) scrubbed.push('workspace:detached')
  // 清 archived / pinned 两个全局集合（幂等软接口）。
  if (await refreshAfterDelete(ctx, [info.id])) scrubbed.push('registry-refreshed')
  // 强制刷新各页面里的会话清单：`api-session/removed` 是会话离开宿主清单时宿主自己播的事件，
  // 客户端收到后会把这一行从列表里删掉（不需要等下一次 refresh，更不需要重启）。
  try {
    ctx.emit?.('api-session/removed', info.id)
    scrubbed.push('clients-notified')
  } catch {}
  return { id: info.id, ok: true, scrubbed }
}

/* ------------------------------------------------------------------ *
 * 删除一批会话
 * ------------------------------------------------------------------ */

async function deleteSessions(ctx, request) {
  const home = dshHome()
  const args = request && typeof request === 'object' ? request : {}
  const requested = Array.isArray(args.sessionIds) ? args.sessionIds : []
  const ids = [...new Set(requested.map(String))]
  const backup = args.backup !== false
  const allowActive = args.allowActive === true
  const listing = await listSessionInfos(ctx)
  const byId = new Map(listing.sessions.map((info) => [info.id, info]))
  const guarded = listing.currentSessionId ? descendantsOf(listing.sessions, listing.currentSessionId) : new Set()
  let backupDir
  let backupError = null
  // 空请求不建备份目录：否则会留下一个只有 manifest.json 的空目录。
  if (backup && ids.length > 0) {
    try {
      backupDir = uniqueBackupDir(home)
    } catch (error) {
      backupError = error instanceof Error ? error.message : String(error)
    }
  }

  const results = []
  for (const id of ids) {
    try {
      if (!ID_RE.test(id)) throw new Error('不是合法的会话 id')
      if (backup && backupDir === undefined) throw new Error(`无法创建备份目录，已放弃删除：${backupError ?? '未知原因'}`)
      if (guarded.has(id)) throw new Error(id === listing.currentSessionId ? '这是当前使用的会话，不能删除' : '这是当前会话的子会话，不能删除')
      const info = byId.get(id)
      if (!info) throw new Error('找不到这个会话（可能已被删除，或不属于当前 DSH_HOME）')
      if (info.running && !allowActive) throw new Error('会话正在运行，请先停止它，或勾选“强制删除”')
      results.push(await deleteOne(ctx, home, info, { backup, backupDir, allowActive }))
    } catch (error) {
      results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (backupDir) {
    const manifest = { deletedAt: new Date().toISOString(), home, sessions: results }
    try {
      fs.writeFileSync(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}
`, 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-session-manager] 写入备份清单失败：${String(error)}`)
    }
  }
  // 尽力让内存里的登记与新磁盘状态一致（投影缓存没有公开的删行接口，这部分要刷新/重启才生效）
  try {
    await refreshAfterDelete(ctx, results.filter((result) => result.ok).map((result) => result.id))
  } catch {}

  return { results, backupDir, restartRecommended: true }
}

/* ------------------------------------------------------------------ *
 * HTTP 端点 + 信任栅栏
 * ------------------------------------------------------------------ */

const ROUTE_BASE = '/dsh-session-manager'
const MAX_BODY_BYTES = 64 * 1024
/** typert 协议里 Remote 方法标记的属性键（与 @deepseek-ai/dsh-typert-protocol 内部一致）。 */
const REMOTE_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

function headerOf(req, name) {
  const value = req?.headers?.[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

function isLoopbackHostname(hostname) {
  const name = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name === '::1') return true
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  return Boolean(parts) && Number(parts[1]) === 127 && parts.slice(2).every((part) => Number(part) <= 255)
}

/**
 * 端点安全判定：页面由本宿主提供，同源请求会带本宿主的 Host/Origin。
 * 只放行回环 Host 或 Origin 与 Host 同地址的请求；拒绝显式跨站标记。
 * 写请求额外要求 application/json（跨站表单无法在不触发预检的情况下伪造它）。
 */
/**
 * 判定「这次请求带着宿主自己签发的凭据」。
 *
 * Electron 桌面壳的 `dsh-app://app` 反代会（见 app.asar/lib/main.js forwardWebRequest）：
 *   · 删掉 host / origin / cookie / sec-fetch-site 四个头；
 *   · 再把宿主 cookie 以 `cookie: <dsh_session=...>` 的形式重新塞回去。
 * 所以这里同时接受 `cookie` 头与 `authorization: Bearer <cookie>`（两种壳版本都覆盖）。
 */
function presentedCookie(req) {
  const cookie = headerOf(req, 'cookie')
  if (typeof cookie === 'string' && cookie.trim() !== '') return cookie.trim()
  const raw = headerOf(req, 'authorization')
  if (typeof raw !== 'string') return ''
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return match ? match[1].trim() : ''
}

/**
 * 桌面端 `dsh-app://app` 页面由 Electron 主进程反代到宿主：它剥掉 Origin/sec-fetch-site、
 * 把宿主 cookie 放进 Authorization: Bearer。这种「代理形状」的请求只要是回环 Host、
 * 且带了本宿主签发的 cookie，就等同于浏览器同源 —— 平台自己的鉴权已经放行过一次。
 */
function proxyShaped(req, authority) {
  if (!isLoopbackHostname(authority.hostname)) return false
  if (headerOf(req, 'origin') !== undefined) return false
  const site = String(headerOf(req, 'sec-fetch-site') || '').toLowerCase()
  if (site !== '' && site !== 'none') return false
  return presentedCookie(req) !== ''
}

/** 把刚才用的是哪种凭据（口令 / cookie）记到响应头里，方便排查。 */
function replyHeaders(req, { write, token }) {
  const pageToken = String(headerOf(req, 'x-dsh-session-manager-token') || '')
  const headers = {}
  if (typeof token === 'string' && token.length > 0 && pageToken === token) headers['X-DSH-Session-Manager-Auth'] = 'token'
  else if (presentedCookie(req) !== '') headers['X-DSH-Session-Manager-Auth'] = 'cookie'
  return headers
}

function requestRejection(req, { write, token }) {
  const pageToken = String(headerOf(req, 'x-dsh-session-manager-token') || '')
  const pagePresented = typeof token === 'string' && token.length > 0 && pageToken === token
  const host = headerOf(req, 'host')
  if (!host) return 403
  let authority
  try {
    authority = new URL(`http://${host}`)
  } catch {
    return 403
  }
  const origin = headerOf(req, 'origin')
  if (typeof origin === 'string' && origin !== 'null') {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return 403
    }
    if (originUrl.host.toLowerCase() !== authority.host.toLowerCase()) return 403
  }
  const site = String(headerOf(req, 'sec-fetch-site') || '').toLowerCase()
  if (site === 'cross-site') return 403
  // `sec-fetch-site: none` 表示「用户直接导航 / 直接加载脚本」这类没有来源的请求，
  // 它**不是**同源证据，绝不能当成浏览器同源放行写操作；按「既无 Origin 也无 fetch-site」
  // 处理：读放行，写仍然要求口令。
  const noSourceEvidence = site === '' || site === 'none'
  const proxyEvidence = write && proxyShaped(req, authority)
  if (write && !pagePresented) {
    // 其他进程也可能通过 127.0.0.1 访问：写请求要么出示落地口令，
    // 要么出示浏览器同源证据（same-origin / same-site）。
    // Electron 的 dsh-app:// 代理会剥掉 Origin 与 sec-fetch-site，这种「代理形状」的请求
    // 只能靠口令放行；没有口令时一律 403（包括 sec-fetch-site: none 的直接导航）。
    if (site !== 'same-origin' && site !== 'same-site' && !proxyEvidence) return 403
  }
  if (!isLoopbackHostname(authority.hostname) && noSourceEvidence) return 403
  if (write) {
    const type = String(headerOf(req, 'content-type') || '').toLowerCase()
    if (!type.startsWith('application/json')) return 415
  }
  return null
}

function sendJson(res, code, body, extra) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(extra && typeof extra === 'object' ? extra : {}),
  })
  res.end(JSON.stringify(body))
}

/** 原始字节响应（JS 资源）：不参与 JSON 序列化，Content-Length 精确到字节。 */
function sendBytes(res, code, body, contentType) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(code, {
    'Content-Type': contentType,
    'Content-Length': String(buffer.length),
    'Cache-Control': 'no-store',
  })
  res.end(buffer)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const value = JSON.parse(text)
  return value && typeof value === 'object' ? value : {}
}

/**
 * 页面口令：插件自己的同源端点用来挡「本机其他进程/脚本」的写入。
 * 口令在一次宿主生命周期内固定（只放进页面 HTML），但会落盘，刷新/重启后前端仍能读到，
 * 因此不会出现「打开会话后仍扫描不到」的问题；文件权限为 0600，删除即失效。
 */
function pluginToken(home) {
  const file = path.join(home, '.dsh-session-manager.token')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9_-]{32,}$/.test(existing)) return { file, token: existing }
  } catch {}
  const token = crypto.randomBytes(24).toString('base64url')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${token}
`, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-manager] 无法写入口令文件（写操作将要求本机回环）：${String(error)}`)
  }
  return { file, token }
}

/** 页面注入行：把口令放进 HTML 的 <script>，前端每次加载都能读到（与宿主重启无关）。 */
function injectPageToken(ctx, token) {
  const webServer = ctx.get?.('webServer')
  if (!webServer) return
  const row = { kind: 'script', placement: 'body', text: `window.__DSH_SESSION_MANAGER_TOKEN__=${JSON.stringify(token)}` }
  if (typeof webServer.tapIndex === 'function') {
    ctx.effect(
      () => webServer.tapIndex((html) => (html.includes('__DSH_SESSION_MANAGER_TOKEN__') ? html : html.replace('</body>', `<script>${row.text}</script></body>`))),
      'dsh-session-manager: index tap',
    )
  }
  ctx.on?.('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      if (table.some((entry) => entry && typeof entry.text === 'string' && entry.text.includes('__DSH_SESSION_MANAGER_TOKEN__'))) return
      table.push(row)
    } catch {}
  })
}

const CORS_ALLOW_HEADERS = 'accept, content-type, x-dsh-session-manager-token'
const CORS_ALLOW_METHODS = 'GET,POST,OPTIONS'
const CORS_MAX_AGE = '600'

/**
 * 预检响应：预检请求不可能带自定义头（浏览器就不允许），所以**不**要求页面口令；
 * 但仍然要求 Host 是回环地址，且 Origin（若有）必须是回环 Origin，
 * 避免把回环端点变成任意站点的可读资源。
 */
function corsPreflight(req, res) {
  const host = headerOf(req, 'host')
  let authority
  try {
    authority = new URL(`http://${host}`)
  } catch {
    sendJson(res, 403, { error: '请求被拒绝（缺少有效的 Host）' })
    return
  }
  if (!isLoopbackHostname(authority.hostname) && !isLoopbackHostname(authority.host)) {
    sendJson(res, 403, { error: '请求被拒绝（非本机回环）' })
    return
  }
  const origin = headerOf(req, 'origin')
  const headers = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
    'Access-Control-Max-Age': CORS_MAX_AGE,
    'Cache-Control': 'no-store',
  }
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      sendJson(res, 403, { error: '请求被拒绝（Origin 无效）' })
      return
    }
    if (!isLoopbackHostname(originUrl.hostname)) {
      sendJson(res, 403, { error: '请求被拒绝（非本机回环 Origin）' })
      return
    }
  }
  // 镜像调用方的 Origin（回环 Origin 就回显它，否则回显本宿主地址）。
  headers['Access-Control-Allow-Origin'] = typeof origin === 'string' && origin !== '' && origin !== 'null' ? origin : authority.origin
  res.writeHead(204, headers)
  res.end()
}

function installRoutes(ctx, base, token) {
  const webServer = ctx.get?.('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[dsh-session-manager] webServer 不可用，HTTP 端点未注册（界面将无法调用）')
    return
  }
  const register = webServer.register.bind(webServer)
  /**
   * 统一的栅栏 + 分发，所有路由共用（含静态资源路由）：
   *   OPTIONS -> 预检（免口令）; 方法不匹配 -> 405; 栅栏 -> 403/415; 其余交给 run。
   * run 返回 { body, contentType } 时按原始字节回（JS 文件），否则按 JSON 回。
   */
  const route = ({ method, path: routePath, status, run }) => {
    const handler = async (req, res) => {
      const actual = String(req.method || 'GET').toUpperCase()
      // 预检先于栅栏：OPTIONS 本身不携带自定义头，按定义不可能满足口令检查。
      if (actual === 'OPTIONS') {
        corsPreflight(req, res)
        return
      }
      // 方法不匹配要先判：否则一个 GET 会因为「没有 application/json」被误报成 415。
      if (method === 'POST' && actual !== 'POST') {
        sendJson(res, 405, { error: '请使用 POST' })
        return
      }
      if (method === 'GET' && actual !== 'GET' && actual !== 'HEAD') {
        sendJson(res, 405, { error: '请使用 GET' })
        return
      }
      const fence = requestRejection(req, { write: method === 'POST', token })
      if (fence !== null) {
        sendJson(res, fence, { error: fence === 415 ? '请求必须使用 application/json' : '请求被拒绝（非本机同源）' })
        return
      }
      try {
        const result = await run(req)
        if (result && typeof result === 'object' && typeof result.contentType === 'string') {
          sendBytes(res, 200, result.body, result.contentType)
          return
        }
        sendJson(res, 200, result, replyHeaders(req, { write: method === 'POST', token }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[dsh-session-manager] ${routePath}: ${message}`)
        sendJson(res, status?.(error) ?? 500, { error: message })
      }
    }
    ctx.effect(() => register({ kind: 'exact', path: routePath, handler }), `dsh-session-manager: route ${routePath}`)
  }
  route({ method: 'GET', path: `${ROUTE_BASE}/status`, run: () => base.call('status', null) })
  // /token：只读地回显页面口令。用途是让通过 Electron dsh-app:// 代理访问的页面
  // 能拿到口令去完成写操作（那条代理会剥掉 Origin 与 sec-fetch-site，也无法加自定义头）。
  // 它本身走的是和其它 GET 完全相同的栅栏（回环 + 同源 Origin），并不是新的信任升级：
  // 能读到它的请求，本来就已经在回环内且（若带 Origin）与本宿主同源。
  route({ method: 'GET', path: `${ROUTE_BASE}/token`, run: () => ({ token: token ?? null }) })
  route({ method: 'GET', path: `${ROUTE_BASE}/list`, run: () => base.call('sessions.list', null) })
  // /resolve 只读，但用 POST 是为了把 id 列表放进 body（id 多时不至于超长 URL），
  // 所以沿用写请求的栅栏（同源 + application/json），不放宽任何判定。
  route({ method: 'POST', path: `${ROUTE_BASE}/resolve`, run: async (req) => base.call('resolve', await readJsonBody(req)) })
  // 静态资源：浏览器半段脚本（Desktop 页面拿不到 dsh.client 时的同源回退通道）。
  route({ method: 'GET', path: `${ROUTE_BASE}/client.js`, status: assetStatus, run: () => ({ ...readClientAsset(), contentType: 'application/javascript; charset=utf-8' }) })
  route({ method: 'GET', path: `${ROUTE_BASE}/boot.js`, status: assetStatus, run: () => ({ ...readBootAsset(), contentType: 'application/javascript; charset=utf-8' }) })
  route({ method: 'POST', path: `${ROUTE_BASE}/delete`, run: async (req) => base.call('deleteSessions', await readJsonBody(req)) })
}

/* ------------------------------------------------------------------ *
 * 静态资源：client.js / boot.js（同源回退通道）
 * ------------------------------------------------------------------ */

/** client.js 的磁盘位置：由模块 URL 推导，永远指向本插件自己的文件。 */
function clientAssetPath() {
  return new URL('../client.js', import.meta.url)
}

/** 资源缺失时用 404（而不是其他路由的 500），供 route() 的 status 钩子使用。 */
function assetStatus(error) {
  return error?.code === 'ENOENT' ? 404 : 500
}

/**
 * 每次请求都重新读盘：改完 client.js 只要刷新页面就能拿到最新字节，不需要重启宿主。
 * 读不到就抛 ENOENT，由 route() 转成 404 + {error}。
 */
function readClientAsset() {
  const body = fs.readFileSync(clientAssetPath())
  return { body, bytes: body.length }
}

/**
 * boot.js = client.js 原文 + 一行标记注释。
 * 为什么不做任何改写：client.js 本身已经通过 `window.__ModuleLoader__.load({id, factory})`
 * 自注册（与 asar 里官方模板一致），宿主端的 client-modules 按 id 记忆 factory；
 * 所以「原样吐出来」就已经等于「注册了」。末尾的标记行只用于确认脚本确实执行到了最后
 * （截断的响应会被发现），也方便调试时区分两个 URL。
 */
function readBootAsset() {
  const { body } = readClientAsset()
  const marker = '\n;/*dsh-session-manager:loaded*/'
  const buffer = Buffer.concat([body, Buffer.from(marker, 'utf8')])
  return { body: buffer, bytes: buffer.length }
}

/* ------------------------------------------------------------------ *
 * Remote 命名空间（可选：只在 typert 协议包能从本插件解析到时安装）
 * ------------------------------------------------------------------ */

/**
 * 以真实 Cordis Service 子类暴露 dshSessionManager{list,resolve,delete}。
 *
 * ⚠️ 本函数是**尽力而为且可能永不绑定**的（见文件头 FINDING 说明）：packaged Desktop 运行时里
 * app-boot 的 profile resolution 会把 @deepseek-ai/cordis / @deepseek-ai/dsh-typert-protocol
 * 从符号链接插件路由进 app.asar，普通 Node 加载不了，动态 import 必然被拒绝。
 * 因此：HTTP 端点必须自成完整通道（/status /list /resolve /delete 都在 installRoutes 里），
 * 任何 HTTP 路径**都不允许**依赖这个 Service 存在。这里失败只记一条警告，不影响其它任何行为。
 *
 * 两条必须遵守的实现约束（都由宿主源码决定）：
 *   1. 不能 `new TypertRemoteService(ctx, key)` —— 它的构造链会去建/绑定自己的 Cordis
 *      Context，而插件拿到的是受限 Context，实测直接抛
 *      `Cannot read properties of undefined (reading 'provide')`，这正是之前那版“静默不可用”的原因。
 *      只借用协议包的 `bindTypertRemote` 工具，在**当前 Context** 里 `new Service(...)`。
 *   2. Remote 标记必须落在类原型上，`typertRemote.service` 必须是原始实例。
 *      参数名必须是纯标识符（Gateway 的 methodParameterNames 逐个校验语法），不能用解构/默认值/rest。
 * 任一步失败都只记警告并跳过：HTTP 端点始终是主通道。
 */
async function installRemote(ctx, base) {
  let cordis
  let protocol
  try {
    cordis = await import('@deepseek-ai/cordis')
    protocol = await import('@deepseek-ai/dsh-typert-protocol').catch(() => null)
  } catch (error) {
    // 一次明确的警告，这个失败以后不再静默（历史上它让整条 Remote 通道无声消失）。
    ctx.logger?.warn?.(
      `[dsh-session-manager] Remote 命名空间不可用（本运行时无法从插件解析 @deepseek-ai/cordis）：` +
        `${error instanceof Error ? error.message : String(error)}；HTTP 端点不受影响，界面请用 /status、/list、/resolve、/delete`,
    )
    return
  }
  const Service = cordis?.Service ?? cordis?.default?.Service
  if (typeof Service !== 'function') {
    ctx.logger?.warn?.('[dsh-session-manager] Remote 命名空间不可用（@deepseek-ai/cordis 没有导出 Service）；HTTP 端点不受影响')
    return
  }
  const bindTypertRemote = protocol?.bindTypertRemote

  try {
    class SessionManagerRemote extends Service {
      list() {
        return base.call('sessions.list', null)
      }

      resolve(sessionIds) {
        return base.call('resolve', sessionIds)
      }

      delete(request) {
        return base.call('deleteSessions', request)
      }
    }

    // Remote 方法标记：与协议包 mark() 的产物结构一致，写在类原型上。
    const direct = (method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })
    Object.defineProperty(SessionManagerRemote.prototype, REMOTE_DESCRIPTOR, {
      configurable: true,
      value: Object.freeze({ version: 1, methods: Object.freeze([direct('list'), direct('resolve'), direct('delete')]) }),
    })

    // 受限插件 Context 上不一定有 `reflect`（那属于应用根 Context），没有就回退到 ctx.provide。
    let owner = ctx
    try {
      if (ctx?.reflect === undefined && typeof ctx?.provide !== 'function') owner = ctx?.root ?? ctx
      if (owner?.reflect === undefined && typeof owner?.provide !== 'function') throw new Error('no provide-capable Context')
      if (owner.reflect === undefined) {
        // 最小垫片：把 Service 构造函数的一次 provide 转发给 Cordis 的 ctx.provide。
        const realProvide = owner.provide.bind(owner)
        owner = new Proxy(owner, {
          get(target, key, receiver) {
            if (key === 'reflect') return { provide: (name, value) => realProvide(name, value) }
            return Reflect.get(target, key, receiver)
          },
        })
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-session-manager] Remote 命名空间未安装（HTTP 端点不受影响）：${String(error)}`)
      return
    }
    const facade = new SessionManagerRemote(owner, 'dshSessionManager')
    const binding = typeof bindTypertRemote === 'function'
      ? bindTypertRemote(facade, 'dshSessionManager')
      : Object.freeze({ service: facade, serviceKey: 'dshSessionManager', namespace: 'dshSessionManager' })
    Object.defineProperty(facade, 'typertRemote', { value: binding, enumerable: true })
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-manager] Remote 命名空间未安装（HTTP 端点不受影响）：${String(error)}`)
  }
}

/**
 * 安装期自检：宿主端插件的运行期错误只会静默冒到 logger，而“引用了一个已不存在的名字”
 * 这类问题（历史上 deleteSessions / REMOTE_DESCRIPTOR 都栽在这里）在语法检查阶段查不出来。
 * @param names 需要在模块作用域里可见的标识符。
 * @returns 未定义的名字列表。
 */
export function undefinedNames(names) {
  const scope = {
    encodeSegment,
    projectKey,
    locateSessionDir,
    deleteSessions,
    listSessionInfos,
    resolveSessions,
    statusInfo,
    installRoutes,
    installRemote,
    REMOTE_DESCRIPTOR,
    RESOLVE_LIMIT,
    normalizeIds,
    corsPreflight,
    clientAssetPath,
    readClientAsset,
    readBootAsset,
    assetStatus,
    sendBytes,
    titleOfVal,
    readTitles,
    clearTitleCache,
    TITLE_CACHE_TTL_MS,
    titleCacheGet,
    titleCacheSet,
  }
  return names.filter((name) => !(name in scope) || scope[name] === undefined)
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/** 健康检查：界面用它判断“宿主这一侧到底通不通”，比 /list 便宜且不受会话数据影响。 */
function statusInfo() {
  return {
    ok: true,
    plugin: name,
    version: pluginVersion(),
    home: dshHome(),
    pid: process.pid,
    platform: process.platform,
    node: process.versions.node,
    resolveLimit: RESOLVE_LIMIT,
    endpoints: [
      `GET ${ROUTE_BASE}/status`,
      `GET ${ROUTE_BASE}/token`,
      `GET ${ROUTE_BASE}/list`,
      `POST ${ROUTE_BASE}/resolve`,
      `POST ${ROUTE_BASE}/delete`,
      `GET ${ROUTE_BASE}/client.js`,
      `GET ${ROUTE_BASE}/boot.js`,
    ],
  }
}

/** 从本包 package.json 读版本；读不到就回 'unknown'（不让健康检查因此失败）。 */
function pluginVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

export function apply(ctx) {
  const report = (message) => {
    try {
      ctx.logger?.warn?.(`[dsh-session-manager] ${message}`)
    } catch {}
  }
  const base = {
    async call(method, args) {
      if (method === 'status') return statusInfo()
      if (method === 'sessions.list') return listSessionInfos(ctx)
      if (method === 'resolve') return resolveSessions(ctx, args)
      if (method === 'deleteSessions') return deleteSessions(ctx, args)
      throw new Error(`未知方法：${String(method)}`)
    },
    status: () => statusInfo(),
    list: () => listSessionInfos(ctx),
    resolve: (ids) => resolveSessions(ctx, ids),
    delete: (request) => deleteSessions(ctx, request),
  }
  let token
  try {
    token = pluginToken(dshHome()).token
    injectPageToken(ctx, token)
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-session-manager] 页面口令未建立：${String(error)}`)
  }
  // 关键：不要在 apply 里一次性 `ctx.get('webServer')` 就认定可用。
  // 插件行会在 webServer 之前就挂载，这里那一次取到的往往是 undefined，
  // 于是「首次打开」永远 404，而重启后偶尔又能用 —— 正是这个竞态。
  // 用 ctx.inject 等 webServer 真正就绪再注册，并在服务替换/重载时重新注册。
  let routesReady = false
  try {
    ctx.inject(['webServer'], (sub) => {
      try {
        installRoutes(sub, base, token)
        routesReady = true
        report(`HTTP 端点已注册（${statusInfo().version}）`)
      } catch (error) {
        report(`HTTP 端点注册失败：${String(error)}`)
      }
    })
  } catch (error) {
    // 没有 inject（测试用 ctx）时退回一次性注册，行为与旧版一致。
    try {
      installRoutes(ctx, base, token)
      routesReady = true
    } catch (inner) {
      report(`HTTP 端点注册失败：${String(inner)}`)
    }
  }
  // 兜底：若 200ms 后仍未注册（某些宿主把 webServer 挂在更晚的 fiber 上），再补一次。
  const timer = setTimeout(() => {
    if (routesReady) return
    try {
      installRoutes(ctx, base, token)
      routesReady = true
      report('HTTP 端点延迟注册成功')
    } catch (error) {
      report(`HTTP 端点延迟注册失败：${String(error)}`)
    }
  }, 200)
  if (timer && typeof timer.unref === 'function') timer.unref()
  installRemote(ctx, base)
  return base
}

export default { name, inject, apply }
