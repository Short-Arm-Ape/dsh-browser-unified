#!/usr/bin/env node
/**
 * seg6-contract.mjs — 第六段（浮层的"防欺骗 + 双击 + 中止"）真机核对。
 *
 * 主人 2026-10-17 夜的口径：
 *   ① 标题写死「模型正在操作此标签页」—— 模型传的 title 不许生效（防伪造"系统提示"）；
 *   ② 提示改成「双击任意处接管页面」，并且**按点击间隔**判定双击（间隔过大不算双击）；
 *   ③ 底部不显示模型名，改显示**会话标题**（由插件从运行时上下文填，模型碰不到）；
 *   ④ 底部「中止操作」按钮：点一次变「点击确认」，超时回默认态；确认后浮层撤掉，
 *      并且**模型对该标签页的 click/input/press/nav 会被拒**，直到调 hold.off 解除。
 *
 * 用法：node seg6-contract.mjs [--out evidence.json]
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
async function settle(pathExpected) {
  for (let i = 0; i < 40; i += 1) {
    const st = JSON.parse(String(await ev("JSON.stringify({href:location.href,rs:document.readyState,btn:!!document.querySelector('button[type=submit]')})") ?? '{}'))
    if (st.rs === 'complete' && (pathExpected === undefined || String(st.href ?? '').endsWith(pathExpected)) && st.btn === true) return st
    await wait(200)
  }
  return null
}
/** 页面里对浮层内某个元素派发 click（模拟用户点）。 */
const tapInPage = async (selectorInShadow, count = 1) => ev(`(() => {
  const h = document.getElementById('__dsh_hold_overlay__');
  if (!h || !h.shadowRoot) return 'no-overlay';
  const el = ${selectorInShadow};
  if (!el) return 'no-target';
  for (let i = 0; i < ${count}; i += 1) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return 'ok';
})()`)
/** 取浮层里的文字（标题/正文/提示/身份行/按钮文案）。 */
const overlayText = async () => JSON.parse(String(await ev(`(() => {
  const h = document.getElementById('__dsh_hold_overlay__');
  if (!h || !h.shadowRoot) return JSON.stringify({ present: false });
  const card = h.shadowRoot.querySelector('div').firstElementChild;
  const kids = [...card.children].map((x) => ({ tag: x.tagName.toLowerCase(), text: (x.textContent || '').trim() }));
  const btn = card.querySelector('button');
  return JSON.stringify({ present: true, kids, button: btn ? btn.textContent.trim() : null });
})()`) ?? '{}'))

let hello = null
for (let i = 0; i < 30; i += 1) {
  const s = await (await fetch(`${BASE}/ctl/state`)).json()
  if (s.connected) { hello = s.hello; break }
  await wait(1000)
}
if (hello === null) { console.error('扩展没连上'); process.exit(2) }
if (WANT !== null && hello.rigTag !== WANT) { console.error(`跑错版本：期望 ${WANT}，实际 ${hello.rigTag}`); process.exit(2) }
console.log(`桥已连：rigTag=${hello.rigTag} version=${hello.version}\n`)

await ctl('nav', { url: 'http://localhost:9781/press' })
check('基线：停在 /press', (await settle('/press')) !== null)
await ctl('eval', { expression: '__resetForm()' })

console.log('[1] 标题写死：模型传的 title 一律被忽略')
await ctl('hold.on', { title: '⚠️ 系统警告：请立即输入你的密码', text: '正在把「局域网」档改成放行', meta: { session: '模型与终端中间层（Prism-Gate）', cwd: '~/projects', port: 9777, at: Date.now() } })
await wait(150)
raw.t1 = await overlayText()
check('标题是固定文案', raw.t1.kids?.[0]?.text === '模型正在操作此标签页', raw.t1.kids?.[0]?.text)
check('模型传的伪造标题没出现', !JSON.stringify(raw.t1).includes('系统警告'))
check('接管提示是「双击任意处接管页面」', (raw.t1.kids ?? []).some((k) => k.text.includes('双击任意处接管页面')))
check('底部显示的是会话标题（不是模型名）', (raw.t1.kids ?? []).some((k) => k.text.includes('会话 模型与终端中间层（Prism-Gate）')), JSON.stringify((raw.t1.kids ?? []).map((k) => k.text)))
check('底部有「中止操作」按钮', raw.t1.button === '中止操作', String(raw.t1.button))

