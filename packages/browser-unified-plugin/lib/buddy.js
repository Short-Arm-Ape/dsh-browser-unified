/**
 * buddy.ts — 原 `dsh-browser-buddy` 的能力，**合并进桥插件**（de-036，2026-10-10）。
 *
 * 合并前它是一个独立插件，靠三个公开扩展点外挂在这座桥旁边；合并后它与桥共用同一个
 * ctx/配置/生命周期，于是那些跨包接缝全部消失：
 *
 *  1. **工具面分层** —— `system-prompt/assemble`（waterfall，返回值权威），在 `next()` 之后
 *     替换 `tools`：常驻白名单 + 按组展开。实测（2026-09-28 首次读数）：21 个 browser_* →
 *     常驻 6 个，隐藏 16 个（8,937 字符，约占整个工具面 19%）。数量别写死，看
 *     `browser_tools action=status` 的实时读数。
 *  2. **状态注入** —— `ctx.systemPrompt.context({ text: () => ... })` 按轮次求值：桥在哪个端口、
 *     扩展连没连、分层与自动拉起的当前状态。
 *  3. **调用即唤醒** —— `tools/pre-execute`：`browser_*` 调用前探一次桥状态；开着开关且扩展
 *     未连接时先唤醒浏览器、等它连上再放行，并把"我替你开了一个窗口、落在哪个网址"作为
 *     一次性回执送给模型。
 *  4. **问题登记簿送达** —— `tools/post-execute` + `additionalContexts`：会话**首次**调用
 *     `browser_*` 时挂一次摘要（仍存在的问题 + 各自绕行；以及"你上次调用之后修复的"定向告知）。
 *
 * 合并带来的三个具体收益（都是原来踩过的坑）：
 *  - `browser_frames` / `browser_frame_eval` 不再走 `POST /api/command`，改用 controller
 *    （于是自动过 URL 策略与"已开标签页红线"）；
 *  - 探桥端口不再硬编码 9777：桥自报的 `boundPort` 优先（原来配置端口一改就误报"全未命中"）；
 *  - 不再有 `browserBridge` 跨包服务契约与"同一份配置存两处"的隐患。
 *
 * 仍然**不**解决的：分层的作用域。`ctx.tools.restrict()` 在全局 ctx 上会抛错
 * （"a context-global restriction would mask every agent"），所以这里仍是全局装配重写 ⇒
 * 同进程所有会话共享同一套展开状态。要做按会话得走 `agent.ctx`（独立立项，见 de-023 备注）。
 *
 * 会话标记文件仍在 `<DSH_HOME>/browser-buddy/session-issues.json`（沿用旧路径，免得丢历史）。
 * 本文件是 AGPL-3.0-only（同插件）。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
/** 合并进插件后的旋钮默认值（原先由本包自己的 Config schema 提供；现在声明在插件 schema 里）。 */
export const BUDDY_DEFAULTS = {
    layeredTools: true,
    autoLaunchOnToolUse: false,
    autoLaunchWaitMs: 8_000,
    enabledGroups: [],
};
/** 默认常驻（第一层）工具：只读/高频 + 入口开关本身。
 *  `browser_read` 自宿主 0.8.0 起已把**正文**交给模型、并支持 `frame` 与 frameset 自动拍平，
 *  所以本包不再重复提供读页面工具（0.4.0 移除了 browser_page_read / browser_frame_read）。 */
const DEFAULT_RESIDENT = [
    'browser_policy_status',
    'browser_read',
    'browser_snapshot',
    'browser_screenshot',
    'browser_launch',
    'browser_tools',
    // 问题登记簿必须常驻：会话首次调用/列表有变化时都会提示模型去查或去提，
    // 若它躺在默认隐藏的 registry 组里，那句提示就等于指着一个看不见的工具（真机验收时发现）。
    'browser_issues',
    // 权限现状同样必须常驻：命令超时（多为浏览器级权限气泡在等人）的一次性提示会点名让它去查，
    // 藏进组里就又是一句"指着一个看不见的工具"（同 browser_issues 的教训）。
    'browser_permissions',
];
/** 默认分组：按需展开。registry 组是仓库维护工具，日常不该出现在工具面里。 */
const DEFAULT_GROUPS = {
    interact: ['browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_dialog', 'browser_hold'],
    debug: [
        'browser_evaluate',
        'browser_console_log',
        'browser_network_log',
        'browser_network_clear',
        'browser_emulate',
        'browser_pdf',
        // 上行 v1.0.9 的三件只读诊断件：按需展开，别常驻占 token。
        'browser_find',
        'browser_info',
    ],
    session: ['browser_navigate', 'browser_tabs', 'browser_cleanup', 'browser_wait'],
    /** 老式 frameset 管理页专用：列帧结构 + 在指定帧里求值（读正文交给宿主的 browser_read）。 */
    frames: ['browser_frames', 'browser_frame_eval'],
    registry: ['browser_check_update', 'browser_design_show', 'browser_design_edit'],
};
/**
 * 写回目标命名空间：合并后**就是插件自己**的 `browser-bridge`（旋钮与端口/令牌同处一份配置）。
 * 合并前这里写的是独立的 `browser-buddy` 段 —— 那正是"同一份意图存两处"的来源。
 */
const SETTINGS_NS = 'browser-bridge';
/** 桥插件的设置命名空间（只读消费：生效配置的唯一事实来源）。 */
const BRIDGE_NS = 'browser-bridge';
/** 会话问题标记文件（相对 DSH_HOME）。 */
const SESSION_MARKS_REL = path.join('browser-buddy', 'session-issues.json');
/** 标记文件最多保留多少个会话（超出丢最旧的）。 */
const SESSION_MARKS_MAX = 50;
// 旋钮已并入插件 Config（index.ts 的 browser-bridge schema）：
//   layeredTools / autoLaunchOnToolUse / autoLaunchWaitMs / enabledGroups
// 高级项（residentTools / groups / scanBase / scanCount / autoLaunchCooldownMs /
// bridgeCommandTimeoutMs）不进 schema，直接用配置里的同名键覆盖默认（schemastery 会原样保留未声明键）。
/** 输出 schema（原生 JSON Schema；registry 只校验 output.schema）。 */
const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        ok: { type: 'boolean' },
        text: { type: 'string' },
    },
    required: ['ok', 'text'],
};
const renderText = (_args, value) => [{ type: 'text', text: String(value.text) }];
/**
 * 0.2.0 的 `.volatile()` 字段在组合结果里不是普通值，而是惰性访问器对象
 * （官方读法是 `config.cwd.get()`）。直接比较会**静默退化且不报错**：
 * patch 里写着 `autoLaunchOnToolUse: true`，这里读出来却恒为 false
 * （现象就是工具面一直显示"调用即自动拉起：关"）。
 * 未在 schema 里声明的键不受影响（实测 schemastery 会原样保留），所以只需解包。
 */
