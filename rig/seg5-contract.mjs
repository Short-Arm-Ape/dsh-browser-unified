#!/usr/bin/env node
/**
 * seg5-contract.mjs — 第五段（防误触浮层 `hold`）的真机核对。
 *
 * 主人定的硬要求（2026-10-17）：「**不能改页面本身的逻辑** —— 这玩意是在页面之上的，不影响前端元素」。
 * 所以真要证的不是"浮层能显示"，而是下面五条：
 *
 *   1. 浮层铺满视口、内容在 **Shadow DOM** 里（页面 CSS 进不来、我们的样式也漏不出去）；
 *   2. **页面本体一字未动**：只多了一个 host 元素，`body.innerHTML` / `document.styleSheets.length` / 页面计数器全都不变；
 *   3. 浮层在场时，**真实命中点**落在浮层上（`elementFromPoint` 打到 host）⇒ 用户点不到页面按钮（防误触）；
 *   4. **模型自己的点击能穿过**（扩展派发前把浮层临时设成 pointer-events:none）⇒ 锁住之后模型还能干活；
 *   5. **用户连点两下任意处** ⇒ 浮层撤掉、`dismissedBy: 'user'`；页面恢复可点；导航后浮层自然消失（status 不假装还锁着）。
 *
 * 用法：node seg5-contract.mjs [--out evidence.json]
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
const ev = async (expression) => (await ctl('eval', { expression })).result?.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** 等页面就绪（readyState=complete 且 href 命中）—— 台子在文档切换瞬间会返回 undefined。 */
async function settle(expectPath) {
  for (let i = 0; i < 40; i += 1) {
    const st = JSON.parse(String(await ev("JSON.stringify({href:location.href,rs:document.readyState,btn:!!document.querySelector('button[type=submit]')})") ?? '{}'))
    if (st.rs === 'complete' && (expectPath === undefined || String(st.href ?? '').endsWith(expectPath)) && st.btn === true) return st
    await wait(200)
  }
  return null
}

let hello = null
for (let i = 0; i < 30; i += 1) {
  const s = await (await fetch(`${BASE}/ctl/state`)).json()
  if (s.connected) { hello = s.hello; break }
  await new Promise((r) => setTimeout(r, 1000))
}
if (hello === null) { console.error('扩展没连上'); process.exit(2) }
if (WANT !== null && hello.rigTag !== WANT) { console.error(`跑错版本：期望 ${WANT}，实际 ${hello.rigTag}`); process.exit(2) }
console.log(`桥已连：rigTag=${hello.rigTag} version=${hello.version}\n`)

const nav0 = await ctl('nav', { url: 'http://localhost:9781/press' })
let onPress = false
for (let i = 0; i < 20; i += 1) {
  const href = String(await ev('location.href') ?? '')
  if (href.endsWith('/press')) { onPress = true; break }
  await new Promise((r) => setTimeout(r, 250))
}
check('基线：确实停在 /press 页面', onPress && nav0.ok !== false, `nav.ok=${nav0.ok}`)
await settle('/press')
await ctl('eval', { expression: '__resetForm()' })

console.log('[0] 基线：页面本体指纹（浮层出现前后必须一致）')
const fingerprint = async () => JSON.parse(String(await ev(`JSON.stringify({
  bodyLen: document.body.innerHTML.length,
  sheets: document.styleSheets.length,
  nodes: document.body.querySelectorAll('*').length,
  state: window.__state(),
})`) ?? '{}'))
const before = await fingerprint()
check('基线拿到页面指纹', before.bodyLen > 0, JSON.stringify(before))