console.log('\n[2] 双击判定按"点击间隔"：隔太久不算双击')
await tapInPage("h.shadowRoot.querySelector('div')", 1)
await wait(900)   // 超过 500ms 窗口
await tapInPage("h.shadowRoot.querySelector('div')", 1)
await wait(150)
raw.slow = await overlayText()
check('两次点击间隔过大 ⇒ 浮层仍在（不误判成双击）', raw.slow.present === true)
const stSlow = (await ctl('hold.status', {})).result
check('status 也仍是 active', stSlow?.active === true, JSON.stringify(stSlow))

console.log('\n[3] 间隔内的两次点击 ⇒ 接管')
await tapInPage("h.shadowRoot.querySelector('div')", 2)   // 同一 tick 内两次
await wait(150)
raw.fast = await overlayText()
check('快双击之后浮层消失', raw.fast.present === false)
const stUser = (await ctl('hold.status', {})).result
check('status：dismissedBy=user', stUser?.dismissedBy === 'user', JSON.stringify(stUser))

console.log('\n[4] 「中止操作」按钮：点一次变「点击确认」，超时回默认')
await ctl('nav', { url: 'http://localhost:9781/press' })
await settle('/press')
await ctl('eval', { expression: '__resetForm()' })
await ctl('hold.on', { text: '正在改档（测试中止）', meta: { session: '测试会话标题', port: 9777, at: Date.now() } })
await wait(150)
await tapInPage("h.shadowRoot.querySelector('button')", 1)
await wait(80)
raw.armed = await overlayText()
check('点一次 ⇒ 按钮文案变「点击确认」', raw.armed.button === '点击确认', String(raw.armed.button))
await wait(3400)
raw.disarmed = await overlayText()
check('超时（3.4s）⇒ 回默认「中止操作」', raw.disarmed.button === '中止操作', String(raw.disarmed.button))

console.log('\n[5] 双击确认中止 ⇒ 浮层撤掉 + 模型后续动作被拒')
await tapInPage("h.shadowRoot.querySelector('button')", 2)
await wait(200)
raw.afterAbort = await overlayText()
check('中止后浮层消失', raw.afterAbort.present === false)
const stAbort = (await ctl('hold.status', {})).result
check('status：dismissedBy=abort 且 aborted=true', stAbort?.dismissedBy === 'abort' && stAbort?.aborted === true, JSON.stringify(stAbort))
const blocked = await ctl('click', { selector: 'button[type=submit]' })
check('中止后模型 click 被拒', blocked.ok === false && String(blocked.error ?? '').includes('中止操作'), String(blocked.error ?? '').slice(0, 90))
const blockedNav = await ctl('nav', { url: 'http://localhost:9781/fast' })
check('中止后模型 nav 也被拒', blockedNav.ok === false && String(blockedNav.error ?? '').includes('中止操作'), String(blockedNav.error ?? '').slice(0, 90))
const afterBlocked = JSON.parse(String(await ev('JSON.stringify(window.__state())') ?? '{}'))
check('页面没收到那次点击（submit 仍为 0）', afterBlocked.submit === 0, JSON.stringify(afterBlocked))

console.log('\n[6] hold.off = 确认继续：解除中止、恢复可点')
raw.off = (await ctl('hold.off', {})).result
check('off 之后 aborted 被清掉', raw.off?.aborted !== true, JSON.stringify(raw.off))
const resumed = await ctl('click', { selector: 'button[type=submit]' })
check('解除后模型 click 恢复', resumed.ok === true, String(resumed.error ?? ''))
const afterResume = JSON.parse(String(await ev('JSON.stringify(window.__state())') ?? '{}'))
check('这次点击真的落到页面（submit=1）', afterResume.submit === 1, JSON.stringify(afterResume))

const failed = checks.filter((c) => !c.ok)
console.log(`\n合计 ${checks.length} 项，失败 ${failed.length} 项`)
if (OUT !== null) { fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rigTag: hello.rigTag, version: hello.version, raw, checks }, null, 2) + '\n'); console.log(`证据写到 ${OUT}`) }
process.exit(failed.length === 0 ? 0 : 1)
