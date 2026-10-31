#!/usr/bin/env node
/**
 * extension-hold.mjs — 接管浮层的三处真机契约（在 node:vm 里加载**真实的** extension/background.js）。
 *
 * 起因（上游 v1.0.19 的 `2b278d2`）：合并 PR #18 后维护者在真环境逐条量出四处问题，其中三处
 * 属于"台子测不出来"的那一类 —— 假件只断言返回值就永远绿：
 *
 *   1. 模型自己的点击被自己的浮层吃掉（浮层全屏、z-index 最大，`Input.dispatchMouseEvent`
 *      按坐标派发先命中它），且同坐标连点两下会被浮层的「双击接管」当成用户操作；
 *   2. AX 快照把浮层自己编进去了（卡片上的「中止操作」是标准 button，进无障碍树占 ref，
 *      模型读到的是自己刚挂上去的那句话）；
 *   3. `hold on` 会把「用户中止」静默清掉（被拦一次 → 再 on 一次 → 照常点，全程不必问用户）；
 *   4. 只读档把 `hold status` 也拒了（只读的语义是"只让看"，不是"连看一眼都不给"）。
 *
 * 我们本地 #1 已有 `withHoldPassthrough` 挡住，#4 的只读白名单本来就含 `hold.status`；
 * **#2、#3 我们确实有**，这个套件就是为它们钉的钉子。断言方式刻意选"让假件真的执行页面侧
 * 表达式"，而不是断言我们以为它会返回什么 —— 后者的绿是假绿。
 *
 * 复现：node tests/extension-hold.mjs   （需要先 npm run build：classify 那组读 core 的 dist/）
 */

import vm from 'node:vm'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const results = []
const ok = (name, cond, detail) => {
	results.push({ name, pass: cond === true, detail })
	if (cond !== true) console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
}
const eq = (name, actual, expected) => ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)

/* ────────────────────────── 假 Chrome ────────────────────────── */

function makeArea() {
	const m = new Map()
	return {
		get: async (key) => (key === undefined || key === null
			? Object.fromEntries(m)
			: (typeof key === 'string' ? (m.has(key) ? { [key]: m.get(key) } : {}) : {})),
		set: async (obj) => { for (const [k, v] of Object.entries(obj || {})) m.set(k, v) },
		remove: async (key) => { (Array.isArray(key) ? key : [key]).forEach((k) => m.delete(k)) },
		_has: (k) => m.has(k),
		_map: m,
	}
}

/**
 * @param {(method: string, params: any) => any|null} onSend CDP 发送的处理器；返回 null 表示"没登记，用默认"
 */
function makeChrome(onSend) {
	const noop = () => {}
	const local = makeArea()
	const session = makeArea()
	/** chrome.runtime 的同一份引用：sendCommand 里要清掉上一枪的 lastError。 */
	const runtimeRef = {
		id: 'testextension',
		lastError: null,
		getManifest: () => ({ version: '1.0.40', manifest_version: 3 }),
		getURL: (p) => `chrome-extension://testextension/${p}`,
		onMessage: { addListener: noop },
		onInstalled: { addListener: noop },
		onStartup: { addListener: noop },
		sendMessage: async () => ({}),
	}
	/**
	 * 扩展用的是 **chrome.* 的 callback 形态**（`dbgSend` 里 `sendCommand(target, method, params, cb)`），
	 * 只返回 Promise 的假件会让 `await` 永远挂住 —— 这里两种形态都支持。
	 */
	/** 记录会抢焦点的两类调用，外加最近一次 windows.get 报的窗口状态。 */
	const calls = { tabsUpdate: [], tabsCreate: [], tabsGroup: [], windowsUpdate: [], focusThrows: 0 };
	let windowState = 'normal';
	const eventListeners = [];
	const detachListeners = []
	let pendingSendFailures = []   // [{ method, occurrence, message }]，按方法名 + 第几次命中消费
	const debuggerApi = {
		attachCount: 0,
		sendCount: 0,
		attach: async (target, version, cb) => {
			debuggerApi.attachCount += 1
			debuggerApi.attached = true
			if (typeof version === 'function') version()
			else if (typeof cb === 'function') cb()
		},
		detach: async (target, cb) => {
			debuggerApi.attached = false
			if (typeof cb === 'function') cb()
		},
		sendCommand: async (target, method, params, cb) => {
			debuggerApi.sendCount += 1
			const tabId = target && typeof target === 'object' ? target.tabId : target
			const hitCount = (pendingSendFailures.hits ||= new Map())
			const bumped = (hitCount.get(method) || 0) + 1
			hitCount.set(method, bumped)
			const idx = pendingSendFailures.findIndex((row) => row.method === method && row.occurrence === bumped)
			if (idx >= 0) {
				const failure = pendingSendFailures.splice(idx, 1)[0]
				runtimeRef.lastError = { message: failure.message }
				// 回调是同步的：扩展在回调里读 lastError，读完就清掉（真 chrome 也是这样，
				// 不清会让下一次 attach 误读到这条旧错误）。
				if (typeof cb === 'function') { cb(undefined); runtimeRef.lastError = null; return undefined }
				runtimeRef.lastError = null
				return undefined
			}
			const handled = onSend(method, params, tabId)
			let out = handled
			if (out === null || out === undefined) {
				if (method === 'Runtime.enable' || method === 'Page.enable' || method === 'DOM.enable'
					|| method === 'Accessibility.enable' || method === 'Network.enable') out = {}
				else if (method === 'Runtime.evaluate') {
					// 默认当作"正常显示、前台"的窗口：几何探针要有答案，否则会被判成窗口没显示
					const ex = String((params && params.expression) || '')
					out = ex.includes('outerWidth')
						? { result: { value: JSON.stringify({ ow: 1280, oh: 800, iw: 1280, ih: 800, vis: 'visible' }) } }
						: { result: { value: '' } }
				}
				else out = {}
			}
			// 探针类表达式即便 handler 回了空串，也要给一个"正常窗口"的默认答案，
			// 否则每个用例都得自己补几何/视口（真机上这两个探针几乎不会为空）。
			if (method === 'Runtime.evaluate' && out && out.result && String(out.result.value) === '') {
				const ex = String((params && params.expression) || '')
				if (ex.includes('innerWidth')) out = { result: { value: JSON.stringify({ w: 1280, h: 800, dpr: 1 }) } }
				else if (ex.includes('outerWidth')) out = { result: { value: JSON.stringify({ ow: 1280, oh: 800, vis: 'visible' }) } }
			}
			runtimeRef.lastError = null
			if (typeof cb === 'function') { cb(out); return undefined }
			return out
		},
		onEvent: { addListener: (fn) => eventListeners.push(fn) },
		onDetach: { addListener: (fn) => detachListeners.push(fn) },
		attached: false,
	}
	const chrome = {
		runtime: runtimeRef,
		tabs: {
			query: async () => [],
			get: async (id) => ({ id, url: 'https://example.com/', windowId: 1, active: true, title: 'example' }),
			update: async (id, props) => { calls.tabsUpdate.push(props); return { id, ...props } },
			create: async (props) => { calls.tabsCreate.push(props ?? {}); return { id: 1 } },
			remove: async () => {},
			onRemoved: { addListener: noop },
			onUpdated: { addListener: noop },
			onActivated: { addListener: noop },
			group: async (props) => { calls.tabsGroup.push(props ?? {}); return 1 },
			ungroup: async () => {},
			sendMessage: async () => ({}),
		},
		tabGroups: { query: async () => [], update: async () => ({}), get: async () => ({}), TAB_GROUP_ID_NONE: -1 },
		windows: {
			get: async () => ({ id: 1, state: windowState }),
			update: async (id, props) => { calls.windowsUpdate.push(props); return { id, ...props } },
			create: async () => ({ id: 1 }),
			getLastFocused: async () => ({ id: 1, state: windowState }),
			onRemoved: { addListener: noop },
		},
		debugger: debuggerApi,
		storage: { local, session, onChanged: { addListener: noop } },
		action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
		alarms: { create: noop, clear: async () => {}, onAlarm: { addListener: noop } },
		scripting: { executeScript: async () => [] },
		permissions: { contains: async () => true, request: async () => true },
		webNavigation: { onCommitted: { addListener: noop } },
		i18n: { getMessage: (k) => k },
	}
	return {
		chrome, local, session, calls, debugger: debuggerApi,
		setWindowState: (next) => { windowState = next },
		/** 让指定方法的第 occurrence 次 sendCommand 失败；只消费一次。 */
		failOnMethod: (method, message, occurrence = 1) => { pendingSendFailures.push({ method, occurrence: Math.max(1, occurrence), message }) },
		/** 模拟 Chrome 主动 detach（用户开了 DevTools、页面变成 chrome-extension://、导航竞态）。 */
		fireDetach: (tabId, reason = 'canceled_by_user') => { for (const fn of detachListeners) fn({ tabId }, reason) },
		fireCdp: (tabId, method, params) => { for (const fn of eventListeners) fn({ tabId }, method, params) },
	}
}

