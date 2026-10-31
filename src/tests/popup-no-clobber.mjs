#!/usr/bin/env node
/**
 * popup-no-clobber.mjs — 扩展 popup 的表单回填与「测试」语义（2026-11-01 主人指出后定）。
 *
 * 背景（真踩过）：popup 每 1.5s 刷一次，老代码把**除当前聚焦那个以外**的字段全部按生效值
 * 回填。于是「先改 token、再改端口、最后一起保存」时，先改的那个被静默刷回旧值 —— 看着改好了，
 * 保存下去的是旧的。而「重新扫描本地桥」被他当**测试项**用（填完先试、再保存），测的却是
 * 存储里的旧值：测试通过、保存后反而连不上。
 *
 * 这里用 node:vm + 一个极小的假 DOM 直接驱动**真实的 popup.js**，钉住四条判据：
 *   1. 面板**收起**时才回填（收起 = 以已保存的值为准；这也是阳性对照）；
 *   2. 面板展开且有未保存改动时，1.5s 刷新**不许**动表单；
 *   3. 「重新扫描本地桥」把**表单里当前的值**一起送出去（tryConfig），不落盘；
 *   4. 「保存」才落盘，且落的是表单里的值；收起后表单回到已保存的值（丢弃未保存的填写）。
 *
 * 复现：node tests/popup-no-clobber.mjs   （不需要浏览器、不需要构建）
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const code = readFileSync(path.join(root, 'extension', 'popup.js'), 'utf8')

const results = []
function check(name, ok, detail) {
	results.push({ name, ok: ok === true })
	console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const DEFAULT_CONFIG = { port: 9777, token: 'dsh-local', autoConnect: true, lastKnownPort: null, dialogPolicy: 'accept' }

function makeEl(id) {
	return {
		id,
		value: '',
		checked: false,
		textContent: '',
		className: '',
		dataset: {},
		style: {},
		_h: {},
		classList: {
			_s: new Set(),
			add(c) { this._s.add(c) },
			remove(c) { this._s.delete(c) },
			toggle(c, force) {
				const on = force === undefined ? !this._s.has(c) : Boolean(force)
				if (on) this._s.add(c)
				else this._s.delete(c)
				return on
			},
			contains(c) { return this._s.has(c) },
		},
		addEventListener(type, fn) { this._h[type] = fn },
		click() { return this._h.click?.() },
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** 在假 DOM 里跑真实的 popup.js；`stored` 就是 chrome.storage.local 里那份已保存配置。 */
function loadPopup(stored) {
	const elements = new Map()
	const document = {
		activeElement: null,
		getElementById(id) {
			if (!elements.has(id)) elements.set(id, makeEl(id))
			return elements.get(id)
		},
	}
	const sent = []
	const writes = []
	const state = { stored: { ...stored }, effective: { ...stored } }
	const chrome = {
		runtime: {
			getManifest: () => ({ version: '1.0.54' }),
			sendMessage: async (msg) => {
				sent.push(msg)
				if (msg.type === 'bridgeStatus') {
					return {
						state: 'idle',
						// 运行中的 cfg 与已落盘的 cfgPersisted 分开给（真实的 background 也是两份）
						cfg: { ...DEFAULT_CONFIG, ...state.effective },
						cfgPersisted: { ...DEFAULT_CONFIG, ...state.stored },
						helloInfo: null,
						lastError: null,
						locked: false,
						discoveredPort: 9777,
						lastProbeNote: null,
					}
				}
				if (msg.type === 'lockSet') return { locked: msg.locked }
				return { started: true }
			},
		},
		storage: {
			local: {
				get: async () => ({ ...state.stored }),
				set: async (obj) => {
					writes.push({ ...obj })
					Object.assign(state.stored, obj)
					Object.assign(state.effective, obj)
				},
			},
		},
		tabs: { create: async () => ({}) },
	}
	const sandbox = {
		document,
		chrome,
		window: { close() {} },
		console,
		setTimeout: () => 0,
		setInterval: () => 0,
		clearTimeout: () => {},
	}
	sandbox.globalThis = sandbox
	const ctx = vm.createContext(sandbox)
	new vm.Script(code).runInContext(ctx)
	return { ctx, el: (id) => document.getElementById(id), sent, writes, state }
}

