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
import type { BridgeExecuteOptions } from './bridge/server.js';
import { BridgeServer } from './bridge/server.js';
import type { UrlPolicy } from './url-policy.js';
/** A {@link BridgeServer} whose navigation commands pass the unified URL policy. */
export declare class GuardedBridge {
    private readonly server;
    private readonly policy;
    constructor(server: BridgeServer, policy: UrlPolicy);
    /** Raw link status, unchanged from the bridge. */
    get status(): import("./bridge/server.js").BridgeServerStatus;
    /**
     * Run one extension command. `nav` / `tabs.open` first pass
     * `policy.assertUsableUrl(url)`; a blocked or non-public target throws
     * {@link UrlPolicyError} and nothing is sent to the browser.
     */
    execute(command: string, params?: Record<string, unknown>, options?: BridgeExecuteOptions): Promise<unknown>;
    /** Delete generated screenshots / scratch files (same as the bridge). */
    cleanup(): Promise<import("./bridge/server.js").CleanupResult>;
}
