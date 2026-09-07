# dsh-browser-unified 0.7.0 发布说明

> 语义收敛 + 受限态 + 自动拉起（de-018 / de-016 / de-013）

## 变化
- **设计收敛（de-018，四层模型）**：语法(http(s)/file、无凭据) → 红线（云元数据含 DNS 别名、DSH 页列表默认拒/显式开、凭据）→ 名单（denyHosts/allowHosts，`*.suffix`）→ 分域（外网/局域网/本机 allow|ask|deny + 临时授权）。`urlMode` 不再是“私网硬拦”，而是**网络预设**（公网=默认仅外网、局域网/本机默认拒绝；内网=默认全放行），每域可显式覆盖；GUI/文档文案已注明避免歧义（“放行=忽略黑白名单、红线仍生效”等）。
- **受限态 ask 策略（de-016）**：按宿主审批策略判定（`approval.overrideOf(session) ?? config.policy ?? ask`）；审批可用→恒弹窗；不可用（never/完全权限）→ 忽略（ask 失效，其余规则照常）/ 放行（再忽略黑白名单，红线仍生效）/ 禁止。按 preset 上下文解释。
- **断线自动拉起 / 临时干净实例（de-013）**：看门狗基于 `extensionConnected`；支持指定浏览器/专用 profile、无痕式临时目录（需未打包扩展目录 sideload）。
- 伴随：核心决策 DNS 分类（主机名按解析域归类）、fake-ip 按 allowFakeIp 归外网；状态工具显示生效值（预设/显式）。

## 已知语义
- 0.7.0 起 `askMode` 仅在“无法请求审批”时生效；审批 ask 下始终弹窗（0.6.x 的“放行免弹窗”行为已收敛，如需旧行为请看 0.6.1 标签）。
- “放行”忽略 denyHosts 的方式为策略构建期不挂载 denyHosts（红线不经该列表，仍生效）。
- DNS 别名（元数据/回环）在真实解析环境生效；沙箱 DNS 受限时以字面与列表校验为主。

## 构建产物
- 插件：`packages/browser-unified-plugin/dsh-browser-unified-0.7.0.tgz`
- core `dist/`、mit `lib/` 已构建；registry/baseline 三副本同步。
- 上游归档第 5 个：`dsh-agent-webops`（de-019，参考）。

## 后续（已登记，未实现）
de-014 录制/宏、de-015 本仓库 releases 自检 + 代提 issue/PR、de-017 CDP 透传、TOCTOU 复检、页面级拦截(de-005)、协议白名单(extension:// 控制)等；详见 `design/registry.json` 与 `docs/gap-analysis.md`。
