// Finds the Claude Code chats and agents that are working outside this app:
// in the Claude desktop app, a terminal, an editor. Claude Code saves every
// chat as a file of lines under its own folder (projects/<folder>/<chat>.jsonl,
// with a chat's agents in <chat>/subagents/agent-*.jsonl). Only the end of
// each recently saved file is read: to see whether its last turn is finished,
// and for the status bar's list, the chat's name, folder and the step it is
// on. Nothing is written, and nothing else from a chat is kept.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** A chat with no save for this long is taken as stopped, whatever its last line says. */
const QUIET_AFTER = 15 * 60 * 1000
const FRESH = 60 * 1000
const FIRST_READ = 1024 * 1024
const MOST_READ = 8 * 1024 * 1024
const DONE = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal', 'pause_turn'])

export const chatsFolder = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')

const short = (text, most) => {
  const tidy = String(text ?? '').replace(/\s+/g, ' ').trim()

  return tidy.length > most ? tidy.slice(0, most - 1) + '…' : tidy
}

/** A tool call in a few words: "Bash: Run the tests", "Edit: main.mjs". */
const stepOf = block => {
  const input = block.input ?? {}
  const name = String(block.name ?? 'tool').replace(/^mcp__.*__/, '')
  const about =
    typeof input.description === 'string' ? input.description
    : typeof input.file_path === 'string' ? path.basename(input.file_path)
    : typeof input.command === 'string' ? input.command
    : typeof input.pattern === 'string' ? input.pattern
    : typeof input.query === 'string' ? input.query
    : typeof input.url === 'string' ? input.url
    : ''

  return short(about ? `${name}: ${about}` : name, 90)
}

/**
 * Reads the last turn in the end of a chat file. `state` is 'working',
 * 'idle', or '' when the text holds no turn at all; `doing` is the step a
 * working turn is on. Lines that are not part of the conversation (costs,
 * attachments) are passed over, but a title or last prompt among them is kept.
 */
export const readTurn = (text, now = Date.now()) => {
  const lines = text.split('\n')
  const found = { state: '', doing: '', cwd: '', title: '', prompt: '', at: 0 }
  // Claude Code notes each request it sends for an answer.
  let isAsked = false

  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]

    if (!line.startsWith('{')) {
      continue
    }

    const head = line.slice(0, 300)

    if (head.includes('"type":"api-request"')) {
      isAsked = true
      continue
    }

    if (found.title === '' && head.includes('"type":"custom-title"')) {
      try {
        found.title = short(JSON.parse(line).customTitle, 80)
      } catch {
        // A cut line.
      }
      continue
    }

    if (found.prompt === '' && head.includes('"type":"last-prompt"')) {
      try {
        found.prompt = short(JSON.parse(line).lastPrompt, 80)
      } catch {
        // A cut line.
      }
      continue
    }

    if (!/"type":"(user|assistant)"/.test(line)) {
      continue
    }

    let entry

    try {
      entry = JSON.parse(line)
    } catch {
      // The cut first line of the part that was read.
      continue
    }

    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta === true) {
      continue
    }

    const content = entry.message?.content
    const blocks = Array.isArray(content) ? content : []

    // Walking backwards, the first tool call met is the step the turn is on.
    if (found.doing === '' && entry.type === 'assistant') {
      const call = blocks.findLast(one => one?.type === 'tool_use')
      found.doing = call ? stepOf(call) : blocks.some(one => one?.type === 'thinking') ? 'Thinking' : blocks.some(one => one?.type === 'text') ? 'Writing' : ''
    }

    if (found.state !== '') {
      // The turn's state is known; this was one more line to find its step.
      if (found.doing !== '' || entry.type === 'assistant') {
        break
      }
      continue
    }

    found.cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
    found.at = Date.parse(entry.timestamp ?? '') || 0

    if (entry.type === 'assistant') {
      found.state = DONE.has(entry.message?.stop_reason) ? 'idle' : 'working'
      break
    }

    const said = typeof content === 'string' ? content : blocks.map(one => (typeof one?.text === 'string' ? one.text : '')).join(' ')

    // Stopped by the person, or a command typed at the prompt: no turn follows.
    if (/\[Request interrupted|<local-command-|<command-name>/.test(said)) {
      found.state = 'idle'
      break
    }

    // A tool's answer always goes back to Claude. A message does once a
    // request for it is noted, or while it is fresh; a notice left behind
    // when its app closed has neither.
    const isAnswer = blocks.some(one => one?.type === 'tool_result')
    found.state = isAnswer || isAsked || now - found.at < FRESH ? 'working' : 'idle'

    if (found.state === 'idle') {
      break
    }
    // Working: one line further back holds the tool call being answered.
  }

  if (found.state !== 'working') {
    found.doing = ''
  } else if (found.doing === '') {
    found.doing = 'Thinking'
  }

  return found
}

