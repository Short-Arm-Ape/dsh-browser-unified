/**
 * Vendored from @caob23/dsh-browser-control v1.0.7 (AGPL-3.0), file src/server.ts.
 * Part of the AGPL-3.0-licensed browser-unified-core merge; two mechanical
 * adaptations for this package's NodeNext emit: the internal import was
 * rewritten to './ws.js', and `import type net` became a namespace import.
 * Upstream: https://github.com/caob23/dsh-browser-control
 *
 * 2026-10-10：并入上游 **v1.0.8**（`43e6325`，同 AGPL-3.0）的安全强化 —— WebSocket
 * 升级加 `Host` 回环校验与 `Origin` 校验（挡 DNS-rebinding 与网页直接拨号）、HTTP 面
 * 鉴权接受 `Authorization: Bearer` / `X-Token` / `?token=` 并用 `timingSafeEqual`、
 * 状态页不再把 token 内嵌进 HTML（改 sessionStorage + 现问）。我们保留的差异：
 * ① `guardCommand` 策略钩子（X18）；② 空 token = 不校验的向后兼容；③ `/api/status`
 * 仍对**回环来源**回显 CORS（GUI 设置页的只读探测依赖它，`ACAO: *` 已收窄成回环回显）。
 *
 * Local WebSocket+HTTP bridge between one browser extension and dsh. The
 * extension connects OUT to `ws://127.0.0.1:<port>/ws?token=...`, so no
 * native-messaging host or registry setup exists; dsh drives commands through
 * {@link BridgeServer.execute} and reads link state through {@link BridgeServer.status}.
 * A small HTTP face (`/api/status`, `/api/command`, `/api/cleanup`, `/`) keeps
 * the bridge usable from curl while the server runs.
 *
 * Wire protocol (text frames, one JSON object each):
 * - extension → server: `{type:'hello',…}`, `{type:'pong',t}`, `{type:'result',id,ok,result?|error}`
 * - server → extension: `{type:'ping',t}`, `{type:'command',id,command,params}`
 *
 * Command names (sent in `command`) include: `ping`, `browser.info`, `tabs.list/open/close/activate`,
 * `nav`, `eval`, `content`, `find`, `click`, `input`, `press`, `scroll`, `snapshot`, `screenshot`,
 * `wait`, `dialog`, `console.log`, `network.log`, `network.clear`, `pdf`, `emulate`.
 * @module @deepseek-ai/dsh-browser-bridge/server
 */
/**
 * 本桥说的线协议版本。与包版本分开：扩展新一个补丁版照样能用，但**帧契约不同**就必须亮灯。
 * （与上游 v1.0.9 的 `protocol` 字段同口径；我们没有该字段的旧扩展一律按 v1 兼容处理。）
 */
