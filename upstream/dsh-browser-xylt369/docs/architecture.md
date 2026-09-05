# dsh-browser architecture

The browser capability follows DeepSeek Harness's "everything is a plugin" model: a Service Definition declares the seam, a Service Provider implements it, and a Consumer exposes it to the model. Nothing is hard-coded into the harness core.

## Seam shape

`@yeesy369/dsh-browser` declares `ctx.browser` as an **abstract seam** (the `ctx.subprocess` pattern, one implementation per context):

```ts
export abstract class BrowserRuntime extends Service {
  constructor(ctx: Context) { super(ctx, 'browser') }
  abstract newPage(options?, signal?): Promise<BrowserPage>
  abstract close(signal?): Promise<void>
}
```

A provider subclasses it and is loaded as a plugin, so swapping Playwright for CDP or a remote browser service means loading a different provider — no consumer change.

## Page lifecycle

`BrowserRuntime` owns one persistent browser profile (shared cookies / logins) and **one tab set per `sessionKey`** (typically a harness session id). `newPage({ sessionKey })` returns that session's active tab.

- `navigate` validates the URL through the URL guard, then `goto` with `domcontentloaded`.
- `snapshot` reads the accessibility tree via `ariaSnapshot({ mode: 'ai' })` — the AI mode exposes actionable refs like `[ref=e1]` — falling back to `document.body.innerText`.
- `click` / `fill` / `press` accept an accessibility ref or a CSS selector.
- `scroll` moves the main document by a pixel amount in a direction (default 800px down) and reports the new offset plus an `atBoundary` flag so the model knows when it hit the edge.
- `wait` bounds idle time (and optionally `domcontentloaded`).
- `evaluate` runs a raw JS expression in the page (high risk; the consumer exposes it only behind a config flag).
- `screenshot` produces PNG bytes; the consumer commits them via `ctx.attachments.saveImage`.
- `type` / `back` / `forward` map to Playwright actions.
- `listTabs` / `openTab` / `switchTab` / `closeTab` stay inside one session key.

## Deployment configuration

`dsh-browser-playwright` exposes a provider-level `Config` so the window mode, the browser channel, the persistent profile, and anti-detection are deployment choices. The same namespace is editable from the Web **Plugins** tab (`./client` lazy-CJS card; `windowVisibility` / `stealth` apply on the next browser launch). YAML remains valid:

```yaml
- id: browser-playwright
  config:
    windowVisibility: visible   # visible / hidden / headless
    stealth: true               # lightweight anti-detection patch
    channel: msedge        # or chrome; auto-detected when omitted
    profileDir: ~/.dsh/edge-profile
```

Window mode resolution is per-call override (`newPage({ windowVisibility })`) > provider config > legacy `headless` field > `visible`. `headless` is deprecated but kept so profiles written before `windowVisibility` existed keep working.

The `stealth` option wires launch args (`--disable-blink-features=AutomationControlled`) plus an init script (`packages/browser-playwright/src/stealth.ts`) that patches `navigator.webdriver`, plugins, the WebGL unmasked vendor strings, and the notifications permission — all conditional so a real browser keeps its genuine values. `hidden` mode additionally parks the window offscreen and minimized, keeping the browser fully real (best anti-bot posture) without desktop clutter; it requires a desktop session.

## Screenshot → attachment

Screenshots are not returned as raw bytes to the model. The consumer stores them through the `ctx.attachments` seam, returns the durable `ImageAttachmentRef`, and `output.render` emits both a text caption and an `{ type: 'image', attachment }` ContentBlock so vision adapters / Files API can consume the tool result.

## URL guard (anti-SSRF)

`browser-playwright/src/url-guard.ts` is the single owner of navigation safety:

1. reject non-`http(s)` schemes and URLs with embedded credentials;
2. block a default hostname list (`localhost`, cloud metadata endpoints, …);
3. reject private/loopback/link-local/multicast/reserved IP literals;
4. resolve the hostname and reject any non-public result (resolve-then-validate).

The guard is exercised by unit tests for the pure IP classifiers and the scheme/credential/literal branches.

## Permission integration

`@yeesy369/dsh-web-permission` gates web/browser tools at `tools/pre-execute` (waterfall):

- it reads `exec.name` and the `url` argument, then classifies the hostname as allowlist / denylist / ask;
- a denylisted host returns `{ kind: 'deny', reason }`;
- with `defaultAction: 'ask'`, an unknown host routes through `ctx.approval`; with `remember` (default `true`), an approved host is appended to `allowHosts` (persisted to settings.yaml), so it is not asked again;
- an allowlisted host delegates via `next()`.

The classification logic lives in `src/policy.ts` as pure functions so it is unit-testable without a live harness.

`browser_evaluate` ships but is **disabled by default** (`tool-browser` config `evaluate: true` to enable) because it is arbitrary code execution; the permission gate should be tightened alongside it.

## Limitations and roadmap

- **Residual SSRF TOCTOU** — Playwright owns the connection; the DNS check and the browser's connect are separate. A proxy or `--host-resolver-rules` pin is the follow-up.
- **Shared cookies, isolated tabs** — sessions share the persistent Edge profile (that is the login feature). They do not share tabs. True cookie isolation would require a second profile directory.
- **Settings UI cards** — Host registers with `inject: ['settings']` and `expose: 'web'`; each of `web-permission` and `browser-playwright` also ships a lazy-CJS `./client` card into `settings.plugin.item`. YAML/`cordis.patch.yml` still work. Window-mode / fake-ip changes apply on the next browser launch (`applies: restart`).
- **Proxy fake-ip** — `allowFakeIp` (default on) permits Clash/Surge DNS answers in `198.18.0.0/15` so public sites work behind system fake-ip DNS; true private ranges remain blocked.

## Composition

The Provider, Consumer, and permission gate are bundles. Their patch rows are:

```yaml
- insert:
    - id: browser-playwright
      name: '@yeesy369/dsh-browser-playwright'
- insert:
    - id: tool-browser
      name: '@yeesy369/dsh-tool-browser'
- insert:
    - id: web-permission
      name: '@yeesy369/dsh-web-permission'
```
