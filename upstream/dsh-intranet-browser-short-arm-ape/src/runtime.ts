/**
 * Standalone Playwright provider for the intranet/local debugging browser.
 *
 * Modeled on `@yeesy369/dsh-browser-playwright`'s runtime (same repo, MIT) but
 * deliberately independent: its own service name, its own persistent profile
 * directory, its own browser context, and — the whole point of the plugin — a
 * PERMISSIVE URL policy that skips the SSRF guard (private IPs, localhost and
 * LAN hosts are allowed). The only check kept by default is the cloud-metadata
 * blocklist. Every navigation is still approval-gated at the tool layer.
 *
 * The original `browser-playwright` instance is never touched, so its strict
 * url-guard remains in force for the regular `browser_*` tools.
 *
 * @module dsh-intranet-browser/runtime
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import {
  BrowserError,
  type BrowserActionResult,
  type BrowserNavigateResult,
  type BrowserPage,
  type BrowserPageOptions,
  type BrowserScrollResult,
  type BrowserScreenshot,
  type BrowserSnapshot,
  type BrowserTabInfo,
  type BrowserWaitOptions,
} from '@yeesy369/dsh-browser'
import type { Config } from './config.js'
import {
  HIDDEN_WINDOW_ARGS,
  STEALTH_INIT_SCRIPT,
  STEALTH_LAUNCH_ARGS,
} from './stealth.js'
import { blockReasonForUrl, createIntranetUrlCheck, type IntranetUrlCheck } from './url-check.js'

/**
 * Prefer a locally installed real browser — Microsoft Edge first, then Chrome;
 * fall back to the bundled Chromium when neither is installed.
 * (Copied from `browser-playwright/src/index.ts`; kept local so the intranet
 * instance has no runtime coupling to the original provider.)
 */
