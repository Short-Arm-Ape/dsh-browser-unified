# dsh-browser-unified (AGPL full edition)

> ⚠️ **本文件是 0.7.x 时代的快照，数字已过期**（下面那张表的版本 0.7.4 / 16 个工具 / 扩展 1.0.8 都是旧的）。
> **现况一律以 [`../dsh-browser-unified-src/README.md`](../dsh-browser-unified-src/README.md) 为准**
> （最新：插件 **0.11.21** / core **0.1.5** / **27 个** `browser_*` 工具 / 扩展 **1.0.20**；
> 发布说明见 [`../dsh-browser-unified-src/docs/releases-0.11.21.md`](../dsh-browser-unified-src/docs/releases-0.11.21.md)）。
> 本目录是**笔记与历史档**（`NOTE.md` 是项目流水），代码与文档的真源在 `-src/`。

Unified DeepSeek Harness browser-bridge plugin: the `@caob23/dsh-browser-control` wiring merged
with the unified URL policy, self-update / design-registry tools, and — since 0.3.0 — a GUI
Settings section. Uses the same DSH Browser Control extension and the same instance id /
settings namespace (`browser-bridge`) as the upstream plugin it replaces.

| 项 | 值 |
|---|---|
| 包名 | `dsh-browser-unified` |
| 版本 | 0.7.4 |
| 许可证 | **AGPL-3.0-only**（含 caob23 收编代码；归属与合规见 NOTICE.md） |
| 实例 id / 设置命名空间 | `browser-bridge`（与 @caob23 一致，便于迁移） |
| 提供 | 16 个 `browser_*` 驱动工具、`GuardedBridge` URL 策略守卫、自更新三件套、GUI「浏览器」设置分区 |
| 配套扩展 | **1.0.8 本地版**（上游 caob23 1.0.7 + 端口自动发现补丁，见 `extension/` 与 `extension-port-discovery-1.0.7.patch`） |

> 不含 caob23 派生代码、希望 MIT 许可的请用同仓库的 MIT 版 `dsh-browser-unified-mit`
> （`packages/browser-unified-mit`）——但它不带浏览器桥与 `browser_*` 驱动工具。

## 功能

- **浏览器驱动**：桥接 DSH Browser Control 扩展（CDP），16 个 `browser_*` 工具
  （navigate/read/snapshot/click/type/press/scroll/tabs/evaluate/screenshot/cleanup/
  console_log/network_log/network_clear/pdf/emulate）。
- **URL 策略守卫（GuardedBridge）**：`nav` / `tabs.open` 先过统一 `UrlPolicy` 再发给扩展。
  `urlMode: public`（默认）拦私网/回环/云元数据目标；`urlMode: intranet` 放行本地/LAN。
  **云元数据端点可配置**（0.3.0）：`blockMetadata` 总开关 + `metadataHostnames` /
  `metadataIps` 两条列表，列表**整体替换**内置默认（内置仅作初始值），供非 AWS/GCP/Azure 云
  与自建部署按需维护；改策略只重建守卫、不重启监听。已知边界：仅拦工具发起的导航，页面内请求
  拦截（route 化 / WebSocket / DNS-rebinding）属后续里程碑（design 条目 de-005）。
- **GUI「浏览器」设置分区**（0.3.0）：DSH 设置对话框左侧新增独立分区，逐项即时编辑
  enabled / urlMode / 端口 / 令牌 / 截图目录 / registry 目录 / 云元数据端点列表
  （settings.section 注册；client 半区为手写 `__ModuleLoader__` bundle，无新增构建链）。
- **自更新/设计注册表三件套**：`browser_check_update`（只读查上游漂移）、
  `browser_design_show` / `browser_design_edit`（读 / 审批门控写 `design/registry.json`，写前
  备份、fail-closed）。
