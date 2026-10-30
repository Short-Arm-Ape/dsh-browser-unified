#!/usr/bin/env node
/**
 * registry-consistency.mjs — X17 的回归测试（离线、不需要浏览器/重启）。
 *
 * 为什么要有它：「设计注册表是唯一真相源」曾经只是一句话 —— 实际同时存在三份
 * （仓库根 design/registry.json、包内 registry/、装机 node_modules 里那份），
 * 它们真的会互相矛盾（实测：根 20 条 vs 包内 34 条），而运行时读写的其实是**装机那份**；
 * 与此同时 `authz.writeAllowlist` 只是一段文案，代码从不读它（issues.json 也没被列进去）。
 *
 * 本测试钉住四件事：
 *   1. 包内 registry/ 是唯一真源；仓库根的 design/registry.json 与 upstream-baseline.json
 *      与它**逐字节一致**（由 build-pack 生成镜像）；
 *   2. 工具真正会写的路径都写在 authz.writeAllowlist 里（且名单里没有它其实不写的东西）；
 *   3. tooling 里的工具名与**实际注册**的工具名一致（写错名字等于文档说谎）；
 *   4. 两份数据自身的不变量（id 唯一 / 状态合法 / open 带绕行 / fixed 带版本）。
 *
 * 复现：node tests/registry-consistency.mjs        # 需要先 npm run build-pack（或 npm run build）
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const pkg = path.join(repo, 'packages', 'browser-unified-plugin')

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const read = (file) => readFileSync(file, 'utf8')
const readJson = (file) => JSON.parse(read(file))

/** 与 schema 默认值对齐的最小配置（enabled=false ⇒ 不会真的 bind 端口、不会起桥）。 */
const CONFIG_MIN = {
	enabled: false, port: 9777, token: 't', shotsDir: 'x', urlMode: 'public',
	blockMetadata: true, metadataHostnames: [], metadataIps: [],
	internetAccess: undefined, lanAccess: undefined, localAccess: undefined,
	internetTemp: true, lanTemp: true, localTemp: true, askMode: 'inherit',
	dshAccessEnabled: false, dshOrigins: [], allowHosts: [], denyHosts: [], registryDir: '',
	autoLaunchEnabled: false, autoLaunchIdleSeconds: 15, autoLaunchBrowserExe: '',
	autoLaunchProfileDir: '', autoLaunchProfileName: '', autoLaunchTempProfile: false, autoLaunchExtensionDir: '',
}

console.log('\n[1] 单一真源：仓库根镜像是包内副本的逐字节镜像')
{
	const pairs = [
		[path.join(pkg, 'registry', 'design', 'registry.json'), path.join(repo, 'design', 'registry.json')],
		[path.join(pkg, 'registry', 'upstream-baseline.json'), path.join(repo, 'upstream-baseline.json')],
	]
	for (const [from, to] of pairs) {
		let ok = false
		let detail = ''
		try {
			ok = read(from) === read(to)
			if (!ok) {
				const a = readJson(from)
				const b = readJson(to)
				const count = (v) => Array.isArray(v.designEntries) ? v.designEntries.length : (Array.isArray(v.repos) ? v.repos.length : '?')
				detail = `不一致：包内 ${count(a)} 条 vs 仓库根 ${count(b)} 条（跑 build-pack 会同步镜像）`
			}
		} catch (error) {
			detail = error instanceof Error ? error.message : String(error)
		}
		check(`镜像一致：${path.relative(repo, to)}`, ok, detail)
	}
}

const registry = readJson(path.join(pkg, 'registry', 'design', 'registry.json'))
const issuesDoc = readJson(path.join(pkg, 'registry', 'issues', 'issues.json'))

console.log('\n[2] 写白名单必须覆盖工具真正会写的路径')
{
	const written = ['design/registry.json', 'issues/issues.json']
	const allow = Array.isArray(registry.authz?.writeAllowlist) ? registry.authz.writeAllowlist.map(String) : []
	for (const target of written) check(`白名单含 ${target}`, allow.includes(target), allow.join(', '))
	const extra = allow.filter((entry) => !written.includes(entry))
	check('白名单里没有"其实不写"的路径（否则白名单本身在说谎）', extra.length === 0, extra.join(', '))
	check('白名单有说明字段（讲清 baseline 不由工具写）',
		typeof registry.authz?.writeAllowlistNote === 'string' && registry.authz.writeAllowlistNote.includes('upstream-baseline'))
}

console.log('\n[3] tooling 里的工具名 == 实际注册的工具名')
{
	const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)
	const registered = new Set()
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools: { register: (definition) => { registered.add(definition.name) } },
		inject() {},
		get() { return undefined },
		effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
		on() { return () => {} },
		provide() { return () => {} },
		systemPrompt: { context: () => () => {}, section: () => () => {}, tools: () => () => {} },
	}
	mod.apply(ctx, CONFIG_MIN)
	const tooling = registry.tooling ?? {}
	const named = ['checkToolName', 'designViewToolName', 'designEditToolName', 'issuesToolName']
	for (const key of named) {
		const value = tooling[key]
		check(`tooling.${key} = ${String(value)} 与实际注册一致`, typeof value === 'string' && registered.has(value), [...registered].filter((n) => n.startsWith('browser_')).join(','))
	}
	check('writeAllowlist 的校验真的接在写入路径上（built 产物里能找到拒绝文案）',
		read(path.join(pkg, 'lib', 'unified-tools.js')).includes('不在 authz.writeAllowlist 内'))
}

