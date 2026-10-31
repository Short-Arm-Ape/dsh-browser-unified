/**
 * 导航等待口径的预算计算（插件侧）。
 *
 * 与扩展 `background.js` 的 `NAV_DEFAULT_BUDGET` 保持同值：扩展负责"等多久"的执行，
 * 插件负责把**同样的预算**告诉桥。为什么非要插件也算一遍 —— 桥有自己的命令超时（默认 60s），
 * 若导航预算比桥超时还长，先到的是桥，模型拿到的是 `command_timeout` 而不是"导航等待超时"，
 * 这两条错误的处置完全不同（前者结果未知，后者没动过页面）。
 *
 * 所以发命令时把「预算 + 余量」交给桥，让导航自己先超时、自己解释。
 */

/** 各等待口径的默认预算（毫秒），与扩展同值。 */
export const NAV_DEFAULT_BUDGET_MS = { none: 0, commit: 4_000, domcontentloaded: 4_000, load: 15_000 } as const

export type NavWaitMode = keyof typeof NAV_DEFAULT_BUDGET_MS

/** 桥侧余量：留给扩展回报结果与桥序列化；必须大于 0。 */
export const NAV_BRIDGE_MARGIN_MS = 2_000

/** 显式 `timeoutMs` 的允许上限（与工具参数的上限一致）。 */
export const NAV_MAX_BUDGET_MS = 120_000

/** 归一等待口径：认不出的值按默认 `load`（与上游行为一致）。 */
export function normalizeNavWaitMode(value: unknown): NavWaitMode {
	const text = String(value ?? '').toLowerCase()
	return text === 'none' || text === 'commit' || text === 'domcontentloaded' || text === 'load' ? text : 'load'
}

/** 导航等待预算：显式 `timeoutMs` 永远优先，否则按口径取默认值。 */
export function navWaitBudget(waitUntil: unknown, timeoutMs?: unknown): number {
	if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
		return Math.min(NAV_MAX_BUDGET_MS, Math.max(100, Math.trunc(timeoutMs)))
	}
	return NAV_DEFAULT_BUDGET_MS[normalizeNavWaitMode(waitUntil)]
}

/** 交给桥的命令等待上限：预算 + 余量（`none` 也要留出探针与回报的时间）。 */
export function navBridgeTimeout(waitUntil: unknown, timeoutMs?: unknown): number {
	return Math.max(NAV_BRIDGE_MARGIN_MS, navWaitBudget(waitUntil, timeoutMs) + NAV_BRIDGE_MARGIN_MS)
}

/**
 * 页内预算（`browser_wait` / `browser_evaluate` 的 `timeoutMs`）对应的桥等待上限。
 *
 * 和上面导航那笔是同一个道理：桥自己的命令超时是 60s，而这两个工具的页内预算上限是 120s。
 * 预算比桥还长时**先到的是桥** —— 模型拿到 `command_timeout`（"扩展超时未回应"），
 * 而真实原因只是"等得久、页面还没满足条件"。把这个预算交给桥，让页内自己先超时、自己解释。
 */
export function pageBridgeTimeout(budgetMs: number): number {
	const budget = Number.isFinite(budgetMs)
		? Math.min(NAV_MAX_BUDGET_MS, Math.max(100, Math.trunc(budgetMs)))
		: NAV_DEFAULT_BUDGET_MS.load
	return budget + NAV_BRIDGE_MARGIN_MS
}
