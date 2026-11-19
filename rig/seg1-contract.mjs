#!/usr/bin/env node
/**
 * seg1-contract.mjs — 第一段（吸收上游 v1.0.9~v1.0.13）的**扩展侧契约**真机核对。
 *
 * 为什么单独跑这一层：插件里三个新工具（browser_find / browser_dialog / browser_info）以及
 * nav 的 `pendingUrl`，都**建立在对扩展回包形状的假设**上。假设错了两边都不报错、
 * 只是渲染出一片空白或 `undefined`。所以这里用真扩展把形状打出来，逐条核。
 *
 * 前置：stub.mjs 在 9781；rig 浏览器已 deploy ext-<tag>（扩展 = 我们当前源码）。
 * 用法：node seg1-contract.mjs [--out evidence.json]
 */
import fs from 'node:fs'

const BASE = process.env.RIG_BASE || 'http://127.0.0.1:9781'
const WANT = process.env.RIG_TAG || null
const outArg = process.argv.indexOf('--out')
const OUT = outArg > 0 ? process.argv[outArg + 1] : null

const checks = []
const raw = {}
function check(name, ok, detail) { checks.push({ name, ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`) }

async function ctl(command, params = {}, timeoutMs = 30000) {
  const res = await fetch(`${BASE}/ctl/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, params, timeoutMs }) })
  return res.json()
}

let hello = null
for (let i = 0; i < 30; i += 1) {
  const s = await (await fetch(`${BASE}/ctl/state`)).json()
  if (s.connected) { hello = s.hello; break }
  await new Promise((r) => setTimeout(r, 1000))
}
if (hello === null) { console.error('扩展没连上'); process.exit(2) }
console.log(`桥已连：rigTag=${hello.rigTag} version=${hello.version}\n`)
if (WANT !== null && hello.rigTag !== WANT) { console.error(`跑错版本：期望 ${WANT}，实际 ${hello.rigTag}`); process.exit(2) }

console.log('[1] browser.info —— 插件假设 {client, version, browser:{name,version,ua}}')
raw.info = (await ctl('browser.info')).result
check('有 client / version / browser.name / browser.version / browser.ua',
  typeof raw.info?.client === 'string' && typeof raw.info?.version === 'string'
  && typeof raw.info?.browser?.name === 'string' && typeof raw.info?.browser?.version === 'string'
  && typeof raw.info?.browser?.ua === 'string', JSON.stringify(raw.info).slice(0, 160))

console.log('\n[2] find —— 插件假设 {count, items:[{tag,id?,class?,text?,href?,rect:{x,y,w,h}}]}')
await ctl('nav', { url: 'http://localhost:9781/press' })
raw.find = (await ctl('find', { selector: '#i' })).result
const item = raw.find?.items?.[0]
check('count 是数字且 items 是数组', typeof raw.find?.count === 'number' && Array.isArray(raw.find?.items), JSON.stringify(raw.find).slice(0, 160))
check('item 有 tag/id/rect{x,y,w,h}', typeof item?.tag === 'string' && item?.id === 'i'
  && typeof item?.rect?.x === 'number' && typeof item?.rect?.y === 'number' && typeof item?.rect?.w === 'number' && typeof item?.rect?.h === 'number',
  JSON.stringify(item))
check('选择器没命中时 count=0 且 items 为空（不是报错）',
  (await ctl('find', { selector: '#nope-nope' })).result?.count === 0)

console.log('\n[3] dialog —— 插件假设 {policy, answered?, recent:[{tabId,type,message,answeredAs,t}]}')
raw.dialog = (await ctl('dialog', {})).result
check('policy 是 accept|dismiss|manual 之一', ['accept', 'dismiss', 'manual'].includes(raw.dialog?.policy), String(raw.dialog?.policy))
check('recent 是数组', Array.isArray(raw.dialog?.recent), JSON.stringify(raw.dialog).slice(0, 120))
raw.dialogSet = (await ctl('dialog', { policy: 'manual' })).result
check('设 policy=manual 会回显新策略', raw.dialogSet?.policy === 'manual', String(raw.dialogSet?.policy))
await ctl('dialog', { policy: raw.dialog.policy })

console.log('\n[4] 读正文：确认真机回来的是完整正文（插件的窗口切片依赖这一点）')
await ctl('nav', { url: 'http://localhost:9781/press' })
raw.content = (await ctl('content', { mode: 'text' })).result
check('content 是字符串且带 title/url', typeof raw.content?.content === 'string' && typeof raw.content?.title === 'string',
  `len=${String(raw.content?.content ?? '').length}`)

console.log('\n[5] nav 的 pendingUrl —— 用「慢但有限」的页面造"这次没等到落地"')
// /hang 是**永远**不回应（会连 CDP 探针一起挂住，见 bi-036）；这里用 /slow 让"落地等待"
// 先超时、而页面稍后自己完成 —— 这才是 pendingUrl 要覆盖的常态（慢站/SPA 首屏）。
raw.navPendingResp = await ctl('nav', { url: 'http://localhost:9781/slow?ms=8000', timeoutMs: 1500 }, 30000)
raw.navPending = raw.navPendingResp.result
check('loadPending=true', raw.navPending?.loadPending === true, JSON.stringify(raw.navPending ?? raw.navPendingResp).slice(0, 220))
check('pendingUrl 指向 /slow（或 tabs 的 pendingUrl）',
  typeof raw.navPending?.pendingUrl === 'string' && raw.navPending.pendingUrl.includes('/slow'), String(raw.navPending?.pendingUrl))

const failed = checks.filter((c) => !c.ok)
console.log(`\n合计 ${checks.length} 项，失败 ${failed.length} 项`)
if (OUT !== null) { fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rigTag: hello.rigTag, version: hello.version, raw, checks }, null, 2) + '\n'); console.log(`证据写到 ${OUT}`) }
process.exit(failed.length === 0 ? 0 : 1)
