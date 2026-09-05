# 上游功能差距清单（dsh-browser-unified vs 四上游）

> 与 0.3.0 的逐项对比。结论同时在 `design/registry.json`（de-005…de-007 等条目）与对话报告同步。
> 出处均为 `upstream/` 原样归档路径；「未实现 / 部分」项对应后续里程碑，需走注册表条目 + 用户确认流程。

## 汇总表

| # | 功能 | 上游出处 | 本插件现状 | 建议 |
|---|---|---|---|---|
| 1 | 页面级逐请求拦截（XHR/重定向/iframe/WebSocket/DNS-rebinding） | `caob23 …/extension/`（扩展端能力）、xylt369 `url-guard` 语义 | **未实现**：GuardedBridge 只拦工具发起的 `nav`/`tabs.open`；页面自身请求不拦（设计条目 de-005 已 accepted） | 扩展端 route handler（`blockReasonForUrl` 语义）+ routeWebSocket + DNS-rebinding 缓解 |
| 2 | `browser_evaluate` 门控（默认关闭） | xylt369 `packages/tool-browser` Config `evaluate` 默认 false | **未实现**：`browser_evaluate` 常驻注册、无开关（de-006 已 accepted） | Config 增加 `allowEval`（默认 false），关闭时不注册该工具 |
| 3 | 网页权限门：主机 allow/deny/ask + `remember` | xylt369 `packages/web-permission`（`allowHosts`/`denyHosts`/`gatedTools`/`defaultAction`/`remember`；settings 卡片 + settings.yaml 热更新） | **未并入**：仅有宿主 approval 机制；无按主机 ACL、无“批准后记住” | 可选 provider 档：宿主批准（当前）已覆盖主要安全面；主机级 ACL 待 de-005 后考虑 |
| 4 | 工具层 `pre-execute` 接线（审批门决策表真正生效于每次工具调用） | short-arm-ape `gate.ts`（approval.ts 纯函数已并入 core，但未接到插件工具） | **部分**：approval 决策表在 core，工具层未执行 gateAction | 把 `gateAction` 接到宿主 tools pre-execute，GuardedBridge 参与 |
| 5 | GUI 实时画面（`tool.view.cordis` 面板 + 自动截图轮询） | kyo615 `lib/client.js` | **未实现**（de-007 已 accepted；可选集成层） | 人看实时画面 + 模型截图附件两通道并存 |
| 6 | stealth 反检测 | xylt369 `packages/browser-playwright/src/stealth.ts`（impact note 记录“原型未并入”） | **未并入**（本插件走用户真实浏览器扩展，适用性低） | 仅归档跟踪；需要时再评估 |
| 7 | 细分工具体系：`browser_fill` / `browser_wait` / `browser_back` / `browser_forward` / `open/switch/close_tab` | xylt369 `packages/tool-browser` | **部分等价**：`browser_tabs` 合并 list/open/close/activate；`browser_type` 承担 fill；无 wait/back/forward | 若需补齐再加可选工具，避免工具面膨胀 |
| 8 | 标签 sessionKey 隔离模型 | xylt369（browser 会话按 sessionKey 隔离） | **设计差异（非缺口）**：本路线=用户真实浏览器多标签共享登录态；Playwright 实例与用户浏览器是不同路线 | 文档化差异即可 |
| 9 | 自有浏览器实例 / 独立持久 profile | xylt369 / kyo615 路线特性 | **设计差异（非缺口）**：本插件明确复用用户真实浏览器（含登录态） | — |
| 10 | 单元/契约测试与 AGENTS.md 规范 | xylt369 仓库（url-guard/gate/form 等单测、AGENTS.md） | **缺失**：本仓库仅有手工冒烟，无自动化单测 | 按上游规范移植 url-policy/gate 测试（core 纯函数可测） |

## 逐条说明（关键出处）

1. **请求级拦截（de-005）**：合并核心 `guarded-bridge.ts` 明确“仅工具调用级门”；页内 XHR/重定向/iframe
   只能在扩展端拦。WebSocket 与 DNS-rebinding 为已知缺口。registry `impactRules`（caob23 → guarded-bridge）同步标注。
2. **allowEval（de-006）**：xylt369 `tool-browser` Config 字段 `evaluate`（“Expose the high-risk browser_evaluate…
   Off by default”）；caob23 v1.0.6→v1.0.7 曾丢失开关。合并版 0.3.0 仍常驻注册 `browser_evaluate`。
3. **web-permission**：`packages/web-permission/src/index.ts` 有 `allowHosts` / `denyHosts`
   （默认含 `localhost`、`metadata.google.internal`）/ `gatedTools` / `defaultAction` / `remember`，并带
   client 设置卡片。本插件以宿主 approval + GuardedBridge URL 策略替代，但**没有**“按主机记住允许”的持久 ACL。
4. **pre-execute 接线**：仓库根 README（0.3.0 前）“后续合并候选”与 registry note 均列出“把 `approval.ts`
   的 `gateAction` 接到宿主 `tools/pre-execute`”。
5. **live-view（de-007）**：kyo615 `lib/client.js` 以 `slots.inject('tool.view.cordis')` 注册面板。
6. **stealth**：registry impactRules（xylt369 `stealth.ts` → “stealth 反检测（原型未并入…）”）。
7. **细分工具体系**：xylt369 `tool-browser/src/index.ts` 注册工具名清单（navigate/snapshot/click/evaluate/
   type/fill/press/scroll/wait/back/forward/tabs/…/screenshot）；本插件 16 工具另有 read/content、pdf、
   emulate、console/network、cleanup 等上游没有的能力（等价覆盖反向成立）。

## 非缺口（设计取舍）

- 用**用户真实浏览器**（caob23 路线）而非另起 Playwright/Chrome 实例：登录态与真实性是特性不是缺陷；
- 云元数据端点/URL 策略档位在 0.3.0 已 GUI 可配（settings.section「浏览器」分区）；
- 上游截图→模型 `image` ContentBlock 通道：本插件截图落盘 + `read_image` 由模型侧读取，等价。

_更新记录：2026-09-05 建立（0.3.0 基线）。_
