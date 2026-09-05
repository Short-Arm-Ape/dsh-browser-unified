/** Permission gate for web and browser tools. @module dsh-web-permission */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { settingsNamespace, type SettingsProvider, type SettingsScope } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { decideHost, hostnameOf } from './policy.js'

export const name = 'web-permission'
/** Wait for Host settings so `register(..., { expose: 'web' })` actually runs. */
export const inject = ['settings']

export interface Config {
  allowHosts: string[]
  denyHosts: string[]
  gatedTools: string[]
  defaultAction: 'allow' | 'ask'
  /** When `defaultAction: 'ask'`, persist an approved host into `allowHosts`. */
  remember: boolean
}

export const Config: Schema<Config> = Schema.object({
  allowHosts: Schema.array(String).default([]),
  denyHosts: Schema.array(String).default(['localhost', 'metadata.google.internal']),
  gatedTools: Schema.array(String).default([
    'browser_navigate',
    'browser_click',
    'browser_type',
    'browser_fill',
    'browser_open_tab',
    'web_fetch',
  ]),
  defaultAction: Schema.union(['allow', 'ask']).default('allow'),
  remember: Schema.boolean().default(true),
})

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface ApprovalLike {
  request(req: {
    agent?: unknown
    toolName: string
    callId?: unknown
    reason?: string
    signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

export function apply(ctx: Context, config: Config): void {
  const settings = ctx.get('settings') as SettingsProvider
  const registered = settings.register(settingsNamespace(name), Config, {
    base: config,
    applies: 'live',
    expose: 'web',
  } as Parameters<SettingsProvider['register']>[2])
  const scope: SettingsScope<Config> = registered
  const getConfig = (): Config => registered.get()
  const approval = ctx.get('approval') as ApprovalLike | undefined

  const persistHost = async (host: string): Promise<void> => {
    const current = getConfig()
    if (current.allowHosts.includes(host)) return
    await scope.update({ allowHosts: [...current.allowHosts, host] })
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const current = getConfig()
    if (!current.gatedTools.includes(exec.name)) return next()
    const host = hostnameOf(exec.arguments)
    if (!host) return next()

    const decision = decideHost(current, host)
    if (decision === 'deny') {
      return { kind: 'deny', reason: `Host ${host} is denied by web-permission.` }
    }
    if (decision === 'allow') return next()

    // decision === 'ask'
    if (current.remember && approval && exec.agent) {
      let outcome: ApprovalOutcome
      try {
        outcome = await approval.request({
          agent: exec.agent,
          toolName: exec.name,
          callId: exec.callId,
          reason: `Allow web access to ${host}?`,
          signal: exec.signal,
        })
      } catch {
        return { kind: 'ask', reason: `Allow web access to ${host}?` }
      }
      if (outcome === 'allowed-once') {
        await persistHost(host)
        return next()
      }
      return { kind: 'deny', reason: `Access to ${host} was not approved.` }
    }

    return { kind: 'ask', reason: `Allow web access to ${host}?` }
  })
}
