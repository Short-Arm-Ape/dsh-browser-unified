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
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
/** Stable error code + human message; callers (tools) surface `code` to the model. */
export class UrlPolicyError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = 'UrlPolicyError';
    }
}
/**
 * Default cloud-metadata hostnames (upstream list) — kept blocked even in
 * intranet mode. This is only the *initial value*: pass your own
 * `metadataHostnames` to {@link UrlPolicy} (or `browser-bridge` settings) to
 * fully replace it, e.g. for non-AWS/GCP/Azure clouds or private deployments.
 */
export const DEFAULT_METADATA_HOSTNAMES = [
    'metadata',
    'metadata.google.internal',
    'instance-data',
    'instance-data.ec2.internal',
    'metadata.azure.internal',
    'metadata.tencentyun.com',
];
/**
 * Default cloud-metadata IP literals (AWS/GCP/Azure 169.254.169.254, Alibaba
 * 100.100.100.200, AWS IMDSv2 IPv6). Initial value only — replace via
 * `metadataIps` for full control.
 */
export const DEFAULT_METADATA_IPS = [
    '169.254.169.254', // AWS / GCP / Azure instance metadata
    '100.100.100.200', // Alibaba Cloud
    'fd00:ec2::254', // AWS IMDSv2 IPv6
];
/** Back-compat aliases kept for existing consumers (values equal the defaults above). */
export const METADATA_HOSTNAMES = new Set(DEFAULT_METADATA_HOSTNAMES);
export const METADATA_IPS = new Set(DEFAULT_METADATA_IPS);
/** Hostnames blocked before any other check in public mode (upstream default set). */
const DEFAULT_BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'metadata',
    'metadata.google.internal',
]);
/**
 * Normalize a hostname for blocklist matching: strip IPv6 brackets, lowercase,
 * drop trailing dots, and map IPv4-mapped IPv6 tails back to dotted quad.
 */
export function normalizeHostname(raw) {
    let host = raw.replace(/^\[|\]$/g, '').toLowerCase();
    while (host.endsWith('.'))
        host = host.slice(0, -1);
    if (host.startsWith('::ffff:')) {
        const v4 = ipv6TailToIpv4(host.slice('::ffff:'.length));
        if (v4)
            return v4;
    }
    return host;
}
function ipv6TailToIpv4(tail) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail))
        return tail;
    const parts = tail.split(':');
    if (parts.length > 2)
        return null;
    let hex = '';
    for (const part of parts) {
        if (!/^[0-9a-f]{1,4}$/.test(part))
            return null;
        hex += part.padStart(4, '0');
    }
    if (hex.length !== 8)
        return null;
    const n = Number.parseInt(hex, 16);
    return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}
