# dsh-browser-unified 0.11.22 发布说明

> 三段上游欠账吸收完毕（无冲突项 → 语义冲突项 → 扩展侧四件）＋ 两个自研缺陷修复 ＋ 设置页改动反馈。
> 本版**不含**新工具注册表以外的行为变更；上游独有面至此**清零**，re-vendor 明确不做。

## 版本

| 包 | 版本 | 说明 |
|---|---|---|
| `dsh-browser-unified` | **0.11.22** | 插件壳（30 个 `browser_*` 工具） |
| `browser-unified-core` | **0.1.6** | 合并核心（URL 策略 / 审批 / 收编桥 / **结构化错误契约**，AGPL-3.0-only） |
| `dsh-browser-unified-mit` | **0.1.1** | MIT 版（不含桥与驱动工具） |
| 浏览器扩展 `extension/` | **1.0.21** | MV3（新增 `tabGroups` 权限） |

> ⚠️ **core 与插件必须同版升级**：插件 `import { classify } from 'browser-unified-core'`，
> 而 `errors.ts`／`classify` 是本版新进 core 的（0.1.5 没有）—— 只换插件不换 core 会在 import 阶段就挂。

## 一、上游欠账（三段，全部落定）

### 第 1 段 · 无设计冲突项（照搬）

- **结构化错误契约**（移植上游 v1.0.13 `errors.ts`）：错误码 / `effectState`（`not_started` / `unknown`）/
  `hint` 三段式；`classify()` 在桥的**两个收口处**（无扩展、命令异常）统一归类；新 `errorResponse()`
  把码映射成 HTTP 状态（503/403/504/502）并原样带上契约文本 —— 宿主只把 `message` 展示给模型，
  所以契约必须写在文案里（否则模型看不到码与重试语义）。
- **帧协议协商**：桥 `BRIDGE_PROTOCOL_VERSION = 1`，扩展在 hello 里声明 `protocol`；状态面新增
  `bridgeProtocol` / `extensionProtocol` / `protocolCompatible` / `protocolNote`。
- **`browser_read` 文本窗口**：`offset` / `limit`，回包带 `offset` / `totalChars` 与
  「chars a-b of N；call again with offset=」的接续指引（上限 20,000 字符，取代旧的 120k 硬截断）。
- **新工具**：`browser_find`（页内查找）、`browser_dialog`（JS 对话框策略）、`browser_info`
  （桥/扩展/配对/协议一屏），全部走人话渲染而不是 `JSON.stringify`。

### 第 2 段 · 语义冲突项（两个都留）

- **`browser_wait` 保留自研版**：上游 v1.0.9 也加了一个（`render` 直接 `JSON.stringify(value)`），
  我们有 selector/text/fn 三选一、明确的超时与中止语义、`siteUnreachable` 兜底 —— **不换**，
  只把上游描述里「SPA 路由与懒渲染：`browser_navigate` 不会等它们」并进我们的描述。
- **`browser_snapshot` 增 `mode:"ax"`（可选）**：默认仍是我们的 DOM 判据（含 `why=cursor` 的
  div 化 SPA 识别）；`mode:"ax"` 走 Chrome 无障碍树（`role` + 可访问名），**ref 契约不变** ——
  AX 模式同样把 `data-dsh-ref` 打到真实 DOM 节点上（`DOM.resolveNode` + `Runtime.callFunctionOn`），
  所以 `browser_click ref=…` 在两种模式下都照旧可用。页面给不出 a11y 树时**落回 DOM 并带原因**。
  另采纳上游 v1.0.15 的教训：**旧扩展会静默忽略 `mode:"ax"`**，插件自己把降级说出来
  （抽成纯函数 `snapshotModeOf(rawMode, rawFallback, wantAx)`，可单测）。

### 第 3 段 · 扩展侧四件（决定：手工挑，不 re-vendor）

先把净差量出来再决定：命令表对比 = 上游多 `tabs.group`/`tabs.ungroup`/`tabs.closeMany`，我们多
`content.debug`/`window.ensure`；函数表对比 = 上游独有的只有 6 个归组函数 + `parseKeySpec` +
`cmdTabsCloseMany` + 四个通用小助手，我们独有的是端口自动发现（3）、frames（2）、`content.debug`、
`window.ensure`（3）、弹窗策略。**结论：手工挑** —— ① 本段补完后上游独有面几乎清零，re-vendor
换不来新能力；② re-vendor 会把我们 8 处独有改动全变成"要重新打补丁"的对象；③ 我们这条线每步都有
真机取证，re-vendor 等于把已验证的基线推倒重来。需要处**明确保留**我们的差异
（`host_permissions`、端口发现、frames、`cmdTabsOpen` 的无窗口自愈分支）。

