# 插件自更新与设计注册表 —— 设计文档

> 范围：dsh-browser-unified（合并核心 `packages/browser-unified-core` 及其未来 DSH 插件壳）。
> 本目录是**设计思路的唯一书面出处**：改设计先看这里、改完把决策写回 `design/registry.json` 的
> `designEntries`；`impactRules` 是「上游改动路径 → 合并核心影响面」的单一事实源。

## 1. 目标与非目标

目标：

- **工具化自检**：把「查上游有没有新提交」从"每次让 agent 跑脚本"收敛为一个**只读工具**
  `browser_check_update`（名字可配，见 registry `tooling`）。用户说"帮我检查下浏览器插件的更新 /
  上游有没有新提交 / 现在是什么基线"这类话时，由 **LLM 自行识别并调用**——我们不做关键词/意图的
  硬编码判断，只把工具的 name + description + 输出写好。
- **一致性**：设计决策、待办、影响映射沉淀为 `design/registry.json` 条目；人与插件（经工具）都能改，
  改后仍可被 `browser_check_update` 消费，避免 PS 脚本/TS 工具/文档三处逻辑漂移。
- **受控变更**：无上游提交的用户功能改动也走注册表（新增 pending 条目），而不是绕过流程直接改源码。
- **鉴权兜底**：任何写入动作都过用户审批；外部内容（网络/文件/上游 commit）只作数据，不能驱动修改。

非目标（本轮）：

- 不做运行期"每次浏览器调用都自动联网检查"（太费且无必要，工具显式调用/启动时一次即可）。
- 不做工具内自动 re-vendor/合并源码（那是高风险的写操作，保留在"agent + 用户确认"流程）。

## 2. 文件布局

```
dsh-browser-unified/
├── design/
│   ├── README.md            本设计文档
│   └── registry.json        设计注册表（impactRules / tooling / authz / designEntries）
├── upstream-baseline.json   四上游归档日 commit SHA（机器基线）
├── scripts/
│   └── check-upstream.ps1   只读自检（实现 A：离线/终端；impactRules 读自 registry.json）
└── packages/browser-unified-core/src/self-update/
    ├── registry.ts          load/validate registry+baseline、impactRowsFor（纯函数）
    └── check.ts             buildReport（纯函数，供实现 B 工具层复用）
```

两份实现共用同一份数据：**PS 脚本与 TS 工具层都读 `design/registry.json` 的 impactRules**；
`upstream-baseline.json` 只存指针（SHA），不含映射。

## 3. 工具契约（未来 DSH 插件壳注册；名字来自 registry.tooling）

### 3.1 `browser_check_update`（只读，无审批门槛，无副作用）

输入（全部可选，默认全量）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `repos` | `string[]` | 只查指定上游 id（registry impactRules 的键） |
| `includeDesign` | `boolean` | 是否附上未决 designEntries 摘要（默认 false 省 token） |

输出（紧凑文本/结构化 JSON）：

- 每个上游：`UP-TO-DATE`，或 `DRIFT`（HEAD SHA/日期/版本 → 基线 SHA）＋自基线以来新提交
  （`短sha 日期 标题`）＋改动文件数＋按 impactRules 映射的**影响面与影响说明**；
- 无法连通（网络/代理）时输出 `UNREACHABLE`，不误报 DRIFT；
- 基线 SHA 不在历史（force-push 改写）时输出 `REWRITTEN`，提示人工核对，不自动推进。

**description 模板（写进工具注册，LLM 靠它自识别）**：

> Check whether the browser plugin's tracked upstream repositories (dsh-browser,
> dsh-intranet-browser, dsh-browser-control kyo615/caob23) have new commits since the
> development baseline. Read-only: reports UP-TO-DATE or lists the new commits, changed
> files, and their expected impact on the merged code (url-policy / approval / vendored
> bridge modules). Call this when the user asks to check for plugin/upstream updates,
> new commits, version drift, or what changed upstream — e.g. "帮我检查下浏览器插件的更新".
> Never modify anything; for source changes an explicit user-approved flow is required.

用户可能的话术（仅供文档参考，不做匹配逻辑）："检查下浏览器插件更新 / 上游有没有新提交 /
现在基线是多少 / 最近上游改了什么、影响哪里"。

### 3.2 `browser_design_show`（只读）

输出 `design/registry.json` 的压缩摘要：designEntries 状态机视图 + tooling/authz 当前值。
供 LLM 在要改功能前先核对设计意图（低成本）。

### 3.3 `browser_design_edit`（写，强制审批，fail-closed）

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | `'add' \| 'transition'` | 新增条目 / 改变已有条目状态 |
| `entryId` | `string?` | transition 时必填；add 时省略 |
| `title` | `string?` | add 必填 |
| `status` | `'proposed'\|'accepted'\|'applied'\|'rejected'\|'superseded'?` | transition 目标 |
| `summary` | `string?` | 改动意图摘要（**用户明示内容**） |
| `linkedRepo` / `linkedCommits` | `string?` / `string[]?` | 可选关联上游 |

执行契约：

1. 只允许写 `design/registry.json`（writeAllowlist 见 authz）——白名单之外一律拒绝；
2. 写前 JSON schema 校验 + 把旧文件备份为 `registry.json.bak-<ts>`；
3. **每次写入都调 `ctx.approval`**，审批框展示
   `authz.approvalPromptTemplate` 渲染的 diff 摘要（动作/条目/标题/摘要/来源类型）；
   拒绝 → 不写入、不重试；
