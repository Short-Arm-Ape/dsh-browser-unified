# dsh-browser-unified (AGPL full edition)

Unified DeepSeek Harness browser-bridge plugin: the `@caob23/dsh-browser-control` wiring merged
with the unified URL policy, self-update / design-registry tools, and — since 0.3.0 — a GUI
Settings section. Uses the same DSH Browser Control extension and the same instance id /
settings namespace (`browser-bridge`) as the upstream plugin it replaces.

| 项 | 值 |
|---|---|
| 包名 | `dsh-browser-unified` |
| 版本 | 0.3.0 |
| 许可证 | **AGPL-3.0-only**（含 caob23 收编代码；归属与合规见 NOTICE.md） |
| 实例 id / 设置命名空间 | `browser-bridge`（与 @caob23 一致，便于迁移） |
| 提供 | 16 个 `browser_*` 驱动工具、`GuardedBridge` URL 策略守卫、自更新三件套、GUI「浏览器」设置分区 |

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
    registryDir: 'F:\path\to\dsh-browser-unified'   # 留空读包内 registry/
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

产物：`dsh-browser-unified-0.3.0.tgz`。

## 安装

```bash
cd <dsh-profile-dir>                     # 例如 F:\dsh-data\profiles\web
pnpm add ./dsh-browser-unified-0.3.0.tgz
# package.json:
#   dependencies:        "dsh-browser-unified": "file:dsh-browser-unified-0.3.0.tgz"
#                        "browser-unified-core": "file:<abs path to packages/browser-unified-core>"
#   dsh.profile.bundles: 加入 "dsh-browser-unified"（移除旧 @caob23/dsh-browser-control）
# 重启 dsh web 生效（宿主与 client 半区均需重启加载）；浏览器扩展（DSH Browser Control）不变。
```

Chrome 扩展请前往上游仓库 [caob23/dsh-browser-control](https://github.com/caob23/dsh-browser-control/releases) 下载。

## 许可与归属

- `LICENSE`：AGPL-3.0 全文。
- `NOTICE.md`：完整来源矩阵——caob23 `ws.ts`/`server.ts`/接线层（AGPL-3.0）收编并保留头部
  版权；url-policy/approval 为 MIT 上游语义蒸馏；自更新/设计工具/设置分区 client 半区为本仓撰写。
  分发或提供网络服务须遵守 AGPL-3.0 第 13 条；企业若需闭源商用请另洽 caob23 作者许可。
- 安装形态决策与上游 SHA 基线另见仓库根 `NOTICE.md` 与 `upstream-baseline.json`。
