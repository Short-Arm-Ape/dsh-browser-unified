#!/usr/bin/env node
/**
 * rig/probe-scenario.mjs — 一个最小的真机场景：导航到慢页，然后用**扩展自己的 eval**
 * 把页面真实状态读回来（ground truth），而不是相信 nav 的回执。
 *
 * 这是 probe.sh 的可移植版本：端口/输出位置都从环境与自身位置推导。
 * 用法：node rig/probe-scenario.mjs <label>
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const RIG_DIR = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.RIG_PORT || 9781)
const LABEL = process.argv[2] || 'probe'
const BASE = `http://127.0.0.1:${PORT}`
const OUT = path.join(RIG_DIR, `evidence-${LABEL}.txt`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lines = []
const log = (s) => { lines.push(s); console.log(s) }

async function call(command, params = {}, timeoutMs = 45000) {
  const res = await fetch(`${BASE}/ctl/cmd`, { method: 'POST', body: JSON.stringify({ command, params, timeoutMs }) })
  return res.json()
}

async function truth() {
  const r = await call('eval', { expression: 'JSON.stringify({href: location.href, ready: document.readyState, title: document.title})' }, 15000)
  const raw = typeof r?.result === 'string' ? r.result : (r?.result?.value ?? JSON.stringify(r?.result ?? null))
  try { return JSON.parse(raw) } catch { return { raw } }
}

log(`=== probe ${LABEL} @ ${new Date().toISOString()} (port ${PORT}) ===`)
log('--- 0. baseline: nav /fast')
log(JSON.stringify(await call('nav', { url: `${BASE}/fast` })))
await sleep(1000)
log('--- 1. ground truth: ' + JSON.stringify(await truth()))

log('--- 2. nav /slow?ms=3000（响应体拖 3 秒）')
const slow = await call('nav', { url: `${BASE}/slow?ms=3000` })
log(JSON.stringify(slow))
log(`    回执: waitedMs=${slow?.result?.waitedMs} loadPending=${slow?.result?.loadPending} elapsed=${slow?.elapsedMs}ms`)

log('--- 3. 立刻读 ground truth（不信任回执）')
log(JSON.stringify(await truth()))
log('--- 4. 4 秒后再读')
await sleep(4000)
log(JSON.stringify(await truth()))

log('--- 5. tabs.open /slow?ms=3000')
const opened = await call('tabs.open', { url: `${BASE}/slow?ms=3000` })
log(JSON.stringify(opened))
await sleep(4000)
log('--- 6. tabs.list（确认那个标签真的在那儿）')
const list = await call('tabs.list')
log(JSON.stringify(list).slice(0, 600))
const id = opened?.result?.tabId
if (Number.isFinite(Number(id))) { log('--- 7. 关掉它'); log(JSON.stringify(await call('tabs.close', { tabId: Number(id) }))) }
log(`=== end ${LABEL} ===`)

fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
console.log(`wrote ${OUT}`)
