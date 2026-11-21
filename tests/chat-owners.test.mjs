import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ownerIn, ownerOfFile, ownersOnDisk } from '../chat-owners.mjs'

const A = '11111111-2222-3333-4444-555555555555'
const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const line = org => `${JSON.stringify({ type: 'session-owner', organizationUuid: org })}\n`
const filler = bytes => `${JSON.stringify({ type: 'user', message: 'x'.repeat(bytes) })}\n`

const scratch = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claamp-owners-'))
  fs.mkdirSync(path.join(root, 'C--one'))
  fs.mkdirSync(path.join(root, 'C--two'))

  return root
}

test('the id is read from a line that names it, and nothing is found where none is', () => {
  assert.equal(ownerIn(line(A)), A)
  assert.equal(ownerIn('{"attachment":{"organizationUuid": "' + B.toUpperCase() + '"}}'), B)
  assert.equal(ownerIn(filler(50)), '')
  assert.equal(ownerIn('"organizationUuid":"not an id"'), '')
})

test('a mark at the start, at the end or in the middle of a long file is found; a file without one gives none', async () => {
  const root = scratch()
  const start = path.join(root, 'C--one', 'start.jsonl')
  const end = path.join(root, 'C--one', 'end.jsonl')
  const middle = path.join(root, 'C--one', 'middle.jsonl')
  fs.writeFileSync(start, line(A) + filler(900000))
  fs.writeFileSync(end, filler(900000) + line(B))
  fs.writeFileSync(middle, filler(600000) + line(A) + filler(600000))

  assert.equal((await ownerOfFile(start)).org, A)
  assert.equal((await ownerOfFile(end)).org, B)
  assert.equal((await ownerOfFile(middle)).org, A)

  const none = path.join(root, 'C--one', 'none.jsonl')
  fs.writeFileSync(none, filler(600000) + filler(600000))
  assert.equal((await ownerOfFile(none)).org, '')

  // A mark lying across the edge of the first piece read.
  const edge = path.join(root, 'C--one', 'edge.jsonl')
  const mark = line(B)
  fs.writeFileSync(edge, 'x'.repeat(512 * 1024 - 30) + mark + filler(900000))
  assert.equal((await ownerOfFile(edge)).org, B)
  fs.rmSync(root, { recursive: true, force: true })
})

test('every chat under the projects folder gets its owner, and what was found is remembered', async () => {
  const root = scratch()
  const ids = ['00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000c']
  fs.writeFileSync(path.join(root, 'C--one', `${ids[0]}.jsonl`), line(A))
  fs.writeFileSync(path.join(root, 'C--two', `${ids[1]}.jsonl`), line(B))
  fs.writeFileSync(path.join(root, 'C--two', `${ids[2]}.jsonl`), filler(40))
  fs.writeFileSync(path.join(root, 'C--two', 'notes.txt'), line(A))

  const known = {}
  const first = await ownersOnDisk(root, known)
  assert.deepEqual([...first.owners].sort(), [[ids[0], A], [ids[1], B], [ids[2], '']])
  assert.equal(first.isChanged, true)
  assert.equal(known[ids[0]].org, A)

  // Nothing new on disk: nothing is read again.
  const second = await ownersOnDisk(root, known)
  assert.equal(second.isChanged, false)
  assert.deepEqual([...second.owners].sort(), [...first.owners].sort())

  // A chat without an owner that has since grown is looked at again.
  fs.appendFileSync(path.join(root, 'C--two', `${ids[2]}.jsonl`), line(B))
  const third = await ownersOnDisk(root, known)
  assert.equal(third.owners.get(ids[2]), B)
  assert.equal(third.isChanged, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('a projects folder that is not there gives no owners', async () => {
  const got = await ownersOnDisk(path.join(os.tmpdir(), 'claamp-owners-none-such'))

  assert.equal(got.owners.size, 0)
})
