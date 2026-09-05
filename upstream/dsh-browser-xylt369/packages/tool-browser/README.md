# @yeesy369/dsh-tool-browser

[English](./README.en.md) | **中文**

把 `ctx.browser` 注册成模型工具。

## Config

| 字段 | 语义 |
|---|---|
| `evaluate` | 是否暴露 `browser_evaluate`（默认 false） |
| `maxWaitMs` | `browser_wait` 上限 |

## 模型体验

模型看到 `browser_*` 工具名、snapshot 文本与 ref、截图的 `image` ContentBlock。snapshot 按页面长度占 token；截图不把 PNG 写进对话 JSON。

## 限制

`browser_evaluate` 是任意页面 JS。标签按 `sessionKey` 隔离，不是独立 browser context。
