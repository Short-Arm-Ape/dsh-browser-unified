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
 * @module browser-unified-core/url-policy
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

/**
 * A target realm, from most trusted to least:
 * - `local`: the machine itself (loopback / localhost);
 * - `lan`: private networks (LAN / link-local / fake-ip / local-only names);
 * - `internet`: everything else.
 * Kept separate so a user may e.g. let the model debug the local DSH service
 * without exposing LAN devices, or scan the LAN without exposing this host.
 */
export type Realm = 'internet' | 'lan' | 'local'

/**
 * Per-realm access behavior for hosts that pass the routing stance and the
 * hard blocklists:
 * - `allow`: navigation proceeds without further approval;
 * - `ask`: an explicit user approval is required unless the host is on the
 *   allow list or already granted this session (see the `*Temp` switches for
 *   whether such approvals may grant new hosts);
 * - `deny`: refused regardless of allow list.
 */
export type RealmAccess = 'allow' | 'ask' | 'deny'

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
  /** Access policy for `internet` hosts. Default 'allow'. */
  readonly internetAccess?: RealmAccess
  /** Access policy for `lan` (private network) hosts. Default 'allow'. */
  readonly lanAccess?: RealmAccess
  /** Access policy for `local` (loopback / localhost) hosts. Default 'allow'. */
  readonly localAccess?: RealmAccess
  /** Whether ask-mode approvals may grant temporary internet hosts this session. Default true. */
  readonly internetTemp?: boolean
  /** Whether ask-mode approvals may grant temporary lan hosts this session. Default true. */
  readonly lanTemp?: boolean
  /** Whether ask-mode approvals may grant temporary local hosts this session. Default true. */
  readonly localTemp?: boolean
  /**
   * DSH-page special rule (optional). When enabled, origins listed in
   * `dshOrigins` (normalized `http(s)://host[:port]`, or `host:*` to allow any
   * port of that host) bypass the routing stance and the realm allow/ask
   * layer, so the model can reach the harness control page even under
   * `public`. This is an explicitly user-opted capability (the GUI asks twice
   * when enabling): the model otherwise could drive its own approval prompts.
   */
  readonly dshAccessEnabled?: boolean
  readonly dshOrigins?: readonly string[]
  /**
   * Hostnames/IPs that never need per-host authorization in `ask` realms.
   * Entries may be exact (after normalization) or a `*.suffix` wildcard
   * matching any subdomain.
   */
  readonly allowHosts?: readonly string[]
  /**
   * Hostnames/IPs always denied (both modes and under every authorization
   * mode), merged with `blockedHostnames`. Exact entries or `*.suffix`
   * wildcards.
   */
  readonly denyHosts?: readonly string[]
  /** Public mode: resolve hostnames and reject any non-public answer. Default true. */
  readonly resolveDns?: boolean
}

/** Verdict of {@link UrlPolicy.authorizeUrl}. */
export interface UrlAuthorization {
  /** `allow`: navigation may proceed. `ask`: needs an explicit user approval first. `block`: refused. */
  decision: 'allow' | 'ask' | 'block'
  /** Stable error/status code (`NEED_AUTHORIZATION`, `WEB_*`); undefined when allowed. */
  code?: string
  /** Human message describing the decision. */
  reason: string
  /** Normalized target host the decision refers to. */
  host: string
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

/** Normalize one allow/deny entry keeping a leading `*.` wildcard intact. */
function normalizeEntry(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (value.startsWith('*.')) return '*.' + normalizeHostname(value.slice(2))
  return normalizeHostname(value)
}

/** Match a normalized host against exact entries and `*.suffix` wildcards. */
function entryMatches(host: string, entries: readonly string[]): boolean {
  for (const entry of entries) {
    if (entry.startsWith('*.')) {
      if (host.endsWith(entry.slice(1))) return true
    } else if (entry === host) {
      return true
    }
  }
  return false
}

/**
 * BLOCK-list matching: like {@link entryMatches} but a `*.domain` wildcard
 * also covers the bare apex (`*.baidu.com` matches both `www.baidu.com` and
 * `baidu.com`). Used for deny/metadata lists where the user's intent is "the
 * whole domain is off limits". Allow lists keep {@link entryMatches} strict.
 */
function entryMatchesBlock(host: string, entries: readonly string[]): boolean {
  for (const entry of entries) {
    if (entry.startsWith('*.')) {
      if (host.endsWith(entry.slice(1)) || host === entry.slice(2)) return true
    } else if (entry === host) {
      return true
    }
  }
  return false
}

/** True when an IPv6 address is a loopback form (::1, ::, v4-mapped 127/8). */
function isLoopbackIp6(addr: string): boolean {
  const lower = addr.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('::ffff:7f') || lower === '::7f00:1' || lower === '::ffff:7f00:1') return true
  if (/^0:0:0:0:0:0:7f00:1$/.test(lower)) return true
  return false
}

