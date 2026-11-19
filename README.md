# dsh-browser-unified

Browser automation for DeepSeek Harness (dsh) on **your own browser**: a local WebSocket bridge plus a
Chrome/Edge MV3 extension expose `browser_*` tools to the model, with a configurable URL policy in front.
AGPL-3.0-only.

[中文](README.zh.md) · English

| package | version | what it is |
|---|---|---|
| `dsh-browser-unified` | 0.11.54 | the plugin: 31 `browser_*` tools (27 driving a browser + 4 registry/tooling), GUI settings section |
| `browser-unified-core` | 0.1.15 | URL policy, approval layer, bridge (vendored from upstream), guarded bridge, error classification |
| `dsh-browser-unified-mit` | 0.1.1 | MIT edition without the bridge and without browser tools |
| extension `DSH Browser Control` | 1.0.58 | MV3 extension; **use this repo's build**, not upstream's |

## Install

Requirements: dsh web, Edge or Chrome 116+.

1. **Extension** — build this repo's assets with `node src/scripts/build-release.mjs` (writes
   `dist-release/`: the three package tarballs, the extension zip and their `.sha256`), unzip the extension
   zip anywhere, then `edge://extensions` (Chrome: `chrome://extensions`) → enable developer mode →
   *Load unpacked*. Source: [`src/extension/`](src/extension/).
2. **Plugin** — take `browser-unified-core-<ver>.tgz` and `dsh-browser-unified-<ver>.tgz` from
   `dist-release/`, then:

   ```bash
   dsh plugin --profile <profile> add \
     file:/abs/path/browser-unified-core-0.1.15.tgz \
     file:/abs/path/dsh-browser-unified-0.11.54.tgz
   ```

3. **Restart `dsh web`.** The bundled patch sets `enabled: true`, so the bridge listens on
   `127.0.0.1:9777` right away.

`dsh plugin add github:Short-Arm-Ape/dsh-browser-unified` does **not** work: pnpm resolves the repo root,
which is not a package, so the installed entry has no `lib/` and no `dsh.bundle.patch` and dsh never mounts
it. GitHub installs only fit repos whose root *is* the plugin package. Use the tarballs above, or
`file:` a checkout's `src/packages/` entry.

The MIT edition (`dsh-browser-unified-mit`, same release) carries the URL policy, approval and self-update
modules but no bridge and no browser tools.

## Configure

GUI: **Settings → Browser**. Equivalent YAML in the profile's `cordis.patch.yml`:

```yaml
- id: browser-bridge
  config:
    enabled: true
    urlMode: public      # public | intranet
    blockMetadata: true
    readOnly: false      # true = refuse every state-changing command before it is sent
    allowScript: true    # false = no browser_evaluate
    focusMode: auto      # auto = switch the tab without raising the window
```

Every field, its semantics and the validation rules:
[`src/packages/browser-unified-plugin/README.md`](src/packages/browser-unified-plugin/README.md).

## Tools

Navigation `browser_navigate` / `browser_wait` / `browser_read` / `browser_find` / `browser_snapshot`;
interaction `browser_click` / `browser_type` / `browser_press` / `browser_scroll` / `browser_dialog` /
`browser_hold`; tabs and frames `browser_tabs` / `browser_frames` / `browser_frame_eval`;
inspection `browser_console_log` / `browser_network_log` / `browser_network_clear` / `browser_screenshot` /
`browser_pdf` / `browser_emulate` / `browser_permissions` / `browser_evaluate` / `browser_policy_status`;
session `browser_info` / `browser_launch` / `browser_tools`; housekeeping `browser_cleanup`;
project registry `browser_check_update` / `browser_design_show` / `browser_design_edit` / `browser_issues`.

Navigation requests are checked against the URL policy **before** they reach the extension, so a refused
target never touches the browser.

## Security model

- **The real boundary is the loopback address plus the token** in the profile config. The agent can read and
  rewrite that config, so the token separates you from other local processes — not from the agent.
- **URL policy** — per-realm `allow` / `ask` / `deny` (internet, LAN, loopback), allow and deny host lists,
  cloud-metadata blocking, and an approval prompt for unknown hosts.
- **`readOnly` / `allowScript`** — refused commands never reach the browser, so they leave no side effects;
  `evalNavGuard` compares the tab address after `browser_evaluate` and reports a script that navigated away.
- **Take-over overlay** — `browser_hold` dims the page and shows what the model is doing; the user
  double-clicks to take the page back, after which the model's click / input / press / nav on that tab are
  refused until it turns the overlay off.
- **Focus discipline** — `focusMode: auto` switches tabs without raising the window, so an agent command
  does not steal focus while you are working elsewhere.

## Verified

- `node src/tests/run-all.mjs` — 20 suites, exit 0. Suites use fake WebSockets and their own ports; they
  never touch a real browser.
- Real-browser checks (Edge plus the extension under test) are manual; CI never runs a browser.

## Layout

```
src/packages/browser-unified-core/    AGPL core: url-policy / approval / bridge (vendored) / error map
src/packages/browser-unified-plugin/  dsh plugin: 31 tools, client half, GUI settings section
src/packages/browser-unified-mit/     MIT edition (no bridge, no browser tools)
src/extension/                        MV3 extension source
src/design/                           design entries, impact map, authorization policy
src/upstream/                         upstream license texts only; sources pinned by SHA in upstream-baseline.json
src/tests/                            20 regression suites + run-all.mjs
rig/                                  real-browser test rig
```

## Related projects

- [caob23/dsh-browser-control](https://github.com/caob23/dsh-browser-control) — upstream bridge and MV3
  extension this project vendors and extends (AGPL-3.0).
- [dsh-intranet-browser](https://github.com/Short-Arm-Ape/dsh-intranet-browser) — this plugin's predecessor
  (archived); the URL policy and approval layer started there.
- [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) — the host.

## License

Plugin and core: **AGPL-3.0-only**, which includes code derived from `caob23/dsh-browser-control`.
Per-upstream attribution, versions and license matrix: [NOTICE.md](NOTICE.md).
The MIT edition is MIT-licensed and carries no upstream-derived code.

Upstream sources are not vendored: `src/upstream/` keeps the license texts and `upstream-baseline.json`
keeps one public repository plus commit SHA per upstream.