/** 在 node:vm 里加载真实的 background.js，返回它的顶层函数与常量。 */
async function loadWorker(onSend) {
	const code = await readFile(path.join(root, 'extension', 'background.js'), 'utf8')
	const fake = makeChrome(onSend)
	const chrome = fake.chrome
	const sandbox = {
		chrome,
		console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
		setTimeout, clearTimeout, setInterval, clearInterval,
		crypto: globalThis.crypto, structuredClone, performance: globalThis.performance,
		URL, AbortController, AbortSignal, TextEncoder, TextDecoder,
		// 桥：测试里连不上，init() 会退避重试 —— 断言完 process.exit 收工，定时器不影响结果。
		fetch: async () => { throw new Error('no bridge in test') },
		WebSocket: class FakeWebSocket { constructor() { this.readyState = 0 } addEventListener() {} close() {} send() {} },
		document: undefined, window: undefined, self: undefined,
	}
	sandbox.globalThis = sandbox
	const ctx = vm.createContext(sandbox)
	new vm.Script(code).runInContext(ctx)
	return { ctx, chrome, fake }
}

/** 从源码里取出模板字符串拼接出来的页面侧函数（`const NAME = '...' + '...';`）。 */
function extractConcatString(source, name) {
	const at = source.indexOf(`const ${name} = `)
	if (at < 0) throw new Error(`源码里找不到 ${name}`)
	const rest = source.slice(at + `const ${name} = `.length)
	const lines = rest.split('\n')
	const parts = []
	for (const line of lines) {
		parts.push(line)
		// 定义结尾固定是 `\t+ '}';`（函数体收尾）—— 不能只靠 "\}" 判，因为前面的 `'};'` 也带花括号
		if (/^\s*\+ '}';\s*$/.test(line) && parts.length > 1) break
	}
	const expr = parts.join('\n').replace(/;\s*$/, '')
	return new Function(`return (${expr})`)()
}

/* ────────────────────────── 断言：AX 快照排除浮层 ────────────────────────── */

async function testAxExclusion() {
	const source = await readFile(path.join(root, 'extension', 'background.js'), 'utf8')
	const stampSource = extractConcatString(source, 'AX_STAMP_FN')
	// AX_STAMP_FN 本身是"函数源码字符串"（CDP 的 functionDeclaration 要的就是这个形状），
	// 所以在台子上先求值成真函数，再拿假节点去喂它。
	const stamp = new Function(`return (${stampSource})`)()
	ok('AX_STAMP_FN 能被取出并求值（是个函数）', typeof stamp === 'function', typeof stamp)

	const host = {
		nodeType: 1,
		closest: (sel) => (sel === '[data-dsh-hold]' ? host : null),
	}
	/** 浮层 shadow root 内部的可操作节点：`closest` 跨不出 shadow 边界，必须靠 getRootNode().host。 */
	const innerButton = {
		attrs: new Map(),
		getBoundingClientRect: () => ({ left: 10, top: 10, width: 80, height: 24 }),
		closest: () => null,
		getRootNode: () => ({ host }),
		setAttribute(k, v) { this.attrs.set(k, v) },
		tagName: 'BUTTON',
	}
	const own = stamp.call(innerButton, 'e1')
	ok('shadow 内的浮层节点被判成自己的浮层（不占 ref）', own && own.ownOverlay === true, JSON.stringify(own))
	eq('浮层节点没有被写 data-dsh-ref', innerButton.attrs.has('data-dsh-ref'), false)

	const pageButton = {
		attrs: new Map(),
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 20 }),
		closest: () => null,
		getRootNode: () => ({ host: null }),
		setAttribute(k, v) { this.attrs.set(k, v) },
		tagName: 'BUTTON',
	}
	const page = stamp.call(pageButton, 'e2')
	ok('页面自己的节点照常打 ref 并回报几何', page && page.tag === 'button' && pageButton.attrs.get('data-dsh-ref') === 'e2', JSON.stringify(page))

	// 反向：浮层不在场时不能因为"看起来像按钮"就被误判
	const plain = { ...pageButton, attrs: new Map(), getRootNode: () => ({}) }
	const reverse = stamp.call(plain, 'e3')
	ok('反向：没有 data-dsh-hold 祖先时不会被误判成浮层', reverse && reverse.ownOverlay !== true)

	const src = source
	ok('snapshotViaAx 把 ownOverlay 从 total 里扣除', /total: candidates\.length - ownOverlay/.test(src))
	ok('snapshotViaAx 回报 ax.ownOverlay', /ownOverlay, \.\.\.skipped/.test(src) && /let ownOverlay = 0/.test(src))
}


