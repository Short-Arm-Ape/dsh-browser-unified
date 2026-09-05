# @yeesy369/dsh-browser-playwright

**English** | [中文](./README.md)

Playwright provider for `ctx.browser`: persistent Edge profile, per-session tabs, navigation only through `src/url-guard.ts`.

## Config

| Field | Semantics |
|---|---|
| `windowVisibility` | `visible` / `hidden` / `headless` (default visible) |
| `stealth` | Lightweight anti-detection, default true |
| `channel` / `profileDir` | Browser channel and profile directory |

The Web settings card exposes window mode and stealth (`applies: restart`). Other fields stay YAML-only.

## Model experience

The model sees page text, refs, and screenshot attachments via `dsh-tool-browser`, not Playwright. Long snapshots cost tokens; screenshots are attachments, not base64.

## Limitations

DNS check vs connect is still TOCTOU. Sessions share the profile's cookies.