/** True when an IPv4 literal is private / loopback / link-local / multicast / reserved. */
export function isPrivateIPv4(addr) {
    const parts = addr.split('.');
    if (parts.length !== 4)
        return true; // fail-safe on malformed input
    const octets = parts.map((p) => Number(p));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
        return true;
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127)
        return true;
    if (a === 100 && b >= 64 && b <= 127)
        return true; // CGNAT 100.64/10
    if (a === 169 && b === 254)
        return true; // link-local
    if (a === 172 && b >= 16 && b <= 31)
        return true; // 172.16/12
    if (a === 192 && b === 168)
        return true; // 192.168/16
    if (a === 192 && b === 0 && (c === 0 || c === 2))
        return true; // IETF / TEST-NET-1
    if (a === 198 && (b === 18 || b === 19))
        return true; // benchmark / proxy fake-ip range
    if (a === 198 && b === 51 && c === 100)
        return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113)
        return true; // TEST-NET-3
    if (a >= 224)
        return true; // multicast + reserved 240/4
    return false;
}
/** True only for the Clash/Surge/mihomo fake-ip pool 198.18.0.0/15. */
export function isFakeIpIPv4(addr) {
    const parts = addr.split('.');
    if (parts.length !== 4)
        return false;
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    return a === 198 && (b === 18 || b === 19);
}
/** True when an IPv6 address is loopback, ULA, link-local, multicast, or mapped to a private v4. */
export function isPrivateIPv6(addr) {
    const lower = addr.toLowerCase();
    if (lower === '::' || lower === '::1')
        return true;
    if (lower.startsWith('fc') || lower.startsWith('fd'))
        return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(lower))
        return true; // link-local fe80::/10
    if (lower.startsWith('ff'))
        return true; // multicast
    if (lower.startsWith('2001:db8'))
        return true; // documentation
    if (lower.startsWith('::ffff:'))
        return isPrivateIPv4(lower.slice('::ffff:'.length));
    return false;
}
function isPrivateAddress(addr, family) {
    return family === 4 ? isPrivateIPv4(addr) : isPrivateIPv6(addr);
}
function isFakeIpAddress(addr, family) {
    if (family === 4)
        return isFakeIpIPv4(addr);
    if (family === 6) {
        const lower = addr.toLowerCase();
        if (lower.startsWith('::ffff:'))
            return isFakeIpIPv4(lower.slice('::ffff:'.length));
    }
    return false;
}
/** Normalize every entry of a configured metadata list for membership checks. */
function normalizeList(entries, fallback) {
    return new Set((entries ?? fallback).map((entry) => normalizeHostname(entry)).filter((host) => host.length > 0));
}
/** Normalize one allow/deny entry keeping a leading `*.` wildcard intact. */
function normalizeEntry(raw) {
    const value = raw.trim().toLowerCase();
    if (value.startsWith('*.'))
        return '*.' + normalizeHostname(value.slice(2));
    return normalizeHostname(value);
}
/** Match a normalized host against exact entries and `*.suffix` wildcards. */
function entryMatches(host, entries) {
    for (const entry of entries) {
        if (entry.startsWith('*.')) {
            if (host.endsWith(entry.slice(1)))
                return true;
        }
        else if (entry === host) {
            return true;
        }
    }
    return false;
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
export function realmOf(host) {
    const family = isIP(host);
    if (family !== 0) {
        if (family === 4) {
            const parts = host.split('.');
            const a = Number(parts[0]);
            if (a === 127)
                return 'local'; // loopback 127/8
        }
        else if (host === '::1' || host === '::') {
            return 'local';
        }
        return isPrivateAddress(host, family) || isFakeIpAddress(host, family) ? 'lan' : 'internet';
    }
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower === 'localhost.localdomain' || lower === 'ip6-localhost')
        return 'local';
    if (/(^|\.)(local|lan|internal|home|corp|intranet|localhost)(\.|$)/.test(lower))
        return 'lan';
    return 'internet';
}
/** Short display name of a realm for policy messages. */
export function realmLabel(realm) {
    return realm === 'local' ? 'Local' : realm === 'lan' ? 'LAN' : 'Internet';
}
/**
 * Host-level blocklist usable against ANY request URL (navigation, redirects,
 * subresources). Invalid URLs fail open here — the strict navigation check is
 * the caller's safety net for the initial `goto`.
 */
