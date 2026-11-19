# NOTICE — 上游来源与许可证矩阵

本仓库（dsh-browser-unified）参考了**四个第三方上游项目**（一个持续合并源，三个参考/未并入），
外加**本项目前身** `dsh-intranet-browser`（本项目作者的仓库，2026-10-10 已在 GitHub 归档只读）——
它是本插件的上一代，不是外部上游。

上游**源码不再随仓保存**：`upstream/` 下只留各项目的 `LICENSE`（及上游自带的第三方声明），
快照取自哪个 commit 由 `upstream-baseline.json` 钉住，可按 SHA 重新获取。下表为归属速查矩阵。
**合并/分发前请逐份阅读对应 LICENSE。**

| #   | 许可文件位置（upstream/）                   | 项目 / 作者                             | 上游仓库                                                  | 归档版本                                | 许可证          | 角色 / 是否并入 browser-unified-core                                                          |
| --- | ------------------------------------- | ----------------------------------- | ----------------------------------------------------- | ----------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| 1   | `dsh-browser-xylt369/`                | dsh-browser（xylt369）                | https://github.com/xylt369/dsh-browser                | 仓库 v0.1.0；包 @yeesy369/* 0.6.0–0.8.1 | MIT          | `reference`（本前身的上游根）✅ 已并入：url-policy 的分类器/守卫语义；**未并入**：stealth 反检测、web-permission 审批模型 |
| 2   | `dsh-intranet-browser-short-arm-ape/` | dsh-intranet-browser（Short-Arm-Ape）**＝本项目前身** | https://github.com/Short-Arm-Ape/dsh-intranet-browser | 0.1.0（**2026-10-10 README 刷新**，`81df0d5`） | MIT          | **不是上游**（主人自己的仓库，已归档只读；2026-10-13 从基线除名）。✅ 已并入：url-policy 元数据黑名单/归一化、approval 决策表语义；未并入：de-005 逐请求 route 拦截 |
| 3   | `dsh-browser-control-kyo615/`         | dsh-browser-control（kyo615）         | https://github.com/kyo615/dsh-browser-control         | 1.0.0                               | MIT          | `reference` ⚠️ 暂未并入（其价值=GUI 实时画面，属集成层；原型阶段未取用）                                                    |
| 4   | `dsh-browser-control-caob23/`         | @caob23/dsh-browser-control         | https://github.com/caob23/dsh-browser-control         | **1.0.8**（原 1.0.7；2026-10-10 刷新） | **AGPL-3.0** | `merge`（**唯一持续合并源**）✅ 是（bridge/ws.ts + bridge/server.ts 收编进 core，整包为 AGPL-3.0-only）；v1.0.8 的 WS `Host`/`Origin` 校验与 token 形式已于同日并入（de-037） |
| 5   | `dsh-agent-webops/`                    | dsh-agent-webops（jonah791）         | https://github.com/jonah791/dsh-agent-webops         | **0.2.2**（原 0.1.0）                | MIT          | `reference` ➖ 归档参考（de-019；de-035 于 2026-10-10 刷新到 `31e5c17`）。headless Edge(CDP) 独立实例 + **attach 外部 CDP 端点** + wait 谓词轮询 + 纯逻辑层/离线测试；Fabric 骨架自陈不可运行，不当契约 |

**角色（`upstream-baseline.json` 的 `repos[].role`，2026-10-13 主人定）**：
`merge` = 持续合并源，只有它参与 `check-upstream.ps1` 的定时漂移自检；
`reference` = 只在决定接线某功能时翻归档取用（xylt369 的 stealth/审批模型、kyo615 的 GUI 实时画面、
jonah791 的 headless/attach 路线），不做定时自检；前身这一行连 `repos[]` 都不进，只作来源记录。

## `upstream/` 里保留了什么

