// 加载形态（两种都支持）：
//   · 宿主模块系统加载：页面里已有 window.__ModuleLoader__，注册工厂交给它实例化；
//   · 原生 <script src=".../boot.js">（含 Electron 的 dsh-app:// 页面）：没有模块加载器时，
//     工厂执行完就自己实例化插件，并把工厂挂到 window.__DSH_SESSION_MANAGER_FACTORY__。
(function () {
	const factory = function (require) {
	'use strict'

	// ════════════════════════════════════════════════════════════════════
	// dsh-session-manager —— Client half（浏览器半段）
	//
	// 交付形态（与 asar 里的官方模板一致）：
	//   dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/
	//     templates/decoration/client.js       -> window.__ModuleLoader__.load({id, factory})
	//   dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:1101 register()
	//                                          -> this.factories.get(id)，按 id 记忆
	//   dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/client.js:37633 materialize()
	//                                          -> registered.factory(this.makeRequire(...)) 的返回值即模块导出
	// 因此：脚本层只有这一次 load()；factory 内 require('react') 取 React（平台种子词，
	// 见 dsh-web-frontend/dist/assets/index-*.js 的 staticModules 表）；
	// factory 返回一个「Cordis 插件对象」{ name, inject, apply }。
	//
	// Host 通道：静态包没有 host.call —— seed 表只有 react / react-dom / cordis / zod /
	// react-virtual / dsh-client-store / dsh-client-ui-{slots,primitives,dockkit}
	// （dsh-web-frontend/dist/assets/index-*.js 的 OZ()）。静态形态优先走插件自己
	// provide 的 `dshSessionManager` 服务（含 { call }），动态形态用 globalThis.host；
	// 两条都不通时 UI 明确显示「无法连接宿主端」，不臆造传输。
	//
	// Host RPC 契约（lib/index.js）：
	//   host.call('sessions.list')  -> { sessions, home, currentSessionId }
	//   host.call('deleteSessions', { sessionIds, backup, allowActive })
	//                               -> { results: [{ id, ok, error?, scrubbed? }], backupDir?, restartRecommended? }
	// ════════════════════════════════════════════════════════════════════

	const PLUGIN_NAME = 'dsh-session-manager'
	const NS = 'dsh-session-manager'
	const EVENT_OPEN = 'dsh-session-manager:open'
	const OVERLAY_ID = 'session-manager'
	const ACTION_ID = 'session-manager'
	/** 侧栏会话行「…」菜单里的入口 id（与官方 pin/rename/fork/archive/session-id 并列）。 */
	const MENU_ACTION_ID = 'dsh-session-manager.delete'
	const HOST_TIMEOUT_MS = 40000
	const MAX_VISIBLE = 800
	const DAY = 86400000
	const RESTART_HINT = '界面列表可能需要刷新或重启后才会完全消失'

	// ── 词典（中文是键集来源；英文逐条对齐）─────────────────────────────
	const zh = {
		'dialog.title': '删除会话',
		'dialog.desc': '勾选要永久删除的会话。删除会移除会话日志、索引缓存与工作区记录；默认先备份到 {backupRoot}，之后可从备份里还原。',
		'dialog.desc.nohome': '勾选要永久删除的会话。删除会移除会话日志、索引缓存与工作区记录。',
		'search.placeholder': '按标题或路径搜索会话…',
		'search.clear': '清除搜索',
		'action.all': '全选',
		'action.none': '全不选',
		'action.refresh': '刷新列表',
		'action.close': '关闭对话框',
		'state.loading': '正在读取会话列表…',
		'state.refreshed': '已刷新会话列表',
		'state.refreshAppDone': '已刷新侧边栏会话列表',
		'state.refreshAppSkipped': '（侧边栏刷新不可用，刷新页面即可）',
		'state.loadFailed': '读取会话列表失败',
		'state.retry': '重试',
		'state.empty': '还没有任何会话。',
		'state.noMatch': '没有匹配当前筛选条件的会话。',
		'state.more': '另有 {n} 个会话未显示，继续输入可以缩小范围。',
		'state.partial': '列表可能不完整，只显示已经加载的部分',
		'list.aria': '会话列表',
		'badge.running': '运行中',
		'badge.archived': '已归档',
		'badge.child': '子会话',
		'badge.child.title': '这是另一个会话的子对话（子代理 / 协作成员）',
		'badge.parent': '含 {n} 个子会话',
		'scope.sidebar': '侧边栏中的会话',
		'scope.other': '不在侧边栏（{n}）',
		'scope.other.hint': '子会话与孤立记录不出现在侧边栏；需要时可展开查看或清理',
		'meta.parent': '父会话：{title}',
		'meta.lastUsed': '最后使用 {time}',
		'meta.created': '创建于 {time}',
		'badge.orphan': '残留记录',
		'badge.live': '已打开',
		'select.aria': '选择会话：{title}',
		'protected.current': '当前会话',
		'protected.descendant': '当前会话的子会话',
		'time.now': '刚刚',
		'time.m': '{n} 分钟前',
		'time.h': '{n} 小时前',
		'time.d': '{n} 天前',
		'time.unknown': '时间未知',
		'foot.selected': '已选 {n} 项',
		'foot.hidden': '（{n} 项不在当前筛选）',
		'foot.hiddenHint': '这些会话被搜索或「不在侧边栏」收起后看不到，但仍会被删除',
		'dialog.backup': '删除前备份',
		'dialog.allowActive': '强制删除运行中的会话',
		'button.delete': '删除',
		'button.deleting': '正在删除…',
		'button.cancel': '取消',
		'confirm.hint': '删除后无法从列表中恢复，只能从备份目录还原。',
		'result.title': '删除结果',
		'result.done': '成功 {ok} 项，失败 {fail} 项。',
		'result.backup': '备份目录：{dir}',
		'result.restart': '界面列表可能需要刷新或重启后才会完全消失',
		'result.failed': '失败',
		'error.backupFailed': '备份失败，已中止删除：{detail}',
		'error.timeout': '宿主端没有响应（{ms} 毫秒超时）',
		'error.noHost': '无法连接宿主端：没有可用的 RPC 通道，暂时不能删除会话。',
		'error.hostError': '宿主端出错：{detail}',
		'error.remote': '宿主端拒绝了这次调用（{code}）：{message}',
		'error.remoteHint': '可以稍后点「刷新列表」或再点一次「删除」重试。',
		'error.generic': '操作失败：{detail}',
		'error.noSelection': '请先勾选要删除的会话。',
		'button.label': '删除会话',
		'button.aria': '删除会话',
		'menu.delete': '删除会话…',
		'menu.delete.desc': '在删除会话对话框里选择这个会话',
		'transport.http': 'HTTP 桥',
		'transport.remote': 'Remote 服务',
		'transport.service': '宿主服务',
		'transport.global': '页面 host 对象',
		'transport.none': '没有可用通道',
		'transport.pending': '正在探测…',
		'state.preselectMissing': '没有找到会话 {id}：它可能已经被删除，或不在当前宿主里。',
		'state.channel': '通道：{name}',
	}
	const en = {
		'dialog.title': 'Delete Sessions',
		'dialog.desc': 'Pick the sessions to delete permanently. Deleting removes session logs, index cache, and workspace records; by default everything is backed up to {backupRoot} first and can be restored from there.',
		'dialog.desc.nohome': 'Pick the sessions to delete permanently. Deleting removes session logs, index cache, and workspace records.',
		'search.placeholder': 'Search sessions by title or path…',
		'search.clear': 'Clear search',
		'action.all': 'Select all',
		'action.none': 'Clear selection',
		'action.refresh': 'Refresh list',
		'action.close': 'Close dialog',
		'state.loading': 'Reading the session list…',
		'state.refreshed': 'Session list refreshed',
		'state.refreshAppDone': 'Sidebar session list refreshed',
		'state.refreshAppSkipped': '(sidebar refresh unavailable; reload the page)',
		'state.loadFailed': 'Reading the session list failed',
		'state.retry': 'Retry',
		'state.empty': 'No sessions yet.',
		'state.noMatch': 'No sessions match the current filters.',
		'state.more': '{n} more sessions are hidden — keep typing to narrow the list.',
		'state.partial': 'The list may be incomplete — only loaded sessions are shown',
		'list.aria': 'Session list',
		'badge.running': 'Running',
		'badge.archived': 'Archived',
		'badge.child': 'Child',
		'badge.child.title': 'This session is a sub-conversation (subagent / teammate) of another session',
		'badge.parent': '{n} child conversations',
		'scope.sidebar': 'Sessions in the sidebar',
		'scope.other': 'Not in the sidebar ({n})',
		'scope.other.hint': 'Sub-conversations and orphan records are not shown in the sidebar; expand to inspect or clean them',
		'meta.parent': 'Parent session: {title}',
		'meta.lastUsed': 'last used {time}',
		'meta.created': 'created {time}',
		'badge.orphan': 'Stale record',
		'badge.live': 'Open',
		'select.aria': 'Select session: {title}',
		'protected.current': 'Current session',
		'protected.descendant': 'Child of the current session',
		'time.now': 'just now',
		'time.m': '{n} min ago',
		'time.h': '{n} h ago',
		'time.d': '{n} d ago',
		'time.unknown': 'Unknown time',
		'foot.selected': '{n} selected',
		'foot.hidden': '({n} hidden by the filter)',
		'foot.hiddenHint': 'These sessions are hidden by the search or scope toggle but will still be deleted',
		'dialog.backup': 'Back up before deleting',
		'dialog.allowActive': 'Force-delete running sessions',
		'button.delete': 'Delete',
		'button.deleting': 'Deleting…',
		'button.cancel': 'Cancel',
		'confirm.hint': 'Deleted sessions cannot be restored from the list — only from the backup directory.',
		'result.title': 'Delete results',
		'result.done': '{ok} succeeded, {fail} failed.',
		'result.backup': 'Backup directory: {dir}',
		'result.restart': 'The UI list may only disappear after a refresh or restart',
		'result.failed': 'Failed',
		'error.backupFailed': 'Backup failed; deletion was aborted: {detail}',
		'error.timeout': 'The host did not answer ({ms} ms timeout)',
		'error.noHost': 'Cannot reach the host: no RPC channel is available, so sessions cannot be deleted right now.',
		'error.hostError': 'Host error: {detail}',
		'error.remote': 'The host rejected this call ({code}): {message}',
		'error.remoteHint': 'Use Refresh list or press Delete again to retry.',
		'error.generic': 'Operation failed: {detail}',
		'error.noSelection': 'Select at least one session first.',
		'button.label': 'Delete sessions',
		'button.aria': 'Delete sessions',
		'menu.delete': 'Delete session…',
		'menu.delete.desc': 'Open the delete-session dialog with this session selected',
		'transport.http': 'HTTP bridge',
		'transport.remote': 'Remote service',
		'transport.service': 'Host service',
		'transport.global': 'Page host object',
		'transport.none': 'No channel available',
		'transport.pending': 'Probing…',
		'state.preselectMissing': 'Session {id} was not found — it may already be deleted or belong to another host.',
		'state.channel': 'Channel: {name}',
	}
	// 服务缺席时按宿主语言自选词典；中文走「键即原文」。
	const DICT_ZH = { '取消': '取消', '删除': '删除', '删除会话': '删除会话' }

	// ════════════════════════════════════════════════════════════════════
	// 工厂闭包内的全部状态（不依赖任何模块外全局）
	// ════════════════════════════════════════════════════════════════════

	/** 尚未接上任何 ctx 之前的日志出口（ctx 到位后换成它）。 */
	let logger = {
		error(...args) {
			try {
				globalThis.console.error(`[${PLUGIN_NAME}]`, ...args)
			} catch {}
		},
		warn(...args) {
			try {
				globalThis.console.warn(`[${PLUGIN_NAME}]`, ...args)
			} catch {}
		},
	}
	const reported = new Set()
	function reportOnce(key, error) {
		if (reported.has(key)) return
		reported.add(key)
		logger.warn(key + ':', errText(error))
	}

	/** React 由平台种子表（require('react')）或页面全局 React 提供；缺失时 UI 不挂载并留一条日志。 */
	let React = null
	try {
		const mod = require('react')
		React = mod && typeof mod.createElement === 'function' ? mod : mod && mod.default ? mod.default : null
	} catch (error) {
		const fromPage = typeof globalThis !== 'undefined' ? globalThis.React ?? globalThis.__DSH_REACT__ : null
		if (fromPage && typeof fromPage.createElement === 'function') React = fromPage
		else reportOnce('react', error)
	}

	/** 打开请求的订阅表 + window 事件桥（整个页面一份，闭包内）。 */
	const openListeners = new Set()
	let bridgeInstalled = false
	/**
	 * 最近一次解析出的传输（只是缓存：每次 list/delete 都会重新调用 resolveTransport，
	 * 失败后还会清掉缓存重新探测，所以启动早期的一次失败不会永久禁用通道）。
	 */
	let transport = { path: 'pending', listSessions: null, deleteSessions: null }
	let stylesSeat = null
	let styleDispose = null

	// 只给自检用：把「谁在听打开事件」这件事暴露出去。浏览器里没有人会碰它；
	// research/client-check.cjs 靠它在一个进程里反复挂载/卸载组件而不串台。
	function exposeHarness() {
		const view = typeof window !== 'undefined' ? window : null
		if (view === null) return
		try {
			view.__DSH_SESSION_MANAGER_HARNESS__ = {
				listeners: openListeners,
				reset() {
					openListeners.clear()
				},
			}
		} catch {}
	}

	function requestOpen(detail) {
		const sessionId = detail && typeof detail.sessionId === 'string' && detail.sessionId !== '' ? detail.sessionId : null
		for (const listener of [...openListeners]) {
			try {
				listener(sessionId)
			} catch (error) {
				logger.error('open listener failed:', errText(error))
			}
		}
	}

	/**
	 * 当前插件 ctx。传输解析是 lazy 的，每次 list/delete 都重新读它 ——
	 * 所以「apply 很早、服务晚一点才就绪」以及「插件被重新 apply」都不会把通道定死。
	 */
	let lastCtx = null

	function installOpenBridge() {
		if (bridgeInstalled) return
		const view = typeof window !== 'undefined' ? window : null
		if (view === null || typeof view.addEventListener !== 'function') return
		try {
			view.addEventListener(EVENT_OPEN, onOpenEvent)
			bridgeInstalled = true
		} catch (error) {
			reportOnce('event-bridge', error)
		}
	}

	/** 页面上任何地方都可以 `new CustomEvent('dsh-session-manager:open', { detail: { sessionId } })`。 */
	function onOpenEvent(event) {
		requestOpen(event && event.detail ? event.detail : null)
	}

	function removeOpenBridge() {
		if (!bridgeInstalled) return
		const view = typeof window !== 'undefined' ? window : null
		try {
			if (view !== null && typeof view.removeEventListener === 'function') view.removeEventListener(EVENT_OPEN, onOpenEvent)
		} catch {}
		bridgeInstalled = false
	}

	// ── 小工具 ──────────────────────────────────────────────────────────
	function errText(error) {
		if (error instanceof Error) return error.message
		return String(error ?? '')
	}
	function normalizePath(value) {
		return String(value || '').replace(/[\\/]+/g, '/')
	}
	function formatBytes(bytes) {
		if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
		const units = ['B', 'KB', 'MB', 'GB']
		let value = bytes
		let unit = 0
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024
			unit += 1
		}
		return value.toFixed(unit === 0 || value >= 100 ? 0 : 1) + ' ' + units[unit]
	}
	/** 绝对时间（本地时区，YYYY-MM-DD HH:mm）：行内显示的主时间。 */
	function absoluteTime(ms) {
		if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
		const date = new Date(ms)
		if (Number.isNaN(date.getTime())) return ''
		const pad = (n) => (n < 10 ? '0' + n : String(n))
		return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
	}

	/** 完整时间戳（含秒），用作 tooltip。 */
	function fullTime(ms) {
		if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
		const date = new Date(ms)
		if (Number.isNaN(date.getTime())) return ''
		const pad = (n) => (n < 10 ? '0' + n : String(n))
		return (
			date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
			pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
		)
	}

	function relativeTime(createdAt, t) {
		if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return t('time.unknown')
		const diff = Date.now() - createdAt
		if (diff < 60000) return t('time.now')
		const minutes = Math.floor(diff / 60000)
		if (minutes < 60) return t('time.m', { n: minutes })
		const hours = Math.floor(diff / 3600000)
		if (hours < 24) return t('time.h', { n: hours })
		return t('time.d', { n: Math.floor(diff / DAY) })
	}

	/**
	 * 刷新宿主/前端的会话列表（DSH 客户端服务 `sessions.refresh()`）。
	 *
	 * 删除时宿主会通过 `Workspace.detachSession` 把会话从工作区摘掉并派发 `domain/changed`，
	 * 前端通常已自动少一行；这里再主动拉一次，覆盖「事件丢了 / 页面在后台」的情况。
	 * @returns 是否成功调用了刷新
	 */
	/**
	 * 客户端 `sessions` 服务（DSH 自己的会话列表）的刷新入口。
	 * 通过 `ctx.inject(['sessions'], …)` 拿到 —— 插件 ctx 是受限上下文，
	 * 直接 `ctx.get('sessions')` 在真实客户端里可能取不到，注入才是官方方式。
	 */
	let appSessionSeat = null

	function installAppRefreshSeat(ctx) {
		if (!ctx || typeof ctx.inject !== 'function' || appSessionSeat !== null) return
		try {
			ctx.inject(['sessions'], (sub) => {
				try {
					const sessions = sub && typeof sub.get === 'function' ? sub.get('sessions') : sub?.sessions
					if (sessions && typeof sessions.refresh === 'function') {
						appSessionSeat = () => sessions.refresh()
					}
				} catch {}
			})
		} catch {}
	}

	let secondRefreshTimer = null

	/**
	 * 宿主删文件后，会话清单/索引可能还有一次异步收敛：稍后再拉一次，
	 * 确保被删的会话不会留在「未分组」里。重复调用只保留最后一个定时器。
	 */
	function scheduleSecondRefresh(sessions) {
		if (secondRefreshTimer !== null) return
		secondRefreshTimer = setTimeout(() => {
			secondRefreshTimer = null
			try {
				const run = appSessionSeat !== null ? appSessionSeat : sessions && typeof sessions.refresh === 'function' ? () => sessions.refresh() : null
				if (run !== null) Promise.resolve(run()).catch(() => {})
			} catch {}
		}, 700)
	}

	async function refreshAppSessionList(pluginCtx) {
		try {
			const ctx = pluginCtx || lastCtx
			if (appSessionSeat !== null) {
				await appSessionSeat()
				scheduleSecondRefresh()
				return true
			}
			const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : null
			if (!sessions) return false
			if (typeof sessions.refresh !== 'function') return false
			await sessions.refresh()
			scheduleSecondRefresh(sessions)
			return true
		} catch {}
		return false
	}

	/** 取词：宿主语言服务在就用它，否则退回内置 zh/en。 */
	function makeTranslate(seat) {
		const bound = (() => {
			if (seat && typeof seat.bind === 'function') {
				try {
					const fn = seat.bind(NS)
					if (typeof fn === 'function') return fn
				} catch {}
			}
			return null
		})()
		return (key, params) => {
			let template = null
			if (bound !== null) {
				try {
					const value = bound(key, params)
					if (typeof value === 'string' && value !== key) template = value
				} catch {}
			}
			if (template === null) {
				let id = 'zh'
				if (seat && typeof seat.getSnapshot === 'function') {
					try {
						const active = seat.getSnapshot()?.active
						if (typeof active === 'string') id = active
					} catch {}
				}
				const dict = id.toLowerCase().startsWith('zh') ? DICT_ZH : en
				template = dict[key] !== undefined ? dict[key] : zh[key] !== undefined ? zh[key] : key
			}
			if (!params) return template
			return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
		}
	}

	// ── Host 传输层 ─────────────────────────────────────────────────────
	//
	// 逻辑契约（界面只认这一层）：
	//   listSessions() -> { sessions, home, currentSessionId }
	//   deleteSessions({ sessionIds, backup, allowActive }) -> { results, backupDir?, restartRecommended }
	//
	// 传输链，按顺序取第一个可用的：
	//   d. HTTP 桥（首选）：本插件 Host 半段注册的 GET /dsh-session-manager/list 与
	//      POST /dsh-session-manager/delete。静态 dsh.client 形态下这是**唯一**稳定的
	//      浏览器→宿主通道：浏览器 bundle 是普通页面脚本，没有 globalThis.host；
	//      ctx.get('remote') / ctx.get('dshSessionManager') 在前端 Context 里也解析不出
	//      本插件命名空间（解析成别的服务则被下面的结构检查挡掉）。
	//   a/b/c 只是可选的上层通道：真的能拿到本插件方法时优先用（载荷更直接），拿不到就退回 d。
	//   都不可用 → 界面明确显示「无法连接宿主端」，不臆造调用。
	//
	// 解析时机：**每次** list/delete 都重新解析（lazy）。页面还在启动时的一次调用失败
	// 不会把通道永久判死；失败后清掉缓存，下一次调用重新探测。
	const REMOTE_NAMESPACE = 'dshSessionManager'
	/** HTTP 桥的同源路由（与 Host 半段约定；POST 只接受 JSON）。 */
	const BRIDGE_ROUTES = {
		list: '/dsh-session-manager/list',
		delete: '/dsh-session-manager/delete',
	}
	/** 页面口令：Host 半段写进 index.html 的 <script>window.__DSH_SESSION_MANAGER_TOKEN__="…"</script>。 */
	const TOKEN_GLOBAL = '__DSH_SESSION_MANAGER_TOKEN__'
	const TOKEN_HEADER = 'x-dsh-session-manager-token'
	/** 瞬时失败（网络错误 / 5xx）的重试次数与间隔。 */
	const RETRY_DELAY_MS = 350
	/** 首次打开时宿主可能还没注册完路由：先自动重试几次，不要一打开就报错。 */
	const BOOT_RETRIES = 4
	const BOOT_RETRY_DELAY_MS = 400
	/** 可选：页面若自己挂出了菜单 open state 工厂，就用它（否则菜单项用惰性替身）。 */
	const MENU_OPEN_STATE_GLOBAL = '__DSH_SESSION_MANAGER_MENU_OPEN_STATE__'
	/** 模块表：静态形态下 ui-workspace 的 client 模块就从这里注册。 */
	const CLIENT_MODULES_GLOBAL = '__dshClientModules'

	function remoteSeat(ctx) {
		let remote = null
		try {
			remote = ctx.get('remote') ?? null
		} catch {
			return null
		}
		if (remote === null || typeof remote !== 'object') return null
		let namespace = null
		try {
			namespace = remote[REMOTE_NAMESPACE]
		} catch {
			return null
		}
		if (!namespace || typeof namespace !== 'object') return null
		const callList = typeof namespace.list === 'function' ? (...args) => namespace.list(...args) : null
		const callDelete = typeof namespace.delete === 'function' ? (...args) => namespace.delete(...args) : null
		if (callList === null && callDelete === null) return null
		return { callList, callDelete }
	}

	function serviceSeat(ctx) {
		let service = null
		try {
			service = ctx.get(REMOTE_NAMESPACE) ?? null
		} catch {
			return null
		}
		if (!service || typeof service !== 'object') return null
		const callList = typeof service.list === 'function' ? () => service.list() : null
		if (callList === null && typeof service.call !== 'function') return null
		return { service, callList }
	}

	function globalHostSeat() {
		try {
			const host = globalThis.host
			if (host && typeof host.call === 'function') return host
		} catch {}
		return null
	}

	/** 读页面口令；Host 没注入（或注入失败）时返回空串，此时省略请求头。 */
	/**
	 * 页面口令：宿主写进 index.html 的全局优先；桌面端（dsh-app:// 页面，HTML 由磁盘直出、
	 * 注入行到不了）没有它，就从只读端点 `GET /dsh-session-manager/token` 取一次并缓存。
	 * 没有口令时写请求会被宿主 403 —— 所以这里必须真的拿到它，而不是静默省略。
	 */
	let tokenCache = ''
	let tokenPending = null
	function pageToken() {
		if (tokenCache !== '') return tokenCache
		try {
			const view = typeof window !== 'undefined' ? window : null
			if (view !== null && typeof view[TOKEN_GLOBAL] === 'string' && view[TOKEN_GLOBAL] !== '') {
				tokenCache = view[TOKEN_GLOBAL]
				return tokenCache
			}
			const fallback = globalThis[TOKEN_GLOBAL]
			if (typeof fallback === 'string' && fallback !== '') {
				tokenCache = fallback
				return tokenCache
			}
		} catch {}
		return ''
	}

	/** 异步补取口令（同源只读端点，桌面端靠它）；失败就返回空串，让上层报出真实 403。 */
	async function ensurePageToken() {
		if (typeof fetch !== 'function') return ''
		const known = pageToken()
		if (known !== '') return known
		if (tokenPending !== null) return tokenPending
		tokenPending = (async () => {
			try {
				const response = await fetch(`${BRIDGE_BASE}token`, {
					method: 'GET',
					credentials: 'same-origin',
					cache: 'no-store',
					headers: { accept: 'application/json' },
				})
				if (response.ok) {
					const payload = await response.json()
					if (payload && typeof payload.token === 'string' && payload.token !== '') tokenCache = payload.token
				}
			} catch {}
			tokenPending = null
			return tokenCache
		})()
		return tokenPending
	}

	/** 诊断用：把内部 path 翻成给人看的通道名。 */
	function transportLabel(path, t) {
		if (typeof path !== 'string' || path === '') return t('transport.pending')
		if (path === 'http') return t('transport.http')
		if (path === 'none') return t('transport.none')
		if (path.indexOf('remote:') === 0) return t('transport.remote')
		if (path.indexOf('service:') === 0) return t('transport.service')
		if (path.indexOf('global:') === 0) return t('transport.global')
		return path
	}

	/**
	 * 传输链的排序：上层通道优先，HTTP 桥兜底。
	 * @returns {Array<{ path, listSessions, deleteSessions }>} 至少一项；完全不可用时是 [{ path:'none' }]
	 */
	function transportCandidates(ctx, t) {
		const out = []
		if (ctx) {
			const remote = remoteSeat(ctx)
			if (remote !== null) {
				out.push({
					path: 'remote:' + REMOTE_NAMESPACE,
					listSessions() {
						if (remote.callList === null) return Promise.reject(hostUnavailableError(t))
						return Promise.resolve(remote.callList())
					},
					deleteSessions(request) {
						if (remote.callDelete === null) return Promise.reject(hostUnavailableError(t))
						return Promise.resolve(remote.callDelete(request))
					},
				})
			}
			const service = serviceSeat(ctx)
			if (service !== null) {
				out.push({
					path: 'service:' + REMOTE_NAMESPACE,
					listSessions() {
						if (service.callList !== null) return Promise.resolve(service.callList())
						return Promise.resolve(service.service.call('sessions.list', null))
					},
					deleteSessions(request) {
						if (typeof service.service.call === 'function') return Promise.resolve(service.service.call('deleteSessions', request))
						return Promise.reject(hostUnavailableError(t))
					},
				})
			}
			const globalSeat = globalHostSeat()
			if (globalSeat !== null) {
				out.push({
					path: 'global:host',
					listSessions() {
						return Promise.resolve(globalSeat.call('sessions.list', null))
					},
					deleteSessions(request) {
						return Promise.resolve(globalSeat.call('deleteSessions', request))
					},
				})
			}
		}
		/**
	 * 插件端点可能挂在别的端口上（桌面/多窗口会把页面切到新的宿主端口，而 5752 这类端口上
	 * 根本没有本插件）。所以同源路径 404 时，再按 `location.port ± N` 试探同一台机器的邻居端口，
	 * 命中后记住它，后续请求直接用它。
	 */
	const NEIGHBOR_PORT_SPANS = [24, 48]

	function routeCandidates(route) {
		const seen = new Set([route])
		const out = [route]
		let origin = ''
		try {
			origin = String(globalThis.location?.origin ?? '')
		} catch {}
		if (!origin) return out
		let port = 0
		try {
			port = Number(new URL(origin).port) || 0
		} catch {}
		if (port === 0) return out
		for (const span of NEIGHBOR_PORT_SPANS) {
			for (let delta = 1; delta <= span; delta += 1) {
				for (const candidatePort of [port + delta, port - delta]) {
					if (candidatePort <= 0 || candidatePort > 65535) continue
					const candidate = `${origin.replace(/:(\d+)$/, ':' + String(candidatePort))}${route}`
					if (seen.has(candidate)) continue
					seen.add(candidate)
					out.push(candidate)
				}
			}
		}
		return out
	}

	let resolvedBase = ''

	/**
	 * 依次尝试候选地址；只有 404（说明这个端口上没有本插件）才换下一个。
	 * 其他状态码 / 网络错误照原样抛出，交给上层显示原因。
	 */
	/** 兜底读本地清单（宿主完全不可达时）：{"sessions":[{id,...}], "home": "...", "currentSessionId": null}。 */
	async function readLocalListing() {
		for (const path of ['/session-delete-ids.json', '/dsh-session-manager/local.json']) {
			try {
				const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin' })
				if (!response.ok) continue
				const text = await response.text()
				if (!String(text).trim().startsWith('{')) continue
				const payload = JSON.parse(text)
				if (payload && Array.isArray(payload.sessions)) return payload
			} catch {}
		}
		return null
	}

	async function requestAnyRoute(method, route, body) {
		// 桌面端页面里没有注入的口令全局：写请求前先同源取一次，否则会被宿主 403。
		if (method !== 'GET') await ensurePageToken()
		const tried = []
		let sourceError = null
		// ① 页面自己的来源（同源，带凭据）。只试这一个地址：其他的同源变体在大多数
		//    宿主上根本不存在，逐个去探只会放大一次失败请求的代价。
		try {
			const found = await httpRequest(method, route, body)
			return found
		} catch (error) {
			sourceError = error
			tried.push(error && error.code ? String(error.code) : 'error')
			// 只有「这个地址上没有本插件」（404 / 连接被拒）才继续找；
			// 4xx/5xx 与真实的网络错误都直接上抛，交给界面显示和重试。
			if (!isRouteMissing(error)) throw error
		}
		// ② 同一来源的相邻端口（宿主把页面与 HTTP 分在不同随机端口时）。
		for (const port of neighbouringPorts()) {
			const found = await crossOriginRequest(method, route, body, port)
			if (found !== null) return found
		}
		// ③ 兜底：本机几个常见的 dsh web 端口。
		for (const base of LOOPBACK_BASES) {
			const found = await crossOriginRequest(method, route, body, base)
			if (found !== null) return found
		}
		// ④ 兜底：完全连不上宿主时，读一份本地清单文件（由桌面页代理或本机脚本放置），
		//    照样能按 id 列出并删除。
		const local = await readLocalListing()
		if (local !== null) return local
		// 保留第一次的真实原因（网络错误 / 5xx），别换成通用话术。
		const first = sourceError
		const error = new Error(
			first && first.message ? `${first.message}（另外尝试了相邻与本机常见端口）` : '找不到宿主的删除会话端点',
		)
		error.code = first && first.code ? first.code : 'no-host'
		error.transient = first ? first.transient === true : false
		throw error
	}

	function neighbouringPorts() {
		const base = (() => {
			try {
				return Number(new URL(String(globalThis.location?.href ?? '')).port) || 0
			} catch {
				return 0
			}
		})()
		if (base <= 0) return []
		const out = []
		for (const span of [8, 24]) {
			for (let delta = 1; delta <= span; delta += 1) {
				for (const port of [base + delta, base - delta]) {
					if (port > 0 && port < 65536 && !out.includes(port)) out.push(port)
				}
			}
		}
		return out.slice(0, 16)
	}

	/** 404/000 都算「这个地址上没有本插件的端点」，可以继续换地址；其他状态码表示端点存在。 */
	function isRouteMissing(error) {
		if (!error) return true
		const code = String(error.code ?? '')
		if (code === 'http-404' || code === 'http-transport') return true
		return false
	}

	// HTTP 桥（兜底，也是静态 dsh.client 形态下实际可用的通道）：Host 半段把端点挂在
		// 本页同源路径上，前端用 fetch 直连，凭据 same-origin，响应不走缓存。
		if (typeof globalThis.fetch === 'function') {
			out.push({
				path: 'http',
				listSessions() {
					return requestAnyRoute('GET', BRIDGE_ROUTES.list, null)
				},
				deleteSessions(request) {
					return requestAnyRoute('POST', BRIDGE_ROUTES.delete, request)
				},
			})
		}
		if (out.length === 0) out.push({ path: 'none', listSessions: null, deleteSessions: null })
		return out
	}

	/**
	 * 解析传输链，返回统一的 { listSessions(), deleteSessions(req), path }。
	 * 每次调用都重新解析；取候选里的第一个（序号 0 是首选）。
	 */
	function resolveTransport(ctx, t) {
		return transportCandidates(ctx, t)[0]
	}

	/**
	 * 调一个同源 JSON 端点。非 2xx 视为失败，并尽量把响应体里的 { error } 抬上来。
	 * @param method - 'GET' 或 'POST'
	 * @param route - 绝对路径（同源）
	 * @param body - POST 的 JSON 载荷；GET 传 null
	 */
	/**
	 * 跨来源兜底（实验）：页面可能挂在 A 端口、宿主的 HTTP 在 B 端口（桌面壳用 --port 0
	 * 随机端口），此时同源路径一定 404、跨源 fetch 会被 CORS 挡住。这里把请求直接打到
	 * 回环地址上的候选端口（不带 Origin、不带 cookie）：插件端点自己的栅栏本来就允许回环访问。
	 */
	const CROSS_ORIGIN_TRIES = [24, 48, 120, 1024, 4096]
	/** 本机常见的 dsh web 端口（桌面客户端可能把页面托管在另一个端口上，用来兜底探测）。 */
	const LOOPBACK_BASES = ['http://127.0.0.1:8314']

	function locationPort() {
		try {
			return Number(new URL(String(globalThis.location?.href ?? '')).port) || 0
		} catch {
			return 0
		}
	}

	function candidatePorts(base) {
		const out = []
		const push = (port) => {
			if (port > 0 && port < 65536 && !out.includes(port)) out.push(port)
		}
		if (base > 0) push(base)
		for (const span of CROSS_ORIGIN_TRIES) {
			for (let delta = 1; delta <= span; delta += 1) {
				push(base + delta)
				push(base - delta)
			}
		}
		return out
	}

	function crossOriginRequest(method, routePath, body, target) {
		const headers = { accept: 'application/json' }
		const token = pageToken()
		if (token !== '') headers[TOKEN_HEADER] = token
		if (method !== 'GET') headers['content-type'] = 'application/json'
		const base = typeof target === 'number' ? `http://127.0.0.1:${target}` : String(target)
		return fetch(`${base}${routePath}`, {
			method,
			cache: 'no-store',
			mode: 'cors',
			credentials: 'omit',
			headers,
			body: method === 'GET' ? undefined : JSON.stringify(body === undefined || body === null ? {} : body),
		})
			.then((response) => (response.ok ? response.json() : null))
			.catch(() => null)
	}

	function httpRequest(method, route, body) {
		const headers = { accept: 'application/json' }
		// 页面口令：Host 写进 index.html 的同一份；缺失时省略（Host 仍接受带同源证据的请求）。
		const token = pageToken()
		if (token !== '') headers[TOKEN_HEADER] = token
		const init = {
			method,
			credentials: 'same-origin',
			headers,
			cache: 'no-store',
		}
		if (method !== 'GET') {
			headers['content-type'] = 'application/json'
			init.body = JSON.stringify(body === undefined || body === null ? {} : body)
		}
		return Promise.resolve()
			.then(() => globalThis.fetch(route, init))
			.then(
				(response) =>
					Promise.resolve(response.text()).then((text) => {
						let payload = null
						if (typeof text === 'string' && text.trim() !== '') {
							try {
								payload = JSON.parse(text)
							} catch {}
						}
						if (!response.ok) {
							const detail = payload && typeof payload.error === 'string' && payload.error !== ''
								? payload.error
								: 'HTTP ' + String(response.status) + (response.statusText ? ' ' + response.statusText : '')
							const error = new Error(detail)
							error.code = 'http-' + String(response.status)
							// 5xx 视为瞬时失败（宿主正在重启/初始化），值得重试一次。
							error.transient = typeof response.status === 'number' && response.status >= 500
							throw error
						}
						return payload
					}),
				(error) => {
					// transport 级失败（宿主没起、断网、被拦截）：交给界面显示可读原因。
					const wrapped = new Error(errText(error) || 'fetch failed')
					wrapped.code = 'http-transport'
					wrapped.transient = true
					throw wrapped
				},
			)
	}

	/**
	 * 首次打开时的「宿主还没就绪」判定：404（路由尚未注册）、连不上、超时都算，
	 * 值得等一会儿自动重试；真正的 4xx 业务拒绝不在此列。
	 */
	/** 是否存在任何可用通道：完全没有通道时重试毫无意义，直接报「无法连接宿主端」。 */
	function hasAnyChannel() {
		try {
			const list = transportCandidates(hostCtx(), (key) => key)
			return Array.isArray(list) && list.length > 0 && list[0] && list[0].path !== 'none'
		} catch {
			return false
		}
	}

	function isBootPending(error) {
		if (!error) return false
		const code = typeof error.code === 'string' ? error.code : ''
		// 只对「宿主起来了但路由还没注册好」这一类重试：
		//   404 —— 服务在，端点还没出现；no-host —— 所有候选地址都 404。
		// 连接被拒 / 超时 / 4xx 都是确定结论，交给界面的「重试」按钮，避免无谓等待。
		return code === 'http-404' || code === 'no-host'
	}

	/** 是否值得再试一次：网络错误 / 5xx / 通道暂时不可用。4xx 是确定性拒绝，不重试。 */
	function isTransient(error) {
		if (!error) return false
		if (error.transient === true) return true
		const code = typeof error.code === 'string' ? error.code : ''
		if (code === 'http-transport' || code === 'no-host') return true
		const match = /^http-(\d{3})$/.exec(code)
		if (match !== null) return Number(match[1]) >= 500
		return false
	}

	function delay(ms) {
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, ms)
			// 浏览器没有 unref；Node 下也不 unref —— 否则 vm/沙箱里上下文一到 idle
			// 定时器就永远不到期，重试看起来像「卡死」。
			void timer
		})
	}

	/**
	 * 通过传输链执行一次调用：
	 *   - 每次调用都重新解析候选通道（lazy，不在 apply 时一次性定死）；
	 *   - 瞬时失败（网络错误 / 5xx / 通道消失）且还没重试过时重试一次：
	 *     有下一个候选就换下一个（remote → service → global → HTTP），没有就重试当前通道
	 *     （宿主可能正在重启，等一小会儿再问一次）。仍失败才抛出；
	 *   - 失败后清空缓存，下一次调用重新探测（例如页面刚启动时 fetch 还没就绪）。
	 * 4xx（确定性拒绝）不重试，直接把宿主给的原因抬上来。
	 * @param ctx - 插件 ctx（可选；没有时只走 HTTP 桥 / 全局 host）
	 * @param t - 翻译函数
	 * @param run - (seat) => Promise，seat 是 { path, listSessions, deleteSessions }
	 * @returns {Promise<{ value, path }>} 结果 + 实际使用的通道（给诊断行用）
	 */
	function runWithTransport(ctx, t, run) {
		const candidates = transportCandidates(ctx, t)
		const reset = () => {
			transport = { path: 'pending', listSessions: null, deleteSessions: null }
		}
		const attempt = (index, retried) => {
			const seat = candidates[index]
			if (!seat || seat.path === 'none' || typeof run !== 'function') {
				reset()
				return Promise.reject(hostUnavailableError(t))
			}
			transport = seat
			return Promise.resolve()
				.then(() => run(seat))
				.then(
					(value) => ({ value, path: seat.path }),
					(error) => {
						if (!retried && isTransient(error)) {
							// 这个通道不通（还没起来 / 5xx / 被拦截）：换下一个候选，没有就再试当前这个。
							reset()
							const next = index + 1 < candidates.length ? index + 1 : index
							return delay(RETRY_DELAY_MS).then(() => attempt(next, true))
						}
						reset()
						throw error
					},
				)
		}
		return attempt(0, false)
	}

	function hostUnavailableError(t) {
		const error = new Error(t('error.noHost'))
		error.code = 'no-host'
		return error
	}

	/** 给任意异步操作加超时；RPC 卡住时界面不会无限转圈。 */
	function withTimeout(pendingFactory, t) {
		return new Promise((resolve, reject) => {
			let settled = false
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				const error = new Error(t('error.timeout', { ms: HOST_TIMEOUT_MS }))
				error.code = 'timeout'
				reject(error)
			}, HOST_TIMEOUT_MS)
			const finish = (fn, value) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				fn(value)
			}
			let pending
			try {
				pending = pendingFactory()
			} catch (error) {
				finish(reject, error)
				return
			}
			Promise.resolve(pending).then(
				(value) => finish(resolve, value),
				(error) => finish(reject, error),
			)
		})
	}

	/** 把各传输的原始返回整理成界面契约（多余字段原样保留）。 */
	function toListing(raw) {
		const value = raw && typeof raw === 'object' ? raw : {}
		return {
			sessions: Array.isArray(value.sessions) ? value.sessions : [],
			home: typeof value.home === 'string' ? value.home : null,
			currentSessionId: typeof value.currentSessionId === 'string' ? value.currentSessionId : null,
		}
	}
	function toDeletion(raw) {
		const value = raw && typeof raw === 'object' ? raw : {}
		return {
			results: Array.isArray(value.results) ? value.results : [],
			backupDir: typeof value.backupDir === 'string' ? value.backupDir : null,
			restartRecommended: value.restartRecommended === true,
		}
	}

	/** RemoteError 靠结构识别（跨 realm 不共享 instanceof）。 */
	function remoteErrorOf(value) {
		if (typeof value === 'object' && value !== null) {
			try {
				if (value.isDSHRemoteError === true && typeof value.code === 'string') return value
			} catch {}
		}
		return null
	}

	function describeError(error, t) {
		if (error && error.code === 'no-host') return t('error.noHost')
		if (error && error.code === 'timeout') return t('error.timeout', { ms: HOST_TIMEOUT_MS })
		const remote = remoteErrorOf(error)
		if (remote !== null) return t('error.remote', { code: remote.code || 'remote', message: errText(error) || 'unknown' })
		const message = errText(error)
		if (message && message.trim() !== '') return t('error.generic', { detail: message })
		return t('error.hostError', { detail: 'unknown' })
	}

	// ── 数据整理 ────────────────────────────────────────────────────────
	function asSessions(listing) {
		const rows = []
		const seen = new Set()
		const source = listing && Array.isArray(listing.sessions) ? listing.sessions : []
		for (const raw of source) {
			if (!raw || typeof raw !== 'object') continue
			const id = typeof raw.id === 'string' ? raw.id : ''
			if (id === '' || seen.has(id)) continue
			seen.add(id)
			rows.push({
				id,
				// 空标题保持为空：界面用「未命名会话」占位并单独显示 id，不再把 id 当标题。
				title: typeof raw.title === 'string' ? raw.title.trim() : '',
				cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : null,
				createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : null,
				updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
				origin: typeof raw.origin === 'string' && raw.origin !== '' ? raw.origin : null,
				inWorkspace: raw.inWorkspace === true,
				parentId: typeof raw.parentId === 'string' && raw.parentId !== '' ? raw.parentId : null,
				children: Array.isArray(raw.children) ? raw.children.filter((child) => typeof child === 'string') : [],
				archived: raw.archived === true,
				running: raw.running === true,
				live: raw.live === true,
				orphan: raw.orphan === true,
				bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
			})
		}
		return rows
	}

	/**
	 * 排序：父会话后面紧跟它的子会话（两者都可见时），其余按时间倒序。
	 * @param list 已过滤的行
	 * @returns 渲染顺序
	 */
	function orderByLineage(list) {
		const byId = new Map(list.map((row) => [row.id, row]))
		const emitted = new Set()
		const out = []
		const push = (row) => {
			if (emitted.has(row.id)) return
			emitted.add(row.id)
			out.push(row)
			for (const childId of row.children || []) {
				const child = byId.get(childId)
				if (child !== undefined) push(child)
			}
		}
		for (const row of list) {
			if (row.parentId !== null && byId.has(row.parentId)) continue
			push(row)
		}
		for (const row of list) push(row)
		return out
	}

	/** 工具栏上的「显示不在侧边栏的会话」开关；没有隐藏行时返回 null。 */
	function scopeToggleElement(e, t, hiddenCount, showHidden, setShowHidden) {
		if (hiddenCount <= 0) return null
		return e(
			'label',
			{ className: 'dsm-scope' + (showHidden ? ' dsm-scope-on' : ''), title: t('scope.other.hint'), 'data-dsm-scope': showHidden ? 'all' : 'sidebar' },
			e('input', {
				type: 'checkbox',
				className: 'dsm-scope-input',
				checked: showHidden,
				onChange: () => setShowHidden(!showHidden),
			}),
			e('span', { className: 'dsm-scope-text' }, t('scope.other', { n: hiddenCount })),
		)
	}

	/** 父会话标题（用于子会话行的「父会话：…」提示）。 */
	function parentLabel(row, byId, t) {
		if (!row.parentId) return ''
		const parent = byId.get(row.parentId)
		const name = parent !== undefined && parent.title ? parent.title : row.parentId
		return t('meta.parent', { title: name })
	}

	/** 当前会话 + 它的全部后代：host 会拒绝，界面上也不给勾。 */
	function collectProtected(rows, currentId) {
		const out = new Set()
		if (typeof currentId !== 'string' || currentId === '') return out
		const byId = new Map(rows.map((row) => [row.id, row]))
		out.add(currentId)
		const queue = [currentId]
		while (queue.length > 0) {
			const row = byId.get(queue.shift())
			if (row === undefined) continue
			for (const child of row.children) {
				if (out.has(child)) continue
				out.add(child)
				queue.push(child)
			}
		}
		return out
	}

	// ── 样式 ────────────────────────────────────────────────────────────
	function injectStyles() {
		if (styleDispose !== null) return
		if (stylesSeat !== null && typeof stylesSeat.insert === 'function') {
			try {
				styleDispose = stylesSeat.insert(STYLESHEET)
				return
			} catch (error) {
				reportOnce('styles.insert', error)
			}
		}
		// 静态形态没有 styles 闭包符号：自己插一个带 data-plugin 的标签，
		// 模块系统按 data-plugin 归属样式（client-modules claimStyles/removeOwnedStyles）。
		const doc = typeof document !== 'undefined' ? document : null
		if (doc === null || !doc.head) return
		const tag = doc.createElement('style')
		tag.dataset.plugin = NS
		tag.textContent = STYLESHEET
		doc.head.append(tag)
		styleDispose = () => {
			try {
				tag.remove()
			} catch {}
		}
	}

	function dropStyles() {
		if (styleDispose === null) return
		try {
			styleDispose()
		} catch {}
		styleDispose = null
	}

	// ── 图标 ────────────────────────────────────────────────────────────
	function icon(paths, extra) {
		const children = paths.map((d, index) =>
			React.createElement('path', {
				key: 'p' + index,
				d,
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.6,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
			}),
		)
		return React.createElement('svg', Object.assign({
			xmlns: 'http://www.w3.org/2000/svg',
			width: 18,
			height: 18,
			viewBox: '0 0 20 20',
			fill: 'none',
			'aria-hidden': 'true',
			focusable: 'false',
		}, extra || {}), children)
	}
	function TrashIcon(size) {
		return icon(['M3.5 5.5h13', 'M8 5.5V3.6h4v1.9', 'M5.3 5.5l.8 10.2h7.8l.8-10.2', 'M8.3 8.4v4.8', 'M11.7 8.4v4.8'], { width: size, height: size, 'data-dsm-icon': 'trash' })
	}
	function SearchIcon() {
		return icon(['M9.2 15.4a6.2 6.2 0 1 0 0-12.4 6.2 6.2 0 0 0 0 12.4Z', 'M13.8 13.8 17 17'], { width: 14, height: 14, 'data-dsm-icon': 'search' })
	}
	function CloseIcon() {
		return icon(['M5 5l10 10', 'M15 5 5 15'], { width: 14, height: 14, 'data-dsm-icon': 'close' })
	}
	function RefreshIcon() {
		return icon(['M16 10a6 6 0 1 1-1.8-4.3', 'M16.4 3.2v3.4H13'], { width: 14, height: 14, 'data-dsm-icon': 'refresh' })
	}
	function CheckIcon() {
		return icon(['M4 10.5l3.2 3.2L16 6'], { width: 11, height: 11, 'data-dsm-icon': 'check', strokeWidth: 2.2 })
	}

	/** 弹窗外壳的层级：盖过宿主自己的模态层。 */
	function backdropStyle() {
		const style = {
			position: 'fixed',
			top: 0,
			left: 0,
			right: 0,
			bottom: 0,
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .45))',
			zIndex: 900,
		}
		return style
	}

	// ── 组件：删除会话弹窗 ──────────────────────────────────────────────
	function createOverlay(t, ctxOf) {
		const e = React.createElement

		/**
		 * 取「当前」插件 ctx 来解析通道。优先用 lastCtx（每次 apply 都会刷新），
		 * 没有才退回创建组件时闭包里的那个 —— 这样插件被重新 apply（HMR / reload）
		 * 时，早就挂载的弹窗也能看到新的 ctx，而不是一直抱着旧的那个。
		 */
		const hostCtx = () => lastCtx || (typeof ctxOf === 'function' ? ctxOf() : ctxOf) || null

		return function SessionManagerOverlay() {
			const [open, setOpen] = React.useState(false)
			const [status, setStatus] = React.useState('idle')
			const [rows, setRows] = React.useState([])
			const [home, setHome] = React.useState(null)
			const [currentSessionId, setCurrentSessionId] = React.useState(null)
			const [query, setQuery] = React.useState('')
			const [selected, setSelected] = React.useState(() => new Set())
			const [backup, setBackup] = React.useState(true)
			const [allowActive, setAllowActive] = React.useState(false)
			const [deleting, setDeleting] = React.useState(false)
			const [notice, setNotice] = React.useState(null)
			const [results, setResults] = React.useState(null)
			const [errorText, setErrorText] = React.useState(null)
			const [channel, setChannel] = React.useState('pending')
			/** 打开时要求预先勾选的会话（来自侧栏行「…」菜单）；列表回来后兑现。 */
			const [preselect, setPreselect] = React.useState(null)
			const searchRef = React.useRef(null)
			/** 每次 load 递增，慢响应回来时不会覆盖更新的结果。 */
			const loadSeq = React.useRef(0)

			const load = React.useCallback((requested) => {
				const wanted = typeof requested === 'string' && requested !== '' ? requested : null
				const seq = ++loadSeq.current
				setErrorText(null)
				setNotice(null)
				setStatus((previous) => (previous === 'ready' ? 'ready' : 'loading'))
				// 首次打开时宿主可能刚起来、路由还在注册：这类失败自动重试，不直接报红。
				const attempt = (triesLeft) =>
					runWithTransport(hostCtx(), t, (seat) => {
						if (seat.listSessions === null) return Promise.reject(hostUnavailableError(t))
						return withTimeout(() => seat.listSessions(), t)
					}).catch((error) => {
						if (triesLeft > 0 && isBootPending(error) && hasAnyChannel()) {
							return delay(BOOT_RETRY_DELAY_MS).then(() => attempt(triesLeft - 1))
						}
						throw error
					})
				attempt(BOOT_RETRIES)
					.then((outcome) => {
						if (seq !== loadSeq.current) return
						const listing = toListing(outcome.value)
						const nextRows = asSessions(listing)
						setRows(nextRows)
						setHome(listing.home)
						setCurrentSessionId(listing.currentSessionId)
						setStatus('ready')
						setChannel(outcome.path)
						if (wanted !== null) {
							// 预先勾选菜单里点的那个会话；受保护（当前会话/其子会话）时不给勾，只提示。
							const protectedNow = collectProtected(nextRows, listing.currentSessionId)
							if (!nextRows.some((row) => row.id === wanted)) {
								setErrorText(t('state.preselectMissing', { id: wanted }))
							} else if (!protectedNow.has(wanted)) {
								setSelected((previous) => {
									const next = new Set(previous)
									next.add(wanted)
									return next
								})
							}
						}
					})
					.catch((error) => {
						if (seq !== loadSeq.current) return
						setRows([])
						setChannel('none')
						setErrorText(describeError(error, t))
						setStatus('failed')
					})
			}, [])

			const requestShow = React.useCallback((sessionId) => {
				const wanted = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
				setResults(null)
				setPreselect(wanted)
				setSelected(new Set())
				setQuery('')
				setOpen(true)
				load(wanted)
			}, [load])

			const refresh = React.useCallback(() => {
				// 手动「刷新列表」：同时刷新侧边栏的会话列表与本对话框（先 load 再提示）。
				refreshAppSessionList(hostCtx())
					.then((refreshed) => {
						load(preselect)
						setNotice(refreshed ? t('state.refreshAppDone') : null)
					})
					.catch(() => {
						load(preselect)
						setNotice(null)
					})
			}, [load, preselect])

			const close = React.useCallback(() => {
				setOpen(false)
				setResults(null)
				setErrorText(null)
				setDeleting(false)
			}, [])

			React.useEffect(() => {
				installOpenBridge()
				openListeners.add(requestShow)
				return () => {
					openListeners.delete(requestShow)
				}
			}, [requestShow])

			// 打开后把焦点交给搜索框（键盘用户的第一站）。
			React.useEffect(() => {
				if (!open) return undefined
				const node = searchRef.current
				if (node !== null && typeof node.focus === 'function') {
					try {
						node.focus()
					} catch {}
				}
				return undefined
			}, [open])

			// Esc 关闭；捕获阶段拦下，避免宿主在别的层再处理一次。
			React.useEffect(() => {
				if (!open) return undefined
				const doc = typeof document !== 'undefined' ? document : null
				if (doc === null) return undefined
				const onKey = (event) => {
					if (!event || (event.key !== 'Escape' && event.keyCode !== 27)) return
					if (typeof event.stopPropagation === 'function') event.stopPropagation()
					if (typeof event.preventDefault === 'function') event.preventDefault()
					close()
				}
				doc.addEventListener('keydown', onKey, true)
				return () => {
					try {
						doc.removeEventListener('keydown', onKey, true)
					} catch {}
				}
			}, [open, close])

			const protectedIds = React.useMemo(() => collectProtected(rows, currentSessionId), [rows, currentSessionId])

			// 侧边栏之外（子会话 / 孤立记录）默认不显示：与侧边栏保持一致，需要时再展开。
			const [showHidden, setShowHiddenState] = React.useState(false)
			/**
			 * 切换「显示不在侧边栏的会话」。收起时把已经不在列表里的已选会话从选择集里去掉 ——
			 * 否则用户会删掉一批自己看不见的会话。
			 */
			const setShowHidden = (next) => {
				setShowHiddenState(next)
				if (next) return
				setSelected((previous) => {
					if (previous.size === 0) return previous
					const keep = new Set(inSidebarIdsRef.current)
					const pruned = new Set([...previous].filter((id) => keep.has(id)))
					return pruned.size === previous.size ? previous : pruned
				})
			}
			const inSidebarIdsRef = React.useRef(new Set())

			const inSidebar = React.useMemo(
				() => rows.filter((row) => row.inWorkspace === true && row.orphan !== true),
				[rows],
			)
			const outsideSidebar = React.useMemo(
				() => rows.filter((row) => !(row.inWorkspace === true && row.orphan !== true)),
				[rows],
			)
			inSidebarIdsRef.current = new Set(inSidebar.map((row) => row.id))
			const scoped = showHidden ? rows : inSidebar
			const filtered = React.useMemo(() => {
				const needle = query.trim().toLowerCase()
				if (needle === '') return scoped
				return scoped.filter((row) => {
					const haystack = [
						row.title,
						normalizePath(row.cwd),
						row.id,
						absoluteTime(row.updatedAt),
						absoluteTime(row.createdAt),
					]
						.filter(Boolean)
						.join('\n')
						.toLowerCase()
					return haystack.indexOf(needle) >= 0
				})
			}, [scoped, query])

			const ordered = React.useMemo(() => orderByLineage(filtered), [filtered])
			const visible = ordered.length > MAX_VISIBLE ? ordered.slice(0, MAX_VISIBLE) : ordered
			const selectableVisible = React.useMemo(
				() => visible.map((row) => row.id).filter((id) => !protectedIds.has(id)),
				[visible, protectedIds],
			)
			const selectedIds = React.useMemo(() => [...selected].filter((id) => !protectedIds.has(id)), [selected, protectedIds])
			// 已选但当前筛选/作用域下看不到的条数（提示用，避免误删看不见的会话）
			const hiddenSelected = React.useMemo(() => {
				if (selectedIds.length === 0) return 0
				const visibleIds = new Set(visible.map((row) => row.id))
				return selectedIds.filter((id) => !visibleIds.has(id)).length
			}, [selectedIds, visible])
			const allSelected = selectableVisible.length > 0 && selectableVisible.every((id) => selected.has(id))
			const someSelected = selectableVisible.some((id) => selected.has(id))

			const toggle = (id) => {
				setSelected((previous) => {
					const next = new Set(previous)
					if (next.has(id)) next.delete(id)
					else next.add(id)
					return next
				})
			}
			const toggleAll = () => {
				setSelected((previous) => {
					const next = new Set(previous)
					const clear = selectableVisible.length > 0 && selectableVisible.every((id) => next.has(id))
					for (const id of selectableVisible) {
						if (clear) next.delete(id)
						else next.add(id)
					}
					return next
				})
			}

			const submit = () => {
				if (deleting) return
				const ids = selectedIds
				if (ids.length === 0) {
					setErrorText(t('error.noSelection'))
					return
				}
				setDeleting(true)
				setErrorText(null)
				const request = { sessionIds: ids, backup, allowActive }
				runWithTransport(hostCtx(), t, (seat) => {
					if (seat.deleteSessions === null) return Promise.reject(hostUnavailableError(t))
					return withTimeout(() => seat.deleteSessions(request), t)
				})
					.then((outcome) => {
						const payload = toDeletion(outcome.value)
						setChannel(outcome.path)
						const bySession = new Map()
						for (const item of payload.results) {
							if (!item || typeof item !== 'object') continue
							const id = typeof item.id === 'string' ? item.id : ''
							if (id === '') continue
							bySession.set(id, {
								id,
								ok: item.ok === true,
								error: typeof item.error === 'string' && item.error !== '' ? item.error : null,
							})
						}
						const missing = ids.filter((id) => !bySession.has(id))
						setResults({
							bySession,
							missing,
							backupDir: payload.backupDir,
							restartRecommended: payload.restartRecommended,
						})
						setSelected(new Set([...missing, ...ids.filter((id) => bySession.get(id)?.ok !== true)]))
						setPreselect(null)
						setDeleting(false)
						// 删完自动刷新会话列表：先让宿主/前端的列表重拉，再刷新本对话框。
						// 注意先 load()（它会清空提示）再 setNotice，否则提示会被立刻抹掉。
						const anyDeleted = [...bySession.values()].some((item) => item.ok)
						;(anyDeleted ? refreshAppSessionList(hostCtx()) : Promise.resolve(false))
							.then((refreshed) => {
								load()
								if (!anyDeleted) {
									setNotice(null)
									return
								}
								setNotice(refreshed ? t('state.refreshAppDone') : t('state.refreshAppSkipped'))
							})
							.catch(() => {
								load()
								setNotice(null)
							})
					})
					.catch((error) => {
						setDeleting(false)
						setErrorText(describeError(error, t))
					})
			}

			const onBackdrop = (event) => {
				if (deleting) return
				if (event && event.target === event.currentTarget) close()
			}

			if (!open) return null

			const body = []
			if (notice !== null && notice !== undefined && notice !== '') {
				body.push(
					e(
						'div',
						{ key: 'notice', className: 'dsm-notice', role: 'status' },
						notice,
					),
				)
			}
			if (errorText !== null) {
				body.push(
					e(
						'div',
						{ key: 'alert', className: 'dsm-alert', role: 'alert' },
						errorText,
						e('button', { type: 'button', className: 'dsm-btn dsm-btn-ghost dsm-alert-action', onClick: refresh, disabled: deleting }, t('state.retry')),
					),
				)
			}

			if (results !== null) {
				const values = [...results.bySession.values()]
				const failed = values.filter((row) => !row.ok)
				const failedCount = failed.length + results.missing.length
				const items = failed.map((row) =>
					e(
						'li',
						{ key: 'f-' + row.id, className: 'dsm-result-row' },
						e('span', { className: 'dsm-result-mark', 'aria-hidden': 'true' }, '×'),
						e('code', { className: 'dsm-code' }, row.id.slice(0, 24)),
						e('span', { className: 'dsm-result-msg' }, row.error || t('result.failed')),
					),
				)
				for (const id of results.missing) {
					items.push(
						e(
							'li',
							{ key: 'm-' + id, className: 'dsm-result-row' },
							e('span', { className: 'dsm-result-mark', 'aria-hidden': 'true' }, '×'),
							e('code', { className: 'dsm-code' }, id.slice(0, 24)),
							e('span', { className: 'dsm-result-msg' }, t('result.failed')),
						),
					)
				}
				const restart = results.restartRecommended || failedCount > 0
				body.push(
					e(
						'section',
						{ key: 'results', className: 'dsm-results', 'aria-live': 'polite' },
						e('h3', { className: 'dsm-results-title' }, t('result.title')),
						e('p', { className: 'dsm-results-summary' }, t('result.done', { ok: values.length - failed.length, fail: failedCount })),
						results.backupDir ? e('p', { className: 'dsm-results-backup' }, t('result.backup', { dir: normalizePath(results.backupDir) })) : null,
						restart ? e('p', { className: 'dsm-results-hint' }, t('result.restart')) : null,
						items.length > 0 ? e('ul', { className: 'dsm-results-list' }, items) : null,
					),
				)
			}

			const byIdRows = new Map(rows.map((row) => [row.id, row]))
			const listItems = []
			if (status === 'loading' && rows.length === 0) {
				listItems.push(e('li', { key: 'st-loading', className: 'dsm-state' }, t('state.loading')))
			} else if (status === 'failed' && rows.length === 0) {
				listItems.push(
					e(
						'li',
						{ key: 'st-failed', className: 'dsm-state' },
						e('span', null, t('state.loadFailed')),
						e('button', { type: 'button', className: 'dsm-btn dsm-btn-ghost', onClick: refresh }, t('state.retry')),
					),
				)
			} else if (rows.length === 0) {
				listItems.push(e('li', { key: 'st-empty', className: 'dsm-state' }, t('state.empty')))
			} else if (filtered.length === 0) {
				listItems.push(e('li', { key: 'st-none', className: 'dsm-state' }, t('state.noMatch')))
			} else {
				for (const row of visible) {
					const blocked = protectedIds.has(row.id)
					const checked = selected.has(row.id)
					const badges = []
					if (row.running) badges.push(e('span', { key: 'b-run', className: 'dsm-badge dsm-badge-running' }, t('badge.running')))
					if (row.live) badges.push(e('span', { key: 'b-live', className: 'dsm-badge dsm-badge-live' }, t('badge.live')))
					if (row.archived) badges.push(e('span', { key: 'b-arch', className: 'dsm-badge dsm-badge-archived' }, t('badge.archived')))
					if (row.parentId || row.origin === 'subagent') {
						badges.push(e('span', { key: 'b-child', className: 'dsm-badge dsm-badge-child', title: t('badge.child.title') }, '↳ ' + t('badge.child')))
					}
					if (row.children.length > 0) {
						badges.push(e('span', { key: 'b-parent', className: 'dsm-badge dsm-badge-parent' }, t('badge.parent', { n: row.children.length })))
					}
					if (row.orphan) badges.push(e('span', { key: 'b-orphan', className: 'dsm-badge dsm-badge-orphan' }, t('badge.orphan')))
					if (blocked) {
						badges.push(
							e(
								'span',
								{ key: 'b-prot', className: 'dsm-badge dsm-badge-protected' },
								currentSessionId === row.id ? t('protected.current') : t('protected.descendant'),
							),
						)
					}
					// 时间：先显示「最后使用」（会话日志最后写入时间），再显示「创建」。
					// 两者都是本地绝对时间，相对时间只做后缀提示，悬停显示精确到秒。
					const used = absoluteTime(row.updatedAt)
					const created = absoluteTime(row.createdAt)
					const meta = []
					if (used !== '') {
						meta.push({
							text: t('meta.lastUsed', { time: used }) + ' · ' + relativeTime(row.updatedAt, t),
							title: fullTime(row.updatedAt),
							className: 'dsm-meta-time dsm-meta-lastused',
						})
					}
					if (created !== '') {
						meta.push({
							text: t('meta.created', { time: created }),
							title: fullTime(row.createdAt),
							className: 'dsm-meta-time dsm-meta-created',
						})
					}
					if (meta.length === 0) {
						meta.push({ text: t('time.unknown'), className: 'dsm-meta-time' })
					}
					const parentTip = parentLabel(row, byIdRows, t)
					if (parentTip !== '') meta.push({ text: parentTip, className: 'dsm-meta-parent' })
					if (row.cwd) meta.push({ text: normalizePath(row.cwd) })
					const size = formatBytes(row.bytes)
					if (size !== '') meta.push({ text: size })
					listItems.push(
						e(
							'li',
							{
								key: row.id,
								className:
									'dsm-row' +
									(row.parentId ? ' dsm-row-child' : '') +
									(row.children.length > 0 ? ' dsm-row-parent' : '') +
									(checked ? ' dsm-row-on' : '') +
									(blocked ? ' dsm-row-blocked' : ''),
							},
							e(
								'label',
								{ className: 'dsm-row-label' },
								e(
									'span',
									{ className: 'dsm-check' },
									e('input', {
										type: 'checkbox',
										className: 'dsm-check-input',
										checked: checked,
										disabled: blocked || deleting,
										'aria-label': t('select.aria', { title: row.title }),
										onChange: () => toggle(row.id),
									}),
									e('span', { className: 'dsm-check-mark', 'aria-hidden': 'true' }, CheckIcon()),
								),
								e(
									'span',
									{ className: 'dsm-row-body' },
									e(
									'span',
									{ className: 'dsm-row-titleline' },
									e(
										'span',
										{ className: 'dsm-row-title' + (row.title ? '' : ' dsm-row-title-empty'), title: row.title || row.id },
										row.title || t('row.untitled'),
									),
									e('span', { className: 'dsm-row-id' }, row.id),
									badges,
								),
									e(
										'span',
										{ className: 'dsm-row-meta' },
										meta.map((part, index) =>
											e(
												'span',
												{ key: 'm' + index, className: 'dsm-meta-part' + (part.className ? ' ' + part.className : ''), title: part.title || part.text },
												part.text,
											),
										),
									),
								),
							),
						),
					)
				}
				if (filtered.length > visible.length) {
					listItems.push(e('li', { key: 'st-more', className: 'dsm-state dsm-state-inline' }, t('state.more', { n: filtered.length - visible.length })))
				}
			}

			const backupRoot = home ? normalizePath(home) + '/session-delete-backup/<timestamp>/' : '<DSH home>/session-delete-backup/<timestamp>/'

			return e(
				'div',
				{ className: 'dsm-backdrop', style: backdropStyle(), onMouseDown: onBackdrop, 'data-dsm': OVERLAY_ID },
				e(
					'div',
					{
						className: 'dsm-modal',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-labelledby': 'dsm-title',
						'aria-describedby': 'dsm-desc',
						onMouseDown: (event) => {
							if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
						},
					},
					e(
						'header',
						{ className: 'dsm-head' },
						e('h2', { id: 'dsm-title', className: 'dsm-title' }, t('dialog.title')),
						e(
							'button',
							{ type: 'button', className: 'dsm-iconbtn dsm-close', title: t('action.close'), 'aria-label': t('action.close'), onClick: close },
							CloseIcon(),
						),
					),
					e('p', { id: 'dsm-desc', className: 'dsm-desc' }, home ? t('dialog.desc', { backupRoot }) : t('dialog.desc.nohome')),
					...body,
					e(
						'div',
						{ className: 'dsm-search' },
						e('span', { className: 'dsm-search-icon', 'aria-hidden': 'true' }, SearchIcon()),
						e('input', {
							ref: searchRef,
							type: 'search',
							className: 'dsm-search-input',
							placeholder: t('search.placeholder'),
							'aria-label': t('search.placeholder'),
							value: query,
							onChange: (event) => setQuery(event && event.target ? String(event.target.value) : ''),
						}),
						query !== ''
							? e(
									'button',
									{ type: 'button', className: 'dsm-iconbtn dsm-search-clear', title: t('search.clear'), 'aria-label': t('search.clear'), onClick: () => setQuery('') },
									CloseIcon(),
								)
							: null,
					),
					e(
						'div',
						{ className: 'dsm-toolbar' },
						e(
							'label',
							{ className: 'dsm-all' },
							e(
								'span',
								{ className: 'dsm-check dsm-check-sm' },
								e('input', {
									type: 'checkbox',
									className: 'dsm-check-input',
									checked: allSelected,
									disabled: selectableVisible.length === 0 || deleting,
									'aria-label': t('action.all'),
									onChange: toggleAll,
								}),
								e('span', { className: 'dsm-check-mark', 'aria-hidden': 'true' }, CheckIcon()),
							),
							e('span', { className: 'dsm-all-text' }, t('action.all')),
						),
						scopeToggleElement(e, t, outsideSidebar.length, showHidden, setShowHidden),
						e(
							'span',
							{ className: 'dsm-toolbar-note' },
							t('foot.selected', { n: selectedIds.length }),
							hiddenSelected > 0
								? e('span', { className: 'dsm-hidden-selected', title: t('foot.hiddenHint') }, t('foot.hidden', { n: hiddenSelected }))
								: null,
							e('span', { className: 'dsm-channel', 'data-dsm-channel': channel, title: channel }, t('state.channel', { name: transportLabel(channel, t) })),
						),
						e(
							'span',
							{ className: 'dsm-toolbar-actions' },
							e('button', { type: 'button', className: 'dsm-btn dsm-btn-ghost', onClick: () => setSelected(new Set()), disabled: selectedIds.length === 0 || deleting }, t('action.none')),
							e(
								'button',
								{ type: 'button', className: 'dsm-btn dsm-btn-ghost dsm-btn-refresh', title: t('action.refresh'), 'aria-label': t('action.refresh'), onClick: refresh, disabled: deleting },
								RefreshIcon(),
								e('span', { className: 'dsm-refresh-text' }, t('action.refresh')),
							),
						),
					),
					e('ul', { className: 'dsm-list', role: 'group', 'aria-label': t('list.aria') }, listItems),
					e(
						'footer',
						{ className: 'dsm-foot' },
						e(
							'div',
							{ className: 'dsm-foot-left' },
							e(
								'label',
								{ className: 'dsm-toggle', title: t('dialog.backup') },
								e('input', {
									type: 'checkbox',
									className: 'dsm-toggle-input',
									checked: backup,
									disabled: deleting,
									onChange: (event) => setBackup(!!(event && event.target && event.target.checked)),
								}),
								e('span', { className: 'dsm-toggle-track', 'aria-hidden': 'true' }, e('span', { className: 'dsm-toggle-thumb' })),
								e('span', { className: 'dsm-toggle-text' }, t('dialog.backup')),
							),
							e(
								'label',
								{ className: 'dsm-toggle', title: t('dialog.allowActive') },
								e('input', {
									type: 'checkbox',
									className: 'dsm-toggle-input',
									checked: allowActive,
									disabled: deleting,
									onChange: (event) => setAllowActive(!!(event && event.target && event.target.checked)),
								}),
								e('span', { className: 'dsm-toggle-track', 'aria-hidden': 'true' }, e('span', { className: 'dsm-toggle-thumb' })),
								e('span', { className: 'dsm-toggle-text' }, t('dialog.allowActive')),
							),
						),
						e(
							'div',
							{ className: 'dsm-foot-right' },
							e('span', { className: 'dsm-hint' }, t('confirm.hint')),
							e('button', { type: 'button', className: 'dsm-btn dsm-btn-ghost', onClick: close, disabled: deleting }, t('button.cancel')),
							e(
								'button',
								{
									type: 'button',
									className: 'dsm-btn dsm-btn-danger',
									onClick: submit,
									disabled: deleting || selectedIds.length === 0,
									'aria-busy': deleting ? 'true' : 'false',
								},
								deleting ? t('button.deleting') : t('button.delete'),
							),
						),
					),
				),
			)
		}
	}

	// ── 组件：侧栏会话行「…」菜单里的「删除会话…」──────────────────────────
	//
	// 插槽契约（已在 dsh-client-ui-workspace/lib/client.js 里逐条核对）：
	//   ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id, order, locale, inject }, Component)
	//   ownerProps = { sessionId, displayTitle }                    ← 行的会话 id 与标题
	//   slotInject = { hooks: { menuOpenState, shortcuts } }        ← 插槽自己提供的 hook
	//   hooks.<key> 会以 `use<Key 首字母大写>` 的名字出现在组件 props 里（与官方
	//   pin/rename/fork/archive/session-id 五个占用者一致：hooks:{dialog} → useDialog），
	//   所以这里的 menuOpenState → useMenuOpenState。
	//   菜单行本体用 primitives 的 MenuItemButton（role="menuitem" + separatorBefore），
	//   require 不到时退回同结构的手写按钮，保证菜单项永远渲染得出来。
	let menuItemCache
	function menuItemButton() {
		// 懒解析：**成功才记忆**。factory 执行得比平台种子表就绪更早时第一次 require 会失败，
		// 那时用兜底按钮，下一次渲染再试一次 —— 失败绝不能被记成「永久没有」。
		if (menuItemCache !== undefined) return menuItemCache
		try {
			const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
			if (primitives && typeof primitives.MenuItemButton === 'function') {
				menuItemCache = primitives.MenuItemButton
				return menuItemCache
			}
		} catch (error) {
			reportOnce('primitives.MenuItemButton', error)
		}
		return null
	}

	/**
	 * 读菜单的关闭钩子。注册时给了 inject.hooks.menuOpenState，平台上就是 props.useMenuOpenState；
	 * 拿不到也不致命（只是点完菜单要等下一次点击/失焦才关），绝不能因此让菜单项消失。
	 */
	function useMenuClose(props) {
		const hook = props && typeof props.useMenuOpenState === 'function'
			? props.useMenuOpenState
			: props && typeof props.menuOpenState === 'function'
				? props.menuOpenState
				: null
		let api = null
		if (hook !== null) {
			try {
				api = hook()
			} catch (error) {
				reportOnce('menuOpenState', error)
			}
		}
		let close = null
		if (Array.isArray(api)) {
			if (typeof api[1] === 'function') close = () => api[1](false)
			else if (typeof api[0] === 'function') close = () => api[0](false)
		} else if (api && typeof api.close === 'function') {
			close = () => api.close()
		} else if (typeof api === 'function') {
			close = () => api(false)
		}
		return close
	}

	function createSessionMenuAction(t) {
		return function SessionManagerMenuItem(props) {
			const owner = props && typeof props === 'object' ? props : {}
			const sessionId = typeof owner.sessionId === 'string' && owner.sessionId !== '' ? owner.sessionId : null
			const closeMenu = useMenuClose(owner)
			const label = t('menu.delete')
			const description = t('menu.delete.desc')
			const onSelect = () => {
				if (typeof closeMenu === 'function') {
					try {
						closeMenu()
					} catch (error) {
						reportOnce('menuOpenState.close', error)
					}
				}
				requestOpen(sessionId === null ? null : { sessionId })
			}
			const MenuItem = menuItemButton()
			if (MenuItem !== null) {
				return React.createElement(
					MenuItem,
					{
						danger: true,
						separatorBefore: true,
						icon: TrashIcon(14),
						onSelect,
						'data-dsm-menu-action': sessionId || '',
					},
					label,
				)
			}
			// 兜底：与 MenuItemButton 的结构一致（itemWrap > button[role=menuitem]）。
			return React.createElement(
				'div',
				{ className: 'dsm-menuitem-wrap' },
				React.createElement('div', { className: 'dsm-menuitem-sep', role: 'separator' }),
				React.createElement(
					'button',
					{
						type: 'button',
						role: 'menuitem',
						className: 'dsm-menuitem dsm-menuitem-danger',
						title: description,
						'data-dsm-menu-action': sessionId || '',
						onClick: onSelect,
					},
					React.createElement('span', { className: 'dsm-menuitem-icon', 'aria-hidden': 'true' }, TrashIcon(14)),
					React.createElement('span', { className: 'dsm-menuitem-label' }, label),
				),
			)
		}
	}

	/**
	 * 菜单 open state hook（插槽 `sidebar.workspaces.session.menu.item` 的 inject.hooks.menuOpenState）。
	 *
	 * ui-workspace 用 `menuOpenStateFactory`（hookContext 工厂）提供它，而不是一个值。那份源码在
	 * asar 里以压缩产物交付，拿不到稳定导出，所以这里按「最优努力」加载：
	 *   - 先从宿主模块表里找 ui-workspace 的 client 模块，看它有没有把工厂挂出来；
	 *   - 拿不到就返回一个对任何输入都返回 undefined 的 hook —— 菜单项照样渲染、点击照样
	 *     打开弹窗（菜单随后由宿主的关闭钩子自己收起），只是少了「立刻收起」这一步。
	 * 关键点：**绝不能因为 hook 拿不到就让菜单项消失**。
	 */
	function loadMenuOpenStateFactory() {
		try {
			const factory = globalThis[MENU_OPEN_STATE_GLOBAL]
			if (typeof factory === 'function') return factory
		} catch {}
		try {
			const modules = globalThis[CLIENT_MODULES_GLOBAL]
			const factories = modules && modules.factories
			if (factories && typeof factories.get === 'function') {
				const workspace = factories.get('@deepseek-ai/dsh-client-ui-workspace')
				const factory = workspace && workspace.menuOpenStateFactory
				if (typeof factory === 'function') return factory
			}
		} catch {}
		return null
	}
	/** 插槽 hook 的替身：永远返回 undefined（不抛错、不阻塞渲染）。 */
	function inertMenuOpenState() {
		return undefined
	}
	const globalMenuOpenState = loadMenuOpenStateFactory() || inertMenuOpenState

	// ── 组件：侧栏底部按钮 ──────────────────────────────────────────────
	function createFooterAction(t) {
		return function SessionManagerFooterAction(ownerProps) {
			installOpenBridge()
			const wide = !!(ownerProps && ownerProps.wide === true)
			const label = t('button.label')
			return React.createElement(
				'button',
				{
					type: 'button',
					className: 'dsm-sidebtn' + (wide ? ' dsm-sidebtn-wide' : ''),
					title: label,
					'aria-label': t('button.aria'),
					'data-dsm-action': ACTION_ID,
					onClick: (event) => {
						if (event && typeof event.preventDefault === 'function') event.preventDefault()
						if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
						requestOpen()
					},
				},
				React.createElement('span', { className: 'dsm-sidebtn-icon' }, TrashIcon(18)),
				wide ? React.createElement('span', { className: 'dsm-sidebtn-text' }, label) : null,
			)
		}
	}

	// ── 样式表 ──────────────────────────────────────────────────────────
	const STYLESHEET = [
		'.dsm-sidebtn{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-width:0;height:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:1;cursor:pointer;transition:background-color .2s ease,color .2s ease}',
		'.dsm-sidebtn:not(.dsm-sidebtn-wide){justify-content:center;padding:0}',
		'.dsm-sidebtn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}',
		'.dsm-sidebtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}',
		'.dsm-sidebtn-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:18px;height:18px}',
		'.dsm-sidebtn-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.dsm-backdrop{box-sizing:border-box}',
		'.dsm-modal{display:flex;flex-direction:column;box-sizing:border-box;width:min(680px,100% - 32px);max-height:min(82vh,780px);padding:16px 18px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 12px 40px rgba(0,0,0,.25);font-size:13px;line-height:1.45}',
		'.dsm-head{display:flex;align-items:center;gap:8px;flex:none}',
		'.dsm-title{margin:0;font-size:15px;font-weight:600;line-height:1.3}',
		'.dsm-desc{margin:6px 0 10px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;flex:none;word-break:break-word}',
		'.dsm-iconbtn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
		'.dsm-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}',
		'.dsm-iconbtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
		'.dsm-iconbtn:disabled{opacity:.45;cursor:not-allowed}',
		'.dsm-close{margin-left:auto}',
		'.dsm-notice{flex:none;margin:0 0 10px;padding:7px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 35%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 8%,transparent);color:var(--dsw-alias-brand-primary,#4f7cff);font-size:12px}',
		'.dsm-alert{flex:none;margin:0 0 10px;padding:7px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 40%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 9%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;word-break:break-word}',
		'.dsm-search{display:flex;align-items:center;gap:6px;flex:none;height:32px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:8px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff))}',
		'.dsm-search:focus-within{border-color:var(--dsw-alias-brand-primary,#4f7cff)}',
		'.dsm-search-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary,#6b7280)}',
		'.dsm-search-input{flex:1;min-width:0;height:100%;border:0;outline:none;background:transparent;color:inherit;font:inherit;font-size:13px}',
		'.dsm-search-input::-webkit-search-cancel-button{display:none}',
		'.dsm-search-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary,#9ca3af))}',
		'.dsm-search-clear{width:22px;height:22px}',
		'.dsm-toolbar{display:flex;align-items:center;gap:8px;flex:none;padding:8px 2px 6px}',
		'.dsm-all,.dsm-row-label{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer}',
		'.dsm-all-text{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
		'.dsm-toolbar-note{margin-left:auto;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;white-space:nowrap}',
		'.dsm-toolbar-actions{display:flex;align-items:center;gap:2px}',
		'.dsm-badge-parent{background:var(--dsw-alias-brand-bg-subtle,rgba(79,124,255,.14));color:var(--dsw-alias-brand-primary,#4f7cff)}',
		'.dsm-meta-time{font-variant-numeric:tabular-nums}',
		'.dsm-meta-lastused{color:var(--dsw-alias-label-primary,#1f2328)}',
		'.dsm-meta-created{opacity:.72}',
		'.dsm-hidden-selected{color:var(--dsw-alias-state-warning-primary,#b45309)}',
		'.dsm-scope{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:999px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;cursor:pointer;user-select:none}',
		'.dsm-scope-on{background:var(--dsw-alias-brand-bg-subtle,rgba(79,124,255,.12));color:var(--dsw-alias-brand-primary,#4f7cff);border-color:transparent}',
		'.dsm-scope-input{margin:0;width:12px;height:12px}',
		'.dsm-row-child .dsm-row-title{padding-left:2px}',
		'.dsm-check{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;width:16px;height:16px}',
		'.dsm-check-sm{width:15px;height:15px}',
		'.dsm-check-input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;z-index:1}',
		'.dsm-check-input:disabled{cursor:not-allowed}',
		'.dsm-check-mark{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border:1.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.28));border-radius:4px;color:#fff}',
		'.dsm-check-mark>svg{opacity:0}',
		'.dsm-check-input:checked+.dsm-check-mark{background:var(--dsw-alias-button-primary-fill,#4f7cff);border-color:var(--dsw-alias-button-primary-fill,#4f7cff)}',
		'.dsm-check-input:checked+.dsm-check-mark>svg{opacity:1}',
		'.dsm-check-input:focus-visible+.dsm-check-mark{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
		'.dsm-list{flex:1 1 auto;min-height:140px;margin:0;padding:2px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));overflow-y:auto;list-style:none;overscroll-behavior:contain;scrollbar-width:thin}',
		'.dsm-row{border-radius:8px}',
		'.dsm-row+.dsm-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
		'.dsm-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
		'.dsm-row-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 8%,transparent)}',
		'.dsm-row-label{padding:8px 10px;align-items:flex-start}',
		'.dsm-row-blocked{opacity:.62}',
		'.dsm-row-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;text-align:left}',
		'.dsm-row-titleline{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}',
		'.dsm-row-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}',
		'.dsm-row-title-empty{color:var(--dsw-alias-label-secondary,#6b7280);font-weight:400}',
		'.dsm-row-id{flex:none;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
		'.dsm-row-meta{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11.5px}',
		'.dsm-meta-part{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.dsm-meta-part:first-child{flex:none}',
		'.dsm-badge{display:inline-flex;align-items:center;flex:none;height:17px;padding:0 6px;border-radius:999px;border:1px solid transparent;font-size:10.5px;line-height:1;white-space:nowrap;font-weight:500}',
		'.dsm-badge-running{color:var(--dsw-alias-state-success-primary,#15803d);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#15803d) 13%,transparent)}',
		'.dsm-badge-live{color:var(--dsw-alias-state-business-primary,#4f7cff);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 10%,transparent)}',
		'.dsm-badge-archived{color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
		'.dsm-badge-child{color:var(--dsw-alias-state-business-primary,#4f7cff);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f7cff) 12%,transparent)}',
		'.dsm-badge-orphan{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 13%,transparent)}',
		'.dsm-badge-protected{color:var(--dsw-alias-label-secondary,#6b7280);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-style:dashed}',
		'.dsm-state{display:flex;align-items:center;justify-content:center;gap:10px;padding:32px 16px;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12.5px;text-align:center;list-style:none}',
		'.dsm-state-inline{padding:10px 16px;font-size:11.5px}',
		'.dsm-results{flex:none;margin:0 0 10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,#fff));max-height:180px;overflow:auto}',
		'.dsm-results-title{margin:0 0 4px;font-size:12.5px;font-weight:600}',
		'.dsm-results-summary,.dsm-results-backup,.dsm-results-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
		'.dsm-results-backup{word-break:break-all}',
		'.dsm-results-hint{margin-top:4px;font-size:11.5px;color:var(--dsw-alias-state-warn-primary,#b45309)}',
		'.dsm-results-list{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:3px}',
		'.dsm-result-row{display:flex;align-items:center;gap:6px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280)}',
		'.dsm-result-mark{flex:none;width:14px;text-align:center;font-weight:700;color:var(--dsw-alias-state-error-primary,#dc2626)}',
		'.dsm-code{flex:none;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px}',
		'.dsm-result-msg{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.dsm-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
		'.dsm-foot-left{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-width:0}',
		'.dsm-foot-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}',
		'.dsm-toggle{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap}',
		'.dsm-toggle-input{position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
		'.dsm-toggle-track{position:relative;display:inline-flex;align-items:center;flex:none;width:26px;height:15px;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.24));transition:background-color .15s ease}',
		'.dsm-toggle-thumb{position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s ease}',
		'.dsm-toggle-input:checked+.dsm-toggle-track{background:var(--dsw-alias-button-primary-fill,#4f7cff)}',
		'.dsm-toggle-input:checked+.dsm-toggle-track>.dsm-toggle-thumb{transform:translateX(11px)}',
		'.dsm-toggle-input:focus-visible+.dsm-toggle-track{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}',
		'.dsm-toggle-input:disabled+.dsm-toggle-track{opacity:.5;cursor:not-allowed}',
		'.dsm-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);opacity:.8}',
		'.dsm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:30px;padding:0 12px;border:1px solid transparent;border-radius:8px;font:inherit;font-size:12.5px;line-height:1;cursor:pointer;white-space:nowrap}',
		'.dsm-btn:disabled{opacity:.45;cursor:not-allowed}',
		'.dsm-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
		'.dsm-btn-ghost{background:transparent;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.14));color:var(--dsw-alias-label-primary,#1f2328)}',
		'.dsm-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
		'.dsm-btn-icon{width:30px;padding:0}',
		'.dsm-btn-refresh{gap:5px;padding:0 9px}',
		'.dsm-refresh-text{font-size:12px}',
		'.dsm-channel{display:inline-flex;align-items:center;margin-left:8px;padding:0 6px;height:16px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,#6b7280);font-size:10.5px;white-space:nowrap;cursor:help}',
		'.dsm-channel[data-dsm-channel="none"]{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 45%,transparent)}',
		'.dsm-alert{display:flex;align-items:center;gap:10px}',
		'.dsm-alert-action{flex:none;height:24px;padding:0 8px;font-size:11.5px;border-color:currentColor;color:inherit}',
		'.dsm-menuitem-wrap{display:flex;flex-direction:column}',
		'.dsm-menuitem-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
		'.dsm-menuitem{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12.5px;line-height:1;text-align:left;cursor:pointer;white-space:nowrap}',
		'.dsm-menuitem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
		'.dsm-menuitem:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}',
		'.dsm-menuitem-danger{color:var(--dsw-alias-state-error-primary,#dc2626)}',
		'.dsm-menuitem-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:14px;height:14px}',
		'.dsm-menuitem-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
		'.dsm-btn-danger{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;font-weight:600}',
		'.dsm-btn-danger:hover:not(:disabled){filter:brightness(1.08)}',
		'body[data-ds-dark-theme] .dsm-modal{border-color:rgba(255,255,255,.14)}',
		'body[data-ds-dark-theme] .dsm-badge-archived{background:rgba(255,255,255,.08)}',
		'@media (max-width:480px){.dsm-modal{width:100%;max-width:100%;max-height:92vh;padding:14px}.dsm-foot-right{width:100%;margin-left:0;justify-content:flex-end}.dsm-hint{display:none}}',
	].join('\n')

	// ── 插件对象 ────────────────────────────────────────────────────────
	return {
		name: PLUGIN_NAME,
		// 'locale' 是有则用之的可选服务：缺了退回内置 zh/en，所以不进 inject。
		inject: ['slots'],
		apply(ctx) {
			if (React === null) {
				logger.error('require("react") did not provide React; the delete-session dialog will not mount.')
				return
			}

			// ctx 到位后把日志接到宿主身上的同一套 console 通道。
			try {
				const contextLogger = ctx.get('logger')
				if (contextLogger && typeof contextLogger.warn === 'function' && typeof contextLogger.error === 'function') logger = contextLogger
			} catch {}

			// 语言服务（可选）。
			let localeSeat = null
			try {
				localeSeat = ctx.get('locale') ?? null
			} catch {}
			if (localeSeat !== null && typeof localeSeat.register === 'function') {
				try {
					localeSeat.register(NS, { zh, en })
				} catch (error) {
					reportOnce('locale.register', error)
				}
			} else {
				reportOnce('locale.missing', 'the optional locale service is absent; falling back to built-in zh/en dictionaries')
			}
			const t = makeTranslate(localeSeat)

			// 样式（styles 闭包符号 → 自插 <style data-plugin>）。
			try {
				const stylesSymbol = globalThis.styles
				if (stylesSymbol && typeof stylesSymbol.insert === 'function') stylesSeat = stylesSymbol
			} catch {}
			if (typeof ctx.effect === 'function') {
				ctx.effect(() => {
					injectStyles()
					return () => dropStyles()
				}, `${PLUGIN_NAME}: stylesheet`)
			} else {
				injectStyles()
			}

			// 宿主通道：每条 list/delete 现取（lazy）。这里只做一次探测，用于日志提示。
			const boot = resolveTransport(ctx, t)
			transport = boot
			if (boot.path === 'none') {
				logger.warn(
					'no host transport available (no HTTP fetch, no ctx.remote.dshSessionManager, no dshSessionManager service, no global host): the dialog will show "无法连接宿主端" instead of deleting.',
				)
			}

			// 打开信号桥：整个页面一份，卸载时拆掉。
			if (typeof ctx.effect === 'function') {
				ctx.effect(() => {
					installOpenBridge()
					return () => removeOpenBridge()
				}, `${PLUGIN_NAME}: open signal`)
			}

			const slots = (() => {
				try {
					return ctx.get('slots') ?? null
				} catch {
					return null
				}
			})()
				exposeHarness()
		if (slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
				logger.error('the slots service is unavailable; the delete-session dialog cannot be mounted.')
				return
			}

			const overlay = createOverlay(t, ctx)
			lastCtx = ctx
			installAppRefreshSeat(ctx)
			const action = createFooterAction(t)
			const menuAction = createSessionMenuAction(t)

			slots.inject('shell.overlay', () =>
				slots.register(
					{
						name: 'shell.overlay',
						id: OVERLAY_ID,
						order: 200,
						locale: NS,
					},
					overlay,
				),
			)
			slots.inject('sidebar.footer.action', () =>
				slots.register(
					{
						name: 'sidebar.footer.action',
						id: ACTION_ID,
						order: 10,
						label: () => t('button.label'),
						locale: NS,
					},
					action,
				),
			)
			// 侧栏会话行「…」菜单：删除入口（order 500，排在官方 session-id(450) 之后）。
			// ownerProps 里的 sessionId 就是这一行的会话 id；点完先用菜单钩子收起菜单，
			// 再派发同一个打开事件（带 { sessionId }）让弹窗预先勾好它。
			slots.inject('sidebar.workspaces.session.menu.item', () =>
				slots.register(
					{
						name: 'sidebar.workspaces.session.menu.item',
						id: MENU_ACTION_ID,
						order: 500,
						locale: NS,
						// 插槽本身提供的 hook：menuOpenState（菜单开合）。注册时声明后在组件
						// props 里以 useMenuOpenState 出现，用来点完收起菜单。缺了也不致命。
						inject: () => ({
							hooks: { menuOpenState: globalMenuOpenState },
						}),
					},
					menuAction,
				),
			)
		},
	}

	}
	window.__DSH_SESSION_MANAGER_FACTORY__ = factory
	if (typeof window.__ModuleLoader__?.load === 'function') {
		try {
			window.__ModuleLoader__.load({ id: 'dsh-session-manager', factory })
			return
		} catch (error) {}
	}
	try {
		factory(function (spec) {
			if (spec === 'react') {
				const g = globalThis
				const react = g.React ?? g.__DSH_REACT__
				if (react && typeof react.createElement === 'function') return react
			}
			throw new Error('dsh-session-manager: unexpected require(' + JSON.stringify(spec) + ')')
		})
	} catch (error) {
		console.error('[dsh-session-manager] standalone activation failed:', error)
	}
})()