function findBrowserChannel(): 'msedge' | 'chrome' | undefined {
  const candidates: Array<['msedge' | 'chrome', string[]]> = []
  if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES
    const pf86 = process.env['PROGRAMFILES(X86)']
    const local = process.env.LOCALAPPDATA
    candidates.push(
      ['msedge', [
        pf86 && `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
        pf && `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ].filter((p): p is string => Boolean(p))],
      ['chrome', [
        pf && `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
        local && `${local}\\Google\\Chrome\\Application\\chrome.exe`,
        pf86 && `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
      ].filter((p): p is string => Boolean(p))],
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      ['msedge', ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']],
      ['chrome', ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']],
    )
  } else {
    candidates.push(
      ['msedge', ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']],
      ['chrome', ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']],
    )
  }
  for (const [channel, paths] of candidates) {
    for (const path of paths) {
      if (existsSync(path)) return channel
    }
  }
  return undefined
}

function sessionKeyOf(options?: BrowserPageOptions): string {
  return options?.sessionKey || 'default'
}

interface SessionState {
  pages: Map<string, IntranetPage>
  activeId: string | null
}

/**
 * The standalone intranet browser service. One instance per context, registered
 * under `intranet-browser` (NOT `browser`, so it never collides with the
 * original provider). Consumed by the `intranet_*` tools via closure.
 */
export class IntranetBrowserRuntime extends Service {
  private context: BrowserContext | null = null
  private readonly sessions = new Map<string, SessionState>()
  private readonly claimed = new WeakSet<Page>()
  private nextPageId = 0

  constructor(
    ctx: Context,
    private readonly getConfig: () => Config,
  ) {
    super(ctx, 'intranet-browser')
    ctx.effect(() => () => this.close())
  }

  /** Open (or reuse) the active page for a session. */
  async newPage(options?: BrowserPageOptions, _signal?: AbortSignal): Promise<BrowserPage> {
    const key = sessionKeyOf(options)
    try {
      await this.ensureBrowser(options)
      return await this.activePage(key)
    } catch {
      await this.close()
      await this.ensureBrowser(options)
      return await this.activePage(key)
    }
  }

  /** List tabs owned by a session. */
  async listTabs(sessionKey = 'default', _signal?: AbortSignal): Promise<readonly BrowserTabInfo[]> {
    const session = this.sessions.get(sessionKey)
    if (!session) return []
    const out: BrowserTabInfo[] = []
    for (const [id, wrapper] of session.pages) {
      if (wrapper.isClosed()) continue
      out.push({
        id,
        url: wrapper.url(),
        title: await wrapper.title(),
        active: id === session.activeId,
      })
    }
    return out
  }

  /** Open a new tab in a session and make it active. */
  async openTab(options?: BrowserPageOptions, _signal?: AbortSignal): Promise<BrowserPage> {
    await this.ensureBrowser(options)
    const key = sessionKeyOf(options)
    const session = this.session(key)
    const page = await this.claimOrCreatePage()
    const wrapper = this.wrap(page, session)
    session.activeId = wrapper.id
    return wrapper
  }

  /** Switch the session's active tab. */
  async switchTab(id: string, sessionKey = 'default', _signal?: AbortSignal): Promise<BrowserPage> {
    const session = this.sessions.get(sessionKey)
    const wrapper = session?.pages.get(id)
    if (!session || !wrapper || wrapper.isClosed()) {
      throw new BrowserError('BROWSER_TAB_NOT_FOUND', `No open tab ${id} in session ${sessionKey}.`)
    }
    session.activeId = id
    return wrapper
  }

  /** Close one tab in a session. */
  async closeTab(id: string, sessionKey = 'default', _signal?: AbortSignal): Promise<void> {
    const session = this.sessions.get(sessionKey)
    const wrapper = session?.pages.get(id)
    if (!session || !wrapper) return
    await wrapper.close()
    session.pages.delete(id)
    if (session.activeId === id) {
      const next = [...session.pages.keys()][0] ?? null
      session.activeId = next
    }
  }

  /** Release every browser resource owned by this runtime. */
  async close(_signal?: AbortSignal): Promise<void> {
    try {
      if (this.context) await this.context.close()
    } catch {
      // already closed — nothing to do
    }
    this.context = null
    this.sessions.clear()
  }

  private session(key: string): SessionState {
    let session = this.sessions.get(key)
    if (!session) {
      session = { pages: new Map(), activeId: null }
      this.sessions.set(key, session)
    }
    return session
  }

  private async activePage(key: string): Promise<IntranetPage> {
    const session = this.session(key)
    for (const [id, wrapper] of session.pages) {
      if (wrapper.isClosed()) session.pages.delete(id)
    }
    if (session.activeId && !session.pages.has(session.activeId)) session.activeId = null
    if (session.activeId) {
      const existing = session.pages.get(session.activeId)
      if (existing && !existing.isClosed()) return existing
    }
    for (const [id, wrapper] of session.pages) {
      if (!wrapper.isClosed()) {
        session.activeId = id
        return wrapper
      }
    }
    const page = await this.claimOrCreatePage()
    const wrapper = this.wrap(page, session)
    session.activeId = wrapper.id
    return wrapper
  }

  private wrap(page: Page, session: SessionState): IntranetPage {
    const id = `intranet-page-${this.nextPageId++}`
    const wrapper = new IntranetPage(page, () => this.urlCheck(), id, this.getConfig)
    session.pages.set(id, wrapper)
    return wrapper
  }

  private urlCheck(): IntranetUrlCheck {
    const c = this.getConfig()
    return createIntranetUrlCheck({
      allowFile: c.allowFile,
      blockMetadata: c.blockMetadata,
      blockedHostnames: new Set(c.blockedHostnames ?? []),
    })
  }

  /**
   * Reuse an unclaimed launch tab instead of always creating a new one. On
   * launch the browser already opens one (about:blank) tab — creating another
   * one leaves a blank tab behind every time the browser (re)starts.
   */
  private async claimOrCreatePage(): Promise<Page> {
    const existing = this.context!.pages().find((p) => !p.isClosed() && !this.claimed.has(p))
    if (existing) {
      this.claimed.add(existing)
      return existing
    }
    const page = await this.context!.newPage()
    this.claimed.add(page)
    return page
  }

  private async ensureBrowser(options?: BrowserPageOptions): Promise<void> {
    // The persistent context may have died (browser crash / manual window
    // close): `launchPersistentContext` returns a context whose `browser()` is
    // disconnected in that state. Treat it as dead and relaunch, otherwise
    // tab-list/switch calls would hang on a zombie context.
    const alive = this.context?.browser()?.isConnected() ?? false
    if (this.context && !alive) await this.close()
    if (alive) return
    const config = this.getConfig()
    const visibility = options?.windowVisibility ?? config.windowVisibility ?? 'visible'
    const headless = visibility === 'headless'
    const channel = options?.channel ?? config.channel ?? findBrowserChannel()
    const profileDir = options?.profileDir ?? config.profileDir ?? join(homedir(), '.dsh', 'intranet-edge-profile')
    const args = [
      ...(config.stealth !== false ? STEALTH_LAUNCH_ARGS : []),
      ...(visibility === 'hidden' ? HIDDEN_WINDOW_ARGS : []),
    ]
    const launchOptions = {
      headless,
      args,
      ...(channel ? { channel } : {}),
    }
    try {
      this.context = await chromium.launchPersistentContext(profileDir, {
        viewport: options?.viewport,
        ...launchOptions,
      })
      if (config.stealth !== false) {
        await this.context.addInitScript(STEALTH_INIT_SCRIPT)
      }
      // Blocklist enforcement at the request level: every request (redirect
      // targets, XHR/fetch, iframes, …) is checked against the metadata
      // blocklist and the configured extra blocklist, so an approved page
      // cannot 302 / script its way onto a metadata endpoint.
      await this.context.route('**/*', async (route) => {
        const c = this.getConfig()
        const reason = blockReasonForUrl(route.request().url(), {
          blockMetadata: c.blockMetadata,
          blockedHostnames: new Set(c.blockedHostnames ?? []),
        })
        try {
          if (reason) await route.abort('blockedbyclient')
          else await route.continue()
        } catch {
          // the request already finished (page closed / raced) — nothing to do
        }
      })
    } catch (cause) {
      throw new BrowserError(
        'BROWSER_LAUNCH_FAILED',
        'Failed to launch the intranet browser. Install Microsoft Edge (or Chrome), or run `pnpm playwright install chromium`.',
        { cause },
      )
    }
  }
}

/** A live page inside the intranet browser context. Implements the shared `BrowserPage` contract. */
export class IntranetPage implements BrowserPage {
  private lastRefs: readonly string[] = []

  constructor(
    private readonly page: Page,
    private readonly getCheck: () => IntranetUrlCheck,
    readonly id: string,
    private readonly getConfig: () => Config,
  ) {}

  isClosed(): boolean {
    return this.page.isClosed()
  }

  url(): string | null {
    return this.page.url() || null
  }

  async title(): Promise<string | null> {
    return (await this.page.title()) || null
  }

  /**
   * Navigate with the PERMISSIVE intranet policy: the SSRF guard is bypassed
   * (localhost / LAN / private ranges allowed), only the metadata blocklist and
   * basic scheme/credential checks apply. Approval is enforced one layer up at
   * the tool gate, so a navigation only happens after the user said yes.
   * Redirect targets are covered by the context-level route blocklist
   * (see `ensureBrowser`), so a 302 onto a metadata endpoint is aborted.
   */
  async navigate(raw: string, _signal?: AbortSignal): Promise<BrowserNavigateResult> {
    const url = this.getCheck().assertUsableUrl(raw)
    const timeout = this.getConfig().navigationTimeoutMs ?? 60_000
    const response = await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout })
    return {
      url: this.page.url(),
      statusCode: response?.status() ?? null,
      title: (await this.page.title()) || null,
    }
  }

  async snapshot(_signal?: AbortSignal): Promise<BrowserSnapshot> {
    const text = await this.readSnapshot()
    this.lastRefs = extractAriaRefs(text)
    return { url: this.page.url(), text, refs: this.lastRefs }
  }

  /**
   * Capture a screenshot. The first parameter accepts either a `{ fullPage }`
   * options object or a bare `AbortSignal` (the `BrowserPage` contract passes
   * the signal positionally), which is detected at runtime.
   */
  async screenshot(
    optionsOrSignal?: { fullPage?: boolean } | AbortSignal,
    _signal?: AbortSignal,
  ): Promise<BrowserScreenshot> {
    const options = optionsOrSignal instanceof AbortSignal ? undefined : optionsOrSignal
    const data = await this.page.screenshot({ type: 'png', fullPage: options?.fullPage ?? false })
    const viewport = this.page.viewportSize()
    return {
      mediaType: 'image/png',
      data: new Uint8Array(data),
      width: viewport?.width ?? 0,
      height: viewport?.height ?? 0,
    }
  }

  async click(ref: string, _signal?: AbortSignal): Promise<BrowserActionResult> {
    await this.locatorFor(ref).click({ timeout: this.getConfig().interactionTimeoutMs ?? 30_000 })
    return { url: this.page.url(), ok: true }
  }

  async type(text: string, _signal?: AbortSignal): Promise<BrowserActionResult> {
    await this.page.keyboard.type(text)
    return { url: this.page.url(), ok: true }
  }

  async fill(ref: string, value: string, _signal?: AbortSignal): Promise<BrowserActionResult> {
    await this.locatorFor(ref).fill(value, { timeout: this.getConfig().interactionTimeoutMs ?? 30_000 })
    return { url: this.page.url(), ok: true }
  }

  async press(key: string, ref?: string, _signal?: AbortSignal): Promise<BrowserActionResult> {
    if (ref) await this.locatorFor(ref).press(key, { timeout: this.getConfig().interactionTimeoutMs ?? 30_000 })
    else await this.page.keyboard.press(key)
    return { url: this.page.url(), ok: true }
  }

  async scroll(options?: { direction?: 'up' | 'down' | 'left' | 'right'; amount?: number }, _signal?: AbortSignal): Promise<BrowserScrollResult> {
    const direction = options?.direction ?? 'down'
    const amount = options?.amount ?? 800
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0
    const before = await this.page.evaluate('({ x: window.scrollX, y: window.scrollY })') as { x: number; y: number }
    await this.page.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`)
    await this.page.evaluate('new Promise((resolve) => requestAnimationFrame(() => resolve()))')
    const after = await this.page.evaluate('({ x: window.scrollX, y: window.scrollY })') as { x: number; y: number }
    const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y)
    return {
      url: this.page.url(),
      ok: true,
      scrollX: after.x,
      scrollY: after.y,
      atBoundary: moved < Math.abs(deltaX) + Math.abs(deltaY),
    }
  }

  async wait(options?: BrowserWaitOptions, signal?: AbortSignal): Promise<BrowserActionResult> {
    // The tools layer already clamps `ms` to the current `maxWaitMs` config;
    // no hard cap here so hot-reloaded values above 60s take effect.
    const ms = Math.max(0, options?.ms ?? 1000)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      }, { once: true })
    })
    if (options?.load) {
      await this.page.waitForLoadState('domcontentloaded', { timeout: this.getConfig().navigationTimeoutMs ?? 60_000 })
    }
    return { url: this.page.url(), ok: true }
  }

  async evaluate<T>(script: string, _signal?: AbortSignal): Promise<T> {
    return (await this.page.evaluate(script)) as T
  }

  async back(_signal?: AbortSignal): Promise<BrowserNavigateResult> {
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: this.getConfig().navigationTimeoutMs ?? 60_000 })
    return { url: this.page.url(), statusCode: null, title: (await this.page.title()) || null }
  }

  async forward(_signal?: AbortSignal): Promise<BrowserNavigateResult> {
    await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: this.getConfig().navigationTimeoutMs ?? 60_000 })
    return { url: this.page.url(), statusCode: null, title: (await this.page.title()) || null }
  }

  async close(_signal?: AbortSignal): Promise<void> {
    if (!this.page.isClosed()) await this.page.close()
  }

  private locatorFor(ref: string) {
    const useAriaRef = this.lastRefs.includes(ref) || isAriaRefFormat(ref)
    return useAriaRef ? this.page.locator(`aria-ref=${ref}`) : this.page.locator(ref)
  }

  private async readSnapshot(): Promise<string> {
    try {
      const aria = await this.page.locator('body').ariaSnapshot({ mode: 'ai' })
      if (aria && aria.trim()) return aria
    } catch {
      // fall through to innerText
    }
    const text = (await this.page.evaluate('document.body?.innerText ?? ""')) as string
    return text || ''
  }
}

/** Collect the actionable `ref` ids Playwright embeds in an aria snapshot. */
export function extractAriaRefs(text: string): string[] {
  const refs = new Set<string>()
  const re = /\[ref=([^\]]+)\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) refs.add(match[1])
  return [...refs]
}

/**
 * Whether a string looks like an aria-snapshot ref (letter prefix + digits,
 * e.g. `e1` on older Playwright builds, `f29e86` on newer ones) as opposed
 * to a CSS selector such as `text=Save` or `input[name=q]`.
 */
export function isAriaRefFormat(ref: string): boolean {
  return /^[a-z][a-z0-9]*\d+[a-z0-9]*$/i.test(ref)
}