console.log('\n[1] 装上浮层：铺满视口 + Shadow DOM')
raw.on = (await ctl('hold.on', { text: '正在把「局域网」档改成放行', title: '模型正在操作这个标签页' })).result
await wait(150)
check('hold.on 回 active=true', raw.on?.active === true, JSON.stringify(raw.on))
check('内容装在 Shadow DOM 里', raw.on?.shadow === true, JSON.stringify(raw.on))
const overlay = JSON.parse(String(await ev(`(() => { const h = document.getElementById('__dsh_hold_overlay__'); if (!h) return 'null';
  const r = h.getBoundingClientRect(); const root = h.shadowRoot;
  const wrap = root ? root.querySelector('div') : null;
  return JSON.stringify({ rect: { w: Math.round(r.width), h: Math.round(r.height) }, iw: innerWidth, ih: innerHeight,
    text: root ? root.textContent.slice(0, 120) : '', hasShadow: !!root, zIndex: getComputedStyle(h).zIndex }); })()`) ?? 'null'))
check('浮层铺满视口（宽高 == 视口）', overlay?.rect?.w === overlay?.iw && overlay?.rect?.h === overlay?.ih, JSON.stringify(overlay?.rect))
check('卡片里写着"模型在做什么"', String(overlay?.text ?? '').includes('局域网'), String(overlay?.text ?? '').slice(0, 60))
check('提示里写明"连点两下接管"', /连点两下|两下|再点一下/.test(String(overlay?.text ?? '')), String(overlay?.text ?? '').slice(-40))
check('z-index 在最上层', overlay?.zIndex === '2147483647', String(overlay?.zIndex))

console.log('\n[2] 页面本体一字未动（只多了一个 host 元素）')
const after = await fingerprint()
check('页面 body 未被改动（长度/节点数一致）', after.bodyLen === before.bodyLen && after.nodes === before.nodes,
  `bodyLen ${before.bodyLen}->${after.bodyLen}, nodes ${before.nodes}->${after.nodes}`)
check('没有往页面加样式表（Shadow DOM 不外泄）', after.sheets === before.sheets, `${before.sheets} -> ${after.sheets}`)
check('页面计数器没被触发（没有假点击）', JSON.stringify(after.state) === JSON.stringify(before.state), JSON.stringify(after.state))
check('host 挂在 <html> 上而不是 <body> 里', await ev(`document.body.contains(document.getElementById('__dsh_hold_overlay__'))`) === false)

console.log('\n[3] 防误触：真实命中点落在浮层上（用户点不到页面按钮）')
const hit = JSON.parse(String(await ev(`(() => {
  const btn = document.querySelector('button[type=submit]');
  const r = btn.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  return JSON.stringify({ topId: top ? (top.id || top.tagName.toLowerCase()) : null, btnTag: btn.tagName.toLowerCase() });
})()`) ?? '{}'))
check('按钮中心点的最上层元素是浮层 host', hit.topId === '__dsh_hold_overlay__', JSON.stringify(hit))

console.log('\n[4] 模型自己的点击仍能穿过浮层')
const clicked = await ctl('click', { selector: 'button[type=submit]' })
check('locked 状态下 click 成功', clicked.ok === true, String(clicked.error ?? ''))
const st = JSON.parse(String(await ev('JSON.stringify(window.__state())') ?? '{}'))
check('页面真的收到了这次点击（submit=1）', st.submit === 1, JSON.stringify(st))

console.log('\n[5] 用户连点两下任意处 ⇒ 接管')
// 连点两下"任意处"：在浮层上派发两次 click（与真实点击走同一条 onTap 逻辑）
const dismissed = await ev(`(() => {
  const h = document.getElementById('__dsh_hold_overlay__');
  const wrap = h.shadowRoot ? h.shadowRoot.querySelector('div') : h;
  wrap.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  wrap.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return document.getElementById('__dsh_hold_overlay__') === null;
})()`)
check('两下之后浮层从 DOM 里消失', dismissed === true)
raw.statusUser = (await ctl('hold.status', {})).result
check('status 报 active=false 且 dismissedBy=user', raw.statusUser?.active === false && raw.statusUser?.dismissedBy === 'user', JSON.stringify(raw.statusUser))
check('撤掉后页面元素恢复可点（命中点回到按钮）', JSON.parse(String(await ev(`(() => {
  const btn = document.querySelector('button[type=submit]'); const r = btn.getBoundingClientRect();
  const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  return JSON.stringify({ top: top ? (top.id || top.tagName.toLowerCase()) : null });
})()`) ?? '{}')).top !== '__dsh_hold_overlay__')
const afterDismiss = await fingerprint()
check('撤掉后页面仍未被改动', afterDismiss.bodyLen === before.bodyLen && afterDismiss.nodes === before.nodes && afterDismiss.sheets === before.sheets)