/**
 * Loopback identity of a host: `localhost` names and every loopback IP map to
 * the single token `loopback`, so 127.0.0.1 / ::1 / ::ffff:127.* / localhost
 * are treated as the SAME target. Non-loopback hosts keep their normalized
 * hostname.
 */
function loopbackIdentity(host: string): string {
  if (host === 'localhost' || host === 'localhost.localdomain' || host === 'ip6-localhost') return 'loopback'
  const family = isIP(host)
  if (family !== 0) {
    if (family === 4) {
      const first = Number(host.split('.')[0])
      if (first === 127) return 'loopback'
    } else if (isLoopbackIp6(host)) {
      return 'loopback'
    }
  }
  return host
}

/** Is `host` a loopback-equivalent literal/name (no DNS needed)? */
function isLoopbackHost(host: string): boolean {
  return loopbackIdentity(host) === 'loopback'
}

/**
 * Parse one dsh-origin rule into {proto ('http'|'https'|'*'), canon, port}
 * where canon is the loopback identity and port is a number or '*'.
 */
function parseOriginRule(rule: string): { proto: string; canon: string; port: string } | null {
  let proto = '*'
  let rest = rule
  const schemeIdx = rule.indexOf('://')
  if (schemeIdx !== -1) {
    proto = rule.slice(0, schemeIdx)
    rest = rule.slice(schemeIdx + 3)
  }
  let hostPart = rest
  let port = ''
  const colon = rest.lastIndexOf(':')
  if (colon !== -1 && rest.indexOf(']') < colon) {
    hostPart = rest.slice(0, colon)
    port = rest.slice(colon + 1)
  }
  if (hostPart.length === 0) return null
  const canon = loopbackIdentity(normalizeHostname(hostPart))
  if (canon.length === 0) return null
  return { proto, canon, port: port === '' ? (proto === 'https' ? '443' : proto === 'http' ? '80' : '*') : port }
}

/** Arm check: does the dsh rule list target any loopback endpoint? */
function originRulesContainLoopback(rules: readonly string[]): boolean {
  for (const rule of rules) {
    const parsed = parseOriginRule(rule)
    if (parsed && parsed.canon === 'loopback') return true
  }
  return false
}

/**
 * Classify a normalized host into its realm:
 * - `local`: loopback literals and localhost names (the machine itself);
 * - `lan`: other private/ULA/link-local/fake-ip literals and local-only
 *   suffixes (.local/.lan/.internal/…);
 * - `internet`: everything else.
 * Hostnames that only resolve to private addresses are not classified here
 * (DNS is only consulted in public mode) — documented approximation.
 */
export function realmOf(host: string): Realm {
  const family = isIP(host)
  if (family !== 0) {
    if (family === 4) {
      const parts = host.split('.')
      const a = Number(parts[0])
      if (a === 127) return 'local' // loopback 127/8
    } else if (isLoopbackIp6(host)) {
      return 'local'
    }
    return isPrivateAddress(host, family) || isFakeIpAddress(host, family) ? 'lan' : 'internet'
  }
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower === 'localhost.localdomain' || lower === 'ip6-localhost') return 'local'
  if (/(^|\.)(local|lan|internal|home|corp|intranet|localhost)(\.|$)/.test(lower)) return 'lan'
  return 'internet'
}

