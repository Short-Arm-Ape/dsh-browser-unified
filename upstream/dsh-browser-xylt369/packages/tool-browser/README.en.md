# @yeesy369/dsh-tool-browser

**English** | [中文](./README.md)

Registers `ctx.browser` as model-facing tools.

## Config

| Field | Semantics |
|---|---|
| `evaluate` | Expose `browser_evaluate` (default false) |
| `maxWaitMs` | Cap for `browser_wait` |

## Model experience

The model sees `browser_*` tools, snapshot text and refs, and screenshot `image` ContentBlocks. Snapshots scale with page text; PNG bytes stay in the attachment store.

## Limitations

`browser_evaluate` is arbitrary page JS. Tabs are isolated by `sessionKey`, not by a separate browser context.
