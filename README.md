# dsh-browser-unified

Browser automation for DeepSeek Harness (dsh) on **your own browser**: a local WebSocket bridge plus a
Chrome/Edge MV3 extension expose `browser_*` tools to the model, with a configurable URL policy in front.
AGPL-3.0-only.

[中文](README.zh.md) · English

| package | version | what it is |
|---|---|---|
| `dsh-browser-unified` | 0.11.34 | the plugin: 31 `browser_*` tools (27 driving a browser + 4 registry/tooling), GUI settings section |
| `browser-unified-core` | 0.1.10 | URL policy, approval layer, bridge (vendored from upstream), guarded bridge |
| `dsh-browser-unified-mit` | 0.1.1 | MIT edition without the bridge and without browser tools |
| extension `DSH Browser Control` | 1.0.37 | MV3 extension; **use this repo's build**, not upstream's |

## Install

Requirements: dsh web (0.1.7+ renders the settings card), Edge or Chrome 116+.

1. **Extension** — download `DSH-Browser-Control-v1.0.37.zip` from
   [Releases](../../releases/latest), unzip anywhere, then `edge://extensions` (Chrome:
   `chrome://extensions`) → enable developer mode → *Load unpacked*. Source: [`extension/`](extension/).
2. **Plugin** — download `browser-unified-core-0.1.10.tgz` and `dsh-browser-unified-0.11.34.tgz` from the
   same release, then:

   ```bash
   dsh plugin --profile web add \
     file:/abs/path/browser-unified-core-0.1.10.tgz \
     file:/abs/path/dsh-browser-unified-0.11.34.tgz
   ```

3. **Restart `dsh web`.** The bundled patch sets `enabled: true`, so the bridge listens on
   `127.0.0.1:9777` right away.

`dsh plugin add github:Short-Arm-Ape/dsh-browser-unified` does **not** work. pnpm resolves the repo root,
which is not a package — it installs an `@short-arm-ape/dsh-browser-unified@0.0.0` stub with no `lib/` and no
`dsh.bundle.patch`, so dsh never mounts it. GitHub installs only fit repos whose root *is* the plugin package.
Use the release tarballs above, or `file:` a checkout's `packages/` entry.

The MIT edition (`dsh-browser-unified-mit`, same release) carries the URL policy, approval and self-update
modules but no bridge and no browser tools.

## Configure

GUI: **Settings → Browser** (0.1.7+). Equivalent YAML in the profile's `cordis.patch.yml`:

```yaml
- id: browser-bridge
  config:
    enabled: true
    urlMode: public      # public | intranet
    blockMetadata: true
    readOnly: false      # true = refuse every state-changing command before it is sent
    allowScript: true    # false = no browser_evaluate
```

Every field, its semantics and the validation rules:
[packages/browser-unified-plugin/README.md](packages/browser-unified-plugin/README.md).

## Tools

Navigation `browser_navigate` / `browser_wait` / `browser_read` / `browser_find` / `browser_snapshot`;
interaction `browser_click` / `browser_type` / `browser_press` / `browser_scroll`;
tabs and frames `browser_tabs` / `browser_frames` / `browser_frame_eval`;
inspection `browser_console_log` / `browser_network_log` / `browser_network_clear` / `browser_screenshot` /
`browser_pdf` / `browser_emulate` / `browser_permissions` / `browser_dialog` / `browser_evaluate`;
session `browser_info` / `browser_launch` / `browser_hold`;
housekeeping `browser_cleanup` / `browser_tools`;
project registry `browser_check_update` / `browser_design_show` / `browser_design_edit` / `browser_issues`.

## Security model

- **The real boundary is the loopback address plus the token** in the profile config. The agent can read and
  rewrite that config, so the token separates you from other local processes — not from the agent.
- **URL policy** — per-realm `allow` / `ask` / `deny` (internet, LAN, loopback), allow and deny host lists,
  cloud-metadata blocking, and an approval prompt for unknown hosts.
- **`readOnly` / `allowScript`** — refused commands never reach the browser, so they leave no side effects.
- **Extension-side hard lock** — the popup's 「锁定」 freezes every browser command; only the popup can undo it.
- **Take-over overlay** — `browser_hold` dims the page and shows what the model is doing; the user
  double-clicks to take the page back, after which the model's click / input / press / nav on that tab are
  refused until it turns the overlay off.

## Verified

- `node tests/run-all.mjs` — 10 suites, 325 assertions, exit 0.
- CI on every push and PR: all three packages build from a clean checkout, those suites run, and
  `lib/client.js` is byte-identical to `client/client.js`.
- Real-browser checks (headless Edge plus the extension under test) are manual; CI never runs a browser.

## Layout

```
packages/browser-unified-core/    AGPL core: url-policy / approval / bridge (vendored) / guarded-bridge
packages/browser-unified-plugin/  dsh plugin: 31 tools, client half, GUI settings section
packages/browser-unified-mit/     MIT edition (no bridge, no browser tools)
extension/                        MV3 extension source
design/registry.json              design entries, impact map, authorization policy
upstream/                         third-party upstream snapshots, each with its own LICENSE
tests/                            10 regression suites + run-all.mjs
```

## Related projects

- [caob23/dsh-browser-control](https://github.com/caob23/dsh-browser-control) — upstream bridge and MV3
  extension this project vendors and extends (AGPL-3.0).
- [dsh-intranet-browser](https://github.com/Short-Arm-Ape/dsh-intranet-browser) — this plugin's predecessor
  (archived); the URL policy and approval layer started there.
- [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) — the host.
- [dsh-plugin.org](https://dsh-plugin.org/) — plugin hub; its install-failure report is where several
  diagnostics in this README come from.

## License

Plugin and core: **AGPL-3.0-only**, which includes code derived from `caob23/dsh-browser-control`.
Per-upstream attribution, versions and license matrix: [NOTICE.md](NOTICE.md).
The MIT edition is MIT-licensed and carries no upstream-derived code.
