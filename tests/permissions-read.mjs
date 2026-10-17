#!/usr/bin/env node
/**
 * permissions-read.mjs — 「读弹窗」只读探针的回归测试（不需要浏览器、不需要重启）。
 *
 * 动机：这一版把"有没有权限气泡在等我"变成模型可读的事实。判据全是"数值 + 模式匹配"，
 * 最容易出的两类错都是**静默**的：
 *   1. 假阴性 —— origin pattern 匹配不上（Preferences 键是 `https://host:443,*`，带默认端口与次 pattern），
 *      于是报告"没有记录"，模型就会继续把"有人在等人点"误诊成"页面卡了"；
 *   2. 把「询问」说成「允许」—— 分组写错就会让模型以为可以继续跑。
 * 所以钉住：分组、pattern 形态、`*` 兜底、错误指引、以及结论措辞（谁能点）。
 *
 * 复现：npm run build && node tests/permissions-read.mjs   （夹具在 tmp 目录里造，不碰真实 profile）
 */

import path from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..', 'packages', 'browser-unified-plugin')
const permissions = await import(pathToFileURL(path.join(pkg, 'lib', 'permissions.js')).href)
const index = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 夹具：键形态照抄本机真实 Profile（`<主pattern>,<次pattern>`，默认端口显式写出）。 */
const FIXTURE = {
	profile: {
		content_settings: {
			exceptions: {
				loopback_network: { 'https://ti.qianxin.com:443,*': { setting: 1, last_modified: '13435135275374948' } },
				notifications: { 'https://ti.qianxin.com:443,*': { setting: 3 } },
				automatic_downloads: { 'https://ti.qianxin.com:443,*': { setting: '1' } },
				geolocation: { '*': { setting: 2 } },
				camera: { 'https://x.example:443,*': { nope: 1 } }, // 无 setting ⇒ 必须被跳过
			},
		},
	},
}

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-perm-'))
writeFileSync(path.join(dir, 'Preferences'), JSON.stringify(FIXTURE))

// ---- 读取与解析 ---------------------------------------------------------------
const store = permissions.readPermissionStore(dir)
check('classNames 含真实存在的类且已排序',
	store.classNames.includes('camera') && store.classNames.includes('loopback_network')
	&& JSON.stringify(store.classNames) === JSON.stringify([...store.classNames].sort()))
check('缺 setting 的条目被跳过（camera 不进 exceptions）', !store.exceptions.has('camera'))
check('setting 兼容字符串形式（automatic_downloads="1"）',
	store.exceptions.get('automatic_downloads')?.get('https://ti.qianxin.com:443,*')?.setting === 1)

// ---- origin 匹配 --------------------------------------------------------------
const hit = permissions.readOriginPermissions(store, 'https://ti.qianxin.com/vulnerability/list?keyword=DeepSeek%20Harness')
const byPref = new Map(hit.readings.map(r => [r.pref, r]))
check('带默认端口的 pattern 能匹配上（否则就是假阴性）',
	byPref.get('loopback_network')?.exception?.setting === 1,
	`got ${JSON.stringify(byPref.get('loopback_network')?.exception)}`)
check('询问(3) 的措辞是"会弹窗"',
	byPref.get('notifications')?.exception?.label.includes('询问')
	&& byPref.get('notifications')?.exception?.label.includes('弹窗'))
check('curated 之外的类不出现（camera 不在受关注清单）', byPref.get('camera') === undefined)
check('origin 归一化去掉路径与查询', hit.origin === 'https://ti.qianxin.com')

const other = permissions.readOriginPermissions(store, 'https://example.com/')
const otherByPref = new Map(other.readings.map(r => [r.pref, r]))
check('裸 `*` 兜底对本机以外的 origin 也生效', otherByPref.get('geolocation')?.exception?.setting === 2)
check('无记录的类如实留空（不编造）',
	otherByPref.get('notifications')?.exception === undefined
	&& otherByPref.get('geolocation')?.exception !== undefined)

