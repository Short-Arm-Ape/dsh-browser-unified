# dsh-browser-unified 0.11.23 发布说明

> 主题：**「允许访问本 DSH 页面」这一项不再骗人** —— 桥把"正在生效的值"报出来，设置页把"存了但没生效"的改动显式列出来。
> 另修一个**装机持久性**缺陷（0.11.22 曾被 profile 重装静默回滚）。

## 版本

| 包 | 版本 | 说明 |
|---|---|---|
| `dsh-browser-unified` | **0.11.23** | 插件壳（30 个 `browser_*` 工具） |
| `browser-unified-core` | **0.1.7** | 新增 `BridgeServerOptions.describePolicy` 与 `BridgeServerStatus.policy` |
| `dsh-browser-unified-mit` | 0.1.1 | 未变 |
| 浏览器扩展 | 1.0.21 | 未变 |

⚠️ core 与插件仍**必须同版升**（插件 import core 的 `classify`；0.1.7 起还用到 `describePolicy`）。

## 一、修：`bi-040` 装机不是持久的（0.11.22 被静默回滚）

2026-10-14 手工把 core 0.1.6 + 插件 0.11.22 解包进 `~/.dsh/profiles/web/node_modules/` 并验证通过；
2026-10-17 发现装机目录又变回 **core 0.1.5 + 插件 0.11.21**，`loader/volatile-update` 订阅消失。

**根因**：profile 的 `package.json` 用 `file:` 指向 `vendor/*.tgz`：

```json
"browser-unified-core": "file:./vendor/browser-unified-core-0.1.5.tgz",
"dsh-browser-unified": "file:./vendor/dsh-browser-unified-0.11.21.tgz"
```

只要 profile 被重新解析/安装（本次发生在 10-17 13:20），就按**声明的** tgz 覆盖 ⇒ 手工覆盖文件从没改声明，
所以它不持久。**表现**就是：设置里 `dshAccessEnabled: true` 写进了配置文件，但运行中的桥仍是 `false`，
`browser_navigate http://127.0.0.1:3080` 一直报 `WEB_DSH_DISABLED`。

**新装机流程**（三步，少一步就不算装）：
1. 新 tgz 放进 `~/.dsh/profiles/web/vendor/`；
2. 改 `package.json` 的 dependencies 指向新文件名；
3. 再解包（`rm -rf node_modules/<name> && mkdir -p … && tar xzf vendor/<tgz> -C … --strip-components=1`）。

本次已按此流程装 **0.1.7 / 0.11.23**，并核对 `package.json` 声明与 `lib/` 内容一致。

## 二、优化：「允许访问本 DSH 页面」

### 1. 桥报出生效值（新 core 字段）

- `BridgeServerOptions.describePolicy?: () => Record<string, unknown> | undefined` —— 只读策略快照；
- `BridgeServerStatus.policy` —— 随 `GET /api/status` 一起返回（已有回环来源的 CORS 回显，设置页可直接读）；
- 插件在 reconcile 时挂上 `describePolicy`，**读 `this.current`** 而不是 reconcile 的参数
  （策略变更不重建监听器，闭包捕获的旧 config 会过期）。字段：`enabled / dshAccessEnabled /
  internetAccess / lanAccess / localAccess / askMode / blockMetadata / allowHosts / denyHosts`。
- `dshOrigins` 刻意**不**报：生效值里含宿主推导出来的控制页地址，与用户列表天然不同。

### 2. 设置页显式提示（新增）

- 访问控制卡顶部：存下来的值 ≠ 生效值时，弹琥珀 **「有改动还没生效」**，并**列出具体哪几项**
  （例：「配置已保存，但运行中的桥还是旧的 —— 重启 dsh web 后生效：允许访问本 DSH 页面」）。
- 桥**没报**生效值（旧插件 / 旧 core）时给灰字说明「无法确认这些改动是否已生效」——**不装作没事**。
- 比对逻辑抽成纯函数 `stalePolicyKeys(stored, policy)`，可单测；`dshOrigins` 不参与比对，
  `blockMetadata` / `enabled` 缺省视为"开"（避免默认值造成假报警）。
- 每次写入完成后自动重探一次 → 改了立刻反映（保存成功但没生效 ⇒ 提示条当场列出来）。

### 3. 这一项的说明改短（原来是五句长文）

> 开启后模型可以打开并操作本机 DSH 控制页（含你的会话列表与审批界面）。关闭时一律拒绝；关闭即时生效，开启需二次确认。

（"本机控制页地址由宿主自动识别"那段仍保留在地址列表上方 —— 它解释的是"为什么不需要你登记"。）

### 4. 顺带：探针只扫一遍

原来「本地桥」状态行与新的生效值比对**各扫一遍**候选端口（测试里暴露成 20 次请求）。
现在探针上移到分区 body，一次扫描两处共用；`BridgeStatus` 变成纯展示组件（带 `onRetry`）。

## 三、验证

| 层 | 结果 |
|---|---|
| 单元 / 渲染（10 套） | **298 项全绿**（`render-settings-pages` 38 → **49**，新增 11 项：`stalePolicyKeys` 6 组判据 + 提示条接线 + 说明文案） |
| 打包闸门 | `build-release.mjs` **G1–G8 全过** |
| 装机核对 | `package.json` 声明 0.11.23/0.1.7、`lib/index.js` 含 3 处 `loader/volatile-update` 与 7 处 `describePolicy`、`lib/client.js` 含 `stalePolicyKeys` 与提示条文案 |

## 四、升级与验收

装 `browser-unified-core-0.1.7.tgz` + `dsh-browser-unified-0.11.23.tgz`（按上文三步），重启一次 `dsh web`。
重启后验收「允许访问本 DSH 页面」：
1. 设置页打开该开关 → 应**立刻**（不重启）生效；
2. `browser_policy_status` 应显示「DSH 页面访问: 开」；
3. 若仍为"关"，访问控制卡顶部会出现「有改动还没生效」并点名这一项。
