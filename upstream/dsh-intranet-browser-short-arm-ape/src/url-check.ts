/**
 * URL policy for the intranet/local debugging browser.
 *
 * This is the ONE place the SSRF guard is deliberately relaxed: the standalone
 * intranet instance performs no private-IP screening (localhost, 10/8,
 * 192.168/16, link-local, ULA, … are all allowed) so local and LAN debugging
 * works. The ONLY safety net kept by default is the cloud-metadata blocklist
 * (169.254.169.254, `metadata.google.internal`, …), which stays on unless the
 * operator explicitly disables it. The original browser instance
 * (`browser-playwright`) is NOT affected — it keeps its strict url-guard.
 *
 * The blocklist is enforced in two places:
 *  1. `assertUsableUrl` — the initial navigation URL, before `page.goto`.
 *  2. `blockReasonForUrl` — every request of the browser context, via a
 *     context-level route handler, so redirect targets, XHR/fetch, iframes and
 *     other subresources are covered too (a 302 from an approved page onto a
 *     metadata endpoint is aborted before it loads).
 *
 * Every URL that passes is still routed through the plugin's approval gate
 * (see gate.ts) before any navigation happens.
 *
 * @module dsh-intranet-browser/url-check
 */

export class IntranetUrlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'IntranetUrlError'
  }
}

/** Cloud-metadata hostnames blocked by default even though SSRF protection is bypassed. */
export const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.internal', // Azure IMDS hostname
  'metadata.tencentyun.com', // Tencent Cloud metadata
])

/** Cloud-metadata IP literals blocked by default. */
export const METADATA_IPS: ReadonlySet<string> = new Set([
  '169.254.169.254', // AWS / GCP / Azure instance metadata
  '100.100.100.200', // Alibaba Cloud instance metadata
  'fd00:ec2::254', // AWS IMDSv2 IPv6
])

export interface IntranetUrlOptions {
  /** Allow `file://` URLs in addition to http(s). Defaults to `false`. */
  allowFile?: boolean
  /**
   * Keep blocking cloud-metadata endpoints even though SSRF protection is
   * bypassed. Defaults to `true`; flip to `false` only on networks you fully
   * control (e.g. a cloud VM where the metadata service is the point of the
   * test).
   */
  blockMetadata?: boolean
  /** Extra hostnames or IP literals that are always blocked. Defaults to none. */
  blockedHostnames?: ReadonlySet<string>
}

/**
 * Normalize a hostname for blocklist matching:
 * - strips IPv6 brackets and lowercases,
 * - strips trailing dots (FQDN root form, e.g. `metadata.google.internal.`),
 * - maps IPv4-mapped IPv6 literals back to their embedded IPv4 dotted quad
 *   (the WHATWG URL parser renders `[::ffff:169.254.169.254]` as the hex form
 *   `::ffff:a9fe:a9fe`, which a literal match would miss).
 *
 * Integer / hex / octal IPv4 variants (e.g. `http://2852039166/`) are already
 * normalized to dotted-quad form by the URL parser itself, so they match here
 * with no extra work.
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

/** Interpret the tail of an IPv4-mapped IPv6 literal as a dotted quad. */
function ipv6TailToIpv4(tail: string): string | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail
  // Tail is 1-2 16-bit groups (e.g. `a9fe:a9fe` or `7f00:1` for 127.0.0.1);
  // pad each group to 4 hex digits so the concatenation is the full 32 bits.
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

/**
 * Blocklist check usable against ANY request URL (navigation, redirect target,
 * subresource). Returns a human-readable reason when the request must be
 * blocked, or `null` when it may proceed. Invalid URLs fail open (the strict
 * navigation check still covers the initial `goto`).
 */
export function blockReasonForUrl(raw: string | URL, options: IntranetUrlOptions = {}): string | null {
  let url: URL
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw
  } catch {
    return null
  }
  const host = normalizeHostname(url.hostname)
  const extra = options.blockedHostnames ?? new Set<string>()
  if (extra.has(host)) {
    return `Hostname is blocked by intranet-browser config: ${host}`
  }
  if ((options.blockMetadata ?? true) && (METADATA_HOSTNAMES.has(host) || METADATA_IPS.has(host))) {
    return `Cloud metadata endpoint is blocked: ${host}`
  }
  return null
}

export interface IntranetUrlCheck {
  /**
   * Validate `raw` for the intranet browser: http(s) (optionally file) only,
   * no embedded credentials, and no metadata endpoint unless disabled.
   * @throws {IntranetUrlError} with a stable `code` when the URL is unusable.
   */
  assertUsableUrl(raw: string): URL
}

/** Build a permissive-but-not-naked URL check for the intranet browser. */
export function createIntranetUrlCheck(options: IntranetUrlOptions = {}): IntranetUrlCheck {
  const allowFile = options.allowFile ?? false

  function parse(raw: string): URL {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new IntranetUrlError('WEB_INVALID_URL', `Invalid URL: ${raw}`)
    }
    const schemeOk = url.protocol === 'http:' || url.protocol === 'https:' || (allowFile && url.protocol === 'file:')
    if (!schemeOk) {
      throw new IntranetUrlError(
        'WEB_INVALID_URL',
        `Only http(s)${allowFile ? ' and file' : ''} URLs are allowed: ${raw}`,
      )
    }
    if (url.username || url.password) {
      throw new IntranetUrlError('WEB_BLOCKED_URL', 'URLs with embedded credentials are blocked')
    }
    return url
  }

  return {
    assertUsableUrl(raw: string): URL {
      const url = parse(raw)
      const reason = blockReasonForUrl(url, options)
      if (reason) throw new IntranetUrlError('WEB_BLOCKED_URL', reason)
      return url
    },
  }
}
