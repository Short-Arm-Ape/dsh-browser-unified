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

/** 失败原因分类。 */
export type BridgeErrorCode =
	| 'bridge_disabled'      // 桥接没在监听（配置里关掉了，或启动失败）
	| 'extension_offline'    // 桥在跑，但浏览器扩展没连上
	/** 预算用尽：桥等到扩展回话的时限，或扩展执行页内命令（`eval` / `wait`）的时限。 */
	| 'command_timeout'
	| 'link_lost'            // 命令在途时扩展掉线/链路被换掉
	| 'cancelled'            // 调用方主动取消（命令还没发出去）
	/** 命令**已经发出**、取消发生在路上：写操作的副作用可能已经落地（不能当"重试安全"）。 */
	| 'cancelled_in_flight'
	| 'not_configured'       // 还没拿到任何一份配置
	/** 【本仓库扩展】URL 策略在**发出命令之前**把目标拦下了（上游没有策略层，故无此码）。 */
	| 'policy_blocked'
	/** 用户按了浮层上的「中止操作」（上游 v1.0.19 起同码）：重试只会再被拦一次。 */
	| 'held_by_user'
	/** 浏览器窗口存在但没显示出来（几何 0×0）：输入无处可落，重试同一命令仍会失败。 */
	| 'window_not_shown'
	| 'command_failed';      // 扩展明确回了失败

/** 副作用状态。 */
export type EffectState =
	/** 确定没有副作用落到页面上，重试安全。 */
	| 'not_started'
	/** 无法判断（写操作超时、在途掉线、扩展中途报错），重试前应先观察。 */
	| 'unknown'
	/** 已确认执行完成（用于成功路径的显式标注，目前只在结果里出现）。 */
	| 'committed';

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
const WRITE_COMMANDS = new Set<string>([
	'nav', 'click', 'input', 'press', 'scroll', 'eval', 'emulate',
	'tabs.open', 'tabs.close', 'tabs.closeMany', 'tabs.activate', 'dialog',
	 // 浮层往页面里插 DOM：超时同样是"可能挂上去了"，不能当只读。
	'hold.on', 'hold.off',
]);

/**
 * 中止期间拒绝挂浮层时，扩展在错误文案前加的前缀（上游 v1.0.19 同前缀）。
 * 模型读到的是语气正常的说明，这个前缀只用来把失败归到 `held_by_user`。
 */
export const HOLD_ABORTED_MARKER = 'browser-hold-aborted:'

/** 窗口没显示出来（扩展探测到 outerWidth/outerHeight = 0）时的错误前缀。 */
export const WINDOW_NOT_SHOWN_MARKER = 'browser-window-not-shown:'

/** 该命令是否可能留下副作用。 */
export function isWriteCommand(command: string): boolean {
	return WRITE_COMMANDS.has(command)
}

