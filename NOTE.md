# dsh-browser-unified 迁移记录（0.7.4 + 扩展 1.0.7）

## 来源与凭据

- 老机器 `172.18.65.100:2121`（**只读 FTP**：只做过 LIST / RETR，没写过任何东西）
- 取的路径：
  - `/Work/Objects/dsh-browser-unified/packages/browser-unified-plugin/dsh-browser-unified-0.7.4.tgz`
  - `/edge-plugin/DSH-Browser-Control-1.0.7/`（扩展整目录）
  - `/Work/Objects/dsh-browser-unified/{upstream-baseline.json,NOTICE.md,README.md}`
- sha256（本地留档）：
  - tgz `a56c09a1…2ce6af`
  - 扩展 `background.js b07ebf60…b7861d` / `manifest.json 3078108e…1550f1`
  - `upstream-baseline.json e48944da…654e94` / `NOTICE.md 12edf391…d2480`

## 已经做了什么

1. tgz 放进 profile 并挂上：`~/.dsh/profiles/web/vendor/dsh-browser-unified-0.7.4.tgz`
   `dsh.profile.bundles` 现在第 6 层：base → web-app → sensitive-replace → better-sidebar → dshmarket → **browser-unified**
2. `dsh --profile web --dump-config` 退出码 0，组合树 560 行，`browser-bridge` 行已就位。
3. **默认是关闭挂载**（原插件的设计）：
   ```yaml
   enabled: false      # 要开：设置 → 插件 → DSH Browser Control
   port: 9777
   token: dsh-local
   urlMode: public     # 默认拦私网/回环/云元数据
   ```

## 审计结论（装之前扫的）

- 21 个工具（16 驱动 + 5 辅助）、**零 `fetch(`、零 `http://`、零外部域名**、总 0.3 MB
- 依赖只有 `@deepseek-ai/schemastery`；peer 要 `dsh-* >=0.1.0-rc.1 <0.2.0-0` → 本机 0.1.5-rc.2 满足
- `engines: node ^22.19.0 || >=24` → 本机 v22.23.2 满足
- 许可 AGPL-3.0-only（含 caob23 收编代码，归属见 `NOTICE.md`）

## 浏览器侧（要你手动做一次）

Windows 的 Edge 加载**未打包扩展**：`edge://extensions` → 打开「开发人员模式」→「加载解压缩的扩展」→ 选

```
\\wsl.localhost\Ubuntu\home\wsluser\projects\dsh-browser-unified\extension
```

要求 Edge/Chrome ≥ 116（扩展用了 `debugger` 权限做 CDP）。扩展名 **DSH Browser Control** 1.0.7。

## 卸载 / 回滚

```bash
cd ~/.dsh/profiles/web && dsh plugin --profile web remove dsh-browser-unified
rm ~/.dsh/profiles/web/vendor/dsh-browser-unified-0.7.4.tgz
```

## 已知边界

- 只拦**工具发起**的导航；页面内请求拦截（route 化 / WebSocket / DNS rebinding）未做（原仓库 design 条目 de-005）。
- 老机器那边**没有** DSH 本体版本记录，`0.7.4` 是照着 `dsh-* 0.1.x` 构的成品；若启动即报错，回滚命令在上面。

## 2026-09-22 23:1x 更新：首次启动失败的根因与修复

**症状**：`dsh web` 报
`Cannot find package 'browser-unified-core' imported from .../dsh-browser-unified/lib/index.js`

**根因**：那个 tgz **不是自包含的**。`lib/index.js` 里有
`import { BridgeServer, cleanupArtifacts, GuardedBridge, UrlPolicy } from 'browser-unified-core'`
—— 这是同仓库的**兄弟包**（monorepo 本地包）。他开发机上靠工作区链接能解析，
打出来的 tgz 里没有它，package.json 也没把它列为依赖。

**修复**：从老机器把 `packages/browser-unified-core` 的 `dist/` 拉下来（23 个文件 / 148 KB），
本地 `npm pack` 成 `browser-unified-core-0.1.0.tgz`，装进 profile 当**普通依赖**
（它不声明 `dsh.bundle`，所以只当库，不成为新层）。

```bash
cd ~/.dsh/profiles/web-0 && dsh plugin --profile web-0 add \
  file:./vendor/browser-unified-core-0.1.0.tgz file:./vendor/dsh-browser-unified-0.7.4.tgz
```

**验证（在独立 DSH_HOME 上起探针实例做的，没碰正式实例）**：
- `DSH_HOME=~/.dsh-probe dsh --profile web-0 --no-open --port 3099` → 正常启动，出 URL
- 首页 boot 图里 `dsh-browser-unified/client.js`、`dshmarket/client.js`、`dsh-better-sidebar/client.js` 都在
- 会话客户端 bundle 里含分支补丁 `handOffDraft`（2 处）→ 补丁确实被服务出去
- 探针已关、`~/.dsh-probe` 已删

## profile 归属（2026-09-22 23:1x 改名后的最终形态）

**`web` = 日常**（装齐插件：sensitive-replace / better-sidebar / dshmarket / browser-unified），
**`web-0` = 纯净救援**（`dependencies: {}`，bundles 只有 base + web-app）。启动就是 `dsh web`。

> 更正一条早期误判：23:09 那次重装**并没有**"把 `web` 重置成空模板"。`loadProfile` 只在
> profile 目录**缺 `package.json`** 时按模板新建 —— 当时是改名后 `web` 目录不存在才被新建的。
> `dsh`/`dsh-app-boot` 都没有 postinstall，升级本身不碰 `~/.dsh`。

改名带来的坑（已修）：`dsh plugin add` 会把相对 `file:` 规格改写成**绝对路径**，所以 `web` 里
两条依赖曾指向 `profiles/web-0/vendor/...`；在 `~/.dsh/profiles/web` 下重跑一次
`dsh plugin --profile web add file:./vendor/...tgz` 即修好。**任何时候都要保证日常 profile
的目录名就是 `web`**（绝对路径按名写死）。

## 浏览器扩展（Edge）安装记录

- 解压缩加载目录：**`D:\edge-extensions\dsh-browser-extension`**（与
  `projects/dsh-browser-unified/extension` **逐字节一致**）。Edge `Profile 3` 中扩展 id
  `nlhedoliokpkcodjlgdlhiiohjcbbaap`，`location=4`（=unpacked）。
  **版本注意**：上游原样副本是 1.0.7（7 个文件的 sha256 见本文件开头「来源与凭据」）；
  2026-09-25 起本地加载的是在其上打过端口发现补丁的 **1.0.8 本地版**（见文末一节）。
- 扩展是 **per-profile** 的：只有装了它的那个 Edge 配置文件里的标签页能被控 —— 当前在 **Profile 3**。
- 桥接开关在 **`~/.dsh/settings.yaml` → `browser-bridge.enabled: true`**（默认 false）。开关打开后
  服务端才开始监听 9777；扩展最迟 ~30 s 自动握手（`autoConnect` 默认 true，backoff 上限 30 s，
  alarm 每 30 s 唤醒 SW）。
- 连接参数：默认 `ws://127.0.0.1:9777/ws?token=dsh-local`。**2026-09-25 起端口不再写死**：
  扩展按候选序列探测（见文末），所以桥换端口后扩展会自动跟随。扩展自 1.0.8 起声明了
  `host_permissions: http://127.0.0.1/*, http://localhost/*`（只为 `GET /api/status` 探测；
  上游 1.0.7 没有 host_permissions）。服务端仍不校验 Origin。
  状态页 `http://127.0.0.1:<实际端口>/`，`/api/status` 看 `extensionConnected`。
- 服务端策略：**新连接替换旧连接**（`replaced by a newer connection`）—— 从 Windows 侧做连通性
  测试会短暂挤掉扩展，它会自行重连，不是故障。
- WSL2 → Windows 的 localhost 转发可用（Windows 侧 `Invoke-WebRequest 127.0.0.1:9777` 回 200）。

## 2026-09-25 扩展端改造：端口自动发现（上游 1.0.7 → 本地 1.0.8）

> 完整的背景、待办与设计取舍见 `改造方案-对齐.md`（§0 P0 实测、§3 已定五项、§5 原型验证、§6 本节对应的验收）。

**为什么改**：需求「端口能动态切换，即使端口被占也不影响 DSH 本身启动」。实测坐实了另一半风险：
宿主侧端口被占会让 DSH **启动即退出**（`P0-探针取证-20260925.log`：对照组存活、实验组
`dsh: fatal load failure: … listen EADDRINUSE` + `exit=1`）。宿主侧那半**本轮没改**
（要动插件的 `lib/index.js`，源在老机）；本轮只做扩展端——让扩展不再死守一个写死的端口。

**改了什么**（4 个文件，全部在 `extension/`）

| 文件 | 改动 |
|---|---|
| `background.js` | 新增 `portCandidates()` / `probeBridge()` / `discoverBridge()`：候选顺序 = `[用户设置端口 → lastKnownPort → 9777..9786]`，逐个 `GET /api/status`（400ms 超时）；`connect()` 改为「先发现后握手」；WS 断开时清空命中结果，下次重连重新发现；新增 `{type:'rescan'}` 消息；`bridgeStatus` 增加 `discoveredPort/lastProbeNote/scanRange`；`DEFAULT_CONFIG` 升 v3（+`lastKnownPort`） |
| `manifest.json` | `host_permissions: ["http://127.0.0.1/*", "http://localhost/*"]`（匹配模式不含端口，覆盖全部候选）；`version` 1.0.7 → **1.0.8** |
| `popup.html` / `popup.js` | 主区显示「实际端口」；高级区显示最近一次扫描结论 + 「重新扫描本地桥」；「连接中」文案改为「正在扫描端口并握手」 |

**服务端零改动**：`/api/status` 本来就有 `Access-Control-Allow-Origin: *`（`core/dist/bridge/server.js`
的 `respondJson`）且不校验 token —— 探测不需要新增服务端代码，也能区分「端口上没桥」与
「有桥但 token 不对」（后者到 WS 握手才失败）。

**可复用补丁**：`extension-port-discovery-1.0.7.patch`（对上游 1.0.7 原样副本的 unified diff，
已 `patch -p1 --dry-run` 自检干净）。**吸收上游扩展新版本时**：先 `patch -p1` 打上这个补丁；
冲突点集中在 `background.js` 的 `connect()` 与 `DEFAULT_CONFIG`、`manifest.json` 的权限数组、
`popup.js` 的 `render()`。

**部署与重载**：`projects/dsh-browser-unified/extension/` → 复制到
`D:\edge-extensions\dsh-browser-extension`（两边 4 文件 sha256 一致）→ 在 `edge://extensions`
点一次「重新加载」。这一步**只能人手点**：插件自己的 URL 策略按设计只放 http(s)，
`edge://` 与 `chrome-extension://` 都被挡（`WEB_INVALID_URL`），agent 无法代劳；
也因此验收只能靠「桥侧读数」，不能读 popup DOM。

> 版本号的用途：桥的 `/api/status` → `hello.version` 会显示扩展自报版本。
> 升到 1.0.8 后，重载一次就能从桥侧区分「新构建 / 旧构建」——升级后若仍显示 1.0.7，说明没重载成功。

**验收（2026-09-25 实测）**

| 步骤 | 读数 |
|---|---|
| 重载后 | `9777/api/status` → `extensionConnected: true` |
| 桥端口 9777 → 9781（改 `~/.dsh/settings.yaml`，**热生效**，不用重启） | 2s 内 `9781` 上 `extensionConnected: true`；9777 无响应 |
| 改回 9777 | 2s 内恢复；9781 无响应 |
| 功能冒烟 | `browser_tabs` 正常返回 |

**回滚**：`extension.bak-20260925/`（本目录）与
`/mnt/d/edge-extensions/dsh-browser-extension.bak-20260925/` 都是改造前的 1.0.7 原样副本；
回滚 = 拷回 4 个文件再重载一次。

**遗留**：宿主侧 fail-soft（端口被占 → 换端口或降级，而不是 `exit(1)`）未做；
`~/.dsh/settings.yaml` 里 `dshOrigins` 仍写 `http://127.0.0.1:3081`，而当前实例在 `3080`。

## 2026-09-25 外挂式改造：`dsh-browser-buddy` v0.1.0（已装机、已验收）

**为什么会有它**：宿主侧要改的三件事**不必动本插件源码**，用 DSH 公开扩展点就能做到；
（第四件 fail-soft 不行，见上节遗留。）包放在 **`~/projects/dsh-browser-buddy/`**，
与本仓库是**两个独立产物**：本仓库管桥与扩展，buddy 只管"怎么把桥的能力交给模型"。

| 能力 | 扩展点 | 实测 |
|---|---|---|
| 工具面分层 | `system-prompt/assemble`（waterfall，返回值权威）→ `next()` 后替换 `tools` | 21 个 `browser_*` → 常驻 6；隐藏 16 个 = 8,937 字符 ≈ **工具面的 19.1%** |
| 状态注入 | `ctx.systemPrompt.context({ text: () => … })` | 每轮上下文出现桥端口/扩展连接/分层与自动拉起状态 + 调用约定 |
| 调用即自动拉起 | `tools/pre-execute`（waterfall，`next()` 放行） | `browser_*` 调用前探状态，开关开且未连接时先拉起；默认**关** |

**装机方式（不是 bundle 层，无需重启）**：

```bash
cd ~/.dsh/profiles/web && dsh plugin --profile web add file:~/projects/dsh-browser-buddy/dsh-browser-buddy-0.1.0.tgz
# 然后在 profile 的 cordis.patch.yml 里加一段（该文件 live 重载，改完即时生效）：
#   - insert:
#       - id: browser-buddy
#         name: 'dsh-browser-buddy'
#         config: { enabled: true, layeredTools: true, autoLaunchOnToolUse: false }
```

**验收读数**：桥探测 `端口 9777 / 扩展已连接 / hello 版本 1.0.7`；分层开时子会话只见常驻 6 个；
`browser_tools enable session` 后子会话见 9 个（6 + navigate/tabs/cleanup）、注入行"隐藏"16 → 13。

**边界**：装配钩子**全局生效**（同进程内所有会话都被过滤）；运行时开关状态在内存里，重启回到 patch 配置；
隐藏只是"不呈现"，工具仍在注册表。**回滚**：删 patch 里那段 insert →
`dsh plugin --profile web remove dsh-browser-buddy`（改前备份 `/tmp/cordis.patch.yml.bak`、`/tmp/profile-package.json.bak`）。

## 2026-09-25（晚）老页面读取修复 + 核心 HTTP 面安全补丁

### A. 老式 frameset 管理页读不动（扩展 1.0.9）

**症状**：路由器/光猫/交换机那类 `<frameset>` 管理页，`browser_read` 只返回标题+URL
（实测 20 字符；另一个会话遇到的是 40 字符）。三条根因都在扩展：

| # | 根因 | 修法 |
|---|---|---|
| 1 | `cmdContent` 只读顶层 `document.body`，而 **frameset 页面没有可见正文** | 顶层正文为空且有子帧时，**自动拍平同源子帧**（每段带 `[name]` 标签）；跨域帧只标注不抛错；新增 `params.frame`（name / `#序号` / url 子串）只读指定帧 |
| 2 | `cmdEval` 默认预算写成 `Math.max(100, params.timeoutMs \|\| 0)` = **100ms**，而宿主从不传 timeoutMs | 默认改为 **15s**。实测旧代码下连一句 `JSON.stringify(...)` 在非激活标签页都必报 `eval timeout after 100ms` |
| 3 | 没有"枚举 frame"的命令；frame 目标只有 eval 有 | 新增命令 **`frames`**（index/name/src/url/同源 + 文本预览）；eval 支持 `params.frame` |

**验收（fixture：`fixtures/legacy-admin/`，`python3 -m http.server 8099`）**

```
修复前: browser_read → "Legacy Router Admin (frameset) (http://…index.html) — 20 chars"
修复后: [top] UTT 进取 750W / 软件版本 …  [menu] 运行状态 网络参数 无线配置
        [main] 运行状态 / WAN 连接	未连接 / IP 地址	0.0.0.0 / 管理员口令 保存
frames: 3 个 frame（top/menu/main），全部同源，各自带预览
```

配套：`extractPageException` 现在输出 `exception.description`（以前只有 "Uncaught"，老页面调试看不到真因）。

**注意**：`manifest.json` 已到 **1.0.12**；改 `background.js` 后 Edge **不一定**自动重载
（改 manifest 那次它自己重载了，改 JS 没有），需要人手在 `edge://extensions` 点一次。

**真机复验（2026-09-25 深夜，UTT 进取 750W @ `192.168.2.1/framePage.asp`）**

| 项 | 结果 |
|---|---|
| `browser_frames` | 9 个 frame 全列出（top / leftMenu / assist / secondTop / main / bottom + 3 个 about:blank），带同源标记与文本预览 |
| `content`（拍平） | 9 帧拍平 882 字符：产品型号·软件版本、**完整左侧菜单**（配置向导→客户服务）、向导正文 |
| `content frame=main` | FastConfig 向导正文（旧代码此处报 `page exception: Uncaught`） |
| `eval frame=assist` | `{"loginName":"admin","deviceName":"utt","deviceType":""}` |

**踩坑（写死，血泪）**：`buildContentScript()` 的**模板字面量内部不能出现反引号**——哪怕在注释里。
我曾在该模板内的注释中用反引号强调 frameset 标签，那只反引号**提前闭合了模板**，其后中文被当代码解析，
于是 `content` / `content.debug` 一律抛 `ReferenceError: frameset is not defined`，而 **`node --check` 依旧通过**
（同一行另一只反引号又把模板"重新打开"，整体括号平衡，静态检查抓不到）。
定位手法：**用 Chrome API 桩加载真文件直接调该函数**，堆栈直接指出 `background.js:996:8`；
另加了 `content.debug` 命令可把注入脚本原样 dump 出来（这条留作常备诊断）。
过程中我曾误判为"Edge 缓存旧 SW"，把 SW 改名成 `sw.js` 试过——**不是缓存问题，已改回 `background.js`**；
行尾也别乱动：上游 `background.js` 是 CRLF，规范化成 LF 会让补丁打不上（补丁 512 行，`patch -p1` 自检可干净应用）。

### A2. 宿主 `browser_read` 只回摘要 ⇒ 模型拿不到正文

`dsh-browser-unified` 的 `browser_read` 渲染是：

```js
text: `${value.title} (${value.url}) — ${value.content.length} chars${value.truncated ? ', truncated' : ''}`
```

正文在结构化值里，**渲染把它丢了** —— 模型只看到「标题 (URL) — N chars」。
这是"读老页面"另一半的锅，属插件宿主（源码在老机，正解是改那个 render）。
目前由 buddy 的 **`browser_page_read`** 补位（走桥的 HTTP 命令面，返回完整正文 + frameset 拍平）：
实测同一台 UTT 页面返回 **882 字符全文**（含完整菜单），而 `browser_read` 只给 "882 chars"。
buddy 里 `browser_read` 已移出常驻、降到 `raw` 分组。

### B. `POST /api/command` 未鉴权 ⇒ 任意网页可驱动浏览器（本地补丁）

**问题**（实测复现）：桥的 HTTP 面 `/api/command` **不校验 token**，且 OPTIONS 预检无条件回
`Access-Control-Allow-Origin: *`。于是**用户浏览的任意网页**都能 POST 桥命令（含 `eval`）：

```
从网页上下文 POST http://127.0.0.1:9777/api/command {command:'browser.info'}
→ HTTP 200，返回真实浏览器信息（无需 token）
```

**上游来源**：caob23 收编的 HTTP face（不是本次改造引入）。

**补丁**（改的是**编译产物** `browser-unified-core/dist/bridge/server.js`，不是源码）：

1. 新增 `tokenOk(req, url)`（常量时间比较；token 为空则不校验，向后兼容）；
2. `/api/command` 与 `/api/cleanup` 必须带 `?token=`（或 `X-DSH-Token` 头），否则 401；
3. `respondJson` 增加 `{ cors: false }`：**写类端点不再发 CORS 头**；只读的 `/api/status` 仍保留 `*`；
4. OPTIONS 预检只对扩展来源（`chrome-extension://`）回显 Origin，网页来源不回；
5. 状态页内嵌 token，供页面上的「清理」按钮使用。

**验证**：`tests/verify-core-patch.mjs`（在 `~/projects/dsh-browser-buddy/`）起一个独立桥实例，
**8/8 通过**：无 token→401、错 token→401、对 token→通过鉴权、网页 Origin 预检→不回 ACAO、
扩展 Origin 预检→回显、`/api/status` 仍 `*`、`/api/cleanup` 无 token→401、状态页含 token。

**⚠️ 生效条件**：运行中的 DSH 进程已把旧 `server.js` 载入内存，**补丁要等下次重启 `dsh web` 才生效**
（实测此刻无 token 仍返回 200）。备份：`~/projects/dsh-browser-buddy/backups/core-server.js.before-20260925`。
**待办**：这属于源码侧该改的东西（`core/src/bridge/server.ts`），重装 `browser-unified-core` 会覆盖本补丁。

## 2026-09-27 取源 + 源码侧三处修复（已装机，待重启生效）

**取源**：老机 FTP 恢复可达（2121 OPEN），按铁律**只读**（MLSD/RETR，无任何写操作）拉下源码树到
`~/projects/dsh-browser-unified/src/`（26+ 文件，含 `packages/*/src`、`design/`、`scripts/`）。

**溯源校验（重要）**：本机用同一套 tsconfig 重建，`lib/index.js` 与**装机 0.7.4 逐字节相同**，
unified-tools/invariant 亦一致；core 只差我早先打在**编译产物**上的安全补丁那份 —— 坐实"源码=装机版"。

**源码侧改动（3 组，补丁 `source-changes-2026-09-27.patch` 308 行，可干净 `patch -p1`）**

| # | 文件 | 改动 |
|---|---|---|
| 1 | `core/src/bridge/server.ts` | `/api/command`、`/api/cleanup` 要 token；写类端点不发 CORS；OPTIONS 只回显扩展来源；状态页内嵌 token（把 09-25 打在编译产物上的补丁**正式落到源码**） |
| 2 | `plugin/src/index.ts` | **fail-soft**：端口被占 → 依次试 `port+1..+9`；全不可用只记录降级、**不再抛**（历史上未处理拒绝 → DSH `exit(1)`）；`describePolicy` 增 `boundPort/requestedPort/portNote`，`browser_policy_status` 增「桥接端口」行 |
| 3 | `plugin/src/index.ts` | `browser_read` 的 render **返回正文**（原来只给 `title (url) — N chars`，模型读不到正文）；新增 `frame` 参数透传 |

版本：core **0.1.1**、plugin **0.8.0**。

**验收（隔离环境，未碰线上）**

| 项 | 方法 | 结果 |
|---|---|---|
| core 安全补丁 | 源码构建版起独立桥（9799）跑 8 项矩阵 | **8/8 通过** |
| plugin fail-soft | 独立 `DSH_HOME=~/.dsh-probe` + 先占住 9797 再启动 | **exit=124（存活）**，桥自动回退并监听 **9798**；修复前同场景 **exit=1** |

**装机状态**：`~/.dsh/profiles/web` 已 `pnpm add` 新版两个 tgz（vendor 里新旧都在）；
**需重启 `dsh web` 才生效**（宿主半区）。回滚 = 把依赖指回
`vendor/browser-unified-core-0.1.0.tgz` + `vendor/dsh-browser-unified-0.7.4.tgz` 再重启。

**遗留**：① 补丁尚未同步回老机（只读铁律，请你有远程终端时 `patch -p1` 应用）；
② `design/registry.json` 母本未补本会话设计条目；③ buddy 的 `browser_page_read` 在宿主 read 修好后已冗余（可择机收敛）。

## 2026-09-28 唤起修复（"进程活着 ≠ 有窗口"）

**症状**（另一个会话末尾 + 本会话复现）：Edge 关掉所有窗口后仍后台驻留，扩展连着桥但
`tabs.list` 回 0、宿主报 `No current window`；此时 `browser_launch` 回答"扩展已连接，无需拉起" → 死局。

