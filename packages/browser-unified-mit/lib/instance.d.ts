/**
 * dsh-browser-unified-mit — MIT-licensed release (contains no caob23-derived code).
 * Relicensed MIT by the repository authors; upstream (MIT) attribution of distilled
 * semantics is in NOTICE.md. License: MIT.
 */
/**
 * Instance registry — merge prototype.
 *
 * Original metadata mapping of the four archived routes. Lets a future unified
 * bundle declare "which instance, which tool prefix, which URL mode, which
 * approval model" per deployment instead of shipping four parallel plugins.
 * @module dsh-browser-unified-mit/instance
 */
import type { UrlPolicyMode } from './url-policy.js';
/** The four archived routes. */
export type RouteId = 'dsh-browser' | 'intranet-browser' | 'browser-control-mcp' | 'browser-control-bridge';
export type ApprovalModelId = 'web-permission' | 'per-call-approval' | 'host-policy' | 'none';
export interface BrowserInstanceProfile {
    readonly route: RouteId;
    /** npm scope / author identity of the upstream. */
    readonly upstream: string;
    /** Relative directory under upstream/ in this repository. */
    readonly upstreamDir: string;
    /** Tool prefix the model sees. */
    readonly toolPrefix: string;
    /** How the browser is provided. */
    readonly browserKind: 'native-playwright' | 'playwright-mcp' | 'real-browser-cdp';
    /** URL enforcement stance (see url-policy.ts). */
    readonly urlMode: UrlPolicyMode | 'none';
    /** Which approval mechanism guards tool calls. */
    readonly approvalModel: ApprovalModelId;
    /** License of the upstream (see NOTICE.md). */
    readonly license: 'MIT' | 'AGPL-3.0';
    /** Cookie / login persistence boundary. */
    readonly sessionNote: string;
    readonly note: string;
}
export declare const PROFILES: Record<RouteId, BrowserInstanceProfile>;
/** Resolve a profile by route id (case-insensitive, also matches npm-ish names). */
export declare function resolveProfile(key: string): BrowserInstanceProfile;
/**
 * Informational helper: upstream routes whose own code is MIT-licensed. Useful
 * when producing a separate MIT-only build (e.g. a public "policy" subpackage).
 * NOTE: since 2026-09-05 this whole package is MIT; this function no
 * longer describes the package license.
 */
export declare function mitMergeableProfiles(): BrowserInstanceProfile[];
