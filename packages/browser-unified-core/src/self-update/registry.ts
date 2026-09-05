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
  m: string
  /** affected merged-core surface, human-readable. */
  t: string
  /** expected impact, human-readable. */
  i: string
}

export interface RepoPin {
  id: string
  url: string
  branch?: string
  archivedPath?: string
  pinnedSha: string
  pinnedVersion?: string
  license?: string
  mergedIntoCore?: boolean
}

export interface BaselineDocument {
  schemaVersion: number
  pinnedAt?: string
  repos: RepoPin[]
}

export interface ToolingNames {
  toolPrefix?: string
  checkToolName?: string
  designViewToolName?: string
  designEditToolName?: string
  checkReadOnly?: boolean
  mutateRequiresApproval?: boolean
}

export interface AuthzPolicy {
  policy?: string
  approvalPromptTemplate?: string
  externalContentPolicy?: string
  writeAllowlist?: string[]
  schemaValidationBeforeWrite?: boolean
  backupBeforeWrite?: boolean
  outsideWorkspaceWritesForbidden?: boolean
}

export interface DesignEntry {
  id: string
  title: string
  status: string
  decidedBy?: string
  createdAt?: string
  updatedAt?: string
  scope?: string
  affectedModules?: string[]
  summary?: string
  notes?: string[]
  history?: { at?: string; what?: string }[]
}

export interface DesignRegistry {
  schemaVersion: number
  lastUpdated?: string
  purpose?: string
  baselineRef?: string
  tooling?: ToolingNames
  authz?: AuthzPolicy
  impactRules: Record<string, ImpactRule[]>
  designEntries?: DesignEntry[]
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryError'
  }
}

function parseJson<T>(text: string, what: string): T {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new RegistryError(`${what} is not valid JSON: ${(err as Error).message}`)
  }
  return value as T
}

function requireVersion(doc: { schemaVersion?: unknown }, what: string): void {
  if (typeof doc.schemaVersion !== 'number') {
    throw new RegistryError(`${what}: missing numeric schemaVersion`)
  }
}

/** Load upstream-baseline.json text into a validated BaselineDocument. */
export function loadBaseline(text: string): BaselineDocument {
  const doc = parseJson<BaselineDocument>(text, 'upstream-baseline.json')
  requireVersion(doc, 'upstream-baseline.json')
  if (!Array.isArray(doc.repos)) {
    throw new RegistryError('upstream-baseline.json: repos must be an array')
  }
  for (const repo of doc.repos) {
    if (typeof repo.id !== 'string' || repo.id.length === 0) {
      throw new RegistryError('upstream-baseline.json: every repo needs a non-empty id')
    }
    if (typeof repo.pinnedSha !== 'string' || !/^[0-9a-f]{40}$/i.test(repo.pinnedSha)) {
      throw new RegistryError(`upstream-baseline.json: repo "${repo.id}" has an invalid pinnedSha`)
    }
  }
  return doc
}

/** Load design/registry.json text into a validated DesignRegistry. */
export function loadRegistry(text: string): DesignRegistry {
  const doc = parseJson<DesignRegistry>(text, 'design/registry.json')
  requireVersion(doc, 'design/registry.json')
  if (typeof doc.impactRules !== 'object' || doc.impactRules === null || Array.isArray(doc.impactRules)) {
    throw new RegistryError('design/registry.json: impactRules must be a plain object')
  }
  for (const repoId of Object.keys(doc.impactRules)) {
    const rules = doc.impactRules[repoId]
    if (!Array.isArray(rules)) {
      throw new RegistryError(`design/registry.json: impactRules["${repoId}"] must be an array`)
    }
    for (const rule of rules) {
      if (typeof rule?.m !== 'string' || typeof rule?.t !== 'string' || typeof rule?.i !== 'string') {
        throw new RegistryError(`design/registry.json: impactRules["${repoId}"] rows need m/t/i strings`)
      }
    }
  }
  return doc
}

/**
 * Map a repo's changed (repo-relative) paths to the distinct impact rows that
 * apply, preserving rule order. First matching rule wins per path; a path that
 * matches nothing falls back to the registry's '' (match-all) row if present.
 */
export function impactRowsFor(
  registry: DesignRegistry,
  repoId: string,
  changedFiles: readonly string[],
): ImpactRule[] {
  const rules = registry.impactRules[repoId]
  if (!rules || rules.length === 0) return []
  const seen = new Set<ImpactRule>()
  const out: ImpactRule[] = []
  for (const file of changedFiles) {
    let row: ImpactRule | undefined
    for (const rule of rules) {
      if (file.includes(rule.m)) {
        row = rule
        break
      }
    }
    if (!row) {
      row = rules.find((r) => r.m === '') ?? rules[rules.length - 1]
    }
    if (row && !seen.has(row)) {
      seen.add(row)
      out.push(row)
    }
  }
  return out
}

/** True when repoId is tracked in the registry's impactRules. */
export function isTrackedRepo(registry: DesignRegistry, repoId: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry.impactRules, repoId)
}
