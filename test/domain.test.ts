import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ExportRange, MessageKind, parseExportMessage, parseExportRange } from '@/domain'

test('a known range parses; anything else degrades to the default', () => {
  assert.equal(parseExportRange('90'), ExportRange.lastNinetyDays)
  assert.equal(parseExportRange('0'), ExportRange.everything)
  assert.equal(parseExportRange('nonsense'), ExportRange.lastThirtyDays)
  assert.equal(parseExportRange(''), ExportRange.lastThirtyDays)
})

test('messages from outside the extension are rejected', () => {
  assert.equal(parseExportMessage(null), null)
  assert.equal(parseExportMessage('start'), null)
  assert.equal(parseExportMessage({ kind: 'dropTables' }), null)
  assert.deepEqual(parseExportMessage({ kind: MessageKind.requestState }), {
    kind: MessageKind.requestState,
  })
})
