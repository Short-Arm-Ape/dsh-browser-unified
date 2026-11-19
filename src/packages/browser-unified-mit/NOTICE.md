# NOTICE — dsh-browser-unified-mit (MIT edition)

This package is an **MIT-licensed release of dsh-browser-unified that contains
no caob23-derived code**. License: MIT (see LICENSE).

## Content and provenance

| Path | Content | Provenance |
|---|---|---|
| `src/url-policy.ts` | Unified URL policy (`public` / `intranet`, metadata blocklist, fake-ip allowance). | Distilled in this repository from **MIT** sources: `xylt369/dsh-browser` (MIT, `url-guard.ts` semantics) and `Short-Arm-Ape/dsh-intranet-browser` (MIT, `url-check.ts` metadata/normalization semantics). Relicensed MIT by the authors. |
| `src/approval.ts` | Generic approval-gate decision table. | Distilled from `Short-Arm-Ape/dsh-intranet-browser` (MIT, `gate.ts`); generalized by the authors. MIT. |
| `src/instance.ts` | Instance/profile registry metadata. | Authored in this repository. MIT. |
| `src/self-update/registry.ts`, `src/self-update/check.ts`, `src/tools.ts`, `src/index.ts` | Baseline/registry loading, drift report builder, `browser_check_update` / `browser_design_show` / `browser_design_edit` tools. | Authored in this repository (developed for the AGPL browser-unified-core/plugin, relicensed MIT here by the authors). MIT. |
| `registry/*` | Bundled seed data: upstream commit baseline + design registry (metadata only). | Data; upstream repositories & versions are referenced inside the files themselves. |

## What is deliberately NOT included

- The caob23 bridge implementation (`@caob23/dsh-browser-control`, AGPL-3.0:
  `ws.ts`/`server.ts` codecs, `index.ts` wiring, 16 `browser_*` tools,
  extension protocol) is **not** part of this edition. Its AGPL-3.0 obligations
  therefore do not attach here.
- For a full browser-driving plugin (bridge + `browser_*` tools + `GuardedBridge`
  URL policy), use the **AGPL-3.0 full edition** package `dsh-browser-unified`
  (`packages/browser-unified-plugin` in this repository), which vendors the
  caob23 code with attribution.

## Runtime peer packages

`@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` are peer dependencies owned
by their respective authors under their own licenses.
