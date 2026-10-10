# dsh-browser-unified 0.11.20 发布说明

> 跟进上游 caob23 v1.0.8 的安全强化 + 发布流程可复现化（de-037）

## 版本

| 包 | 版本 | 说明 |
|---|---|---|
| `dsh-browser-unified` | **0.11.20** | 插件壳（27 个 `browser_*` 工具） |
| `browser-unified-core` | **0.1.4** | 合并核心（URL 策略 / 审批 / 收编桥，AGPL-3.0-only） |
| `dsh-browser-unified-mit` | 0.1.0 | MIT 版（不含桥与驱动工具） |
| 浏览器扩展 `extension/` | **1.0.19** | MV3，**本次起随仓库发布**（原先在仓库外维护） |

## 变化

### 1. 跟进上游 v1.0.8 的安全强化（core 0.1.4）

上游 2026-10-10 发布 v1.0.8，其中两条与我们 2026-09-25 独立发现并修过的问题同类
（他们的 #3/#6：HTTP 面无鉴权 + `Access-Control-Allow-Origin: *`），且修得更全。本轮**并入**：

- **WebSocket 升级加 `Host` 回环校验 + `Origin` 校验** —— 挡 DNS-rebinding（公网域名解析回
  127.0.0.1）与「网页直接拨号」（WS 握手不受 CORS 约束；而桥的默认 token 是公开的 `dsh-local`）。
- HTTP 面 token 形式对齐上游：`Authorization: Bearer` / `X-Token` / `?token=`，比较用 `timingSafeEqual`
  （我们额外保留旧的 `X-DSH-Token`，兼容既有脚本）。
- 所有 JSON 响应不再发 `Access-Control-Allow-Origin: *`；`/api/status` 改为**只对回环来源回显**
  （GUI 设置页的只读探测依赖它，公网网页读不到）。

**我们另外自己修的两条**（登记为 bi-031 / bi-032）：

- 状态页曾把 token 内嵌进 HTML —— 任何能 `GET /` 的本机程序都能拿到唯一凭据；现改为
  sessionStorage + 现问，清理按钮走 `Authorization: Bearer`。
- 弱 token（内置默认或短于 16 字符）现在启动时告警，状态面新增 `insecureToken`（告警不拒启，
  与上游同口径；拒绝启动会让所有现存配对当场断连）。

**保留的差异**：① `guardCommand` 策略钩子（HTTP 命令面也要过 URL 策略，上游只做鉴权不做策略）；
② 空 token = 不校验（向后兼容）；③ `/api/status` 的回环 CORS 回显；④ `hello` 多一个 `extensionId`。

### 2. 扩展源码迁入仓库（`extension/`）

扩展此前在仓库外维护（与上游扩展已分叉到 1.0.19），导致 Release 里的扩展**无法从 tag 复现**，
也不满足 AGPL「给二进制就要给对应源码」。现在源码在 [`extension/`](extension/)，归属登记在
`NOTICE.md` 第 5 条。它是能力完整性的前提：`browser_frames` / `browser_frame_eval`、
自动拉起的「扩展自建窗口」路径（`window.ensure`）、端口自动发现、导航完成判定、
div 化 SPA 元素识别（`cursor:pointer` 样式边界）都只有本版扩展提供。

### 3. 发布流程改成脚本 + 闸门（`scripts/build-release.mjs`）

不再「把 packages 下三个文件夹压成 zip」（0.6.1 的形态：会把 `.npm-cache/` 88 条一起发出去，
且产物与源码的一致性无人把关）。新脚本产出并自检：

```
dist-release/
  browser-unified-core-0.1.4.tgz          + .sha256
  dsh-browser-unified-0.11.20.tgz         + .sha256
  dsh-browser-unified-mit-0.1.0.tgz       + .sha256
  DSH-Browser-Control-v1.0.19.zip         + .sha256   ← 扩展（PK 头 + 正斜杠）
  browser-unified-{core,plugin,mit}.zip   + .sha256   ← 兼容旧资产名：只含对应 tgz + README
  INSTALL.md
```

闸门（任一不过即非零退出，不出半套资产）：

