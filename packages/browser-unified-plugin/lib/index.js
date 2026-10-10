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
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool as rawDefineTool } from '@deepseek-ai/dsh-tools';
import { BridgeServer, cleanupArtifacts, GuardedBridge, UrlPolicy } from 'browser-unified-core';
import { DEFAULT_METADATA_HOSTNAMES, DEFAULT_METADATA_IPS, realmOf } from 'browser-unified-core';
import { applyUnifiedTools, currentPluginVersion, loadIssues } from './unified-tools.js';
// 原 dsh-browser-buddy 的能力（de-036 合并）：工具面分层 / 状态注入 / 调用即唤醒 / 登记簿送达
// + browser_tools / browser_frames / browser_frame_eval。
import { applyBuddyFeatures } from './buddy.js';
import { CONTENT_SETTING, chromiumTime, readOriginPermissions, readPermissionStoreTolerant } from './permissions.js';
import { brandIdFromHelloName, exeCandidates, hostStyle, locateExtensionProfile, profileDisplayName, profileHasExtension, splitProfilePath, toLinuxPath, } from './browser-profiles.js';
// Schema shapes below are the same ones the upstream plugin shipped and the
// dsh-tools assert layer validates at runtime; the loose wrapper only widens
// the compile-time view (types differ between rc builds).
const defineTool = (options) => rawDefineTool(options);
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-bridge';
/** The tool registry this plugin contributes `browser_*` tools to. */
export const inject = ['tools', 'systemPrompt'];
/** Settings namespace carrying the bridge switch and endpoint options. */
export const BROWSER_BRIDGE_SETTINGS_NAMESPACE = 'browser-bridge';
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
});
/**
 * Validate a dsh-origin entry: `http(s)://host[:port]` or `host:*` (any port).
 */
function assertOriginList(list) {
    if (!Array.isArray(list))
        return;
    if (list.length > 16)
        throw new Error('browser-bridge: dshOrigins 最多 16 条');
    const ok = (raw) => {
        const value = raw.trim().toLowerCase();
        if (value.length === 0 || value.length > 200 || /\s/.test(value))
            return false;
        if (/^https?:\/\/[a-z0-9.\-\[\]:]+$/.test(value))
            return true;
        if (/^[a-z0-9.\-\[\]]+:\*$/.test(value))
            return true;
        return false;
    };
    for (const raw of list) {
        if (typeof raw !== 'string' || !ok(raw)) {
            throw new Error(`browser-bridge: dshOrigins 包含非法条目 "${String(raw)}"（格式: http(s)://host[:port] 或 host:*）`);
        }
    }
}
const MAX_METADATA_ENTRIES = 64;
const MAX_HOST_ENTRIES = 128;
/**
 * Validate a host-list (allow/deny/metadata). Entries must survive hostname
 * normalization (optionally as a `*.suffix` wildcard) and contain no URL
 * syntax / whitespace / control characters.
 */
