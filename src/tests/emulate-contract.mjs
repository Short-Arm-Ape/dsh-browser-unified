#!/usr/bin/env node
/**
 * emulate-contract.mjs — browser_emulate 的**输出契约**回归（不需要浏览器、不需要重启）。
 *
 * 动机：扩展在"没有 UA 覆盖"时回的是**显式** `userAgent: null`
 * （`extension/background.js` 的 `userAgent: userAgent || null`），而宿主的输出校验器
 * 对 `null` **会下钻判类型**（只跳过 `undefined`）。插件把回包原样透传时，
 * `device:"desktop"` 和"只给宽高"的自定义视口**每次调用**都抛 `ToolOutputError` ——
 * 只有带真 UA 的预设（mobile/tablet）能过，所以这条从 v0.7 起一直静默地坏着。
 *
 * 做法：加载构建产物，取 `browser_emulate` 的 output 规格，用**宿主机自己的校验器**
 * （`@deepseek-ai/dsh-tools` 的 `valueSchemaSpecToJsonSchema` + `validateJsonSchemaValue`）
 * 跑两份值做对照：
 *   ① 真机回包原样      → 必须**不合格**（这是修复前的失败，也是这条测试的阳性对照）
 *   ② normalizeEmulateValue(真机回包) → 必须合格
 * 真机回包是从 rig（真 Edge + 真扩展 + 假桥）里录下来的，见文件末尾的 provenance。
 *
 * 复现：node tests/emulate-contract.mjs      # 需要先 npm run build
 */

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '..', 'packages', 'browser-unified-plugin')
const mod = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href)

const require = createRequire(path.join(pkg, 'package.json'))
let validateJsonSchemaValue
let valueSchemaSpecToJsonSchema
try {
	const host = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)
	;({ validateJsonSchemaValue, valueSchemaSpecToJsonSchema } = host)
} catch (error) {
	console.log(`跳过：本机解析不到 @deepseek-ai/dsh-tools（宿主校验器）—— ${error.code ?? error.message}`)
	console.log('这条测试的价值就在"用宿主自己的校验器"，拿不到它时不做替代性通过。')
	process.exit(0)
}

const results = []
function check(name, ok, detail) {
	results.push({ name, ok })
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/* 与 schema 默认值对齐的最小配置；enabled=false 保证不会真的去 bind 端口。 */
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
	inject() {},
	get() { return undefined },
	effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
	on() { return () => {} },
	provide() { return () => {} },
	systemPrompt: { context: () => () => {}, section: () => () => {}, tools: () => () => {} },
}
mod.apply(ctx, CONFIG)

const emulate = tools.get('browser_emulate')
if (emulate === undefined) {
	console.log('  ✗ browser_emulate 未注册')
	process.exit(1)
}

/* output.schema 可能是"规格"（属性里带 required: true）或已是原始 JSON Schema。 */
const spec = emulate.output.schema
const looksLikeSpec = spec !== undefined && spec.properties !== undefined
	&& Object.values(spec.properties).some((p) => p !== null && typeof p === 'object' && 'required' in p)
const jsonSchema = looksLikeSpec ? valueSchemaSpecToJsonSchema(spec) : spec
console.log(`\n[0] 取到 browser_emulate 的 output 规格（${looksLikeSpec ? '规格 → 已转 JSON Schema' : '已是 JSON Schema'}）`)
check('output 规格里声明了 userAgent: string', JSON.stringify(jsonSchema).includes('userAgent'))

/* 真机回包：rig（真 Edge 155 + 真扩展 1.0.91 + 假桥 9781）实测，2026-10-13。
   原始记录：__pr-d-rig/evidence-unified-UC1.json → emulate.desktop
   注意 `userAgent` 是**显式 null**（不是缺字段）—— 这是整条 bug 的前提。 */
const REAL_DESKTOP = {
	tabId: 794592662,
	width: 1280,
	height: 800,
	deviceScaleFactor: 1,
	isMobile: false,
	hasTouch: false,
	userAgent: null,
}

console.log('\n[1] 阳性对照：真机回包**原样透传**必须不合格（这就是修复前的 ToolOutputError）')
const rawViolations = validateJsonSchemaValue(jsonSchema, REAL_DESKTOP, 'value')
check('原样透传被判不合格', rawViolations.length > 0, rawViolations.join('; '))
check('不合格的原因正是 userAgent: null', rawViolations.some((v) => v.includes('userAgent')), rawViolations.join('; '))

console.log('\n[2] 归一化后必须合格，且不夹带 null')
const normalized = mod.normalizeEmulateValue(REAL_DESKTOP)
const normViolations = validateJsonSchemaValue(jsonSchema, normalized, 'value')
check('归一化后合格', normViolations.length === 0, normViolations.join('; ') || '无违规')
check('userAgent 不再是 null', normalized.userAgent === undefined, `实际 ${JSON.stringify(normalized.userAgent)}`)
check('其余字段一个不少（1280×800 / DPR 1 / mobile false / touch false）',
	normalized.width === 1280 && normalized.height === 800 && normalized.deviceScaleFactor === 1
	&& normalized.isMobile === false && normalized.hasTouch === false, JSON.stringify(normalized))
check('没有多出 schema 不认识的键',
	Object.keys(normalized).every((k) => k in jsonSchema.properties), Object.keys(normalized).join(','))

console.log('\n[3] 带真 UA 的预设：好数据不能被归一化丢掉')
const REAL_MOBILE = { tabId: 7, reset: false, width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
const mobile = mod.normalizeEmulateValue(REAL_MOBILE)
check('userAgent 原样保留', mobile.userAgent === REAL_MOBILE.userAgent)
check('归一化后合格', validateJsonSchemaValue(jsonSchema, mobile, 'value').length === 0)

console.log('\n[4] reset 回包：null 字段一律不落进结果，reset 标记要留下')
const reset = mod.normalizeEmulateValue({ tabId: 7, reset: true, width: null, height: null, deviceScaleFactor: null, isMobile: null, hasTouch: null, userAgent: null })
check('reset: true 保留', reset.reset === true)
check('其余 null 字段全部消失', Object.keys(reset).join(',') === 'tabId,reset', Object.keys(reset).join(','))
check('归一化后合格', validateJsonSchemaValue(jsonSchema, reset, 'value').length === 0)

const failed = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