| 闸门 | 抓什么 |
|---|---|
| G1 | core `dist/` 存在**且含本轮新代码**（防"忘构建 → 发空包"；`dist/` 不入库） |
| G2 | plugin / mit 的 `lib/` 工具集 == `src/` 工具集（防"入库的 lib 落后 src" —— 上游 v1.0.7 就是这么发出 11/16 个工具的） |
| G3 | core 与 mit 的共享逻辑**只比代码行**（忽略许可头/模块名）一致（防 MIT 版悄悄漂移） |
| G4 | `design/registry.json` 与 `upstream-baseline.json` 的**三份副本**（根 / plugin / mit）一致 |
| G5 | 扩展：manifest 版本、图标 16/48/128 齐全、无 `.map` 等垃圾 |
| G6 | 每个 zip：`PK\x03\x04` 头 + 正斜杠条目 + 不含 `.npm-cache` / `node_modules` / `*.tgz` |
| G7 | 资产名里的版本 == `package.json` 版本 |
| G8 | `dsh --profile web --dump-config` 零 `skipping profile bundle` |

脚本自带的 zip 写入器是**自己实现的**（Node + zlib）：PS 5.1 的 `Compress-Archive` 会写反斜杠条目，
而 Windows 资源管理器只认文件头 + 正斜杠（上游 issue #2 的教训）。产出后用 Python `zipfile.testzip()`
与 Info-ZIP `unzip -t` 双重复核过，且扩展 zip 解压后与 `extension/` 逐字节一致。

### 4. 包内 patch 默认改为 `enabled: true`

包内 `cordis.patch.yml` 原本写死 `enabled: false`：显式值会覆盖 schema 默认值（本来就是 true），
于是「装上即用」变成「装上没监听 9777、扩展报 `ERR_CONNECTION_REFUSED`」—— 正是上游 v1.0.8 修
issue #4 的同一个坑。现在默认开；关掉的正确位置是 **profile 层**或设置页（优先级更高）。
实测（模拟全新安装：profile 层不写 `browser-bridge` 行）：桥照样起来，且 9777 被占时自动顺延到 9778。

## 上游采纳 / 归档

- 归档刷新：caob23 `2763148`(v1.0.7) → **`43e6325`(v1.0.8)**；short-arm-ape `d3f63d4` → **`81df0d5`**
  （README 停维护横幅，源码面仍 0.1.0）。旧快照备份在 `..\__archive-backups\`。
- `scripts/check-upstream.ps1` 修复三处自伤（无 UTF-8 BOM → PS 5.1 解析错；`Get-Content` 按 ANSI 读
  UTF-8 JSON → `ConvertFrom-Json` 抛错；git 参数只用 `http.sslBackend=openssl` → 五个上游全部误报
  UNREACHABLE），并钉 UTF-8 输出编码。修后实测 **5/5 UP-TO-DATE**。
- 登记簿：新增 `de-037`（本次）、`bi-031`/`bi-032`（上面两条安全缺陷）；`de-006` 前提更正 ——
  上游 CHANGELOG 明确 `allowEval` **从未实现过**，该条性质由「恢复上游能力」改为「本仓库自有功能」。

## 验收

- WSL 活体：插件 0.11.20 + core 0.1.4 装机；探针实例 `exit=124`、stderr 0 行、0 跳过；
  9777 实测：无 Origin 不回 ACAO / 回环来源回显 / 公网来源不回收 / `OPTIONS` 204 且无 CORS /
  无 token 401 / 带 token 503（阳性对照）/ WS 坏 Host 403 / 网页 Origin 403；**扩展重连正常**。
- 测试：7 套 **190 项**全绿（tool-render 61、permissions-read 23、permissions-resolve 13、
  registry-consistency 18、buddy-merged 21、render-settings-pages 22、bridge-http-auth 32）。
- 发布脚本：G1–G8 全通过；4 个 zip 经 Python/Info-ZIP 双重复核；7 个资产 sha256 校验通过。

## 已知 / 未做

- `de-005` 页面级逐请求拦截（route 化）仍未实现（设计 accepted）。
- 上游 `verify/` 那套「装载产物实测台」我们只覆盖了一部分（G1/G2/G6 是它的等价物），
  发布前建议仍手工跑一遍 7 套测试。
- 状态页/设置页里显示的 token 强度依赖配置：本机当前是默认 `dsh-local`，**建议改强随机值**。
