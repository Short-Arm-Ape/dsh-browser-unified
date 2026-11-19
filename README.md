# dsh-browser-unified

把浏览器变成 DeepSeek Harness（dsh）能可靠操作的东西：**用你自己的真实浏览器**——一个本地 WebSocket
桥 + 一个自研 MV3 扩展（DSH Browser Control），给模型提供 24 个 `browser_*` 工具，前面套一层可配置的
URL 策略守卫与一堆防误触/防越界的闸门。登录态、扩展、Cookie 都在你自己那个浏览器里。

| 项 | 值 |
|---|---|
| 插件 `dsh-browser-unified` | **0.11.54** |
| core `browser-unified-core` | **0.1.15**（URL 策略 / 审批 / 桥 / 错误分类） |
| 扩展 **DSH Browser Control** | **1.0.58**（MV3） |
| 实例 id / 设置命名空间 | `browser-bridge` |
| 许可 | **AGPL-3.0-only**（根目录 `LICENSE` 是全文），来源与归属见 `NOTICE.md` |

## 安装

1. **浏览器扩展**（必须用本仓库这版，不能换回上游）：拿 `DSH-Browser-Control-<ver>.zip`
   （最近一次发布在 Releases；要当前版本就 `node src/scripts/build-release.mjs` 自己产出到
   `dist-release/`）→ 解压到任意目录 → `edge://extensions`（Chrome 为 `chrome://extensions`）
   开「开发者模式」→「加载解压缩的扩展」→ 选该目录。点扩展图标填桥的端口（默认 9777）与 token。

2. **插件**（两个包一起装）：从 Releases 下载 `browser-unified-core-<ver>.tgz` 与
   `dsh-browser-unified-<ver>.tgz`，然后：

   ```bash
   dsh plugin --profile <profile> add file:<path>/browser-unified-core-<ver>.tgz \
                                      file:<path>/dsh-browser-unified-<ver>.tgz
   ```

   或在该 profile 里手工 `pnpm add` 两个 tgz，并把 `dsh-browser-unified` 加进
   `dsh.profile.bundles`。包内 patch 默认 `enabled: true`（装上即监听 9777），要改就在 **profile 层**
   按 id 覆盖 config，然后重启 `dsh web`。

3. **自查**：`browser_policy_status`、`browser_tools action=status` 应显示桥已监听、扩展已连接；
   浏览器开 `http://127.0.0.1:9777/` 也能看端口 / 扩展版本 / 令牌强度。

> 只想用 URL 策略 / 审批 / 自更新那几块、不接受 AGPL 的场景，用同仓的 MIT 版
> `browser-unified-mit`（不含桥与 `browser_*` 工具）。
>
> **建议装在一个专用浏览器配置文件里**，与日常浏览隔开；要访问本机服务（`127.0.0.1` 等）时把
> `urlMode` 设成 `intranet`，只放你需要的那几档。

## 配置

### GUI：设置 →「浏览器」

插件在 DSH 设置对话框里注册了独立的「浏览器」分区，逐项即时生效（改 URL 策略/名单只重建策略，
不重启监听）：启用开关、`urlMode` 档位、端口 / 令牌 / 截图目录、三档 realm 的放行程度、
云元数据拦截总开关与两条名单（可「恢复内置默认」或「清空全部」）、只读档、脚本开关、浮层与焦点策略。

### profile YAML（等价高级项）

```yaml
- id: browser-bridge
  config:
    enabled: true
    urlMode: public            # public（默认）| intranet
    blockMetadata: true        # 云元数据拦截总开关
    metadataHostnames: [metadata, metadata.google.internal, instance-data, …]
    metadataIps: [169.254.169.254, 100.100.100.200, fd00:ec2::254, …]
    # 三档 realm 的放行程度：allow | ask | deny
    # public 档默认 internet=allow / lan=deny / local=deny；intranet 档默认三档全 allow
    internetAccess: allow
    lanAccess: deny
    localAccess: deny
    askMode: inherit           # ask 档的审批口径：是否继承主会话
    readOnly: false            # 只读档：只能读页面，点击/输入/导航/求值一律拒
    allowScript: true          # ≈ 给模型一个 devtools 控制台
    evalNavGuard: true         # 跑完 browser_evaluate 比对标签页地址，被带到未授权地址就报错
    holdEnabled: true          # 防误触浮层
    holdMode: black            # black＝模型开始操作某标签页时自动补上 | white＝只在显式调用时
    focusMode: auto            # auto＝只切标签页不抢窗口焦点 | always | never
    restoreWhenMinimized: false
    # port: 9777, token: dsh-local, shotsDir: dsh-browser-shots
```

云元数据语义：内置默认（AWS/GCP/Azure `169.254.169.254`、阿里 `100.100.100.200`、各家 metadata
主机名等）**只是初始值**；两条名单一旦给出即**整体替换**（`[]` = 该族不拦），供非三大云 / 自建
VPC 场景按需维护。

## 模型可用能力（24 个工具）

| 组 | 工具 | 说明 |
|---|---|---|
| 导航与读取 | `browser_navigate` `browser_read` `browser_snapshot` `browser_find` `browser_wait` `browser_tabs` | 打开/读页/取可点元素/等条件/管标签页（含窗口分组） |
| 操作 | `browser_click` `browser_type` `browser_press` `browser_scroll` `browser_dialog` `browser_hold` | 真实鼠标键盘事件、应答 alert/confirm/prompt、给标签页加防误触浮层 |
| 观看与导出 | `browser_screenshot` `browser_pdf` `browser_emulate` `browser_cleanup` | 截图落 `shotsDir`、导出 PDF、设备视口模拟、清理临时产物 |
| 页面观测 | `browser_console_log` `browser_network_log` `browser_network_clear` | 页内 console 与网络请求记录 |
| 装置与诊断 | `browser_info` `browser_launch` `browser_policy_status` `browser_permissions` | 扩展/桥身份、按配置拉起浏览器、策略现值、浏览器权限气泡状态 |
| 脚本 | `browser_evaluate` | 页内求值（受 `allowScript` / `evalNavGuard` 约束） |