export declare const BRIDGE_PROTOCOL_VERSION = 1;
/** Per-command ceiling when the caller passes none. */
export declare const DEFAULT_COMMAND_TIMEOUT_MS = 60000;
/** Hard ceiling accepted from callers; longer waits cannot be expressed. */
export declare const MAX_COMMAND_TIMEOUT_MS = 300000;
/** Identity the extension announces right after the handshake completes. */
export interface BridgeHello {
    readonly client: string;
    readonly version: string;
    readonly browser: {
        readonly name: string;
        readonly version: string;
        readonly ua: string;
    };
    /**
     * Extension id (`chrome.runtime.id`), when the extension reports it.
     *
     * 这是桥唯一能拿到"扩展是谁"的稳定标识 —— 浏览器侧没有"我在哪个 profile"的接口，
     * 更读不了 `edge://version`（scheme 被拦），所以插件要拿这个 id 去磁盘上
     * 反查"哪个 profile 装了它"。旧版扩展不带此字段，故可选。
     */
    readonly extensionId?: string;
    /** 扩展声明的帧契约版本；缺失＝0（早于版本协商的扩展）。 */
    readonly protocol?: number;
}
/** Snapshot of the link and in-flight work, served verbatim on `/api/status`. */
export interface BridgeServerStatus {
    readonly listening: boolean;
    readonly port: number | undefined;
    readonly extensionConnected: boolean;
    readonly connectedAt: string | undefined;
    readonly hello: BridgeHello | undefined;
    /** 本桥说的协议版本。 */
    readonly bridgeProtocol: number;
    /** 扩展声明的协议版本；缺失/0 ＝ 早于版本协商。 */
    readonly extensionProtocol: number;
    /** 两边帧契约是否对得上；对不上时 `protocolNote` 说明原因。 */
    readonly protocolCompatible: boolean;
    readonly protocolNote: string | null;
    readonly pendingCommands: number;
    readonly lastError: string | undefined;
    /**
     * Token 还是内置默认值（`dsh-local`）或短于 16 字符 —— 状态面据此标红，
     * 因为**回环绑定不是边界，token 才是**（上游 v1.0.8 的口径）。
     */
    readonly insecureToken: boolean;
    /** 运行中**正在生效**的策略快照（来自 `BridgeServerOptions.describePolicy`）；没提供就是 undefined。 */
    readonly policy?: Record<string, unknown>;
}
/** Caller controls for one {@link BridgeServer.execute} round-trip. */
export interface BridgeExecuteOptions {
    /** Fail the command after this many milliseconds; defaults to 60s, capped at 300s. */
    readonly timeoutMs?: number;
    /** Cancellation from the tool execution; aborting fails the in-flight command. */
    readonly signal?: AbortSignal;
}
/** What {@link BridgeServer.cleanup} removed. */
export interface CleanupResult {
    /** Files deleted directly inside the screenshots directory. */
    readonly shotsRemoved: number;
    /** Scratch files deleted (agent temp scripts/artifacts matched by convention). */
    readonly scratchRemoved: readonly string[];
}
export interface BridgeServerOptions {
    readonly port: number;
    readonly token: string;
    /** Directory whose direct contents `cleanup()` clears; created on demand. */
    readonly shotsDir: string;
    /** Directory scanned for agent scratch files by `cleanup()`; defaults to the process working directory. */
    readonly scratchDir?: string;
    /** Optional line logger for lifecycle diagnostics. */
    readonly log?: (line: string) => void;
    /**
     * Optional policy hook for the HTTP command face (`POST /api/command`).
     *
     * 为什么需要它（X18，2026-10-10）：WS 面向扩展；宿主工具走 `GuardedBridge`（导航过
     * `UrlPolicy`）＋工具层的"已开标签页红线"；而 **HTTP 命令面**是第三条通道
     * （同伴件的 browser_frames / browser_frame_eval 就走它），它此前**完全不过策略** ——
     * 等于"带 token 就能对任意标签页 eval / nav"。这个钩子让宿主把策略接回来。
     * @returns 拒绝原因（非空字符串即拒绝 → HTTP 403）；undefined 表示放行。
     */
    readonly guardCommand?: (command: string, params: Record<string, unknown>) => string | undefined | Promise<string | undefined>;
    /**
     * Optional read-only "what is in force right now" snapshot for the status face.
     *
     * 为什么需要它（2026-10-17）：设置页里存下来的值 ≠ 运行中生效的值 —— 改完没重启时两者会
     * 不一致，而设置页原来只能显示"存下来的"，于是用户看到"已开启"、实际仍被拒（`WEB_DSH_DISABLED`）。
     * 让桥把**生效值**一起吐出来，设置页就能把差异显式标出来（"改动需重启才生效"），
     * 而不用靠人猜。
     *
     * 只放只读、非机密的字段（策略开关与名单）；调用方必须容错：抛错就当没有。
     */
    readonly describePolicy?: () => Record<string, unknown> | undefined;
    /** 本机插件版本（设置页「检查更新」拿它和最新发布比）。 */
    readonly pluginVersion?: string;
}
/**
 * 校验并规范化扩展发来的 `hello` 帧。
 *
 * **为什么单独抽出来（2026-10-17 实测发现）**：这段原来内联在 WS 消息处理里、逐字段手抄，
 * 抄的时候**漏了 `protocol`** —— 于是 `extensionProtocol` 恒为 0。扩展明明在 hello 里声明了
 * `protocol: 1`（rig 里 hello 帧也确实是 1），桥却在落库时把它丢了，协议协商从来没真正生效过。
 * 手抄字段这种活最容易漏，所以抽成纯函数并单测。
 */
