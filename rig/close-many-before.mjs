/**
 * close-many-before.mjs — 对照组：**当前 main**（未改造）的扩展在真浏览器里长什么样。
 *
 * 结论要能对上台：这一版没有 `tabs.closeMany`；单数 `tabs.close` 回的是标量
 * `{closed: 7}`；关一个已经不在的标签是**报错**而不是幂等成功（⇒ 重试不安全，
 * 而且"前面已经关掉的"在结果里看不见）。用法: node close-many-before.mjs <rigTag> <outJson>
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const RIG = `http://127.0.0.1:${process.env.RIG_PORT || 9781}`
const TAG = process.argv[2] ?? 'B0'
const OUT = process.argv[3] ?? fileURLToPath(new URL(`./evidence-${TAG}-real-browser.json`, import.meta.url))
const steps = []; let fails = 0
const check = (name, ok, detail = '') => { if (!ok) fails++; steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`) }
const cmd = async (command, params = {}, timeoutMs = 20000) => {
  const res = await fetch(`${RIG}/ctl/cmd`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, params, timeoutMs }) })
  return await res.json()
}
const list = async () => (await cmd('tabs.list')).result
const open = async (url = `${RIG}/fast`) => (await cmd('tabs.open', { url, wait: false })).result.tabId

const state = await (await fetch(`${RIG}/ctl/state`)).json()
check(`加载的是 ${TAG}（未改造的 main）`, state.hello?.rigTag === TAG, JSON.stringify(state.hello))
const base = (await list()).count

const many = await cmd('tabs.closeMany', { tabIds: [1, 2] })
check('对照：这一版没有 tabs.closeMany（真机确认）', many.ok === false && /unknown command/i.test(String(many.error)), String(many.error))

const a = await open()
const one = await cmd('tabs.close', { tabId: a })
check('对照：单数 tabs.close 回的是标量 {closed: n}', typeof one.result?.closed === 'number', JSON.stringify(one.result))
const again = await cmd('tabs.close', { tabId: a })
check('对照：关一个已经不在的标签 → 报错，而不是 alreadyGone（重试不安全）', again.ok === false && !/alreadyGone/.test(JSON.stringify(again)), `${again.ok} ${String(again.error)}`)

/* 关 3 个标签要 3 次往返；中途一个失败，前面的结果就丢了 */
const ids = [await open(), await open(), await open()]
const results = []
for (const id of [ids[0], 999999, ids[1], ids[2]]) {
  const out = await cmd('tabs.close', { tabId: id })
  results.push({ id, ok: out.ok, result: out.result, error: out.error, elapsedMs: out.elapsedMs })
}
check('对照：一次一个 → 4 个 id 要 4 条命令（本可一条）', results.length === 4, `elapsed=${results.map((r) => r.elapsedMs).join('/')}ms`)
const failedMid = results.filter((r) => !r.ok)
check('对照：中间那个不存在的 id 直接抛错，而"它前面已关掉的"不在这个结果里',
  failedMid.length === 1 && !('alreadyGone' in (failedMid[0].result ?? {})), JSON.stringify(failedMid[0]))
const after = await list()
check('对照：浏览器侧确实少了 3 个（副作用发生了，但报告里看不出来）', after.count === base, `base=${base} after=${after.count}`)
check('对照：扩展仍然活着（ping）', (await cmd('ping')).ok === true)

writeFileSync(OUT, JSON.stringify({ rigTag: TAG, hello: state.hello, baseCount: base, fails, steps, roundTrips: results }, null, 1))
console.log(`\n对照组跑完（${fails === 0 ? '与预期一致' : fails + ' 项不符'}）—— 证据写入 ${OUT}`)
process.exit(fails === 0 ? 0 : 1)