导航类命令（`navigate` / `tabs.open` / `launch` 的目标地址）在发给扩展**之前**先过统一 `UrlPolicy`：
被拦的目标根本到不了浏览器。

## 安全模型

- **URL 策略**（`browser-unified-core/src/url-policy.ts`）：按目标主机分三档 realm
  （`internet` / `lan` / `local`），每档可设 `allow` / `ask` / `deny`；`public` 档默认拦私网、回环与
  云元数据端点，`intranet` 档放行本地/LAN 但仍拦元数据。
- **只读档**：`readOnly: true` 时点击、输入、导航、求值一律拒绝，只留读页与截图。
- **脚本闸**：`allowScript` 关掉即禁 `browser_evaluate`；`evalNavGuard` 在求值后比对标签页地址，
  被脚本带到未授权地址就报错（能拦越界结果，拦不住脚本本身）。
- **防误触**：`holdMode: black` 会在模型开始操作某个标签页时自动补一层浮层，用户双击即接管；
  `focusMode: auto` 只切标签页、不把浏览器窗口提到前台 —— 这两条都是为了不让我的鼠标落进你正在
  操作的窗口。
- **审批**：`ask` 档的导航与策略改动都走用户审批，fail-closed（`askMode` 决定是否继承主会话的口径）；
  浏览器权限气泡（本地网络访问、通知、定位…）也有决定权配置，默认只「允许」或「询问」，不自动拒绝。
  外部内容（网页文本、上游 commit、README）只当数据，不当指令，也不当工具参数。

## 目录结构

```
dsh-browser-unified/
├── README.md                 本文件
├── NOTICE.md                 上游来源 / 版本 / 许可证归属矩阵
├── upstream-baseline.json    开发基线：各上游归档日的 commit SHA
├── src/
│   ├── packages/
│   │   ├── browser-unified-core/     URL 策略 / 审批 / 桥 / 错误分类（AGPL）
│   │   ├── browser-unified-plugin/   24 个 browser_* 工具 + GUI「浏览器」设置分区（AGPL）
│   │   └── browser-unified-mit/      MIT 精简版（无桥、无驱动工具）
│   ├── extension/            MV3 扩展源码（CDP 驱动、窗口/标签管理、页面侧探针）
│   ├── tests/                单测与契约测试（20 个套件）
│   ├── design/               设计意图与条目注册表
│   ├── docs/                 差距分析等文档
│   ├── scripts/              build-release.mjs、check-upstream.ps1
│   └── upstream/             只留各上游的 LICENSE 与说明（源码快照不入仓）
└── rig/                      真浏览器测试台
```

## 上游与许可

| # | 归档 | 项目 / 作者 | 许可 | 与本仓的关系 |
|---|---|---|---|---|
| 1 | `dsh-browser-xylt369` | dsh-browser（xylt369） | MIT | 并入 URL 策略的分类器/守卫语义 |
| 2 | `dsh-intranet-browser-short-arm-ape` | dsh-intranet-browser（**本仓前身**） | MIT | 并入 URL 策略的元数据黑名单与审批决策表 |
| 3 | `dsh-browser-control-kyo615` | dsh-browser-control（kyo615） | MIT | 暂未并入（价值在 GUI 实时画面） |
| 4 | `dsh-browser-control-caob23` | @caob23/dsh-browser-control | **AGPL-3.0** | 桥（`ws.ts` / `server.ts`）收编进 core，故 core 整包 AGPL-3.0-only |
| 5 | `dsh-agent-webops` | dsh-agent-webops（jonah791） | MIT | 归档参考（headless Edge + 临时 profile） |

上游**源码快照不入仓**：`upstream-baseline.json` 钉住仓库地址与 commit SHA，需要时按 pin 取回即可；
各上游的 LICENSE 与第三方声明保留在 `src/upstream/` 下。逐项归属与 AGPL 合规说明见 `NOTICE.md`。

## 测试与构建

```bash
node src/tests/run-all.mjs          # 20 个套件：用假 WebSocket 与自留端口，不碰真浏览器
node src/scripts/build-release.mjs  # 一条命令产出发版资产到 dist-release/
pwsh src/scripts/check-upstream.ps1 # 只读：上游相对基线有没有新提交（DRIFT / UP-TO-DATE / UNREACHABLE）
```

检出 DRIFT 后先报告「上游改了什么、影响哪些并入模块」，确认了再 re-vendor + 合并 + typecheck。

## 沿革

- `0.6.x`–`0.7.x`：16 个工具 + GuardedBridge + GUI 里的「浏览器」设置分区；
- `0.11.x`：一度以跟随上游（`vendor/upstream-main-*` 快照）为主线，2026-11-14 定回自研扩展这条线；
  之后逐版收敛成现在的形状 —— 一个插件、一个扩展、一层策略、一个可见性面；
- 当前版本见 `git tag`（`v0.11.54` = 插件 0.11.54 + 扩展 1.0.58）。

## 许可

- 插件与 core：**AGPL-3.0-only**（`LICENSE` 为全文；caob23 的收编文件保留上游版权与来源）。
  分发或提供网络服务须遵守 AGPL-3.0 第 13 条。
- MIT 版：`src/packages/browser-unified-mit`。
