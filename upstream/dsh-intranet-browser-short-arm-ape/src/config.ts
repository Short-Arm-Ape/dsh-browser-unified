/** Shared config shape for the intranet/local debugging browser. @module dsh-intranet-browser/config */

export interface Config {
  /**
   * Approval granularity:
   * - `per-call` (default) — every `intranet_*` call asks the user via `ctx.approval`.
   * - `arm` — one `intranet_arm` call (itself approval-gated) arms the current
   *   agent; later `intranet_*` calls run without further prompts until
   *   `intranet_disarm`. Per-agent, per process lifetime.
   */
  approvalMode: 'per-call' | 'arm'
  /**
   * Which `intranet_*` calls require approval:
   * - `all` (default) — every call prompts (per `approvalMode`).
   * - `navigation` — read-only calls (`intranet_snapshot`, `intranet_screenshot`,
   *   `intranet_scroll`, `intranet_wait`, `intranet_list_tabs`) run without
   *   prompting; navigation / write calls (`intranet_open`, `click`, `type`,
   *   `fill`, `press`, `back`, `forward`, tab open/switch/close, `evaluate`,
   *   `close`) still prompt every time.
   */
  approvalScope: 'all' | 'navigation'
  /** Keep blocking cloud-metadata endpoints even though SSRF protection is bypassed. Defaults to `true`. */
  blockMetadata: boolean
  /** Extra hostnames or IP literals that are always blocked (in addition to the metadata list). */
  blockedHostnames: string[]
  /** Allow `file://` URLs. Defaults to `false`. */
  allowFile: boolean
  /** Window mode for the standalone intranet browser. Defaults to `visible`. */
  windowVisibility: 'visible' | 'hidden' | 'headless'
  /** Apply lightweight anti-detection patches. Defaults to `true`. */
  stealth: boolean
  /** Prefer a real browser channel; auto-detect when omitted. */
  channel?: 'chrome' | 'msedge'
  /** Persistent profile directory for the intranet browser (login state). */
  profileDir: string
  /** Upper bound for `intranet_wait` in milliseconds. Defaults to 60_000. */
  maxWaitMs: number
  /** Navigation timeout (open/back/forward) in milliseconds. Defaults to 60_000. */
  navigationTimeoutMs: number
  /** Interaction timeout (click/fill/press) in milliseconds. Defaults to 30_000. */
  interactionTimeoutMs: number
  /**
   * Expose the `intranet_evaluate` tool (raw JS in the page). Defaults to
   * `false`; HIGH RISK. The tool is registered at plugin load, so toggling it
   * takes effect on the next dsh restart.
   */
  evaluate: boolean
}
