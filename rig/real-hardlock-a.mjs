// real-hardlock-a.mjs — 真浏览器证据：headless Edge（Windows 本机）+ 未打包的**上游扩展**，
// 弹窗页面跑在自己的扩展源里，由「真实按钮的 click 事件」在 +8s 锁上、+16s 再点一次解锁；
// 探针每秒发一条 ping，把冻结窗口按秒画出来。
//
// 为什么 ping 就够：本地锁拦的是 runCommand 入口，26 条命令走同一个闸门；ping 最便宜，
// 能把窗口按秒画出来，而且它被拒这件事本身证明连接还在（回复是扩展回的话）——这正是
// 设计目标「连得上但被冻结」，不是掉线。
//
// 弹窗页在 headless 里的开法：命令行给 `chrome-extension://…/popup.html` 当起始 URL
// **不会真的加载**（tab 标题会退化成 URL 本身，说明是错误页）；用扩展自己的
// `tabs.open` 打开同一个地址才会真的跑起来（标题被页面 JS 改写就是证据）。
import fs from 'node:fs'

const BASE = process.env.RIG_BASE || 'http://127.0.0.1:9781'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ctl = async (command, params = {}, timeoutMs = 6000) =>
  (await fetch(`${BASE}/ctl/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, params, timeoutMs }),
  })).json()

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

let state = { connected: false }
for (let i = 0; i < 60; i++) {
  state = await (await fetch(`${BASE}/ctl/state`)).json()
  if (state.connected === true) break
  await sleep(500)
}
if (state.connected !== true) {
  console.error('扩展没连上桥：' + JSON.stringify(state))
  process.exit(2)
}
console.log(`hello: ${JSON.stringify(state.hello.browser)} rigTag=${state.hello.rigTag} extId=${state.hello.extId}`)

// 0) 起始状态：未锁，命令可用。
// 桥刚报 connected 的那一瞬间第一条命令可能撞上 stub 自己的握手收尾（同一个桥地址上
// 先跑一次「预热」，预热结果照原样打出来，不参与断言）。
const warm = await ctl('ping')
console.log(`预热 ping: ${JSON.stringify(warm).slice(0, 160)}`)
let first = warm
for (let i = 0; i < 5 && first.ok !== true; i++) {
  await sleep(500)
  first = await ctl('ping')
}
check('扩展连上且未锁：ping 正常', first.ok === true, JSON.stringify(first).slice(0, 160))
const tabsBefore = await ctl('tabs.list')
check('未锁：只读命令（tabs.list）也正常', tabsBefore.ok === true, `tabs=${tabsBefore.result?.count}`)

// 1) 「用户打开弹窗」：用扩展自己的 tabs.open 载入 popup 页面（headless 里没有工具栏可点）
const opened = await ctl('tabs.open', { url: `chrome-extension://${state.hello.extId}/popup.html` })
check('弹窗页面在真浏览器里真的跑起来了（标题被页面 JS 改写成 rig-js-loaded）',
  opened.ok === true && /popup\.html$/.test(opened.result?.url ?? ''), String(opened.result?.title))
await sleep(1000)

// 2) 每秒一条 ping，跨越页面里那两次真实点击
const rows = []
const t0 = Date.now()
for (let i = 0; i < 22; i++) {
  const res = await ctl('ping')
  const t = Number(((Date.now() - t0) / 1000).toFixed(1))
  rows.push({ t, ok: res.ok === true, error: res.ok ? null : String(res.error) })
  console.log(`${String(t).padStart(5)}s  ${res.ok ? 'ok     ' : 'REFUSED'}  ${res.ok ? JSON.stringify(res.result) : String(res.error).slice(0, 80)}`)
  await sleep(1000)
}

// 3) 冻结窗口的形状
const firstRefused = rows.findIndex((r) => !r.ok)
const lastRefused = rows.map((r) => !r.ok).lastIndexOf(true)
const frozen = rows.slice(firstRefused, lastRefused + 1)
check('开始时未锁，命令照常执行', firstRefused > 0 && rows.slice(0, firstRefused).every((r) => r.ok))
check('真实按钮点击后开始拒绝，且冻结窗口是连续的一段',
  firstRefused > 0 && lastRefused > firstRefused && frozen.every((r) => !r.ok),
  `窗口 ${rows[firstRefused]?.t}s → ${rows[lastRefused]?.t}s（共 ${frozen.length} 条）`)
check('冻结期每条命令都是同一种拒绝文案', new Set(frozen.map((r) => r.error)).size === 1)
check('拒绝文案点名解锁只能由用户在弹窗里点「已锁定」完成',
  /解锁只能由用户在浏览器工具栏的扩展弹窗里点「已锁定」完成/.test(frozen[0]?.error ?? ''), frozen[0]?.error?.slice(0, 120))
check('拒绝文案劝退重试', /不要重试/.test(frozen[0]?.error ?? ''))
check('窗口之后恢复：解锁不是自己发生的，是页面第二次点击', lastRefused < rows.length - 1 && rows.slice(lastRefused + 1).every((r) => r.ok))

// 4) 解锁后：只读命令恢复，两次点击都来自弹窗页面本身，且冻结期间没有副作用
const after = await ctl('tabs.list')
check('解锁后只读命令恢复', after.ok === true, `tabs=${after.result?.count}`)
const pageTitle = after.result?.tabs?.find((t) => /popup\.html$/.test(t.url))?.title
check('两次点击都来自弹窗页面本身（标题 rig-click-2）', pageTitle === 'rig-click-2', String(pageTitle))
check('冻结过一次也没有多出/少掉标签页（点击没有落到页面上）',
  (after.result?.count ?? -1) === (tabsBefore.result?.count ?? -2) + 1,
  `${tabsBefore.result?.count} -> ${after.result?.count}（+1 是这次打开的弹窗页）`)

const out = { at: new Date().toISOString(), rigTag: state.hello.rigTag, extId: state.hello.extId, browser: state.hello.browser, rows, fails }
fs.writeFileSync(new URL('./evidence-hardlock-real.json', import.meta.url).pathname, JSON.stringify(out, null, 2))
console.log(fails === 0 ? '\n真浏览器：本地锁符合契约' : `\n${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
