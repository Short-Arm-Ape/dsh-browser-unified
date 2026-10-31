#!/usr/bin/env node
/**
 * http-face-access.mjs — 「只读档 / 关掉允许执行任意脚本」这两道闸必须**两个入口都生效**（2026-11-01）。
 *
 * 动机：审计发现 `execute()` 里有这两道判据，而 `POST /api/command` 走的是 core 的
 * `guardCommand` 钩子 → 插件 `guardHttpCommand()`，那里只判 URL 策略，完全不过访问控制。
 * 后果不是文案问题，是真越权：同一个只读档，模型调不动 `browser_click`，但任何带 token 的
 * 同伴件（或另一个脚本）POST 一次 `/api/command` 就能点击、输入、求值。
 *
 * 这个套件直接拿**真的** `BridgeController`（导出来只为这件事），把状态摆成只读/关脚本，
 * 然后**两个入口各调一次**，要求它们给出同一条拒绝。判据只有一份（`accessDenial`），
 * 谁把调用删掉这条就红 —— 不是靠读源码猜。
 *
 * 复现：node tests/http-face-access.mjs   （需要先构建插件 lib/）
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const lib = path.join(repo, 'packages', 'browser-unified-plugin', 'lib', 'index.js')
const { BridgeController } = await import(pathToFileURL(lib).href)

const results = []
function check(name, ok, detail) {
	results.push({ name, ok: ok === true })
	console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 起一个什么都不连的控制器：只摆状态，不发命令（accessDenial 在发命令之前就拦）。 */
function controllerWith(state) {
	const created = new BridgeController(() => {})
	// `current` 在编译产物里就是个普通属性；这里直接摆成配置解析后的形状。
	created.current = state
	return created
}

async function executeError(controller, command) {
	try {
		await controller.execute(command, {}, new AbortController().signal)
		return undefined
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

console.log('\n1) 只读档：HTTP 命令面与工具面给出同一条拒绝')
{
	const controller = controllerWith({ readOnly: true, allowScript: true })
	const viaHttp = await controller.guardHttpCommand('click', { selector: '#go', tabId: 7 })
	check('guardHttpCommand(click) 被拒', typeof viaHttp === 'string' && viaHttp.includes('只读模式'), String(viaHttp).slice(0, 80))
	const viaTool = await executeError(controller, 'click')
	check('execute(click) 也被拒（同一句话）', typeof viaTool === 'string' && viaTool.includes('只读模式'), String(viaTool).slice(0, 80))
	check('两个入口的拒绝理由一致', typeof viaHttp === 'string' && typeof viaTool === 'string' && viaHttp.includes('只读模式') && viaTool.includes('只读模式'))
	for (const command of ['input', 'press', 'nav', 'eval', 'scroll', 'hold.on']) {
		const reason = await controller.guardHttpCommand(command, {})
		check(`只读档：写类命令 ${command} 在 HTTP 面被拒`, typeof reason === 'string' && reason.includes('只读模式'), String(reason).slice(0, 60))
	}
	const readBack = await controller.guardHttpCommand('content', { tabId: 7 })
	check('只读档：读页面（content）不被这道闸拦（阳性对照，别把只读做成什么都干不了）', readBack === undefined, String(readBack))
	const ping = await controller.guardHttpCommand('ping', {})
	check('只读档：ping / tabs.list 这类只读命令放行', ping === undefined, String(ping))
}

console.log('\n2) 关掉「允许执行任意脚本」：eval 被拒，点击不受影响')
{
	const controller = controllerWith({ readOnly: false, allowScript: false })
	const viaHttp = await controller.guardHttpCommand('eval', { expression: '1' })
	check('guardHttpCommand(eval) 被拒', typeof viaHttp === 'string' && viaHttp.includes('脚本执行已关闭'), String(viaHttp).slice(0, 80))
	const viaTool = await executeError(controller, 'eval')
	check('execute(eval) 也被拒（同一句话）', typeof viaTool === 'string' && viaTool.includes('脚本执行已关闭'), String(viaTool).slice(0, 80))
	const click = await controller.guardHttpCommand('click', {})
	check('点击不受这条开关影响（阳性对照）', click === undefined, String(click))
	const content = await controller.guardHttpCommand('content', {})
	check('读页面也不受影响（content 不在脚本类里，2026-10-31 审计修过）', content === undefined, String(content))
}

console.log('\n3) 两档都开：闸门不该误伤')
{
	const controller = controllerWith({ readOnly: false, allowScript: true })
	const click = await controller.guardHttpCommand('click', {})
	check('全放开时 click 放行（闸门本身没坏）', click === undefined, String(click))
	const evalAllowed = await controller.guardHttpCommand('eval', {})
	check('全放开时 eval 也放行（剩下的拦截交给 URL/页面策略）', evalAllowed === undefined, String(evalAllowed))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败：')
	for (const f of failed) console.log(`  ✗ ${f.name}`)
	process.exit(1)
}
