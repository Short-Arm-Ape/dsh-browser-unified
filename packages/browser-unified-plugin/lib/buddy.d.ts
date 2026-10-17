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
/** 合并进插件后的旋钮默认值（原先由本包自己的 Config schema 提供；现在声明在插件 schema 里）。 */
export declare const BUDDY_DEFAULTS: {
    layeredTools: boolean;
    autoLaunchOnToolUse: boolean;
    autoLaunchWaitMs: number;
    enabledGroups: any[];
};
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
export declare function applyBuddyFeatures(options: any): {
    state: {
        enabledGroups: string[];
        probe: any;
        probeAt: number;
        probeError: any;
        preExecuteChecks: number;
        lastPreExecuteName: any;
        wakes: number;
        lastWakeAt: number;
        lastWakeNote: any;
        assembled: any;
        hidden: any;
        lastError: any;
        /** 会话问题标记（懒加载 + 缓存；持久化在 $DSH_HOME/browser-buddy/session-issues.json）。 */
        marks: any;
        /** 一次性唤醒回执（下次工具结果后注入一次；由 tools/post-execute 取走）。 */
        wakeNotePending: any;
    };
    cfg: {
        layeredTools: boolean;
        scanBase: any;
        scanCount: any;
        autoLaunchOnToolUse: boolean;
        autoLaunchCooldownMs: any;
        autoLaunchWaitMs: any;
        residentTools: string[];
        groups: any;
        bridgeCommandTimeoutMs: any;
        readOnly: boolean;
        allowScript: boolean;
    };
    allowedTools: () => Set<string>;
    probeBridge: (force?: boolean) => Promise<any>;
    wakeBrowser: (trigger: any, landingUrl: any) => Promise<any>;
    bridgeCommand: (command: any, params: any) => Promise<any>;
    refreshConfig: (raw: any) => void;
    getCfg: () => {
        layeredTools: boolean;
        scanBase: any;
        scanCount: any;
        autoLaunchOnToolUse: boolean;
        autoLaunchCooldownMs: any;
        autoLaunchWaitMs: any;
        residentTools: string[];
        groups: any;
        bridgeCommandTimeoutMs: any;
        readOnly: boolean;
        allowScript: boolean;
    };
};
