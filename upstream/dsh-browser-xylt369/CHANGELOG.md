# Changelog

## 0.8.1 (2026-08-24)

- **Settings cards**: Host halves declare `inject: ['settings']` so `settings.register(..., { expose: 'web' })` cannot be skipped when the settings service is late. Without this, the Plugins tab hid both cards (client loaded; Host namespaces never appeared in `served`).
- **Clash fake-ip**: `allowFakeIp` (default `true`) lets DNS answers in `198.18.0.0/15` through the URL guard. Machines behind Clash/Surge fake-ip were rejecting every public host (e.g. `www.bilibili.com` → `198.18.0.x`) as `WEB_PRIVATE_TARGET`. Real private ranges stay blocked.
- **Ref clicking**: accept current Playwright ref formats via `isAriaRefFormat` (e.g. `f29e86` as well as legacy `e1`).

## 0.8.0 (2026-08-24)

- **Settings cards**: `web-permission` and `browser-playwright` ship a lazy-CJS `./client` half (`dsh.client`, `settings.plugin.item` keyed by Host namespace). Configure allow/deny lists, window mode, and stealth from the Plugins tab; YAML remains valid. The unpublished official `clientBundle` preset is reproduced by `scripts/bundle-client.mjs` (esbuild). React / client UI packages stay out of Host `dependencies`.
- **Screenshots**: `browser_screenshot` `output.render` now returns a durable `image` ContentBlock (`attachment: ImageAttachmentRef`) plus the caption, so vision adapters can pick the raster up from the tool result.

## 0.7.0 (2026-08-24)

- **Host target**: peer range for `dsh-tools` / `dsh-attachment` / `dsh-settings` is `>=0.1.0-rc.7 <0.2.0` (dev/typecheck against `0.1.1-rc.2`). Still peers only — never install a second `dsh-tools` copy into a profile.
- **Session tabs**: each harness session key gets its own tab set on the shared persistent Edge profile (logins still survive). Model tools: `browser_tabs` / `browser_open_tab` / `browser_switch_tab` / `browser_close_tab`.
- **More page tools**: `browser_fill`, `browser_press`, `browser_wait`, `browser_forward`.
- **Settings**: `web-permission` and `browser-playwright` register with `expose: 'web'` and `applies: live|restart`.
- **Screenshots**: `browser_screenshot` still goes through `ctx.attachments.saveImage` so dsh 0.1.1 vision / Files API can consume the durable attachment.

## dsh-browser-settings 0.1.1 (2026-08-15)

- **New companion package** `@yeesy369/dsh-browser-settings`: a DSH sidebar panel that makes `browser-playwright` configurable from the UI (window mode `visible` / `hidden` / `headless` and the `stealth` toggle). Prefer the official Plugins settings cards in 0.8.x for day-to-day use; this package remains available as an optional sidebar.

## 0.6.1 (2026-08-15)

- **Fix ref-based clicking** (`browser-playwright`): snapshot refs now live on the runtime instead of the per-call page instance, so `browser_click(ref=...)` works across tool calls; ref detection also accepts the current Playwright ref format (e.g. `f29e86`) alongside the legacy `e1` style (`isAriaRefFormat`). Previously ref clicks could time out after 30s. Closes #1.
- **Publish hardening**: `browser-playwright` 0.6.1 and `tool-browser` 0.5.1 now depend on a concrete `@yeesy369/dsh-browser@0.5.1` instead of `workspace:*`, so the published packages install outside the monorepo.
- **CI**: drop the redundant pnpm version pin (package.json `packageManager` already selects pnpm 11.21.0); e2e uses `windowVisibility: "headless"` so the suite runs on headless CI runners.

## 0.6.0 (2026-08-15)

- **Window modes**: `browser-playwright` now ships `windowVisibility: "visible" | "hidden" | "headless"` (default `visible`). `hidden` runs the real browser with the window minimized and parked offscreen — best anti-bot posture without desktop clutter — while `headless` stays the no-window choice for servers/CI. The legacy `headless: true` field still works and maps to `windowVisibility: "headless"`.
- **Stealth patch**: new `stealth` config (default `true`) wires launch args plus a dependency-free init script that removes `navigator.webdriver`, fakes plugins in headless, masks SwiftShader/llvmpipe WebGL vendors, fixes the notifications permission, and more (`packages/browser-playwright/src/stealth.ts`).
- **Seam 0.5.0**: `BrowserPageOptions.windowVisibility` added; `headless` marked deprecated.
- **e2e**: headless+stealth marker checks (`navigator.webdriver`, plugins, notifications) and a hidden-window smoke test (skipped on CI, which has no desktop session).

## 0.5.0 (2026-08-15)

- **`browser_scroll`**: new model-facing tool to page through long content (feeds, documents, comment threads). Defaults to 800px down; accepts `direction` (`up` / `down` / `left` / `right`) and `amount` (pixels). Returns the new `scrollX` / `scrollY` plus `atBoundary`, so the model can stop scrolling at the page edge instead of looping.
- **Seam 0.4.0**: `BrowserPage.scroll` added to the `@yeesy369/dsh-browser` service definition (`BrowserScrollOptions` / `BrowserScrollResult`).
- **e2e**: real-browser test covers offsets and boundary detection for down / up / edge / defaults.

## 0.4.1 (2026-08-15)

- **Fix duplicate `@deepseek-ai/dsh-tools` breaking the tool scheduler**: moved `dsh-tools`, `dsh-attachment`, `dsh-settings` back to peerDependencies so pnpm no longer installs a second `dsh-tools` copy into the profile; otherwise tool calls fail with `Cannot read properties of undefined (reading 'prepare')` and the turn reports an error.

## 0.4.0 (2026-08-14)

- **Dependency hardening**: `@deepseek-ai/dsh-tools`, `dsh-attachment`, `dsh-settings` moved from peerDependencies to regular dependencies; only `@deepseek-ai/cordis` remains a peer (it must share the host instance).
- **Headless deployment config**: `dsh-browser-playwright` accepts a provider `Config` (`headless` / `channel` / `profileDir`) for server/CI use.
- **e2e stability**: tests use a temp profile + headless; added a tab-reuse / recreate-after-close core test.
- **Docs**: README (zh/en) wording clarified (SSRF-safe by default; permission gate is opt-in strictness); CI example updated.

## 0.3.0 (2026-08-14)

- **a11y refs clicking**: `browser_snapshot` returns actionable refs (`e1`, …) via `ariaSnapshot({ mode: 'ai' })`; `browser_click` accepts a ref or CSS selector.
- **Auto-remember approved hosts**: `web-permission.remember` (default `true`) appends an approved host to `allowHosts` (persisted to settings.yaml).
- **`browser_evaluate`**: gated tool, disabled by default (`tool-browser` config `evaluate: true`).
