/**
 * offline-diagnosis.ts — 把「扩展没连上」拆成**能被指名的一条原因**。
 *
 * 为什么需要：`extension_offline` 是一个把四件完全不同的事压成一模一样的症状的报错 ——
 * 端口不对 / 令牌不对 / 扩展没装在这个资料页 / 扩展被禁用。用户与模型看到的都是
 * 「浏览器扩展没连上」，于是只能猜；2026-11-15 与 11-16 台机那两次故障就是这样
 * 各花了几十分钟。修法各不相同，所以这里只做一件事：**把证据摆出来并指名**。
 *
 * 设计约束：
 *  1. **纯函数**，不读盘、不联网 —— 证据由调用方收集，这样它能在离线台子上被逐条钉住；
 *  2. **不许把「读不出」当「确定没有」**（`unknown` 与 `absent` 分开）；
 *  3. 证据不足时**不编原因**，只说「拿不到决定性证据」+ 已核过什么 + 四种常见原因。
 *
 * @module offline-diagnosis
 */
/** 一条可能的原因。 */
export type OfflineCauseId = 
/** 这个浏览器 profile 已被另一个桥占着（L1 记录）。 */
'other-bridge-owns'
/** 扩展拨过桥，但 token 与桥配置不一致（被 401 拒）。 */
 | 'token-mismatch'
/** 扩展拨过桥，但被 Host / Origin 校验拒（本机网页冒充扩展时会这样）。 */
 | 'handshake-blocked'
/** 桥的端口不在扩展的扫描窗口内，扩展根本不会拨这个端口。 */
 | 'port-out-of-scan'
/** 目标 profile 里确定没有这个扩展。 */
 | 'extension-absent'
/** 目标 profile 里有这个扩展，但处于禁用状态。 */
 | 'extension-disabled'
/** 拉起的进程**根本没起来**（异步 `error`：可执行文件不在 / 无权限）。 */
 | 'launch-failed'
/** 拉起的进程以 exit 21（PROFILE_IN_USE）退出：user-data-dir 被别的浏览器进程拿着，本次启动作废。 */
 | 'profile-in-use'
/** 拉起的进程几乎立刻退出（exit 0）：启动被合并进已运行实例，目标资料页没加载。 */
 | 'merged-into-running-instance'
/** 曾经 hello 过，现在断了。 */
 | 'dropped-after-hello'
/** 拉起后等到超时也没有 hello，进程还在。 */
 | 'hello-timeout'
/** 没有拉起动作，也从没 hello 过。 */
 | 'never-connected';
/** 扩展在目标 profile 里的存在性。`unknown` 与 `absent` 必须分开。 */
export type ExtensionPresence = 'present-enabled' | 'present-disabled' | 'absent' | 'unknown';
export interface OfflineCause {
    readonly id: OfflineCauseId;
    /** 一句话（含证据里的具体值），给模型/人读。 */
    readonly detail: string;
    /** 具体读数，贴进工单/复盘用。 */
    readonly evidence: readonly string[];
}
/** 调用方收集好的证据。字段省略＝这条没核过（不是「没有」）。 */
export interface OfflineEvidence {
    /** 桥真正绑定的端口。 */
    readonly port?: number | undefined;
    /** 扩展的端口扫描窗口（默认 `9777..9786`）。 */
    readonly scanWindow?: {
        readonly base: number;
        readonly count: number;
    } | undefined;
    /** 握手被拒计数（来自 `BridgeServer.status.handshakeRejects`）。 */
    readonly handshakeRejects?: {
        readonly badToken: number;
        readonly badHost: number;
        readonly badOrigin: number;
        readonly lastReason?: string | undefined;
        readonly lastAt?: string | undefined;
    } | undefined;
    /** 最近一次成功的 hello（断开后仍在）。 */
    readonly lastHello?: {
        readonly version: string;
        readonly at: string;
        readonly extensionId?: string;
    } | undefined;
    /** 最近一次断开时刻。 */
    readonly lastDisconnectAt?: string | undefined;
    /** 本次要拉起/正在服务的浏览器 profile。 */
    readonly target?: {
        readonly userDataDir: string;
        readonly profileDir: string;
        readonly profileName?: string;
    } | undefined;
    /** 目标 profile 里扩展的存在性；`undefined` ＝ 没核。 */
    readonly extension?: ExtensionPresence | undefined;
    readonly extensionId?: string | undefined;
    /** L1：这个 userDataDir 上的另一个活占用者。 */
    readonly otherOwner?: {
        readonly port: number;
        readonly pid: number;
        readonly dshHome: string;
        readonly instanceName?: string | undefined;
        readonly startedAt: string;
    } | undefined;
    /** 拉起动作（有就说明这次是「拉不起来」，不是「从来没拉起」）。 */
    readonly spawn?: {
        readonly pid?: number | undefined;
        /** spawn 的时刻（ms epoch）。 */
        readonly spawnedAt?: number | undefined;
        /** 进程退出时刻（ms epoch）；没退出就没有这个字段。 */
        readonly exitedAt?: number | undefined;
        readonly exitCode?: number | null | undefined;
        /** 异步 `error` 的原文：有它＝进程从来没起来过（与"起来又退出"是两回事）。 */
        readonly spawnError?: string | undefined;
        /** 等到超时总共等了多少毫秒。 */
        readonly waitedMs: number;
    } | undefined;
    /** 环境标记：沙箱里没有用户登录态。 */
    readonly env?: 'desktop' | 'sandbox' | undefined;
}
export interface OfflineDiagnosis {
    /** 拿不到决定性证据时为 undefined。 */
    readonly primary?: OfflineCause;
    /** 全部命中（含 primary）的原因，按优先级排。 */
    readonly causes: readonly OfflineCause[];
    /** 拼好的那句话（前缀「诊断：」），调用方直接追加到错误文案后面。 */
    readonly text: string;
}
/**
 * 按证据给原因。
 *
 * 优先级 = 「越接近根因的越靠前」：占用（别的桥在管）> 握手被拒（扩展来了但被拦）
 * > 端口不在窗口内（扩展拨不到）> 浏览器进程根本没起来 > 扩展不在/被禁
 * > 资料页被别的浏览器进程占着（exit 21）> 启动被合并进已运行实例（exit 0）
 * > 曾经连上过 > 超时。
 * @param evidence - 调用方收集的证据。
 * @returns 诊断结果（`text` 已可直接拼进错误文案）。
 */
export declare function diagnoseOffline(evidence: OfflineEvidence): OfflineDiagnosis;
/**
 * 一句话版本（状态工具/日志用，不带全部证据）。
 * @param evidence - 证据。
 */
export declare function offlineCauseLine(evidence: OfflineEvidence): string;