| 件 | 内容 |
|---|---|
| 协议声明 | hello 带 `protocol = 1`（与 core 0.1.5 起的桥协商配对） |
| `parseKeySpec` | `key:"Ctrl+A"` 与 `key:"a"` + `modifiers:["ctrl"]` 等价；**未知键名/未知修饰键明确报错**（以前静默发 `undefined` keyCode，Chrome 什么都不做却回成功） |
| 标签归组 | manifest 增 `tabGroups`；agent 开的标签默认进当前窗口的 `DSH` 蓝色组；`tabs.group`/`tabs.ungroup`；退避 50/150/400ms 最多 4 枪；`groupId` 只存内存、按标题反查重建；**`ungroup` 只解除归属、不关任何标签页**。未为它加 `host_permissions` |
| `tabs.closeMany` | **我们提给上游的 PR #11 搬回自己的线**：一条命令、一份超时预算、逐 id 交代（`closed` / `alreadyGone` / `failed`）；插件侧批量关闭改为「匹配在我们侧、关闭走 `tabs.closeMany`」 |

## 二、自研缺陷修复

### `bi-036` 导航遇到「永远加载中」的页面会挂住

`cmdNav` 的落地探针没有预算：文档卡在 commit 之前时 CDP **不回** `Runtime.evaluate`，整条命令被拖到
桥的 60s 兜底。修法：探针包 `withBudget(promise, 2500, null)`（移植上游同名助手，其注释写着
「无预算的探针让 nav 40 多秒没回答」—— 与本机复现一致）。
**真机前后对照**（真 Edge + `/hang` 页面）：修前 25s 无任何回答 → 修后 **5.7s 返回**，且如实报
`loadPending: true` + `pendingUrl`。

### `bi-038` 运行中改设置一律不生效（要重启）

宿主对「只动 volatile 字段」的配置变更是**原地提交**：`@deepseek-ai/cordis-plugin-loader` 的
`_commitVolatile()` 把新值写进运行中的 volatile 引用，然后 `emit('loader/volatile-update', paths)`，
**不 dispose、不重跑 apply** —— 这正是 `.volatile()` 的语义（"别重载我，我自己处理"）。
我们既在 `apply()` 里把配置快照死、又没订阅该事件 ⇒ 所有设置改动被静默吞掉。
修法：`validate()` 抽出（热更新走同一条判据，不许绕过）＋ 订阅 `loader/volatile-update` →
用**原始** config 重新 `unwrapVolatile` → `resolved = next` → `controller.reconcile(next)`；
buddy 增 `refreshConfig(raw)` 重建 `cfg` / `enabledGroups` / `resident`。非法新值只 warn 并继续用
上一份好配置。**0.11.22 起：改设置即时生效，不需要重启**（只有更换插件包版本需要）。

## 三、设置页：改动反馈改成"胶囊"

页面不再写「保存即时生效」这类自夸文案，改成**行为反馈**：写完轮询快照复验，
只有「新值已落盘且与写之前不同」才弹绿色 **「配置已保存」1 秒**；选了个一模一样的值判为 noop
（不打扰）；1.5s 内没看到新值弹琥珀 **「配置尚未生效（字段）」**；写失败弹红「保存失败：原因」。
多条胶囊共用一个元素（新的一来先清旧定时器）⇒ **后弹覆盖前弹**。轮询有硬上界（1.5s，
⌈1500/60⌉+1 = 26 步）且只在 `wait` 分支重排，卸载后不再 `setState`。
另：主机列表（`allowHosts` / `denyHosts`）写入前按插件同一条规则自查，格式不对只在本地弹琥珀。

## 四、验证

| 层 | 结果 |
|---|---|
| 单元 / 渲染（10 套） | **287 项全绿**（新增 `config-hot-update` 11 项、`error-contract` 24 项、`render-settings-pages` 38 项） |
| 真机契约 ①（`/press` 等页面） | `seg1-contract.mjs` **10/10** |
| 真机契约 ②（snapshot AX） | `seg2-contract.mjs` **12/12** —— ax 回 `mode:'ax'` 且带 role；`[data-dsh-ref]` 属性数 == items 数；**按 ax 给的 ref 点得动**（表单 `submit=1`） |
| 真机契约 ③（扩展侧四件） | `seg3-contract.mjs` **16/16** —— 归组/拆组（标签页数不变）、`Ctrl+A` 页面收到 `ctrlKey=true`、未知键报错、`closeMany requested=3 → closed=2 + alreadyGone=1`、`/hang` 下 nav 5.7s 返回 |
| 打包闸门 | `build-release.mjs` **G1–G8 全过**（含 lib↔src 工具集一致、core↔mit 共享逻辑一致、registry 三副本逐字节一致、扩展 zip 形态、`dump-config` 零跳过） |
| 扩展三副本 | 源码 / 仓库 / 部署目录 4 文件 sha256 一致（1.0.21） |

台子收尾：rig 进程 0 残留；测试用的临时端口/目录已释放。

## 五、升级

按 `dist-release/INSTALL.md` 装 `browser-unified-core-0.1.6.tgz` 与 `dsh-browser-unified-0.11.22.tgz`
（**两个一起换**），扩展用 `DSH-Browser-Control-v1.0.21.zip` 重载。装完重启一次 `dsh web`，
之后改设置不再需要重启。
