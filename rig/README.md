# rig/ — 真浏览器端到端测试台

假桥 + 真浏览器。用来验证**只有真 MV3 环境才看得见**的东西：真 service worker、
真 `chrome.debugger` 附着、真实导航时序、标签归组、批量关闭、硬锁竞态。

> 规范来源：`docs/BEHAVIOR.md` 里的到达判据；本目录只负责把它在真机上跑出来。

## 为什么需要它

`tests/*.mjs` 跑在 `node:vm` + 假 `chrome.*` 上，快、且能上 CI，但**假件永远比真浏览器宽容**。
`rig/` 就是补这一层：同一个 `background.js`，放进一份临时 profile 的真 Edge/Chrome 里跑，
再用扩展自己的 `eval` 把页面真实状态读回来当 ground truth。

## 依赖

- Node.js ≥ 18（`node --version` 能跑就行；不装任何 npm 包）
- 一台装了 Edge / Chrome / Chromium 的机器
- 端口 9781 空闲（**真桥是 9777，台子绝不碰它**）

## 快速开始

```bash
# 一条命令跑完整套（构建 → stub → 浏览器 → 冒烟 → 收尾）
node rig/rig.mjs run --tag smoke --scenario smoke

# 分步（要反复跑场景时更快）
node rig/rig.mjs build --tag dev --ver 1.0.99      # 从 ../src/extension 造一份 rig 专用扩展
node rig/rig.mjs up    --tag dev --reuse           # 起 stub + 浏览器，等到 rigTag=dev 才返回
node rig/rig.mjs probe dev                         # 慢页场景，写 rig/evidence-dev.txt
node rig/rig.mjs matrix dev                        # 9 个 nav/tabs.open 场景，写 rig/evidence-dev.json
node rig/rig.mjs down                              # 收尾（浏览器 + stub + 端口）
node rig/rig.mjs status                            # 看当前状态
```

Windows 用 `pwsh -File rig\rig.ps1 …`，Linux/macOS 用 `./rig/rig.sh …`（两个都是 `rig.mjs` 的薄壳，
逻辑只有一份）。旧的 `mk-ext.sh` / `deploy.sh` / `probe.sh` / `teardown.sh` 也保留着，
形状不变，内部转调 `rig.mjs`。

## 台子怎么保证「证据是真的」

1. **端口钉死**：构建时把 `const DEFAULT_PORT = 9777` 换成 stub 的端口（默认 9781），
   扩展自己扫端口也是在 9781 起扫 —— 绝不会连上你日常那座真桥。
2. **`rigTag` 注入 hello 帧**：`up` 只有等到浏览器报出本次的 tag 才返回。
   旧 profile / 旧脚本静默顶替时，tag 对不上，台子直接失败而不是交出一份错证据。
3. **每次全新 profile**：`--user-data-dir` 指到工作目录下的临时 profile，跑完就删。
4. **锚点缺失即中止**：`background.js` 里认不出 `DEFAULT_PORT` 或 hello 锚点就报错退出
   （宁可跑不起来，也不要跑出一份「不是盘上那份代码」的证据）。

## 工作目录与产物

默认 `<tmp>/dsh-rig`（`RIG_WORK` 可覆盖），所有临时物件都在这里，不污染源码树：

| 路径 | 是什么 |
|---|---|
| `<work>/ext-<tag>/` | 本次构建出的 rig 专用扩展 |
| `<work>/profile-<tag>/` | 浏览器临时 profile |
| `<work>/stub.log` | 假桥日志（含 hello 原文、每条命令耗时） |
| `<work>/browser.log` | 浏览器 stdout/stderr |
| `<work>/{stub,browser}.pid` | 用来收尾的 pid |

场景脚本把证据写回 `rig/` 本身：`evidence-<label>.txt` / `evidence-<label>.json`。

## 可选参数

| 参数 | 作用 |
|---|---|
| `--port 9782` | 换端口（默认 9781） |
| `--windowed` | 不 headless（要看画面/调试时）；默认 headless |
| `--reuse` | 不再重新构建，直接用 `<work>/ext-<tag>` |
| `--keep` | `run` 跑完不收尾，留着让你手动探 |
| `--timeout 90` | 等 `rigTag` 的秒数（默认 60） |
| `RIG_BROWSER=/path/to/chrome` | 指定浏览器可执行文件 |

## 已知未覆盖

- 台子跑的是**假桥**，真桥（`core` 的 WebSocket 服务 + 宿主侧策略）不在这一层；
  验证那条链用 `tests/` 与真宿主。
- `--headless=new` 下扩展能加载（本次实测 Edge 157 正常），但如果某个浏览器版本拒绝，
  加 `--windowed` 退回有窗口模式。
- `matrix.mjs` 里的 `10.255.255.1` 是刻意选的不可路由地址，用来演 TCP 黑洞；不是笔误。

## 历史

`rig/` 从 2026-09 起积累，`evidence-*` 是当时真机读数的存档（`git log -- rig/`）。
2026-10-30 换边到 Windows 后，启动脚本里写死的 WSL 路径失效，台子停摆；
2026-11-10 用一份可移植的 `rig.mjs` 接回来（同一次也补了 Linux 入口）。
