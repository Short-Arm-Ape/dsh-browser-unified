/**
 * errors.ts — 工具调用失败时的结构化契约。
 *
 * 来源：**移植自 `@caob23/dsh-browser-control` v1.0.13 的 `src/errors.ts`**（AGPL-3.0，
 * 本包同许可；见仓库根 NOTICE.md 的归属矩阵）。差异只在三处本地化：写命令集合按**我们的**
 * 扩展命令表列、`hint` 指到**我们**的配置位置（GUI「浏览器」分区）与我们的扩展名、
 * 并补了 `tabs.closeMany` 的前向兼容位。
 *
 * Agent 拿到一句 `Error("...")` 文本时，其实无法决定下一步：该重试、该放弃、还是该先
 * 去确认页面状态？真正需要区分的是两件事——
 *
 *   1. `code`：失败的可分类原因（链路没起、扩展没连、超时、扩展报错……）
 *   2. `effectState`：这次调用的副作用**是否可能已经落到页面上**
 *
 * 第二条是重点：`click` 超时和"扩展中途断开"都属于**结果未知** —— 鼠标事件也许已经发出去了。
 * 这时让 agent 盲目重试，就会点两次、提交两次表单。所以对写操作，我们宁可报 `unknown`
 * 并要求它先观察，也不假装"没发生"。读操作不改变页面，任何失败都是 `not_started`，重试安全。
 */
/**
 * 会改变页面或不可逆地改变浏览器状态的扩展命令；其余按只读处理。
 *
 * 判据是「重试会不会造成额外损害」，不是「有没有动到浏览器」。所以
 * `tabs.group` / `tabs.ungroup` 不在表里：把已经在组里的标签再归一次是空操作，重试安全；
 * `window.ensure` 也不在：它幂等（没窗口就建一个）。而 `tabs.open` 重试会多出标签页、
 * `tabs.close` 重试可能关掉用户正在看的页面，必须报 unknown。
 *
 * `tabs.closeMany` 是**前向兼容位** —— 我们的扩展目前没有这条命令（它是我们提给上游的
 * PR #11 引入的），写上不会有害：只有真的发这条命令时才用得到。
 */
const WRITE_COMMANDS = new Set([
    'nav', 'click', 'input', 'press', 'scroll', 'eval', 'emulate',
    'tabs.open', 'tabs.close', 'tabs.closeMany', 'tabs.activate', 'dialog',
]);
/** 该命令是否可能留下副作用。 */
export function isWriteCommand(command) {
    return WRITE_COMMANDS.has(command);
}
/** 每个 code 对应的下一步建议（写给 agent，不是写给用户看的日志）。 */
const HINTS = {
    bridge_disabled: '桥接未启用或没起来：到 dsh 设置 →「浏览器」分区把开关打开（或 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true）后重启 dsh；不要重试本命令。若状态里带 listen EADDR，是端口被占 —— 换个 port 即可。',
    extension_offline: '浏览器扩展没连上：让用户打开装了 DSH Browser Control 的那个浏览器（扩展图标应为绿色），确认端口与令牌两边一致后再试。',
    command_timeout: '扩展超时未回应：先别重试。用 browser_find / browser_snapshot 看页面当前状态，判断动作是否其实已经生效。',
    link_lost: '命令在途时链路断了：动作可能已经落到页面上。先用只读工具确认页面状态，再决定是否重做。',
    cancelled: '调用被取消：按需重新发起，不必当作错误处理。',
    not_configured: '插件还没读到配置：确认 dsh 已加载本插件（dsh plugin list / dsh --profile web --dump-config）后再试。',
    policy_blocked: '目标被 URL 策略拦下了：这是插件的策略决定，不是页面错误，重试同一目标不会有不同结果。要么改用允许的目标，要么让用户在设置 →「浏览器」分区调整 urlMode / allowHosts；人机校验、反机器人挑战类目标一律交回真人。',
    command_failed: '扩展报回失败：按 error 文本处理，通常是选择器没命中、标签页已关闭或页面不允许该操作。',
};
/**
 * 失败文案里「该不该重试」那半句。
 *
 * 宿主的失败内容是 `Error: ${message}`，`code` / `effectState` / `hint` 这些结构化字段
 * 只进 `error.info` 与 HTTP 面，**模型读不到**。所以决定下一步所需的两个信息 ——
 * 副作用状态与下一步动作 —— 必须写进 message 本身，否则整个错误契约对 agent 失效
 * （和「render 只写摘要」是同一类缺陷）。
 */
function effectClause(effectState) {
    switch (effectState) {
        case 'unknown':
            return 'effectState=unknown：动作可能已经落到页面上，先用只读工具看当前状态，再决定要不要重做，不要直接重试';
        case 'committed':
            return 'effectState=committed：动作已经生效';
        default:
            return 'effectState=not_started：这次调用没有动到页面，重试安全';
    }
}
/** 带分类的桥接错误；`message` 面向模型，`toJSON()` 面向程序。 */
export class BridgeError extends Error {
    code;
    effectState;
    hint;
    command;
    /** 原始失败描述：HTTP 面的 `error` 字段就是它，不含我们追加的契约文案。 */
    detail;
    constructor(command, code, effectState, message) {
        super(`[${code}] ${message} — ${effectClause(effectState)}。下一步：${HINTS[code]}`);
        this.name = 'BridgeError';
        this.code = code;
        this.effectState = effectState;
        this.hint = HINTS[code];
        this.command = command;
        this.detail = message;
    }
    /** 给 HTTP 面用的扁平 JSON 形状。 */
    toJSON() {
        return {
            ok: false,
            error: this.detail,
            code: this.code,
            effectState: this.effectState,
            hint: this.hint,
        };
    }
}
/**
 * 把任意底层抛出的错误归类成 BridgeError。已经分类过的原样返回，
 * 保证多次包裹（core 的桥 → 插件壳）不会把 code 洗掉。
 */
export function classify(command, error) {
    if (error instanceof BridgeError)
        return error;
    const message = error instanceof Error ? error.message : String(error);
    // 策略拦截发生在命令**发出之前**（GuardedBridge 先过 UrlPolicy），所以"没动到页面"是确定的：
    // 不能按写操作一律报 unknown，否则模型会对一个根本没发生的动作白等一轮。
    const isPolicy = error?.name === 'UrlPolicyError';
    if (isPolicy)
        return new BridgeError(command, 'policy_blocked', 'not_started', message);
    // 写操作一旦超时或掉线，结果就是未知的；读操作永远可以安全重试。
    const unknownIsPossible = isWriteCommand(command);
    let code;
    if (/no browser extension connected/.test(message))
        code = 'extension_offline';
    else if (/disconnected mid-command|browser-bridge stopped/.test(message))
        code = 'link_lost';
    else if (/timed out after/.test(message))
        code = 'command_timeout';
    else if (/cancelled/.test(message))
        code = 'cancelled';
    else if (/尚未加载配置|not configured yet/.test(message))
        code = 'not_configured';
    else if (/未启用|not enabled|桥接启动失败|listen EADDR|settings integration/.test(message))
        code = 'bridge_disabled';
    else
        code = 'command_failed';
    const effectState = code === 'command_timeout' || code === 'link_lost'
        ? (unknownIsPossible ? 'unknown' : 'not_started')
        : code === 'command_failed'
            ? (unknownIsPossible ? 'unknown' : 'not_started')
            : 'not_started';
    return new BridgeError(command, code, effectState, message);
}
