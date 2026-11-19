# dsh-browser-unified

在**你自己的浏览器**上给 DeepSeek Harness（dsh）做浏览器自动化：本地 WebSocket 桥 + Chrome/Edge 的
MV3 扩展，把 `browser_*` 工具交给模型，前面套一层可配置的 URL 策略。AGPL-3.0-only。

[English](README.md) · 中文

| 包 | 版本 | 是什么 |
|---|---|---|
| `dsh-browser-unified` | 0.11.54 | 插件：31 个 `browser_*` 工具（27 个驱动浏览器 + 4 个注册表/工具），GUI 设置分区 |
| `browser-unified-core` | 0.1.15 | URL 策略、审批层、桥（收编自上游）、guarded bridge、错误分类 |
| `dsh-browser-unified-mit` | 0.1.1 | MIT 版：没有桥、没有浏览器工具 |
| 扩展 `DSH Browser Control` | 1.0.58 | MV3 扩展；**用本仓这版**，别换回上游 |

## 安装

要求：dsh web，Edge 或 Chrome 116+。

1. **扩展** —— 先 `node src/scripts/build-release.mjs` 产出资产（写进 `dist-release/`：三个包的 tgz、
   扩展 zip 与各自的 `.sha256`），把扩展 zip 解压到任意目录，`edge://extensions`（Chrome：
   `chrome://extensions`）开开发者模式 →「加载解压缩的扩展」。源码在 [`src/extension/`](src/extension/)。
2. **插件** —— 取 `dist-release/` 里的 `browser-unified-core-<ver>.tgz` 与 `dsh-browser-unified-<ver>.tgz`：

   ```bash
   dsh plugin --profile <profile> add \
     file:/abs/path/browser-unified-core-0.1.15.tgz \
     file:/abs/path/dsh-browser-unified-0.11.54.tgz
   ```

3. **重启 `dsh web`**。包内 patch 默认 `enabled: true`，装好即监听 `127.0.0.1:9777`。

`dsh plugin add github:Short-Arm-Ape/dsh-browser-unified` **不行**：pnpm 解析的是仓库根，而根不是包，
装出来的条目没有 `lib/`、没有 `dsh.bundle.patch`，dsh 根本不会挂载它。GitHub 安装只适用于「仓库根就是
包」的仓。用上面的 tgz，或者 `file:` 指向 checkout 里的 `src/packages/` 条目。

MIT 版（`dsh-browser-unified-mit`，同一个 release）带 URL 策略、审批与自更新模块，但没有桥和浏览器工具。

## 配置

GUI：**设置 → 浏览器**。等价的 profile YAML（`cordis.patch.yml`）：

```yaml
- id: browser-bridge
  config:
    enabled: true
    urlMode: public      # public | intranet
    blockMetadata: true
    readOnly: false      # true = 所有改变状态的命令在发出前就被拒
    allowScript: true    # false = 禁用 browser_evaluate
    focusMode: auto      # auto = 切标签页但不把窗口提到前台
```

每个字段的语义与校验规则见
[`src/packages/browser-unified-plugin/README.md`](src/packages/browser-unified-plugin/README.md)。

## 工具

导航 `browser_navigate` / `browser_wait` / `browser_read` / `browser_find` / `browser_snapshot`；
交互 `browser_click` / `browser_type` / `browser_press` / `browser_scroll` / `browser_dialog` /
`browser_hold`；标签页与帧 `browser_tabs` / `browser_frames` / `browser_frame_eval`；
观测 `browser_console_log` / `browser_network_log` / `browser_network_clear` / `browser_screenshot` /
`browser_pdf` / `browser_emulate` / `browser_permissions` / `browser_evaluate` / `browser_policy_status`；
会话 `browser_info` / `browser_launch` / `browser_tools`；清理 `browser_cleanup`；
项目注册表 `browser_check_update` / `browser_design_show` / `browser_design_edit` / `browser_issues`。

导航请求在发给扩展**之前**就过 URL 策略，所以被拒的目标根本到不了浏览器。

## 安全模型

- **真正的边界是回环地址加 profile 配置里的 token**。agent 能读写那份配置，所以 token 隔开的是
  「你」和「本机其它进程」—— 不是「你」和 agent。
- **URL 策略** —— 三档 realm（internet / LAN / loopback）各自的 `allow` / `ask` / `deny`，放行/拒绝名单，
  云元数据拦截，未知主机的审批提示。
- **`readOnly` / `allowScript`** —— 被拒的命令根本到不了浏览器，因此不留副作用；`evalNavGuard` 在
  `browser_evaluate` 之后比对标签页地址，脚本把页面带走会报出来。
- **接管浮层** —— `browser_hold` 让页面变暗并显示模型在做什么；用户双击即接管，之后模型在那个标签页上的
  点击/输入/按键/导航一律被拒，直到它把浮层撤掉。
- **焦点纪律** —— `focusMode: auto` 只切标签页、不把窗口提到前台，模型操作不会打断你正在做的事。

## 已验证

- `node src/tests/run-all.mjs` —— 20 个套件，exit 0。套件用假 WebSocket 与自留端口，不碰真浏览器。
- 真浏览器检查（Edge + 待测扩展）是手工做的；CI 不跑浏览器。

## 目录

```
src/packages/browser-unified-core/    AGPL 核心：url-policy / approval / bridge（收编）/ 错误映射
src/packages/browser-unified-plugin/  插件：31 个工具、client 半区、GUI 设置分区
src/packages/browser-unified-mit/     MIT 版（无桥、无浏览器工具）
src/extension/                        MV3 扩展源码
src/design/                           设计条目、影响面、授权策略
src/upstream/                         只留上游 LICENSE；源码按 upstream-baseline.json 的 SHA 取回
src/tests/                            20 个回归套件 + run-all.mjs
rig/                                  真浏览器测试台
```

## 相关项目

- [caob23/dsh-browser-control](https://github.com/caob23/dsh-browser-control) —— 本仓收编并扩展的上游桥
  与 MV3 扩展（AGPL-3.0）。
- [dsh-intranet-browser](https://github.com/Short-Arm-Ape/dsh-intranet-browser) —— 本插件前身（已归档），
  URL 策略与审批层从那里起步。
- [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) —— 宿主。

## 许可

插件与 core：**AGPL-3.0-only**（含收编自 `caob23/dsh-browser-control` 的代码）。逐项来源、版本与许可矩阵见
[NOTICE.md](NOTICE.md)。MIT 版为 MIT，且不含上游衍生代码。

上游源码不入库：`src/upstream/` 只留许可证文本，`upstream-baseline.json` 每个上游记一个公开仓库与 commit SHA。
