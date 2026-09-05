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
import path from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool as rawDefineTool } from '@deepseek-ai/dsh-tools'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-invariants'
import { BridgeServer, cleanupArtifacts, GuardedBridge, UrlPolicy } from 'browser-unified-core'
import { DEFAULT_METADATA_HOSTNAMES, DEFAULT_METADATA_IPS, type RealmAccess, realmOf, type UrlPolicyMode } from 'browser-unified-core'
import { applyUnifiedTools } from './unified-tools.js'

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
	internetAccess: z.string().default('allow'),
	lanAccess: z.string().default('allow'),
	localAccess: z.string().default('allow'),
	internetTemp: z.boolean().default(true),
	lanTemp: z.boolean().default(true),
	localTemp: z.boolean().default(true),
	askMode: z.string().default('inherit'),
	dshAccessEnabled: z.boolean().default(false),
	dshOrigins: z.array(z.string()).default([]),
	allowHosts: z.array(z.string()).default([]),
	denyHosts: z.array(z.string()).default([]),
	registryDir: z.string().default(''),
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
	internetAccess: string
	lanAccess: string
	localAccess: string
	internetTemp: boolean
	lanTemp: boolean
	localTemp: boolean
	askMode: string
	dshAccessEnabled: boolean
	dshOrigins: string[]
	allowHosts: string[]
	denyHosts: string[]
	registryDir: string
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

function policyOptionsFor(config: ResolvedConfig): ConstructorParameters<typeof UrlPolicy>[0] {
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
		dshOrigins: config.dshOrigins ?? [],
		allowHosts: config.allowHosts ?? [],
		denyHosts: config.denyHosts ?? [],
	}
}

const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/
const READ_CONTENT_MAX_CHARS = 120_000

/**
 * Owns zero or one live {@link BridgeServer} and restarts it whenever the
 * resolved settings change. Reconciles serialize through a promise chain so a
 * burst of settings commits cannot interleave stop/start pairs.
 */
class BridgeController {
	private server: BridgeServer | undefined
	private guarded: GuardedBridge | undefined
	private policy: UrlPolicy | undefined
	private serverKey = ''
	private policyKey = ''
	private lastError: string | undefined
	private chain: Promise<void> = Promise.resolve()
	private current: ResolvedConfig | undefined
	/** Per-session grants: hosts the user approved once in ask mode. Cleared when
	 *  policy inputs change or the plugin stops. */
	private readonly tempAllow = new Set<string>()

	constructor(private readonly log: (line: string) => void) {}

	/** Resolved directory screenshots land in; defined once any config arrived. */
	get shotsDir(): string | undefined {
		return this.current === undefined ? undefined : path.resolve(this.current.shotsDir)
	}

