<#
  check-upstream.ps1 — 上游新提交自检（dsh-browser-unified 开发基线）

  用法：
    pwsh scripts/check-upstream.ps1                          # 只查 role=merge 的上游（持续合并源）
    pwsh scripts/check-upstream.ps1 -UpstreamId caob23-browser-control   # 只查一个
    pwsh scripts/check-upstream.ps1 -UpdateBaseline          # (仅在你已批准后) 把基线 SHA 推进到当前 HEAD

  角色（2026-10-13 主人定；见 upstream-baseline.json 顶层 note）：
    - role=merge：持续合并源，本脚本唯一做漂移自检的对象（目前只有 caob23）。
    - role=reference：只在决定接线某功能时按基线 SHA 取用（xylt369 的 stealth/审批模型、kyo615 的
      GUI 实时画面、jonah791 的 headless/attach 路线）。**不做定时自检** —— 它们几个月不动，
      每次自检只会报一堆没人处理的提交。要取用时按 id + baselineRef 里的 SHA 重新拉取
      （仓库里只留了 LICENSE，不存源码快照），别指望本脚本提醒。
    - 本项目前身 `dsh-intranet-browser`（主人自己的仓库，已归档只读）已从基线除名，不是上游。

  安全约定：
    - 默认只做只读网络探测（git clone 到临时目录）与临时目录清理；
      绝不修改 upstream/、绝不修改 packages/ 下的源码。
    - 影响映射（改动路径→合并核心影响面）单一事实源 = design/registry.json 的 impactRules；
      本脚本只读它，不在代码里维护第二份。
    - -UpdateBaseline 只写 upstream-baseline.json（pinnedSha/pinnedAt），不碰任何源码。
    - "根据上游提交修改合并源码"必须走单独的审批流程：先向用户报告改了什么/影响面，
      用户确认后由 agent 手工执行 re-vendor（按 SHA 取源码）+ 合并 + typecheck，并同步推进本基线。

  兼容性（2026-10-10 实撞；三项都会让自检"看起来跑了、其实什么都没查到"）：
    - 本文件**必须带 UTF-8 BOM**：Windows PowerShell 5.1 把无 BOM 的非 ASCII .ps1 按 ANSI 解码，
      中文字符串会吞掉引号 → 解析期直接报错（`MissingFileSpecification`）。
    - 所有 JSON 读取都走 [System.IO.File]::ReadAllText(..., UTF8 无 BOM) 或 -Encoding UTF8：
      PS 5.1 的 Get-Content 默认按 ANSI 读，UTF-8 中文会解出 GBK 尾字节 `\` → ConvertFrom-Json 抛 ArgumentException。
    - git 探测参数按序回退（纯 sslVerify=false → 再加 openssl 后端 → 原样）：gnutls 版 git 不认
      `http.sslBackend=openssl`，只带该参数会让五个上游全部误报 UNREACHABLE。
#>
[CmdletBinding()]
param(
  [string]$UpstreamId = '',
  [switch]$UpdateBaseline
)

$ErrorActionPreference = 'Continue'
# 原生命令（git）输出是 UTF-8，而 PS 5.1 默认按控制台 OEM 代码页解码 ⇒ 提交标题全成乱码，
# 而提交清单正是本脚本唯一的证据面。两条都钉成 UTF-8（无 BOM）。
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$repoRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$baselineFile = Join-Path $repoRoot 'upstream-baseline.json'
if (-not (Test-Path $baselineFile)) { Write-Error "baseline 文件不存在: $baselineFile"; exit 2 }
# PS 5.1 的 Get-Content 默认按 ANSI 代码页读文件：本仓库这两个 JSON 都是 UTF-8 无 BOM 且含中文，
# 按 ANSI 解码会产出 GBK 尾字节恰好是 `\` 的乱码 ⇒ ConvertFrom-Json 抛 ArgumentException。
# 所以**所有** JSON 读取都必须显式 -Encoding UTF8（2026-10-10 实撞）。
$utf8 = [System.Text.UTF8Encoding]::new($false)
$baseline = [System.IO.File]::ReadAllText($baselineFile, $utf8) | ConvertFrom-Json

# 只读网络探测的 git 参数。旧写法只用 `-c http.sslBackend=openssl`，而本机 git 是 gnutls 构建
# （无 openssl 后端）⇒ 该参数本身就让 git 失败、五个上游全部误报 UNREACHABLE（bi-030 同一坑）。
# 现在按序回退：先只关校验，再试 openssl 后端，最后原样重试。
$gitArgSets = @(
  ,@('-c', 'http.sslVerify=false')
  ,@('-c', 'http.sslBackend=openssl', '-c', 'http.sslVerify=false')
  ,@()
)
$env:GIT_TERMINAL_PROMPT = '0'

$tmp = Join-Path $repoRoot '__upstream-check'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# ---- 影响映射：单一事实源 = design/registry.json 的 impactRules（勿在代码里再写一份）----
$registryFile = Join-Path (Join-Path $repoRoot 'design') 'registry.json'
if (-not (Test-Path $registryFile)) { Write-Error "registry 文件不存在: $registryFile"; exit 2 }
$registry = [System.IO.File]::ReadAllText($registryFile, $utf8) | ConvertFrom-Json
$impactMap = @{}
foreach ($prop in $registry.impactRules.PSObject.Properties) {
  $impactMap[$prop.Name] = @($prop.Value)
}

$anyDrift = $false
$dirty = $false
foreach ($repo in $baseline.repos) {
  if ($UpstreamId -and $repo.id -ne $UpstreamId) { continue }
  # 只有 role=merge 参与漂移自检；reference 档只打一行说明就跳过（不 clone、不比对）。
  $role = 'merge'
  if ($repo.PSObject.Properties['role'] -and $repo.role) { $role = [string]$repo.role }
  Write-Output ("===== {0} =====" -f $repo.id)
  if ($role -ne 'merge') {
    Write-Output ("  状态      : SKIP —— role={0}（参考档：只在决定接线/取用时翻归档，不做定时漂移自检）" -f $role)
    Write-Output ''
    continue
  }
  $dst = Join-Path $tmp $repo.id
  foreach ($gitArgs in $gitArgSets) {
    if (Test-Path (Join-Path $dst '.git')) { break }
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue }
    $attempt = (& git @gitArgs clone --quiet $repo.url $dst 2>&1 | Out-String).Trim()
    if (-not (Test-Path (Join-Path $dst '.git')) -and $attempt) { $cloneError = $attempt }
  }
  if (-not (Test-Path (Join-Path $dst '.git'))) {
    Write-Output '  状态      : UNREACHABLE —— clone 失败（网络 / 代理 / 认证），本次跳过'
    if ($cloneError) { Write-Output ("  末次错误  : {0}" -f ($cloneError -split "`n" | Select-Object -First 1)) }
    Write-Output ''
    continue
  }
  $head     = (& git -C $dst rev-parse HEAD 2>&1 | Select-Object -First 1).Trim()
  $headLine = (& git -C $dst --no-pager log -1 --format='%h %cs %s' 2>&1 | Select-Object -First 1)
  $pj = Join-Path $dst 'package.json'
  $ver = '<n/a>'
  if (Test-Path $pj) { try { $ver = ([System.IO.File]::ReadAllText($pj, $utf8) | ConvertFrom-Json).version } catch { $ver = '<unreadable>' } }
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
    # 与自检同一把尺子：只有 merge 档会被推进（reference 档的 pin 只在"重新归档并取用"时手改，
    # 否则 pin 会脱离归档快照本身）。
    if ($repo.PSObject.Properties['role'] -and $repo.role -and $repo.role -ne 'merge') {
      Write-Output ("跳过（role={0}，本开关只推进 merge 档）: {1}" -f $repo.role, $repo.id)
      continue
    }
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
    # 不用 Set-Content -Encoding UTF8：PS 5.1 会写 **带 BOM** 的 UTF-8，而我们的工具与 Node
    # 都按无 BOM 解析（JSON.parse 会把 BOM 当非法字符）。这里显式写无 BOM UTF-8。
    # 注意：本开关会按 PS 的格式重排整个文件（仍是合法 JSON）。
    [System.IO.File]::WriteAllText($baselineFile, ($baseline | ConvertTo-Json -Depth 8), $utf8)
    Write-Output '已更新 upstream-baseline.json（仅 pinnedSha/pinnedAt；未触碰任何源码）。'
  } else {
    Write-Output '无漂移，基线未改动。'
  }
}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Output 'DONE'
