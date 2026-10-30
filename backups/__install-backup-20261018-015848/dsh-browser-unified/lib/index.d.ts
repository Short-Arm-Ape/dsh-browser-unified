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
import { type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { readPermissionStore, type PermissionReading } from './permissions.js';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-bridge";
/** The tool registry this plugin contributes `browser_*` tools to. */
export declare const inject: string[];
/** Settings namespace carrying the bridge switch and endpoint options. */
export declare const BROWSER_BRIDGE_SETTINGS_NAMESPACE = "browser-bridge";
export interface Config {
    /**
     * Whether the local bridge listens. Defaults to true so the plugin is
     * usable immediately after install; set false to keep the tools mounted but
     * every call reports how to enable the bridge, so the opt-out stays explicit.
     */
    enabled?: boolean;
    /** Loopback port the extension dials; the HTTP face shares it. */
    port?: number;
    /** Shared secret the extension presents on the WebSocket upgrade query. */
    token?: string;
    /**
     * Directory screenshots are written to and `cleanup` clears. Relative paths
     * resolve against the process working directory at resolve time.
     */ shotsDir?: string;
    /**
     * URL policy mode applied to navigation commands. `public` (default): blocks
     * private/loopback/metadata targets before they reach the extension.
     * `intranet`: allows local/LAN targets while still blocking cloud-metadata
     * endpoints. Lives on the bridge instance config (registry via Settings).
     */
    urlMode?: string;
    /**
     * Master switch for cloud-metadata endpoint blocking (both modes). Default
     * true. Turn off only when you deliberately accept access to
     * instance-metadata services (e.g. inside your own VPC sandbox).
     */
    blockMetadata?: boolean;
    /**
     * Cloud-metadata HOSTNAMES to always block (both modes). This list FULLY
     * replaces the built-in defaults — the defaults are only the initial value
     * shown in Settings. `[]` blocks none of this family. Entries are matched
     * after hostname normalization (lowercase, trailing dot/brackets stripped).
     */
    metadataHostnames?: string[];
    /**
     * Cloud-metadata IP literals to always block (both modes). Same
     * replace-or-default contract as `metadataHostnames`.
     */
    metadataIps?: string[];
    /**
     * Per-realm access policies. Realms: 外网 `internet` / 局域网 `lan` /
     * 本机 `local` (loopback). Each may be `allow` (default), `ask` (approval
     * required unless allowlisted / session-granted) or `deny`.
     */
    internetAccess?: string;
    lanAccess?: string;
    localAccess?: string;
    /** Whether ask-mode approvals may grant temporary hosts this session, per realm. Default true. */
    internetTemp?: boolean;
    lanTemp?: boolean;
    localTemp?: boolean;
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
    askMode?: string;
    /**
     * DSH-page special rule: when enabled, origins in `dshOrigins` (the harness
     * control page, e.g. http://127.0.0.1:3080) are reachable even under the
     * `public` routing stance and skip the realm ask/deny layer. Enabling is
     * double-confirmed in the GUI: the model could otherwise drive its own
     * approval prompts from that page. Under a host approval policy of `never`,
     * this is the only way to grant such access (approvals cannot be asked).
     */
    dshAccessEnabled?: boolean;
    dshOrigins?: string[];
    /**
     * Hosts that never need per-host approval in `ask` realms. Exact hostnames/IPs
     * or `*.suffix` wildcards (matches any subdomain).
     */
    allowHosts?: string[];
    /**
     * Hosts the user wants denied —— **用户名单（L3），不是红线**。Exact hostnames/IPs 或
     * `*.suffix` 通配。在 deny/allow 分域、以及 `ask` 分域都生效，**唯一例外**是
     * `askMode === 'allow'`（受限态"放行"档 = 连黑白名单一起忽略，de-016/de-018）。
     * 硬红线（云元数据、内嵌凭据、DSH 控制页关闭时的拦截、路由档）**不受本列表与 askMode 影响**。
     * （旧注释曾写"always denied — regardless of …"，与实现不符，已按实现订正。）
     */
    denyHosts?: string[];
    /**
     * Absolute directory containing `design/registry.json` and
     * `upstream-baseline.json` for the self-update tools. Empty (default) means
     * the copies bundled under the package `registry/` directory.
     */
    registryDir?: string;
    /** de-013: auto-launch a browser when the extension has been disconnected too long. Default false. */
    autoLaunchEnabled?: boolean;
    /** Seconds the extension may stay disconnected before an auto-launch attempt. Default 15. */
    autoLaunchIdleSeconds?: number;
    /** Browser executable to launch (e.g. msedge.exe full path). Omit to search PATH for msedge/chrome. */
    autoLaunchBrowserExe?: string;
    /** Existing dedicated profile dir for the extension (recommended). Empty = default profile of the executable. */
    autoLaunchProfileDir?: string;
    /** Edge/Chrome 配置文件名称（如 'Profile 4'/'Default'）。留空=自动识别目录名或 Default。 */
    autoLaunchProfileName?: string;
    /** Use a fresh temporary profile (like an incognito/clean instance) instead of a profile dir. */
    autoLaunchTempProfile?: boolean;
    /** When using a temporary profile: path to an UNPACKED extension dir to sideload (`--load-extension`). */
    autoLaunchExtensionDir?: string;
    /** 工具面分层：只把常驻白名单 + 已展开组的 `browser_*` 交给模型（关掉=全部暴露）。默认 true。 */
    layeredTools?: boolean;
    /** 模型调用 `browser_*` 而扩展未连接时，先自动拉起浏览器再放行。默认 false（避免你没预期时弹窗口）。 */
    autoLaunchOnToolUse?: boolean;
    /** 自动拉起后等扩展连上的上限（毫秒）。默认 8000。 */
    autoLaunchWaitMs?: number;
    /** 启动时就展开的工具组（interact/debug/session/frames/registry）。默认 []。 */
    enabledGroups?: string[];
}
export declare const Config: z<Config>;
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
export declare function snapshotModeOf(rawMode: string | undefined, rawFallback: string | undefined, wantAx: boolean): {
    mode: 'ax' | 'dom';
    axFallback?: string;
};
export declare function denyHostsStatusLine(shown: string, ignored: boolean): string;
/** 扩展端 `emulate` 的原始回包（无 UA 覆盖时 `userAgent` 是**显式** `null`）。 */
export interface EmulateRawValue {
    tabId: number;
    reset?: boolean | null;
    width?: number | null;
    height?: number | null;
    deviceScaleFactor?: number | null;
    isMobile?: boolean | null;
    hasTouch?: boolean | null;
    userAgent?: string | null;
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
export declare function normalizeEmulateValue(raw: EmulateRawValue): {
    tabId: number;
    reset?: boolean;
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
    isMobile?: boolean;
    hasTouch?: boolean;
    userAgent?: string;
};
export declare function permissionReport(input: {
    origin: string;
    tabId: number | undefined;
    store: ReturnType<typeof readPermissionStore>;
    readings: PermissionReading[];
    pendingLocal: ReadonlyArray<{
        url: string;
        ageSeconds?: number;
    }>;
    requestedClass: string | undefined;
    /** 读取时的形态转换说明（bi-013）：非空时在报告头上写一行，别让"静默换路径"发生。 */
    storeNote?: string;
}): string;
export declare function sessionTitleOf(sessionId: string, now?: number): string | undefined;
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export declare function apply(ctx: Context, config: Config): void;
