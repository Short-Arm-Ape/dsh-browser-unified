#!/usr/bin/env node
/**
 * tool-render.mjs — 模型侧 tool render 的回归测试（不需要浏览器、不需要重启）。
 *
 * 动机：这批工具曾经把有用数据留在结构化 `value` 里、`render` 只回一行摘要，或者把 JSON 硬切到
 * 300/400 字符。模型只看得到 render 的文本 —— 于是 `browser_snapshot` 拿不到 ref、
 * `browser_console_log` / `browser_network_log` 拿不到条目、`browser_evaluate` 长结果必被砍。
 * 这类缺陷不会让任何东西报错，只会静默变废，所以必须由测试钉住。
 *
 * 做法：加载**构建产物** `lib/index.js`，用假 ctx 跑 `apply()`，拿到每个工具的
 * `output.render`，喂合成 value，断言载荷真的出现在文本里。
 *
 * 复现：node tests/tool-render.mjs        # 需要先 npm run build-pack（或 npm run build）
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..', 'packages', 'browser-unified-plugin')
const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 与 schema 默认值对齐的最小配置；enabled=false 保证不会真的去 bind 端口。 */
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
	inject() { /* 不提供 settings：current 退回组合配置 */ },
	get() { return undefined },   // 真实 ctx 有 get（approval 等可选服务靠它）；这里一律没有 → 写类动作应 fail-closed
	effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
	on() { return () => {} },
	provide() { return () => {} },
	systemPrompt: { context: () => () => {}, section: () => () => {}, tools: () => () => {} },
}
mod.apply(ctx, CONFIG)

function renderText(name, args, value) {
	const definition = tools.get(name)
	if (definition === undefined) throw new Error(`工具未注册：${name}`)
	const blocks = definition.output.render(args, value)
	return blocks.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('\n')
}

console.log('\n[1] browser_snapshot：ref 必须交给模型（它存在的理由）')
{
	const text = renderText('browser_snapshot', {}, {
		tabId: 7,
		title: '登录页',
		url: 'https://example.com/login',
		items: [
			{ ref: 'e1', tag: 'input', name: '用户名' },
			{ ref: 'e2', tag: 'button', name: '登录' },
			{ ref: 'e3', tag: 'a', href: 'https://example.com/help' },
		],
	})
	check('含 ref e1/e2/e3', ['e1', 'e2', 'e3'].every((ref) => text.includes(ref)))
	check('含元素名与 href', text.includes('用户名') && text.includes('登录') && text.includes('help'))
	check('含标题与元素数', text.includes('登录页') && text.includes('3 个可交互元素'))
}

console.log('\n[2] browser_console_log：条目必须交给模型')
{
	const text = renderText('browser_console_log', {}, {
		tabId: 7,
		count: 2,
		total: 9,
		entries: [
			{ tabId: 7, level: 'error', text: 'Uncaught TypeError: x is not a function', t: 1_760_000_000_000, location: 'app.js:12' },
			{ tabId: 7, level: 'log', text: 'submit clicked', t: 1_760_000_001_000 },
		],
	})
	check('含 error 文本', text.includes('x is not a function'))
	check('含级别与来源', text.includes('[error]') && text.includes('app.js:12'))
	check('含第二条', text.includes('submit clicked'))
}

console.log('\n[3] browser_network_log：请求行必须交给模型')
{
	const text = renderText('browser_network_log', {}, {
		tabId: 7,
		count: 3,
		total: 62,
		requests: [
			{ method: 'POST', url: 'https://ti.qianxin.com/api/vulnerability/list', status: 200, resourceType: 'XHR', encodedDataLength: 4096 },
			{ method: 'GET', url: 'https://ti.qianxin.com/api/missing', status: 404, resourceType: 'Fetch' },
			{ method: 'GET', url: 'https://cdn.example.com/a.js', failed: true, errorText: 'net::ERR_BLOCKED_BY_CLIENT' },
		],
	})
	check('含 200/404/FAILED', text.includes('200') && text.includes('404') && text.includes('FAILED'))
	check('含方法与 URL', text.includes('POST') && text.includes('api/vulnerability/list'))
	check('含失败原因与资源类型', text.includes('ERR_BLOCKED_BY_CLIENT') && text.includes('[XHR]'))
}

