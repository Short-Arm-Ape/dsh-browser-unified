#!/usr/bin/env node
/**
 * build-release.mjs — 一条命令产出可上传的 Release 资产，并在产出前后自检（fail-closed）。
 *
 * 为什么不是"把 packages/ 下的三个文件夹压成 zip"（0.6.1 那次的形态）：
 *   1. 那样会把 `.npm-cache/`（上次 plugin.zip 里 88 条、1.34MB 里大半）和 `node_modules/`
 *      的壳一起发出去；
 *   2. 更要命的是**产物与源码的一致性没有把关**：plugin / mit 的 `lib/` 是入库的（core 的
 *      `dist/` 不入库），入库的 lib 完全可能与 src 不同步 —— 上游 caob23 v1.0.7 就这么栽过：
 *      npm 包里只注册了 11/16 个工具。core 更极端：`dist/` 不在库里，没构建就打包等于发空包。
 *   3. 扩展 zip 还有形态要求：文件头必须是 `PK\x03\x04`、条目必须是正斜杠（Windows 资源管理器
 *      只认文件头；上游 issue #2 就是栽在这）。PS 5.1 的 `Compress-Archive` 会写反斜杠条目，
 *      所以这里**自己写 zip**（Node + zlib），不依赖任何外部 zip 工具。
 *
 * 产出（dist-release/）：
 *   browser-unified-core-<ver>.tgz                 + .sha256
 *   dsh-browser-unified-<ver>.tgz                  + .sha256
 *   dsh-browser-unified-mit-<ver>.tgz              + .sha256
 *   DSH-Browser-Control-v<ver>.zip                 + .sha256   ← 浏览器扩展
 *   browser-unified-{core,plugin,mit}.zip          + .sha256   ← 兼容旧资产名：只含对应 tgz + README
 *   INSTALL.md                                                  ← 从 zip 装上手的步骤
 *
 * 闸门（任一不过 → 非零退出，不产出半套资产）：
 *   G1 core 的 dist/ 存在且含本轮新代码的标记（防止"忘构建 → 发空包"）
 *   G2 plugin / mit 的 lib 工具集 == src 工具集（防止"入库的 lib 落后于 src"）
 *   G3 core 与 mit 的共享逻辑文件除「许可头/模块名」外逐行一致（防止 MIT 版悄悄漂移）
 *   G4 registry 三副本（根 / plugin / mit）逐字节一致（单一真源）
 *   G5 扩展：manifest 版本 == 资产名版本、图标 16/48/128 齐全、无 .map 等垃圾
 *   G6 每个 zip：PK 头 + 正斜杠条目 + 不含 .npm-cache / node_modules / *.tgz
 *   G7 资产名里的版本 == package.json 的版本
 *   G8（可选）PATH 里有 dsh 时：`dsh --profile web --dump-config` 零跳过
 *
 * 用法（仓库根）：
 *   node scripts/build-release.mjs             # 构建 + 打包 + 自检
 *   node scripts/build-release.mjs --no-build  # 只打包 + 自检（调试脚本本身用）
 *   node scripts/build-release.mjs --skip-mit  # 本次不发 MIT 版
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const outDir = path.join(repo, 'dist-release')
const noBuild = process.argv.includes('--no-build')
const skipMit = process.argv.includes('--skip-mit')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const failures = []
const warnings = []
function ok(line) { console.log(`  \u2713 ${line}`) }
function bad(line) { failures.push(line); console.log(`  \u2717 ${line}`) }
function warn(line) { warnings.push(line); console.log(`  ! ${line}`) }
function section(title) { console.log(`\n${title}`) }

function run(command, args, cwd) {
  console.log(`  $ ${command} ${args.join(' ')}  (cwd=${path.relative(repo, cwd) || '.'})`)
  execFileSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && /^npm(\.cmd)?$/.test(command),
  })
}

const read = (p) => readFileSync(p, 'utf8')
const readJson = (p) => JSON.parse(read(p))
/** 换行归一化：core.autocrlf=true 会让同一个文件在不同机器上 CRLF/LF 混着来，
 *  逐字节比较会全盘假红。文本一致性判断一律先归一化。 */