export declare function normalizeHello(msg: Record<string, unknown>): BridgeHello;
/**
 * Clear the screenshots directory and delete agent scratch files. Only the
 * top level of each location is touched; nested trees stay untouched.
 * @param options - `shotsDir` is cleared of direct file children; `scratchDir`
 *   defaults to the process working directory and loses only scratch-named files.
 * @returns counts and names of what was removed.
 */
export declare function cleanupArtifacts(options: {
    shotsDir: string;
    scratchDir?: string;
}): Promise<CleanupResult>;
/**
 * One live bridge endpoint. Start/stop may cycle repeatedly on one instance;
 * a fresh listener is built per start so a changed config reuses the class
 * without re-allocation concerns. Exactly one extension link is held at a
 * time; a newer WebSocket replaces the older one.
 */
export declare class BridgeServer {
    private readonly options;
    private httpServer;
    private clientSocket;
    private hello;
    private connectedAt;
    private readonly pending;
    private lastError;
    private continuationRemainder;
    private continuationOpen;
    constructor(options: BridgeServerOptions);
    /** Current link state, also served verbatim as `/api/status`. */
    get status(): BridgeServerStatus;
    /** Bind `127.0.0.1:<port>` and start accepting the extension plus HTTP calls. */
    start(): Promise<void>;
    /** Close the extension link, fail every pending command, and release the port. Idempotent. */
    stop(): Promise<void>;
    /**
     * Send one command to the connected extension and await its result.
     * Throws while no extension is linked; the rejection message names the fix.
     */
    execute(command: string, params: Record<string, unknown>, options?: BridgeExecuteOptions): Promise<unknown>;
    /**
     * Delete generated screenshots and agent scratch files via
     * {@link cleanupArtifacts} using this server's configured directories.
     */
    cleanup(): Promise<CleanupResult>;
    private log;
    /**
     * 协议不匹配的说明，或 null（能对话）。**声明 0/缺失的老扩展按 v1 兼容处理**：
     * 它能答本桥发过的每一条命令，为了一处形式上的缺口把可用装置判死并不值得。
     */
    private get protocolNote();
    private handleHttp;
    /**
     * 请求是否携带桥的 token —— 与 WebSocket 升级同一个凭据。接受三种形式：
     * `Authorization: Bearer <token>`、`X-Token` / `X-DSH-Token: <token>`、`?token=<token>`
     * （查询串形式留给 curl 与状态页）。
     *
     * 空 token 视为不校验：配置显式关掉 token 时保持旧行为（本仓库相对上游的差异点）。
     * @returns 凭据是否有效。
     */
    private authorized;
    private rejectUnauthenticated;
    /**
     * 唯一的 JSON 出口。默认**不发任何 CORS 头**；只有显式给出 `corsOrigin`
     * （只在 `/api/status` 且来源是回环时）才回显该来源。
     */
    private respondJson;
    private handleCommandRequest;
    /**
     * 失败 → HTTP 响应。有 {@link BridgeError} 时按 `code` 给状态码（不再靠 message 前缀猜），
     * 并把 `code` / `effectState` / `hint` 一并交出去 —— HTTP 面本来就是给脚本/curl 用的，
     * 结构化字段在这里**读得到**（模型面只能读 message，那是另一条路径，见 errors.ts 的注释）。
     */
    private errorResponse;
    private handleUpgrade;
    private handleFrame;
    private handleText;
    private closeClientSocket;
    private failAllPending;
    private logVerbose;
}