**三处改动**

| 层 | 改动 |
|---|---|
| 宿主 0.8.1 | 新增 `wakeBrowser()`：扩展已连但无窗口 → 调扩展 `window.ensure` 开窗（不起进程）；未连接 → 才 spawn。`browser_launch` 改走它 |
| 扩展 1.0.13 | `windowCount()`/`ensureWindow()`；`resolveTab()` 零窗口时按需唤起；新命令 `window.ensure`；`tabs.list` 增 `windows`/`noWindow` |
| 运维配置 | `~/.dsh/settings.yaml` 写入 `autoLaunchBrowserExe` + `autoLaunchProfileDir`（**Profile 3**，扩展只装在这里）；buddy patch 行也配了同样的 `browserExe`/`browserProfileDir` |

**关键坑**：Edge `Local State` 的 `last_used=Default`，而扩展在 **Profile 3** ⇒ 不带 `--profile-directory`
的启动只会开一个没有扩展的窗口，看起来"唤起了但没用"。

**实测**：`browser_launch` → 5 s 扩展连上；`tabs.list` `count=1 windows=1`；`window.ensure` 已有窗口时
`created:false`（1→1，不乱开窗）。

**更正（实测得出）**：关掉**最后一个窗口**后扩展 SW 被卸载、alarm 也拉不回来 ⇒ **零窗口时扩展无法自愈**，
只能外部拉起。因此上面那条运维配置是"唤起"能否work的前提。详见 `dsh-browser-unified-src/SOURCE-NOTES.md`。

## 2026-09-28 核查：扩展会**自动"同意"** JS 对话框（实测确认，含两条修正）

**结论：说法成立**，而且是策略驱动的，不是偶发。实现：`background.js` 里 `dialogPolicy` 默认 `'accept'`；
收到 CDP `Page.javascriptDialogOpening` 就回 `Page.handleJavaScriptDialog{accept: dialogPolicy==='accept', promptText: params.defaultPrompt}`。

**实测**（自建探针页 `fixtures/dialog/probe.html`，让页面把**返回值**记进 DOM 再读回，不是靠推断）：

| 页面调用 | 实际返回值 | 证据 |
|---|---|---|
| `confirm('确认吗？')` | **`true`** | 页面自记 `[confirm=true]`；`click` 返回 `dialogsAnswered=1` |
| `prompt('输入点什么')` | **`""`** | `[prompt=""]` |
| `prompt('输入点什么','预设值')` | **`"预设值"`** | `[prompt2="预设值"]` |
| `alert('提示')` | 自动关闭、页面继续 | `[alert="returned"]` |

**修正 1**：`prompt()` **不是"总返回空串"**，而是返回**页面自己给的默认值**（扩展把 `promptText: params.defaultPrompt` 传下去了）。

**修正 2（更重要）**：策略可关，且**关掉之后会把标签页卡死**——

| 策略 | 实测 |
|---|---|
| `accept`（默认） | confirm→true（如上） |
| `dismiss` | confirm→**false** ✅（覆盖机制有效，`dialog` 命令可切） |
| `manual` | 对话框保持打开 → **`click` 8s 超时，之后连 `eval 1+1` 都超时**；桥**没有"回答已打开对话框"的命令**，只能 `tabs.close`（实测可救）或人工点 |

⇒ 纪律（与另一个会话记的一致）：**不要驱动可能弹 JS confirm 的页面**；自动化的"确定"是页面自己收到的，无法分辨。
**缺口**：`manual` 下无路可退，建议给 `dialog` 命令加 `answer: accept|dismiss`（CDP `Page.handleJavaScriptDialog`），待定。
**适用范围**：只对扩展**已 attach** 的标签页生效（事件来自该 debugger 连接）。

## 2026-09-28（续）对话框：补齐 `answer` + 默认行为可配置（扩展 1.0.14 / buddy 0.5.0）

**背景**：上一节实测出缺口——`manual` 档下对话框一开，桥没有任何"回答已打开对话框"的命令，只能关标签页。

**改动**

| 位置 | 内容 |
|---|---|
| 扩展 `dialog` 命令 | 新增 `answer: accept\|dismiss` → CDP `Page.handleJavaScriptDialog`（与自动应答同一 API；`tabId` 省略时用最近一次对话框记录的标签页）；新增 `persist: true` 把 `policy` 写进 `chrome.storage.local` |
| 扩展默认行为 | `DEFAULT_CONFIG` 升 **v4** 加 `dialogPolicy`（默认 `accept`）；`loadConfig()` 启动套用、`storage.onChanged` 实时同步 |
| popup | 「高级」新增下拉：自动确定 / 自动取消 / 不处理 |
| buddy 0.5.0 | `browser_tools action=dialog`：查看策略 + 最近记录；`policy=…`（可 `persist=true`）；`answer=accept\|dismiss` 解卡（manual 档返回里带解卡指引）。不新增工具名 |

**实测（探针页 `fixtures/dialog/probe.html`）**

```
① 默认 policy=accept
② 切 manual → click #b-confirm：6.0s 超时；随后 eval 1+1：8.0s 超时   ← 卡死复现
③ dialog {answer:"accept"} → 0.0s，answered={tabId, as:accept}
④ eval 1+1 → 2（0.0s，立刻恢复）；页面自记 [confirm=true]
⑤ dialog {policy:"dismiss", persist:true} → policy=dismiss；点 confirm → 页面自记 [confirm=false]
```

**注意**：≤1.0.13 收到 `answer` 会**静默忽略**（不报错也不动作），所以判读要把扩展版本一起看。

## 2026-09-28 反复出现的坑：重载扩展后 SW 不启动，直到有"窗口事件"

三次实测同型：`edge://extensions` 点「重新加载」后，桥侧 `extensionConnected=false` 且**扩展不尝试连接**；
扩展自己的 storage 是干净的（只有 `lastKnownPort`，`autoConnect` 未设=默认 true、port/token 未设=默认 9777/dsh-local）
⇒ **不是配置问题，是 service worker 没被启动**。扩展依旧装着（Profile 3 / `location=4` / 路径 `D:\edge-extensions\...`）。

**恢复手段（实测有效）**：`browser_launch` → 开一个 Profile 3 窗口 → **4~5 秒**后扩展连上。
**根治手段（可选）**：把 buddy 的 `autoLaunchOnToolUse` 打开 → 下一次 `browser_*` 调用发现未连接就自动拉起。

## 2026-09-28（续）「调用即自动拉起」打开 + 做成真设置（buddy 0.6.0）

**用户决定**：打开它，且**设置要可调**。

**改动**

| 项 | 内容 |
|---|---|
| 设置命名空间 | buddy 新增 `browser-buddy` 命名空间（schemastery schema）：`enabled / layeredTools / autoLaunchOnToolUse / autoLaunchWaitMs / enabledGroups / browserExe / browserProfileDir / bridgeToken`；`settings.register(ns, Config, {base: config})` → **用户层覆盖 patch 配置**，`scope.watch` 实时套用 |
| 持久化 | `browser_tools action=auto_launch value=…` 与 `action=enable/disable group=…` 现在会 `settings.update()` **写进设置文档**（返回文案里注明"已写入设置，重启后仍生效"） |
| 等连上再放行 | 闸门拉起浏览器后**轮询等扩展连上**（`autoLaunchWaitMs`，默认 8s）再放行 —— 否则"调用即自动拉起"是假承诺（第一次调用照样会因"扩展还没连上"失败） |
| 默认 | patch 行改成 `autoLaunchOnToolUse: true` |

**实测**

```
① browser_tools action=auto_launch value=true
   → 返回「调用即自动拉起 = 开（已写入设置，重启后仍生效）…」
   → ~/.dsh/settings.yaml 出现:
        browser-buddy:
          autoLaunchOnToolUse: true
② 制造故障态：tabs.close 关掉唯一标签页 → 扩展掉线（extensionConnected=False）
③ 只调一次 browser_read（无参数）→ 成功返回 " (about:blank) [text, 0 chars]"
   注入行：拦到的 browser_* 调用 2 次，已拉起 1 次；扩展已连接（1.0.14）
```

⇒ 以后那种"重载后 SW 不动"的状态，**一次普通工具调用就会自动开窗并等它连上**，不需要人工介入。

## 2026-09-28（续）buddy 有了 GUI 设置分区 + 一条 Cordis 坑（0.7.1）

**做了什么**：给 buddy 加**客户端半区**（`client/client.js`，手写 `window.__ModuleLoader__.load({id:'dsh-browser-buddy', factory})`），
在 DSH 设置里注册独立分区「**浏览器工具面**」（`settings.section`，id `browser-buddy`，order 61，紧跟插件的「浏览器插件」之后）；
分区通过 `ctx.settingsScope.bind({namespace:'browser-buddy'})` 读写宿主命名空间，字段：启用 / 工具面分层 / 常驻展开的组 /
调用即自动拉起 / 拉起后等待毫秒 / 浏览器可执行文件 / profile 目录。
为此 buddy 从"普通依赖 + profile patch 行（file URL）"改成**正规 bundle 层**：包内 `cordis.patch.yml` 自带 insert 行、
`dsh.bundle` + `dsh.client` 声明、profile 的 `bundles` 列表加入 `dsh-browser-buddy`，并把原先那条 profile insert 撤掉
（否则 `duplicate loader entry id`）。代价：**bundle 层改代码必须重启**，不能再靠 `?v=N` 热换。

**实测（重启后）**：设置侧栏出现「浏览器工具面」（`浏览器插件` 之后）✅；分区渲染正常、console 无报错 ✅；
但**读到的值是空的/默认的**（`常驻展开的组` 为空、`调用即自动拉起` 未勾、两条路径为空，只有 `autoLaunchWaitMs` 是 schema 默认 8000）。

**根因（Cordis 坑，写死）**：宿主半区里用 `ctx.get('settings')` 拿不到 settings 服务 —— **Cordis 的 Guard 会拒未声明的依赖**，
返回 undefined（静默），于是命名空间没注册、客户端只能绑到空 scope；而 buddy 的 `inject: ['systemPrompt','tools']` 里没有 settings。
正解是照已装插件的写法：`ctx.inject(['settings'], (sctx) => { scope = sctx.settings.register(ns, Config, {base: config}); … })`。
→ **0.7.1 已修**（`applyResolved`/`scope.watch` 一并移进回调）。
教训：**`ctx.get(name)` 只对"当前 scope 可见"的服务有效；可选但有依赖关系的服务要用 `ctx.inject([...], cb)`**。

## 2026-09-28（续）设置面收敛：撤掉 buddy 那一栏 + 唤醒单一来源 + 浏览器页精简（buddy 0.8.3 / 插件 0.8.5）

**用户的判断**：「为什么要单独开一栏？这完全可以融入现有设置项」——对。DSH 的 `settings.section` 是
**一个注册方 = 一个导航页**，buddy 是独立插件，我给它注册了自己的页，于是侧栏平白多一栏。
顺着这句话把两边的字段对了一遍，重复是真的（buddy 8 个字段里 4 个与 `browser-bridge` 重复）：

| buddy 字段（0.7.x） | 已有的同一份 |
|---|---|
| `enabled` | `browser-bridge.enabled` |
| `browserExe` | `browser-bridge.autoLaunchBrowserExe` |
| `browserProfileDir` | `browser-bridge.autoLaunchProfileDir` |
| `bridgeToken` | `browser-bridge.token` |

而且是**同值两处维护**：msedge 路径与 `…\User Data\Profile 3` 同时写在 buddy 的 `cordis.patch.yml`（base 层）
和 `settings.yaml` 的 `browser-bridge:`（用户层）。今天两边一样所以没炸，但在设置页改 profile 时，
buddy 那份不跟着动 —— 拉起的窗口就落在没装扩展的 profile 上（"唤起了但没用"的经典现场）。

**改法（buddy 0.8.0 → 0.8.3）**
1. 删掉 `settings.section` 注册与整个独立分区；改用 DSH 给「不需要独立页的设置」预留的加法座位
   `settings.general.item` —— 本插件的旋钮作为**一行**并入「通用设置」（与 Composer Enter 那种行并列），
   行内：`工具面分层` 开关 + `常驻展开的组` 输入。**侧栏不再多一栏。**
2. 只保留真正属于自己的 4 个键：`layeredTools / enabledGroups / autoLaunchOnToolUse / autoLaunchWaitMs`。
3. 端口/令牌/exe/profile/启用开关全部改成**读** `browser-bridge`（`settings.get` 或新服务），不再镜像。
4. **唤醒动作改为调用桥插件新提供的 `browserBridge` 服务**（插件 0.8.2 `ctx.provide`）：buddy 里那套
   `browserCandidates/spawnBrowser`（约 50 行）整块删掉。桥插件才知道 exe/profile/临时干净实例/sideload 怎么拼，
   也知道「扩展连着但一个窗口都没有」该走 `window.ensure` 而不是起进程 —— 一份实现，不可能漂移。
   服务缺失（老版本桥插件）时明确回落：提示模型直接调 `browser_launch`，不假成功。

**改法（插件 0.8.5，页面精简 —— 用户点的两条 + 我顺着找的）**
| # | 改动 | 理由 |
|---|---|---|
| 1 | 砍掉「网络预设」整行 | 三档分域（外网/局域网/本机）才是真控制面；`urlMode` 只是它们的默认值。键保留（老设置继续生效），不再露出 |
| 2 | 三档各带自己的「允许临时授权」开关 | 6 行 → 3 行；同一域的授权与临时授权在一处看得见 |
| 3 | 端口行改「起始端口」+ 说明 | 被占自动顺延 +1…+9，扩展与页面都会自动探测，不必与扩展里填的一致 |
| 4 | **新增「本地桥」页面侧只读探测行** | `/api/status` 是唯一带 CORS 的只读端点（写类端点 2026-09-25 起不发 CORS 头），所以设置页能**自己**并行探 10 个候选端口并显示「端口 / 扩展是否连接 / 扩展版本」，不需要新增宿主通道，也不碰安全边界 |
| 5 | 新增「自动拉起浏览器」卡 | 断线看门狗 + 模型调用时唤醒共用同一套目标配置（exe/profile）；buddy 那两行也在这里 |
| 6 | 新增「高级」卡 | askMode / 配置文件名称 / 临时干净实例 / sideload 目录 / 截图目录 / registry 目录收进去 |
| 7 | 卡片默认折叠、文案统一 | 首屏只剩：探测行 + 常规 + 访问控制 |

**一处刻意的耦合（写下来免得以后忘）**：的「自动拉起」卡里那两行（模型调用时唤醒 / 拉起后等待）
绑的是**同伴件的命名空间** `browser-buddy`（`settingsScope.bind`）。同伴件没装/没注册时该 scope 的
status='unavailable'，那两行自动不出现 —— 本页不 import 它，也不要求它先加载。

**验收（不重启就能做的）**
- `tests/render-settings-pages.mjs`（buddy 仓库）：用最小 React 桩静态渲染两个 client 半区，**20/20**
  —— 覆盖：预设行消失、探测行出现、3 个临时授权开关、新卡出现、同伴 ready/unavailable 两种情况下的行数、
  buddy 只注册 `settings.general.item`（不再有 `settings.section`）、探测真的打 10 个候选端口且能解析出
  「127.0.0.1:9778 扩展已连接 1.0.14 + 已自动顺延」。
- `tests/buddy-wake.mjs`：用最小 Cordis 桩驱动 `tools/pre-execute` 与 `browser_tools`，**10/10**
  —— 服务在位调 `wake()` 一次、服务缺失回落提示、桥停用不唤醒、`action=auto_launch` 仍写入命名空间、
  状态文本里的唤醒目标来自 `browser-bridge`。
- `dsh --profile web --dump-config` → exit 0，`browser-bridge` 与 `browser-buddy` 两行都在。
- **待重启复验**：通用设置里那一行、浏览器页新结构、以及「模型调用时自动拉起」开关**写入落盘**。

**补丁**：`dsh-browser-unified-src/source-changes-2026-09-28.patch`（含 `ctx.provide` + 页面重写 + registry de-021..de-026 + 版本号 0.8.1→0.8.5，含 de-021..de-027），
**必须在 `source-changes-2026-09-27.patch` 之后应用**（同一文件 `src/index.ts` 都有改动），已在临时树上验证
「apply 后与工作副本逐字节一致」。老机同步照旧攒着（FTP 现在关着）。

## 2026-09-28（续）「DSH 页面地址 = 127.0.0.1:* 是不是把本地拦了？」→ 改为宿主推导（插件 0.8.5）

**用户的问题**：「怎么 DSH 的配置值是 `127.0.0.1:*` 呢？这样不就是拦截本地了吗？」

**答**（对着 `core/src/url-policy.ts` 核过）：这个键是**登记表**——「哪些地址算本 DSH 控制页」，
不是网络/分域过滤器。`dshRule()` 命中后：`dshAccessEnabled: true` → **放行**（跳过域审批）；
关 → 拦（`WEB_DSH_DISABLED`）。规则顺序：红线（denyHosts/元数据）→ **DSH 规则** → 分域授权。
所以现在（开着）本机是**被放行**的，不是被拦。回环别名 `127.0.0.1`/`localhost`/`::1` 会归一成同一
endpoint；`host:*` = 该主机任意端口 —— 于是 `127.0.0.1:*` 的真实含义是「本机任意端口都算控制页」：
开着时过度放权，关掉时过度拦截（本机所有端口都被当 DSH 页拦）。**这个值是我上次填的**
（当时 `http://127.0.0.1:*` 被校验拒了，我图省事改成合法的通配形式）。

**用户接着点出关键**：「之前不是有个能探测实例端口的方法吗？不一定是 3080」。对 —— 但要分两件事：
- **桥端口**（9777…9786）确实要探测（扩展端 + 宿主端 + 设置页三方同构）；
- **GUI 端口**不需要探测：宿主进程自己就知道，`webServer` 服务里就有（`config.port=0` 时是 OS 分配的
  实际端口）。所以正解是**推导**，不是登记、也不是探测。

**改法（0.8.5）**：插件激活时 `ctx.inject(['webServer'])` 读实际端口 → 把
`http://127.0.0.1:<port>` 合并进生效的 `dshOrigins`（**不写进用户设置**）；用户列表降级为「额外地址」
（局域网 IP / 域名 / 反代）。`describePolicy()` 与 `policyKey` 用合并后的列表，端口变化即重建策略；
缺服务时静默退回「只认用户列表」。顺手把 `settings.yaml` 里的 `127.0.0.1:*` 收窄成
`http://127.0.0.1:3080`（当前真实 origin）。页面文案同步：DSH 行显示「本机控制页地址（宿主自动识别，
无需登记）」+ 列表改称「额外地址」+ 说明列表用途。

**实测**：
- 改 `settings.yaml`（外部编辑）后，运行中的 0.8.3 实例立刻反映：
  `browser_policy_status` → `DSH 页面访问: 开（http://127.0.0.1:3080）` —— 设置文件的 watch 生效 ✅
- **重启后要复验的一项**（需要 0.8.5 才有的行为）：`browser_policy_status` 里应出现
  `http://127.0.0.1:<实际端口>`，而 **settings.yaml 里没有这一条**（证明是推导来的）。

**另外两件现场发现**（都不是本次改的内容）：
1. **浏览器窗口最小化时，扩展拒绝一切真实鼠标/键盘输入**（`browser window is minimized — real keyboard/mouse
   input cannot reach a 0x0 viewport`）。这是对的行为（自动化不改窗口尺寸/位置），但意味着 GUI 里的点击验收
   需要用户先把窗口恢复。本次 GUI 复验因此只做到「读」这一层。
2. `browser_frame_eval` 在**没有子 frame** 的页面上报 `frame not found: main（候选: ）` —— 顶层文档没有"帧"
   可指。已让 buddy 把这句错误改写成可行动的指引（「顶层文档请用 browser_evaluate，属于 debug 组」），
   buddy 0.8.3。

## 2026-09-28（续）提醒用户「模型需要你在电脑上动手」：browser_notify + 帧级浮层 + 系统通知（buddy 0.9.1）

**用户的要求**：「加个通知事件，提醒用户模型需要操作配置（模型主动发起通知），需要用户恢复窗口」。

**现状的痛点**：模型撞上「浏览器窗口被最小化 → 扩展拒绝真实鼠标/键盘输入」这类墙时，只能在错误里
反复试或干脆放弃，用户那边什么都没发生（他甚至不知道自己该动手）。

**三条送达路径**（都实现）：

1. **模型主动**：新常驻工具 `browser_notify {text, kind, clear}`（`kind`: window/login/captcha/config/other）。
   常驻是刻意的 —— 藏进分组的话，模型在最需要它的时刻反而看不到它。
2. **自动**：`tools/post-execute` 里匹配已知症状（`window is minimized` / `no browser extension connected` /
   `manual` 对话框卡住）→ 自动发同格式提醒。契约里写明「抛出的工具也会带着错误到达这个 waterfall」，
   所以失败调用看得见。同症状 60s 内只发一次（不刷屏）；**只有自动提醒**会在下一次 `browser_*` 调用成功后自动收起
   （模型主动发的要模型自己 `clear=true`，免得被别的成功调用误清）。
3. **送达**：客户端半区新增 `shell.overlay` 条目（id `browser-buddy-notice`，order 90）。
   该座位是帧级浮层（`dsh-market-toast` 也在这里占一格），页面任何位置都看得见，层本身 click-through、
   卡片自己开 `pointer-events`；卡片带分类标签、文案、「知道了」和（未授权时）「允许系统通知」。
   授权过就同时发浏览器 **系统通知** → **窗口最小化时这才是能看到的那一个**（正好对上用户说的场景）。
   去重用 `attentionAt` 时刻戳而不是 id（插件重启后 id 会从头开始）。

**通道**：宿主→页面没有专用事件通道（远端事件由 API 网关挑选投射，第三方插件加不进去），所以借
`browser-buddy` 命名空间的 5 个短键（`attentionId/Text/Kind/At/Visible`）传递 —— 客户端订阅 settings 镜像，
快照一变就重渲染。代价：设置文档里会短暂出现这几个键；`clear` 时把文案清空，别把用户设置当日志用。
`scope` 不可用时 `browser_notify` 会**如实**返回「送不到页面，请改为在回复里直接告诉用户」。

**状态行**也加了一句：提醒可见时状态里出现「正在等用户操作（第 N 次提醒）：…（处理完用 browser_notify clear=true 收起）」，
模型下一轮就知道自己还在等人，不会假装无事发生。

**验收**：
- `tests/buddy-wake.mjs` **21/21**：主动提醒写入 5 个键、缺 text 明确报错、clear 收起、
  窗口最小化症状自动提醒、同症状去抖、`browser_*` 恢复后自动收起、`browser_notify` 在分层下**常驻**。
- `tests/render-settings-pages.mjs` **26/26**：客户端注册 `settings.general.item` + `shell.overlay` 两个座位
  （仍**不**注册 `settings.section`）、有提醒时浮层渲染出文案与分类、无提醒时什么都不画。

**边界（写清免得当成 bug）**：GUI 页面没开着 → 浮层和系统通知都到不了（宿主侧只写了设置文档）；
系统通知需要用户在提示卡上点一次授权。要更硬的送达（页面关着也能弹）得上 Windows 侧通知，未做。

## 2026-09-28（续）提醒功能上线验收（buddy 0.9.3）+ 两个真缺陷 + 一条加载器事实

**验收结果（真机，截图 `~/dsh-browser-shots/2026-09-28T10-48-00-655Z-yg3g.png`）**：页面顶部出现常驻提醒卡
「需要你在电脑上操作 · 窗口 / 浏览器」+ 文案 + 「知道了」+「允许系统通知（窗口最小化也能看到）」。
宿主侧链路同时可见：`settings.yaml` 的 `browser-buddy` 段写入 `attentionId/Text/Kind/At/Visible`，
buddy 状态行出现「正在等用户操作（第 N 次提醒）：…」。

