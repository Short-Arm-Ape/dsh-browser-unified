# dsh-browser-unified

四条 DeepSeek Harness（dsh）浏览器插件路线合一的可安装插件：**用你自己的真实浏览器**
（DSH Browser Control 扩展 + 本地桥）给模型提供 16 个 `browser_*` 驱动工具，前面统一加一层
可配置的 URL 策略守卫，另附「上游自检 / 设计注册表」工具三件套与 GUI 设置分区。

> 仓库 = `upstream/`（四个上游原样归档，各自带 LICENSE）+ `packages/`（合并产物）。
> 合并核心与插件壳整包以 **AGPL-3.0-only** 发布（含 caob23 桥收编代码，归属矩阵见 `NOTICE.md`）。

## 安装

1. **浏览器扩展**：装 DSH Browser Control（Chrome/Edge 请从上游
   [caob23/dsh-browser-control](https://github.com/caob23/dsh-browser-control/releases) 下载，与
   @caob23 版同扩展、同实例 id，无需换扩展）。
2. **插件**（在 dsh profile 目录，如 `F:\dsh-data\profiles\web`）：

   ```bash
   pnpm add ./dsh-browser-unified-0.3.0.tgz        # 或 pnpm add dsh-browser-unified@file:<path>
   # package.json:
   #   dependencies:        "dsh-browser-unified": "file:dsh-browser-unified-0.3.0.tgz"
   #                        "browser-unified-core": "file:<abs path to packages/browser-unified-core>"
   #   dsh.profile.bundles: 加入 "dsh-browser-unified"
   ```

   重启 dsh web 后生效（宿主新代码与 GUI client 半区都需要重启加载）。

> 想要 MIT 许可、不含 caob23 派生代码的版本，用同仓库的 MIT 版 `dsh-browser-unified-mit`
> （不带浏览器桥与 `browser_*` 工具，仅 URL 策略 / 审批 / 自更新等模块）。
>
> **建议（专用配置文件）**：把 DSH Browser Control 扩展装在**专用的浏览器配置文件**里，与日常
> 浏览隔离；需要访问本机服务（如 127.0.0.1）时把 urlMode 设为 `intranet`。跨 profile 自动拉起与
> “无痕式临时干净配置”属拟议能力（design `de-013`），尚未实现。

## 配置与设置界面

### GUI：设置 →「浏览器」（0.3.0+）

插件以 `settings.section` 在 DSH 设置对话框注册了独立的 **「浏览器」** 分区（形如
better-sidebar 的「侧边卡片」），逐项即时生效（改 URL 策略 / 云元数据列表只重建策略、不重启监听）：

| 项 | 说明 |
|---|---|
| 启用浏览器桥 | 关闭则工具仍挂载，调用时报如何开启 |
| URL 策略档位 | `public`（默认，拦私网/回环/云元数据）／`intranet`（放行本地/LAN，仍拦云元数据） |
| 端口 / 令牌 / 截图目录 / registry 目录 | 监听与路径（改动重启本地桥） |
| 云元数据端点拦截 | 主开关 + **拦截主机名列表** + **拦截 IP 列表**（整体替换内置默认；GUI 可「恢复内置默认」或「清空全部」） |

### profile YAML（等价高级项，`cordis.patch.yml`）

```yaml
- id: browser-bridge
  config:
    enabled: true
    urlMode: public            # public | intranet
    blockMetadata: true        # 云元数据拦截总开关
    metadataHostnames: [metadata, metadata.google.internal, instance-data, instance-data.ec2.internal, metadata.azure.internal, metadata.tencentyun.com]
    metadataIps: [169.254.169.254, 100.100.100.200, fd00:ec2::254]
    registryDir: 'F:\path\to\dsh-browser-unified'   # 含 design/registry.json + upstream-baseline.json；留空读包内 registry/
    # port: 9777, token: dsh-local, shotsDir: dsh-browser-shots（默认即可）
```

云元数据端点语义：内置默认（AWS/GCP/Azure `169.254.169.254`、阿里 `100.100.100.200`、腾讯/阿里
metadata hostname 等）**只是初始值**；两条列表一旦给出即整体替换（`[]` = 该族不拦），用于非
三大云 / 自建 VPC 等场景的按需维护。`public` 档还有一条固定的默认主机黑名单（localhost /
metadata 等）作为安全网，不受上述列表影响。

## 模型可用能力

| 工具 | 说明 |
|---|---|
| `browser_navigate / read / snapshot / click / type / press / scroll / tabs / evaluate` | 驱动真实浏览器（含登录态） |
| `browser_screenshot / pdf / emulate` | 截图（落盘 shotsDir）、导出 PDF、设备视口模拟 |
| `browser_cleanup` | 清理截图与 `__` 前缀临时产物 |
| `browser_console_log / network_log / network_clear` | 页内 console / 网络请求观测 |
| `browser_check_update` | 只读：上游相对开发基线是否有新提交（DRIFT / UP-TO-DATE / UNREACHABLE） |
| `browser_design_show / browser_design_edit` | 读 / 受控改 `design/registry.json`（写必经审批，自动 `.bak`） |

导航类命令（`nav` / `tabs.open`）在发给扩展**之前**先过统一 `UrlPolicy`；被拦目标根本到不了浏览器。

## 安全模型

- **URL 策略**（`src/url-policy.ts`，MIT 上游语义蒸馏）：public 档拦私网/回环/云元数据并做
  resolve-then-validate DNS 复核；intranet 档有意放行本地/LAN，只保留元数据端点黑名单与用户黑名单。
- **鉴权**：写入类操作（`browser_design_edit`、基线推进、源码变更）一律用户审批，fail-closed；
  外部内容（上游 commit / README / 网页文本）只作数据、绝不充当指令或工具参数。
- **已知边界（未实现里程碑）**：策略只拦“工具发起的导航”；页面自身 XHR / 重定向 / iframe /
  WebSocket / DNS-rebinding 需扩展端逐请求拦截（design `de-005`）；`browser_evaluate` 尚无
  `allowEval` 门控（`de-006`）；无 GUI 实时画面（`de-007`）。设计注册表见 `design/registry.json`。

## 目录结构

```
dsh-browser-unified/
├── README.md                    本文件
├── NOTICE.md                    上游来源/版本/许可证归属矩阵
├── upstream-baseline.json       开发基线：四上游归档日 commit SHA
├── design/                      设计意图唯一书面出处
│   ├── README.md                工具契约 / 威胁模型与鉴权 / 条目状态机
│   └── registry.json            impactRules（单一事实源）/ tooling / authz / designEntries
├── scripts/check-upstream.ps1   上游自检（只读）
├── upstream/                    四上游原样快照（各自 LICENSE）
└── packages/
    ├── browser-unified-core/    合并核心（AGPL）：url-policy / approval / bridge(收编) / guarded-bridge / self-update
    ├── browser-unified-plugin/  dsh 插件壳（AGPL）：16 个 browser_* 工具 + 自更新三件套 + GUI「浏览器」设置分区
    └── browser-unified-mit/     MIT 精简版（无桥、无驱动工具）
```

## 上游与许可

| 归档 | 路线 | 浏览器 | 安全模型 | 并入 |
|---|---|---|---|---|
| `dsh-browser-xylt369` | 类型化 seam + Playwright | 插件另起 Edge | 四层 URL 守卫 | ✅ url-policy(public)/approval |
| `dsh-intranet-browser-short-arm-ape` | 上者内网分支 | 独立实例+profile | 元数据黑名单+逐次审批 | ✅ url-policy(intranet)/approval |
| `dsh-browser-control-kyo615` | @playwright/mcp 子进程 | 另起 Chrome | 无 URL 校验 | ➖ 仅归档（live-view 候选） |
| `dsh-browser-control-caob23` | 扩展+本地 WS 桥(CDP) | **用户真实浏览器** | 无 URL 校验（本插件已补） | ✅ bridge + GuardedBridge |

- **构建 / 验证**：`packages/browser-unified-core`、`browser-unified-plugin`、`browser-unified-mit`
  各自 `npm run typecheck` / `npm run build`；插件用 `node scripts/build-pack.mjs`（tsc→lib，
  client/client.js→lib/client.js，npm pack 到包根）。产物 `dsh-browser-unified-0.3.0.tgz`。
- **上游自检**：`pwsh scripts/check-upstream.ps1 [-UpstreamId <id>] [-UpdateBaseline]`。检出
  DRIFT 后**必须先向你报告**“上游改了什么、影响哪些合并模块”，你确认后 agent 才 re-vendor +
  合并 + typecheck；`-UpdateBaseline` 只推进基线 SHA。改动会写 `design/registry.json` 条目。
- 安全红线：本机 git 缺 CA 时脚本内置 `-c http.sslBackend=openssl -c http.sslVerify=false`
  （只读参数）；外部文本不得当指令执行。

## 与上游功能差距

（0.3.0 之后与四上游逐项对比的差距清单：页面级请求拦截、allowEval 门控、GUI 实时画面、
stealth / web-permission 授权 UI 等未实现项，见 `docs/gap-analysis.md`，条目状态在
`design/registry.json`。）详见对话产出的差距报告。

## 许可

- 合并核心与插件壳：**AGPL-3.0-only**（MIT 逻辑并入 AGPL 在法理上允许；caob23 源码行保留头部
  版权与来源，`NOTICE.md` 为完整归属矩阵）。分发 / 提供网络服务须遵守 AGPL-3.0 第 13 条。
- MIT 版：`packages/browser-unified-mit`。
