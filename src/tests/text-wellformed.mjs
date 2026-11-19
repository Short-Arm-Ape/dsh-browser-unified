#!/usr/bin/env node
/**
 * text-wellformed.mjs — 半个 emoji 不许进模型（上游 v1.7.10 / issue #26 的回归）。
 *
 * 为什么值得单独钉：页面文本被截断时如果切在高位代理项上，孤立代理项经 `JSON.stringify`
 * 变成裸 `\ud83d`，模型侧的 JSON 解析器会拒收**整个请求体**；坏字符还会随会话历史每轮重放，
 * `/compact` 也清不掉。这类缺陷不会报错、也不会让任何测试变红——只会让会话在某轮突然 400。
 *
 * 做法：加载构建产物 `lib/index.js`，用假 ctx 跑 `apply()`，把**每个**工具的 render 喂一份
 * 带孤立代理项与「切点正好落在 emoji 中间」的 value，断言渲染出来的文本里没有孤立代理项。
 *
 * 复现：node tests/text-wellformed.mjs        # 需要先构建（node node_modules/typescript/bin/tsc -p tsconfig.json）
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..', 'packages', 'browser-unified-plugin')
const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)

let failures = 0
function check(name, ok, detail = '') {
	if (!ok) failures++
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 孤立代理项检测：高位后面不是低位，或低位前面不是高位。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const CONFIG = {
	enabled: false,
	port: 9777,
	token: 'dsh-local',
	shotsDir: 'dsh-browser-shots',
	urlMode: 'public',
	blockMetadata: true,
	metadataHostnames: [],
	metadataIps: [],
	internetAccess: undefined,
	lanAccess: undefined,
	localAccess: undefined,
	internetTemp: true,
	lanTemp: true,
	localTemp: true,
	askMode: 'inherit',
	dshAccessEnabled: false,
	dshOrigins: [],
	allowHosts: [],
	denyHosts: [],
	registryDir: '',
	autoLaunchEnabled: false,
	autoLaunchIdleSeconds: 15,
	autoLaunchBrowserExe: '',
	autoLaunchProfileDir: '',
	autoLaunchProfileName: '',
	autoLaunchTempProfile: false,
	autoLaunchExtensionDir: '',
}

const tools = new Map()
const ctx = {
	logger: { info() {}, warn() {}, error() {} },
	tools: { register: (definition) => { tools.set(definition.name, definition) } },
	inject() { /* 不提供 settings */ },
	get() { return undefined },
	effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
	on() { return () => {} },
	provide() { return () => {} },
	systemPrompt: { context: () => () => {}, section: () => () => {}, tools: () => () => {} },
}
mod.apply(ctx, CONFIG)

/** 一份「到处都可能被截断」的 value：顶层、数组元素、深层字段各带一个半个 emoji。 */
function poisonValue() {
	const half = '\uD83D' // 半个 emoji（高位代理项单独出现）
	const emoji = '😀'
	// 让 JSON.stringify 的截断点正好落在 emoji 中间：2 + 1999 个字符后是高位代理项
	const boundary = `${'x'.repeat(1997)}${half}`
	return {
		tabId: 1,
		title: `标题${half}`,
		url: 'https://example.com/p',
		text: `正文前段${boundary}${emoji}尾巴`,
		items: [{ ref: 'e1', name: `名${half}`, text: `值${half}` }],
		entries: [{ level: 'log', text: `日志${half}` }],
		requests: [{ method: 'GET', url: `https://example.com/${half}` }],
		tabs: [{ id: 1, title: `标签${half}`, url: 'https://example.com/p' }],
	}
}

console.log('\n[1] 每个工具的 render 都不许吐出孤立代理项')
{
	const value = poisonValue()
	let exercised = 0
	let checked = 0
	const skipped = []
	for (const [name, definition] of tools) {
		const render = definition?.output?.render
		if (typeof render !== 'function') continue
		exercised++
		let text = ''
		try {
			const blocks = render({}, value)
			text = (Array.isArray(blocks) ? blocks : [])
				.map((block) => (block && typeof block.text === 'string' ? block.text : ''))
				.join('\n')
		} catch {
			// 这条 render 要它自己那份 value 形状（例如 browser_read 要 text.length），
			// 用通用毒值喂必然抛 —— 不用它判良构，但下面要求被真正检查的渲染器够多。
			skipped.push(name)
			continue
		}
		checked++
		check(`${name}: 无孤立代理项`, !LONE.test(text), text.slice(0, 60))
	}
	check('至少真正检查 20 个渲染器', checked >= 20, `检查 ${checked} / 共 ${exercised}（跳过 ${skipped.length}: ${skipped.join(', ')}）`)
}

console.log('\n[2] 2000 字符截断点正好切在 emoji 中间时，不许留下半个')
{
	const value = { data: `"${'x'.repeat(1996)}😀"` }
	let cleaned = 0
	let total = 0
	const dirty = []
	for (const [name, definition] of tools) {
		const render = definition?.output?.render
		if (typeof render !== 'function') continue
		let text = ''
		try {
			const blocks = render({}, value)
			text = (Array.isArray(blocks) ? blocks : [])
				.map((block) => (block && typeof block.text === 'string' ? block.text : ''))
				.join('\n')
		} catch { continue }
		total++
		if (LONE.test(text)) check(`${name}: 无半个 emoji`, false, text.slice(-40))
		else cleaned++
	}
	check('所有渲染结果都不含半个 emoji', total > 0 && cleaned === total, `${cleaned}/${total}`)
}

console.log('\n[3] 阴性对照：没装这道闸时同样的输入确实会带出孤立代理项')
{
	// 直接模拟旧行为：JSON.stringify(...).slice(0, 2000)，确认它真的会把半个 emoji 切出来，
	// 否则上面的断言可能只是「输入里根本没出现过半个」而显得全绿。
	const source = `"${'x'.repeat(1996)}😀"`
	const naive = JSON.stringify(source).slice(0, 2000)
	check('旧写法确实切出孤立代理项（说明断言有意义）', LONE.test(naive))
}

console.log('')
if (failures > 0) {
	console.log(`FAILED: ${failures} 项`)
	process.exit(1)
}
console.log('text-wellformed: 全部通过')
