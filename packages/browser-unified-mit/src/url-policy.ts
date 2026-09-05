/**
 * dsh-browser-unified-mit — MIT-licensed release (contains no caob23-derived code).
 * Relicensed MIT by the repository authors; upstream (MIT) attribution of distilled
 * semantics is in NOTICE.md. License: MIT.
 */
/**
 * Unified URL policy — merge prototype.
 *
 * Distilled from two MIT upstreams:
 *  - `dsh-browser` (xylt369, MIT): private/fake-ip IP classifiers + resolve-then-validate
 *    "public" guard (see its packages/browser-playwright/src/url-guard.ts);
 *  - `dsh-intranet-browser` (Short-Arm-Ape, MIT): relaxed "intranet" mode, metadata
 *    hostname/IP blocklist + hostname normalization (see its src/url-check.ts).
 *
 * One entry point with `mode: 'public' | 'intranet'` so a future unified provider can
 * mount both a safe instance and a local-debugging instance from the same code path.
 * @module dsh-browser-unified-mit/url-policy
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Stable error code + human message; callers (tools) surface `code` to the model. */
export class UrlPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'UrlPolicyError'
  }
}

/** Which network stance this instance enforces. */
export type UrlPolicyMode = 'public' | 'intranet'

export interface UrlPolicyOptions {
  readonly mode: UrlPolicyMode
  /** Allow Clash/Surge/mihomo fake-ip answers in 198.18.0.0/15 (public mode). Default true. */
  readonly allowFakeIp?: boolean
  /** Public mode only: skip private-IP screening entirely. Never enable near sensitive hosts. */
  readonly allowPrivate?: boolean
  /** Allow file:// URLs in addition to http(s). Default false. */
  readonly allowFile?: boolean
  /** Master switch: keep blocking cloud-metadata endpoints. Default true (both modes). */
  readonly blockMetadata?: boolean
  /** Extra hostnames/IP literals always blocked (both modes). */
  readonly blockedHostnames?: ReadonlySet<string>
  /**
   * Cloud-metadata hostnames always blocked in BOTH modes. When provided this
   * REPLACES the built-in default list entirely (`[]` = block none of this
   * family); when omitted the built-in defaults are used. Values are compared
   * after hostname normalization (lowercase, trailing dot / IPv6 brackets
   * stripped, IPv4-mapped tails unwrapped).
   */
  readonly metadataHostnames?: readonly string[]
  /**
   * Same replace-or-default contract as {@link metadataHostnames}, for the
   * IP-literal family of cloud-metadata endpoints.
   */
  readonly metadataIps?: readonly string[]
  /** Public mode: resolve hostnames and reject any non-public answer. Default true. */
  readonly resolveDns?: boolean
}

/**
 * Default cloud-metadata hostnames (upstream list) — kept blocked even in
 * intranet mode. This is only the *initial value*: pass your own
 * `metadataHostnames` to {@link UrlPolicy} (or `browser-bridge` settings) to
 * fully replace it, e.g. for non-AWS/GCP/Azure clouds or private deployments.
 */
export const DEFAULT_METADATA_HOSTNAMES: readonly string[] = [
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.internal',
  'metadata.tencentyun.com',
]
/**
 * Default cloud-metadata IP literals (AWS/GCP/Azure 169.254.169.254, Alibaba
 * 100.100.100.200, AWS IMDSv2 IPv6). Initial value only — replace via
 * `metadataIps` for full control.
 */
export const DEFAULT_METADATA_IPS: readonly string[] = [
  '169.254.169.254', // AWS / GCP / Azure instance metadata
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IMDSv2 IPv6
]

/** Back-compat aliases kept for existing consumers (values equal the defaults above). */
export const METADATA_HOSTNAMES: ReadonlySet<string> = new Set(DEFAULT_METADATA_HOSTNAMES)
export const METADATA_IPS: ReadonlySet<string> = new Set(DEFAULT_METADATA_IPS)

/** Hostnames blocked before any other check in public mode (upstream default set). */
const DEFAULT_BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'metadata',
  'metadata.google.internal',
])

