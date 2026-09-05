/**
 * Instance registry — merge prototype.
 *
 * Original metadata mapping of the four archived routes. Lets a future unified
 * bundle declare "which instance, which tool prefix, which URL mode, which
 * approval model" per deployment instead of shipping four parallel plugins.
 * @module browser-unified-core/instance
 */

import type { UrlPolicyMode } from './url-policy.js'

/** The four archived routes. */
export type RouteId =
  | 'dsh-browser' // xylt369 monorepo provider (native Playwright, public only)
  | 'intranet-browser' // Short-Arm-Ape relaxed fork
  | 'browser-control-mcp' // kyo615 @playwright/mcp child process
  | 'browser-control-bridge' // caob23 real-browser extension + local WS bridge

export type ApprovalModelId = 'web-permission' | 'per-call-approval' | 'host-policy' | 'none'

export interface BrowserInstanceProfile {
  readonly route: RouteId
  /** npm scope / author identity of the upstream. */
  readonly upstream: string
  /** Relative directory under upstream/ in this repository. */
  readonly upstreamDir: string
  /** Tool prefix the model sees. */
  readonly toolPrefix: string
  /** How the browser is provided. */
  readonly browserKind: 'native-playwright' | 'playwright-mcp' | 'real-browser-cdp'
  /** URL enforcement stance (see url-policy.ts). */
  readonly urlMode: UrlPolicyMode | 'none'
  /** Which approval mechanism guards tool calls. */
  readonly approvalModel: ApprovalModelId
  /** License of the upstream (see NOTICE.md). */
  readonly license: 'MIT' | 'AGPL-3.0'
  /** Cookie / login persistence boundary. */
  readonly sessionNote: string
  readonly note: string
}

export const PROFILES: Record<RouteId, BrowserInstanceProfile> = {
  'dsh-browser': {
    route: 'dsh-browser',
    upstream: '@yeesy369 (xylt369)',
    upstreamDir: 'dsh-browser-xylt369',
    toolPrefix: 'browser_',
    browserKind: 'native-playwright',
    urlMode: 'public',
    approvalModel: 'web-permission',
    license: 'MIT',
    sessionNote: 'persistent Edge profile (shared logins); tabs isolated per harness session',
    note: 'Recommended base: typed ctx.browser seam, 4-layer URL guard incl. DNS resolve, screenshot→image attachment.',
  },
  'intranet-browser': {
    route: 'intranet-browser',
    upstream: '@short-arm-ape',
    upstreamDir: 'dsh-intranet-browser-short-arm-ape',
    toolPrefix: 'intranet_',
    browserKind: 'native-playwright',
    urlMode: 'intranet',
    approvalModel: 'per-call-approval',
    license: 'MIT',
    sessionNote: 'own persistent profile (~/.dsh/intranet-edge-profile); cookies shared across sessions',
    note: 'Same code family as dsh-browser but relaxes private-IP screening; metadata list + approval gate kept. Best merged as a provider urlMode rather than a fork.',
  },
  'browser-control-mcp': {
    route: 'browser-control-mcp',
    upstream: 'kyo615',
    upstreamDir: 'dsh-browser-control-kyo615',
    toolPrefix: 'browser_',
    browserKind: 'playwright-mcp',
    urlMode: 'none',
    approvalModel: 'host-policy',
    license: 'MIT',
    sessionNote: '--isolated in-memory Chrome profile (no persistence)',
    note: 'Wraps @playwright/mcp over stdio; dynamic ~80-tool surface; no URL guard, no queue-safe lifecycle.',
  },
  'browser-control-bridge': {
    route: 'browser-control-bridge',
    upstream: '@caob23',
    upstreamDir: 'dsh-browser-control-caob23',
    toolPrefix: 'browser_',
    browserKind: 'real-browser-cdp',
    urlMode: 'none',
    approvalModel: 'host-policy',
    license: 'AGPL-3.0',
    sessionNote: 'user real browser: full logins/cookies of the browsing profile',
    note: 'Extension + local WS bridge over CDP (bridge/ws.ts + bridge/server.ts vendored into this package, AGPL). Best UX (real logged-in browser). GuardedBridge now applies the unified UrlPolicy to nav/tabs.open; request-level page blocking and an allowEval gate remain future work.',
  },
}

/** Resolve a profile by route id (case-insensitive, also matches npm-ish names). */
export function resolveProfile(key: string): BrowserInstanceProfile {
  const normalized = key.trim().toLowerCase()
  const direct = PROFILES[normalized as RouteId]
  if (direct) return direct
  for (const profile of Object.values(PROFILES)) {
    if (profile.upstreamDir.toLowerCase().includes(normalized) || normalized.includes(profile.route.toLowerCase())) {
      return profile
    }
  }
  throw new Error(`unknown browser instance: ${key} (use ${Object.keys(PROFILES).join(', ')})`)
}

/**
 * Informational helper: upstream routes whose own code is MIT-licensed. Useful
 * when producing a separate MIT-only build (e.g. a public "policy" subpackage).
 * NOTE: since 2026-09-05 this whole package is AGPL-3.0; this function no
 * longer describes the package license.
 */
export function mitMergeableProfiles(): BrowserInstanceProfile[] {
  return Object.values(PROFILES).filter((p) => p.license === 'MIT')
}
