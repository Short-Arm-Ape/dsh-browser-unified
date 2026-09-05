import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionKeyOf } from '../src/index.ts'

test('sessionKeyOf prefers session.id then agent.id then default', () => {
  assert.equal(sessionKeyOf({ session: { id: 'sess-1' }, agent: { id: 'agent-9' } }), 'sess-1')
  assert.equal(sessionKeyOf({ agent: { id: 'agent-9' } }), 'agent:agent-9')
  assert.equal(sessionKeyOf({}), 'default')
})
