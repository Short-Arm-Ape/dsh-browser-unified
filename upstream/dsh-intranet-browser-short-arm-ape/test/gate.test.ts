/** Unit tests for the approval-gate decision logic. @module dsh-intranet-browser/test */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { approvalReason, gateAction, sessionApprovalPolicy } from '../src/gate.js'

const perCall = { approvalMode: 'per-call' as const, approvalScope: 'all' as const }
const armMode = { approvalMode: 'arm' as const, approvalScope: 'all' as const }
const navScope = { approvalMode: 'per-call' as const, approvalScope: 'navigation' as const }

describe('intranet approval gate', () => {
  it('passes tools that are not intranet_*', () => {
    assert.deepEqual(gateAction('browser_navigate', perCall, false), { kind: 'pass' })
    assert.deepEqual(gateAction('web_fetch', armMode, false), { kind: 'pass' })
  })

  it('asks before arming only under approvalMode arm; per-call treats arm as a no-op', () => {
    assert.deepEqual(gateAction('intranet_arm', armMode, true), { kind: 'ask-arm' })
    assert.deepEqual(gateAction('intranet_arm', armMode, false), { kind: 'ask-arm' })
    assert.deepEqual(gateAction('intranet_arm', perCall, false), { kind: 'pass' })
  })

  it('disarm needs no approval', () => {
    assert.deepEqual(gateAction('intranet_disarm', perCall, true), { kind: 'disarm' })
  })

  it('per-call mode asks for every intranet_* call, even when armed', () => {
    assert.deepEqual(gateAction('intranet_open', perCall, true), { kind: 'ask' })
    assert.deepEqual(gateAction('intranet_snapshot', perCall, false), { kind: 'ask' })
  })

  it('arm mode passes intranet_* calls while armed, and asks otherwise', () => {
    assert.deepEqual(gateAction('intranet_open', armMode, true), { kind: 'pass' })
    assert.deepEqual(gateAction('intranet_click', armMode, true), { kind: 'pass' })
    assert.deepEqual(gateAction('intranet_open', armMode, false), { kind: 'ask' })
  })

  it('approvalScope navigation frees read-only tools but still gates write tools', () => {
    assert.deepEqual(gateAction('intranet_snapshot', navScope, false), { kind: 'pass' })
    assert.deepEqual(gateAction('intranet_screenshot', navScope, false), { kind: 'pass' })
    assert.deepEqual(gateAction('intranet_scroll', navScope, false), { kind: 'pass' })
    assert.deepEqual(gateAction('intranet_wait', navScope, false), { kind: 'pass' })
    assert.deepEqual(gateAction('intranet_list_tabs', navScope, false), { kind: 'pass' })
    // navigation / write tools still prompt every time
    assert.deepEqual(gateAction('intranet_open', navScope, false), { kind: 'ask' })
    assert.deepEqual(gateAction('intranet_click', navScope, true), { kind: 'ask' })
    assert.deepEqual(gateAction('intranet_open_tab', navScope, false), { kind: 'ask' })
    assert.deepEqual(gateAction('intranet_evaluate', navScope, false), { kind: 'ask' })
  })

  it('full-access sessions (policy never) auto-pass every intranet_* call', () => {
    assert.deepEqual(gateAction('intranet_open', perCall, false, 'never'), { kind: 'pass' })
    assert.deepEqual(gateAction('intranet_click', perCall, false, 'never'), { kind: 'pass' })
    assert.deepEqual(gateAction('intranet_arm', perCall, false, 'never'), { kind: 'pass' })
    assert.deepEqual(gateAction('intranet_snapshot', armMode, false, 'never'), { kind: 'pass' })
    // ...but tools outside the intranet namespace are unaffected.
    assert.deepEqual(gateAction('browser_navigate', perCall, false, 'never'), { kind: 'pass' })
  })

  it('builds an approval reason that names the target URL for intranet_open', () => {
    const reason = approvalReason('intranet_open', { url: 'http://localhost:8080/admin' })
    assert.match(reason, /localhost:8080/)
    assert.match(reason, /SSRF/)
  })

  it('builds a generic reason for other tools', () => {
    const reason = approvalReason('intranet_snapshot', {})
    assert.match(reason, /intranet_snapshot/)
  })
})

describe('session approval policy read', () => {
  it('defaults to ask without an override or configured policy', () => {
    assert.equal(sessionApprovalPolicy(undefined, undefined), 'ask')
    assert.equal(sessionApprovalPolicy({}, undefined), 'ask')
  })

  it('falls back to the host configured default', () => {
    const approval = { config: { policy: 'never' as const } }
    assert.equal(sessionApprovalPolicy(approval, undefined), 'never')
  })

  it('prefers the last approval/policy event in the session log', () => {
    const agent = {
      session: {
        events: [
          { type: 'approval/policy', data: { policy: 'never' } },
          { type: 'approval/policy', data: { policy: 'ask' } },
        ],
      },
    }
    // Host default is 'never', but the session override wins.
    assert.equal(sessionApprovalPolicy({ config: { policy: 'never' as const } }, agent), 'ask')
  })

  it('ignores unrelated events and returns the latest policy switch', () => {
    const agent = {
      session: {
        events: [
          { type: 'session/start', data: {} },
          { type: 'approval/policy', data: { policy: 'never' } },
          { type: 'permission/preset', data: { preset: 'danger-full-access' } },
        ],
      },
    }
    assert.equal(sessionApprovalPolicy(undefined, agent), 'never')
  })

  it('treats a malformed policy event as no override', () => {
    const agent = {
      session: {
        events: [
          { type: 'approval/policy', data: { policy: 'sometimes' } },
        ],
      },
    }
    assert.equal(sessionApprovalPolicy(undefined, agent), 'ask')
  })
})
