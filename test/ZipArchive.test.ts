import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32, ZipArchive } from '@/archive/ZipArchive'

test('crc32 matches the known vector for "123456789"', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
})

test('crc32 of empty input is zero', () => {
  assert.equal(crc32(new Uint8Array()), 0)
})

test('archive is readable by a real unzip implementation', async () => {
  const archive = new ZipArchive()
  archive.addText('conversations.json', '[{"uuid":"a"}]')
  archive.addBytes('files/22222222-2222-2222-2222-222222222222', new Uint8Array([1, 2, 3, 4]))

  const bytes = new Uint8Array(await archive.toBlob().arrayBuffer())

  // End-of-central-directory signature, and both entries counted.
  const view = new DataView(bytes.buffer)
  const eocd = bytes.length - 22
  assert.equal(view.getUint32(eocd, true), 0x06054b50)
  assert.equal(view.getUint16(eocd + 10, true), 2)
  assert.equal(archive.entryCount, 2)
})

test('entry names are stored UTF-8 with the flag set', async () => {
  const archive = new ZipArchive()
  archive.addText('skipped.json', '[]')
  const bytes = new Uint8Array(await archive.toBlob().arrayBuffer())
  const view = new DataView(bytes.buffer)

  assert.equal(view.getUint32(0, true), 0x04034b50)
  assert.equal(view.getUint16(6, true), 0x0800, 'utf-8 name flag')
  assert.equal(view.getUint16(8, true), 0, 'stored, not deflated')
})
