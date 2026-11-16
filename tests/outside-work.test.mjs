// The count of chats working outside the app, from made-up chat files.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { countOutside, turnState } from '../outside-work.mjs'

const now = Date.parse('2026-11-15T12:00:00Z')
const at = secondsAgo => new Date(now - secondsAgo * 1000).toISOString()
const line = entry => JSON.stringify(entry)
const said = (stop, secondsAgo = 5) => line({ type: 'assistant', timestamp: at(secondsAgo), message: { stop_reason: stop, content: [{ type: 'text', text: 'x' }] } })
const toolAnswer = line({ type: 'user', timestamp: at(900), message: { content: [{ type: 'tool_result', content: 'ok' }] } })
const message = (text, secondsAgo) => line({ type: 'user', timestamp: at(secondsAgo), message: { content: text } })
const extras = [line({ type: 'cost-state' }), line({ type: 'last-prompt' })]

test('a turn is working until Claude ends it', () => {
  assert.equal(turnState([said('tool_use'), ...extras].join('\n'), now), 'working')
  assert.equal(turnState([said('tool_use'), toolAnswer, ...extras].join('\n'), now), 'working')
  assert.equal(turnState([toolAnswer, said('end_turn'), ...extras].join('\n'), now), 'idle')
  assert.equal(turnState(extras.join('\n'), now), '')
})

test('a message counts once it is asked about or while fresh', () => {
  assert.equal(turnState(message('hello', 5), now), 'working')
  assert.equal(turnState([message('hello', 500), line({ type: 'api-request', timestamp: at(499) })].join('\n'), now), 'working')
  // A notice left when the app closed: old, and never sent on.
  assert.equal(turnState([said('end_turn'), message('<task-notification>', 500), ...extras].join('\n'), now), 'idle')
  assert.equal(turnState(message('[Request interrupted by user]', 5), now), 'idle')
})

test('chats and their agents are counted, skipped chats and old files are not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-outside-'))
  const folder = path.join(root, 'C--some-project')
  const put = (name, text, minutesOld = 0) => {
    const file = path.join(folder, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text + '\n')
    const when = new Date(now - minutesOld * 60000)
    fs.utimesSync(file, when, when)
  }

  put('aaaa.jsonl', said('tool_use'))
  put('aaaa/subagents/agent-1.jsonl', said('tool_use'))
  put('aaaa/subagents/agent-2.jsonl', said('end_turn'))
  put('bbbb.jsonl', said('end_turn'))
  put('cccc.jsonl', said('tool_use'), 40)
  put('dddd.jsonl', said('tool_use'))
  put('dddd/subagents/agent-3.jsonl', said('tool_use'))

  try {
    assert.deepEqual(countOutside({ root, now }), { chats: 2, agents: 2 })
    assert.deepEqual(countOutside({ root, now, skip: new Set(['dddd']) }), { chats: 1, agents: 1 })
    assert.deepEqual(countOutside({ root: path.join(root, 'missing'), now }), { chats: 0, agents: 0 })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