**缺陷 1（客户端，已修，0.9.2）**：`shell.overlay` 的 **ownerProps 是空的** —— 该座位不保证调用注册处的
`inject` 面（已占据它的 `dsh-market-toast` 也没用 inject）。原写法靠 `inject: () => ({scope})` 拿数据，
真机上会拿到 undefined 一渲染就炸，而这个座位在**外壳层**，砸了影响面不小。
→ 改成注册处**闭包**直接把 scope 给组件（+ 组件内 `if (!scope) return null` 兜底）。
教训：**别把 `settings.section` 的 inject 用法套到所有 list 座位上**，要看该座位 catalog 的 `ownerProps`/`slotInject`。

**缺陷 2（宿主，已修，0.9.3）**：自动提醒的解除条件原本是「任何 `browser_*` 调用成功」，于是
最小化窗口上的一次 `browser_policy_status`（只读，照样成功）就把「请恢复窗口」的提醒顶掉了 ——
障碍还在，提醒先没了。→ 改成**回到撞墙的那一类调用**：记录失败工具所在分组，只有同组调用成功才解除。
模型主动发的提醒仍然只由 `browser_notify clear=true` 解除。

**一条加载器事实（写死，省得以后再查）**：客户端 bundle 是**页面加载那一刻**按
`/plugins/??<modules>&rev=<hash>` 取的，服务端重启/换包**不会**换掉已在跑的页面 ——
必须 `location.reload()`（或用户 Ctrl+Shift+R）。
另：用 `setTimeout(() => location.reload(), 300)` **不生效**（eval 上下文里的定时器不留存），
直接 `window.location.reload()` 才有效（实测页面年龄从 4900s 变 2.4s、`__DSH_BOOT__.rev` 批次重新拉取）。
验证页面新旧的可读信号：`performance.now()` 页面年龄、`performance.getEntriesByType('navigation')[0].type`、
`window.__DSH_BOOT__.{rev,batches[].rev}`、以及自己埋的全局变量是否还在。

**控制页地址推导（0.8.5）真机确认**：把 `settings.yaml` 里的 `dshOrigins` 整条删掉后，
`browser_policy_status` 仍报 `DSH 页面访问: 开（http://127.0.0.1:3080）` —— 这个 origin 来自
`ctx.inject(['webServer'])` 读到的实际监听端口。手工列表从此只用于额外地址。

## 2026-09-29 另一会话的实测反馈 → 复核 + 一批修复（插件 0.8.9 / buddy 0.9.4）

用户把另一个会话（奇安信 DSH 报告扫描）的现场引过来。**逐条自己复现，不照抄结论**：

### 一、确认是真 bug，而且是**一类**（de-028）

`browser_network_log` 只回 `Tab X: N of M network requests`、**零条记录** —— 根因不在抓包：
工具把数据放在结构化 `value` 里，`render` 只回一行摘要。同类一摸一串：

| 工具 | 原来的 render | 后果 |
|---|---|---|
| `browser_snapshot` | `N interactive elements on T; click or fill them by ref.` | **ref 全丢** —— ref 正是它存在的理由（我自己这轮就撞上，被迫改用 eval 绕） |
| `browser_console_log` | `Tab X: N of M console entries` | 条目全丢 |
| `browser_network_log` | `Tab X: N of M network requests` | 条目全丢（就是被投诉的那条） |
| `browser_evaluate` | `value.json.slice(0, 300)` | 长结果被硬砍（对方测到 ~250） |
| `browser_tabs` | `JSON.stringify(value).slice(0, 400)` | 列表被切一半 |
| click/type/press/scroll | `JSON.stringify(value).slice(0, 300)` | 小结果也顺手砍 |

修复：五处改成把载荷交给模型 + 统一 `textBlock(text, max=20000)`（**截断必须写在文本里**，
不静默丢），并新增回归测试 `tests/tool-render.mjs`（加载构建产物、假 ctx、喂合成 value 断言
载荷真的出现在文本里，**16/16**）。这类缺陷不报错、只静默变废，所以必须由测试钉住。

### 二、`No tab with id` 的根因在宿主（顺手修）

对方抱怨"传错 tabId 只回一句 No tab with id、不列可用 id"。查证：那句来自扩展，但**宿主
`currentTabUrl()` 查不到指定 id 时会静默退回 `tabs[0]`** —— 于是授权判在了*另一个*标签页上，
真正的命令再由扩展报错。改成：指定了 id 就查不到时**明确报错并列出可用 id**（含 active 标记）。
不用改扩展。

### 三、两个"使用坑"落进工具描述（比落进文档有用）

- `browser_navigate`：SPA/微前端常在本次返回之后才渲染正文 —— 拿到标题不等于内容就绪。
- `browser_evaluate`：`history.pushState` 只改 URL、**不会**触发 SPA 重渲染（对方实测把 A 通告的
  受影响版本安到 B 头上，靠"页面身份自证"才发现）；换页要用 `browser_navigate` 且抽取前核对身份。

### 四、我自己的噪声（de-029）—— 对方的投诉成立

`browser_notify` 那条「请恢复窗口」被**每一轮**注入运行时上下文、**跨会话可见**、还写进持久设置重启仍在。
根因：我把提醒塞进了 `ctx.systemPrompt.context`（进程级、所有会话共用）。修复：

- 从全局上下文里**删掉**提醒行，改为 `browser_tools action=status` **按需拉取**；
- 新增 `attentionTtlMs`（默认 900s，0=不过期）：到点自动收起并清空文案；
- 激活时若已存提醒已超 TTL → 立刻丢弃（重启不复活陈提醒）；
- 去掉"第 N 次提醒"这种全局计数注入。

页面浮层与宿主→页面通道（`browser-buddy` 命名空间的 `attention*` 键）不变。
buddy 测试补两段：提醒不进上下文/能按需拉取/TTL 生效、重启丢弃过期提醒（宿主 **26/26**、客户端 **27/27**）。

### 五、对方提到但我**没有**当成插件 bug 的

- "桥会自动点掉 JS 确认框"：已知设计（dialog 策略默认 accept），属**纪律问题**：涉及确认框的页面
  我不驱动。不是这轮要改的。
- "登录墙 / 一样要人登录"：站点行为，不是插件缺陷。
- "普通用户能不能读"：对方实测**能读全文、无付费墙**，这是好结论，记下来。

补丁 `source-changes-2026-09-28.patch` 已更新为 0.8.1 → 0.8.9（含 de-021..de-029），
临时树上验证 apply 后逐字节一致。

## 2026-09-29（续）通知撤除 + 注册表二分（插件 0.9.1 / buddy 0.10.0）

### 一、通知功能撤除（de-031）

用户裁定：通知**不该长在浏览器插件里**（既噪声又占 token，还跨会话泄漏）——「到时候专门写个插件来
方便模型通过多渠道提醒用户」。撤除面：buddy 的 `browser_notify` 工具、`attention*` 设置键、`shell.overlay`
浮层、TTL/自动提醒钩子，以及 `settings.yaml` 里已写入的那些键。需求转交未来的通知插件。
（撤除前那轮已把"不进全局上下文 + TTL + 重启丢弃陈提醒"做完并验证，这次是整体拿掉。）

### 二、注册表二分（de-030）

用户指定：**浏览器插件注册表分两部分**——
1. **`registry/design/registry.json`**：功能对齐与计划（既有 de-XXX，不动）；
2. **`registry/issues/issues.json`**（新）：**调用时的问题**。

第二部分的用法（就是用户要的三条）：

| 场景 | 行为 |
|---|---|
| 模型在**会话里首次**调用 `browser_*` | buddy 挂**一次**摘要：仍存在的问题 + 各自**绕行方案**（`additionalContexts`，一次会话一次，不给每轮加 token） |
| 问题**已修复**，而某会话在**修复前调用过**、现在是修复后首次调用 | 摘要里多一段「你上次调用之后修复的」，该会话**撞到过**的条目前面标 `★` 定向告知 |
| 要看**完整内容** / 记录新问题 | `browser_issues`：`summary`（默认，要点）/ `list` / `show [id]`（症状/证据/历史）/ `add` / `resolve`；**写入需用户审批（fail-closed）** |

实现要点：
- 「撞到过」的判据是条目里的 `match` 正则 —— 每次 `browser_*` 调用的结果/错误文本拿去比，命中即记；
- 会话标记（`hits` / `knownFixed`）落在 `$DSH_HOME/browser-buddy/session-issues.json`，**跨进程**，
  所以「修复（=换版本重启）前后」能被认出来；新会话只拿 open 摘要，**不**被误告知修复（它压根没在修复前调用过）；
- 登记簿由桥插件通过 `browserBridge.issues()` / `.version()` 提供，buddy 不碰文件路径；老版本桥没有这两个方法就静默跳过；
- 已录 8 条：`bi-001`（snapshot/console/network 只回计数，0.8.6 修）、`bi-002`（evaluate 砍 300 字符，0.8.6 修）、
  `bi-003`（tabId 静默退回 tabs[0]，0.8.8 修）、`bi-004`（SPA 导航早返回）、`bi-005`（pushState 不重渲染）、
  `bi-006`（JS 对话框被自动 accept）、`bi-007`（窗口最小化时真实输入不可达）、`bi-008`（提醒跨会话残留，buddy 0.9.5 撤除）。
  **open 项必须带 workaround、fixed 项必须带 fixedIn** —— 测试里有这两条不变量断言。

### 三、验收

| 测试 | 结果 |
|---|---|
| `tests/tool-render.mjs`（桥插件 26 项） | **26/26** —— 含 `browser_issues` 的 summary/list/show、`show` 找不到报错、**无审批服务时写入 fail-closed**、open 项必有绕行/fixed 项必有版本 |
| `tests/buddy-wake.mjs`（buddy 宿主 24 项） | **24/24** —— 含首次调用挂摘要、消息形状=插件来源 user 消息、同会话第二次不重发、**修复前踩坑→修后首调用定向告知**、修后新会话不被误告知、登记簿不可用时静默 |
| `tests/render-settings-pages.mjs`（客户端 21 项） | **21/21** —— 浮层相关断言随通知撤除一并移除，仍不注册 `settings.section` |

补丁 `source-changes-2026-09-28.patch` 已更新为 0.8.1 → 0.9.1（含新文件 `registry/issues/issues.json`，
含 registry `de-021..de-031`），临时树上验证 apply 后逐字节一致。

## 2026-09-29（续）补正：提醒触发条件改成「与上次调用相比列表有变化」+ 会话可查可提

用户补正（原话）：「准确的说就是问题列表与上次调用存在变化的时候进行提醒，同时每个会话自己调用的
时候出现了问题都可以查 issue 和提 issue」。

**改法（buddy 0.11.0）**：触发条件从"会话首次调用"改成**指纹比对**——
每个会话持久化「上次调用时的问题列表指纹」（`id → status|fixedIn`，存 `$DSH_HOME/browser-buddy/session-issues.json`）：

| 情况 | 行为 |
|---|---|
| 首次调用（没有基准） | 送 open 全量摘要 + 各自绕行 |
| 列表**与本会话上次调用相比有变化** | 送**变化**摘要：新增条目（带绕行）/ 新修复条目（该会话撞到过的标 `★`）；只有 open 集合变了才重复列 open |
| 列表没变 | **不打扰**（省的正是 token） |
| 调用 `browser_issues` 自己 | 只**静默刷新**指纹，不推（模型正在看内容），避免"自己提了 issue 又被自己提醒" |

**会话级"能查能提"落成可行动提示**：某次 `browser_*` **失败**且症状在登记簿里**没有**匹配时，追加一句
「这个症状不在问题登记簿里：<首行> — 先 `browser_issues action=show` 看已知绕行，确认是新问题就
`browser_issues action=add` 记下来（写入需审批）」；每会话最多 3 次、同症状只提一次（按首行哈希去重）。

**题外话登记**：用户提到这套东西像老机的「爱丽丝记忆插件」，并设想将来专门写一个**像 GitHub 那样
让会话之间协作**的插件（会话=贡献者，早先 PM 构想里经理充当 GitHub 角色）。明确**不属本插件**，
已作为 `de-032`（proposed）登记，以免方向丢失。

**验收**：`tests/buddy-wake.mjs` 段 [11] 重写为 14 条断言（**27/27 总通过**）：首次送摘要 / 无变化不打扰 /
有变化送 delta / 没撞到过不标 ★ / open 未变不重复列 / 撞到过修复后标 ★ / 新增 open 带绕行 /
`browser_issues` 自调用静默且刷新指纹 / 新症状提示一次 / 同症状不重复 / 不同症状再提示 / 登记簿不可用静默。

## 2026-09-29（续）真机验收：问题登记簿送达 ✓，并修掉两个真机才暴露的问题

**验收（本会话真机，全部通过）**
| 项 | 结果 |
|---|---|
| 会话**首次**调用送摘要 | `browser_policy_status` 之后收到完整摘要：4 条 open + 各自绕行 + 结尾指向 `browser_issues` ✅ —— 这条同时证明 `additionalContexts`（插件来源 user 消息）在真实 agent loop 里被接受（此前唯一没法离线验的一环） |
| 列表**无变化**不打扰 | 第二次调用没有任何注入 ✅ |
| 列表**有变化**送 delta | 在**已装**登记簿里把 `bi-004` 改成 fixed（模拟"别处修好了"）→ 下一次调用收到「调用时问题列表有变化 / 已修复：bi-004（0.9.2）」，且**没有**重复列 open ✅；随后把文件按 src 还原（sha256 一致） |
| 会话标记持久化 | `~/.dsh/browser-buddy/session-issues.json` 出现本会话的指纹（`id → status|fixedIn`）✅ |
| `browser_issues` 读 | `action=summary` 正常输出，且**不推**摘要（静默刷新指纹，避免"自己刚提的 issue 又被自己提醒"）✅ |
| 写入 fail-closed | 本会话审批被禁用 → `action=add` **没有落盘**（sha256 复核文件未变）✅ |

**真机暴露并修掉的两条**
1. **`bi-009`（0.9.3）**：审批被禁用时 `approval.request` 会**抛异常**，写入工具把
   `Cannot read properties of undefined (reading 'seq')` 原样丢给模型 —— 拒绝的**实质**成立（文件确实没写），
   但模型看到的是一句天书。抽出 `approvalRefusal()` 助手：服务缺失 / 抛异常 / 未批准三种情况都返回
   「…拒绝写入（fail-closed）；请…重试」（原始异常保留在括号里作诊断）。`browser_design_edit` 同病同治。
   测试补两条（抛异常 / denied → 明确拒绝），桥插件 `tool-render.mjs` **28/28**。
2. **`browser_issues` 原本藏在默认隐藏的 `registry` 组里**（buddy 0.11.1 修）：摘要明确让模型去查/去提，
   而那个工具按分层是看不见的 —— 等于指着一个不存在的入口。已加入常驻白名单（常驻 7 个），
   并加断言「`browser_issues` 常驻（摘要指到的工具必须看得见）」。

## 2026-09-29（续）「读弹窗」：浏览器级权限现状变成模型可读（插件 0.9.4 / buddy 0.11.2）

**起因**：另一会话撞上「本地网络访问」(LNA) 授权气泡 —— 页面 `POST http://127.0.0.1:8791` 时请求挂住，
模型只收到 `eval timeout after 15000ms`，只能自己排查"页面是不是卡了"。用户明示：**先让模型能读弹窗**，
再把"谁来定"（模型逐次决定 / 按配置自动放行或拒绝，如自动允许通知、自动拒绝定位）做成配置项。

**取证（全部离线可复现，未驱动浏览器）**
- 权限类枚举：本机 Edge 154 的 `Preferences → profile.content_settings.exceptions` 有 **124 个类**；
  `default_content_setting_values` **为空** ⇒ 谁都没显式设过，浏览器默认（多为"询问"）在起作用。
- 目击坐实：`loopback_network` 对 `https://ti.qianxin.com` 记 **allow**，`last_modified` = **2026-09-29 14:01:15**
  （= 用户本人点的那一次）；该页 ingest 落盘 14:02:13 / 14:02:19 —— 顺序与"先点允许、后拿到数据"一致。
- 版本事实（解释另一会话报告的错配）：`dsh web` PID 16495 起于 **13:38:59**，而 0.9.3 落盘 13:40:57、
  buddy 0.11.1 落盘 13:41:04 ⇒ 它跑的是 **0.9.2 + buddy 0.11.0**。它报的 `browser_notify` 残留属旧代码；
  而 `network_log 零记录` / `eval ~250 字符截断` 两条**与代码矛盾**
  （0.9.2 的 render 就是按 `value.requests` 逐行渲染；`cmdEval` 全链路无长度上限；插件 render 上限 20000），
  **未入册**，待其停手后真机复验（两条调用即可定案）。

**改动（这一版刻意不动扩展 —— 证据宿主侧全有）**
- `packages/browser-unified-plugin/src/permissions.ts`（新）：读 Preferences 的权限现状 + 受关注类清单（24 个，
  键名取自本机真实枚举，不猜）+ `permissionReport()` 结论文本（放在纯模块里，便于离线测试）。
- `src/index.ts`：新增**只读**工具 `browser_permissions` —— 按 origin 分「会弹窗(询问) / 已允许 / 已拒绝 / 无记录」，
  并给挂起信号：`network.log?status=pending` 里指向本机/私网的未回请求 + 该类是否"询问" ⇒ 结论"气泡在等人"。
- buddy：`browser_permissions` 进**常驻**白名单；命令**超时**失败时给一次性提示（每会话 ≤2 次）指向它。
- 登记簿：`bi-011`（权限气泡不可见 → 超时误导；fixed 0.9.4）、`de-033`（读弹窗，applied）、
  `de-034`（权限策略与决定权，accepted）。

**真机只读读数**（用 `lib/permissions.js` 直读真实 profile）
```
origin = https://ti.qianxin.com      权限存储 = /mnt/c/.../Profile 3/Preferences（改于 2026-09-29 14:16:07；共 124 类）
已允许：loopback_network = 允许，2026-09-29 14:01:15
无记录（走浏览器默认，默认多为"询问"）：25 类 —— local_network_access, local_network, automatic_downloads,
        notifications, geolocation, media_stream_camera, media_stream_mic …
```
真机读数当场抓出我自己一处**措辞假阴性**：「没有显式询问记录」原本写成「受关注类里也没有"询问"项」——
在本机（默认值表为空）会把"一触发就弹窗"说成"不会弹"。已改，并加断言钉死。

**测试**：`tests/permissions-read.mjs` **22/22**（离线夹具；含 `https://host:443,*` 形态、裸 `*` 兜底、
Chromium 时间戳换算、配置错法指引、四支结论措辞、apply() 真注册与 render 载荷）；
`tool-render.mjs` **28/28**；buddy `buddy-wake.mjs` **33/33**；`render-settings-pages.mjs` **21/21**。

**待办（都未做，等用户发话）**
1. 安装 `dsh-browser-unified-0.9.4.tgz` + `dsh-browser-buddy-0.11.2.tgz` 并重启 `dsh web`（会中断在跑的会话）。
2. `source-changes-*.patch` **未重生成**：它是对外部基线树的 diff，本机没有那棵树（`find` 已验证），
   老机可达时连同 0.9.4 一起出。
3. `de-034` 执行侧（`chrome.contentSettings.set` 需给扩展加权限+重载；或 CDP `Browser.setPermission`
   能否经 chrome.debugger 的标签页附件送达）—— 需一次真机可达性验证再定实现。
4. 配置项 UI（「浏览器」分区权限卡）与 decider（ask|policy|model）随 de-034 落地。

### 安装（2026-09-29 21:2x）：0.9.4 + buddy 0.11.2

- **踩到一个操作事实**：`~/.dsh/profiles/web` 里直接 `npm install` 会 **ERESOLVE 失败** ——
  `dsh-better-sidebar@0.19.1` 要 `@deepseek-ai/dsh-agent ^0.1.5-rc.1`，树里是 `0.1.0-rc.8`。
  这与本次改动无关（是既有的第三方 peer 冲突），但意味着**不能靠 npm 重装整棵树**。
- 采用的落地方式：`rm -rf node_modules/<name>` + `tar xzf <tgz> --strip-components=1`（file: 依赖的等价物），
  两个包各自精确替换；无 lockfile（profile 里本来就没有），所以不存在锁文件漂移。
- 装完自检（**用已安装副本**跑，不是跑源码）：`lib/index.js` 能加载、工具数 23、
  `browser_permissions` 在工具面、`lib/permissions.js` 就位、安装包内登记簿含 `bi-011`、
  buddy 侧含常驻项与超时提示。
- 生效仍需**再重启一次** `dsh web`（第一版重启时磁盘上还是 0.9.3/0.11.1 —— 那时我只打包没安装）。
  重启后应看到：buddy 状态行 **常驻 8 个**，且 `browser_permissions` 可直接调用。

### 真机验收（2026-09-29 21:2x，PID 20403，插件 0.9.4 + buddy 0.11.2，扩展 1.0.14）

| 项 | 结果 |
|---|---|
| 状态行 | 「常驻 **8** 个」= buddy 0.11.2 生效 ✅ |
| `browser_permissions` 直调（无参数，只读） | 输出 `origin = https://ti.qianxin.com`、`loopback_network = 允许（2026-09-29 14:01:15）`、`无记录 25 类`、末句是新版措辞「别把"没记录"当成"不会弹"」✅ |
| 首调摘要 | 同一步收到登记簿 delta（`bi-009`/`bi-011` 改动）—— 说明会话首调 + 列表变化的送达路径仍正常 ✅ |
| **超时提示** | `browser_evaluate` 跑 `(async()=>{await new Promise(r=>setTimeout(r,20000))})()` → `eval timeout after 15000ms` + 一次性提示「这次是命令超时…先调 browser_permissions」**原样送达** ✅ |
| 现场复原 | 验收用的 debug 组已收起（工具面回到 frames），设置已回写 |

**验收中顺带发现并登记 `bi-012`（open）**：`browser_evaluate` 描述写「awaited like a promise body」，
但**顶层 `await` 会报** `SyntaxError: await is only valid in async functions…`（顶层分支没包 async 包裹，
`frame` 分支倒是自带）。绕行=`(async () => { … })()`。注意这条也演示了"新症状提示"链路：
那次 SyntaxError 不在登记簿里，插件当场提示「先查绕行、确认新问题就记下来」，我据此登记。

**登记簿落地状态**：`bi-012` 已同时写入源码与**已装包**的 `registry/issues/issues.json`
（sha256 一致 `04f6874905cea1da`）⇒ 已装 0.9.4 的登记簿比 tgz **多这一条数据**，
下次 `build-pack` 会带上；代码层面无需为此发版。

---

## 2026-10-13　两个真机 bug 修复 + 上游角色收敛

### 2026-10-13-a　press 双倍输入（`browser_press` 一次按键插两遍）

**症状**：输入框里按一次 `x` 得到 `xx`；按一次 `Enter` 表单提交两次；`browser_type` 的
`submit:true` 走同一条通道，同样双提交。数字键、带修饰键的字符键全都翻倍。

**根因**（`extension/background.js` 的 `cmdPress`）：CDP 的 `Input.dispatchKeyEvent`
`type:'keyDown'` **带 `text` 时 Chrome 自己就会补一个 char/keypress**（`rawKeyDown` 才不补），
代码在这之后再显式发一条 `type:'char'` ⇒ 一次按键插入两遍。

**修法**：删掉那条多余的 `char` 派发（保留 `keyDown` 带 `text` + `keyUp`）。上游同一个坑
（caob23 issue **#14**）截至 v1.0.15 仍未修，我们这段代码与它逐字相同。

**真机前后对照**（台子：`__pr-d-rig` —— 真 Edge 155（headless=new）+ 真扩展 sideload + 假桥
`stub.mjs`@9781；页面 `/press` 数事件。为我们的扩展线新增 `mk-ext-unified.sh`，stub 为此加了
`/api/status` 让端口自动发现能命中 9781）：

