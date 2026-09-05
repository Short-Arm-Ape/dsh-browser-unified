# @yeesy369/dsh-browser-playwright

[English](./README.en.md) | **中文**

`ctx.browser` 的 Playwright 实现：持久 Edge profile、按会话隔离标签、导航只走 `src/url-guard.ts`。

## Config

| 字段 | 语义 |
|---|---|
| `windowVisibility` | `visible` / `hidden` / `headless`（默认 visible） |
| `stealth` | 轻量反检测，默认 true |
| `channel` / `profileDir` | 浏览器通道与 profile 目录 |

Web 设置卡片只暴露窗口模式与 stealth（`applies: restart`）。其余仍用 YAML。

## 模型体验

模型通过 `dsh-tool-browser` 看到页面文本、ref、截图附件，不看到 Playwright。长 snapshot 会占 token；截图走附件而非 base64。

## 限制

DNS 校验与真实连接之间仍有 TOCTOU。会话共享同一 profile 的 cookie。