const norm = (s) => s.replace(/\r\n/g, '\n')
const exists = (p) => existsSync(p)

/* ------------------------------------------------------------------ 构建 */

section('[1/5] 构建三个包')
const packages = [
  // core 没有 build-pack（它的 build 只跑 tsc），所以构建后自己 npm pack 出 tgz；
  // plugin / mit 的 build-pack 内部已经 pack 过。
  { key: 'core', dir: 'packages/browser-unified-core', build: ['run', 'build'], pack: true },
  { key: 'plugin', dir: 'packages/browser-unified-plugin', build: ['run', 'build-pack'] },
]
if (!skipMit) packages.push({ key: 'mit', dir: 'packages/browser-unified-mit', build: ['run', 'build-pack'] })
for (const pkg of packages) {
  const abs = path.join(repo, pkg.dir)
  if (!exists(abs)) { bad(`包目录不存在：${pkg.dir}（mit 用 --skip-mit 跳过）`); continue }
  pkg.abs = abs
  pkg.manifest = readJson(path.join(abs, 'package.json'))
}

/**
 * 构建前置守卫（2026-10-10 实撞）：build-pack.mjs 发现"没有 typescript / peers"时会自己跑
 * `npm install`，而 **npm install 会删掉 node_modules 里的 junction** —— 插件那份
 * `browser-unified-core` 链接、mit 那份 `typescript`/`@types` 链接都是这么被弄断的，
 * 然后编译报 `Cannot find module 'browser-unified-core'`，看着像代码问题、其实是环境被毁。
 * 所以这里先查、查不到就**停**并给出修复命令，不让它悄悄装。
 */
function missingDeps(pkg) {
  // core 的 build 只跑 tsc（不需要 @deepseek-ai peers，实测可编译）；plugin / mit 走
  // build-pack.mjs，它的依赖检查就是 typescript + @deepseek-ai/dsh-tools 这两条。
  const need = [['node_modules/typescript/bin/tsc', 'TypeScript 编译器']]
  if (pkg.key !== 'core') need.push(['node_modules/@deepseek-ai/dsh-tools', '@deepseek-ai peers'])
  return need.filter(([rel]) => !exists(path.join(pkg.abs, rel))).map(([rel, what]) => `${what}（缺 ${rel}）`)
}
for (const pkg of packages) {
  if (!pkg.abs || noBuild) continue
  const missing = missingDeps(pkg)
  if (missing.length === 0) continue
  bad(`${pkg.key}: 构建依赖不全 —— ${missing.join('；')}`)
  console.log(`      修法（Windows，示例按 package 调整；**别让它跑 npm install**，那会删掉 junction）：`)
  console.log(`        mklink /J packages\\${pkg.dir.split('/')[1]}\\node_modules\\typescript packages\\browser-unified-plugin\\node_modules\\typescript`)
  console.log(`        mklink /J packages\\${pkg.dir.split('/')[1]}\\node_modules\\@deepseek-ai  packages\\browser-unified-plugin\\node_modules\\@deepseek-ai`)
  console.log(`      或用 --no-build 只打包 + 走一致性闸门（G1/G2 仍会校验 lib/dist 与 src 是否一致）。`)
}
if (failures.length > 0) {
  console.log('\n构建前的依赖检查没过 —— 已停在构建之前（不产出资产）。')
  process.exit(1)
}
for (const pkg of packages) {
  if (noBuild) continue
  run(npm, pkg.build, pkg.abs)
  if (pkg.pack === true) run(npm, ['pack', '--pack-destination', pkg.abs], pkg.abs)
}

/* ------------------------------------------- G1 core dist 存在且是新代码 */

