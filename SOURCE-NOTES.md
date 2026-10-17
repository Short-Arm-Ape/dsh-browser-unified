# dsh-browser-unified 源码树（本机工作副本）

> 来源：**老机只读 FTP** `172.18.65.100:2121`，路径
> `/Work/Objects/dsh-browser-unified/`。只做过 LIST/MLSD/RETR，**没有向老机写任何东西**。
> 拉取时间：2026-09-27。原始版本：plugin 0.7.4 / core 0.1.0。

## 已做的校验：这份源码就是装机版的源码

本机用同一套 tsconfig 重建后：

| 产物 | 结果 |
|---|---|
| `browser-unified-plugin/lib/index.js` | 与装机 0.7.4 **逐字节相同（diff 0 行）** |
| `lib/unified-tools.js` / `lib/invariant.js` | 完全一致 |
| `browser-unified-core/dist/**` | 仅 `bridge/server.js` 不同 —— 那是本会话早先在**编译产物**上打的安全补丁（现已正式落到源码） |

## 本机构建环境（依赖复用 DSH 安装里的那份，避免版本漂移）

```bash
D=/home/wsluser/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
cd packages/browser-unified-core && npm i -D typescript@5.7.2 @types/node@22 --registry=https://registry.npmmirror.com
npm run build            # tsc → dist/

cd ../browser-unified-plugin
mkdir -p node_modules/@deepseek-ai
for p in cordis dsh-tools dsh-settings dsh-invariants schemastery; do ln -sfn "$D/$p" node_modules/@deepseek-ai/$p; done
ln -sfn ../browser-unified-core node_modules/browser-unified-core   # ← npm i 会删掉这个软链，装完要重建
npm i -D typescript@5.7.2 @types/node@22 --registry=https://registry.npmmirror.com
for p in cordis dsh-tools dsh-settings dsh-invariants schemastery; do ln -sfn "$D/$p" node_modules/@deepseek-ai/$p; done
ln -sfn ../browser-unified-core node_modules/browser-unified-core
npm run build && npm run build-pack    # → dsh-browser-unified-*.tgz
```

## 本会话对源码的改动（3 组，补丁见 `source-changes-2026-09-27.patch`，308 行）

1. **core `src/bridge/server.ts`（安全）**：`/api/command` 与 `/api/cleanup` 必须带 `?token=`；
   写类端点不再发 CORS 头；OPTIONS 预检只对 `chrome-extension://` 来源回显；状态页内嵌 token。
   动因：实测**任意网页**都能 `POST /api/command` 驱动用户浏览器（`browser.info` 返回 200）。
2. **plugin `src/index.ts`（fail-soft）**：端口被占时依次尝试 `port+1..port+9`，全不可用则降级记录、
   **不再抛**（历史上这里形成未处理拒绝 → DSH `exit(1)`）；`describePolicy` 增加
   `boundPort/requestedPort/portNote`，`browser_policy_status` 增加「桥接端口」一行。
3. **plugin `src/index.ts`（读正文）**：`browser_read` 的 render 从
   `title (url) — N chars` 改为**返回正文**；并新增 `frame` 参数透传（走扩展 1.0.12 的
   `content` 的帧定位与 frameset 拍平）。

版本：core 0.1.0 → **0.1.1**；plugin 0.7.4 → **0.8.0**。

## 验收（都在隔离环境，不碰线上实例）

| 项 | 方法 | 结果 |
|---|---|---|
| core 安全补丁 | `tests/` 同款脚本起独立桥（9799）跑 8 项 | **8/8 通过** |
| plugin fail-soft | 独立 `DSH_HOME=~/.dsh-probe`，先占住 9797，再启动探针实例 | **exit=124（存活）**，桥自动回退并监听 **9798**（`/api/status` 返回 `port:9798`）；修复前同场景 `exit=1` |

## 待办 / 未做

- 本补丁**尚未同步回老机**（只读铁律）：请在有远程终端时于老机仓库 `patch -p1 < source-changes-2026-09-27.patch`。
- `design/registry.json` 母本尚未补写本会话的设计条目（端口自动发现/fail-soft、工具面分层、
  云元数据定位 L3、老页面 frameset 支持）。
- `upstream/` 四个归档与 `.git` 未拉取（体积）；需要历史时再按需取。
- 扩展端改动（1.0.12）不在本源码树内 —— 它在
  `~/projects/dsh-browser-unified/extension/` 并以 `extension-port-discovery-1.0.7.patch` 留档。

## 2026-09-27（晚）追加：唤起修复（宿主 0.8.1）