// ---- 时间戳 -------------------------------------------------------------------
// 这个函数是**给人看的本机时间**（`toLocaleString('sv-SE')`），所以断言只能钉「瞬间」，
// 不能写死某个时区的人眼时间。第一版就把 `2026-09-29 14:01:15`（作者在东八区）写进了断言，
// 于是在 CI（UTC runner）上算出 `06:01:15` 直接翻红 —— 换台机器跑就红的断言不是断言。
const CHROMIUM_STAMP = '13435135275374948'
const EXPECTED_MS = Date.UTC(2026, 8, 29, 6, 1, 15) // 2026-09-29T06:01:15Z，即东八区的 14:01:15
const stampText = permissions.chromiumTime(CHROMIUM_STAMP)
check('Chromium 时间戳换算到正确瞬间（与时区无关）',
	// 返回值就是本机时区的墙上时间，按本机时区解析回来才可比
	new Date(stampText.replace(' ', 'T')).getTime() === EXPECTED_MS,
	`${stampText}（本机时区） 期望瞬间 ${new Date(EXPECTED_MS).toISOString()}`)
check('Chromium 时间戳按 YYYY-MM-DD HH:MM:SS 显示给人看',
	/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stampText), stampText)

// ---- 配置错法：可行动指引（bi-013 之后，指引在**容错读取器**里，且不再冤枉配置） --------
let threw = ''
try { permissions.readPermissionStore(path.join(dir, 'nope')) } catch (e) { threw = e.message }
check('裸读取器只陈述事实（不指控"配置写错了"）',
	threw.includes('没有 Preferences 文件') && !threw.includes('要指向 **profile 目录**'), threw)
let tolerant = ''
try { permissions.readPermissionStoreTolerant([path.join(dir, 'nope')]) } catch (e) { tolerant = e.message }
check('容错读取器给出可行动指引（列试过哪些 + 两种真实原因）',
	tolerant.includes('试过：') && tolerant.includes('User Data') && tolerant.includes('从未启动过'),
	tolerant.split('\n')[0])

// ---- 结论文本 -----------------------------------------------------------------
// 这一次的现场（本机真实形态）里 LNA 是**已允许**：结论必须走"排除权限因素"那一支。
const t1 = index.permissionReport({
	origin: hit.origin, tabId: 875806480, store, readings: hit.readings,
	pendingLocal: [{ url: 'http://127.0.0.1:8791/ingest', ageSeconds: 24 }],
	requestedClass: undefined,
})
check('已允许 + 挂起本机请求 ⇒ 排除权限因素，别误诊', t1.includes('已允许') && t1.includes('不要当成权限问题'))
check('结论里给出挂起证据（URL + 已等秒数）', t1.includes('127.0.0.1:8791') && t1.includes('已等 24s'))
check('明确只读、不代答', t1.includes('只读') && t1.includes('也不会未经你配置就代答'))

/** 气泡真的在等人的现场：该类=询问(3) + 有挂起的本机请求。 */
const askDir = mkdtempSync(path.join(tmpdir(), 'dsh-perm-ask-'))
writeFileSync(path.join(askDir, 'Preferences'), JSON.stringify({
	profile: { content_settings: { exceptions: { loopback_network: { 'https://b.example:443,*': { setting: 3 } } } } },
}))
const askStore = permissions.readPermissionStore(askDir)
const askReadings = permissions.readOriginPermissions(askStore, 'https://b.example/page').readings
const tAsk = index.permissionReport({
	origin: 'https://b.example', tabId: undefined, store: askStore, readings: askReadings,
	pendingLocal: [{ url: 'http://127.0.0.1:8791/ingest', ageSeconds: 9 }], requestedClass: undefined,
})
check('询问 + 挂起本机请求 ⇒ 指向"气泡在等人"',
	tAsk.includes('大概率正等') && tAsk.includes('需要用户在浏览器窗口里点'),
	tAsk.split('\n').slice(-4).join(' / '))