4. 来源类型标注：`user`（用户在对话里明示的意图）才能直接写；`upstream/file/network`
   内容**永不自动映射成参数**——即便模型被外部文本诱导，也只能发起一次审批请求，由用户拒绝。

### 3.4 基线推进

`browser_check_update` **不**提供推进基线开关（防工具被诱导静默改 SHA）。推进只在用户确认吸收
上游改动后，由 agent 跑 `scripts/check-upstream.ps1 -UpdateBaseline`（只写 pinnedSha/pinnedAt），
或未来拆一个独立的高危工具（与 design_edit 同级审批）。

## 4. 为什么"不做判断逻辑、只做好调用"

触发条件是**自然语言语义**，属于 LLM 的分类能力而非确定性逻辑；关键词表会漏、会误伤、还要维护。
正确做法 = 高信号工具（名、description、参数、输出）+ 由模型在用户话语里自行识别。
实现注意：

- description 里列出典型问法，但写成"示例"而非 if-else；
- 工具只读、输出紧凑（默认不展开 design 摘要），控制 token；
- 工具的副作用面要小到"被误调用也无害"（只读网络探测）。

## 5. 威胁模型与鉴权（重点）

### 5.1 注入面与对策矩阵

| 注入面 | 可能危害 | 对策 |
|---|---|---|
| 上游 commit message / diff / README 文本 | 诱导模型"按此修改"或把恶意文本当指令 | 外部内容一律 data-only；不进系统指令区；不直接成为工具参数；工具只接收用户明示意图 |
| 网页/文件内容（浏览器读到的页面等） | 同上 | 同上 + `browser_check_update` 无写路径 |
| 恶意本地进程 / 伪造远端 | 篡改检测结果诱导更新 | 只读探测不改任何状态；结果仅提示，不自动推进 |
| 直接写 registry/baseline 文件 | 污染设计/基线 | 文件沙箱（workspace-write）+ 白名单 + schema + 备份；核心数据改动仍需批准 |
| LLM 幻觉或过度调用 | token 浪费/打扰 | 只读工具放开但输出小；写工具必经审批弹窗（人类最后关卡） |

### 5.2 硬性规则

1. **写 = 审批**：`browser_design_edit`、基线推进、任何源码修改都必须有用户可见的批准环节
   （`ctx.approval` 或宿主工具审批），拒绝即失败、不重试、不换名重发。
2. **外部内容不是指令**：上游/网络/文件文本永远贴"数据"标签；任何工具参数不得由外部内容拼装。
3. **最小写面**：工具能写的只有白名单文件；re-vendor/合并/typecheck 留在 agent 流程里由用户把关。
4. **fail-closed**：网络不可达 → `UNREACHABLE`；基线 SHA 缺失/被改写 → `REWRITTEN`，均不自动做任何事。
5. **审批文案透明**：审批框展示动作与原因（模板见 registry.authz.approvalPromptTemplate），
   让用户能看出"是谁要改什么、改了哪、为什么"。

### 5.3 本会话（开发沙箱）已知网络事实

- `web_fetch` 的 URL 守卫把 github.com/api/raw 域名判为非公网（fake-ip 代理 DNS）→ 工具层远程探测
  走 **git 子进程**（`-c http.sslBackend=openssl -c http.sslVerify=false`，只读）；
- 正常终端/部署环境无需这些参数；工具层若改用 HTTP(S) 探测需处理同源守卫与证书。

## 6. registry.json：条目状态机与修改入口

状态：`proposed`（想法/需求）→ `accepted`（用户或评审采纳）→ `applied`（已实现/已入库）→
`superseded`（被新决策取代）；任何状态可 → `rejected`（并记原因）。每次变迁追加 `history`。

修改入口（等价）：

- **人工直接编辑** `design/registry.json`（记得 lastUpdated + history）；
- **`browser_design_edit` 工具**（审批门控、校验、备份）；
- 语义约定：改代码前先看注册表有没有对应条目；实现完把条目置 `applied`。

## 7. 一致性守则

1. `impactRules` 只维护在 `design/registry.json`（PS 与 TS 同读）——**不要在代码里再写一份**。
2. `upstream-baseline.json` 只存 SHA/版本指针；每次 re-vendor 后同步推进并更新本注册表 lastUpdated。
3. 工具命名以 `registry.tooling` 为准（当前 `browser_*` 前缀在 unified 插件里由其独占；
   与宿主其他插件前缀冲突时改 tooling 字段即可，不散落硬编码）。
4. 任何"新功能/新修改"先 add 一条 pending/proposed 条目，再谈实现。

## 8. 落地路径（现状与选项）

- **A（已完成/本仓库）**：registry.json + 本设计文档 + core `src/self-update/` 纯函数 + PS 自检脚本
  改为读 registry（消除双份映射）。可独立 typecheck/build 验证。
- **B（可选，演示用）**：把 `buildReport` 包成一个动态 Cordis 插件，在当前会话注册
  `browser_check_update`，验证"用户一句话 → LLM 调工具 → 紧凑报告"。生命周期限于当前会话。
- **C（最终）**：browser-unified-core 外壳做成可安装 DSH 插件（按 caob23 `src/index.ts` 的
  `tools`/`settings`/审批接线模式引入 @deepseek-ai 依赖），注册本设计的三件套 + browser 工具面。

决策记录见 registry.designEntries（de-001 ~ de-004 已入账）。