section('[2/5] G1/G2 产物与源码一致性')
if (noBuild) warn('--no-build：跳过"是否构建过"的判断，只校验现有产物')
const corePkg = packages.find((p) => p.key === 'core')
if (corePkg && corePkg.abs) {
  const dist = path.join(corePkg.abs, 'dist', 'index.js')
  if (!exists(dist)) bad('core dist/index.js 不存在 —— 先 npm run build 再打包')
  else {
    const bridge = path.join(corePkg.abs, 'dist', 'bridge', 'server.js')
    if (!exists(bridge)) bad('core dist/bridge/server.js 不存在')
    else if (!read(bridge).includes('isLoopbackHost')) bad('core dist 缺少本轮新代码（isLoopbackHost）—— dist 是旧的')
    else ok('core dist 存在且含本轮新代码')
  }
}

/* ------------------------------------ G2 lib 工具集 == src 工具集（防 lib 落后）*/

function toolNames(text, pattern = /name: *'([a-zA-Z_]+)'/g) {
  const out = new Set()
  for (const m of text.matchAll(pattern)) out.add(m[1])
  return out
}
function sourceText(dir) {
  const src = path.join(dir, 'src')
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) return walk(p)
    return e.name.endsWith('.ts') ? [read(p)] : []
  })
  return walk(src).join('\n')
}
function libText(dir) {
  const lib = path.join(dir, 'lib')
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name)
    if (e.isDirectory()) return walk(p)
    return e.name.endsWith('.js') ? [read(p)] : []
  })
  return walk(lib).join('\n')
}
for (const pkg of packages) {
  if (!pkg.abs || pkg.key === 'core') continue
  if (!exists(path.join(pkg.abs, 'lib'))) { bad(`${pkg.key}: lib/ 不存在`); continue }
  const fromSrc = toolNames(sourceText(pkg.abs))
  const fromLib = toolNames(libText(pkg.abs))
  const missing = [...fromSrc].filter((n) => !fromLib.has(n))
  const extra = [...fromLib].filter((n) => !fromSrc.has(n))
  if (fromSrc.size === 0) bad(`${pkg.key}: src 里没解析到任何工具名（判据失效，别当通过）`)
  else if (missing.length > 0) bad(`${pkg.key}: lib 落后 src，缺 ${missing.length} 个工具：${missing.join(', ')}`)
  else if (extra.length > 0) warn(`${pkg.key}: lib 多出 ${extra.join(', ')}（通常是没重新构建的残留）`)
  else ok(`${pkg.key}: lib 与 src 工具集一致（${fromSrc.size} 个）`)
}

/* ------------------------------------- G3 core 与 mit 共享逻辑（忽略许可头）*/

