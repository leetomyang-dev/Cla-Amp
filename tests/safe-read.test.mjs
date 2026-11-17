// Checks for safe-read.mjs: each reader opens the file once and measures what it opened.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readCapped, readCappedLater, readEndLater, readTail, sizeAndBytes } from '../safe-read.mjs'

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'claamp-safe-read-'))
const file = path.join(folder, 'ten.txt')
fs.writeFileSync(file, '0123456789')

test.after(() => fs.rmSync(folder, { recursive: true, force: true }))

test('readCapped gives the bytes up to the limit and null past it', () => {
  assert.equal(readCapped(file, 10).toString(), '0123456789')
  assert.equal(readCapped(file, 9), null)
  assert.throws(() => readCapped(path.join(folder, 'missing'), 10))
})

test('readCappedLater does the same', async () => {
  assert.equal((await readCappedLater(file, 10)).toString(), '0123456789')
  assert.equal(await readCappedLater(file, 9), null)
  await assert.rejects(readCappedLater(path.join(folder, 'missing'), 10))
})

test('readTail gives the end of a long file and all of a short one', () => {
  assert.equal(readTail(file, 4).toString(), '6789')
  assert.equal(readTail(file, 100).toString(), '0123456789')
})

test('readEndLater gives the end of a long file, all of a short one, and fails on a missing one', async () => {
  const end = await readEndLater(file, 4)
  assert.equal(end.bytes.toString(), '6789')
  assert.equal(end.isCut, true)
  const all = await readEndLater(file, 100)
  assert.equal(all.bytes.toString(), '0123456789')
  assert.equal(all.isCut, false)
  await assert.rejects(readEndLater(path.join(folder, 'missing'), 10))
})

test('sizeAndBytes gives the size always and the bytes only when wanted and small enough', () => {
  assert.deepEqual(sizeAndBytes(file, 10).size, 10)
  assert.equal(sizeAndBytes(file, 10).bytes.toString(), '0123456789')
  assert.equal(sizeAndBytes(file, 9).bytes, null)
  assert.equal(sizeAndBytes(file, 10, false).bytes, null)
})
