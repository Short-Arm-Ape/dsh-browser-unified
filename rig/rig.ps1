# rig.ps1 — Windows 入口。真正的实现在 rig.mjs（两个平台同一份逻辑）。
# 用法：pwsh -File rig\rig.ps1 run --tag win --scenario smoke
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $here 'rig.mjs') @args
exit $LASTEXITCODE
