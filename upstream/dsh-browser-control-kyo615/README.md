# dsh-browser-control

让 [DeepSeek Harness](https://github.com/deepseek-ai) 里的 AI 像 Codex 一样**操控一个真实、可见的 Chrome 浏览器**，并在对话 GUI 里**实时看到每一步操作**（自动截图 + 可点击元素的数字编号）。

底层基于微软官方开源项目 [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)，通过 **MCP（Model Context Protocol）stdio** 连接。

> 本项目是 **DeepSeek Harness 的动态 Cordis 插件**（Host + Client 两部分）。它只调用 DSH / Cordis 的公开插件 API，不包含、不修改它们的源码。

## ✨ 特性

- **真实有头 Chrome**：不是无头浏览器，你桌面上直接看到 AI 在操作（鼠标移动、输入、点击）
- **约 80 个 `browser_*` 工具**注册给 AI：`browser_navigate` / `browser_click` / `browser_type` / `browser_snapshot` / `browser_press_key` / `browser_mouse_click_xy` / `browser_tabs` / `browser_evaluate` 等
- **GUI 内嵌实时画面**：每次 AI 动作后自动截图（`live.png`），经宿主 HTTP 路由 `/dsh-browser/shot.png` 实时刷新到对话面板，数字方框 = AI 可点击的元素编号
- **面板操作**：网址栏跳转、刷新画面、重启浏览器、关闭浏览器
- **零硬编码路径**：所有路径自动探测或可配置，clone 下来即可用

## 🏗 架构

```
┌──────────────────── DeepSeek Harness 进程 ────────────────────┐
│  Host（code.host）                                            │
│  ├─ 拉起 @playwright/mcp 子进程（真实有头 Chrome）             │
│  ├─ 最小 MCP stdio 客户端（换行分隔 JSON-RPC，手写实现）        │
│  ├─ 把 ~80 个 browser_* 工具注册为动态工具（harness.registerTool）│
│  └─ HTTP 路由 /dsh-browser/shot.png 提供实时截图               │
└──────┬─────────────────────────────┬──────────────────────────┘
       │ MCP stdio（stdin/stdout）    │ HTTP（GUI 同源）
       ▼                             ▼
┌──────────────────┐        ┌──────────────────┐
│ @playwright/mcp  │        │ Client（code.client）│
│ （node 子进程）    │        │ 实时画面面板（轮询 rev）│
│   └─ 真实 Chrome │        └──────────────────┘
└──────────────────┘
```

## 📦 依赖与前提

- [DeepSeek Harness](https://github.com/deepseek-ai)（或兼容其动态 Cordis 插件机制的环境）
- Node.js ≥ 18
- 系统已安装 **Google Chrome**（或 Edge）
- 依赖包（在你打算放置 `node_modules` 的工作区里执行）：

```bash
npm install @playwright/mcp
```

## 🧩 方式一：作为正式插件安装（`dsh plugin add`）

本项目声明了标准的 `dsh.bundle` manifest（`cordis.patch.yml` + package.json 的 `dsh` 字段），可通过 DSH 的插件安装命令直接安装：

```bash
dsh plugin add <本仓库 URL>
# 例如：
dsh plugin add https://github.com/kyo615/dsh-browser-control
```

安装后插件以 `browser-control` 作为实例 id 插入 Cordis 组合树，host 半加载 `lib/index.js`、client 半加载 `lib/client.js`。

> 前提同样需要：在对应工作区 `npm install @playwright/mcp`，且系统装有 Chrome。

## 🚀 方式二：动态插件（cordis_define / cordis_run）

动态插件是**进程级**的：DSH 重启后需重新定义与运行（依赖已在磁盘，无需重装）。

1. 在 DSH 对话中让 AI 执行（或手动调用）：
   - `cordis_define`：
     - `plugin.kind: 'new'`，`idPrefix` 例如 `brws`
     - `code.host` = 本仓库 [`src/host.js`](src/host.js) 的完整内容
     - `code.client` = 本仓库 [`src/client.js`](src/client.js) 的完整内容
   - `cordis_run(pluginId, packageId, 'run')`
2. 在弹出的运行卡片上**批准**（Client 部分需要授权）。
3. Chrome 自动启动并打开起始页；对话中那张运行卡片变成实时画面面板。

## ⚙️ 配置

所有配置均有**自动探测的默认值**，无需手动配置即可运行：

| 配置项 | 默认值（自动探测顺序） | 说明 |
|--------|------------------------|------|
| `workspace` | 插件 `config.workspace` → 当前会话工作区（`sandboxPolicy.workspaceRoot`）→ 空 | 存放 `node_modules/@playwright/mcp` 的工作区 |
| `cli` | `config.cli` → `<workspace>/node_modules/@playwright/mcp/cli.js` → 相对当前目录 → PATH 里的 `playwright-mcp` | MCP 服务入口 |
| `startUrl` | `https://www.bing.com` | 启动后自动打开的页面 |
| `shotPath` | `.playwright-mcp/live.png` | 实时截图文件（相对 workspace） |
| `viewport` | `1280x800` | 浏览器视口 |

> 代码按上述顺序解析，**不硬编码任何本机路径**。若运行时的插件配置支持 `config` 注入（`apply(ctx, config)` 的第二参），可用 `workspace` / `cli` / `startUrl` / `shotPath` / `viewport` 覆盖。

## 🎮 使用

- 直接对 AI 说："打开某网站 / 搜索某某 / 帮我操作网页"
- 或在面板的网址输入框输入网址跳转
- AI "看到"的是无障碍快照（带 `[ref]` 编号）；面板截图上的数字方框与之对应
- AI 可用 `browser_status`（带 `start: true`）在浏览器未运行时自行拉起来

## 📁 目录结构

```
dsh-browser-control/
├── LICENSE                 # MIT
├── THIRD_PARTY_NOTICES     # 第三方依赖声明（Apache-2.0 / MIT）
├── .gitignore              # 排除 node_modules / .playwright-mcp
├── cordis.patch.yml        # dsh.bundle manifest：`dsh plugin add` 安装入口
├── package.json            # 依赖声明 + dsh.bundle 字段（正式插件规范）
├── README.md               # 本文件
├── lib/
│   ├── index.js            # 宿主端入口（标准 Cordis 插件模块）
│   └── client.js           # 客户端入口（标准 Cordis 插件模块）
└── src/
    ├── host.js             # 宿主端源码（cordis_define 的 code.host 用）
    └── client.js           # 客户端源码（cordis_define 的 code.client 用）
```

## 🤝 致谢 / 第三方

- [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) · Apache-2.0 · © Microsoft
- [Playwright](https://github.com/microsoft/playwright) · Apache-2.0 · © Microsoft
- [DeepSeek Harness](https://github.com/deepseek-ai) · MIT · © 2026 DeepSeek
- [Cordis](https://github.com/cordiverse/cordis) · MIT · © 2021-present Shigma

详见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。

## 📄 许可证

[MIT](LICENSE) © 2026 kyo615

> ⚠️ 本插件允许 AI 操控浏览器执行真实操作，请自行负责使用场景的合规性（如网站条款、登录态、自动化访问限制等）。
