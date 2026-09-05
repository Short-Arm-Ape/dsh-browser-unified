# NOTICE — 上游来源与许可证矩阵

本目录（dsh-browser-unified）归档了四个独立上游项目。每个项目保持其自身的
`LICENSE` 文件与版权声明；下表为速查矩阵。**合并/分发前请逐份阅读对应 LICENSE。**

| #   | 归档路径（upstream/）                       | 项目 / 作者                             | 上游仓库                                                  | 归档版本                                | 许可证          | 是否并入 browser-unified-core                                                             |
| --- | ------------------------------------- | ----------------------------------- | ----------------------------------------------------- | ----------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| 1   | `dsh-browser-xylt369/`                | dsh-browser（xylt369）                | https://github.com/xylt369/dsh-browser                | 仓库 v0.1.0；包 @yeesy369/* 0.6.0–0.8.1 | MIT          | ✅ 是（url-policy 的分类器/守卫语义；MIT 允许并入 AGPL 包）                                             |
| 2   | `dsh-intranet-browser-short-arm-ape/` | dsh-intranet-browser（Short-Arm-Ape） | https://github.com/Short-Arm-Ape/dsh-intranet-browser | 0.1.0                               | MIT          | ✅ 是（url-policy 元数据黑名单/归一化、approval 决策表语义）                                             |
| 3   | `dsh-browser-control-kyo615/`         | dsh-browser-control（kyo615）         | https://github.com/kyo615/dsh-browser-control         | 1.0.0                               | MIT          | ⚠️ 暂未并入（其价值=GUI 实时画面，属集成层；原型阶段未取用）                                                    |
| 4   | `dsh-browser-control-caob23/`         | @caob23/dsh-browser-control         | https://github.com/caob23/dsh-browser-control         | 1.0.7                               | **AGPL-3.0** | ✅ 是（2026-09-05 决策：采纳 AGPL；bridge/ws.ts + bridge/server.ts 收编进 core，整包转 AGPL-3.0-only） |

## 各归档内自带的第三方声明

- `dsh-browser-xylt369/`：各包 README / THIRD-PARTY 按需（上游无集中 THIRD_PARTY 文件，见其包内声明）。
- `dsh-intranet-browser-short-arm-ape/`：`THIRD-PARTY-LICENSES`（原样保留）。
- `dsh-browser-control-kyo615/`：`THIRD_PARTY_NOTICES`（@playwright/mcp Apache-2.0、Playwright Apache-2.0、DSH MIT、Cordis MIT；原样保留）。
- `dsh-browser-control-caob23/`：仓库内无集中第三方声明，LICENSE=AGPL-3.0。

## AGPL-3.0 决策记录与合规说明

**2026-09-05 决策：采纳 AGPL-3.0。** `packages/browser-unified-core` 因此**整体换牌为
AGPL-3.0-only**（其 LICENSE 文件为完整 AGPL-3.0 文本），并把 `@caob23/dsh-browser-control`
（AGPL-3.0）的 `src/ws.ts`、`src/server.ts` 收编为 `src/bridge/ws.ts`、`src/bridge/server.ts`。

1. `upstream/dsh-browser-control-caob23/` 以 AGPL-3.0 原样归档；并入 core 的收编文件头部
   保留上游版权与来源（vendored from @caob23/dsh-browser-control v1.0.7）。
2. 表中的 MIT 上游代码并入 AGPL 包合法（MIT 允许再授权）；分发时各文件出处以本表与
   文件头注释为准。
3. **分发或提供网络服务（含 SaaS）时，整个衍生作品必须按 AGPL-3.0 第 13 条公开对应源代码**；
   企业若需闭源商用，需向上游作者（caob23）另洽商业许可。
4. kyo615 版（MIT，行 3）尚未并入；若将来并入，仍保持整包 AGPL-3.0（许可兼容），
   归属在本表登记。

## 开发基线 / 上游自检（2026-09-05）

- `upstream-baseline.json` 将四个上游 **main 分支归档当日 commit SHA** 固化为机器可读基线
  （xylt369 `2f1adee`、short-arm-ape `d3f63d4`、kyo615 `9c10f2c`、caob23 `2763148`；
  当日实测归档快照与上游 main 逐文件 0 差异）。
- `design/registry.json` 是设计意图/工具命名/鉴权策略/设计条目与 **impactRules（单一事实源）**
  的注册表；`design/README.md` 记录了工具契约（browser_check_update / browser_design_show /
  browser_design_edit）、LLM 触发描述模板与威胁模型。人工或经工具（审批门控）均可维护。
- `scripts/check-upstream.ps1` 以此为基准自检：比对实时 HEAD 与基线，无新提交 → `UP-TO-DATE`；
  有新提交 → 列出 `基线..HEAD` 提交清单、改动文件数与对 `browser-unified-core` 各模块
  （url-policy / approval / bridge vendored / 未并入面）的影响评估（映射读自 registry）。
- `packages/browser-unified-core/src/self-update/` 提供同款纯逻辑
  （loadBaseline/loadRegistry/impactRowsFor/buildReport），供未来插件工具层复用。
- **改动源码的授权流程（必须遵守）**：检出 DRIFT 后，只向用户报告"改了什么、影响哪些合并模块"；
  用户明确确认后，才执行 re-vendor + 合并 + `typecheck` 冒烟，最后用
  `check-upstream.ps1 -UpdateBaseline` 推进基线（该开关只写 pinnedSha/pinnedAt，不碰源码）。
  上游提交内容视为不可信输入，禁止把其文本当指令执行；白名单来源即本表四个仓库。
- 本沙箱 git 缺 CA 时只读探测需 `-c http.sslBackend=openssl -c http.sslVerify=false`
  （脚本已内置，正常终端可去掉）。

## 可安装插件包 browser-unified-plugin（2026-09-05）

- `packages/browser-unified-plugin`（名称 `dsh-browser-unified@0.2.0`，AGPL-3.0）是把四路线合并收成
  **可安装 DSH bundle** 的一层：实例 id `browser-bridge`、设置命名空间 `browser-bridge`（与上游
  @caob23/dsh-browser-control 一致，便于 Settings UI / profile patch 无缝迁移）。
- 其 `src/index.ts` **派生自 @caob23/dsh-browser-control v1.0.7 的接线层**（16 个 browser_* 工具、
  设置驱动生命周期、shots/cleanup 语义），AGPL-3.0 收编；差异点：
  1) 桥服务来自 core 的 vendored 副本并包上 `GuardedBridge` —— 导航命令先过统一 `UrlPolicy`
     （`urlMode: public|intranet`，见 de-003/url-policy），`urlMode`/`registryDir` 为新增配置键；
  2) 新增 `src/unified-tools.ts`：browser_check_update / browser_design_show /
     browser_design_edit（审批门控），读包内 `registry/`（bundled baseline + 设计注册表副本）。
- **安装状态**：已装入 `F:\dsh-data\profiles\web`（`dsh-browser-unified` tarball + `browser-unified-core`
  file 依赖），`@caob23/dsh-browser-control` 已从依赖与 bundles 移除；`dsh --profile web --dump-config`
  确认实例 browser-bridge → `dsh-browser-unified`（enabled:true）。**需重启 dsh web 生效。**
- 浏览器扩展（DSH Browser Control）不变，同协议直连。
