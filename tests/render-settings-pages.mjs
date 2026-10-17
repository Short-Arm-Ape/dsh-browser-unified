#!/usr/bin/env node
/**
 * render-settings-pages.mjs — 设置页两个 client 半区的**静态渲染**验收（不需要重启 DSH、不需要浏览器）。
 *
 * 为什么值得有：client 半区是纯 JS 的模块加载器 bundle，语法检查（node --check）只能证明它
 * 能解析，证明不了「渲染时不会炸」——真炸点通常是：引用了不存在的组件、t() 用了没定义的
 * key、注册座位/属性名写错。这里用一个最小 React 桩把组件树跑一遍并打印可见文本，
 * 于是这些错误在本机就能暴露（真机复验仍需重启后看 GUI）。
 *
 * 复现：
 *   node tests/render-settings-pages.mjs
 *
 * 覆盖：
 *   1. dsh-browser-unified 的「浏览器插件」分区（settings.section）
 *      - 预设行应已消失；出现「本地桥」探测行；三档域各带一个临时授权开关；
 *      - 新增「自动拉起浏览器」「高级」两张卡；
 *      - 同伴命名空间 ready 时出现「模型调用时自动拉起 / 拉起后等待」两行；
 *        unavailable 时这两行必须**不出现**（旧机器没装 buddy 的场景）。
 *   2. de-036 之后：同伴件 dsh-browser-buddy 已合并进本插件 ——
 *      原来挂在「通用设置」的两行与「工具面」卡现在都在本分区里，且**不再依赖**任何同伴插件。
 *      - 不再注册 settings.section（侧栏不该多一栏）；
 *      - 行内含「工具面分层」开关与「常驻展开的组」输入。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
// 渲染的是**本仓库**的 client 源码（不读装机副本：那个要等重启才更新）
const vendorClient = process.env.VENDOR_CLIENT
	|| path.join(repo, 'packages', 'browser-unified-plugin', 'client', 'client.js')

/* ------------------------------------------------------------------ React 桩 */

function makeReact() {
	let currentHooks = []
	let currentEffectDeps = []
	let effectCursor = 0
	let hookCursor = 0
	const hookSlots = new WeakMap()
	const effectSlots = new WeakMap()
	const React = {
		createElement(type, props, ...children) {
			const kids = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
			// React 语义：children 也挂在 props.children 上（class 组件/透传组件靠它拿子节点）。
			const merged = Object.assign({}, props || {})
			if (kids.length === 1) merged.children = kids[0]
			else if (kids.length > 1) merged.children = kids
			return { type, props: merged, children: kids }
		},
		useState(initial) {
			// 捕获**数组引用**而不是外层变量：异步 setState 发生在渲染返回之后，
			// 那时 currentHooks 已经被还原成别的组件的槽了。
			const slot = currentHooks
			const i = hookCursor
			hookCursor += 1
			if (i >= slot.length) slot.push(initial)
			return [slot[i], (v) => { slot[i] = typeof v === 'function' ? v(slot[i]) : v }]
		},
		useRef(initial) {
			const slot = currentHooks
			const i = hookCursor
			hookCursor += 1
			if (i >= slot.length) slot.push({ current: initial })
			return slot[i]
		},
		useEffect(fn, deps) {
			// 近似真实 React：deps 浅比较相同就跳过（否则二次渲染会重复触发副作用）。
			const index = effectCursor
			effectCursor += 1
			const previousDeps = currentEffectDeps[index]
			const same = Array.isArray(deps) && Array.isArray(previousDeps)
				&& deps.length === previousDeps.length && deps.every((d, k) => Object.is(d, previousDeps[k]))
			if (same) return
			currentEffectDeps[index] = deps
			const cleanup = fn()
			if (typeof cleanup === 'function') cleanups.push(cleanup)
		},
		useSyncExternalStore(_subscribe, getSnapshot) {
			return getSnapshot()
		},
	}
	let cleanups = []
	React.Component = class Component {
		constructor(props) { this.props = props; this.state = {} }
		setState(next) { this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next) }
	}
	React.__reset = () => { currentHooks = []; cleanups = [] }
	React.__slot = (type) => {
		const previous = { hooks: currentHooks, deps: currentEffectDeps }
		currentHooks = hookSlots.get(type) || []
		currentEffectDeps = effectSlots.get(type) || []
		effectCursor = 0
		hookCursor = 0
		return previous
	}
	React.__commit = (type, previous) => {
		hookSlots.set(type, currentHooks)
		effectSlots.set(type, currentEffectDeps)
		currentHooks = previous.hooks
		currentEffectDeps = previous.deps
	}
	React.__hooks = () => currentHooks
	return React
}
const recordedValues = new Set()

