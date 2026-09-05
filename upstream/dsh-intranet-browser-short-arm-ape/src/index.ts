/**
 * dsh-intranet-browser: a STANDALONE intranet/local debugging browser for
 * DeepSeek Harness.
 *
 * Deliberate, documented SSRF-guard bypass. The original browser plugin
 * (`@yeesy369/dsh-browser-playwright`) keeps its strict url-guard untouched;
 * this plugin spins up its OWN Playwright instance (own service name, own
 * profile directory, own visible window) whose URL policy skips private-IP
 * screening so localhost / LAN / internal hosts become reachable. Because that
 * is a real SSRF risk, EVERY `intranet_*` tool call is gated behind user
 * approval via `ctx.approval` (default `approvalMode: 'per-call'`), and cloud
 * metadata endpoints stay blocked by default.
 *
 * @module dsh-intranet-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { Config as IntranetConfig } from './config.js'
import { registerApprovalGate } from './gate.js'
import { IntranetBrowserRuntime } from './runtime.js'
import { registerIntranetTools } from './tools.js'

export const name = 'intranet-browser'
/** Wait for Host settings, tools, attachments, and the approval service so the gate can always ask. */
export const inject = ['settings', 'tools', 'attachments', 'approval']

export const Config: Schema<IntranetConfig> = Schema.object({
  approvalMode: Schema.union(['per-call', 'arm']).default('per-call').description(
    '授权粒度：per-call = 每次 intranet_* 调用都弹窗授权（默认，最严格）；arm = 先调 intranet_arm（本身也要授权）激活，之后本会话内的 intranet_* 不再逐个弹窗，直到 intranet_disarm。' +
    '注意：当会话授权策略为 never（Full access / danger-full-access）时，intranet_* 调用自动放行（与其它工具一致的信任级别），此设置不生效。' +
    'Approval granularity: per-call = every intranet_* call asks the user (default, strictest); arm = approve intranet_arm once, then later intranet_* calls run without prompts until intranet_disarm. ' +
    'Note: when the session approval policy is never (Full access / danger-full-access), intranet_* calls auto-pass (matching the trust level of other tools) and this setting is moot.',
  ),
  approvalScope: Schema.union(['all', 'navigation']).default('all').description(
    '授权范围：all = 所有 intranet_* 调用都弹窗（默认）；navigation = 只读操作（intranet_snapshot / intranet_screenshot / intranet_scroll / intranet_wait / intranet_list_tabs）不再逐个弹窗，导航/写操作仍每次弹窗。' +
    'Approval scope: all = every intranet_* call prompts (default); navigation = read-only calls run without prompts, navigation/write calls still prompt.',
  ),
  blockMetadata: Schema.boolean().default(true).description(
    '即使绕过了 SSRF 防护，仍默认拦截云元数据端点（169.254.169.254、metadata.google.internal 等）。该黑名单在导航入口和所有请求（含重定向/XHR/iframe）两个层面生效。只在完全受控的网络（如云主机上专门测元数据）才建议关闭。' +
    'Keep blocking cloud-metadata endpoints even though SSRF protection is bypassed, at both the navigation entry and every request (redirects/XHR/iframes included). Defaults to true; disable only on fully controlled networks.',
  ),
  blockedHostnames: Schema.array(String).default([]).description(
    '额外始终拦截的主机名或 IP 字面量（在元数据列表之外）。Extra hostnames or IP literals that are always blocked.',
  ),
  allowFile: Schema.boolean().default(false).description(
    '允许 file:// URL（http(s) 之外）。Allow file:// URLs in addition to http(s).',
  ),
  windowVisibility: Schema.union(['visible', 'hidden', 'headless']).default('visible').description(
    '内网浏览器窗口模式：visible = 可见窗口（默认，方便调试）；hidden = 最小化移出屏幕；headless = 无头。' +
    'Intranet browser window mode: visible (default) / hidden / headless. Applies on the next browser launch.',
  ),
  stealth: Schema.boolean().default(true).description(
    '轻量反检测补丁（同原版 browser-playwright）。Lightweight anti-detection patches. Defaults to true.',
  ),
  channel: Schema.union(['chrome', 'msedge']).description(
    '优先使用的真实浏览器通道；省略时自动检测。Prefer a real browser channel; auto-detect when omitted.',
  ),
  profileDir: Schema.string().description(
    `内网浏览器独立 profile 目录（与原版 Edge profile 分开，避免抢锁）。Defaults to ${join(homedir(), '.dsh', 'intranet-edge-profile')}.`,
  ),
  maxWaitMs: Schema.number().default(60_000).description(
    'intranet_wait 的等待上限（毫秒）。Upper bound for intranet_wait in milliseconds.',
  ),
  navigationTimeoutMs: Schema.number().default(60_000).description(
    '导航超时（intranet_open / intranet_back / intranet_forward，毫秒）。Navigation timeout in milliseconds.',
  ),
  interactionTimeoutMs: Schema.number().default(30_000).description(
    '交互超时（intranet_click / intranet_fill / intranet_press，毫秒）。Interaction timeout in milliseconds.',
  ),
  evaluate: Schema.boolean().default(false).description(
    '暴露 intranet_evaluate 工具（在页面里执行原始 JS，高风险）。默认关闭；工具在插件加载时注册，修改后需重启生效。' +
    'Expose the intranet_evaluate tool (raw JS in the page, HIGH RISK). Defaults to false; registered at plugin load, so a change needs a restart.',
  ),
})

export function apply(ctx: Context, config: IntranetConfig): void {
  const settings = ctx.get('settings') as SettingsProvider
  // Note: web exposure of the settings card is declared by `dsh.client` in
  // package.json (the inject list), not by a register option — the legacy
  // `expose` option no longer exists in dsh-settings.
  const registered = settings.register(settingsNamespace(name), Config, {
    base: config,
    applies: 'live',
  })
  const getConfig = (): IntranetConfig => registered.get()

  // Arm/disarm state, keyed by agent id, shared with the approval gate.
  const armedAgents = new Set<string>()
  const armState = {
    isArmed: (agentId: string): boolean => armedAgents.has(agentId),
    arm: (agentId: string): void => {
      armedAgents.add(agentId)
    },
    disarm: (agentId: string): void => {
      armedAgents.delete(agentId)
    },
  }
  // Agents come and go (sessions end, forks dispose); drop their arm state so
  // the set cannot grow for the process lifetime. agent id === session id.
  ctx.on('agent/disposed', ({ agent }: { agent?: { id?: string } }) => {
    if (agent && typeof agent.id === 'string') armedAgents.delete(agent.id)
  })

  // The standalone intranet browser service: constructed directly (its own
  // service name `intranet-browser` never collides with `browser`).
  const browser = new IntranetBrowserRuntime(ctx, getConfig)

  registerIntranetTools(ctx, { getConfig, browser })
  registerApprovalGate(ctx, { getConfig, armState })
}
