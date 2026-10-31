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
import { type UrlPolicyMode } from 'browser-unified-core';
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
interface ResolvedConfig {
    enabled: boolean;
    /** 只读档：模型只能读页面，不能操作。 */
    readOnly: boolean;
    /** 允许模型执行任意脚本（devtools 级能力）。 */
    allowScript: boolean;
    /** 允许 `browser_hold` 加防误触浮层。 */
    holdEnabled: boolean;
    /** 脚本执行后检查是否被带到未授权地址。 */
    evalNavGuard: boolean;
    /** 浮层出现方式：black = 操作时自动补；white = 只在调用时出现。 */
    holdMode: string;
    /** 焦点策略：auto（不抢窗口焦点，默认）/ always / never。 */
    focusMode?: string;
    /** 最小化时是否自动恢复窗口。 */
    restoreWhenMinimized?: boolean;
    /** de-034：谁来决定浏览器权限气泡（ask|policy|model）。 */
    permissionDecider?: string;
    /** de-034：每类策略条目（`pref=allow|deny|inherit`）。 */
    permissionPolicy?: string[];
    port: number;
    token: string;
    shotsDir: string;
    urlMode: UrlPolicyMode;
    blockMetadata: boolean;
    metadataHostnames: string[];
    metadataIps: string[];
    internetAccess: string | undefined;
    lanAccess: string | undefined;
    localAccess: string | undefined;
    internetTemp: boolean;
    lanTemp: boolean;
    localTemp: boolean;
    askMode: string;
    dshAccessEnabled: boolean;
    dshOrigins: string[];
    allowHosts: string[];
    denyHosts: string[];
    registryDir: string;
    autoLaunchEnabled: boolean;
    autoLaunchIdleSeconds: number;
    autoLaunchBrowserExe: string;
    autoLaunchProfileDir: string;
    autoLaunchProfileName: string;
    autoLaunchTempProfile: boolean;
    autoLaunchExtensionDir: string;
    layeredTools: boolean;
    autoLaunchOnToolUse: boolean;
    autoLaunchWaitMs: number;
    enabledGroups: string[];
}
/**
 * 「自动拉起 / 握手即学习」这批配置的指纹。
 *
 * 它们**不动监听器**（不用重启桥），但必须让断线 watchdog 与学习定时器跟着换配置：
 * 以前 `reconcileNow` 的早退只看 serverKey 与 policyKey，于是改完「自动拉起 / 断开容忍 /
 * 拉起用哪个 profile」要等端口或策略也变了才生效，而设置页当时就把新值显示成"已保存"
 * （2026-10-31 审计）。抽成纯函数是为了能直接钉住"哪些字段必须算进来"。
 * @param config - 解析后的配置（只需要这批字段）。
 * @returns 指纹串；禁用时为空串。
 */
export declare function autoLaunchFingerprint(config: {
    enabled: boolean;
    autoLaunchEnabled?: boolean;
    autoLaunchIdleSeconds?: number;
    autoLaunchBrowserExe?: string;
    autoLaunchProfileDir?: string;
    autoLaunchProfileName?: string;
    autoLaunchTempProfile?: boolean;
    autoLaunchExtensionDir?: string;
    autoLaunchOnToolUse?: boolean;
    autoLaunchWaitMs?: number;
}): string;
/**
 * 「握手即学习」失败后的退避时长（指数，封顶 10 分钟）。
 *
 * 学不成时 `learnedExtensionId` 不会被写入，于是 5 秒一次的定时器会**每轮全盘重扫**所有
 * profile —— 一直连着一个学不到位置的扩展就是每 5 秒一次磁盘风暴（2026-10-31 审计）。
 * @param attempts - 这个扩展 id 已经失败过几次（0 = 第一次失败）。
 * @returns 下次允许重试前要等的毫秒数（15s 起，指数增长，第 6 次起封顶 10 分钟）。
 */
export declare function learnRetryDelayMs(attempts: number): number;
/**
 * 桥的控制器：配置 → 监听器 / 策略 / 命令收口的唯一持有者。
 *
 * 导出只为一件事：**访问控制的判据能在离线台子上被钉住**（`src/tests/http-face-access.mjs`
 * 直接拿一个实例改状态、调两个入口，比较它们是否给出同一个拒绝）。不给别的模块用。
 */
