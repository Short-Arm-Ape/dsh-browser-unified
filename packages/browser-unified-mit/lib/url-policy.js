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
import { lookup, resolve4, resolve6 } from 'node:dns/promises';
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
/** de-018 preset table: 'public' = internet-only defaults; 'intranet' = all realms allowed. */
export function presetForMode(mode) {
    return mode === 'intranet'
        ? { internet: 'allow', lan: 'allow', local: 'allow' }
        : { internet: 'allow', lan: 'deny', local: 'deny' };
}
/**
 * de-018: resolve one realm's effective access. An explicit user realm value
 * wins; otherwise the mode preset default applies (so urlMode becomes a
 * preset, not a second hard gate).
 */
export function resolveRealmAccess(option, mode, realm) {
    if (option !== undefined)
        return option;
    return presetForMode(mode)[realm];
}
/**
 * de-018: realm of one resolved address. Fake-ip answers (Clash/Surge/mihomo)
 * count as `internet` while `allowFakeIp` is on — that is what keeps proxy
 * setups working once private/loopback are no longer hard-blocked by routing.
 */
export function addressRealm(addr, family, allowFakeIp) {
    const lower = addr.toLowerCase();
    if (family === 4) {
        if (Number(addr.split('.')[0]) === 127)
            return 'local';
        if (isFakeIpAddress(addr, family))
            return allowFakeIp ? 'internet' : 'lan';
        return isPrivateAddress(addr, family) ? 'lan' : 'internet';
    }
    if (isLoopbackIp6(lower))
        return 'local';
    if (isFakeIpAddress(lower, family))
        return allowFakeIp ? 'internet' : 'lan';
    return isPrivateAddress(lower, family) ? 'lan' : 'internet';
}
/** Pure DNS answers (A+AAAA) for `host`, bypassing /etc/hosts overrides. */
async function pureDnsAnswers(host) {
    const [a4, a6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
    const answers = [];
    if (a4.status === 'fulfilled')
        for (const address of a4.value)
            answers.push({ address, family: 4 });
    if (a6.status === 'fulfilled')
        for (const address of a6.value)
            answers.push({ address, family: 6 });
    return answers;
}
/** Hosts-aware answers for `host` ([] on failure). */
async function lookupHosts(host) {
    try {
        return await lookup(host, { all: true });
    }
    catch {
        return [];
    }
}
/**
 * Addresses used by /etc/hosts block lists to "blackhole" a domain:
 * 127.0.0.0/8, 0.0.0.0, ::1 and ::. A name pinned to one of these is being
 * blocked at the OS level, not served by a local endpoint.
 */
function isBlackholeAddress(addr, family) {
    if (family === 4) {
        const first = Number(addr.split('.')[0]);
        return first === 127 || first === 0;
    }
    const lower = addr.toLowerCase();
    return lower === '::' || lower === '::1' || lower.startsWith('::ffff:7f');
}
/**
 * de-018: classify a host into a realm, resolving hostnames when asked. For a
 * hostname the "most local" answer wins (any loopback answer → local, else
 * any LAN answer → lan, else internet), matching the old any-private-block
 * conservatism. DNS failure surfaces `unresolved` instead of guessing.
 *
 * Resolution is pure-DNS first: `/etc/hosts` block lists routinely pin *public*
 * domains (github.com, google.com, …) to 127.0.0.1 / 0.0.0.0 to cut them off
 * at the OS level — that machine-local override is NOT evidence the name is a
 * local service, and the browser being driven may well resolve it normally.
 * Only when pure DNS answers nothing (hosts-only / offline setups) do we
 * consult the hosts file, and answers that are all block-list blackholes for a
 * non-local-spelled name are still treated as internet, never as `local`/`lan`.
 */
export async function classifyHostRealm(host, options) {
    const family = isIP(host);
    if (family !== 0) {
        return { realm: addressRealm(host, family, options.allowFakeIp), unresolved: false };
    }
    if (!options.resolveDns) {
        // Without DNS we can only trust local-only spellings; treat as internet.
        return { realm: realmOf(host) === 'local' ? 'local' : realmOf(host) === 'lan' ? 'lan' : 'internet', unresolved: false };
    }
    const spelling = realmOf(host) === 'local' ? 'local' : realmOf(host) === 'lan' ? 'lan' : 'internet';
    if (spelling !== 'internet') {
        // Explicit local-only spelling (localhost / *.local / *.lan / …): no DNS needed.
        return { realm: spelling, unresolved: false };
    }
    const dnsAnswers = await pureDnsAnswers(host);
    if (dnsAnswers.length > 0) {
        let local = false;
        let lan = false;
        for (const entry of dnsAnswers) {
            const r = addressRealm(entry.address, entry.family, options.allowFakeIp);
            if (r === 'local')
                local = true;
            else if (r === 'lan')
                lan = true;
        }
        return { realm: local ? 'local' : lan ? 'lan' : 'internet', unresolved: false };
    }
    // Pure DNS answered nothing → hosts-only / offline fallback.
    const hostsAnswers = await lookupHosts(host);
    if (hostsAnswers.length === 0)
        return { realm: 'internet', unresolved: true };
    let hostLocal = false;
    let hostLan = false;
    let nonBlackhole = false;
    for (const entry of hostsAnswers) {
        if (isBlackholeAddress(entry.address, entry.family))
            continue;
        nonBlackhole = true;
        const r = addressRealm(entry.address, entry.family, options.allowFakeIp);
        if (r === 'local')
            hostLocal = true;
        else if (r === 'lan')
            hostLan = true;
    }
    // All hosts answers were blackholes (block list) → not a local service.
    if (!nonBlackhole)
        return { realm: 'internet', unresolved: false };
    return { realm: hostLocal ? 'local' : hostLan ? 'lan' : 'internet', unresolved: false };
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
 * BLOCK-list matching: like {@link entryMatches} but a `*.domain` wildcard
 * also covers the bare apex (`*.baidu.com` matches both `www.baidu.com` and
 * `baidu.com`). Used for deny/metadata lists where the user's intent is "the
 * whole domain is off limits". Allow lists keep {@link entryMatches} strict.
 */
function entryMatchesBlock(host, entries) {
    for (const entry of entries) {
        if (entry.startsWith('*.')) {
            if (host.endsWith(entry.slice(1)) || host === entry.slice(2))
                return true;
        }
        else if (entry === host) {
            return true;
        }
    }
    return false;
}
/** True when an IPv6 address is a loopback form (::1, ::, v4-mapped 127/8). */
function isLoopbackIp6(addr) {
    const lower = addr.toLowerCase();
    if (lower === '::1' || lower === '::')
        return true;
    if (lower.startsWith('::ffff:7f') || lower === '::7f00:1' || lower === '::ffff:7f00:1')
        return true;
    if (/^0:0:0:0:0:0:7f00:1$/.test(lower))
        return true;
    return false;
}
/**
 * Loopback identity of a host: `localhost` names and every loopback IP map to
 * the single token `loopback`, so 127.0.0.1 / ::1 / ::ffff:127.* / localhost
 * are treated as the SAME target. Non-loopback hosts keep their normalized
 * hostname.
 */
function loopbackIdentity(host) {
    if (host === 'localhost' || host === 'localhost.localdomain' || host === 'ip6-localhost')
        return 'loopback';
    const family = isIP(host);
    if (family !== 0) {
        if (family === 4) {
            const first = Number(host.split('.')[0]);
            if (first === 127)
                return 'loopback';
        }
        else if (isLoopbackIp6(host)) {
            return 'loopback';
        }
    }
    return host;
}
/** Is `host` a loopback-equivalent literal/name (no DNS needed)? */
function isLoopbackHost(host) {
    return loopbackIdentity(host) === 'loopback';
}
/**
 * Parse one dsh-origin rule into {proto ('http'|'https'|'*'), canon, port}
 * where canon is the loopback identity and port is a number or '*'.
 */
function parseOriginRule(rule) {
    let proto = '*';
    let rest = rule;
    const schemeIdx = rule.indexOf('://');
    if (schemeIdx !== -1) {
        proto = rule.slice(0, schemeIdx);
        rest = rule.slice(schemeIdx + 3);
    }
    let hostPart = rest;
    let port = '';
    const colon = rest.lastIndexOf(':');
    if (colon !== -1 && rest.indexOf(']') < colon) {
        hostPart = rest.slice(0, colon);
        port = rest.slice(colon + 1);
    }
    if (hostPart.length === 0)
        return null;
    const canon = loopbackIdentity(normalizeHostname(hostPart));
    if (canon.length === 0)
        return null;
    return { proto, canon, port: port === '' ? (proto === 'https' ? '443' : proto === 'http' ? '80' : '*') : port };
}
/** Arm check: does the dsh rule list target any loopback endpoint? */
function originRulesContainLoopback(rules) {
    for (const rule of rules) {
        const parsed = parseOriginRule(rule);
        if (parsed && parsed.canon === 'loopback')
            return true;
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
        else if (isLoopbackIp6(host)) {
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
        const hosts = (options.metadataHostnames ?? DEFAULT_METADATA_HOSTNAMES).map(normalizeEntry).filter((h) => h.length > 0);
        const ips = normalizeList(options.metadataIps, DEFAULT_METADATA_IPS);
        if (entryMatchesBlock(host, hosts) || ips.has(host))
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
        this.metadataHosts = (options.metadataHostnames ?? DEFAULT_METADATA_HOSTNAMES).map(normalizeEntry).filter((h) => h.length > 0);
        this.metadataIps = normalizeList(options.metadataIps, DEFAULT_METADATA_IPS);
        this.internetAccess = options.internetAccess;
        this.lanAccess = options.lanAccess;
        this.localAccess = options.localAccess;
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
    /** Verdict for a DSH control-page target: 'allow' when enabled, 'block'
     * when listed but disabled (loopback aliases like localhost/::1/127.0.0.1
     * are treated as the same endpoint), 'none' otherwise. */
    dshRule(url) {
        if (this.dshOrigins.length === 0)
            return 'none';
        const proto = url.protocol.slice(0, -1);
        const canon = loopbackIdentity(normalizeHostname(url.hostname));
        const port = url.port === '' ? (proto === 'https' ? '443' : '80') : url.port;
        for (const rule of this.dshOrigins) {
            const parsed = parseOriginRule(rule);
            if (!parsed)
                continue;
            if (parsed.proto !== '*' && parsed.proto !== proto)
                continue;
            if (parsed.port !== '*' && parsed.port !== port)
                continue;
            if (parsed.canon !== canon)
                continue;
            return this.dshAccessEnabled ? 'allow' : 'block';
        }
        return 'none';
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
    async dnsRedlineBlocked(url) {
        const host = normalizeHostname(url.hostname);
        if (isLoopbackHost(host) || isIP(host) !== 0)
            return null; // literals handled elsewhere
        const proto = url.protocol.slice(0, -1);
        const port = url.port === '' ? (proto === 'https' ? '443' : '80') : url.port;
        const guardLoopback = !this.dshAccessEnabled && originRulesContainLoopback(this.dshOrigins);
        let loopbackPortMatch = false;
        if (guardLoopback) {
            for (const rule of this.dshOrigins) {
                const parsed = parseOriginRule(rule);
                if (parsed && parsed.canon === 'loopback' && (parsed.port === '*' || parsed.port === port)) {
                    loopbackPortMatch = true;
                    break;
                }
            }
        }
        const guardMetadata = this.blockMetadata;
        if (!guardMetadata && !loopbackPortMatch)
            return null;
        let resolved;
        try {
            resolved = await lookup(host, { all: true });
        }
        catch {
            return null;
        }
        let loopbackHit = false;
        for (const entry of resolved) {
            const addr = entry.address;
            if (guardMetadata && this.metadataIps.has(addr))
                return 'metadata';
            if (!loopbackPortMatch)
                continue;
            if (entry.family === 4) {
                const first = Number(addr.split('.')[0]);
                if (first === 127)
                    loopbackHit = true;
            }
            else if (isLoopbackIp6(addr)) {
                loopbackHit = true;
            }
        }
        return loopbackHit ? 'dsh' : null;
    }
    /** Effective access of one realm: explicit user value wins, else mode preset. */
    effectiveAccess(realm) {
        const option = realm === 'internet' ? this.internetAccess : realm === 'lan' ? this.lanAccess : this.localAccess;
        return resolveRealmAccess(option, this.mode, realm);
    }
    /** de-018 fast path: when every realm is allowed there is nothing to gate. */
    allRealmsAllow() {
        return ['internet', 'lan', 'local'].every((realm) => this.effectiveAccess(realm) === 'allow');
    }
    /** Realm policy of a classified realm (access + temp-grant switch). */
    realmPolicyOf(realm) {
        const temp = realm === 'internet' ? this.internetTemp : realm === 'lan' ? this.lanTemp : this.localTemp;
        return { realm, access: this.effectiveAccess(realm), temp: temp ?? true };
    }
    /** Whether a host is currently granted through the persistent allow list. */
    isAllowlisted(host) {
        return entryMatches(host, this.allowEntries);
    }
    denyBlocked(host) {
        return entryMatchesBlock(host, this.denyEntries);
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
        if (this.denyBlocked(host)) {
            return { decision: 'block', code: 'WEB_BLOCKED_URL', reason: `Hostname is denied by configuration: ${host}`, host };
        }
        const reason = blockReasonForUrl(url, {
            blockMetadata: this.blockMetadata,
            metadataHostnames: [...this.metadataHosts],
            metadataIps: [...this.metadataIps],
        });
        if (reason)
            return { decision: 'block', code: 'WEB_BLOCKED_URL', reason, host };
        // --- DSH-page special rule: listed control-page origins are only
        // reachable while explicitly enabled; while disabled they are refused so
        // the model cannot silently reach the harness control page.
        const dshRule = this.dshRule(url);
        if (dshRule === 'allow')
            return { decision: 'allow', reason: '', host };
        if (dshRule === 'block') {
            return {
                decision: 'block',
                code: 'WEB_DSH_DISABLED',
                reason: `DSH control-page access is disabled (enable “允许访问本 DSH 页面”): ${url.origin}`,
                host,
            };
        }
        // DNS re-check for aliases resolving to red-line endpoints (disabled DSH
        // loopback, cloud-metadata IPs) while the relevant guard is armed.
        const dnsHit = await this.dnsRedlineBlocked(url);
        if (dnsHit !== null) {
            return {
                decision: 'block',
                code: dnsHit === 'metadata' ? 'WEB_BLOCKED_URL' : 'WEB_DSH_DISABLED',
                reason: dnsHit === 'metadata'
                    ? `Cloud metadata endpoint is blocked (hostname resolves to a metadata address): ${url.host}`
                    : `DSH control-page access is disabled — target resolves to the protected loopback endpoint: ${url.host}`,
                host,
            };
        }
        // --- de-018: preset-driven realm authorization (no routing hard-block).
        // Effective access = explicit user realm value, else the mode preset.
        // Fast path: all realms allowed → nothing left to gate.
        if (this.allRealmsAllow())
            return { decision: 'allow', reason: '', host };
        const family = isIP(host);
        let realm;
        if (family !== 0) {
            realm = addressRealm(host, family, this.allowFakeIp);
        }
        else {
            const cls = await classifyHostRealm(host, { resolveDns: this.resolveDns, allowFakeIp: this.allowFakeIp });
            if (cls.unresolved && this.resolveDns) {
                return {
                    decision: 'block',
                    code: 'WEB_PROVIDER_ERROR',
                    reason: `DNS resolution failed for ${host}`,
                    host,
                };
            }
            realm = cls.realm;
        }
        const realmPolicy = this.realmPolicyOf(realm);
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
        if (this.denyBlocked(host)) {
            throw new UrlPolicyError('WEB_BLOCKED_URL', `Hostname is denied by configuration: ${host}`);
        }
        const reason = blockReasonForUrl(url, {
            blockMetadata: this.blockMetadata,
            metadataHostnames: [...this.metadataHosts],
            metadataIps: [...this.metadataIps],
        });
        if (reason)
            throw new UrlPolicyError('WEB_BLOCKED_URL', reason);
        const dshRule = this.dshRule(url);
        if (dshRule === 'allow')
            return url;
        if (dshRule === 'block') {
            throw new UrlPolicyError('WEB_DSH_DISABLED', `DSH control-page access is disabled (enable “允许访问本 DSH 页面”): ${url.origin}`);
        }
        if (await this.dnsRedlineBlocked(url)) {
            throw new UrlPolicyError('WEB_DSH_DISABLED', `Access disabled — target resolves to a protected endpoint (DSH loopback or cloud metadata): ${url.host}`);
        }
        // --- de-018: preset-driven realm authorization (route gate). ask is NOT
        // enforced here (it is surfaced by the tool layer before the bridge).
        if (this.allRealmsAllow())
            return url;
        const family = isIP(host);
        let realm;
        if (family !== 0) {
            realm = addressRealm(host, family, this.allowFakeIp);
        }
        else {
            const cls = await classifyHostRealm(host, { resolveDns: this.resolveDns, allowFakeIp: this.allowFakeIp });
            if (cls.unresolved && this.resolveDns) {
                throw new UrlPolicyError('WEB_PROVIDER_ERROR', `DNS resolution failed for ${host}`);
            }
            realm = cls.realm;
        }
        const routePolicy = this.realmPolicyOf(realm);
        if (routePolicy.access === 'deny') {
            throw new UrlPolicyError('WEB_REALM_DENIED', `${realmLabel(realm)} access is denied by policy: ${host}`);
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
