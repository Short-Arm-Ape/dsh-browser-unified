# dsh-browser-unified 0.11.21 发布说明

> 两个静默缺陷的真机修复（`browser_press` 双倍输入、`browser_emulate` 空 UA）+ 上游清单收敛为「四个第三方上游 + 前身」

## 版本

| 包 | 版本 | 说明 |
|---|---|---|
| `dsh-browser-unified` | **0.11.21** | 插件壳（27 个 `browser_*` 工具） |
| `browser-unified-core` | **0.1.5** | 合并核心（URL 策略 / 审批 / 收编桥，AGPL-3.0-only） |
| `dsh-browser-unified-mit` | **0.1.1** | MIT 版（不含桥与驱动工具；本版跟进 core 的 self-update 增量） |
| 浏览器扩展 `extension/` | **1.0.20** | MV3 |

## 变化

### 1. `browser_press` 一次按键插两遍（扩展 1.0.20）

**症状**：输入框里按一次 `x` 得到 `xx`；按一次 `Enter` 表单**提交两次**；数字键同样翻倍。
**全程不报错** —— 页面上只是"多了一个字符"，看起来像手滑，所以坏了很多版都没人报。

**根因**：CDP `Input.dispatchKeyEvent` 的 `type:'keyDown'` **带 `text` 时 Chrome 自己会补一个
char/keypress**（`rawKeyDown` 才不补），而 `cmdPress` 在这之后又显式发了一条 `type:'char'`。
`browser_type` 的 `submit:true` 在插件侧是先 `input` 再 `press Enter` ⇒ 同样提交两次。

**修法**：删掉那条多余的 `char` 派发。上游 caob23 是同一个坑（其 issue #14），2026-10-13
他自己以同样方式修掉（`908a149f9`）—— 我们这条扩展线独立复现并修好。

**真机前后对照**（台子：真 Edge 155（headless=new）+ 真扩展 sideload + 假桥 `stub.mjs`@9781，
页面 `/press` 数事件）：

| 场景 | 改前 `UB0`（1.0.90） | 改后 `UC1`（1.0.91） |
|---|---|---|
| 按 `x` | `value="xx"`，keydown=1 **keypress=2 input=2 beforeinput=2** | `value="x"`，keydown=1 keypress=1 input=1 |
| 按 `7` | `value="77"` | `value="7"` |
| 表单里按 `Enter` | **submit=2** | **submit=1** |
| 按 `ArrowRight`（不带 text，对照） | 不插字符、keydown=1 | 同左（未受影响） |

改前 **9 项 6 失败** → 改后 **9/9**。证据：`__pr-d-rig/evidence-unified-UB0.json` /
`evidence-unified-UC1.json`，场景脚本 `unified-bugs-real.mjs`；台子已收（`rig edge killed: 16; left: 0`）。

**顺带发现、本版未动**：`Shift+X` 落成小写 `x`（`text` 直接取 `key` 原文，没有按 shift 提大写）。
这是独立的小瑕疵，登记为观察项。

### 2. `browser_emulate` 不覆盖 UA 时每次抛 `ToolOutputError`（插件）

**症状**：`device:"desktop"`、或只给 `width`/`height` 的自定义视口，**每次**都报
`"value.userAgent" must be a string`；只有带真 UA 的预设（mobile/tablet）能过 —— 所以从 0.7
起一直坏着。

**根因**：扩展在无 UA 覆盖时回的是**显式** `userAgent: null`（`userAgent: userAgent || null`），
而宿主的输出校验器对 `null` **会下钻判类型**（只跳过 `undefined`）；插件把回包原样透传。
上游在 v1.0.14 修的是同一条。

**修法**：新增导出纯函数 `normalizeEmulateValue()`，`browser_emulate` 的 execute 改为逐字段按类型
收口，`null`/缺字段一律不落进结果（与上游同法）。

**两层验证**：

- 契约层 —— 新增 `tests/emulate-contract.mjs`（**用宿主机自己的校验器**
  `@deepseek-ai/dsh-tools` 的 `valueSchemaSpecToJsonSchema` + `validateJsonSchemaValue`），**12/12**：
  真机回包原样必须**不合格**（阳性对照，报 `"value.userAgent" must be a string`）、归一化后合格；
  另覆盖"带真 UA 的预设不能被丢掉"与 reset 回包。
- 真机层 —— rig 里实测回包确实是 `{"tabId":…,"width":1280,"height":800,…,"userAgent":null}`
  （**显式 null，不是缺字段**）。