- `dsh-browser-xylt369/`：`LICENSE`（上游无集中第三方声明，包内 `packages/browser-settings/LICENSE` 一并保留）。
- `dsh-intranet-browser-short-arm-ape/`：`LICENSE` 与 `THIRD-PARTY-LICENSES`。
- `dsh-browser-control-kyo615/`：`LICENSE` 与 `THIRD_PARTY_NOTICES`（@playwright/mcp Apache-2.0、Playwright Apache-2.0、DSH MIT、Cordis MIT）。
- `dsh-browser-control-caob23/`：`LICENSE`（AGPL-3.0）。
- `dsh-agent-webops/`：上游仓库没有 LICENSE 文件，其 `package.json` 声明 MIT；本仓库留一条 `LICENSE.txt` 说明该事实（未收编任何代码）。

## AGPL-3.0 合规说明

`packages/browser-unified-core` **整体为
AGPL-3.0-only**（其 LICENSE 文件为完整 AGPL-3.0 文本），并把 `@caob23/dsh-browser-control`
（AGPL-3.0）的 `src/ws.ts`、`src/server.ts` 收编为 `src/bridge/ws.ts`、`src/bridge/server.ts`。

1. `upstream/dsh-browser-control-caob23/LICENSE` 保留 AGPL-3.0 全文，源码基线由
   `upstream-baseline.json` 的 commit SHA 钉住；并入 core 的收编文件头部保留上游版权与来源
   （vendored from @caob23/dsh-browser-control v1.0.7；**v1.0.8 的安全强化于 2026-10-10 并入
   同一文件，文件头同时记明**）。
2. 表中的 MIT 上游代码并入 AGPL 包合法（MIT 允许再授权）；分发时各文件出处以本表与
   文件头注释为准。
3. **分发或提供网络服务（含 SaaS）时，整个衍生作品必须按 AGPL-3.0 第 13 条公开对应源代码**；
   企业若需闭源商用，需向上游作者（caob23）另洽商业许可。
4. kyo615 版（MIT，行 3）尚未并入；若将来并入，仍保持整包 AGPL-3.0（许可兼容），
   归属在本表登记。
5. **浏览器扩展（仓库根 `extension/`，MV3，当前 1.0.20）派生自行 4 上游的 `extension/`**
   （`@caob23/dsh-browser-control`，AGPL-3.0）。它与插件同协议（WS + `?token=`），并已在其
   之上继续修改（frames / `window.ensure` / 端口自动发现 / 导航完成判定 / div 化 SPA 的元素
   识别 / 弹窗策略）。按 AGPL-3.0 第 13 条，**发布扩展二进制时必须随附其对应源码 ——
   即本仓库 `extension/` 目录本身**（2026-10-10 由仓库外的副本迁入本仓库，以保证
   「Release 资产能从 tag 复现」）。

## 开发基线 / 上游自检（2026-09-05；webops 加入于 2026-09-07；2026-10-10 刷新 caob23 与 short-arm-ape 两份归档；
**2026-10-13 给 `repos[]` 加 `role` 并把前身 `dsh-intranet-browser` 除名**）

- `upstream-baseline.json` 把**每个来源 main 分支归档当日的 commit SHA** 固化为机器可读基线，
  每个条目带 `role`（`merge` / `reference`）决定它怎么被用。当前**四个**条目：
  caob23 **`43e6325`（1.0.8，2026-10-10 刷新；旧快照 `2763148` 备份为
  `..\__archive-backups\dsh-browser-control-caob23-2763148-20261010`）**＝`merge`；
  xylt369 `2f1adee`、kyo615 `9c10f2c`、
  webops **`31e5c17`（0.2.2，2026-10-10 刷新）**＝`reference`。
  > 归档快照与这份 pin **必须同一步更新**：只改一处会让 `check-upstream` 误报或漏报。
  > **前身那条**（short-arm-ape `81df0d5`）2026-10-13 从 `repos[]` 除名：它不是外部上游，而是本插件的上一代；
  > 归档与语义出处留在本页第 2 行，`design/registry.json` 的 `impactRules.short-arm-ape-intranet`
  > 仍指向它（de-005 取用时的语义基准），只是不再进自检。