/** Only whether the last turn is still going. */
export const turnState = (text, now = Date.now()) => readTurn(text, now).state

const endOf = (file, size, most) => {
  const length = Math.min(size, most)
  const buffer = Buffer.alloc(length)
  const handle = fs.openSync(file, 'r')

  try {
    fs.readSync(handle, buffer, 0, length, size - length)
  } finally {
    fs.closeSync(handle)
  }

  return buffer.toString('utf8')
}

/** The working turn at the end of a chat file, or null. */
const workIn = (file, now) => {
  try {
    const stat = fs.statSync(file)

    if (now - stat.mtimeMs > QUIET_AFTER || stat.size === 0) {
      return null
    }

    let turn = readTurn(endOf(file, stat.size, FIRST_READ), now)

    if (turn.state === '' && stat.size > FIRST_READ) {
      turn = readTurn(endOf(file, stat.size, MOST_READ), now)
    }

    return turn.state === 'working' ? turn : null
  } catch {
    // Being written, or gone.
    return null
  }
}

const list = folder => {
  try {
    return fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return []
  }
}

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The chats that are working or have working agents, newest step first. Each:
 * { id, title, folder, cwd, doing, isWorking, agents: [{ name, kind, doing }] }.
 * `skip` holds the chats this app is running itself, which it shows on its own.
 */
export const listOutside = ({ root = chatsFolder(), skip = new Set(), now = Date.now() } = {}) => {
  const chats = new Map()
  const chat = (folder, id) => {
    if (!chats.has(id)) {
      chats.set(id, { id, title: '', folder: '', cwd: '', doing: '', isWorking: false, at: 0, agents: [], dir: path.join(folder, id) })
    }

    return chats.get(id)
  }

  for (const project of list(root)) {
    if (!project.isDirectory()) {
      continue
    }

    const folder = path.join(root, project.name)

    for (const entry of list(folder)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const id = entry.name.slice(0, -6)
        const turn = skip.has(id) ? null : workIn(path.join(folder, entry.name), now)

        if (turn) {
          Object.assign(chat(folder, id), {
            isWorking: true,
            doing: turn.doing,
            at: turn.at,
            title: turn.title || turn.prompt,
            folder: turn.cwd ? path.basename(turn.cwd) : '',
            cwd: turn.cwd,
          })
        }
      } else if (entry.isDirectory() && !skip.has(entry.name)) {
        const subs = path.join(folder, entry.name, 'subagents')

        for (const sub of list(subs)) {
          if (!sub.isFile() || !/^agent-.*\.jsonl$/.test(sub.name)) {
            continue
          }

          const turn = workIn(path.join(subs, sub.name), now)

          if (turn) {
            const meta = readJson(path.join(subs, sub.name.replace(/\.jsonl$/, '.meta.json')))
            const owner = chat(folder, entry.name)
            owner.agents.push({ name: short(meta?.description || 'Agent', 80), kind: short(meta?.agentType || '', 40), doing: turn.doing })
            owner.at = Math.max(owner.at, turn.at)
            owner.folder ||= turn.cwd ? path.basename(turn.cwd) : ''
            owner.cwd ||= turn.cwd
          }
        }
      }
    }
  }

  return [...chats.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, 40)
    .map(({ dir, at, ...one }) => ({
      ...one,
      // The name given in the desktop app, else the chat's last prompt.
      title: short(readJson(path.join(dir, 'custom-title.json'))?.customTitle || one.title || 'Chat', 80),
      agents: one.agents.slice(0, 12),
    }))
}

/** How many chats and agents are working. */
export const countOutside = (options, found = listOutside(options)) => {
  return { chats: found.filter(one => one.isWorking).length, agents: found.reduce((sum, one) => sum + one.agents.length, 0) }
}
