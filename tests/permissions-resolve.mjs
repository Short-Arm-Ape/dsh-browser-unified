#!/usr/bin/env node
/**
 * permissions-resolve.mjs — bi-013 的回归测试（不需要浏览器、不需要重启）。
 *
 * 现场（2026-10-08/09 实测）：`browser_permissions` 报
 * `读不到 C:\Users\…\Profile 3/Preferences —— autoLaunchProfileDir 要指向 profile 目录…`，
 * 而配置**本来就是对的**：浏览器在 Windows 侧（路径是 Windows 形态），宿主跑在 WSL 里
 * ⇒ `path.join('C:\\…', 'Preferences')` 得到一个不存在的相对路径。后果很实在：命令超时时
 * 那个"用来判断是不是权限气泡在等人"的常驻工具正好失效，而且把模型引向"去改配置"（写操作）。
 *
 * 本测试钉三件事：
 *   1. 形态转换能救回来（Windows 形态 → `/mnt/c/…`），且**如实报告**用了哪个路径；
 *   2. 真读不到时，错误里列**试过哪些**、且不再把"配置写错了"当作原因；
 *   3. 候选全空时给的是"先让扩展连上一次"的指路，而不是一句内部异常。
 *
 * 复现：node tests/permissions-resolve.mjs        # 需要先 npm run build
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..', 'packages', 'browser-unified-plugin')
const { readPermissionStoreTolerant } = await import(pathToFileURL(path.join(pkg, 'lib', 'permissions.js')).href)

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
function skip(name, why) {
	console.log(`  - ${name}（跳过：${why}）`)
}

// 本机实测过的那个 profile（Edge 的 Profile 3 = "Agent"，装了扩展的那个）。
const WSL_DIR = '/mnt/c/Users/localuser/AppData/Local/Microsoft/Edge/User Data/Profile 3'
const WIN_DIR = 'C:\\Users\\localuser\\AppData\\Local\\Microsoft\\Edge\\User Data\\Profile 3'
const hasRealProfile = existsSync(path.join(WSL_DIR, 'Preferences'))

console.log('\n[1] 形态转换：Windows 形态的配置在 WSL 里也能读到')
if (hasRealProfile) {
	const viaWsl = readPermissionStoreTolerant([WSL_DIR])
	check('WSL 形态原样命中（converted=false）', viaWsl.converted === false && viaWsl.usedDir === WSL_DIR, viaWsl.usedDir)
	check('读到真实的 124 个权限类', viaWsl.store.classNames.length > 100, `${viaWsl.store.classNames.length} 类`)
	check('能定位到 Preferences 文件', /Profile 3[\\/]Preferences$/.test(viaWsl.store.file), viaWsl.store.file)

	const viaWin = readPermissionStoreTolerant([WIN_DIR])
	check('Windows 形态自动转换后命中（converted=true）', viaWin.converted === true, `${viaWin.configuredDir} → ${viaWin.usedDir}`)
	check('转换后用的是 WSL 可访问的 /mnt/c 形态', viaWin.usedDir === WSL_DIR, viaWin.usedDir)
	check('转换结果与直接读 WSL 形态一致（同一份 Preferences）',
		viaWin.store.file === viaWsl.store.file && viaWin.store.classNames.length === viaWsl.store.classNames.length)
} else {
	skip('形态转换', `本机没有 ${WSL_DIR}`)
}

console.log('\n[2] 真读不到时：列试过哪些，且不再冤枉配置')
{
	let message = ''
	try {
		readPermissionStoreTolerant([WIN_DIR.replace('Profile 3', 'Profile 99')])
	} catch (error) {
		message = error instanceof Error ? error.message : String(error)
	}
	check('抛出明确错误（而不是内部异常）', message.length > 0)
	check('列出了试过的路径', /试过：/.test(message) && /Profile 99/.test(message), message.split('\n').slice(0, 3).join(' / '))
	check('两种真实原因都写明（User Data 层 / profile 没启动过）', /User Data/.test(message) && /从未启动过/.test(message))
	check('明确排除"配置写错"这一误导解释', /已经不是原因之一/.test(message))
	check('不再出现旧的断言式文案', !/autoLaunchProfileDir 要指向 \*\*profile 目录\*\*/.test(message))
}

console.log('\n[3] 候选全空：给"先让扩展连上一次"的指路')
{
	let message = ''
	try {
		readPermissionStoreTolerant([undefined, '', '   '])
	} catch (error) {
		message = error instanceof Error ? error.message : String(error)
	}
	check('空候选也给可行动的错误', /配对记录里也没有位置/.test(message) && /连上过一回/.test(message), message.slice(0, 120))
}

console.log('\n[4] 多候选按顺序回退（配置值不命中时用配对记录）')
if (hasRealProfile) {
	const resolution = readPermissionStoreTolerant([WIN_DIR.replace('Profile 3', 'Profile 99'), WIN_DIR])
	check('第一个候选失败后回退到第二个', resolution.usedDir === WSL_DIR, `${resolution.tried.join(' → ')}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	for (const f of failed) console.log('  - ' + f.name)
	process.exit(1)
}
