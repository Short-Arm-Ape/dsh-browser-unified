# DSH Browser Control（浏览器扩展，MV3）

让 DSH 通过本地桥（`ws://127.0.0.1:<port>/ws?token=…`）驱动**你已登录的真实浏览器**：
导航、读正文、执行 JS、点击/输入/按键、截图/PDF、console/network 缓冲、标签页与窗口管理、视口仿真。

当前版本 **1.0.19**（`manifest.json` 的 `version` 是唯一真源：`background.js` 里
`EXT_VERSION = chrome.runtime.getManifest().version`，改版本只改 manifest，别在代码里再写一份）。

## 来源与许可

- **派生自上游 [caob23/dsh-browser-control](https://github.com/caob23/dsh-browser-control) 的
  `extension/`（AGPL-3.0）**，本仓库在其之上继续修改（版本已分叉到 1.0.x 的 1.0.19）。
- 因此本目录与本仓库其余部分一样按 **AGPL-3.0-only** 分发；归属矩阵与收编说明见
  [`../NOTICE.md`](../NOTICE.md)。把扩展打进 Release 时，**对应源码就是本目录**（AGPL 要求
  提供二进制就要提供对应源码 —— 这也是它必须留在仓库里的原因）。
- 想知道与上游扩展的差异，看 `../docs/releases-*.md` 与 `../design/registry.json`。

## 为什么必须和插件一起发

本插件的这几个能力**只有本版扩展提供**（配上游 1.0.7/1.0.8 的扩展会报「未知命令」或退化）：

| 工具/能力 | 依赖的扩展命令 |
|---|---|
| `browser_frames` / `browser_frame_eval` | `frames`（frameset / iframe 结构读取） |
| 自动拉起的「扩展自建窗口」路径（无窗口死局） | `window.ensure` |
| 端口自动发现（桥端口改动无需手改扩展） | 扩展侧 10 端口并行探测 |
| 导航「完成」判定不再撞旧文档（不假成功） | `waitForNavigationComplete` |
| div 化 SPA（淘宝 / 拼多多类）能认出可点元素 | `cursor:pointer` 样式边界扫描 |
| 弹窗策略 / 页面异常文案分类 | `dialog` 策略、`pageExceptionText` |

## 安装（手动）

1. 浏览器打开 `edge://extensions`（Chrome 为 `chrome://extensions`），开「开发者模式」。
2. 「加载解压缩的扩展」→ 选**本目录**。
3. 点扩展图标：填桥的端口（默认 9777）与 token，确认状态页显示「已连接」。
   建议装在**专用浏览器配置文件**里，与日常浏览隔离。

> 扩展只申请 `debugger / tabs / storage / alarms` 四个权限，并只对
> `http://127.0.0.1/*`、`http://localhost/*` 申请主机权限；桥只监听回环地址。

## 发布时的 zip 形态（踩过的坑）

Windows 资源管理器只认文件头，且不认反斜杠条目：

- 文件头必须是 `PK\x03\x04`（不能带 multipart 前言）；
- 条目分隔符必须是**正斜杠**；
- 上传后**匿名再下载一次**，核对头 4 字节、条目分隔符，并附一份 `.sha256`。

仓库根的 `scripts/build-release.mjs` 会自动按这个形态产出
`DSH-Browser-Control-v<version>.zip`（并自检：图标齐全、无 `.map`/缓存垃圾、条目为正斜杠）。

## 目录

```
extension/
├── manifest.json     MV3 清单（版本唯一真源）
├── background.js     service worker：连接桥 + 全部命令实现（CDP 驱动）
├── popup.html/.js    点图标弹出的状态/连接面板
└── icons/            16 / 48 / 128 图标
```
