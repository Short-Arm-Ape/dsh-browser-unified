# dsh-intranet-browser one-click installer for DeepSeek Harness (PowerShell / Windows)
# Manually installs THIS local package (no npm publish needed) into the `web` profile:
#   - builds the package (tsc + client bundle) if sources changed
#   - runs `dsh plugin --profile web add file:<this repository root>`
#   - migrates the legacy `@yeesy369/dsh-intranet-browser` entry if one exists
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# or from the repository root:
#   ./scripts/install.ps1
#
# Prerequisites: Node.js + pnpm (dsh plugin itself requires pnpm) and the dsh CLI.

$ErrorActionPreference = 'Stop'

# --- locate this package ------------------------------------------------------
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
Write-Host "[dsh-intranet-browser] Package root: $repoRoot" -ForegroundColor Cyan

# --- prerequisites ------------------------------------------------------------
if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  Write-Host '[dsh-intranet-browser] dsh CLI not found.' -ForegroundColor Red
  Write-Host ''
  Write-Host '  Check:    dsh --version' -ForegroundColor Yellow
  Write-Host '  Install:  npm i -g @deepseek-ai/dsh' -ForegroundColor Yellow
  Write-Host '  Website:  https://www.npmjs.com/package/@deepseek-ai/dsh' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  After installing, open a NEW terminal window and run this script again.' -ForegroundColor Yellow
  exit 1
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host '[dsh-intranet-browser] pnpm not found on PATH — dsh plugin management needs it.' -ForegroundColor Red
  Write-Host '  Install:  npm i -g pnpm' -ForegroundColor Yellow
  exit 1
}

# --- build if sources are newer than the emitted lib/ --------------------------
$needBuild = -not (Test-Path (Join-Path $repoRoot 'lib\index.js'))
if (-not $needBuild) {
  $libTime = (Get-Item (Join-Path $repoRoot 'lib\index.js')).LastWriteTimeUtc
  Get-ChildItem (Join-Path $repoRoot 'src') -Recurse -File -Include *.ts, *.tsx | ForEach-Object {
    if ($_.LastWriteTimeUtc -gt $libTime) { $needBuild = $true }
  }
}
if ($needBuild) {
  Write-Host '[dsh-intranet-browser] Building the package (pnpm install + pnpm build)...' -ForegroundColor Cyan
  Push-Location $repoRoot
  try {
    pnpm install
    if ($LASTEXITCODE -ne 0) { Write-Host '[dsh-intranet-browser] pnpm install failed.' -ForegroundColor Red; exit $LASTEXITCODE }
    pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Host '[dsh-intranet-browser] pnpm build failed.' -ForegroundColor Red; exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }
} else {
  Write-Host '[dsh-intranet-browser] lib/ is up to date, skipping build.' -ForegroundColor DarkGray
}

# --- install into the web profile (manual / local-path install) ----------------
Write-Host '[dsh-intranet-browser] Installing into the web profile...' -ForegroundColor Cyan
dsh plugin --profile web add "file:$repoRoot"
if ($LASTEXITCODE -ne 0) {
  Write-Host '[dsh-intranet-browser] Install failed (see output above).' -ForegroundColor Red
  exit $LASTEXITCODE
}

# --- migrate the legacy package name if present --------------------------------
if ($env:DSH_HOME) { $dshHome = $env:DSH_HOME } else { $dshHome = Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome 'profiles\web'
$manifest = Join-Path $profileDir 'package.json'
if (Test-Path $manifest) {
  $pkg = Get-Content $manifest -Raw | ConvertFrom-Json
  $deps = $pkg.dependencies
  if ($null -ne $deps -and ($deps.PSObject.Properties.Name -contains '@yeesy369/dsh-intranet-browser')) {
    Write-Host '[dsh-intranet-browser] Removing the legacy @yeesy369/dsh-intranet-browser entry...' -ForegroundColor Yellow
    dsh plugin --profile web remove @yeesy369/dsh-intranet-browser
    if ($LASTEXITCODE -ne 0) {
      Write-Host '[dsh-intranet-browser] WARNING: could not remove the legacy entry (the running dsh instance may lock its files).' -ForegroundColor Yellow
      Write-Host '  After restarting dsh web, run:  dsh plugin --profile web remove @yeesy369/dsh-intranet-browser' -ForegroundColor Yellow
    }
  }
}

# --- verify ---------------------------------------------------------------------
$ok = $false
if (Test-Path $manifest) {
  $pkg = Get-Content $manifest -Raw | ConvertFrom-Json
  $deps = $pkg.dependencies
  $bundles = $pkg.dsh.profile.bundles
  $installed = Join-Path $profileDir "node_modules\@short-arm-ape\dsh-intranet-browser\lib\index.js"
  if ($null -ne $deps -and ($deps.PSObject.Properties.Name -contains '@short-arm-ape/dsh-intranet-browser') -and
      ($bundles -contains '@short-arm-ape/dsh-intranet-browser') -and
      (Test-Path $installed)) {
    $ok = $true
  }
}
if ($ok) {
  Write-Host '[dsh-intranet-browser] Verified: @short-arm-ape/dsh-intranet-browser is registered in the web profile.' -ForegroundColor Green
} else {
  Write-Host '[dsh-intranet-browser] WARNING: verification failed — check the profile manifest at:' -ForegroundColor Yellow
  Write-Host "  $manifest" -ForegroundColor Yellow
}

Write-Host ''
Write-Host '[dsh-intranet-browser] Done! Restart your profile to load the new build:' -ForegroundColor Green
Write-Host '  1) Ctrl+C the running `dsh web`, then run `dsh web` again.'
Write-Host '  2) The AI gets the intranet_* tools; every call asks for approval (per call by default).'
Write-Host '  3) Logins persist in ~/.dsh/intranet-edge-profile (independent of the regular browser).'