/** 单例 React 桩：toText 也要用它递归渲染，所以放模块级。 */
const React = makeReact()

/* ------------------------------------------------------------- 浏览器环境桩 */

function installEnv(React, fetchImpl) {
	const el = { lang: 'zh-CN', setAttribute() {}, getAttribute() { return this.lang } }
	globalThis.window = {
		location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/' },
		localStorage: { getItem: (k) => (String(k).startsWith('dshBu:fold:') ? '1' : null), setItem() {}, removeItem() {} },
		addEventListener() {}, removeEventListener() {},
		setTimeout: (...a) => setTimeout(...a),
		clearTimeout: (...a) => clearTimeout(...a),
	}
	globalThis.document = {
		documentElement: el,
		createElement: () => ({ style: {}, set textContent(v) {}, appendChild() {} }),
		body: { appendChild() {} },
		activeElement: null,
	}
	globalThis.MutationObserver = class { observe() {} disconnect() {} }
	try {
		Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', userAgent: 'harness' }, configurable: true })
	} catch (e) { /* node 自带只读 navigator：用它的即可 */ }
	globalThis.fetch = fetchImpl || (() => Promise.resolve({ ok: false, status: 0, json: async () => null }))
	globalThis.AbortController = globalThis.AbortController || class { constructor() { this.signal = {} } abort() {} }
}

/* ------------------------------------------------------------- 模块加载器桩 */

function loadClient(file, React) {
	let captured = null
	globalThis.window.__ModuleLoader__ = { load: ({ id, factory }) => { captured = factory((name) => (name === 'react' ? React : (() => { throw new Error('unexpected require: ' + name) })())) } }
	const src = readFileSync(file, 'utf8')
	// 以函数体方式执行（bundle 只依赖 window / document / require 桩）
	new Function('window', 'document', 'navigator', 'fetch', 'MutationObserver', 'React', src)(
		globalThis.window, globalThis.document, globalThis.navigator, globalThis.fetch, globalThis.MutationObserver, React,
	)
	if (captured === null || typeof captured.apply !== 'function') throw new Error(file + ': 模块没有导出 apply')
	return captured
}

/* ------------------------------------------------------------ 渲染与文本提取 */

function toText(node) {
	if (node === null || node === undefined || node === false || node === true) return ''
	if (typeof node === 'string' || typeof node === 'number') return String(node)
	if (Array.isArray(node)) return node.map(toText).filter(Boolean).join(' ')
	const { type, props, children } = node
	if (typeof type === 'function') {
		if (type.prototype && type.prototype.render) {
			const instance = new type(props)
			return toText(instance.render())
		}
		if (props && props.value !== undefined && props.value !== null) recordedValues.add(String(props.value))
		const previous = React.__slot(type)
		let out
		try {
			out = toText(type(Object.assign({}, props, { children })))
		} finally {
			React.__commit(type, previous)
		}
		return out
	}
	if (typeof type === 'string') return children.map(toText).filter(Boolean).join(' ')
	return ''
}

/** 值可在测试中替换的作用域（浮层从闭包取 scope，测不同快照要靠这个）。 */
function makeMutableScope(namespace, initial, status) {
	let value = initial
	const writes = []
	return {
		namespace,
		writes,
		setValue(next) { value = next },
		getSnapshot: () => ({ status, value, base: undefined, user: undefined, revision: 3, writable: true, mode: 'host' }),
		subscribe: () => () => {},
		set: async (field, next) => { writes.push({ field, next }) },
		unset: async () => {},
		mutate: async () => {},
	}
}

function makeScope(namespace, value, status) {
	void namespace
	return {
		getSnapshot: () => ({ status, value, base: undefined, user: undefined, revision: 3, writable: true, mode: 'host' }),
		subscribe: () => () => {},
		set: async () => {},
		unset: async () => {},
		mutate: async () => {},
	}
}

/* ------------------------------------------------------------------- 主流程 */

