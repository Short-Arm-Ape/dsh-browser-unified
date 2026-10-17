#!/usr/bin/env node
/**
 * buddy-merged.mjs — 合并进插件后的回归（de-036，2026-10-10）。
 *
 * 原 `dsh-browser-buddy` 是独立插件，靠三个公开扩展点外挂；现在它是插件内的
 * `applyBuddyFeatures()`。这个脚本**直接驱动那个入口**（不需要 DSH、不需要浏览器、不需要重启），
 * 用最小桩验证合并后仍然成立的行为，重点是"搬过来以后没变坏"：
 *
 *   1. 工具面分层：assemble 之后 browser_* 只剩常驻白名单 + 已展开组（非 browser_ 工具不受影响）；
 *   2. 展开一组后，该组工具进入工具面；
 *   3. 状态注入：systemPrompt.context 注册了，探到桥之后文本含端口与分层状态；
 *   4. 调用即唤醒：扩展未连接 + 开着开关 → 调 bridge.wake（带回落地网址），回执只挂一次；
 *   5. 登记簿送达：会话首次调用挂一次摘要；
 *   6. frames / frame_eval 直连 controller（不再走 HTTP 命令面），且先过 authorizeTab 红线；
 *   7. 探桥候选端口：桥自报 boundPort 优先（X15 回归搬到这里）；
 *   8. browser_tools action=auto_launch 写回插件自己的命名空间（browser-bridge）。
 *
 * 复现：node tests/buddy-merged.mjs      （在仓库根跑；需要先 npm run build）
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const pkg = path.join(repo, 'packages', 'browser-unified-plugin')

// 会话标记文件落到临时 DSH_HOME，别污染真环境
const fakeHome = mkdtempSync(path.join(tmpdir(), 'dsh-buddy-merged-'))
process.env.DSH_HOME = fakeHome

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 让 /api/status 按 respond 的返回作答；null = 连接失败（同时记下试过的 URL）。 */
function installFetch(respond) {
	globalThis.fetch = async (url) => {
		const out = respond(String(url))
		if (out === null) throw new Error('ECONNREFUSED')
		return { ok: true, status: 200, json: async () => out }
	}
}

/** 一次成功的探桥响应。 */
const STATUS_OK = () => ({ ok: true, wsUrl: 'ws://127.0.0.1:9777/ws', extensionConnected: true, hello: { version: '1.0.19' } })

function makeCtx() {
	const hooks = {}
	const tools = {}
	const contexts = []
	const settings = { updates: [], service: { describe: () => [], update: async (ns, patch) => { settings.updates.push({ ns, patch }) } } }
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		inject(names, cb) {
			// 只提供 settings；dshHomePath 不提供 ⇒ 代码应回落到 DSH_HOME 环境变量
			if (names.includes('settings')) cb({ settings: settings.service })
		},
		on(event, fn) { hooks[event] = fn },
		effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
		tools: { register(def) { tools[def.name] = def } },
		systemPrompt: { context: (entry) => { contexts.push(entry); return () => {} } },
	}
	return { ctx, hooks, tools, contexts, settings }
}

function makeBridge({ port = 9777, boundPort = 9999, issues = [], extensionConnected = false } = {}) {
	const wakes = []
	return {
		wakes,
		service: {
			config: () => ({ enabled: true, port, token: 'dsh-local', autoLaunchBrowserExe: 'msedge.exe', autoLaunchProfileDir: '/x/Profile 3' }),
			describe: () => ({
				enabled: true, boundPort, requestedPort: port, extensionConnected,
				autoLaunchEnabled: true, autoLaunchIdleSeconds: 15, tempGrants: [], ready: true,
			}),
			wake: async (options) => { wakes.push(options ?? {}); return '扩展已受理' },
			issues: async () => ({ dir: '/reg', file: '/reg/issues/issues.json', issues }),
			version: async () => '0.11.15',
		},
	}
}

function makeController({ execute } = {}) {
	const calls = []
	return {
		calls,
		controller: {
			async execute(command, params) { calls.push({ command, params }); return execute ? execute(command, params) : { ok: true } },
			describePolicy: () => ({ enabled: true }),
			wakeBrowser: async () => '已唤醒',
		},
	}
}

/** additionalContexts 里是插件上下文消息（{id, role, content:[{type,text}]}），没有顶层 text。 */
function pluginText(decision) {
	return (decision?.additionalContexts ?? [])
		.map((c) => (typeof c.text === 'string'
			? c.text
			: (c.content ?? []).map((part) => part.text ?? '').join('\n')))
		.join('\n')
}
/** post-execute 的 next() 决策形状是 {kind:'accept'}（pre-execute 才是 'allow'）。 */
const acceptWith = (text) => ({ kind: 'accept', additionalContexts: [{ type: 'text', text }] })

const { applyBuddyFeatures } = await import(pathToFileURL(path.join(pkg, 'lib', 'buddy.js')).href)