const allowStore = permissions.readPermissionStore(
	(() => {
		const d2 = mkdtempSync(path.join(tmpdir(), 'dsh-perm2-'))
		writeFileSync(path.join(d2, 'Preferences'), JSON.stringify({
			profile: { content_settings: { exceptions: { loopback_network: { 'https://a.example:443,*': { setting: 1 } } } } },
		}))
		return d2
	})(),
)
const readings2 = permissions.readOriginPermissions(allowStore, 'https://a.example/x').readings
const t2 = index.permissionReport({
	origin: 'https://a.example', tabId: undefined, store: allowStore, readings: readings2,
	pendingLocal: [{ url: 'http://127.0.0.1:8791/ingest' }], requestedClass: undefined,
})
check('已允许但仍挂起 ⇒ 明确排除权限因素（别误诊）',
	t2.includes('已允许') && t2.includes('不要当成权限问题'))

const t3 = index.permissionReport({
	origin: hit.origin, tabId: undefined, store, readings: hit.readings, pendingLocal: [], requestedClass: undefined,
})
check('无挂起但存在询问类 ⇒ 事前提醒"一触发就弹窗"', t3.includes('一旦被页面触发就会弹窗'))

const t4 = index.permissionReport({
	origin: hit.origin, tabId: undefined, store, readings: [], pendingLocal: [], requestedClass: 'not_a_real_class',
})
check('点名不存在的类 ⇒ 摊出本机真实类名（不猜枚举）',
	t4.includes('没有 not_a_real_class 这个类') && t4.includes('loopback_network'))

// 真机读数暴露过的措辞假阴性：本机默认值表是空的，"没有显式记录"≠"不会弹窗"。
const noneReadings = permissions.readOriginPermissions(askStore, 'https://never-seen.example/x').readings
const tNone = index.permissionReport({
	origin: 'https://never-seen.example', tabId: undefined, store: askStore, readings: noneReadings,
	pendingLocal: [], requestedClass: undefined,
})
check('全部无记录时不许说成"没有询问项"',
	tNone.includes('没有**显式**的"询问"记录') && tNone.includes('别把"没记录"当成"不会弹"'),
	tNone.split('\n').slice(-2).join(' / '))

// ---- 真实注册：apply() 必须真的把这个工具挂上 ----------------------------------
{
	const CONFIG = {
		enabled: false, port: 9777, token: 'dsh-local', shotsDir: 'dsh-browser-shots', urlMode: 'public',
		blockMetadata: true, metadataHostnames: [], metadataIps: [], internetAccess: undefined, lanAccess: undefined,
		localAccess: undefined, internetTemp: true, lanTemp: true, localTemp: true, askMode: 'inherit',
		dshAccessEnabled: false, dshOrigins: [], allowHosts: [], denyHosts: [], registryDir: '',
		autoLaunchEnabled: false, autoLaunchIdleSeconds: 15, autoLaunchBrowserExe: '',
		autoLaunchProfileDir: path.join(dir), autoLaunchProfileName: '', autoLaunchTempProfile: false,
		autoLaunchExtensionDir: '',
	}
	const tools = new Map()
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools: { register: (definition) => { tools.set(definition.name, definition) } },
		inject() { /* 不提供 settings：current 退回组合配置 */ },
		get() { return undefined },
		effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
		on() { return () => {} },
		provide() { return () => {} },
		systemPrompt: { context: () => () => {}, section: () => () => {}, tools: () => () => {} },
	}
	index.apply(ctx, CONFIG)
	const definition = tools.get('browser_permissions')
	check('apply() 后 browser_permissions 出现在工具面里', definition !== undefined)
	check('描述里点明"只读"（不许让模型以为它会代答）',
		String(definition?.description ?? '').includes('只读'))
	check('render 打的是完整载荷 text（不是只回计数 —— bi-001 的教训）',
		definition?.output?.render(undefined, { text: 'PAYLOAD-XYZ' })?.[0]?.text === 'PAYLOAD-XYZ')
}

// ---- 汇总 ---------------------------------------------------------------------
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
	console.log('失败项：')
	for (const f of failed) console.log(`  - ${f.name}`)
	process.exitCode = 1
}