**症状**：Edge 关掉所有窗口后仍后台驻留 → 扩展照样连着桥、`hello` 正常，但
`chrome.tabs.query({})` 返回空 ⇒ 所有"当前标签页"类命令失败（宿主报 `No current window`、
`tabs.list` 回 0 个标签页）。而此时 `launchBrowser()` 只看"扩展连没连"，会回答
"扩展已连接，无需拉起" —— **进程活着 ≠ 有可操作的窗口**，于是形成死局。

**改动**：新增 `wakeBrowser()`：扩展已连接 → 调扩展的新命令 `window.ensure`（让扩展自己新建窗口，
不再起进程）；扩展未连接 → 才走原 spawn。`browser_launch` 改走它，描述也拆成两种情况说明。

**配套（扩展侧，1.0.13）**：`windowCount()`/`ensureWindow()`、`resolveTab()` 零窗口时按需唤起、
新命令 `window.ensure`、`tabs.list` 增 `windows`/`noWindow` 字段。

**另一处必须配套的运维动作**：Edge 的 `Local State` 里 `last_used = Default`，而扩展只装在
**Profile 3**（名字 `Agent`）——**不带 `--profile-directory` 的启动会开 Default 窗口，里面没有扩展**。
所以已在 `~/.dsh/settings.yaml` 写入：

```yaml
autoLaunchBrowserExe: /mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe
autoLaunchProfileDir: /mnt/c/Users/localuser/AppData/Local/Microsoft/Edge/User Data/Profile 3
```

**真机验收**：`browser_launch` → 已拉起（profile=Profile 3）→ **5 s 内扩展连上（1.0.13）** →
`tabs.list` 回 `count=1 windows=1 noWindow=false`；`window.ensure` 在已有窗口时回
`created:false`（windows 1→1，不乱开窗）。**尚未验**：零窗口时由扩展自建窗口那条路径
（需要关掉唯一窗口才能触发）。

## 补丁文件状态

`source-changes-2026-09-27.patch` 曾生成（308 行）并自检可干净应用，但 **`/tmp` 被清空导致原始副本丢失**，
且老机 FTP 再次不可达，无法重新比对生成 ⇒ 已删除该文件，改为 **`CHANGES-2026-09-27.md`**（逐文件改动清单）。
老机可达后：① 直接拷这两个改动文件过去；或 ② 让我重拉原始文件生成 diff。

### 更正：零窗口时**扩展无法自愈**（实测 2026-09-28）

实测流程：只剩一个窗口 → 用 `tabs.close` 关掉它 → 4 秒后 `extensionConnected=False`；
此时 **msedge.exe 仍有 13 个进程**（浏览器后台驻留）、桥仍在听，但扩展的 **service worker 已被卸载**，
`chrome.alarms` 也没能在 10 秒内把它拉回来 ⇒ **没有任何东西能执行 `ensureWindow`**。

结论修正：扩展的 `ensureWindow`/`resolveTab` 自愈只在 **SW 还活着**时有用（例如"有窗口但零标签页"、
或窗口切换过程中）。**"关掉所有窗口"这个用户实际遇到的故障态，只能靠外部拉起**：

| 触发者 | 条件 |
|---|---|
| `browser_launch`（宿主工具） | `autoLaunchBrowserExe` / `autoLaunchProfileDir` 已配 ✅（已写入 settings.yaml） |
| buddy 的「调用即自动拉起」闸门 | `autoLaunchOnToolUse: true`（当前默认关）＋ patch 行里的 `browserExe`/`browserProfileDir`（已配 ✅） |
| 用户自己开一个窗口 | 无需配置 |

**实测恢复**：从上述完全掉线状态调 `browser_launch` → **5 秒**后扩展连上（1.0.13）→
`tabs.list` 回 `count=1 windows=1 noWindow=false` ✅。

## 2026-09-28 设置面收敛（plugin 0.8.1 → 0.8.5，含 registry de-021..de-027）

补丁：`source-changes-2026-09-28.patch`（**必须在 09-27 之后应用**：同一文件 `src/index.ts` 两次都有改动）。
已在临时树上验证 apply 后与工作副本逐字节一致；`npm run build-pack` 通过（tsc 无错），产物
`dsh-browser-unified-0.8.5.tgz` 已装进 `~/.dsh/profiles/web`（vendor/ 留档）。

三处改动：