console.log('\n[4] browser_evaluate：不再硬砍 300 字符')
{
	const long = 'x'.repeat(5000)
	const text = renderText('browser_evaluate', { expression: '1' }, { tabId: 7, json: long })
	check('5000 字符完整返回', text.length === 5000, `实际 ${text.length}`)
	const huge = renderText('browser_evaluate', { expression: '1' }, { tabId: 7, json: 'y'.repeat(30_000) })
	check('超长时明确标注截断（而不是静默）', huge.includes('已截断') && huge.length > 15_000, `实际 ${huge.length}`)
}

console.log('\n[5] browser_tabs：列表给人看（不是被切一半的 JSON）')
{
	const text = renderText('browser_tabs', { action: 'list' }, {
		count: 2,
		windows: 1,
		noWindow: false,
		activeTabId: 875806349,
		tabs: [
			{ id: 875806349, url: 'http://127.0.0.1:3080/', title: 'DeepSeek Harness', active: true },
			{ id: 875806480, url: 'https://ti.qianxin.com/vulnerability/list', title: '奇安信威胁情报中心', active: false },
		],
	})
	check('含两个 tabId', text.includes('875806349') && text.includes('875806480'))
	check('标出 active 与标题', text.includes('active') && text.includes('DeepSeek Harness') && text.includes('奇安信威胁情报中心'))
}

console.log('\n[6] 反向断言：这些工具**不**该再出现"只有计数"的文本')
{
	const summaryOnly = [
		['browser_snapshot', {}, { tabId: 1, title: 'T', url: 'u', items: [{ ref: 'e1', tag: 'button' }] }],
		['browser_console_log', {}, { tabId: 1, count: 1, total: 1, entries: [{ level: 'warn', text: 'W' }] }],
		['browser_network_log', {}, { tabId: 1, count: 1, total: 1, requests: [{ method: 'GET', url: 'http://a' }] }],
	]
	for (const [name, args, value] of summaryOnly) {
		const text = renderText(name, args, value)
		check(`${name} 不再只回计数`, text.split('\n').length > 1, `行数 ${text.split('\n').length}`)
	}
}

