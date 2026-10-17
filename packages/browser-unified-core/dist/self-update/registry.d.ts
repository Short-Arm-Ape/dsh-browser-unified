/**
 * registry.ts — load & validate the design registry and the upstream baseline.
 *
 * Both are plain-JSON files owned by the repository:
 *   - design/registry.json         impactRules (single source of truth for the
 *                                  "changed upstream path -> merged-core surface"
 *                                  mapping), tooling names, authz policy, designEntries.
 *   - upstream-baseline.json       per-repo pinned commit SHAs of the archived snapshots.
 *
 * Pure functions, no I/O, no DSH dependency. License: AGPL-3.0 (part of
 * browser-unified-core; see NOTICE.md for the MIT/AGPL attribution matrix).
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
    /**
     * 这份来源怎么被用（2026-10-13 主人定；缺省视为 `merge`，与老基线兼容）：
     * - `merge`：持续合并源 —— 唯一参与漂移自检的对象；
     * - `reference`：只在决定接线某功能时翻归档取用，不做定时自检；
     * - `attribution`：纯来源记录（本项目前身那类，连 `repos[]` 都不进）。
     */
    role?: RepoRole;
}
export type RepoRole = 'merge' | 'reference' | 'attribution';
/** 缺省 `merge`：老基线没有 role 字段时行为不变。 */
export declare function repoRole(repo: RepoPin): RepoRole;
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
