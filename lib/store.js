// dsh-session-manager —— 删除后的「让 UI 也认账」刷新步骤（纯 Node，无 dsh 依赖）。
//
// 为什么需要这一步：workspace / session_projcache 这两个领域由 dsh-storage-json 长期持有，
// 它们的权威状态在**内存**里。我们直接改磁盘上的 JSON 文件时，运行中的宿主看不到变化 ——
// 列表里那一行会一直留着，直到重启。所以删完文件后，尽力通过官方软接口把内存状态也拨正。
//
// 能力边界（均已核实，不是猜测）：
//   * workspaceRegistry.unarchiveSession / unpinSession —— 公开、幂等、未知 id 不报错，可用。
//   * 投影缓存**没有任何公开的行删除接口**：SessionProjectionCache 的公开面只有
//     recordFor / cachedSnapshot / cachedPredecessorTitle / viewRecord / hydratePrepared /
//     put（以及内部 write / flushSoft / coldSnapshot）。内部的 `this.table` 从不调用 .delete，
//     源码里连一处 `delete` 都没有。所以投影缓存的行只能靠删磁盘文档，**没有**可调用的
//     row-drop —— 这里不做任何假装成功的调用。
//   * 同理，没有「把某条 sessionId 从 Workspace.sessionIds 里摘掉」的软接口：
//     Workspace.detachSession 需要活着的会话对象，对已删除的会话不可用。
//
// 因此本模块的实际产出：尽力刷新 workspaceRegistry 的 archived/pinned 集合，并如实报告
// 哪些刷新成功、投影缓存为何跳过。

const CACHE_SKIP = 'projectionCache:no-public-row-drop'

/** 从 ctx 上取服务，兼容 ctx.<name> / ctx.get(name) / 不存在三种情况。 */
function service(ctx, name) {
  if (!ctx) return undefined
  try {
    const direct = ctx[name]
    if (direct !== undefined && direct !== null) return direct
  } catch {
    // 访问器抛错：当作没有
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 删除后尽力刷新宿主的内存状态，使其与磁盘一致。
 *
 * @param {any} ctx  宿主上下文
 * @param {readonly (string|{id:string})[]} ids 已删除的会话 id（字符串或含 .id 的对象）
 * @returns {Promise<string[]>} 实际完成的刷新项；拿不到的项不会出现在结果里
 */
export async function refreshAfterDelete(ctx, ids) {
  const refreshed = []
  const list = Array.isArray(ids) ? ids : []
  const normalized = []
  for (const item of list) {
    const id = typeof item === 'string' ? item : item && typeof item === 'object' ? item.id : undefined
    if (typeof id === 'string' && id !== '') normalized.push(id)
  }
  if (normalized.length === 0) return refreshed

  // ---- workspaceRegistry：把 id 从 archived / pinned 集合里摘掉 ----
  // 两个调用都是幂等的，且对未知 id 不抛错（unarchive/unpin 都不做存在性校验），
  // 所以即使磁盘上已经删干净了，这里再叫一次也是安全的。
  const registry = service(ctx, 'workspaceRegistry')
  if (registry) {
    let touched = false
    for (const id of normalized) {
      for (const method of ['unarchiveSession', 'unpinSession']) {
        const fn = registry[method]
        if (typeof fn !== 'function') continue
        try {
          await fn.call(registry, id)
          touched = true
        } catch {
          // 单个失败不影响其它 id / 其它方法
        }
      }
    }
    if (touched) refreshed.push('workspaceRegistry')
  }

  // ---- 投影缓存：没有公开的行删除接口，如实跳过 ----
  // 如果将来上游加了（比如 table.delete 暴露出来），这里再补：只要存在可直接调用的
  // `drop` / `remove` / `delete` 语义的方法就用，否则跳过。当前版本没有。
  const cache = service(ctx, 'sessionProjectionCache')
  if (cache) {
    const drop = ['dropRecord', 'remove', 'delete']
      .map((name) => cache[name])
      .find((fn) => typeof fn === 'function')
    if (typeof drop === 'function') {
      let touched = false
      for (const id of normalized) {
        try {
          await drop.call(cache, id)
          touched = true
        } catch {
          // 忽略：单条失败不影响其它
        }
      }
      if (touched) refreshed.push('projectionCache')
    } else {
      refreshed.push(CACHE_SKIP)
    }
  }

  return refreshed
}

/** 供测试与文档引用：当前版本投影缓存的跳过原因。 */
export { CACHE_SKIP }