/** 从源码里取出一个顶层 `function NAME(...) {` 声明（按花括号配平），返回它的源码字符串。 */
function extractFunction(source, name) {
	const at = source.indexOf(`function ${name}(`)
	if (at < 0) throw new Error(`源码里找不到 function ${name}`)
	let i = source.indexOf('{', at)
	let depth = 0
	for (; i < source.length; i++) {
		const ch = source[i]
		if (ch === '{') depth += 1
		else if (ch === '}') { depth -= 1; if (depth === 0) return source.slice(at, i + 1) }
	}
	throw new Error(`function ${name} 花括号没配平`)
}

/**
 * 一台够用的假 DOM：只实现 pageShowHold / pageHoldStatus 真正用到的那几个 API。
 * `fullscreenElement` 与 `elementFromPoint` 由用例现场摆布 —— 这两个就是全屏覆盖问题的全部变量。
 */
function makeFakeDom() {
	let listening = new Map()
	const makeNode = (tag) => {
		const node = {
			tagName: String(tag).toUpperCase(),
			id: '',
			type: '',
			textContent: '',
			style: { cssText: '' },
			children: [],
			parentNode: null,
			shadowRoot: null,
			listeners: [],
			attrs: new Map(),
			setAttribute(k, v) { this.attrs.set(k, v) },
			getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null },
			appendChild(child) {
				if (child.parentNode) child.parentNode.removeChild(child)
				child.parentNode = this
				this.children.push(child)
				return child
			},
			removeChild(child) {
				const i = this.children.indexOf(child)
				if (i >= 0) this.children.splice(i, 1)
				child.parentNode = null
				return child
			},
			contains(other) {
				if (!other) return false
				if (other === this) return true
				for (const c of this.children) if (c.contains(other)) return true
				return false
			},
			attachShadow() { const r = makeNode('shadow-root'); this.shadowRoot = r; return r },
			addEventListener(type, fn) { this.listeners.push({ type, fn }) },
			removeEventListener(type, fn) {
				const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn)
				if (i >= 0) this.listeners.splice(i, 1)
			},
			focus() {},
			getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 40 } },
		}
		return node
	}
	const documentElement = makeNode('html')
	const dom = {
		documentElement,
		fullscreenElement: null,
		activeElement: null,
		documentElementChildren: documentElement.children,
		createElement: (tag) => {
			const n = makeNode(tag)
			n.setAttribute = function (k, v) { this.attrs.set(k, v); if (k === 'id') this.id = v }
			return n
		},
		/** 现场摆布：返回哪个节点就是"用户在那一层看到的" */
		hitNode: undefined,
		/** 默认"浮层盖住了"：返回浮层宿主；用例要用别的结果时显式摆 hitNode。 */
		elementFromPoint() {
			if (this.hitNode !== undefined) return this.hitNode
			return this.getElementById('__dsh_hold_overlay__')
		},
		getElementById(id) {
			const walk = (n) => {
				if (n.id === id) return n
				for (const c of n.children) { const f = walk(c); if (f) return f }
				if (n.shadowRoot) { const f = walk(n.shadowRoot); if (f) return f }
				return null
			}
			return walk(documentElement)
		},
		addEventListener(type, fn) { listening.set(type, [...(listening.get(type) ?? []), fn]) },
		removeEventListener(type, fn) { listening.set(type, (listening.get(type) ?? []).filter((f) => f !== fn)) },
		fire(type) { for (const fn of [...(listening.get(type) ?? [])]) fn({ type }) },
		listenerCount(type) { return (listening.get(type) ?? []).length },
		clearListeners() { listening = new Map() },
		fake: makeNode,
	}
	return dom
}

/** 在假 DOM 里跑真实的 pageShowHold / pageHoldStatus。 */
function makeHoldSandbox(dom, source) {
	const code = `${extractFunction(source, 'pageShowHold')}\n${extractFunction(source, 'pageHoldStatus')}\n`
	const win = {
		innerWidth: 1200,
		innerHeight: 800,
		addEventListener() {},
		removeEventListener() {},
		setTimeout, clearTimeout,
	}
	const sandbox = {
		document: dom,
		window: win,
		setTimeout, clearTimeout,
	}
	sandbox.globalThis = sandbox
	win.__proto__ = sandbox
	const ctx = new Function('document', 'window', 'setTimeout', 'clearTimeout',
		`${code}\nreturn { pageShowHold, pageHoldStatus };`)(dom, win, setTimeout, clearTimeout)
	return ctx
}

/* ────────────────────────── 断言：全屏覆盖（第四个"盖不住"的场景） ────────────────────────── */

async function testFullscreenCoverage() {
	const source = await readFile(path.join(root, 'extension', 'background.js'), 'utf8')
	const payload = {
		title: '模型正在操作此标签页', text: 'x', hint: 'h', hintOne: 'h1',
		dblMs: 500, abortLabel: '中止操作', abortConfirmLabel: '点击确认', armMs: 3000, blockKeys: false,
	}

	// ① 普通页面：挂到 documentElement，命中测试返回宿主 ⇒ covered:true
	{
		const dom = makeFakeDom()
		const api = makeHoldSandbox(dom, source)
		const res = api.pageShowHold(payload)
		const host = dom.getElementById('__dsh_hold_overlay__')
		const res2 = api.pageHoldStatus()
		ok('普通页面：宿主挂在 documentElement 上', host !== null && host.parentNode === dom.documentElement)
		ok('普通页面：covered:true', res2.covered === true, JSON.stringify(res2))
		ok('普通页面：pageShowHold 返回里就带 covered', res.covered === true, JSON.stringify(res))
	}

	// ② 全屏元素在场：宿主必须挂进全屏子树（否则被 top layer 盖住），且 covered:true
	{
		const dom = makeFakeDom()
		const api = makeHoldSandbox(dom, source)
		const fs = dom.createElement('div')
		fs.tagName = 'DIV'
		dom.documentElement.appendChild(fs)
		dom.fullscreenElement = fs
		const res = api.pageShowHold(payload)
		const host = dom.getElementById('__dsh_hold_overlay__')
		ok('全屏：宿主被挂进全屏元素子树', host !== null && host.parentNode === fs, host && host.parentNode && host.parentNode.tagName)
		ok('全屏：挂进去之后 covered:true', res.covered === true && res.reason === undefined, JSON.stringify(res))
	}

	// ③ 全屏元素是 iframe（跨源全屏的真正形态）：挂不进去 ⇒ 必须如实报 covered:false
	{
		const dom = makeFakeDom()
		const api = makeHoldSandbox(dom, source)
		const fs = dom.createElement('iframe')
		fs.tagName = 'IFRAME'
		dom.documentElement.appendChild(fs)
		dom.fullscreenElement = fs
		dom.hitNode = fs
		const res = api.pageShowHold(payload)
		ok('全屏 iframe：covered:false', res.covered === false, JSON.stringify(res))
		eq('全屏 iframe：原因', res.reason, 'fullscreen-iframe')
	}

	// ④ 挂上之后才进全屏：监听 fullscreenchange 把宿主搬进全屏子树
	{
		const dom = makeFakeDom()
		const api = makeHoldSandbox(dom, source)
		api.pageShowHold(payload)
		const host = dom.getElementById('__dsh_hold_overlay__')
		const fs = dom.createElement('div')
		dom.documentElement.appendChild(fs)
		dom.fullscreenElement = fs
		dom.fire('fullscreenchange')
		ok('后进全屏：fullscreenchange 之后宿主被搬进全屏子树', host.parentNode === fs, host.parentNode && host.parentNode.tagName)
		eq('后进全屏：停掉了监听器数量（应当是 1 个）', dom.listenerCount('fullscreenchange'), 1)
		// 退出全屏：搬回 documentElement
		dom.fullscreenElement = null
		dom.fire('fullscreenchange')
		ok('退出全屏：宿主搬回 documentElement', host.parentNode === dom.documentElement)
	}

	// ⑤ 反向：全屏元素在场、宿主却还在 body 层（旧实现）⇒ status 必须说 covered:false
	{
		const dom = makeFakeDom()
		const api = makeHoldSandbox(dom, source)
		api.pageShowHold(payload)
		const host = dom.getElementById('__dsh_hold_overlay__')
		const fs = dom.createElement('div')
		dom.documentElement.appendChild(fs)
		dom.documentElement.appendChild(host) // 手动搬回 body 层，模拟"没搬进去"
		dom.fullscreenElement = fs
		dom.hitNode = fs
		const status = api.pageHoldStatus()
		ok('旧形状：全屏时宿主流落在 body 层 ⇒ covered:false', status.covered === false, JSON.stringify(status))
		eq('旧形状：原因', status.reason, 'fullscreen-behind-top-layer')
	}

	// ⑥ 判定用的是现场命中测试，不是"我挂上去了"：挂上了但没命中 ⇒ covered:false
	{
		const dom = makeFakeDom()
		const api = makeHoldSandbox(dom, source)
		api.pageShowHold(payload)
		dom.hitNode = dom.createElement('div')
		const status = api.pageHoldStatus()
		ok('命中测试没打到宿主 ⇒ covered:false', status.covered === false, JSON.stringify(status))
		eq('命中测试失败的原因', status.reason, 'hit-test-miss')
	}
}