console.log('\n[7] browser_issues：第二部分注册表（调用时的问题）')
{
	const issuesTool = tools.get('browser_issues')
	check('工具已注册', issuesTool !== undefined)

	const summary = await issuesTool.execute({ action: 'summary' }, {})
	check('summary 给出 open 问题 + 绕行', summary.ok === true && summary.text.includes('bi-004') && summary.text.includes('绕行：'), summary.text.split('\n')[1] ?? '')
	check('summary 给出已修复清单', /已修复：/.test(summary.text))

	const list = await issuesTool.execute({ action: 'list' }, {})
	check('list 一行一条', list.text.includes('bi-001') && list.text.includes('[fixed]'))

	const show = await issuesTool.execute({ action: 'show', id: 'bi-001' }, {})
	check('show 输出完整内容（症状/证据/历史）', show.text.includes('症状：') && show.text.includes('证据：') && show.text.includes('历史：'))
	const missing = await issuesTool.execute({ action: 'show', id: 'bi-999' }, {})
	check('show 找不到时明确报错', missing.ok === false && missing.text.includes('bi-999'))

	// 写入类必须 fail-closed（这个假 ctx 没有审批服务）
	const add = await issuesTool.execute({ action: 'add', title: 'x', symptom: 'y' }, {})
	check('无审批服务时写入 fail-closed', add.ok === false && add.text.includes('拒绝写入'), add.text)
	const noTitle = await issuesTool.execute({ action: 'add', symptom: 'y' }, {})
	check('add 缺 title 明确报错', noTitle.ok === false && noTitle.text.includes('title'))

	// ── bi-017 回归：审批请求必须携带**真正的 agent（带 .session）** ────────────────
	// 历史 bug：这里传的是合成对象 `{ id: agent.id }`，而审批服务第一行就是
	// `const session = req.agent.session` → `hasOpenTurn(session)` 读 `session.seq`
	// ⇒ 必然抛 "Cannot read properties of undefined (reading 'seq')"，
	// 于是"用户批准了却什么都没写进去"。下面既钉住请求形状，也钉住三种拒绝文案。
	const { mkdtemp, mkdir, writeFile, readFile } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')

	/** 造一个带最小注册表结构的临时 registry 目录（写入要真落盘，才算"批准就写得进去"）。 */
	async function makeTempRegistry() {
		const dir = await mkdtemp(path.join(tmpdir(), 'dsh-bi017-'))
		await mkdir(path.join(dir, 'issues'), { recursive: true })
		await mkdir(path.join(dir, 'design'), { recursive: true })
		await writeFile(path.join(dir, 'issues', 'issues.json'), JSON.stringify({
			schemaVersion: 1, lastUpdated: '2026-01-01T00:00:00.000Z', purpose: 'test', fields: {}, issues: [],
		}, null, 2) + '\n', 'utf8')
		await writeFile(path.join(dir, 'design', 'registry.json'), JSON.stringify({
			schemaVersion: 1, lastUpdated: '2026-01-01T00:00:00.000Z', designEntries: [],
			// X17 起写入会**真的**校验 authz.writeAllowlist（fail-closed）：夹具必须带上它，
			// 否则连"批准后应写入"这条也会被白名单挡住 —— 那正是新语义。
			authz: { writeAllowlist: ['design/registry.json', 'issues/issues.json'] },
		}, null, 2) + '\n', 'utf8')
		return dir
	}

	/** 用给定的 approval 假服务挂起插件，返回 { tool, seen }（seen 记录服务收到的请求）。 */
	function mountWithApproval(approval, registryDir) {
		const seen = []
		const localTools = new Map()
		const localCtx = {
			logger: { info() {}, warn() {}, error() {} },
			tools: { register: (definition) => { localTools.set(definition.name, definition) } },
			inject() {},
			effect() { return () => {} },
			on() { return () => {} },
			provide() { return () => {} },
			systemPrompt: { context: () => () => {}, section: () => () => {}, tools: () => () => {} },
			get: (name) => (name === 'approval' ? {
				request: async (req) => { seen.push(req); return approval.outcome ?? 'allowed-once' },
				...(approval.policy === undefined ? {} : { overrideOf: () => approval.policy }),
				...(approval.throwOnRequest === true ? { request: async (req) => { seen.push(req); throw new Error(approval.throwText ?? 'boom') } } : {}),
			} : undefined),
		}
		mod.apply(localCtx, { ...CONFIG, registryDir })
		return { tool: localTools.get('browser_issues'), seen }
	}

	const tempRegistry = await makeTempRegistry()
	const session = { seq: 42, append() {}, eventAt() { return undefined } }
	const agent = { id: 'agent-1', session }

	// ① 形状：服务收到的 agent 必须**就是**调用方那个对象，且 .session 原样可达
	{
		const { tool, seen } = mountWithApproval({ outcome: 'allowed-once' }, tempRegistry)
		const result = await tool.execute({ action: 'add', title: '形状检查', symptom: 's', workaround: 'w' }, { agent })
		check('审批请求携带真 agent（session 可达，不再是 {id} 合成对象）',
			seen.length === 1 && seen[0].agent === agent && seen[0].agent.session === session,
			`seen=${seen.length}${seen[0] ? `，agent.session=${String(seen[0].agent && seen[0].agent.session === session)}` : ''}`)
		check('批准后**真的写入**（回执 + 落盘含新条目）',
			result.ok === true && result.text.includes('已写入'),
			result.text)
		const onDisk = JSON.parse(await readFile(path.join(tempRegistry, 'issues', 'issues.json'), 'utf8'))
		check('落盘内容含刚写的条目', onDisk.issues.some((i) => i.title === '形状检查'), JSON.stringify(onDisk.issues.map((i) => i.title)))
	}
	// ② agent 没带 session → 明确拒绝（而不是 TypeError）
	{
		const { tool } = mountWithApproval({ outcome: 'allowed-once' }, tempRegistry)
		const result = await tool.execute({ action: 'add', title: 't', symptom: 's' }, { agent: { id: 'agent-1' } })
		check('agent 无 session → 明确拒绝（不再抛 reading \'seq\'）',
			result.ok === false && result.text.includes('没携带会话') && !result.text.includes("reading 'seq'"),
			result.text)
	}
	// ③ 策略 never → 说清是策略拒绝、并给出替代路径
	{
		const { tool } = mountWithApproval({ outcome: 'allowed-once', policy: 'never' }, tempRegistry)
		const result = await tool.execute({ action: 'add', title: 't', symptom: 's' }, { agent })
		check('策略 never → 明确说明是策略拒绝 + 指路',
			result.ok === false && result.text.includes('never') && result.text.includes('直接编辑'),
			result.text)
	}
	// ④ 服务抛异常 → 仍然 fail-closed，且保留原始异常文本作诊断
	{
		const { tool } = mountWithApproval({ throwOnRequest: true, throwText: "Cannot read properties of undefined (reading 'seq')" }, tempRegistry)
		const result = await tool.execute({ action: 'add', title: 't', symptom: 's' }, { agent })
		check('审批抛异常 → 明确拒绝（fail-closed + 保留原始异常作诊断）',
			result.ok === false && result.text.includes('审批请求失败') && result.text.includes('拒绝写入（fail-closed）'),
			result.text)
	}
	// ④b X17：白名单里没有 issues.json 时必须 fail-closed 拒绝（这条就是"白名单不是文案"的证据）
	{
		const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
		const { tmpdir } = await import('node:os')
		const dir = await mkdtemp(path.join(tmpdir(), 'dsh-allowlist-'))
		await mkdir(path.join(dir, 'issues'), { recursive: true })
		await mkdir(path.join(dir, 'design'), { recursive: true })
		await writeFile(path.join(dir, 'issues', 'issues.json'), JSON.stringify({ schemaVersion: 1, issues: [] }, null, 2) + '\n', 'utf8')
		await writeFile(path.join(dir, 'design', 'registry.json'), JSON.stringify({
			schemaVersion: 1, designEntries: [], authz: { writeAllowlist: ['design/registry.json'] },
		}, null, 2) + '\n', 'utf8')
		const { tool } = mountWithApproval({ outcome: 'allowed-once' }, dir)
		const result = await tool.execute({ action: 'add', title: '不该写入', symptom: 's', workaround: 'w' }, { agent })
		const onDisk = JSON.parse(await readFile(path.join(dir, 'issues', 'issues.json'), 'utf8'))
		check('写白名单不含 issues.json → 拒绝写入（fail-closed）',
			result.ok === false && /不在 authz.writeAllowlist 内/.test(result.text) && onDisk.issues.length === 0,
			result.text)
	}

	// ⑤ 未批准（denied）→ 不写入
	{
		const { tool } = mountWithApproval({ outcome: 'denied' }, tempRegistry)
		const result = await tool.execute({ action: 'add', title: '不该出现', symptom: 's' }, { agent })
		const onDisk = JSON.parse(await readFile(path.join(tempRegistry, 'issues', 'issues.json'), 'utf8'))
		check('审批拒绝 → 未获批准 + 未写入',
			result.ok === false && result.text.includes('未获批准') && !onDisk.issues.some((i) => i.title === '不该出现'),
			result.text)
	}

	// 数据不变量：open 项必须有绕行方案（会话首次调用的摘要靠它）
	const { loadIssues } = await import(pathToFileURL(path.join(pkg, 'lib', 'unified-tools.js')).href)
	const { issues } = await loadIssues('')
	const openWithout = issues.filter((i) => i.status === 'open' && (typeof i.workaround !== 'string' || i.workaround.length === 0))
	check('每条 open 问题都带绕行方案', openWithout.length === 0, openWithout.map((i) => i.id).join(','))
	const fixedWithout = issues.filter((i) => i.status === 'fixed' && (typeof i.fixedIn !== 'string' || i.fixedIn.length === 0))
	check('每条已修复问题都标注修复版本', fixedWithout.length === 0, fixedWithout.map((i) => i.id).join(','))
}

