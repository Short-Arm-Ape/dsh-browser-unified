# dsh-browser-unified (AGPL full edition)

Unified DeepSeek Harness browser-bridge plugin: the `@caob23/dsh-browser-control` wiring merged
with the unified URL policy, self-update / design-registry tools, and — since 0.3.0 — a GUI
Settings section. Uses the same DSH Browser Control extension and the same instance id /
settings namespace (`browser-bridge`) as the upstream plugin it replaces.

| 项 | 值 |
|---|---|
| 包名 | `dsh-browser-unified` |
| 版本 | 0.7.3 |
| 许可证 | **AGPL-3.0-only**（含 caob23 收编代码；归属与合规见 NOTICE.md） |
| 实例 id / 设置命名空间 | `browser-bridge`（与 @caob23 一致，便于迁移） |
| 提供 | 24 个 `browser_*` 驱动工具、`GuardedBridge` URL 策略守卫、自更新三件套、GUI「浏览器」设置分区 |

> 不含 caob23 派生代码、希望 MIT 许可的请用同仓库的 MIT 版 `dsh-browser-unified-mit`
> （`packages/browser-unified-mit`）——但它不带浏览器桥与 `browser_*` 驱动工具。

## 功能

- **浏览器驱动**：桥接 DSH Browser Control 扩展（CDP），27 个 `browser_*` 工具（含 `browser_wait` 等待原语，以及 2026-10-10 从同伴件 `dsh-browser-buddy` 合并进来的 `browser_tools` / `browser_frames` / `browser_frame_eval`）
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
    registryDir: '<repo-dir>'            # 指向本仓库根（含 design/registry.json + upstream-baseline.json）；留空读包内 registry/
    # port: 9777, token: dsh-local, shotsDir: dsh-browser-shots
```

字段校验（违反即写入被拒并报错）：条目须能通过主机名归一化、≤253 字符、无协议/路径/空白/控制字符；
每列表 ≤64 条；token 非空；urlMode ∈ {public, intranet}。

### 设置项细节

界面上每项只留一句，具体规矩在这里。

**云元数据端点拦截**：内置默认是 AWS / GCP / Azure 的 `169.254.169.254`、阿里云的
`100.100.100.200`、IPv6 的 `fd00:ec2::254`，以及 `metadata` / `metadata.google.internal` /
`instance-data` / `metadata.azure.internal` / `metadata.tencentyun.com` 等主机名。
两个列表是**整体替换**语义：改了就等于换成你给的那份，不是追加；清空表示不拦这类。
主机名支持 `*.suffix` 通配（`*.baidu.com` 拦全部子域），条目须通过归一化、≤253 字符、无协议/路径/空白。
关闭这一项表示接受页面访问实例元数据服务（例如自建 VPC 沙箱内确实需要）。

**访问控制**：外网 / 局域网 / 本机三个域各自可选 放行 / 需审批 / 拒绝。
需审批＝陌生主机弹一次批准并记住本次会话；拒绝＝一律拒绝；白名单主机在「需审批」下免批准。
「允许临时授权」关掉后该域不再弹批准，只能靠白名单放行。
受限态（无法请求审批时，如完全权限模式）另有一档 ask 策略：忽略＝ask 失效、黑白名单等其余规则照常；
放行＝连黑白名单一并忽略（云元数据、内嵌凭据、DSH 控制页拦截、路由档这些红线仍生效）；禁止＝直接拒绝。

**工具面分层**：开启后只把常驻白名单与「已展开组」的工具交给模型，其余组对模型不可见，
需要时让模型调 `browser_tools enable <组>`。组名：`interact`（点击/输入/按键/滚动）、
`debug`（求值/日志/网络/截图/PDF）、`session`（标签页/导航）、`frames`（iframe）、`registry`（设计注册表与问题登记簿）。

**自动拉起浏览器**：两条路共用同一套目标配置（浏览器可执行文件 + profile）。
「断线自动拉起」＝扩展断开超过容忍秒数后拉起；「模型调用时自动拉起」＝任何 `browser_*` 调用发现扩展未连接时，
先唤醒、等它连上再执行本次调用（等待上限可配）。前置条件是目标 profile 里已装扩展；
或用「临时干净实例 + 未打包扩展目录」的免 profile 方式。默认都关。

**允许访问本 DSH 页面**：开启后模型能打开并操作本机 DSH 控制页，其中包含会话列表与审批界面；
关闭时一律拒绝，且关闭即时生效、开启需二次确认。开启后仍受云元数据、内嵌凭据、黑名单等红线约束。

**检查更新**：只读，与仓库最新发布比一次版本号，不安装任何东西。本机版本是预览版
（`x.y.z-beta.n`）时允许与预览版比较；本机版本高于最新发布时显示「已领先」而不是「有新版本」。

## 本地构建与打包

```bash
cd packages/browser-unified-plugin
npm run build-pack        # tsc 编译 src -> lib/；client/client.js -> lib/client.js；npm pack 到包根
# 或： node scripts/build-pack.mjs     （--no-pack 只编译+拷贝 client）
```

产物：`dsh-browser-unified-0.7.3.tgz`。

## 安装

```bash
cd <dsh-profile-dir>                     # 你的 dsh web profile 目录
pnpm add ./dsh-browser-unified-0.7.3.tgz
# package.json:
#   dependencies:        "dsh-browser-unified": "file:dsh-browser-unified-0.7.3.tgz"
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
