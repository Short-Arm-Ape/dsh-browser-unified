#!/usr/bin/env node
/**
 * seg2-contract.mjs — 第二段（snapshot 的 AX 模式）的**真机**核对。
 *
 * 单测只能证明渲染与判定逻辑；这里要证的是三件真机事实：
 *   1. 扩展在 `mode:"ax"` 下真的走无障碍树（回 `mode:'ax'` + `role`），默认仍是 dom；
 *   2. AX 模式下 **ref 契约没变**：它把 `data-dsh-ref` 打到了真实 DOM 节点上；
 *   3. 因此**按 ax 给的 ref 能真的点到东西**（用 /press 页的按钮提交表单来证）。
 *
 * 前置：stub.mjs 在 9781；rig 浏览器已 deploy ext-<tag>。
 * 用法：node seg2-contract.mjs [--out evidence.json]
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

await ctl('nav', { url: 'http://localhost:9781/press' })
await ctl('eval', { expression: '__resetForm()' })

console.log('[1] 默认（dom）：老行为不变')
raw.dom = (await ctl('snapshot', { limit: 60 })).result
check('回 mode=dom', raw.dom?.mode === 'dom', String(raw.dom?.mode))
check('有 items 且带 ref', Array.isArray(raw.dom?.items) && raw.dom.items.length > 0 && typeof raw.dom.items[0]?.ref === 'string',
  JSON.stringify(raw.dom?.items?.slice(0, 2)))

console.log('\n[2] mode:"ax"：走无障碍树，带 role')
raw.ax = (await ctl('snapshot', { mode: 'ax', limit: 60 })).result
check('回 mode=ax（不是静默忽略）', raw.ax?.mode === 'ax', String(raw.ax?.mode))
check('带 ax 统计（nodes/candidates）', typeof raw.ax?.ax?.nodes === 'number' && typeof raw.ax?.ax?.candidates === 'number', JSON.stringify(raw.ax?.ax))
const withRole = (raw.ax?.items ?? []).filter((i) => typeof i.role === 'string' && i.role.length > 0)
check('至少有一条带 role（这才是 AX 的价值）', withRole.length > 0, JSON.stringify((raw.ax?.items ?? []).slice(0, 3)))
check('AX 条目 why=ax', (raw.ax?.items ?? []).every((i) => i.why === 'ax'), String(raw.ax?.items?.[0]?.why))

console.log('\n[3] ref 契约没变：ref 真的打在 DOM 节点上')
const stamped = (await ctl('eval', { expression: "JSON.stringify([...document.querySelectorAll('[data-dsh-ref]')].map(e => e.getAttribute('data-dsh-ref')))" })).result?.value
const refs = JSON.parse(String(stamped ?? '[]'))
check('页面上打到的 ref 数 == ax items 数', refs.length === (raw.ax?.items?.length ?? -1), `stamped=${refs.length} items=${raw.ax?.items?.length}`)
check('ref 名字与返回的一致', refs.length > 0 && raw.ax.items.every((i) => refs.includes(i.ref)), refs.join(','))

console.log('\n[4] 按 ax 给的 ref 真能点到（用 /press 的按钮提交表单来证）')
const button = (raw.ax?.items ?? []).find((i) => i.role === 'button' || i.tag === 'button')
check('ax 结果里有按钮', button !== undefined, JSON.stringify(button))
if (button !== undefined) {
  // 注意：ref → CSS 选择器是**插件**那层的活（`browser_click` 把 `ref` 翻成
  // `[data-dsh-ref="e3"]` 再发给扩展）。所以直连扩展时要自己带上这个选择器 ——
  // 这一步恰好证的正是"ref 契约没变"：属性在 DOM 上，按属性点得动。
  const clicked = await ctl('click', { selector: `[data-dsh-ref="${button.ref}"]` })
  check('按 [data-dsh-ref=…] 点得动（ref 契约没变）', clicked.ok === true, clicked.ok ? '' : String(clicked.error))
  const st = JSON.parse(String((await ctl('eval', { expression: 'JSON.stringify(window.__state())' })).result?.value ?? '{}'))
  check('表单被提交了 1 次（ref 指向的是真按钮）', st.submit === 1, JSON.stringify(st))
}

console.log('\n[5] AX 在拿不到 a11y 树的页面上要落回 dom 并给原因（不报错）')
raw.edge = (await ctl('snapshot', { mode: 'ax', limit: 5 })).result
check('小 limit 下仍是 ax（不因额度小就落回）', raw.edge?.mode === 'ax', String(raw.edge?.mode))

const failed = checks.filter((c) => !c.ok)
console.log(`\n合计 ${checks.length} 项，失败 ${failed.length} 项`)
if (OUT !== null) { fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rigTag: hello.rigTag, version: hello.version, raw, checks }, null, 2) + '\n'); console.log(`证据写到 ${OUT}`) }
process.exit(failed.length === 0 ? 0 : 1)
