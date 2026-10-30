#!/usr/bin/env node
/**
 * seg3-contract.mjs — 第三段（扩展侧）的真机核对。
 *
 * 覆盖五件本段新写进扩展的能力，以及一条本段修掉的缺陷：
 *   1. hello 帧声明 `protocol`（桥据此判断两边帧契约是否一致）；
 *   2. **标签归组**：agent 开的标签进 `DSH` 组，`ungroup` 能解散且**不关标签页**；
 *   3. `parseKeySpec`：`"Ctrl+A"` 这种组合键真的把 ctrl 带到了页面；
 *   4. 未知键名**明确报错**（以前静默什么都不做却回成功）；
 *   5. `tabs.closeMany`：一条命令关一批，并逐 id 交代；
 *   6. bi-036：`/hang`（永不回正文）下 `nav` 必须**在自己的预算内返回**，不再挂到 60s 兜底。
 *
 * 前置：stub.mjs 在 9781；rig 浏览器已 deploy ext-<tag>。
 * 用法：node seg3-contract.mjs [--out evidence.json]
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

let hello = null
for (let i = 0; i < 30; i += 1) {
  const s = await (await fetch(`${BASE}/ctl/state`)).json()
  if (s.connected) { hello = s.hello; break }
  await new Promise((r) => setTimeout(r, 1000))
}
if (hello === null) { console.error('扩展没连上'); process.exit(2) }
if (WANT !== null && hello.rigTag !== WANT) { console.error(`跑错版本：期望 ${WANT}，实际 ${hello.rigTag}`); process.exit(2) }
console.log(`桥已连：rigTag=${hello.rigTag} version=${hello.version}\n`)

console.log('[1] hello 声明了 protocol')
raw.hello = hello
check('hello.protocol === 1', hello.protocol === 1, JSON.stringify(hello.protocol))

console.log('\n[2] 标签归组：开标签自动归组 → ungroup 解散（且不关标签）')
await ctl('nav', { url: 'http://localhost:9781/press' })
raw.open = (await ctl('tabs.open', { url: 'http://localhost:9781/fast' })).result
check('tabs.open 回 grouped=true', raw.open?.grouped === true, JSON.stringify(raw.open))
const beforeUngroup = (await ctl('tabs.list', {})).result
raw.ungroup = (await ctl('tabs.ungroup', {})).result
check('ungroup 报出解散了标签与分组', (raw.ungroup?.groups ?? 0) >= 1 && (raw.ungroup?.ungrouped ?? 0) >= 1, JSON.stringify(raw.ungroup))
const afterUngroup = (await ctl('tabs.list', {})).result
check('ungroup **没有关掉任何标签页**', afterUngroup?.count === beforeUngroup?.count, `before=${beforeUngroup?.count} after=${afterUngroup?.count}`)
raw.ungroup2 = (await ctl('tabs.ungroup', {})).result
check('再拆一次是空操作（幂等）', (raw.ungroup2?.groups ?? 0) === 0, JSON.stringify(raw.ungroup2))

console.log('\n[3] tabs.group：把已有标签拉进 DSH 组')
const tabId = afterUngroup?.tabs?.[0]?.id
raw.group = (await ctl('tabs.group', { tabId })).result
check('tabs.group 回 grouped=true', raw.group?.grouped === true, JSON.stringify(raw.group))
raw.ungroup3 = (await ctl('tabs.ungroup', {})).result
check('归的组是真的（ungroup 能数到它）', (raw.ungroup3?.groups ?? 0) >= 1, JSON.stringify(raw.ungroup3))

console.log('\n[4] parseKeySpec：`"Ctrl+A"` 真的把 ctrl 带到页面')
await ev("window.__keys = []; addEventListener('keydown', (e) => window.__keys.push({ key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey }), true); 'ok'")
await ctl('press', { key: 'Ctrl+A' })
raw.keys = JSON.parse(String(await ev('JSON.stringify(window.__keys || [])') ?? '[]'))
check('页面收到一次 keydown 且 ctrlKey=true', raw.keys.length === 1 && raw.keys[0].ctrl === true, JSON.stringify(raw.keys))
await ev("window.__keys = []; 'ok'")
await ctl('press', { key: 'A', modifiers: ['ctrl', 'shift'] })
raw.keys2 = JSON.parse(String(await ev('JSON.stringify(window.__keys || [])') ?? '[]'))
check('分开写 modifiers 也生效（ctrl+shift）', raw.keys2.length === 1 && raw.keys2[0].ctrl === true && raw.keys2[0].shift === true, JSON.stringify(raw.keys2))

console.log('\n[5] 未知键名明确报错（不再静默成功）')
raw.badKey = await ctl('press', { key: 'Nope' })
check('未知键名 → 失败', raw.badKey.ok === false, JSON.stringify(raw.badKey).slice(0, 160))
check('错误文案说明可用键名与组合写法', /unknown key|Nope/.test(String(raw.badKey.error ?? '')) && /Ctrl\+A/.test(String(raw.badKey.error ?? '')), String(raw.badKey.error ?? '').slice(0, 120))
raw.badModifier = await ctl('press', { key: 'Hyper+A' })
check('未知修饰键 → 失败且指出修饰键', raw.badModifier.ok === false && /modifier/.test(String(raw.badModifier.error ?? '')), String(raw.badModifier.error ?? '').slice(0, 140))

console.log('\n[6] tabs.closeMany：一条命令关一批，逐 id 交代')
const t1 = (await ctl('tabs.open', { url: 'http://localhost:9781/fast', group: false })).result?.tabId
const t2 = (await ctl('tabs.open', { url: 'http://localhost:9781/slow?ms=200', group: false })).result?.tabId
raw.closeMany = (await ctl('tabs.closeMany', { tabIds: [t1, t2, 999999999] })).result
check('requested=3 且不再存在的那条进了 alreadyGone',
  raw.closeMany?.requested === 3 && Array.isArray(raw.closeMany?.alreadyGone) && raw.closeMany.alreadyGone.includes(999999999),
  JSON.stringify(raw.closeMany))
check('两个真标签都关掉了（closed 里都有）',
  Array.isArray(raw.closeMany?.closed) && raw.closeMany.closed.includes(t1) && raw.closeMany.closed.includes(t2),
  JSON.stringify(raw.closeMany?.closed))

console.log('\n[7] bi-036：`/hang` 下 nav 必须在自己预算内返回')
const started = Date.now()
raw.hangResp = await ctl('nav', { url: 'http://localhost:9781/hang', timeoutMs: 2000 }, 20000)
const elapsed = Date.now() - started
check('nav 在 20s 内回来了（不再挂到桥的 60s 兜底）', raw.hangResp.ok === true, `${elapsed}ms ${JSON.stringify(raw.hangResp).slice(0, 120)}`)
check('并且如实报 loadPending（不假装掉地）', raw.hangResp.result?.loadPending === true, JSON.stringify(raw.hangResp.result))

const failed = checks.filter((c) => !c.ok)
console.log(`\n合计 ${checks.length} 项，失败 ${failed.length} 项`)
if (OUT !== null) { fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rigTag: hello.rigTag, version: hello.version, raw, checks }, null, 2) + '\n'); console.log(`证据写到 ${OUT}`) }
process.exit(failed.length === 0 ? 0 : 1)