/* ────────────────────────── 断言：不抢焦点 / 弹窗关掉后补层 ────────────────────────── */

async function testFocusPolicy() {
	// 默认 auto：只切标签页，**不**把窗口提到前台（抢焦点是误触来源）
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: '' } }))
		await ctx.activateTabWindow(7)
		eq('auto：切了标签页', fake.calls.tabsUpdate.length, 1)
		eq('auto：没有把窗口提到前台', fake.calls.windowsUpdate.length, 0)
	}
	// always：保留旧行为
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: '' } }))
		await ctx.cmdFocusConfig({ mode: 'always' })
		await ctx.activateTabWindow(7)
		ok('always：窗口被提到前台', fake.calls.windowsUpdate.some((p) => p.focused === true), JSON.stringify(fake.calls.windowsUpdate))
	}
	// never：连标签页都不切
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: '' } }))
		await ctx.cmdFocusConfig({ mode: 'never' })
		await ctx.activateTabWindow(7)
		eq('never：既不切标签页也不抢焦点', fake.calls.tabsUpdate.length + fake.calls.windowsUpdate.length, 0)
	}
	// 非法值回落 auto（不抢焦点最安全）
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: '' } }))
		const res = await ctx.cmdFocusConfig({ mode: 'nope' })
		eq('非法 focus mode ⇒ auto', res.mode, 'auto')
		await ctx.activateTabWindow(7)
		eq('非法 focus mode 下也不抢焦点', fake.calls.windowsUpdate.length, 0)
	}
	// 最小化：activateTabWindow 只如实回报状态、不抛错也不擅自恢复（2026-10-23 起）
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: '' } }))
		fake.setWindowState('minimized')
		const status = await ctx.activateTabWindow(7)
		eq('最小化 ⇒ 状态如实回报', status && status.windowState, 'minimized')
		eq('最小化时不擅自恢复/抢焦点', fake.calls.windowsUpdate.length, 0)
	}
}

async function testWindowStateAndViewport() {
	/** 统一的假 CDP：视口尺寸由 `vp` 摆布，点击命中按正常返回。 */
	const makeHandler = (vp) => (method, params) => {
		if (method === 'Input.dispatchMouseEvent') return {}
		if (method !== 'Runtime.evaluate') return null
		const ex = String((params && params.expression) || '')
		if (ex.includes('innerWidth')) return { result: { value: JSON.stringify(vp) } }
		if (ex.includes('pointerEvents')) return { result: { value: false } }
		if (ex.includes('__dshPick')) return { result: { value: { x: 10, y: 20, tag: 'button', text: 'go', hitTag: 'button', isTop: true, relocated: false } } }
		return { result: { value: '' } }
	}

	// ① 最小化但视口仍有尺寸（渲染器保留布局）：应当照常干活，而不是先拒
	{
		const { ctx, fake } = await loadWorker(makeHandler({ w: 1200, h: 800, dpr: 1 }))
		fake.setWindowState('minimized')
		let res = null
		let err = null
		try { res = await ctx.cmdClick({ selector: '#go', tabId: 7 }) } catch (e) { err = e }
		ok('最小化但视口有尺寸 ⇒ 不被拦下', err === null, err && (err.code || err.message))
		ok('最小化但视口有尺寸 ⇒ 照常派发点击', !!(res && res.hitVerified === true), JSON.stringify(res))
		eq('回执如实带 windowState=minimized', res && res.windowState, 'minimized')
		ok('回执带视口尺寸（模型可据此判断坐标是否过期）', res && res.viewport && res.viewport.w === 1200 && res.viewport.h === 800, JSON.stringify(res && res.viewport))
	}

	// ② 最小化 + 视口 0×0：拒绝，并给出可操作的出路
	{
		const { ctx, fake } = await loadWorker(makeHandler({ w: 0, h: 0, dpr: 1 }))
		fake.setWindowState('minimized')
		let err = null
		try { await ctx.cmdClick({ selector: '#go', tabId: 7 }) } catch (e) { err = e }
		ok('0×0 视口 ⇒ 拒绝（window_not_shown）', err !== null && err.code === 'window_not_shown', err && (err.code || err.message))
		ok('拒因说清"输入无处可落"并指出读取类不受影响',
			err !== null && /视口/.test(err.message) && /读取类命令不受影响/.test(err.message), err && err.message.slice(0, 120))
	}

	// ③ 打开「最小化时自动恢复窗口」：先恢复再执行，且只恢复、不抢焦点
	{
		const { ctx, fake } = await loadWorker(makeHandler({ w: 1200, h: 800, dpr: 1 }))
		await ctx.cmdFocusConfig({ mode: 'auto', restoreMinimized: true })
		fake.setWindowState('minimized')
		const res = await ctx.cmdClick({ selector: '#go', tabId: 7 })
		ok('自动恢复：调了 windows.update({state:normal})', fake.calls.windowsUpdate.some((p) => p.state === 'normal'), JSON.stringify(fake.calls.windowsUpdate))
		ok('自动恢复：没有顺手抢焦点（auto 不 focused）', !fake.calls.windowsUpdate.some((p) => p.focused === true), JSON.stringify(fake.calls.windowsUpdate))
		eq('自动恢复：回执标明恢复过', res && res.windowRestored, true)
	}

	// ④ 窗口被改过大小：下一次输入类命令如实报 viewportChanged
	{
		const state = { w: 1200, h: 800, dpr: 1 }
		const { ctx } = await loadWorker((method, params) => makeHandler(state)(method, params))
		await ctx.cmdClick({ selector: '#go', tabId: 7 })
		state.w = 900
		const second = await ctx.cmdClick({ selector: '#go', tabId: 7 })
		ok('尺寸变化后的下一次调用报 viewportChanged', second && second.viewportChanged === true, JSON.stringify(second && second.viewport))
		eq('并带回上一次的尺寸', second && second.previousViewport, '1200x800@1')
		eq('视口本身是新的尺寸', second && second.viewport.w, 900)
	}
}

