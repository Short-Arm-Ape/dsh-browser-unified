#!/bin/bash
# deploy.sh <rigTag> — put ext-<rigTag> in front of a FRESH browser profile and
# refuse to hand back control unless the browser's hello frame carries that tag.
#
# Why the tag + fresh profile: a stale profile (or a half-killed browser) keeps
# serving the *old* background.js, which silently produces "evidence" for a
# build that is not the one on disk. The tag makes that impossible to miss.
set -euo pipefail
tag="${1:?usage: deploy.sh <rigTag>}"
win_root='C:\Users\localuser\AppData\Local\Temp\__pr-d-rig'
wsl_root='/mnt/c/Users/localuser/AppData/Local/Temp/__pr-d-rig'
prof="profile-$tag"
ps1=/home/wsluser/projects/dsh-browser-unified/rig/__rig-launch-run.ps1

if [ ! -d "/home/wsluser/projects/dsh-browser-unified/rig/ext-$tag" ]; then echo "no ext-$tag; run mk-ext.sh first" >&2; exit 2; fi

cat > "$ps1" <<'PS1'
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = '__WIN_ROOT__'
$profile = Join-Path $root '__PROFILE__'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
for ($i = 0; $i -lt 15; $i++) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$root*" }
  if (-not $procs) { break }
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 700
}
$left = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$root*" }).Count
Write-Output "rig edge processes left: $left"
Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
$arglist = @("--user-data-dir=$profile", "--load-extension=$root\ext", '--no-first-run', '--no-default-browser-check', '--disable-sync', '--window-size=800,600', '--headless=new', 'http://localhost:9781/fast')
Start-Process -FilePath $edge -ArgumentList $arglist
Write-Output "launched profile=$profile"
PS1
python3 - "$ps1" "$win_root" "$prof" <<'PY'
import sys
path, win_root, prof = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding='utf-8').read()
s = s.replace('__WIN_ROOT__', win_root).replace('__PROFILE__', prof)
open(path, 'w', encoding='utf-8', newline='').write(s)
PY
grep -n 'Join-Path' "$ps1" | head -3
grep -c '__WIN_ROOT__\|__PROFILE__' "$ps1" || true

rm -rf "$wsl_root/ext"
cp -r "/home/wsluser/projects/dsh-browser-unified/rig/ext-$tag" "$wsl_root/ext"
/home/wsluser/projects/__ps.sh "$ps1" 2>&1 | tr -d '\r' | grep -v 'CLIXML\|^<Objs\|Preparing modules' | head -4

state=""
for i in $(seq 1 20); do
  state=$(curl -s --max-time 3 http://127.0.0.1:9781/ctl/state || true)
  if [ -n "$state" ] && echo "$state" | grep -q "\"rigTag\":\"$tag\""; then
    echo "READY: $state"
    exit 0
  fi
  sleep 2
done
echo "FAILED: browser never reported rigTag=$tag; last state: ${state:-<none>}" >&2
exit 1
