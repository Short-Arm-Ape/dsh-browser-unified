#!/usr/bin/env node
/**
 * rig/rig.mjs — 真浏览器测试台的**唯一入口**（Windows / Linux 同一份）。
 *
 * 之前的三层脚本（mk-ext.sh + deploy.sh + probe.sh + teardown.sh + 两个 .ps1）把
 * WSL 换边前的绝对路径写死在各处（`/home/wsluser/projects/...`、`%TEMP%\__pr-d-rig`），
 * 换到 Windows 之后整个台子跑不起来。这里把路径全部改成「本文件所在目录 + 工作目录」推导，
 * 平台差异只剩两件真的事：**怎么找浏览器** 和 **怎么杀自己的进程树**。
 *
 * 用法：
 *   node rig/rig.mjs build   [--from asis|pristine|fixed] [--src <扩展目录>] [--tag <t>] [--ver <v>]
 *   node rig/rig.mjs up      [--tag <t>] [--port 9781] [--windowed] [--reuse] [--timeout 40]
 *   node rig/rig.mjs status  [--port 9781]
 *   node rig/rig.mjs down
 *   node rig/rig.mjs smoke   [--port 9781]
 *   node rig/rig.mjs matrix  [label]
 *   node rig/rig.mjs probe   [label]
 *
 * 约定：
 *   - 所有产物落在工作目录（默认 `<tmp>/dsh-rig`，可用 RIG_WORK 覆盖），不污染源码树；
 *   - 只杀命令行里带**本工作目录**的浏览器进程，绝不碰你日常用的 Edge/Chrome；
 *   - rig 扩展把端口钉在 stub 上（默认 9781），桥在 9777 也不会被连上；
 *   - hello 帧里注入 `rigTag`，`up` 只在 hello 报出这个 tag 后才返回 —— 旧 profile/旧脚本
 *     静默顶替时，证据会指向一个不在盘上的构建，这个 tag 就是防它的。
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RIG_DIR = path.dirname(fileURLToPath(import.meta.url))
const IS_WIN = process.platform === 'win32'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'help'
const opt = parseOptions(argv.slice(1))

function parseOptions(list) {
  const out = {}
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = list[i + 1]
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++ } else out[key] = true
    } else if (!out._) out._ = a
  }
  return out
}

const PORT = Number(opt.port || process.env.RIG_PORT || 9781)
/** os.tmpdir() 在 Windows 上给的是 8.3 短路径（LOCALU~1），realpath 也解不开 ——
 *  直接用户目录推长路径，日志和 `--user-data-dir` 都能一眼对得上。 */
const TMP = (() => {
  if (!IS_WIN) return os.tmpdir()
  const long = path.join(os.homedir(), 'AppData', 'Local', 'Temp')
  return fs.existsSync(long) ? long : os.tmpdir()
})()
const WORK = path.resolve(opt.work || process.env.RIG_WORK || path.join(TMP, 'dsh-rig'))
const TAG = String(opt.tag || process.env.RIG_TAG || 'asis')
const EXT_DIR = path.join(WORK, `ext-${TAG}`)
const PROFILE = path.join(WORK, `profile-${TAG}`)
const STUB_LOG = path.join(WORK, 'stub.log')
const STUB_PID = path.join(WORK, 'stub.pid')
const BR_PID = path.join(WORK, 'browser.pid')

const say = (...a) => console.log(...a)
const die = (msg) => { console.error('ERROR: ' + msg); process.exit(1) }

/* ------------------------------------------------------------------ 小工具 */

