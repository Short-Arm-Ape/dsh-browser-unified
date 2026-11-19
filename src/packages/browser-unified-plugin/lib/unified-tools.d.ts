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
 * browser-unified-plugin, AGPL-3.0 (see NOTICE.md).
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * 读问题登记簿。读失败（文件缺失/坏 JSON）返回空表而不是抛：它只是提示来源，
 * 不该让任何一次工具调用因为登记簿读不出来而失败。
 */
export declare function loadIssues(configuredRegistryDir: string): Promise<{
    dir: string;
    file: string;
    issues: Record<string, unknown>[];
}>;
/** 插件自身版本（登记簿的 fixedIn 默认值）；读不到就写「未标注」。 */
export declare function currentPluginVersion(configuredRegistryDir: string): Promise<string>;
/**
 * 这次 git 失败该不该"关掉 TLS 校验重试"（X19）。
 * 抽成导出函数是为了能被离线测试钉住：**只有证书/CA 类**才允许回退；
 * 代理抖动、DNS、超时等一律如实报错（否则等于给中间人留了伪造 HEAD 的窗口）。
 */
export declare function shouldRetryInsecureGit(detail: string): boolean;
export declare function applyUnifiedTools(ctx: Context, config: {
    registryDir: string;
}): void;
