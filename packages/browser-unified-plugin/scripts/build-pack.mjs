#!/usr/bin/env node
/**
 * build-pack.mjs — local build + pack for one dsh-browser-unified* package.
 *
 * Steps:
 *   1. ensure devDependencies exist (installs from the configured registry
 *      when node_modules/typescript or the @deepseek-ai peers are missing);
 *   2. compile src -> lib with the local TypeScript (no global tsc needed);
 *   3. `npm pack` into the package root and print the artifact path.
 *
 * Requires a writable npm cache; falls back to a package-local `.npm-cache`
 * directory so the script works even when the default cache is unwritable
 * (e.g. sandboxed CI). Run from the package directory:
 *
 *   node scripts/build-pack.mjs          # or: npm run build-pack
 *
 * Flags: --no-pack to stop after typecheck+compile.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(here, '..')
const cacheDir = path.join(pkgDir, '.npm-cache')
const noPack = process.argv.includes('--no-pack')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const tsc = path.join(pkgDir, 'node_modules', 'typescript', 'bin', 'tsc')

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  // .cmd scripts cannot be spawned directly on Windows; run them through a shell.
  const shell = process.platform === 'win32' && /npm(\.cmd)?$/.test(command)
  return execFileSync(command, args, { cwd: pkgDir, stdio: 'inherit', shell, ...options })
}

mkdirSync(cacheDir, { recursive: true })

const hasTs = existsSync(tsc)
const hasPeers = existsSync(path.join(pkgDir, 'node_modules', '@deepseek-ai', 'dsh-tools'))
if (!hasTs || !hasPeers) {
  console.log('\n[deps] missing typescript or @deepseek-ai peers — running npm install …')
  run(npm, ['install', '--no-audit', '--no-fund', `--cache=${cacheDir}`])
}

run(process.execPath, [tsc, '-p', 'tsconfig.json']) // typecheck + compile to lib/

// The browser client half ships as a hand-assembled module-loader bundle
// (client/client.js -> lib/client.js). No bundler needed; the source is plain
// JS in the required loader format (see file header).
const clientSrc = path.join(pkgDir, 'client', 'client.js')
const clientOut = path.join(pkgDir, 'lib', 'client.js')
if (existsSync(clientSrc)) {
  mkdirSync(path.dirname(clientOut), { recursive: true })
  copyFileSync(clientSrc, clientOut)
  console.log('\n[build-pack] copied client/client.js -> lib/client.js')
} else {
  console.warn('\n[build-pack] WARNING: client/client.js missing — package will ship without a client half')
}

if (noPack) {
  console.log('\n[build-pack] compile done (--no-pack)')
  process.exit(0)
}

// Remove stale artifacts of this package before packing.
try {
  const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  for (const f of readdirSync(pkgDir)) {
    if (f.startsWith(pkgJson.name + '-') && f.endsWith('.tgz')) rmSync(path.join(pkgDir, f), { force: true })
  }
} catch { /* best-effort cleanup */ }

run(npm, ['pack', '--pack-destination', pkgDir, `--cache=${cacheDir}`])
console.log('\n[build-pack] done — artifact in', pkgDir)
