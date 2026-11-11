// 在 rig 上复现「nav 到 /hang 就挂住」：同一份 background.js，headless Edge，假桥。
// 用法：node rig/rig.mjs build/lup 之后跑本脚本（端口默认 9781，可用 RIG_PORT 覆盖）。
const PORT = Number(process.env.RIG_PORT || 9781)
const BASE = `http://127.0.0.1:${PORT}`

async function ctl(command, params = {}, timeoutMs = 60000) {
  const started = Date.now()
  const res = await fetch(`${BASE}/ctl/cmd`, { method: 'POST', body: JSON.stringify({ command, params, timeoutMs }) })
  const body = await res.json()
  return { ...body, wallMs: Date.now() - started }
}

const opened = await ctl('tabs.open', { url: `${BASE}/fast`, waitUntil: 'none' }, 20000)
const tabId = opened.result?.tabId
console.log('tabs.open fast ->', opened.ok, opened.wallMs, 'ms tabId=', tabId)

for (const [label, params] of [
  ['nav /hang waitUntil=none', { tabId, url: `${BASE}/hang`, waitUntil: 'none' }],
  ['nav /fast waitUntil=load (control)', { tabId, url: `${BASE}/fast`, waitUntil: 'load' }],
  ['nav /hang waitUntil=load timeoutMs=3000', { tabId, url: `${BASE}/hang`, waitUntil: 'load', timeoutMs: 3000 }],
  ['nav /hang waitUntil=commit timeoutMs=3000', { tabId, url: `${BASE}/hang`, waitUntil: 'commit', timeoutMs: 3000 }],
]) {
  const r = await ctl('nav', params, 60000)
  console.log(`${label}: ok=${r.ok} wall=${r.wallMs}ms elapsed=${r.elapsedMs ?? '?'} loadPending=${r.result?.loadPending} readyState=${r.result?.readyState} err=${r.error ?? ''}`)
}

await ctl('tabs.close', { tabId }, 15000)
console.log('closed')
process.exit(0)