console.log('\n[4] 数据自身的不变量')
{
	const entries = Array.isArray(registry.designEntries) ? registry.designEntries : []
	const ids = entries.map((e) => e.id)
	check('设计条目 id 唯一', new Set(ids).size === ids.length, `共 ${ids.length} 条`)
	const allowed = new Set(['proposed', 'accepted', 'applied', 'rejected', 'superseded'])
	const badStatus = entries.filter((e) => !allowed.has(String(e.status)))
	check('设计条目状态都在状态机内', badStatus.length === 0, badStatus.map((e) => `${e.id}:${e.status}`).join(','))
	const badTitle = entries.filter((e) => typeof e.title !== 'string' || e.title.length === 0)
	check('设计条目都有标题', badTitle.length === 0)

	const issues = Array.isArray(issuesDoc.issues) ? issuesDoc.issues : []
	const issueIds = issues.map((i) => i.id)
	check('问题条目 id 唯一', new Set(issueIds).size === issueIds.length, `共 ${issueIds.length} 条`)
	const openWithout = issues.filter((i) => i.status === 'open' && (typeof i.workaround !== 'string' || i.workaround.length === 0))
	check('每条 open 问题都带绕行方案', openWithout.length === 0, openWithout.map((i) => i.id).join(','))
	const fixedWithout = issues.filter((i) => i.status === 'fixed' && (typeof i.fixedIn !== 'string' || i.fixedIn.length === 0))
	check('每条已修复问题都标注修复版本', fixedWithout.length === 0, fixedWithout.map((i) => i.id).join(','))
	const badStatus2 = issues.filter((i) => !['open', 'fixed', 'wontfix'].includes(String(i.status)))
	check('问题条目状态合法', badStatus2.length === 0, badStatus2.map((i) => `${i.id}:${i.status}`).join(','))
}

console.log('\n[5] role 决定谁进漂移自检（merge 才查；reference 跳过但要说出来）')
{
	const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)
	const tmp = mkdtempSync(path.join(os.tmpdir(), 'role-check-'))
	mkdirSync(path.join(tmp, 'design'), { recursive: true })
	writeFileSync(path.join(tmp, 'design', 'registry.json'), JSON.stringify({ schemaVersion: 1, impactRules: {}, designEntries: [] }))
	// 两个假来源：URL 指向一个必定立刻失败的本地端口（不碰真网络、不依赖 github 可达）。
	const bogus = 'https://127.0.0.1:9/nope.git'
	writeFileSync(path.join(tmp, 'upstream-baseline.json'), JSON.stringify({
		schemaVersion: 1,
		pinnedAt: 'test',
		repos: [
			{ id: 'fake-merge', url: bogus, pinnedSha: '0'.repeat(40), role: 'merge' },
			{ id: 'fake-reference', url: bogus, pinnedSha: '0'.repeat(40), role: 'reference' },
			{ id: 'fake-legacy-no-role', url: bogus, pinnedSha: '0'.repeat(40) },
		],
	}))
	const tools = new Map()
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools: { register: (definition) => { tools.set(definition.name, definition) } },
		inject() {},
		get() { return undefined },
		effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
		on() { return () => {} },
		provide() { return () => {} },
		systemPrompt: { context: () => () => {}, section: () => () => {}, tools: () => () => {} },
	}
	mod.apply(ctx, { ...CONFIG_MIN, registryDir: tmp })
	const tool = tools.get('browser_check_update')
	const run = async (args) => String((await tool.execute(args, { signal: undefined })).text)

	const def = await run({})
	check('默认不查 reference 档', def.includes('fake-reference') && !def.split('\n').some((l) => l.startsWith('[fake-reference]')),
		def.split('\n').filter((l) => l.includes('fake-reference')).join(' | '))
	check('默认也不查没有 role 的老条目（缺省=merge 的老语义不变）', def.includes('[fake-legacy-no-role]'), def.includes('legacy'))
	check('被跳过的参考来源在报告里点名（不静默丢弃）', def.includes('未查的参考来源') && def.includes('fake-reference(reference)'))
	check('merge 档照旧去查（这里必定 UNREACHABLE，因为 URL 指向死端口）', def.includes('[fake-merge] UNREACHABLE'))

	const explicit = await run({ repos: ['fake-reference'] })
	check('显式点名 reference 档时仍会查（工具不因角色变哑巴）', explicit.includes('[fake-reference] UNREACHABLE'))

	rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	for (const f of failed) console.log('  - ' + f.name)
	process.exit(1)
}
