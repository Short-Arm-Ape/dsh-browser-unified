import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCardForm, decodeList, encodeList } from '../src/client/form.ts'

test('encodeList / decodeList round-trip host lists', () => {
  assert.equal(encodeList(['example.com', 'foo.test']), 'example.com\nfoo.test')
  assert.deepEqual(decodeList('example.com\n foo.test, bar.test'), ['example.com', 'foo.test', 'bar.test'])
})

test('createCardForm stages edits and writes set/unset', async () => {
  const user: Record<string, unknown> = {}
  const value: Record<string, unknown> = {
    allowHosts: ['a.com'],
    remember: true,
  }
  const base: Record<string, unknown> = {
    allowHosts: [],
    remember: true,
  }
  const sets: Array<[string, unknown]> = []
  const unsets: string[] = []
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
    unset(field) {
      unsets.push(field)
      delete user[field]
      value[field] = base[field]
      for (const listener of listeners) listener()
    },
  }
  const form = createCardForm(scope, ['allowHosts', 'remember'])
  assert.equal(form.store.getSnapshot().available, true)
  form.actions.edit('allowHosts', 'b.com\nc.com')
  assert.equal(form.store.getSnapshot().dirty, true)
  form.actions.save()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(sets, [['allowHosts', ['b.com', 'c.com']]])
  assert.equal(form.store.getSnapshot().dirty, false)
  form.actions.resetField('allowHosts')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(unsets, ['allowHosts'])
})
