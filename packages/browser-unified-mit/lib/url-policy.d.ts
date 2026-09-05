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
    /** Public mode: resolve hostnames and reject any non-public answer. Default true. */
    readonly resolveDns?: boolean;
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
    private readonly resolveDns;
    constructor(options: UrlPolicyOptions);
    get isIntranet(): boolean;
    /**
     * Validate `raw` for a navigation. Public mode: http(s) only, no embedded
     * credentials, default-hostname blocklist, IP-literal screening and (unless
     * disabled) resolve-then-validate DNS. Intranet mode: http(s) (+file), no
     * credentials, and only the metadata/extras blocklist — private and loopback
     * targets are intentionally allowed (that is the point of the intranet mode).
     * @throws {UrlPolicyError} with a stable `code` when unusable.
     */
    assertUsableUrl(raw: string): Promise<URL>;
    private blockedAsPrivate;
}
