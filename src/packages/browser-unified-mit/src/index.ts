/**
 * dsh-browser-unified-mit — plugin entry (MIT edition).
 *
 * Registers the self-update / design-registry tools and re-exports the pure
 * unified logic modules (URL policy, approval gate, instance registry,
 * self-update report builder) as a library. No caob23-derived code is
 * included — this edition carries no browser bridge and no browser driver
 * tools. License: MIT (see NOTICE.md).
 */

import type { Context } from '@deepseek-ai/cordis'
import { applyUnifiedTools } from './tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-unified-mit'

/** The tool registry this plugin contributes self-update / design tools to. */
export const inject = ['tools']

export interface Config {
	/**
	 * Absolute directory containing `design/registry.json` and
	 * `upstream-baseline.json` for the self-update tools. Empty (default) means
	 * the copies bundled under the package `registry/` directory.
	 */
	registryDir?: string
}

/** Cordis plugin entry: register the three tools (read-only pair + approval-gated writer). */
export function apply(ctx: Context, config: Config): void {
	const registryDir = typeof config?.registryDir === 'string' ? config.registryDir : ''
	applyUnifiedTools(ctx, { registryDir })
}

// Library surface: the pure, dependency-free logic modules.
export * from './url-policy.js'
export * from './approval.js'
export * from './instance.js'
export * from './self-update/registry.js'
export * from './self-update/check.js'