	/** Snapshot for the read-only policy-status tool. */
	describePolicy(): { enabled: boolean; urlMode?: string; internetAccess?: string; lanAccess?: string; localAccess?: string; internetTemp?: boolean; lanTemp?: boolean; localTemp?: boolean; askMode?: string; dshAccessEnabled?: boolean; dshOrigins?: string[]; allowHosts?: string[]; denyHosts?: string[]; blockMetadata?: boolean; metadataHostnames?: string[]; metadataIps?: string[]; tempGrants: readonly string[]; ready: boolean } {
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
			dshAccessEnabled: c?.dshAccessEnabled,
			dshOrigins: c?.dshOrigins,
			allowHosts: c?.allowHosts,
			denyHosts: c?.denyHosts,
			blockMetadata: c?.blockMetadata,
			metadataHostnames: c?.metadataHostnames,
			metadataIps: c?.metadataIps,
			tempGrants: [...this.tempAllow],
			ready: this.guarded !== undefined,
		}
	}

	/**
	 * Converge the live server onto `config`. With `throwOnError`, an initial
	 * start failure rejects (fail-loud activation); later changes record the
	 * failure instead, so a bad port cannot tear down an otherwise running session.
	 * @param config - the freshly resolved settings snapshot.
	 * @param options - set `throwOnError` only for the activation-time call.
	 * @returns a promise settling once the convergence attempt finished.
	 */
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
			? `${config.urlMode}|${config.blockMetadata ? '1' : '0'}|${config.internetAccess}|${config.lanAccess}|${config.localAccess}|`
				+ `${config.internetTemp ? '1' : '0'}|${config.lanTemp ? '1' : '0'}|${config.localTemp ? '1' : '0'}|`
				+ `${config.dshAccessEnabled ? '1' : '0'}|${(config.dshOrigins ?? []).join('\u0001')}|`
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
			const server = new BridgeServer({ port: config.port, token: config.token, shotsDir, log: this.log })
			try {
				await server.start()
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				this.lastError = `桥接启动失败（端口 ${config.port}）: ${message}`
				this.log(this.lastError!)
				throw error instanceof Error ? error : new Error(message)
			}
			this.server = server
			this.serverKey = serverKey
		}
		if (!config.enabled) return
		// Unified URL policy in front of every navigation command: public mode
		// blocks private/loopback/metadata targets before they reach the
		// extension; intranet mode allows local/LAN but still blocks metadata.
		// Rebuild whenever the policy inputs change (mode, realm access, temps,
		// full access, metadata and allow/deny lists). Session grants reset with
		// the policy.
		if (policyKey !== this.policyKey && this.server !== undefined) {
			this.policy = new UrlPolicy(policyOptionsFor(config))
			this.guarded = new GuardedBridge(this.server, this.policy)
			this.tempAllow.clear()
			this.policyKey = policyKey
			this.lastError = undefined
		}
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
		// Behaviour when the realm is `ask`, the host is not allowlisted, and
		// (usually) no user approval can be shown (host approval = never /
		// Full Access):
		//  - 'inherit' (default): keep whatever the earlier settings imply —
		//    honour the per-realm temp switch, then try the host approval;
		//  - 'allow': pass every ask-realm target through (ignore white/black
		//    lists for this decision); metadata/credential/scheme red lines
		//    that precede this verdict still apply;
		//  - 'deny': refuse without asking.
		const askMode = (s.askMode as 'inherit' | 'allow' | 'deny' | undefined) ?? 'inherit'
		if (askMode === 'deny') {
			throw new Error(`WEB_REALM_DENIED: ${verdict.reason} — ask 域被配置为直接禁止（审批缺失策略=禁止）`)
		}
		if (askMode === 'allow') {
			controller.grantTemporary(verdict.host)
			return
		}
		const realmTemp = realm === 'internet' ? (s.internetTemp ?? true) : realm === 'lan' ? (s.lanTemp ?? true) : (s.localTemp ?? true)
		if (!realmTemp) {
			throw new Error(`NEED_AUTHORIZATION: ${verdict.reason} — 该网络（${realmLabelZh(realm)}）不允许临时授权；请把主机 ${verdict.host} 加入 allowHosts 白名单后再试`)
		}
		const approval = ctx.get('approval') as ApprovalService | undefined
		const agent = (exec as { agent?: unknown }).agent
		if (!approval || agent === undefined || agent === null || typeof agent !== 'object') {
			throw new Error(`NEED_AUTHORIZATION: ${verdict.reason} — no approval service or agent context available; add the host to allowHosts or set the realm access back to allow`)
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
	}
}

function controllerDescribeUnavailable(): string {
	return '浏览器控制未启用 —— 到 dsh 设置 → 插件 → DSH 浏览器控制 打开开关'
}

function realmLabelZh(realm: string): string {
	return realm === 'lan' ? '局域网' : realm === 'local' ? '本机' : '外网'
}