/**
 * Normalize a hostname for blocklist matching: strip IPv6 brackets, lowercase,
 * drop trailing dots, and map IPv4-mapped IPv6 tails back to dotted quad.
 */
export function normalizeHostname(raw: string): string {
  let host = raw.replace(/^\[|\]$/g, '').toLowerCase()
  while (host.endsWith('.')) host = host.slice(0, -1)
  if (host.startsWith('::ffff:')) {
    const v4 = ipv6TailToIpv4(host.slice('::ffff:'.length))
    if (v4) return v4
  }
  return host
}

function ipv6TailToIpv4(tail: string): string | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail
  const parts = tail.split(':')
  if (parts.length > 2) return null
  let hex = ''
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    hex += part.padStart(4, '0')
  }
  if (hex.length !== 8) return null
  const n = Number.parseInt(hex, 16)
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`
}

/** True when an IPv4 literal is private / loopback / link-local / multicast / reserved. */
export function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split('.')
  if (parts.length !== 4) return true // fail-safe on malformed input
  const octets = parts.map((p) => Number(p))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = octets as [number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true // benchmark / proxy fake-ip range
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224) return true // multicast + reserved 240/4
  return false
}

/** True only for the Clash/Surge/mihomo fake-ip pool 198.18.0.0/15. */
export function isFakeIpIPv4(addr: string): boolean {
  const parts = addr.split('.')
  if (parts.length !== 4) return false
  const a = Number(parts[0])
  const b = Number(parts[1])
  return a === 198 && (b === 18 || b === 19)
}

/** True when an IPv6 address is loopback, ULA, link-local, multicast, or mapped to a private v4. */
export function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA fc00::/7
  if (/^fe[89ab]/.test(lower)) return true // link-local fe80::/10
  if (lower.startsWith('ff')) return true // multicast
  if (lower.startsWith('2001:db8')) return true // documentation
  if (lower.startsWith('::ffff:')) return isPrivateIPv4(lower.slice('::ffff:'.length))
  return false
}

function isPrivateAddress(addr: string, family: number): boolean {
  return family === 4 ? isPrivateIPv4(addr) : isPrivateIPv6(addr)
}

function isFakeIpAddress(addr: string, family: number): boolean {
  if (family === 4) return isFakeIpIPv4(addr)
  if (family === 6) {
    const lower = addr.toLowerCase()
    if (lower.startsWith('::ffff:')) return isFakeIpIPv4(lower.slice('::ffff:'.length))
  }
  return false
}

/** Normalize every entry of a configured metadata list for membership checks. */
function normalizeList(entries: readonly string[] | undefined, fallback: readonly string[]): ReadonlySet<string> {
  return new Set((entries ?? fallback).map((entry) => normalizeHostname(entry)).filter((host) => host.length > 0))
}

/**
 * Host-level blocklist usable against ANY request URL (navigation, redirects,
 * subresources). Invalid URLs fail open here — the strict navigation check is
 * the caller's safety net for the initial `goto`.
 */
export function blockReasonForUrl(
  raw: string | URL,
  options: {
    readonly blockMetadata?: boolean
    readonly blockedHostnames?: ReadonlySet<string>
    readonly metadataHostnames?: readonly string[]
    readonly metadataIps?: readonly string[]
  } = {},
): string | null {
  let url: URL
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw
  } catch {
    return null
  }
  const host = normalizeHostname(url.hostname)
  const extra = options.blockedHostnames ?? new Set<string>()
  if (extra.has(host)) return `Hostname is blocked by configuration: ${host}`
  if (options.blockMetadata ?? true) {
    const hosts = normalizeList(options.metadataHostnames, DEFAULT_METADATA_HOSTNAMES)
    const ips = normalizeList(options.metadataIps, DEFAULT_METADATA_IPS)
    if (hosts.has(host) || ips.has(host)) return `Cloud metadata endpoint is blocked: ${host}`
  }
  return null
}

/** One policy instance: `mode` selects how strict `assertUsableUrl` is. */
export class UrlPolicy {
  private readonly mode: UrlPolicyMode
  private readonly allowFakeIp: boolean
  private readonly allowPrivate: boolean
  private readonly allowFile: boolean
  private readonly blockMetadata: boolean
  private readonly blocked: ReadonlySet<string>
  private readonly metadataHosts: ReadonlySet<string>
  private readonly metadataIps: ReadonlySet<string>
  private readonly resolveDns: boolean

  constructor(options: UrlPolicyOptions) {
    this.mode = options.mode
    this.allowFakeIp = options.allowFakeIp ?? true
    this.allowPrivate = options.allowPrivate ?? false
    this.allowFile = options.allowFile ?? false
    this.blockMetadata = options.blockMetadata ?? true
    this.blocked = options.blockedHostnames ?? (options.mode === 'public' ? DEFAULT_BLOCKED_HOSTNAMES : new Set<string>())
    this.metadataHosts = normalizeList(options.metadataHostnames, DEFAULT_METADATA_HOSTNAMES)
    this.metadataIps = normalizeList(options.metadataIps, DEFAULT_METADATA_IPS)
    this.resolveDns = options.resolveDns ?? true
  }

  get isIntranet(): boolean {
    return this.mode === 'intranet'
  }

  /**
   * Validate `raw` for a navigation. Public mode: http(s) only, no embedded
   * credentials, default-hostname blocklist, IP-literal screening and (unless
   * disabled) resolve-then-validate DNS. Intranet mode: http(s) (+file), no
   * credentials, and only the metadata/extras blocklist — private and loopback
   * targets are intentionally allowed (that is the point of the intranet mode).
   * @throws {UrlPolicyError} with a stable `code` when unusable.
   */
  async assertUsableUrl(raw: string): Promise<URL> {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new UrlPolicyError('WEB_INVALID_URL', `Invalid URL: ${raw}`)
    }
    const schemeOk = url.protocol === 'http:' || url.protocol === 'https:' || (this.allowFile && url.protocol === 'file:')
    if (!schemeOk) {
      throw new UrlPolicyError('WEB_INVALID_URL', `Only http(s)${this.allowFile ? ' and file' : ''} URLs are allowed: ${raw}`)
    }
    if (url.username || url.password) {
      throw new UrlPolicyError('WEB_BLOCKED_URL', 'URLs with embedded credentials are blocked')
    }
    const host = normalizeHostname(url.hostname)
    if (this.blocked.has(host)) {
      throw new UrlPolicyError('WEB_BLOCKED_URL', `Hostname is blocked: ${host}`)
    }
    const reason = blockReasonForUrl(url, {
      blockMetadata: this.blockMetadata,
      blockedHostnames: this.blocked,
      metadataHostnames: [...this.metadataHosts],
      metadataIps: [...this.metadataIps],
    })
    if (reason) throw new UrlPolicyError('WEB_BLOCKED_URL', reason)
    if (this.mode === 'intranet') return url
    if (this.allowPrivate) return url

    // --- public mode: literal + DNS screening (resolve-then-validate) ---
    const literalFamily = isIP(host)
    if (literalFamily !== 0) {
      if (this.blockedAsPrivate(host, literalFamily)) {
        throw new UrlPolicyError('WEB_PRIVATE_TARGET', `Non-public IP literal is blocked: ${host}`)
      }
      return url
    }
    if (!this.resolveDns) return url
    let resolved
    try {
      resolved = await lookup(host, { all: true })
    } catch (cause) {
      throw new UrlPolicyError('WEB_PROVIDER_ERROR', `DNS resolution failed for ${host}`, { cause })
    }
    for (const entry of resolved) {
      if (this.blockedAsPrivate(entry.address, entry.family)) {
        throw new UrlPolicyError('WEB_PRIVATE_TARGET', `Hostname resolves to a non-public address: ${host}`)
      }
    }
    return url
  }

  private blockedAsPrivate(addr: string, family: number): boolean {
    if (!isPrivateAddress(addr, family)) return false
    if (this.allowFakeIp && isFakeIpAddress(addr, family)) return false
    return true
  }
}
