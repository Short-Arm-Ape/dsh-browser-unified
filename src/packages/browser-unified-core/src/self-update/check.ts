/**
 * check.ts — pure report builder for the "browser_check_update"-style check.
 *
 * Consumes a BaselineDocument (upstream-baseline.json) + DesignRegistry
 * (design/registry.json) + per-repo remote HEAD observations and produces a
 * compact, human/LLM-readable status report. A host/tool adapter is responsible
 * for actually observing remote heads (e.g. git ls-remote via subprocess or an
 * HTTP fetch) and for listing commits/changed files on drift.
 *
 * Pure functions, no I/O, no DSH dependency. License: AGPL-3.0 (part of
 * browser-unified-core; see NOTICE.md).
 */

import type { BaselineDocument, DesignRegistry, ImpactRule, RepoRole } from './registry.js'
import { impactRowsFor, repoRole } from './registry.js'

export type RepoStatus = 'up-to-date' | 'drift' | 'unreachable' | 'rewritten' | 'unknown'

export interface RemoteHeadInfo {
  sha: string
  /** short description of the head commit, e.g. "2f1adee 2026-08-25 docs: …" */
  lastCommit?: string
  version?: string
  /** commits between baseline and head, pre-formatted one-line strings. */
  newCommits?: string[]
  /** changed files between baseline and head, repo-relative paths. */
  changedFiles?: string[]
  /** true when the baseline SHA could not be found in history (force-push). */
  baselineMissing?: boolean
}

export interface RepoObservation {
  /** error message when the remote could not be reached. */
  unreachable?: string
  head?: RemoteHeadInfo
}

export interface RepoReport {
  id: string
  url: string
  pinnedSha: string
  pinnedVersion?: string
  role: RepoRole
  status: RepoStatus
  headSha?: string
  headMeta?: string
  version?: string
  driftReason?: string
  newCommitCount?: number
  changedFileCount?: number
  newCommits?: string[]
  impact?: ImpactRule[]
  baselineRef: string
}

export interface CheckSummary {
  generatedAt?: string
  /** true when at least one tracked repo is drifting. */
  anyDrift: boolean
  reports: RepoReport[]
  /**
   * 基线里 `role` 不是 `merge` 的来源 id：它们不做漂移自检（2026-10-13 主人定），
   * 但**不静默丢弃** —— 报告里要能看出"被跳过的是谁、为什么"。
   */
  skippedNonMerge: string[]
  /** compact digest of open (proposed/pending/accepted) design entries, optional. */
  openDesign?: { id: string; title: string; status: string }[]
}

function classify(pinSha: string, head: RemoteHeadInfo | undefined): RepoStatus {
  if (!head) return 'unknown'
  if (head.baselineMissing) return 'rewritten'
  if (head.sha === pinSha) return 'up-to-date'
  return 'drift'
}

/**
 * Build the per-repo status report set. `observations` maps repo id -> remote
 * observation; repos without an observation are reported as unreachable.
 *
 * 只报告 `role=merge` 的来源（缺省即 merge）；`reference`/`attribution` 档
 * 只在决定接线某功能时按需翻归档，不进这个定时自检（它们的 id 收在
 * `skippedNonMerge` 里，读者仍知道跳过了谁）。
 */
export function buildReport(
  baseline: BaselineDocument,
  registry: DesignRegistry,
  observations: Record<string, RepoObservation | undefined>,
  opts: { includeOpenDesign?: boolean } = {},
): CheckSummary {
  const reports: RepoReport[] = []
  const skippedNonMerge: string[] = []
  for (const repo of baseline.repos) {
    if (repoRole(repo) !== 'merge') { skippedNonMerge.push(repo.id); continue }
    const obs = observations[repo.id]
    const head = obs?.head
    const status: RepoStatus = obs?.unreachable
      ? 'unreachable'
      : classify(repo.pinnedSha, head)

    const report: RepoReport = {
      id: repo.id,
      url: repo.url,
      pinnedSha: repo.pinnedSha,
      pinnedVersion: repo.pinnedVersion,
      role: repoRole(repo),
      status,
      baselineRef: baseline.pinnedAt ?? '',
    }
    if (head) {
      report.headSha = head.sha
      report.headMeta = head.lastCommit
      report.version = head.version
      report.newCommits = head.newCommits
      report.newCommitCount = head.newCommits?.length ?? 0
      report.changedFileCount = head.changedFiles?.length ?? 0
    }
    if (status === 'unreachable') {
      report.driftReason = obs?.unreachable ?? 'remote unreachable'
    } else if (status === 'rewritten') {
      report.driftReason =
        'baseline SHA not found in current history (force-push / rewritten history); manual review required'
    } else if (status === 'drift' && head) {
      report.impact = impactRowsFor(registry, repo.id, head.changedFiles ?? [])
      report.driftReason =
        head.changedFiles?.length
          ? `new commits since pinned baseline (${head.newCommits?.length ?? '?'} commit(s), ${head.changedFiles.length} file(s) changed)`
          : 'new commits since pinned baseline'
    }
    reports.push(report)
  }

  let openDesign: { id: string; title: string; status: string }[] | undefined
  if (opts.includeOpenDesign) {
    const entries = registry.designEntries ?? []
    const open = entries.filter((e) => e.status === 'proposed' || e.status === 'accepted')
    openDesign = open.map((e) => ({ id: e.id, title: e.title, status: e.status }))
  }

  return {
    anyDrift: reports.some((r) => r.status === 'drift' || r.status === 'rewritten'),
    reports,
    skippedNonMerge,
    openDesign,
  }
}
