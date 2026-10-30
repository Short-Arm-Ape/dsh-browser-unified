/**
 * close-many-real.mjs — 真浏览器证据：`tabs.closeMany` 到底有没有真的关掉标签。
 *
 * 为什么还需要这一层：`verify/verify_tabs_close_many.mjs` 跑的是 node:vm + **假** chrome.tabs，
 * 它只能证明"按 Chrome 文档写的行为是对的"。模型/维护者真正要问的那句是
 * "真 Chrome 里它会不会真的关掉 N 个标签、并且自己没崩" —— 那需要一台真浏览器。
 *
 * 台子：__pr-d-rig/stub.mjs（9781，跑的就是桥的线协议）+ headless Edge 155 +
 * 全新 profile，`hello` 帧带 rigTag 证明加载的是哪一版 background.js。
 *
 * 用法: node close-many-real.mjs <rigTag> <outJson>
 */
const RIG = 'http://127.0.0.1:9781'
const TAG = process.argv[2] ?? 'C1'
const OUT = process.argv[3] ?? `/home/wsluser/projects/__pr-E/evidence-${TAG}-real-browser.json`
import { writeFileSync } from 'node:fs'

const steps = []
let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}
const cmd = async (command, params = {}, timeoutMs = 20000) => {
  const res = await fetch(`${RIG}/ctl/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, params, timeoutMs }),
  })
  return await res.json()
}
const list = async () => {
  const out = await cmd('tabs.list')
  return out.ok ? out.result : null
}
const open = async (url = `${RIG}/fast`) => {
  const out = await cmd('tabs.open', { url, wait: false })
  if (!out.ok) throw new Error('tabs.open failed: ' + out.error)
  return out.result.tabId
}
/** 每个 id 恰好出现一次：`closed ∪ alreadyGone ∪ failed = requested`（本 PR 的核心承诺）。 */
const accountsForEveryId = (r, expected) => {
  const seen = [...r.closed, ...r.alreadyGone, ...(r.failed ?? []).map((f) => f.tabId)]
  const uniq = [...new Set(seen)]
  return {
    ok: r.requested === expected.length && uniq.length === expected.length && expected.every((id) => uniq.includes(id)) && seen.length === uniq.length,
    detail: `requested=${r.requested} seen=${JSON.stringify(seen)} expected=${JSON.stringify(expected)}`,
  }
}

const state = await (await fetch(`${RIG}/ctl/state`)).json()
check(`加载的是 ${TAG} 这一版扩展（rigTag 闸门）`, state.hello?.rigTag === TAG, JSON.stringify(state.hello))
check('真浏览器是 Edge', /Edg\//.test(state.hello?.browser?.ua ?? ''), state.hello?.browser?.version)

const before = await list()
const baseCount = before.count
console.log(`# 起始标签数 = ${baseCount}（含浏览器自带的新标签页）`)

/* 1 —— 一批全在：真关掉 3 个，浏览器自己说它们没了 */
{
  const ids = [await open(), await open(), await open()]
  const out = await cmd('tabs.closeMany', { tabIds: ids })
  check('closeMany 成功返回', out.ok === true, out.ok ? '' : String(out.error))
  const r = out.result ?? {}
  check('三个 id 都报 closed', JSON.stringify(r.closed) === JSON.stringify(ids), JSON.stringify(r))
  check('每个 id 都有去向（不吞副作用）', accountsForEveryId(r, ids).ok, accountsForEveryId(r, ids).detail)
  const after = await list()
  check('浏览器侧真的少了 3 个标签', after.count === baseCount, `before=${baseCount} after=${after.count}`)
  check('关掉的 id 在列表里确实不存在', ids.every((id) => !after.tabs.some((t) => t.id === id)), `remaining=${after.tabs.map((t) => t.id).join(',')}`)
  console.log(`   耗时 ${out.elapsedMs}ms；一次调用关 ${ids.length} 个`)
}

/* 2 —— 同一批再关一次：幂等，不抛错，全落 alreadyGone */
{
  const ids = [await open(), await open()]
  await cmd('tabs.closeMany', { tabIds: ids })
  const out = await cmd('tabs.closeMany', { tabIds: ids })
  const r = out.result ?? {}
  check('重试不报错', out.ok === true, out.ok ? '' : String(out.error))
  check('重试全部落在 alreadyGone（幂等成功）', JSON.stringify(r.alreadyGone) === JSON.stringify(ids) && (r.closed ?? []).length === 0 && (r.failed ?? []).length === 0, JSON.stringify(r))
  check('重试也把每个 id 交代清楚', accountsForEveryId(r, ids).ok, accountsForEveryId(r, ids).detail)
}

/* 3 —— 单数命令与批量同形状 */
{
  const id = await open()
  const one = await cmd('tabs.close', { tabId: id })
  const r = one.result ?? {}
  check('单数 tabs.close 与批量同形状', JSON.stringify(r) === JSON.stringify({ requested: 1, closed: [id], alreadyGone: [], failed: [] }), JSON.stringify(r))
  const again = await cmd('tabs.close', { tabId: id })
  check('单数重复关闭：幂等成功', JSON.stringify(again.result?.alreadyGone) === JSON.stringify([id]), JSON.stringify(again.result))
}

/* 4 —— 混合：一个还活着、一个早就关了 */
{
  const alive = await open()
  const gone = await open()
  await cmd('tabs.close', { tabId: gone })
  const out = await cmd('tabs.closeMany', { tabIds: [alive, gone] })
  const r = out.result ?? {}
  check('混合批次：活着的进 closed', JSON.stringify(r.closed) === JSON.stringify([alive]), JSON.stringify(r))
  check('混合批次：已消失的进 alreadyGone（不连坐）', JSON.stringify(r.alreadyGone) === JSON.stringify([gone]), JSON.stringify(r))
  check('混合批次：没有 failed', (r.failed ?? []).length === 0, JSON.stringify(r.failed))
  check('混合批次也交代了每个 id', accountsForEveryId(r, [alive, gone]).ok, accountsForEveryId(r, [alive, gone]).detail)
}

/* 5 —— 入参清洗（真扩展里也要一样） */
{
  const id = await open()
  const out = await cmd('tabs.closeMany', { tabIds: [id, id, 'x', -1, 0, null] })
  const r = out.result ?? {}
  check('重复与非法 id 被清洗去重（真机同行为）', r.requested === 1 && JSON.stringify(r.closed) === JSON.stringify([id]), JSON.stringify(r))
  const empty = await cmd('tabs.closeMany', { tabIds: [] })
  check('空数组明确报错', empty.ok === false && /non-empty array/.test(String(empty.error)), String(empty.error))
}

/* 6 —— 竞态：同一批里有一个正被另一条命令关掉 */
{
  const p = await open()
  const q = await open()
  const [many, single] = await Promise.all([
    cmd('tabs.closeMany', { tabIds: [p, q] }),
    cmd('tabs.close', { tabId: q }),
  ])
  const r = many.result ?? {}
  const accounted = many.ok ? accountsForEveryId(r, [p, q]) : { ok: false, detail: 'closeMany 报错: ' + many.error }
  check('并发下 closeMany 仍然把两个 id 都交代清楚', accounted.ok, accounted.detail)
  check('并发下两个标签最终都关掉了（不管谁关的）', !(await list()).tabs.some((t) => t.id === p || t.id === q), `single.ok=${single.ok} p=${p} q=${q}`)
  console.log(`   closeMany: ${JSON.stringify(many.result)}  |  tabs.close: ${JSON.stringify(single.result ?? single.error)}`)
}

/* 7 —— 干完这些活，浏览器和扩展还活着 */
{
  const out = await cmd('ping')
  check('扩展还活着（ping）', out.ok === true, out.ok ? `${out.elapsedMs}ms` : String(out.error))
  const after = await list()
  check('浏览器标签台账仍可读', typeof after?.count === 'number', `count=${after?.count}`)
  check('没有留下没人管的孤儿标签', after.count === baseCount, `期望回到 ${baseCount}，实际 ${after.count}（多余的：${after.tabs.filter((t) => !/^edge:|about:/.test(t.url)).map((t) => t.id + ':' + t.url).join(' ')}）`)
}

writeFileSync(OUT, JSON.stringify({ rigTag: TAG, hello: state.hello, baseCount, fails, steps }, null, 1))
console.log(`\n${fails === 0 ? '真浏览器侧全部通过' : fails + ' 项失败'} —— 证据写入 ${OUT}`)
process.exit(fails === 0 ? 0 : 1)
