/** Playwright provider for the browser capability seam. @module dsh-browser-playwright */

import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import Schema from '@deepseek-ai/schemastery'
import {
  BrowserError,
  BrowserRuntime,
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
import { createUrlGuard, type UrlGuard } from './url-guard.js'
import {
  HIDDEN_WINDOW_ARGS,
  STEALTH_INIT_SCRIPT,
  STEALTH_LAUNCH_ARGS,
} from './stealth.js'

/**
 * Prefer a locally installed real browser — Microsoft Edge first (the default
 * for this provider), then Chrome; fall back to the bundled Chromium when
 * neither is installed.
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

export const name = 'browser-playwright'
/** Wait for Host settings so `register(..., { expose: 'web' })` actually runs. */
export const inject = ['settings']

export interface Config {
  /**
   * Window mode:
   * - `visible` — real browser window on the desktop (manual login / captcha possible).
   * - `hidden` — real browser with the window minimized and parked offscreen (anti-bot friendliest, no visible window; needs a desktop session).
   * - `headless` — no window at all (server/CI); weaker against aggressive bot detection.
   * Defaults to `visible`.
   */
  windowVisibility?: 'visible' | 'hidden' | 'headless'
  /** Apply lightweight anti-detection patches; defaults to `true`. */
  stealth: boolean
  /**
   * Allow Clash / Surge "fake-ip" DNS answers in `198.18.0.0/15`.
   * Without this, every public site fails on machines whose system DNS is hijacked to fake-ip.
   * Defaults to `true`. Real private ranges (10/8, 127/8, 169.254/16, …) stay blocked.
   */
  allowFakeIp: boolean
  /** @deprecated Use `windowVisibility: 'headless'` instead. */
  headless?: boolean
  /** Prefer a real browser channel; auto-detect when omitted. */
  channel?: 'chrome' | 'msedge'
  /** Persistent profile directory (login state). */
  profileDir?: string
}

export const Config = Schema.object({
  windowVisibility: Schema.union(['visible', 'hidden', 'headless']).description(
    '窗口模式：visible = 弹出真实浏览器窗口，可直接手动登录、处理验证码（缺点是每次使用都会打扰桌面）；' +
    'hidden = 真浏览器但窗口最小化并移到屏幕外，反爬最强且不打扰桌面（缺点：不能直接看窗口操作，登录需提前在 profile 里完成，且依赖桌面会话）；' +
    'headless = 完全不弹窗，适合服务器/CI（缺点：即使开了 stealth 补丁，强风控仍可能识别，且无法手动登录）。默认 visible。',
  ),
  stealth: Schema.boolean().default(true).description(
    '轻量反检测补丁：抹掉 navigator.webdriver、补全 plugins、伪装 WebGL 厂商等常见自动化指纹。默认开启；极少数站点可能因补丁行为异常，可关闭。',
  ),
  allowFakeIp: Schema.boolean().default(true).description(
    '允许 Clash/Surge 等代理的 fake-ip DNS（198.18.0.0/15）。本机开了 fake-ip 时若不开启，所有公网页都会被 SSRF 守卫误拦。默认开启；10/8、127/8 等真实内网地址仍会拦截。',
  ),
  headless: Schema.boolean().description('已废弃：请改用 windowVisibility: "headless"。'),
  channel: Schema.union(['chrome', 'msedge']),
  profileDir: Schema.string(),
})

interface SessionState {
  pages: Map<string, PlaywrightBrowserPage>
  activeId: string | null
}

export function apply(ctx: Context, config: Config): void {
  const settings = ctx.get('settings') as {
    register: (ns: string, schema: unknown, options: object) => { get: () => Config }
  }
  const scope = settings.register(name, Config, {
    base: config,
    applies: 'restart',
    expose: 'web',
  })
  ctx.plugin(PlaywrightBrowserRuntime, scope.get())
}

class PlaywrightBrowserRuntime extends BrowserRuntime {
  private readonly config: Config
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private readonly sessions = new Map<string, SessionState>()
  private readonly claimed = new WeakSet<Page>()
  private nextPageId = 0
  private readonly guard: UrlGuard

  constructor(ctx: Context, config: Partial<Config> = {}) {
    super(ctx)
    this.config = { stealth: true, allowFakeIp: true, ...config }
    this.guard = createUrlGuard({
      allowPrivate: false,
      allowFakeIp: this.config.allowFakeIp !== false,
    })
    ctx.effect(() => () => this.close())
  }

  override async newPage(options?: BrowserPageOptions, _signal?: AbortSignal): Promise<BrowserPage> {
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

  override async listTabs(sessionKey = 'default'): Promise<readonly BrowserTabInfo[]> {
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

  override async openTab(options?: BrowserPageOptions): Promise<BrowserPage> {
    await this.ensureBrowser(options)
    const key = sessionKeyOf(options)
    const session = this.session(key)
    const page = await this.claimOrCreatePage()
    const wrapper = this.wrap(page, session)
    session.activeId = wrapper.id
    return wrapper
  }

  override async switchTab(id: string, sessionKey = 'default'): Promise<BrowserPage> {
    const session = this.sessions.get(sessionKey)
    const wrapper = session?.pages.get(id)
    if (!session || !wrapper || wrapper.isClosed()) {
      throw new BrowserError('BROWSER_TAB_NOT_FOUND', `No open tab ${id} in session ${sessionKey}.`)
    }
    session.activeId = id
    return wrapper
  }

  override async closeTab(id: string, sessionKey = 'default'): Promise<void> {
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

  override async close(_signal?: AbortSignal): Promise<void> {
    try {
      if (this.browser) {
        await this.browser.close()
      } else if (this.context) {
        await this.context.close()
      }
    } catch {
      // already closed — nothing to do
    }
    this.browser = null
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

  private async activePage(key: string): Promise<PlaywrightBrowserPage> {
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

  private wrap(page: Page, session: SessionState): PlaywrightBrowserPage {
    const id = `page-${this.nextPageId++}`
    const wrapper = new PlaywrightBrowserPage(page, this.guard, id)
    session.pages.set(id, wrapper)
    return wrapper
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
    if (this.context && (!this.browser || this.browser.isConnected())) return
    const visibility = options?.windowVisibility
      ?? this.config.windowVisibility
      ?? (this.config.headless ? 'headless' : 'visible')
    const headless = visibility === 'headless'
    const channel = options?.channel ?? this.config.channel ?? findBrowserChannel()
    const profileDir = options?.profileDir ?? this.config.profileDir ?? join(homedir(), '.dsh', 'edge-profile')
    const args = [
      ...(this.config.stealth ? STEALTH_LAUNCH_ARGS : []),
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
      if (this.config.stealth) {
        await this.context.addInitScript(STEALTH_INIT_SCRIPT)
      }
    } catch (cause) {
      throw new BrowserError(
        'BROWSER_LAUNCH_FAILED',
        'Failed to launch a browser. Install Microsoft Edge (or Chrome), or run `pnpm playwright install chromium`.',
        { cause },
      )
    }
  }
}

class PlaywrightBrowserPage implements BrowserPage {
  private lastRefs: readonly string[] = []

  constructor(
    private readonly page: Page,
    private readonly guard: UrlGuard,
    readonly id: string,
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

  async navigate(raw: string, _signal?: AbortSignal): Promise<BrowserNavigateResult> {
    const url = await this.guard.assertPublicHttpUrl(raw)
    const response = await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 })
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

  async screenshot(_signal?: AbortSignal): Promise<BrowserScreenshot> {
    const data = await this.page.screenshot({ type: 'png', fullPage: false })
    const viewport = this.page.viewportSize()
    return {
      mediaType: 'image/png',
      data: new Uint8Array(data),
      width: viewport?.width ?? 0,
      height: viewport?.height ?? 0,
    }
  }

  async click(ref: string, _signal?: AbortSignal): Promise<BrowserActionResult> {
    await this.locatorFor(ref).click({ timeout: 30_000 })
    return { url: this.page.url(), ok: true }
  }

  async type(text: string, _signal?: AbortSignal): Promise<BrowserActionResult> {
    await this.page.keyboard.type(text)
    return { url: this.page.url(), ok: true }
  }

  async fill(ref: string, value: string, _signal?: AbortSignal): Promise<BrowserActionResult> {
    await this.locatorFor(ref).fill(value, { timeout: 30_000 })
    return { url: this.page.url(), ok: true }
  }

  async press(key: string, ref?: string, _signal?: AbortSignal): Promise<BrowserActionResult> {
    if (ref) await this.locatorFor(ref).press(key, { timeout: 30_000 })
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
    const ms = Math.max(0, Math.min(options?.ms ?? 1000, 60_000))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      }, { once: true })
    })
    if (options?.load) {
      await this.page.waitForLoadState('domcontentloaded', { timeout: 60_000 })
    }
    return { url: this.page.url(), ok: true }
  }

  async evaluate<T>(script: string, _signal?: AbortSignal): Promise<T> {
    return (await this.page.evaluate(script)) as T
  }

  async back(_signal?: AbortSignal): Promise<BrowserNavigateResult> {
    await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    return { url: this.page.url(), statusCode: null, title: (await this.page.title()) || null }
  }

  async forward(_signal?: AbortSignal): Promise<BrowserNavigateResult> {
    await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 60_000 })
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

export { PlaywrightBrowserRuntime }