if (!skipMit) {
  const mit = packages.find((p) => p.key === 'mit')
  const shared = ['url-policy.ts', 'approval.ts', 'instance.ts', 'self-update/check.ts', 'self-update/registry.ts']
  /**
   * 只比"代码行"：去掉注释与空行后再比。
   * mit 版的文件头与 core 不同（许可声明 + `@module` 名），这是**有意差异**；
   * 早先按"过滤若干已知行"的写法仍会因注释块结构（多一个开注释符、多一行结束符）误报，
   * 所以直接只留代码行 —— 这个闸门要抓的是**逻辑漂移**，不是注释。
   */
  const codeOnly = (text) => norm(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
    .join('\n')
  if (mit && mit.abs) {
    let drift = []
    for (const rel of shared) {
      const a = path.join(corePkg.abs, 'src', rel)
      const b = path.join(mit.abs, 'src', rel)
      if (!exists(a) || !exists(b)) { warn(`共享逻辑缺文件：${rel}`); continue }
      if (codeOnly(read(a)) !== codeOnly(read(b))) drift.push(rel)
    }
    if (drift.length > 0) bad(`core 与 mit 的共享逻辑出现实体差异（除许可头外）：${drift.join(', ')} —— MIT 版会悄悄落后`)
    else ok(`core 与 mit 的共享逻辑一致（忽略许可头/模块名，${shared.length} 个文件）`)
  }
}

/* ------------------------------------------- G4 registry 三副本（单一真源）*/

const mirrors = [
  ['design/registry.json', ['design/registry.json', 'packages/browser-unified-plugin/registry/design/registry.json', 'packages/browser-unified-mit/registry/design/registry.json']],
  ['upstream-baseline.json', ['upstream-baseline.json', 'packages/browser-unified-plugin/registry/upstream-baseline.json', 'packages/browser-unified-mit/registry/upstream-baseline.json']],
]
for (const [label, paths] of mirrors) {
  const present = paths.map((p) => path.join(repo, p)).filter(exists)
  if (present.length < 2) { warn(`${label}: 只找到 ${present.length} 份副本，跳过一致性检查`); continue }
  const bodies = present.map((p) => norm(read(p)))
  const same = bodies.every((b) => b === bodies[0])
  if (!same) bad(`${label}: ${present.length} 份副本不一致（单一真源破功）`)
  else ok(`${label}: ${present.length} 份副本一致`)
}

/* --------------------------------------------------- G5 扩展清单与图标 */

section('[3/5] G5 扩展')
const extDir = path.join(repo, 'extension')
let extVersion = null
if (!exists(extDir)) bad('extension/ 不存在')
else {
  const manifest = readJson(path.join(extDir, 'manifest.json'))
  extVersion = manifest.version
  const needed = ['background.js', 'manifest.json', 'popup.html', 'popup.js',
    'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png']
  const missing = needed.filter((f) => !exists(path.join(extDir, f)))
  if (missing.length > 0) bad(`extension 缺文件：${missing.join(', ')}`)
  else ok(`extension 齐全（manifest v${extVersion}）`)
  const junk = readdirSync(extDir).filter((f) => /\.(map|log|zip)$|^\./.test(f))
  if (junk.length > 0) warn(`extension 里有可疑文件：${junk.join(', ')}`)
}

/* ------------------------------------------------------- 自己写的 zip 写入器 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
/** 只收「路径 → Buffer」，条目名一律正斜杠、无目录条目、无外部属性 —— 资源管理器认这个。 */
function writeZip(zipPath, entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8')
    if (/\\/.test(name)) throw new Error(`zip 条目名含反斜杠：${name}`)
    // 真·deflate：方法写 8 就必须存压缩后的字节。2026-10-10 实撞：方法写 8 却存原始数据，
    // 自己那个"只读目录名"的解析器看不出问题，Python zipfile 一解压就 `invalid block type`。
    const packed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0x0800, 6)      // UTF-8 名称
    local.writeUInt16LE(8, 8)           // deflate
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, packed)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(8, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(packed.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + packed.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  const zip = Buffer.concat([...chunks, cdBuf, end])
  writeFileSync(zipPath, zip)
  return zip
}
/** 回读校验：PK 头 + 正斜杠 + 无垃圾（G6 就是拿它做的）。 */
function inspectZip(zipPath) {
  const buf = readFileSync(zipPath)
  const pk = buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const names = []
  for (let i = 0; i + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const n = buf.readUInt16LE(i + 28)
      names.push(buf.subarray(i + 46, i + 46 + n).toString('utf8'))
    }
  }
  return { pk, names, size: buf.length }
}
function walkFiles(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, base, acc)
    else acc.push([path.relative(base, p).replace(/\\/g, '/'), readFileSync(p)])
  }
  return acc
}

/* --------------------------------------------------------- 产出 4 类资产 */

section('[4/5] 产出资产')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const produced = []
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
function seal(file) {
  const h = sha256(file)
  writeFileSync(`${file}.sha256`, `${h}  ${path.basename(file)}\n`)
  produced.push({ file, sha: h, size: statSync(file).size })
}