console.log('\n[8] 2026-10-09 修的模型可见契约（bi-015 / bi-016 / F-1 / F-2 / bi-014）')
{
	const paramNames = (name) => Object.keys(tools.get(name).parameters?.properties ?? {})

	// bi-015：等待原语 + navigate 就绪参数
	const waitTool = tools.get('browser_wait')
	check('browser_wait 已注册', waitTool !== undefined)
	if (waitTool !== undefined) {
		const names = paramNames('browser_wait')
		check('browser_wait 有 selector/text/fn/timeoutMs',
			['selector', 'text', 'fn', 'timeoutMs'].every((n) => names.includes(n)), names.join(','))
		check('browser_wait 描述点明"超时 ≠ 页面没有内容"', /不等于/.test(waitTool.description))
	}
	const navNames = paramNames('browser_navigate')
	check('browser_navigate 支持 waitSelector/waitText/waitFn/waitTimeoutMs',
		['waitSelector', 'waitText', 'waitFn', 'waitTimeoutMs'].every((n) => navNames.includes(n)), navNames.join(','))
	{
		const text = renderText('browser_navigate', {}, { tabId: 3, url: 'https://example.com', title: 'T', waitedMs: 15_000, waitTimedOut: true })
		check('navigate render 说清"等待未成立 ≠ 没内容"', /未成立/.test(text) && /不等于/.test(text), text)
		const okText = renderText('browser_navigate', {}, { tabId: 3, url: 'https://example.com', title: 'T', waitedMs: 420, waitTimedOut: false })
		check('navigate render 报出等待耗时', /420ms/.test(okText), okText)
		// bi-023：导航没等完必须如实说（"仍在加载"），别让模型以为到位了
		check('navigate 输出 schema 含 loadPending',
			'loadPending' in ((tools.get('browser_navigate').output?.schema?.properties) ?? {}))
		const pendingText = renderText('browser_navigate', {}, { tabId: 3, url: 'https://example.com', title: 'T', loadPending: true })
		check('navigate render 说清"仍在加载、别单次采样"', /仍在加载/.test(pendingText) && /browser_wait/.test(pendingText), pendingText)
		// 页面落到浏览器错误页时，错误码必须送到模型眼前（以前 siteUnreachable 对象被 === true 判丢）
		const unreachableText = renderText('browser_navigate', {}, {
			tabId: 3, url: 'https://developer.android.com/studio', title: 'developer.android.com',
			siteUnreachable: true, error: 'ERR_CONNECTION_TIMED_OUT — developer.android.com 响应时间太长',
		})
		check('navigate render 报出不可达与具体错误码',
			/unreachable/.test(unreachableText) && /ERR_CONNECTION_TIMED_OUT/.test(unreachableText), unreachableText)
		// 等待"被中止"（页面错误页）不能被说成"超时/可能只是慢" —— 那是误诊
		const abortedText = renderText('browser_navigate', {}, {
			tabId: 3, url: 'https://developer.android.com/studio', title: 'developer.android.com',
			siteUnreachable: true, error: 'ERR_CONNECTION_TIMED_OUT — 响应时间太长',
			waitedMs: 1, waitAborted: true, waitError: '页面加载失败（浏览器错误页）：ERR_CONNECTION_TIMED_OUT',
		})
		check('等待被中止 ≠ 等待超时（不套"可能只是慢"的话术）',
			/已中止/.test(abortedText) && !/可能只是慢/.test(abortedText) && /原因见上/.test(abortedText), abortedText)
	}

	// bi-016：eval 超时旋钮
	check('browser_evaluate 有 timeoutMs', paramNames('browser_evaluate').includes('timeoutMs'))
	check('browser_evaluate 描述说明顶层 await 与"别写轮询"',
		/顶层 `await`/.test(tools.get('browser_evaluate').description) && /browser_wait/.test(tools.get('browser_evaluate').description))

	// F-1：批量关页签
	const tabNames = paramNames('browser_tabs')
	check('browser_tabs close 支持 tabIds/urlPattern/others',
		['tabIds', 'urlPattern', 'others'].every((n) => tabNames.includes(n)), tabNames.join(','))
	{
		const text = renderText('browser_tabs', { action: 'close' }, { closed: 3, closedIds: [11, 12, 13] })
		check('批量关页签 render 给出数量与 id', /已关闭 3 个/.test(text) && /11, 12, 13/.test(text), text)
	}

	// F-2：点击/输入的真实输入语义（自动置前 + 最小化限制）
	check('browser_click 描述点明自动置前与最小化限制',
		/自动置前/.test(tools.get('browser_click').description) && /最小化/.test(tools.get('browser_click').description))
	check('browser_type 描述同样点明置前/最小化', /置前/.test(tools.get('browser_type').description))

	// bi-014：snapshot 的 why 载荷要能到达模型
	{
		const text = renderText('browser_snapshot', {}, {
			tabId: 9,
			title: '商品页',
			url: 'https://example.com/g',
			items: [
				{ ref: 'e1', tag: 'div', name: '5口千兆铁壳 ¥21.49', why: 'cursor' },
				{ ref: 'e2', tag: 'input', name: '搜索', why: 'native' },
			],
		})
		check('snapshot render 标出 cursor 类候选与其数量',
			/\(cursor\)/.test(text) && /1 个是"只有点击处理器的元素"/.test(text), text.split('\n')[1] ?? '')
	}

	// X14：denyHosts 的状态行必须说出"这份名单此刻到底生不生效"
	{
		const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)
		const fn = mod.denyHostsStatusLine
		check('denyHostsStatusLine 已导出', typeof fn === 'function')
		if (typeof fn === 'function') {
			const normal = fn('a.com', false)
			const ignored = fn('a.com', true)
			check('生效时不加警告', normal === 'denyHosts: a.com' && !/不生效/.test(normal), normal)
			check('askMode=放行时明确标注"本名单不生效"',
				/不生效/.test(ignored) && /askMode/.test(ignored) && /红线/.test(ignored), ignored)
		}
	}

	// X19：只有证书/CA 类失败才允许"关掉 TLS 校验重试"
	{
		const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'unified-tools.js')).href)
		const fn = mod.shouldRetryInsecureGit
		check('shouldRetryInsecureGit 已导出', typeof fn === 'function')
		if (typeof fn === 'function') {
			check('CA 类失败 → 允许回退',
				fn('fatal: unable to get local issuer certificate') && fn('SSL certificate problem: self-signed certificate'))
			check('代理/超时/DNS 类失败 → **不**回退（不给中间人留窗口）',
				!fn('Failed to connect to github.com port 443: Connection timed out')
				&& !fn('Could not resolve host: github.com')
				&& !fn('OpenSSL SSL_read: Connection reset by peer'))
		}
	}

	// 工具面总数（防止新增工具被分层名单漏掉时无人发现）。
	// 30 = 27 + 2026-10-13 吸收上游 v1.0.9 的 3 个（browser_find / browser_dialog / browser_info）。
	const browserTools = [...tools.keys()].filter((n) => n.startsWith('browser_'))
	check('宿主侧 browser_* 工具数 = 30（含 2026-10-13 新并入的 find/dialog/info）', browserTools.length === 30, `${browserTools.length}: ${browserTools.join(',')}`)
	for (const merged of ['browser_tools', 'browser_frames', 'browser_frame_eval']) {
		check(`合并进来的 ${merged} 已注册`, browserTools.includes(merged))
	}
}