| 场景 | 改前 `UB0`（1.0.90） | 改后 `UC1`（1.0.91） |
|---|---|---|
| 按 `x` | `value="xx"`，keydown=1 **keypress=2 input=2 beforeinput=2** | `value="x"`，keydown=1 keypress=1 input=1 |
| 按 `7` | `value="77"` | `value="7"` |
| 表单里按 `Enter` | **submit=2** | **submit=1** |
| 按 `ArrowRight`（不带 text，对照） | 不插字符、keydown=1 | 同左（未受影响） |

证据：`dsh-browser-unified/rig/evidence-unified-UB0.json`（9 项中 **6 项失败**）与
`dsh-browser-unified/rig/evidence-unified-UC1.json`（**9/9 通过**）；场景脚本 `unified-bugs-real.mjs`。
台子已收（`rig edge killed: 16; left: 0`，stub 停）。

**顺带发现、本次不动**：`Shift+X` 落成小写 `x` —— `text` 直接取 `key` 原文，没有按 shift 提大写。
这是独立的小瑕疵（不是本次双倍输入那条），先记在这。

### 2026-10-13-b　`browser_emulate` 空 UA 打穿输出契约

**症状**：`device:"desktop"`、或只给 `width`/`height` 的自定义视口**每次调用**都抛
`ToolOutputError`；只有带真 UA 的预设（mobile/tablet）能过 —— 所以坏了很多版都没暴露。

**根因**：扩展在无 UA 覆盖时回的是**显式** `userAgent: null`
（`extension/background.js` 的 `userAgent: userAgent || null`），而宿主的输出校验器对 `null`
**会下钻判类型**（只跳过 `undefined`）。插件把回包原样透传 ⇒ 校验失败。
上游在 v1.0.14 修的是同一条。

**修法**：新增导出纯函数 `normalizeEmulateValue()`（`packages/browser-unified-plugin/src/index.ts`），
`browser_emulate` 的 execute 改为逐个字段按类型收口、null/缺字段一律不落进结果（与上游同法）。

**验证**：
- `tests/emulate-contract.mjs` **12/12**（新增）：用**宿主自己的校验器**
  （`@deepseek-ai/dsh-tools` 的 `valueSchemaSpecToJsonSchema` + `validateJsonSchemaValue`）跑两份值 ——
  ① 真机回包原样 → `"value.userAgent" must be a string`（阳性对照，证明这条测试会在旧行为上失败）；
  ② 归一化后 → 无违规。另覆盖"带真 UA 的预设不能被丢掉"与 reset 回包。
- 真机确认前提：rig 里 `emulate {device:"desktop"}` 的回包确实是
  `{"tabId":…,"width":1280,"height":800,…,"userAgent":null}`（**显式 null，不是缺字段**）。

### 2026-10-13-c　版本与部署

- 扩展 `manifest.json` **1.0.19 → 1.0.20**（真源只有 manifest 一处）。两份副本同步改：
  仓库 `extension/` 与装机旁那份 `projects/dsh-browser-unified/extension/`（逐字节一致）。
- ⚠️ **Edge 里那份要重新加载才生效**：现在跑的还是 1.0.19（`browser_tools status` 里看得到）。
  插件包侧的改动（emulate 归一化、role 过滤）要重新 `build-pack` + 安装才进 live —— 未做，等指示。

### 2026-10-13-d　上游角色收敛（除名）

- `upstream-baseline.json` 每个来源加 `role`：`caob23`＝**merge**（唯一持续合并源），
  `xylt369` / `kyo615` / `webops`＝**reference**；**前身 `dsh-intranet-browser` 从 `repos[]` 除名**
  （它是主人自己的仓库、2026-10-10 已在 GitHub 归档只读，是本插件的上一代而非外部上游）。
  条目 5 → 4。
- `scripts/check-upstream.ps1` 只对 `role=merge` 做漂移自检（reference 打一行 `SKIP` 就跳过，不 clone）；
  `-UpdateBaseline` 同样只推进 merge 档。**实测**（Windows PowerShell 5.1）：三个 reference 各回
  一行 `SKIP`，`caob23` 走到 clone 并按预期报 `UNREACHABLE`（本机 github.com 不可达）。
- `browser_check_update` 同规则：默认只查 merge，被跳过的 reference 在报告里点名
  （显式传 `repos:[<id>]` 仍可单独查）。`tests/registry-consistency.mjs` 新增 `[5]` 段 5 条断言
  （含"缺 role 的老条目按 merge 处理"），全量 **23/23 通过**。
- `NOTICE.md` / `README.md` 口径改成「四个第三方上游 + 本项目前身」；`NOTICE.md` 写明
  `role` 三档语义与除名理由，前身那行标注"不是上游"。

### 2026-10-13-e　发布 0.11.21（自用版）

把上面两个修复做成一个正式版本，顺手清完了内务。

| 包 | 版本 | 变化 |
|---|---|---|
| `dsh-browser-unified` | 0.11.20 → **0.11.21** | `normalizeEmulateValue()`；`browser_check_update` 按 `role` 过滤并点名被跳过的参考来源 |
| `browser-unified-core` | 0.1.4 → **0.1.5** | `RepoRole` / `repoRole()` / `RepoReport.role` / `CheckSummary.skippedNonMerge` |
| `dsh-browser-unified-mit` | 0.1.0 → **0.1.1** | 跟进 core 的 self-update 增量（G3 闸门：只比代码行） |
| 浏览器扩展 `extension/` | 1.0.19 → **1.0.20** | 删掉 `cmdPress` 里多余的 `char` 派发 |

**内务清单（本轮一并清掉）**

1. 文档里"16 个 `browser_*` 工具"是 v1.0.7 时代的旧数字 ⇒ 改成实际的 **27 个**（README 两处；
   NOTICE 那处保留"当时 16 个"的历史口径并补一句现为 27）；
2. "五上游"口径 ⇒ **四个第三方上游 + 本项目前身**（README 目录树、NOTICE 来源矩阵、role 说明）；
3. core↔mit 的共享逻辑（`self-update/check.ts`、`self-update/registry.ts`）按 core 重新生成、
   保留 mit 自己的许可横幅 ⇒ G3 通过（只比代码行）；
4. 登记簿：`bi-034`（press 双倍输入，fixed）、`bi-035`（emulate 空 UA，fixed）、
   `de-039`（上游 role 分档 + 前身除名，applied）；`registry/design/registry.json` 三副本逐字节同步；
5. 新发布说明 `docs/releases-0.11.21.md`。

**验收**

- 测试 **8 套 207 项全绿**（tool-render 61 / bridge-http-auth 32 / permissions-read 23 /
  registry-consistency **23**（新增 `[5]` role 段）/ render-settings-pages 22 / buddy-merged 21 /
  permissions-resolve 13 / emulate-contract **12**）。上一版 7 套 190 项。
- 三包 `tsc --noEmit` 全过；发布脚本 **G1–G8 全过**，7 个资产 + sha256 落在 `dist-release/`。
- `dsh --profile web --dump-config`：**零跳过**，`- id: browser-bridge / name: dsh-browser-unified` 在位。

**装机状态**

- core 0.1.5 + 插件 0.11.21 已解包进 `~/.dsh/profiles/web/node_modules/`（profile 依赖已指向
  `vendor/browser-unified-core-0.1.5.tgz` / `vendor/dsh-browser-unified-0.11.21.tgz`）。
  备份：`projects/__install-backup-20261013/`（旧的两个包 + 旧 profile package.json）。
- ⚠️ **要重启 `dsh web` 才生效**（当前进程里还是 0.11.20/0.1.4 —— 所以工具面里还看不到 role 过滤的新行为）。
- ⚠️ **扩展 1.0.20 要在 Edge 里点「重新加载」或重启浏览器**（现在跑的还是 1.0.19）。
- 回滚：把 profile 的两条依赖指回 `vendor/*-0.11.20.tgz` / `*-0.1.4.tgz`，再 `rm -rf node_modules/<name>`
  + `tar xzf <tgz> --strip-components=1`（vendor 里新旧都在）。

**本版刻意没做**：上游欠账 caob23 `v1.0.9→v1.0.17`（find/dialog/info、read 分页、`effectState`
错误契约、标签归组、AX 快照、`parseKeySpec`）—— 触发条件已满足，但不与本次修复混在一个版本里。

**扩展部署（本轮踩的坑，2026-10-13 20:00）**

改了仓库里的 `extension/` 之后，**必须再同步到 Edge 的加载目录**，否则「重新加载」读到的还是旧文件：

```
projects/dsh-browser-unified/extension/   ──复制 4 个文件──▶   D:\edge-extensions\dsh-browser-extension
```

这一步就是本文件上面「浏览器扩展（Edge）安装记录」里写的部署步骤（两边 4 文件 sha256 必须一致）。
本轮第一次重载失败（桥仍报 1.0.19）就是因为只改了仓库那份、没同步到 `D:\` —— **不是重载没生效，是磁盘上就没有新文件**。

已补做：备份旧目录到 `D:\edge-extensions\dsh-browser-extension.bak-20261013-pre1020`（1.0.19），
再复制 `background.js` / `manifest.json` / `popup.html` / `popup.js` 四个文件；三处（`-src/extension`、
`dsh-browser-unified/extension`、`D:\…`）sha256 逐个核对一致，部署件版本 **1.0.20**、
`type: 'char'` 分支计数 0，`node --check` 通过。剩下就等人在 `edge://extensions` 点一次「重新加载」
（这一步 agent 代劳不了：插件的 URL 策略只放 http(s)，`edge://` 被 `WEB_INVALID_URL` 挡住）。
验证口径：桥侧 `/api/status` → `hello.version` 应从 1.0.19 变 **1.0.20**。

**生效确认（2026-10-13 20:0x —— 两侧都验过了）**

| 侧 | 证据 | 结论 |
|---|---|---|
| 扩展 | 桥 `/api/status` → `hello.version = **1.0.20**`（`extensionId nlhedoliokpkcodjlgdlhiiohjcbbaap`，connectedAt 19:57:57） | 新的扩展在跑（1.0.20 这个号只在修好的构建里） |
| 插件 | `browser_emulate {device:"desktop"}` 在 live 上调**成功**（返回 `1280×800 DPR=1 mobile=false touch=false`，随后 `device:"reset"`）—— 旧代码（≤0.11.20）这条**每次必抛** `ToolOutputError` | 新插件代码确实在跑 |
| 插件进程 | `dsh web` pid 2509 启动于 **19:52:42**，在我把 0.11.21/0.1.5 解包进 `node_modules`（约 19:48）**之后** | 重启已覆盖新包 |
| 登记簿 | 调 `browser_*` 时收到 delta：`bi-034`/`bi-035` 新增（`bi-034` 被标「★ 你撞到过」） | 新 registry 数据已送达（数据是调用时从磁盘读的，不需重启） |

> 注意区分：**registry 数据（issues/design JSON）改动即时生效**（每次调用现读磁盘），
> **插件代码改动要重启 `dsh web`**（Node 在进程启动时载入模块）。本轮两者都齐了。

顺带记一条环境事实：`dsh web` 现在是**前台跑在 pts/0**（`node …/dsh web`，无 `--no-open`），
所以它自己的日志只在那个人工终端里 —— 桥/宿主侧的启动日志读不到文件，验收要靠 `/api/status` 这类读数。

---

## 2026-10-13（夜，第二场）　吸收上游第一段：插件侧五条

背景：欠账是 caob23 `v1.0.8 → v1.0.17`（53 提交 / 40 文件）。**插件侧不能 merge**（我们的
`src/index.ts` 是 v1.0.7 接线层派生后重写过的，不是同一份文件），只能逐条移植语义；
**扩展侧**才是真 fork、可 patch 化。所以拆三段：① 无设计冲突的插件侧（本节）→ ② 有语义冲突的
（`browser_wait` / snapshot 的 AX 模式）→ ③ 扩展侧（与"路线"一起定）。

### 落地的五条

1. **错误契约（`code` / `effectState` / `hint` 进模型可见文案）** —— 新增
   `packages/browser-unified-core/src/errors.ts`（移植自上游 v1.0.13，AGPL 同源）。
   两个收口点：core 的桥（`bridge/server.ts`，与上游同位置）与插件壳的
   `BridgeController.execute()`。**本地增强**：策略拦截（`UrlPolicyError`）单独归类成
   `policy_blocked` + `effectState=not_started` —— 上游没有策略层，而"命令根本没发出去"
   是确定的事，不能按写操作一律报 `unknown`。
2. **`browser_read` 改窗口式**（上游 v1.0.12 口径）：`offset`/`limit`，单次默认/上限
   **20 000** 字符（原先是"一次 120 000 + 截断标记"）；头部给
   `chars a-b of N; call again with offset=b`。扩展回来的是完整正文（已核 `buildContentScript`
   无长度上限），切窗口在插件侧做 ⇒ `totalChars` 是真总长。
3. **注册三个工具**（上游 v1.0.9 的四件里我们缺的三件）：`browser_find`（按选择器描述元素）、
   `browser_dialog`（读/改弹窗策略 + `answer` 回答当前对话框 + 最近记录）、`browser_info`
   （接上的是哪个浏览器/扩展构建 + **桥与扩展的协议是否对得上**）。渲染都按本项目口径写成
   人读的行，**没有**沿用上游那种 `JSON.stringify(value)` 一把梭。工具面 **27 → 30**。
4. **`browser_navigate`**：`siteUnreachable` 我们 2026-10-10 就修过（bi-015，含对象形状容错），
   本段补的是 **`pendingUrl`**（扩展侧 `chrome.tabs` 的 `pendingUrl`，没有就退回调用方要的地址）
   —— 让"仍在加载"变成"仍在加载**哪个**地址"。
5. **vendored `bridge/server.ts`**：并入上游的**协议协商**（`BRIDGE_PROTOCOL_VERSION`、
   hello 的 `protocol`、status 的 `bridgeProtocol`/`extensionProtocol`/`protocolCompatible`/
   `protocolNote`）与 `classify` 收口；缺失 `protocol` 的老扩展按 v1 兼容（不判死）。
   同时把 HTTP 面的**错误→状态码**从"按 message 前缀猜"改成**按 `code` 映射**
   （`extension_offline`/`bridge_disabled`→503、`policy_blocked`→403、`command_timeout`→504、其余 502），
   并把 `code`/`effectState`/`hint` 一并交给脚本侧（这一处是 `bridge-http-auth` 测试当场抓出来的）。

### 验证

- 测试：**9 套 247 项全绿**。新增 `tests/error-contract.mjs`（24 项：写操作超时→unknown、
  读操作→not_started、策略拦截→policy_blocked、8 条文案→code 映射、classify 幂等）；
  `tool-render.mjs` 加 `[9]` 段（read 窗口头 / find 行 / dialog 记录 / info 协议对账 / nav 未落地文案）
  并把工具数断言 27 → 30，**77/77**。
- 真机契约核对（rig：真 Edge 155 + 真扩展 1.0.92 + 假桥）：`seg1-contract.mjs` **10/10** ——
  `browser.info` / `find`（含"没命中=count 0 不报错"）/ `dialog`（读+设）/ `content`（完整正文）/
  `nav` 的 `pendingUrl`（用"慢但有限"的 `/slow?ms=8000` + 落地预算 1500ms 造出
  `{loadPending:true, pendingUrl:…}`）。

### 顺带查出一条新缺陷（bi-036，open）

用假桥的 `/hang`（接受连接、永不回正文）造边界时发现：**`browser_navigate` 会挂到桥的 60s 兜底**——
`cmdNav` 落地等待结束后那次 `withCDP` 落地 URL 探针**没有超时预算**，文档一直不 commit 时它就挂着
（对比 `cmdEval` 早就有 `evalTimeoutMs`）。已登记 bi-036 并写清绕行；修法留到第三段（扩展侧）一起做。
> 附带收益：这条失败现在会带着 `[command_timeout] … effectState=unknown` 出来（第 1 条的产物），
> 而不是一句干巴巴的超时。

### 状态

- 代码在仓库里，**未发布、未装机**（按约定：三段做完再发 0.11.22）。
- 扩展源码三处（`-src/extension`、`dsh-browser-unified/extension`、`D:\edge-extensions\…`）
  已同步含 `pendingUrl` 的 1.0.20（4 文件 sha256 一致）；Edge 里跑的还是**不含** pendingUrl 的
  同版本号构建 —— 下次装机时一并重载即可。

### 第二段：吸收上游的两处语义冲突（2026-10-13 深夜）

用户口径（原话）：「按你倾向做」⇒ 两条都按"两个都留"处理，登记 `de-040`。

**① `browser_wait`：保留我们的自研版。**
上游 v1.0.9 也加了一个 `browser_wait`（更简单、`render` 直接 `JSON.stringify(value)`）。
我们 2026-09 那版有 selector/text/fn 三选一、明确的超时与中止语义（`waitTimedOut` / `waitAborted`）、
以及 `siteUnreachable` 兜底 —— 比它强，所以**不换**，只把上游描述里那句
「SPA 路由与懒渲染：`browser_navigate` 不会等它们」并进我们的 description。

**② `browser_snapshot`：加 `mode:"ax"`，默认仍是我们那套 DOM 判据。**
- 扩展侧新增 `snapshotViaAx()`（移植自上游 v1.0.11，AGPL 同源）+ `AX_ACTIONABLE_ROLES` 白名单 +
  `AX_STAMP_FN`；`cmdSnapshot` 加 ax 分支，失败**落回 DOM 并带 `axFallback`**（不让整次调用失败）。
- **关键：ref 契约没变** —— AX 模式同样把 `data-dsh-ref` 打到真实 DOM 节点上
  （`DOM.resolveNode` + `Runtime.callFunctionOn` 盖章），所以 `browser_click ref=…` 在两种模式下都照旧。
- 插件侧采纳上游 v1.0.15 的教训：**旧扩展会静默忽略 `mode:"ax"`**（照回 DOM 结果，既没 `mode`
  也没 `axFallback`）⇒ 必须由插件把"降级了"说出来。判定抽成导出纯函数
  `snapshotModeOf(rawMode, rawFallback, wantAx)`，可单测。
- 渲染按本项目口径：ax 条目打印 `[role] 可访问名`，头部标明这是 a11y 树；`why=ax` 不再被当作
  「cursor 兜底」打印；落回 dom 时把原因写进模型可见文本。

**验证**

- 测试：**9 套 255 项全绿**（tool-render 增 `[10]` 段 8 项 → 85/85）。
- 真机（rig：真 Edge 155 + 真扩展 1.0.93 + 假桥）：`seg2-contract.mjs` **12/12** ——
  dom 老行为不变；ax 回 `mode:'ax'` 且 3 条带 role（`input→textbox`、`button→button` + 可访问名 `go`）；
  `[data-dsh-ref]` 属性数 == items 数；**按 ax 给的 ref 点得动**（`/press` 表单 `submit=1`）。
- 扩展源码三处（`-src`、笔记目录、`D:\edge-extensions\…`）已同步到含 AX 的 1.0.20
  （4 文件 sha256 一致）。

**下一段（第三段）**：扩展侧的剩余欠账 —— 标签归组（`tabGroups` + `cmdTabGroup/Ungroup` + 退避）、
`parseKeySpec`（`"Ctrl+A"` 写法）、未知键名报错、bi-036（`cmdNav` 探针无超时），
以及**是否重做 re-vendor 回上游**。这一段与"路线"一起定。

### 第三段：吸收上游的扩展侧四件 —— 并且**决定不 re-vendor**（2026-10-13 深夜）

用户口径：先答"欠账补完就是路线问题"，随后「开始」。

#### 先把净差量出来，再决定怎么补

| 对比项 | 上游独有 | 我们独有 |
|---|---|---|
| 命令表 | `tabs.group` / `tabs.ungroup` / `tabs.closeMany` | `content.debug` / `window.ensure` |
| 函数表（扩展） | 6 个归组函数 + `parseKeySpec` + `cmdTabsCloseMany` + `withBudget`/`landsAt`/`failureText`/`clearAttachment` | 端口自动发现（`discoverBridge`/`portCandidates`/`probeBridge`）、frames（`cmdFrames`/`buildContentScript`）、`cmdContentDebug`、`cmdEnsureWindow`/`ensureWindow`/`windowCount`、`applyDialogPolicy` |
| manifest | `tabGroups` 权限 | `host_permissions`（127.0.0.1/localhost，上游刻意没有） |
| 行数 | 上游 1688 行 | 我们 1987 行 |

**结论：手工挑，不重做 re-vendor。** 三条理由：① 本段补完后上游独有面几乎清零，re-vendor 换不来新能力；
② re-vendor 会把我们 8 处独有改动全部变成"需要重新打补丁"的对象，风险大于收益；
③ 我们这条线每一步都有 rig 真机取证，re-vendor 等于把已验证的基线推倒重来。
需要的地方**明确保留我们的差异**（`host_permissions`、端口发现、frames、`cmdTabsOpen` 的无窗口自愈分支）。

#### 落地的四件

1. **hello 声明 `protocol = 1`** —— 与 core 0.1.5 的桥协议协商配对（桥据此判断两边帧契约是否一致）。
2. **`parseKeySpec` + 未知键报错**：`key:"Ctrl+A"` 与 `key:"a"+modifiers:["ctrl"]` 等价；
   未知键名/未知修饰键**明确报错**（以前会静默发 `undefined` 的 keyCode，Chrome 什么都不做却回成功）。
3. **标签归组**（移植上游 v1.0.10/11）：manifest 加 `tabGroups` 权限；agent 开的标签默认收进当前窗口的
   `DSH` 蓝色组；`tabs.group` / `tabs.ungroup`；退避 50/150/400ms、最多 4 枪；`groupId` 只存内存、
   按标题反查重建；**`ungroup` 只解除归属、不关任何标签页**。没有为它加 `host_permissions`。
4. **`tabs.closeMany`** —— 这条是**我们提给上游的 PR #11**，现在搬回自己的扩展线：
   一条命令、一份超时预算、逐 id 交代（`closed` / `alreadyGone` / `failed`）。
   外加通用小助手 `withBudget` / `landsAt` / `failureText` / `sleep`。

**顺带修掉两条我们的缺陷：**
- **bi-036（本段前刚登记）**：`cmdNav` 的落地探针现在包 `withBudget(..., 2500, null)`。
  上游 v1.0.11 用同名函数修过同一现象，其注释写着"无预算的探针让 nav 40 多秒没回答"—— 与本机复现一致。
- **`waitForNavigationComplete` 带 `expectedUrl` + `landsAt`**：区分「新文档快到没采样到 loading」与
  「根本没导航过去」（链接变下载、同 URL 空操作）—— 后者以前会被判成 settled（假绿）。

#### 插件侧接线

`browser_tabs` 增 `group` / `ungroup` 两个动作、`open` 支持 `group:false`；批量关闭改为
**匹配在插件侧（我们的 `tabIds`/`urlPattern`/`others` 比上游丰富）、关闭走扩展的 `tabs.closeMany`**；
归组/拆组/开标签的结果都改成给人话（不再落回 JSON）。

#### 验证

- 测试：**9 套 260 项全绿**（tool-render 加 `[11]` 段 5 项 → **90/90**）。
- 真机（rig：真 Edge 155 + 真扩展 1.0.94 + 假桥）：`seg3-contract.mjs` **16/16** ——
  `hello.protocol=1`；开标签自动归组（`created=true, groupId`）→ `ungroup` 解散（`groups=1`）
  且**标签页数不变**、再拆一次幂等；`tabs.group` 对已有标签有效；`Ctrl+A` 页面收到 `ctrlKey=true`
  （`modifiers` 数组写法同样有效）；未知键/未知修饰键各自报错并给出可用值；
  `closeMany requested=3 → closed=2 + alreadyGone=1`；
  **`/hang` 下 `nav` 从"25s 无任何回答"变成 5.7s 返回**且 `loadPending=true` / `pendingUrl=…/hang`。

#### 状态与结论

