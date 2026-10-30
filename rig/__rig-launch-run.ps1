$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = 'C:\Users\localuser\AppData\Local\Temp\__pr-d-rig'
$profile = Join-Path $root 'profile-hardlock-a'
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