function assertHostList(kind, list) {
    const bad = (entry) => {
        throw new Error(`browser-bridge: ${kind} 包含非法条目 "${entry}"（仅允许主机名/IP 或 *.suffix，去掉协议、路径与空白）`);
    };
    if (!Array.isArray(list))
        return;
    if (list.length > MAX_HOST_ENTRIES) {
        throw new Error(`browser-bridge: ${kind} 最多 ${MAX_HOST_ENTRIES} 条`);
    }
    for (const raw of list) {
        if (typeof raw !== 'string')
            bad(String(raw));
        const entry = raw.trim();
        if (entry.length === 0)
            bad(raw);
        if (entry.length > 253)
            bad(raw);
        if (/[\s/\\@?#\u0000-\u001f\u007f]/.test(entry))
            bad(raw);
    }
}
/**
 * Validate the metadata endpoint configuration. Both lists are fully
 * user-maintained (the built-ins are only their initial value); entries must
 * survive hostname normalization and contain no URL syntax.
 */
function assertMetadataLists(config) {
    assertHostList('metadataHostnames', config.metadataHostnames);
    assertHostList('metadataIps', config.metadataIps);
}
/**
 * 「本 DSH 控制页」的本机地址：由宿主从 `webServer.port` 推导，**不再要求用户登记一个会过期的
 * 写死 origin**（GUI 端口可以变，也可能是 OS 随机分配的端口 0 → 实际监听端口）。
 * 用户自己登记的列表仍然生效，用于额外地址（局域网 IP / 自定义域名 / 反向代理等）。
 */
function mergeDshOrigins(config, controlOrigins) {
    const merged = [...(config.dshOrigins ?? [])];
    for (const origin of controlOrigins) {
        if (!merged.includes(origin))
            merged.push(origin);
    }
    return merged;
}
function policyOptionsFor(config, controlOrigins = []) {
    return {
        mode: config.urlMode,
        blockMetadata: config.blockMetadata,
        metadataHostnames: config.metadataHostnames ?? [...DEFAULT_METADATA_HOSTNAMES],
        metadataIps: config.metadataIps ?? [...DEFAULT_METADATA_IPS],
        internetAccess: config.internetAccess,
        lanAccess: config.lanAccess,
        localAccess: config.localAccess,
        internetTemp: config.internetTemp ?? true,
        lanTemp: config.lanTemp ?? true,
        localTemp: config.localTemp ?? true,
        dshAccessEnabled: config.dshAccessEnabled ?? false,
        dshOrigins: mergeDshOrigins(config, controlOrigins),
        allowHosts: config.allowHosts ?? [],
        // de-016/de-018: 受限态「放行」档 = 忽略黑名单（红线/元数据/DSH 等仍先行）。
        // 策略实例按当前 askMode 静态构建；红线不经此列表，因此仍生效。
        denyHosts: config.askMode === 'allow' ? [] : config.denyHosts ?? [],
    };
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
function textBlock(text, max = 20_000) {
    const value = String(text ?? '');
    if (value.length <= max)
        return [{ type: 'text', text: value }];
    return [{ type: 'text', text: `${value.slice(0, max)}\n…（已截断：全文 ${value.length} 字符；分段取可用 browser_evaluate，过滤可用 urlPattern/status）` }];
}
const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/;
const READ_CONTENT_MAX_CHARS = 120_000;
/**
 * 把 `selector` / `text` / `fn` 三种写法收敛成扩展 `wait` 命令的参数 + 一句人话标签。
 *
 * 三者是**互斥**的（共用同一个 `wait` 命令），同时给了就按 selector > text > fn 取第一个，
 * 并把选择写进标签里 —— 免得"我传了但等的是另一个条件"这种静默歧义。
 */
function describeWaitCondition(args) {
    const selector = args.selector ?? args.waitSelector;
    const text = args.text ?? args.waitText;
    const fn = args.fn ?? args.waitFn;
    if (typeof selector === 'string' && selector.length > 0)
        return { params: { selector }, label: `选择器出现 ${selector}` };
    if (typeof text === 'string' && text.length > 0)
        return { params: { text }, label: `正文包含「${text}」` };
    if (typeof fn === 'string' && fn.length > 0)
        return { params: { fn }, label: `谓词为真 ${fn}` };
    return undefined;
}
/**
 * 把 `urlPattern` 编译成匹配器：`/re/flags` 形式按正则，其余按**子串**（默认大小写不敏感）。
 * 正则写坏时不抛（退回子串匹配）—— 批量关页签是收拾动作，不该因为一个 pattern 写错整批失败。
 */
function compileUrlPattern(pattern) {
    const asRegex = /^\/(.*)\/([a-z]*)$/.exec(pattern);
    if (asRegex !== null) {
        try {
            const flags = asRegex[2].includes('i') ? asRegex[2] : `${asRegex[2]}i`;
            const re = new RegExp(asRegex[1], flags);
            return (url) => re.test(url);
        }
        catch { /* 非法正则 → 按子串匹配 */ }
    }
    const needle = pattern.toLowerCase();
    return (url) => url.toLowerCase().includes(needle);
}
/**
 * HTTP 命令面里"带 URL、会改变浏览器去向"的命令（与 core 的 `URL_COMMANDS` 对齐）。
 */
const HTTP_URL_COMMANDS = new Set(['nav', 'tabs.open']);
/**
 * HTTP 命令面里"作用于页面内容"的命令：对**已开标签页**跑同一套红线判据
 * （云元数据 / DSH 控制页 / deny 名单 / 分域拒绝），与工具层的 `authorizeExistingTab` 一致。
 */
const HTTP_PAGE_COMMANDS = new Set([
    'eval', 'content', 'content.debug', 'find', 'frames', 'click', 'input', 'press', 'scroll',
    'snapshot', 'screenshot', 'pdf', 'emulate',
]);
/** 端口被占时向后尝试的候选端口个数（配置端口 → +1 … +N）。 */
const PORT_FALLBACK_COUNT = 9;
/**
 * 扩展端默认扫描的端口窗口（`background.js` 的 `PORT_SCAN_BASE/COUNT`）。
 * 这里只用来**如实描述**回退后的可发现性：窗口外扩展扫不到，得在扩展高级里手填端口。
 * （两处常量没法自动同步 —— 改扩展的窗口就要改这里，反之亦然。）
 */
const EXTENSION_PORT_SCAN_BASE = 9777;
const EXTENSION_PORT_SCAN_COUNT = 10;
/** 回退到 `port` 之后，扩展能否自己发现它。 */
function extensionCanDiscoverPort(port) {
    return port >= EXTENSION_PORT_SCAN_BASE && port < EXTENSION_PORT_SCAN_BASE + EXTENSION_PORT_SCAN_COUNT;
}
/**
 * Owns zero or one live {@link BridgeServer} and restarts it whenever the
 * resolved settings change. Reconciles serialize through a promise chain so a
 * burst of settings commits cannot interleave stop/start pairs.
 */
/** 拉起目标来源的中文说法（给人看的；诊断"这次为什么落在这个 profile"时很重要）。 */
function launchSourceZh(source) {
    switch (source) {
        case 'config': return '设置里显式填的 profile';
        case 'hello': return '扩展自报的 id 反查磁盘';
        case 'hint': return '配置的扩展目录比对磁盘';
        case 'record': return '上次配对记录';
        default: return String(source);
    }
}
class BridgeController {
    log;
    server;
    /** 实际绑定到的端口；端口被占时可能回退到 port+1..port+9。未启动时为 undefined。 */
    boundPort;
    /** 端口回退说明，供 browser_policy_status 展示。 */
    portNote;
    guarded;
    policy;
    serverKey = '';
    policyKey = '';
    /** 宿主推导的「本 DSH 控制页」地址（来自 webServer 服务）；用户登记列表之外的补充。 */
    controlOrigins = [];
    lastError;
    chain = Promise.resolve();
    current;
    /** Per-session grants: hosts the user approved once in ask mode. Cleared when
     *  policy inputs change or the plugin stops. */
    tempAllow = new Set();
    // de-013 auto-launch watchdog state.
    watchdogTimer;
    lastSpawnAt = 0;
    droppedSince = 0;
    /** 上次成功配对（学到的浏览器位置），懒加载自 {@link pairingFile}。 */
    pairing;
    /** 定位失败时到底扫了什么、为什么没命中 —— 状态工具要把这句话说出来。 */
    locateNote;
    /** 已经学过其位置的扩展 id（避免重复扫盘）。 */
    learnedExtensionId;
    /**
     * 「握手即学习」的定时器。
     *
     * 为什么必须在**连着的**时候学：`hello` 只在扩展连着时存在（断开即清空），
     * 而"需要拉起"恰恰发生在**断开**时 —— 等到那时再去读 id，读不到。所以一看到
     * 新 id 就立刻反查磁盘并落盘，之后的冷启动才有依据。
     */
    learnTimer;
    constructor(log) {
        this.log = log;
    }
    /** Resolved directory screenshots land in; defined once any config arrived. */
    get shotsDir() {
        return this.current === undefined ? undefined : path.resolve(this.current.shotsDir);
    }
    /** 把一个目标系统形态的路径换成当前进程能访问的形态（WSL 下 `C:\…` → `/mnt/c/…`）。 */
    localForm(p) {
        return hostStyle() === 'wsl' ? toLinuxPath(p) : p;
    }
    /** 配对记录的落盘位置：`$DSH_HOME/browser-unified-pairing.json`（两个实例各自的 DSH_HOME 天然隔离）。 */
    pairingFile() {
        const home = process.env['DSH_HOME'] !== undefined && process.env['DSH_HOME'] !== ''
            ? process.env['DSH_HOME']
            : path.join(homedir(), '.dsh');
        return path.join(home, 'browser-unified-pairing.json');
    }
    loadPairing() {
        if (this.pairing !== undefined)
            return this.pairing;
        try {
            const raw = JSON.parse(readFileSync(this.pairingFile(), 'utf8'));
            if (typeof raw?.userDataDir === 'string' && raw.userDataDir !== '' && typeof raw?.profileDir === 'string') {
                this.pairing = raw;
            }
        }
        catch {
            // 没有记录、或记录坏了：一律按"还没有"处理，绝不因此报错。
        }
        return this.pairing;
    }
    savePairing(record) {
        this.pairing = record;
        try {
            mkdirSync(path.dirname(this.pairingFile()), { recursive: true });
            writeFileSync(this.pairingFile(), `${JSON.stringify(record, undefined, '\t')}\n`, 'utf8');
            this.log(`[browser-bridge] 已记下浏览器位置：${record.brandId} / ${record.profileDir}`
                + `${record.profileName !== undefined ? `（${record.profileName}）` : ''} ← 命中方式 ${record.matchedBy}`);
        }
        catch (error) {
            // 写不进去不影响本次拉起，只是下次冷启动还得重新定位一次。
            this.log(`[browser-bridge] 配对记录写入失败：${error instanceof Error ? error.message : String(error)}`);
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
    resolveLaunchTarget(config) {
        const hello = this.server?.status.hello;
        const extensionId = hello?.extensionId !== undefined && hello.extensionId !== '' ? hello.extensionId : undefined;
        if (config.autoLaunchProfileDir.length > 0) {
            const split = splitProfilePath(config.autoLaunchProfileDir, config.autoLaunchProfileName);
            if (split !== undefined) {
                // 用户显式填了就以他为准 —— 但**能查就查一下**：填错 profile 的表现是
                // "窗口起来了、扩展就是连不上"，事后极难查。判"确实是这个扩展"才记进配对
                // 记录；判"这个 profile 里没有它"就继续往下走磁盘定位，不盲信。
                const verdict = extensionId === undefined
                    ? undefined
                    : profileHasExtension(this.localForm(split.userDataDir), split.profileDir, extensionId);
                if (verdict !== false) {
                    if (verdict === true && extensionId !== undefined) {
                        // 显示名只在"用户没自己填"时去磁盘捞一下，纯展示用。
                        const shown = config.autoLaunchProfileName !== ''
                            ? config.autoLaunchProfileName
                            : profileDisplayName(this.localForm(split.userDataDir), split.profileDir);
                        this.savePairing({
                            brandId: brandIdFromHelloName(hello?.browser?.name ?? '') ?? 'unknown',
                            userDataDir: split.userDataDir,
                            profileDir: split.profileDir,
                            ...(shown !== undefined ? { profileName: shown } : {}),
                            extensionId,
                            matchedBy: 'config-verified',
                            resolvedAt: new Date().toISOString(),
                        });
                    }
                    return {
                        ...split,
                        ...(config.autoLaunchProfileName !== '' ? { profileName: config.autoLaunchProfileName } : {}),
                        source: 'config',
                    };
                }
                this.locateNote = `设置里填的 profile（${split.profileDir}）里没有这个扩展，改用磁盘定位`;
                this.log(`[browser-bridge] ${this.locateNote}`);
            }
        }
        const hint = config.autoLaunchExtensionDir.length > 0 ? config.autoLaunchExtensionDir : undefined;
        if (extensionId !== undefined || hint !== undefined) {
            const brandId = brandIdFromHelloName(hello?.browser?.name ?? '');
            const found = locateExtensionProfile({ brandId, extensionId, extensionPathHint: hint });
            const location = found.location;
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
                });
                this.locateNote = undefined;
                return {
                    userDataDir: location.userDataDir,
                    profileDir: location.profileDir,
                    ...(location.profileName !== undefined ? { profileName: location.profileName } : {}),
                    brandId: location.brandId,
                    source: extensionId !== undefined ? 'hello' : 'hint',
                };
            }
            this.locateNote = `按${extensionId !== undefined ? `扩展 id ${extensionId}` : `扩展目录 ${hint ?? ''}`}没找到装了它的 profile`
                + `（扫过 ${found.profilesScanned.length} 个 profile）`
                + (found.notes.length > 0 ? `；${found.notes.slice(0, 3).join('；')}` : '');
        }
        const saved = this.loadPairing();
        if (saved !== undefined) {
            const local = hostStyle() === 'wsl' ? toLinuxPath(saved.userDataDir) : saved.userDataDir;
            if (existsSync(local)) {
                return {
                    userDataDir: saved.userDataDir,
                    profileDir: saved.profileDir,
                    ...(saved.profileName !== undefined ? { profileName: saved.profileName } : {}),
                    brandId: saved.brandId,
                    source: 'record',
                };
            }
            this.locateNote = `上次配对记录里的目录已不存在：${saved.userDataDir}`;
        }
        return undefined;
    }
    /** 在 `refreshWatchdog` 的每个出口旁调用：只在桥启用时做"握手即学习"。 */
    refreshLearnTimer(config) {
        if (this.learnTimer !== undefined) {
            clearInterval(this.learnTimer);
            this.learnTimer = undefined;
        }
        if (!config.enabled)
            return;
        this.learnTimer = setInterval(() => {
            this.learnFromHello(config);
        }, 5_000);
        this.learnFromHello(config);
    }
    /**
     * 看 `hello` 学一次位置（幂等）。学成了就不再重复扫盘，直到换了一个扩展 id。
     * @param config - 当前解析后的配置。
     */
    learnFromHello(config) {
        const extensionId = this.server?.status.hello?.extensionId;
        if (extensionId === undefined || extensionId === '')
            return;
        if (extensionId === this.learnedExtensionId && this.loadPairing() !== undefined)
            return;
        const target = this.resolveLaunchTarget(config);
        if (target === undefined)
            return;
        this.learnedExtensionId = extensionId;
        this.log(`[browser-bridge] 已从 hello 学到浏览器位置（ext=${extensionId} → ${target.brandId ?? '?'} / ${target.profileDir}`
            + `${target.profileName !== undefined ? `（${target.profileName}）` : ''}）`);
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
    resolveBrowserCandidates(configured, brandId) {
        if (configured.length > 0)
            return [configured];
        return exeCandidates(hostStyle(), brandId !== undefined && brandId !== '' ? [brandId] : undefined);
    }
    /** Snapshot for the read-only policy-status tool. */
    describePolicy() {
        const c = this.current;
        const hello = this.server?.status.hello;
        const pairing = this.loadPairing();
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
            pairing: pairing === undefined ? undefined : {
                brandId: pairing.brandId,
                profileDir: pairing.profileDir,
                profileName: pairing.profileName,
                userDataDir: pairing.userDataDir,
                matchedBy: pairing.matchedBy,
                resolvedAt: pairing.resolvedAt,
            },
            launchNote: this.locateNote,
        };
    }
    // --- de-013 auto-launch watchdog -------------------------------------
    /** (Re)arm the watchdog from the resolved config; clears it when disabled. */
    refreshWatchdog(config) {
        if (this.watchdogTimer !== undefined) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }
        this.droppedSince = 0;
        if (!config.enabled || !config.autoLaunchEnabled)
            return;
        const idleMs = Math.max(3, Math.min(3600, config.autoLaunchIdleSeconds ?? 15)) * 1000;
        this.watchdogTimer = setInterval(() => {
            void this.watchdogTick(idleMs, config);
        }, Math.min(5000, Math.max(1000, idleMs)));
    }
    async watchdogTick(idleMs, config) {
        const status = this.server?.status;
        if (status === undefined || !status.listening)
            return;
        if (status.extensionConnected) {
            this.droppedSince = 0;
            return;
        }
        const now = Date.now();
        if (this.droppedSince === 0)
            this.droppedSince = now;
        if (now - this.droppedSince < idleMs)
            return;
        const cooldown = Math.max(30_000, idleMs * 2);
        if (now - this.lastSpawnAt < cooldown)
            return;
        this.lastSpawnAt = now;
        this.spawnBrowser(config);
    }
    /**
     * de-013 model-invoked launch: bring the extension's browser back up on
     * demand. Unlike the disconnect watchdog this does not require
     * `autoLaunchEnabled` — the model asks, the browser starts. Spawn
     * parameters come from the same autoLaunch* settings the watchdog uses.
     * A short cooldown prevents the model from spawning a window per call.
     * @returns a human-readable outcome for the tool layer.
     */
    launchBrowser(landingUrl) {
        const status = this.server?.status;
        if (status?.extensionConnected)
            return '扩展已连接，无需拉起';
        const config = this.current;
        if (config === undefined)
            return '浏览器控制尚未加载配置，无法拉起';
        if (!config.enabled)
            return '浏览器控制未启用，无法拉起（请先打开开关）';
        // 以前这里硬性要求填过 autoLaunchProfileDir / autoLaunchBrowserExe。现在
        // "哪个 profile"可以由**扩展自报 id + 磁盘反查**得到，所以只在真的没有任何
        // 判据时才拦 —— 否则就是"明明能学会，却先怪用户没配置"。
        const hasJudgement = config.autoLaunchProfileDir.length > 0
            || config.autoLaunchBrowserExe.length > 0
            || config.autoLaunchExtensionDir.length > 0
            || this.loadPairing() !== undefined;
        if (!hasJudgement) {
            return '定位不到浏览器 profile：既没配过（autoLaunchProfileDir / autoLaunchExtensionDir），也还没有过成功配对。'
                + '先手动打开一次装了扩展的那个 profile，让扩展连上过一回，桥会记住位置'
                + (this.locateNote !== undefined ? `；上次定位失败原因：${this.locateNote}` : '');
        }
        const now = Date.now();
        if (now - this.lastSpawnAt < 10_000)
            return '刚刚已尝试拉起，请稍候几秒让浏览器/扩展连上';
        this.lastSpawnAt = now;
        return this.spawnBrowser(config, landingUrl);
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
    async wakeBrowser(options = {}) {
        const status = this.server?.status;
        const reason = typeof options.reason === 'string' && options.reason.length > 0 ? options.reason : 'browser_launch';
        // 落地页：只有"当前策略**直接放行**"的 http(s) 网址才会被采用。唤醒发生在
        // buddy 的 pre-execute（也就是工具自身授权门**之前**），把未授权/被拦的 URL
        // 交给浏览器等于绕过 UrlPolicy（元数据端点、deny 名单全会漏）。判定不过就退回 about:blank。
        const landingUrl = await this.wakeLandingUrl(options.url);
        if (status?.extensionConnected === true) {
            try {
                const info = (await this.execute('window.ensure', { reason, ...(landingUrl === undefined ? {} : { url: landingUrl }) }, new AbortController().signal));
                if (info.created === true) {
                    return `扩展已连接，但浏览器里没有任何窗口 —— 已让扩展新建一个窗口（tabId=${String(info.tabId)}`
                        + `${landingUrl === undefined ? '' : `，落在 ${landingUrl}`}），可以继续操作了`;
                }
                return `扩展已连接，当前有 ${String(info.windowsBefore)} 个窗口，无需唤起`;
            }
            catch (error) {
                return `扩展已连接，但请求它新建窗口失败：${errorMessage(error)}（可手动打开一次浏览器窗口）`;
            }
        }
        return this.launchBrowser(landingUrl);
    }
    /**
     * 校验候选项能否当"唤醒落地页"：必须 http(s)，且当前策略**直接放行**（allow）——
     * `ask`/`block`/`unavailable` 一律不用（唤醒不该成为绕过审批的通道）。
     * @returns 可用则返回归一化后的 URL，否则 undefined（调用方退回 about:blank）。
     */
    async wakeLandingUrl(candidate) {
        if (typeof candidate !== 'string')
            return undefined;
        const url = candidate.trim();
        if (!/^https?:\/\//i.test(url))
            return undefined;
        try {
            const verdict = await this.authorizeUrl(url);
            return verdict.decision === 'allow' ? url : undefined;
        }
        catch {
            return undefined;
        }
    }
    spawnBrowser(config, landingUrl) {
        // 拉起目标**先由学习/配置得出**（见 resolveLaunchTarget），不再自己
        // `path.resolve` —— 那正是 Windows 路径被 Linux 口径拆坏的来源（缺陷③）。
        const target = config.autoLaunchTempProfile ? undefined : this.resolveLaunchTarget(config);
        let userDataDir = '';
        let profileName = '';
        if (config.autoLaunchTempProfile) {
            if (!config.autoLaunchExtensionDir) {
                this.log('[browser-bridge] autoLaunch: 临时干净实例需要 autoLaunchExtensionDir（未打包扩展目录）才能 sideload；改用已装扩展的 profile 目录');
                return '临时干净实例需要 autoLaunchExtensionDir（未打包扩展目录）才能 sideload；请改配已装扩展的 profile 目录或填扩展目录';
            }
            userDataDir = mkdtempSync(path.join(tmpdir(), 'dsh-browser-'));
        }
        else if (target !== undefined) {
            userDataDir = target.userDataDir;
            profileName = target.profileDir;
        }
        else if (config.autoLaunchBrowserExe.length === 0) {
            // 定位不到"装了扩展的那个 profile"。此时用默认 profile 拉一个窗口出来，
            // 表现就是历史上那个「唤起了但没用」：窗口起来了、扩展永远连不上。
            // 与其开一个没用的窗口，不如把话说明白。
            // （用户显式填了 autoLaunchBrowserExe 的按他自己的选择走，不拦。）
            const why = this.locateNote !== undefined ? `；${this.locateNote}` : '';
            this.log(`[browser-bridge] autoLaunch: 跳过拉起 —— 定位不到装了扩展的 profile${why}`);
            return '定位不到装了扩展的 profile，因此没有拉起（用默认 profile 起了也连不上）'
                + `${why}。先手动打开一次装了扩展的那个 profile，让扩展连上过一回，桥会自己记住位置`;
        }
        const extra = config.autoLaunchTempProfile && config.autoLaunchExtensionDir
            ? ['--load-extension=' + path.resolve(config.autoLaunchExtensionDir)]
            : [];
        const args = ['--no-first-run', '--no-default-browser-check'];
        if (userDataDir)
            args.push('--user-data-dir=' + userDataDir);
        if (profileName)
            args.push('--profile-directory=' + profileName);
        args.push(...extra);
        // 落地页：有"本次调用要去的网址"就直接落在那里（2026-10-10 用户反馈：以前一律
        // about:blank，每唤起一次就多一张空白垃圾页，而且模型还得再导航一次）。
        args.push(landingUrl === undefined ? 'about:blank' : landingUrl);
        const candidates = this.resolveBrowserCandidates(config.autoLaunchBrowserExe, target?.brandId);
        if (candidates.length === 0) {
            const why = this.locateNote !== undefined ? `；${this.locateNote}` : '';
            this.log(`[browser-bridge] autoLaunch: 找不到可用的浏览器可执行文件${why}`);
            return `找不到浏览器可执行文件（登记表里的常见安装位置都没命中）${why}`;
        }
        if (target !== undefined) {
            this.log(`[browser-bridge] autoLaunch: 拉起目标来自 ${target.source}（${target.brandId ?? '未知品牌'} / ${target.profileDir}`
                + `${target.profileName !== undefined ? `（${target.profileName}）` : ''}）`);
        }
        const where = `user-data-dir=${userDataDir || '默认'}${profileName ? `, profile=${profileName}` : ''}`;
        for (const exe of candidates) {
            const looksLikePath = exe.includes('/') || exe.includes('\\');
            if (looksLikePath && !existsSync(exe)) {
                this.log(`[browser-bridge] autoLaunch: 跳过不存在的可执行文件 ${exe}`);
                continue;
            }
            try {
                const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
                // ⚠️ ENOENT / EACCES 走的是**异步** `'error'` 事件，try/catch 抓不到。
                // 所以这里只能说"已发起"，成不成功由 `hello` 到达来判定 —— 过去正是在
                // 这里谎报"已拉起"，才让"调用即自动拉起"静默失效。
                child.on('error', (error) => {
                    this.log(`[browser-bridge] autoLaunch ${exe} 启动失败：${error.message}（若配置了可执行文件请给完整路径）`);
                });
                child.unref();
                this.log(`[browser-bridge] autoLaunch: 已发起 ${exe}（${where}）`);
                return `已发起 ${exe}（${where}）${target !== undefined ? `，目标来自${launchSourceZh(target.source)}` : ''}`
                    + '；是否真的起来以 hello 到达为准（等几秒再看扩展是否已连接）';
            }
            catch (error) {
                this.log(`[browser-bridge] autoLaunch ${exe} 失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
        this.log('[browser-bridge] autoLaunch: 候选可执行文件都起不来');
        return `候选浏览器都起不来（试过 ${candidates.join(', ')}）`;
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
    setControlOrigins(origins) {
        const next = [...origins];
        if (next.join('\u0001') === this.controlOrigins.join('\u0001'))
            return;
        this.controlOrigins = next;
        this.policyKey = '';
        const config = this.current;
        if (config !== undefined)
            void this.reconcile(config);
    }
    reconcile(config, options = {}) {
        this.current = config;
        const run = this.chain.then(() => this.reconcileNow(config));
        this.chain = run.catch(() => { });
        if (options.throwOnError === true) {
            return run.catch((error) => {
                throw error instanceof Error ? error : new Error(String(error));
            });
        }
        return Promise.resolve();
    }
    async reconcileNow(config) {
        const shotsDir = path.resolve(config.shotsDir);
        // The listener only restarts when transport-affecting values change.
        const serverKey = config.enabled ? `${config.port}|${config.token}|${shotsDir}` : '';
        // URL policy is rebuilt in place (no listener restart) when the policy
        // inputs change, so editing the lists / modes in Settings applies live
        // without ever dropping an in-flight browser command.
        const policyKey = config.enabled
            ? `${config.urlMode}|${config.blockMetadata ? '1' : '0'}|${config.askMode}|${config.internetAccess}|${config.lanAccess}|${config.localAccess}|`
                + `${config.internetTemp ? '1' : '0'}|${config.lanTemp ? '1' : '0'}|${config.localTemp ? '1' : '0'}|`
                + `${config.dshAccessEnabled ? '1' : '0'}|${mergeDshOrigins(config, this.controlOrigins).join('\u0001')}|`
                + `${(config.metadataHostnames ?? []).join('\u0001')}|${(config.metadataIps ?? []).join('\u0001')}|`
                + `${(config.allowHosts ?? []).join('\u0001')}|${(config.denyHosts ?? []).join('\u0001')}`
            : '';
        if (serverKey === this.serverKey && policyKey === this.policyKey)
            return;
        if (serverKey !== this.serverKey) {
            const previous = this.server;
            this.server = undefined;
            this.guarded = undefined;
            this.policy = undefined;
            this.tempAllow.clear();
            this.serverKey = '';
            this.policyKey = '';
            await previous?.stop();
            if (!config.enabled) {
                this.lastError = undefined;
                return;
            }
            // 端口被占时**依次尝试候选端口**（配置端口 → +1 … +9），全不可用则降级记录错误。
            // 历史行为是这里直接 throw → 变成未处理拒绝 → DSH `exit(1)`（P0 取证：端口被占时
            // `dsh web` 起不来）。现在任何启动失败都不再拖垮 DSH；扩展端会按候选序列自动发现端口。
            const candidates = [config.port, ...Array.from({ length: PORT_FALLBACK_COUNT }, (_, i) => config.port + i + 1)];
            let started;
            let lastStartError;
            for (const candidate of candidates) {
                const attempt = new BridgeServer({
                    port: candidate,
                    token: config.token,
                    shotsDir,
                    log: this.log,
                    // X18：HTTP 命令面（`POST /api/command`）过去完全不过策略，同伴件的 frames/eval
                    // 就走它 —— 等于"带 token 就能对任意标签页 eval/nav"。这里把策略接回去。
                    guardCommand: (command, params) => this.guardHttpCommand(command, params),
                });
                try {
                    await attempt.start();
                    started = attempt;
                    this.boundPort = candidate;
                    if (candidate === config.port) {
                        this.portNote = undefined;
                    }
                    else {
                        // X15（另一半）：回退到扩展扫描窗口**之外**时，"扩展会自动发现"是句假承诺
                        // （扩展只扫 9777..9786，外加它自己 popup 里填过的端口/lastKnownPort）。
                        this.portNote = extensionCanDiscoverPort(candidate)
                            ? `配置端口 ${config.port} 被占用，已回退到 ${candidate}（在扩展的扫描窗口 ${EXTENSION_PORT_SCAN_BASE}..${EXTENSION_PORT_SCAN_BASE + EXTENSION_PORT_SCAN_COUNT - 1} 内，扩展会自己发现）`
                            : `配置端口 ${config.port} 被占用，已回退到 ${candidate} —— ⚠️ 该端口**不在扩展的默认扫描窗口 ${EXTENSION_PORT_SCAN_BASE}..${EXTENSION_PORT_SCAN_BASE + EXTENSION_PORT_SCAN_COUNT - 1} 内**：请到扩展的高级里把「桥接端口」填成 ${candidate}，否则扩展连不上这个桥`;
                        this.log(`[browser-bridge] ${this.portNote}`);
                    }
                    break;
                }
                catch (error) {
                    lastStartError = error;
                    const code = error?.code;
                    // 只有"端口被占"值得换端口；其它错误（无权限 / 非法端口）立即停手。
                    if (code !== 'EADDRINUSE')
                        break;
                    this.log(`[browser-bridge] 端口 ${candidate} 被占用，尝试下一个候选`);
                }
            }
            if (started === undefined) {
                this.boundPort = undefined;
                this.portNote = undefined;
                const message = lastStartError instanceof Error ? lastStartError.message : String(lastStartError);
                this.lastError = `桥接启动失败（候选端口 ${candidates[0]}..${candidates[candidates.length - 1]} 均不可用）: ${message}`;
                this.log(this.lastError);
                this.refreshWatchdog(config);
                this.refreshLearnTimer(config);
                return;
            }
            this.server = started;
            this.serverKey = serverKey;
        }
        if (!config.enabled) {
            this.refreshWatchdog(config);
            this.refreshLearnTimer(config);
            return;
        }
        // Unified URL policy in front of every navigation command: public mode
        // blocks private/loopback/metadata targets before they reach the
        // extension; intranet mode allows local/LAN but still blocks metadata.
        // Rebuild whenever the policy inputs change (mode, realm access, temps,
        // full access, metadata and allow/deny lists). Session grants reset with
        // the policy.
        if (policyKey !== this.policyKey && this.server !== undefined) {
            this.policy = new UrlPolicy(policyOptionsFor(config, this.controlOrigins));
            this.guarded = new GuardedBridge(this.server, this.policy);
            this.tempAllow.clear();
            this.policyKey = policyKey;
            this.lastError = undefined;
        }
        this.refreshWatchdog(config);
        this.refreshLearnTimer(config);
    }
    /**
     * Run one extension command over the live, policy-guarded link.
     * @param command - extension command name (`nav`, `click`, …).
     * @param params - wire params passed through to the extension.
     * @param signal - tool-execution cancellation propagated to the pending command.
     * @returns the extension's result payload verbatim.
     */
    async execute(command, params, signal) {
        const guarded = this.guarded;
        if (guarded === undefined) {
            throw new Error(this.lastError ?? '浏览器控制未启用 —— 到 dsh 设置 → 插件 → DSH 浏览器控制 打开开关');
        }
        return guarded.execute(command, params, { signal });
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
    async guardHttpCommand(command, params) {
        const url = params.url;
        if (typeof url === 'string' && url.length > 0 && HTTP_URL_COMMANDS.has(command)) {
            const verdict = await this.authorizeUrl(url);
            if (verdict.decision === 'unavailable')
                return controllerDescribeUnavailable();
            if (verdict.decision !== 'allow') {
                const code = verdict.decision === 'block' ? (verdict.code ?? 'WEB_BLOCKED_URL') : 'NEED_AUTHORIZATION';
                return `${code}: ${verdict.reason}（HTTP 命令面没有审批通道：要访问该目标请改用 browser_navigate 工具，或把它加入 allowHosts）`;
            }
        }
        if (HTTP_PAGE_COMMANDS.has(command)) {
            if (this.server?.status.extensionConnected !== true)
                return undefined;
            const tabId = typeof params.tabId === 'number' ? params.tabId : undefined;
            try {
                await authorizeExistingTab(this, tabId, new AbortController().signal);
            }
            catch (error) {
                return errorMessage(error);
            }
        }
        return undefined;
    }
    async authorizeUrl(raw) {
        const policy = this.policy;
        if (policy === undefined) {
            return { decision: 'unavailable' };
        }
        const verdict = await policy.authorizeUrl(raw);
        if (verdict.decision === 'ask' && verdict.host.length > 0 && this.tempAllow.has(verdict.host)) {
            return { decision: 'allow', reason: '', host: verdict.host };
        }
        return verdict;
    }
    /** Remember one host for the rest of this session (ask-mode grant). */
    grantTemporary(host) {
        if (host.length > 0)
            this.tempAllow.add(host);
    }
    /**
     * Delete generated artifacts using the currently resolved directories;
     * works while the bridge is stopped because it never touches the socket.
     * @returns counts and names of what was removed.
     */
    async cleanup() {
        const dir = this.shotsDir;
        if (dir === undefined)
            throw new Error('浏览器控制尚未加载配置，无法确定清理目录');
        return cleanupArtifacts({ shotsDir: dir });
    }
    /** Stop the listener; safe to call repeatedly and during teardown. */
    stop() {
        if (this.watchdogTimer !== undefined) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = undefined;
        }
        if (this.learnTimer !== undefined) {
            clearInterval(this.learnTimer);
            this.learnTimer = undefined;
        }
        this.droppedSince = 0;
        const previous = this.server;
        this.server = undefined;
        this.guarded = undefined;
        this.policy = undefined;
        this.tempAllow.clear();
        this.serverKey = '';
        this.policyKey = '';
        return previous?.stop() ?? Promise.resolve();
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Authorization gate in front of navigation tools. Blocks carry a stable code;
 * `ask` verdicts raise a host approval request through the host approval
 * service and remember an approved host for the rest of the session, so the
 * model never loops on a target the user already granted.
 */
async function authorizeNavigation(ctx, controller, url, exec, toolName) {
    const verdict = await controller.authorizeUrl(url);
    if (verdict.decision === 'unavailable') {
        throw new Error(controllerDescribeUnavailable());
    }
    if (verdict.decision === 'block') {
        throw new Error(`${verdict.code ?? 'WEB_BLOCKED_URL'}: ${verdict.reason}`);
    }
    if (verdict.decision === 'ask') {
        const s = controller.describePolicy();
        const realm = verdict.host.length > 0 ? realmOf(verdict.host) : 'internet';
        const agent = exec.agent;
        const session = agent?.session;
        const approval = ctx.get('approval');
        // de-016: can a host approval actually be requested right now? The
        // restricted-state askMode only applies when it cannot.
        let askable = false;
        if (approval && typeof agent === 'object' && agent !== null && session !== undefined && typeof approval.overrideOf === 'function') {
            try {
                const override = approval.overrideOf(session);
                const effective = override ?? approval.config?.policy ?? 'ask';
                askable = effective === 'ask';
            }
            catch {
                askable = true; // unknown → assume ask is usable (safe default: prompt)
            }
        }
        if (askable) {
            // Approvals are usable: always show the host approval; askMode
            // (restricted-state policy) deliberately does not apply here.
            const realmTemp = realm === 'internet' ? (s.internetTemp ?? true) : realm === 'lan' ? (s.lanTemp ?? true) : (s.localTemp ?? true);
            if (!realmTemp) {
                throw new Error(`NEED_AUTHORIZATION: ${verdict.reason} — 该网络（${realmLabelZh(realm)}）不允许临时授权；请把主机 ${verdict.host} 加入 allowHosts 白名单后再试`);
            }
            if (!approval || !agent || !session) {
                throw new Error(`NEED_AUTHORIZATION: ${verdict.reason} — no approval service or agent/session context available; add the host to allowHosts or set the realm access back to allow`);
            }
            const outcome = await approval.request({
                agent: agent,
                toolName,
                reason: `【浏览器访问授权】目标 ${url}（主机 ${verdict.host}，${realmLabelZh(realm)}域）：该域为 ask 模式且主机不在 allowHosts。批准后本次会话内访问此主机不再重复询问。`,
                signal: exec.signal,
            });
            if (outcome !== 'allowed-once') {
                throw new Error(`NEED_AUTHORIZATION: 用户未批准访问 ${verdict.host}（${outcome}）。请勿自动重试该目标；如需继续，请向用户请求授权或把主机加入 allowHosts 白名单。`);
            }
            controller.grantTemporary(verdict.host);
            return;
        }
        // Approvals unavailable (policy never / Full Access / no service):
        // apply the restricted-state askMode.
        const askMode = s.askMode ?? 'inherit';
        if (askMode === 'deny') {
            throw new Error(`WEB_REALM_DENIED: ${verdict.reason} — ask 域被配置为直接禁止（受限态策略=禁止）`);
        }
        // 'inherit'（忽略）与 'allow'（放行）都让目标通过：ask 失效。
        controller.grantTemporary(verdict.host);
    }
}
function controllerDescribeUnavailable() {
    return '浏览器控制未启用 —— 到 dsh 设置 → 插件 → DSH 浏览器控制 打开开关';
}
function realmLabelZh(realm) {
    return realm === 'lan' ? '局域网' : realm === 'local' ? '本机' : '外网';
}
function askModeZh(mode) {
    return mode === 'allow' ? '放行' : mode === 'deny' ? '禁止' : '忽略';
}
/** Resolve the current URL of a tab (by id, or the active tab) through tabs.list. */
async function currentTabUrl(controller, tabId, signal) {
    const raw = await controller.execute('tabs.list', {}, signal);
    const tabs = Array.isArray(raw.tabs) ? raw.tabs : [];
    let pick = undefined;
    if (typeof tabId === 'number') {
        pick = tabs.find((t) => t.id === tabId);
        if (pick === undefined) {
            // 以前这里静默退回 tabs[0]：授权判在了**另一个**标签页上，命令本身再由扩展回一句
            // "No tab with id: …"（调用方还得多跑一次 browser_tabs 才知道有哪些 id）。
            const available = tabs.map((t) => `${t.id}${t.active === true ? '(active)' : ''}`);
            throw new Error(`没有 id=${tabId} 的标签页`
                + (available.length > 0 ? `；现有：${available.join(', ')}` : '（当前没有标签页）'));
        }
    }
    else {
        pick = tabs.find((t) => t.active === true);
        if (pick === undefined && typeof raw.activeTabId === 'number')
            pick = tabs.find((t) => t.id === raw.activeTabId);
    }
    if (pick === undefined)
        pick = tabs[0];
    return typeof pick?.url === 'string' && pick.url.length > 0 ? pick.url : undefined;
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
async function authorizeExistingTab(controller, tabId, signal) {
    const url = await currentTabUrl(controller, tabId, signal);
    if (!url)
        return;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
            return;
    }
    catch {
        return;
    }
    const verdict = await controller.authorizeUrl(url);
    if (verdict.decision === 'unavailable') {
        throw new Error(controllerDescribeUnavailable());
    }
    if (verdict.decision === 'block') {
        throw new Error(`${verdict.code ?? 'WEB_BLOCKED_URL'}: ${verdict.reason} — operating on this open tab is refused`);
    }
    if (verdict.decision === 'ask') {
        throw new Error(`NEED_AUTHORIZATION: 当前标签页 ${url}（主机 ${verdict.host}）未获授权访问。请先让用户批准该主机，或把它加入 allowHosts 白名单后再操作。`);
    }
}
/** Cap long page reads and mark the cut, so token cost stays bounded. */
function clampText(value, maxChars) {
    return value.length <= maxChars
        ? { content: value, truncated: false }
        : { content: value.slice(0, maxChars), truncated: true };
}
/**
 * Resolve the element target a click/type tool received.
 * @param args - validated tool arguments carrying at most one targeting field.
 * @returns the CSS selector to send on the wire, refs translated to their attribute form.
 */
function targetSelector(args) {
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    if (hasSelector === hasRef) {
        throw new Error('provide exactly one of selector or ref (ref comes from browser_snapshot)');
    }
    if (hasRef) {
        const ref = args.ref;
        if (!SNAPSHOT_REF_SELECTOR_PATTERN.test(ref))
            throw new Error(`invalid ref: ${ref}`);
        return `[data-dsh-ref="${ref}"]`;
    }
    return args.selector;
}
function requireTabId(args, action) {
    if (typeof args.tabId !== 'number')
        throw new Error(`${action} requires tabId`);
    return args.tabId;
}
/** Write one screenshot payload to the shots directory and return its durable location. */
async function saveScreenshot(controller, payload) {
    const dir = controller.shotsDir;
    if (dir === undefined)
        throw new Error('browser-bridge is not configured yet');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).slice(2, 6);
    const file = path.join(dir, `${stamp}-${random}.${payload.format === 'jpeg' ? 'jpg' : 'png'}`);
    const buffer = Buffer.from(payload.base64, 'base64');
    await writeFile(file, buffer);
    return {
        file,
        bytes: buffer.length,
        tabId: payload.tabId,
        title: payload.tabTitle,
        url: payload.tabUrl,
    };
}
/** Write one PDF payload to `path` (absolute or relative to `controller.shotsDir`)
 *  and return the absolute path + size. Mirrors saveScreenshot's contract. */
async function savePdf(controller, payload, requestedPath) {
    const dir = controller.shotsDir;
    if (dir === undefined)
        throw new Error('browser-bridge is not configured yet');
    let file;
    if (requestedPath && path.isAbsolute(requestedPath)) {
        file = requestedPath;
        await mkdir(path.dirname(file), { recursive: true });
    }
    else {
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const random = Math.random().toString(36).slice(2, 6);
        const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.pdf`;
        file = path.join(dir, name);
    }
    const buffer = Buffer.from(payload.base64, 'base64');
    await writeFile(file, buffer);
    return {
        file,
        bytes: buffer.length,
        tabId: payload.tabId,
        ...(payload.tabTitle === undefined ? {} : { title: payload.tabTitle }),
        ...(payload.tabUrl === undefined ? {} : { url: payload.tabUrl }),
    };
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
export function denyHostsStatusLine(shown, ignored) {
    const base = `denyHosts: ${shown.length > 0 ? shown : '（空）'}`;
    return ignored
        ? `${base}  ⚠️ askMode=放行 ⇒ **本名单当前不生效**（该档连黑白名单一起忽略；硬红线仍生效）`
        : base;
}
export function permissionReport(input) {
    const lines = [];
    lines.push(`origin = ${input.origin}${input.tabId === undefined ? '' : `（tab ${input.tabId}）`}`);
    lines.push(`权限存储 = ${input.store.file}`);
    if (input.storeNote !== undefined && input.storeNote.length > 0)
        lines.push(`          ${input.storeNote}`);
    lines.push(`          改于 ${input.store.modifiedAt.toLocaleString('sv-SE')}；本机共 ${input.store.classNames.length} 个权限类`);
    const detail = (reading) => {
        const e = reading.exception;
        if (e === undefined)
            return `- ${reading.label} [${reading.pref}]｜触发：${reading.trigger}`;
        const when = e.lastModified === undefined ? '' : `，${chromiumTime(e.lastModified)}`;
        return `- ${reading.label} [${reading.pref}] = **${e.label}**${when}｜触发：${reading.trigger}`;
    };
    const ask = input.readings.filter((r) => r.exception?.setting === CONTENT_SETTING.ASK);
    const allowed = input.readings.filter((r) => r.exception?.setting === CONTENT_SETTING.ALLOW || r.exception?.setting === CONTENT_SETTING.SESSION_ONLY);
    const denied = input.readings.filter((r) => r.exception?.setting === CONTENT_SETTING.BLOCK);
    const none = input.readings.filter((r) => r.exception === undefined);
    const networkAsk = ask.filter((r) => r.pref === 'loopback_network' || r.pref === 'local_network_access' || r.pref === 'local_network');
    const networkAllowed = allowed.filter((r) => r.pref === 'loopback_network' || r.pref === 'local_network_access' || r.pref === 'local_network');
    if (input.readings.length === 0 && input.requestedClass !== undefined) {
        // 指定的类不在受关注清单里：把本机**真实存在**的类摊开（不猜枚举值）。
        const rows = input.store.exceptions.get(input.requestedClass);
        if (rows !== undefined) {
            lines.push(`类 ${input.requestedClass} 在本机存在，该 origin 有记录：`);
            for (const [pattern, entry] of rows)
                lines.push(`- ${pattern} = ${entry.setting}`);
        }
        else if (input.store.classNames.includes(input.requestedClass)) {
            lines.push(`类 ${input.requestedClass} 在本机存在，但该 origin 没有例外记录（走浏览器默认）。`);
        }
        else {
            lines.push(`没有 ${input.requestedClass} 这个类。本机存在的类（前 24 个）：`);
            lines.push(input.store.classNames.slice(0, 24).join(', '));
        }
        return lines.join('\n');
    }
    if (ask.length > 0) {
        lines.push('');
        lines.push(`会弹窗（**询问** = 气泡拦人，只有用户本人能点）：${ask.length} 类`);
        for (const reading of ask)
            lines.push(detail(reading));
    }
    if (allowed.length > 0) {
        lines.push('');
        lines.push(`已允许（含仅本次会话）：${allowed.length} 类`);
        for (const reading of allowed)
            lines.push(detail(reading));
    }
    if (denied.length > 0) {
        lines.push('');
        lines.push(`已拒绝：${denied.length} 类`);
        for (const reading of denied)
            lines.push(detail(reading));
    }
    if (none.length > 0) {
        lines.push('');
        const names = none.map((r) => r.pref);
        lines.push(`无记录（走浏览器默认，默认多为"询问"）：${none.length} 类 —— ${names.slice(0, 12).join(', ')}${names.length > 12 ? ' …' : ''}`);
    }
    lines.push('');
    if (input.pendingLocal.length > 0) {
        const head = input.pendingLocal[0];
        const age = head.ageSeconds === undefined ? '' : `（已等 ${head.ageSeconds}s）`;
        lines.push(`挂起信号：${input.pendingLocal.length} 个指向本机/私网的请求仍在等响应 —— 例 ${head.url}${age}`);
        if (networkAsk.length > 0) {
            lines.push(`⇒ **大概率正等「本地网络访问」气泡**：该类在当前 origin 是"询问"，而请求已经发出去了。`);
            lines.push('  扩展对这类 chrome 级气泡**不可见、也不代答** —— 需要用户在浏览器窗口里点「允许/拒绝」。');
            lines.push('  绕开办法：页面侧别 await 本机地址（fire-and-forget 或改走不访问本机的通道）。');
        }
        else if (networkAllowed.length > 0) {
            lines.push('⇒ 本地网络访问**已允许**，但仍挂起：更可能是对端没回（服务在不在？）或另有阻塞，不要当成权限问题。');
        }
        else {
            lines.push('⇒ 该 origin 没有本地网络访问的例外记录；若浏览器默认是"询问"，屏幕上可能正有一个气泡。');
        }
    }
    else if (ask.length > 0) {
        lines.push('当前没有挂起的本机请求；但上面这些"询问"类**一旦被页面触发就会弹窗拦人** —— 事前提醒用户可省一次超时排查。');
    }
    else if (none.length > 0) {
        // 别把"没有显式记录"说成"不会弹"：本机默认值表是空的，受关注类的浏览器默认**就是询问**。
        lines.push(`当前没有挂起的本机请求，也没有**显式**的"询问"记录；但有 ${none.length} 类无记录 ⇒ `
            + '浏览器默认多为"询问"，页面一触发这些 API 仍会弹窗拦人（**别把"没记录"当成"不会弹"**）。');
    }
    else {
        lines.push('当前没有挂起的本机请求，受关注类也都有显式记录且无"询问"项。');
    }
    lines.push('本次为**只读**：我没有替你点任何气泡（也不会未经你配置就代答）。');
    return lines.join('\n');
}
function applyBrowserTools(ctx, controller, getConfig) {
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
    });
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
            const s = controller.describePolicy();
            const firstN = (list, n = 6) => {
                if (!Array.isArray(list))
                    return '';
                const head = list.slice(0, n).join(', ');
                return head + (list.length > n ? ` …共 ${list.length} 条` : '');
            };
            const lines = [];
            lines.push(`启用: ${s.enabled ? '是' : '否'}${s.enabled && !s.ready ? '（桥未就绪）' : ''}`);
            if (s.enabled) {
                const mode = s.urlMode ?? 'public';
                const effRealm = (realm, raw) => {
                    return raw ?? (mode === 'intranet' || realm === 'internet' ? 'allow' : 'deny');
                };
                const fmt = (label, realm, raw, temp) => {
                    const eff = effRealm(realm, raw);
                    return `${label}: ${eff}${raw ? '（显式）' : '（预设）'}${temp === false ? '，无临时授权' : ''}`;
                };
                lines.push(`网络预设: ${mode === 'intranet' ? '内网' : '公网'}${s.urlMode === undefined ? '（缺省公网）' : ''}`);
                lines.push(`桥接端口: ${s.boundPort ?? '（未启动）'}${s.portNote ? ' — ' + s.portNote : (s.requestedPort !== undefined && s.boundPort !== s.requestedPort ? `（配置 ${s.requestedPort}）` : '')}`);
                lines.push(`DSH 页面访问: ${s.dshAccessEnabled ? '开（' + (s.dshOrigins ?? []).join(', ') + '）' : '关'}`);
                lines.push(fmt('外网', 'internet', s.internetAccess, s.internetTemp));
                lines.push(fmt('局域网', 'lan', s.lanAccess, s.lanTemp));
                lines.push(fmt('本机', 'local', s.localAccess, s.localTemp));
                lines.push(`受限态 ask 策略: ${askModeZh(s.askMode)}`);
                lines.push(`自动拉起: ${s.autoLaunchEnabled ? '开（断开容忍 ' + (s.autoLaunchIdleSeconds ?? 15) + 's' + (s.autoLaunchProfileDir ? '，profile=' + (s.autoLaunchProfileName || path.basename(s.autoLaunchProfileDir)) : '') + '）' : '关'}`);
                lines.push(`浏览器配对: ${s.pairing !== undefined ? `${s.pairing.brandId} / ${s.pairing.profileDir}${s.pairing.profileName !== undefined ? `（${s.pairing.profileName}）` : ''} ← ${s.pairing.matchedBy} @ ${s.pairing.resolvedAt}` : '（还没有：需要装了扩展的浏览器先连上过一次）'}`);
                if (s.extensionId !== undefined)
                    lines.push(`扩展自报: id=${s.extensionId}；浏览器=${s.browserName ?? '—'}`);
                if (s.launchNote !== undefined)
                    lines.push(`上次定位失败: ${s.launchNote}`);
                lines.push(`allowHosts: ${firstN(s.allowHosts) || '（空）'}`);
                lines.push(denyHostsStatusLine(firstN(s.denyHosts), s.denyHostsIgnored === true));
                lines.push(`blockMetadata: ${s.blockMetadata === false ? '关' : '开'}；metadataHostnames: ${(s.metadataHostnames ?? []).length} 条；metadataIps: ${(s.metadataIps ?? []).length} 条`);
                lines.push(`本会话已授权主机: ${s.tempGrants.length > 0 ? s.tempGrants.join(', ') : '（无）'}`);
            }
            return { ok: true, text: lines.join('\n') };
        },
    }));
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
            const text = await controller.wakeBrowser();
            return { ok: true, text };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_navigate',
        description: 'Navigate a browser tab to a URL and wait for the page load to settle. '
            + '注意：SPA / 微前端常常在本次返回之后才渲染正文 —— 拿到标题不等于内容就绪；'
            + '若紧接着读到的正文是空或极短，用 browser_read / browser_evaluate 复查一次再下结论。'
            + '要一次到位：传 `waitSelector` / `waitText` / `waitFn`（任一），导航后会等服务端轮询到该条件成立；'
            + '超时不会让本次导航失败，而是在结果里给 `waitTimedOut: true`。',
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
                    error: { type: 'string' },
                    loadPending: { type: 'boolean' },
                    waitedMs: { type: 'number' },
                    waitTimedOut: { type: 'boolean' },
                    waitAborted: { type: 'boolean' },
                    waitError: { type: 'string' },
                },
            },
            render: (_args, value) => {
                const label = [value.title, value.url].filter(part => typeof part === 'string' && part.length > 0).join(' — ');
                const tail = value.siteUnreachable === true
                    ? ` — target unreachable${value.error ? `: ${value.error}` : ''}`
                    : '';
                const pending = value.loadPending === true
                    ? ' — 页面**仍在加载**（15s 内没等到完成）：别单次采样就下结论，用 browser_wait 等条件或稍后复查'
                    : '';
                const wait = typeof value.waitedMs === 'number'
                    ? value.waitTimedOut === true
                        ? ` — 等待条件在 ${value.waitedMs}ms 内**未成立**（不等于页面没有内容，可能只是慢；可加大 waitTimeoutMs 或换条件）`
                        : value.waitAborted === true
                            ? ` — 等待**已中止**（${value.siteUnreachable === true
                                ? '页面不可达，原因见上'
                                : String(value.waitError ?? '').slice(0, 160)}），不是"条件不成立"`
                            : ` — 等待条件成立（${value.waitedMs}ms）`
                    : '';
                return [{ type: 'text', text: `Tab ${value.tabId} now shows ${label.length > 0 ? label : '(untitled)'}${tail}${pending}${wait}` }];
            },
        },
        isConcurrencySafe: () => false,
        presentCall: args => ({ card: 'generic', title: `Open ${args.url}`, kind: 'other' }),
        async execute(args, exec) {
            await authorizeNavigation(ctx, controller, args.url, exec, 'browser_navigate');
            const params = { url: args.url };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            const raw = await controller.execute('nav', params, exec.signal);
            const out = { tabId: raw.tabId };
            if (typeof raw.url === 'string')
                out.url = raw.url;
            if (typeof raw.title === 'string')
                out.title = raw.title;
            if (raw.loadPending === true)
                out.loadPending = true;
            // 形状容错（2026-10-10 实测缺陷）：扩展返回的是 `siteUnreachable: {reason}`，
            // 而这里以前判 `=== true` ⇒ 对象被整个丢掉，"页面连不上"从来没送到模型眼前，
            // 模型只看到一句"now shows <目标URL>"（于是以为成功）。
            const unreachable = raw.siteUnreachable === true
                || (typeof raw.siteUnreachable === 'object' && raw.siteUnreachable !== null);
            if (unreachable) {
                out.siteUnreachable = true;
                const reason = typeof raw.siteUnreachable === 'object' && raw.siteUnreachable !== null
                    ? raw.siteUnreachable.reason
                    : undefined;
                out.error = typeof raw.error === 'string' && raw.error.length > 0
                    ? raw.error
                    : reason === 'dns' ? 'DNS 解析失败' : '无法连接（浏览器错误页）';
            }
            // bi-015：SPA 就绪等待。导航本身已经成功，所以等待超时**不**让整次调用失败，
            // 只在结果里标注 waitTimedOut —— 让模型能区分"慢"与"没有内容"。
            const waitCondition = describeWaitCondition(args);
            if (waitCondition !== undefined) {
                const budget = Math.min(120_000, Math.max(100, Math.trunc(args.waitTimeoutMs ?? 15_000)));
                const waitStartedAt = Date.now();
                try {
                    const waited = await controller.execute('wait', {
                        ...waitCondition.params,
                        timeoutMs: budget,
                        tabId: raw.tabId,
                    }, exec.signal);
                    out.waitedMs = typeof waited?.waited === 'number' ? waited.waited : Date.now() - waitStartedAt;
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    out.waitedMs = Date.now() - waitStartedAt;
                    out.waitError = message;
                    // 「等待超时」与「等待被中止」是两件事，不能都套超时话术：
                    // 典型的中止是页面落到浏览器错误页（ERR_CONNECTION_TIMED_OUT）——
                    // 那种情况还说"可能只是慢、加大预算"就是**误诊**（2026-10-10 真机实测）。
                    if (/wait timeout after/i.test(message))
                        out.waitTimedOut = true;
                    else {
                        out.waitAborted = true;
                        if (typeof out.error !== 'string')
                            out.error = message;
                    }
                }
            }
            return out;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_wait',
        description: 'Wait, server-side, until the page meets a condition — instead of guessing with sleeps or sampling once. '
            + 'Provide one of `selector` (CSS selector exists), `text` (body text contains), or `fn` (JS predicate truthy). '
            + 'Returns how long it waited. 用途：SPA / 微前端 navigate 返回后正文还没渲染（拿到标题 ≠ 内容就绪）、'
            + '等列表加载完再抽取、等某个全局变量就绪（如 `window.rawData !== null`）。'
            + '超时会明确报 `wait timeout`（**不等于**"页面没有内容"，只是该条件在预算内没成立）。',
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
        presentCall: () => ({ card: 'generic', title: 'Wait for page condition', kind: 'other' }),
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const condition = describeWaitCondition(args);
            if (condition === undefined) {
                throw new Error('browser_wait 需要 selector / text / fn 三者之一（一次只等一个条件）');
            }
            const budget = Math.min(120_000, Math.max(100, Math.trunc(args.timeoutMs ?? 15_000)));
            try {
                const waited = await controller.execute('wait', {
                    ...condition.params,
                    timeoutMs: budget,
                    ...(args.tabId === undefined ? {} : { tabId: args.tabId }),
                }, exec.signal);
                return {
                    tabId: typeof waited?.tabId === 'number' ? waited.tabId : (args.tabId ?? -1),
                    waitedMs: typeof waited?.waited === 'number' ? waited.waited : budget,
                    condition: condition.label,
                };
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`等待「${condition.label}」失败：${detail}`
                    + ' —— 这不等于"页面没有内容"：可能只是慢（加大 timeoutMs），也可能条件写错了（先用 browser_evaluate 验证该条件此刻的取值）。');
            }
        },
    }));
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
        presentCall: () => ({ card: 'generic', title: 'Read browser page', kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const mode = args.mode === 'html' ? 'html' : 'text';
            const params = { mode, flattenFrames: true };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.frame !== undefined)
                params.frame = args.frame;
            const raw = await controller.execute('content', params, exec.signal);
            const clamped = clampText(raw.content ?? '', READ_CONTENT_MAX_CHARS);
            return {
                tabId: raw.tabId,
                mode,
                title: raw.title ?? '',
                url: raw.url ?? '',
                content: clamped.content,
                truncated: clamped.truncated,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_snapshot',
        description: 'Inventory the page\'s interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards. '
            + '判据包含原生控件、ARIA role/tabindex/onclick，以及**只有点击处理器的 div/span**（靠 `cursor:pointer` 的样式边界识别，'
            + '这类元素在淘宝 SKU 面板、拼多多商品卡上是主体，条目里会带 `why=cursor`）。'
            + '该判据不完美：若某目标没被列出，退回 browser_evaluate 定位 + 设 id + `browser_click selector=#id` 这条稳妥路径。',
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
                                why: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const lines = value.items.map((item) => {
                    const name = typeof item.name === 'string' ? item.name.trim().replace(/\s+/g, ' ').slice(0, 140) : '';
                    const href = typeof item.href === 'string' && item.href.length > 0 ? ` → ${item.href.slice(0, 140)}` : '';
                    const why = typeof item.why === 'string' && item.why.length > 0 && item.why !== 'native' ? ` (${item.why})` : '';
                    return `${item.ref}\t<${item.tag}>${name.length > 0 ? ' ' + name : ''}${href}${why}`;
                });
                const cursorCount = value.items.filter((item) => item.why === 'cursor').length;
                return textBlock(`${value.title} (${value.url})\n共 ${value.items.length} 个可交互元素`
                    + `${cursorCount > 0 ? `（其中 ${cursorCount} 个是"只有点击处理器的元素"，按 cursor:pointer 边界识别）` : ''}`
                    + `（每行第一列就是 ref，可直接传给 browser_click / browser_type）：\n${lines.join('\n')}`);
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Snapshot browser page', kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const limit = Math.min(200, Math.max(1, args.limit ?? 120));
            const raw = await controller.execute('snapshot', args.tabId === undefined ? { limit } : { limit, tabId: args.tabId }, exec.signal);
            return {
                tabId: raw.tabId,
                title: raw.title ?? '',
                url: raw.url ?? '',
                items: (raw.items ?? []).map(item => ({
                    ref: item.ref,
                    tag: item.tag,
                    ...(item.name === undefined ? {} : { name: item.name }),
                    ...(item.href === undefined ? {} : { href: item.href }),
                    ...(item.why === undefined ? {} : { why: item.why }),
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_click',
        description: 'Click a page element with real mouse events; target it by snapshot ref or CSS selector. '
            + '目标标签页会被**自动置前**（真实鼠标事件要落在可见页面上），所以后台标签页也可以直接点，不必先 activate；'
            + '登录态/SPA 上 JS `el.click()` 常不触发跳转，本工具走的是真实事件通道。'
            + '唯一限制：窗口被最小化时视口为 0×0，真实键鼠送不进去（会明确报错，不会静默失败）。',
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
        presentCall: args => ({ card: 'generic', title: `Click ${args.ref ?? args.selector ?? ''}`, kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const params = { selector: targetSelector(args) };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.doubleClick !== undefined)
                params.doubleClick = args.doubleClick;
            return await controller.execute('click', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_type',
        description: 'Fill an input/textarea/select/contentEditable (React-compatible events); optionally press Enter afterwards. '
            + '和 browser_click 一样会把目标标签页自动置前；窗口最小化时真实输入送不进去（会明确报错）。',
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
        presentCall: args => ({ card: 'generic', title: `Type into ${args.ref ?? args.selector ?? 'element'}`, kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const params = { selector: targetSelector(args), value: args.value };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            const filled = await controller.execute('input', params, exec.signal);
            if (args.submit === true) {
                await controller.execute('press', args.tabId === undefined ? { key: 'Enter' } : { key: 'Enter', tabId: args.tabId }, exec.signal);
            }
            return filled;
        },
    }));
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
        presentCall: args => ({ card: 'generic', title: `Press ${args.key}`, kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const params = { key: args.key };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('press', params, exec.signal);
        },
    }));
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
        presentCall: () => ({ card: 'generic', title: 'Scroll browser page', kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const params = { x: args.x ?? 0, y: args.y ?? 0 };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('scroll', params, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_tabs',
        description: 'List tabs, or open/close/activate one. Actions act on real browser windows. '
            + 'close 支持批量：给 `tabIds`（数组）、`urlPattern`（URL 子串或 /正则/）、或 `others: true`（关掉除 `tabId` 外的全部）—— '
            + '不用为了收拾十几个页签发十几次调用。',
        parameters: {
            action: { type: 'string', required: true, description: 'One of: list, open, close, activate.' },
            url: { type: 'string', description: 'URL for the open action.' },
            tabId: { type: 'number', description: 'Target tab for close/activate; with others:true it is the one to KEEP.' },
            tabIds: { type: 'array', items: { type: 'number' }, description: 'close: explicit list of tab ids to close.' },
            urlPattern: { type: 'string', description: 'close: only tabs whose URL contains this substring, or a /regex/ form.' },
            others: { type: 'boolean', description: 'close: close every tab except tabId (defaults the kept tab to the active one).' },
            active: { type: 'boolean', description: 'Whether a newly opened tab becomes active; defaults to true.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => {
                const tabs = Array.isArray(value?.tabs) ? value.tabs : [];
                if (tabs.length === 0) {
                    if (Array.isArray(value?.closedIds)) {
                        return textBlock(`已关闭 ${value.closed ?? value.closedIds.length} 个标签页：${value.closedIds.join(', ')}`
                            + `${Array.isArray(value.failedIds) && value.failedIds.length > 0 ? `；失败：${value.failedIds.join(', ')}` : ''}`);
                    }
                    return textBlock(JSON.stringify(value));
                }
                const lines = tabs.map((tab) => `${tab.id}\t${tab.active === true ? 'active' : '      '}\t${String(tab.title ?? '')} — ${String(tab.url ?? '')}`);
                const head = `窗口 ${value.windows ?? '?'} 个，标签页 ${value.count ?? tabs.length} 个`
                    + `（activeTabId=${value.activeTabId ?? '?'}${value.noWindow === true ? '，当前没有任何窗口' : ''}）`;
                return textBlock(`${head}\n${lines.join('\n')}`);
            },
        },
        presentCall: args => ({ card: 'generic', title: `Browser tabs: ${args.action}`, kind: 'other' }),
        async execute(args, exec) {
            switch (args.action) {
                case 'list':
                    return await controller.execute('tabs.list', {}, exec.signal);
                case 'open': {
                    if (typeof args.url !== 'string' || args.url.length === 0)
                        throw new Error('open requires url');
                    await authorizeNavigation(ctx, controller, args.url, exec, 'browser_tabs');
                    const params = { url: args.url };
                    if (args.active !== undefined)
                        params.active = args.active;
                    return await controller.execute('tabs.open', params, exec.signal);
                }
                case 'close': {
                    // 单页签：保持老语义（tabId）。
                    const explicit = Array.isArray(args.tabIds) ? args.tabIds.filter((id) => typeof id === 'number') : [];
                    const others = args.others === true;
                    const pattern = typeof args.urlPattern === 'string' && args.urlPattern.length > 0 ? args.urlPattern : undefined;
                    if (explicit.length === 0 && !others && pattern === undefined) {
                        return await controller.execute('tabs.close', { tabId: requireTabId(args, 'close') }, exec.signal);
                    }
                    const listed = await controller.execute('tabs.list', {}, exec.signal);
                    const tabs = Array.isArray(listed?.tabs) ? listed.tabs : [];
                    const keep = typeof args.tabId === 'number'
                        ? args.tabId
                        : (typeof listed?.activeTabId === 'number' ? listed.activeTabId : tabs.find(tab => tab.active === true)?.id);
                    const matcher = pattern === undefined ? undefined : compileUrlPattern(pattern);
                    const wantClose = (tab) => {
                        if (typeof tab.id !== 'number')
                            return false;
                        if (matcher !== undefined)
                            return matcher(tab.url ?? '');
                        if (explicit.length > 0)
                            return explicit.includes(tab.id);
                        if (others)
                            return tab.id !== keep;
                        return false;
                    };
                    const targets = tabs.filter(wantClose).map(tab => tab.id);
                    if (targets.length === 0) {
                        return { closed: 0, closedIds: [], note: `没有匹配的标签页（现有 ${tabs.length} 个；matcher=${pattern ?? (others ? `others(keep=${String(keep)})` : 'tabIds')}）` };
                    }
                    const closedIds = [];
                    const failedIds = [];
                    for (const id of targets) {
                        try {
                            await controller.execute('tabs.close', { tabId: id }, exec.signal);
                            closedIds.push(id);
                        }
                        catch (error) {
                            failedIds.push({ id, error: error instanceof Error ? error.message : String(error) });
                        }
                    }
                    return {
                        closed: closedIds.length,
                        closedIds,
                        ...(failedIds.length === 0 ? {} : { failedIds }),
                    };
                }
                case 'activate':
                    return await controller.execute('tabs.activate', { tabId: requireTabId(args, 'activate') }, exec.signal);
                default:
                    throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate)`);
            }
        },
    }));
    ctx.tools.register(defineTool({
        name: 'browser_evaluate',
        description: 'Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection. '
            + '表达式会被当作 **async 函数体**执行（顶层 `await` 可用），返回的 promise 会被等待到 `timeoutMs`（默认 15s）。'
            + '注意：① 表达式里**不要**写轮询/sleep —— 超时（`eval timeout after Nms`）与"页面没内容"表现完全一样，'
            + '需要等待请用 browser_wait，或分多次调用；② 只返回可序列化数据（DOM 节点/循环引用请自己 `JSON.stringify`）。'
            + '注意：`history.pushState` 只改 URL、**不会**触发 SPA 重渲染 —— 用它站内翻页会让后续抽取读到上一条页面的内容'
            + '（实测踩过，URL 变了内容没变）；换页请用 browser_navigate，抽取前先核对页面身份（标题/编号）。',
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
        presentCall: () => ({ card: 'generic', title: 'Evaluate in page', kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const params = { expression: args.expression };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.timeoutMs !== undefined) {
                const budget = Math.min(120_000, Math.max(100, Math.trunc(args.timeoutMs)));
                params.timeoutMs = budget;
            }
            const raw = await controller.execute('eval', params, exec.signal);
            let json;
            try {
                json = JSON.stringify(raw.value) ?? String(raw.value);
            }
            catch {
                json = String(raw.value);
            }
            return { tabId: raw.tabId, json };
        },
    }));
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
        presentCall: () => ({ card: 'generic', title: 'Browser screenshot', kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const format = args.format === 'jpeg' ? 'jpeg' : 'png';
            const params = { format };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.fullPage !== undefined)
                params.fullPage = args.fullPage;
            const payload = await controller.execute('screenshot', params, exec.signal);
            return saveScreenshot(controller, payload);
        },
    }));
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
        presentCall: () => ({ card: 'generic', title: 'Clean up browser artifacts', kind: 'other' }),
        async execute() {
            const result = await controller.cleanup();
            return { shotsRemoved: result.shotsRemoved, scratchRemoved: Array.from(result.scratchRemoved) };
        },
    }));
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
    };
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
    };
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
                    const time = typeof entry.t === 'number' ? new Date(entry.t).toLocaleTimeString() : '';
                    const location = typeof entry.location === 'string' && entry.location.length > 0 ? `  @ ${entry.location}` : '';
                    return `${time} [${entry.level ?? 'log'}] ${String(entry.text ?? '').slice(0, 500)}${location}`;
                });
                return textBlock(`Tab ${value.tabId}: ${value.count} of ${value.total} console entries\n${lines.join('\n')}`);
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser console', kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (Array.isArray(args.levels))
                params.levels = args.levels;
            if (typeof args.pattern === 'string')
                params.pattern = args.pattern;
            if (typeof args.limit === 'number')
                params.limit = args.limit;
            if (args.clear === true)
                params.clear = true;
            return await controller.execute('console.log', params, exec.signal);
        },
    }));
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
                    const status = typeof request.status === 'number' ? String(request.status) : (request.failed === true ? 'FAILED' : 'pending');
                    const size = typeof request.encodedDataLength === 'number' && request.encodedDataLength > 0 ? ` ${request.encodedDataLength}B` : '';
                    const error = request.failed === true && typeof request.errorText === 'string' ? ` — ${request.errorText}` : '';
                    const type = typeof request.resourceType === 'string' && request.resourceType.length > 0 ? ` [${request.resourceType}]` : '';
                    return `${status}${size}${type}\t${request.method ?? 'GET'} ${String(request.url ?? '').slice(0, 300)}${error}`;
                });
                return textBlock(`Tab ${value.tabId}: ${value.count} of ${value.total} network requests\n${lines.join('\n')}`);
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser network log', kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.includeStatic === true)
                params.includeStatic = true;
            if (typeof args.methodPattern === 'string')
                params.methodPattern = args.methodPattern;
            if (typeof args.urlPattern === 'string')
                params.urlPattern = args.urlPattern;
            if (typeof args.status === 'string')
                params.status = args.status;
            if (typeof args.limit === 'number')
                params.limit = args.limit;
            if (args.clear === true)
                params.clear = true;
            return await controller.execute('network.log', params, exec.signal);
        },
    }));
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
        presentCall: () => ({ card: 'generic', title: 'Clear browser network log', kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('network.clear', params, exec.signal);
        },
    }));
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
        presentCall: args => ({ card: 'generic', title: `Save PDF${args.path ? ' → ' + args.path : ''}`, kind: 'other' }),
        async execute(args, exec) {
            await authorizeExistingTab(controller, args.tabId, exec.signal);
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.landscape === true)
                params.landscape = true;
            if (args.printBackground === false)
                params.printBackground = false;
            if (typeof args.paperWidth === 'number')
                params.paperWidth = args.paperWidth;
            if (typeof args.paperHeight === 'number')
                params.paperHeight = args.paperHeight;
            if (typeof args.scale === 'number')
                params.scale = args.scale;
            if (typeof args.pageRanges === 'string')
                params.pageRanges = args.pageRanges;
            const payload = await controller.execute('pdf', params, exec.signal);
            return await savePdf(controller, payload, typeof args.path === 'string' ? args.path : undefined);
        },
    }));
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
                if (value.reset)
                    return [{ type: 'text', text: `Tab ${value.tabId}: emulation reset to default` }];
                return [{
                        type: 'text',
                        text: `Tab ${value.tabId}: ${value.width || '?'}×${value.height || '?'} DPR=${value.deviceScaleFactor ?? '?'} mobile=${value.isMobile ?? false} touch=${value.hasTouch ?? false}`,
                    }];
            },
        },
        presentCall: args => ({ card: 'generic', title: `Emulate${args.device ? ' ' + args.device : ' device'}`, kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (typeof args.device === 'string')
                params.device = args.device;
            if (typeof args.width === 'number')
                params.width = args.width;
            if (typeof args.height === 'number')
                params.height = args.height;
            if (typeof args.deviceScaleFactor === 'number')
                params.deviceScaleFactor = args.deviceScaleFactor;
            if (typeof args.isMobile === 'boolean')
                params.isMobile = args.isMobile;
            if (typeof args.hasTouch === 'boolean')
                params.hasTouch = args.hasTouch;
            if (typeof args.userAgent === 'string')
                params.userAgent = args.userAgent;
            return await controller.execute('emulate', params, exec.signal);
        },
    }));
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
            render: (_args, value) => textBlock(String(value.text ?? '')),
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser permissions', kind: 'other' }),
        async execute(args, exec) {
            const config = getConfig();
            const url = await currentTabUrl(controller, args.tabId, exec.signal);
            if (typeof url !== 'string' || url.length === 0) {
                throw new Error('拿不到该标签页的 URL（标签页可能已关闭）——换一个 tabId，或用 browser_tabs 看现有标签页');
            }
            // 挂起信号：扩展 network buffer 里"已发出、未结束"的请求。指向本机/私网的 pending 请求
            // + 对应权限类是"询问" ⇒ 屏幕上大概率正挂着一个 LNA 气泡。CDP 对 chrome 自己的权限气泡
            // **没有事件**，所以这是唯一可靠的推断路径（而不是猜"页面慢"）。
            const pendingLocal = [];
            try {
                const payload = await controller.execute('network.log', {
                    status: 'pending',
                    limit: 50,
                    ...(args.tabId === undefined ? {} : { tabId: args.tabId }),
                }, exec.signal);
                for (const request of payload?.requests ?? []) {
                    const raw = typeof request?.url === 'string' ? request.url : '';
                    if (raw.length === 0)
                        continue;
                    let host = '';
                    try {
                        host = new URL(raw).hostname;
                    }
                    catch {
                        continue;
                    }
                    const realm = realmOf(host);
                    if (realm !== 'local' && realm !== 'lan')
                        continue;
                    const wallTime = typeof request?.wallTime === 'number' ? request.wallTime : undefined;
                    const ageSeconds = wallTime === undefined ? undefined : Math.max(0, Math.round(Date.now() / 1000 - wallTime));
                    pendingLocal.push(ageSeconds === undefined ? { url: raw } : { url: raw, ageSeconds });
                }
            }
            catch { /* 网络缓冲读不到不影响权限现状本身 */ }
            // 修 bi-013：配置里存的可能是 Windows 形态路径（浏览器在 Windows 侧），而这个进程在 WSL 里；
            // 直接把原值交给 path.join 会读不到**配置正确**的 profile。候选顺序：配置值 → 配对记录学到的位置。
            const pairingDir = controller.describePolicy().pairing?.profileDir;
            const resolvedStore = readPermissionStoreTolerant([config.autoLaunchProfileDir, pairingDir]);
            const store = resolvedStore.store;
            const requested = args.className === undefined ? undefined : String(args.className);
            const reading = readOriginPermissions(store, url, requested === undefined ? undefined : { pref: requested });
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
            });
            return { ...(args.tabId === undefined ? {} : { tabId: args.tabId }), origin: reading.origin, text };
        },
    }));
}
/**
 * 0.2.0 的 `.volatile()` 字段在组合结果里不是普通值，而是惰性访问器对象
 * （官方读法是 `config.cwd.get()` / `config.timeoutMs.get()`）。本插件把 config
 * 当普通对象用遍了整个 apply，这里统一解包一次，避免逐处 `.get()` 漏字段 ——
 * 漏一处的后果就是该项设置静默失效（buddy 正是这么栽的，见其 schema 注释）。
 */
function unwrapVolatile(config) {
    const source = config;
    const out = {};
    for (const key of Object.keys(source)) {
        const value = source[key];
        const accessor = value;
        out[key] = value !== null && typeof value === 'object' && typeof accessor?.get === 'function'
            ? accessor.get()
            : value;
    }
    return out;
}
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export function apply(ctx, config) {
    const resolved = unwrapVolatile(config);
    if (resolved.enabled && resolved.token.trim().length === 0) {
        throw new Error('browser-bridge: token must be a non-empty string when enabled');
    }
    if (resolved.urlMode !== 'public' && resolved.urlMode !== 'intranet') {
        throw new Error(`browser-bridge: invalid urlMode "${String(resolved.urlMode)}" (use public|intranet)`);
    }
    for (const [label, v] of [['internetAccess', resolved.internetAccess], ['lanAccess', resolved.lanAccess], ['localAccess', resolved.localAccess]]) {
        if (v !== undefined && v !== 'allow' && v !== 'ask' && v !== 'deny') {
            throw new Error(`browser-bridge: invalid ${label} "${String(v)}" (use allow|ask|deny)`);
        }
    }
    if (resolved.askMode !== 'inherit' && resolved.askMode !== 'allow' && resolved.askMode !== 'deny') {
        throw new Error(`browser-bridge: invalid askMode "${String(resolved.askMode)}" (use inherit|allow|deny)`);
    }
    assertOriginList(resolved.dshOrigins);
    assertHostList('allowHosts', resolved.allowHosts);
    assertHostList('denyHosts', resolved.denyHosts);
    assertMetadataLists(resolved);
    const controller = new BridgeController(line => ctx.logger.info(line));
    const current = () => resolved;
    // 0.2.0 起 Host 是设置的唯一事实源：用户层并入 loader 条目 config，apply 收到的
    // config 就是生效值。原本的 settings.register + scope.watch 因此整块删除 ——
    // 改一次设置 = 重组一次条目 = 重跑本函数，校验在函数开头已经做过一遍。
    void controller.reconcile(current());
    // 「本 DSH 控制页」的本机地址由宿主自己推导：GUI 端口写在 `webServer` 服务里
    // （配置 0 时是 OS 实际分配的端口），所以不需要用户去登记一个会过期的 origin ——
    // 端口变了这里跟着变。手动列表仍然生效，作为额外地址（局域网 IP / 域名）。
    // 缺这个服务时（非 web 部署）不做任何事，行为退回「只认用户登记的列表」。
    const injectOptional = ctx.inject;
    injectOptional(['webServer'], (scoped) => {
        const port = scoped.webServer?.port;
        if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535)
            return;
        const origin = `http://127.0.0.1:${port}`;
        controller.setControlOrigins([origin]);
        ctx.logger.info(`browser-bridge: 本机 DSH 控制页地址 = ${origin}（推导自 webServer 服务，用于 DSH 页面红线）`);
    });
    // 激活期**不再** fail-loud：历史上这里把拒绝再抛出去，形成无人处理的 Promise 拒绝，
    // DSH 的 fail-loud 处理器随即 `exit(1)`（端口被占即 DSH 起不来，见 P0-探针取证）。
    // 现在启动失败只记录到 lastError（端口回退在 reconcileNow 内完成），由 browser_policy_status 暴露。
    void controller.reconcile(resolved).catch((error) => {
        ctx.logger.warn(`browser-bridge: 激活期收敛失败（已降级，不影响 DSH 启动）: ${errorMessage(error)}`);
    });
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
        wake: (options) => controller.wakeBrowser(options ?? {}),
        /** 调用时问题登记簿（第二部分注册表）：据此在「本会话首次调用」时给出绕行摘要。 */
        issues: () => loadIssues(resolved.registryDir),
        /** 插件版本（摘要里标注 / 登记簿 fixedIn 默认值）。 */
        version: () => currentPluginVersion(resolved.registryDir),
    };
    ctx.provide('browserBridge', bridgeService);
    applyBrowserTools(ctx, controller, () => current());
    // Unified self-update / design-registry tools (browser_check_update,
    // browser_design_show, browser_design_edit). Read-only pair plus an
    // approval-gated writer over the package registry copies.
    applyUnifiedTools(ctx, resolved);
    // 原 dsh-browser-buddy 的能力（工具面分层 / 状态注入 / 调用即唤醒 / 登记簿送达 +
    // browser_tools / browser_frames / browser_frame_eval）。合并后它直接用 controller，
    // frames/eval 不再走 HTTP 命令面，于是自动过 URL 策略与已开标签页红线。
    applyBuddyFeatures({
        ctx,
        controller,
        bridge: bridgeService,
        config: resolved,
        authorizeTab: (tabId, signal) => authorizeExistingTab(controller, tabId, signal ?? new AbortController().signal),
    });
    ctx.effect(() => () => {
        void controller.stop();
    }, 'browser-bridge: server lifecycle');
}