console.log('\n[9] 2026-10-13 吸收上游：read 窗口 / find / dialog / info / nav 未落地')
{
	// read：头部必须说清「这是哪一段、下一段怎么取」——否则长页面只能一次倒进上下文。
	const longRead = renderText('browser_read', { offset: 20000 }, {
		tabId: 3, mode: 'text', title: '长页', url: 'https://example.com/long',
		content: 'x'.repeat(100), truncated: true, offset: 20000, totalChars: 43210,
	})
	check('read 头含区间 chars 20000-20100 of 43210', longRead.includes('chars 20000-20100 of 43210'), longRead.split('\n')[0])
	check('read 头含「call again with offset=20100」', longRead.includes('call again with offset=20100'))
	check('read 正文就是窗口那一段', longRead.includes('x'.repeat(100)))
	const shortRead = renderText('browser_read', {}, { tabId: 3, mode: 'text', title: 't', url: 'u', content: 'abc', truncated: false, offset: 0, totalChars: 3 })
	check('读完了就不再提示 offset=', !shortRead.includes('call again with offset='))

	// find：给人看的行，不是半截 JSON。
	const found = renderText('browser_find', { selector: '.sku' }, {
		tabId: 3, selector: '.sku', count: 7,
		items: [
			{ tag: 'div', id: 'a', class: 'sku-plus active', text: '加价购', rect: '120×40 @300,410' },
			{ tag: 'a', href: '/x', rect: '10×10 @0,0' },
		],
	})
	check('find 头含总数与选择器', found.includes('7 个匹配') && found.includes('.sku'))
	check('find 行含 tag/id/class 与视口矩形', found.includes('div#a.sku-plus.active') && found.includes('@300,410'))
	check('find 行含 href', found.includes('→ /x'))
	check('find 不是半截 JSON', !found.trim().startsWith('{'))

	// dialog：策略 + 最近记录（用来证明"确实弹过"）。
	const dlg = renderText('browser_dialog', {}, {
		policy: 'manual', changed: false,
		recent: [{ type: 'alert', message: '确定要删除吗', at: '12:00:01' }],
	})
	check('dialog 报出当前策略', dlg.includes('对话框策略 = manual'))
	check('dialog 列出历史记录', dlg.includes('确定要删除吗') && dlg.includes('[alert]'))
	check('dialog 无记录时明说没有', renderText('browser_dialog', {}, { policy: 'accept', changed: false, recent: [] }).includes('最近没有对话框记录'))

	// info：身份 + 协议对账（"行为不对先跑它"的那条）。
	const info = renderText('browser_info', {}, {
		client: 'dsh-browser-extension', extensionVersion: '1.0.20',
		browserName: 'edge', browserVersion: '155.0.0.0', userAgent: 'UA',
		bridgeProtocol: 1, extensionProtocol: 1, protocolCompatible: true, port: 9777, urlMode: 'public',
	})
	check('info 含扩展版本与浏览器名版本', info.includes('1.0.20') && info.includes('edge 155.0.0.0'))
	check('info 含协议对账行', info.includes('桥 v1 / 扩展 v1'))
	check('info 协议不匹配时把原因说出来', renderText('browser_info', {}, {
		client: 'c', extensionVersion: '9.9.9', browserName: 'b', browserVersion: '1', userAgent: 'u',
		bridgeProtocol: 1, extensionProtocol: 2, protocolCompatible: false, protocolNote: '扩展声明协议 v2',
	}).includes('扩展声明协议 v2'))

	// nav：没等到落地时要说清"还在加载哪个地址"。
	const nav = renderText('browser_navigate', { url: 'https://slow.example/x' }, {
		tabId: 3, url: 'https://old.example/', title: '旧页', loadPending: true, pendingUrl: 'https://slow.example/x',
	})
	check('nav 的"仍在加载"带上目标地址', nav.includes('https://slow.example/x') && nav.includes('仍在加载'))
	check('nav 不可达时不再说"now shows 目标URL"', renderText('browser_navigate', { url: 'https://dead.example/' }, {
		tabId: 3, url: 'https://dead.example/', siteUnreachable: true, error: 'DNS 解析失败',
	}).includes('target unreachable'))
}

