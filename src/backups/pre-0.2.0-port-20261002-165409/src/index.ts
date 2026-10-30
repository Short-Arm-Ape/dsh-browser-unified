/**
 * Browser-bridge plugin: one local WebSocket endpoint the DSH Browser Control
 * extension connects to, plus the model-facing `browser_*` tools that drive
 * it. The Settings-managed `enabled` flag starts and stops the listener live
 * through dsh-settings' change hook — no reload needed.
 *
 * We deliberately bypass the higher-level `installSettingsSection` helper and
 * talk to the lower-level `sctx.settings.register` API directly: that API
 * predates the helper and is the one stable across every dsh-settings build a
 * consumer is realistically pinned to. Importing the helper on a build that
 * does not export it crashes the whole plugin at module load.
 *
 * Tools stay mounted whenever the plugin does; calling one while the bridge
 * is disabled or the extension is offline fails with a message naming the
 * fix, so the model can tell the user what to do instead of hanging.
 * @module @deepseek-ai/dsh-browser-bridge
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool as rawDefineTool } from '@deepseek-ai/dsh-tools'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-invariants'
import { BridgeServer, cleanupArtifacts, GuardedBridge, UrlPolicy } from 'browser-unified-core'
import { DEFAULT_METADATA_HOSTNAMES, DEFAULT_METADATA_IPS, type RealmAccess, realmOf, type UrlPolicyMode } from 'browser-unified-core'
import { applyUnifiedTools, currentPluginVersion, loadIssues } from './unified-tools.js'
import { CONTENT_SETTING, chromiumTime, readOriginPermissions, readPermissionStore, type PermissionReading } from './permissions.js'

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
	 * without prompting — explicit red lines (denyHosts, metadata, DSH-page
	 * access being off, credentials) still apply because they are enforced
	 * before this branch; `deny` refuses without asking.
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
	 * Hosts always denied — regardless of urlMode, realm or authorization. Exact
	 * hostnames/IPs or `*.suffix` wildcards. Hard blocks (metadata endpoints,
	 * embedded credentials, routing stance) apply in addition to this list.
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
}

export const Config: z<Config> = z.object({
	enabled: z.boolean().default(true),
	port: z.number().step(1).min(1024).max(65_535).default(9777),
	token: z.string().default('dsh-local'),
	shotsDir: z.string().default('dsh-browser-shots'),
	urlMode: z.string().default('public'),
	blockMetadata: z.boolean().default(true),
	metadataHostnames: z.array(z.string()).default([...DEFAULT_METADATA_HOSTNAMES]),
	metadataIps: z.array(z.string()).default([...DEFAULT_METADATA_IPS]),
	internetAccess: z.string(),
	lanAccess: z.string(),
	localAccess: z.string(),
	internetTemp: z.boolean().default(true),
	lanTemp: z.boolean().default(true),
	localTemp: z.boolean().default(true),
	askMode: z.string().default('inherit'),
	dshAccessEnabled: z.boolean().default(false),
	dshOrigins: z.array(z.string()).default([]),
	allowHosts: z.array(z.string()).default([]),
	denyHosts: z.array(z.string()).default([]),
	registryDir: z.string().default(''),
	autoLaunchEnabled: z.boolean().default(false),
	autoLaunchIdleSeconds: z.number().step(1).min(3).max(3600).default(15),
	autoLaunchBrowserExe: z.string().default(''),
	autoLaunchProfileDir: z.string().default(''),
	autoLaunchProfileName: z.string().default(''),
	autoLaunchTempProfile: z.boolean().default(false),
	autoLaunchExtensionDir: z.string().default(''),
})

interface ResolvedConfig {
	enabled: boolean
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
const READ_CONTENT_MAX_CHARS = 120_000
/** 端口被占时向后尝试的候选端口个数（配置端口 → +1 … +N）。 */
const PORT_FALLBACK_COUNT = 9