- 扩展版本 **1.0.20 → 1.0.21**（三处副本同步、sha256 一致）。Edge 里跑的还是 1.0.20 —— 装机时一并重载。
- 三段（插件侧无冲突项 → wait/AX 语义项 → 扩展侧四件）**全部做完**，仍未发布、未装机。
- **现在的净差**：上游独有面 ≈ 0（剩下的只有上游把 DOM 路径抽成 `snapshotViaDom` 这种结构差异），
  我们独有 = 上面那张表的 8 处。**"路线问题"的已知条件因此清了**：剩下的选择是
  「把我们的 8 处推回上游、自己只留薄补丁」/「做官方 provider」/「上 npm+市场」，而不再是"要不要继续跟上游"。

### 设置热更新（bi-038 修复）+ 设置页改动的「胶囊」反馈（2026-10-14 深夜）

**① bi-038：运行中改设置一律不生效 —— 根因与修法**

宿主对「只动 volatile 字段」的配置变更是**原地提交**：`@deepseek-ai/cordis-plugin-loader`
的 `_commitVolatile()` 把新值写进运行中那些 volatile 引用（`updateVolatile(ref, source)`），
然后 `fiber.ctx.emit(self, 'loader/volatile-update', paths)`，**不 dispose、不重跑 apply` ——
这正是 `.volatile()` 的语义（"别重载我，我自己处理"）。我们既在 `apply()` 里把配置快照死、
又没订阅这个事件 ⇒ 所有设置改动被静默吞掉（实测：20:00 把局域网/本机档改成放行，桥侧到 22:03
仍是 deny，要重启才生效）。

修法：`validate()` 抽出（热更新走同一条判据，不许绕过）＋ 订阅 `loader/volatile-update` →
用**原始** config 重新 `unwrapVolatile`（包装的 `.get()` 已是新值）→ `resolved = next` →
`controller.reconcile(next)`；buddy 加 `refreshConfig(raw)` 重建 `cfg`/`enabledGroups`/`resident`。
非法值只 warn 并继续用上一份好配置。
新回归测试 `tests/config-hot-update.mjs` **11/11**（仿 loader 的 volatile 包装：原地提交 + 事件 ⇒
策略与分层立刻跟着变）。

**② de-042：页面不再自夸「保存即时生效」，改成行为反馈**

用户口径：「与其写『保存即时生效』，不如配置真改了后显示 1 秒的『配置已保存』
（后来的胶囊会直接覆盖之前的胶囊），让人知道这真改了，要是没改也能看出来。」⇒

| 情形 | 胶囊 |
|---|---|
| 真改了（新值已落盘且与写之前不同） | 绿色「配置已保存」，1 秒后消失 |
| 选了个跟原来一样的值 | **不弹**（确实没改，不打扰） |
| 1.5s 内没看到新值 | 琥珀「配置尚未生效（字段名）」 ← "没改也能看出来"那一格 |
| 写失败 | 红色「保存失败：原因」（内联错误行保留） |

多条胶囊共用一个元素：新的一来先清旧定时器再挂 ⇒ 后弹覆盖前弹。判定抽成纯函数
`writeOutcome(before, next, seen, timedOut)` → saved/noop/pending/wait（`exports.__test` 暴露给单测）。
顺手：主机列表按**插件同一条规则**（主机名/IP 或 `*.suffix`，禁空白与 `/ \ @ ? #`）写入前自查，
格式不对只在本地弹琥珀，不发出去。

**测试**：`render-settings-pages` 22 → **35 项**；全套 **10 套 284 项全绿**。
**诚实边界**：胶囊属 client 半区，随包更新 —— 先装 0.11.22 并重启一次才会出现在眼前。

### 0.11.22 发布 + 装机 + 推 PR（2026-10-14 22:3x）

**发布**：`node scripts/build-release.mjs` → **G1–G8 全过**。
`browser-unified-core-0.1.6.tgz`（48KB）/ `dsh-browser-unified-0.11.22.tgz`（210KB）/
`dsh-browser-unified-mit-0.1.1.tgz`（59KB）/ `DSH-Browser-Control-v1.0.21.zip`（62KB）+ 三个兼容 zip + INSTALL.md。
> ⚠️ **core 与插件必须同版升级**：插件 `import { classify } from 'browser-unified-core'`，
> `errors.ts`/`classify` 是 0.1.6 新进的 —— 只换插件会在 import 阶段就挂。

**装机**（live profile `~/.dsh/profiles/web/node_modules/`）：
`browser-unified-core` 0.1.5 → **0.1.6**、`dsh-browser-unified` 0.11.21 → **0.11.22**
（备份 `__install-backup-20261014-222835`；滚回＝把两个目录换回备份，再重启）。装完核对：
`dist/errors.js` 在、`server.js` 里 classify 4 处、插件 lib 里 `loader/volatile-update` 监听 3 处、
客户端胶囊文案在、登记簿 38 条。**运行中的进程仍是旧代码 —— 要重启一次才生效**（扩展一并重载到 1.0.21）。
另外装机副本的登记簿已是合并后的 38 条（bi-036 已修 / bi-037 局域网被拒 / bi-038 已修 / bi-039 副本漂移）。

**推 PR**：目标 **`Short-Arm-Ape/dsh-browser-unified`**（他的仓库，main 停在 0.11.20）。
fork `long-arm-ape/dsh-browser-unified` → 分支 `release/0.11.22` → commit `47dd718330`（45 个文件）
→ **PR #1** <https://github.com/Short-Arm-Ape/dsh-browser-unified/pull/1>。
- 只带**内容真变了**的文件：39 改 + 6 增（含新增 `docs/releases-0.11.22.md`）；
- **不吃进 PR**：7 个仅行尾差异的文件（本地 CRLF、仓库 LF —— 避免纯格式噪音）、4 个 2026-09 本地草稿
  （`CHANGES-2026-09-27.md`、`SOURCE-NOTES.md`、`source-changes-2026-09-*.patch`）；
- 上传前把 CRLF 归一化成 LF（仓库存 LF），但**保留 `scripts/check-upstream.ps1` 的 UTF-8 BOM**；
- 用户口径：「用你的身份推，PR 里不用提及我」⇒ PR 正文 **0 处** `@Short-Arm-Ape`、提交**不带**
  `Co-authored-by` 尾注；**保留** AI 身份（作者 `Long-Arm Ape (agent)`）与披露（"an automated assistant"）。
  （工具 `__gh/agent-gh.py` 因此加了一行守卫：`AGENT_GH_COAUTHOR` 为空时不加尾注。）

**产物去向**（按 ENV-PROFILE §三-9）：PR 清单与正文源、三次台子的假桥日志已挪进 [`scratch/browser-unified-0.11.22/`](../scratch/browser-unified-0.11.22/README.md)；台子脚本与证据 JSON 留在 `dsh-browser-unified/rig/`（共享资产）；装机备份 `__install-backup-20261014-222835/` 是滚回点，原地保留。

### 0.11.23：装机持久性（bi-040）+「允许访问本 DSH 页面」不再骗人（de-043）（2026-10-17）

**起因**：整理那个会话发现「允许访问本 DSH 页面」开了却不生效（`WEB_DSH_DISABLED`），并指出装机目录其实是
**0.11.21 / core 0.1.5**、`lib/index.js` 里**没有** `loader/volatile-update` 订阅。核实属实 —— 我 10-14 那次
"装机"只是**覆盖文件**，没改 profile 的声明。

**bi-040（fixed）**：`~/.dsh/profiles/web/package.json` 用 `file:./vendor/*.tgz` 声明这两个包；
profile 于 10-17 13:20 被重新解析/安装 ⇒ 按**声明的旧 tgz** 解包，`node_modules` 与 `package.json` 的 mtime
都是 13:20。手工覆盖的文件因此**不持久**。新装机流程三步：**放 vendor → 改 package.json 依赖 → 再解包**；
本次按此装 **core 0.1.7 + 插件 0.11.23**（备份 `__install-backup-20261017-134947`）。

**de-043（applied）**：「允许访问本 DSH 页面」两项优化 ——
1. **桥报生效值**：core 新增 `BridgeServerOptions.describePolicy` 与 `BridgeServerStatus.policy`，随 `GET /api/status`
   一起给；插件在 reconcile 时挂上、**读 `this.current`**（策略变更不重建监听器，闭包参数会过期）。
   `dshOrigins` 不报（生效值含宿主推导的控制页地址，与用户列表天然不同）。
2. **设置页显式提示**：存下来的值 ≠ 生效值 ⇒ 访问控制卡顶部琥珀条「有改动还没生效」并**列出具体哪几项**；
   桥没报生效值（旧版）⇒ 灰字「无法确认…已生效」，不装作没事。判定抽成纯函数 `stalePolicyKeys()`。
3. 那一项的说明从五句长文改两句（能做什么 + 关闭即时生效 / 开启需二次确认）。
4. 顺带：探针上移到分区 body —— 原来「本地桥」行与生效值比对**各扫一遍**候选端口（测试暴露成 20 次请求），
   现在一次扫描共用，`BridgeStatus` 变纯展示。

**测试**：10 套 **298 项全绿**（`render-settings-pages` 38 → 49）；发布闸门 G1–G8 全过。
**未重启**：运行中的进程仍是 0.11.21/0.1.5 —— 重启后 0.11.22（AX/标签归组/capsule/hot-update）与 0.11.23 一起生效。

### 0.11.24：标签分组「看得见」（de-044）（2026-10-17）

**问题**：分组 0.11.22 就有了（`tabs.group`/`tabs.ungroup`/开标签自动进 `DSH` 蓝色组），但
`tabs.list` 只回 `id/url/title/active` ⇒ **能做但看不见** —— 建了组也确认不了谁在组里，只能靠人眼看窗口顶部。

**改法**：
- 扩展 `cmdTabsList`：每个标签补 `groupId/groupTitle/groupColor`（**未归组的不加字段**，保持紧凑），
  并回一份 `groups` 一览（id/title/color/windowId，`chrome.tabGroups.query` 一次批量）。
- 插件 `browser_tabs`：list 渲染成行首 `[DSH]` 徽标 + 头部「分组：DSH（2 个标签）」，另加 `groupTitle`
  参数只列某个组（注：`group` 这个名字已被 open 的布尔占用，所以过滤参数叫 `groupTitle`）。

**真机核对**（rig：真 Edge 155 + 真扩展 1.0.95 + 假桥）：`seg4-contract.mjs` **11/11** ——
开标签自动归组后 list 带 `groupTitle: DSH`（color=blue）；`tabs.group` 把已有标签拉进去后同样看得见
（两个标签同 groupId）；`ungroup` 后字段消失且**标签页数不变**；未归组标签不带字段。
测试 10 套 **302 项全绿**；发布闸门 G1–G8 全过；装 **0.11.24**（core 仍是 0.1.7）。

**顺带一件事（记下来免得下次再踩）**：`dsh-browser-unified/rig/deploy.sh` 依赖工作区根目录的 `__ps.sh`，
而它在 2026-10-14 的产物归档里（`archives/scratch-2026-10-14/pr-scripts/__ps.sh`）——
本次已按归档约定"还原＝拷回根目录"取回。**归档时别把 rig 依赖的脚本归走**（`__ps.sh`、`__desk.sh`、`__old.sh`）。

### 0.11.25：帧协议协商原来一直是假的（bi-041）（2026-10-17）

**怎么发现的**：让 `browser_info` 复核 1.0.22 时注意到「协议：桥 v1 / 扩展 **v0**」—— 扩展明明在 hello 里
声明了 `protocol: 1`（部署件与 rig 的 hello 帧都能验到 1），桥却说 0。于是 `curl /api/status` 对账：
`hello.version=1.0.22` 但 `hello.protocol=null`。

**根因（我们的锅，在 core）**：`handleExtensionFrame` 把 hello **逐字段手抄**进 `this.hello`，抄的时候
**漏了 `protocol`** ⇒ `extensionProtocol` 恒为 0 ⇒ 0.11.22 移植进来的协议协商从来没生效过。
（手抄字段这种活最容易漏，所以这次抽成纯函数。）

**修法**：`normalizeHello(msg)` 导出并单测（`protocol` 校验：有限、≥0、小数截断、非法忽略），
落库直接用它。`error-contract` 增 **7 项**断言（protocol 保留 / 缺省 undefined / 非法忽略 / 小数截断 / 兜底）。

**状态**：测试 10 套 **309 项全绿**；G1–G8 全过；已装 **core 0.1.8 + 插件 0.11.25**
（备份 `__install-backup-20261017-140529`，vendor+package.json 已指向新 tgz ⇒ 持久）。
**要一次重启才轮到线上**；重启后 `browser_info` 应显示「协议：桥 v1 / 扩展 v1」。

### PR：0.11.22 已合并，追加的 0.11.23→0.11.25 另开 PR（2026-10-17）

- **PR #1**（45 文件，0.11.20→0.11.22）**主人 2026-10-14 23:19 自己合并了** —— 他仓库 `Short-Arm-Ape/dsh-browser-unified` 的 main 现在是 0.11.22。
- 今天的追加（`bi-040` 装机持久性 / `de-043` 生效值提示条 / `de-044` 分组可见 / `bi-041` 协议协商）推成
  **PR #2** <https://github.com/Short-Arm-Ape/dsh-browser-unified/pull/2>：**18 个文件、+796/−72**，分支 `release/0.11.25`
  （原来那条 `release/0.11.22` 已改名 —— 它已并入 main，再往里推提交只会挂在一个已合并的分支上）。
  - 提交 `2b0bd895e4`，作者 `Long-Arm Ape (agent)`，**不带** `Co-authored-by` 尾注（主人要求 PR 里不提他）；
  - 正文 5340 字，**0 处** `@Short-Arm-Ape`，保留 AI 披露（"prepared by @long-arm-ape, an automated assistant"）。
  - ⚠️ **踩到一个差点出事的地方**：清单生成时不能对所有文件做"CRLF→LF"归一化 —— **PNG 图标里也可能出现
    `\r\n` 字节对**（实测 `icon16.png` 里 1 对）。本次先发现、改成"只对文本归一化（无 NUL 判定）"，
    推完复核 `icon16.png` 与本地**逐字节一致**。

### 0.11.26：防误触浮层 `browser_hold`（de-045）（2026-10-17）

**需求**（原话）：「模型操作标签页时可以通过调用工具让标签页加个可取消的浮层防止用户误触（画面变暗并在中央显示提示和信息），
用户连续两次点击任意处取消浮层用户直接操作标签页」；追加硬约束：**「不能改页面本身的逻辑 —— 这玩意是在页面之上的，不影响前端元素」**。

**实现（每条对应那个约束）**：

| 要求 | 做法 |
|---|---|
| 在页面之上 | 只往 `<html>` 追加**一个** host 元素；撤掉时**只删它自己** |
| 不影响前端元素 | 内容全在 **Shadow DOM**（页面 CSS 进不来、我们的样式漏不出去）；`body` 一字不动 |
| 不抢焦点/不拦键盘 | 默认零干扰；`blockKeys: true` 才临时在 window 挂拦截器，撤销时移除 |
| 防误触 | 指针/滚轮只在我们这层的监听里拦（真实命中点落在浮层上） |
| 用户接管 | 600ms 内连点两下 ⇒ 撤掉，记 `dismissedBy: user`（`hold.status` 可查） |
| 模型还能干活 | 派发前把浮层临时设 `pointer-events:none`、派发完 120ms 恢复 |
| 导航后不假报 | `hold.status` 以 **DOM 是否存在**为准 |

**真机核对**（rig：真 Edge 155 + 真扩展 1.0.96 + 假桥）：`seg5-contract.mjs` **20/20**，其中"页面一字未动"那组是硬指标 ——
装浮层前后 `document.body.innerHTML.length`（1187→1187）、节点数（5→5）、`document.styleSheets.length`（0→0）、
页面计数器（全 0）**完全一致**；按钮中心 `elementFromPoint` 命中浮层 host；locked 下模型 click 仍成功（`submit=1`）；
连点两下后浮层消失、页面恢复可点。测试 10 套 **315 项全绿**；G1–G8 全过；装 **0.11.26 + 扩展 1.0.23**。

### 0.11.29 / 扩展 1.0.33（2026-10-17 夜）：三条口径收口（de-046/de-047/de-048）

1. **模型可见文案不许夹带实现注释**（主人口径：「注释不要写到前端」）：
   - 中止报错缩短为「用户终止控制（click 已拦下）。请与用户沟通确认后再调用 browser_hold action=off 解除中止。」；
   - `browser_hold` 回执去掉「标题由扩展写死」「连点两下」（改「用户双击任意处可接管；你的点击/输入照常可用。」）；
   - `browser_evaluate` 描述里「（实测踩过，URL 变了内容没变）」这类开发注记改成事实陈述；
   - 测试里加了一条**反向断言**：回执不许出现实现说明。
2. **扩展侧"终止"（硬锁 panic switch，de-047）**：popup 里「锁定扩展」（双击确认）⇒ 写 `chrome.storage.local.hardLock`；
   锁定后扩展**保持连接**，但 `runCommand` 单一闸门上除 `ping/browser.info/lock.status` 一律拒绝
   （「浏览器扩展已被用户在本地锁定，拒绝一切操作。请在浏览器右上角的扩展图标里解除锁定后再试。」）。
   **解锁只在扩展 popup 里**：DSH 设置页对模型是可达的（「允许访问本 DSH 页面」开着时更是如此），
   把解锁放页面里等于"跑偏的模型能自己解锁"。
3. **只读档（访问控制能选"能不能操作页面"，de-048）**：新配置 `readOnly`（volatile），设置页 访问控制 卡里是
   「允许模型操作页面」开关（默认开）。两层收口：L1 `buddy` 的 assemble 只暴露读类工具（read/find/snapshot/
   screenshot/wait/info/policy/permissions/logs/frames/tools/issues…）；L2 `BridgeController.execute` 的
   `READ_ONLY_ALLOWED` 白名单，猜中命令名也拒（错误文案说明"只读模式"）。

### 0.11.37（2026-10-19 夜）：浮层开关、脚本越界导航检查、令牌去默认值

来源：主人 2026-10-19「二同意 / 三可以做成设置项 / 把 hold 做成设置项（启用·关闭）」。
起因是那晚读教务课表时我在内网话题上答偏了一段，顺带把插件里两处"默认太宽"的口子收掉。

1. **`holdEnabled`（volatile，默认开）**：访问控制卡里「允许模型加防误触浮层」。
   关掉后 `browser_hold` 的**所有** action（含 `status` / `off`）都抛错——不给模型留"先 off 再 on"的绕路。
   工具仍在工具面里（配置热更新不重注册工具），只有调用时才拒。
2. **`evalNavGuard`（volatile，默认开）**：访问控制卡里「脚本越界导航检查」。
   `browser_evaluate` 调用前后各读一次标签页地址（`authorizeExistingTab` 现在返回它读到的 URL）；
   地址变了且新地址在当前策略下不是 allow ⇒ 本次调用报错并给出两个地址与恢复办法。
   **定位说清楚**：分域只拦"导航命令"，`location.href = …` / `fetch()` 这类脚本内导航与请求拦不住，
   这一项只保证"不静默"。默认开，代价是每次 eval 多一次 `tabs.list`（毫秒级）。
3. **令牌不再默认藏成密码框**：设置页显示当前值 + 「换一个随机值」（`crypto.getRandomValues` 16 字节 → 32 位 hex）。
   默认 `dsh-local` 是公开值（插件与扩展两侧都写死），同机任何程序都能冒充桥；换掉后把同一个值粘进扩展弹窗。
   说明文字写清了这条因果，没有渲染成"安全默认"。
4. 测试：`tool-render` 新增 [N] 段（关掉浮层后连 `status` 也拒，并用第二个实例证明"同一源码不同设置"）；
   `render-settings-pages` 新增 3 条（两个开关 + 令牌行）。**10 套 331 项全绿**。
5. 版本：插件 **0.11.37**，核心 0.1.10、扩展 1.0.38 不动（本轮无扩展改动，不用重载扩展）。

**一处我答偏了的记录**：主人问"针对这类情况插件有没有改进点"，指的是**读教务课表那一段**（DOM 抓不住），
我先按校园网扫描段答了，被当场指正。教务那段的实测结论写在下一节，属于待办。

### 0.11.38 / 扩展 1.0.39（2026-10-19 深夜）：穿透 shadow root、ref 自愈、读取稳定性、浮层黑名单模式

主人原话：「一、修」「二、1.反正目前工具是暴露出来的，我们甚至能直接在跨轮的时候把工具隐藏了」
「三、就是A……另外我倾向双击后不影响模型操作，中断会」。

**一、读教务那段的四条改进，前三条已实现**（扩展 `background.js`，共用一段 `DEEP_HELPER`）：

1. **穿透 open shadow root**：`find` / `snapshot` / `read`（text 与 html 模式）、`click` / `input`、`wait` 的
   选择器判定全部改走 composed tree。实测复刻页上原来 `find('table')` 0 命中、`snapshot` 0 个可交互元素、
   `read` 读不到表内文字；closed shadow root 依然取不到（浏览器的边界，不假装能）。
   `click` 的命中判定补了"命中点是宿主元素、目标在其 shadow root 里"这一支（`elementFromPoint` 不穿透）。
2. **ref 自愈**：快照时给每个 ref 存一枚指纹（tag + 可访问名 + role），点击/输入找不到原元素时按指纹在
   同一份快照的可交互集合里重定位一次，回执带 `relocated: true`；SW 被回收后指纹表清空，退回"找不到就是找不到"。
3. **读取稳定性**：`read` 现在回 `settled` 与 `changedSinceLastRead`（同一标签页两次读取的正文签名比较），
   正文变了会在头部提示"页面还在变"；`browser_wait` 新增 `stable` 参数（正文停止变化 N 毫秒才返回）。
4. 表格结构化读取**没做**（第 4 条）——留作下一批。

**二、浮层开关改成"跨轮隐藏"**：`holdEnabled=false` 时 buddy 的 assemble 钩子直接把 `browser_hold`
从工具面拿掉（不再只是"留着、点了才报错"）；控制器侧那道拒绝保留作第二道收口。

**三、浮层黑名单模式（A）**：新设置 `holdMode: 'black' | 'white'`（**默认 black**）。
- black：模型执行**操作类**命令（click/input/press/scroll/nav/eval）前，扩展自动补一层浮层（文字
  「模型正在操作这个页面」）；读取/截图/快照不触发，不会把页面一直盖住。
- 用户双击接管、或模型 `hold.off` 之后，**这个标签页本会话不再自动补**（否则接管等于没接管）；
  `hold.on` 或切回 white 时清掉抑制。
- 双击接管**不影响模型继续操作**（与以前一致），中止按钮才拒（与以前一致）——主人这次明确要的就是这个分法。
- 模式由桥推给扩展（`hold.config`，启动/配置变更/扩展重连时各推一次）；旧扩展不认识这条命令就按白名单行为，不报错。

测试：10 套 **336 项全绿**（buddy 新增 3 项钉"关掉后工具面里没有 browser_hold"、settings 渲染新增 1 项钉黑/白下拉）。
扩展已同步到 `D:\edge-extensions\dsh-browser-extension`（旧版备份 `dsh-browser-extension.bak-20261019-pre1039`），
**需在 `edge://extensions` 点一次重新加载**；插件 0.11.38 已装进 profile，**重启 dsh web 生效**。

### 待办：读教务课表那段的插件改进点（2026-10-19 实测）

用一个复刻症状的本地页面（晚渲染 + 每 2 秒整块重建 + open shadow root 里的表格与按钮）比对了现有工具：

| 症状 | 实测 | 根因 |
|---|---|---|
| `browser_find('table')` → 0 命中；`browser_snapshot` → 0 个可交互元素；`browser_read` 读不到表内文字 | 三项都看不见 shadow 里的内容 | 遍历只走 light DOM（`document.querySelectorAll`），不穿透 shadow root |
| 读早了只拿到占位文本，与"页面真没内容"无法区分 | `browser_read` 拿到什么算什么 | 没有"是否稳定"的信号 |
| 重渲染之后 snapshot 的 ref 失效 | ref = 打在元素上的 `data-dsh-ref` 属性，元素被重建即丢 | 无自愈重定位 |