function askModeZh(mode: string | undefined): string {
	return mode === 'allow' ? '放行' : mode === 'deny' ? '禁止' : '继承'
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
function applyBrowserTools(ctx: Context, controller: BridgeController): void {
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
				lines.push(`urlMode: ${s.urlMode ?? 'public'}`)
				lines.push(`DSH 页面访问: ${s.dshAccessEnabled ? '开（' + (s.dshOrigins ?? []).join(', ') + '）' : '关'}`)
				lines.push(`外网: ${s.internetAccess ?? 'allow'}${(s.internetAccess ?? 'allow') !== 'allow' ? `（临时授权: ${s.internetTemp === false ? '关' : '开'}）` : ''}`)
				lines.push(`局域网: ${s.lanAccess ?? 'allow'}${(s.lanAccess ?? 'allow') !== 'allow' ? `（临时授权: ${s.lanTemp === false ? '关' : '开'}）` : ''}`)
				lines.push(`本机: ${s.localAccess ?? 'allow'}${(s.localAccess ?? 'allow') !== 'allow' ? `（临时授权: ${s.localTemp === false ? '关' : '开'}）` : ''}`)
				lines.push(`ask 域无审批策略: ${askModeZh(s.askMode)}`)
				lines.push(`allowHosts: ${firstN(s.allowHosts) || '（空）'}`)
				lines.push(`denyHosts: ${firstN(s.denyHosts) || '（空）'}`)
				lines.push(`blockMetadata: ${s.blockMetadata === false ? '关' : '开'}；metadataHostnames: ${(s.metadataHostnames ?? []).length} 条；metadataIps: ${(s.metadataIps ?? []).length} 条`)
				lines.push(`本会话已授权主机: ${s.tempGrants.length > 0 ? s.tempGrants.join(', ') : '（无）'}`)
			}
			return { ok: true, text: lines.join('\n') }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'browser_navigate',
		description: 'Navigate a browser tab to a URL and wait for the page load to settle.',
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
			render: (_args, value) => [{
				type: 'text',
				text: `${value.title} (${value.url}) — ${value.content.length} chars${value.truncated ? ', truncated' : ''}`,
			}],
		},
		presentCall: () => ({ card: 'generic', title: 'Read browser page', kind: 'other' as const }),
		async execute(args, exec) {
			await authorizeExistingTab(controller, args.tabId, exec.signal)
			const mode = args.mode === 'html' ? 'html' : 'text'
			const raw = await controller.execute(
				'content',
				args.tabId === undefined ? { mode } : { mode, tabId: args.tabId },
				exec.signal,
			) as { tabId: number; title?: string; url?: string; content?: string }
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
			render: (_args, value) => [{
				type: 'text',
				text: `${value.items.length} interactive elements on ${value.title}; click or fill them by ref.`,
			}],
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 300) }],
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
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 400) }],
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
		description: 'Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection.',
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
			render: (_args, value) => [{ type: 'text', text: value.json.slice(0, 300) }],
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
					entries: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {} } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `Tab ${value.tabId}: ${value.count} of ${value.total} console entries`,
			}],
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
					requests: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {} } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: `Tab ${value.tabId}: ${value.count} of ${value.total} network requests`,
			}],
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
		if (v !== 'allow' && v !== 'ask' && v !== 'deny') {
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
						if (v !== 'allow' && v !== 'ask' && v !== 'deny') {
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

	// Activation converges loudly so a bad port fails the plugin at load;
	// later settings commits degrade to recorded errors instead.
	controller.reconcile(resolved, { throwOnError: resolved.enabled }).catch((error) => {
		throw new Error(`browser-bridge: ${errorMessage(error)}`)
	})

	applyBrowserTools(ctx, controller)
	// Unified self-update / design-registry tools (browser_check_update,
	// browser_design_show, browser_design_edit). Read-only pair plus an
	// approval-gated writer over the package registry copies.
	applyUnifiedTools(ctx, resolved)
	ctx.effect(() => () => {
		void controller.stop()
	}, 'browser-bridge: server lifecycle')
}