1. **`src/index.ts`：新增 `ctx.provide('browserBridge', { config, describe, wake })`。**
   动机：唤醒被控浏览器需要 exe / profile 目录 / 配置文件名称 / 临时干净实例 / sideload 目录，
   还要区分「扩展连着但没有窗口」（`window.ensure`，不起进程）与「扩展没连上」（才 spawn）。
   这些只有本插件知道。外挂插件（dsh-browser-buddy）此前自存了一份 exe/profile 与一套 spawn 逻辑，
   与「浏览器插件」分区的设置**同值两处维护** —— 改一处另一处不跟着动。现在它改为消费本服务，
   自己那 50 行 spawn 代码整块删除。服务缺失（旧版本）时它明确回落为「请调 browser_launch」。

2. **`client/client.js`：「浏览器插件」分区精简**（用户要求：预设直接用分域设置控制；端口别让人手填）。
   砍「网络预设」行 → 三档分域成为唯一控制面（`urlMode` 键保留做默认值，不再露出）；
   三档各自带「允许临时授权」（6 行→3 行）；端口行改「起始端口 + 自动顺延」说明；
   **新增页面侧只读探测行**：`/api/status` 是唯一带 CORS 的只读端点，设置页直接并行探 10 个候选端口，
   显示端口/扩展连接/扩展版本，无需新增宿主通道；新增「自动拉起浏览器」卡（含同伴件那两行）与「高级」卡。
   同伴件的两行绑 `browser-buddy` 命名空间，未注册时不渲染。

3. **`registry/design/registry.json`：补写 de-021..de-026**（端口自动发现/fail-soft、HTTP 面安全收紧、工具面分层、frameset 支持、元数据 L3、本次设置面收敛）。

4. **`package.json`：0.8.1 → 0.8.5。**

**尚未同步老机**（只读铁律 + FTP 当前关闭）：两个补丁按 09-27 → 09-28 顺序 `patch -p1`，然后
`cd packages/browser-unified-plugin && npm run build-pack` 重新生成 `lib/`（补丁不含构建产物）。

## 2026-09-28 补充：DSH 控制页地址改为宿主推导（plugin 0.8.5）

用户提问：「怎么 DSH 的配置值是 `127.0.0.1:*` 呢？这样不就是拦截本地了吗？」

先把语义说清（都对着代码核过）：
- `dshOrigins` 是**登记表**（哪些地址算「DSH 控制页」），不是网络/分域过滤器；
  `UrlPolicy.dshRule()` 命中后：`dshAccessEnabled=true` → **直接放行**（跳过域审批），
  关 → 拦（`WEB_DSH_DISABLED`）。规则顺序在红线之后、分域授权之前。
- 回环别名（`127.0.0.1` / `localhost` / `::1`）会被归一成同一 endpoint；`host:*` = 该主机任意端口。
- 于是 `127.0.0.1:*` 的实际含义是「**本机任意端口都算控制页**」：开着时过度放权（本机其它服务
  也跳过审批），关掉时过度拦截（本机所有端口都被当成 DSH 页拦掉）。

改法（0.8.5）：**不让用户登记一个会过期的写死 origin**。
`ctx.inject(['webServer'])` 读实际监听端口（`config.port=0` 时是 OS 分配端口），
把 `http://127.0.0.1:<port>` 合并进生效 `dshOrigins`（**不写入用户设置**）；用户列表降级为
「额外地址」（局域网 IP / 自定义域名 / 反代）。`describePolicy()` 与 `policyKey` 都用合并后的列表，
端口变化即重建策略。缺 `webServer` 服务（非 web 部署）时静默退回「只认用户列表」。

同时把 `settings.yaml` 里的 `127.0.0.1:*` 收窄成 `http://127.0.0.1:3080`（当前真实 origin）。
实测（0.8.5 之前跑的 0.8.3 实例）：外部改文件后 `browser_policy_status` 立刻报
`DSH 页面访问: 开（http://127.0.0.1:3080）`，说明设置文件的 watch 生效、且 state 就是合并后的列表。
页面侧同步改了文案：DSH 行显示「本机控制页地址（宿主自动识别，无需登记）」+ 列表改称「额外地址」。

patch 已更新（同一份 `source-changes-2026-09-28.patch`，版本号 0.8.1 → 0.8.5，含 de-027），
临时树上验证 apply 后逐字节一致。

## 附：Chromium 系浏览器落点调研（2026-10-02）

给 `browser-profiles.ts` 的登记表做出处核对。**只列有出处的，其余明确写"未验证"** ——
调研时 `support.google.com` / `help.vivaldi.com` / `brave.com` / `help.opera.com` /
`web.archive.org` 都取不到正文（GFW/超时），`arc.net` 经浏览器桥拿回的是 Cloudflare 拦截页。

