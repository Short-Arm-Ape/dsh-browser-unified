/** Service Definition for the browser capability seam. @module dsh-browser */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { BrowserPage, BrowserPageOptions, BrowserTabInfo } from './types.js'

export * from './types.js'
export { BrowserError } from './error.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/**
 * The `ctx.browser` capability seam. One implementation per context; a
 * provider subclasses this service and is loaded as a plugin (the same pattern
 * as `ctx.subprocess`). Loading a second implementation throws.
 *
 * Pages are grouped by `sessionKey` (a harness session id). Cookies still
 * share the persistent profile so logins survive; tabs and navigation do not
 * leak across sessions.
 */
export abstract class BrowserRuntime extends Service {
  constructor(ctx: Context) {
    super(ctx, 'browser')
  }

  /** Open (or reuse) the active page for a session. */
  abstract newPage(options?: BrowserPageOptions, signal?: AbortSignal): Promise<BrowserPage>

  /** List tabs owned by a session. */
  abstract listTabs(sessionKey?: string, signal?: AbortSignal): Promise<readonly BrowserTabInfo[]>

  /** Open a new tab in a session and make it active. */
  abstract openTab(options?: BrowserPageOptions, signal?: AbortSignal): Promise<BrowserPage>

  /** Switch the session's active tab. */
  abstract switchTab(id: string, sessionKey?: string, signal?: AbortSignal): Promise<BrowserPage>

  /** Close one tab in a session. */
  abstract closeTab(id: string, sessionKey?: string, signal?: AbortSignal): Promise<void>

  /** Release every browser resource owned by this runtime. */
  abstract close(signal?: AbortSignal): Promise<void>
}

export default BrowserRuntime