/**
 * Owns zero or one live {@link BridgeServer} and restarts it whenever the
 * resolved settings change. Reconciles serialize through a promise chain so a
 * burst of settings commits cannot interleave stop/start pairs.
 */
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

	constructor(private readonly log: (line: string) => void) {}

	/** Resolved directory screenshots land in; defined once any config arrived. */
	get shotsDir(): string | undefined {
		return this.current === undefined ? undefined : path.resolve(this.current.shotsDir)
	}

	/** Snapshot for the read-only policy-status tool. */
	describePolicy(): { enabled: boolean; urlMode?: string; internetAccess?: string; lanAccess?: string; localAccess?: string; internetTemp?: boolean; lanTemp?: boolean; localTemp?: boolean; askMode?: string; autoLaunchEnabled?: boolean; autoLaunchIdleSeconds?: number; autoLaunchProfileDir?: string; autoLaunchProfileName?: string; dshAccessEnabled?: boolean; dshOrigins?: string[]; allowHosts?: string[]; denyHosts?: string[]; blockMetadata?: boolean; metadataHostnames?: string[]; metadataIps?: string[]; tempGrants: readonly string[]; ready: boolean; boundPort?: number; requestedPort?: number; portNote?: string } {
		const c = this.current
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
			blockMetadata: c?.blockMetadata,
			metadataHostnames: c?.metadataHostnames,
			metadataIps: c?.metadataIps,
			tempGrants: [...this.tempAllow],
			ready: this.guarded !== undefined,
			boundPort: this.boundPort,
			requestedPort: c?.port,
			portNote: this.portNote,
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
	launchBrowser(): string {
		const status = this.server?.status
		if (status?.extensionConnected) return '扩展已连接，无需拉起'
		const config = this.current
		if (config === undefined) return '浏览器控制尚未加载配置，无法拉起'
		if (!config.enabled) return '浏览器控制未启用，无法拉起（请先打开开关）'
		if (config.autoLaunchProfileDir.length === 0 && config.autoLaunchBrowserExe.length === 0) {
			return '未配置拉起目标：请在「浏览器」设置里填 autoLaunchBrowserExe / autoLaunchProfileDir（或开 autoLaunchEnabled 交给看门狗）后再试'
		}
		const now = Date.now()
		if (now - this.lastSpawnAt < 10_000) return '刚刚已尝试拉起，请稍候几秒让浏览器/扩展连上'
		this.lastSpawnAt = now
		return this.spawnBrowser(config)
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
	async wakeBrowser(): Promise<string> {
		const status = this.server?.status
		if (status?.extensionConnected === true) {
			try {
				const info = (await this.execute(
					'window.ensure',
					{ reason: 'browser_launch' },
					new AbortController().signal,
				)) as { created?: boolean; windowsBefore?: number; tabId?: number }
				if (info.created === true) {
					return `扩展已连接，但浏览器里没有任何窗口 —— 已让扩展新建一个窗口（tabId=${String(info.tabId)}），可以继续操作了`
				}
				return `扩展已连接，当前有 ${String(info.windowsBefore)} 个窗口，无需唤起`
			} catch (error) {
				return `扩展已连接，但请求它新建窗口失败：${errorMessage(error)}（可手动打开一次浏览器窗口）`
			}
		}
		return this.launchBrowser()
	}

	private spawnBrowser(config: ResolvedConfig): string {
		let userDataDir = ''
		let profileName = ''
		if (config.autoLaunchTempProfile) {
			if (!config.autoLaunchExtensionDir) {
				this.log('[browser-bridge] autoLaunch: 临时干净实例需要 autoLaunchExtensionDir（未打包扩展目录）才能 sideload；改用已装扩展的 profile 目录')
				return '临时干净实例需要 autoLaunchExtensionDir（未打包扩展目录）才能 sideload；请改配已装扩展的 profile 目录或填扩展目录'
			}
			userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-browser-'))
		} else if (config.autoLaunchProfileDir) {
			const resolved = path.resolve(config.autoLaunchProfileDir)
			const base = path.basename(resolved)
			if (/^(Default|Profile\s?\d+)$/i.test(base)) {
				// 目录直接指向某个 profile（如 ...\User Data\Profile 4）：父目录作 user-data-dir，名字作 profile。
				userDataDir = path.dirname(resolved)
				profileName = base
			} else {
				userDataDir = resolved
				profileName = config.autoLaunchProfileName || 'Default'
			}
		}
		const extra = config.autoLaunchTempProfile && config.autoLaunchExtensionDir
			? ['--load-extension=' + path.resolve(config.autoLaunchExtensionDir)]
			: []
		const args = ['--no-first-run', '--no-default-browser-check']
		if (userDataDir) args.push('--user-data-dir=' + userDataDir)
		if (profileName) args.push('--profile-directory=' + profileName)
		args.push(...extra)
		args.push('about:blank')
		for (const exe of this.resolveBrowserCandidates(config.autoLaunchBrowserExe)) {
			try {
				const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
				child.on('error', (error) => {
					this.log(`[browser-bridge] autoLaunch ${exe} 启动失败：${error.message}（若配置了可执行文件请给完整路径）`)
				})
				child.unref()
				this.log(`[browser-bridge] autoLaunch: 已拉起 ${exe}（user-data-dir=${userDataDir || '默认'}${profileName ? ', profile=' + profileName : ''}）`)
				return `已拉起 ${exe}（user-data-dir=${userDataDir || '默认'}${profileName ? ', profile=' + profileName : ''}），等待扩展连接`
			} catch (error) {
				this.log(`[browser-bridge] autoLaunch ${exe} 失败：${error instanceof Error ? error.message : String(error)}`)
			}
		}
		this.log('[browser-bridge] autoLaunch: 无可用的浏览器可执行文件（可在 autoLaunchBrowserExe 指定完整路径）')
		return '无可用的浏览器可执行文件（请在 autoLaunchBrowserExe 指定完整路径）'
	}

	/** Ordered candidate executables: configured value → common absolute paths → PATH names. */
	private resolveBrowserCandidates(configured: string): string[] {
		const out: string[] = []
		const pushFile = (p: string): void => {
			try { if (existsSync(p)) out.push(p) } catch { /* ignore */ }
		}
		if (configured && configured.length > 0) {
			out.push(configured)
			return out
		}
		if (process.platform === 'win32') {
			const roots: string[] = []
			if (process.env['ProgramFiles(x86)']) roots.push(process.env['ProgramFiles(x86)']!)
			if (process.env.ProgramFiles) roots.push(process.env.ProgramFiles!)
			for (const root of roots) {
				pushFile(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
				pushFile(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
			}
			if (process.env.LOCALAPPDATA) {
				pushFile(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
			}
		}
		out.push('msedge', 'chrome')
		return out
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
				const attempt = new BridgeServer({ port: candidate, token: config.token, shotsDir, log: this.log })
				try {
					await attempt.start()
					started = attempt
					this.boundPort = candidate
					if (candidate === config.port) {
						this.portNote = undefined
					} else {
						this.portNote = `配置端口 ${config.port} 被占用，已回退到 ${candidate}（扩展端会自动发现）`
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
				return
			}
			this.server = started
			this.serverKey = serverKey
		}
		if (!config.enabled) {
			this.refreshWatchdog(config)
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
	}

	/**
	 * Run one extension command over the live, policy-guarded link.
	 * @param command - extension command name (`nav`, `click`, …).
	 * @param params - wire params passed through to the extension.
	 * @param signal - tool-execution cancellation propagated to the pending command.
	 * @returns the extension's result payload verbatim.
	 */
	async execute(command: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		const guarded = this.guarded
		if (guarded === undefined) {
			throw new Error(
				this.lastError ?? '浏览器控制未启用 —— 到 dsh 设置 → 插件 → DSH 浏览器控制 打开开关',
			)
		}
		return guarded.execute(command, params, { signal })
	}

	/**
	 * Authorize one navigation target against the live policy, honoring
	 * per-session grants. Returns `unavailable` while the bridge is stopped.
	 */
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
export function permissionReport(input: {
	origin: string
	tabId: number | undefined
	store: ReturnType<typeof readPermissionStore>
	readings: PermissionReading[]
	pendingLocal: ReadonlyArray<{ url: string; ageSeconds?: number }>
	requestedClass: string | undefined
}): string {
	const lines: string[] = []
	lines.push(`origin = ${input.origin}${input.tabId === undefined ? '' : `（tab ${input.tabId}）`}`)
	lines.push(`权限存储 = ${input.store.file}`)
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
		description: 'Read the browser-bridge URL/access policy state: enabled, urlMode, per-realm access (internet/intranet: allow|ask|deny), temp-grant switches, full access, allow/deny host lists, cloud-metadata switch, and session grants. Read-only. Call this to check why a navigation was refused or whether a host still needs approval.',
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
				lines.push(`allowHosts: ${firstN(s.allowHosts) || '（空）'}`)
				lines.push(`denyHosts: ${firstN(s.denyHosts) || '（空）'}`)
				lines.push(`blockMetadata: ${s.blockMetadata === false ? '关' : '开'}；metadataHostnames: ${(s.metadataHostnames ?? []).length} 条；metadataIps: ${(s.metadataIps ?? []).length} 条`)
				lines.push(`本会话已授权主机: ${s.tempGrants.length > 0 ? s.tempGrants.join(', ') : '（无）'}`)
			}
			return { ok: true, text: lines.join('\n') }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_launch',
		description: 'Wake the controlled browser. Two distinct cases: (a) the extension is connected but the browser has NO window (Edge keeps running in the background after all windows are closed, and every "current tab" command then fails) — this asks the extension to open one; (b) the extension is not connected — this launches the configured browser (per autoLaunch profile/exe settings). Use this when browser_* tools fail with "no browser extension connected" — call it once, wait a few seconds, then retry the failing tool. Does NOT require the auto-launch watchdog to be enabled. Safe: spawns the configured browser only; no page is touched until you navigate.',
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
		description: 'Navigate a browser tab to a URL and wait for the page load to settle. '
			+ '注意：SPA / 微前端常常在本次返回之后才渲染正文 —— 拿到标题不等于内容就绪；'
			+ '若紧接着读到的正文是空或极短，用 browser_read / browser_evaluate 复查一次再下结论。',
		parameters: {
			url: { type: 'string', required: true, description: 'Absolute URL to open in the tab.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
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
					error: { type: 'string' },
				},
			},
			render: (_args, value) => {
				const label = [value.title, value.url].filter(part => typeof part === 'string' && part.length > 0).join(' — ')
				const tail = value.siteUnreachable === true
					? ` — target unreachable${value.error ? `: ${value.error}` : ''}`
					: ''
				return [{ type: 'text', text: `Tab ${value.tabId} now shows ${label.length > 0 ? label : '(untitled)'}${tail}` }]
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
				siteUnreachable?: boolean
				error?: string
			}
			const out: Record<string, unknown> = { tabId: raw.tabId }
			if (typeof raw.url === 'string') out.url = raw.url
			if (typeof raw.title === 'string') out.title = raw.title
			if (raw.siteUnreachable === true) {
				out.siteUnreachable = true
				if (typeof raw.error === 'string') out.error = raw.error
			}
			return out
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_read',
		description: 'Read the current page: title, URL, ready state, and body text (or full HTML).',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			mode: { type: 'string', description: '"text" (default) for visible text, "html" for the whole document.' },
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
				},
			},
			// 以前这里只回「标题 (URL) — N chars」，把 content 丢掉了 —— 模型因此**读不到页面正文**，
			// 只能靠 browser_evaluate 硬抠。现在把正文交给模型（过长时由 execute 侧 clamp + 截断标记）。
			render: (_args, value) => [{
				type: 'text',
				text: `${value.title} (${value.url}) [${value.mode}${value.truncated ? ', truncated' : ''}, ${value.content.length} chars]\n\n${value.content}`,
			}],
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
			const clamped = clampText(raw.content ?? '', READ_CONTENT_MAX_CHARS)
			return {
				tabId: raw.tabId,
				mode,
				title: raw.title ?? '',
				url: raw.url ?? '',
				content: clamped.content,
				truncated: clamped.truncated,
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_snapshot',
		description: 'Inventory the page\'s interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards.',
		parameters: {
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
			limit: { type: 'number', description: 'Max elements returned; defaults to 120, capped at 200.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					tabId: { type: 'number', required: true },
					title: { type: 'string', required: true },
					url: { type: 'string', required: true },
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
							},
						},
					},
				},
			},
			render: (_args, value) => {
				const lines = value.items.map((item) => {
					const name = typeof item.name === 'string' ? item.name.trim().replace(/\s+/g, ' ').slice(0, 140) : ''
					const href = typeof item.href === 'string' && item.href.length > 0 ? ` → ${item.href.slice(0, 140)}` : ''
					return `${item.ref}\t<${item.tag}>${name.length > 0 ? ' ' + name : ''}${href}`
				})
				return textBlock(`${value.title} (${value.url})\n共 ${value.items.length} 个可交互元素`
					+ `（每行第一列就是 ref，可直接传给 browser_click / browser_type）：\n${lines.join('\n')}`)
			},
		},
		presentCall: () => ({ card: 'generic', title: 'Snapshot browser page', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const limit = Math.min(200, Math.max(1, args.limit ?? 120))
			const raw = await controller.execute(
				'snapshot',
				args.tabId === undefined ? { limit } : { limit, tabId: args.tabId },
				exec.signal,
			) as { tabId: number; title?: string; url?: string; items?: Array<{ ref: string; tag: string; name?: string; href?: string }> }
			return {
				tabId: raw.tabId,
				title: raw.title ?? '',
				url: raw.url ?? '',
				items: (raw.items ?? []).map(item => ({
					ref: item.ref,
					tag: item.tag,
					...(item.name === undefined ? {} : { name: item.name }),
					...(item.href === undefined ? {} : { href: item.href }),
				})),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_click',
		description: 'Click a page element with real mouse events; target it by snapshot ref or CSS selector.',
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
		description: 'Fill an input/textarea/select/contentEditable (React-compatible events); optionally press Enter afterwards.',
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
		description: 'Send a real keyboard event to the page (Enter, Tab, Escape, arrows, or a single character).',
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
		description: 'Scroll the page viewport by a delta and report the resulting position.',
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
		description: 'List tabs, or open/close/activate one. Actions act on real browser windows.',
		parameters: {
			action: { type: 'string', required: true, description: 'One of: list, open, close, activate.' },
			url: { type: 'string', description: 'URL for the open action.' },
			tabId: { type: 'number', description: 'Target tab for close/activate.' },
			active: { type: 'boolean', description: 'Whether a newly opened tab becomes active; defaults to true.' },
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => {
				const tabs = Array.isArray(value?.tabs) ? value.tabs : []
				if (tabs.length === 0) return textBlock(JSON.stringify(value))
				const lines = tabs.map((tab) => `${tab.id}\t${tab.active === true ? 'active' : '      '}\t${String(tab.title ?? '')} — ${String(tab.url ?? '')}`)
				const head = `窗口 ${value.windows ?? '?'} 个，标签页 ${value.count ?? tabs.length} 个`
					+ `（activeTabId=${value.activeTabId ?? '?'}${value.noWindow === true ? '，当前没有任何窗口' : ''}）`
				return textBlock(`${head}\n${lines.join('\n')}`)
			},
		},
		presentCall: args => ({ card: 'generic', title: `Browser tabs: ${args.action}`, kind: 'other' as const }),
		async execute(args, exec) {
			switch (args.action) {
				case 'list':
					return await controller.execute('tabs.list', {}, exec.signal) as Record<string, JsonValue>
				case 'open': {
					if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('open requires url')
					await authorizeNavigation(ctx, controller, args.url, exec, 'browser_tabs')
					const params: Record<string, unknown> = { url: args.url }
					if (args.active !== undefined) params.active = args.active
					return await controller.execute('tabs.open', params, exec.signal) as Record<string, JsonValue>
				}
				case 'close':
					return await controller.execute('tabs.close', { tabId: requireTabId(args, 'close') }, exec.signal) as Record<string, JsonValue>
				case 'activate':
					return await controller.execute('tabs.activate', { tabId: requireTabId(args, 'activate') }, exec.signal) as Record<string, JsonValue>
				default:
					throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate)`)
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_evaluate',
		description: 'Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection. '
			+ '注意：`history.pushState` 只改 URL、**不会**触发 SPA 重渲染 —— 用它站内翻页会让后续抽取读到上一条页面的内容'
			+ '（实测踩过，URL 变了内容没变）；换页请用 browser_navigate，抽取前先核对页面身份（标题/编号）。',
		parameters: {
			expression: { type: 'string', required: true, description: 'JavaScript expression or statement sequence; awaited like a promise body.' },
			tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
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
			const raw = await controller.execute(
				'eval',
				args.tabId === undefined ? { expression: args.expression } : { expression: args.expression, tabId: args.tabId },
				exec.signal,
			) as { tabId: number; value: unknown }
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
		description: 'Capture the tab as PNG/JPEG, save it under the configured shots directory, and return the absolute file path.',
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
		description: 'Delete generated screenshots and agent scratch files (__-prefixed temp scripts/artifacts) from their top-level directories.',
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
		description: 'Read the captured `console.log/info/warn/error` entries for a tab. Set `clear:true` to also empty the buffer so the next call shows only entries recorded after this one. Useful for "what did the page log after I clicked submit".',
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
		description: 'Read captured HTTP request/response pairs for a tab. `includeStatic:true` adds images / fonts / stylesheets / scripts (filtered by default — they dominate the buffer). `methodPattern` / `urlPattern` / `status` filter server-side results; `clear:true` empties the buffer.',
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
		description: 'Empty the per-tab network capture buffer without returning the rows.',
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
		description: 'Export the current page to a PDF. `path` may be absolute (saved there) or omitted (saved under the configured shotsDir). Returns the absolute path + size; the PDF preserves text (selectable, searchable) and print-media CSS.',
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
		description: 'Switch the tab into a device viewport (mobile / tablet / desktop) for responsive-UI testing. `device:"reset"` restores the user\'s actual viewport. Custom `width`/`height`/`deviceScaleFactor`/`isMobile`/`hasTouch` override any preset field.',
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
			return await controller.execute('emulate', params, exec.signal) as { tabId: number; reset?: boolean; width?: number; height?: number; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean; userAgent?: string }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_permissions',
		description: '读「浏览器级权限」现状（只读）：当前 origin 上哪些权限是「询问（=会弹窗，需人点）」、哪些已允许/拒绝，'
			+ '并给出挂起信号。**典型用途**：某个 browser_* 调用报 `eval timeout`／页面动作卡住时，先用它判断'
			+ '「是不是有个浏览器权限气泡（如『本地网络访问』LNA）在等人点」——扩展对这类 chrome 级气泡既看不见也答不了，'
			+ '所以超时时不要猜"页面卡了"。数据源：浏览器自己的权限存储（Preferences）+ 桥的待处理请求；'
			+ 'className 可只看一类（如 loopback_network / automatic_downloads），传了不存在的类会把本机真实类名列出来。',
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
			const store = readPermissionStore(config.autoLaunchProfileDir)
			const requested = args.className === undefined ? undefined : String(args.className)
			const reading = readOriginPermissions(store, url, requested === undefined ? undefined : { pref: requested })
			const text = permissionReport({
				origin: reading.origin,
				tabId: args.tabId,
				store,
				readings: reading.readings,
				pendingLocal,
				requestedClass: requested,
			})
			return { ...(args.tabId === undefined ? {} : { tabId: args.tabId }), origin: reading.origin, text }
		},
	}))
}

/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export function apply(ctx: Context, config: Config): void {
	const resolved = config as unknown as ResolvedConfig
	if (resolved.enabled && resolved.token.trim().length === 0) {
		throw new Error('browser-bridge: token must be a non-empty string when enabled')
	}
	if (resolved.urlMode !== 'public' && resolved.urlMode !== 'intranet') {
		throw new Error(`browser-bridge: invalid urlMode "${String(resolved.urlMode)}" (use public|intranet)`)
	}
	for (const [label, v] of [['internetAccess', resolved.internetAccess], ['lanAccess', resolved.lanAccess], ['localAccess', resolved.localAccess]] as const) {
		if (v !== undefined && v !== 'allow' && v !== 'ask' && v !== 'deny') {
			throw new Error(`browser-bridge: invalid ${label} "${String(v)}" (use allow|ask|deny)`)
		}
	}
	if (resolved.askMode !== 'inherit' && resolved.askMode !== 'allow' && resolved.askMode !== 'deny') {
		throw new Error(`browser-bridge: invalid askMode "${String(resolved.askMode)}" (use inherit|allow|deny)`)
	}
	assertOriginList(resolved.dshOrigins)
	assertHostList('allowHosts', resolved.allowHosts)
	assertHostList('denyHosts', resolved.denyHosts)
	assertMetadataLists(resolved)
	const controller = new BridgeController(line => ctx.logger.info(line))

	let current: () => ResolvedConfig = () => resolved
	// Equivalent of @deepseek-ai/dsh-settings' `installSettingsSection`, inlined so
	// the plugin still loads on dsh-settings builds that predate the helper. The
	// underlying `sctx.settings.register` API is the one stable across every
	// dsh-settings version a consumer is realistically pinned to.
	ctx.inject(['settings'], (sctx) => {
		const scope = (sctx.settings.register as (
			ns: string,
			schema: typeof Config,
			options: { base: Config; validate?: (value: Config) => void },
		) => SettingsScope<Config>)(
			BROWSER_BRIDGE_SETTINGS_NAMESPACE,
			Config,
			{
				base: config,
				validate: (value) => {
					if (value.enabled && (value.token ?? '').trim().length === 0) {
						throw new Error('browser-bridge: token must be a non-empty string when enabled')
					}
					if (value.urlMode !== 'public' && value.urlMode !== 'intranet') {
						throw new Error(`browser-bridge: invalid urlMode "${String(value.urlMode)}" (use public|intranet)`)
					}
					for (const [label, v] of [['internetAccess', value.internetAccess], ['lanAccess', value.lanAccess], ['localAccess', value.localAccess]] as const) {
						if (v !== undefined && v !== 'allow' && v !== 'ask' && v !== 'deny') {
							throw new Error(`browser-bridge: invalid ${label} "${String(v)}" (use allow|ask|deny)`)
						}
					}
					if (value.askMode !== 'inherit' && value.askMode !== 'allow' && value.askMode !== 'deny') {
						throw new Error(`browser-bridge: invalid askMode "${String(value.askMode)}" (use inherit|allow|deny)`)
					}
					assertOriginList(value.dshOrigins)
					assertHostList('allowHosts', value.allowHosts)
					assertHostList('denyHosts', value.denyHosts)
					assertMetadataLists(value as unknown as ResolvedConfig)
				},
			},
		)
		current = () => scope.get() as ResolvedConfig
		ctx.effect(() => () => {
			// Mirror `isUnloading` from dsh-settings (private): the fiber's own
			// unload path runs the disposer too, and there re-applying the
			// composition entry and firing `onChange` would re-register routes
			// against a fiber whose resources are being released.
			if (ctx.fiber.state === FiberState.DISPOSED || ctx.fiber.state === FiberState.UNLOADING) return
			current = () => resolved
			void controller.reconcile(current())
		}, 'browser-bridge: settings cleanup')
		void controller.reconcile(current())
		scope.watch(() => {
			if (ctx.fiber.state === FiberState.DISPOSED || ctx.fiber.state === FiberState.UNLOADING) return
			void controller.reconcile(current())
		})
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

	// 对同进程的其它插件暴露最小面（当前唯一消费者：dsh-browser-buddy）。
	//
	// 为什么要有这个服务：唤醒浏览器要知道 exe / profile 目录 / 配置文件名称 / 临时干净实例 /
	// sideload 目录该怎么拼，还要区分「扩展连着但没有窗口」（走 window.ensure，不起进程）与
	// 「扩展没连上」（才起进程）。这些只有本插件知道；外挂插件若自己再存一份配置与一套 spawn
	// 逻辑，就会与「浏览器插件」分区里的设置形成同值两处维护 —— 改一处另一处不跟着动，
	// 拉起的窗口落在没装扩展的 profile 上，表现为「唤起了但没用」。
	ctx.provide('browserBridge', {
		/** 生效配置（用户层 > 组合 base > schema 默认）。 */
		config: () => current(),
		/** 策略/链路快照：含 enabled / autoLaunch* / boundPort / portNote，状态面用。 */
		describe: () => controller.describePolicy(),
		/** 唤醒被控浏览器：已连接则让扩展开一个窗口，未连接才起进程（受 10s 冷却保护）。 */
		wake: () => controller.wakeBrowser(),
		/** 调用时问题登记簿（第二部分注册表）：同伴件据此在「本会话首次调用」时给出绕行摘要。 */
		issues: () => loadIssues(resolved.registryDir),
		/** 插件版本（摘要里标注 / 登记簿 fixedIn 默认值）。 */
		version: () => currentPluginVersion(resolved.registryDir),
	})

	applyBrowserTools(ctx, controller, () => current())
	// Unified self-update / design-registry tools (browser_check_update,
	// browser_design_show, browser_design_edit). Read-only pair plus an
	// approval-gated writer over the package registry copies.
	applyUnifiedTools(ctx, resolved)
	ctx.effect(() => () => {
		void controller.stop()
	}, 'browser-bridge: server lifecycle')
}
