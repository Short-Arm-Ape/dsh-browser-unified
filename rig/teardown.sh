#!/bin/bash
# teardown.sh — kill the rig browser (only processes whose command line carries the
# rig root) and report what is left. Never touches the user's own Edge.
set -euo pipefail
ps1=/home/wsluser/projects/dsh-browser-unified/rig/__rig-teardown.ps1
cat > "$ps1" <<'PS1'
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = 'C:\Users\localuser\AppData\Local\Temp\__pr-d-rig'
$procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$root*" }
$n = @($procs).Count
$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
$left = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$root*" }).Count
Write-Output "rig edge killed: $n; left: $left"
PS1
/home/wsluser/projects/__ps.sh "$ps1" 2>&1 | tr -d '\r' | grep -v 'CLIXML\|^<Objs\|Preparing modules' | tail -2
