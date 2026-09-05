# dsh-browser

[English](README.en.md) | **中文** | [Español](README.es.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [العربية](README.ar.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供完整的浏览器能力：导航、可读快照、点击与填表、多标签、截图，以及可接入识图模型的图像附件。

目标宿主：**dsh `0.1.0-rc.7` / `0.1.1-rc.2`**。默认驱动本机 **Microsoft Edge**（持久登录态 + 轻量反检测），并兼容 Clash / Surge 的 fake-ip DNS。

当前发布版本：

| 包 | 版本 |
|---|---|
| `@yeesy369/dsh-browser` | `0.6.0` |
| `@yeesy369/dsh-browser-playwright` | `0.8.1` |
| `@yeesy369/dsh-tool-browser` | `0.7.0` |
| `@yeesy369/dsh-web-permission` | `0.6.1` |

仓库与发行说明：https://github.com/xylt369/dsh-browser/releases/tag/v0.8.1

---

## 安装

1. 确认已安装 `dsh`（`dsh --version`）。未安装时执行 `npm i -g @deepseek-ai/dsh`。
2. 安装插件：

```sh
dsh plugin --profile web add \
  @yeesy369/dsh-browser-playwright@0.8.1 \
  @yeesy369/dsh-tool-browser@0.7.0 \
  @yeesy369/dsh-web-permission@0.6.1
```

3. 重启 `dsh web`。
4. 在对话中请求打开网页；需要登录时在弹出的 Edge 窗口中完成一次即可（状态保存在 `~/.dsh/edge-profile`）。

升级已有安装时，请使用上方带版本号的 `plugin add`，然后重启 `dsh web`。

---

## 配置界面（0.8.x）

配置入口为 **dsh Web → 设置 → 插件配置**。安装并重启后，该页会出现两张官方插件卡片（主路径不再是手写 YAML）。

### 网页权限门

控制浏览器 / 抓取工具可访问的主机。保存后**立即生效**（热更新）。

| 控件 | 说明 |
|---|---|
| 允许的主机 | 每行一个主机名；命中则放行 |
| 拒绝的主机 | 每行一个；优先于允许名单（默认含 `localhost`、`metadata.google.internal`） |
| 受管控的工具名 | 需要检查 `url` 参数的工具列表（如 `browser_navigate`、`browser_fill`、`web_fetch`） |
| 名单外主机的默认动作 | `允许` 或 `询问` |
| 批准后写入允许名单 | `询问` 且用户批准后，自动追加到允许名单 |

卡片底部提供 **放弃** / **保存**；字段被用户覆盖时可 **恢复默认**。

### 浏览器窗口

控制 Playwright 启动形态与网络兼容。保存后需**重启 dsh**，或等待**下一次启动浏览器**后生效。

| 控件 | 说明 |
|---|---|
| 窗口模式 | `可见窗口` / `隐藏窗口` / `无头` |
| 轻量反检测补丁 | 默认开启（抹除常见自动化指纹） |
| 允许代理 fake-ip DNS | 默认开启；放行 Clash/Surge 的 `198.18.0.0/15` 解析结果 |

| 窗口模式 | 适用场景 | 注意 |
|---|---|---|
| 可见窗口 | 手动登录、验证码、所见即所得 | 会占用桌面窗口 |
| 隐藏窗口 | 真浏览器、不打扰桌面 | 无法直接看窗口；需要桌面会话 |
| 无头 | 服务器 / CI | 强风控站点仍可能识别；无法手动登录 |

可选包 `@yeesy369/dsh-browser-settings` 提供侧栏面板。日常配置请优先使用上方「插件配置」卡片。

---

## 模型可用能力

| 能力 | 工具 / 行为 |
|---|---|
| 打开页面 | `browser_navigate`（经 URL 守卫） |
| 阅读页面 | `browser_snapshot`（含可点击 ref，如 `e1`、`f29e86`） |
| 交互 | `browser_click` / `type` / `fill` / `press` / `scroll` / `wait` / `back` / `forward` |
| 多标签 | `browser_tabs` / `open_tab` / `switch_tab` / `close_tab`（按会话隔离） |
| 截图 | `browser_screenshot` → 持久附件 + `image` ContentBlock（可送识图模型） |
| 页面内 JS | `browser_evaluate`（默认关闭；需 YAML/`cordis.patch.yml` 显式开启） |

---

## 安全模型

- 仅允许公网 `http(s)`；拦截内网、回环、link-local、云元数据地址（`packages/browser-playwright/src/url-guard.ts`）。
- 默认允许代理 fake-ip（`198.18.0.0/15`）；真实内网段仍拦截。可在「浏览器窗口」卡片关闭。
- 权限门默认对名单外主机为「允许」；需要人工审批时改为「询问」。
- 反检测为轻量实现，不能保证绕过全部风控。

YAML / `cordis.patch.yml` 仍可作为部署层配置；Web 卡片写入同一 settings 命名空间。

---

## 包职责

| 包 | 职责 |
|---|---|
| `@yeesy369/dsh-browser` | 服务定义：`ctx.browser` |
| `@yeesy369/dsh-browser-playwright` | Playwright 实现 + 「浏览器窗口」设置卡片 |
| `@yeesy369/dsh-tool-browser` | 面向模型的 `browser_*` 工具 |
| `@yeesy369/dsh-web-permission` | `tools/pre-execute` 权限门 + 「网页权限门」设置卡片 |
| `@yeesy369/dsh-browser-settings` | 可选侧栏配置面板 |

---

## 可选：YAML / 高级项

多数选项应在 Web 卡片中修改。以下仅用于自动化部署或尚未进卡片的字段。

```yaml
# $DSH_HOME/settings.yaml — web-permission（热更新）
web-permission:
  defaultAction: ask
  remember: true
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: browser-playwright
  config:
    windowVisibility: visible
    stealth: true
    allowFakeIp: true
- id: tool-browser
  config:
    evaluate: false
```

---

## 开发

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

文档：[架构](./docs/architecture.md) · [贡献与发版](./CONTRIBUTING.md) · [AGENTS](./AGENTS.md) · [许可证 MIT](./LICENSE)

卸载：

```sh
dsh plugin --profile web remove \
  @yeesy369/dsh-browser-playwright \
  @yeesy369/dsh-tool-browser \
  @yeesy369/dsh-web-permission
```
