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
/** Stable error code + human message; callers (tools) surface `code` to the model. */
export declare class UrlPolicyError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: {
        cause?: unknown;
    });
}
/** Which network stance this instance enforces. */
export type UrlPolicyMode = 'public' | 'intranet';
/**
 * A target realm, from most trusted to least:
 * - `local`: the machine itself (loopback / localhost);
 * - `lan`: private networks (LAN / link-local / fake-ip / local-only names);
 * - `internet`: everything else.
 * Kept separate so a user may e.g. let the model debug the local DSH service
 * without exposing LAN devices, or scan the LAN without exposing this host.
 */
export type Realm = 'internet' | 'lan' | 'local';
/**
 * Per-realm access behavior for hosts that pass the routing stance and the
 * hard blocklists:
 * - `allow`: navigation proceeds without further approval;
 * - `ask`: an explicit user approval is required unless the host is on the
 *   allow list or already granted this session (see the `*Temp` switches for
 *   whether such approvals may grant new hosts);
 * - `deny`: refused regardless of allow list.
 */
export type RealmAccess = 'allow' | 'ask' | 'deny';
export interface UrlPolicyOptions {
    readonly mode: UrlPolicyMode;
    /** Allow Clash/Surge/mihomo fake-ip answers in 198.18.0.0/15 (public mode). Default true. */
    readonly allowFakeIp?: boolean;
    /** Public mode only: skip private-IP screening entirely. Never enable near sensitive hosts. */
    readonly allowPrivate?: boolean;
    /** Allow file:// URLs in addition to http(s). Default false. */
    readonly allowFile?: boolean;
    /** Master switch: keep blocking cloud-metadata endpoints. Default true (both modes). */
    readonly blockMetadata?: boolean;
    /** Extra hostnames/IP literals always blocked (both modes). */
    readonly blockedHostnames?: ReadonlySet<string>;
    /**
     * Cloud-metadata hostnames always blocked in BOTH modes. When provided this
     * REPLACES the built-in default list entirely (`[]` = block none of this
     * family); when omitted the built-in defaults are used. Values are compared
     * after hostname normalization (lowercase, trailing dot / IPv6 brackets
     * stripped, IPv4-mapped tails unwrapped).
     */
    readonly metadataHostnames?: readonly string[];
    /**
     * Same replace-or-default contract as {@link metadataHostnames}, for the
     * IP-literal family of cloud-metadata endpoints.
     */
    readonly metadataIps?: readonly string[];
    /** Access policy for `internet` hosts. Default 'allow'. */
    readonly internetAccess?: RealmAccess;
    /** Access policy for `lan` (private network) hosts. Default 'allow'. */
    readonly lanAccess?: RealmAccess;
    /** Access policy for `local` (loopback / localhost) hosts. Default 'allow'. */
    readonly localAccess?: RealmAccess;
    /** Whether ask-mode approvals may grant temporary internet hosts this session. Default true. */
    readonly internetTemp?: boolean;
    /** Whether ask-mode approvals may grant temporary lan hosts this session. Default true. */
    readonly lanTemp?: boolean;
    /** Whether ask-mode approvals may grant temporary local hosts this session. Default true. */
    readonly localTemp?: boolean;
    /**
     * DSH-page special rule (optional). When enabled, origins listed in
     * `dshOrigins` (normalized `http(s)://host[:port]`, or `host:*` to allow any
     * port of that host) bypass the routing stance and the realm allow/ask
     * layer, so the model can reach the harness control page even under
     * `public`. This is an explicitly user-opted capability (the GUI asks twice
     * when enabling): the model otherwise could drive its own approval prompts.
     */
    readonly dshAccessEnabled?: boolean;
    readonly dshOrigins?: readonly string[];
    /**
     * Hostnames/IPs that never need per-host authorization in `ask` realms.
     * Entries may be exact (after normalization) or a `*.suffix` wildcard
     * matching any subdomain.
     */
    readonly allowHosts?: readonly string[];
    /**
     * Hostnames/IPs always denied (both modes and under every authorization
     * mode), merged with `blockedHostnames`. Exact entries or `*.suffix`
     * wildcards.
     */
    readonly denyHosts?: readonly string[];
    /** Public mode: resolve hostnames and reject any non-public answer. Default true. */
    readonly resolveDns?: boolean;
}
/** Verdict of {@link UrlPolicy.authorizeUrl}. */
export interface UrlAuthorization {
    /** `allow`: navigation may proceed. `ask`: needs an explicit user approval first. `block`: refused. */
    decision: 'allow' | 'ask' | 'block';
    /** Stable error/status code (`NEED_AUTHORIZATION`, `WEB_*`); undefined when allowed. */
    code?: string;
    /** Human message describing the decision. */
    reason: string;
    /** Normalized target host the decision refers to. */
    host: string;
}
/**
 * Default cloud-metadata hostnames (upstream list) — kept blocked even in
 * intranet mode. This is only the *initial value*: pass your own
 * `metadataHostnames` to {@link UrlPolicy} (or `browser-bridge` settings) to
 * fully replace it, e.g. for non-AWS/GCP/Azure clouds or private deployments.
 */