/** Short display name of a realm for policy messages. */
export function realmLabel(realm: Realm): string {
  return realm === 'local' ? 'Local' : realm === 'lan' ? 'LAN' : 'Internet'
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
    const hosts = (options.metadataHostnames ?? DEFAULT_METADATA_HOSTNAMES).map(normalizeEntry).filter((h) => h.length > 0)
    const ips = normalizeList(options.metadataIps, DEFAULT_METADATA_IPS)
    if (entryMatchesBlock(host, hosts) || ips.has(host)) return `Cloud metadata endpoint is blocked: ${host}`
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
  private readonly metadataHosts: readonly string[]
  private readonly metadataIps: ReadonlySet<string>
  private readonly internetAccess: RealmAccess
  private readonly lanAccess: RealmAccess
  private readonly localAccess: RealmAccess
  private readonly internetTemp: boolean
  private readonly lanTemp: boolean
  private readonly localTemp: boolean
  private readonly dshAccessEnabled: boolean
  private readonly dshOrigins: readonly string[]
  private readonly allowEntries: readonly string[]
  private readonly denyEntries: readonly string[]
  private readonly resolveDns: boolean

  constructor(options: UrlPolicyOptions) {
    this.mode = options.mode
    this.allowFakeIp = options.allowFakeIp ?? true
    this.allowPrivate = options.allowPrivate ?? false
    this.allowFile = options.allowFile ?? false
    this.blockMetadata = options.blockMetadata ?? true
    this.blocked = options.blockedHostnames ?? (options.mode === 'public' ? DEFAULT_BLOCKED_HOSTNAMES : new Set<string>())
    this.metadataHosts = (options.metadataHostnames ?? DEFAULT_METADATA_HOSTNAMES).map(normalizeEntry).filter((h) => h.length > 0)
    this.metadataIps = normalizeList(options.metadataIps, DEFAULT_METADATA_IPS)
    this.internetAccess = options.internetAccess ?? 'allow'
    this.lanAccess = options.lanAccess ?? 'allow'
    this.localAccess = options.localAccess ?? 'allow'
    this.internetTemp = options.internetTemp ?? true
    this.lanTemp = options.lanTemp ?? true
    this.localTemp = options.localTemp ?? true
    this.dshAccessEnabled = options.dshAccessEnabled ?? false
    this.dshOrigins = (options.dshOrigins ?? []).map((o) => o.trim().toLowerCase()).filter((o) => o.length > 0)
    this.allowEntries = (options.allowHosts ?? []).map(normalizeEntry).filter((entry) => entry.length > 0)
    this.denyEntries = (options.denyHosts ?? []).map(normalizeEntry).filter((entry) => entry.length > 0)
    this.resolveDns = options.resolveDns ?? true
  }

  get isIntranet(): boolean {
    return this.mode === 'intranet'
  }

  /** Verdict for a DSH control-page target: 'allow' when enabled, 'block'
   * when listed but disabled (loopback aliases like localhost/::1/127.0.0.1
   * are treated as the same endpoint), 'none' otherwise. */
  private dshRule(url: URL): 'allow' | 'block' | 'none' {
    if (this.dshOrigins.length === 0) return 'none'
    const proto = url.protocol.slice(0, -1)
    const canon = loopbackIdentity(normalizeHostname(url.hostname))
    const port = url.port === '' ? (proto === 'https' ? '443' : '80') : url.port
    for (const rule of this.dshOrigins) {
      const parsed = parseOriginRule(rule)
      if (!parsed) continue
      if (parsed.proto !== '*' && parsed.proto !== proto) continue
      if (parsed.port !== '*' && parsed.port !== port) continue
      if (parsed.canon !== canon) continue
      return this.dshAccessEnabled ? 'allow' : 'block'
    }
    return 'none'
  }

  /**
   * DNS-based red-line re-check for hostname aliases that only resolve to a
   * protected endpoint (e.g. 127.0.0.1.nip.io → loopback, or an alias of
   * 169.254.169.254 / 100.100.100.200 → cloud metadata). Runs only when a
   * guard is actually armed:
   *  - metadata aliases: whenever `blockMetadata` is on (any port);
   *  - DSH-loopback aliases: when the DSH rule is DISABLED and the origin list
   *    targets a loopback endpoint on the same port as the URL.
   * Ordinary traffic that needs neither guard does no DNS work.
   */
  private async dnsRedlineBlocked(url: URL): Promise<'dsh' | 'metadata' | null> {
    const host = normalizeHostname(url.hostname)
    if (isLoopbackHost(host) || isIP(host) !== 0) return null // literals handled elsewhere
    const proto = url.protocol.slice(0, -1)
    const port = url.port === '' ? (proto === 'https' ? '443' : '80') : url.port
    const guardLoopback = !this.dshAccessEnabled && originRulesContainLoopback(this.dshOrigins)
    let loopbackPortMatch = false
    if (guardLoopback) {
      for (const rule of this.dshOrigins) {
        const parsed = parseOriginRule(rule)
        if (parsed && parsed.canon === 'loopback' && (parsed.port === '*' || parsed.port === port)) {
          loopbackPortMatch = true
          break
        }
      }
    }
    const guardMetadata = this.blockMetadata
    if (!guardMetadata && !loopbackPortMatch) return null
    let resolved
    try {
      resolved = await lookup(host, { all: true })
    } catch {
      return null
    }
    let loopbackHit = false
    for (const entry of resolved) {
      const addr = entry.address
      if (guardMetadata && this.metadataIps.has(addr)) return 'metadata'
      if (!loopbackPortMatch) continue
      if (entry.family === 4) {
        const first = Number(addr.split('.')[0])
        if (first === 127) loopbackHit = true
      } else if (isLoopbackIp6(addr)) {
        loopbackHit = true
      }
    }
    return loopbackHit ? 'dsh' : null
  }

  /** Realm policy of a normalized host. */
  accessFor(host: string): { access: RealmAccess; temp: boolean; realm: Realm } {
    const realm = realmOf(host)
    const access = realm === 'internet' ? this.internetAccess : realm === 'lan' ? this.lanAccess : this.localAccess
    const temp = realm === 'internet' ? this.internetTemp : realm === 'lan' ? this.lanTemp : this.localTemp
    return { realm, access, temp }
  }

  /** Whether a host is currently granted through the persistent allow list. */
  isAllowlisted(host: string): boolean {
    return entryMatches(host, this.allowEntries)
  }

  private denyBlocked(host: string): boolean {
    return entryMatchesBlock(host, this.denyEntries)
  }

  /**
   * Authorize one navigation target. Returns an explicit verdict instead of
   * throwing:
   * - `block`: refused unconditionally (routing stance, blocklist, metadata,
   *   denied hosts, embedded credentials…);
   * - `allow`: routing stance permits the target and (ask mode) the host is on
   *   the allow list;
   * - `ask`: routing permits the target but authorization is `ask` and the
   *   host needs an explicit user approval first.
   * No browser state is touched; callers decide how to surface `ask`
   * (approval prompt, temp session grant, tool guidance…).
   */
  async authorizeUrl(raw: string): Promise<UrlAuthorization> {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return { decision: 'block', code: 'WEB_INVALID_URL', reason: `Invalid URL: ${raw}`, host: '' }
    }
    const schemeOk = url.protocol === 'http:' || url.protocol === 'https:' || (this.allowFile && url.protocol === 'file:')
    if (!schemeOk) {
      return {
        decision: 'block',
        code: 'WEB_INVALID_URL',
        reason: `Only http(s)${this.allowFile ? ' and file' : ''} URLs are allowed: ${raw}`,
        host: '',
      }
    }
    if (url.username || url.password) {
      return { decision: 'block', code: 'WEB_BLOCKED_URL', reason: 'URLs with embedded credentials are blocked', host: '' }
    }
    const host = normalizeHostname(url.hostname)
    if (this.denyBlocked(host)) {
      return { decision: 'block', code: 'WEB_BLOCKED_URL', reason: `Hostname is denied by configuration: ${host}`, host }
    }
    const reason = blockReasonForUrl(url, {
      blockMetadata: this.blockMetadata,
      metadataHostnames: [...this.metadataHosts],
      metadataIps: [...this.metadataIps],
    })
    if (reason) return { decision: 'block', code: 'WEB_BLOCKED_URL', reason, host }

    // --- DSH-page special rule: listed control-page origins are only
    // reachable while explicitly enabled; while disabled they are refused so
    // the model cannot silently reach the harness control page.
    const dshRule = this.dshRule(url)
    if (dshRule === 'allow') return { decision: 'allow', reason: '', host }
    if (dshRule === 'block') {
      return {
        decision: 'block',
        code: 'WEB_DSH_DISABLED',
        reason: `DSH control-page access is disabled (enable “允许访问本 DSH 页面”): ${url.origin}`,
        host,
      }
    }
    // DNS re-check for aliases resolving to red-line endpoints (disabled DSH
    // loopback, cloud-metadata IPs) while the relevant guard is armed.
    const dnsHit = await this.dnsRedlineBlocked(url)
    if (dnsHit !== null) {
      return {
        decision: 'block',
        code: dnsHit === 'metadata' ? 'WEB_BLOCKED_URL' : 'WEB_DSH_DISABLED',
        reason: dnsHit === 'metadata'
          ? `Cloud metadata endpoint is blocked (hostname resolves to a metadata address): ${url.host}`
          : `DSH control-page access is disabled — target resolves to the protected loopback endpoint: ${url.host}`,
        host,
      }
    }
    // Default routing blocklist (public mode: localhost etc.) — applied after
    // the DSH rule so an explicit DSH enable may reach it, but not on red
    // lines above (denyHosts / metadata / credentials) which stay absolute.
    if (this.blocked.has(host)) {
      return { decision: 'block', code: 'WEB_BLOCKED_URL', reason: `Hostname is blocked: ${host}`, host }
    }

    // --- routing stance (public: literal + DNS screening) ---
    if (this.mode === 'public' && !this.allowPrivate) {
      const literalFamily = isIP(host)
      if (literalFamily !== 0) {
        if (this.blockedAsPrivate(host, literalFamily)) {
          return { decision: 'block', code: 'WEB_PRIVATE_TARGET', reason: `Non-public IP literal is blocked: ${host}`, host }
        }
      } else if (this.resolveDns) {
        let resolved
        try {
          resolved = await lookup(host, { all: true })
        } catch {
          return {
            decision: 'block',
            code: 'WEB_PROVIDER_ERROR',
            reason: `DNS resolution failed for ${host}`,
            host,
          }
        }
        for (const entry of resolved) {
          if (this.blockedAsPrivate(entry.address, entry.family)) {
            return {
              decision: 'block',
              code: 'WEB_PRIVATE_TARGET',
              reason: `Hostname resolves to a non-public address: ${host}`,
              host,
            }
          }
        }
      }
    }

    // --- authorization layer: per-realm allow / ask / deny (skipped for
    // granted DSH origins above) ---
    const realmPolicy = this.accessFor(host)
    if (realmPolicy.access === 'deny') {
      return {
        decision: 'block',
        code: 'WEB_REALM_DENIED',
        reason: `${realmLabel(realmPolicy.realm)} access is denied by policy: ${host}`,
        host,
      }
    }
    if (realmPolicy.access === 'ask' && !this.isAllowlisted(host)) {
      return {
        decision: 'ask',
        code: 'NEED_AUTHORIZATION',
        reason: `Host requires user authorization before access: ${host}`
          + (realmPolicy.temp ? '' : ` (this realm does not allow temporary grants — add the host to allowHosts instead)`),
        host,
      }
    }
    return { decision: 'allow', reason: '', host }
  }

  /**
   * Validate `raw` for a navigation — the ROUTE-ONLY gate used by
   * GuardedBridge. Public mode: http(s) only, no embedded credentials,
   * default-hostname blocklist, deny list, IP-literal screening and (unless
   * disabled) resolve-then-validate DNS. Intranet mode: http(s) (+file), no
   * credentials, and only the metadata/extras/deny blocklist — private and
   * loopback targets are intentionally allowed (that is the point of the
   * intranet mode). The authorization layer (ask/allow lists) intentionally
   * lives OUTSIDE this gate: tools decide how to surface `ask` (approval +
   * session grant) before the bridge ever sees the command.
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
    if (this.denyBlocked(host)) {
      throw new UrlPolicyError('WEB_BLOCKED_URL', `Hostname is denied by configuration: ${host}`)
    }
    const reason = blockReasonForUrl(url, {
      blockMetadata: this.blockMetadata,
      metadataHostnames: [...this.metadataHosts],
      metadataIps: [...this.metadataIps],
    })
    if (reason) throw new UrlPolicyError('WEB_BLOCKED_URL', reason)
    const dshRule = this.dshRule(url)
    if (dshRule === 'allow') return url
    if (dshRule === 'block') {
      throw new UrlPolicyError('WEB_DSH_DISABLED', `DSH control-page access is disabled (enable “允许访问本 DSH 页面”): ${url.origin}`)
    }
    if (await this.dnsRedlineBlocked(url)) {
      throw new UrlPolicyError('WEB_DSH_DISABLED', `Access disabled — target resolves to a protected endpoint (DSH loopback or cloud metadata): ${url.host}`)
    }
    if (this.blocked.has(host)) {
      throw new UrlPolicyError('WEB_BLOCKED_URL', `Hostname is blocked: ${host}`)
    }
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
