/**
 * Browser-bridge plugin: one local WebSocket endpoint the DSH Browser Control
 * extension connects to, plus the model-facing `browser_*` tools that drive
 * The Settings-managed `enabled` flag starts and stops the listener live —
 * no reload needed beyond the config recomposition 0.2.0 performs on a write.
 *
 * Since DSH 0.2.0 the Host is the single source of truth for settings: the
 * user layer is folded into this plugin's loader-entry config, so `apply(ctx,
 * config)` already receives the effective values and no `settings.register`
 * call is involved. Fields must be declared `.volatile()` in `Config` or the
 * namespace is skipped by `describe()` and never reaches the Settings UI.
 *
 * Tools stay mounted whenever the plugin does; calling one while the bridge
 * is disabled or the extension is offline fails with a message naming the
 * fix, so the model can tell the user what to do instead of hanging.
 * @module @deepseek-ai/dsh-browser-bridge
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool as rawDefineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-invariants'
import { BridgeError, BridgeServer, classify, cleanupArtifacts, GuardedBridge, UrlPolicy } from 'browser-unified-core'
import { DEFAULT_METADATA_HOSTNAMES, DEFAULT_METADATA_IPS, type RealmAccess, realmOf, type UrlPolicyMode } from 'browser-unified-core'
import { applyUnifiedTools, currentPluginVersion, loadIssues } from './unified-tools.js'
// 原 dsh-browser-buddy 的能力（de-036 合并）：工具面分层 / 状态注入 / 调用即唤醒 / 登记簿送达
// + browser_tools / browser_frames / browser_frame_eval。
import { applyBuddyFeatures } from './buddy.js'
import { CONTENT_SETTING, chromiumTime, readOriginPermissions, readPermissionStore, readPermissionStoreTolerant, type PermissionReading } from './permissions.js'
import {
	brandIdFromHelloName,
	exeCandidates,
	hostStyle,
	locateExtensionProfile,
	profileDisplayName,
	profileHasExtension,
	splitProfilePath,
	toLinuxPath,
} from './browser-profiles.js'

// Schema shapes below are the same ones the upstream plugin shipped and the
// dsh-tools assert layer validates at runtime; the loose wrapper only widens
// the compile-time view (types differ between rc builds).
const defineTool = (options: unknown) => rawDefineTool(options as never)

/** Wire-payload values from the extension are opaque JSON. */
type JsonValue = unknown

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-bridge'

/** The tool registry this plugin contributes `browser_*` tools to. */
export const inject = ['tools', 'systemPrompt']

/** Settings namespace carrying the bridge switch and endpoint options. */
export const BROWSER_BRIDGE_SETTINGS_NAMESPACE = 'browser-bridge'

export interface Config {
	/**
	 * Whether the local bridge listens. Defaults to true so the plugin is
	 * usable immediately after install; set false to keep the tools mounted but
	 * every call reports how to enable the bridge, so the opt-out stays explicit.
	 */
	enabled?: boolean
	/** Loopback port the extension dials; the HTTP face shares it. */
	port?: number
	/** Shared secret the extension presents on the WebSocket upgrade query. */
	token?: string
	/**
	 * Directory screenshots are written to and `cleanup` clears. Relative paths
	 * resolve against the process working directory at resolve time.
	 */	shotsDir?: string
	/**
	 * URL policy mode applied to navigation commands. `public` (default): blocks
	 * private/loopback/metadata targets before they reach the extension.
	 * `intranet`: allows local/LAN targets while still blocking cloud-metadata
	 * endpoints. Lives on the bridge instance config (registry via Settings).
	 */
	urlMode?: string
	/**
	 * Master switch for cloud-metadata endpoint blocking (both modes). Default
	 * true. Turn off only when you deliberately accept access to
	 * instance-metadata services (e.g. inside your own VPC sandbox).
	 */
	blockMetadata?: boolean
	/**
	 * Cloud-metadata HOSTNAMES to always block (both modes). This list FULLY
	 * replaces the built-in defaults — the defaults are only the initial value
	 * shown in Settings. `[]` blocks none of this family. Entries are matched
	 * after hostname normalization (lowercase, trailing dot/brackets stripped).
	 */
	metadataHostnames?: string[]
	/**
	 * Cloud-metadata IP literals to always block (both modes). Same
	 * replace-or-default contract as `metadataHostnames`.
	 */
	metadataIps?: string[]
	/**
	 * Per-realm access policies. Realms: 外网 `internet` / 局域网 `lan` /
	 * 本机 `local` (loopback). Each may be `allow` (default), `ask` (approval
	 * required unless allowlisted / session-granted) or `deny`.
	 */
	internetAccess?: string
	lanAccess?: string
	localAccess?: string
	/** Whether ask-mode approvals may grant temporary hosts this session, per realm. Default true. */
	internetTemp?: boolean
	lanTemp?: boolean
	localTemp?: boolean
	/**
	 * Behavior for a realm in `ask` mode when the target host is not on the
	 * allow list. `prompt` (default) shows the host approval (under an
	 * approval policy of never the request is auto-rejected and the model gets
	 * NEED_AUTHORIZATION guidance); `allow` grants the host for this session
	 * without prompting —— **注意它连用户名单一起忽略**（allowHosts/denyHosts
	 * 都不再拦，de-016/de-018 的"放行"档语义）；`deny` refuses without asking。
	 * 三种档位都不影响**硬红线**（云元数据、内嵌凭据、DSH 控制页关闭时的拦截、路由档），
	 * 红线在分域判定之前就已生效。
	 */
	askMode?: string
	/**
	 * DSH-page special rule: when enabled, origins in `dshOrigins` (the harness
	 * control page, e.g. http://127.0.0.1:3080) are reachable even under the
	 * `public` routing stance and skip the realm ask/deny layer. Enabling is
	 * double-confirmed in the GUI: the model could otherwise drive its own
	 * approval prompts from that page. Under a host approval policy of `never`,
	 * this is the only way to grant such access (approvals cannot be asked).
	 */
	dshAccessEnabled?: boolean
	dshOrigins?: string[]
	/**
	 * Hosts that never need per-host approval in `ask` realms. Exact hostnames/IPs
	 * or `*.suffix` wildcards (matches any subdomain).
	 */
	allowHosts?: string[]
	/**
	 * Hosts the user wants denied —— **用户名单（L3），不是红线**。Exact hostnames/IPs 或
	 * `*.suffix` 通配。在 deny/allow 分域、以及 `ask` 分域都生效，**唯一例外**是
	 * `askMode === 'allow'`（受限态"放行"档 = 连黑白名单一起忽略，de-016/de-018）。
	 * 硬红线（云元数据、内嵌凭据、DSH 控制页关闭时的拦截、路由档）**不受本列表与 askMode 影响**。
	 * （旧注释曾写"always denied — regardless of …"，与实现不符，已按实现订正。）
	 */
	denyHosts?: string[]
	/**
	 * Absolute directory containing `design/registry.json` and
	 * `upstream-baseline.json` for the self-update tools. Empty (default) means
	 * the copies bundled under the package `registry/` directory.
	 */
	registryDir?: string
	/** de-013: auto-launch a browser when the extension has been disconnected too long. Default false. */
	autoLaunchEnabled?: boolean
	/** Seconds the extension may stay disconnected before an auto-launch attempt. Default 15. */
	autoLaunchIdleSeconds?: number
	/** Browser executable to launch (e.g. msedge.exe full path). Omit to search PATH for msedge/chrome. */
	autoLaunchBrowserExe?: string
	/** Existing dedicated profile dir for the extension (recommended). Empty = default profile of the executable. */
	autoLaunchProfileDir?: string
	/** Edge/Chrome 配置文件名称（如 'Profile 4'/'Default'）。留空=自动识别目录名或 Default。 */
	autoLaunchProfileName?: string
	/** Use a fresh temporary profile (like an incognito/clean instance) instead of a profile dir. */
	autoLaunchTempProfile?: boolean
	/** When using a temporary profile: path to an UNPACKED extension dir to sideload (`--load-extension`). */
	autoLaunchExtensionDir?: string
	// ── 以下 4 项原来属于同伴件 dsh-browser-buddy（2026-10-10 合并进来，de-036）──
	/** 工具面分层：只把常驻白名单 + 已展开组的 `browser_*` 交给模型（关掉=全部暴露）。默认 true。 */
	layeredTools?: boolean
	/** 模型调用 `browser_*` 而扩展未连接时，先自动拉起浏览器再放行。默认 false（避免你没预期时弹窗口）。 */
	autoLaunchOnToolUse?: boolean
	/** 自动拉起后等扩展连上的上限（毫秒）。默认 8000。 */
	autoLaunchWaitMs?: number
	/** 启动时就展开的工具组（interact/debug/session/frames/registry）。默认 []。 */
	enabledGroups?: string[]
}

// 注：`.volatile()` 让 schemastery 的推断类型带上 `Volatile<>` 包装，与下面导出的
// `interface Config`（普通字段类型）在 TS 层面不兼容；运行时值不受影响，故断言。
export const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	port: z.number().step(1).min(1024).max(65_535).default(9777).volatile(),
	token: z.string().default('dsh-local').volatile(),
	shotsDir: z.string().default('dsh-browser-shots').volatile(),
	urlMode: z.string().default('public').volatile(),
	blockMetadata: z.boolean().default(true).volatile(),
	metadataHostnames: z.array(z.string()).default([...DEFAULT_METADATA_HOSTNAMES]).volatile(),
	metadataIps: z.array(z.string()).default([...DEFAULT_METADATA_IPS]).volatile(),
	internetAccess: z.string().volatile(),
	lanAccess: z.string().volatile(),
	localAccess: z.string().volatile(),
	internetTemp: z.boolean().default(true).volatile(),
	lanTemp: z.boolean().default(true).volatile(),
	localTemp: z.boolean().default(true).volatile(),
	askMode: z.string().default('inherit').volatile(),
	dshAccessEnabled: z.boolean().default(false).volatile(),
	/** 只读档：开启后模型只能读页面、不能操作（点击/输入/导航/求值一律拒）。 */
	readOnly: z.boolean().default(false).volatile(),
	/** 允许模型在这台浏览器里执行任意脚本（eval / 帧内 eval / content.debug）—— 等价于给模型一个 devtools 控制台。 */
	allowScript: z.boolean().default(true).volatile(),
	dshOrigins: z.array(z.string()).default([]).volatile(),
	allowHosts: z.array(z.string()).default([]).volatile(),
	denyHosts: z.array(z.string()).default([]).volatile(),
	registryDir: z.string().default('').volatile(),
	autoLaunchEnabled: z.boolean().default(false).volatile(),
	autoLaunchIdleSeconds: z.number().step(1).min(3).max(3600).default(15).volatile(),
	autoLaunchBrowserExe: z.string().default('').volatile(),
	autoLaunchProfileDir: z.string().default('').volatile(),
	autoLaunchProfileName: z.string().default('').volatile(),
	autoLaunchTempProfile: z.boolean().default(false).volatile(),
	autoLaunchExtensionDir: z.string().default('').volatile(),
	// 同伴件合并进来的旋钮（de-036）
	layeredTools: z.boolean().default(true).volatile(),
	autoLaunchOnToolUse: z.boolean().default(false).volatile(),
	autoLaunchWaitMs: z.number().step(1).min(0).max(60_000).default(8_000).volatile(),
	enabledGroups: z.array(z.string()).default([]).volatile(),
}) as unknown as z<Config>

interface ResolvedConfig {
	enabled: boolean
	/** 只读档：模型只能读页面，不能操作。 */
	readOnly: boolean
	/** 允许模型执行任意脚本（devtools 级能力）。 */
	allowScript: boolean
	port: number
	token: string
	shotsDir: string
	urlMode: UrlPolicyMode
	blockMetadata: boolean
	metadataHostnames: string[]
	metadataIps: string[]
	internetAccess: string | undefined
	lanAccess: string | undefined
	localAccess: string | undefined
	internetTemp: boolean
	lanTemp: boolean
	localTemp: boolean
	askMode: string
	dshAccessEnabled: boolean
	dshOrigins: string[]
	allowHosts: string[]
	denyHosts: string[]
	registryDir: string
	autoLaunchEnabled: boolean
	autoLaunchIdleSeconds: number
	autoLaunchBrowserExe: string
	autoLaunchProfileDir: string
	autoLaunchProfileName: string
	autoLaunchTempProfile: boolean
	autoLaunchExtensionDir: string
	layeredTools: boolean
	autoLaunchOnToolUse: boolean
	autoLaunchWaitMs: number
	enabledGroups: string[]
}

/**
 * Validate a dsh-origin entry: `http(s)://host[:port]` or `host:*` (any port).
 */
function assertOriginList(list: string[] | undefined): void {
	if (!Array.isArray(list)) return
	if (list.length > 16) throw new Error('browser-bridge: dshOrigins 最多 16 条')
	const ok = (raw: string): boolean => {
		const value = raw.trim().toLowerCase()
		if (value.length === 0 || value.length > 200 || /\s/.test(value)) return false
		if (/^https?:\/\/[a-z0-9.\-\[\]:]+$/.test(value)) return true
		if (/^[a-z0-9.\-\[\]]+:\*$/.test(value)) return true
		return false
	}
	for (const raw of list) {
		if (typeof raw !== 'string' || !ok(raw)) {
			throw new Error(`browser-bridge: dshOrigins 包含非法条目 "${String(raw)}"（格式: http(s)://host[:port] 或 host:*）`)
		}
	}
}

const MAX_METADATA_ENTRIES = 64
const MAX_HOST_ENTRIES = 128

/**
 * Validate a host-list (allow/deny/metadata). Entries must survive hostname
 * normalization (optionally as a `*.suffix` wildcard) and contain no URL
 * syntax / whitespace / control characters.
 */
