#!/usr/bin/env node
/**
 * seg4-contract.mjs — 第四段（标签分组**看得见**）的真机核对。
 *
 * 背景：分组（`tabs.group` / `tabs.ungroup` / 开标签自动归组）在 0.11.22 就有了，但
 * `tabs.list` 只回 id/url/title/active ⇒ **建了组也确认不了某个标签在不在组里**。本段补上
 * 每个标签的 `groupId/groupTitle/groupColor` 与当前全部组的一览 `groups`。
 *
 * 真机要证四件（真 Edge + 真扩展 + 假桥）：
 *   1. 开标签自动归组后，`tabs.list` 里该标签带 `groupTitle: 'DSH'`（且 `groups` 里有它）；
 *   2. `tabs.group` 把**已有**标签拉进组后，list 同样看得见；
 *   3. `tabs.ungroup` 之后再 list，分组字段消失（只解除归属、标签页一个不少）；
 *   4. 未归组的标签不带分组字段（不多占字节、也不会误标）。
 *
 * 用法：node seg4-contract.mjs [--out evidence.json]
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
if (WANT !== null && hello.rigTag !== WANT) { console.error(`跑错版本：期望 ${WANT}，实际 ${hello.rigTag}`); process.exit(2) }
console.log(`桥已连：rigTag=${hello.rigTag} version=${hello.version}\n`)

console.log('[1] 开标签自动归组 ⇒ list 里看得见')
raw.open = (await ctl('tabs.open', { url: 'http://localhost:9781/fast' })).result
const openedId = raw.open?.tabId
raw.list1 = (await ctl('tabs.list', {})).result
const opened = (raw.list1?.tabs ?? []).find((t) => t.id === openedId)
check('开回来的标签在分组里（groupTitle=DSH）', opened?.groupTitle === 'DSH', JSON.stringify(opened))
check('list 回了一览 groups（含 DSH）', Array.isArray(raw.list1?.groups) && raw.list1.groups.some((g) => g.title === 'DSH'), JSON.stringify(raw.list1?.groups))
check('分组带颜色（DSH 应为 blue）', (raw.list1?.groups ?? []).some((g) => g.title === 'DSH' && g.color === 'blue'), JSON.stringify(raw.list1?.groups?.[0]))

console.log('\n[2] 把「已有」标签拉进组 ⇒ 同样看得见')
const other = (raw.list1?.tabs ?? []).find((t) => t.id !== openedId)
check('先确认它本来不在任何组里', other !== undefined && other.groupTitle === undefined, JSON.stringify(other))
if (other !== undefined) {
  raw.group = (await ctl('tabs.group', { tabId: other.id })).result
  raw.list2 = (await ctl('tabs.list', {})).result
  const after = (raw.list2?.tabs ?? []).find((t) => t.id === other.id)
  check('tabs.group 后 list 里带上了组名', after?.groupTitle === 'DSH', JSON.stringify(after))
  check('两个标签在同一个组（groupId 相同）',
    (raw.list2?.tabs ?? []).filter((t) => t.groupTitle === 'DSH').length === 2,
    `组内 ${(raw.list2?.tabs ?? []).filter((t) => t.groupTitle === 'DSH').length} 个`)
}

console.log('\n[3] ungroup 之后分组字段消失，标签页一个不少')
const beforeCount = (raw.list2?.tabs ?? []).length
raw.ungroup = (await ctl('tabs.ungroup', {})).result
raw.list3 = (await ctl('tabs.list', {})).result
check('ungroup 报出解散数量', (raw.ungroup?.groups ?? 0) >= 1, JSON.stringify(raw.ungroup))
check('标签页数量不变（只解除归属、不关标签）', (raw.list3?.tabs ?? []).length === beforeCount, `${beforeCount} -> ${(raw.list3?.tabs ?? []).length}`)
check('list 里再没有分组字段', (raw.list3?.tabs ?? []).every((t) => t.groupTitle === undefined), JSON.stringify((raw.list3?.tabs ?? [])[0]))
check('groups 一览也空了', Array.isArray(raw.list3?.groups) && raw.list3.groups.length === 0, JSON.stringify(raw.list3?.groups))

console.log('\n[4] 未归组的标签不带分组字段（不误标）')
const lone = (raw.list3?.tabs ?? [])[0]
check('未归组标签没有 groupId/groupTitle', lone !== undefined && lone.groupId === undefined && lone.groupTitle === undefined, JSON.stringify(lone))

const failed = checks.filter((c) => !c.ok)
console.log(`\n合计 ${checks.length} 项，失败 ${failed.length} 项`)
if (OUT !== null) { fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rigTag: hello.rigTag, version: hello.version, raw, checks }, null, 2) + '\n'); console.log(`证据写到 ${OUT}`) }
process.exit(failed.length === 0 ? 0 : 1)