export declare class BridgeController {
    private readonly log;
    private server;
    /** 实际绑定到的端口；端口被占时可能回退到 port+1..port+9。未启动时为 undefined。 */
    private boundPort;
    /** 端口回退说明，供 browser_policy_status 展示。 */
    private portNote;
    private guarded;
    private policy;
    private serverKey;
    private policyKey;
    /** 宿主推导的「本 DSH 控制页」地址（来自 webServer 服务）；用户登记列表之外的补充。 */
    private controlOrigins;
    private lastError;
    private chain;
    private current;
    /** Per-session grants: hosts the user approved once in ask mode. Cleared when
     *  policy inputs change or the plugin stops. */
    private readonly tempAllow;
    private watchdogTimer;
    private lastSpawnAt;
    private droppedSince;
    /** 上次成功配对（学到的浏览器位置），懒加载自 {@link pairingFile}。 */
    private pairing;
    /** 定位失败时到底扫了什么、为什么没命中 —— 状态工具要把这句话说出来。 */
    private locateNote;
    /** 已经学过其位置的扩展 id（避免重复扫盘）。 */
    private learnedExtensionId;
    /**
     * 「握手即学习」失败时的退避状态。
     *
     * 为什么需要：学习失败（按扩展 id 反查不到装了它的 profile）时 `learnedExtensionId` 不会被写入，
     * 于是 5 秒一次的定时器**每轮全盘重扫**一遍所有 profile —— 一直连着一个学习不了的扩展，
     * 就是每 5 秒一次磁盘风暴。改成指数退避：同一个扩展 id 失败后按 15s → 30s → … → 10min 退避，
     * 下次换 id 或配置变了（`refreshLearnTimer`）才立刻重试。
     */
    private learnFailure;
    /**
     * 「握手即学习」的定时器。
     *
     * 为什么必须在**连着的**时候学：`hello` 只在扩展连着时存在（断开即清空），
     * 而"需要拉起"恰恰发生在**断开**时 —— 等到那时再去读 id，读不到。所以一看到
     * 新 id 就立刻反查磁盘并落盘，之后的冷启动才有依据。
     */
    private learnTimer;
    /** 上一次重建 watchdog / 学习定时器用的 autoLaunch* 快照（见 reconcileNow 里那个早退）。 */
    private autoLaunchKey;
    constructor(log: (line: string) => void);
    /** Resolved directory screenshots land in; defined once any config arrived. */
    get shotsDir(): string | undefined;
    /** 把一个目标系统形态的路径换成当前进程能访问的形态（WSL 下 `C:\…` → `/mnt/c/…`）。 */
    private localForm;
    /** 配对记录的落盘位置：`$DSH_HOME/browser-unified-pairing.json`（两个实例各自的 DSH_HOME 天然隔离）。 */
    private pairingFile;
    private loadPairing;
    private savePairing;
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
    private resolveLaunchTarget;
    /** 在 `refreshWatchdog` 的每个出口旁调用：只在桥启用时做"握手即学习"。 */
    private refreshLearnTimer;
    /**
     * 看 `hello` 学一次位置（幂等）。学成了就不再重复扫盘，直到换了一个扩展 id。
     *
     * 扫盘本身很贵（每个 profile 都要读磁盘），所以**失败也要退避**：
     * 见 {@link learnFailure}。`loadPairing()` 只在真需要判断时读一次，不进 5 秒热路径。
     * @param config - 当前解析后的配置。
     */
    private learnFromHello;
    /**
     * 找浏览器可执行文件。
     *
     * **只返回真实存在的路径**（posix 上允许裸名交给 PATH 解析）。绝不返回"可能的名字"：
     * WSL 下 `spawn('msedge')` 会 ENOENT，而那个错误是**异步**的、会被 `child.on('error')`
     * 吞掉，函数照旧返回"已拉起" —— 实测就是这个假成功让自动拉起一直静默失效。
     * @param configured - 用户显式填的 exe（非空则以它为准）。
     * @param brandId - 限定品牌（来自 `hello`）；省略=按登记表找全部。
     */
    private resolveBrowserCandidates;
    /** Snapshot for the read-only policy-status tool. */
    describePolicy(): {
        enabled: boolean;
        holdMode?: string;
        holdEnabled?: boolean;
        evalNavGuard?: boolean;
        focusMode?: string;
        restoreWhenMinimized?: boolean;
        permissionDecider?: string;
        holdSyncNote?: string;
        urlMode?: string;
        internetAccess?: string;
        lanAccess?: string;
        localAccess?: string;
        internetTemp?: boolean;
        lanTemp?: boolean;
        localTemp?: boolean;
        askMode?: string;
        autoLaunchEnabled?: boolean;
        autoLaunchIdleSeconds?: number;
        autoLaunchProfileDir?: string;
        autoLaunchProfileName?: string;
        dshAccessEnabled?: boolean;
        dshOrigins?: string[];
        allowHosts?: string[];
        denyHosts?: string[];
        denyHostsIgnored?: boolean;
        blockMetadata?: boolean;
        metadataHostnames?: string[];
        metadataIps?: string[];
        tempGrants: readonly string[];
        ready: boolean;
        boundPort?: number;
        requestedPort?: number;
        portNote?: string;
        extensionId?: string;
        browserName?: string;
        bridgeProtocol?: number;
        extensionProtocol?: number;
        protocolCompatible?: boolean;
        protocolNote?: string | null;
        pairing?: {
            brandId: string;
            profileDir: string;
            profileName?: string;
            userDataDir: string;
            matchedBy: string;
            resolvedAt: string;
        };
        launchNote?: string;
    };
    /** (Re)arm the watchdog from the resolved config; clears it when disabled. */
    private refreshWatchdog;
    private watchdogTick;
    /**
     * de-013 model-invoked launch: bring the extension's browser back up on
     * demand. Unlike the disconnect watchdog this does not require
     * `autoLaunchEnabled` — the model asks, the browser starts. Spawn
     * parameters come from the same autoLaunch* settings the watchdog uses.
     * A short cooldown prevents the model from spawning a window per call.
     * @returns a human-readable outcome for the tool layer.
     */
    launchBrowser(landingUrl?: string): string;
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
    wakeBrowser(options?: {
        url?: string;
        reason?: string;
    }): Promise<string>;
    /**
     * 校验候选项能否当"唤醒落地页"：必须 http(s)，且当前策略**直接放行**（allow）——
     * `ask`/`block`/`unavailable` 一律不用（唤醒不该成为绕过审批的通道）。
     * @returns 可用则返回归一化后的 URL，否则 undefined（调用方退回 about:blank）。
     */
    private wakeLandingUrl;
    private spawnBrowser;
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
    setControlOrigins(origins: readonly string[]): void;
    reconcile(config: ResolvedConfig, options?: {
        throwOnError?: boolean;
    }): Promise<void>;
    private reconcileNow;
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
    private static readonly SCRIPT_COMMANDS;
    /** 会让扩展"自动补浮层"的命令 + 浮层自身的命令：执行前把当前模式推下去。 */
    private static readonly HOLD_MODE_COMMANDS;
    private static readonly READ_ONLY_ALLOWED;
    /**
     * 已经推给扩展的浮层模式（`mode|扩展id|连接状态`）。扩展重连或配置变更后戳记不同 ⇒ 重推一次。
     * 旧扩展不认识 `hold.config`：推送失败就保持在白名单行为，不影响任何调用。
     */
    private holdModeStamp;
    /** 上一次把浮层模式推给扩展的结果（诊断用；undefined = 还没推过）。 */
    private holdSyncNote;
    /** 当前是否只读档（`accessLevel: 'read-only'`）。 */
    private isReadOnly;
    /**
     * 访问控制的两道闸（只读档 / 关掉「允许执行任意脚本」）。
     *
     * **工具面与 HTTP 命令面共用这一份判据**：以前只有 `execute` 里写了这两道，
     * 而 `POST /api/command` 走的是 core 的 `guardCommand` 钩子、根本不过 `execute`
     * ⇒ 同一个只读档，模型调不动 `browser_click`，同伴件带 token 一次 POST 就能点
     * （2026-11-01 审计第 2 条）。判据抽出来以后，两个入口谁都不能单方面漏掉。
     * @param command - 扩展命令名。
     * @returns 拒绝原因（给模型/调用方看）；undefined = 放行。
     */
    private accessDenial;
    /**
     * 最近一条对话框记录所在的标签页 —— `dialog` 的 `answer` 默认就作用于它（扩展侧
     * `dialogLog[dialogLog.length - 1].tabId`）。授权必须判**那个**页面，不能拿当前激活页顶包。
     * 读不到（没有记录 / 桥没起 / 扩展没连）返回 undefined：调用方据此 fail-closed。
     */
    lastDialogTabId(): Promise<number | undefined>;
    execute(command: string, params: Record<string, unknown>, signal: AbortSignal, timeoutMs?: number): Promise<unknown>;
    /**
     * 把「浮层出现方式」推给扩展（只在变更/重连后推一次）。
     * 推不动（旧扩展不认识这条命令、或桥刚断）就保持白名单行为 —— 浮层是附加保护，不该让调用失败。
     */
    private syncHoldMode;
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
    guardHttpCommand(command: string, params: Record<string, unknown>): Promise<string | undefined>;
    authorizeUrl(raw: string): Promise<{
        decision: 'allow' | 'ask' | 'block';
        code?: string;
        reason: string;
        host: string;
    } | {
        decision: 'unavailable';
    }>;
    /** Remember one host for the rest of this session (ask-mode grant). */
    grantTemporary(host: string): void;
    /**
     * Delete generated artifacts using the currently resolved directories;
     * works while the bridge is stopped because it never touches the socket.
     * @returns counts and names of what was removed.
     */
    cleanup(): Promise<{
        shotsRemoved: number;
        scratchRemoved: readonly string[];
    }>;
    /** Stop the listener; safe to call repeatedly and during teardown. */
    stop(): Promise<void>;
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
export {};
