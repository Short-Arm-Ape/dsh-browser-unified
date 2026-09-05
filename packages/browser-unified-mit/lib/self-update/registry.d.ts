/**
 * dsh-browser-unified-mit — MIT-licensed release (contains no caob23-derived code).
 * Relicensed MIT by the repository authors; upstream (MIT) attribution of distilled
 * semantics is in NOTICE.md. License: MIT.
 */
/**
 * registry.ts — load & validate the design registry and the upstream baseline.
 *
 * Both are plain-JSON files owned by the repository:
 *   - design/registry.json         impactRules (single source of truth for the
 *                                  "changed upstream path -> merged-core surface"
 *                                  mapping), tooling names, authz policy, designEntries.
 *   - upstream-baseline.json       per-repo pinned commit SHAs of the archived snapshots.
 *
 * Pure functions, no I/O, no DSH dependency. License: MIT (part of
 * dsh-browser-unified-mit; see NOTICE.md for the MIT/AGPL attribution matrix).
 */
export interface ImpactRule {
    /** substring matched against a repo-relative changed path; '' matches everything (fallback). */
    m: string;
    /** affected merged-core surface, human-readable. */
    t: string;
    /** expected impact, human-readable. */
    i: string;
}
export interface RepoPin {
    id: string;
    url: string;
    branch?: string;
    archivedPath?: string;
    pinnedSha: string;
    pinnedVersion?: string;
    license?: string;
    mergedIntoCore?: boolean;
}
export interface BaselineDocument {
    schemaVersion: number;
    pinnedAt?: string;
    repos: RepoPin[];
}
export interface ToolingNames {
    toolPrefix?: string;
    checkToolName?: string;
    designViewToolName?: string;
    designEditToolName?: string;
    checkReadOnly?: boolean;
    mutateRequiresApproval?: boolean;
}
export interface AuthzPolicy {
    policy?: string;
    approvalPromptTemplate?: string;
    externalContentPolicy?: string;
    writeAllowlist?: string[];
    schemaValidationBeforeWrite?: boolean;
    backupBeforeWrite?: boolean;
    outsideWorkspaceWritesForbidden?: boolean;
}
export interface DesignEntry {
    id: string;
    title: string;
    status: string;
    decidedBy?: string;
    createdAt?: string;
    updatedAt?: string;
    scope?: string;
    affectedModules?: string[];
    summary?: string;
    notes?: string[];
    history?: {
        at?: string;
        what?: string;
    }[];
}
export interface DesignRegistry {
    schemaVersion: number;
    lastUpdated?: string;
    purpose?: string;
    baselineRef?: string;
    tooling?: ToolingNames;
    authz?: AuthzPolicy;
    impactRules: Record<string, ImpactRule[]>;
    designEntries?: DesignEntry[];
}
export declare class RegistryError extends Error {
    constructor(message: string);
}
/** Load upstream-baseline.json text into a validated BaselineDocument. */
export declare function loadBaseline(text: string): BaselineDocument;
/** Load design/registry.json text into a validated DesignRegistry. */
export declare function loadRegistry(text: string): DesignRegistry;
/**
 * Map a repo's changed (repo-relative) paths to the distinct impact rows that
 * apply, preserving rule order. First matching rule wins per path; a path that
 * matches nothing falls back to the registry's '' (match-all) row if present.
 */
export declare function impactRowsFor(registry: DesignRegistry, repoId: string, changedFiles: readonly string[]): ImpactRule[];
/** True when repoId is tracked in the registry's impactRules. */
export declare function isTrackedRepo(registry: DesignRegistry, repoId: string): boolean;
