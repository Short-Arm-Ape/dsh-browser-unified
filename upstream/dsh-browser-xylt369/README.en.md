# dsh-browser

**English** | [中文](README.md) | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [العربية](README.ar.md)

Browser capability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): navigation, accessibility snapshots, click/fill, tabs, screenshots, and vision-ready image attachments.

Host targets: **dsh `0.1.0-rc.7` / `0.1.1-rc.2`**. Defaults to local **Microsoft Edge** (persistent profile + lightweight stealth) and tolerates Clash/Surge fake-ip DNS.

Published versions:

| Package | Version |
|---|---|
| `@yeesy369/dsh-browser` | `0.6.0` |
| `@yeesy369/dsh-browser-playwright` | `0.8.1` |
| `@yeesy369/dsh-tool-browser` | `0.7.0` |
| `@yeesy369/dsh-web-permission` | `0.6.1` |

Release: https://github.com/xylt369/dsh-browser/releases/tag/v0.8.1

---

## Install

1. Ensure `dsh` is available (`dsh --version`), or install with `npm i -g @deepseek-ai/dsh`.
2. Add the plugins:

```sh
dsh plugin --profile web add \
  @yeesy369/dsh-browser-playwright@0.8.1 \
  @yeesy369/dsh-tool-browser@0.7.0 \
  @yeesy369/dsh-web-permission@0.6.1
```

3. Restart `dsh web`.
4. Ask the agent to open a page. For login-required sites, sign in once in the Edge window (`~/.dsh/edge-profile`).

When upgrading an existing install, use the versioned `plugin add` commands above, then restart `dsh web`.

---

## Settings UI (0.8.x)

Primary configuration lives in **dsh Web → Settings → Plugins**. After install and restart, two official plugin cards appear (YAML is no longer the main path).

### Web permission gate

Controls which hosts browser/fetch tools may reach. Saves apply **immediately** (live).

| Control | Meaning |
|---|---|
| Allowed hosts | One hostname per line |
| Denied hosts | One hostname per line; deny wins (defaults include `localhost`, `metadata.google.internal`) |
| Gated tool names | Tools whose `url` argument is inspected |
| Default action for hosts on neither list | `Allow` or `Ask` |
| Remember approved hosts on the allow list | After an `Ask` approval, append the host automatically |

Use **Discard** / **Save**; overridden fields can **Reset** to the composed default.

### Browser window

Controls launch mode and DNS compatibility. Saves apply after a **dsh restart** or the **next browser launch**.

| Control | Meaning |
|---|---|
| Window mode | `Visible window` / `Hidden window` / `Headless` |
| Lightweight stealth patch | On by default |
| Allow proxy fake-ip DNS | On by default; permits Clash/Surge `198.18.0.0/15` answers |

| Mode | Best for | Trade-off |
|---|---|---|
| Visible | Manual login / captcha | Desktop window |
| Hidden | Real browser, no clutter | No visible window; needs a desktop session |
| Headless | Servers / CI | Weaker against aggressive bot detection; no manual login |

Optional `@yeesy369/dsh-browser-settings` adds a sidebar panel. Prefer the Plugins cards above for day-to-day use.

---

## Model-facing capabilities

| Capability | Tools |
|---|---|
| Navigate | `browser_navigate` (URL-guarded) |
| Read | `browser_snapshot` (actionable refs such as `e1`, `f29e86`) |
| Interact | `browser_click` / `type` / `fill` / `press` / `scroll` / `wait` / `back` / `forward` |
| Tabs | `browser_tabs` / `open_tab` / `switch_tab` / `close_tab` (per session) |
| Screenshot | `browser_screenshot` → durable attachment + `image` ContentBlock |
| In-page JS | `browser_evaluate` (off by default; enable via YAML / `cordis.patch.yml`) |

---

## Security

- Public `http(s)` only; private / loopback / link-local / metadata blocked (`url-guard.ts`).
- Proxy fake-ip (`198.18.0.0/15`) allowed by default; real private ranges stay blocked.
- Permission gate defaults to allow for unknown hosts; switch to Ask when you need approval.
- Stealth is best-effort, not a bypass for every anti-bot stack.

YAML / `cordis.patch.yml` remain valid deployment surfaces and write the same settings namespaces.

---

## Packages

| Package | Role |
|---|---|
| `@yeesy369/dsh-browser` | Service Definition (`ctx.browser`) |
| `@yeesy369/dsh-browser-playwright` | Playwright provider + Browser window card |
| `@yeesy369/dsh-tool-browser` | Model-facing `browser_*` tools |
| `@yeesy369/dsh-web-permission` | `tools/pre-execute` gate + Web permission card |
| `@yeesy369/dsh-browser-settings` | Optional sidebar panel |

---

## Optional YAML

Most options belong in the Web cards. Use YAML for automation or fields not yet on a card:

```yaml
web-permission:
  defaultAction: ask
  remember: true
```

```yaml
- id: browser-playwright
  config:
    windowVisibility: visible
    stealth: true
    allowFakeIp: true
- id: tool-browser
  config:
    evaluate: false
```

---

## Development

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

See [architecture](./docs/architecture.md), [CONTRIBUTING](./CONTRIBUTING.md), [AGENTS](./AGENTS.md), [MIT License](./LICENSE).

Uninstall:

```sh
dsh plugin --profile web remove \
  @yeesy369/dsh-browser-playwright \
  @yeesy369/dsh-tool-browser \
  @yeesy369/dsh-web-permission
```