console.log('\n[1] 工具面分层：assemble 后只留白名单 + 已展开组')
{
	installFetch(() => null)
	const { ctx, hooks } = makeCtx()
	const bridge = makeBridge()
	const { controller } = makeController()
	applyBuddyFeatures({ ctx, bridge: bridge.service, controller, config: { layeredTools: true, enabledGroups: [] } })
	const assembled = await hooks['system-prompt/assemble']({}, {}, async () => ({ tools: [
		{ name: 'browser_read' }, { name: 'browser_cleanup' }, { name: 'browser_tools' },
		{ name: 'browser_frames' }, { name: 'browser_frame_eval' }, { name: 'bash' },
	] }))
	const names = assembled.tools.map((t) => t.name)
	check('常驻工具保留', names.includes('browser_read') && names.includes('browser_tools'), names.join(','))
	check('未展开组的工具被隐藏', !names.includes('browser_frames') && !names.includes('browser_frame_eval'), names.join(','))
	check('非 browser_ 工具不受影响', names.includes('bash'))
}

console.log('\n[1b] 只读档：写操作类工具从工具面拿掉（点击/输入/导航/求值）')
{
	installFetch(() => null)
	const { ctx, hooks } = makeCtx()
	const bridge = makeBridge()
	const { controller } = makeController()
	applyBuddyFeatures({ ctx, bridge: bridge.service, controller, config: { layeredTools: true, enabledGroups: ['interact', 'session', 'debug'], readOnly: true } })
	const assembled = await hooks['system-prompt/assemble']({}, {}, async () => ({ tools: [
		{ name: 'browser_read' }, { name: 'browser_snapshot' }, { name: 'browser_screenshot' },
		{ name: 'browser_click' }, { name: 'browser_type' }, { name: 'browser_navigate' }, { name: 'browser_evaluate' },
		{ name: 'browser_hold' }, { name: 'bash' },
	] }))
	const names = assembled.tools.map((t) => t.name)
	check('只读工具保留', ['browser_read', 'browser_snapshot', 'browser_screenshot'].every((n) => names.includes(n)), names.join(','))
	check('写操作工具被拿掉（即使组已展开）', !names.includes('browser_click') && !names.includes('browser_type') && !names.includes('browser_navigate') && !names.includes('browser_evaluate'), names.join(','))
	check('浮层（会挡用户操作）也只读档下不可见', !names.includes('browser_hold'))
	check('非 browser_ 工具照旧', names.includes('bash'))
}

console.log('\n[2] 展开一组之后，该组工具进入工具面')
{
	installFetch(() => null)
	const { ctx, tools, hooks } = makeCtx()
	const bridge = makeBridge()
	const { controller } = makeController()
	applyBuddyFeatures({ ctx, bridge: bridge.service, controller, config: { layeredTools: true, enabledGroups: [] } })
	const out = await tools.browser_tools.execute({ action: 'enable', group: 'frames' }, {})
	check('enable 回执提到 frames', /frames/.test(out.text), out.text.split('\n')[0])
	const assembled = await hooks['system-prompt/assemble']({}, {}, async () => ({ tools: [{ name: 'browser_frames' }, { name: 'browser_cleanup' }] }))
	const names = assembled.tools.map((t) => t.name)
	check('browser_frames 现在可见', names.includes('browser_frames'), names.join(','))
}

console.log('\n[3] 状态注入：注册了 context，探到桥后文本含端口与分层')
{
	installFetch(STATUS_OK)
	const { ctx, contexts, tools } = makeCtx()
	const bridge = makeBridge({ port: 9777, boundPort: 9777, extensionConnected: true })
	const { controller } = makeController()
	applyBuddyFeatures({ ctx, bridge: bridge.service, controller, config: {} })
	check('注册了一个 systemPrompt.context', contexts.length === 1)
	const before = String(contexts[0]?.text?.() ?? '')
	check('未探测时如实说"尚未探测"', /尚未探测/.test(before), before.split('\n')[0])
	await tools.browser_tools.execute({ action: 'probe' }, {})
	const text = String(contexts[0]?.text?.() ?? '')
	check('探到桥后文本含端口与分层', /9777/.test(text) && /分层/.test(text), text.split('\n').slice(0, 2).join(' | '))
}

console.log('\n[4] 调用即唤醒：唤醒带回落地网址，回执只挂一次')
{
	installFetch(() => null)
	const { ctx, hooks } = makeCtx()
	const bridge = makeBridge({ extensionConnected: false })
	const { controller } = makeController()
	applyBuddyFeatures({ ctx, bridge: bridge.service, controller, config: { autoLaunchOnToolUse: true, autoLaunchWaitMs: 0 } })
	const exec = { name: 'browser_read', arguments: { url: 'https://example.com/' }, agent: { id: 'sess-1' } }
	await hooks['tools/pre-execute'](exec, async () => ({ kind: 'allow' }))
	check('bridge.wake 被调用一次', bridge.wakes.length === 1, JSON.stringify(bridge.wakes[0] ?? {}))
	check('唤醒带走落地网址', bridge.wakes[0]?.url === 'https://example.com/', JSON.stringify(bridge.wakes[0] ?? {}))
	const first = await hooks['tools/post-execute'](exec, {}, async () => acceptWith('x'))
	const second = await hooks['tools/post-execute'](exec, {}, async () => acceptWith('x'))
	check('第一次结果里带唤醒回执', /自动唤起|已唤醒/.test(pluginText(first)), pluginText(first).split('\n')[0]?.slice(0, 90))
	check('第二次不再重复回执', !/自动唤起|已唤醒/.test(pluginText(second)), pluginText(second).split('\n')[0]?.slice(0, 60) || '(只有原始上下文)')
}