候选改法（按性价比）：① 遍历走 composed tree（find/snapshot/read 穿透 open shadow root，点击已是真实坐标，不需改）；
② `read`/`find` 回 `settled` 标记 + `browser_wait` 支持 `stable` 条件；③ ref 失效时按"同文本 + 同角色"重解析；
④ `browser_read` 加表格结构化模式（课表/成绩这类页面不必每次手写 eval 抠表）。

### 验收记录：黑名单浮层与 Esc 接管（2026-10-20 00:2x–00:3x，真浏览器 + 真扩展 1.0.40）

这轮排查出三个真 bug（都不是"以为会好"，是实测不出来才挖出来的）：

1. **MV3 service worker 回收把浮层模式吃掉**：模式只存内存 `let`，SW 一回收就退回白名单，
   于是"黑名单"看着配了却永远不出浮层。改成 `chrome.storage.local`（`holdMode` / `holdSuppressed`）
   + 每次命令前 `ensureHoldState()` 读回；快照指纹与读取签名改存 `chrome.storage.session`（浏览器关掉才清）。
2. **注入脚本的转义被模板字面量吃掉**：`DEEP_HELPER` 写在模板字面量里，`/\s+/g` 与 `'\n'`
   在求值时变成 `/s+/g` 与真实换行 ⇒ 页面侧直接语法错，`find`/`snapshot` 全挂。
   修法：模板里必须写 `\\s` / `\\n`；另外 `browser_wait` 的 `stable` 条件漏了 `${DEEP_HELPER}`（`__dshShadowText is not defined`）。
3. **"用户接管后不再自动补"永远不会触发**：检测放在命令结束后比对，而用户双击撤层不经过任何命令
   （下一枪会先把层补回来再比对）。改成补层前读页面 `window.__dshHold`：上一次是 `user`/`abort` 撤的
   就把该标签页拉黑；`hold.on` 解除拉黑。
   附带：**黑名单模式下截图会拍到暗色浮层** ⇒ 截图前 `visibility:hidden`、拍完恢复（已用真截图确认画面干净）。

实测（tab 逐条，都是真命令）：新标签页点击 ⇒ 自动出层（`autoStats.added` +1、文案「模型正在操作这个页面」）；
`content` 正文 **不含**浮层文字、含 shadow 表格文字、`settled: true`；截图画面无暗层且拍完浮层仍在；
模拟用户接管后再点一次 ⇒ `autoSuppressed: true`、跳过原因 `user-took-over`、不再补层；`hold.on` ⇒ 重新出层。

**Esc 接管（主人问的那条）**实测三种情形，都按设计走：
单次 Esc ⇒ 不接管（`active: true`、`dismissedBy: null`）；800ms 内连按两下 ⇒ 接管（`dismissedBy: user`）；
按住 700ms ⇒ 接管（`dismissedBy: user`）。双击路径未变（0.11.26 台架已验），且双击**不拦模型**，
只有「中止操作」按钮才把后续 click/input/press/nav 拦下。

**状态（2026-10-19 深夜）**：①②③ 已在 0.11.38 / 扩展 1.0.39 实现，④ 未做。

### 上游 PR #18：接管浮层（2026-10-20）

主人定的流程：「上游同意搞的向上游提 PR，等合并后我们插件从上游拉，再把自己的改动一并做了」。

- 分支 `feat/hold-overlay`（commit `0fe5da4570`，24 文件 +911/-33），PR **#18** <https://github.com/caob23/dsh-browser-control/pull/18>，`mergeable: true`。
- 内容按维护者 #17 那五条写：一条 `hold` 命令（on/off/status）、状态在 `chrome.storage.session` 按 tabId、`covered:false`+reason、
  原生弹窗不碰（只回 recentDialogs）、`data-dsh-hold` 子树从 content（含 html）/find/snapshot 排除、
  `hold` 登记为写操作 + 只读档专属拒因（`PAGE_MUTATING_COMMANDS`）、文档契约表 + README 双语 + llms 信任边界。
- 两处需要维护者拍板的偏离已在正文写明：双击接管**不**拦模型（他原始 issue 写的是拦）、`hold` 一条命令带 action ⇒ 只读档连 status 也拒。
- 本地验证：基线 478 → 本分支 **535 PASS / 0 FAIL**（新增 `verify_hold.mjs` 44 项 + 四张对账台）。
  页面侧三个函数抽出来放进真 Edge 156 跑过：13 条断言 + 几何探针（fixed / 铺满 / z-index 最大 / 中心命中 / 遮罩 0.42）。
- **后续（等合并）**：从上游 main 拉一次，把我们自己的增强叠回去（黑名单自动补层、穿透 shadow root、Esc 双击/长按措辞、buddy 工具面），
  并复核两处上游新增的 fail-closed（锁读不出按冻结、`init()` 先读锁）与我们 0.11.39 的行为是否冲突。

### 分工定盘：引擎归上游、闸门归宿主、策略与产品归我们（2026-10-20）

全文见 `路线分工-2026-10-20.md`。要点（读本机实装代码得出，dsh 0.2.0-rc.2）：

- 宿主已有闸门机制：`tools/pre-execute` waterfall（`dsh-tools/lib/index.js:3225`），`exec` 只带
  `name + arguments`（`:3131–3160`）且 `arguments` 是深度冻结快照；闸门返回 `ask` 而宿主没有审批服务时
  降级成 **deny**（`:3439` 起 `serviceAsk`）。→ 我们不再自建闸门机制。
- 现成通用件 `@yeesy369/dsh-web-permission@0.6.1` 两个洞：只认 `args.url`（默认列了
  `browser_click/type/fill`，但那些工具的参数里没有 url ⇒ 静默放行）；`denyHosts` 只有精确主机名单，
  没有网段/端口/协议/三档概念。→ 我们的三档分类器是补洞，不是重复造轮子。
- 我们的闸门现状不能自我感觉良好：`GuardedBridge` 只拦 `nav`/`tabs.open`，文件头自认 redirect/XHR/iframe
  不拦；扩展侧也没有 `onBeforeRequest`/`declarativeNetRequest` ⇒ 请求级逃逸两边都开着，这是空白。
- 对上游只提一条契约（命令执行前声明"这次碰哪个源"，`eval` 特殊、`nav` 回报最终 URL），不谈权限分层；
  性质同已合并的 #15/#16。
- 候选动作：A（把三档策略迁成宿主 pre-execute 的消费者 + 把"有效目标"缺口提给宿主件，维护面变小，
  推荐）/ B（先补请求级逃逸，工作量最大、要扩权限）/ C（先解命名空间）。
- 接上"合并多条路线"的技术前提：`@yeesy369/dsh-browser@0.6.0`（MIT）已定义公开接缝 `ctx.browser`
  （`BrowserRuntime` + `BrowserPage`，方法面与我们命令几乎一一对应，`windowVisibility` 支持
  visible/hidden/headless，一个上下文只允许一个实现）⇒ 整合发生在接口层，而不是代码拷贝层。

### 生态路线盘点（2026-10-20）

全文 `生态路线盘点-2026-10-20.md`（数据取当日 GitHub API / npm 下载量，痛点全部来自对方 README、限制文档、未关 issue）。
一句话：**再写 driver 没位置**（仓库名含 `dsh-browser` 的 278 个，头部 ★861 / 周下载 6387 且已跑基准），
空位在三个横向层——接缝不统一、闸门只认 `url` 参数、载体与登录态差异每家重踩。
已有前例证明整合可行：hy-sde 在 `ctx.browser` 下一个包并四个后端（含 relay+扩展驱动用户自有标签页），
yeesy369 把接缝/工具层/闸门拆成三个包；但没有一家把两者合起来，也没有载体差异与安全基线的公共件。
风险同时记：接缝无官方地位（本机 dsh 里 `ctx.browser` 零匹配，官方只有 `ctx.browserUse` 名字槽）、许可证分裂（AGPL vs MIT vs 内嵌 GPL）。

### 上游 v1.0.19 的四处复审问题 ⇒ 本地已合（2026-10-20 晚，扩展 1.0.41 / core 0.1.11 / 插件 0.11.40）

维护者把 PR #18 合了（`070f48b`），并在 `2b278d2` 里补了他合并后真环境量出来的四处，随 **v1.0.19** 发布，
上游台子 535 → **548 项 exit 0**。逐条对我们本地（`src/extension/background.js`）：

| # | 上游的问题 | 我们本地 | 处置 |
|---|---|---|---|
| 1 | 模型的点击被自己的浮层吃掉；同坐标连点两下会被浮层的双击接管当成用户操作、以用户名义关掉层 | **已有**：`cmdClick` 整体包在 `withHoldPassthrough` 里（派发前宿主 `pointer-events:none`、派发后恢复） | 补 `bypassedOwnOverlay:true` 结果字段（诊断用），与上游字段名对齐 |
| 2 | AX 快照把浮层自己编进去了（卡片上「中止操作」占一个 ref） | **确有**（AX_STAMP_FN 无浮层排除；DOM 路径本来就有，所以只有 ax 漏） | `AX_STAMP_FN` 遇 `[data-dsh-hold]` 返回 `{ownOverlay:true}`：不占 ref、不计入 `total`，`ax.ownOverlay` 单独计数。**我们的浮层在 shadow root 里，`closest` 跨不过去**，必须再走 `getRootNode().host.closest(...)`（与上游的纯 div 版本不同，已真机验证 `closest` 返回 null、host 路径返回宿主） |
| 3 | `hold on` 会静默清掉「用户中止」 | **确有**（`pageShowHold` 里 `aborted:false` 直接覆盖） | 中止期间 `hold.on` 拒（前缀 `browser-hold-aborted:`，不注入任何东西）；`maybeAutoHold` 探针加 `aborted` 并跳过（skip 原因 `aborted`） |
| 4 | 只读档把 `hold status` 也拒了 | **本来就对**（`READ_ONLY_ALLOWED` 含 `hold.status`） | 不动 |

配套：`core/errors.ts` 加 `held_by_user`（唯一的新 code）+ 导出 `HOLD_ABORTED_MARKER` +
`hold.on`/`hold.off` 进 `WRITE_COMMANDS`（超时=unknown，不能当只读）+ classify 去掉线上前缀后再给模型看。

**台子**：新增 `tests/extension-hold.mjs`（23 项，node:vm 加载**真实的** background.js + 假 chrome/假 CDP）：
AX 排除（shadow 内节点判成自己的浮层、不写 `data-dsh-ref`、页面节点照常打 ref、反向不误判）、
`hold.on` 中止期拒（含阳性对照：无中止时照常注入一次）、点击旁路（`bypassedOwnOverlay`、派发前后 `pointer-events` 一开一关、反向不谎报）、
`classify` 的 `held_by_user`/`not_started`/前缀剥离。三处变异测试都验过会红：
摘 AX 排除 → 2 红；摘中止守卫 → 3 红（注入次数=1）；摘透明旁路 → 2 红。`node tests/run-all.mjs` **11/11 套件通过**。

**真机证据（部署前，扩展 1.0.40）**：给 example.com 挂浮层后 `browser_snapshot mode=ax` 读出
`e2 <button> [button] 中止操作`（占 ref，正是上游描述的形状）；同一时刻 DOM 快照只有 1 个元素（`e1`）⇒ 只有 AX 路径漏。
shadow 边界也真机验过：shadow 内节点 `closest('[data-dsh-hold]')` 返回 null，`getRootNode().host.closest(...)` 返回宿主。

**待办**：扩展已部署到 `/mnt/d/edge-extensions/dsh-browser-extension`（1.0.41，备份 `dsh-browser-extension.bak-20261020-2120-pre1041`），
**需要主人到 `edge://extensions` 点一次重新加载**；重载后要复验 ax 快照里不再出现「中止操作」。
另有上游自认缺的那层（真 MV3 worker / CSP / 跨源 iframe 的端到端），我们的真机台子能补——按主人定的 B/C 计划，重载验完再整理成给上游的证据。

### 重载后真机复验（2026-10-20 21:3x，扩展 1.0.41 已连上桥）

三条都在**真 Edge + 真 MV3 扩展**上跑过（不是假件）：

1. **AX 快照不再漏浮层**：`browser_hold action=on` 之后 `browser_snapshot mode:"ax"` 只回
   `e1 <a> [link] Learn more`——重载前同一步读出的是 `e1` + `e2 <button> [button] 中止操作`。修复前后同一操作对照，干净。
2. **点击不吃自己**：浮层在场时点页面上自建的 `#dsh-probe-btn`，结果
   `hitVerified:true, bypassedOwnOverlay:true`，页面侧 `window.__dshProbeClicks === 1`（真的点到了），
   同时 `window.__dshHold = {active:true, dismissedBy:null}` ⇒ 浮层没有被"当成用户双击"关掉、也没有误记 `dismissedBy:'user'`。
3. **中止期拒绝再挂层**：把页面状态置成 `aborted:true`（模拟用户按过「中止操作」）后调 `browser_hold action=on`，
   被拒且文案以 `browser-hold-aborted:` 开头、`effectState=not_started`（页面没被动过）。
   注意：这一步跑的是**内存里还在的插件 0.11.39**，所以 code 仍是 `command_failed`；
   `held_by_user` 要等 dsh 重启加载 0.11.40 才生效——文案里的前缀已经对了。

复验后现场已复原（浮层 off、`aborted:false`、探针按钮删除）。

**这一层正是上游自认缺的**（他的 issue 正文原话：真 MV3 worker 走真扩展的注入链没有端到端断言，
CSP/全屏/跨源 iframe 只保证如实回报 `covered:false`）。我们的真机台子能补，下一步整理成给上游的证据（对外文本先给主人过目）。

### 重启后状态 + 三项覆盖场景实测（2026-10-20 21:3x–21:4x）

**插件侧状态（QQ 桥重启后）**：桥连上、扩展 1.0.41；插件 0.11.40 + core 0.1.11 **确已加载**（两个新行为都验到：
ax 快照多一句「另有 1 个节点是插件自己的接管浮层，已跳过、不占 ref」；中止期 `hold on` 回 `[held_by_user]` + `not_started`）；
`browser_policy_status` 正常（外网/局域网/本机均显式 allow、浮层黑名单模式已推送 black、配对 config-verified @13:30:38Z）。
QQ 桥 13:30 那次重启只换了它自己的 dsh 进程（驱动本会话），没有动浏览器插件，也没抢 9777。

**三项覆盖测量**（真 Edge 155；判据 `document.elementFromPoint(场景中心)` 返回谁）：

| 场景 | 结果 |
|---|---|
| 普通页面 | 命中浮层宿主 ⇒ 覆盖 |
| CSP（meta 注入 `style-src 'none'; script-src 'none'`） | 浮层无 `<style>` 元素、样式走 CSSOM 内联；卡片 rgba(8,10,14,.45)+白字+fixed+z 最大全生效 ⇒ 覆盖 |
| 跨源 iframe（example.org 600×400） | iframe 中心命中浮层宿主 ⇒ 覆盖 |
| **全屏元素** | 命中全屏元素本身；浮层在 DOM、rect 铺满视口，但 `fullscreenElement.contains(host)===false` ⇒ **不覆盖** |

**结论**：全屏是第四个"盖不住"的场景（top layer 压过 body 层，z-index 无用），而我们**还照样回报"已锁住"**——
用户屏幕上什么都没有，浮层上的「中止操作」也点不到。上游 `covered/reason` 现在只覆盖错误页/浏览器页/devtools。
本地是否按"注入时挂进 fullscreen 子树 + 监听 fullscreenchange 重挂 + 补 covered:false"修，等主人定。

给上游的证据草稿已更新：`上游证据-真MV3端到端-2026-10-20.md`（未发）。

### 全屏覆盖修复（2026-10-20 21:5x，扩展 1.0.42 / 插件 0.11.41）

量出来的第四个"盖不住"的场景，按主人"先修全屏"的要求改掉：

- **改法**：`pageShowHold` 不再无条件挂到 `document.documentElement`，而是按 `document.fullscreenElement` 选挂载点
  （全屏元素是 `<iframe>` 时挂不进去）；同时注册一次 `fullscreenchange` 监听，进出全屏都把宿主搬过去；
  浮层撤掉（`pageHideHold` / 用户双击 / 中止）时把监听摘掉。
- **如实回报**：`pageShowHold` / `pageHoldStatus` 现在都现场量覆盖 —— 全屏元素在场且宿主不在其子树 ⇒
  `covered:false, reason:'fullscreen-behind-top-layer'`；全屏元素是 iframe ⇒ `'fullscreen-iframe'`；
  否则用 `elementFromPoint(视口中心)` 打一次命中测试，没打到宿主 ⇒ `'hit-test-miss'`。**不信"我挂上去了"这件事。**
- **插件侧**：`browser_hold` 输出加 `covered` / `reason`；`render` 在 `covered:false` 时明说"浮层没盖在用户眼前"
  并点出全屏原因，不许再把"已锁住"当作"用户已知情"。
- **台子**：`tests/extension-hold.mjs` 37 项（新增 14 项跑**真实的** `pageShowHold`/`pageHoldStatus`，配一台够用的假 DOM）：
  普通页面挂 documentElement 且 covered:true、全屏时挂进全屏子树且 covered:true、全屏是 iframe ⇒ covered:false+原因、
  挂上之后进/出全屏由 `fullscreenchange` 搬动、宿主留在 body 层时 status 必须说 covered:false、
  命中测试没打到宿主也算没覆盖。三处变异都验过会红：摘掉全屏挂载点 → 2 红；摘掉 status 的全屏判定 → 1 红。
  `node tests/run-all.mjs` 11/11 套件通过。
- **部署**：扩展 1.0.42 已放进装载目录；插件 0.11.41 已装进 profile。**两处都要重启才有意义**
  （扩展要 `edge://extensions` 重载一次，插件要 dsh 重启）。真机复验：全屏时 `browser_hold action=on` 应报 `covered:true`，
  且 `elementFromPoint(视口中心)` 命中浮层宿主而不是全屏元素。

**全屏修复真机复验（2026-10-20 22:0x，扩展 1.0.42）**：`requestFullscreen()` 之后 `browser_hold action=on`，
测得 `overlayParent='fs-probe'`、`overlayInsideFullscreen=true`、`elementFromPoint(视口中心)='__dsh_hold_overlay__'`
⇒ 全屏下真的盖住了（修复前同一操作命中 `fs-probe` 本身）。退出全屏后宿主自动搬回 `HTML` 且仍盖住 ⇒
`fullscreenchange` 两个方向都对。**插件侧的 `covered` 文案还没生效**：本机 dsh 进程起于 21:30:30，没重启过，
内存里仍是 0.11.40；0.11.41（含 covered/reason 输出与 covered:false 文案，含 status）已构建并装进 profile，等重启。

### 交上游前的遗漏复查（2026-10-20 22:0x）

主人问"确认没有其他遗漏？要不要再全量测一次"——查出来四处，已补三处、押后一处：

1. **文档版本号没跟上**：README（en/zh）还写着扩展 1.0.41 / 插件 0.11.40。已改 1.0.42 / 0.11.41（含 tgz 文件名与安装命令示例）。
2. **插件 README 没写"盖不住会说出来"**：补了一段（全屏时按 `fullscreenElement` 选挂载点、`fullscreenchange` 跟随、
   现场命中测试、`covered:false` 的三种原因）。用户读文档时才知道这是设计而不是故障。
3. **回执文案没有插件级测试**：`covered:false` 的两条分支（on / status）只有扩展侧台子覆盖过。
   在 `tool-render.mjs` 加 6 项（`[13b]`）：盖不住时不再只说"已锁住"、点名全屏原因并提醒别当用户已知情、
   正文照带、status 说明原因、`covered:true` 时不多说废话、正常路径不回退。台子 105 → **111 项**。
4. **（押后）自动补层没记"盖不住"**：黑名单模式下 `maybeAutoHold` 只数 `added`，不区分"补上且盖住"与"补上但盖不住"。
   改动本身只有一行（自动路径加个 `uncovered` 计数），但它要重发扩展 ⇒ 再让主人重载一次，不值得为诊断字段加一次重载。
   **等下一个扩展版本一起发**，已在这里留痕。

**全量回归**：`node tests/run-all.mjs` 11/11 套件、**370 项**全绿（bridge-http-auth 32、buddy-merged 28、config-hot-update 11、
emulate-contract 12、error-contract 31、extension-hold 37、permissions-read 24、permissions-resolve 6、registry-consistency 23、
render-settings-pages 55、tool-render 111）。仓库与已部署件逐字节一致（扩展 background.js/manifest.json、插件 lib/）。

**真机回归（扩展 1.0.42，重启前也有效：只涉及扩展）**：
新标签页 ⇒ 黑名单模式自动补层（`overlay:true`，不用模型调 `hold`）；层在场时点页面按钮 ⇒
`hitVerified:true, bypassedOwnOverlay:true`、页面侧计数 +1、`dismissedBy:null`（没被当双击关掉）；
`mode:"ax"` 快照 ⇒ 只有真实元素（`e1` 链接 + `e2` 按钮），并注明"另有 1 个节点是接管浮层，已跳过"；
含浮层时截图与撤层后截图 **sha256 完全相同**（截图前会临时隐藏浮层，验证仍成立）。测试页签已关、探针已清。
另：`hold off` 之后同一标签页本会话不再自动补层（`dismissedBy:'agent'`），这是设计，不是回归。

### 给上游的证据已发出（2026-10-20 21:45 UTC+8，PR #18）

- 帖子：<https://github.com/caob23/dsh-browser-control/pull/18#issuecomment-6292331056>（作者 `long-arm-ape`，3288 字符）。
- 正文＝`上游证据-真MV3端到端-2026-10-20.md` 去掉开头两行给主人看的草稿说明；工具按惯例自动追加了 AI 披露页脚（含 `@Short-Arm-Ape`）。
- 内容：三条修法前后对照（AX 快照漏浮层 / 点击被自己浮层吃掉 / `hold on` 清中止）、shadow root 下 `closest` 跨不过边界的提醒、
  三项覆盖实测（CSP 覆盖、跨源 iframe 覆盖、**全屏不覆盖**）、我们本地全屏修法与真机复验、以及如实列出没验的（响应头 CSP、
  `chrome-*` 页、全屏 iframe 只在假 DOM 验过）。
- 纪律：按「能编辑就不新增」，后续这条 thread 上的补充**改这条评论**，不再新增；维护者回话前不再对外发言。

### 体验优化：不抢焦点 + 弹窗关掉后自动补层（2026-10-22 深夜，扩展 1.0.43 / 插件 0.11.43）

主人原话：「网页有弹窗的时候该配置的窗口会自动跳到前台，而用户这时可能在操作别的造成误触，这也是我最开始加 hold 的原因」。
两处来源：① **我们自己**在每次点击/输入前调 `chrome.windows.update({focused:true})`（`activateTabWindow`），
等于把浏览器窗口提到前台；② 浏览器在页面弹原生对话框时会把那个窗口/标签端到前台（这层改不了，只能缩小后果）。

- **焦点策略 `focusMode`（默认 `auto`）**：auto＝只 `tabs.update(active)`、**不**抢窗口焦点（切标签页不会把非前台窗口提上来）；
  always＝旧行为；never＝连标签页都不切（后台操作，键盘类可能到不了）。窗口最小化仍照旧报 `window_minimized`（不擅自 restore）。
  插件在首次交互/配置变更/扩展重连时把 `hold.config` 与 `focus.config` 一起推下去；旧扩展不认识 `focus.config` 就退回旧行为。
- **弹窗关掉后补层**：`Page.javascriptDialogClosed` 事件里，若 `holdMode=black` 就对该标签页补层 ——
  弹窗通常刚把窗口提到前台，关掉后用户的下一次点击极易落在页面控件上，补层让这次误触落在浮层上。
- 设置页「访问控制」卡新增「操作时是否抢焦点」三选一；`describePolicy()` 报出 `focusMode`。
- **台子**：`extension-hold.mjs` 37→**47** 项（auto 不调 windows.update、always 调、never 两者都不调、非法值回落 auto、
  最小化仍报错、弹窗关闭补层、白名单模式不补层）。两处变异验证过会红：把 auto 写死成抢焦点 → 2 红；删掉补层 → 1 红。
  `run-all` **12/12 套件**；`render-settings-pages` 59→**60**。