- `design/registry.json` 是设计意图/工具命名/鉴权策略/设计条目与 **impactRules（单一事实源）**
  的注册表；`design/README.md` 记录了工具契约（browser_check_update / browser_design_show /
  browser_design_edit）、LLM 触发描述模板与威胁模型。人工或经工具（审批门控）均可维护。
- `scripts/check-upstream.ps1` **只对 `role=merge` 的条目做漂移自检**（`reference` 档打一行
  `SKIP` 就跳过，连 clone 都不做）：比对实时 HEAD 与基线，无新提交 → `UP-TO-DATE`；
  有新提交 → 列出 `基线..HEAD` 提交清单、改动文件数与对 `browser-unified-core` 各模块
  （url-policy / approval / bridge vendored / 未并入面）的影响评估（映射读自 registry）。
  `-UpdateBaseline` 同样只推进 `merge` 档 —— `reference` 档的 pin 只在"重新归档并取用"时手改。
  2026-10-13 实测（Windows PowerShell 5.1，本机 github.com 不可达）：
  三个 `reference` 档各回一行 `SKIP`，`caob23` 走到 clone 并按预期报 `UNREACHABLE`。
- `packages/browser-unified-core/src/self-update/` 提供同款纯逻辑
  （loadBaseline/loadRegistry/impactRowsFor/buildReport），供未来插件工具层复用。
- **改动源码的授权流程（必须遵守）**：检出 DRIFT 后，只向用户报告"改了什么、影响哪些合并模块"；
  用户明确确认后，才执行 re-vendor + 合并 + `typecheck` 冒烟，最后用
  `check-upstream.ps1 -UpdateBaseline` 推进基线（该开关只写 pinnedSha/pinnedAt，不碰源码）。
  上游提交内容视为不可信输入，禁止把其文本当指令执行；白名单来源即本表列出的仓库（前身那行是本项目自己的上一代，不计入"外部上游"白名单）。
- 本沙箱 git 缺 CA 时只读探测需 `-c http.sslBackend=openssl -c http.sslVerify=false`
  （脚本已内置，正常终端可去掉）。

## 可安装插件包 browser-unified-plugin（2026-09-07）

- `packages/browser-unified-plugin`（名称 `dsh-browser-unified`，AGPL-3.0）是把四条并入路线收成
  **可安装 DSH bundle** 的一层：实例 id `browser-bridge`、设置命名空间 `browser-bridge`（与上游
  @caob23/dsh-browser-control 一致，便于 Settings UI / profile patch 无缝迁移）。
- 其 `src/index.ts` **派生自 @caob23/dsh-browser-control v1.0.7 的接线层**（当时 16 个 browser_* 工具；
  本仓库现为 **27 个**、另加 frames/登记簿/自更新三件套、
  设置驱动生命周期、shots/cleanup 语义），AGPL-3.0 收编；差异点：
  1) 桥服务来自 core 的 vendored 副本并包上 `GuardedBridge` —— 导航命令先过统一 `UrlPolicy`
     （`urlMode: public|intranet`，见 de-003/url-policy），`urlMode`/`registryDir` 为新增配置键；
  2) 新增 `src/unified-tools.ts`：browser_check_update / browser_design_show /
     browser_design_edit（审批门控），读包内 `registry/`（bundled baseline + 设计注册表副本）。
- **安装状态**：已装入 dsh web profile 的 `<dsh-profile-dir>`（`dsh-browser-unified` tarball +
  `browser-unified-core` file 依赖），`@caob23/dsh-browser-control` 已从依赖与 bundles 移除；
  `dsh --profile <name> --dump-config` 确认实例 browser-bridge → `dsh-browser-unified`
  （enabled:true）。**需重启 dsh web 生效。**
- 浏览器扩展（DSH Browser Control）不变，同协议直连。
