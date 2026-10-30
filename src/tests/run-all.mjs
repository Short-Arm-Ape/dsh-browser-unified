#!/usr/bin/env node
/**
 * run-all.mjs — 一次跑完 tests/ 下的全部回归套件，并按退出码汇总。
 *
 * 为什么要有这个文件：每个套件都是独立进程（各自起自己的桥、自己的假 chrome），
 * 之前只能一个一个敲，CI 里也得把文件名抄一遍——抄漏一个就静默少验一块。
 * 这里改成一个命令：`node tests/run-all.mjs`。
 *
 * 只管「跑与汇总」：每个套件自己数断言、自己 `process.exit(1)`，这里不自作判断。
 * 缺构建产物时直接说清楚该跑什么，而不是抛一堆 MODULE_NOT_FOUND。
 *
 * 用法（仓库根目录）：
 *   node tests/run-all.mjs          # 全部
 *   node tests/run-all.mjs tool     # 只跑文件名包含 tool 的
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const filter = process.argv[2] ?? ''
const suites = readdirSync(here)
	.filter((name) => name.endsWith('.mjs') && name !== 'run-all.mjs')
	.filter((name) => filter.length === 0 || name.includes(filter))
	.sort()

if (suites.length === 0) {
	console.error(`没有匹配 "${filter}" 的套件（${here}）`)
	process.exit(2)
}

// 绝大多数套件加载的是**构建产物**，不是 src：缺了就先说清楚，别让它以
// ERR_MODULE_NOT_FOUND 的形式出现（那种报错看起来像测试坏了）。
const built = path.join(root, 'packages', 'browser-unified-plugin', 'lib', 'index.js')
if (!existsSync(built)) {
	console.error(`缺少构建产物：${path.relative(root, built)}`)
	console.error('先构建：')
	console.error('  cd packages/browser-unified-core && npm run build')
	console.error('  cd packages/browser-unified-plugin && node scripts/build-pack.mjs --no-pack')
	process.exit(2)
}

const rows = []
for (const suite of suites) {
	const started = Date.now()
	const run = spawnSync(process.execPath, [path.join(here, suite)], {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, FORCE_COLOR: '0' },
	})
	const ms = Date.now() - started
	const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
	const lastLine = output.trim().split('\n').filter((l) => l.trim().length > 0).at(-1) ?? ''
	rows.push({ suite, ok: run.status === 0, ms, lastLine })
	console.log(`${run.status === 0 ? '✓' : '✗'} ${suite.padEnd(30)} ${String(ms).padStart(6)}ms  ${lastLine.slice(0, 80)}`)
	if (run.status !== 0) {
		// 失败时把整套输出打出来：只留最后一行会把真正的断言藏掉。
		console.log(output.trim().split('\n').map((l) => `    ${l}`).join('\n'))
	}
}

const failed = rows.filter((r) => !r.ok)
const totalMs = rows.reduce((sum, r) => sum + r.ms, 0)
console.log(`\n${rows.length - failed.length}/${rows.length} 套件通过（${(totalMs / 1000).toFixed(1)}s）`)
if (failed.length > 0) {
	console.log('失败：')
	for (const f of failed) console.log(`  ✗ ${f.suite}`)
	process.exit(1)
}
