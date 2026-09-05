import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCardForm } from '../src/client/form.ts'

test('createCardForm writes boolean stealth and windowVisibility', async () => {
  const value: Record<string, unknown> = { windowVisibility: 'visible', stealth: true, allowFakeIp: true }
  const base: Record<string, unknown> = { windowVisibility: 'visible', stealth: true, allowFakeIp: true }
  const user: Record<string, unknown> = {}
  const sets: Array<[string, unknown]> = []
  const listeners = new Set<() => void>()
  const scope: DshSettingsScope = {
    getSnapshot: () => ({ status: 'ready', writable: true, value, base, user }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(field, next) {
      sets.push([field, next])
      value[field] = next
      user[field] = next
      for (const listener of listeners) listener()
    },
    unset() {},
  }
  const form = createCardForm(scope, ['windowVisibility', 'stealth', 'allowFakeIp'])
  form.actions.edit('windowVisibility', 'hidden')
  form.actions.edit('stealth', 'false')
  form.actions.edit('allowFakeIp', 'false')
  form.actions.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(sets, [
    ['windowVisibility', 'hidden'],
    ['stealth', false],
    ['allowFakeIp', false],
  ])
})
