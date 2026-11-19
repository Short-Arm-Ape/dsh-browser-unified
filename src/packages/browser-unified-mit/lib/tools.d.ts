/**
 * dsh-browser-unified-mit — MIT-licensed release (contains no caob23-derived code).
 * Relicensed MIT by the repository authors; upstream (MIT) attribution of distilled
 * semantics is in NOTICE.md. License: MIT.
 */
/**
 * unified-tools — the dsh-browser-unified self-update + design-registry tools.
 *
 * Registers three model-facing tools beside the bridge's `browser_*` set:
 *   - browser_check_update    read-only upstream-drift probe (git ls-remote vs baseline)
 *   - browser_design_show     read-only digest of design/registry.json
 *   - browser_design_edit     approval-gated writer over design/registry.json
 *
 * Data lives in the package `registry/` directory by default (or an absolute
 * `registryDir` override from settings): upstream-baseline.json (commit pins)
 * and design/registry.json (design entries / impactRules / authz policy).
 *
 * Derived from the design in `design/README.md` of the repository. Part of
 * browser-unified-plugin, MIT (see NOTICE.md).
 */
import type { Context } from '@deepseek-ai/cordis';
export declare function applyUnifiedTools(ctx: Context, config: {
    registryDir: string;
}): void;