async function testHoldEvidenceAndInputGate() {
	/* H1：只有页面里的只读镜像记着"用户接管"才抑制自动补层。
	 * 导航会销毁浮层（镜像也随之消失），不能因此把这一页永久标记成"用户已接管"。 */
	{
		const { ctx, fake } = await loadWorker((method, params) => {
			if (method === 'Runtime.evaluate' && String(params.expression).includes('__dshHold')) {
				return { result: { value: { active: false, dismissedBy: 'user' } } }
			}
			return null
		})
		await ctx.suppressAutoHoldIfTaken(7)
		const stored = await fake.local.get('holdSuppressed')
		ok('H1：镜像说 dismissedBy=user ⇒ 抑制成立', Array.isArray(stored.holdSuppressed) && stored.holdSuppressed.includes(7), JSON.stringify(stored))
	}
	{
		const { ctx, fake } = await loadWorker((method, params) => {
			if (method === 'Runtime.evaluate' && String(params.expression).includes('__dshHold')) {
				// 文档被换掉：浮层没了，镜像也没了（dismissedBy=null）
				return { result: { value: { active: false, dismissedBy: null } } }
			}
			return null
		})
		await ctx.suppressAutoHoldIfTaken(7)
		const stored = await fake.local.get('holdSuppressed')
		ok('H1：浮层因导航消失 ≠ 用户接管（不抑制）', !(Array.isArray(stored.holdSuppressed) && stored.holdSuppressed.includes(7)), JSON.stringify(stored))
	}
	{
		const { ctx, fake } = await loadWorker(() => null)
		// 探针失败（CDP 卡住/页面在导航）⇒ 不下结论
		await ctx.suppressAutoHoldIfTaken(7)
		const stored = await fake.local.get('holdSuppressed')
		ok('H1：探不到状态时不动抑制表', !(Array.isArray(stored.holdSuppressed) && stored.holdSuppressed.includes(7)), JSON.stringify(stored))
	}

	/* H2：用户在浮层上按了「中止操作」之后，输入也必须被拦（以前这一枪误挂在读命令上）。 */
	{
		const { ctx } = await loadWorker((method, params) => {
			const ex = String(params && params.expression ? params.expression : '')
			if (ex.includes('s.aborted === true')) return { result: { value: JSON.stringify({ text: '用户点了中止' }) } }
			return null
		})
		let err = null
		try { await ctx.cmdInput({ selector: '#x', value: 'v', tabId: 7 }) } catch (e) { err = e }
		ok('H2：中止之后 input 被拒', err !== null && /用户终止控制/.test(err.message), err && err.message)
	}
}

async function testCdpSessionRecovery() {
	const DETACHED = 'Debugger is not attached to the tab with id: 7'

	/* A. 第一条 CDP 就撞上"会话丢了" ⇒ 透明重连一次并成功 */
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: 'ok' } }))
		fake.failOnMethod('Runtime.evaluate', DETACHED, 1)
		const out = await ctx.withCDP(7, (send) => send('Runtime.evaluate', { expression: '1', returnByValue: true }))
		eq('A：读命令照常返回结果', out && out.result ? out.result.value : out, 'ok')
		eq('A：重新 attach 了一次', fake.debugger.attachCount, 2)
	}

	/* B. 失败发生在第二条 CDP 调用上 ⇒ **不重放**（重放会重复派发副作用） */
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: 'ok' } }))
		await ctx.withCDP(7, (send) => send('Runtime.evaluate', { expression: 'warm', returnByValue: true }))
		const before = fake.debugger.attachCount
		fake.failOnMethod('Runtime.evaluate', DETACHED, 3)
		let err = null
		try {
			await ctx.withCDP(7, async (send) => {
				await send('Runtime.evaluate', { expression: '1', returnByValue: true })
				await send('Runtime.evaluate', { expression: '2', returnByValue: true })
			})
		} catch (e) { err = e }
		ok('B：第二条失败必须抛出（不替调用方重放）', err !== null && /not attached/i.test(err.message), err && err.message)
		eq('B：没有因为这次失败而重连', fake.debugger.attachCount, before)
	}

	/* C. Chrome 主动 detach 后，缓存必须失效，下一条命令重新 attach */
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: 'ok' } }))
		await ctx.withCDP(7, (send) => send('Runtime.evaluate', { expression: '1', returnByValue: true }))
		const afterFirst = fake.debugger.attachCount
		fake.fireDetach(7, 'canceled_by_user')
		await ctx.withCDP(7, (send) => send('Runtime.evaluate', { expression: '1', returnByValue: true }))
		eq('C：detach 之后下一条命令重新附加', fake.debugger.attachCount, afterFirst + 1)
	}

	/* D. 不是"会话丢了"的错 ⇒ 不重连（重连也救不了，只会白试一次） */
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: 'ok' } }))
		await ctx.withCDP(7, (send) => send('Runtime.evaluate', { expression: 'warm', returnByValue: true }))
		const before = fake.debugger.attachCount
		fake.failOnMethod('Runtime.evaluate', 'Cannot access a chrome-extension:// URL of different extension', 2)
		let err = null
		try {
			await ctx.withCDP(7, (send) => send('Runtime.evaluate', { expression: '1', returnByValue: true }))
		} catch (e) { err = e }
		ok('D：永久性错误原样抛出', err !== null && /chrome-extension/.test(err.message), err && err.message)
		eq('D：没有白试一次重连', fake.debugger.attachCount, before)
	}
}