function unwrapVolatile(config) {
    const out = {};
    const source = config || {};
    for (const key of Object.keys(source)) {
        const value = source[key];
        out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function'
            ? value.get()
            : value;
    }
    return out;
}
/**
 * 把原 buddy 的能力接进桥插件。
 * @param options.ctx 插件的 ctx（与桥共用同一个）
 * @param options.bridge 桥服务对象（插件内部构造：{config, describe, wake, issues, version}）
 * @param options.controller 桥控制器（frames/eval 直连它，不再走 HTTP 命令面）
 * @param options.config 插件已解析的配置（含合并进来的 4 个旋钮）
 * @param options.settings 可选 settings 服务（把 `browser_tools action=auto_launch` 的改动写回用户层）
 * @param options.authorizeTab 可选：对"已开标签页"的红线检查（插件把 approveExistingTab 传进来）
 * @returns 运行态句柄（`state` 供测试与状态面读取）
 */
export function applyBuddyFeatures(options) {
    const ctx = options.ctx;
    const controller = options.controller ?? null;
    const authorizeTab = typeof options.authorizeTab === 'function' ? options.authorizeTab : null;
    let settings = options.settings;
    const config = unwrapVolatile(options.config ?? {});
    /**
     * 把一份**原始**配置推导成运行态旋钮。抽成函数是为了支持热更新：宿主对 volatile 字段
     * 只原地提交并发 `loader/volatile-update`，**不会重跑 apply**（见 index.ts 的同名处理），
     * 所以层化/分组/自动拉起这些旋钮必须能在这里重建 —— 否则设置页勾了「工具面分层」要等重启（bi-038）。
     */
    const buildCfg = (raw) => {
        const config = unwrapVolatile((raw ?? {}));
        return {
            layeredTools: config.layeredTools !== false,
            scanBase: Number.isInteger(config.scanBase) ? config.scanBase : 9777,
            scanCount: Number.isInteger(config.scanCount) ? config.scanCount : 10,
            autoLaunchOnToolUse: config.autoLaunchOnToolUse === true,
            autoLaunchCooldownMs: Number.isInteger(config.autoLaunchCooldownMs) ? config.autoLaunchCooldownMs : 10_000,
            autoLaunchWaitMs: Number.isInteger(config.autoLaunchWaitMs) ? config.autoLaunchWaitMs : 8_000,
            residentTools: Array.isArray(config.residentTools) && config.residentTools.length > 0
                ? config.residentTools.map(String)
                : DEFAULT_RESIDENT,
            groups: config.groups && typeof config.groups === 'object' ? config.groups : DEFAULT_GROUPS,
            bridgeCommandTimeoutMs: Number.isInteger(config.bridgeCommandTimeoutMs) ? config.bridgeCommandTimeoutMs : 20_000,
            readOnly: config.readOnly === true,
            allowScript: config.allowScript !== false,
        };
    };
    let cfg = buildCfg(config);
    /** 热更新入口：宿主提交了新值之后由 index.ts 调用。`state.enabledGroups` 也跟着重置。 */
    const refreshConfig = (raw) => {
        const next = unwrapVolatile((raw ?? {}));
        cfg = buildCfg(raw);
        state.enabledGroups = Array.isArray(next.enabledGroups) ? next.enabledGroups.map(String) : [];
        resident = new Set(cfg.residentTools);
    };
    const state = {
        enabledGroups: Array.isArray(config.enabledGroups) ? config.enabledGroups.map(String) : [],
        probe: null,
        probeAt: 0,
        probeError: null,
        preExecuteChecks: 0,
        lastPreExecuteName: null,
        wakes: 0,
        lastWakeAt: 0,
        lastWakeNote: null,
        assembled: null,
        hidden: null,
        lastError: null,
        /** 会话问题标记（懒加载 + 缓存；持久化在 $DSH_HOME/browser-buddy/session-issues.json）。 */
        marks: null,
        /** 一次性唤醒回执（下次工具结果后注入一次；由 tools/post-execute 取走）。 */
        wakeNotePending: null,
    };
    // ── 桥配置：唯一事实来源 ────────────────────────────────────────────────────
    // 优先问桥插件的服务（0.8.2 起提供），老版本则直接读它的设置命名空间。
    // 本包**不再**自己存 exe/profile/令牌/端口：那些值改在「浏览器插件」分区，
    // 镜像一份的下场是两处不同步（拉起的窗口用了旧 profile ⇒ 窗口里没有扩展）。
    // bridge 由调用方注入（合并后没有跨包服务边界）；settings 拿不到时只改内存。
    const bridge = options.bridge ?? null;
    /** 读某设置命名空间的生效值（0.2.0-rc.2 起 settings.get() 已移除，改走 describe()）。 */
    function describeValue(ns) {
        if (settings === undefined)
            return undefined;
        try {
            const row = settings.describe().find((x) => x.ns === ns);
            return row === undefined ? undefined : row.value;
        }
        catch (error) {
            state.lastError = `读取设置命名空间 ${ns} 失败：${error instanceof Error ? error.message : String(error)}`;
            return undefined;
        }
    }
    /** 桥的生效配置（用户层 > 组合 base > schema 默认）；读不到返回 null。 */
    function bridgeConfig() {
        try {
            if (bridge !== null && typeof bridge.config === 'function') {
                const live = bridge.config();
                if (live !== null && typeof live === 'object')
                    return live;
            }
            const raw = settings === undefined ? undefined : describeValue(BRIDGE_NS);
            if (raw !== null && typeof raw === 'object')
                return raw;
        }
        catch (error) {
            state.lastError = `读取桥配置失败：${error instanceof Error ? error.message : String(error)}`;
        }
        return null;
    }
    /** 桥是否启用（读不到时按启用处理，避免误伤）。 */
    function bridgeEnabled() {
        const c = bridgeConfig();
        return c === null ? true : c.enabled !== false;
    }
    /** 人类可读的唤醒目标（排障与状态行用）。 */
    function wakeTargetText() {
        const c = bridgeConfig();
        if (c === null)
            return '（读不到桥配置）';
        const exe = typeof c.autoLaunchBrowserExe === 'string' && c.autoLaunchBrowserExe.length > 0
            ? c.autoLaunchBrowserExe
            : '自动探测 msedge/chrome';
        const profile = typeof c.autoLaunchProfileDir === 'string' && c.autoLaunchProfileDir.length > 0
            ? c.autoLaunchProfileDir
            : '未配置（拉起会落在默认 profile，可能没有扩展）';
        return `exe=${exe}；profile=${profile}`;
    }
    // ── 设置服务：读值直接用 apply() 收到的 config（0.2.0-rc.2 起用户层已并入 profile 文档，
    // Loader 重新组合后经 config 送达），这里只为**写回**与读桥命名空间而持有 settings。──
    // 注意：Cordis 的 Guard 会拒**未声明**的依赖 —— `ctx.get('settings')` 拿不到服务，
    // 必须用 ctx.inject 声明后取。
    if (settings === undefined && ctx !== null && typeof ctx.inject === 'function') {
        ctx.inject(['settings'], (sctx) => {
            // 合并后配置就是插件自己的命名空间；写回仍走 settings（拿不到就只改内存）。
            settings = sctx.settings;
        });
    }
    /** 把一份已解析配置套进运行态（设置变化与 patch 配置共用同一条路）。 */
    function applyResolved(next) {
        if (next === null || typeof next !== 'object')
            return;
        if (next.layeredTools !== undefined)
            cfg.layeredTools = next.layeredTools !== false;
        if (next.autoLaunchOnToolUse !== undefined)
            cfg.autoLaunchOnToolUse = next.autoLaunchOnToolUse === true;
        if (Number.isInteger(next.autoLaunchWaitMs))
            cfg.autoLaunchWaitMs = next.autoLaunchWaitMs;
    }
    /** 写回设置（持久化到 settings 文档）；settings 不可用时只改内存。 */
    async function persist(patch) {
        if (settings === undefined)
            return '（settings 服务不可用，仅本次运行生效）';
        try {
            await settings.update(SETTINGS_NS, patch);
            applyResolved(patch);
            return '（已写入设置，重启后仍生效）';
        }
        catch (error) {
            return `（写入设置失败：${error instanceof Error ? error.message : String(error)}）`;
        }
    }
    let resident = new Set(cfg.residentTools);
    /** 允许出现在模型工具面里的 browser_* 名单。 */
    /**
     * **只读档**下仍暴露给模型的 `browser_*` 工具（其余从工具面里拿掉）。
     * 这只是 L1（模型看不见）；真正的边界在插件 `BridgeController.execute` 的命令闸门（L2：拦得住）。
     */
    const READ_ONLY_TOOLS = new Set([
        'browser_read', 'browser_find', 'browser_snapshot', 'browser_screenshot', 'browser_wait',
        'browser_info', 'browser_policy_status', 'browser_permissions', 'browser_console_log',
        'browser_network_log', 'browser_frames', 'browser_tools', 'browser_issues',
        'browser_design_show', 'browser_check_update',
    ]);
    function allowedTools() {
        const allow = new Set(resident);
        for (const group of state.enabledGroups) {
            for (const toolName of cfg.groups[group] ?? [])
                allow.add(toolName);
        }
        return allow;
    }
    /* ------------------------------------------------------------ bridge probe */
    /**
     * 探桥的候选端口（X15，2026-10-10 修）。
     *
     * 以前写死 `9777..9786`（`scanBase`/`scanCount`）—— 于是用户一旦把 `browser-bridge.port` 改成
     * 别的值，**扩展能找到桥、本包却报"候选全未命中"**：状态行反过来、`调用即自动拉起` 的闸门
     * 也会误判（可能为此白开一个窗口）。正解是问桥自己：服务暴露的 `describe().boundPort` 是
     * **实际监听**的端口（端口被占时顺延后的那个），`config().port` 是配置值，最后才退回扫描窗口。
     */
    function bridgePortCandidates() {
        const out = [];
        const push = (value) => {
            const n = Number(value);
            if (Number.isInteger(n) && n > 0 && n <= 65535 && !out.includes(n))
                out.push(n);
        };
        try {
            if (bridge !== null && typeof bridge.describe === 'function')
                push(bridge.describe()?.boundPort);
        }
        catch { /* 服务抛错就退回配置值 */ }
        const live = bridgeConfig();
        if (live !== null)
            push(live.port);
        push(cfg.scanBase);
        for (let i = 1; i < cfg.scanCount; i += 1)
            push(cfg.scanBase + i);
        return out;
    }
    /**
     * 宿主侧端口探测：候选 = 桥自报的 boundPort → 配置端口 → 扫描窗口（9777..9786），命中即缓存 5 秒。
     * 用 `GET /api/status`：该端点带 CORS 头且不校验 token。
     */
    async function probeBridge(force = false) {
        const now = Date.now();
        if (!force && state.probe !== null && now - state.probeAt < 5000)
            return state.probe;
        const candidates = bridgePortCandidates();
        for (const port of candidates) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 400);
            try {
                const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                if (res.ok) {
                    const body = await res.json();
                    if (body && body.ok === true && typeof body.wsUrl === 'string') {
                        state.probe = {
                            port,
                            extensionConnected: body.extensionConnected === true,
                            extensionVersion: body.hello && typeof body.hello.version === 'string' ? body.hello.version : null,
                        };
                        state.probeAt = now;
                        state.probeError = null;
                        return state.probe;
                    }
                }
            }
            catch {
                /* 端口上没有桥 / 超时：继续下一个候选 */
            }
            finally {
                clearTimeout(timer);
            }
        }
        state.probe = { port: null, extensionConnected: false, extensionVersion: null };
        state.probeAt = now;
        state.probeError = `候选 ${candidates.join(', ')} 全未命中（桥自报端口优先，其次配置端口，最后扫描窗口）`;
        return state.probe;
    }
    /* --------------------------------------------------------- bridge command */
    /**
     *
     * 为什么需要它：已装插件对**工具参数是白名单转发**（例如 browser_read 只把
     * `{mode, tabId}` 交给桥），所以像 `frame` 这种新参数、以及 `frames` 这种新命令，
     * 用宿主工具根本传不进去。HTTP 命令面是目前唯一能带任意参数的通道。
     *
     * @param command 桥命令名（nav/eval/content/find/frames/click/input/...）
     * @param params  命令参数
     * @param timeoutMs 桥侧命令超时（可选）
     */
    /**
     * 执行一条桥命令。**合并后直连 controller**（原来走 `POST /api/command`，那条通道
     * 绕过 URL 策略与已开标签页红线 —— 见 X18/bi-029）。
     */
    async function bridgeCommand(command, params) {
        if (controller === null || typeof controller.execute !== 'function') {
            throw new Error('桥控制器不可用（插件尚未激活）');
        }
        return controller.execute(command, params ?? {}, new AbortController().signal);
    }
    /* ------------------------------------------------------------ browser wake */
    /**
     * 唤醒浏览器（受冷却保护）。**完全委托给桥插件**，本包不自己 spawn：
     *
     *  - 只有桥插件知道 exe/profile/临时干净实例/sideload 目录该怎么拼，也只有它处理
     *    「扩展连着但一个窗口都没有」那种故障态（走 `window.ensure`，不起进程）；
     *  - 0.7.x 以前本包自己存了一份 exe/profile，与「浏览器插件」分区里的
     *    autoLaunchBrowserExe/autoLaunchProfileDir 同值两处维护 —— 改一处另一处不跟着动，
     *    拉起的窗口落在没装扩展的 profile 上就是「唤起了但没用」。现在这份配置只有一份。
     *
     * @returns 人类可读的结果说明（不抛）。
     */
    async function wakeBrowser(trigger, landingUrl) {
        const now = Date.now();
        if (now - state.lastWakeAt < cfg.autoLaunchCooldownMs) {
            return `冷却中（距上次尝试 ${Math.round((now - state.lastWakeAt) / 1000)}s），跳过`;
        }
        state.lastWakeAt = now;
        if (bridge === null || typeof bridge.wake !== 'function') {
            return '桥插件未提供唤醒服务（dsh-browser-unified < 0.8.2）——请直接调用 browser_launch';
        }
        if (!bridgeEnabled()) {
            return '浏览器桥已停用，不自动拉起（先在「浏览器插件」分区打开「启用浏览器桥」）';
        }
        try {
            // 把"本次调用要去的网址"一并交给桥当落地页（2026-10-10：以前一律 about:blank，
            // 每唤起一次就多一张空白垃圾页；桥侧还会先过一遍 URL 策略，放行才采用）。
            const text = await bridge.wake(landingUrl === undefined ? { reason: trigger } : { reason: trigger, url: landingUrl });
            state.wakes += 1;
            state.lastWakeNote = `已唤醒（触发=${trigger}${landingUrl === undefined ? '' : `，落地 ${landingUrl}`}）：${text}`;
            ctx.logger?.info?.(`[browser-bridge] ${state.lastWakeNote}`);
            return state.lastWakeNote;
        }
        catch (error) {
            state.lastError = `唤醒失败：${error instanceof Error ? error.message : String(error)}`;
            return `唤醒失败：${state.lastError}`;
        }
    }
    /**
     * 从工具调用参数里取"本次要去的网址"（唤醒落地页用）。
     * 兼容 `arguments` 是对象或 JSON 字符串两种形态；只认 http(s)。
     */
    function wakeLandingUrlOf(exec) {
        let args = exec && exec.arguments;
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            }
            catch {
                return undefined;
            }
        }
        if (args === null || typeof args !== 'object')
            return undefined;
        const url = args.url;
        return typeof url === 'string' && /^https?:\/\//i.test(url.trim()) ? url.trim() : undefined;
    }
    /* ------------------------------------------------- issues digest (Part B 送达) */
    // DSH_HOME 由宿主作为服务提供（dsh-app-boot）；拿不到就退回环境变量/默认值。
    let dshHome = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    ctx.inject(['dshHomePath'], (hctx) => {
        const value = hctx.dshHomePath;
        if (typeof value === 'string' && value.length > 0)
            dshHome = value;
    });
    function marksFile() {
        return path.join(dshHome, SESSION_MARKS_REL);
    }
    /** 读会话标记（懒加载 + 缓存）；坏文件当空表，绝不因此让工具调用失败。 */
    async function loadMarks() {
        if (state.marks !== null)
            return state.marks;
        try {
            const raw = await readFile(marksFile(), 'utf8');
            const parsed = JSON.parse(raw);
            const sessions = parsed && typeof parsed.sessions === 'object' && parsed.sessions !== null ? parsed.sessions : {};
            state.marks = { sessions };
        }
        catch {
            state.marks = { sessions: {} };
        }
        return state.marks;
    }
    async function saveMarks() {
        if (state.marks === null)
            return;
        const entries = Object.entries(state.marks.sessions);
        if (entries.length > SESSION_MARKS_MAX) {
            entries.sort((a, b) => String(b[1]?.at ?? '').localeCompare(String(a[1]?.at ?? '')));
            state.marks.sessions = Object.fromEntries(entries.slice(0, SESSION_MARKS_MAX));
        }
        try {
            await mkdir(path.dirname(marksFile()), { recursive: true });
            await writeFile(marksFile(), JSON.stringify({ version: 1, sessions: state.marks.sessions }, null, 2) + '\n', 'utf8');
        }
        catch (error) {
            state.lastError = `会话标记写入失败：${error instanceof Error ? error.message : String(error)}`;
        }
    }
    /** 问题登记簿（第二部分注册表）由桥插件的服务提供；老版本没有就静默跳过。 */
    async function loadIssues() {
        try {
            if (bridge === null || typeof bridge.issues !== 'function')
                return null;
            const data = await bridge.issues();
            const issues = data && Array.isArray(data.issues) ? data.issues : [];
            return issues.filter((issue) => issue && typeof issue.id === 'string');
        }
        catch (error) {
            state.lastError = `读取问题登记簿失败：${error instanceof Error ? error.message : String(error)}`;
            return null;
        }
    }
    /**
     * 问题列表的「指纹」：id → status|fixedIn。
     * 触发规则是**与上次调用相比有没有变化**（不是"首次调用"）——列表没动就不打扰。
     */
    function issuesSnapshot(issues) {
        const map = {};
        for (const issue of issues)
            map[issue.id] = `${issue.status ?? '?'}|${issue.fixedIn ?? ''}`;
        return map;
    }
    function sameSnapshot(a, b) {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        if (ka.length !== kb.length)
            return false;
        for (const key of ka)
            if (a[key] !== b[key])
                return false;
        return true;
    }
    /** 小字符串哈希（判重「这个症状提过没」用，不需要加密强度）。 */
    function shortHash(text) {
        let hash = 5381;
        for (let i = 0; i < text.length; i += 1)
            hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
        return (hash >>> 0).toString(36);
    }
    /**
     * 把一次调用的文本拿去和每条问题的 match 正则比：命中即算「本会话撞到过」。
     * @returns 命中的问题 id 列表
     */
    async function noteIssueHits(sessionId, text, issues) {
        if (text.length === 0 || issues === null)
            return [];
        const hits = issues.filter((issue) => typeof issue.match === 'string' && issue.match.length > 0
            && new RegExp(issue.match, 'i').test(text));
        if (hits.length === 0)
            return [];
        const marks = await loadMarks();
        const mark = marks.sessions[sessionId] ?? { hits: [], snapshot: {}, at: '' };
        const set = new Set(Array.isArray(mark.hits) ? mark.hits.map(String) : []);
        let changed = false;
        for (const issue of hits) {
            if (!set.has(issue.id)) {
                set.add(issue.id);
                changed = true;
            }
        }
        if (changed) {
            mark.hits = [...set];
            mark.at = new Date().toISOString();
            marks.sessions[sessionId] = mark;
            await saveMarks();
        }
        return hits.map((issue) => issue.id);
    }
    /**
     * 送达「调用时问题登记簿」：**与上次调用相比列表有变化**时给一次摘要。
     *  - 第一次（没有指纹）：open 问题全量 + 绕行；
     *  - 之后：只讲变化（新增条目 → 带绕行；新修复条目 → 该会话撞到过的标 ★），且只有 open 集合变了才重复列 open。
     * 无论是否送达都会把指纹更新为「本次调用时的列表」——因为比较基准就是"上次调用"。
     * @returns 摘要文本或 null（没变化 / 登记簿不可用）
     */
    async function evaluateIssuesContext(sessionId, issues, pluginVersion) {
        const marks = await loadMarks();
        const mark = marks.sessions[sessionId] ?? { hits: [], snapshot: null, at: '' };
        const now = issuesSnapshot(issues);
        const prev = mark.snapshot !== null && typeof mark.snapshot === 'object' ? mark.snapshot : null;
        const hits = new Set(Array.isArray(mark.hits) ? mark.hits.map(String) : []);
        const open = issues.filter((issue) => issue.status === 'open' || issue.status === 'wontfix');
        if (prev !== null && sameSnapshot(prev, now))
            return null;
        const added = prev === null ? [] : issues.filter((issue) => !(issue.id in prev));
        const newlyFixed = prev === null ? [] : issues.filter((issue) => issue.status === 'fixed' && prev[issue.id] !== now[issue.id]);
        const openChanged = prev === null || added.some((issue) => issue.status === 'open' || issue.status === 'wontfix');
        const lines = [];
        if (prev === null) {
            lines.push(`【浏览器插件：调用时问题摘要（本会话首次调用${pluginVersion ? `；插件 ${pluginVersion}` : ''}）】`);
        }
        else {
            lines.push('【浏览器插件：调用时问题列表有变化】');
        }
        if (added.length > 0) {
            lines.push('新增/改动：');
            for (const issue of added) {
                lines.push(`- ${issue.id} [${String(issue.status ?? '?')}] ${issue.title}`);
                if (typeof issue.workaround === 'string' && issue.workaround.length > 0)
                    lines.push(`    绕行：${issue.workaround}`);
            }
        }
        if (newlyFixed.length > 0) {
            lines.push('已修复（现在可以正常用）：');
            for (const issue of newlyFixed) {
                lines.push(`- ${hits.has(issue.id) ? '★ 你撞到过——' : ''}${issue.id} ${issue.title}（${String(issue.fixedIn ?? '已修')}）`);
            }
        }
        if (openChanged && open.length > 0) {
            lines.push('仍存在（按绕行做，别硬碰）：');
            for (const issue of open) {
                lines.push(`- ${issue.id} ${issue.title}`);
                if (typeof issue.workaround === 'string' && issue.workaround.length > 0)
                    lines.push(`    绕行：${issue.workaround}`);
            }
        }
        if (lines.length === 1)
            return null; // 变化不值得说（例如只有标题改了）
        lines.push('完整内容（症状/证据/历史）与记录新问题：browser_issues（action=show [id] / add / resolve）。');
        mark.snapshot = now;
        mark.at = new Date().toISOString();
        marks.sessions[sessionId] = mark;
        await saveMarks();
        return lines.join('\n');
    }
    /** 只刷新指纹、不送达（模型自己刚查过/提过 issue，它已经知道内容了）。 */
    async function refreshIssuesSnapshot(sessionId, issues) {
        const marks = await loadMarks();
        const mark = marks.sessions[sessionId] ?? { hits: [], snapshot: null, at: '' };
        mark.snapshot = issuesSnapshot(issues);
        mark.at = new Date().toISOString();
        marks.sessions[sessionId] = mark;
        await saveMarks();
    }
    /**
     * 「这条失败**看起来是页面/表达式自己的问题**」的特征 —— 这类不该催模型去登记。
     *
     * 为什么要这道闸（F-3，2026-10-09 实测反馈）：模型自己写错表达式抛的 `page exception: TypeError…`
     * 也命中"登记簿里没有"这条路，于是模型收到一句"这个症状不在登记簿里、去登记吧"；而登记是**需要审批的
     * 写操作**（审批被禁用的会话里等于白催）。既噪声又空转。
     */
    const PAGE_SIDE_ERROR_RE = /page exception:|SyntaxError|ReferenceError|TypeError:|await is only valid|is not a function|Cannot read propert/i;
    /** 工具/插件/桥**自己**的失败特征：这些才值得进登记簿。 */
    const PLUGIN_SIDE_ERROR_RE = /browser_|桥|bridge|WEB_|NEED_AUTHORIZATION|eval timeout|No tab with id|window is minimized|权限|审批|registry|issues\.json/i;
    /**
     * 撞上一个**登记簿里没有**的失败时，给一句可行动的提示（每会话最多 3 次、同症状只提一次）：
     * 「先看有没有已知绕行，再把新问题记下来」——这就是会话级「能查能提」的入口。
     *
     * 只对**插件侧**报错提示（见 PAGE_SIDE_ERROR_RE 的说明）：模型写错表达式、页面自身抛异常
     * 属于"用户/页面数据问题"，不是插件缺陷，催登记只会制造噪音。
     */
    async function maybeNovelIssueHint(sessionId, result, matchedIds) {
        if (matchedIds.length > 0)
            return null;
        if (!result || result.isError !== true)
            return null;
        const line = resultText(result).split('\n')[0].trim().slice(0, 160);
        if (line.length === 0)
            return null;
        if (PAGE_SIDE_ERROR_RE.test(line) && !PLUGIN_SIDE_ERROR_RE.test(line))
            return null;
        if (!PLUGIN_SIDE_ERROR_RE.test(line))
            return null;
        const marks = await loadMarks();
        const mark = marks.sessions[sessionId] ?? { hits: [], snapshot: null, at: '' };
        const hinted = Array.isArray(mark.hinted) ? mark.hinted : [];
        const key = shortHash(line);
        if (hinted.includes(key) || hinted.length >= 3)
            return null;
        hinted.push(key);
        mark.hinted = hinted;
        mark.at = new Date().toISOString();
        marks.sessions[sessionId] = mark;
        await saveMarks();
        return `【浏览器插件】这个症状不在问题登记簿里：${line}\n`
            + '先 browser_issues action=show 看有没有已知绕行；确认是插件侧的新问题就 browser_issues action=add 记下来'
            + '（写入需用户审批；审批策略为 never 的会话里它会明确拒绝，不会白跑），后续会话少踩一次。';
    }
    /** 命令超时的特征（扩展侧 `eval timeout after Nms` / 桥侧超时 / 各家别称）。 */
    const TIMEOUT_RE = /timeout after \d+\s*ms|eval_timeout|timed out|超时/i;
    /**
     * 撞上**命令超时**时给一次性提示（每会话最多 2 次）。
     *
     * 为什么单独有这一条：浏览器 chrome 自己的权限气泡（最典型是页面访问 127.0.0.1 时的
     * 「本地网络访问」LNA）扩展**看不见也答不了**，表现出来只是一句超时 —— 模型很容易误诊
     * 成"页面慢/内容没加载"，然后反复换表达式、白烧上下文。这里直接把它指向只读的
     * `browser_permissions`（常驻），让模型先读权限态与挂起请求再决定。
     */
    async function maybeTimeoutHint(sessionId, result) {
        if (!result || result.isError !== true)
            return null;
        if (!TIMEOUT_RE.test(resultText(result)))
            return null;
        const marks = await loadMarks();
        const mark = marks.sessions[sessionId] ?? { hits: [], snapshot: null, at: '' };
        const count = Number.isInteger(mark.timeoutHinted) ? mark.timeoutHinted : 0;
        if (count >= 2)
            return null;
        mark.timeoutHinted = count + 1;
        mark.at = new Date().toISOString();
        marks.sessions[sessionId] = mark;
        await saveMarks();
        return '【浏览器插件】这次是**命令超时**，不等于"页面没内容"。浏览器 chrome 自己的权限气泡'
            + '（最典型：页面访问 127.0.0.1 时的「本地网络访问」）扩展**看不见也答不了**，只会表现成超时。\n'
            + '先调 browser_permissions（常驻、只读）看当前 origin 的权限态与挂起请求：'
            + '若是权限气泡，让用户本人点；或改成不 await 本机地址的取数方式（fire-and-forget）。';
    }
    /** 插件来源的一次性上下文消息（形状与宿主 createUserMessage 一致）。 */
    function pluginContextMessage(text) {
        return {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            // 会话格式 v4 废弃了共享的裸 `kind: 'plugin'`（v3→v4 转换表：非一方插件一律
            // 变 `plugin:<完整原名>`）。发裸 kind 会被持久化门禁拒收，而拒收的整批事件会留
            // 在写入缓冲里被无限重试 —— 该会话从此每轮报错，直到重启进程。按契约直接发。
            source: { kind: 'plugin:browser-buddy', plugin: 'browser-buddy' },
        };
    }
    /** 把摘要并进 post-execute 的决策（accept/block 两种都支持）。 */
    function attachContext(decision, text) {
        const message = pluginContextMessage(text);
        if (decision && decision.kind === 'accept') {
            return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), message] };
        }
        if (decision && decision.kind === 'block') {
            return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), message] };
        }
        return decision;
    }
    /** 从一次工具结果里抽出可读文本（失败消息 + 文本块），供命中判定。 */
    function resultText(result) {
        const parts = [];
        if (result && result.error && typeof result.error.message === 'string')
            parts.push(result.error.message);
        const blocks = result && Array.isArray(result.content) ? result.content : [];
        for (const block of blocks) {
            if (block && block.type === 'text' && typeof block.text === 'string')
                parts.push(block.text);
        }
        return parts.join('\n');
    }
    /* --------------------------------------------------------------- status text */
    function statusText() {
        const p = state.probe;
        const link = p === null
            ? '尚未探测'
            : p.port === null
                ? `${state.probeError ?? '没找到桥'}`
                : `端口 ${p.port}，扩展${p.extensionConnected ? '已连接' : '未连接'}`
                    + (p.extensionVersion ? `（扩展版本 ${p.extensionVersion}）` : '');
        const layer = cfg.layeredTools
            ? `开（常驻 ${resident.size} 个${state.hidden === null ? '' : `，本轮隐藏 ${state.hidden} 个`}`
                + `${state.enabledGroups.length > 0 ? `，已展开 ${state.enabledGroups.join('/')}` : ''}）`
            : `关（browser_* 全量暴露；当前装配到 ${state.assembled === null ? '未知' : state.assembled} 个工具）`;
        const auto = cfg.autoLaunchOnToolUse
            ? `开（拦到的 browser_* 调用 ${state.preExecuteChecks} 次，已唤醒 ${state.wakes} 次）`
            : '关';
        const lines = [
            `[browser-bridge] 桥：${link}`,
            `[browser-bridge] 工具面分层：${layer}`,
            `[browser-bridge] 调用即自动拉起：${auto}`,
            `[browser-bridge] 约定：需要点击/输入 → 调 browser_tools enable interact；需要导航/标签页 → enable session；需要 eval/网络/截图 PDF → enable debug。未展开的组对模型不可见。`,
        ];
        if (cfg.autoLaunchOnToolUse)
            lines.push(`[browser-bridge] 唤醒目标（来自「浏览器插件」分区）：${wakeTargetText()}`);
        if (!bridgeEnabled())
            lines.unshift('[browser-bridge] 浏览器桥当前已停用（「浏览器插件」分区里的开关）。');
        return lines.join('\n');
    }
    /* ------------------------------------------------------- extension point ① */
    // 工具面分层：装配 waterfall 的返回值是权威的 ⇒ 在 next() 之后替换 tools。
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
        const result = await next();
        try {
            const list = Array.isArray(result.tools) ? result.tools : [];
            state.assembled = list.length;
            if (!cfg.layeredTools) {
                state.hidden = 0;
                return result;
            }
            const allow = allowedTools();
            const readOnly = cfg.readOnly === true;
            const noScript = cfg.allowScript === false;
            const SCRIPT_TOOLS = new Set(['browser_evaluate', 'browser_frame_eval']);
            const kept = [];
            let hidden = 0;
            for (const schema of list) {
                const toolName = schema && typeof schema.name === 'string' ? schema.name : '';
                if (noScript && SCRIPT_TOOLS.has(toolName)) {
                    hidden += 1;
                    continue;
                }
                if (readOnly && toolName.startsWith('browser_') && !READ_ONLY_TOOLS.has(toolName)) {
                    hidden += 1;
                    continue;
                }
                if (toolName.startsWith('browser_') && !allow.has(toolName)) {
                    hidden += 1;
                    continue;
                }
                kept.push(schema);
            }
            state.hidden = hidden;
            if (hidden === 0)
                return result;
            return { ...result, tools: kept };
        }
        catch (error) {
            state.lastError = `装配钩子失败：${error instanceof Error ? error.message : String(error)}`;
            return result;
        }
    });
    /* ------------------------------------------------------- extension point ② */
    // 调用即自动拉起：dispatch 前的 waterfall；把桥状态探一次，必要时先唤起再放行。
    ctx.on('tools/pre-execute', async (exec, next) => {
        try {
            const toolName = exec && typeof exec.name === 'string' ? exec.name : '';
            if (toolName.startsWith('browser_')) {
                state.preExecuteChecks += 1;
                state.lastPreExecuteName = toolName;
                const probe = await probeBridge(false);
                if (cfg.autoLaunchOnToolUse && !probe.extensionConnected) {
                    const note = await wakeBrowser(toolName, wakeLandingUrlOf(exec));
                    state.lastWakeNote = note;
                    // 唤醒回执要送到模型/用户眼前（2026-10-10：以前唤醒了没有任何回执，
                    // 桌面上自己冒出一个窗口谁也不知道为什么）。等 post-execute 挂一次即止。
                    if (note.startsWith('已唤醒'))
                        state.wakeNotePending = note;
                    // 唤起之后**等它连上**再放行（默认 8s）——否则第一次调用照样会因为"扩展还没连上"而失败，
                    // "调用即自动拉起"就成了假承诺。
                    if (note.startsWith('已唤醒') && cfg.autoLaunchWaitMs > 0) {
                        const deadline = Date.now() + cfg.autoLaunchWaitMs;
                        while (Date.now() < deadline) {
                            await new Promise((resolve) => setTimeout(resolve, 500));
                            const again = await probeBridge(true);
                            if (again.extensionConnected) {
                                state.lastWakeNote = `${note}；等候 ${Math.round((cfg.autoLaunchWaitMs - (deadline - Date.now())) / 1000)}s 后扩展已连上`;
                                break;
                            }
                        }
                    }
                }
            }
        }
        catch (error) {
            state.lastError = `pre-execute 钩子失败：${error instanceof Error ? error.message : String(error)}`;
        }
        return next();
    });
    /**
     * 送达「调用时问题登记簿」（第二部分注册表）。规则（用户定稿）：
     *  **问题列表与本会话上次调用相比有变化**时才给摘要（首次=没有基准，也算有变化）；
     *  每次调用都更新指纹；`browser_issues` 自己的调用只静默刷新（模型正在看内容，不必再推）；
     *  撞上登记簿里没有的失败时，追加一句「先查绕行、可提 issue」的可行动提示。
     */
    ctx.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next();
        try {
            const name = exec && typeof exec.name === 'string' ? exec.name : '';
            if (!name.startsWith('browser_'))
                return decision;
            const sessionId = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : '';
            if (sessionId.length === 0)
                return decision;
            // 唤醒回执：本次调用前如果自动拉起了浏览器，先把这件事说清楚（一次即止）——
            // 桌面自己冒出一个窗口，模型和用户都该知道是"调用即自动拉起"干的、落在哪个网址。
            const wakeNote = typeof state.wakeNotePending === 'string' && state.wakeNotePending.length > 0
                ? `【浏览器插件】本次调用前**自动唤起了浏览器**（因为装扩展的那个配置文件当时没有窗口）：${state.wakeNotePending}`
                : '';
            if (wakeNote.length > 0)
                state.wakeNotePending = '';
            const issues = await loadIssues();
            if (issues === null)
                return wakeNote.length > 0 ? attachContext(decision, wakeNote) : decision;
            const matched = await noteIssueHits(sessionId, resultText(result), issues);
            if (name === 'browser_issues') {
                await refreshIssuesSnapshot(sessionId, issues);
                return decision;
            }
            let version = '';
            try {
                if (bridge !== null && typeof bridge.version === 'function')
                    version = String(await bridge.version() ?? '');
            }
            catch { /* 版本拿不到就当空 */ }
            const digest = await evaluateIssuesContext(sessionId, issues, version);
            // 失败且登记簿里没有这个症状时，单独也给一句可行动提示（自带去重）；
            // 首次调用会同时拿到摘要与提示 —— 那次本来就该把「已知问题 + 怎么绕 + 可提 issue」讲全。
            const hint = await maybeNovelIssueHint(sessionId, result, matched);
            const timeoutHint = await maybeTimeoutHint(sessionId, result);
            const text = [wakeNote, digest, hint, timeoutHint].filter((part) => typeof part === 'string' && part.length > 0).join('\n\n');
            return text.length > 0 ? attachContext(decision, text) : decision;
        }
        catch (error) {
            state.lastError = `问题摘要钩子失败：${error instanceof Error ? error.message : String(error)}`;
            return decision;
        }
    });
    /* --------------------------------------------------------- extension point ③ */
    // 状态注入：按轮次求值，模型不用调工具就能知道浏览器侧状态与调用约定。
    ctx.effect(() => ctx.systemPrompt.context({
        name: 'tool:browser-bridge',
        order: 117,
        text: () => statusText(),
    }), 'browser-bridge: state context');
    /* ------------------------------------------------------------------- tools */
    ctx.tools.register({
        name: 'browser_tools',
        description: '浏览器工具面开关、桥状态与 JS 对话框策略：action=list 看当前常驻/已展开的 browser_* 工具；'
            + 'action=enable 配合 group（interact|debug|session|frames|registry）展开一组，展开后这些工具才会进入后续步骤的工具面；'
            + 'action=disable 收起一组；action=status 看桥端口/扩展连接/分层与自动拉起状态；action=probe 重新探测桥端口；'
            + 'action=auto_launch 配合 value 开关「调用即自动拉起」（唤醒目标沿用「浏览器插件」分区的自动拉起配置）；'
            + 'action=dialog 查看/设置 JS 对话框策略（policy=accept|dismiss|manual，persist=true 写进扩展持久偏好），'
            + '或 answer=accept|dismiss 回答**当前已打开**的对话框（manual 档页面卡死时唯一的退路）。'
            + '常驻只读工具（read/snapshot/screenshot）无需展开即可用。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: { type: 'string', description: 'list | enable | disable | status | probe | auto_launch | dialog' },
                group: { type: 'string', description: 'enable/disable 时的组名：interact | debug | session | frames | registry' },
                value: { type: 'boolean', description: 'auto_launch 的目标值' },
                policy: { type: 'string', description: 'dialog 用：accept | dismiss | manual' },
                persist: { type: 'boolean', description: 'dialog 用：true=写进扩展的持久偏好（默认只改本次运行）' },
                answer: { type: 'string', description: 'dialog 用：accept | dismiss —— 回答当前已打开的对话框' },
                tabId: { type: 'number', description: 'dialog answer 的目标标签页（省略则用最近一次对话框记录的那个）' },
            },
            required: [],
        },
        output: { schema: OUTPUT_SCHEMA, render: renderText },
        timeoutMs: 30_000,
        isConcurrencySafe: () => false,
        async execute(args) {
            const action = args && typeof args.action === 'string' ? args.action : 'list';
            const group = args && typeof args.group === 'string' ? args.group : '';
            if (action === 'list' || action === 'status') {
                const known = Object.keys(cfg.groups);
                const rows = known.map((g) => {
                    const names = cfg.groups[g];
                    const on = names.filter((n) => allowedTools().has(n));
                    const mark = on.length === 0 ? '未展开' : on.length === names.length ? '已展开' : '部分展开';
                    return `- ${g}: [${names.join(', ')}] → ${mark}`;
                });
                const extra = action === 'status'
                    ? `\n常驻白名单：${[...resident].join(', ')}\n本轮装配 ${state.assembled ?? '?'} 个工具、隐藏 ${state.hidden ?? '?'} 个；拦截计数 ${state.preExecuteChecks}`
                    : '';
                return { ok: true, text: `${statusText()}\n分组：\n${rows.join('\n')}${extra}` };
            }
            if (action === 'enable' || action === 'disable') {
                if (!Object.prototype.hasOwnProperty.call(cfg.groups, group)) {
                    return { ok: false, text: `未知分组：${group}（可用：${Object.keys(cfg.groups).join(' | ')}）` };
                }
                const has = state.enabledGroups.includes(group);
                if (action === 'enable' && !has)
                    state.enabledGroups.push(group);
                if (action === 'disable' && has)
                    state.enabledGroups = state.enabledGroups.filter((g) => g !== group);
                const note = await persist({ enabledGroups: state.enabledGroups });
                return {
                    ok: true,
                    text: `分组 ${group} 已${action === 'enable' ? '展开' : '收起'}：`
                        + `${action === 'enable' ? `[${cfg.groups[group].join(', ')}] 将在后续步骤进入工具面` : '后续步骤不再提供该组工具'}${note}`,
                };
            }
            if (action === 'probe') {
                const p = await probeBridge(true);
                return { ok: true, text: `探测结果：${JSON.stringify(p)}${state.probeError ? `（${state.probeError}）` : ''}` };
            }
            if (action === 'dialog') {
                const params = {};
                if (args && args.policy !== undefined)
                    params.policy = String(args.policy);
                if (args && args.persist === true)
                    params.persist = true;
                if (args && args.answer !== undefined)
                    params.answer = String(args.answer);
                if (args && args.tabId !== undefined)
                    params.tabId = Number(args.tabId);
                const r = await bridgeCommand('dialog', params);
                const note = r.answered ? `\n本次已回答：标签页 ${r.answered.tabId} → ${r.answered.as}` : '';
                const recent = (r.recent ?? []).slice(-5)
                    .map((e) => `  ${new Date(e.t).toLocaleTimeString()} ${e.type} → ${e.answeredAs}${e.message ? ' ' + JSON.stringify(e.message).slice(0, 50) : ''}`)
                    .join('\n');
                const guide = r.policy === 'manual'
                    ? '\n注意：manual 档下页面会停在对话框上（桥的其它命令会超时）；用 answer=accept|dismiss 解卡，或关掉该标签页。'
                    : '';
                return { ok: true, text: `JS 对话框策略 = ${r.policy}${note}${guide}\n最近记录：\n${recent || '  （暂无）'}` };
            }
            if (action === 'auto_launch') {
                cfg.autoLaunchOnToolUse = args.value === true;
                const note = await persist({ autoLaunchOnToolUse: cfg.autoLaunchOnToolUse });
                return {
                    ok: true,
                    text: `调用即自动拉起 = ${cfg.autoLaunchOnToolUse ? '开' : '关'}${note}`
                        + (cfg.autoLaunchOnToolUse
                            ? `（唤醒目标沿用「浏览器插件」分区：${wakeTargetText()}；冷却 ${cfg.autoLaunchCooldownMs / 1000}s）`
                            : ''),
                };
            }
            return { ok: false, text: `未知 action：${action}（可用：list | enable | disable | status | probe | auto_launch）` };
        },
    });
    /* ------------------------------------------------------------- frame tools */
    // 老式管理页（路由器/光猫/交换机）大量用 <frameset>。宿主 browser_read 从 0.8.0 起已能
    // 拍平同源子帧、并用 `frame` 指定单帧，所以这里只留宿主没有的两件：**列帧结构** 与 **在帧里求值**。
    ctx.tools.register({
        name: 'browser_frames',
        description: '列出标签页的 frame 结构（老式 frameset 管理页必用）：每个 frame 的 index / name / src / url / 是否同源，并附一段文本预览。'
            + '当 browser_read 只返回标题+URL（frameset 页面读不动）时，先调本工具看结构，再用 browser_frame_read 指定 frame 取正文。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { tabId: { type: 'number', description: '目标标签页；省略=当前激活页' } },
            required: [],
        },
        output: { schema: OUTPUT_SCHEMA, render: renderText },
        timeoutMs: 30_000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            if (authorizeTab !== null)
                await authorizeTab(args && args.tabId, exec && exec.signal);
            const r = await bridgeCommand('frames', args && args.tabId !== undefined ? { tabId: args.tabId } : {});
            const lines = [
                `${r.title || '(无标题)'} — ${r.url || ''}`,
                `isFrameset=${r.isFrameset === true} hasBody=${r.hasBody === true} 共 ${r.count ?? 0} 个 frame`,
            ];
            for (const f of r.frames ?? []) {
                lines.push(`  #${f.index} name=${f.name || '-'} ${f.sameOrigin ? '同源' : '跨域'} ${f.url || f.src || ''}`);
                if (f.textPreview)
                    lines.push(`      预览: ${f.textPreview}`);
            }
            if ((r.count ?? 0) === 0)
                lines.push('  （没有子 frame）');
            return { ok: true, text: lines.join('\n') };
        },
    });
    ctx.tools.register({
        name: 'browser_frame_eval',
        description: '在指定 frame 的 document/window 作用域里执行 JS（老管理页的表格/字段数据常只在某个 frame 内）。'
            + '默认预算 15s（宿主自带的 browser_evaluate 早期默认只有 100ms，几乎必超时），可用 timeoutMs 覆盖。',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                frame: { type: 'string', description: 'frame 的 name、#序号 或 url 子串' },
                expression: { type: 'string', description: '要执行的 JS 表达式' },
                timeoutMs: { type: 'number', description: '求值预算，默认 15000ms' },
                tabId: { type: 'number' },
            },
            required: ['frame', 'expression'],
        },
        output: { schema: OUTPUT_SCHEMA, render: renderText },
        timeoutMs: 40_000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            if (authorizeTab !== null)
                await authorizeTab(args && args.tabId, exec && exec.signal);
            let r;
            try {
                r = await bridgeCommand('eval', {
                    frame: String(args.frame),
                    expression: String(args.expression),
                    ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
                    ...(args.tabId === undefined ? {} : { tabId: args.tabId }),
                });
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                // 「frame not found: main（候选：）」= 这个标签页根本没有子 frame。
                // 那是常见困惑点（顶层文档没有"帧"可指），直接给出正确工具，别让模型在错误里打转。
                if (msg.includes('frame not found')) {
                    return { ok: false, text: `${msg}\n（该标签页没有子 frame：顶层文档请用 browser_evaluate —— 它在 debug 组，先 browser_tools enable debug）` };
                }
                throw error;
            }
            const text = typeof r === 'string' ? r : JSON.stringify(r);
            return { ok: true, text: text.length > 20_000 ? `${text.slice(0, 20_000)}…（已截断）` : text };
        },
    });
    ctx.logger?.info?.(`[browser-bridge] buddy features applied: layered=${cfg.layeredTools}, resident=${resident.size}, groups=${Object.keys(cfg.groups).join(',')}, autoLaunchOnToolUse=${cfg.autoLaunchOnToolUse}`);
    return { state, cfg, allowedTools, probeBridge, wakeBrowser, bridgeCommand, refreshConfig, getCfg: () => cfg };
}
