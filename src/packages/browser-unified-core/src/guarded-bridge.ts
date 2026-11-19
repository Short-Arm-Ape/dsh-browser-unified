/**
 * GuardedBridge — merge integration.
 *
 * Wraps the vendored (AGPL-3.0, caob23) {@link BridgeServer} with the unified
 * {@link UrlPolicy} so that navigation-y commands (`nav`, `tabs.open`) are
 * URL-checked *before* they reach the extension. This closes the largest gap
 * of the caob23 upstream (no URL policy at all) while keeping its bridge
 * qualities (abort, per-command timeout, no hanging pending queue).
 *
 * Limitation (documented): the policy here is a tool-call-level gate. For a
 * real browser driven via CDP the *page's own* requests (redirects, XHR,
 * iframes) are not intercepted by this Node layer — request-level blocking
 * must live in the extension (like `blockReasonForUrl` used as a route
 * handler), which is future work.
 * @module browser-unified-core/guarded-bridge
 */

import type { BridgeExecuteOptions } from './bridge/server.js'
import { BridgeServer } from './bridge/server.js'
import type { UrlPolicy } from './url-policy.js'

/** Commands that carry a `url` param and change where the browser navigates. */
const URL_COMMANDS: ReadonlySet<string> = new Set(['nav', 'tabs.open'])

/** A {@link BridgeServer} whose navigation commands pass the unified URL policy. */
export class GuardedBridge {
  constructor(
    private readonly server: BridgeServer,
    private readonly policy: UrlPolicy,
  ) {}

  /** Raw link status, unchanged from the bridge. */
  get status() {
    return this.server.status
  }

  /**
   * Run one extension command. `nav` / `tabs.open` first pass
   * `policy.assertUsableUrl(url)`; a blocked or non-public target throws
   * {@link UrlPolicyError} and nothing is sent to the browser.
   */
  async execute(
    command: string,
    params: Record<string, unknown> = {},
    options: BridgeExecuteOptions = {},
  ): Promise<unknown> {
    const url = (params as { url?: unknown }).url
    if (typeof url === 'string' && URL_COMMANDS.has(command)) {
      await this.policy.assertUsableUrl(url)
    }
    return this.server.execute(command, params, options)
  }

  /** Delete generated screenshots / scratch files (same as the bridge). */
  async cleanup() {
    return this.server.cleanup()
  }
}