### 3. 上游清单收敛：`role` 分档 + 前身除名（core 0.1.5）

- `upstream-baseline.json` 每个来源加 `role`：**`merge`**（持续合并源，唯一参与漂移自检）＝ caob23；
  **`reference`**（只在决定接线某功能时翻归档取用，不做定时自检）＝ xylt369 / kyo615 / webops。
  `role` 缺省视为 `merge` —— 老基线行为不变。
- **前身 `short-arm-ape-intranet` 从 `repos[]` 除名**（条目 5 → 4）：它是**本插件的上一代**、
  主人自己的仓库，且 2026-10-10 已在 GitHub 归档只读。已并入的部分（url-policy 的 intranet 档、
  approval 决策表）不变，未并入的只剩 de-005。`design/registry.json` 的 `impactRules` 仍保留它那一行 ——
  除名的是"上游自检清单"，不是来源记录。
- `scripts/check-upstream.ps1` 只对 `role=merge` 做漂移自检（reference 打一行 `SKIP` 就跳过，
  连 clone 都不做）；`-UpdateBaseline` 同样只推进 merge 档。
  **实测**（Windows PowerShell 5.1，本机 github.com 不可达）：三个 reference 各回一行 `SKIP`，
  caob23 走到 clone 并按预期报 `UNREACHABLE`。
- 插件侧 `browser_check_update` 同规则：默认只查 merge，被跳过的 reference 在报告里**点名**
  （显式传 `repos:[<id>]` 仍可单独查）。
- core API 增量：`RepoRole` / `repoRole()` / `RepoReport.role` / `CheckSummary.skippedNonMerge`。

### 4. 文档口径修正

- README 里"16 个 `browser_*` 工具"是旧数字（v1.0.7 时代的接线层规模）⇒ 改为实际的 **27 个**。
- 「上游」口径统一为「**四个第三方上游 + 本项目前身**」；NOTICE 的来源矩阵加了 role 列与
  「前身不是上游」的说明。

## 登记簿

- 新增 `bi-034`（`browser_press` 双倍输入）、`bi-035`（`browser_emulate` 空 UA），均 `fixed`。
- 新增 `de-039`（上游 role 分档 + 前身除名），`applied`。

## 验收

- 测试：**8 套 207 项全绿**（tool-render 61、bridge-http-auth 32、permissions-read 23、
  registry-consistency **23**（新增 `[5]` role 段 5 条）、render-settings-pages 22、buddy-merged 21、
  permissions-resolve 13、emulate-contract **12**）。上一版是 7 套 190 项。
- typecheck：core / plugin / mit 三包 `tsc --noEmit` 全过。
- 发布脚本：G1–G8 全通过（core dist 含本轮代码、plugin/mit 的 lib 工具集 == src、core↔mit 共享逻辑
  仅代码行一致、registry 三副本逐字节一致、扩展 manifest 版本与资产名一致、zip 形态、资产名版本、`dsh` 零跳过）。
- 真机：rig 上 press 前后成对对照（6 失败 → 9/9）；emulate 的前提（扩展回显式 `null`）实测确认。
- **装机后 live 验收（2026-10-13 20:0x）**：桥 `/api/status` → `hello.version = 1.0.20`（扩展到位）；
  `browser_emulate {device:"desktop"}` 在 live 上调用成功（旧代码必抛 `ToolOutputError`）⇒ 插件侧新代码在跑；
  登记簿 delta 送达（`bi-034`/`bi-035`）。

## 已知 / 未做

- ⚠️ **扩展 1.0.20 需要重启浏览器（或在扩展页点「重新加载」）才生效** —— 装着的还是 1.0.19。
- ⚠️ 插件包侧的改动要**重装 + 重启 `dsh web`** 才进 live。
- **本版没有吸收上游**：caob23 待吸收面仍是 `v1.0.9→v1.0.17`（find/dialog/info、read 分页、
  `effectState` 错误契约、标签归组、AX 快照、`parseKeySpec`）。触发条件已满足，但刻意没有与本次
  修复混在一起发。
- `Shift+X` 落成小写 `x`（观察项，未登记为 issue）。
- `de-005` 页面级逐请求拦截（route 化）仍未实现（设计 accepted）。
- 仓库根 `dsh-browser-unified/README.md`（笔记目录那份）是 0.7.x 时代的快照，本版未同步 ——
  现况以本目录 `README.md` 为准。
