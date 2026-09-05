# @yeesy369/dsh-web-permission

**English** | [中文](./README.md)

`tools/pre-execute` gate: allow / deny / ask by hostname.

## Config

| Field | Semantics |
|---|---|
| `allowHosts` / `denyHosts` | Host allow/deny lists (deny wins) |
| `gatedTools` | Tools whose `url` argument is inspected |
| `defaultAction` | `allow` or `ask` for hosts on neither list |
| `remember` | After an `ask` approval, append the host to `allowHosts` (live) |

The Web settings card (`settings.plugin.item` key `web-permission`) writes the same namespace as `$DSH_HOME/settings.yaml`.

## Model experience

The model never sees the card. Denies return a reason; `ask` uses `ctx.approval`. Negligible tokens / KV.

## Limitations

Only arguments that carry `url` are gated. SSRF remains the url-guard in `browser-playwright`.