export declare const DEFAULT_METADATA_HOSTNAMES: readonly string[];
/**
 * Default cloud-metadata IP literals (AWS/GCP/Azure 169.254.169.254, Alibaba
 * 100.100.100.200, AWS IMDSv2 IPv6). Initial value only — replace via
 * `metadataIps` for full control.
 */
export declare const DEFAULT_METADATA_IPS: readonly string[];
/** Back-compat aliases kept for existing consumers (values equal the defaults above). */
export declare const METADATA_HOSTNAMES: ReadonlySet<string>;
export declare const METADATA_IPS: ReadonlySet<string>;
/**
 * Normalize a hostname for blocklist matching: strip IPv6 brackets, lowercase,
 * drop trailing dots, and map IPv4-mapped IPv6 tails back to dotted quad.
 */
export declare function normalizeHostname(raw: string): string;
/** True when an IPv4 literal is private / loopback / link-local / multicast / reserved. */
export declare function isPrivateIPv4(addr: string): boolean;
/** True only for the Clash/Surge/mihomo fake-ip pool 198.18.0.0/15. */
export declare function isFakeIpIPv4(addr: string): boolean;
/** True when an IPv6 address is loopback, ULA, link-local, multicast, or mapped to a private v4. */
export declare function isPrivateIPv6(addr: string): boolean;
/**
 * Classify a normalized host into its realm:
 * - `local`: loopback literals and localhost names (the machine itself);
 * - `lan`: other private/ULA/link-local/fake-ip literals and local-only
 *   suffixes (.local/.lan/.internal/…);
 * - `internet`: everything else.
 * Hostnames that only resolve to private addresses are not classified here
 * (DNS is only consulted in public mode) — documented approximation.
 */
export declare function realmOf(host: string): Realm;
/** Short display name of a realm for policy messages. */
export declare function realmLabel(realm: Realm): string;
/**
 * Host-level blocklist usable against ANY request URL (navigation, redirects,
 * subresources). Invalid URLs fail open here — the strict navigation check is
 * the caller's safety net for the initial `goto`.
 */
export declare function blockReasonForUrl(raw: string | URL, options?: {
    readonly blockMetadata?: boolean;
    readonly blockedHostnames?: ReadonlySet<string>;
    readonly metadataHostnames?: readonly string[];
    readonly metadataIps?: readonly string[];
}): string | null;
/** One policy instance: `mode` selects how strict `assertUsableUrl` is. */
export declare class UrlPolicy {
    private readonly mode;
    private readonly allowFakeIp;
    private readonly allowPrivate;
    private readonly allowFile;
    private readonly blockMetadata;
    private readonly blocked;
    private readonly metadataHosts;
    private readonly metadataIps;
    private readonly internetAccess;
    private readonly lanAccess;
    private readonly localAccess;
    private readonly internetTemp;
    private readonly lanTemp;
    private readonly localTemp;
    private readonly dshAccessEnabled;
    private readonly dshOrigins;
    private readonly allowEntries;
    private readonly denyEntries;
    private readonly resolveDns;
    constructor(options: UrlPolicyOptions);
    get isIntranet(): boolean;
    /** Whether the origin of `url` is explicitly granted as a DSH control page. */
    private dshGranted;
    /** Realm policy of a normalized host. */
    accessFor(host: string): {
        access: RealmAccess;
        temp: boolean;
        realm: Realm;
    };
    /** Whether a host is currently granted through the persistent allow list. */
    isAllowlisted(host: string): boolean;
    private denyBlocked;
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
    authorizeUrl(raw: string): Promise<UrlAuthorization>;
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
    assertUsableUrl(raw: string): Promise<URL>;
    private blockedAsPrivate;
}