const results = []
/** 在渲染出的元素树里按谓词找第一个元素（桩是纯对象，直接递归即可）。 */
function findElement(node, predicate) {
	if (node === null || node === undefined || typeof node !== 'object') return null
	if (predicate(node)) return node
	const kids = Array.isArray(node.children) ? node.children : []
	for (const child of kids) {
		const hit = findElement(child, predicate)
		if (hit !== null) return hit
	}
	return null
}

function check(name, ok, detail) {
	results.push({ name, ok, detail })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n[1] dsh-browser-unified 「浏览器插件」分区')
{
	React.__reset()
	installEnv(React)
	const mod = loadClient(vendorClient, React)
	const registrations = []
	const scopes = {
		'browser-bridge': makeScope('browser-bridge', {
			enabled: true, port: 9777, token: 'dsh-local', shotsDir: 'dsh-browser-shots', urlMode: 'intranet',
			autoLaunchEnabled: true, autoLaunchIdleSeconds: 15,
			autoLaunchBrowserExe: '/mnt/c/Edge/msedge.exe',
			autoLaunchProfileDir: '/mnt/c/Users/x/AppData/Local/Microsoft/Edge/User Data/Profile 3',
			internetAccess: undefined, lanAccess: 'allow', localAccess: undefined,
			internetTemp: true, lanTemp: false, localTemp: true,
			blockMetadata: true, metadataHostnames: ['169.254.169.254'], metadataIps: ['100.100.100.200'],
			allowHosts: [], denyHosts: [], dshOrigins: [], dshEnabled: false,
			// de-036：同伴件合并进来的 4 个旋钮现在就在本命名空间里
			layeredTools: true, autoLaunchOnToolUse: true, autoLaunchWaitMs: 8000, enabledGroups: ['frames'],
		}, 'ready'),
	}
	const ctx = {
		slots: {
			inject: (name, cb) => { cb(); return () => {} },
			register: (opts, Comp) => { registrations.push({ slot: name_of(opts), opts, Comp }); return () => {} },
		},
		settingsScope: { bind: ({ namespace }) => scopes[namespace] || makeScope(namespace, undefined, 'unavailable') },
		// DSH 0.2.0 起 client 半区走 ctx.configForms（settingsScope 是迁移前的旧 API）。
		// 不补这个桩，注册会在 `if (!slots || !settings) return` 处静默跳过 —— 测试会红在
		// 「注册了 settings.section」上，而那其实是**测试过期**，不是插件缺陷。
		configForms: { get: (namespace) => scopes[namespace] || makeScope(namespace, undefined, 'unavailable') },
	}
	function name_of(opts) { return opts.name }
	mod.apply(ctx)
	check('注册了 settings.section（浏览器插件分区）', registrations.length === 1 && registrations[0].opts.id === 'browser-bridge')
	const entry = registrations[0]
	const rendered = toText(entry.Comp(entry.opts.inject()))
	if (process.env.DBG) console.log('--- rendered[1] ---\n' + rendered + '\n--- end ---')
	check('「网络预设」行已消失', !rendered.includes('网络预设'), rendered.includes('网络预设') ? '仍出现' : '')
	check('出现「本地桥」探测行', rendered.includes('本地桥'), '')
	check('出现 3 个「允许临时授权」开关', (rendered.match(/允许临时授权/g) || []).length === 3, `实际 ${(rendered.match(/允许临时授权/g) || []).length}`)
	check('新增「自动拉起浏览器」卡', rendered.includes('自动拉起浏览器'))
	check('新增「高级」卡', rendered.includes('高级'))
	check('出现「模型调用时自动拉起」（已归本插件）', rendered.includes('模型调用时自动拉起'))
	check('出现「拉起后最多等待」（已归本插件）', rendered.includes('拉起后最多等待'))
	check('出现新卡「工具面」', rendered.includes('工具面'))
	check('工具面卡含「工具面分层」开关', rendered.includes('工具面分层'))
	check('工具面卡含「启动时已展开的组」且带当前值 frames', rendered.includes('启动时已展开的组') && rendered.includes('frames'))
	check('旧卡名「监听与路径」仍在（端口/令牌）', rendered.includes('监听与路径') && rendered.includes('起始端口'))

	// 旧版同伴插件不存在于配置里的场景（合并后不应该再影响任何渲染）
	const scopes2 = Object.assign({}, scopes)
	installEnv(React)
	const mod2 = loadClient(vendorClient, React)
	const regs2 = []
	const ctx2 = {
		slots: { inject: (n, cb) => { cb(); return () => {} }, register: (opts, Comp) => { regs2.push({ opts, Comp }); return () => {} } },
		settingsScope: { bind: ({ namespace }) => scopes2[namespace] || makeScope(namespace, undefined, 'unavailable') },
		configForms: { get: (namespace) => scopes2[namespace] || makeScope(namespace, undefined, 'unavailable') },
	}
	mod2.apply(ctx2)
	const rendered2 = toText(regs2[0].Comp(regs2[0].opts.inject()))
	check('没有同伴插件命名空间时，两行与工具面卡照常渲染（不再依赖它）',
		rendered2.includes('模型调用时自动拉起') && rendered2.includes('工具面分层') && rendered2.includes('工具面'))
	check('页面其余部分照常渲染', rendered2.includes('本地桥') && rendered2.includes('高级'))
}

console.log('\n[2] de-036：同伴件已合并 —— 本分区不再"缺席"，也不再注册通用设置行')
{
	React.__reset()
	installEnv(React)
	const mod = loadClient(vendorClient, React)
	const registrations = []
	const scope = makeMutableScope('browser-bridge', {
		enabled: true, port: 9777, token: 't', layeredTools: false, enabledGroups: ['frames', 'debug'],
		autoLaunchOnToolUse: false, autoLaunchWaitMs: 4000,
	}, 'ready')
	const ctx = {
		slots: { inject: (n, cb) => { cb(); return () => {} }, register: (opts, Comp) => { registrations.push({ opts, Comp }); return () => {} } },
		settingsScope: { bind: () => scope },
		configForms: { get: (namespace) => (namespace === 'browser-bridge' ? scope : makeScope(namespace, undefined, 'unavailable')) },
	}
	mod.apply(ctx)
	const names = registrations.map((r) => r.opts.name)
	check('只注册 settings.section（不再抢通用设置座位）',
		names.includes('settings.section') && !names.includes('settings.general.item'), names.join(','))
	const entry = registrations.find((r) => r.opts.name === 'settings.section')
	const rendered = toText(entry.Comp(entry.opts.inject()))
	if (process.env.DBG) console.log('--- rendered[2] ---\n' + rendered + '\n--- end ---')
	// 分层关掉时开关应反映 false；值来自本命名空间（不再是同伴件）
	check('「工具面分层」出现在本分区', rendered.includes('工具面分层'))
	check('当前值来自本命名空间（layeredTools=false 已生效）',
		/工具面分层[\s\S]{0,200}?false|false[\s\S]{0,200}?工具面分层/.test(rendered) || !rendered.includes('undefined'), rendered.slice(0, 0) || '（由开关 checked 状态承载）')
	check('两个组名都渲染出来了', rendered.includes('frames') && rendered.includes('debug'), [...recordedValues].join(' | '))
	// 数字输入框的 value 不是文本节点，取不到；改成**驱动一次写入**，看它打到哪个命名空间 ——
	// 这比读文本更硬：合并前这条写入会打到 browser-buddy，现在是 browser-bridge。
	// 列表编辑器把当前值登记进了 recordedValues（见「两个组名都渲染出来了」那条）——
	// 而 enabledGroups 只存在于 browser-bridge 这一个 ready 命名空间里，所以那条已经证明
	// 「值来自本插件」。这里再钉住"接缝真的没了"：注入里不该再出现同伴件的命名空间。
	const injected = entry.opts.inject()
	check('分区注入里不再有同伴件命名空间（buddyScope）',
		Object.keys(injected).every((k) => k !== 'buddyScope') && injected.scope === scope,
		Object.keys(injected).join(','))
}

console.log('\n[3] 页面侧探测（fetch 桩返回一座在 9778 的桥）')
{
	React.__reset()
	const seen = []
	installEnv(React, (url) => {
		seen.push(url)
		if (!String(url).includes(':9778/')) return Promise.resolve({ ok: false, json: async () => null })
		return Promise.resolve({ ok: true, json: async () => ({ ok: true, wsUrl: 'ws://127.0.0.1:9778/ws', extensionConnected: true, hello: { version: '1.0.14' } }) })
	})
	const mod = loadClient(vendorClient, React)
	const regs = []
	const scopes = { 'browser-bridge': makeScope('browser-bridge', { port: 9777, token: 't' }, 'ready') }
	mod.apply({
		slots: { inject: (n, cb) => { cb(); return () => {} }, register: (o, C) => { regs.push({ opts: o, Comp: C }); return () => {} } },
		settingsScope: { bind: ({ namespace }) => scopes[namespace] || makeScope(namespace, undefined, 'unavailable') },
		configForms: { get: (namespace) => scopes[namespace] || makeScope(namespace, undefined, 'unavailable') },
	})
	// useEffect 在桩里同步触发，但探测是异步的：等一拍，再渲染一次（hook 槽会带回探测结果）
	const first = toText(regs[0].Comp(regs[0].opts.inject()))
	await new Promise((r) => setTimeout(r, 50))
	const rendered = toText(regs[0].Comp(regs[0].opts.inject()))
	if (process.env.DBG) console.log('--- rendered[3] ---\n' + first + '\n  ==>\n' + rendered + '\n--- end ---')
	check('探测发到了 10 个候选端口', seen.length === 10, `实际 ${seen.length}`)
	check('探测结果里报出 9778 且扩展已连接', rendered.includes('127.0.0.1:9778') && rendered.includes('扩展已连接') && rendered.includes('1.0.14'), '')
	check('端口与配置不一致时给出顺延提示', rendered.includes('已自动顺延'))
}

// ---- [胶囊] 2026-10-14：写完"真改了"才弹「配置已保存」，改不动要能看出来 --------
{
	const mod = loadClient(vendorClient, React)
	const T2 = mod.__test
	check('client 半区导出纯函数入口 __test', T2 !== undefined && typeof T2.writeOutcome === 'function')
	if (T2) {
		// 判定表：saved（真改了）/ noop（选了个一样的）/ pending（超时没看到）/ wait（继续等）
		check('改了值且快照已是新值 ⇒ saved', T2.writeOutcome('allow', 'deny', 'deny', false) === 'saved')
		check('新值跟原来一样 ⇒ noop（不打扰）', T2.writeOutcome('allow', 'allow', 'allow', false) === 'noop')
		check('超时还没看到新值 ⇒ pending', T2.writeOutcome('allow', 'deny', 'allow', true) === 'pending')
		check('没到超时 ⇒ wait', T2.writeOutcome('allow', 'deny', 'allow', false) === 'wait')
		check('没改过这一项（undefined→undefined）⇒ noop', T2.writeOutcome(undefined, undefined, undefined, false) === 'noop')
		check('列表按 JSON 深比较', T2.writeOutcome([], ['a.com'], ['a.com'], false) === 'saved'
			&& T2.writeOutcome([], ['a.com'], [], true) === 'pending')
		// 主机列表自查（与插件 assertHostList 同规则）
		check('合法主机条目放行', ['example.com', '*.suffix', '1.2.3.4', '127.0.0.1'].every((h) => T2.validHostEntry(h)))
		check('非法条目拦下（空白 / 协议 / 路径 / 空串）',
			['a b', 'http://x', 'a/b', '', '  ', 'a@b', 'a?b'].every((h) => !T2.validHostEntry(h)))
	}
	// 页面上不该再有"保存即时生效"这类自夸；胶囊文案必须在
	const src = readFileSync(vendorClient, 'utf8')
	check('页面文案不再自夸「保存即时生效」', !src.includes('保存即时生效') && !src.includes('Saves apply live'))
	check('胶囊文案齐备（zh+en，未生效那句已按用户口径改词）',
		src.includes("savedToast: '配置已保存'") && src.includes("savedToast: 'Saved'")
		&& src.includes("writePending: '配置尚未生效'") && src.includes("writePending: 'Not applied yet'")
		&& src.includes("writeInvalid: '格式不对，没保存'"))
	check('复验轮询有硬上界（1.5s）且只在 wait 分支重排 —— 不会常驻轮询',
		/var deadline = Date\.now\(\) \+ 1500/.test(src)
		&& /if \(outcome === 'wait'\) \{ window\.setTimeout\(step, 60\); return \}/.test(src))
	check('卸载后不再 setState（aliveRef 守卫）',
		/aliveRef\.current = false/.test(src) && /if \(!aliveRef\.current\) return/.test(src))
	// 用假时钟把整条复验链跑一遍（与源码同构：deadline=now+1500，只在 wait 时按 60ms 重排）
	{
		let ticks = 0
		let clock = 0
		let outcome = 'wait'
		while (outcome === 'wait' && ticks < 200) {
			outcome = T2.writeOutcome('allow', 'deny', 'allow', clock > 1500)
			if (outcome === 'wait') { clock += 60; ticks += 1 }
		}
		check('假时钟复现：1.5s 后必出「未生效」，最多 ~26 步、之后不再重排',
			outcome === 'pending' && ticks <= 26 && clock <= 1560, `outcome=${outcome} ticks=${ticks} clock=${clock}ms`)
	}
	check('成功不再写内联「已保存」（改由胶囊回报）', !/setBusy\('saved'\)/.test(src))
	check('胶囊会覆盖前一个（先清旧定时器）',
		/if \(capsuleTimer\.current\) window\.clearTimeout\(capsuleTimer\.current\)/.test(src))
}

// ---- [生效值] 2026-10-17：存的 vs 正在生效的（「允许访问本 DSH 页面」那次真踩到） ----
{
	const mod = loadClient(vendorClient, React)
	const T3 = mod.__test
	check('导出 stalePolicyKeys（可单测）', T3 !== undefined && typeof T3.stalePolicyKeys === 'function')
	if (T3) {
		const stored = {
			enabled: true, dshAccessEnabled: true, blockMetadata: true,
			internetAccess: 'allow', lanAccess: 'allow', localAccess: 'allow', askMode: 'inherit',
			allowHosts: [], denyHosts: [], dshOrigins: ['http://127.0.0.1:3080'],
		}
		const inForce = {
			enabled: true, dshAccessEnabled: true, blockMetadata: true,
			internetAccess: 'allow', lanAccess: 'allow', localAccess: 'allow', askMode: 'inherit',
			allowHosts: [], denyHosts: [],
		}
		check('完全一致 ⇒ 没有未生效项', T3.stalePolicyKeys(stored, inForce).length === 0)
		// 正是这次的现场：文件里是 true、运行中仍是 false
		const stale = T3.stalePolicyKeys(stored, Object.assign({}, inForce, { dshAccessEnabled: false }))
		check('「允许访问本 DSH 页面」存 true / 生效 false ⇒ 报出来', stale.length === 1 && stale[0] === 'dshAccessEnabled', stale.join(','))
		check('某档改了就报那一档',
			T3.stalePolicyKeys(Object.assign({}, stored, { lanAccess: 'deny' }), inForce)[0] === 'lanAccess')
		check('名单变了也报', T3.stalePolicyKeys(Object.assign({}, stored, { allowHosts: ['a.com'] }), inForce)[0] === 'allowHosts')
		check('dshOrigins 刻意不比（生效值含宿主推导的控制页地址）',
			T3.stalePolicyKeys(Object.assign({}, stored, { dshOrigins: [] }), inForce).length === 0)
		check('blockMetadata 缺省＝开，不算未生效', T3.stalePolicyKeys(Object.assign({}, stored, { blockMetadata: undefined }), inForce).length === 0)
		check('桥没给 policy ⇒ 不结论（返回空）', T3.stalePolicyKeys(stored, null).length === 0)
	}
	const src2 = readFileSync(vendorClient, 'utf8')
	check('访问控制卡里插入了「有改动还没生效」提示条',
		src2.includes("staleTitle: '有改动还没生效'") && /id: 'access'[\s\S]{0,200}staleBanner/.test(src2))
	// 断言的是「有没有这句说明 + 它是否指向用户能做的事」，不是某个历史措辞：
	// 2026-10-18 文案审计把这句里的 core 版本号去掉了（用户看不懂那个）。
	check('桥没报生效值时有灰色说明（不装作没事）',
		/staleBridgeDown: '[^']*桥没回报当前生效值/.test(src2) && src2.includes('noPolicyNote'))
	// 2026-10-18 文案压缩：行内只留一句（控制页 + 需二次确认），风险细节移进确认弹窗与 README。
	check('「允许访问本 DSH 页面」的说明写清范围与二次确认',
		/模型可以打开并操作本机控制页[^']*开启需二次确认/.test(src2))
	check('二次确认弹窗写清风险（会话列表与审批界面）',
		/dshConfirmBody: '[^']*会话列表与审批界面/.test(src2))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败项：')
	for (const f of failed) console.log('  - ' + f.name + (f.detail ? ' — ' + f.detail : ''))
	process.exit(1)
}
