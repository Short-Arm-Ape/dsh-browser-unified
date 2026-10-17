#!/usr/bin/env node
/**
 * error-contract.mjs — 失败文案的「该不该重试」契约（纯逻辑，不需要浏览器/重启）。
 *
 * 动机（上游 v1.0.13 同一条）：宿主的失败内容是 `Error: ${message}`，而 `code` /
 * `effectState` / `hint` 这些结构化字段只进 `error.info` 与 HTTP 面 —— **模型读不到**。
 * 于是"点超时了要不要重试""链路断了动作落没落"这种决定，模型只能瞎猜；猜错的代价是
 * 点两次、提交两次表单。所以决定下一步所需的信息必须**写进 message 本身**。
 *
 * 本测试钉住四件事：
 *   1. 写操作超时/掉线 ⇒ `effectState=unknown`（可能已经落到页面上），文案里必须出现该字样与下一步；
 *   2. 读操作同样的失败 ⇒ `not_started`（重试安全）；
 *   3. **策略拦截**（UrlPolicyError，命令根本没发出去）⇒ `policy_blocked` 且 `not_started`
 *      —— 不能按"写操作"一律报 unknown，那是把确定的事说成不确定；
 *   4. 各类底层文案 → code 的映射，以及 classify 的幂等（core 桥包一次、插件壳再包一次）。
 *
 * 复现：node tests/error-contract.mjs      # 需要先 npm run build（core 的 dist/ 要有）
 */

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..', 'packages', 'browser-unified-plugin')
const require = createRequire(path.join(pkg, 'package.json'))
const corePath = require.resolve('browser-unified-core')
const core = await import(pathToFileURL(corePath).href)

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const { classify, BridgeError, isWriteCommand } = core

console.log('\n[1] 写命令集合：判据是「重试会不会造成额外损害」')
{
	check('click / nav / press / input / tabs.close 是写命令',
		['click', 'nav', 'press', 'input', 'tabs.close'].every((c) => isWriteCommand(c)))
	check('只读命令不是写命令', !['content', 'snapshot', 'find', 'screenshot', 'wait', 'tabs.list', 'browser.info'].some((c) => isWriteCommand(c)))
	check('window.ensure 不算写命令（幂等：没窗口才建）', !isWriteCommand('window.ensure'))
}

console.log('\n[2] 写操作超时 = 结果未知；读操作超时 = 重试安全')
{
	const write = classify('click', new Error('browser command timed out after 800ms: click'))
	check('code = command_timeout', write.code === 'command_timeout', write.code)
	check('effectState = unknown', write.effectState === 'unknown', write.effectState)
	check('message 里带 effectState=unknown', write.message.includes('effectState=unknown'))
	check('message 里带"不要直接重试"的下一步', write.message.includes('不要直接重试'))
	check('message 里没有把原始描述吞掉', write.message.includes('timed out after 800ms'))

	const read = classify('snapshot', new Error('browser command timed out after 800ms: snapshot'))
	check('读命令同文案 ⇒ not_started', read.effectState === 'not_started', read.effectState)
	check('读命令的文案说"重试安全"', read.message.includes('重试安全'))
}

console.log('\n[3] 策略拦截：命令没发出去，"没动到页面"是确定的')
{
	const err = new Error('WEB_BLOCKED_URL: 目标被 URL 策略拦下')
	err.name = 'UrlPolicyError'
	const blocked = classify('nav', err)
	check('code = policy_blocked（本仓库扩展码）', blocked.code === 'policy_blocked', blocked.code)
	check('effectState = not_started（不能报 unknown）', blocked.effectState === 'not_started', blocked.effectState)
	check('hint 指向设置里的策略项而不是"重试"', blocked.hint.includes('策略') && blocked.hint.includes('不会有不同结果'))
}

console.log('\n[4] 底层文案 → code 的映射')
{
	const cases = [
		['no browser extension connected — open the browser…', 'extension_offline'],
		['the browser extension disconnected mid-command', 'link_lost'],
		['browser-bridge stopped', 'link_lost'],
		['browser command cancelled: click', 'cancelled'],
		['浏览器控制未启用 —— 到 dsh 设置 →「浏览器」分区打开开关', 'bridge_disabled'],
		['listen EADDRINUSE: address already in use 127.0.0.1:9777', 'bridge_disabled'],
		['尚未加载配置', 'not_configured'],
		['扩展报回：selector not found', 'command_failed'],
	]
	for (const [message, code] of cases) {
		const got = classify('click', new Error(message))
		check(`${code} ← ${message.slice(0, 34)}…`, got.code === code, got.code)
	}
}

console.log('\n[5] 幂等：桥包一次、插件壳再包一次，code 不能被洗掉')
{
	const first = classify('click', new Error('browser command timed out after 800ms: click'))
	const second = classify('click', first)
	check('同一个对象原样返回（不二次改造）', second === first)
	check('再包一次 message 也不会出现两段契约文案', (second.message.match(/effectState=/g) ?? []).length === 1)
	check('BridgeError 带 command / detail / toJSON', first.command === 'click'
		&& first.detail === 'browser command timed out after 800ms: click'
		&& first.toJSON().effectState === 'unknown')
}

// ---- 2026-10-17：hello 规范化（protocol 曾被漏拷，协商形同虚设）----
{
	const { normalizeHello } = core
	check('normalizeHello 已导出', typeof normalizeHello === 'function')
	const h1 = normalizeHello({ client: 'dsh-browser-extension', version: '1.0.22', protocol: 1, browser: { name: 'edge', version: '155', ua: 'x' }, extensionId: 'abc' })
	check('protocol 被保留（这是修的那个洞）', h1.protocol === 1, JSON.stringify(h1))
	check('extensionId 被保留', h1.extensionId === 'abc')
	const h2 = normalizeHello({ client: 'c', version: 'v', browser: { name: 'n', version: '1', ua: '' } })
	check('旧扩展不带 protocol ⇒ undefined（不是 0，状态面自己兜底）', h2.protocol === undefined)
	check('protocol 非法类型被忽略',
		normalizeHello({ protocol: 'one' }).protocol === undefined
		&& normalizeHello({ protocol: -3 }).protocol === undefined
		&& normalizeHello({ protocol: Number.NaN }).protocol === undefined)
	check('protocol 小数被截断成整数', normalizeHello({ protocol: 1.9 }).protocol === 1)
	check('缺 client/version 有兜底', normalizeHello({}).client === 'unknown' && normalizeHello({}).version === 'unknown')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	for (const f of failed) console.log('  - ' + f.name)
	process.exit(1)
}