console.log('\n[5] 登记簿送达：会话首次调用挂一次摘要')
{
	installFetch(() => null)
	const { ctx, hooks } = makeCtx()
	const bridge = makeBridge({ issues: [{ id: 'bi-999', status: 'open', title: '示例问题', symptom: 's', workaround: '绕行办法', match: 'nomatch-xyz' }] })
	const { controller } = makeController()
	applyBuddyFeatures({ ctx, bridge: bridge.service, controller, config: {} })
	const exec = { name: 'browser_read', args: {}, agent: { id: 'sess-2' } }
	const out = await hooks['tools/post-execute'](exec, { ok: true, text: 'nothing matched' }, async () => acceptWith('x'))
	check('首次调用挂上登记簿摘要', /bi-999/.test(pluginText(out)) || /绕行办法/.test(pluginText(out)), pluginText(out).split('\n')[0]?.slice(0, 80))
}

console.log('\n[6] frames / frame_eval 直连 controller，且先过已开标签页红线')
{
	installFetch(() => null)
	const { ctx, tools } = makeCtx()
	const bridge = makeBridge()
	const framesResult = {
		title: '示例页', url: 'https://example.com/', isFrameset: true, hasBody: true, count: 1,
		frames: [{ index: 0, name: 'main', sameOrigin: true, url: 'https://example.com/f', textPreview: '预览文本' }],
	}
	const { controller, calls } = makeController({ execute: (command) => (command === 'frames' ? framesResult : '1+1 = 2') })
	const denied = []
	applyBuddyFeatures({
		ctx, bridge: bridge.service, controller, config: {},
		authorizeTab: async (tabId) => {
			denied.push(tabId)
			if (tabId === 7) throw new Error('WEB_BLOCKED_URL: 该标签页踩红线')
		},
	})
	const framesOut = await tools.browser_frames.execute({ tabId: 5 }, {})
	check('frames 走 controller.execute（不是 HTTP）', calls.length === 1 && calls[0].command === 'frames', calls.map((c) => c.command).join(','))
	check('frames 结果渲染正常', /isFrameset=true/.test(framesOut.text) && /#0/.test(framesOut.text), framesOut.text.split('\n')[0].slice(0, 60))
	let refused = null
	try {
		await tools.browser_frame_eval.execute({ frame: 'main', expression: '1', tabId: 7 }, {})
	} catch (error) {
		refused = error instanceof Error ? error.message : String(error)
	}
	check('两个工具调用前都跑了 authorizeTab', denied.includes(5) && denied.includes(7), JSON.stringify(denied))
	check('红线拒绝时 frame_eval 必须失败（不许静默继续）', refused !== null && /红线/.test(refused), String(refused).slice(0, 60))
	check('被拒后没有再打 controller', calls.length === 1, calls.map((c) => c.command).join(','))
}

console.log('\n[7] 探桥候选端口：桥自报 boundPort 优先（X15 回归）')
{
	const tried = []
	installFetch((url) => { tried.push(url); return null })
	const { ctx, tools } = makeCtx()
	const bridge = makeBridge({ port: 9777, boundPort: 9999 })
	const { controller } = makeController()
	applyBuddyFeatures({ ctx, bridge: bridge.service, controller, config: {} })
	await tools.browser_tools.execute({ action: 'probe' }, {})
	const order = tried.map((u) => Number(u.split(':')[2]?.split('/')[0]))
	check('先探 boundPort(9999)，再配置端口(9777)', order[0] === 9999 && order[1] === 9777, order.slice(0, 4).join(' → '))
}

console.log('\n[8] auto_launch 写回插件自己的命名空间')
{
	installFetch(() => null)
	const { ctx, tools, settings } = makeCtx()
	const bridge = makeBridge()
	const { controller } = makeController()
	applyBuddyFeatures({ ctx, bridge: bridge.service, controller, config: {} })
	const out = await tools.browser_tools.execute({ action: 'auto_launch', value: true }, {})
	check('写回命名空间 = browser-bridge', settings.updates.some((u) => u.ns === 'browser-bridge'), JSON.stringify(settings.updates.map((u) => u.ns)))
	check('回执含唤醒目标（exe/profile）', /exe=/.test(out.text) && /profile=/.test(out.text), out.text.split('\n')[0])
}

try { rmSync(fakeHome, { recursive: true, force: true }) } catch { /* ignore */ }

const failed = results.filter((r) => !r.ok)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	for (const f of failed) console.log('  - ' + f.name)
	process.exit(1)
}