/** 每个 code 对应的下一步建议（写给 agent，不是写给用户看的日志）。 */
const HINTS: Record<BridgeErrorCode, string> = {
	bridge_disabled: '桥接未启用或没起来：到 dsh 设置 →「浏览器」分区把开关打开（或 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true）后重启 dsh；不要重试本命令。若状态里带 listen EADDR，是端口被占 —— 换个 port 即可。',
	extension_offline: '浏览器扩展没连上：让用户打开装了 DSH Browser Control 的那个浏览器（扩展图标应为绿色），确认端口与令牌两边一致后再试。',
	command_timeout: '预算用尽没拿到结果：先别重试。用 browser_find / browser_snapshot 看页面当前状态，判断动作是否其实已经生效。若原始文案是页内的 `eval timeout after` / `wait timeout after`（预算用尽，不是链路问题），加大 timeoutMs 再试即可。',
	link_lost: '命令在途时链路断了：动作可能已经落到页面上。先用只读工具确认页面状态，再决定是否重做。',
	cancelled_in_flight: '这次调用在命令发出之后被取消（用户停止/会话中断），页面可能已经动过了。不要直接重发：先用只读工具确认当前状态，再决定是否重做。',
	cancelled: '调用被取消：按需重新发起，不必当作错误处理。',
	not_configured: '插件还没读到配置：确认 dsh 已加载本插件（dsh plugin list / dsh --profile web --dump-config）后再试。',
	policy_blocked: '目标被 URL 策略拦下了：这是插件的策略决定，不是页面错误，重试同一目标不会有不同结果。要么改用允许的目标，要么让用户在设置 →「浏览器」分区调整 urlMode / allowHosts；人机校验、反机器人挑战类目标一律交回真人。',
	held_by_user: '用户按下了浮层上的「中止操作」，这个标签页现在拒收写操作。不要重试、也不要换命令绕：先向用户说明并询问是否继续；用户同意后调用 browser_hold action=off（这一步等于确认继续），再继续原来的事。',
	window_not_shown: '浏览器窗口存在但没有显示出来（几何 0×0），真实输入落不到页面上。这不是页面问题：让用户把浏览器窗口切出来（或检查自动拉起是不是只建了隐藏窗口）后再重试；读取类工具照常可用。',
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
function effectClause(effectState: EffectState): string {
	switch (effectState) {
		case 'unknown':
			return 'effectState=unknown：动作可能已经落到页面上，先用只读工具看当前状态，再决定要不要重做，不要直接重试'
		case 'committed':
			return 'effectState=committed：动作已经生效'
		default:
			return 'effectState=not_started：这次调用没有动到页面，重试安全'
	}
}

/** 带分类的桥接错误；`message` 面向模型，`toJSON()` 面向程序。 */
export class BridgeError extends Error {
	readonly code: BridgeErrorCode
	readonly effectState: EffectState
	readonly hint: string
	readonly command: string
	/** 原始失败描述：HTTP 面的 `error` 字段就是它，不含我们追加的契约文案。 */
	readonly detail: string

	constructor(command: string, code: BridgeErrorCode, effectState: EffectState, message: string) {
		super(`[${code}] ${message} — ${effectClause(effectState)}。下一步：${HINTS[code]}`)
		this.name = 'BridgeError'
		this.code = code
		this.effectState = effectState
		this.hint = HINTS[code]
		this.command = command
		this.detail = message
	}

	/** 给 HTTP 面用的扁平 JSON 形状。 */
	toJSON(): { ok: false; error: string; code: string; effectState: string; hint: string } {
		return {
			ok: false,
			error: this.detail,
			code: this.code,
			effectState: this.effectState,
			hint: this.hint,
		}
	}
}

/**
 * 把任意底层抛出的错误归类成 BridgeError。已经分类过的原样返回，
 * 保证多次包裹（core 的桥 → 插件壳）不会把 code 洗掉。
 */
export function classify(command: string, error: unknown): BridgeError {
	if (error instanceof BridgeError) return error
	const message = error instanceof Error ? error.message : String(error)
	// 策略拦截发生在命令**发出之前**（GuardedBridge 先过 UrlPolicy），所以"没动到页面"是确定的：
	// 不能按写操作一律报 unknown，否则模型会对一个根本没发生的动作白等一轮。
	const isPolicy = (error as { name?: string } | null)?.name === 'UrlPolicyError'
	if (isPolicy) return new BridgeError(command, 'policy_blocked', 'not_started', message)
	// 写操作一旦超时或掉线，结果就是未知的；读操作永远可以安全重试。
	const unknownIsPossible = isWriteCommand(command)
	// 用户中止：被拦的是"这次调用"本身，页面没被动过 —— 归成 held_by_user，别让模型当普通失败重试。
	const aborted = message.indexOf(HOLD_ABORTED_MARKER) >= 0 || /用户终止控制/.test(message)
	const notShown = message.indexOf(WINDOW_NOT_SHOWN_MARKER) >= 0
	const detail = aborted
		? message.split(HOLD_ABORTED_MARKER).join('').trim()
		: notShown ? message.split(WINDOW_NOT_SHOWN_MARKER).join('').trim() : message
	let code: BridgeErrorCode
	if (aborted) code = 'held_by_user'
	else if (notShown) code = 'window_not_shown'
	else if (/no browser extension connected/.test(message)) code = 'extension_offline'
	else if (/disconnected mid-command|browser-bridge stopped/.test(message)) code = 'link_lost'
	// 桥自己的文案是 `browser command timed out after Nms`，扩展页内的文案是
	// `eval timeout after Nms` / `wait timeout after Nms` —— 两种都算预算用尽。
	// 以前只认前者 ⇒ 扩展侧超时被归成 command_failed（"扩展明确回了失败"），
	// 模型据此以为命令没成功而重试，写操作就可能点两次。
	else if (/time[do]?[ -]?out after/i.test(message)) code = 'command_timeout'
	else if (/cancelled while in flight|in flight/i.test(message)) code = 'cancelled_in_flight'
	else if (/cancelled/.test(message)) code = 'cancelled'
	else if (/尚未加载配置|not configured yet/.test(message)) code = 'not_configured'
	else if (/未启用|not enabled|桥接启动失败|listen EADDR|settings integration/.test(message)) code = 'bridge_disabled'
	else code = 'command_failed'
	// `cancelled_in_flight` = 命令已经发给扩展、取消发生在路上（server.ts 用这个词报告在途取消）：
	// 对写操作来说副作用可能已经落地，报 not_started 会让模型"以为没生效"而重试，于是点两次/提交两次。
	const midFlight = code === 'cancelled_in_flight'
	const effectState: EffectState = code === 'command_timeout' || code === 'link_lost' || midFlight
		? (unknownIsPossible ? 'unknown' : 'not_started')
		: code === 'command_failed'
			? (unknownIsPossible ? 'unknown' : 'not_started')
			: 'not_started'
	return new BridgeError(command, code, effectState, detail)
}