async function testWokenTabReuse() {
	/* B：唤醒建了窗口、紧接着 tabs.open 要去同一个地址 ⇒ 复用那张，不再 new 一张
	 *    （2026-10-24 实测的重复标签页就是这个形状：一张未归组、一张归组、同地址） */
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: '' } }))
		const calls = fake.calls
		fake.chrome.tabs.query = async () => []
		fake.chrome.tabs.get = async (id) => ({ id, url: 'about:blank', windowId: 9, active: true, title: '' })
		fake.chrome.windows.create = async () => ({ id: 9, tabs: [{ id: 501, url: 'about:blank', windowId: 9 }] })
		fake.chrome.tabGroups.query = async () => []
		fake.chrome.tabGroups.update = async () => ({})
		const info = await ctx.ensureWindow('test')
		ok('唤醒确实新建了窗口', info.created === true, JSON.stringify(info))
		eq('C：唤醒建的标签页也被归组', calls.tabsGroup.length, 1)
		const out = await ctx.cmdTabsOpen({ url: 'https://x.test/', active: true, group: false, wait: false })
		eq('B：复用唤醒那张，不再新建', calls.tabsCreate.length, 0)
		eq('回执给出复用的 tabId', out.tabId, 501)
		eq('回执标出 reused', out.reused, true)
		ok('复用时把地址更新到目标', calls.tabsUpdate.some((p) => p.url === 'https://x.test/'), JSON.stringify(calls.tabsUpdate))
	}

	/* 没有唤醒标签页时仍然按老语义新建（别把"复用"做成所有 tabs.open 都去凑已有的页） */
	{
		const { ctx, fake } = await loadWorker(() => ({ result: { value: '' } }))
		const calls = fake.calls
		fake.chrome.tabs.query = async () => [{ id: 601, url: 'https://a.test/', windowId: 1, active: true }]
		fake.chrome.tabs.get = async (id) => ({ id, url: 'https://a.test/', windowId: 1, active: true, title: 'a' })
		fake.chrome.tabs.create = async (props) => { calls.tabsCreate.push(props ?? {}); return { id: 602 } }
		const out = await ctx.cmdTabsOpen({ url: 'https://b.test/', group: false, wait: false })
		eq('没有可复用的唤醒标签页 ⇒ 照常新建', calls.tabsCreate.length, 1)
		eq('新建的 tabId 带回', out.tabId, 602)
		ok('不标 reused', out.reused === undefined, JSON.stringify(out))
	}
}

async function testWindowNotShown() {
	/** 假页面按脚本返回几何：第一次 0×0，落位后变成真几何。 */
	const makeGeomWorker = (sequence) => {
		let i = 0
		return loadWorker((method, params) => {
			if (method === 'Input.dispatchMouseEvent') return {}
			if (method !== 'Runtime.evaluate') return null
			const ex = String((params && params.expression) || '')
			if (ex.includes('outerWidth')) {
				const g = sequence[Math.min(i, sequence.length - 1)]
				i += 1
				return { result: { value: JSON.stringify(g) } }
			}
			if (ex.includes('innerWidth')) return { result: { value: JSON.stringify({ w: 1000, h: 700, dpr: 2 }) } }
			if (ex.includes('pointerEvents')) return { result: { value: false } }
			if (ex.includes('__dshPick')) return { result: { value: { x: 10, y: 20, tag: 'button', text: 'go', hitTop: true, isTop: true, relocated: false } } }
			return { result: { value: '' } }
		})
	}

	// ① 正常几何：不该去 focus 窗口（不抢焦点）
	{
		const { ctx, fake } = await makeGeomWorker([{ ow: 1200, oh: 800, iw: 1200, ih: 800, vis: 'visible' }])
		await ctx.cmdClick({ selector: '#go', tabId: 7 })
		eq('有几何时不去 focus 窗口', fake.calls.windowsUpdate.filter((p) => p.focused === true).length, 0)
	}

	// ② 几何 0×0 → 先 focus 让它落位，探到真几何后继续执行
	{
		const { ctx, fake } = await makeGeomWorker([
			{ ow: 0, oh: 0, iw: 1000, ih: 700, vis: 'hidden' },
			{ ow: 1200, oh: 800, iw: 1200, ih: 800, vis: 'visible' },
		])
		let res = null; let err0 = null
		try { res = await ctx.cmdClick({ selector: '#go', tabId: 7 }) } catch (e) { err0 = e }
		ok('0×0 但落位成功 ⇒ 不报错', err0 === null, err0 && (err0.code || err0.message))
		ok('0×0 时尝试让窗口落位（focused:true）', fake.calls.windowsUpdate.some((p) => p.focused === true), JSON.stringify(fake.calls.windowsUpdate))
		ok('落位成功后照常派发点击', res && res.hitVerified === true, JSON.stringify(res))
	}

	// ③ 几何一直是 0×0 → 结构化拒绝（不假装成功、不派发任何输入）
	{
		const dispatched = []
		const { ctx } = await makeGeomWorker([
			{ ow: 0, oh: 0, iw: 1000, ih: 700, vis: 'hidden' },
			{ ow: 0, oh: 0, iw: 1000, ih: 700, vis: 'hidden' },
		])
		let err = null
		try { await ctx.cmdClick({ selector: '#go', tabId: 7 }) } catch (e) { err = e }
		ok('几何一直 0×0 ⇒ 报错', err !== null && err.code === 'window_not_shown', err && (err.code || err.message))
		ok('错误带 browser-window-not-shown: 前缀（插件侧据此归类）', err !== null && String(err.message).indexOf('browser-window-not-shown:') === 0, err && err.message.slice(0, 60))
		eq('没有派发任何鼠标事件', dispatched.length, 0)
	}
}

