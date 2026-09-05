import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as gate from '../src/index.ts'

function mockSettings(base: Partial<gate.Config> = {}) {
  const state = {
    allowHosts: base.allowHosts ?? [],
    denyHosts: base.denyHosts ?? ['evil.com'],
    gatedTools: base.gatedTools ?? ['browser_navigate'],
    defaultAction: base.defaultAction ?? 'ask' as const,
    remember: base.remember ?? true,
  }
  const updates: Array<{ allowHosts: string[] }> = []
  return {
    updates,
    provider: {
      register(_ns: unknown, _schema: unknown, options: { base?: gate.Config; expose?: string; applies?: string }) {
        assert.equal(options.expose, 'web')
        Object.assign(state, options.base ?? {})
        return {
          get: () => ({ ...state }),
          update: async (patch: { allowHosts: string[] }) => {
            updates.push(patch)
            state.allowHosts = patch.allowHosts
          },
        }
      },
    },
  }
}

test('web-permission gate denies, allows, and asks through the real waterfall', async () => {
  const ctx = new Context()
  const { provider } = mockSettings({
    allowHosts: ['example.com'],
    denyHosts: ['evil.com'],
    gatedTools: ['browser_navigate'],
    defaultAction: 'ask',
  })
  ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('settings', provider)

  await ctx.plugin(
    { name: gate.name, inject: gate.inject, Config: gate.Config, apply: gate.apply },
    {
      allowHosts: ['example.com'],
      denyHosts: ['evil.com'],
      gatedTools: ['browser_navigate'],
      defaultAction: 'ask',
    },
  )

  const run = (name: string, args: unknown) =>
    ctx.waterfall('tools/pre-execute', { name, arguments: args }, () => Promise.resolve({ kind: 'allow' as const }))

  const deny = await run('browser_navigate', { url: 'https://evil.com/' })
  assert.equal(deny.kind, 'deny')

  const allow = await run('browser_navigate', { url: 'https://example.com/' })
  assert.equal(allow.kind, 'allow')

  const ask = await run('browser_navigate', { url: 'https://unknown.com/' })
  assert.equal(ask.kind, 'ask')

  const passthrough = await run('browser_snapshot', {})
  assert.equal(passthrough.kind, 'allow')
})

test('web-permission persists an approved host into allowHosts when remember is on', async () => {
  const ctx = new Context()
  const { provider, updates } = mockSettings({
    allowHosts: [],
    denyHosts: ['evil.com'],
    gatedTools: ['browser_navigate'],
    defaultAction: 'ask',
    remember: true,
  })
  ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('settings', provider)
  ;(ctx as unknown as { provide: (k: string, v: unknown) => void }).provide('approval', {
    request: async () => 'allowed-once' as const,
  })

  await ctx.plugin(
    { name: gate.name, inject: gate.inject, Config: gate.Config, apply: gate.apply },
    {
      allowHosts: [],
      denyHosts: ['evil.com'],
      gatedTools: ['browser_navigate'],
      defaultAction: 'ask',
      remember: true,
    },
  )

  const run = (name: string, args: unknown) =>
    ctx.waterfall(
      'tools/pre-execute',
      { name, arguments: args, agent: { id: 'test-agent' }, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'allow' as const }),
    )

  const decision = await run('browser_navigate', { url: 'https://newhost.com/' })
  assert.equal(decision.kind, 'allow')
  assert.deepEqual(updates, [{ allowHosts: ['newhost.com'] }])
})

test('web-permission declares inject settings so Host registration cannot be skipped', () => {
  assert.deepEqual(gate.inject, ['settings'])
})
