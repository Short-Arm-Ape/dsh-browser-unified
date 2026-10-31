#!/usr/bin/env node
/**
 * issues-fail-closed.mjs — 问题登记簿的写入必须 fail-closed（2026-11-01 审计第 4 条）。
 *
 * 原来的写法：`readJson(file).catch(() => ({schemaVersion:1, issues:[]}))` —— 读不出就用
 * 空登记簿顶上。于是 `issues.json` 一旦是坏 JSON（手改成半截、磁盘写坏、合并冲突残留），
 * 下一次 `browser_issues action=add` 会把**整本**登记簿覆盖成这一条，而 `.bak` 只有上一版
 * （再写一次 `.bak` 也被覆盖）。这不是"丢一条"，是"丢一本"。
 *
 * 这里钉三件事，缺一条都不算修好：
 *   1. 文件在但解析不出来 → 拒绝写入，且原文件**一个字节都不动**（也不留半成品 .bak）；
 *   2. 文件真的不存在 → 允许新建（阳性对照：证明 1 不是"什么都写不了"）；
 *   3. 文件合法 → 追加，既有条目原样保留（证明 fail-closed 没把正常路径误伤）。
 *
 * 复现：node tests/issues-fail-closed.mjs   （需要先构建插件 lib/）
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const pkg = path.join(repo, 'packages', 'browser-unified-plugin')
const { applyUnifiedTools } = await import(pathToFileURL(path.join(pkg, 'lib', 'unified-tools.js')).href)

const results = []
function check(name, ok, detail) {
	results.push({ name, ok: ok === true })
	console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-issues-failclosed-'))
mkdirSync(path.join(dir, 'design'), { recursive: true })
mkdirSync(path.join(dir, 'issues'), { recursive: true })
// authz.writeAllowlist 必须放行 issues/issues.json，否则被白名单先挡住，测不到这条路径。
writeFileSync(
	path.join(dir, 'design', 'registry.json'),
	JSON.stringify({ schemaVersion: 1, authz: { writeAllowlist: ['issues/issues.json'] } }, null, 2),
)

const tools = {}
const ctx = {
	get: (name) => (name === 'approval'
		? { request: async () => 'allowed-once', config: { policy: 'ask' } }
		: undefined),
	tools: { register: (def) => { tools[def.name] = def } },
}
applyUnifiedTools(ctx, { registryDir: dir })

const issuesFile = path.join(dir, 'issues', 'issues.json')
const exec = { agent: { id: 'agent-1', session: { seq: 1 } }, signal: new AbortController().signal }
const call = (args) => tools.browser_issues.execute(args, exec)

try {
	console.log('\n1) 文件在但解析不出来 → 拒绝写入，原文件一个字节不动')
	const corrupt = '{ "schemaVersion": 1, "issues": [ {"id": "bi-001"'
	writeFileSync(issuesFile, corrupt)
	const before = readFileSync(issuesFile, 'utf8')
	const bad = await call({ action: 'add', title: '新问题', symptom: '症状' })
	check('add 返回 ok:false', bad.ok === false, JSON.stringify(bad).slice(0, 80))
	check('拒绝文案点名 fail-closed 并说是解析失败', /fail-closed/.test(bad.text) && /解析失败/.test(bad.text), bad.text.slice(0, 120))
	check('原文件逐字节未变（没有把整本覆盖成一条）', readFileSync(issuesFile, 'utf8') === before)
	check('没有产生 .bak 半成品（备份是写完前才做的）', !existsSync(issuesFile + '.bak'))
	check('也没有别的文件被顺手写出来', existsSync(issuesFile))

	console.log('\n2) 文件真的不存在 → 允许新建（阳性对照）')
	rmSync(issuesFile, { force: true })
	const created = await call({ action: 'add', title: '第一条', symptom: '当场看到的现象' })
	check('add 成功新建', created.ok === true, String(created.text).slice(0, 90))
	const reg1 = JSON.parse(readFileSync(issuesFile, 'utf8'))
	check('新建出 schemaVersion:1 + 1 条', reg1.schemaVersion === 1 && Array.isArray(reg1.issues) && reg1.issues.length === 1, JSON.stringify(reg1).slice(0, 100))
	check('新条目 id = bi-001', reg1.issues[0].id === 'bi-001', String(reg1.issues[0].id))

	console.log('\n3) 文件合法 → 追加而不是覆盖（fail-closed 没误伤正常路径）')
	const existing = {
		schemaVersion: 1,
		lastUpdated: '2026-10-01T00:00:00.000Z',
		issues: [
			{ id: 'bi-001', title: '旧的 open', status: 'open', symptom: 'a', history: [] },
			{ id: 'bi-002', title: '旧的 fixed', status: 'fixed', symptom: 'b', fixedIn: '0.9.0', history: [] },
		],
	}
	writeFileSync(issuesFile, JSON.stringify(existing, null, 2) + '\n')
	const appended = await call({ action: 'add', title: '新的', symptom: 'c' })
	check('add 成功', appended.ok === true, String(appended.text).slice(0, 90))
	const reg2 = JSON.parse(readFileSync(issuesFile, 'utf8'))
	check('变成 3 条', reg2.issues.length === 3, `len=${reg2.issues.length}`)
	check('既有 2 条原样保留（顺序与字段都在）', reg2.issues[0].id === 'bi-001' && reg2.issues[0].status === 'open' && reg2.issues[1].id === 'bi-002' && reg2.issues[1].fixedIn === '0.9.0')
	check('新条目接着编号 bi-003', reg2.issues[2].id === 'bi-003', String(reg2.issues[2].id))

	const resolved = await call({ action: 'resolve', id: 'bi-001', fixedIn: '0.11.51' })
	const reg3 = JSON.parse(readFileSync(issuesFile, 'utf8'))
	check('resolve 也走同一条写入路径（bi-001 → fixed）', resolved.ok === true && reg3.issues[0].status === 'fixed' && reg3.issues[0].fixedIn === '0.11.51', String(resolved.text).slice(0, 80))
	check('resolve 之后仍然是 3 条（没被覆盖）', reg3.issues.length === 3, `len=${reg3.issues.length}`)
} finally {
	rmSync(dir, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败：')
	for (const f of failed) console.log(`  ✗ ${f.name}`)
	process.exit(1)
}