async function testNavigationWaitModes() {
	/** 假标签页状态：url + status 可摆布；tabs.update 会把地址带过去并置成 loading。 */
	const makeNavWorker = () => {
		let state = { url: 'https://old.example/', status: 'complete' };
		let readyState = 'interactive';
		const fakeTab = { id: 7, windowId: 1, active: true, title: 'old' };
		return loadWorker((method, params) => {
			if (method !== 'Runtime.evaluate') return null
			const ex = String((params && params.expression) || '')
			if (ex.includes('readyState') && ex.includes('href')) {
				return { result: { value: JSON.stringify({ href: state.url, readyState, mainFrameError: false }) } }
			}
			if (ex.includes('document.readyState')) return { result: { value: readyState } }
			if (ex.includes('__dshHold')) return { result: { value: '' } }
			return { result: { value: '' } }
		}).then((w) => {
			w.fake.setNavState = (next) => { state = Object.assign(state, next) }
			w.fake.getNavState = () => state
			w.fake.setReadyState = (next) => { readyState = next }
			// 让 tabs.get 反映真实状态、tabs.update 把地址带过去
			const realGet = w.chrome.tabs.get
			const realUpdate = w.chrome.tabs.update
			w.chrome.tabs.get = async (id) => ({ ...fakeTab, id, url: state.url, status: state.status, pendingUrl: state.status === 'loading' ? state.url : undefined })
			w.chrome.tabs.update = async (id, props) => {
				if (props && typeof props.url === 'string') {
					state = { url: props.url, status: 'loading' }
				}
				return realUpdate ? await realUpdate(id, props) : { id }
			}
			return w
		})
	}

	// ① waitUntil='none'：立刻回，且如实说"还在加载"
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('loading')
		const res = await ctx.cmdNav({ url: 'https://new.example/', tabId: 7, waitUntil: 'none' })
		eq('none：等待口径回显 none', res.waitUntil, 'none')
		ok('none：不等页面加载（loadPending）', res.loadPending === true, JSON.stringify(res))
		ok('none：耗时很短（<300ms）', typeof res.waitedMs === 'number' && res.waitedMs < 300, String(res.waitedMs))
	}

	// ② waitUntil='commit'：新文档一开始替换旧文档就回（靠 CDP 的 frameNavigated，不靠地址变化）
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('loading')
		const pending = ctx.cmdNav({ url: 'https://new.example/', tabId: 7, waitUntil: 'commit', timeoutMs: 2000 })
		await new Promise((r) => setTimeout(r, 40))
		fake.fireCdp(7, 'Page.frameNavigated', { frame: { url: 'https://new.example/', parentId: undefined } })
		const res = await pending
		eq('commit：等待口径回显 commit', res.waitUntil, 'commit')
		ok('commit：新文档到达即回（loadPending）', res.loadPending === true, JSON.stringify(res))
		ok('commit：远快于预算（<1500ms）', res.waitedMs < 1500, String(res.waitedMs))
	}

	// ③ 默认口径 = load（2026-10-30 与上游对齐；domcontentloaded 变成显式选项）
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('complete')
		const res = await ctx.cmdNav({ url: 'https://new.example/', tabId: 7 })
		eq('默认口径是 load', res.waitUntil, 'load')
		eq('load：回显 readyState', res.readyState, 'complete')
		ok('load：整页加载完才算到达', res.loadPending === undefined, JSON.stringify(res))
	}

	// ③b 显式 domcontentloaded：readyState 一变成 interactive 就回（元素可能还没挂上）
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('interactive')
		fake.setNavState({ status: 'loading' }) // 还在 loading，但 DOM 已可用
		const res = await ctx.cmdNav({ url: 'https://new.example/', tabId: 7, waitUntil: 'domcontentloaded' })
		eq('domcontentloaded：口径回显', res.waitUntil, 'domcontentloaded')
		eq('domcontentloaded：回显 readyState', res.readyState, 'interactive')
		ok('domcontentloaded：DOM 可用即回（不等 load）', res.loadPending === true, JSON.stringify(res))
	}

	// ④ 非法口径回落默认，不能让模型写错就变慢/报错
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('complete')
		const res = await ctx.cmdNav({ url: 'https://new.example/', tabId: 7, waitUntil: 'whenever' })
		eq('非法 waitUntil ⇒ load（默认口径）', res.waitUntil, 'load')
	}

	// ④b 同站重定向/刷新回到同一个地址（bing.com ↔ cn.bing.com）：地址启发式会等满预算，
	//     现在靠 frameNavigated，必须立刻回
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('loading')
		// 目标与"当前地址"完全相同，模拟"改了没变"的那种重定向
		fake.setNavState({ url: 'https://cn.bing.example/' })
		const pending = ctx.cmdNav({ url: 'https://www.bing.example/', tabId: 7, waitUntil: 'commit', timeoutMs: 5000 })
		await new Promise((r) => setTimeout(r, 40))
		fake.fireCdp(7, 'Page.frameNavigated', { frame: { url: 'https://cn.bing.example/', parentId: undefined } })
		const res = await pending
		ok('同站重定向：立刻算到达（<1500ms）', typeof res.waitedMs === 'number' && res.waitedMs < 1500, String(res.waitedMs))
		eq('同站重定向：口径 commit', res.waitUntil, 'commit')
	}

	// ⑤ 默认预算：非 load 口径 4s、load 仍 15s；显式 timeoutMs 优先（黑洞目标不再干等 15 秒）
	{
		const { ctx } = await loadWorker(() => ({ result: { value: '' } }))
		eq('domcontentloaded 预算 = 4000ms（显式时才用它）', ctx.navBudget('domcontentloaded', undefined), 4000)
		eq('commit 预算 = 4000ms', ctx.navBudget('commit', undefined), 4000)
		eq('none 预算 = 0', ctx.navBudget('none', undefined), 0)
		eq('load 预算仍 15000ms', ctx.navBudget('load', undefined), 15000)
		eq('显式 timeoutMs 优先', ctx.navBudget('domcontentloaded', 900), 900)
	}

	// ⑥ load：仍然按老口径等（这里页面一直 loading ⇒ 超时并如实报）
	{
		const { ctx, fake } = await makeNavWorker()
		fake.setReadyState('interactive')
		fake.setNavState({ status: 'loading' })
		const res = await ctx.cmdNav({ url: 'https://slow.example/', tabId: 7, waitUntil: 'load', timeoutMs: 250 })
		eq('load：等待口径回显 load', res.waitUntil, 'load')
		ok('load：超时后如实报 loadPending', res.loadPending === true, JSON.stringify(res))
	}
}

async function testDialogClosedAutoHold() {
	const calls = []
	const { ctx, fake } = await loadWorker((method, params) => {
		if (method !== 'Runtime.evaluate') return null
		const ex = String((params && params.expression) || '')
		calls.push(ex)
		// 中止探针是一条 JSON 字符串；自动补层的探针返回**对象**（active/dismissedBy/aborted）
		if (ex.includes('JSON.stringify')) return { result: { value: '' } }
		if (ex.includes('__dshHold')) return { result: { value: { active: false, dismissedBy: null, aborted: false, closedAt: null } } }
		if (ex.includes('pageShowHold')) return { result: { value: { active: true, covered: true } } }
		return { result: { value: '' } }
	})
	await ctx.cmdHoldConfig({ mode: 'black' })
	// 弹窗关掉 ⇒ 黑名单模式下应当补层（弹窗通常把窗口提到前台，关掉后用户下一次点击极易落在页面上）
	fake.fireCdp(7, 'Page.javascriptDialogClosed', {})
	await new Promise((r) => setTimeout(r, 60))
	ok('弹窗关闭后自动补层（黑名单模式）', calls.some((x) => x.includes('pageShowHold')), calls.map((c) => c.slice(0, 40)).join(' | '))

	// 白名单模式不自动补（与 hold 的既有语义一致）
	const calls2 = []
	const { ctx: ctx2, fake: fake2 } = await loadWorker((method, params) => {
		if (method !== 'Runtime.evaluate') return null
		const ex = String((params && params.expression) || '')
		calls2.push(ex)
		if (ex.includes('JSON.stringify')) return { result: { value: '' } }
		if (ex.includes('__dshHold')) return { result: { value: { active: false, dismissedBy: null, aborted: false, closedAt: null } } }
		if (ex.includes('pageShowHold')) return { result: { value: { active: true, covered: true } } }
		return { result: { value: '' } }
	})
	await ctx2.cmdHoldConfig({ mode: 'white' })
	fake2.fireCdp(7, 'Page.javascriptDialogClosed', {})
	await new Promise((r) => setTimeout(r, 60))
	ok('白名单模式下弹窗关闭不自动补层', !calls2.some((x) => x.includes('pageShowHold')))
}