### 有官方源码出处的

| 品牌 | 平台 | exe / 命令 | user-data-dir | 出处 |
|---|---|---|---|---|
| Chrome | Win | `chrome.exe` | `%LOCALAPPDATA%\Google\Chrome\User Data` | `chrome_constants.cc`、`docs/user_data_dir.md` |
| Chrome | macOS | `Google Chrome.app`（`Contents/MacOS/Google Chrome`） | `~/Library/Application Support/Google/Chrome` | `chrome_constants.cc` + `user_data_dir.md` |
| Chrome | Linux | `google-chrome`（beta/dev/canary 有后缀） | `~/.config/google-chrome` | `chrome_paths_linux.cc`（注释逐字列出各通道）+ `user_data_dir.md` |
| Chromium | Win | `chrome.exe` | `%LOCALAPPDATA%\Chromium\User Data` | `chrome_constants.cc`、`chromium_install_modes.h`、`chrome_paths_win.cc` |
| Chromium | macOS | `Chromium.app` | `~/Library/Application Support/Chromium` | `chrome_constants.cc`、`theme/chromium/BRANDING` |
| Chromium | Linux | `chromium` | `~/.config/chromium` | `chrome_paths_linux.cc`（`data_dir_basename="chromium"`） |
| Brave | Win | `brave.exe` | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data` | brave-core `chromium_src/.../chrome_constants.cc`、`brave_user_data_dir_win_unittest.cc`、`chromium_install_modes.h` |
| Brave | Linux | `brave-browser` | `~/.config/BraveSoftware/Brave-Browser` | brave-core `chromium_src/.../chrome_paths_linux.cc` 原文 |

**profile 内部结构（全家族同构，Chromium 上游常量）**：`Default`（`kInitialProfile`）、
`Profile ` 前缀（`kMultiProfileDirPrefix`）、`Guest Profile`、`System Profile`、`Local State`
（`kLocalStateFilename`）、`Preferences` / `Secure Preferences`；
`profile.info_cache` 在 **`Local State`** 里（键=目录名），值含 `name` / `shortcut_name`（都是字符串）。
本机 Edge 154 实测吻合：`info_cache` 键 = `Default`/`Profile 1..3`，`Profile 3 → name="Agent"`。

### 两个关键发现（都影响代码）

1. **`extensions.settings` 的落点是"品牌差异"不是"平台差异"**：它是 tracked split pref，
   落哪个文件取决于品牌的 `kTrackedPrefs` EnforcementLevel —— 上游 Chromium（以及只
   `#include` 上游、没改这张表的 Brave）是 `NO_ENFORCEMENT` ⇒ 落 **`Preferences`**；
   而 **Edge 154 实测落 `Secure Preferences`**（本机 Profile 3：`Preferences` 0 条 vs
   `Secure Preferences` 30 条；`Default` 是 0 vs 40）。⇒ 代码必须**两个都读、Secure 优先**，
   绝不能按平台二选一，也绝不能把"没读到"当成"没装"。
2. **Linux 数据目录还看环境变量**：`$CHROME_CONFIG_HOME` > `$XDG_CONFIG_HOME` > `~/.config`，
   且**只有 Chrome / Chromium 认第一个**（Brave 只认 `$XDG_CONFIG_HOME`）。已在
   `expandPosixLinuxDir()` 里实现并用单测覆盖（设 `CHROME_CONFIG_HOME` 时 Brave 不受影响）。

### 未验证（用之前先跑一次探测，别当已知）

- Edge 的 macOS / Linux 路径；Brave 的 macOS 数据目录；**Vivaldi 全部**（只有 Linux snap 的
  启动器与 `/opt/vivaldi/vivaldi` 有官方出处）；**Opera 全部**（Windows 是 Roaming 还是 Local、
  是否"缓存 Local + 数据 Roaming"的分裂结构都没核实）；**Arc 全部**（连 Windows 版是否已停止支持
  都没拿到官方公告原文）。Chrome 的 `Preferences` 落点也**没有活体实测**（本机未装 Chrome），
  是源码推导 —— 落地前最好在装了 Chrome/Brave/Vivaldi/Opera 的机器上各验一次。
- **本表只对 stable 通道成立**：canary/beta/dev 会改可执行名与数据目录名（Windows 靠
  `install_suffix`、Linux 靠 `$CHROME_VERSION_EXTRA`、macOS 靠 app 包 `Info.plist` 的
  `CrProductDirName`）—— 所以**不能只看 app 名推目录名**。
