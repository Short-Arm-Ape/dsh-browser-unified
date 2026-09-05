# dsh-intranet-browser
Bypasses the SSRF protection of `@yeesy369/dsh-browser-playwright`

[中文](https://github.com/Short-Arm-Ape/dsh-intranet-browser/blob/main/%E8%AF%B4%E6%98%8E%20.md)

# Overview

This plugin is modified from [`@yeesy369/dsh-browser-playwright`](https://www.npmjs.com/package/@yeesy369/dsh-browser-playwright) (upstream source repo: [xylt369/dsh-browser](https://github.com/xylt369/dsh-browser/)) and keeps the same runtime dependency on the service-definition package [`@yeesy369/dsh-browser`](https://www.npmjs.com/package/@yeesy369/dsh-browser).

This plugin will **⚠️bypass the SSRF protection** of the original plugin (`url-guard.ts`) to facilitate DeepSeek Harness to open local and LAN for page debugging. It will invoke an independent Playwright instance (independent service name, independent profile directory, independent window).

For security reasons, **every `intranet_*` tool call is gated behind user approval** (default `approvalMode: 'per-call'`), and cloud-metadata endpoints stay blocked by default.

# Relationship to the original plugins

| Package name    | Original plugin `browser-playwright` | This plugin `intranet-browser`                               |
| --------------- | ----------------------------- | ------------------------------------------------------------ |
| Service name    | `ctx.browser`                 | `intranet-browser` (separate instance)                       |
| SSRF protection | Strict url-guard, untouched   | Bypassed (metadata block retained)                           |
| Browser window  | Own Edge profile              | **Another** profile (default `~/.dsh/intranet-edge-profile`) |
| Tool names      | `browser_*`                   | `intranet_*`                                                 |
| Approval        | via `web-permission`          | Built-in `ctx.approval` gate (per call)                      |

The two browsers can run side by side.

# Dependency and adaptation version

| Name | Role | Version |
|---------|---------|---------|
| [`xylt369/dsh-browser`](https://github.com/xylt369/dsh-browser/) | Upstream source repo (adapted from `@yeesy369/dsh-browser-playwright`) | `0.8.1` |
| [`@yeesy369/dsh-browser`](https://www.npmjs.com/package/@yeesy369/dsh-browser) | Runtime dependency (`dependencies`: service-definition types) | `^0.6.0` |
| [`DeepSeek Harness`](https://github.com/deepseek-ai/deepseek-harness) | Target host (`dsh` CLI) | `0.1.0-rc.7` / `0.1.1-rc.2` |

## Compatibility matrix

| dsh version | Status | Notes |
|---|---|---|
| `0.1.0-rc.7` | ✅ verified | Peer ranges `>=0.1.0-rc.7 <0.2.0` cover it. The settings `expose` option is gone in rc.7; the plugin no longer passes it. |
| `0.1.1-rc.2` | ✅ verified | devDependencies are pinned to rc.2, so type contracts are checked against this line. |

# Development & Quick start

## 1. Prerequisites

- [DeepSeek Harness CLI (`dsh`)](https://www.npmjs.com/package/@deepseek-ai/dsh): `npm i -g @deepseek-ai/dsh`
- Node.js ≥ 18 and [pnpm](https://pnpm.io/installation) (`npm i -g pnpm`)

## 2. Build the package

Execute in [absolute path to this package]:
```sh
pnpm install
pnpm build      # tsc → lib/, then the client bundle → lib/client.js
pnpm typecheck
pnpm test
```

Unit tests cover the URL policy (metadata block, file/credentials/scheme checks) and the approval-gate decision logic; real-browser behavior can be verified following `browser-playwright`'s e2e pattern.

## 3. Manually install into DeepSeek Harness (web profile)

The package installs from its local path — no npm publish needed.

Windows one-click:
```sh
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

macOS / Linux one-click:
```sh
bash scripts/install.sh
```

Or manually (the script does exactly this):
```sh
dsh plugin --profile web add [absolute path to this package]
```

If there is a running DeepSeek Harness instance, restart it.

The AI calls `intranet_open`; an approval prompt appears (per call by default); only after you approve does navigation happen. Then keep debugging with `intranet_snapshot` / `intranet_click` / `intranet_screenshot` …

# Uninstall

```sh
dsh plugin --profile web remove @short-arm-ape/dsh-intranet-browser
```

# Tools

| Tool | Purpose |
| --- | --- |
| `intranet_open` | Open an http(s) (optionally file) URL; localhost/LAN/private addresses allowed |
| `intranet_snapshot` | Accessibility snapshot of the current page (with refs) |
| `intranet_screenshot` | Screenshot as a durable image attachment (vision-model ready); optional `fullPage` |
| `intranet_click` / `intranet_type` / `intranet_fill` / `intranet_press` | Page interaction |
| `intranet_scroll` / `intranet_wait` | Scrolling and bounded waits (`maxWaitMs`) |
| `intranet_back` / `intranet_forward` | History navigation |
| `intranet_list_tabs` / `intranet_open_tab` / `intranet_switch_tab` / `intranet_close_tab` | Multi-tab management (tabs are isolated per harness session) |
| `intranet_evaluate` | Run raw JS in the page — **only registered when `evaluate: true`** (default off; needs a restart) |
| `intranet_close` | Close the intranet browser window (releases the profile lock) |
| `intranet_arm` / `intranet_disarm` | Only meaningful under `approvalMode: 'arm'`: approve once to activate / deactivate (no-op under `per-call`) |

# Config

`$DSH_HOME/settings.yaml` (hot-reload; also editable under **Settings → Plugin config → Intranet browser** for `approvalMode` / `approvalScope` / `blockMetadata` / `blockedHostnames` / `windowVisibility` / `stealth`; the rest stays YAML):

```yaml
intranet-browser:
  approvalMode: per-call     # per-call (default, prompt every time) | arm (no prompts after intranet_arm)
  approvalScope: all         # all (default, every call prompts) | navigation (read-only calls run free)
  blockMetadata: true        # keep blocking cloud metadata (169.254.169.254 / metadata.google.internal / instance-data …)
  blockedHostnames: []       # extra hostnames/IPs always blocked (normalized: trailing dots, IPv4-mapped IPv6, integer IPs)
  allowFile: false           # allow file:// URLs
  windowVisibility: visible  # visible (default) / hidden / headless — applies on next browser launch
  stealth: true              # lightweight anti-detection
  channel: null              # chrome / msedge, auto-detected when omitted
  profileDir: ~/.dsh/intranet-edge-profile
  maxWaitMs: 60000           # intranet_wait upper bound
  navigationTimeoutMs: 60000 # intranet_open / intranet_back / intranet_forward timeout
  interactionTimeoutMs: 30000 # intranet_click / intranet_fill / intranet_press timeout
  evaluate: false            # expose intranet_evaluate (HIGH RISK); registered at plugin load, restart to toggle
```

# Semantics & limitations

- **The only checks left are**: scheme must be http(s) (plus file when `allowFile`), no embedded credentials (`user:pass@`), and the metadata blocklist by default. **Private-IP / loopback / DNS-resolved screening is gone** — that is the point.
- **The metadata blocklist is enforced at two levels**: the initial navigation URL (before `goto`) AND every request of the browser context (via a route handler) — redirect targets, XHR/fetch, iframes and other subresources are covered, so an approved page cannot 302 or script its way onto a metadata endpoint. The blocklist matches normalized hostnames: trailing dots, IPv4-mapped IPv6 and integer/hex/octal IP variants are handled; vendor endpoints (Azure `metadata.azure.internal`, Tencent `metadata.tencentyun.com`, Aliyun `100.100.100.200`, …) are included.
- **Approval is the last gate**: in the `tools/pre-execute` waterfall, any gated `intranet_*` call that is not approved is denied (fail-closed). Calls also fail when there is no approval service or no agent. Denials and approval-service errors are logged (`[intranet-browser]`).
- **`approvalScope: navigation`** lets read-only calls (`intranet_snapshot` / `intranet_screenshot` / `intranet_scroll` / `intranet_wait` / `intranet_list_tabs`) run without prompting; navigation / write calls still prompt every time. It does NOT bypass the request-level blocklist.
- **Full-access sessions auto-pass**: when the CALLING session's approval policy is `never` (the Full access / danger-full-access preset), `intranet_*` calls pass without prompting — the user already opted out of approval prompts at the session level, matching the trust level of shell / file tools. Switching back to `ask` (e.g. `/permission workspace-write`) restores per-call prompts.
- **Arm mode** disables prompts only for the **current agent**, for the process lifetime; a dsh restart requires `intranet_arm` again. Under `per-call` mode `intranet_arm` is a documented no-op.
- **Timeouts are config-driven**: `maxWaitMs`, `navigationTimeoutMs`, `interactionTimeoutMs` are read from the current config on every call (hot-reload safe); the registered tool timeouts are generous hang guards.
- **Metadata stays blocked by default**; do not disable `blockMetadata` outside networks you fully control (e.g. a cloud VM explicitly testing IMDS).
- Each navigation returns `url / title / statusCode` like the `browser_*` tools.
- Tabs are isolated per harness session; **cookies and local storage are shared across sessions through the single persistent profile** (`~/.dsh/intranet-edge-profile`) — treat logged-in state as session-spanning.

# Model Experience

- The model sees the `intranet_*` tools (descriptions carry the SSRF-bypass + approval notice) plus page text/refs/screenshot attachments; it never sees Playwright or browser internals.
- Under the `ask` policy every `intranet_*` call may trigger an approval prompt; the descriptions tell the model not to spam and to state intent first. Under `never` (Full access) no prompts appear.
- Long snapshots cost tokens; screenshots travel as attachments, not base64.
- `intranet_open` returns the final URL, title and HTTP status code for troubleshooting.