/* ────────────────────────── 断言：中止期间不许再挂浮层 ────────────────────────── */

async function testHoldOnRefusedWhileAborted() {
	const calls = []
	const { ctx } = await loadWorker((method, params) => {
		calls.push({ method, expression: params && params.expression })
		if (method !== 'Runtime.evaluate') return null
		const ex = String((params && params.expression) || '')
		// 中止探针：页面说"用户按了中止"
		if (ex.includes('__dshHold') && ex.includes('aborted')) return { result: { value: JSON.stringify({ text: '别点了' }) } }
		// 真的注入浮层
		if (ex.includes('pageShowHold') || ex.includes('__dsh_hold_overlay__')) return { result: { value: { active: true } } }
		return { result: { value: '' } }
	})
	let error = null
	try {
		await ctx.cmdHoldOn({ tabId: 7, text: '模型正在操作' })
	} catch (e) { error = e }
	ok('中止期间 hold.on 被拒（抛错）', error !== null, error ? '没有抛错' : '')
	ok('拒因带 browser-hold-aborted: 前缀', error !== null && String(error.message).indexOf('browser-hold-aborted:') === 0, error && error.message.slice(0, 60))
	eq('中止期间没有向页面注入浮层（注入调用次数）',
		calls.filter((c) => String(c.expression || '').includes('pageShowHold')).length, 0)

	// 阳性对照：没有中止标记时必须照常注入，证明上面的拒绝不是"永远都拒"
	const calls2 = []
	const { ctx: ctx2 } = await loadWorker((method, params) => {
		calls2.push({ method, expression: params && params.expression })
		if (method !== 'Runtime.evaluate') return null
		const ex = String((params && params.expression) || '')
		if (ex.includes('__dshHold') && ex.includes('aborted')) return { result: { value: '' } }
		if (ex.includes('pageShowHold')) return { result: { value: { active: true } } }
		return { result: { value: '' } }
	})
	let error2 = null
	try { await ctx2.cmdHoldOn({ tabId: 8, text: 'x' }) } catch (e) { error2 = e }
	ok('阳性对照：无中止标记时 hold.on 正常注入', error2 === null, error2 && error2.message)
	eq('阳性对照：注入调用次数', calls2.filter((c) => String(c.expression || '').includes('pageShowHold')).length, 1)
}

/* ────────────────────────── 断言：点击旁路自己的浮层 ────────────────────────── */

async function testClickBypass() {
	const dispatched = []
	const evalSeen = []
	const { ctx } = await loadWorker((method, params) => {
		if (method === 'Input.dispatchMouseEvent') { dispatched.push(params); return {} }
		if (method !== 'Runtime.evaluate') return null
		const ex = String((params && params.expression) || '')
		evalSeen.push(ex)
		if (ex.includes('El.pointerEvents') || ex.includes('pointerEvents')) return { result: { value: true } }
		if (ex.includes('__dshPick')) {
			return { result: { value: { x: 12, y: 34, tag: 'button', text: '提交', hitTag: 'button', isTop: true, relocated: false } } }
		}
		return { result: { value: '' } }
	})
	const res = await ctx.cmdClick({ selector: '#go', tabId: 7 })
	eq('点击结果带 bypassedOwnOverlay', res && res.bypassedOwnOverlay, true)
	eq('仍然派发了鼠标事件', dispatched.length, 3)
	ok('派发前把浮层临时设为 pointer-events:none', evalSeen.some((x) => x.indexOf('pointerEvents = "none"') >= 0))
	ok('派发后恢复浮层的 pointer-events', evalSeen.some((x) => x.indexOf('pointerEvents = ""') >= 0))

	// 反向：没有浮层时不得谎报旁路
	const { ctx: ctx2 } = await loadWorker((method, params) => {
		if (method === 'Input.dispatchMouseEvent') return {}
		if (method !== 'Runtime.evaluate') return null
		const ex = String((params && params.expression) || '')
		if (ex.includes('pointerEvents')) return { result: { value: false } }
		if (ex.includes('__dshPick')) return { result: { value: { x: 1, y: 2, tag: 'a', text: 'x', isTop: true, relocated: false } } }
		return { result: { value: '' } }
	})
	const res2 = await ctx2.cmdClick({ selector: '#go', tabId: 7 })
	ok('反向：没有浮层时不报 bypassedOwnOverlay', res2 && res2.bypassedOwnOverlay === undefined, JSON.stringify(res2))
}

/* ────────────────────────── 断言：错误契约里的 held_by_user ────────────────────────── */

async function testHeldByUserCode() {
	const pkg = path.join(root, 'packages', 'browser-unified-plugin')
	const require = createRequire(path.join(pkg, 'package.json'))
	let core
	try {
		core = await import(pathToFileURL(require.resolve('browser-unified-core')).href)
	} catch (e) {
		ok('core 的 dist/ 可用（先 npm run build）', false, String(e && e.message).slice(0, 120))
		return
	}
	const { classify, HOLD_ABORTED_MARKER } = core
	eq('HOLD_ABORTED_MARKER 已导出且与扩展同前缀', HOLD_ABORTED_MARKER, 'browser-hold-aborted:')
	const err = classify('click', new Error('browser-hold-aborted: 用户已在浮层上按下「中止操作」…'))
	eq('中止 → code=held_by_user', err.code, 'held_by_user')
	eq('中止 → effectState=not_started（页面没被动过）', err.effectState, 'not_started')
	ok('给模型的文案里不再带线上前缀', err.detail.indexOf('browser-hold-aborted:') < 0, err.detail.slice(0, 80))
	ok('文案说明了下一步是问用户 + hold off', /hold action=off|browser_hold/.test(err.message), err.message.slice(0, 120))
	const plain = classify('click', new Error('用户终止控制（click 已拦下）。'))
	eq('老文案（无前缀）也归 held_by_user', plain.code, 'held_by_user')
}

/* ────────────────────────── 跑 ────────────────────────── */

console.log('extension-hold: 接管浮层的三处真机契约')
await testAxExclusion()
await testFocusPolicy()
await testHoldEvidenceAndInputGate()
await testCdpSessionRecovery()
await testWokenTabReuse()
await testWindowNotShown()
await testNavigationWaitModes()
await testWindowStateAndViewport()
await testDialogClosedAutoHold()
await testFullscreenCoverage()
await testHoldOnRefusedWhileAborted()
await testClickBypass()
await testHeldByUserCode()

const failed = results.filter((r) => !r.pass)
console.log(`  ${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log(`FAIL ${failed.length}`)
	process.exit(1)
}
console.log('OK')
process.exit(0)
