# dsh-browser-unified 0.11.25 发布说明

> 承接 0.11.23（「允许访问本 DSH 页面」不再骗人）：0.11.24 补上**标签分组看得见**，0.11.25 修掉**帧协议协商形同虚设**。
> 三个版本都要重启一次 `dsh web` 才生效（换插件包版本不在热更新范围内）。

## 版本

| 包 | 版本 | 说明 |
|---|---|---|
| `dsh-browser-unified` | **0.11.25** | 插件壳（30 个 `browser_*` 工具） |
| `browser-unified-core` | **0.1.8** | `normalizeHello()`（protocol 协商修好） |
| `dsh-browser-unified-mit` | 0.1.1 | 未变 |
| 浏览器扩展 | **1.0.22** | `tabs.list` 补分组归属 |

## 一、0.11.24：标签分组**看得见**（`de-044`）

分组本身 0.11.22 就有（`tabs.group` / `tabs.ungroup` / 开标签自动进 `DSH` 蓝色组），
但 `tabs.list` 只回 `id/url/title/active` ⇒ **能做但看不见**：建了组也确认不了谁在组里，只能靠人眼看窗口顶部。

- 扩展 `cmdTabsList`：每个标签补 `groupId` / `groupTitle` / `groupColor`（**未归组的不加字段**，保持紧凑），
  并回一份 `groups` 一览（id/title/color/windowId，`chrome.tabGroups.query` 一次批量）；
- 插件 `browser_tabs`：list 渲染成行首 `[DSH]` 徽标 + 头部一行「分组：DSH（2 个标签）」；
  另加 `groupTitle` 参数只列某个组（`group` 这个名字已被 `open` 的布尔占用，故叫 `groupTitle`）。

真机核对（rig：真 Edge 155 + 真扩展 1.0.95 + 假桥）：`seg4-contract.mjs` **11/11** ——
开标签自动归组后 list 带 `groupTitle: DSH`（color=blue）；`tabs.group` 把已有标签拉进去后同样看得见
（两个标签同 `groupId`）；`ungroup` 后字段消失且**标签页数不变**；未归组标签不带字段。

## 二、0.11.25：帧协议协商原来一直是假的（`bi-041`）

`browser_info` 一直显示「协议：桥 v1 / 扩展 **v0**」，而扩展明明在 hello 里声明了 `protocol: 1`。
对账 `/api/status`：`hello.version=1.0.22` 但 `hello.protocol=null`。

**根因**：桥收 hello 时把字段**逐字段手抄**进 `this.hello`，抄的时候**漏了 `protocol`** ⇒
`extensionProtocol` 恒为 0 ⇒ 0.11.22 移植进来的协议协商从来没生效过（"对得上"只是降级后的默认结论）。

**修法**：hello 规范化抽成导出纯函数 `normalizeHello(msg)`（`protocol` 校验：有限、≥0、小数截断、非法忽略），
落库直接用它的结果。`error-contract` 增 **7 项**断言。

重启后实测：`browser_info` → **「桥 v1 / 扩展 v1（对得上）」**；`curl /api/status` →
`hello.protocol = 1`、`extensionProtocol = 1`、`compatible = true`。

## 三、装机与验证

| 项 | 结果 |
|---|---|
| 测试 | **10 套 309 项全绿**（`error-contract` 24 → 31，`render-settings-pages` 38 → 49，`tool-render` 90 → 94） |
| 真机契约 | `seg4-contract.mjs` **11/11** |
| 发布闸门 | `build-release.mjs` **G1–G8 全过** |
| 装机 | core **0.1.8** + 插件 **0.11.25**（vendor + `package.json` 指向新 tgz ⇒ 持久，见 `bi-040`） |
| 扩展 | 1.0.22（三处副本 sha256 一致） |

## 四、升级

装 `browser-unified-core-0.1.8.tgz` + `dsh-browser-unified-0.11.25.tgz`（**两个一起换**），
扩展用 `DSH-Browser-Control-v1.0.22.zip` 重载，重启一次 `dsh web`。
