/**
 * offline-retry.ts — 「扩展还没连上」要不要再试一次。
 *
 * 为什么单独成文件、单独判：这条规则的红线不是"多试几次更好"，而是**只有确实没发出去**才能重试。
 * 判据在 core 里已经分得很清楚（`errors.ts:164-178`）：
 *
 *  - `extension_offline` 的唯一来源是 `server.ts:358` —— `clientSocket === undefined`，
 *    也就是**一个字节都还没发**。重试幂等，最坏是白等一轮；
 *  - 命令在路上掉线归 `link_lost`（写操作 `effectState=unknown`）。**绝不能重试**：
 *    那一次点击/提交可能已经落地，重来一次就是点两次、提交两次。
 *
 * 所以本模块只认 `extension_offline`，别的一律立刻放弃。任何"把重试放宽到 link_lost"的改动
 * 都是在拆这条线，改之前先读 `errors.ts` 里 `midFlight` 那段注释。
 *
 * @module
 */

/** 一次工具调用最多尝试几轮（1 轮首发 + N-1 轮重试）。 */
export const OFFLINE_RETRY_ROUNDS = 3

/** 两轮之间等多久。实测冷启到 hello 约 0.5 s（NOTE.md 21:23），所以 400 ms 的间隔够覆盖"差一点点"。 */
export const OFFLINE_RETRY_DELAY_MS = 400

export interface OfflineRetryInput {
	/** `classify()` 归出来的错误码。 */
	readonly code: string
	/** 已经试过的轮数（首发算第 1 轮）。 */
	readonly round: number
	/** 调用方是否已经中止。 */
	readonly aborted?: boolean
}

/**
 * 要不要再来一轮。
 *
 * @param input - 错误码 / 已试轮数 / 是否已中止。
 * @returns `true` 表示再等 `OFFLINE_RETRY_DELAY_MS` 试一轮。
 */
export function shouldRetryOffline(input: OfflineRetryInput): boolean {
	if (input.aborted === true) return false
	if (input.code !== 'extension_offline') return false
	return input.round < OFFLINE_RETRY_ROUNDS
}