- **扩展端端口自动发现**（本地 1.0.8，2026-09-25）：扩展不再死守写死端口，按
  `[用户设置端口 → 上次命中端口 → 9777..9786]` 依次 `GET /api/status` 探测命中即用；
  桥换端口后扩展 2s 内自动跟随。改动与验收记录见 `NOTE.md` 末节。
  **注意**：宿主侧「端口被占 → 不拖垮 DSH 启动」的 fail-soft **尚未实现**——
  当前端口被占仍会让 `dsh web` 启动即退出（取证：`P0-探针取证-20260925.log`）。

## 配置

GUI：设置 →「浏览器」；等价 profile YAML（`cordis.patch.yml`）：

```yaml
- id: browser-bridge
  config:
    enabled: true
    urlMode: public            # public | intranet
    blockMetadata: true
    metadataHostnames: [metadata, metadata.google.internal, instance-data, instance-data.ec2.internal, metadata.azure.internal, metadata.tencentyun.com]
    metadataIps: [169.254.169.254, 100.100.100.200, fd00:ec2::254]
    registryDir: '<repo-dir>'            # 指向本仓库根（含 design/registry.json + upstream-baseline.json）；留空读包内 registry/
    # port: 9777, token: dsh-local, shotsDir: dsh-browser-shots
```

字段校验（违反即写入被拒并报错）：条目须能通过主机名归一化、≤253 字符、无协议/路径/空白/控制字符；
每列表 ≤64 条；token 非空；urlMode ∈ {public, intranet}。

## 本地构建与打包

```bash
cd packages/browser-unified-plugin
npm run build-pack        # tsc 编译 src -> lib/；client/client.js -> lib/client.js；npm pack 到包根
# 或： node scripts/build-pack.mjs     （--no-pack 只编译+拷贝 client）
```

产物：`dsh-browser-unified-0.7.4.tgz`。

## 安装

```bash
cd <dsh-profile-dir>                     # 你的 dsh web profile 目录
pnpm add ./dsh-browser-unified-0.7.4.tgz
# package.json:
#   dependencies:        "dsh-browser-unified": "file:dsh-browser-unified-0.7.4.tgz"
#                        "browser-unified-core": "file:<abs path to packages/browser-unified-core>"
#   dsh.profile.bundles: 加入 "dsh-browser-unified"（移除旧 @caob23/dsh-browser-control）
# 重启 dsh web 生效（宿主与 client 半区均需重启加载）。
```

## 浏览器扩展

- **来源**：上游 [caob23/dsh-browser-control](https://github.com/caob23/dsh-browser-control/releases) 1.0.7。
- **本地版**：`extension/` 就是当前装机版本（**1.0.8**）= 上游 1.0.7 + 端口自动发现补丁；
  补丁单独留档为 `extension-port-discovery-1.0.7.patch`（`patch -p1` 可复现，用于将来吸收上游新版）。
- **装载**：把 `extension/` 复制到加载目录（本机为 `D:\edge-extensions\dsh-browser-extension`），
  在 `edge://extensions` 点「重新加载」。**重载只能人手点**——插件自身的 URL 策略只放 http(s)，
  `edge://` 与 `chrome-extension://` 都取不到。
- **端口**：扩展自 1.0.8 起声明 `host_permissions: http://127.0.0.1/*, http://localhost/*`，
  仅用于 `GET /api/status` 探测；服务端不校验 Origin，WS 仍以 token 鉴权。
- **回滚**：改造前的 1.0.7 原样副本在本目录 `extension.bak-20260925/`。

## 许可与归属

- `LICENSE`：AGPL-3.0 全文。
- `NOTICE.md`：完整来源矩阵——caob23 `ws.ts`/`server.ts`/接线层（AGPL-3.0）收编并保留头部
  版权；url-policy/approval 为 MIT 上游语义蒸馏；自更新/设计工具/设置分区 client 半区为本仓撰写。
  分发或提供网络服务须遵守 AGPL-3.0 第 13 条；企业若需闭源商用请另洽 caob23 作者许可。
- 安装形态决策与上游 SHA 基线另见仓库根 `NOTICE.md` 与 `upstream-baseline.json`。