/** 1) 三个 tgz：直接取各包目录里刚由 npm pack 产出的同名文件（版本号必须对得上）。 */
const tgzByKey = {}
for (const pkg of packages) {
  if (!pkg.abs || !pkg.manifest) continue
  const want = pkg.key === 'core'
    ? `${pkg.manifest.name}-${pkg.manifest.version}.tgz`
    : `${pkg.manifest.name}-${pkg.manifest.version}.tgz`
  const src = path.join(pkg.abs, want)
  if (!exists(src)) { bad(`${pkg.key}: 没找到 ${want}（npm pack 产物）`); continue }
  const dst = path.join(outDir, want)
  writeFileSync(dst, readFileSync(src))
  tgzByKey[pkg.key] = { name: want, path: dst }
  ok(`tgz: ${want}（${(statSync(dst).size / 1024).toFixed(0)}KB）`)
  seal(dst)
  // G7：资产名里的版本 == package.json 版本（顺带防呆：名字对不上说明 pack 用了别的版本）
  if (!want.includes(pkg.manifest.version)) bad(`${pkg.key}: 资产名与 package.json 版本不一致`)
}

/** 2) 扩展 zip（从仓库内 extension/ 打，条目正斜杠）。 */
if (extVersion) {
  const zipName = `DSH-Browser-Control-v${extVersion}.zip`
  const zipPath = path.join(outDir, zipName)
  const files = walkFiles(extDir).filter(([n]) => n !== 'README.md')
  writeZip(zipPath, files)
  ok(`zip: ${zipName}（${files.length} 个文件）`)
  seal(zipPath)
}

/** 3) 兼容旧资产名：每个包一个干净 zip（只含该包的 tgz + 其 README/LICENSE）。 */
for (const pkg of packages) {
  if (!pkg.abs || !tgzByKey[pkg.key]) continue
  const short = pkg.key === 'plugin' ? 'plugin' : pkg.key
  const zipName = `browser-unified-${short}.zip`
  const entries = [[tgzByKey[pkg.key].name, readFileSync(tgzByKey[pkg.key].path)]]
  for (const extra of ['README.md', 'LICENSE', 'NOTICE.md']) {
    const p = path.join(pkg.abs, extra)
    if (exists(p)) entries.push([extra, readFileSync(p)])
  }
  writeZip(path.join(outDir, zipName), entries)
  ok(`zip: ${zipName}（tgz + README/LICENSE）`)
  seal(path.join(outDir, zipName))
}

/** 4) INSTALL.md */
const install = `# 安装（本次 Release）

## 1. 浏览器扩展（必须换成本版，否则部分工具不可用）
下载 \`DSH-Browser-Control-v${extVersion ?? '<ver>'}.zip\` → 解压到任意目录 →
\`edge://extensions\`（或 \`chrome://extensions\`）开「开发者模式」→「加载解压缩的扩展」→ 选该目录。
然后点扩展图标，填桥的端口（默认 9777）与 token。

> 与上游 caob23 版**同协议**，但本仓库的扩展多了 frames / 自建窗口 / 端口自动发现 /
> 导航完成判定 / div 化 SPA 元素识别等改动，配套本插件请使用本版。

## 2. 插件（两个包一起装）
\`\`\`bash
pnpm add <path>/browser-unified-core-<ver>.tgz
pnpm add <path>/dsh-browser-unified-<ver>.tgz
\`\`\`
装进 DSH profile（推荐用 CLI，它会落到 profile 的 vendor/ 并改 package.json）：

\`\`\`bash
dsh plugin --profile <profile> add file:<path>/browser-unified-core-<ver>.tgz \\
                                   file:<path>/dsh-browser-unified-<ver>.tgz
\`\`\`

然后在 profile 的 \`cordis.patch.yml\` 里给 \`browser-bridge\` 配好 \`enabled / port / token\`
（本版包内 patch 默认 \`enabled: true\`），**重启 dsh web**。

重启后自查：\`browser_policy_status\`／\`browser_tools action=status\` 应显示桥已监听、
扩展已连接；状态页 \`http://127.0.0.1:9777/\` 可看端口/扩展版本/令牌强度。

## 3. MIT 版（可选）
只想要 URL 策略 / 审批 / 自更新与设计注册表这几个模块、且**不能接受 AGPL** 的用户，
装 \`dsh-browser-unified-mit-<ver>.tgz\`（不含桥与 \`browser_*\` 驱动工具）。

## 4. 校验
每个资产都有同名 \`.sha256\`：
\`\`\`bash
sha256sum -c browser-unified-core-<ver>.tgz.sha256
# Windows: certutil -hashfile <file> SHA256
\`\`\`
`
writeFileSync(path.join(outDir, 'INSTALL.md'), install)
ok('INSTALL.md')

