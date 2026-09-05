import assert from 'node:assert/strict'
import { test } from 'node:test'
import { screenshotBlocks } from '../src/screenshot.ts'

test('screenshotBlocks emits a text caption and an image ContentBlock', () => {
  const blocks = screenshotBlocks({
    attachmentId: 'att_1',
    mediaType: 'image/png',
    bytes: 12,
    width: 800,
    height: 600,
  })
  assert.equal(blocks[0]?.type, 'text')
  assert.equal(blocks[1]?.type, 'image')
  assert.equal(blocks[1] && blocks[1].type === 'image' ? blocks[1].attachment.attachmentId : '', 'att_1')
})