console.log('\n[6] agent 主动解除 / 导航清理')
await ctl('hold.on', { text: '第二次' })
raw.off = (await ctl('hold.off', {})).result
check('hold.off ⇒ active=false 且 dismissedBy=agent', raw.off?.active === false && raw.off?.dismissedBy === 'agent', JSON.stringify(raw.off))
await ctl('hold.on', { text: '第三次（要被导航带走）' })
await ctl('nav', { url: 'http://localhost:9781/fast' })
raw.statusNav = (await ctl('hold.status', {})).result
check('页面一导航，status 不再假报"还锁着"', raw.statusNav?.active === false, JSON.stringify(raw.statusNav))

console.log('\n[7] 中央块：半透明毛玻璃（页面透过它仍看得见）—— 主人 2026-10-17 的口径：变暗是为了"看清模型在干嘛"，不是挡视线')
await ctl('nav', { url: 'http://localhost:9781/press' })
await settle('/press')
await ctl('hold.on', { text: '正在把「局域网」档改成放行' })
await wait(150)
raw.style = JSON.parse(String(await ev(`(() => {
  const h = document.getElementById('__dsh_hold_overlay__');
  const wrap = h.shadowRoot.querySelector('div');
  const card = wrap.firstElementChild;
  const cs = getComputedStyle(card);
  const ws = getComputedStyle(wrap);
  const titleCs = getComputedStyle(card.firstElementChild);
  return JSON.stringify({
    cardBg: cs.backgroundColor, cardBorder: cs.borderTopWidth, cardShadow: cs.boxShadow,
    cardBackdrop: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
    titleStroke: titleCs.webkitTextStrokeWidth || '0px', titleShadow: titleCs.textShadow,
    wrapBg: ws.backgroundColor, titleSize: parseFloat(titleCs.fontSize),
  });
})()`) ?? '{}'))
const alphaOf = (rgba) => {
  const m = /rgba?\(([^)]+)\)/.exec(String(rgba || ''))
  if (!m) return 1
  const parts = m[1].split(',').map((x) => parseFloat(x))
  return parts.length >= 4 ? parts[3] : 1
}
const cardAlpha = alphaOf(raw.style.cardBg)
check('中央块是**半透明**（alpha 在 0.45~0.80：文字要压得住、页面还要透得出来）', cardAlpha >= 0.45 && cardAlpha <= 0.8, `${raw.style.cardBg} (alpha=${cardAlpha})`)
check('**不做毛玻璃**（backdrop-filter 必须是 none）', String(raw.style.cardBackdrop) === 'none' || raw.style.cardBackdrop === '', String(raw.style.cardBackdrop))
check('整页黑幕更轻了（≤0.5，页面内容看得清）', alphaOf(raw.style.wrapBg) <= 0.5, String(raw.style.wrapBg))
check('标题够大（≥18px）', (raw.style.titleSize || 0) >= 18, String(raw.style.titleSize))
check('没有用文字描边（上次实测会把 13px 正文糊死）', parseFloat(raw.style.titleStroke || '0') === 0, String(raw.style.titleStroke))
await ctl('hold.off', {})

const failed = checks.filter((c) => !c.ok)
console.log(`\n合计 ${checks.length} 项，失败 ${failed.length} 项`)
if (OUT !== null) { fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rigTag: hello.rigTag, version: hello.version, raw, checks }, null, 2) + '\n'); console.log(`证据写到 ${OUT}`) }
process.exit(failed.length === 0 ? 0 : 1)