function browserCandidates() {
  if (IS_WIN) {
    return [
      process.env.RIG_BROWSER,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean)
  }
  return [process.env.RIG_BROWSER, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'].filter(Boolean)
}

function findBrowser() {
  for (const c of browserCandidates()) {
    try {
      if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue }
      const whichCmd = IS_WIN ? 'where' : 'which'
      const out = execFileSync(whichCmd, [c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim()
      if (out) return out
    } catch { /* 试下一个 */ }
  }
  return null
}

function readPid(file) {
  try { return Number(fs.readFileSync(file, 'utf8').trim()) || null } catch { return null }
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 杀掉一个进程树。Windows 用 taskkill /T；POSIX 用进程组（spawn 时 detached）。 */
function killTree(pid, signal = 'SIGKILL') {
  if (!pid) return
  try {
    if (IS_WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}

/** 兜底清扫：只杀命令行里带**本工作目录 profile** 的浏览器（可能被浏览器自己 reparent 的渲染进程）。
 *  匹配必须带 `--user-data-dir=`：只按工作目录字符串匹配会把调用方的 shell（它的命令行里
 *  也有这个路径）当成残留杀掉。 */
function sweepStrays() {
  const anchor = `--user-data-dir=${WORK}`
  if (IS_WIN) {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | ` +
      `Where-Object { $_.CommandLine -like '*${anchor.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`
    try {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const pids = out.split(/\r?\n/).map((s) => Number(s.trim())).filter(Boolean)
      for (const p of pids) { try { execFileSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
      return pids.length
    } catch { return 0 }
  }
  try {
    // 通过环境变量把锚点传给 pgrep：写成命令行参数的话，pgrep 的**父 bash** 命令行里也会有这个
    // 字符串，于是它把自己人当残留扫出来（第一次实现就这样误杀过调用方的 shell）。
    const out = execFileSync('bash', ['-lc', 'pgrep -f -- "$RIG_ANCHOR" || true'], {
      encoding: 'utf8',
      env: { ...process.env, RIG_ANCHOR: anchor },
    })
    const pids = out.split(/\s+/).map((s) => Number(s)).filter((p) => p && p !== process.pid && p !== process.ppid)
    for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
    return pids.length
  } catch { return 0 }
}

async function httpJson(url, init) {
  const res = await fetch(url, init)
  return res.json()
}

async function ctlState() {
  try { return await httpJson(`http://127.0.0.1:${PORT}/ctl/state`) } catch { return null }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------- build */

async function build() {
  const mode = String(opt.from || 'asis')
  const ver = String(opt.ver || '1.0.99')
  await fsp.mkdir(WORK, { recursive: true })
  await fsp.rm(EXT_DIR, { recursive: true, force: true })
  await fsp.mkdir(EXT_DIR, { recursive: true })

  if (mode === 'asis') {
    const src = path.resolve(String(opt.src || path.join(RIG_DIR, '..', 'src', 'extension')))
    if (!fs.existsSync(path.join(src, 'manifest.json'))) die(`asis：源扩展目录里没有 manifest.json：${src}`)
    await fsp.cp(src, EXT_DIR, { recursive: true })
    say(`build: asis ← ${src}`)
  } else {
    const up = path.join(RIG_DIR, 'upstream-head')
    for (const [from, to] of [
      ['extension__background.js', 'background.js'],
      ['extension__manifest.json', 'manifest.json'],
      ['extension__popup.js', 'popup.js'],
      ['extension__popup.html', 'popup.html'],
    ]) {
      const s = path.join(up, from)
      if (!fs.existsSync(s)) die(`缺少上游快照 ${s}`)
      await fsp.copyFile(s, path.join(EXT_DIR, to))
    }
    say(`build: ${mode} ← rig/upstream-head`)
    if (mode === 'fixed') {
      execFileSync(process.execPath, [path.join(RIG_DIR, 'apply-fix-D.mjs'), path.join(EXT_DIR, 'background.js')], { stdio: 'inherit' })
    }
  }

  const icons = path.join(EXT_DIR, 'icons')
  if (!fs.existsSync(icons)) {
    await fsp.mkdir(icons, { recursive: true })
    for (const f of await fsp.readdir(path.join(RIG_DIR, 'icons'))) {
      await fsp.copyFile(path.join(RIG_DIR, 'icons', f), path.join(icons, f))
    }
  }

  // manifest：版本改成 caller 给的、名字打上 tag（浏览器 about:extensions 里一眼看出是哪次运行）
  const mPath = path.join(EXT_DIR, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8').replace(/^\uFEFF/, ''))
  manifest.version = ver
  manifest.name = `${manifest.name} [RIG ${TAG}]`
  await fsp.writeFile(mPath, JSON.stringify(manifest, null, '\t'), 'utf8')

  // background.js：端口钉到 stub + hello 帧注入 rigTag。锚点缺失就中止——静默产出的
  // 「证据」会指向一个不在盘上的构建。
  const bPath = path.join(EXT_DIR, 'background.js')
  const src = fs.readFileSync(bPath, 'utf8')
  const portAnchor = 'const DEFAULT_PORT = 9777;'
  if (!src.includes(portAnchor)) die(`端口锚点缺失（${portAnchor}）：这份 background.js 认不出端口常量`)
  let out = src.replace(portAnchor, `const DEFAULT_PORT = ${PORT}; // RIG-ONLY（真桥是 9777）`)
  const helloAnchor = "client: 'dsh-browser-extension',"
  if (!out.includes(helloAnchor)) die(`hello 锚点缺失（${helloAnchor}）`)
  out = out.replace(helloAnchor, `${helloAnchor} rigTag: '${TAG}',`)
  await fsp.writeFile(bPath, out, 'utf8')

  execFileSync(process.execPath, ['--check', bPath], { stdio: 'inherit' })
  say(`build: ${EXT_DIR}  port=${PORT}  version=${ver}  rigTag=${TAG}`)
  return EXT_DIR
}

/* --------------------------------------------------------------------- stub */

async function stubStart() {
  await fsp.mkdir(WORK, { recursive: true })
  const old = readPid(STUB_PID)
  if (old && pidAlive(old)) { killTree(old); await sleep(300) }
  const logFd = fs.openSync(STUB_LOG, 'a')
  const child = spawn(process.execPath, [path.join(RIG_DIR, 'stub.mjs')], {
    env: { ...process.env, RIG_PORT: String(PORT), RIG_LOG: STUB_LOG },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  })
  child.unref()
  fs.writeFileSync(STUB_PID, String(child.pid))
  for (let i = 0; i < 50; i++) {
    if (await ctlState()) { say(`stub: listening on ${PORT} (pid ${child.pid})`); return child.pid }
    await sleep(100)
  }
  die(`stub 没起来；看 ${STUB_LOG}`)
}

/* ------------------------------------------------------------------- 浏览器 */

async function launchBrowser(ext) {
  const exe = findBrowser()
  if (!exe) throw new Error('没找到浏览器：用 RIG_BROWSER 指定可执行文件（Edge/Chrome/Chromium 任一）')
  await fsp.rm(PROFILE, { recursive: true, force: true })
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${ext}`,
    `--disable-extensions-except=${ext}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-networking', '--disable-features=Translate,MediaRouter',
    '--window-size=900,650',
    `http://127.0.0.1:${PORT}/fast`,
  ]
  if (!opt.windowed) args.unshift('--headless=new')
  // 平台私有开关（容器/CI 里常要 --no-sandbox；`--disable-dev-shm-usage` 同理）：空格分隔。
  const extra = String(process.env.RIG_EXTRA_ARGS || '').trim()
  if (extra) args.push(...extra.split(/\s+/))
  const logFd = fs.openSync(path.join(WORK, 'browser.log'), 'a')
  const child = spawn(exe, args, { stdio: ['ignore', logFd, logFd], detached: true })
  child.unref()
  fs.writeFileSync(BR_PID, String(child.pid))
  say(`browser: ${exe} pid=${child.pid} profile=${PROFILE}${opt.windowed ? '' : '（headless）'}`)
  return child.pid
}

async function waitForTag(tag, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000
  let last = null
  while (Date.now() < deadline) {
    last = await ctlState()
    if (last?.hello?.rigTag === tag) return last
    await sleep(500)
  }
  const seen = last?.hello ? JSON.stringify(last.hello).slice(0, 300) : '(从没连上)'
  throw new Error(`浏览器没在 ${timeoutSec}s 内报出 rigTag=${tag}；最后状态：${seen}\n  排查：${path.join(WORK, 'browser.log')} 与 ${STUB_LOG}`)
}

/** 启动失败时把自己刚起的 stub 收掉（否则端口被占着，下次 `up` 会以为有人伺候）。 */
async function cleanupStartedStub() {
  const st = readPid(STUB_PID)
  if (st) { killTree(st); try { fs.unlinkSync(STUB_PID) } catch { /* gone */ } }
}

/* --------------------------------------------------------------------- 命令 */

async function cmdUp() {
  const ext = opt.reuse ? EXT_DIR : await build()
  if (opt.reuse && !fs.existsSync(path.join(ext, 'manifest.json'))) die(`--reuse：${ext} 不存在，先跑 build`)
  const startedStub = !(await ctlState())
  if (startedStub) await stubStart()
  else say(`stub: 已在 ${PORT} 上跑着，复用`)
  try {
    await launchBrowser(ext)
    const state = await waitForTag(TAG, Number(opt.timeout || 60))
    say(`up: ready — rigTag=${state.hello.rigTag} version=${state.hello.version ?? '?'} ext=${state.hello.extensionId ?? '?'}`)
  } catch (err) {
    if (startedStub) await cleanupStartedStub()
    throw err
  }
}

async function cmdDown() {
  const br = readPid(BR_PID)
  const st = readPid(STUB_PID)
  if (br) { killTree(br); say(`down: 浏览器 pid ${br} 已杀`) }
  const strays = sweepStrays()
  if (strays) say(`down: 兜底清扫 ${strays} 个残留浏览器进程`)
  if (st) { killTree(st); say(`down: stub pid ${st} 已杀`) }
  await sleep(500)
  for (const f of [BR_PID, STUB_PID]) { try { fs.unlinkSync(f) } catch { /* already gone */ } }
  const left = await ctlState()
  say(left ? `down: 端口 ${PORT} 还有服务在应答（不是我们起的？）` : `down: 端口 ${PORT} 已释放`)
  if (readPid(BR_PID) || readPid(STUB_PID)) process.exitCode = 1
}

async function cmdStatus() {
  const s = await ctlState()
  say(s ? `stub: connected=${s.connected} hello=${JSON.stringify(s.hello).slice(0, 200)}` : `stub: 端口 ${PORT} 上没有服务`)
  say(`work=${WORK}`)
  say(`browser pid=${readPid(BR_PID) ?? '(none)'} alive=${pidAlive(readPid(BR_PID))}`)
  say(`stub    pid=${readPid(STUB_PID) ?? '(none)'} alive=${pidAlive(readPid(STUB_PID))}`)
  say(`browser=${findBrowser() ?? '(未找到)'}`)
}

async function extCmd(command, params = {}, timeoutMs = 40000) {
  const r = await httpJson(`http://127.0.0.1:${PORT}/ctl/cmd`, {
    method: 'POST', body: JSON.stringify({ command, params, timeoutMs }),
  })
  return r
}

async function cmdSmoke() {
  const base = `http://127.0.0.1:${PORT}`
  const results = []
  const check = (name, ok, detail) => { results.push({ name, ok }); say(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`) }

  let r = await extCmd('tabs.list', {}, 15000)
  check('tabs.list', r?.ok === true && Array.isArray(r?.result?.tabs), `tabs=${r?.result?.tabs?.length ?? '?'}`)

  r = await extCmd('nav', { url: `${base}/fast` }, 30000)
  check('nav /fast', r?.ok === true, `elapsed=${r?.elapsedMs}ms url=${r?.result?.url ?? ''}`)

  r = await extCmd('eval', { expression: 'JSON.stringify({href: location.href, ready: document.readyState})' }, 15000)
  let truth = null
  try { truth = JSON.parse(typeof r?.result === 'string' ? r.result : (r?.result?.value ?? 'null')) } catch { /* 下面判 */ }
  check('ground truth /fast', /\/fast$/.test(truth?.href ?? ''), JSON.stringify(truth))

  const t0 = Date.now()
  r = await extCmd('nav', { url: `${base}/slow?ms=1500` }, 30000)
  check('nav /slow?ms=1500', r?.ok === true, `elapsed=${r?.elapsedMs}ms waitedMs=${r?.result?.waitedMs} wall=${Date.now() - t0}ms`)

  r = await extCmd('tabs.open', { url: `${base}/fast` }, 30000)
  const opened = r?.result?.tabId
  check('tabs.open /fast', r?.ok === true && Number.isFinite(Number(opened)), `tabId=${opened}`)
  if (Number.isFinite(Number(opened))) {
    const c = await extCmd('tabs.close', { tabId: Number(opened) }, 15000)
    check('tabs.close', c?.ok === true, `ok=${c?.ok}`)
  }

  const failed = results.filter((x) => !x.ok)
  say(`\nsmoke: ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exitCode = 1
}

function runScenario(script, label) {
  const args = [path.join(RIG_DIR, script)]
  if (label) args.push(label)
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, RIG_PORT: String(PORT) } })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
}

/** 同上，但等它跑完（一条命令内跑完整套时用）。 */
function runScenarioAwait(script, label) {
  return new Promise((resolve) => {
    const args = [path.join(RIG_DIR, script)]
    if (label) args.push(label)
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, RIG_PORT: String(PORT) } })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/** 一条命令跑完整套：build → stub → 浏览器 → 场景 → 收尾（默认收尾，--keep 留着看）。 */
async function cmdRun() {
  const scenario = String(opt.scenario || 'smoke')
  const ext = opt.reuse ? EXT_DIR : await build()
  const startedStub = !(await ctlState())
  if (startedStub) await stubStart()
  else say(`stub: 已在 ${PORT} 上跑着，复用`)
  let code = 0
  try {
    await launchBrowser(ext)
    const state = await waitForTag(TAG, Number(opt.timeout || 60))
    say(`up: ready — rigTag=${state.hello.rigTag} version=${state.hello.version ?? '?'}`)
    if (scenario === 'smoke') { await cmdSmoke(); code = process.exitCode ? 1 : 0 }
    else if (scenario === 'probe') code = await runScenarioAwait('probe-scenario.mjs', TAG)
    else if (scenario === 'matrix') code = await runScenarioAwait('matrix.mjs', TAG)
    else throw new Error(`未知场景 ${scenario}（smoke | probe | matrix）`)
  } finally {
    if (!opt.keep) await cmdDown()
    else say('run: --keep，浏览器与 stub 留着（跑完手动 node rig/rig.mjs down）')
  }
  process.exitCode = code
}

/* --------------------------------------------------------------------- main */

try {
  switch (cmd) {
    case 'build': await build(); break
    case 'stub': await stubStart(); break
    case 'up': await cmdUp(); break
    case 'run': await cmdRun(); break
    case 'down': await cmdDown(); break
    case 'status': await cmdStatus(); break
    case 'smoke': await cmdSmoke(); break
    case 'matrix': runScenario('matrix.mjs', opt._ || 'run'); break
    case 'probe': runScenario('probe-scenario.mjs', opt._ || 'probe'); break
    case 'help': case '--help': case '-h':
      say(`用法: node rig/rig.mjs <build|up|status|down|smoke|matrix|probe> [--tag t] [--port 9781] [--windowed] [--reuse]\n  工作目录: ${WORK}\n  浏览器: ${findBrowser() ?? '(未找到，用 RIG_BROWSER 指定)'}`)
      break
    default: die(`未知命令 ${cmd}`)
  }
} catch (err) {
  const msg = err?.message ? String(err.message) : String(err)
  console.error('ERROR: ' + msg)
  if (process.env.RIG_DEBUG) console.error(err?.stack || '')
  process.exit(1)
}