function assertHostList(kind: string, list: string[] | undefined): void {
	const bad = (entry: string): never => {
		throw new Error(`browser-bridge: ${kind} 包含非法条目 "${entry}"（仅允许主机名/IP 或 *.suffix，去掉协议、路径与空白）`)
	}
	if (!Array.isArray(list)) return
	if (list.length > MAX_HOST_ENTRIES) {
		throw new Error(`browser-bridge: ${kind} 最多 ${MAX_HOST_ENTRIES} 条`)
	}
	for (const raw of list) {
		if (typeof raw !== 'string') bad(String(raw))
		const entry = raw.trim()
		if (entry.length === 0) bad(raw)
		if (entry.length > 253) bad(raw)
		if (/[\s/\\@?#\u0000-\u001f\u007f]/.test(entry)) bad(raw)
	}
}

/**
 * Validate the metadata endpoint configuration. Both lists are fully
 * user-maintained (the built-ins are only their initial value); entries must
 * survive hostname normalization and contain no URL syntax.
 */
function assertMetadataLists(config: { metadataHostnames?: string[]; metadataIps?: string[] }): void {
	assertHostList('metadataHostnames', config.metadataHostnames)
	assertHostList('metadataIps', config.metadataIps)
}

/**
 * 「本 DSH 控制页」的本机地址：由宿主从 `webServer.port` 推导，**不再要求用户登记一个会过期的
 * 写死 origin**（GUI 端口可以变，也可能是 OS 随机分配的端口 0 → 实际监听端口）。
 * 用户自己登记的列表仍然生效，用于额外地址（局域网 IP / 自定义域名 / 反向代理等）。
 */
function mergeDshOrigins(config: ResolvedConfig, controlOrigins: readonly string[]): string[] {
	const merged = [...(config.dshOrigins ?? [])]
	for (const origin of controlOrigins) {
		if (!merged.includes(origin)) merged.push(origin)
	}
	return merged
}

function policyOptionsFor(config: ResolvedConfig, controlOrigins: readonly string[] = []): ConstructorParameters<typeof UrlPolicy>[0] {
	return {
		mode: config.urlMode,
		blockMetadata: config.blockMetadata,
		metadataHostnames: config.metadataHostnames ?? [...DEFAULT_METADATA_HOSTNAMES],
		metadataIps: config.metadataIps ?? [...DEFAULT_METADATA_IPS],
		internetAccess: config.internetAccess as RealmAccess,
		lanAccess: config.lanAccess as RealmAccess,
		localAccess: config.localAccess as RealmAccess,
		internetTemp: config.internetTemp ?? true,
		lanTemp: config.lanTemp ?? true,
		localTemp: config.localTemp ?? true,
		dshAccessEnabled: config.dshAccessEnabled ?? false,
		dshOrigins: mergeDshOrigins(config, controlOrigins),
		allowHosts: config.allowHosts ?? [],
		// de-016/de-018: 受限态「放行」档 = 忽略黑名单（红线/元数据/DSH 等仍先行）。
		// 策略实例按当前 askMode 静态构建；红线不经此列表，因此仍生效。
		denyHosts: config.askMode === 'allow' ? [] : config.denyHosts ?? [],
	}
	// 注：合并进来的 4 个旋钮（layeredTools / autoLaunchOnToolUse / autoLaunchWaitMs /
	// enabledGroups）**不进** UrlPolicyOptions —— 它们由 schema 的默认值与 resolved 配置直接带给
	// applyBuddyFeatures。
}

/**
 * One text content block, with a ceiling that **says so** instead of silently dropping data.
 *
 * 为什么要有它：这批工具曾把有用数据留在结构化 `value` 里，`render` 只回一行摘要
 * （`browser_snapshot` → "N interactive elements"、`browser_console_log`／`browser_network_log`
 * → "N of M …"），或者把 JSON 硬切到 300/400 字符（`browser_evaluate`／`browser_tabs`）。
 * 模型只看得到 render 的文本，于是这些工具在模型侧等于废掉 —— `browser_snapshot` 连 ref 都拿不到，
 * 而 ref 正是它存在的理由（本机实测撞到过）。
 */
function textBlock(text: string, max = 20_000): { type: 'text'; text: string }[] {
	const value = String(text ?? '')
	if (value.length <= max) return [{ type: 'text', text: value }]
	return [{ type: 'text', text: `${value.slice(0, max)}\n…（已截断：全文 ${value.length} 字符；分段取可用 browser_evaluate，过滤可用 urlPattern/status）` }]
}

const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/
/**
 * 单次 `browser_read` 能塞进上下文的窗口（上游 v1.0.12 的口径）。
 *
 * 以前是"一次最多 120 000 字符 + 截断标记"——长页面一次就把上下文吃掉一大块，模型还没法接着读。
 * 现在按窗口取：默认/上限都是这个数，头部直接给出 `chars a-b of N; call again with offset=b`。
 */
const READ_WINDOW_MAX_CHARS = 20_000

/**
 * 把 `selector` / `text` / `fn` 三种写法收敛成扩展 `wait` 命令的参数 + 一句人话标签。
 *
 * 三者是**互斥**的（共用同一个 `wait` 命令），同时给了就按 selector > text > fn 取第一个，
 * 并把选择写进标签里 —— 免得"我传了但等的是另一个条件"这种静默歧义。
 */
function describeWaitCondition(args: {
	selector?: unknown
	text?: unknown
	fn?: unknown
	waitSelector?: unknown
	waitText?: unknown
	waitFn?: unknown
}): { params: Record<string, unknown>; label: string } | undefined {
	const selector = args.selector ?? args.waitSelector
	const text = args.text ?? args.waitText
	const fn = args.fn ?? args.waitFn
	if (typeof selector === 'string' && selector.length > 0) return { params: { selector }, label: `选择器出现 ${selector}` }
	if (typeof text === 'string' && text.length > 0) return { params: { text }, label: `正文包含「${text}」` }
	if (typeof fn === 'string' && fn.length > 0) return { params: { fn }, label: `谓词为真 ${fn}` }
	return undefined
}

/**
 * 把 `urlPattern` 编译成匹配器：`/re/flags` 形式按正则，其余按**子串**（默认大小写不敏感）。
 * 正则写坏时不抛（退回子串匹配）—— 批量关页签是收拾动作，不该因为一个 pattern 写错整批失败。
 */
function compileUrlPattern(pattern: string): (url: string) => boolean {
	const asRegex = /^\/(.*)\/([a-z]*)$/.exec(pattern)
	if (asRegex !== null) {
		try {
			const flags = asRegex[2]!.includes('i') ? asRegex[2]! : `${asRegex[2]!}i`
			const re = new RegExp(asRegex[1]!, flags)
			return (url) => re.test(url)
		} catch { /* 非法正则 → 按子串匹配 */ }
	}
	const needle = pattern.toLowerCase()
	return (url) => url.toLowerCase().includes(needle)
}
/**
 * HTTP 命令面里"带 URL、会改变浏览器去向"的命令（与 core 的 `URL_COMMANDS` 对齐）。
 */
const HTTP_URL_COMMANDS: ReadonlySet<string> = new Set(['nav', 'tabs.open'])
/**
 * HTTP 命令面里"作用于页面内容"的命令：对**已开标签页**跑同一套红线判据
 * （云元数据 / DSH 控制页 / deny 名单 / 分域拒绝），与工具层的 `authorizeExistingTab` 一致。
 */
const HTTP_PAGE_COMMANDS: ReadonlySet<string> = new Set([
	'eval', 'content', 'content.debug', 'find', 'frames', 'click', 'input', 'press', 'scroll',
	'snapshot', 'screenshot', 'pdf', 'emulate',
])

/** 端口被占时向后尝试的候选端口个数（配置端口 → +1 … +N）。 */
const PORT_FALLBACK_COUNT = 9
/**
 * 扩展端默认扫描的端口窗口（`background.js` 的 `PORT_SCAN_BASE/COUNT`）。
 * 这里只用来**如实描述**回退后的可发现性：窗口外扩展扫不到，得在扩展高级里手填端口。
 * （两处常量没法自动同步 —— 改扩展的窗口就要改这里，反之亦然。）
 */
const EXTENSION_PORT_SCAN_BASE = 9777
const EXTENSION_PORT_SCAN_COUNT = 10

/** 回退到 `port` 之后，扩展能否自己发现它。 */
function extensionCanDiscoverPort(port: number): boolean {
	return port >= EXTENSION_PORT_SCAN_BASE && port < EXTENSION_PORT_SCAN_BASE + EXTENSION_PORT_SCAN_COUNT
}

/**
 * Owns zero or one live {@link BridgeServer} and restarts it whenever the
 * resolved settings change. Reconciles serialize through a promise chain so a
 * burst of settings commits cannot interleave stop/start pairs.
 */
/** 拉起目标来源的中文说法（给人看的；诊断"这次为什么落在这个 profile"时很重要）。 */
function launchSourceZh(source: LaunchTarget['source']): string {
	switch (source) {
		case 'config': return '设置里显式填的 profile'
		case 'hello': return '扩展自报的 id 反查磁盘'
		case 'hint': return '配置的扩展目录比对磁盘'
		case 'record': return '上次配对记录'
		default: return String(source)
	}
}

/**
 * 「这台机器上浏览器在哪」——**学到的状态，不是配置**。
 *
 * 落盘的理由是冷启动：桥刚起来、浏览器还没开时 `hello` 不存在，扩展 id 也就无从谈起，
 * 那时唯一能依靠的就是上次成功配对的记录。它只描述"上次确实把扩展连上过的那套参数"。
 */
interface PairingRecord {
	readonly brandId: string
	/** 浏览器 `--user-data-dir`（目标系统形态，如 `C:\Users\…\User Data`）。 */
	readonly userDataDir: string
	/** `--profile-directory`（如 `Profile 3`）。 */
	readonly profileDir: string
	/** 显示名（如 `Agent`），只用于展示与人工确认。 */
	readonly profileName?: string
	readonly extensionId?: string
	readonly extensionPath?: string
	readonly matchedBy: string
	readonly resolvedAt: string
}

/** 一次拉起要用到的两段参数，外加"这个结论是怎么来的"。 */
interface LaunchTarget {
	readonly userDataDir: string
	readonly profileDir: string
	readonly profileName?: string
	readonly brandId?: string
	/** `config` 用户显式填的 > `hello` 活着的扩展 > `hint` 配置里的扩展目录 > `record` 上次配对。 */
	readonly source: 'config' | 'hello' | 'hint' | 'record'
}

class BridgeController {
	private server: BridgeServer | undefined
	/** 实际绑定到的端口；端口被占时可能回退到 port+1..port+9。未启动时为 undefined。 */
	private boundPort: number | undefined
	/** 端口回退说明，供 browser_policy_status 展示。 */
	private portNote: string | undefined
	private guarded: GuardedBridge | undefined
	private policy: UrlPolicy | undefined
	private serverKey = ''
	private policyKey = ''
	/** 宿主推导的「本 DSH 控制页」地址（来自 webServer 服务）；用户登记列表之外的补充。 */
	private controlOrigins: readonly string[] = []
	private lastError: string | undefined
	private chain: Promise<void> = Promise.resolve()
	private current: ResolvedConfig | undefined
	/** Per-session grants: hosts the user approved once in ask mode. Cleared when
	 *  policy inputs change or the plugin stops. */
	private readonly tempAllow = new Set<string>()
	// de-013 auto-launch watchdog state.
	private watchdogTimer: ReturnType<typeof setInterval> | undefined
	private lastSpawnAt = 0
	private droppedSince = 0
	/** 上次成功配对（学到的浏览器位置），懒加载自 {@link pairingFile}。 */
	private pairing: PairingRecord | undefined
	/** 定位失败时到底扫了什么、为什么没命中 —— 状态工具要把这句话说出来。 */
	private locateNote: string | undefined
	/** 已经学过其位置的扩展 id（避免重复扫盘）。 */
	private learnedExtensionId: string | undefined
	/**
	 * 「握手即学习」的定时器。
	 *
	 * 为什么必须在**连着的**时候学：`hello` 只在扩展连着时存在（断开即清空），
	 * 而"需要拉起"恰恰发生在**断开**时 —— 等到那时再去读 id，读不到。所以一看到
	 * 新 id 就立刻反查磁盘并落盘，之后的冷启动才有依据。
	 */
	private learnTimer: ReturnType<typeof setInterval> | undefined

	constructor(private readonly log: (line: string) => void) {}

	/** Resolved directory screenshots land in; defined once any config arrived. */
	get shotsDir(): string | undefined {
		return this.current === undefined ? undefined : path.resolve(this.current.shotsDir)
	}

	/** 把一个目标系统形态的路径换成当前进程能访问的形态（WSL 下 `C:\…` → `/mnt/c/…`）。 */
	private localForm(p: string): string {
		return hostStyle() === 'wsl' ? toLinuxPath(p) : p
	}

	/** 配对记录的落盘位置：`$DSH_HOME/browser-unified-pairing.json`（两个实例各自的 DSH_HOME 天然隔离）。 */
	private pairingFile(): string {
		const home = process.env['DSH_HOME'] !== undefined && process.env['DSH_HOME'] !== ''
			? process.env['DSH_HOME']
			: path.join(homedir(), '.dsh')
		return path.join(home, 'browser-unified-pairing.json')
	}

	private loadPairing(): PairingRecord | undefined {
		if (this.pairing !== undefined) return this.pairing
		try {
			const raw = JSON.parse(readFileSync(this.pairingFile(), 'utf8')) as PairingRecord
			if (typeof raw?.userDataDir === 'string' && raw.userDataDir !== '' && typeof raw?.profileDir === 'string') {
				this.pairing = raw
			}
		} catch {
			// 没有记录、或记录坏了：一律按"还没有"处理，绝不因此报错。
		}
		return this.pairing
	}

	private savePairing(record: PairingRecord): void {
		this.pairing = record
		try {
			mkdirSync(path.dirname(this.pairingFile()), { recursive: true })
			writeFileSync(this.pairingFile(), `${JSON.stringify(record, undefined, '\t')}\n`, 'utf8')
			this.log(`[browser-bridge] 已记下浏览器位置：${record.brandId} / ${record.profileDir}`
				+ `${record.profileName !== undefined ? `（${record.profileName}）` : ''} ← 命中方式 ${record.matchedBy}`)
		} catch (error) {
			// 写不进去不影响本次拉起，只是下次冷启动还得重新定位一次。
			this.log(`[browser-bridge] 配对记录写入失败：${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * 决定"这次拉起要落在哪个 profile"。
	 *
	 * 优先级（从可信到兜底）：用户显式配置 → 活着的 `hello`（扩展自报 id，最真实）→
	 * 配置里的扩展目录（路径比对）→ 上次配对的落盘记录。
	 *
	 * 全都不成立时**返回 undefined，并把"扫过什么"记进 {@link locateNote}** —— 不猜。
	 * 猜错的表现是"窗口起来了、扩展就是连不上"，比明确报错难查得多。
	 * @param config - 当前解析后的配置。
	 */
	private resolveLaunchTarget(config: ResolvedConfig): LaunchTarget | undefined {
		const hello = this.server?.status.hello
		const extensionId = hello?.extensionId !== undefined && hello.extensionId !== '' ? hello.extensionId : undefined
		if (config.autoLaunchProfileDir.length > 0) {
			const split = splitProfilePath(config.autoLaunchProfileDir, config.autoLaunchProfileName)
			if (split !== undefined) {
				// 用户显式填了就以他为准 —— 但**能查就查一下**：填错 profile 的表现是
				// "窗口起来了、扩展就是连不上"，事后极难查。判"确实是这个扩展"才记进配对
				// 记录；判"这个 profile 里没有它"就继续往下走磁盘定位，不盲信。
				const verdict = extensionId === undefined
					? undefined
					: profileHasExtension(this.localForm(split.userDataDir), split.profileDir, extensionId)
				if (verdict !== false) {
					if (verdict === true && extensionId !== undefined) {
						// 显示名只在"用户没自己填"时去磁盘捞一下，纯展示用。
						const shown = config.autoLaunchProfileName !== ''
							? config.autoLaunchProfileName
							: profileDisplayName(this.localForm(split.userDataDir), split.profileDir)
						this.savePairing({
							brandId: brandIdFromHelloName(hello?.browser?.name ?? '') ?? 'unknown',
							userDataDir: split.userDataDir,
							profileDir: split.profileDir,
							...(shown !== undefined ? { profileName: shown } : {}),
							extensionId,
							matchedBy: 'config-verified',
							resolvedAt: new Date().toISOString(),
						})
					}
					return {
						...split,
						...(config.autoLaunchProfileName !== '' ? { profileName: config.autoLaunchProfileName } : {}),
						source: 'config',
					}
				}
				this.locateNote = `设置里填的 profile（${split.profileDir}）里没有这个扩展，改用磁盘定位`
				this.log(`[browser-bridge] ${this.locateNote}`)
			}
		}
		const hint = config.autoLaunchExtensionDir.length > 0 ? config.autoLaunchExtensionDir : undefined
		if (extensionId !== undefined || hint !== undefined) {
			const brandId = brandIdFromHelloName(hello?.browser?.name ?? '')
			const found = locateExtensionProfile({ brandId, extensionId, extensionPathHint: hint })
			const location = found.location
			if (location !== undefined) {
				this.savePairing({
					brandId: location.brandId,
					userDataDir: location.userDataDir,
					profileDir: location.profileDir,
					...(location.profileName !== undefined ? { profileName: location.profileName } : {}),
					...(extensionId !== undefined ? { extensionId } : {}),
					...(location.extensionPath !== undefined ? { extensionPath: location.extensionPath } : {}),
					matchedBy: location.matchedBy,
					resolvedAt: new Date().toISOString(),
				})
				this.locateNote = undefined
				return {
					userDataDir: location.userDataDir,
					profileDir: location.profileDir,
					...(location.profileName !== undefined ? { profileName: location.profileName } : {}),
					brandId: location.brandId,
					source: extensionId !== undefined ? 'hello' : 'hint',
				}
			}
			this.locateNote = `按${extensionId !== undefined ? `扩展 id ${extensionId}` : `扩展目录 ${hint ?? ''}`}没找到装了它的 profile`
				+ `（扫过 ${found.profilesScanned.length} 个 profile）`
				+ (found.notes.length > 0 ? `；${found.notes.slice(0, 3).join('；')}` : '')
		}
		const saved = this.loadPairing()
		if (saved !== undefined) {
			const local = hostStyle() === 'wsl' ? toLinuxPath(saved.userDataDir) : saved.userDataDir
			if (existsSync(local)) {
				return {
					userDataDir: saved.userDataDir,
					profileDir: saved.profileDir,
					...(saved.profileName !== undefined ? { profileName: saved.profileName } : {}),
					brandId: saved.brandId,
					source: 'record',
				}
			}
			this.locateNote = `上次配对记录里的目录已不存在：${saved.userDataDir}`
		}
		return undefined
	}

	/** 在 `refreshWatchdog` 的每个出口旁调用：只在桥启用时做"握手即学习"。 */
	private refreshLearnTimer(config: ResolvedConfig): void {
		if (this.learnTimer !== undefined) {
			clearInterval(this.learnTimer)
			this.learnTimer = undefined
		}
		if (!config.enabled) return
		this.learnTimer = setInterval(() => {
			this.learnFromHello(config)
		}, 5_000)
		this.learnFromHello(config)
	}

	/**
	 * 看 `hello` 学一次位置（幂等）。学成了就不再重复扫盘，直到换了一个扩展 id。
	 * @param config - 当前解析后的配置。
	 */
	private learnFromHello(config: ResolvedConfig): void {
		const extensionId = this.server?.status.hello?.extensionId
		if (extensionId === undefined || extensionId === '') return
		if (extensionId === this.learnedExtensionId && this.loadPairing() !== undefined) return
		const target = this.resolveLaunchTarget(config)
		if (target === undefined) return
		this.learnedExtensionId = extensionId
		this.log(`[browser-bridge] 已从 hello 学到浏览器位置（ext=${extensionId} → ${target.brandId ?? '?'} / ${target.profileDir}`
			+ `${target.profileName !== undefined ? `（${target.profileName}）` : ''}）`)
	}

	/**
	 * 找浏览器可执行文件。
	 *
	 * **只返回真实存在的路径**（posix 上允许裸名交给 PATH 解析）。绝不返回"可能的名字"：
	 * WSL 下 `spawn('msedge')` 会 ENOENT，而那个错误是**异步**的、会被 `child.on('error')`
	 * 吞掉，函数照旧返回"已拉起" —— 实测就是这个假成功让自动拉起一直静默失效。
	 * @param configured - 用户显式填的 exe（非空则以它为准）。
	 * @param brandId - 限定品牌（来自 `hello`）；省略=按登记表找全部。
	 */
	private resolveBrowserCandidates(configured: string, brandId?: string): string[] {
		if (configured.length > 0) return [configured]
		return exeCandidates(hostStyle(), brandId !== undefined && brandId !== '' ? [brandId] : undefined)
	}

	/** Snapshot for the read-only policy-status tool. */
	describePolicy(): { enabled: boolean; urlMode?: string; internetAccess?: string; lanAccess?: string; localAccess?: string; internetTemp?: boolean; lanTemp?: boolean; localTemp?: boolean; askMode?: string; autoLaunchEnabled?: boolean; autoLaunchIdleSeconds?: number; autoLaunchProfileDir?: string; autoLaunchProfileName?: string; dshAccessEnabled?: boolean; dshOrigins?: string[]; allowHosts?: string[]; denyHosts?: string[]; denyHostsIgnored?: boolean; blockMetadata?: boolean; metadataHostnames?: string[]; metadataIps?: string[]; tempGrants: readonly string[]; ready: boolean; boundPort?: number; requestedPort?: number; portNote?: string; extensionId?: string; browserName?: string; bridgeProtocol?: number; extensionProtocol?: number; protocolCompatible?: boolean; protocolNote?: string | null; pairing?: { brandId: string; profileDir: string; profileName?: string; userDataDir: string; matchedBy: string; resolvedAt: string }; launchNote?: string } {
		const c = this.current
		const hello = this.server?.status.hello
		const pairing = this.loadPairing()
		return {
			enabled: c?.enabled ?? false,
			urlMode: c?.urlMode,
			internetAccess: c?.internetAccess,
			lanAccess: c?.lanAccess,
			localAccess: c?.localAccess,
			internetTemp: c?.internetTemp,
			lanTemp: c?.lanTemp,
			localTemp: c?.localTemp,
			askMode: c?.askMode,
			autoLaunchEnabled: c?.autoLaunchEnabled,
			autoLaunchIdleSeconds: c?.autoLaunchIdleSeconds,
			autoLaunchProfileDir: c?.autoLaunchProfileDir,
			autoLaunchProfileName: c?.autoLaunchProfileName,
			dshAccessEnabled: c?.dshAccessEnabled,
			dshOrigins: c === undefined ? undefined : mergeDshOrigins(c, this.controlOrigins),
			allowHosts: c?.allowHosts,
			denyHosts: c?.denyHosts,
			// 状态面必须能说出"这份名单此刻到底生不生效"（X14）：askMode=allow 时空数组才是生效值。
			denyHostsIgnored: c?.askMode === 'allow',
			blockMetadata: c?.blockMetadata,
			metadataHostnames: c?.metadataHostnames,
			metadataIps: c?.metadataIps,
			tempGrants: [...this.tempAllow],
			ready: this.guarded !== undefined,
			boundPort: this.boundPort,
			requestedPort: c?.port,
			portNote: this.portNote,
			extensionId: hello?.extensionId,
			browserName: hello?.browser?.name,
			// 协议协商（core 0.1.5 起随上游 v1.0.9 的口径）：不匹配时 status 里带原因，
			// browser_info 直接把它交给模型 —— 否则"新命令报未知命令"没人解释得清。
			bridgeProtocol: this.server?.status.bridgeProtocol,
			extensionProtocol: this.server?.status.extensionProtocol,
			protocolCompatible: this.server?.status.protocolCompatible,
			protocolNote: this.server?.status.protocolNote ?? null,
			pairing: pairing === undefined ? undefined : {
				brandId: pairing.brandId,
				profileDir: pairing.profileDir,
				profileName: pairing.profileName,
				userDataDir: pairing.userDataDir,
				matchedBy: pairing.matchedBy,
				resolvedAt: pairing.resolvedAt,
			},
			launchNote: this.locateNote,
		}
	}

	// --- de-013 auto-launch watchdog -------------------------------------
	/** (Re)arm the watchdog from the resolved config; clears it when disabled. */
	private refreshWatchdog(config: ResolvedConfig): void {
		if (this.watchdogTimer !== undefined) {
			clearInterval(this.watchdogTimer)
			this.watchdogTimer = undefined
		}
		this.droppedSince = 0
		if (!config.enabled || !config.autoLaunchEnabled) return
		const idleMs = Math.max(3, Math.min(3600, config.autoLaunchIdleSeconds ?? 15)) * 1000
		this.watchdogTimer = setInterval(() => {
			void this.watchdogTick(idleMs, config)
		}, Math.min(5000, Math.max(1000, idleMs)))
	}

	private async watchdogTick(idleMs: number, config: ResolvedConfig): Promise<void> {
		const status = this.server?.status
		if (status === undefined || !status.listening) return
		if (status.extensionConnected) {
			this.droppedSince = 0
			return
		}
		const now = Date.now()
		if (this.droppedSince === 0) this.droppedSince = now
		if (now - this.droppedSince < idleMs) return
		const cooldown = Math.max(30_000, idleMs * 2)
		if (now - this.lastSpawnAt < cooldown) return
		this.lastSpawnAt = now
		this.spawnBrowser(config)
	}

	/**
	 * de-013 model-invoked launch: bring the extension's browser back up on
	 * demand. Unlike the disconnect watchdog this does not require
	 * `autoLaunchEnabled` — the model asks, the browser starts. Spawn
	 * parameters come from the same autoLaunch* settings the watchdog uses.
	 * A short cooldown prevents the model from spawning a window per call.
	 * @returns a human-readable outcome for the tool layer.
	 */
	launchBrowser(landingUrl?: string): string {
		const status = this.server?.status
		if (status?.extensionConnected) return '扩展已连接，无需拉起'
		const config = this.current
		if (config === undefined) return '浏览器控制尚未加载配置，无法拉起'
		if (!config.enabled) return '浏览器控制未启用，无法拉起（请先打开开关）'
		// 以前这里硬性要求填过 autoLaunchProfileDir / autoLaunchBrowserExe。现在
		// "哪个 profile"可以由**扩展自报 id + 磁盘反查**得到，所以只在真的没有任何
		// 判据时才拦 —— 否则就是"明明能学会，却先怪用户没配置"。
		const hasJudgement = config.autoLaunchProfileDir.length > 0
			|| config.autoLaunchBrowserExe.length > 0
			|| config.autoLaunchExtensionDir.length > 0
			|| this.loadPairing() !== undefined
		if (!hasJudgement) {
			return '定位不到浏览器 profile：既没配过（autoLaunchProfileDir / autoLaunchExtensionDir），也还没有过成功配对。'
				+ '先手动打开一次装了扩展的那个 profile，让扩展连上过一回，桥会记住位置'
				+ (this.locateNote !== undefined ? `；上次定位失败原因：${this.locateNote}` : '')
		}
		const now = Date.now()
		if (now - this.lastSpawnAt < 10_000) return '刚刚已尝试拉起，请稍候几秒让浏览器/扩展连上'
		this.lastSpawnAt = now
		return this.spawnBrowser(config, landingUrl)
	}

	/**
	 * 唤起可用的浏览器。
	 *
	 * **"进程活着但没有窗口"与"扩展没连上"是两件不同的事**，混在一起会形成死局：
	 * Edge 关掉所有窗口后仍在后台驻留（启动增强/后台扩展），扩展照样连着桥，于是
	 * `launchBrowser()` 回答"扩展已连接，无需拉起"，但 `tabs.list` 回 0 个标签页、
	 * 所有"当前标签页"类命令全部失败（实测 Windows 侧就是这么卡住的）。
	 *
	 * - 扩展已连接但没有窗口 → 让扩展自己新建窗口（`window.ensure`），**不再起进程**；
	 * - 扩展未连接 → 沿用原来的 spawn 逻辑。
	 * @returns 给人/模型看的结果说明。
	 */
	async wakeBrowser(options: { url?: string; reason?: string } = {}): Promise<string> {
		const status = this.server?.status
		const reason = typeof options.reason === 'string' && options.reason.length > 0 ? options.reason : 'browser_launch'
		// 落地页：只有"当前策略**直接放行**"的 http(s) 网址才会被采用。唤醒发生在
		// buddy 的 pre-execute（也就是工具自身授权门**之前**），把未授权/被拦的 URL
		// 交给浏览器等于绕过 UrlPolicy（元数据端点、deny 名单全会漏）。判定不过就退回 about:blank。
		const landingUrl = await this.wakeLandingUrl(options.url)
		if (status?.extensionConnected === true) {
			try {
				const info = (await this.execute(
					'window.ensure',
					{ reason, ...(landingUrl === undefined ? {} : { url: landingUrl }) },
					new AbortController().signal,
				)) as { created?: boolean; windowsBefore?: number; tabId?: number; note?: string }
				if (info.created === true) {
					return `扩展已连接，但浏览器里没有任何窗口 —— 已让扩展新建一个窗口（tabId=${String(info.tabId)}`
						+ `${landingUrl === undefined ? '' : `，落在 ${landingUrl}`}），可以继续操作了`
				}
				return `扩展已连接，当前有 ${String(info.windowsBefore)} 个窗口，无需唤起`
			} catch (error) {
				return `扩展已连接，但请求它新建窗口失败：${errorMessage(error)}（可手动打开一次浏览器窗口）`
			}
		}
		return this.launchBrowser(landingUrl)
	}

	/**
	 * 校验候选项能否当"唤醒落地页"：必须 http(s)，且当前策略**直接放行**（allow）——
	 * `ask`/`block`/`unavailable` 一律不用（唤醒不该成为绕过审批的通道）。
	 * @returns 可用则返回归一化后的 URL，否则 undefined（调用方退回 about:blank）。
	 */
	private async wakeLandingUrl(candidate: string | undefined): Promise<string | undefined> {
		if (typeof candidate !== 'string') return undefined
		const url = candidate.trim()
		if (!/^https?:\/\//i.test(url)) return undefined
		try {
			const verdict = await this.authorizeUrl(url)
			return verdict.decision === 'allow' ? url : undefined
		} catch {
			return undefined
		}
	}

	private spawnBrowser(config: ResolvedConfig, landingUrl?: string): string {
		// 拉起目标**先由学习/配置得出**（见 resolveLaunchTarget），不再自己
		// `path.resolve` —— 那正是 Windows 路径被 Linux 口径拆坏的来源（缺陷③）。
		const target = config.autoLaunchTempProfile ? undefined : this.resolveLaunchTarget(config)
		let userDataDir = ''
		let profileName = ''
		if (config.autoLaunchTempProfile) {
			if (!config.autoLaunchExtensionDir) {
				this.log('[browser-bridge] autoLaunch: 临时干净实例需要 autoLaunchExtensionDir（未打包扩展目录）才能 sideload；改用已装扩展的 profile 目录')
				return '临时干净实例需要 autoLaunchExtensionDir（未打包扩展目录）才能 sideload；请改配已装扩展的 profile 目录或填扩展目录'
			}
			userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-browser-'))
		} else if (target !== undefined) {
			userDataDir = target.userDataDir
			profileName = target.profileDir
		} else if (config.autoLaunchBrowserExe.length === 0) {
			// 定位不到"装了扩展的那个 profile"。此时用默认 profile 拉一个窗口出来，
			// 表现就是历史上那个「唤起了但没用」：窗口起来了、扩展永远连不上。
			// 与其开一个没用的窗口，不如把话说明白。
			// （用户显式填了 autoLaunchBrowserExe 的按他自己的选择走，不拦。）
			const why = this.locateNote !== undefined ? `；${this.locateNote}` : ''
			this.log(`[browser-bridge] autoLaunch: 跳过拉起 —— 定位不到装了扩展的 profile${why}`)
			return '定位不到装了扩展的 profile，因此没有拉起（用默认 profile 起了也连不上）'
				+ `${why}。先手动打开一次装了扩展的那个 profile，让扩展连上过一回，桥会自己记住位置`
		}
		const extra = config.autoLaunchTempProfile && config.autoLaunchExtensionDir
			? ['--load-extension=' + path.resolve(config.autoLaunchExtensionDir)]
			: []
		const args = ['--no-first-run', '--no-default-browser-check']
		if (userDataDir) args.push('--user-data-dir=' + userDataDir)
		if (profileName) args.push('--profile-directory=' + profileName)
		args.push(...extra)
		// 落地页：有"本次调用要去的网址"就直接落在那里（2026-10-10 用户反馈：以前一律
		// about:blank，每唤起一次就多一张空白垃圾页，而且模型还得再导航一次）。
		args.push(landingUrl === undefined ? 'about:blank' : landingUrl)
		const candidates = this.resolveBrowserCandidates(config.autoLaunchBrowserExe, target?.brandId)
		if (candidates.length === 0) {
			const why = this.locateNote !== undefined ? `；${this.locateNote}` : ''
			this.log(`[browser-bridge] autoLaunch: 找不到可用的浏览器可执行文件${why}`)
			return `找不到浏览器可执行文件（登记表里的常见安装位置都没命中）${why}`
		}
		if (target !== undefined) {
			this.log(`[browser-bridge] autoLaunch: 拉起目标来自 ${target.source}（${target.brandId ?? '未知品牌'} / ${target.profileDir}`
				+ `${target.profileName !== undefined ? `（${target.profileName}）` : ''}）`)
		}
		const where = `user-data-dir=${userDataDir || '默认'}${profileName ? `, profile=${profileName}` : ''}`
		for (const exe of candidates) {
			const looksLikePath = exe.includes('/') || exe.includes('\\')
			if (looksLikePath && !existsSync(exe)) {
				this.log(`[browser-bridge] autoLaunch: 跳过不存在的可执行文件 ${exe}`)
				continue
			}
			try {
				const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
				// ⚠️ ENOENT / EACCES 走的是**异步** `'error'` 事件，try/catch 抓不到。
				// 所以这里只能说"已发起"，成不成功由 `hello` 到达来判定 —— 过去正是在
				// 这里谎报"已拉起"，才让"调用即自动拉起"静默失效。
				child.on('error', (error) => {
					this.log(`[browser-bridge] autoLaunch ${exe} 启动失败：${error.message}（若配置了可执行文件请给完整路径）`)
				})
				child.unref()
				this.log(`[browser-bridge] autoLaunch: 已发起 ${exe}（${where}）`)
				return `已发起 ${exe}（${where}）${target !== undefined ? `，目标来自${launchSourceZh(target.source)}` : ''}`
					+ '；是否真的起来以 hello 到达为准（等几秒再看扩展是否已连接）'
			} catch (error) {
				this.log(`[browser-bridge] autoLaunch ${exe} 失败：${error instanceof Error ? error.message : String(error)}`)
			}
		}
		this.log('[browser-bridge] autoLaunch: 候选可执行文件都起不来')
		return `候选浏览器都起不来（试过 ${candidates.join(', ')}）`
	}

	/**
	 * Converge the live server onto `config`. With `throwOnError`, an initial
	 * start failure rejects (fail-loud activation); later changes record the
	 * failure instead, so a bad port cannot tear down an otherwise running session.
	 * @param config - the freshly resolved settings snapshot.
	 * @param options - set `throwOnError` only for the activation-time call.
	 * @returns a promise settling once the convergence attempt finished.
	 */
	/**
	 * 记录由宿主推导的「本 DSH 控制页」地址（`webServer.port`），并在变化时重建策略：
	 * DSH 页面红线要跟着**真实的控制页**走，而不是跟着用户登记的旧地址走。
	 * @param origins - 归一化的 origin 列表（如 `http://127.0.0.1:3080`）。
	 */
	setControlOrigins(origins: readonly string[]): void {
		const next = [...origins]
		if (next.join('\u0001') === this.controlOrigins.join('\u0001')) return
		this.controlOrigins = next
		this.policyKey = ''
		const config = this.current
		if (config !== undefined) void this.reconcile(config)
	}

	reconcile(config: ResolvedConfig, options: { throwOnError?: boolean } = {}): Promise<void> {
		this.current = config
		const run = this.chain.then(() => this.reconcileNow(config))
		this.chain = run.catch(() => {})
		if (options.throwOnError === true) {
			return run.catch((error) => {
				throw error instanceof Error ? error : new Error(String(error))
			})
		}
		return Promise.resolve()
	}

	private async reconcileNow(config: ResolvedConfig): Promise<void> {
		const shotsDir = path.resolve(config.shotsDir)
		// The listener only restarts when transport-affecting values change.
		const serverKey = config.enabled ? `${config.port}|${config.token}|${shotsDir}` : ''
		// URL policy is rebuilt in place (no listener restart) when the policy
		// inputs change, so editing the lists / modes in Settings applies live
		// without ever dropping an in-flight browser command.
		const policyKey = config.enabled
			? `${config.urlMode}|${config.blockMetadata ? '1' : '0'}|${config.askMode}|${config.internetAccess}|${config.lanAccess}|${config.localAccess}|`
				+ `${config.internetTemp ? '1' : '0'}|${config.lanTemp ? '1' : '0'}|${config.localTemp ? '1' : '0'}|`
				+ `${config.dshAccessEnabled ? '1' : '0'}|${mergeDshOrigins(config, this.controlOrigins).join('\u0001')}|`
				+ `${(config.metadataHostnames ?? []).join('\u0001')}|${(config.metadataIps ?? []).join('\u0001')}|`
				+ `${(config.allowHosts ?? []).join('\u0001')}|${(config.denyHosts ?? []).join('\u0001')}`
			: ''
		if (serverKey === this.serverKey && policyKey === this.policyKey) return
		if (serverKey !== this.serverKey) {
			const previous = this.server
			this.server = undefined
			this.guarded = undefined
			this.policy = undefined
			this.tempAllow.clear()
			this.serverKey = ''
			this.policyKey = ''
			await previous?.stop()
			if (!config.enabled) {
				this.lastError = undefined
				return
			}
			// 端口被占时**依次尝试候选端口**（配置端口 → +1 … +9），全不可用则降级记录错误。
			// 历史行为是这里直接 throw → 变成未处理拒绝 → DSH `exit(1)`（P0 取证：端口被占时
			// `dsh web` 起不来）。现在任何启动失败都不再拖垮 DSH；扩展端会按候选序列自动发现端口。
			const candidates = [config.port, ...Array.from({ length: PORT_FALLBACK_COUNT }, (_, i) => config.port + i + 1)]
			let started: BridgeServer | undefined
			let lastStartError: unknown
			for (const candidate of candidates) {
				const attempt = new BridgeServer({
					port: candidate,
					token: config.token,
					shotsDir,
					log: this.log,
					// X18：HTTP 命令面（`POST /api/command`）过去完全不过策略，同伴件的 frames/eval
					// 就走它 —— 等于"带 token 就能对任意标签页 eval/nav"。这里把策略接回去。
					guardCommand: (command, params) => this.guardHttpCommand(command, params),
					// 设置页要用「存下来的值 vs 正在生效的值」把"改动需重启"显出来（2026-10-17：
					// 用户开了「允许访问本 DSH 页面」、页面显示已保存，实际仍被 `WEB_DSH_DISABLED` 拒）。
					// 读 `this.current`（reconcile 里更新）而不是 reconcile 的参数：策略变更时监听器
					// 不重建，闭包捕获的旧 config 会过期。只放只读、非机密字段；dshOrigins 不放 ——
					// 生效值里含宿主推导出来的控制页地址，与用户列表天然不同，比了会误报。
					pluginVersion: pluginVersionSync(),
			describePolicy: () => {
						const c = this.current
						if (c === undefined) return undefined
						return {
							enabled: c.enabled !== false,
							readOnly: c.readOnly === true,
							allowScript: c.allowScript !== false,
							dshAccessEnabled: c.dshAccessEnabled === true,
							internetAccess: c.internetAccess,
							lanAccess: c.lanAccess,
							localAccess: c.localAccess,
							askMode: c.askMode,
							blockMetadata: c.blockMetadata !== false,
							allowHosts: [...(c.allowHosts ?? [])],
							denyHosts: [...(c.denyHosts ?? [])],
						}
					},
				})
				try {
					await attempt.start()
					started = attempt
					this.boundPort = candidate
					if (candidate === config.port) {
						this.portNote = undefined
					} else {
						// X15（另一半）：回退到扩展扫描窗口**之外**时，"扩展会自动发现"是句假承诺
						// （扩展只扫 9777..9786，外加它自己 popup 里填过的端口/lastKnownPort）。
						this.portNote = extensionCanDiscoverPort(candidate)
							? `配置端口 ${config.port} 被占用，已回退到 ${candidate}（在扩展的扫描窗口 ${EXTENSION_PORT_SCAN_BASE}..${EXTENSION_PORT_SCAN_BASE + EXTENSION_PORT_SCAN_COUNT - 1} 内，扩展会自己发现）`
							: `配置端口 ${config.port} 被占用，已回退到 ${candidate} —— ⚠️ 该端口**不在扩展的默认扫描窗口 ${EXTENSION_PORT_SCAN_BASE}..${EXTENSION_PORT_SCAN_BASE + EXTENSION_PORT_SCAN_COUNT - 1} 内**：请到扩展的高级里把「桥接端口」填成 ${candidate}，否则扩展连不上这个桥`
						this.log(`[browser-bridge] ${this.portNote}`)
					}
					break
				} catch (error) {
					lastStartError = error
					const code = (error as NodeJS.ErrnoException | undefined)?.code
					// 只有"端口被占"值得换端口；其它错误（无权限 / 非法端口）立即停手。
					if (code !== 'EADDRINUSE') break
					this.log(`[browser-bridge] 端口 ${candidate} 被占用，尝试下一个候选`)
				}
			}
			if (started === undefined) {
				this.boundPort = undefined
				this.portNote = undefined
				const message = lastStartError instanceof Error ? lastStartError.message : String(lastStartError)
				this.lastError = `桥接启动失败（候选端口 ${candidates[0]}..${candidates[candidates.length - 1]} 均不可用）: ${message}`
				this.log(this.lastError)
				this.refreshWatchdog(config)
		this.refreshLearnTimer(config)
				return
			}
			this.server = started
			this.serverKey = serverKey
		}
		if (!config.enabled) {
			this.refreshWatchdog(config)
		this.refreshLearnTimer(config)
			return
		}
		// Unified URL policy in front of every navigation command: public mode
		// blocks private/loopback/metadata targets before they reach the
		// extension; intranet mode allows local/LAN but still blocks metadata.
		// Rebuild whenever the policy inputs change (mode, realm access, temps,
		// full access, metadata and allow/deny lists). Session grants reset with
		// the policy.
		if (policyKey !== this.policyKey && this.server !== undefined) {
			this.policy = new UrlPolicy(policyOptionsFor(config, this.controlOrigins))
			this.guarded = new GuardedBridge(this.server, this.policy)
			this.tempAllow.clear()
			this.policyKey = policyKey
			this.lastError = undefined
		}
		this.refreshWatchdog(config)
		this.refreshLearnTimer(config)
	}

	/**
	 * Run one extension command over the live, policy-guarded link.
	 * @param command - extension command name (`nav`, `click`, …).
	 * @param params - wire params passed through to the extension.
	 * @param signal - tool-execution cancellation propagated to the pending command.
	 * @returns the extension's result payload verbatim.
	 */
	/**
	 * **只读档**下仍然放行的命令（其余一律拒绝）。判定放在 `execute` 这个单一收口上 ——
	 * 工具面隐藏（buddy）只是"模型不知道有它"，真边界在这里：即使注入猜中名字也会被拒。
	 */
	/**
	 * 哪些命令属于"执行任意脚本"这一类（等价于 devtools 控制台）。
	 * 主人 2026-10-17：「模型权限我觉得可以细化，比如让不让调用类似 devtools 这类」——
	 * 先把最危险的一类单独拎出来做成开关；其余按 read-only 那档兜。
	 */
	private static readonly SCRIPT_COMMANDS = new Set(['eval', 'content.debug', 'content'])

	private static readonly READ_ONLY_ALLOWED = new Set([
		'ping', 'browser.info', 'tabs.list', 'snapshot', 'screenshot', 'find', 'frames',
		'console.log', 'network.log', 'wait', 'hold.status', 'lock.status', 'pdf',
	])

	/** 当前是否只读档（`accessLevel: 'read-only'`）。 */
	private isReadOnly(): boolean {
		return this.current?.readOnly === true
	}

	async execute(command: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		if (BridgeController.SCRIPT_COMMANDS.has(command) && this.current?.allowScript === false) {
			throw classify(command, new Error(
				`脚本执行已关闭：命令 ${command} 被拒绝（设置 →「浏览器」→ 访问控制 → 允许模型执行任意脚本 关着）。`
				+ '读取、点击、输入、导航都不受影响；要放开请让主人打开那一项。',
			))
		}
		if (this.isReadOnly() && !BridgeController.READ_ONLY_ALLOWED.has(command)) {
			throw classify(command, new Error(
				`只读模式：命令 ${command} 已被拒绝（设置 →「浏览器」→ 访问控制 → 允许模型操作页面 关着）。`
				+ '要放开请让主人在设置里打开那一项；读取类工具（read/snapshot/screenshot/find 等）照常可用。',
			))
		}
		const guarded = this.guarded
		if (guarded === undefined) {
			throw classify(command, new Error(
				this.lastError ?? '浏览器控制未启用 —— 到 dsh 设置 →「浏览器」分区打开开关',
			))
		}
		try {
			return await guarded.execute(command, params, { signal })
		} catch (error) {
			// 第二道收口（core 的桥是第一道）：把失败翻译成模型能读的"该不该重试"。
			// classify 幂等，已被分类过的原样返回；策略错误（UrlPolicyError）单独归类成
			// policy_blocked + not_started —— 它发生在命令发出之前，不是"结果未知"。
			throw classify(command, error)
		}
	}

	/**
	 * Authorize one navigation target against the live policy, honoring
	 * per-session grants. Returns `unavailable` while the bridge is stopped.
	 */
	/**
	 * X18：HTTP 命令面（`POST /api/command`）的策略守卫，由 core 的 `guardCommand` 钩子调用。
	 *
	 * 覆盖两类：
	 *  1. **带 URL 的命令**（`nav` / `tabs.open`）：与工具路径同源，但这里没有审批通道 ⇒
	 *     只有 `allow` 才放行，`ask` 一律拒（并指路「用 browser_navigate 工具」或加 allowHosts）。
	 *  2. **页面内容命令**（`eval` / `frames` / `click` …）：判**目标标签页当前 URL**是否踩红线 ——
	 *     这正是以前缺的那一层（同伴件走 HTTP 面，绕过了工具层的 `authorizeExistingTab`）。
	 *
	 * 扩展未连接时不在这里拦（交给 `execute` 报 503「no browser extension」，别把连接问题说成策略拒绝）。
	 * @returns 拒绝原因（非空即 403）；undefined = 放行。
	 */
	async guardHttpCommand(command: string, params: Record<string, unknown>): Promise<string | undefined> {
		const url = params.url
		if (typeof url === 'string' && url.length > 0 && HTTP_URL_COMMANDS.has(command)) {
			const verdict = await this.authorizeUrl(url)
			if (verdict.decision === 'unavailable') return controllerDescribeUnavailable()
			if (verdict.decision !== 'allow') {
				const code = verdict.decision === 'block' ? (verdict.code ?? 'WEB_BLOCKED_URL') : 'NEED_AUTHORIZATION'
				return `${code}: ${verdict.reason}（HTTP 命令面没有审批通道：要访问该目标请改用 browser_navigate 工具，或把它加入 allowHosts）`
			}
		}
		if (HTTP_PAGE_COMMANDS.has(command)) {
			if (this.server?.status.extensionConnected !== true) return undefined
			const tabId = typeof params.tabId === 'number' ? params.tabId : undefined
			try {
				await authorizeExistingTab(this, tabId, new AbortController().signal)
			} catch (error) {
				return errorMessage(error)
			}
		}
		return undefined
	}

	async authorizeUrl(
		raw: string,
	): Promise<{ decision: 'allow' | 'ask' | 'block'; code?: string; reason: string; host: string } | { decision: 'unavailable' }> {
		const policy = this.policy
		if (policy === undefined) {
			return { decision: 'unavailable' }
		}
		const verdict = await policy.authorizeUrl(raw)
		if (verdict.decision === 'ask' && verdict.host.length > 0 && this.tempAllow.has(verdict.host)) {
			return { decision: 'allow', reason: '', host: verdict.host }
		}
		return verdict
	}

	/** Remember one host for the rest of this session (ask-mode grant). */
	grantTemporary(host: string): void {
		if (host.length > 0) this.tempAllow.add(host)
	}

	/**
	 * Delete generated artifacts using the currently resolved directories;
	 * works while the bridge is stopped because it never touches the socket.
	 * @returns counts and names of what was removed.
	 */
	async cleanup(): Promise<{ shotsRemoved: number; scratchRemoved: readonly string[] }> {
		const dir = this.shotsDir
		if (dir === undefined) throw new Error('浏览器控制尚未加载配置，无法确定清理目录')
		return cleanupArtifacts({ shotsDir: dir })
	}

	/** Stop the listener; safe to call repeatedly and during teardown. */
	stop(): Promise<void> {
		if (this.watchdogTimer !== undefined) {
			clearInterval(this.watchdogTimer)
			this.watchdogTimer = undefined
		}
		if (this.learnTimer !== undefined) {
			clearInterval(this.learnTimer)
			this.learnTimer = undefined
		}
		this.droppedSince = 0
		const previous = this.server
		this.server = undefined
		this.guarded = undefined
		this.policy = undefined
		this.tempAllow.clear()
		this.serverKey = ''
		this.policyKey = ''
		return previous?.stop() ?? Promise.resolve()
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Host approval service shape (same as browser_design_edit uses). */
type ApprovalService = {
	request(req: { agent: { id: string }; toolName: string; reason?: string; signal?: AbortSignal }): Promise<string>
}

/**
 * Authorization gate in front of navigation tools. Blocks carry a stable code;
 * `ask` verdicts raise a host approval request through the host approval
 * service and remember an approved host for the rest of the session, so the
 * model never loops on a target the user already granted.
 */
async function authorizeNavigation(
	ctx: Context,
	controller: BridgeController,
	url: string,
	exec: { signal: AbortSignal; agent?: { id?: string } },
	toolName: string,
): Promise<void> {
	const verdict = await controller.authorizeUrl(url)
	if (verdict.decision === 'unavailable') {
		throw new Error(
			controllerDescribeUnavailable(),
		)
	}
	if (verdict.decision === 'block') {
		throw new Error(`${verdict.code ?? 'WEB_BLOCKED_URL'}: ${verdict.reason}`)
	}
	if (verdict.decision === 'ask') {
		const s = controller.describePolicy()
		const realm = verdict.host.length > 0 ? realmOf(verdict.host) : 'internet'
		const agent = (exec as { agent?: unknown }).agent
		const session = (agent as { session?: unknown } | undefined)?.session
		const approval = ctx.get('approval') as
			| { request: (req: { agent: unknown; toolName: string; reason?: string; signal?: AbortSignal }) => Promise<string>; overrideOf?: (s: unknown) => string | undefined; config?: { policy?: string } }
			| undefined
		// de-016: can a host approval actually be requested right now? The
		// restricted-state askMode only applies when it cannot.
		let askable = false
		if (approval && typeof agent === 'object' && agent !== null && session !== undefined && typeof approval.overrideOf === 'function') {
			try {
				const override = approval.overrideOf(session as never)
				const effective = override ?? approval.config?.policy ?? 'ask'
				askable = effective === 'ask'
			} catch {
				askable = true // unknown → assume ask is usable (safe default: prompt)
			}
		}
		if (askable) {
			// Approvals are usable: always show the host approval; askMode
			// (restricted-state policy) deliberately does not apply here.
			const realmTemp = realm === 'internet' ? (s.internetTemp ?? true) : realm === 'lan' ? (s.lanTemp ?? true) : (s.localTemp ?? true)
			if (!realmTemp) {
				throw new Error(`NEED_AUTHORIZATION: ${verdict.reason} — 该网络（${realmLabelZh(realm)}）不允许临时授权；请把主机 ${verdict.host} 加入 allowHosts 白名单后再试`)
			}
			if (!approval || !agent || !session) {
				throw new Error(`NEED_AUTHORIZATION: ${verdict.reason} — no approval service or agent/session context available; add the host to allowHosts or set the realm access back to allow`)
			}
			const outcome = await approval.request({
				agent: agent as never,
				toolName,
				reason: `【浏览器访问授权】目标 ${url}（主机 ${verdict.host}，${realmLabelZh(realm)}域）：该域为 ask 模式且主机不在 allowHosts。批准后本次会话内访问此主机不再重复询问。`,
				signal: exec.signal,
			})
			if (outcome !== 'allowed-once') {
				throw new Error(`NEED_AUTHORIZATION: 用户未批准访问 ${verdict.host}（${outcome}）。请勿自动重试该目标；如需继续，请向用户请求授权或把主机加入 allowHosts 白名单。`)
			}
			controller.grantTemporary(verdict.host)
			return
		}
		// Approvals unavailable (policy never / Full Access / no service):
		// apply the restricted-state askMode.
		const askMode = (s.askMode as 'inherit' | 'allow' | 'deny' | undefined) ?? 'inherit'
		if (askMode === 'deny') {
			throw new Error(`WEB_REALM_DENIED: ${verdict.reason} — ask 域被配置为直接禁止（受限态策略=禁止）`)
		}
		// 'inherit'（忽略）与 'allow'（放行）都让目标通过：ask 失效。
		controller.grantTemporary(verdict.host)
	}
}

function controllerDescribeUnavailable(): string {
	return '浏览器控制未启用 —— 到 dsh 设置 → 插件 → DSH 浏览器控制 打开开关'
}

function realmLabelZh(realm: string): string {
	return realm === 'lan' ? '局域网' : realm === 'local' ? '本机' : '外网'
}

function askModeZh(mode: string | undefined): string {
	return mode === 'allow' ? '放行' : mode === 'deny' ? '禁止' : '忽略'
}

interface TabListPayload {
	count?: number
	activeTabId?: number
	tabs?: Array<{ id: number; url?: string; title?: string; active?: boolean }>
}

/** Resolve the current URL of a tab (by id, or the active tab) through tabs.list. */
async function currentTabUrl(
	controller: BridgeController,
	tabId: number | undefined,
	signal: AbortSignal,
): Promise<string | undefined> {
	const raw = await controller.execute('tabs.list', {}, signal) as TabListPayload
	const tabs = Array.isArray(raw.tabs) ? raw.tabs : []
	let pick: TabListPayload['tabs'] extends Array<infer T> ? T | undefined : never = undefined
	if (typeof tabId === 'number') {
		pick = tabs.find((t) => t.id === tabId)
		if (pick === undefined) {
			// 以前这里静默退回 tabs[0]：授权判在了**另一个**标签页上，命令本身再由扩展回一句
			// "No tab with id: …"（调用方还得多跑一次 browser_tabs 才知道有哪些 id）。
			const available = tabs.map((t) => `${t.id}${t.active === true ? '(active)' : ''}`)
			throw new Error(`没有 id=${tabId} 的标签页`
				+ (available.length > 0 ? `；现有：${available.join(', ')}` : '（当前没有标签页）'))
		}
	} else {
		pick = tabs.find((t) => t.active === true)
		if (pick === undefined && typeof raw.activeTabId === 'number') pick = tabs.find((t) => t.id === raw.activeTabId)
	}
	if (pick === undefined) pick = tabs[0]
	return typeof pick?.url === 'string' && pick.url.length > 0 ? pick.url : undefined
}

/**
 * Red-line gate for operating on an ALREADY-OPEN tab: refuse any page-affecting
 * command whose current URL the live policy forbids (metadata endpoints, the
 * disabled DSH control page, deny/deny-listed hosts, realm denial). Red lines
 * are absolute — they refuse even where a user approval would otherwise be
 * possible (approvals never apply to red-line verdicts). Non-http(s) pages are
 * skipped. Every browser_* tool that reads, evaluates, interacts with or
 * captures a page goes through this gate, so there is no tool that silently
 * bypasses the policy.
 */
async function authorizeExistingTab(
	controller: BridgeController,
	tabId: number | undefined,
	signal: AbortSignal,
): Promise<void> {
	const url = await currentTabUrl(controller, tabId, signal)
	if (!url) return
	try {
		const parsed = new URL(url)
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
	} catch {
		return
	}
	const verdict = await controller.authorizeUrl(url)
	if (verdict.decision === 'unavailable') {
		throw new Error(controllerDescribeUnavailable())
	}
	if (verdict.decision === 'block') {
		throw new Error(`${verdict.code ?? 'WEB_BLOCKED_URL'}: ${verdict.reason} — operating on this open tab is refused`)
	}
	if (verdict.decision === 'ask') {
		throw new Error(`NEED_AUTHORIZATION: 当前标签页 ${url}（主机 ${verdict.host}）未获授权访问。请先让用户批准该主机，或把它加入 allowHosts 白名单后再操作。`)
	}
}

/** Cap long page reads and mark the cut, so token cost stays bounded. */
function clampText(value: string, maxChars: number): { content: string; truncated: boolean } {
	return value.length <= maxChars
		? { content: value, truncated: false }
		: { content: value.slice(0, maxChars), truncated: true }
}

/**
 * Resolve the element target a click/type tool received.
 * @param args - validated tool arguments carrying at most one targeting field.
 * @returns the CSS selector to send on the wire, refs translated to their attribute form.
 */
function targetSelector(args: { selector?: string; ref?: string }): string {
	const hasSelector = typeof args.selector === 'string' && args.selector.length > 0
	const hasRef = typeof args.ref === 'string' && args.ref.length > 0
	if (hasSelector === hasRef) {
		throw new Error('provide exactly one of selector or ref (ref comes from browser_snapshot)')
	}
	if (hasRef) {
		const ref = args.ref!
		if (!SNAPSHOT_REF_SELECTOR_PATTERN.test(ref)) throw new Error(`invalid ref: ${ref}`)
		return `[data-dsh-ref="${ref}"]`
	}
	return args.selector!
}

function requireTabId(args: { tabId?: number }, action: string): number {
	if (typeof args.tabId !== 'number') throw new Error(`${action} requires tabId`)
	return args.tabId
}

interface ScreenshotPayload {
	tabId: number
	format: 'png' | 'jpeg'
	base64: string
	tabTitle?: string
	tabUrl?: string
}

interface ScreenshotResult {
	file: string
	bytes: number
	tabId: number
	title?: string
	url?: string
}

/** Write one screenshot payload to the shots directory and return its durable location. */
async function saveScreenshot(controller: BridgeController, payload: ScreenshotPayload): Promise<ScreenshotResult> {
	const dir = controller.shotsDir
	if (dir === undefined) throw new Error('browser-bridge is not configured yet')
	await mkdir(dir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const random = Math.random().toString(36).slice(2, 6)
	const file = path.join(dir, `${stamp}-${random}.${payload.format === 'jpeg' ? 'jpg' : 'png'}`)
	const buffer = Buffer.from(payload.base64, 'base64')
	await writeFile(file, buffer)
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		title: payload.tabTitle,
		url: payload.tabUrl,
	}
}

/** Write one PDF payload to `path` (absolute or relative to `controller.shotsDir`)
 *  and return the absolute path + size. Mirrors saveScreenshot's contract. */
async function savePdf(
	controller: BridgeController,
	payload: { base64: string; tabId: number; tabTitle?: string; tabUrl?: string },
	requestedPath?: string,
): Promise<{ file: string; bytes: number; tabId: number; title?: string; url?: string }> {
	const dir = controller.shotsDir
	if (dir === undefined) throw new Error('browser-bridge is not configured yet')
	let file: string
	if (requestedPath && path.isAbsolute(requestedPath)) {
		file = requestedPath
		await mkdir(path.dirname(file), { recursive: true })
	} else {
		await mkdir(dir, { recursive: true })
		const stamp = new Date().toISOString().replace(/[:.]/g, '-')
		const random = Math.random().toString(36).slice(2, 6)
		const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.pdf`
		file = path.join(dir, name)
	}
	const buffer = Buffer.from(payload.base64, 'base64')
	await writeFile(file, buffer)
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		...(payload.tabTitle === undefined ? {} : { title: payload.tabTitle }),
		...(payload.tabUrl === undefined ? {} : { url: payload.tabUrl }),
	}
}

/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
/**
 * 权限现状 → 给模型看的文本（`browser_permissions` 的全部载荷都拼在这里）。
 *
 * 措辞原则：**说清"谁能点"**。浏览器 chrome 自己的权限气泡（LNA 等）扩展既看不见也答不了，
 * 唯一能做的是把它读出来、并明确「需要用户本人处理」，避免模型把"有人在等人点"误诊成"页面卡了"。
 */
/**
 * `denyHosts` 的状态行（X14）。抽成纯函数是为了能被离线测试钉住 —— 关键点：
 * **名单存在 ≠ 名单生效**，`askMode=allow` 时它对策略没有作用（允许名单也一样被忽略），
 * 只有硬红线仍然生效。状态面藏着这件事，模型与用户就会按一份"其实不生效"的名单推理。
 * @param shown 已经截断/格式化好的名单文本（空时传 '（空）'）。
 * @param ignored 生效策略是否忽略了这份名单（askMode=allow）。
 */
/**
 * `browser_snapshot` 的模式判定：请求了 ax，扩展到底有没有真的给 ax？
 *
 * 三种情形必须分清（上游 v1.0.15 的教训）：
 *   ① 扩展回了 `mode:'ax'`         → 真 AX；
 *   ② 扩展回了 `axFallback`        → 它试过、落回 dom，把原因原样带出去；
 *   ③ 两者都没有（`mode` 字段也不存在）→ **旧扩展静默忽略**了 `mode:"ax"`，照样回 DOM 结果。
 *      这时必须由插件把"降级了"说出来 —— 否则模型以为自己拿的是无障碍名，实际是标签名。
 *
 * @param rawMode 扩展回包里的 `mode`（老扩展可能完全没有这个字段）
 * @param rawFallback 扩展回包里的 `axFallback`
 * @param wantAx 本次调用是否请求了 ax
 */
export function snapshotModeOf(
	rawMode: string | undefined,
	rawFallback: string | undefined,
	wantAx: boolean,
): { mode: 'ax' | 'dom'; axFallback?: string } {
	if (rawMode === 'ax') return { mode: 'ax' }
	if (rawFallback !== undefined && rawFallback.length > 0) return { mode: 'dom', axFallback: rawFallback }
	if (wantAx && rawMode === undefined) {
		return {
			mode: 'dom',
			axFallback: 'this extension ignored mode:"ax" and returned CSS-DOM matches (AX 模式需要 DSH Browser Control 扩展 ≥1.0.11) —— 下面的名字是标签名，不是可访问名',
		}
	}
	return { mode: 'dom' }
}

export function denyHostsStatusLine(shown: string, ignored: boolean): string {
	const base = `denyHosts: ${shown.length > 0 ? shown : '（空）'}`
	return ignored
		? `${base}  ⚠️ askMode=放行 ⇒ **本名单当前不生效**（该档连黑白名单一起忽略；硬红线仍生效）`
		: base
}

/** 扩展端 `emulate` 的原始回包（无 UA 覆盖时 `userAgent` 是**显式** `null`）。 */
export interface EmulateRawValue {
	tabId: number
	reset?: boolean | null
	width?: number | null
	height?: number | null
	deviceScaleFactor?: number | null
	isMobile?: boolean | null
	hasTouch?: boolean | null
	userAgent?: string | null
}

/**
 * 把扩展端 `emulate` 的回包按 `output.schema` 收口。
 *
 * 为什么必须有这一步：扩展在无 UA 覆盖时回的是**显式** `userAgent: null`
 * （`extension/background.js` 的 `userAgent: userAgent || null`），而宿主的输出校验器
 * 对 `null` **会下钻判类型**（只跳过 `undefined`）。原样透传时，`device:"desktop"`
 * 或只给宽高的自定义视口**每次调用**都会抛 `ToolOutputError` —— 即 `browser_emulate`
 * 从 v0.7 起对这两类调用全是坏的，只有带真 UA 的预设（mobile/tablet）能过，所以一直没暴露。
 */
export function normalizeEmulateValue(raw: EmulateRawValue): {
	tabId: number
	reset?: boolean
	width?: number
	height?: number
	deviceScaleFactor?: number
	isMobile?: boolean
	hasTouch?: boolean
	userAgent?: string
} {
	return {
		tabId: raw.tabId,
		...(raw.reset === true ? { reset: true } : {}),
		...(typeof raw.width === 'number' ? { width: raw.width } : {}),
		...(typeof raw.height === 'number' ? { height: raw.height } : {}),
		...(typeof raw.deviceScaleFactor === 'number' ? { deviceScaleFactor: raw.deviceScaleFactor } : {}),
		...(typeof raw.isMobile === 'boolean' ? { isMobile: raw.isMobile } : {}),
		...(typeof raw.hasTouch === 'boolean' ? { hasTouch: raw.hasTouch } : {}),
		...(typeof raw.userAgent === 'string' ? { userAgent: raw.userAgent } : {}),
	}
}

export function permissionReport(input: {
	origin: string
	tabId: number | undefined
	store: ReturnType<typeof readPermissionStore>
	readings: PermissionReading[]
	pendingLocal: ReadonlyArray<{ url: string; ageSeconds?: number }>
	requestedClass: string | undefined
	/** 读取时的形态转换说明（bi-013）：非空时在报告头上写一行，别让"静默换路径"发生。 */
	storeNote?: string
}): string {
	const lines: string[] = []
	lines.push(`origin = ${input.origin}${input.tabId === undefined ? '' : `（tab ${input.tabId}）`}`)
	lines.push(`权限存储 = ${input.store.file}`)
	if (input.storeNote !== undefined && input.storeNote.length > 0) lines.push(`          ${input.storeNote}`)
	lines.push(`          改于 ${input.store.modifiedAt.toLocaleString('sv-SE')}；本机共 ${input.store.classNames.length} 个权限类`)
	const detail = (reading: PermissionReading): string => {
		const e = reading.exception
		if (e === undefined) return `- ${reading.label} [${reading.pref}]｜触发：${reading.trigger}`
		const when = e.lastModified === undefined ? '' : `，${chromiumTime(e.lastModified)}`
		return `- ${reading.label} [${reading.pref}] = **${e.label}**${when}｜触发：${reading.trigger}`
	}
	const ask = input.readings.filter((r) => r.exception?.setting === CONTENT_SETTING.ASK)
	const allowed = input.readings.filter((r) => r.exception?.setting === CONTENT_SETTING.ALLOW || r.exception?.setting === CONTENT_SETTING.SESSION_ONLY)
	const denied = input.readings.filter((r) => r.exception?.setting === CONTENT_SETTING.BLOCK)
	const none = input.readings.filter((r) => r.exception === undefined)
	const networkAsk = ask.filter((r) => r.pref === 'loopback_network' || r.pref === 'local_network_access' || r.pref === 'local_network')
	const networkAllowed = allowed.filter((r) => r.pref === 'loopback_network' || r.pref === 'local_network_access' || r.pref === 'local_network')

	if (input.readings.length === 0 && input.requestedClass !== undefined) {
		// 指定的类不在受关注清单里：把本机**真实存在**的类摊开（不猜枚举值）。
		const rows = input.store.exceptions.get(input.requestedClass)
		if (rows !== undefined) {
			lines.push(`类 ${input.requestedClass} 在本机存在，该 origin 有记录：`)
			for (const [pattern, entry] of rows) lines.push(`- ${pattern} = ${entry.setting}`)
		} else if (input.store.classNames.includes(input.requestedClass)) {
			lines.push(`类 ${input.requestedClass} 在本机存在，但该 origin 没有例外记录（走浏览器默认）。`)
		} else {
			lines.push(`没有 ${input.requestedClass} 这个类。本机存在的类（前 24 个）：`)
			lines.push(input.store.classNames.slice(0, 24).join(', '))
		}
		return lines.join('\n')
	}

	if (ask.length > 0) {
		lines.push('')
		lines.push(`会弹窗（**询问** = 气泡拦人，只有用户本人能点）：${ask.length} 类`)
		for (const reading of ask) lines.push(detail(reading))
	}
	if (allowed.length > 0) {
		lines.push('')
		lines.push(`已允许（含仅本次会话）：${allowed.length} 类`)
		for (const reading of allowed) lines.push(detail(reading))
	}
	if (denied.length > 0) {
		lines.push('')
		lines.push(`已拒绝：${denied.length} 类`)
		for (const reading of denied) lines.push(detail(reading))
	}
	if (none.length > 0) {
		lines.push('')
		const names = none.map((r) => r.pref)
		lines.push(`无记录（走浏览器默认，默认多为"询问"）：${none.length} 类 —— ${names.slice(0, 12).join(', ')}${names.length > 12 ? ' …' : ''}`)
	}

	lines.push('')
	if (input.pendingLocal.length > 0) {
		const head = input.pendingLocal[0] as { url: string; ageSeconds?: number }
		const age = head.ageSeconds === undefined ? '' : `（已等 ${head.ageSeconds}s）`
		lines.push(`挂起信号：${input.pendingLocal.length} 个指向本机/私网的请求仍在等响应 —— 例 ${head.url}${age}`)
		if (networkAsk.length > 0) {
			lines.push(`⇒ **大概率正等「本地网络访问」气泡**：该类在当前 origin 是"询问"，而请求已经发出去了。`)
			lines.push('  扩展对这类 chrome 级气泡**不可见、也不代答** —— 需要用户在浏览器窗口里点「允许/拒绝」。')
			lines.push('  绕开办法：页面侧别 await 本机地址（fire-and-forget 或改走不访问本机的通道）。')
		} else if (networkAllowed.length > 0) {
			lines.push('⇒ 本地网络访问**已允许**，但仍挂起：更可能是对端没回（服务在不在？）或另有阻塞，不要当成权限问题。')
		} else {
			lines.push('⇒ 该 origin 没有本地网络访问的例外记录；若浏览器默认是"询问"，屏幕上可能正有一个气泡。')
		}
	} else if (ask.length > 0) {
		lines.push('当前没有挂起的本机请求；但上面这些"询问"类**一旦被页面触发就会弹窗拦人** —— 事前提醒用户可省一次超时排查。')
	} else if (none.length > 0) {
		// 别把"没有显式记录"说成"不会弹"：本机默认值表是空的，受关注类的浏览器默认**就是询问**。
		lines.push(`当前没有挂起的本机请求，也没有**显式**的"询问"记录；但有 ${none.length} 类无记录 ⇒ `
			+ '浏览器默认多为"询问"，页面一触发这些 API 仍会弹窗拦人（**别把"没记录"当成"不会弹"**）。')
	} else {
		lines.push('当前没有挂起的本机请求，受关注类也都有显式记录且无"询问"项。')
	}
	lines.push('本次为**只读**：我没有替你点任何气泡（也不会未经你配置就代答）。')
	return lines.join('\n')
}

function applyBrowserTools(ctx: Context, controller: BridgeController, getConfig: () => ResolvedConfig): void {
	ctx.systemPrompt.section({
		name: 'tool:browser',
		order: 112,
		text: 'The browser_* tools drive the user\'s real, logged-in browser through the DSH '
			+ 'Browser Control extension; they act on the active tab unless a tabId is passed. '
			+ 'Prefer browser_snapshot first on unfamiliar pages: it numbers interactive elements, '
			+ 'and browser_click/browser_type accept the returned ref instead of guessing CSS selectors. '
			+ 'browser_read extracts page text, browser_screenshot saves a PNG/JPEG and returns its file '
			+ 'path (view it with an image tool). Calls fail with actionable copy while the bridge is '
			+ 'disabled or no browser is connected. A navigation may be refused with WEB_* (blocked by '
			+ 'URL policy or a deny list; do not retry) or return NEED_AUTHORIZATION when the target '
			+ 'realm (internet/intranet) is in ask mode — request the user to approve that host (or add '
			+ 'it to allowHosts) instead of retrying the same target. browser_policy_status reports the '
			+ 'current mode, per-realm access, lists and session grants.',
	})

	ctx.tools.register(defineTool({
		name: 'browser_policy_status',
		description: "Read the browser bridge's URL and access policy: the switch, urlMode, the three realm settings (internet / LAN / loopback), temp grants, the allow and deny host lists, cloud-metadata blocking, and the grants already approved in this session. Read-only. Check it when a navigation was refused, or when you need to know whether a host still needs approval.",
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ok: { type: 'boolean', required: true },
					text: { type: 'string', required: true },
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		timeoutMs: 10_000,
		async execute() {
			const s = controller.describePolicy()
			const firstN = (list: readonly string[] | undefined, n = 6): string => {
				if (!Array.isArray(list)) return ''
				const head = list.slice(0, n).join(', ')
				return head + (list.length > n ? ` …共 ${list.length} 条` : '')
			}
			const lines: string[] = []
			lines.push(`启用: ${s.enabled ? '是' : '否'}${s.enabled && !s.ready ? '（桥未就绪）' : ''}`)
			if (s.enabled) {
				const mode = s.urlMode ?? 'public'
				const effRealm = (realm: 'internet' | 'lan' | 'local', raw?: string): string => {
					return raw ?? (mode === 'intranet' || realm === 'internet' ? 'allow' : 'deny')
				}
				const fmt = (label: string, realm: 'internet' | 'lan' | 'local', raw?: string, temp?: boolean): string => {
					const eff = effRealm(realm, raw)
					return `${label}: ${eff}${raw ? '（显式）' : '（预设）'}${temp === false ? '，无临时授权' : ''}`
				}
				lines.push(`网络预设: ${mode === 'intranet' ? '内网' : '公网'}${s.urlMode === undefined ? '（缺省公网）' : ''}`)
			lines.push(`桥接端口: ${s.boundPort ?? '（未启动）'}${s.portNote ? ' — ' + s.portNote : (s.requestedPort !== undefined && s.boundPort !== s.requestedPort ? `（配置 ${s.requestedPort}）` : '')}`)
				lines.push(`DSH 页面访问: ${s.dshAccessEnabled ? '开（' + (s.dshOrigins ?? []).join(', ') + '）' : '关'}`)
				lines.push(fmt('外网', 'internet', s.internetAccess, s.internetTemp))
				lines.push(fmt('局域网', 'lan', s.lanAccess, s.lanTemp))
				lines.push(fmt('本机', 'local', s.localAccess, s.localTemp))
				lines.push(`受限态 ask 策略: ${askModeZh(s.askMode)}`)
				lines.push(`自动拉起: ${s.autoLaunchEnabled ? '开（断开容忍 ' + (s.autoLaunchIdleSeconds ?? 15) + 's' + (s.autoLaunchProfileDir ? '，profile=' + (s.autoLaunchProfileName || path.basename(s.autoLaunchProfileDir)) : '') + '）' : '关'}`)
				lines.push(`浏览器配对: ${s.pairing !== undefined ? `${s.pairing.brandId} / ${s.pairing.profileDir}${s.pairing.profileName !== undefined ? `（${s.pairing.profileName}）` : ''} ← ${s.pairing.matchedBy} @ ${s.pairing.resolvedAt}` : '（还没有：需要装了扩展的浏览器先连上过一次）'}`)
				if (s.extensionId !== undefined) lines.push(`扩展自报: id=${s.extensionId}；浏览器=${s.browserName ?? '—'}`)
				if (s.launchNote !== undefined) lines.push(`上次定位失败: ${s.launchNote}`)
				lines.push(`allowHosts: ${firstN(s.allowHosts) || '（空）'}`)
				lines.push(denyHostsStatusLine(firstN(s.denyHosts), s.denyHostsIgnored === true))
				lines.push(`blockMetadata: ${s.blockMetadata === false ? '关' : '开'}；metadataHostnames: ${(s.metadataHostnames ?? []).length} 条；metadataIps: ${(s.metadataIps ?? []).length} 条`)
				lines.push(`本会话已授权主机: ${s.tempGrants.length > 0 ? s.tempGrants.join(', ') : '（无）'}`)
			}
			return { ok: true, text: lines.join('\n') }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_launch',
		description: "Wake the controlled browser. Two cases: (a) the extension is connected but there is no window (Edge keeps running after every window is closed, and every \"current tab\" command then fails) - ask the extension to open one; (b) the extension is not connected - start the configured browser (executable and profile). When a tool fails with \"no browser extension connected\", call this once, wait a few seconds, then retry that tool. Starts the browser only; no page is touched.",
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ok: { type: 'boolean', required: true },
					text: { type: 'string', required: true },
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.text }],
		},
		isConcurrencySafe: () => true,
		timeoutMs: 15_000,
		async execute() {
			const text = await controller.wakeBrowser()
			return { ok: true, text }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_navigate',
		description: "Navigate a tab to a URL and return once the load has settled. SPAs and micro-frontends often render after this call returns, so a title is not the same as content: if the text you read straight afterwards is empty or very short, read again with browser_read before drawing conclusions. To settle in one call, pass `waitSelector` / `waitText` / `waitFn`; the server then polls until the condition holds. A timeout does not fail the call - the result carries `waitTimedOut: true`.",
		parameters: {
			url: { type: 'string', required: true, description: 'Absolute URL to open in the tab.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			waitSelector: { type: 'string', description: 'After navigating, wait until this CSS selector exists (e.g. ".sku-plus, a[href*=goods]").' },
			waitText: { type: 'string', description: 'After navigating, wait until document.body.innerText contains this text.' },
			waitFn: { type: 'string', description: 'After navigating, wait until this JS predicate is truthy (function or bare boolean expression; e.g. "window.rawData !== null").' },
			waitTimeoutMs: { type: 'number', description: 'Budget for the wait above (100–120000; defaults to 15000).' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					url: { type: 'string' },
					title: { type: 'string' },
					siteUnreachable: { type: 'boolean' },
					pendingUrl: { type: 'string' },
					error: { type: 'string' },
					loadPending: { type: 'boolean' },
					waitedMs: { type: 'number' },
					waitTimedOut: { type: 'boolean' },
					waitAborted: { type: 'boolean' },
					waitError: { type: 'string' },
				},
			},
			render: (_args, value) => {
				const label = [value.title, value.url].filter(part => typeof part === 'string' && part.length > 0).join(' — ')
				const tail = value.siteUnreachable === true
					? ` — target unreachable${value.error ? `: ${value.error}` : ''}`
					: ''
				const pending = value.loadPending === true
					? ` — 页面**仍在加载**${typeof value.pendingUrl === 'string' && value.pendingUrl.length > 0 ? ` ${value.pendingUrl}` : ''}（15s 内没等到完成）：别单次采样就下结论，用 browser_wait 等条件或稍后复查`
					: ''
				const wait = typeof value.waitedMs === 'number'
					? value.waitTimedOut === true
						? ` — 等待条件在 ${value.waitedMs}ms 内**未成立**（不等于页面没有内容，可能只是慢；可加大 waitTimeoutMs 或换条件）`
						: value.waitAborted === true
							? ` — 等待**已中止**（${value.siteUnreachable === true
								? '页面不可达，原因见上'
								: String(value.waitError ?? '').slice(0, 160)}），不是"条件不成立"`
							: ` — 等待条件成立（${value.waitedMs}ms）`
					: ''
				return [{ type: 'text', text: `Tab ${value.tabId} now shows ${label.length > 0 ? label : '(untitled)'}${tail}${pending}${wait}` }]
			},
		},
		isConcurrencySafe: () => false,
		presentCall: args => ({ card: 'generic', title: `Open ${args.url}`, kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeNavigation(ctx, controller, args.url, exec, 'browser_navigate')
			const params: Record<string, unknown> = { url: args.url }
			if (args.tabId !== undefined) params.tabId = args.tabId
			const raw = await controller.execute('nav', params, exec.signal) as {
				tabId: number
				title?: string
				url?: string
				/** 布尔（老形状）或 `{reason:'dns'|'unreachable'}`（扩展实际返回的形状）。 */
				siteUnreachable?: boolean | { reason?: string }
				error?: string
				loadPending?: boolean
				pendingUrl?: string
			}
			const out: Record<string, unknown> = { tabId: raw.tabId }
			if (typeof raw.url === 'string') out.url = raw.url
			if (typeof raw.title === 'string') out.title = raw.title
			if (raw.loadPending === true) out.loadPending = true
			if (typeof raw.pendingUrl === 'string' && raw.pendingUrl.length > 0) out.pendingUrl = raw.pendingUrl
			// 形状容错（2026-10-10 实测缺陷）：扩展返回的是 `siteUnreachable: {reason}`，
			// 而这里以前判 `=== true` ⇒ 对象被整个丢掉，"页面连不上"从来没送到模型眼前，
			// 模型只看到一句"now shows <目标URL>"（于是以为成功）。
			const unreachable = raw.siteUnreachable === true
				|| (typeof raw.siteUnreachable === 'object' && raw.siteUnreachable !== null)
			if (unreachable) {
				out.siteUnreachable = true
				const reason = typeof raw.siteUnreachable === 'object' && raw.siteUnreachable !== null
					? raw.siteUnreachable.reason
					: undefined
				out.error = typeof raw.error === 'string' && raw.error.length > 0
					? raw.error
					: reason === 'dns' ? 'DNS 解析失败' : '无法连接（浏览器错误页）'
			}
			// bi-015：SPA 就绪等待。导航本身已经成功，所以等待超时**不**让整次调用失败，
			// 只在结果里标注 waitTimedOut —— 让模型能区分"慢"与"没有内容"。
			const waitCondition = describeWaitCondition(args)
			if (waitCondition !== undefined) {
				const budget = Math.min(120_000, Math.max(100, Math.trunc(args.waitTimeoutMs ?? 15_000)))
				const waitStartedAt = Date.now()
				try {
					const waited = await controller.execute('wait', {
						...waitCondition.params,
						timeoutMs: budget,
						tabId: raw.tabId,
					}, exec.signal) as { waited?: number }
					out.waitedMs = typeof waited?.waited === 'number' ? waited.waited : Date.now() - waitStartedAt
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					out.waitedMs = Date.now() - waitStartedAt
					out.waitError = message
					// 「等待超时」与「等待被中止」是两件事，不能都套超时话术：
					// 典型的中止是页面落到浏览器错误页（ERR_CONNECTION_TIMED_OUT）——
					// 那种情况还说"可能只是慢、加大预算"就是**误诊**（2026-10-10 真机实测）。
					if (/wait timeout after/i.test(message)) out.waitTimedOut = true
					else {
						out.waitAborted = true
						if (typeof out.error !== 'string') out.error = message
					}
				}
			}
			return out
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_wait',
		description: "Wait server-side until the page satisfies a condition, instead of sleeping or sampling once. Pass one of `selector` (element exists), `text` (body contains), `fn` (JS predicate truthy); returns how long it waited. Use it for SPA route changes, lazy lists, or waiting for a global. A timeout is reported as `wait timeout`: that only means the condition never held, not that the page is empty. browser_navigate only waits for the document, not for these.",
		parameters: {
			selector: { type: 'string', description: 'Wait until this CSS selector matches an element.' },
			text: { type: 'string', description: 'Wait until document.body.innerText contains this text.' },
			fn: { type: 'string', description: 'Wait until this JS predicate is truthy: a function ("() => x.ready") or a bare boolean expression ("document.querySelectorAll(\'a\').length > 5").' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			timeoutMs: { type: 'number', description: 'Wait budget in ms (100–120000; defaults to 15000).' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					waitedMs: { type: 'number', required: true },
					condition: { type: 'string', required: true },
				},
			},
			render: (_args, value) => textBlock(`条件成立：${value.condition}（等了 ${value.waitedMs}ms，tab ${value.tabId}）`),
		},
		presentCall: () => ({ card: 'generic', title: 'Wait for page condition', kind: 'other' as const }),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const condition = describeWaitCondition(args)
			if (condition === undefined) {
				throw new Error('browser_wait 需要 selector / text / fn 三者之一（一次只等一个条件）')
			}
			const budget = Math.min(120_000, Math.max(100, Math.trunc(args.timeoutMs ?? 15_000)))
			try {
				const waited = await controller.execute('wait', {
					...condition.params,
					timeoutMs: budget,
					...(args.tabId === undefined ? {} : { tabId: args.tabId }),
				}, exec.signal) as { tabId?: number; waited?: number }
				return {
					tabId: typeof waited?.tabId === 'number' ? waited.tabId : (args.tabId ?? -1),
					waitedMs: typeof waited?.waited === 'number' ? waited.waited : budget,
					condition: condition.label,
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error)
				throw new Error(`等待「${condition.label}」失败：${detail}`
					+ ' —— 这不等于"页面没有内容"：可能只是慢（加大 timeoutMs），也可能条件写错了（先用 browser_evaluate 验证该条件此刻的取值）。')
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_read',
		description: "Read the current page: title, URL, readyState, and the body text (pass `mode:'html'` for the full HTML). The returned text is what you see - no separate fetch. For a long page, read a window at a time with `offset` / `limit`; the head line tells you the next `offset=`.",
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			mode: { type: 'string', description: '"text" (default) for visible text, "html" for the whole document.' },
			offset: { type: 'number', description: 'Character index the window starts at; default 0. Use the "call again with offset=" value the previous result reported.' },
			limit: { type: 'number', description: `Characters to return; default and cap ${READ_WINDOW_MAX_CHARS}.` },
			frame: { type: 'string', description: 'Read one frame (name / #index / url substring). Omit to read the whole page; a <frameset> page is flattened automatically into per-frame sections.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					mode: { type: 'string', required: true },
					title: { type: 'string', required: true },
					url: { type: 'string', required: true },
					content: { type: 'string', required: true },
					truncated: { type: 'boolean', required: true },
					offset: { type: 'number', required: true },
					totalChars: { type: 'number', required: true },
				},
			},
			// 以前这里只回「标题 (URL) — N chars」，把 content 丢掉了 —— 模型因此**读不到页面正文**，
			// 只能靠 browser_evaluate 硬抠。现在把正文交给模型，并按窗口取（头部说明这是哪一段、
			// 下一段怎么取）—— 这样长页面可以连续读，而不是一次把 12 万字符倒进上下文。
			render: (_args, value) => {
				const end = value.offset + value.content.length
				const head = `${value.title} (${value.url}) [${value.mode}, chars ${value.offset}-${end} of ${value.totalChars}]`
					+ (value.truncated ? `; call again with offset=${end} to continue` : '')
				return [{ type: 'text', text: `${head}\n\n${value.content}` }]
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser page', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const mode = args.mode === 'html' ? 'html' : 'text'
			const params: Record<string, unknown> = { mode, flattenFrames: true }
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.frame !== undefined) params.frame = args.frame
			const raw = await controller.execute('content', params, exec.signal) as {
				tabId: number; title?: string; url?: string; content?: string; flattenedFrames?: number; readFrame?: string
			}
			// 窗口式读取（上游 v1.0.12 的口径）：扩展给的正文是完整的，切窗口在插件侧做，
			// 所以 totalChars 是**真实总长**，不是"桥截断后的长度"。
			const full = raw.content ?? ''
			const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0)
			const limit = Math.min(READ_WINDOW_MAX_CHARS, Math.max(1, Math.floor(Number(args.limit ?? READ_WINDOW_MAX_CHARS)) || READ_WINDOW_MAX_CHARS))
			const content = full.slice(offset, offset + limit)
			return {
				tabId: raw.tabId,
				mode,
				title: raw.title ?? '',
				url: raw.url ?? '',
				content,
				truncated: offset + content.length < full.length,
				offset,
				totalChars: full.length,
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_find',
		description: "List elements matching a CSS selector: total count, tag/id/class/text/href and viewport rect. Read-only. Meant for looking before clicking: how many match, and which one is the target. Versus browser_snapshot: snapshot returns numbered interactive elements (to click), find returns the precise description of the selector you named (to check).",
		parameters: {
			selector: { type: 'string', required: true, description: 'CSS selector to query.' },
			limit: { type: 'number', description: 'Maximum items to describe; defaults to 10, capped at 50 (count is always the full total).' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					selector: { type: 'string', required: true },
					count: { type: 'number', required: true },
					items: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								tag: { type: 'string', required: true },
								id: { type: 'string' },
								class: { type: 'string' },
								text: { type: 'string' },
								href: { type: 'string' },
								rect: { type: 'string', required: true },
							},
						},
					},
				},
			},
			// 模型看到的是这一行行 —— 不是一段 JSON。上游同名工具只回 `JSON.stringify(value)`，
			// 长列表会被宿主截断成半截 JSON（本项目的老毛病）。
			render: (_args, value) => {
				const head = `${value.count} 个匹配 \`${value.selector}\``
					+ (value.items.length < value.count ? `（只描述前 ${value.items.length} 个）` : '')
				const lines = value.items.map((item) => {
					const id = item.id ? `#${item.id}` : ''
					const cls = item.class ? `.${String(item.class).trim().split(/\s+/).slice(0, 2).join('.')}` : ''
					const text = item.text ? ` 「${item.text}」` : ''
					const href = item.href ? ` → ${item.href}` : ''
					return `${item.tag}${id}${cls} @${item.rect}${text}${href}`
				})
				return [{ type: 'text', text: [head, ...lines].join('\n') }]
			},
		},
		presentCall: args => ({ card: 'generic', title: `Find ${args.selector}`, kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = { selector: args.selector }
			if (args.limit !== undefined) params.limit = args.limit
			if (args.tabId !== undefined) params.tabId = args.tabId
			const raw = await controller.execute('find', params, exec.signal) as {
				tabId: number; selector?: string; count?: number
				items?: Array<{ tag: string; id?: string; class?: string; text?: string; href?: string; rect?: { x: number; y: number; w: number; h: number } }>
			}
			return {
				tabId: raw.tabId,
				selector: typeof raw.selector === 'string' ? raw.selector : String(args.selector),
				count: typeof raw.count === 'number' ? raw.count : (raw.items?.length ?? 0),
				items: (raw.items ?? []).map((item) => ({
					tag: item.tag,
					...(item.id ? { id: item.id } : {}),
					...(item.class ? { class: item.class } : {}),
					...(item.text ? { text: item.text } : {}),
					...(item.href ? { href: item.href } : {}),
					rect: item.rect ? `${item.rect.w}×${item.rect.h} @${item.rect.x},${item.rect.y}` : '?',
				})),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_dialog',
		description: "Read or set the answer for native alert / confirm / prompt: `accept` / `dismiss` / `manual`. Returns recent dialog records so you can prove one actually fired. Under `manual` the page blocks; the only way out then is `answer` for the dialog that is open right now - otherwise the tab has to be closed.",
		parameters: {
			policy: { type: 'string', description: 'Set this policy: accept | dismiss | manual. Omit to only read the current one.' },
			persist: { type: 'boolean', description: 'With policy: also write it to storage as the user preference (default: this run only).' },
			answer: { type: 'string', description: 'Answer the dialog that is open right now: accept | dismiss.' },
			promptText: { type: 'string', description: 'Text to type into a prompt() when answering with accept.' },
			tabId: { type: 'number', description: 'Tab for `answer` (defaults to the tab of the last dialog record).' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					policy: { type: 'string', required: true },
					changed: { type: 'boolean', required: true },
					answered: { type: 'string' },
					recent: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								tabId: { type: 'number' },
								type: { type: 'string', required: true },
								message: { type: 'string' },
								answeredAs: { type: 'string' },
								at: { type: 'string', required: true },
							},
						},
					},
				},
			},
			render: (_args, value) => {
				const head = `对话框策略 = ${value.policy}`
					+ (value.changed ? '（本次已改）' : '')
					+ (value.answered ? `；刚刚回答了：${value.answered}` : '')
				const log = value.recent.length === 0
					? '最近没有对话框记录。'
					: `最近的对话框（${value.recent.length} 条）：\n` + value.recent.map((row) =>
						`- [${row.type}] ${String(row.message ?? '').slice(0, 120)}${row.answeredAs ? ` → ${row.answeredAs}` : ''}${row.tabId === undefined ? '' : ` (tab ${row.tabId})`} @${row.at}`).join('\n')
				return [{ type: 'text', text: `${head}\n${log}` }]
			},
		},
		presentCall: args => ({ card: 'generic', title: args.policy ? `Dialog policy → ${args.policy}` : 'Read dialog policy', kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.policy !== undefined) params.policy = args.policy
			if (args.persist === true) params.persist = true
			if (args.answer !== undefined) params.answer = args.answer
			if (args.promptText !== undefined) params.promptText = args.promptText
			if (args.tabId !== undefined) params.tabId = args.tabId
			const raw = await controller.execute('dialog', params, exec.signal) as {
				policy?: string
				answered?: { tabId?: number; as?: string }
				recent?: Array<{ tabId?: number; type?: string; message?: string; answeredAs?: string; t?: number }>
			}
			return {
				policy: typeof raw.policy === 'string' ? raw.policy : 'manual',
				changed: args.policy !== undefined,
				...(raw.answered === undefined ? {} : { answered: `${String(raw.answered.as ?? '')}（tab ${String(raw.answered.tabId ?? '?')}）` }),
				recent: (raw.recent ?? []).map((row) => ({
					...(typeof row.tabId === 'number' ? { tabId: row.tabId } : {}),
					type: typeof row.type === 'string' ? row.type : 'dialog',
					...(typeof row.message === 'string' ? { message: row.message } : {}),
					...(typeof row.answeredAs === 'string' ? { answeredAs: row.answeredAs } : {}),
					at: typeof row.t === 'number' ? new Date(row.t).toISOString().slice(11, 19) : '?',
				})),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_info',
		description: "Report which browser and which extension build are actually connected, and whether the bridge and the extension agree on the protocol. Run this first when behaviour looks wrong: a stale extension or a wrong profile explains most oddities. Read-only.",
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					client: { type: 'string', required: true },
					extensionVersion: { type: 'string', required: true },
					browserName: { type: 'string', required: true },
					browserVersion: { type: 'string', required: true },
					userAgent: { type: 'string', required: true },
					bridgeProtocol: { type: 'number', required: true },
					extensionProtocol: { type: 'number', required: true },
					protocolCompatible: { type: 'boolean', required: true },
					protocolNote: { type: 'string' },
					port: { type: 'number' },
					urlMode: { type: 'string', required: true },
				},
			},
			render: (_args, value) => {
				const lines = [
					`扩展 ${value.client} v${value.extensionVersion} · ${value.browserName} ${value.browserVersion}`
					+ (value.port === undefined ? '' : ` · 桥端口 ${value.port}（urlMode=${value.urlMode}）`),
					`协议：桥 v${value.bridgeProtocol} / 扩展 v${value.extensionProtocol}`
					+ (value.protocolCompatible ? '（对得上）' : ` ⚠️ ${String(value.protocolNote ?? '不匹配')}`),
					`UA: ${value.userAgent}`,
				]
				return [{ type: 'text', text: lines.join('\n') }]
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Browser identity', kind: 'other' as const }),
		async execute(_args, exec) {
			const raw = await controller.execute('browser.info', {}, exec.signal) as {
				client?: string; version?: string; browser?: { name?: string; version?: string; ua?: string }
			}
			const s = controller.describePolicy()
			return {
				client: typeof raw.client === 'string' ? raw.client : 'unknown',
				extensionVersion: typeof raw.version === 'string' ? raw.version : 'unknown',
				browserName: typeof raw.browser?.name === 'string' ? raw.browser.name : 'unknown',
				browserVersion: typeof raw.browser?.version === 'string' ? raw.browser.version : 'unknown',
				userAgent: typeof raw.browser?.ua === 'string' ? raw.browser.ua : '',
				bridgeProtocol: typeof s.bridgeProtocol === 'number' ? s.bridgeProtocol : 1,
				extensionProtocol: typeof s.extensionProtocol === 'number' ? s.extensionProtocol : 0,
				protocolCompatible: s.protocolCompatible !== false,
				...(typeof s.protocolNote === 'string' && s.protocolNote.length > 0 ? { protocolNote: s.protocolNote } : {}),
				...(typeof s.boundPort === 'number' ? { port: s.boundPort } : {}),
				urlMode: typeof s.urlMode === 'string' ? s.urlMode : 'public',
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_snapshot',
		description: "List the page's interactive elements with stable refs; pass a ref to browser_click / browser_type. The default DOM pass covers native controls, ARIA role/tabindex/onclick, and div/span elements that only have a click handler (detected by cursor style boundaries; those entries carry `why=cursor`). `mode:'ax'` uses the accessibility tree (role + accessible name) instead, which survives redesigns better; when the page exposes no a11y tree it falls back to DOM and says so. If the element you want is not listed: locate it with browser_evaluate, give it an id, then `browser_click selector=#id`.",
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			limit: { type: 'number', description: 'Max elements returned; defaults to 120, capped at 200.' },
			mode: { type: 'string', description: '"dom" (default) for the selector list, "ax" for Chrome\'s accessibility tree (role + accessible name).' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					title: { type: 'string', required: true },
					url: { type: 'string', required: true },
					mode: { type: 'string', required: true },
					items: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								ref: { type: 'string', required: true },
								tag: { type: 'string', required: true },
								name: { type: 'string' },
								href: { type: 'string' },
								why: { type: 'string' },
								role: { type: 'string' },
								value: { type: 'string' },
							},
						},
					},
					axFallback: { type: 'string' },
				},
			},
			render: (_args, value) => {
				const lines = value.items.map((item) => {
					const name = typeof item.name === 'string' ? item.name.trim().replace(/\s+/g, ' ').slice(0, 140) : ''
					const href = typeof item.href === 'string' && item.href.length > 0 ? ` → ${item.href.slice(0, 140)}` : ''
					const role = typeof item.role === 'string' && item.role.length > 0 ? ` [${item.role}]` : ''
					const value_ = typeof item.value === 'string' && item.value.length > 0 ? ` =${item.value.slice(0, 60)}` : ''
					const why = typeof item.why === 'string' && item.why.length > 0 && item.why !== 'native' && item.why !== 'ax' ? ` (${item.why})` : ''
					return `${item.ref}\t<${item.tag}>${role}${name.length > 0 ? ' ' + name : ''}${value_}${href}${why}`
				})
				const cursorCount = value.items.filter((item) => item.why === 'cursor').length
				const head = value.mode === 'ax'
					? `a11y 树（role + 可访问名）`
					: `选择器判据`
				return textBlock(`${value.title} (${value.url})\n共 ${value.items.length} 个可交互元素（${head}）`
					+ `${cursorCount > 0 ? `（其中 ${cursorCount} 个是"只有点击处理器的元素"，按 cursor:pointer 边界识别）` : ''}`
					+ `${value.axFallback === undefined ? '' : `\n⚠️ 请求了 mode:"ax" 但落回了 dom：${value.axFallback}`}`
					+ `（每行第一列就是 ref，可直接传给 browser_click / browser_type）：\n${lines.join('\n')}`)
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Snapshot browser page', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const limit = Math.min(200, Math.max(1, args.limit ?? 120))
			const wantAx = args.mode === 'ax'
			const params: Record<string, unknown> = { limit }
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (wantAx) params.mode = 'ax'
			const raw = await controller.execute('snapshot', params, exec.signal) as {
				tabId: number; title?: string; url?: string; mode?: string; axFallback?: string
				items?: Array<{ ref: string; tag: string; name?: string; href?: string; why?: string; role?: string; value?: string }>
			}
			const judged = snapshotModeOf(raw.mode, raw.axFallback, wantAx)
			return {
				tabId: raw.tabId,
				title: raw.title ?? '',
				url: raw.url ?? '',
				mode: judged.mode,
				...(judged.axFallback === undefined ? {} : { axFallback: judged.axFallback }),
				items: (raw.items ?? []).map(item => ({
					ref: item.ref,
					tag: item.tag,
					...(item.name === undefined ? {} : { name: item.name }),
					...(item.href === undefined ? {} : { href: item.href }),
					...(item.why === undefined ? {} : { why: item.why }),
					...(item.role === undefined ? {} : { role: item.role }),
					...(item.value === undefined ? {} : { value: item.value }),
				})),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_click',
		description: "Click an element with real mouse events; target it by a snapshot ref or a CSS selector. The target tab is brought to the front first (real events must land on a visible page), so background tabs work too. On logged-in pages and SPAs, JS `el.click()` often does not trigger navigation - this tool uses the real event path. If the window is minimized the viewport is 0x0 and input cannot be delivered: the call fails loudly instead of pretending.",
		parameters: {
			ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e3"); wins over selector.' },
			selector: { type: 'string', description: 'CSS selector; ignored when ref is given.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			doubleClick: { type: 'boolean', description: 'Send a double click instead.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 2000) }],
		},
		presentCall: args => ({ card: 'generic', title: `Click ${args.ref ?? args.selector ?? ''}`, kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = { selector: targetSelector(args) }
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.doubleClick !== undefined) params.doubleClick = args.doubleClick
			return await controller.execute('click', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_type',
		description: "Fill an input / textarea / select / contentEditable, with React-compatible events. `submit:true` presses Enter once afterwards. Like browser_click, it brings the target tab to the front; with the window minimized, real input cannot be delivered and the call fails loudly.",
		parameters: {
			value: { type: 'string', required: true, description: 'Text to put into the element.' },
			ref: { type: 'string', description: 'Element ref from browser_snapshot; wins over selector.' },
			selector: { type: 'string', description: 'CSS selector; ignored when ref is given.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			submit: { type: 'boolean', description: 'Press Enter after filling.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 2000) }],
		},
		presentCall: args => ({ card: 'generic', title: `Type into ${args.ref ?? args.selector ?? 'element'}`, kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = { selector: targetSelector(args), value: args.value }
			if (args.tabId !== undefined) params.tabId = args.tabId
			const filled = await controller.execute('input', params, exec.signal) as Record<string, JsonValue>
			if (args.submit === true) {
				await controller.execute('press', args.tabId === undefined ? { key: 'Enter' } : { key: 'Enter', tabId: args.tabId }, exec.signal)
			}
			return filled
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_press',
		description: "Send one real key event: Enter / Tab / Escape / arrows, or a single character. Combinations can be written as `key:'Ctrl+A'` or as `key:'a'` plus `modifiers:['ctrl']`. Unknown key names or modifiers fail loudly and list the valid values.",
		parameters: {
			key: { type: 'string', required: true, description: 'Named key (Enter, Escape, ArrowDown…) or a single character.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 2000) }],
		},
		presentCall: args => ({ card: 'generic', title: `Press ${args.key}`, kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = { key: args.key }
			if (args.tabId !== undefined) params.tabId = args.tabId
			return await controller.execute('press', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_scroll',
		description: "Scroll the page viewport by a pixel delta and return the resulting position.",
		parameters: {
			x: { type: 'number', description: 'Horizontal delta in pixels; defaults to 0.' },
			y: { type: 'number', description: 'Vertical delta in pixels; positive scrolls down.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 2000) }],
		},
		presentCall: () => ({ card: 'generic', title: 'Scroll browser page', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = { x: args.x ?? 0, y: args.y ?? 0 }
			if (args.tabId !== undefined) params.tabId = args.tabId
			return await controller.execute('scroll', params, exec.signal) as Record<string, JsonValue>
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_tabs',
		description: "List tabs, or open / close / activate / group / ungroup them; actions apply to real browser windows. Closing takes a batch: `tabIds` (array), `urlPattern` (substring or /regex/), or `others:true` (everything except `tabId`), one command for the whole batch, and every id is accounted for (closed / already gone / failed), so a retry is safe. Tabs the agent opened land in a blue `DSH` group in the current window (`group:false` opts out); `ungroup` only removes the grouping and never closes anything. `list` reports each tab's group; `groupTitle` narrows it to one group.",
		parameters: {
			action: { type: 'string', required: true, description: 'One of: list, open, close, activate, group, ungroup.' },
			url: { type: 'string', description: 'URL for the open action.' },
			tabId: { type: 'number', description: 'Target tab for close/activate/group; with others:true it is the one to KEEP.' },
			tabIds: { type: 'array', items: { type: 'number' }, description: 'close: explicit list of tab ids to close.' },
			urlPattern: { type: 'string', description: 'close: only tabs whose URL contains this substring, or a /regex/ form.' },
			others: { type: 'boolean', description: 'close: close every tab except tabId (defaults the kept tab to the active one).' },
			active: { type: 'boolean', description: 'Whether a newly opened tab becomes active; defaults to true.' },
			group: { type: 'boolean', description: 'open: put the new tab in the DSH group (default true); pass false to keep it loose.' },
			windowId: { type: 'number', description: 'ungroup: dissolve only that window\'s DSH group; omit to clear every window.' },
			groupTitle: { type: 'string', description: 'list: only tabs whose tab-group title equals this value (e.g. "DSH").' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => {
				const tabs = Array.isArray(value?.tabs) ? value.tabs : []
				// 归组/拆组/开标签的结果也给人话，不落回 JSON（模型读 JSON 容易漏字段）。
				// 分组归属直接标在每行开头：`[DSH]` —— 原来看不见组，只能靠人眼看浏览器窗口顶部。
				if (value && typeof value.ungrouped === 'number') {
					return textBlock(`已解除 ${value.ungrouped} 个标签的归属（${value.groups ?? 0} 个 DSH 分组）`
						+ `${value.reason === undefined ? '' : ` —— ${String(value.reason)}`}`
						+ `。只解除归属，**没有关闭任何标签页**。`)
				}
				// 只在"纯归组动作"上走这条：open 的结果里也带 grouped，但它要连地址一起说（下面那条）。
				if (value && value.grouped === true && value.url === undefined) {
					return textBlock(`tab ${value.tabId} 已归入 DSH 分组（groupId=${value.groupId}，${value.created === true ? '新建' : '复用已有的'}）`)
				}
				if (value && value.grouped === false && value.reason !== undefined && value.tabId !== undefined && value.url !== undefined) {
					return textBlock(`已打开 tab ${value.tabId}：${String(value.title ?? '')} — ${String(value.url)}`
						+ `${value.pendingUrl === undefined ? '' : `（正在加载 ${String(value.pendingUrl)}）`}`
						+ `；**没归组**：${String(value.reason)}`)
				}
				if (tabs.length === 0) {
					if (Array.isArray(value?.closedIds)) {
						const gone = Array.isArray(value.alreadyGone) && value.alreadyGone.length > 0 ? `；本来就不在了：${value.alreadyGone.join(', ')}` : ''
						const failed = Array.isArray(value.failedIds) && value.failedIds.length > 0
							? `；失败：${value.failedIds.map((row: { id: number }) => row.id).join(', ')}`
							: ''
						return textBlock(`已关闭 ${value.closed ?? value.closedIds.length} 个标签页：${value.closedIds.join(', ')}${gone}${failed}`)
					}
					if (value && typeof value.tabId === 'number' && value.url !== undefined) {
						return textBlock(`已打开 tab ${value.tabId}：${String(value.title ?? '')} — ${String(value.url)}`
							+ `${value.pendingUrl === undefined ? '' : `（正在加载 ${String(value.pendingUrl)}）`}`
							+ `${value.grouped === true ? '；已归入 DSH 分组' : ''}`
							+ `${value.loadPending === true ? '；⚠️ 还没等到落地，别当已就绪' : ''}`)
					}
					return textBlock(JSON.stringify(value))
				}
				const lines = tabs.map((tab) => {
					const badge = typeof tab.groupTitle === 'string' && tab.groupTitle.length > 0 ? `[${tab.groupTitle}] ` : ''
					return `${tab.id}\t${tab.active === true ? 'active' : '      '}\t${badge}${String(tab.title ?? '')} — ${String(tab.url ?? '')}`
				})
				const groups = Array.isArray(value.groups) ? value.groups : []
				const groupLine = groups.length === 0
					? ''
					: `\n分组：${groups.map((g) => `${String(g.title ?? '') || '(无标题)'}（${tabs.filter((t) => t.groupId === g.id).length} 个标签）`).join(' / ')}`
				const head = `窗口 ${value.windows ?? '?'} 个，标签页 ${value.count ?? tabs.length} 个`
					+ `（activeTabId=${value.activeTabId ?? '?'}${value.noWindow === true ? '，当前没有任何窗口' : ''}）`
				return textBlock(`${head}${groupLine}\n${lines.join('\n')}`)
			},
		},
		presentCall: args => ({ card: 'generic', title: `Browser tabs: ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			switch (args.action) {
				case 'list': {
					const listed = await controller.execute('tabs.list', {}, exec.signal) as {
						tabs?: Array<{ id?: number; groupTitle?: string }>; groups?: Array<{ id?: number; title?: string }>
					} & Record<string, JsonValue>
					const wantGroup = typeof args.groupTitle === 'string' && args.groupTitle.length > 0 ? args.groupTitle : undefined
					if (wantGroup === undefined) return listed
					const all = Array.isArray(listed.tabs) ? listed.tabs : []
					const kept = all.filter((tab) => (tab.groupTitle ?? '') === wantGroup)
					return {
						...listed,
						count: kept.length,
						tabs: kept,
						note: `只列分组「${wantGroup}」：匹配 ${kept.length} 个（全部 ${all.length} 个）`,
					} as Record<string, JsonValue>
				}
				case 'open': {
					if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('open requires url')
					await authorizeNavigation(ctx, controller, args.url, exec, 'browser_tabs')
					const params: Record<string, unknown> = { url: args.url }
					if (args.active !== undefined) params.active = args.active
					if (args.group === false) params.group = false
					return await controller.execute('tabs.open', params, exec.signal) as Record<string, JsonValue>
				}
				case 'close': {
					// 单页签：保持老语义（tabId）。
					const explicit = Array.isArray(args.tabIds) ? args.tabIds.filter((id): id is number => typeof id === 'number') : []
					const others = args.others === true
					const pattern = typeof args.urlPattern === 'string' && args.urlPattern.length > 0 ? args.urlPattern : undefined
					if (explicit.length === 0 && !others && pattern === undefined) {
						return await controller.execute('tabs.close', { tabId: requireTabId(args, 'close') }, exec.signal) as Record<string, JsonValue>
					}
					const listed = await controller.execute('tabs.list', {}, exec.signal) as { tabs?: Array<{ id?: number; url?: string; active?: boolean }>; activeTabId?: number }
					const tabs = Array.isArray(listed?.tabs) ? listed.tabs : []
					const keep = typeof args.tabId === 'number'
						? args.tabId
						: (typeof listed?.activeTabId === 'number' ? listed.activeTabId : tabs.find(tab => tab.active === true)?.id)
					const matcher = pattern === undefined ? undefined : compileUrlPattern(pattern)
					const wantClose = (tab: { id?: number; url?: string }): boolean => {
						if (typeof tab.id !== 'number') return false
						if (matcher !== undefined) return matcher(tab.url ?? '')
						if (explicit.length > 0) return explicit.includes(tab.id)
						if (others) return tab.id !== keep
						return false
					}
					const targets = tabs.filter(wantClose).map(tab => tab.id as number)
					if (targets.length === 0) {
						return { closed: 0, closedIds: [], note: `没有匹配的标签页（现有 ${tabs.length} 个；matcher=${pattern ?? (others ? `others(keep=${String(keep)})` : 'tabIds')}）` }
					}
					// 匹配逻辑在插件侧（我们的 tabIds/urlPattern/others 比上游丰富），**关闭本身**交给
					// 扩展的 `tabs.closeMany`：一条命令、一份超时预算，而且它逐 id 交代
					// （closed / alreadyGone / failed）—— 不必再"一个一个关、失败就停"。
					const result = await controller.execute('tabs.closeMany', { tabIds: targets }, exec.signal) as {
						requested?: number; closed?: number[]; alreadyGone?: number[]; failed?: Array<{ tabId: number; error?: string }>
					}
					const closedIds = Array.isArray(result?.closed) ? result.closed : []
					const goneIds = Array.isArray(result?.alreadyGone) ? result.alreadyGone : []
					const failedIds = (Array.isArray(result?.failed) ? result.failed : []).map(row => ({ id: row.tabId, error: String(row.error ?? '') }))
					return {
						closed: closedIds.length,
						closedIds,
						...(goneIds.length === 0 ? {} : { alreadyGone: goneIds }),
						...(failedIds.length === 0 ? {} : { failedIds }),
						...(closedIds.length === 0 && failedIds.length === 0
							? { note: `匹配到 ${targets.length} 个，但一个都没关掉（可能都已不存在）` }
							: {}),
					}
				}
				case 'activate':
					return await controller.execute('tabs.activate', { tabId: requireTabId(args, 'activate') }, exec.signal) as Record<string, JsonValue>
				case 'group':
					return await controller.execute('tabs.group', { tabId: requireTabId(args, 'group') }, exec.signal) as Record<string, JsonValue>
				case 'ungroup': {
					const params: Record<string, unknown> = {}
					if (typeof args.windowId === 'number') params.windowId = args.windowId
					return await controller.execute('tabs.ungroup', params, exec.signal) as Record<string, JsonValue>
				}
				default:
					throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate|group|ungroup)`)
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_hold',
		description: "Put a cancellable take-over overlay on a tab so the user does not mis-click or mis-read while you work: the page dims and a card shows what you are doing. The card title is fixed by the extension (the model cannot change it); your arguments fill only the body text. The user takes the page back by double-clicking anywhere (two clicks within 600ms): the overlay disappears, the tab is theirs, and `status` reports `dismissedBy:'user'`. The card's Abort button needs a confirming second click; once the user presses it, your click / input / press / nav on that tab are refused until you call `action=off` (which counts as confirming you continue). Your own clicks still land. The overlay sits above the page and does not change page logic; navigation clears it, and `status` reports what is actually on screen instead of pretending. It does not steal focus or block keys by default; pass `blockKeys:true` to freeze input too. Keyboard equivalent of the double click: press Escape twice within 800ms, or hold it for 600ms.",
		parameters: {
			action: { type: 'string', required: true, description: 'One of: on, off, status.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			text: { type: 'string', description: 'on: body text — say what you are doing (e.g. 正在把「局域网」档改成放行).' },
			blockKeys: { type: 'boolean', description: 'on: also freeze keyboard input (default false = zero interference; page listeners stay untouched).' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					action: { type: 'string', required: true },
					active: { type: 'boolean', required: true },
					dismissedBy: { type: 'string' },
					text: { type: 'string' },
					shownWho: { type: 'string' },
					aborted: { type: 'boolean' },
				},
			},
			render: (_args, value) => {
				if (value.action === 'status') {
					if (value.active === true) return textBlock(`tab ${value.tabId}：浮层仍在（用户还没接管）`)
					if (value.dismissedBy === 'abort') return textBlock(`tab ${value.tabId}：**用户按了「中止操作」** —— 你接下来的 click/input/press/nav 会被拒；先问用户，确认后调 browser_hold action=off 解除`)
					if (value.dismissedBy === 'user') return textBlock(`tab ${value.tabId}：**用户已双击接管**，浮层已撤 —— 继续驱动这个页面之前先跟用户确认`)
					return textBlock(`tab ${value.tabId}：当前没有浮层`)
				}
				if (value.action === 'off') return textBlock(`已解除 tab ${value.tabId} 的浮层`)
				return textBlock(`已锁住 tab ${value.tabId}：${String(value.text ?? '')}`
					+ `${typeof value.shownWho === 'string' && value.shownWho.length > 0 ? `\n浮层底部已标明：${value.shownWho}` : ''}`
					+ `\n用户双击任意处可接管；你的点击/输入照常可用。`)
			},
		},
		presentCall: args => ({ card: 'generic', title: `Browser hold: ${args.action}`, kind: 'other' as const }),
		timeoutMs: 15_000,
		async execute(args, exec) {
			const action = String(args.action)
			if (action !== 'on' && action !== 'off' && action !== 'status') throw new Error('hold action must be on|off|status')
			if (action !== 'status') await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (action === 'on') {
				if (typeof args.text === 'string') params.text = args.text
				if (args.blockKeys === true) params.blockKeys = true
				// 浮层上"是谁在操作"这一行**由插件从运行时上下文填**，模型只能填正文 text。
				// 这样模型没法在浮层上伪造身份（标题也已被扩展写死）。
				const agent = exec.agent as unknown as {
					options?: { provider?: unknown; model?: unknown }
					session?: { id?: unknown; header?: { cwd?: unknown; agentPreset?: unknown } }
				} | undefined
				const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : undefined
				const short = sessionId === undefined ? undefined : sessionId.replace(/^session-/, '').slice(0, 8)
				// 主人 2026-10-17：底部**不要模型名，要会话标题**（更好辨认，也更难伪造）
				const title = sessionId === undefined ? undefined : sessionTitleOf(sessionId)
				const cwd = typeof agent?.session?.header?.cwd === 'string'
					? agent.session.header.cwd
					: undefined
				const port = controller.describePolicy().boundPort
				params.meta = {
					...(title !== undefined ? { session: title } : short === undefined ? {} : { session: short }),
					...(cwd === undefined ? {} : { cwd: cwd.replace(/^\/home\/[^/]+/, '~') }),
					...(typeof port === 'number' ? { port } : {}),
					at: Date.now(),
				}
			}
			const shownWho = action === 'on' && typeof params.meta === 'object' && params.meta !== null
				? Object.entries(params.meta as Record<string, unknown>)
					.filter(([k, v]) => k !== 'at' && (typeof v === 'string' || typeof v === 'number') && String(v).length > 0)
					.map(([k, v]) => `${k === 'session' ? '会话' : k === 'model' ? '模型' : k === 'cwd' ? '目录' : k === 'port' ? '桥' : k}=${String(v)}`)
					.join(' · ')
				: undefined
			const raw = await controller.execute(`hold.${action}`, params, exec.signal) as {
				tabId?: number; active?: boolean; dismissedBy?: string | null; text?: string; aborted?: boolean
			}
			return {
				tabId: typeof raw?.tabId === 'number' ? raw.tabId : (args.tabId ?? -1),
				action,
				active: raw?.active === true,
				...(typeof raw?.dismissedBy === 'string' && raw.dismissedBy.length > 0 ? { dismissedBy: raw.dismissedBy } : {}),
				...(raw?.aborted === true ? { aborted: true } : {}),
				...(typeof raw?.text === 'string' && raw.text.length > 0 ? { text: raw.text } : {}),
				...(shownWho === undefined ? {} : { shownWho }),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_evaluate',
		description: "Run JavaScript in the page and get the JSON result back as a string; stay read-only if reading is enough. The expression runs as an async function body (top-level `await` works) and a returned promise is awaited up to `timeoutMs` (default 15s). Notes: (1) do not poll or sleep inside the expression - a timeout (`eval timeout after Nms`) looks exactly like \"no content\", so wait with browser_wait instead; (2) only serializable data comes back, so stringify DOM nodes or circular structures yourself; (3) `history.pushState` changes the URL only and does not re-render an SPA, so extracting after it reads the previous page - navigate with browser_navigate instead.",
		parameters: {
			expression: { type: 'string', required: true, description: 'JavaScript to run as an async function body (top-level await is fine).' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			timeoutMs: { type: 'number', description: 'Evaluation budget in ms (100–120000; defaults to 15000). Bump it for deliberately slow pages instead of guessing.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					json: { type: 'string', required: true },
				},
			},
			render: (_args, value) => textBlock(String(value.json ?? '')),
		},
		presentCall: () => ({ card: 'generic', title: 'Evaluate in page', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = { expression: args.expression }
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.timeoutMs !== undefined) {
				const budget = Math.min(120_000, Math.max(100, Math.trunc(args.timeoutMs)))
				params.timeoutMs = budget
			}
			const raw = await controller.execute('eval', params, exec.signal) as { tabId: number; value: unknown }
			let json: string
			try {
				json = JSON.stringify(raw.value) ?? String(raw.value)
			} catch {
				json = String(raw.value)
			}
			return { tabId: raw.tabId, json }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_screenshot',
		description: "Capture the tab as PNG / JPEG into the configured shots directory and return the absolute path.",
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			fullPage: { type: 'boolean', description: 'Capture beyond the viewport.' },
			format: { type: 'string', description: '"png" (default) or "jpeg".' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					file: { type: 'string', required: true },
					bytes: { type: 'number', required: true },
					tabId: { type: 'number', required: true },
					title: { type: 'string' },
					url: { type: 'string' },
				},
			},
			render: (_args, value) => [{ type: 'text', text: `Saved ${value.file} (${value.bytes} bytes)` }],
		},
		presentCall: () => ({ card: 'generic', title: 'Browser screenshot', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const format = args.format === 'jpeg' ? 'jpeg' : 'png'
			const params: Record<string, unknown> = { format }
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.fullPage !== undefined) params.fullPage = args.fullPage
			const payload = await controller.execute('screenshot', params, exec.signal) as ScreenshotPayload
			return saveScreenshot(controller, payload)
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_cleanup',
		description: "Delete generated screenshots plus `__`-prefixed scratch scripts and artifacts from their top-level directories.",
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					shotsRemoved: { type: 'number', required: true },
					scratchRemoved: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `Cleaned ${value.shotsRemoved} screenshot(s) and ${value.scratchRemoved.length} scratch file(s)`,
			}],
		},
		presentCall: () => ({ card: 'generic', title: 'Clean up browser artifacts', kind: 'other' as const }),
		async execute() {
			const result = await controller.cleanup()
			return { shotsRemoved: result.shotsRemoved, scratchRemoved: Array.from(result.scratchRemoved) }
		},
	}))

	// v1.0.7: console + network capture, PDF export, device emulation.

	// Row schemas for the capture tools. `additionalProperties: false` with an
	// empty `properties` map declares an object that has NO legal property, so
	// every real row used to fail output validation and both tools always
	// errored. Declare the fields the extension actually records, and keep the
	// rows open (`additionalProperties: true`) so a future capture field can
	// never silently break the whole tool again.
	const consoleEntrySchema = {
		type: 'object',
		additionalProperties: true,
		properties: {
			tabId: { type: 'number', description: 'Tab the entry was captured in.' },
			level: { type: 'string', description: 'Console level: log/info/warn/error/debug.' },
			text: { type: 'string', description: 'Formatted argument text.' },
			t: { type: 'number', description: 'Capture time (epoch ms).' },
			location: { type: 'string', description: 'Source location "url:line" when the stack trace has one.' },
		},
	}
	const networkRequestSchema = {
		type: 'object',
		additionalProperties: true,
		properties: {
			method: { type: 'string' },
			url: { type: 'string' },
			headers: { type: 'json', description: 'Request headers as sent.' },
			resourceType: { type: 'string', description: 'CDP resource type (XHR/Fetch/Document/…).' },
			postData: { type: 'string', description: 'Request body, capped at 64KB by the extension.' },
			initiator: { type: 'string', description: 'Initiator URL when CDP reports one.' },
			wallTime: { type: 'number', description: 'Request start time (CDP wall clock).' },
			status: { type: 'number', description: 'Response status; absent while pending.' },
			statusText: { type: 'string' },
			mimeType: { type: 'string' },
			responseHeaders: { type: 'json' },
			encodedDataLength: { type: 'number', description: 'Transfer size; set once loading finishes.' },
			finished: { type: 'boolean', description: 'True when Network.loadingFinished arrived.' },
			failed: { type: 'boolean', description: 'True when Network.loadingFailed arrived.' },
			errorText: { type: 'string', description: 'Failure reason when failed is true.' },
			canceled: { type: 'boolean' },
		},
	}

	ctx.tools.register(defineTool({
		name: 'browser_console_log',
		description: "Read the `console.log/info/warn/error` entries captured for a tab. `clear:true` empties the buffer too, so the next call shows only entries recorded after this one.",
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			levels: { type: 'array', items: { type: 'string' }, description: 'Filter to one or more of: log, info, warn, error, debug.' },
			pattern: { type: 'string', description: 'Regex (case-insensitive) matched against the formatted text.' },
			limit: { type: 'number', description: 'Maximum entries to return; default 100, capped at 500.' },
			clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					count: { type: 'number', required: true },
					total: { type: 'number', required: true },
					entries: { type: 'array', required: true, items: consoleEntrySchema },
				},
			},
			render: (_args, value) => {
				const lines = (value.entries ?? []).map((entry) => {
					const time = typeof entry.t === 'number' ? new Date(entry.t).toLocaleTimeString() : ''
					const location = typeof entry.location === 'string' && entry.location.length > 0 ? `  @ ${entry.location}` : ''
					return `${time} [${entry.level ?? 'log'}] ${String(entry.text ?? '').slice(0, 500)}${location}`
				})
				return textBlock(`Tab ${value.tabId}: ${value.count} of ${value.total} console entries\n${lines.join('\n')}`)
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser console', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (Array.isArray(args.levels)) params.levels = args.levels
			if (typeof args.pattern === 'string') params.pattern = args.pattern
			if (typeof args.limit === 'number') params.limit = args.limit
			if (args.clear === true) params.clear = true
			return await controller.execute('console.log', params, exec.signal) as { tabId: number; count: number; total: number; entries: Array<Record<string, unknown>> }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_network_log',
		description: "Read captured HTTP request/response pairs for a tab. Static resources are filtered out by default; `includeStatic:true` adds images, fonts, stylesheets and scripts. `methodPattern` / `urlPattern` / `status` filter server-side; `clear:true` empties the buffer.",
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			includeStatic: { type: 'boolean', description: 'Include images / fonts / stylesheets / scripts. Default false.' },
			methodPattern: { type: 'string', description: 'Regex (case-insensitive) matched against the HTTP method.' },
			urlPattern: { type: 'string', description: 'Regex (case-insensitive) matched against the URL.' },
			status: { type: 'string', description: 'One of: 2xx, 3xx, 4xx, 5xx, failed, pending.' },
			limit: { type: 'number', description: 'Maximum entries to return; default 200, capped at 1000.' },
			clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					count: { type: 'number', required: true },
					total: { type: 'number', required: true },
					requests: { type: 'array', required: true, items: networkRequestSchema },
				},
			},
			render: (_args, value) => {
				const lines = (value.requests ?? []).map((request) => {
					const status = typeof request.status === 'number' ? String(request.status) : (request.failed === true ? 'FAILED' : 'pending')
					const size = typeof request.encodedDataLength === 'number' && request.encodedDataLength > 0 ? ` ${request.encodedDataLength}B` : ''
					const error = request.failed === true && typeof request.errorText === 'string' ? ` — ${request.errorText}` : ''
					const type = typeof request.resourceType === 'string' && request.resourceType.length > 0 ? ` [${request.resourceType}]` : ''
					return `${status}${size}${type}\t${request.method ?? 'GET'} ${String(request.url ?? '').slice(0, 300)}${error}`
				})
				return textBlock(`Tab ${value.tabId}: ${value.count} of ${value.total} network requests\n${lines.join('\n')}`)
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser network log', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.includeStatic === true) params.includeStatic = true
			if (typeof args.methodPattern === 'string') params.methodPattern = args.methodPattern
			if (typeof args.urlPattern === 'string') params.urlPattern = args.urlPattern
			if (typeof args.status === 'string') params.status = args.status
			if (typeof args.limit === 'number') params.limit = args.limit
			if (args.clear === true) params.clear = true
			return await controller.execute('network.log', params, exec.signal) as { tabId: number; count: number; total: number; requests: Array<Record<string, unknown>> }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_network_clear',
		description: "Empty the per-tab network capture buffer without returning the rows.",
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					cleared: { type: 'boolean', required: true },
				},
			},
			render: (_args, value) => [{ type: 'text', text: `Tab ${value.tabId}: network log cleared` }],
		},
		presentCall: () => ({ card: 'generic', title: 'Clear browser network log', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			return await controller.execute('network.clear', params, exec.signal) as { tabId: number; cleared: boolean }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_pdf',
		description: "Export the current page to PDF: `path` saves to that absolute path, otherwise it lands in the configured directory. Returns the path and size; the PDF keeps selectable text and print styles.",
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			path: { type: 'string', description: 'Absolute path. Omit to save under the configured shotsDir with a timestamped name.' },
			landscape: { type: 'boolean', description: 'Use landscape orientation.' },
			printBackground: { type: 'boolean', description: 'Render CSS backgrounds. Default true.' },
			paperWidth: { type: 'number', description: 'Paper width in inches.' },
			paperHeight: { type: 'number', description: 'Paper height in inches.' },
			scale: { type: 'number', description: 'Page scale (0.1–2.0).' },
			pageRanges: { type: 'string', description: 'Sub-range, e.g. "1-3" or "1,4-6".' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					file: { type: 'string', required: true },
					bytes: { type: 'number', required: true },
					tabId: { type: 'number', required: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `PDF written to ${value.file} (${(value.bytes / 1024).toFixed(1)} KB)`,
			}],
		},
		presentCall: args => ({ card: 'generic', title: `Save PDF${args.path ? ' → ' + args.path : ''}`, kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (args.landscape === true) params.landscape = true
			if (args.printBackground === false) params.printBackground = false
			if (typeof args.paperWidth === 'number') params.paperWidth = args.paperWidth
			if (typeof args.paperHeight === 'number') params.paperHeight = args.paperHeight
			if (typeof args.scale === 'number') params.scale = args.scale
			if (typeof args.pageRanges === 'string') params.pageRanges = args.pageRanges
			const payload = await controller.execute('pdf', params, exec.signal) as { base64: string; tabId: number }
			return await savePdf(controller, payload, typeof args.path === 'string' ? args.path : undefined)
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_emulate',
		description: "Switch the tab to a device viewport (mobile / tablet / desktop) for responsive testing; `device:'reset'` restores the user's real viewport. `width` / `height` / `deviceScaleFactor` / `isMobile` / `hasTouch` override any preset field.",
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			device: { type: 'string', description: 'Preset: desktop | mobile-iphone-13 | mobile-pixel-7 | tablet-ipad | reset. Or pass custom width/height below.' },
			width: { type: 'number', description: 'Custom viewport width in CSS px.' },
			height: { type: 'number', description: 'Custom viewport height in CSS px.' },
			deviceScaleFactor: { type: 'number', description: 'Custom DPR (1 = standard, 2 = retina, 3 = super-retina).' },
			isMobile: { type: 'boolean', description: 'Pass as mobile to the page (affects responsive meta).' },
			hasTouch: { type: 'boolean', description: 'Enable touch event dispatch.' },
			userAgent: { type: 'string', description: 'Custom User-Agent string. Empty string clears.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					reset: { type: 'boolean' },
					width: { type: 'number' },
					height: { type: 'number' },
					deviceScaleFactor: { type: 'number' },
					isMobile: { type: 'boolean' },
					hasTouch: { type: 'boolean' },
					userAgent: { type: 'string' },
				},
			},
			render: (_args, value) => {
				if (value.reset) return [{ type: 'text', text: `Tab ${value.tabId}: emulation reset to default` }]
				return [{
					type: 'text',
					text: `Tab ${value.tabId}: ${value.width || '?'}×${value.height || '?'} DPR=${value.deviceScaleFactor ?? '?'} mobile=${value.isMobile ?? false} touch=${value.hasTouch ?? false}`,
				}]
			},
		},
		presentCall: args => ({ card: 'generic', title: `Emulate${args.device ? ' ' + args.device : ' device'}`, kind: 'other' as const }),
		async execute(args, exec) {
			const params: Record<string, unknown> = {}
			if (args.tabId !== undefined) params.tabId = args.tabId
			if (typeof args.device === 'string') params.device = args.device
			if (typeof args.width === 'number') params.width = args.width
			if (typeof args.height === 'number') params.height = args.height
			if (typeof args.deviceScaleFactor === 'number') params.deviceScaleFactor = args.deviceScaleFactor
			if (typeof args.isMobile === 'boolean') params.isMobile = args.isMobile
			if (typeof args.hasTouch === 'boolean') params.hasTouch = args.hasTouch
			if (typeof args.userAgent === 'string') params.userAgent = args.userAgent
			const raw = await controller.execute('emulate', params, exec.signal) as EmulateRawValue
			return normalizeEmulateValue(raw)
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_permissions',
		description: "Read the browser-level permission state for the current origin (read-only): which permissions are set to \"ask\" (a bubble appears and waits for a human), which are allowed or denied, and whether a request is pending. Typical use: a call times out at `eval timeout` or an action hangs - check here first whether a browser-level bubble (\"local network access\", say) is waiting for a click. The extension cannot see or answer those bubbles, so do not assume the page is stuck. `className` narrows the report to one class (for example `loopback_network` / `automatic_downloads`).",
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			className: { type: 'string', description: '只看某一个权限类（本机真实键名，如 loopback_network）；省略=全部受关注类。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number' },
					origin: { type: 'string', required: true },
					text: { type: 'string', required: true },
				},
			},
			render: (_args, value) => textBlock(String((value as { text?: unknown }).text ?? '')),
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser permissions', kind: 'other' as const }),
		async execute(args, exec) {
			const config = getConfig()
			const url = await currentTabUrl(controller, args.tabId, exec.signal)
			if (typeof url !== 'string' || url.length === 0) {
				throw new Error('拿不到该标签页的 URL（标签页可能已关闭）——换一个 tabId，或用 browser_tabs 看现有标签页')
			}
			// 挂起信号：扩展 network buffer 里"已发出、未结束"的请求。指向本机/私网的 pending 请求
			// + 对应权限类是"询问" ⇒ 屏幕上大概率正挂着一个 LNA 气泡。CDP 对 chrome 自己的权限气泡
			// **没有事件**，所以这是唯一可靠的推断路径（而不是猜"页面慢"）。
			const pendingLocal: Array<{ url: string; ageSeconds?: number }> = []
			try {
				const payload = await controller.execute('network.log', {
					status: 'pending',
					limit: 50,
					...(args.tabId === undefined ? {} : { tabId: args.tabId }),
				}, exec.signal) as { requests?: Array<{ url?: unknown; wallTime?: unknown }> }
				for (const request of payload?.requests ?? []) {
					const raw = typeof request?.url === 'string' ? request.url : ''
					if (raw.length === 0) continue
					let host = ''
					try { host = new URL(raw).hostname } catch { continue }
					const realm = realmOf(host)
					if (realm !== 'local' && realm !== 'lan') continue
					const wallTime = typeof request?.wallTime === 'number' ? request.wallTime : undefined
					const ageSeconds = wallTime === undefined ? undefined : Math.max(0, Math.round(Date.now() / 1000 - wallTime))
					pendingLocal.push(ageSeconds === undefined ? { url: raw } : { url: raw, ageSeconds })
				}
			} catch { /* 网络缓冲读不到不影响权限现状本身 */ }
			// 修 bi-013：配置里存的可能是 Windows 形态路径（浏览器在 Windows 侧），而这个进程在 WSL 里；
			// 直接把原值交给 path.join 会读不到**配置正确**的 profile。候选顺序：配置值 → 配对记录学到的位置。
			const pairingDir = controller.describePolicy().pairing?.profileDir
			const resolvedStore = readPermissionStoreTolerant([config.autoLaunchProfileDir, pairingDir])
			const store = resolvedStore.store
			const requested = args.className === undefined ? undefined : String(args.className)
			const reading = readOriginPermissions(store, url, requested === undefined ? undefined : { pref: requested })
			const text = permissionReport({
				origin: reading.origin,
				tabId: args.tabId,
				store,
				readings: reading.readings,
				pendingLocal,
				requestedClass: requested,
				...(resolvedStore.converted
					? { storeNote: `profile 路径按形态转换后读取：配置 ${resolvedStore.configuredDir} → 实际 ${resolvedStore.usedDir}` }
					: {}),
			})
			return { ...(args.tabId === undefined ? {} : { tabId: args.tabId }), origin: reading.origin, text }
		},
	}))
}

/**
 * 0.2.0 的 `.volatile()` 字段在组合结果里不是普通值，而是惰性访问器对象
 * （官方读法是 `config.cwd.get()` / `config.timeoutMs.get()`）。本插件把 config
 * 当普通对象用遍了整个 apply，这里统一解包一次，避免逐处 `.get()` 漏字段 ——
 * 漏一处的后果就是该项设置静默失效（buddy 正是这么栽的，见其 schema 注释）。
 */
/**
 * 取会话标题（给浮层底部那行"是谁在操作"用）。
 *
 * 标题不在会话日志里，而在 DSH 的投影缓存 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`
 * 的 `record.rows.title.val` 里。只读、best-effort、30 秒缓存；拿不到返回 undefined（调用方退回短 id）。
 */
const sessionTitleCache = new Map<string, { at: number; title: string | undefined }>()
/** 本机插件版本（同步读自身 package.json；桥状态是同步 getter，没法 await）。 */
function pluginVersionSync(): string | undefined {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url))
		const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version?: unknown }
		return typeof pkg.version === 'string' ? pkg.version : undefined
	} catch { return undefined }
}

export function sessionTitleOf(sessionId: string, now: number = Date.now()): string | undefined {
	const cached = sessionTitleCache.get(sessionId)
	if (cached !== undefined && now - cached.at < 30_000) return cached.title
	let title: string | undefined
	try {
		const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
		const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
		const doc = JSON.parse(readFileSync(file, 'utf8')) as { record?: { rows?: { title?: { val?: unknown } } } }
		const raw = doc?.record?.rows?.title?.val
		if (typeof raw === 'string' && raw.trim().length > 0) title = raw.trim().slice(0, 60)
	} catch { title = undefined }
	sessionTitleCache.set(sessionId, { at: now, title })
	return title
}

function unwrapVolatile<T extends object>(config: T): T {
	const source = config as unknown as Record<string, unknown>
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(source)) {
		const value = source[key]
		const accessor = value as { get?: unknown } | null | undefined
		out[key] = value !== null && typeof value === 'object' && typeof accessor?.get === 'function'
			? (accessor as { get: () => unknown }).get()
			: value
	}
	return out as unknown as T
}

/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export function apply(ctx: Context, config: Config): void {
	let resolved = unwrapVolatile(config) as unknown as ResolvedConfig
	/**
	 * 校验一份候选配置。抽出来是因为**运行中热更新走的是另一条入口**（见下面的
	 * `loader/volatile-update`），两处必须用同一套判据，否则"重启才拦得住、热更新能绕过"。
	 */
	const validate = (candidate: ResolvedConfig): void => {
		if (candidate.enabled && candidate.token.trim().length === 0) {
			throw new Error('browser-bridge: token must be a non-empty string when enabled')
		}
		if (candidate.urlMode !== 'public' && candidate.urlMode !== 'intranet') {
			throw new Error(`browser-bridge: invalid urlMode "${String(candidate.urlMode)}" (use public|intranet)`)
		}
		for (const [label, v] of [['internetAccess', candidate.internetAccess], ['lanAccess', candidate.lanAccess], ['localAccess', candidate.localAccess]] as const) {
			if (v !== undefined && v !== 'allow' && v !== 'ask' && v !== 'deny') {
				throw new Error(`browser-bridge: invalid ${label} "${String(v)}" (use allow|ask|deny)`)
			}
		}
		if (candidate.askMode !== 'inherit' && candidate.askMode !== 'allow' && candidate.askMode !== 'deny') {
			throw new Error(`browser-bridge: invalid askMode "${String(candidate.askMode)}" (use inherit|allow|deny)`)
		}
		assertOriginList(candidate.dshOrigins)
		assertHostList('allowHosts', candidate.allowHosts)
		assertHostList('denyHosts', candidate.denyHosts)
		assertMetadataLists(candidate)
	}
	validate(resolved)
	const controller = new BridgeController(line => ctx.logger.info(line))
	/** buddy 的运行态句柄：热更新时要让它按新配置重建旋钮（它自己的 apply 不会重跑）。 */
	let buddyHandle: { refreshConfig?: (raw: unknown) => void } | undefined

	const current = (): ResolvedConfig => resolved
	void controller.reconcile(current())

	// ⚠️ **运行中改设置不会重跑本函数**。宿主（`@deepseek-ai/cordis-plugin-loader` 的
	// `_commitVolatile()`）对"只动了 volatile 字段"的配置变更走**原地提交**：把新值写进运行中
	// 那些 volatile 引用，然后 emit `loader/volatile-update`（带变更路径），**不 dispose、
	// 不重新 apply**。这正是 `.volatile()` 的语义 ——「别重载我，我自己处理」。所以插件必须
	// 自己订阅这个事件把新值接回来：否则设置页写着「保存即时生效」，实际却要等重启
	// （2026-10-14 实测：把局域网/本机档改成放行后，桥侧读数仍是 deny，直到重启 —— bi-038）。
	const onAny = ctx.on as unknown as (event: string, listener: (...args: unknown[]) => void) => void
	onAny('loader/volatile-update', () => {
		try {
			const next = unwrapVolatile(config) as unknown as ResolvedConfig
			validate(next)
			resolved = next
			// buddy 那几个旋钮（工具面分层 / 已展开组 / 自动拉起 / 常驻白名单）也在配置里，
			// 它自己那次 apply 同样不会重跑 —— 把**原始** config 递回去让它在原地重建。
			buddyHandle?.refreshConfig?.(config)
			void controller.reconcile(next).catch((error: unknown) => {
				ctx.logger.warn(`browser-bridge: 设置热更新后重建失败 —— ${error instanceof Error ? error.message : String(error)}`)
			})
			ctx.logger.info('browser-bridge: 设置已热更新（无需重启）')
		} catch (error: unknown) {
			ctx.logger.warn(`browser-bridge: 设置热更新被拒，继续用旧配置 —— ${error instanceof Error ? error.message : String(error)}`)
		}
	})

	// 「本 DSH 控制页」的本机地址由宿主自己推导：GUI 端口写在 `webServer` 服务里
	// （配置 0 时是 OS 实际分配的端口），所以不需要用户去登记一个会过期的 origin ——
	// 端口变了这里跟着变。手动列表仍然生效，作为额外地址（局域网 IP / 域名）。
	// 缺这个服务时（非 web 部署）不做任何事，行为退回「只认用户登记的列表」。
	const injectOptional = ctx.inject as unknown as (names: string[], cb: (scoped: unknown) => void) => void
	injectOptional(['webServer'], (scoped) => {
		const port = (scoped as { webServer?: { port?: unknown } }).webServer?.port
		if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) return
		const origin = `http://127.0.0.1:${port}`
		controller.setControlOrigins([origin])
		ctx.logger.info(`browser-bridge: 本机 DSH 控制页地址 = ${origin}（推导自 webServer 服务，用于 DSH 页面红线）`)
	})

	// 激活期**不再** fail-loud：历史上这里把拒绝再抛出去，形成无人处理的 Promise 拒绝，
	// DSH 的 fail-loud 处理器随即 `exit(1)`（端口被占即 DSH 起不来，见 P0-探针取证）。
	// 现在启动失败只记录到 lastError（端口回退在 reconcileNow 内完成），由 browser_policy_status 暴露。
	void controller.reconcile(resolved).catch((error) => {
		ctx.logger.warn(`browser-bridge: 激活期收敛失败（已降级，不影响 DSH 启动）: ${errorMessage(error)}`)
	})

	// 对同进程的其它插件暴露最小面。
	//
	// 2026-10-10（de-036）：**同伴件 dsh-browser-buddy 已合并进本插件**，所以这个服务不再有
	// 消费方；保留它只为两个目的：① 旧版 buddy 还在装着的过渡期不炸；② 第三方/调试脚本
	// 仍可用它读桥状态（`browser_policy_status` 是给模型的那条路）。
	const bridgeService = {
		/** 生效配置（用户层 > 组合 base > schema 默认）。 */
		config: () => current(),
		/** 策略/链路快照：含 enabled / autoLaunch* / boundPort / portNote，状态面用。 */
		describe: () => controller.describePolicy(),
		/** 唤醒被控浏览器：已连接则让扩展开一个窗口，未连接才起进程（受 10s 冷却保护）。
		 *  `options.url`（可选）＝本次调用要去的网址，作为新窗口的落地页（仅策略直接放行的 http(s) 才用）。 */
		wake: (options?: { url?: string; reason?: string }) => controller.wakeBrowser(options ?? {}),
		/** 调用时问题登记簿（第二部分注册表）：据此在「本会话首次调用」时给出绕行摘要。 */
		issues: () => loadIssues(resolved.registryDir),
		/** 插件版本（摘要里标注 / 登记簿 fixedIn 默认值）。 */
		version: () => currentPluginVersion(resolved.registryDir),
	}
	ctx.provide('browserBridge', bridgeService)

	applyBrowserTools(ctx, controller, () => current())
	// Unified self-update / design-registry tools (browser_check_update,
	// browser_design_show, browser_design_edit). Read-only pair plus an
	// approval-gated writer over the package registry copies.
	applyUnifiedTools(ctx, resolved)

	// 原 dsh-browser-buddy 的能力（工具面分层 / 状态注入 / 调用即唤醒 / 登记簿送达 +
	// browser_tools / browser_frames / browser_frame_eval）。合并后它直接用 controller，
	// frames/eval 不再走 HTTP 命令面，于是自动过 URL 策略与已开标签页红线。
	buddyHandle = applyBuddyFeatures({
		ctx,
		controller,
		bridge: bridgeService,
		config: resolved,
		authorizeTab: (tabId: number | undefined, signal?: AbortSignal) =>
			authorizeExistingTab(controller, tabId, signal ?? new AbortController().signal),
	})

	ctx.effect(() => () => {
		void controller.stop()
	}, 'browser-bridge: server lifecycle')
}
