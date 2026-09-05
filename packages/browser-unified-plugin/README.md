# dsh-browser-unified (AGPL full edition)

Unified DeepSeek Harness browser-bridge plugin: the `@caob23/dsh-browser-control`
wiring merged with the unified URL policy, plus self-update / design-registry
tools. Uses the same DSH Browser Control extension and the same instance id /
settings namespace as the upstream plugin it replaces.

| 项 | 值 |
|---|---|
| 包名 | `dsh-browser-unified` |
| 版本 | 0.2.0 |
| 许可证 | **AGPL-3.0-only**（含 caob23 收编代码；归属与合规见 NOTICE.md） |
| 实例 id / 设置命名空间 | `browser-bridge`（与 @caob23 一致，便于迁移） |
| 提供 | 16 个 `browser_*` 驱动工具、`GuardedBridge` URL 策略守卫、`browser_check_update` / `browser_design_show` / `browser_design_edit` |

> 不含 caob23 派生代码、希望 MIT 许可的请用同仓库的 MIT 版
> `dsh-browser-unified-mit`（`packages/browser-unified-mit`）——但它不带浏览器桥与
> `browser_*` 驱动工具。

## 功能

- **浏览器驱动**：桥接 DSH Browser Control 扩展（CDP），16 个 `browser_*` 工具
  （navigate/read/snapshot/click/type/press/scroll/tabs/evaluate/screenshot/cleanup/
  console_log/network_log/network_clear/pdf/emulate）。
- **URL 策略守卫（GuardedBridge）**：`nav` / `tabs.open` 先过统一 `UrlPolicy`
  再发给扩展——`urlMode: public`（默认）拦私网/回环/云元数据目标；`urlMode: intranet`
  放行本地/LAN 但仍拦元数据端点。已知边界：仅拦工具发起的导航，页面内请求拦截
  （route 化 / WebSocket / DNS-rebinding）属后续里程碑（设计条目 de-005）。
- **自更新/设计注册表三件套**：检查上流提交、读/改 `design/registry.json`
  （写走用户审批，fail-closed，自动 `.bak`）。

## 配置（profile `cordis.patch.yml`）

```yaml
- id: browser-bridge
  config:
    enabled: true          # 关闭则工具仍在、调用时报如何开启
    urlMode: public        # public | intranet
    registryDir: 'F:\path\to\dsh-browser-unified'  # 含 design/registry.json + upstream-baseline.json；缺省读包内 registry/
    # port: 9777, token: dsh-local, shotsDir: dsh-browser-shots（默认即可）
```

## 本地构建与打包（内含脚本）

```bash
cd packages/browser-unified-plugin
npm run build-pack        # 依赖检查 -> tsc 编译到 lib/ -> npm pack（缓存落在包内 .npm-cache）
# 或： node scripts/build-pack.mjs     （--no-pack 只编译）
```

产物：`dsh-browser-unified-0.2.0.tgz`。

## 安装

```bash
cd <dsh-profile-dir>                     # 例如 F:\dsh-data\profiles\web
pnpm add ./dsh-browser-unified-0.2.0.tgz
# package.json:
#   dependencies:        "dsh-browser-unified": "file:./dsh-browser-unified-0.2.0.tgz"
#                        "browser-unified-core": "file:<abs path to packages/browser-unified-core>"
#   dsh.profile.bundles: 加入 "dsh-browser-unified"（移除旧 @caob23/dsh-browser-control）
# 重启 dsh web 生效；浏览器扩展（DSH Browser Control）不变。
```

## 许可与归属

- `LICENSE`：AGPL-3.0 全文。
- `NOTICE.md`：完整来源矩阵——caob23 `ws.ts`/`server.ts`/接线层（AGPL-3.0）收编并保留
  头部版权；url-policy/approval 为 MIT 上游语义蒸馏；自更新/设计工具为本仓撰写。
  分发或提供网络服务须遵守 AGPL-3.0 第 13 条；企业若需闭源商用请另洽 caob23 作者许可。
- 安装形态决策与上游 SHA 基线另见仓库根 `NOTICE.md` 与 `upstream-baseline.json`。
