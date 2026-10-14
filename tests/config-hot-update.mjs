#!/usr/bin/env node
/**
 * config-hot-update.mjs — 「改设置即刻生效」的回归测试（不需要浏览器、不需要重启）。
 *
 * 动机（bi-038，2026-10-14 实测）：宿主 `@deepseek-ai/cordis-plugin-loader` 对**只动 volatile
 * 字段**的配置变更走「原地提交」——把新值写进运行中的 volatile 引用，然后 emit
 * `loader/volatile-update`，**不 dispose、不重跑 apply**。这正是 `.volatile()` 的语义
 * （"别重载我，我自己处理"）。插件原来在 apply 里把配置快照死、又没订阅这个事件，
 * 于是「设置页显示已保存 / 桥侧仍是旧档位」，要重启才生效。
 *
 * 本测试用**仿 loader 的 volatile 包装**（每字段一枚 `{ get() }`）复现这条链路，钉住四件事：
 *   1. apply 订阅了 `loader/volatile-update`；
 *   2. 原地提交 + 事件之后，策略读数**立刻**跟着变（且不需要重跑 apply）；
 *   3. 非法的新值被**拒绝**，继续用上一份好配置（不能"热更新绕过校验"）；
 *   4. buddy 那几个旋钮（工具面分层等）同样跟随，不留一份冻住的 cfg。
 *
 * 复现：npm run build && node tests/config-hot-update.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..', 'packages', 'browser-unified-plugin')
const index = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 仿 loader：每个字段都是一枚 volatile 包装，`.get()` 读**当前**值。 */
function wrap(state) {
	const raw = {}
	for (const key of Object.keys(state)) raw[key] = { get: () => state[key] }
	return raw
}

const state = {
	// enabled=true 才能看到分档读数；端口用一个空闲的，别撞线上 9777
	enabled: true, port: 9799, token: 'dsh-local', shotsDir: 'dsh-browser-shots', urlMode: 'public',
	blockMetadata: true, metadataHostnames: [], metadataIps: [],
	internetAccess: undefined, lanAccess: 'deny', localAccess: 'deny',
	internetTemp: true, lanTemp: true, localTemp: true, askMode: 'inherit',
	dshAccessEnabled: false, dshOrigins: [], allowHosts: [], denyHosts: [], registryDir: '',
	autoLaunchEnabled: false, autoLaunchIdleSeconds: 15, autoLaunchBrowserExe: '',
	autoLaunchProfileDir: '', autoLaunchProfileName: '', autoLaunchTempProfile: false,
	autoLaunchExtensionDir: '', layeredTools: true,
}
const raw = wrap(state)

const tools = new Map()
const handlers = new Map()
const logs = []
const disposers = []
const ctx = {
	logger: {
		info: (m) => logs.push(['info', String(m)]),
		warn: (m) => logs.push(['warn', String(m)]),
		error: (m) => logs.push(['error', String(m)]),
	},
	tools: { register: (definition) => { tools.set(definition.name, definition) } },
	inject() { /* 不提供 webServer：控制页地址推导跳过，行为退回只认用户登记列表 */ },
	get() { return undefined },
	effect(fn) {
		const d = fn()
		if (typeof d === 'function') disposers.push(d)
		return () => {}
	},
	on(event, listener) {
		handlers.set(event, [...(handlers.get(event) ?? []), listener])
		return () => {}
	},
	provide() { return () => {} },
	systemPrompt: { context: () => () => {}, section: () => () => {}, tools: () => () => {} },
}

index.apply(ctx, raw)
const exec = { signal: new AbortController().signal }
const fire = (paths) => { for (const listener of handlers.get('loader/volatile-update') ?? []) listener(paths) }
const textOf = (value) => String(value?.text ?? (Array.isArray(value?.content) ? value.content.map(b => b?.text ?? '').join('\n') : ''))
const policy = async () => textOf(await tools.get('browser_policy_status').execute({}, exec))
const buddyStatus = async () => textOf(await tools.get('browser_tools').execute({ action: 'status' }, exec))

console.log('[1] apply 就位：策略读数是 deny（预设）')
check('browser_policy_status 已注册', tools.has('browser_policy_status'))
const before = await policy()
check('初始局域网 = deny', /局域网: deny/.test(before), before.split('\n').find(l => l.includes('局域网')) ?? '')
check('apply 订阅了 loader/volatile-update',
	(handlers.get('loader/volatile-update') ?? []).length > 0,
	`handlers=${[...handlers.keys()].join(',')}`)

console.log('\n[2] 宿主原地提交（不重跑 apply）+ 事件 ⇒ 新档位立刻生效')
state.lanAccess = 'allow'
state.localAccess = 'allow'
fire(['lanAccess', 'localAccess'])
const after = await policy()
check('局域网立刻变 allow（显式）', /局域网: allow（显式）/.test(after), after.split('\n').find(l => l.includes('局域网')) ?? '')
check('本机立刻变 allow（显式）', /本机: allow（显式）/.test(after), after.split('\n').find(l => l.includes('本机')) ?? '')
check('记了一条"已热更新"日志', logs.some(([level, m]) => level === 'info' && m.includes('设置已热更新')))

console.log('\n[3] 非法的新值必须被拒（热更新不能绕过校验）')
state.lanAccess = 'nonsense'
fire(['lanAccess'])
const rejected = await policy()
check('非法值被拒并保留上一份好配置（仍是 allow）', /局域网: allow/.test(rejected))
check('拒绝写进日志（可排障）', logs.some(([level, m]) => level === 'warn' && m.includes('热更新被拒')))
state.lanAccess = 'allow'

console.log('\n[4] buddy 的旋钮同样跟随（不留冻住的 cfg）')
const layeredOn = await buddyStatus()
check('初始：工具面分层 = 开', /分层：开/.test(layeredOn), layeredOn.split('\n').find(l => l.includes('分层')) ?? '')
state.layeredTools = false
fire(['layeredTools'])
const layeredOff = await buddyStatus()
check('事件后：工具面分层 = 关（无需重启）', /分层：关/.test(layeredOff), layeredOff.split('\n').find(l => l.includes('分层')) ?? '')
state.layeredTools = true
fire(['layeredTools'])
check('再改回来也跟随', /分层：开/.test(await buddyStatus()))

// 收起桥（测试里真的监听了 9799），否则事件循环不退出
for (const dispose of disposers) { try { dispose() } catch { /* 已停 */ } }
await new Promise(r => setTimeout(r, 200))

const failed = results.filter(r => !r.ok)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败项：')
	for (const f of failed) console.log(`  - ${f.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
