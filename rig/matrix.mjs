/**
 * __pr-d-rig/matrix.mjs — measure what the extension's `nav` / `tabs.open`
 * report vs. what the tab is really showing, across scenarios that stress the
 * "did the new document arrive yet?" question.
 *
 * For every scenario we record:
 *   - the command's own result and how long it took (elapsedMs)
 *   - GROUND TRUTH immediately after it returns (in-page location.href /
 *     readyState / title, read with the extension's own `eval` command)
 *   - GROUND TRUTH again after the page had time to settle
 *
 * usage: node matrix.mjs <label>            (writes evidence-<label>.json)
 */
import fs from 'node:fs'

const CTL = 'http://127.0.0.1:9781/ctl/cmd'
const BASE = 'http://localhost:9781'
const LABEL = process.argv[2] || 'run'
const TRUTH_EXPR = 'JSON.stringify({href: location.href, ready: document.readyState, title: document.title})'

async function ext(command, params = {}, timeoutMs = 40000) {
  const res = await fetch(CTL, { method: 'POST', body: JSON.stringify({ command, params, timeoutMs }) })
  return res.json()
}

async function truth(tabId) {
  try {
    const r = await ext('eval', { expression: TRUTH_EXPR, ...(tabId === undefined ? {} : { tabId }) }, 10000)
    if (!r.ok) return { error: r.error }
    const raw = r.result
    const text = typeof raw === 'string' ? raw : (raw?.value ?? raw?.json ?? JSON.stringify(raw))
    try { return JSON.parse(text) } catch { return { raw: text } }
  } catch (err) { return { error: String(err.message) } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function activeTabId() {
  const r = await ext('tabs.list', {})
  return r.result?.activeTabId
}

async function closeExtras() {
  const r = await ext('tabs.list', {})
  const tabs = r.result?.tabs ?? []
  for (const t of tabs.slice(1)) await ext('tabs.close', { tabId: t.id })
}

const scenarios = [
  {
    name: 'nav-local-slow',
    what: 'active tab (already loaded) -> a page whose body takes 3 s',
    async run() { return ext('nav', { url: `${BASE}/slow?ms=3000` }) },
    settleMs: 4000,
  },
  {
    name: 'open-local-slow',
    what: 'tabs.open -> a page whose body takes 3 s',
    async run() { return ext('tabs.open', { url: `${BASE}/slow?ms=3000` }) },
    settleMs: 4000,
  },
  {
    name: 'nav-hang',
    what: 'active tab -> a server that accepts and never answers (navigation stuck before commit)',
    async run() { return ext('nav', { url: `${BASE}/hang` }) },
    settleMs: 5000,
  },
  {
    name: 'open-hang',
    what: 'tabs.open -> a server that accepts and never answers',
    async run() { return ext('tabs.open', { url: `${BASE}/hang` }) },
    settleMs: 5000,
  },
  {
    name: 'nav-blackhole-ip',
    what: 'active tab -> a non-routable IP (TCP connect black hole)',
    async run() { return ext('nav', { url: 'http://10.255.255.1:8080/' }) },
    settleMs: 8000,
  },
  {
    name: 'open-blackhole-ip',
    what: 'tabs.open -> a non-routable IP',
    async run() { return ext('tabs.open', { url: 'http://10.255.255.1:8080/' }) },
    settleMs: 8000,
  },
  {
    name: 'nav-bad-host',
    what: 'active tab -> a host that cannot resolve (RFC 2606 .invalid)',
    async run() { return ext('nav', { url: 'http://rig-nx.invalid/' }) },
    settleMs: 6000,
  },
  {
    name: 'nav-timeout-40s-page',
    what: 'active tab -> a page that finishes after 40 s (extension timeout is 15 s)',
    async run() { return ext('nav', { url: `${BASE}/slow?ms=40000` }) },
    settleMs: 3000,
  },
  {
    name: 'nav-background-tab-slow',
    what: 'navigate a NON-active tab -> a page whose body takes 3 s',
    async prepare() {
      await closeExtras()
      const opened = await ext('tabs.open', { url: `${BASE}/fast` })
      await sleep(1200)
      return opened.result?.tabId
    },
    async run(target) { return ext('nav', { url: `${BASE}/slow?ms=3000`, tabId: target }) },
    settleMs: 4000,
  },
]

const out = { label: LABEL, startedAt: new Date().toISOString(), scenarios: [] }

for (const s of scenarios) {
  console.log(`\n### ${s.name} — ${s.what}`)
  await closeExtras()
  const baseline = await ext('nav', { url: `${BASE}/fast` })
  await sleep(1200)
  const target = s.prepare ? await s.prepare() : (baseline.result?.tabId ?? await activeTabId())
  await sleep(300)
  const before = await truth(target)
  const started = Date.now()
  const result = await s.run(target)
  const wallMs = Date.now() - started
  // For tabs.open the interesting tab is the new one, not the one we navigated.
  const observed = result?.result?.tabId ?? target
  const atReturn = await truth(observed)
  await sleep(s.settleMs)
  const settled = await truth(observed)
  const record = {
    name: s.name, what: s.what, targetTabId: target, observedTabId: observed,
    before, commandResult: result, wallMs, truthAtReturn: atReturn, truthAfterSettle: settled,
  }
  out.scenarios.push(record)
  console.log('  before            :', JSON.stringify(before))
  console.log('  result            :', JSON.stringify(result))
  console.log('  truth at return   :', JSON.stringify(atReturn))
  console.log(`  truth +${s.settleMs}ms     :`, JSON.stringify(settled))
}

await closeExtras()
out.finishedAt = new Date().toISOString()
fs.writeFileSync(new URL(`./evidence-${LABEL}.json`, import.meta.url).pathname, JSON.stringify(out, null, 2))
console.log(`\nwrote evidence-${LABEL}.json`)
