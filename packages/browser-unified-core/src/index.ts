/**
 * browser-unified-core — merged core.
 *
 * License: AGPL-3.0 (decision 2026-09-05: AGPL accepted). This package now
 * combines, under one AGPL-3.0 license:
 *
 *  - MIT-distilled logic (see upstream attribution below) — MIT is permissive,
 *    so these files may legally sit inside an AGPL package:
 *      * unified URL policy `public` | `intranet` (xylt369/dsh-browser
 *        url-guard semantics + Short-Arm-Ape/dsh-intranet-browser url-check
 *        metadata/normalization semantics),
 *      * generic approval-gate decision table (Short-Arm-Ape gate.ts),
 *  - AGPL-3.0 code vendored from @caob23/dsh-browser-control v1.0.7:
 *      * bridge/ws.ts + bridge/server.ts (RFC 6455 codec + local WS/HTTP bridge),
 *    plus the GuardedBridge integration that applies the URL policy to bridge
 *    navigation commands.
 *
 * Full attribution matrix: NOTICE.md at the repository root. Source of the
 * AGPL upstream: https://github.com/caob23/dsh-browser-control
 * @module browser-unified-core
 */

export * from './url-policy.js'
export * from './approval.js'
export * from './instance.js'
export * from './guarded-bridge.js'
export * from './bridge/ws.js'
export * from './bridge/server.js'
export * from './self-update/registry.js'
export * from './self-update/check.js'