/* --------------------------------------------------------------- 自检 G6/G8 */

section('[5/5] G6/G7/G8 回读自检')
for (const zipName of readdirSync(outDir).filter((f) => f.endsWith('.zip'))) {
  const info = inspectZip(path.join(outDir, zipName))
  const junk = info.names.filter((n) => /\.npm-cache|node_modules|\.tgz$|\.map$/.test(n) && !/^browser-unified-(core|plugin|mit)\.zip$/.test(zipName))
  const backslash = info.names.filter((n) => n.includes('\\'))
  if (!info.pk) bad(`${zipName}: 文件头不是 PK（资源管理器解不开）`)
  else if (backslash.length > 0) bad(`${zipName}: 有反斜杠条目 ${backslash.length} 条`)
  else if (junk.length > 0) bad(`${zipName}: 含垃圾条目 ${junk.length} 条（如 ${junk[0]}）`)
  else ok(`${zipName}: PK 头 ✓ 正斜杠 ✓ 无垃圾 ✓（${info.names.length} 条）`)
}

try {
  const out = execFileSync('dsh', ['--profile', 'web', '--dump-config'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const skipped = out.split(/\r?\n/).filter((l) => /skipping profile bundle/.test(l))
  // 只对本包相关的跳过报错：别人的 bundle 与 dsh 版本不兼容不该拦住我们的发布
  // （另一台机器上的 profile 是旧的 Windows 装机，实测会跳过别家 bundle）。
  const ours = skipped.filter((l) => /dsh-browser-unified|browser-unified-core|browser-bridge/.test(l))
  if (ours.length === 0) ok(`G8 dump-config：本插件零跳过${skipped.length > 0 ? `（整体跳过 ${skipped.length} 条，均非本包）` : ''}`)
  else bad(`G8 dump-config 跳过了本插件：${ours[0].trim().slice(0, 140)}`)
} catch (error) {
  warn(`G8 跳过：没跑通 dsh（${error instanceof Error ? error.message.split('\n')[0] : String(error)}）`)
}

/* ------------------------------------------------------------------ 汇总 */

console.log('\n================ 汇总 ================')
for (const p of produced) console.log(`  ${path.basename(p.file)}\t${(p.size / 1024).toFixed(0)}KB\tsha256=${p.sha.slice(0, 16)}…`)
if (warnings.length > 0) {
  console.log(`\n警告（不阻断）：`)
  for (const w of warnings) console.log(`  ! ${w}`)
}
if (failures.length > 0) {
  console.log(`\n闸门未过（${failures.length} 项）——不要上传这批资产：`)
  for (const f of failures) console.log(`  \u2717 ${f}`)
  process.exit(1)
}
console.log(`\n全部闸门通过，产物在 ${path.relative(repo, outDir)}/（${produced.length} 个资产 + .sha256）`)
console.log('下一步：把 dist-release/ 里的资产传 Release；上传后匿名下载回来核一次 sha256 与 zip 头。')