export function blockReasonForUrl(raw, options = {}) {
    let url;
    try {
        url = typeof raw === 'string' ? new URL(raw) : raw;
    }
    catch {
        return null;
    }
    const host = normalizeHostname(url.hostname);
    const extra = options.blockedHostnames ?? new Set();
    if (extra.has(host))
        return `Hostname is blocked by configuration: ${host}`;
    if (options.blockMetadata ?? true) {
        const hosts = normalizeList(options.metadataHostnames, DEFAULT_METADATA_HOSTNAMES);
        const ips = normalizeList(options.metadataIps, DEFAULT_METADATA_IPS);
        if (hosts.has(host) || ips.has(host))
            return `Cloud metadata endpoint is blocked: ${host}`;
    }
    return null;
}
/** One policy instance: `mode` selects how strict `assertUsableUrl` is. */
export class UrlPolicy {
    mode;
    allowFakeIp;
    allowPrivate;
    allowFile;
    blockMetadata;
    blocked;
    metadataHosts;
    metadataIps;
    internetAccess;
    lanAccess;
    localAccess;
    internetTemp;
    lanTemp;
    localTemp;
    dshAccessEnabled;
    dshOrigins;
    allowEntries;
    denyEntries;
    resolveDns;
    constructor(options) {
        this.mode = options.mode;
        this.allowFakeIp = options.allowFakeIp ?? true;
        this.allowPrivate = options.allowPrivate ?? false;
        this.allowFile = options.allowFile ?? false;
        this.blockMetadata = options.blockMetadata ?? true;
        this.blocked = options.blockedHostnames ?? (options.mode === 'public' ? DEFAULT_BLOCKED_HOSTNAMES : new Set());
        this.metadataHosts = normalizeList(options.metadataHostnames, DEFAULT_METADATA_HOSTNAMES);
        this.metadataIps = normalizeList(options.metadataIps, DEFAULT_METADATA_IPS);
        this.internetAccess = options.internetAccess ?? 'allow';
        this.lanAccess = options.lanAccess ?? 'allow';
        this.localAccess = options.localAccess ?? 'allow';
        this.internetTemp = options.internetTemp ?? true;
        this.lanTemp = options.lanTemp ?? true;
        this.localTemp = options.localTemp ?? true;
        this.dshAccessEnabled = options.dshAccessEnabled ?? false;
        this.dshOrigins = (options.dshOrigins ?? []).map((o) => o.trim().toLowerCase()).filter((o) => o.length > 0);
        this.allowEntries = (options.allowHosts ?? []).map(normalizeEntry).filter((entry) => entry.length > 0);
        this.denyEntries = (options.denyHosts ?? []).map(normalizeEntry).filter((entry) => entry.length > 0);
        this.resolveDns = options.resolveDns ?? true;
    }
    get isIntranet() {
        return this.mode === 'intranet';
    }
    /** Whether the origin of `url` is explicitly granted as a DSH control page. */
    dshGranted(url) {
        if (!this.dshAccessEnabled || this.dshOrigins.length === 0)
            return false;
        const origin = url.origin.toLowerCase();
        for (const rule of this.dshOrigins) {
            if (rule === origin)
                return true;
            // `host:*` style: allow any port of the same scheme+host.
            if (rule.endsWith(':*') && origin.startsWith(rule.slice(0, -1)))
                return true;
        }
        return false;
    }
    /** Realm policy of a normalized host. */
    accessFor(host) {
        const realm = realmOf(host);
        const access = realm === 'internet' ? this.internetAccess : realm === 'lan' ? this.lanAccess : this.localAccess;
        const temp = realm === 'internet' ? this.internetTemp : realm === 'lan' ? this.lanTemp : this.localTemp;
        return { realm, access, temp };
    }
    /** Whether a host is currently granted through the persistent allow list. */
    isAllowlisted(host) {
        return entryMatches(host, this.allowEntries);
    }
    denyBlocked(host) {
        return entryMatches(host, this.denyEntries);
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
    async authorizeUrl(raw) {
        let url;
        try {
            url = new URL(raw);
        }
        catch {
            return { decision: 'block', code: 'WEB_INVALID_URL', reason: `Invalid URL: ${raw}`, host: '' };
        }
        const schemeOk = url.protocol === 'http:' || url.protocol === 'https:' || (this.allowFile && url.protocol === 'file:');
        if (!schemeOk) {
            return {
                decision: 'block',
                code: 'WEB_INVALID_URL',
                reason: `Only http(s)${this.allowFile ? ' and file' : ''} URLs are allowed: ${raw}`,
                host: '',
            };
        }
        if (url.username || url.password) {
            return { decision: 'block', code: 'WEB_BLOCKED_URL', reason: 'URLs with embedded credentials are blocked', host: '' };
        }
        const host = normalizeHostname(url.hostname);
        if (this.blocked.has(host)) {
            return { decision: 'block', code: 'WEB_BLOCKED_URL', reason: `Hostname is blocked: ${host}`, host };
        }
        if (this.denyBlocked(host)) {
            return { decision: 'block', code: 'WEB_BLOCKED_URL', reason: `Hostname is denied by configuration: ${host}`, host };
        }
        const reason = blockReasonForUrl(url, {
            blockMetadata: this.blockMetadata,
            blockedHostnames: this.blocked,
            metadataHostnames: [...this.metadataHosts],
            metadataIps: [...this.metadataIps],
        });
        if (reason)
            return { decision: 'block', code: 'WEB_BLOCKED_URL', reason, host };
        // --- DSH-page special rule (explicit user opt-in, double-warned in GUI):
        // granted origins bypass the routing stance and the realm ask/deny layer.
        if (this.dshGranted(url))
            return { decision: 'allow', reason: '', host };
        // --- routing stance (public: literal + DNS screening) ---
        if (this.mode === 'public' && !this.allowPrivate) {
            const literalFamily = isIP(host);
            if (literalFamily !== 0) {
                if (this.blockedAsPrivate(host, literalFamily)) {
                    return { decision: 'block', code: 'WEB_PRIVATE_TARGET', reason: `Non-public IP literal is blocked: ${host}`, host };
                }
            }
            else if (this.resolveDns) {
                let resolved;
                try {
                    resolved = await lookup(host, { all: true });
                }
                catch {
                    return {
                        decision: 'block',
                        code: 'WEB_PROVIDER_ERROR',
                        reason: `DNS resolution failed for ${host}`,
                        host,
                    };
                }
                for (const entry of resolved) {
                    if (this.blockedAsPrivate(entry.address, entry.family)) {
                        return {
                            decision: 'block',
                            code: 'WEB_PRIVATE_TARGET',
                            reason: `Hostname resolves to a non-public address: ${host}`,
                            host,
                        };
                    }
                }
            }
        }
        // --- authorization layer: per-realm allow / ask / deny (skipped for
        // granted DSH origins above) ---
        const realmPolicy = this.accessFor(host);
        if (realmPolicy.access === 'deny') {
            return {
                decision: 'block',
                code: 'WEB_REALM_DENIED',
                reason: `${realmLabel(realmPolicy.realm)} access is denied by policy: ${host}`,
                host,
            };
        }
        if (realmPolicy.access === 'ask' && !this.isAllowlisted(host)) {
            return {
                decision: 'ask',
                code: 'NEED_AUTHORIZATION',
                reason: `Host requires user authorization before access: ${host}`
                    + (realmPolicy.temp ? '' : ` (this realm does not allow temporary grants — add the host to allowHosts instead)`),
                host,
            };
        }
        return { decision: 'allow', reason: '', host };
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
    async assertUsableUrl(raw) {
        let url;
        try {
            url = new URL(raw);
        }
        catch {
            throw new UrlPolicyError('WEB_INVALID_URL', `Invalid URL: ${raw}`);
        }
        const schemeOk = url.protocol === 'http:' || url.protocol === 'https:' || (this.allowFile && url.protocol === 'file:');
        if (!schemeOk) {
            throw new UrlPolicyError('WEB_INVALID_URL', `Only http(s)${this.allowFile ? ' and file' : ''} URLs are allowed: ${raw}`);
        }
        if (url.username || url.password) {
            throw new UrlPolicyError('WEB_BLOCKED_URL', 'URLs with embedded credentials are blocked');
        }
        const host = normalizeHostname(url.hostname);
        if (this.blocked.has(host)) {
            throw new UrlPolicyError('WEB_BLOCKED_URL', `Hostname is blocked: ${host}`);
        }
        if (this.denyBlocked(host)) {
            throw new UrlPolicyError('WEB_BLOCKED_URL', `Hostname is denied by configuration: ${host}`);
        }
        const reason = blockReasonForUrl(url, {
            blockMetadata: this.blockMetadata,
            blockedHostnames: this.blocked,
            metadataHostnames: [...this.metadataHosts],
            metadataIps: [...this.metadataIps],
        });
        if (reason)
            throw new UrlPolicyError('WEB_BLOCKED_URL', reason);
        if (this.dshGranted(url))
            return url;
        if (this.mode === 'intranet')
            return url;
        if (this.allowPrivate)
            return url;
        // --- public mode: literal + DNS screening (resolve-then-validate) ---
        const literalFamily = isIP(host);
        if (literalFamily !== 0) {
            if (this.blockedAsPrivate(host, literalFamily)) {
                throw new UrlPolicyError('WEB_PRIVATE_TARGET', `Non-public IP literal is blocked: ${host}`);
            }
            return url;
        }
        if (!this.resolveDns)
            return url;
        let resolved;
        try {
            resolved = await lookup(host, { all: true });
        }
        catch (cause) {
            throw new UrlPolicyError('WEB_PROVIDER_ERROR', `DNS resolution failed for ${host}`, { cause });
        }
        for (const entry of resolved) {
            if (this.blockedAsPrivate(entry.address, entry.family)) {
                throw new UrlPolicyError('WEB_PRIVATE_TARGET', `Hostname resolves to a non-public address: ${host}`);
            }
        }
        return url;
    }
    blockedAsPrivate(addr, family) {
        if (!isPrivateAddress(addr, family))
            return false;
        if (this.allowFakeIp && isFakeIpAddress(addr, family))
            return false;
        return true;
    }
}