- 部署：扩展 1.0.43 已放进装载目录（**需重载一次**）；插件 0.11.43 已装进 profile（**需重启 dsh**）。
  重载后的真机待验：alert 弹窗关闭后该标签页自动出层、且模型点击时窗口不再被提到前台。

### 体验优化（二）：窗口最小化与尺寸变动（2026-10-22 深夜，扩展 1.0.44 / 插件 0.11.44）

上一版只解决了「抢焦点」，这一版把「窗口最小化 / 被改过大小」这两类情况也做成有信息的行为：

- **最小化不再一律硬失败**：`activateTabWindow` 只如实回报 `{windowState, minimized, restored}`；真正的判定挪到
  `inputSurface()` —— 先读视口，**只有「最小化且视口确实 0×0」才拒**。理由：渲染器通常保留最后的布局尺寸，
  CDP 注入的点击/按键照样进得去；过去那句"最小化 ⇒ 0x0 视口"是**猜**，现在改成**量**。
- **拒的时候给出三条出路**：让用户恢复窗口 / 改「操作时是否抢焦点」为 always 并打开「最小化时自动恢复窗口」/ 只读页面不点击。
- **新配置 `restoreWhenMinimized`（默认关）**：开着时先 `windows.update({state:'normal'})` 再执行；注意恢复会**顺带取消最大化**，所以默认不做，文案里写明。
- **窗口尺寸变动如实上报**：每次输入类命令读一次视口（`innerWidth/Height/dpr`）并与上次比较；变了就在回执里带
  `viewportChanged: true` + `previousViewport`，回执平时也带 `viewport`。另监听 `chrome.windows.onBoundsChanged` 清掉缓存，
  保证窗口一动，下一枪一定报"变了"。
- **台子**：`extension-hold.mjs` 47→**59** 项：最小化但有尺寸照常点击、0×0 才拒且拒因含三条出路、自动恢复只 restore 不 focused、
  尺寸变化后报 `viewportChanged` 并带回旧尺寸。两处变异验证过会红（去掉 0×0 判定 → 该用例直接红；去掉视图比较 → 2 红）。
  `render-settings-pages` 60→**61**（钉住新开关与"恢复会取消最大化"的提醒）。`run-all` 12/12。
- 部署：扩展 1.0.44、插件 0.11.44 已就位（**都需重载/重启生效**）。

### 让模型不必等页面加载（2026-10-23 晚，扩展 1.0.45 / 插件 0.11.45）

主人原话：「改进下，让模型可以不等待页面加载」。过去 `nav` 一律等 `waitForNavigationComplete`（默认预算 15s），
慢页/不可达目标每次都把一整轮调用挂住。

- **等待口径 `waitUntil`**（扩展 `nav` + `tabs.open`，插件 `browser_navigate` 暴露）：
  `none`＝不等待（立刻回）、`commit`＝地址落地即回、**`domcontentloaded`（默认）＝DOM 一可用就回**、`load`＝老行为。
  认不出的值按默认口径处理，模型写错不会变慢/报错。`params.wait === false` 仍等价 `none`（老调用不受影响）。
- **`loadPending` 与等待口径解耦**：它现在表示「文档还没到 `complete`」，而不是「没按我的口径等到」。
  选了 `commit`/`none` 时页面**本来**可能还在加载，回执如实说「仍在加载」并给下一步（`browser_wait` 的 selector/text/fn 或稍后 read），
  不再用「15s 内没等到完成」这种套话；`domcontentloaded` 命中时也不再吓唬人。
- **回执带证据**：`waitUntil` / `readyState`（`interactive` 就够读了）/ `waitedMs`。
- **台子**：`extension-hold.mjs` 59→**71**（none 立刻回且 loadPending、commit 不等 load、domcontentloaded 认 interactive、
  非法值回落、load 超时仍如实报）；`tool-render.mjs` 111→**115**（三种回执措辞）；变异验证：把 `navWaitMode` 写死成 `load` → 5 红。
  `run-all` **12/12 套件、448 项**。
- 部署：扩展 1.0.45 / 插件 0.11.45 已就位（**需重载扩展 + 重启 dsh**）；生效后 `browser_navigate` 默认几百毫秒内返回。

### 导航等待：默认口径 + 真机读数（2026-10-23 深夜，扩展 1.0.47 / 插件 0.11.46）

真机（Edge，扩展 1.0.45 已加载时）实测：

| 场景 | 口径 | 读数 |
|---|---|---|
| `https://www.bilibili.com/` | domcontentloaded（默认） | **958ms**，readyState=interactive，loadPending=true |
| `https://www.zhihu.com/` | load | **4492ms**，readyState=complete |
| `https://example.com/` | none | **37ms**，readyState=loading |
| 不可达 `http://10.255.255.1/`（显式 timeoutMs=3000） | domcontentloaded | 3006ms（等满预算） |
| `https://www.bing.com/` | commit | **15022ms —— 缺陷**：重定向落到 `cn.bing.com`，"地址必须一字不差"的判据把整轮拖到超时 |

据此修了三处（都在 1.0.47 / 0.11.46）：

1. **commit/domcontentloaded 的判据放宽**：地址**变了**（不再等于导航前的地址）就算 commit，重定向不再卡住；`tabs.open` 以 `about:blank` 作为旧地址。
2. **默认预算按口径分档**：`none`=0、`commit`/`domcontentloaded`=**4s**、`load`=15s（黑洞目标不再干等 15 秒）；显式 `timeoutMs` 优先。
   `none` 的落地探针预算也从 2.5s 压到 500ms，让"立刻回"名副其实。
3. **回执措辞不再混用**：`waitedMs` 有两个来源（导航等待 / 条件等待），只有后者才说"等待条件成立"；
   新增 `waitConditionMet` 标记；没有 `waitUntil` 的老扩展至少报"导航等待 Nms"。

台子：`extension-hold.mjs` 71→**78**（重定向不被卡住 + 预算分档）；`tool-render.mjs` 115→**117**（措辞区分）。`run-all` 12/12。

### 导航等待：把"到达"判据换成 CDP 事件（2026-10-24，扩展 1.0.48）

1.0.47 复测 Bing（`waitUntil=commit`）仍是 **4010ms**（等于 4s 预算），原因不是预算，而是**判据**：
我们拿"地址是否变了"当 commit 信号，而 bing.com 会重定向回 `cn.bing.com` —— **目标地址与当前地址相同**，
`!landsAt(tab.url, previousUrl)` 永远为假 ⇒ 一直等到预算耗尽。

改成事件驱动：预先挂 debugger（`Page.enable`），在主框架 `Page.frameNavigated` 到达时立刻算"提交完成"；
地址匹配只作为兜底。`commit` 收到事件即回、`domcontentloaded` 收到后再读一次 `readyState`、`load` 仍等 `load`。
台子 `extension-hold.mjs` 78 项（含"同站重定向回到同一地址"这条，靠 `fireCdp('Page.frameNavigated')` 驱动）。
`run-all` 12/12。

**1.0.48 真机复测（2026-10-24，Edge，扩展 1.0.48 / 插件 0.11.46）**

| 场景 | 口径 | 修复前 | 修复后 |
|---|---|---|---|
| `bing.com`（重定向回 `cn.bing.com`） | commit | 4010ms（撞 4s 预算） | **406ms** |
| `bilibili.com` 首页 | domcontentloaded（默认） | 958ms | **1164ms**（readyState=interactive，页面后台继续加载） |
| `10.255.255.1`（不可达黑洞） | domcontentloaded（默认） | 15000ms | **4051ms**（4s 预算上限） |
| `example.com` | none | 37ms | 37ms |

页面没 commit 时 tab 仍显示旧页（上面黑洞那条标题还是 bilibili）—— 这是对的：导航没成功就不该假装换了页。

### 开工检查（2026-10-24 立，主人同意）

碰**契约 / 正确性 / 引擎行为**类改动前，先核一遍上游现状，并把结论写在方案第一行（三选一）：
「上游已有（在哪、怎么用）」「上游计划中（roadmap/issue 号）」「上游没有」。
做法：`/repos/<owner>/<repo>/commits?per_page=5` + `docs/CAPABILITIES.md`（roadmap）+ `docs/BEHAVIOR.md`（契约）+ 未关 issue/PR。
理由：这一轮做"不等页面加载"时，扩展层其实早有 `params.wait === false` 与 `timeoutMs`，只是模型面没暴露；
如果先核一遍，方案会从"新增能力"直接变成"把已有开关接出来"，省掉一轮重复。

### 上游 issue #19：等待口径与事件驱动到达（2026-10-24）

发出：<https://github.com/caob23/dsh-browser-control/issues/19>（作者 `long-arm-ape`，1848 字符）。
内容三件：① `browser_navigate` 暴露 `timeoutMs`（修"raise timeoutMs"这个模型拿不到的旋钮）；
② `waitUntil` 三档（默认 domcontentloaded）；③ 到达判据换事件驱动（对应上游 1.1.0 roadmap 第 4 条，
用已挂的 `chrome.debugger` 收 `Page.frameNavigated`，**不需要新增 webNavigation 权限**）。
正文里给了真机读数（none 37ms / commit 406ms / domcontentloaded ≈1.1s / 不可达 4s vs 原 15s）与"同站重定向"的坑，
并说明愿意按 house rules 拆两个 PR；若他自己做 #4 我们只给读数不占 PR 位。

纪律：这条 thread 上后续补充**改这条 issue 的正文**（PATCH），不新增评论；他回话前不再对外发言。

### 焦点实验：CDP 输入需不需要窗口焦点（2026-10-24 真机）

三种条件，页面里自建按钮/输入框 + 捕获期事件日志：

| 条件 | 判据 | 鼠标 click | 键盘 press |
|---|---|---|---|
| 可见 + 前台 | `visibility=visible`、foreground=Edge | **送达**（计数器 1，mousedown/click 都在） | **送达**（输入框变 `a`） |
| 可见 + 失焦（记事本在前台） | `visibility=visible`、foreground=Notepad(48676) | **送达**（计数器 1） | **送达**（`a`） |
| 最小化（`outerWidth=0`、`visibility=hidden`） | 窗口被 SW_MINIMIZE 后 | **未送达**（计数 0、无事件），回执却仍 `hitVerified:true` | 同理会丢 |

结论：
1. **可见时不需要窗口焦点** —— 这是我们 `focusMode=auto`（只切标签页、不抢焦点）成立的依据；鼠标与键盘都验过。
2. **发现真缺陷**：页面 hidden（最小化/被完全遮挡）时，`Input.*` 被静默丢弃，而我们回报 `hitVerified:true` = **假成功**。
   上游没有这个失败面，因为它**无条件 `windows.update({focused:true})`**（"Bring the window forward so real input can land"）——
   代价就是抢焦点误触。我们的 `viewport 0×0` 检查也挡不住它（最小化时 `innerWidth` 仍是 1416）。
3. 待定：auto 模式在 hidden 时是"自动抬窗口"还是"报 `page_hidden` 让用户自己切"（问主人）。

收尾：探针元素已删；关掉测试标签页=关掉那个窗口 ⇒ 桥断、插件按既有行为自动重开了一个 `about:blank`（触发= browser_tabs）。

### 焦点实验（重跑·完整版，2026-10-24 17:0x，窗口级对照）

这次先定位到**插件控制的那个窗口**（`EnumWindows` 找 pid=23288 里标题 `Example Domain - Agent - Microsoft Edge` 的 hwnd=721058，
与大窗口 659138 区分开），再逐条件摆布，每步都读页面侧的 `visibilityState` / `outerWidth` 与事件日志：

| # | 条件 | 页面读数 | click 是否送达 |
|---|---|---|---|
| 1 | 被最大化的大窗口**完全遮挡** | `hidden`, outerW=1054 | **送达** ✓ |
| 2 | 正常可见 + 前台 | `visible`, hasFocus=true | 送达 ✓ |
| 3 | 可见 + **失焦**（记事本在前台） | `visible` | 送达 ✓ |
| 4 | **最小化**（`IsIconic=True`） | `hidden`, outerW=157 | **送达** ✓ |
| 5 | **窗口没有实际几何**（outerW=outerH=0，窗口建了但没显示出来） | `hidden`, outerW=0 | **未送达**（计数器 0、零事件），回执仍 `hitVerified:true` |

⇒ 更正上一轮结论：**"hidden" 本身不会让输入丢失**（遮挡、最小化都照送）。唯一被证实的静默丢失条件是
**窗口 `outerWidth/outerHeight = 0`**（窗口存在但从未真正显示）。这解释了上一轮那次"丢输入"——当时正是 outerW=0
（自动拉起的窗口还没落位），而我把它归成了"最小化/遮挡"，是错的。

代码含义：`visibilityState` 不足以当判据，应该看**几何**（`outerWidth/outerHeight === 0`）：
碰到这种情况先试着 `windows.update({focused:true})` 让它落位，再探一次；仍是 0 ⇒ 抛结构化错误（`not_started`），绝不回报 `hitVerified:true`。

### 修：窗口没显示出来时输入静默丢失（2026-10-24，扩展 1.0.49 / core 0.1.12 / 插件 0.11.47）

按上面重跑的结论改的，判据从 `visibilityState` 换成**几何**：

- `geometryInfo()`：读 `outerWidth/outerHeight/visibility`。**探针失败（空/非 JSON）不算"没显示"**——误判会把能用的点击全拒掉。
- `inputSurface()`：几何 0×0 ⇒ 先 `windows.update({focused:true})` 让窗口落位（不动最大化状态；`focusMode=never` 时不做），400ms 后复探；
  仍是 0×0 ⇒ 抛 `browser-window-not-shown:`（`code=window_not_shown`、`effectState=not_started`），**不派发任何输入、不回报 `hitVerified:true`**。
  另外保留一条：几何正常但**视口 0×0**（页面没布局）走同一错误。
- core `errors.ts`：新码 `window_not_shown` + `WINDOW_NOT_SHOWN_MARKER` + HINT（指向"让用户把窗口切出来"，不是"换选择器重试"）+ classify 剥前缀。
- 台子：`extension-hold.mjs` 78→**85**（有几何不抢焦点 / 0×0 落位成功照常执行 / 一直 0×0 报错且零派发）；
  `error-contract.mjs` 31→**36**（新码、not_started、前缀剥离、文案指向）。
  变异验证：关掉落位重试 → 用例红；关掉报错 → 2 红。`run-all` **12/12 套件**。
- 部署：扩展 1.0.49 / core 0.1.12 / 插件 0.11.47 已就位（**需重载扩展 + 重启 dsh**）。

**1.0.49 真机复验（2026-10-24 17:1x）**：重载后命中一次**恰好是那个失败状态**（`outerW/outerH=0`、`visibility=hidden`）。
点 `#cds-click` ⇒ 回执 `hitVerified:true`，页面计数 **1**，且探针之后读到 `outerW=1054 / screenX=440 / visible`
⇒ 前置闸的 `windows.update({focused:true})` 把窗口**落位**了、复探通过、输入送达。
即"不再静默丢输入"这条在真机上闭环（代价：这一次确实抢了焦点——只有这种窗口没落位的情况才会）。

### 修：唤醒建的那张标签页要复用（扩展 1.0.50，2026-10-31）

起因：本机真机上出现过「同地址两张标签页」——自动唤醒先把窗口落在目标地址（未归组），紧接着
`browser_tabs action=open` 又新建一张（归组）。上游没有这个问题（它没有自动拉起层）。

改法（B+C）：
- **C**：`window.ensure` 建的标签页也归进 DSH 组（以前不归组，肉眼分不清哪张是唤醒建的）；
- **B**：唤醒建的标签页记进 `wokenTabs`（60 秒窗口）。`tabs.open` 若要去同一个地址，
  **复用**它（导航过去、`reused:true`），不再新建第二张。没有可复用的标签页时行为完全不变。

台子：`extension-hold.mjs` 85→**97**（复用、唤醒页归组、无可复用时照常新建）。
变异验证：关掉复用闸门 → 2 项红。`run-all` 13/13。

部署：扩展已到 `D:\edge-extensions\dsh-browser-extension`（1.0.50，待重载）；插件侧无改动（`reused` 走透传）。

### 全量只读自查：审计结论与待办坐标（2026-10-31 23:3x）

三路并行只读审计（各自的报告已在会话里，这里是可执行的落点）：扩展 `src/extension/background.js`、插件宿主侧 6 个文件、core+client。共 **39 条**：high 6（1 suspected）、medium 14、low 19。

**已修（提交 `de6d4c2` + `df85a4c`；发布位：扩展 `D:\edge-extensions\dsh-browser-extension` = 1.0.52，profile `self-plugins` = 插件 0.11.50 / core 0.1.13）**
- 扩展：`suppressAutoHoldIfTaken` 只认页内镜像 `dismissedBy`（导航销毁浮层不再被当成"用户接管"）
- 扩展：中止闸从 `cmdContent`（读）移到 `cmdInput`
- 插件：`content` 移出 `SCRIPT_COMMANDS`、进 `READ_ONLY_ALLOWED`（只读档下 browser_read 可用）
- 插件：`browser_permissions` 用 `userDataDir + profileDir`
- core：在途取消 → 新码 `cancelled_in_flight`，写操作 `effectState=unknown`
- client：`BrowserSectionBody` 拆成「只订阅的壳 + 只渲染的体」（hook 顺序）
- 更早：CDP 会话丢失透明重连（`clearAttachment`/`onDetach`/`withCDP` 一次重放）、`basePort` 漏传、`waitUntil:none` 措辞

**台子**：`extension-hold` 108 项（H1/H2 有变异验证）、`client-hooks-order`（自带变异对照）、`render-settings-pages` 64、`tool-render` 120、`run-all` **14/14**。

**待办（下次会话直接照坐标做，不必重新审计）**
1. `core/src/bridge/server.ts` `handleHttp`（≈391-444）：**不校验 Host/Origin**，`/api/status` 免 token ⇒ DNS rebinding 可读策略快照；照 WS 面复用 `isLoopbackHost` / `isTrustedUpgradeOrigin`
2. `plugin/src/index.ts` `guardHttpCommand`（≈1291-1311）：只读档/`allowScript` 只管工具面，`POST /api/command` 可绕过；开头复刻 `execute` 的两道判据
3. `core/src/bridge/server.ts` socket `data`/`error`（≈630-648）：缺 `this.clientSocket !== socket` 守卫，旧连接出错会拆掉**新**连接并把在途命令判成 `link_lost`
4. `plugin/src/unified-tools.ts` 写侧（≈544-548，读侧 ≈80-90）：`issues.json` 解析失败后写入会把整本登记簿覆盖成一条 → 改成 fail-closed（文件存在但读不出就拒写）
5. `extension/background.js` `cmdNetworkLog`（≈1037-1052）：`status:'failed'/'pending'` 只写"包含自己"没写"排除其余"，返回全部请求

其余 medium（按价值排序）：扩展 `previousUrl` 收了没用（541/1426，同 URL 刷新可能秒回旧文档）；扩展 `cmdWait` 的 timeoutMs 非硬上限（3196-3302，用 `withBudget`）；插件 `browser_dialog` 未过 `authorizeExistingTab`（2296-2304）且 `'dialog'` 不在 `HTTP_PAGE_COMMANDS`（≈480）；`wait`/`eval` 未按预算放大桥超时（2084/2851，60s 先到）；core `classify` 不认扩展的 `timeout after`（errors.ts ≈165，`/time[do]? ?out after/`）；autoLaunch* 热更新不生效（index ≈1052-1063 早退、1170 watchdog）；`learnFromHello` 失败时每 5s 全盘扫（724-749）。
low：console `levels:['warn']` 与 CDP `warning` 对不上、`Object.hasOwn` 查表、onRemoved 少清 `lastViewport`/`lastReadSignature`/`navArrivals`/`wokenTabs`、hold `focused` 恒 true、Esc 长按定时器、`maybeAutoHold` 与 handler 的 TOCTOU、console/network 的"没在采集"与"0 条"分不开、console `timestamp*1000`（suspected，需真机采一次）、AX 快照不重建指纹表、状态页 `innerHTML` 未转义、`cleanupArtifacts` 无扩展名过滤、self-update `unknown` 被当无漂移、client `set()` 返回 false 被当成功、client `T.border` 不存在。

**上游**：PR #20（timeoutMs）仍 open、无评审；② `feat/nav-wait-until`（远端 `7c77c9b`，基于 #20 的 `1c692f4`）已就绪，等 #20 合并后 rebase 开 PR（正文草稿 `D:\work\DSHWS\scratch\upstream-pr-waituntil-20261031\PR.md`）。git push 到 github.com 当时不通，用 Git Data API 建分支。

### 上面那 5 条待办已修 + 自查又挖出 2 条（2026-11-01）

**发布位**：扩展 **1.0.53**（`D:\edge-extensions\dsh-browser-extension`，background.js 哈希与源一致）/ 插件 **0.11.51** / core **0.1.14**（后两者走 `link:`，lib/dist 已重建）。

1. **HTTP 面 Host/Origin**（core `bridge/server.ts` `handleHttp`）：与 WS 握手共用同一份 `isTrustedRequestOrigin`（原名 `isTrustedUpgradeOrigin`）。Host 非回环、Origin 是公网网页 ⇒ 一律 403，`/api/status` 也不例外（它免 token，正是 DNS-rebinding 读策略快照的入口）。循环来源（DSH 控制页）与不带 Origin 的本机客户端照旧。
2. **HTTP 命令面也过访问控制**（插件 `index.ts`）：判据抽成 `accessDenial(command)`，`execute()` 与 `guardHttpCommand()` **共用**。以前只读档下模型调不动 `browser_click`，但带 token 的 `POST /api/command` 能点、能输入、能 eval。
3. **socket 身份守卫**（core）：`data` / `error` 加 `this.clientSocket !== socket` 早退。以前换链路后旧 socket 的坏帧/报错会拆掉**新**链路，并把在途命令判成 `link_lost`。
4. **登记簿 fail-closed**（插件 `unified-tools.ts`）：文件存在但解析失败 ⇒ 拒写并说明，原文件逐字节不动；文件真的不存在才新建。
5. **network.log 的 status 过滤**（扩展 `background.js`）：新增单点归一化 `normalizeStatusFilter`；`failed` / `pending` / `2xx..5xx` 各只回自己那一档，**拼错的值 ⇒ 0 条**（以前静默返回全部）。

**顺带发现并修（不在原审计清单里，两条都是真故障）**
6. **掉线永远不会被发现**（core）：`http.Server` 的升级 socket 是 `allowHalfOpen: true`，对端走掉只发 `end`、不发 `close`（`close` 要等我们也关写端，我们没关）。后果：`extensionConnected` 永远 true、状态面报「已连接」，之后的命令全熬到 60 秒超时。现在 `socket.on('end')` 也算掉线。
7. **首次 `browser_issues add` 必然失败**（插件）：写前无条件 `copyFile(file, file + '.bak')`，文件不存在时 ENOENT ⇒ 新建登记簿这条路从来没通过。现在只在文件已存在时备份。

**台子**：`run-all` **16/16**（新增 `http-face-access` 17 项、`issues-fail-closed` 14 项；`bridge-http-auth` 32→**42** 项；`extension-hold` 108→**128** 项）。**变异验证 8/8**（删掉任一条守卫 ⇒ 对应套件变红）。变异这轮交了两笔学费，记下来别重犯：
- 第 3 条第一次变异**没被抓住**：台子里的旧连接收到 FIN 就自己关了，「旧连接还活着、只是被换掉」那一刻根本复现不出来。改法：客户端 socket 用 `new net.Socket({ allowHalfOpen: true })`，并把 data / error 拆成**两对独立链路**分别测。
- 第一版"坏帧"写成了**掩码**帧（`0x83` 且少 3 字节载荷）⇒ 解析器只缓冲不报错，断言恒绿。改成真的未掩码帧（`0x81 0x03 'ABC'`）才有判别力。

