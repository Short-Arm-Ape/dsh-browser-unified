/**
 * Browser-bridge plugin: one local WebSocket endpoint the DSH Browser Control
 * extension connects to, plus the model-facing `browser_*` tools that drive
 * it. The Settings-managed `enabled` flag starts and stops the listener live
 * through dsh-settings' change hook — no reload needed.
 *
 * We deliberately bypass the higher-level `installSettingsSection` helper and
 * talk to the lower-level `sctx.settings.register` API directly: that API
 * predates the helper and is the one stable across every dsh-settings build a
 * consumer is realistically pinned to. Importing the helper on a build that
 * does not export it crashes the whole plugin at module load.
 *
 * Tools stay mounted whenever the plugin does; calling one while the bridge
 * is disabled or the extension is offline fails with a message naming the
 * fix, so the model can tell the user what to do instead of hanging.
 * @module @deepseek-ai/dsh-browser-bridge
 */
import { type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-bridge";
/** The tool registry this plugin contributes `browser_*` tools to. */
export declare const inject: string[];
/** Settings namespace carrying the bridge switch and endpoint options. */
export declare const BROWSER_BRIDGE_SETTINGS_NAMESPACE = "browser-bridge";
export interface Config {
    /**
     * Whether the local bridge listens. Defaults to true so the plugin is
     * usable immediately after install; set false to keep the tools mounted but
     * every call reports how to enable the bridge, so the opt-out stays explicit.
     */
    enabled?: boolean;
    /** Loopback port the extension dials; the HTTP face shares it. */
    port?: number;
    /** Shared secret the extension presents on the WebSocket upgrade query. */
    token?: string;
    /**
     * Directory screenshots are written to and `cleanup` clears. Relative paths
     * resolve against the process working directory at resolve time.
     */ shotsDir?: string;
    /**
     * URL policy mode applied to navigation commands. `public` (default): blocks
     * private/loopback/metadata targets before they reach the extension.
     * `intranet`: allows local/LAN targets while still blocking cloud-metadata
     * endpoints. Lives on the bridge instance config (registry via Settings).
     */
    urlMode?: string;
    /**
     * Master switch for cloud-metadata endpoint blocking (both modes). Default
     * true. Turn off only when you deliberately accept access to
     * instance-metadata services (e.g. inside your own VPC sandbox).
     */
    blockMetadata?: boolean;
    /**
     * Cloud-metadata HOSTNAMES to always block (both modes). This list FULLY
     * replaces the built-in defaults — the defaults are only the initial value
     * shown in Settings. `[]` blocks none of this family. Entries are matched
     * after hostname normalization (lowercase, trailing dot/brackets stripped).
     */
    metadataHostnames?: string[];
    /**
     * Cloud-metadata IP literals to always block (both modes). Same
     * replace-or-default contract as `metadataHostnames`.
     */
    metadataIps?: string[];
    /**
     * Absolute directory containing `design/registry.json` and
     * `upstream-baseline.json` for the self-update tools. Empty (default) means
     * the copies bundled under the package `registry/` directory.
     */
    registryDir?: string;
}
export declare const Config: z<Config>;
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export declare function apply(ctx: Context, config: Config): void;