console.log('\n[10] 2026-10-13 第二段：snapshot 的 ax 模式与"旧扩展静默忽略"的告警')
{
	// ax 模式的渲染：role 要出现（它才是这一模式的价值），且标明这是 a11y 树。
	const ax = renderText('browser_snapshot', { mode: 'ax' }, {
		tabId: 3, title: '登录页', url: 'https://example.com/login', mode: 'ax',
		items: [
			{ ref: 'e1', tag: 'input', role: 'textbox', name: '用户名', why: 'ax' },
			{ ref: 'e2', tag: 'button', role: 'button', name: '登录', why: 'ax' },
		],
	})
	check('ax 渲染出 role', ax.includes('[textbox]') && ax.includes('[button]'))
	check('ax 渲染标明这是 a11y 树', ax.includes('a11y 树'))
	check('ax 不再把 why=ax 当作"cursor 兜底"打印', !ax.includes('(ax)'))

	// 落回 dom 时，原因必须写进模型可见文本（不能静默）。
	const fell = renderText('browser_snapshot', { mode: 'ax' }, {
		tabId: 3, title: 't', url: 'u', mode: 'dom', axFallback: 'Accessibility.getFullAXTree 没有返回 nodes',
		items: [{ ref: 'e1', tag: 'a', name: 'x' }],
	})
	check('落回 dom 时写明原因', fell.includes('落回了 dom') && fell.includes('没有返回 nodes'))

	// 判定逻辑本身（纯函数）：真 ax / 有原因 / 旧扩展静默忽略 / 没请求。
	const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)
	check('扩展回 mode:ax ⇒ 判为 ax', mod.snapshotModeOf('ax', undefined, true).mode === 'ax')
	check('扩展回 axFallback ⇒ 连原因一起带出去',
		mod.snapshotModeOf('dom', 'boom', true).axFallback === 'boom')
	const ignored = mod.snapshotModeOf(undefined, undefined, true)
	check('旧扩展静默忽略 ⇒ 插件自己把降级说出来',
		ignored.mode === 'dom' && String(ignored.axFallback).includes('ignored mode:"ax"'), String(ignored.axFallback).slice(0, 60))
	check('没请求 ax ⇒ 不产生告警', mod.snapshotModeOf(undefined, undefined, false).axFallback === undefined)
}