**部署口径（2026-11-01 核，推翻此前记的 `link:`）**：DSH 实际加载
`D:\dsh-data\profiles\web\self-plugins\dsh-browser-unified`（插件）与 `…\browser-unified-core`（core）——
两处都是**实体拷贝**（各带自己的 `.git`），`profiles\web\node_modules\` 下只是指向它们的 junction。
所以在 `D:\work\dsh-browser-unified\src\packages\…` 里重建产物**不会**影响运行中的 DSH。同步清单（只动代码，不碰 `registry/` 活数据）：
- 插件：`lib/index.js`、`lib/index.d.ts`、`lib/unified-tools.js`、`package.json`
- core：`dist/bridge/server.js`、`package.json`

同步后逐文件比哈希 → 重启 `dsh web`。本轮部署回滚点：插件 `7c24498`、core `3de9cd0`（都是 `sync(code): … @ b7d1861`）。
扩展仍是本地加载 `D:\edge-extensions\dsh-browser-extension`，改完要在 `edge://extensions` 点重载。

**线上验收（2026-11-01 00:1x 实测，profile web，端口 9777）**：`pluginVersion=0.11.51`、`hello.version=1.0.53`；
`Host: evil.example → 403`、`Origin: https://evil.example → 403`、`Origin: http://127.0.0.1:3080 → 200`、`Origin: chrome-extension://… → 200`；
`browser_navigate` + `browser_read` 走真桥读回 1403 字（链路与策略都正常）。
**还剩一处真口子**：`insecureToken: true` —— 桥 token 仍是内置默认/过短，而它是 `/api/command` 的唯一边界。

### token 已换（2026-11-01 00:2x，主人同意后执行）

- **改哪里**：不是设置页 —— 插件里 `token` 是 `volatile()` 字段（设置存不进），真正生效的是 profile 的
  `D:\dsh-data\profiles\web\cordis.patch.yml` 里 `- id: browser-bridge` 段的 `token:` 那一行。
- **值**：换成 32 位 hex 的自定义值（**本文不抄**，只在上面那个文件里；好的配置快照备份为同目录 `cordis.patch.yml.bak-token-20261101`）。
- **扩展侧**：点图标 → 高级 ▾ → Token 框 → **保存**（保存会立刻发 `reconnect`，不必重载扩展）。恢复旧 token 也一样操作。
- **验收**：`insecureToken: false`、`extensionConnected: true`、`hello.version 1.0.53`、状态页「令牌强度 已自定义」；
  `Host: evil.example → 403` / `Origin: https://evil.example → 403` / 回环来源 `→ 200` 均未受影响。
- **踩到的坑（值得记）**：popup 的 Token 框每 1.5s 从 `chrome.storage` 自动回填（`popup.js:31`）——
  粘完不点「保存」或先点别处，输入框会静默刷回旧值，看起来像粘上了其实没存。判据：桥那边 `extensionConnected=false`
  但用新 token 手工打 WS 握手是 `101`（说明桥对、扩展手里的 token 还是旧的）。

**教训**：`__` 前缀的临时脚本会被自动清掉（`src\__mutate.mjs`、`src\__dbg-link*.mjs` 跑完就没了）。临时脚本用普通名字、自己删；也别把要留的东西放进 `__` 开头的目录。

### popup 表单：只在「高级」收起时回填（2026-11-01 主人口径，扩展 1.0.54）

主人原话：「把『高级』收起后才自动回填，因为有些时候可能填完改其他设置最后全部改完再点保存；『重新扫描本地桥』也通常被当作『测试项』，测试后再保存。」

改了三处（`extension/popup.js` + `extension/background.js`）：
1. **回填规则**：面板收起 → 回填**已保存**的值（`cfgPersisted`，重启后还在的那份）；面板展开 → 只有「表单内容与已保存值一致」才跟随刷新。以前是每 1.5s 把除当前聚焦以外的字段全部刷回生效值 ⇒「改 token → 改端口 → 一起保存」时先改的被静默刷回。
2. **「重新扫描本地桥」= 测试项**：带上表单里当前的值（`{type:'rescan', tryConfig}`），后台只改**内存里的 cfg**、不写 storage；测通了再点「保存并重连」才落盘。以前它读的是已保存配置 —— 测的是旧 token，于是「测试通过、保存后连不上」（本轮真踩过）。
3. **`bridgeStatus` 多返回 `cfgPersisted`**（已落盘那份）：popup 靠它算「有没有未保存改动」，按钮在有改动时显示「保存并重连 · 有改动」；扫描结论旁会注明「这次用的是表单里填的值，尚未保存」。收起面板 = 以已保存值为准（丢弃未保存的填写）。

台子：新增 `tests/popup-no-clobber.mjs`（19 项，node:vm + 假 DOM 直接驱动真 `popup.js`）；`extension-hold` 增 4 项（`fireMessage` 把消息喂进真 `background.js`，断言 tryConfig 生效且不落盘、`cfgPersisted` 与 `cfg` 分开给）。`run-all` **17/17**，**变异 5/5**（回填改成无条件 / 拿掉 tryConfig / 保存写成固定值 / 后台忽略 tryConfig / 去掉 cfgPersisted —— 每条都变红）。

顺带补了台子的一个假件缺口：`makeArea().get()` 原来只认字符串键，而后台用 `get(Object.keys(DEFAULT_CONFIG))` 读数组键 ⇒ 假件静默返回 `{}`，断言会在错误基线上通过。现在 string / array / null 三种都认。

部署：扩展 **1.0.54** 已拷到 `D:\edge-extensions\dsh-browser-extension`（4 个文件哈希逐一相等），需要 `edge://extensions` 重载；插件/core 这轮没动，不用重启 `dsh web`。


### 审计清单剩下的 medium 7 + low 15 全部清掉（2026-11-01 01:0x）

来源：2026-10-31 那份 39 条审计里**还没动**的部分（坐标见上一节）。发布位：扩展 **1.0.55**、插件 **0.11.52**、core **0.1.15**。

**medium**

1. **`previousUrl` 收了不用**（扩展 `waitForNavigationComplete`）：导航前后地址相同（刷新 / 自跳转）时，"地址对得上"本来就是**旧文档**，于是 `commit` / `domcontentloaded` 立刻返回"已到达"，模型接着读到旧页面。现在这种情形只认 CDP `Page.frameNavigated`；地址真的变了仍按地址判（否则普通导航会被拖满预算 —— 这是修这条时最容易顺手引入的回归，专门留了阳性对照）。
2. **`cmdWait` 的 `timeoutMs` 不是硬上限**：超时判据只在每次 `Runtime.evaluate` **返回之后**查一次，而 CDP 卡在 commit 之前时根本不回 ⇒ 一条探针就能把"上限"变成参考数字。现在每个 await 都带 `withBudget(剩余预算 + 250ms)`，`started` 也从进 CDP 之前算起；超时文案会说明"有一次探针卡住了"。
3. **`browser_dialog` 没过红线判据**：`answer` 会真的操作一个标签页，而它默认作用于「最近一条对话框记录」的页面 —— 那未必是当前激活页。现在工具面与 HTTP 面都在**那个页面**上跑 `authorizeExistingTab`；找不到目标页就 fail-closed（HTTP 面直接拒，不拿活跃页顶包）。
   **有意偏离审计建议**：没把 `'dialog'` 塞进 `HTTP_PAGE_COMMANDS`。那个集合是"读也要碰页面"的命令，而 `dialog` 读/改策略不碰页面，塞进去会让红线页面上的"读策略"被误拒。改成"只有带 `answer` 才判目标页"，覆盖面一样，误伤更少。
4. **`wait`/`eval` 的桥超时没按预算放大**：桥默认 60s，页内预算上限 120s ⇒ 先报"扩展超时未回应"。新增 `pageBridgeTimeout(budget)=budget+2s`（封顶 122s），`browser_wait`、`browser_evaluate`、以及 `nav` 里的内层 wait 都改用它。
5. **core `classify` 不认扩展的 `timeout after`**：`eval timeout after Nms` / `wait timeout after Nms` 被归成 `command_failed`（"扩展明确回了失败"），写操作据此当成"没成功、可以重试" ⇒ 可能点两次。现在 `/time[do]?[ -]?out after/i` 一并归 `command_timeout`（写=unknown、读=not_started），hint 补了"页内预算用尽就加大 timeoutMs"。
6. **autoLaunch* 热更新不生效**：`reconcileNow` 的早退只看 serverKey / policyKey，改完「自动拉起 / 断开容忍 / 拉起用哪个 profile」要等端口或策略也变了（或者重启）才生效，而设置页当场就显示"已保存"。现在多一个 `autoLaunchFingerprint()`（9 个字段）参与早退判断，变了就重算 watchdog 与学习定时器；`refreshLearnTimer` 还会清掉学习退避状态（配置变了 = 失败原因可能已经消失）。
7. **`learnFromHello` 失败时每 5s 全盘扫**：学不成就不写 `learnedExtensionId` ⇒ 5 秒一次、每次把所有 profile 扫一遍。现在指数退避（15s→30s→…→封顶 10min，`learnRetryDelayMs()`），换扩展 id 或配置变更立刻重试；日志只在前两次说话。

**low**

- console `levels:['warn']` 与 CDP 的 `warning` 对不上 ⇒ 一条都匹配不上，看起来像"页面没警告"。新增 `normalizeConsoleLevel()` 两边归一（warn/warning、err/error）。
- console 的 `t` 乘了 1000 —— **真机取证过**：临时脚本直接读原始记录，`t/now = 1000.000000`（渲染成 20:54:28，实际 00:49:08）。CDP `Runtime.consoleAPICalled.timestamp` 本来就是毫秒，改成 `Math.round(params.timestamp)`。
- console/network 分不开"没在采集"与"0 条"：返回里加 `captured`（过滤前条数），插件渲染据此说"还没有任何记录"或"采到了 N 条但全被过滤排除"。
- onRemoved 少清四张表：`lastViewport` / `lastReadSignature` / `navArrivals` / `wokenTabs`（以前只清 console / network / 代际）。
- hold `focused` 恒 true：`abort.focus()` 在 try/catch 里，失败也照样报"焦点已在浮层里"。现在如实回填（`shadowRoot.activeElement === abort || document.activeElement === abort`）。
- Esc 长按定时器漏清：鼠标撤掉浮层后它 600ms 再醒一次，把 `dismissedBy` 改成 `'user'` ⇒ 这个标签页被永久当成"用户已接管"、再也不自动补层。`cleanup()` 现在清它，并且**幂等**（第二条到达直接返回）。
- `maybeAutoHold` 的 TOCTOU：探测→注入之间有 await，两条命令同时在飞时都会判定"没有浮层"，后一条把前一条（连同用户的点击计数）删掉重挂。加了一把 `withHoldInjectLock`，锁内再判一次抑制表。
- AX 快照不重建指纹表：AX 路径拿到的 ref 在 `refFingerprints` 里查不到，元素被重渲染后无法按 name/role 重定位。两条路径统一走 `rememberRefFingerprints()`。
- 状态页 `innerHTML` 未转义：`扩展类型` / `浏览器` 两行来自扩展的 `hello`，而状态页上正存着桥 token（输入框 + sessionStorage）。所有动态值过 `esc()`；顺手把清理提示改成"只删产物"。
- `cleanupArtifacts` 无扩展名过滤：`shotsDir` 一旦被指到真实目录就等于把它清空。现在只删 png/jpeg/webp/pdf/svg，其余文件不动（状态页提示同步改口）。
- self-update `unknown` 被当无漂移：有仓库 UNREACHABLE 时仍说"全部与基线一致"。现在单列 `unreachableRepos` 并明说"状态未知，不能当作一致"，有漂移时也会带一句。
- client `set()` 返回 false 被当成功：同步拒绝会落进 else 分支，一边清 busy 一边去探"生效值"，把"没写进去"演成"已保存"。现在显式处理 `=== false`（`unset` 同理）。
- client `T.border` 不存在：拼出来是 `border: 1px solid undefined`，无效 CSS ⇒ 那两处边框从来没画出来过。改用主题里真有的 `T.line1`（4 处）。
- `Object.hasOwn` 查表：`cfg.groups[group]` 是普通对象，`group='constructor'` 会从原型取到函数、`?? []` 不兜 ⇒ `for…of` 抛"is not iterable"。改用 `Object.hasOwn` 判存在，并把存档里的 `enabledGroups` 过滤成认得出的分组（状态工具的 enable/disable 也共用这个判据）。

**台子**：新增 `tests/status-page-escape.mjs`（11 项）。其余：`error-contract` 36→**42**、`bridge-http-auth` 42→**43**、`http-face-access` 17→**22**、`nav-budget` 14→**19**、`config-hot-update` 11→**27**、`extension-hold` 137→**156**。`run-all` **18/18**。

**这一轮新写的两个手法**（值得留）：
- 假件加 `hangAllMethod()`：模拟"CDP 根本不回"，用来验"预算是不是硬上限"。修好后仍在预算附近报错；没修就会一直挂着 —— 所以断言外面套了 race，让"挂住"变成一条失败断言，而不是把整个套件拖死。
- 状态页转义不能靠"GET 一下 HTML 看看"：rows 是**浏览器里 fetch 之后才填的**。必须把返回的 `<script>` 取出来，在 `node:vm` 里配假 document 跑一遍真 `refresh()`，拿它写进 `innerHTML` 那串去断言。

**变异验证**：**12/12** 被抓住（每条都先断言"原文找得到"，否则"没变红"就成了假结论）。本轮**没有**判别力兜底的几处，如实记下来：
- 收尾自查抓到一条自己的毛病：`learnRetryDelayMs` 的注释写「封顶 10 分钟」，指数却只封到 5（实际最多 8 分钟）。已改成封到 6，测试也从「480000 或 600000 都算过」收紧成「必须 600000」。
- M4 的调用点：`pageBridgeTimeout` 只有纯函数测试，没人钉住"三个调用点都真的用了它"（删掉某个调用点的 timeoutMs 参数，套件不会红）。
- L12 的 UNREACHABLE 文案、L13 的 `set()` 返回 false、L14 的 `T.border`、L2 的 `Object.hasOwn`：都是没写测试的改动。
- L4 / L5 / L6（hold 的 `focused` 如实回填、Esc 长按定时器、补层串行锁）：要真机 DOM 才验得动，本轮只改了代码。

部署：插件/core 是 self-plugins 里的**实体拷贝** ⇒ 拷完要重启 `dsh web` 才生效；扩展在 `D:\edge-extensions\dsh-browser-extension`，改完要在 `edge://extensions` 重载（版本应变 1.0.55）。
### 线上验收（2026-11-01 01:19~01:23，重启 dsh web + 重载扩展后实测）

桥自报：`pluginVersion=0.11.52`、`hello.version=1.0.55`、`extensionConnected=true`、`insecureToken=false`、edge 156。

**console 两处（真机）**：页面里打 log/warn/error 三条 →
- 显示时间是 **01:19:31**，与 `new Date(Date.now()).toLocaleTimeString()` 一致（改之前同一读数会偏，×1000 的溢出）；
- `levels:['warn']` 回 **1 of 1**，命中的正是 `[warning]`（改之前 0 条）；
- `levels:['debug']` 回「采到了 3 条，但全被过滤条件排除了」。

**超时归类（真机）**：`browser_evaluate` 里 `await sleep(3000)`、只给 400ms 预算 ⇒
`[command_timeout] eval timeout after 400ms — effectState=unknown`（改之前是 `[command_failed]`）。

**同 URL 刷新（真机，2026-11-01 01:2x）**——判据：给页面设一个「本文件的标记」+ 读 `performance.timeOrigin`（两者都是**每个文档**的，换文档必变）：

| 轮次 | 操作 | 口径 | 返回耗时 | 返回后标记 | timeOrigin |
| --- | --- | --- | --- | --- | --- |
| 起点 | 设 `window.__probeDoc='D1-marker'` | — | — | 在 | 1793467291644 |
| 1 | 导航到**同一 URL** | commit | 140ms | **不在** | **1793467301301**（新） |
| 2 | 再导航到同一 URL | domcontentloaded | 137ms | **不在** | **1793467314099**（新） |
| 对照 | 同一 URL **只加 `#probe`**（只改 hash，不产生新文档） | commit | 5ms | **还在** | **不变** |

对照那一行是关键：它证明这个读数**能看见"旧文档还在"**（返回 5ms、标记仍在、timeOrigin 没变），所以前两轮的"标记不在 + timeOrigin 变新"不是空话。
**这条线上测量能证明的是**"导航返回时已经在新文档上"；"返回那一刻正好是 `frameNavigated`"这种更细的口径由台子上的 CDP 事件断言钉住（`extension-hold` 的 ④c/④d）。

harness 的「命令超时 ≠ 页面没内容 / 可能是权限气泡」提示在故意造超时时会出现，属正常，原始文案仍保留在错误里。
---

## 2026-11-03：上游那两个 PR 的结局，以及补上的 #21

查于 2026-11-03 22:2x（`api.github.com`，只读）。

**结局**：#20（① `timeoutMs`）**已于 2026-11-03 20:26 合并**（`927f779`，我们两条 commit 原样进去，CI run `41635718914`）；② 由维护者自己实现（`911e828`，v1.4.0）——他在 20:58 动手，21:03 回帖说「PR 位一直空着」。我们手上 `feat/nav-wait-until`（`7c77c9b`，在 fork 上，叠在 #20 的 `1c692f4` 之上）与写好的 PR 正文（`scratch/upstream-pr-waituntil-20261031/PR.md`）**没有独有内容了**：四档、主框架 `frameNavigated`、`committed` 闸、`tabs.open` 共用等待器、about:blank 两步、`navigatedWithinDocument`、`wait:false→none`、封闭 schema 三字段、变异测试他都做了。

**时间线要点**（不要再复述成「本该合成一个 PR」）：拆两单是他在 #19 定的（10-30 19:47「先发 ①，② rebase 在 ① 上」）；① 从他收到到合并用了 4 天；① 一合并到他动手写 ② 只有 32 分钟。教训是**队列礼仪输给了窗口速度**：② 应该以「① 的分支为 base」同时开出去，而不是等 ① 合并。

**仍站得住的一条，已提 issue #21**：桥余量 `BRIDGE_MARGIN_MS = 2000`（`src/index.ts:47`）只够覆盖等待预算，不够覆盖等待**之后**的三个后置探针（`background.js:1621` 落地地址 2s / `:1626` 错误页正文 2s / `:922` readyState 2s）。最坏 `cmdNav` 要 `budget + 4000`（落 error 页 `+6000`），桥在 `budget + 2000` 就超时 ⇒ 模型拿到 `command_timeout`（effectState unknown）而不是准备好的 `loadPending + waitedMs`。

在**他们自己的假件**上量到（判于 2026-11-03 22:3x）：

| 剧本 | budget | 桥 ceiling | 实际返回 | 超出 |
|---|---|---|---|---|
| 对照：探针正常 commit 800 | 800 | 2800 | 813ms | — |
| commit 800 探针卡住 | 800 | 2800 | 4850ms | +2050 |
| commit 默认 4000 探针卡住 | 4000 | 6000 | 8089ms | +2089 |
| load 默认 15000 探针卡住 | 15000 | 17000 | 19292ms | +2292 |
| tabs.open commit 800 探针卡住 | 800 | 2800 | 2825ms | +25（边界） |

复现脚本在 fork 分支 `repro/nav-headroom`（`fc449e2`，基于上游 main `8c24589`）：`verify/repro_nav_headroom.mjs`，跑 `node verify/repro_nav_headroom.mjs`。**未接进 `npm run verify`**，也**没真机跑**（要的是「探针卡住」状态，假件的 `hang` 就是为它写的）。issue：<https://github.com/angelky7/dsh-browser-control/issues/21>，正文原文在 `scratch/upstream-reply-20261103/issue-body.md`。

**不做的事**：#20/#19 不评论、不道谢（上游已了结）；`feat/nav-wait-until` 保留在 fork 当参考，不删也不提 PR。

---

## 2026-11-10：真浏览器台子（rig）接回来，Windows + Linux 一条入口

改与跑于 2026-11-10 20:1x–20:3x（本机 Edge 157 / headless，node v26.13.0；WSL 侧 node v22）。

**为什么动它**：10-30 换边之后 rig 停摆——两个 `.ps1` 硬编码 `%TEMP%\__pr-d-rig`（不存在），三个 `.sh` 硬编码 `/home/wsluser/projects/...`（WSL 里已无此路径）。迁移后它**从没真跑过**，只做过静态检查。

**改了什么**：

- 新增 `rig/rig.mjs`：唯一实现，Windows/Linux 同一份。子命令 `build|stub|up|run|status|down|smoke|matrix|probe`；工作目录默认 `<tmp>/dsh-rig`（`RIG_WORK` 可覆盖），**产物不进源码树**。
- `rig/rig.sh`（POSIX）、`rig/rig.ps1`（Windows）两个薄壳；`mk-ext.sh`/`mk-ext-unified.sh`/`deploy.sh`/`probe.sh`/`teardown.sh` **调用形状不变**，内部转调 `rig.mjs`。
- 删掉 `__rig-launch-run.ps1`、`__rig-teardown.ps1`（被取代，且路径写死）。
- 新增 `rig/probe-scenario.mjs`（旧 `probe.sh` 的可移植版）、`rig/README.md`（两个平台的跑法、参数、产物、未覆盖项）。
- 修两个只在 Windows 上才炸的写法：`os.tmpdir()` 给 8.3 短路径（`LOCALU~1`）→ 用 `homedir` 推长路径；`new URL(...).pathname` 给 `/D:/...` 前导斜杠 → 一律走 `fileURLToPath`（matrix / close-many-* 三处）。
- 修两个**台子自身的**缺陷：① 收尾时按工作目录字符串 `pgrep` 会把调用方的 shell 当残留杀掉（现在按 `--user-data-dir=` 锚点、锚点经环境变量传，避免自己匹配自己）；② `up` 失败时会把自己刚起的 stub 留在端口上（现在会收掉）。

**实测**（真机，不是假件）：

| 场景 | 结果 |
|---|---|
| `run --scenario smoke` | 6/6 通过（tabs.list / nav /fast / ground truth / nav /slow?ms=1500 / tabs.open / tabs.close），收尾端口释放 |
| `run --scenario probe` | 真机 ground truth：nav 到 /fast 回 `readyState=complete` 且 `location.href` 与回执一致；tabs.open 后分组落 `DSH` 蓝组 |
| `run --scenario matrix` | 9 个剧本全跑通，证据落 `rig/evidence-matrix-20261110.json`（12:25:05–12:28:46 UTC） |

**矩阵里量到的那个数（真机，正是 #21 的形状）**：

| 剧本 | 桥 ceiling（budget+2000） | 实际返回 | 超出 |
|---|---|---|---|
| `nav-hang`（服务器接了不回，卡在提交前） | 15000+2000=17000 | **17540ms** | **+540** |
| `nav-blackhole-ip`（不可路由地址，TCP 黑洞） | 17000 | **17597ms** | **+597** |
| `open-hang` / `open-blackhole-ip` | 17000 | 15114 / 15143 | 未超（tabs.open 只有一个后置探针） |
| `nav-local-slow` / `open-local-slow` / `nav-background-tab-slow` | — | 3.1s 级 | 正常 |
| `nav-timeout-40s-page` | 17000 | 15098 | 未超 |

这跟上一条记的、在上游假件台子上量的 `+525…+621ms` 对得上（我们这份的探针是**一个** 2500ms 的合并调用，桥余量 2000 ⇒ 理论超出 500ms）。**结论：0.11 线也有 #21 那个越界，真机确认量级约 +0.5s。**

**Linux 侧到哪一步**：`bash -n` 全过；WSL 里 `build` / `status` / `down` 实跑通过；`up` 干净报「没找到浏览器」（WSL 没装 Chromium/Chrome/Edge），**端到端未测**——装上浏览器后同一条命令即可（平台差异只剩找浏览器、杀进程树两处）。

**跑法不要在本文找**：`rig/README.md` 是唯一出处（一条命令 `node rig/rig.mjs run --tag <t> --scenario smoke|probe|matrix`）。
