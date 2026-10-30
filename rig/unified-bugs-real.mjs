#!/usr/bin/env node
/**
 * unified-bugs-real.mjs — 真机证据（rig：真 Edge + 真扩展 + 假桥）：
 *
 *   [A] browser_press 一次按键只落一次输入（改前应看到 value="xx" / input=2）
 *   [B] browser_emulate 无 UA 覆盖时的**原样回包**（插件侧归一化的前提事实：
 *       扩展回的是显式 `userAgent: null` 还是干脆不带这个字段）
 *
 * 用法：node unified-bugs-real.mjs [--out evidence.json]
 * 前置：__pr-d-rig/stub.mjs 在 9781 上跑着，且 rig 浏览器已 deploy 某个 ext-<tag>。
 * 只读页面 + 只按两次键，不碰用户真实 profile。
 */
import fs from 'node:fs'

const BASE = process.env.RIG_BASE || 'http://127.0.0.1:9781'
const PAGE = process.env.RIG_PAGE || 'http://localhost:9781/press'
const WANT_TAG = process.env.RIG_TAG || null
const outArg = process.argv.indexOf('--out')
const OUT = outArg > 0 ? process.argv[outArg + 1] : null

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

async function ctl(command, params = {}, timeoutMs = 25000) {
  const res = await fetch(`${BASE}/ctl/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, params, timeoutMs }),
  })
  const body = await res.json()
  if (!body.ok) throw new Error(`${command} failed: ${body.error}`)
  return body.result
}

const ev = async (expression) => (await ctl('eval', { expression })).value
const state = async () => JSON.parse(await ev('JSON.stringify(window.__state())'))
const resetText = async () => { await ev('__reset()') }
const resetForm = async () => { await ev('__resetForm()') }

/* ---------------------------------------------------------------- 0. 等扩展 */
let hello = null
for (let i = 0; i < 30; i += 1) {
  const s = await (await fetch(`${BASE}/ctl/state`)).json()
  if (s.connected) { hello = s.hello; break }
  await new Promise((r) => setTimeout(r, 1000))
}
if (hello === null) { console.error('扩展没连上，放弃'); process.exit(2) }
console.log(`桥已连：rigTag=${hello.rigTag} version=${hello.version} browser=${hello.browser?.name} ${hello.browser?.version}`)
if (WANT_TAG !== null && hello.rigTag !== WANT_TAG) {
  console.error(`跑的不是要测的那一版：期望 rigTag=${WANT_TAG}，实际 ${hello.rigTag}`)
  process.exit(2)
}

const nav = await ctl('nav', { url: PAGE })
console.log(`已到 ${nav.url}（${nav.title}）\n`)

/* --------------------------------------------------- A. 一次按键 = 一次输入 */
console.log('[A] browser_press：按一次，页面上只该多一个字符')
await resetText()
await ctl('press', { key: 'x' })
const afterX = await state()
check('字母 x：value === "x"（不是 "xx"）', afterX.value === 'x', `实际 ${JSON.stringify(afterX.value)}`)
check('字母 x：input 事件 = 1', afterX.input === 1, `实际 ${afterX.input}`)
check('字母 x：keypress = 1', afterX.keypress === 1, `实际 ${afterX.keypress}`)

await resetText()
await ctl('press', { key: '7' })
const after7 = await state()
check('数字 7：value === "7"', after7.value === '7', `实际 ${JSON.stringify(after7.value)}`)

await resetText()
await ctl('press', { key: 'x', modifiers: ['shift'] })
const afterShiftX = await state()
// 只断言"一次按键 = 一个字符"。大小写是**另一条独立的瑕疵**（Shift+X 目前落成小写 x，
// 因为 text 直接取 key 原文），不在本次修复范围，故意不在这里钉死。
check('Shift+X：只插入 1 个字符', afterShiftX.value.length === 1, `实际 ${JSON.stringify(afterShiftX.value)}`)

/* --------------------------------------------------------- A2. Enter 只提交一次 */
await resetForm()
await ctl('press', { key: 'Enter' })
const afterEnter = await state()
check('Enter：表单只提交 1 次', afterEnter.submit === 1, `实际 ${afterEnter.submit}`)

/* ------------------------------------------- A3. 对照：不带 text 的键不插字符 */
await resetText()
await ctl('press', { key: 'ArrowRight' })
const afterArrow = await state()
check('ArrowRight（不带 text）：不插入任何字符', afterArrow.value === '', `实际 ${JSON.stringify(afterArrow.value)}`)
check('ArrowRight：keydown 仍然发生', afterArrow.keydown === 1, `实际 ${afterArrow.keydown}`)

/* --------------------------------------------- B. emulate 无 UA 时的原样回包 */
console.log('\n[B] browser_emulate：无 UA 覆盖时扩展回的是什么（插件侧归一化的前提）')
const emuDesktop = await ctl('emulate', { device: 'desktop' })
const uaInDesktop = Object.prototype.hasOwnProperty.call(emuDesktop, 'userAgent')
console.log(`  device:"desktop" 回包 = ${JSON.stringify(emuDesktop)}`)
if (uaInDesktop) {
  check('device:"desktop" 回包里 userAgent 是显式 null（这就是插件侧必须归一化的原因）',
    emuDesktop.userAgent === null, `实际 ${JSON.stringify(emuDesktop.userAgent)}`)
} else {
  check('device:"desktop" 回包里根本没有 userAgent 字段（插件侧无需归一化）', true)
}
await ctl('emulate', { device: 'reset' })
console.log('  已 reset 回默认视口')

/* ------------------------------------------------------------------- 收尾 */
const failed = checks.filter((c) => !c.ok)
console.log(`\n合计 ${checks.length} 项，失败 ${failed.length} 项`)
const evidence = {
  at: new Date().toISOString(),
  rigTag: hello.rigTag,
  extensionVersion: hello.version,
  browser: hello.browser,
  page: nav.url,
  press: { afterX, after7, afterShiftX, afterEnter, afterArrow },
  emulate: { desktop: emuDesktop },
  checks,
}
if (OUT !== null) { fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n'); console.log(`证据写到 ${OUT}`) }
process.exit(failed.length === 0 ? 0 : 1)