console.log('\n[11] 2026-10-13 第三段：tabs 的归组/批量关闭/打开，都给人话')
{
	const closed = renderText('browser_tabs', { action: 'close' }, {
		closed: 2, closedIds: [11, 12], alreadyGone: [13], failedIds: [{ id: 14, error: 'boom' }],
	})
	check('批量关闭报"关掉的 / 本来就不在 / 失败"三类', closed.includes('已关闭 2 个') && closed.includes('本来就不在了：13') && closed.includes('失败：14'))

	const grouped = renderText('browser_tabs', { action: 'group' }, { tabId: 7, grouped: true, groupId: 42, created: true })
	check('归组成功说清 groupId 与新建/复用', grouped.includes('已归入 DSH 分组') && grouped.includes('groupId=42') && grouped.includes('新建'))

	const ungrouped = renderText('browser_tabs', { action: 'ungroup' }, { ungrouped: 5, groups: 2 })
	check('拆组说清"没关任何标签页"', ungrouped.includes('已解除 5 个标签') && ungrouped.includes('没有关闭任何标签页'))

	const opened = renderText('browser_tabs', { action: 'open', url: 'https://x/' }, {
		tabId: 9, url: 'https://x/', title: 'X', grouped: true,
	})
	check('打开标签说清落地地址与归组', opened.includes('已打开 tab 9') && opened.includes('https://x/') && opened.includes('已归入 DSH 分组'))

	const openedNoGroup = renderText('browser_tabs', { action: 'open', url: 'https://x/' }, {
		tabId: 9, url: 'https://x/', title: 'X', grouped: false, reason: 'group:false',
	})
	check('没归组时把原因说出来', openedNoGroup.includes('没归组') && openedNoGroup.includes('group:false'))
}

