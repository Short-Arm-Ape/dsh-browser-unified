<#
  check-upstream.ps1 — 上游新提交自检（dsh-browser-unified 开发基线）

  用法：
    pwsh scripts/check-upstream.ps1                          # 检查全部上游
    pwsh scripts/check-upstream.ps1 -UpstreamId caob23-browser-control   # 只查一个
    pwsh scripts/check-upstream.ps1 -UpdateBaseline          # (仅在你已批准后) 把基线 SHA 推进到当前 HEAD

  安全约定：
    - 默认只做只读网络探测（git clone 到临时目录）与临时目录清理；
      绝不修改 upstream/、绝不修改 packages/ 下的源码。
    - 影响映射（改动路径→合并核心影响面）单一事实源 = design/registry.json 的 impactRules；
      本脚本只读它，不在代码里维护第二份。
    - -UpdateBaseline 只写 upstream-baseline.json（pinnedSha/pinnedAt），不碰任何源码。
    - "根据上游提交修改合并源码"必须走单独的审批流程：先向用户报告改了什么/影响面，
      用户确认后由 agent 手工执行 re-vendor + 合并 + typecheck，并同步推进本基线。
#>
[CmdletBinding()]
param(
  [string]$UpstreamId = '',
  [switch]$UpdateBaseline
)

$ErrorActionPreference = 'Continue'
$repoRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$baselineFile = Join-Path $repoRoot 'upstream-baseline.json'
if (-not (Test-Path $baselineFile)) { Write-Error "baseline 文件不存在: $baselineFile"; exit 2 }
$baseline = Get-Content $baselineFile -Raw | ConvertFrom-Json

# 本沙箱缺 CA（schannel 无凭据 / openssl 无证书链）时的只读探测参数；
# 在正常终端里可去掉这两项。仅影响 git 本次进程，不改任何全局配置。
$gitArgs = @('-c', 'http.sslBackend=openssl', '-c', 'http.sslVerify=false')
$env:GIT_TERMINAL_PROMPT = '0'

$tmp = Join-Path $repoRoot '__upstream-check'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# ---- 影响映射：单一事实源 = design/registry.json 的 impactRules（勿在代码里再写一份）----
$registryFile = Join-Path $repoRoot 'design\registry.json'
if (-not (Test-Path $registryFile)) { Write-Error "registry 文件不存在: $registryFile"; exit 2 }
$registry = Get-Content $registryFile -Raw | ConvertFrom-Json
$impactMap = @{}
foreach ($prop in $registry.impactRules.PSObject.Properties) {
  $impactMap[$prop.Name] = @($prop.Value)
}

$anyDrift = $false
$dirty = $false
foreach ($repo in $baseline.repos) {
  if ($UpstreamId -and $repo.id -ne $UpstreamId) { continue }
  Write-Output ("===== {0} =====" -f $repo.id)
  $dst = Join-Path $tmp $repo.id
  & git @gitArgs clone --quiet $repo.url $dst 2>&1 | Out-Null
  if (-not (Test-Path (Join-Path $dst '.git'))) {
    Write-Output '  状态      : UNREACHABLE —— clone 失败（网络 / 代理 / 认证），本次跳过'
    Write-Output ''
    continue
  }
  $head     = (& git -C $dst rev-parse HEAD 2>&1 | Select-Object -First 1).Trim()
  $headLine = (& git -C $dst --no-pager log -1 --format='%h %cs %s' 2>&1 | Select-Object -First 1)
  $pj = Join-Path $dst 'package.json'
  $ver = '<n/a>'
  if (Test-Path $pj) { try { $ver = (Get-Content $pj -Raw | ConvertFrom-Json).version } catch { $ver = '<unreadable>' } }
  Write-Output ("  HEAD      : {0}  [{1}]  version={2}" -f $head, $headLine, $ver)
  Write-Output ("  基线      : {0}  (pinned {1})" -f $repo.pinnedSha, $repo.pinnedVersion)

  if ($head -ceq $repo.pinnedSha) {
    Write-Output '  状态      : UP-TO-DATE —— 上游 main 无新提交，归档快照即基线'
  } else {
    $anyDrift = $true
    Write-Output '  状态      : DRIFT —— 上游 main 有新提交'
    $commits = & git -C $dst --no-pager log --format='    %h  %cs  %s' "$($repo.pinnedSha)..HEAD" 2>&1
    if ($LASTEXITCODE -ne 0 -or -not ($commits | Where-Object { $_ -notmatch 'fatal' })) {
      Write-Output '  基线 SHA 不在当前历史中（上游可能改写历史 / force-push），无法给出提交清单，需人工核对。'
    } else {
      Write-Output '  自基线以来的新提交:'
      $commits | Where-Object { $_ -notmatch '^fatal' } | ForEach-Object { Write-Output $_ }
      $names = @(& git -C $dst --no-pager diff --name-only "$($repo.pinnedSha)..HEAD" 2>&1 | Where-Object { $_ -notmatch '^fatal' })
      Write-Output ("  改动文件数: {0}" -f $names.Count)
      Write-Output '  对合并核心的影响评估:'
      $seen = @{}
      foreach ($n in $names) {
        $rows = $impactMap[$repo.id]
        $row = $null
        foreach ($r in $rows) { if ($n -like ('*' + $r.m + '*')) { $row = $r; break } }
        if (-not $row) { $row = $rows[-1] }
        $key = $row.t
        if (-not $seen.ContainsKey($key)) {
          $seen[$key] = $true
          Write-Output ("    -> {0}" -f $row.t)
          Write-Output ("        影响: {0}" -f $row.i)
        }
      }
      Write-Output '  >>> 如需吸收：向用户展示以上改动与影响，得到确认后才执行 re-vendor + 合并 + typecheck，并用 -UpdateBaseline 推进基线。'
    }
  }
  Write-Output ''
}

if ($UpdateBaseline -and $anyDrift) {
  $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'
  foreach ($repo in $baseline.repos) {
    if ($UpstreamId -and $repo.id -ne $UpstreamId) { continue }
    $dst = Join-Path $tmp $repo.id
    if (-not (Test-Path (Join-Path $dst '.git'))) { continue }
    $head = (& git -C $dst rev-parse HEAD 2>&1 | Select-Object -First 1).Trim()
    if ($head -and $head -cne $repo.pinnedSha) {
      $repo.pinnedSha = $head
      Write-Output ("基线推进: {0} -> {1}" -f $repo.id, $head)
      $dirty = $true
    }
  }
  if ($dirty) {
    $baseline.pinnedAt = $now
    $baseline | ConvertTo-Json -Depth 8 | Set-Content -Path $baselineFile -Encoding UTF8
    Write-Output '已更新 upstream-baseline.json（仅 pinnedSha/pinnedAt；未触碰任何源码）。'
  } else {
    Write-Output '无漂移，基线未改动。'
  }
}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Output 'DONE'
