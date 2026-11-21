import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { notesNewTo, readNotes } from '../whats-new.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const page = fs.readFileSync(path.join(ROOT, 'docs', 'whats-new.md'), 'utf8')

test('the page in this folder has dated notes', () => {
  const notes = readNotes(page)

  assert.ok(notes.length >= 3)
  assert.match(notes[0].when, /^\d{1,2} [A-Z][a-z]+ \d{4}$/)
  assert.ok(notes.every(one => one.notes.every(note => note.length > 3 && !note.includes('**'))))
})

test('a copy with the same page is told nothing is new', () => {
  assert.deepEqual(notesNewTo(page, page), { groups: [], more: 0 })
})

test('a copy without the newest notes is shown them, under their date', () => {
  const older = page.slice(page.indexOf('\n## ', page.indexOf('\n## ') + 1))
  const got = notesNewTo(page, older)

  assert.equal(got.groups.length, 1)
  assert.equal(got.groups[0].when, readNotes(page)[0].when)
  assert.deepEqual(got.groups[0].notes, readNotes(page)[0].notes)
})

test('a note added under an old date is still new', () => {
  const theirs = '## 1 May 2026\n- One.\n- Two.\n'
  const mine = '## 1 May 2026\n- One.\n'

  assert.deepEqual(notesNewTo(theirs, mine), { groups: [{ when: '1 May 2026', notes: ['Two.'] }], more: 0 })
})

test('long lists are cut and counted, and marks and control characters are dropped', () => {
  const theirs = `## 2 May 2026\n${Array.from({ length: 20 }, (_, i) => `- **Note** \`${i}\`\u0007.`).join('\n')}\n`
  const got = notesNewTo(theirs, '', 5)

  assert.equal(got.groups[0].notes.length, 5)
  assert.equal(got.more, 15)
  assert.equal(got.groups[0].notes[0], 'Note 0 .')
})