console.log('\n[12] 2026-10-17：tabs.list 要看得见分组（原来只能建组/解散，看不出谁在组里）')
{
	const grouped = renderText('browser_tabs', { action: 'list' }, {
		count: 3, windows: 1, activeTabId: 11,
		groups: [{ id: 42, title: 'DSH', color: 'blue', windowId: 1 }],
		tabs: [
			{ id: 11, url: 'https://a.example/', title: 'A', active: true, groupId: 42, groupTitle: 'DSH', groupColor: 'blue' },
			{ id: 12, url: 'https://b.example/', title: 'B', active: false, groupId: 42, groupTitle: 'DSH', groupColor: 'blue' },
			{ id: 13, url: 'https://c.example/', title: 'C', active: false },
		],
	})
	check('归组的标签行首带组名徽标', grouped.includes('[DSH] A') && grouped.includes('[DSH] B'))
	check('未归组的标签没有徽标', !grouped.includes('[DSH] C'))
	check('列表头有一行分组一览（含组内标签数）', /分组：DSH（2 个标签）/.test(grouped), grouped.split('\n')[0])

	const plain = renderText('browser_tabs', { action: 'list' }, {
		count: 1, windows: 1, activeTabId: 9, groups: [],
		tabs: [{ id: 9, url: 'https://x.example/', title: 'X', active: true }],
	})
	check('没有分组时不多出一行', !plain.includes('分组：'))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	for (const f of failed) console.log('  - ' + f.name)
	process.exit(1)
}
