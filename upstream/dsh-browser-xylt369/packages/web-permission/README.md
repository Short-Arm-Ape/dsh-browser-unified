# @yeesy369/dsh-web-permission

[English](./README.en.md) | **中文**

`tools/pre-execute` 权限门：按主机 allow / deny / ask。

## Config

| 字段 | 语义 |
|---|---|
| `allowHosts` / `denyHosts` | 主机白/黑名单（黑名单优先） |
| `gatedTools` | 要检查 `url` 的工具名 |
| `defaultAction` | 名单外主机：`allow` 或 `ask` |
| `remember` | `ask` 且批准后写入 `allowHosts`（热更新） |

Web 设置卡片（`settings.plugin.item` key = `web-permission`）与 `$DSH_HOME/settings.yaml` 写同一命名空间。

## 模型体验

模型看不到这张卡片。被拒绝时工具结果带 `deny` 原因；`ask` 走 `ctx.approval`。几乎不占 token / KV。

## 限制

只看参数里的 `url`；无 `url` 的工具直接放行。SSRF 仍由 `browser-playwright` 的 url-guard 负责。