const SAVED = { port: 9777, token: 'old-token', autoConnect: true, dialogPolicy: 'accept' }

console.log('\n1) 初始（面板收起）：回填已保存的值')
const p = loadPopup(SAVED)
await tick()
check('token 回填为已保存值', p.el('token').value === 'old-token', p.el('token').value)
check('端口回填为已保存值', p.el('port').value === 9777, String(p.el('port').value))
check('此时没有未保存改动', p.el('save').textContent === '保存并重连', p.el('save').textContent)

console.log('\n2) 展开面板后改两个字段：1.5s 刷新不许把它们刷回去')
p.el('gear').click()
await tick()
check('面板已展开', p.el('advanced').classList.contains('open'))
p.el('token').value = 'new-token'
await p.ctx.render(await p.ctx.chrome.runtime.sendMessage({ type: 'bridgeStatus' }))
p.el('port').value = '9778'
await p.ctx.render(await p.ctx.chrome.runtime.sendMessage({ type: 'bridgeStatus' }))
check('改过的 token 没被刷回旧值', p.el('token').value === 'new-token', p.el('token').value)
check('改过的端口没被刷回旧值', Number(p.el('port').value) === 9778, String(p.el('port').value))
check('有未保存改动时按钮点了出来', p.el('save').textContent.includes('有改动'), p.el('save').textContent)

console.log('\n3) 「重新扫描本地桥」= 测试项：用表单里的值去试，不落盘')
p.sent.length = 0
await p.el('rescan').click()
const rescan = p.sent.find((m) => m.type === 'rescan')
check('发出了 rescan', rescan !== undefined)
check('带上了表单里的 token', rescan?.tryConfig?.token === 'new-token', JSON.stringify(rescan?.tryConfig))
check('带上了表单里的端口', rescan?.tryConfig?.port === 9778, JSON.stringify(rescan?.tryConfig))
check('测试不写存储', p.writes.length === 0, JSON.stringify(p.writes))
// 台子里的 setTimeout 是空桩，所以手动跑一次刷新（真机上是 rescan 后 1.2s 自己刷）。
await p.ctx.render(await p.ctx.chrome.runtime.sendMessage({ type: 'bridgeStatus' }))
check('扫描结论旁注明「用的是表单值、尚未保存」', /尚未保存/.test(p.el('scan').textContent), p.el('scan').textContent)

console.log('\n4) 「保存并重连」才落盘，且落的是表单里的值')
await p.el('save').click()
check('写了一次存储', p.writes.length === 1, JSON.stringify(p.writes))
check('存的是改过的 token', p.writes[0]?.token === 'new-token', JSON.stringify(p.writes[0]))
check('存的是改过的端口', Number(p.writes[0]?.port) === 9778, JSON.stringify(p.writes[0]))
await p.ctx.render(await p.ctx.chrome.runtime.sendMessage({ type: 'bridgeStatus' }))
check('保存后不再显示「有改动」', p.el('save').textContent === '保存并重连', p.el('save').textContent)

console.log('\n5) 收起面板 = 以已保存的值为准（丢弃没保存的填写）')
p.el('token').value = 'typed-but-not-saved'
p.el('gear').click()
await tick()
check('收起后 token 回到已保存的值', p.el('token').value === 'new-token', p.el('token').value)
check('收起后端口回到已保存的值', Number(p.el('port').value) === 9778, String(p.el('port').value))

console.log('\n6) 阳性对照：收起状态下刷新**确实**会回填（上面不是"永远不回填"的假象）')
p.el('token').value = 'garbage'
await p.ctx.render(await p.ctx.chrome.runtime.sendMessage({ type: 'bridgeStatus' }))
check('收起时手动改输入框会被回填覆盖', p.el('token').value === 'new-token', p.el('token').value)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败：')
	for (const f of failed) console.log(`  ✗ ${f.name}`)
	process.exit(1)
}
