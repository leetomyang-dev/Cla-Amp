// Cla-Amp's window: projects on the left, the chat in the middle, meters and
// the music deck on the right. The main process runs the sessions and sends
// events; this file turns them into what is on screen.
import hljs from '../node_modules/@highlightjs/cdn-assets/es/highlight.min.js'
import DOMPurify from '../node_modules/dompurify/dist/purify.es.mjs'
import { marked } from '../node_modules/marked/lib/marked.esm.js'

import { openAbout } from './about.js'
import { announce, asKey, calmChoice, setCalm, setSize, sizeNow, SIZES } from './access.js'
import { dayKey, drawCalendar, notePeak, noteToday } from './calendar.js'
import { buildEqualizer, tuner } from './equalizer.js'
import { openGuides } from './guides.js'
import { LANGS, langChoice, setLang } from './lang.js'
import { openLook, startLook } from './look.js'
import { chime, flash, noticeChoice, setNotices } from './notice.js'
import { isBig, setBig } from './places.js'
import { openThemes } from './themes.js'
import { openSettings } from './settings.js'
import { drawStyle, isEffectOn, nextSpectrumStyle, openSpectrumMenu, setCoverColours, setSkinLines, spectrumStyle } from './spectrum.js'

const $ = id => document.getElementById(id)
const isDemo = new URLSearchParams(location.search).has('demo')
const call = (name, ...args) => (isDemo ? Promise.resolve(null) : window.amp.call(name, ...args))
const el = (tag, className, text) => {
  const node = document.createElement(tag)

  if (className) {
    node.className = className
  }

  if (text !== undefined) {
    node.textContent = text
  }

  return node
}
const clock = seconds => {
  const whole = Math.max(0, Math.floor(seconds))

  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
const timeOf = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const count = number => Math.round(number).toLocaleString('en-US')
const baseName = file => String(file).split(/[\\/]/).pop()

const MODES = [
  { id: 'default', label: 'Ask', hint: 'Claude asks before it edits files or runs commands' },
  { id: 'acceptEdits', label: 'Auto-edit', hint: 'Claude edits files without asking; still asks for commands' },
  { id: 'auto', label: 'Auto', hint: 'Claude works on by itself: Claude Code checks each step and asks you only for the risky ones' },
  { id: 'plan', label: 'Plan', hint: 'Claude only reads and plans; it changes nothing' },
]
const BADGES = { working: 'WORKING', waiting: 'WAITING', complete: 'COMPLETE', attention: 'ATTENTION' }

/** @type {Map<string, any>} */
const projects = new Map()
let activeId = null
let tab = 'projects'
const active = () => projects.get(activeId) ?? null

// ------------------------------------------------------------------ projects

const addProject = info => {
  const project = {
    ...info,
    items: [],
    current: null,
    tools: new Map(),
    asks: new Map(),
    subs: [],
    tasks: [],
    taskAsks: new Map(),
    usage: null,
    lastPrompt: '',
    startedAt: 0,
    branch: '',
    isLoaded: false,
  }
  projects.set(info.id, project)

  return project
}

/**
 * What is written and attached but not sent yet, kept for each chat: the
 * message box follows the chat in view, and a half-written message waits
 * where it was written, also across a reload or a restart. A chat that has
 * not been saved yet (a new one) is known by its project entry.
 */
const drafts = new Map()
const draftKeyOf = project => (project ? (project.chatId ? `chat:${project.chatId}` : `new:${project.id}`) : null)
// The chat that what is in the message box right now belongs to.
let boxKey = null

/** A new chat got its id (its first message was sent): what is being written moves with it. */
const nameChat = (project, chatId) => {
  const before = draftKeyOf(project)
  project.chatId = chatId
  const now = draftKeyOf(project)

  if (before !== now) {
    if (drafts.has(before)) {
      drafts.set(now, drafts.get(before))
      drafts.delete(before)
    }

    if (boxKey === before) {
      boxKey = now
    }
  }
}

try {
  for (const [id, draft] of Object.entries(JSON.parse(localStorage.getItem('drafts') ?? '{}'))) {
    drafts.set(id, draft)
  }
} catch {
  // Unreadable drafts are dropped.
}

const keepDraft = () => {
  const input = document.getElementById('input')

  if (!boxKey || !input) {
    return
  }

  if (input.value === '' && attached.length === 0) {
    drafts.delete(boxKey)
  } else {
    drafts.set(boxKey, { text: input.value, files: [...attached] })
  }
  localStorage.setItem('drafts', JSON.stringify(Object.fromEntries(drafts)))
}

const takeDraft = () => {
  const input = $('input')
  boxKey = draftKeyOf(active())
  const draft = drafts.get(boxKey)
  input.value = typeof draft?.text === 'string' ? draft.text : ''
  attached = Array.isArray(draft?.files) ? draft.files.filter(one => typeof one === 'string') : []
  renderAttached()
  input.dispatchEvent(new Event('input'))
}

const select = async id => {
  keepDraft()
  activeId = id
  // Opened: what it had to tell has been seen.
  seen(projects.get(id))
  takeDraft()
  localStorage.setItem('active', id ?? '')
  const project = active()

  if (project && !project.isLoaded) {
    project.isLoaded = true
    const events = (await call('project:transcript', id)) ?? []

    for (const event of events) {
      apply(project, event, true)
    }

    for (const ask of project.asks.values()) {
      ask.isSettled = true
    }
    project.asks.clear()
  }

  if (project) {
    void call('project:branch', id).then(branch => {
      project.branch = branch ?? project.branch

      if (activeId === id) {
        renderStatus()
      }
    })
  }
  renderAll()
  void loadEngine()
}

// -------------------------------------------------------------------- events

const assistantItem = (project, ts) => {
  if (!project.current) {
    project.current = { kind: 'assistant', ts, parts: [] }
    project.items.push(project.current)
  }

  return project.current
}

/** Folds a task-list tool call into the project's task list. True when the call was one. */
const noteTask = (project, block) => {
  const input = block.input ?? {}

  if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
    project.tasks = input.todos.map((one, index) => ({ id: String(index), content: String(one.content ?? ''), status: one.status }))
  } else if (block.name === 'TaskCreate') {
    project.taskAsks.set(block.id, String(input.subject ?? 'Task'))
  } else if (block.name === 'TaskUpdate') {
    const task = project.tasks.find(one => one.id === String(input.taskId))

    if (input.status === 'deleted') {
      project.tasks = project.tasks.filter(one => one !== task)
    } else if (task) {
      task.status = input.status ?? task.status
      task.content = input.subject ? String(input.subject) : task.content
    }
  } else if (block.name.endsWith('__update_plan')) {
    // The Claude desktop app's own task list: the whole list, or a step forward in it.
    const listed = typeof input.items === 'string' ? JSON.parse(input.items) : input.items
    const numbers = value => (Array.isArray(value) ? value : typeof value === 'string' ? JSON.parse(value) : []).map(Number)

    if (Array.isArray(listed)) {
      project.tasks = listed.map((one, index) => ({ id: String(index + 1), content: String(one?.content ?? ''), status: ['pending', 'in_progress', 'completed'].includes(one?.status) ? one.status : 'pending' }))
    }

    if (input.advance === true || input.advance === 'true') {
      const now = project.tasks.find(one => one.status === 'in_progress')
      const next = project.tasks.find(one => one.status === 'pending')

      if (now) {
        now.status = 'completed'
      }

      if (next) {
        next.status = 'in_progress'
      }
    }

    for (const done of numbers(input.done)) {
      const task = project.tasks[done - 1]

      if (task) {
        task.status = 'completed'
      }
    }

    const start = project.tasks[Number(input.start) - 1]

    if (start) {
      for (const one of project.tasks) {
        one.status = one.status === 'in_progress' ? 'pending' : one.status
      }
      start.status = 'in_progress'
    }
  } else if (block.name.endsWith('__wrap_up')) {
    // The desktop app's end of a turn: whatever was on the list is done.
    for (const one of project.tasks) {
      one.status = 'completed'
    }
  } else if (block.name !== 'TaskList' && block.name !== 'TaskGet') {
    return false
  }

  return true
}

const dropLive = item => {
  item.parts = item.parts.filter(part => !part.isLive)
}

/** Folds one session event into a project's state. `isReplay` is a saved transcript being read back. */
const apply = (project, event, isReplay = false) => {
  switch (event.t) {
    case 'user':
      // A finished task list leaves with the next message.
      if (project.tasks.every(task => task.status === 'completed')) {
        project.tasks = []
      }
      project.current = null
      project.suggestion = ''
      project.lastPrompt = event.text
      project.startedAt = event.ts
      project.items.push({ kind: 'user', ts: event.ts, text: event.text, pictures: Array.isArray(event.pictures) ? event.pictures : [] })
      break
    case 'delta': {
      const item = assistantItem(project, event.ts)
      let live = item.parts.find(part => part.isLive && part.type === 'text')

      if (!live) {
        live = { type: 'text', text: '', isLive: true }
        item.parts.push(live)
      }
      live.text += event.text
      item.isDirty = true
      break
    }
    // Claude's thinking, as it comes.
    case 'think': {
      const item = assistantItem(project, event.ts)
      let live = item.parts.find(part => part.isLive && part.type === 'thinking')

      if (!live) {
        live = { type: 'thinking', text: '', isLive: true }
        item.parts.push(live)
      }
      live.text += event.text
      item.isDirty = true
      break
    }
    case 'assistant': {
      if (event.usage) {
        project.usage = event.usage
      }

      if (!event.isMain) {
        break
      }

      const item = assistantItem(project, event.ts)
      dropLive(item)
      // The reply's own id in the saved chat: a fork ends on it.
      item.uuid = event.uuid ?? item.uuid

      for (const block of event.blocks) {
        if (block.type === 'text') {
          item.parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking') {
          item.parts.push({ type: 'thinking', text: block.text })
        } else {
          const part = { type: 'tool', id: block.id, name: block.name, input: block.input ?? {}, startedAt: event.ts }
          // Claude's task list is shown as a list, not as tool calls.
          part.isQuiet = noteTask(project, block)
          item.parts.push(part)
          project.tools.set(block.id, { item, part })

          if (block.name === 'Agent' || block.name === 'Task') {
            project.subs.push({
              id: block.id,
              name: block.input?.description ?? 'Agent',
              kind: block.input?.subagent_type ?? 'agent',
              status: isReplay ? 'complete' : 'working',
            })
            project.subs = project.subs.slice(-6)
          }
        }
      }
      item.isDirty = true
      break
    }
    case 'tool_result': {
      const found = project.tools.get(event.id)

      const subject = project.taskAsks.get(event.id)

      // A new task's number comes back in the tool's answer.
      if (subject !== undefined) {
        project.taskAsks.delete(event.id)
        const id = /#(\d+)/.exec(event.text ?? '')?.[1]

        if (id && !event.isError) {
          project.tasks.push({ id, content: subject, status: 'pending' })
        }
      }

      if (found) {
        found.part.result = event.text
        found.part.pictures = Array.isArray(event.pictures) ? event.pictures : []
        found.part.isError = event.isError
        found.part.isDone = true
        found.item.isDirty = true
      }

      const sub = project.subs.find(one => one.id === event.id)

      // A background agent's tool call answers at once; the agent itself works on.
      if (sub && !sub.isBackground) {
        sub.status = event.isError ? 'attention' : 'complete'
      }
      break
    }
    case 'permission': {
      const ask = { kind: 'ask', ts: event.ts, id: event.id, tool: event.tool, input: event.input, always: event.always }
      project.current = null
      project.items.push(ask)
      project.asks.set(event.id, ask)
      break
    }
    case 'permission-done': {
      const ask = project.asks.get(event.id)

      if (ask) {
        ask.isSettled = true
        ask.isAllowed = event.isAllowed
        ask.isDirty = true
        project.asks.delete(event.id)
      }
      break
    }
    // An agent working in the background: listed until the engine says it ended.
    case 'agent-bg': {
      const sub = project.subs.find(one => one.id === event.id)

      if (sub) {
        Object.assign(sub, { isBackground: true, status: 'working' })
      } else {
        // isTask: a background command, workflow or monitor rather than an agent.
        project.subs.push({ id: event.id, name: event.name || 'Agent', kind: event.kind || 'agent', status: 'working', isBackground: true, isTask: event.isTask === true })
      }
      // Finished agents make room first, so a working one is never dropped from the list.
      project.subs = [...project.subs.filter(one => one.status !== 'working').slice(-4), ...project.subs.filter(one => one.status === 'working')]
      break
    }
    case 'agent-bg-done': {
      const sub = project.subs.find(one => one.id === event.id)

      if (sub) {
        sub.status = event.isOk ? 'complete' : 'attention'
      }
      break
    }
    case 'compacted':
      project.items.push({ kind: 'note', text: `The chat was compacted${event.before > 0 ? ` (it was at ${kilo(event.before)} tokens)` : ''}: older messages are now a summary.` })
      break
    // Claude Code's guess at the next message, offered in the message box.
    case 'suggest':
      project.suggestion = isReplay ? '' : String(event.text ?? '')
      break
    case 'result': {
      if (project.current) {
        dropLive(project.current)
        project.current.isDirty = true
      }
      project.current = null

      if (event.contextWindow > 0) {
        project.contextWindow = event.contextWindow
      }

      const facts = [
        event.wasStopped ? 'Stopped' : event.isOk ? 'Done' : 'Ended with an error',
        clock((event.durationMs ?? 0) / 1000),
        typeof event.cost === 'number' ? `$${event.cost.toFixed(3)}` : null,
        event.turns ? `${event.turns} turns` : null,
        event.error ? String(event.error).slice(0, 300) : null,
      ].filter(Boolean)
      project.items.push({ kind: 'note', text: facts.join('  ·  '), isBad: !event.isOk && !event.wasStopped })
      break
    }
    case 'error':
      project.current = null
      project.items.push({ kind: 'note', text: event.message, isBad: true })
      break
    case 'status':
      project.status = event.status
      project.detail = event.detail
      project.agents = event.agents
      project.queue = event.queue
      break
    case 'limit':
      break
    case 'init':
      project.model = event.model
      project.hasSession = true

      if (event.sessionId && !project.chatId) {
        nameChat(project, event.sessionId)
      }
      break
    default:
      break
  }
}

// ---------------------------------------------------------------------- chat

// What a reply may hold once drawn: text formatting, tables, code and plain
// web links. No pictures, frames, forms, styles or scripts, and no link to a
// file or to another program.
const CLEAN = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'style', 'link', 'meta', 'base', 'svg', 'math'],
  FORBID_ATTR: ['style', 'class', 'id', 'srcset', 'background', 'action', 'formaction', 'ping'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  ALLOW_DATA_ATTR: false,
}

// A link in a reply that is not a web address names a file. It is kept as a
// mark the cleaning lets through, and becomes a button for the file viewer.
marked.use({
  walkTokens(token) {
    if (token.type === 'link' && typeof token.href === 'string' && !/^(?:https?:|mailto:|#)/i.test(token.href)) {
      token.href = `#file:${encodeURIComponent(token.href)}`
    }
  },
})
// Words in code type that read as a file's name, with an ending the viewer can show or point to.
const FILE_NAME = /^[\w.\-\\/:~ ()@+]{1,260}\.(?:md|markdown|txt|log|csv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|css|html|htm|py|gd|tscn|tres|cs|java|go|rs|rb|php|c|h|cpp|ps1|bat|cmd|sh|yml|yaml|toml|ini|cfg|xml|svg|pdf|png|jpe?g|gif|webp)(?::\d+(?::\d+)?)?$/i

// ---- Arrange mode: blocks (the logo, the top player, the buttons, the
// spectrum, every panel) dragged between slots (the rows and columns that
// carry data-slot). What sits where is kept under 'places' and put back
// at the start; a theme keeps it too.
const SLOT_KIND = { brand: 'row', transport: 'row', statusbar: 'row', centerTop: 'col', leftBottom: 'col', right: 'col', right2: 'col' }
const isPanel = node => node.classList.contains('panel')
const isBlock = node => node instanceof HTMLElement && (node.dataset.block !== undefined || isPanel(node))
const blockId = node => node.dataset.block ?? `panel:${node.dataset.panel}`
const blockNode = id =>
  String(id).startsWith('panel:') ? document.querySelector(`.cols .panel[data-panel="${CSS.escape(String(id).slice(6))}"]`) : document.querySelector(`[data-block="${CSS.escape(String(id))}"]`)
// A panel is a column thing; the rest can sit in a row or a column.
const fitsSlot = (node, slot) => SLOT_KIND[slot?.dataset.slot] !== undefined && (!isPanel(node) || SLOT_KIND[slot.dataset.slot] === 'col')

/** Marks a block for where it now sits, and keeps the Widgets button last in its column. */
const settleBlock = node => {
  const slot = node.parentElement?.dataset.slot
  node.dataset.home ??= slot ?? ''
  node.classList.toggle('moved', slot !== node.dataset.home)
  node.classList.toggle('in-col', !isPanel(node) && SLOT_KIND[slot] === 'col')
  node.classList.toggle('in-row', !isPanel(node) && SLOT_KIND[slot] === 'row')
  const chooser = document.querySelector('.wg-chooser')

  if (chooser && chooser.parentElement.lastElementChild !== chooser) {
    chooser.parentElement.append(chooser)
  }
}

const savePlaces = () => {
  const places = {}

  for (const slot of document.querySelectorAll('[data-slot]')) {
    places[slot.dataset.slot] = [...slot.children].filter(isBlock).map(blockId)
  }
  localStorage.setItem('places', JSON.stringify(places))
}

/** Puts every block where it was last left. Nothing moves until something has been arranged. */
const putPlaces = () => {
  for (const node of document.querySelectorAll('[data-block], .cols .panel')) {
    node.dataset.home ??= node.parentElement?.dataset.slot ?? ''
  }

  let places = null

  try {
    places = JSON.parse(localStorage.getItem('places') ?? 'null')
  } catch {
    places = null
  }

  if (!places || typeof places !== 'object') {
    return
  }

  for (const [name, ids] of Object.entries(places)) {
    const slot = document.querySelector(`[data-slot="${CSS.escape(name)}"]`)

    for (const id of slot && Array.isArray(ids) ? ids : []) {
      const node = blockNode(id)

      if (node && fitsSlot(node, slot)) {
        slot.append(node)
        settleBlock(node)
      }
    }
  }
}

let isArranging = false
let moving = null
const clearDropMarks = () => {
  for (const one of document.querySelectorAll('.drop-here, .drop-before')) {
    one.classList.remove('drop-here', 'drop-before')
  }
}

/** The block the dragged one would land in front of: the first whose middle is past the pointer. */
const blockAfter = (slot, event) => {
  const isRow = SLOT_KIND[slot.dataset.slot] === 'row'

  return (
    [...slot.children].filter(one => isBlock(one) && one !== moving).find(one => {
      const box = one.getBoundingClientRect()

      return isRow ? event.clientX < box.left + box.width / 2 && event.clientY < box.bottom : event.clientY < box.top + box.height / 2
    }) ?? null
  )
}

const setArranging = isOn => {
  isArranging = isOn
  moving = null
  clearDropMarks()
  document.body.classList.toggle('arranging', isOn)

  for (const node of document.querySelectorAll('[data-block], .cols .panel')) {
    node.draggable = isOn
  }
  document.querySelector('.arrange-bar')?.remove()

  if (isOn) {
    const bar = el('div', 'arrange-bar')
    const reset = el('button', 'pill', 'Put everything back')
    reset.addEventListener('click', () => {
      localStorage.removeItem('places')
      void call('app:reload')
    })
    const done = el('button', 'pill go', 'Done')
    done.addEventListener('click', () => setArranging(false))
    bar.append(el('span', '', 'Arranging: drag the logo, the top player, the buttons, the spectrum or a panel to any outlined area.'), reset, done)
    document.body.append(bar)
  }
}

// While arranging, these take every drag before the panels' own handlers see it.
document.addEventListener(
  'dragstart',
  event => {
    if (!isArranging) {
      return
    }
    event.stopPropagation()
    moving = event.target instanceof Element ? event.target.closest('[data-block], .cols .panel') : null

    if (moving && event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', blockId(moving))
    }
  },
  true,
)
document.addEventListener(
  'dragover',
  event => {
    if (!isArranging || !moving) {
      return
    }
    event.stopPropagation()
    clearDropMarks()
    const slot = event.target instanceof Element ? event.target.closest('[data-slot]') : null

    if (slot && fitsSlot(moving, slot)) {
      event.preventDefault()
      slot.classList.add('drop-here')
      blockAfter(slot, event)?.classList.add('drop-before')
    }
  },
  true,
)
document.addEventListener(
  'drop',
  event => {
    if (!isArranging || !moving) {
      return
    }
    event.stopPropagation()
    event.preventDefault()
    const slot = event.target instanceof Element ? event.target.closest('[data-slot]') : null

    if (slot && fitsSlot(moving, slot)) {
      const next = blockAfter(slot, event)
      next ? slot.insertBefore(moving, next) : slot.append(moving)
      settleBlock(moving)
      savePlaces()
      savePanels()
    }
    clearDropMarks()
    moving = null
  },
  true,
)
document.addEventListener(
  'dragend',
  () => {
    clearDropMarks()
    moving = null
  },
  true,
)

// Where the sections of the window sit: each choice is a class on the page.
const LAYOUT_CHOICES = [
  ['projects', 'Projects column', [['left', 'Left of the chat'], ['right', 'Right of the chat']]],
  ['panels', 'Side panels', [['right', 'Right side'], ['left', 'Left side']]],
  ['status', 'Status bar', [['top', 'Above the chat'], ['bottom', 'At the bottom']]],
  ['eq', 'Top spectrum', [['m', 'Medium'], ['s', 'Small'], ['l', 'Large']]],
]
const layout = (() => {
  try {
    const kept = JSON.parse(localStorage.getItem('layout') ?? '{}')

    return kept && typeof kept === 'object' ? kept : {}
  } catch {
    return {}
  }
})()
// Typefaces for the window's text. The first group comes with Windows; the
// second are free, open-source typefaces, offered when they are installed on
// this computer. Nothing is downloaded and no font file is part of Cla-Amp.
const FONTS_WINDOWS = ['Segoe UI', 'Calibri', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Bahnschrift', 'Georgia', 'Cambria', 'Consolas', 'Courier New']
const FONTS_OPEN = [
  'Cascadia Mono', 'Cascadia Code', 'Inter', 'Roboto', 'Open Sans', 'Noto Sans', 'Source Sans 3', 'IBM Plex Sans', 'Lato', 'Nunito', 'Ubuntu', 'Work Sans',
  'Atkinson Hyperlegible', 'OpenDyslexic', 'Comic Neue', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Source Code Pro', 'Roboto Mono',
]
// A typeface is here when text set in it measures differently from the
// fallback it would otherwise get (tried against two fallbacks, since it could match one by chance).
const fontProbe = document.createElement('canvas').getContext('2d')
const hasFont = name => {
  const wide = family => {
    fontProbe.font = `72px ${family}`

    return fontProbe.measureText('mmwwlliiQ@0123').width
  }

  return ['monospace', 'serif'].some(base => wide(`"${name}", ${base}`) !== wide(base))
}
// The parts of the status bar: each can be shown or hidden (Widgets, Status bar shows).
const STATUS_ITEMS = [
  ['agents', 'Agents running'],
  ['context', 'Context'],
  ['branch', 'Branch'],
  ['model', 'Model'],
  ['effort', 'Effort'],
  ['limits', 'Usage limits'],
  ['date', 'Date'],
  ['time', 'Time'],
  ['state', 'Chat status'],
]
const statusItems = (() => {
  const usual = { agents: true, context: true, branch: true, state: true, model: false, effort: false, limits: false, date: false, time: false }

  try {
    return { ...usual, ...JSON.parse(localStorage.getItem('statusItems') ?? '{}') }
  } catch {
    return usual
  }
})()
const putStatusItems = () => {
  const bar = document.querySelector('.statusbar')
  let isFirst = true

  for (const child of bar.children) {
    if (child.classList.contains('grow')) {
      // The parts pushed to the far end start a group of their own.
      isFirst = true
    }

    if (!child.classList.contains('sb-item')) {
      continue
    }

    const isOn = statusItems[child.dataset.sb] === true
    child.classList.toggle('hidden', !isOn)
    child.classList.toggle('lined', isOn && !isFirst && child.dataset.sb !== 'state')
    isFirst = isFirst && !isOn
  }
  // With every part off, and nothing dragged into it, the bar itself goes.
  bar.classList.toggle('sb-none', !STATUS_ITEMS.some(([id]) => statusItems[id] === true) && bar.querySelector('[data-block]') === null)
}
putStatusItems()

const putLayout = () => {
  // The person's typeface goes in front of the skin's own, which stays as the fallback.
  const font = typeof layout.font === 'string' && [...FONTS_WINDOWS, ...FONTS_OPEN].includes(layout.font) ? layout.font : ''
  font ? document.body.style.setProperty('--font', `'${font}', 'Segoe UI', system-ui, sans-serif`) : document.body.style.removeProperty('--font')
  document.body.classList.toggle('projects-right', layout.projects === 'right')
  document.body.classList.toggle('panels-left', layout.panels === 'left')
  document.body.classList.toggle('status-bottom', layout.status === 'bottom')
  document.body.classList.toggle('eq-s', layout.eq === 's')
  document.body.classList.toggle('eq-l', layout.eq === 'l')
}
putLayout()

// The one class a reply keeps: a code block's language, for the colouring.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'class' && node.nodeName === 'CODE' && /^language-[\w+#.-]{1,30}$/.test(data.attrValue)) {
    data.forceKeepAttr = true
  }
})

/**
 * The picture viewer: a picture from the chat, shown over the whole window
 * and not inside the chat. It starts fitted to the window; a click on it
 * switches to its real size (scroll to move about) and back. Escape, the
 * cross, or a click beside the picture closes it.
 */
const viewPicture = (src, name = '') => {
  document.querySelector('.pic-view')?.remove()
  const box = el('div', 'pic-view')
  const stage = el('div', 'pic-stage')
  const picture = el('img')
  picture.src = src
  picture.alt = name
  picture.title = 'Click for its real size, and again to fit the window'
  const bar = el('div', 'pic-bar')
  const size = el('span', '', name)
  const shut = el('button', 'pill', 'Close')
  shut.type = 'button'
  shut.title = 'Close (Escape)'
  bar.append(size, shut)
  stage.append(picture)
  box.append(bar, stage)
  const close = () => {
    box.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = event => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  }
  picture.addEventListener('load', () => (size.textContent = [name, `${picture.naturalWidth} \u00d7 ${picture.naturalHeight}`].filter(Boolean).join('  \u00b7  ')))
  picture.addEventListener('click', event => {
    event.stopPropagation()
    box.classList.toggle('real')
  })
  stage.addEventListener('click', close)
  shut.addEventListener('click', close)
  document.addEventListener('keydown', onKey, true)
  document.body.append(box)
  shut.focus()
}

/** The folders this chat's tools have worked in, the most used first: where a short name in a reply may belong. */
const workFolders = () => {
  const count = new Map()

  for (const item of active()?.items ?? []) {
    for (const part of item.kind === 'assistant' ? item.parts : []) {
      const file = part.input?.file_path ?? part.input?.notebook_path

      if (typeof file !== 'string' || !/^([a-z]:[\\/]|\/)/i.test(file)) {
        continue
      }

      const bits = file.replace(/\\/g, '/').split('/')

      // The file's own folder and a few above it.
      for (let n = bits.length - 1; n >= 2 && n >= bits.length - 6; n -= 1) {
        const folder = bits.slice(0, n).join('/')
        count.set(folder, (count.get(folder) ?? 0) + 1)
      }
    }
  }

  return [...count].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([folder]) => folder)
}

const NOT_FOUND = 'That file was not found.'
const foundFiles = new Map()

/**
 * Reads a file a reply names. A short name is first looked for in the
 * project's folder; when Claude was working in a folder inside it (or in
 * another one), the name is tried in the folders this chat's tools have
 * used. Gives { name, got }: the name that worked, and what was read.
 */
const findFile = async name => {
  const id = activeId
  const key = `${id}\n${name}`
  const first = await call('file:view', id, foundFiles.get(key) ?? name)

  if (!first || first.error !== NOT_FOUND || /^([a-z]:[\\/]|[\\/]|file:)/i.test(name)) {
    return { name: foundFiles.get(key) ?? name, got: first }
  }

  for (const folder of workFolders()) {
    const full = `${folder}/${name.replace(/^\.[\\/]/, '')}`
    const got = await call('file:view', id, full)

    if (got && got.error !== NOT_FOUND) {
      foundFiles.set(key, full)

      return { name: full, got }
    }
  }

  return { name, got: first }
}

/** Makes a name in a reply open the file viewer when clicked. */
const asFileLink = (node, name) => {
  node.classList.add('file-link')
  node.title = `${name}\nClick to view this file. Right-click to show it in its folder.`
  node.tabIndex = 0
  // Right-click: the things to do with the file, without opening it first.
  node.addEventListener('contextmenu', event => {
    event.stopPropagation()
    const id = activeId
    popMenu(event, [
      ['Show in folder', () => void findFile(name).then(found => (found.got?.error === NOT_FOUND ? alert(NOT_FOUND) : call('file:reveal', id, found.name)))],
      ['View the file', () => void openFile(name)],
      ...(/\.(html?|pdf|svg)$/i.test(name.replace(/[#?].*$/, '')) ? [['Open in browser', () => void findFile(name).then(found => call('file:browser', id, found.name))]] : []),
      ['Copy path', () => void findFile(name).then(found => navigator.clipboard.writeText(found.name))],
    ])
  })
  node.setAttribute('role', 'button')
  node.addEventListener('click', event => {
    event.preventDefault()
    void openFile(name)
  })
  node.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void openFile(name)
    }
  })
}

// The file viewer: one sheet, made when first used.
let fileSheet = null

/**
 * Shows a file named in a reply: Markdown drawn as a page, other text with
 * its colours, a picture as it is. Anything else can be shown in its
 * folder; a page or a PDF can be opened in the browser.
 */
const openFile = async name => {
  const id = activeId
  const got = isDemo ? { name, file: name, kind: 'markdown', text: `# ${name}\n\nThis is the **demo**: a real file would be shown here.\n\n- one\n- two\n`, size: 60 } : (await findFile(name)).got

  if (!got || got.error) {
    alert(got?.error ?? 'That file could not be read.')

    return
  }

  if (fileSheet === null) {
    fileSheet = el('dialog', 'sheet file-sheet')
    document.body.append(fileSheet)
    fileSheet.addEventListener('click', event => {
      if (event.target === fileSheet) {
        fileSheet.close()
      }
    })
  }

  const head = el('div', 'file-head')
  const title = el('div', 'file-title')
  title.append(el('b', '', got.name), el('small', '', got.file))
  const button = (label, tip, run) => {
    const one = el('button', 'pill', label)
    one.type = 'button'
    one.title = tip
    one.addEventListener('click', () => run(one))

    return one
  }
  head.append(
    title,
    button('Copy path', 'Copy where this file is', one => {
      void call('text:copy', got.file)
      one.textContent = 'Copied'
      setTimeout(() => (one.textContent = 'Copy path'), 1200)
    }),
    button('Show in folder', 'Open the folder this file is in', () => void call('file:reveal', id, name)),
  )

  if (got.canBrowse) {
    head.append(button('Open in browser', "Open this page in Cla-Amp's own browser, attached to this window", () => void call('file:browser', id, name)))
  }

  if (got.kind === 'markdown') {
    // A Markdown file can be read as a page or as it is written.
    const flip = button('Show as written', 'Switch between the page and the text as it is written', () => {
      const isRaw = body.classList.toggle('raw')
      flip.textContent = isRaw ? 'Show as a page' : 'Show as written'
      body.replaceChildren(isRaw ? rawText(got.text, 'markdown') : markdown(got.text))
    })
    head.append(flip)
  }
  const close = button('Close', 'Close the viewer', () => fileSheet.close())
  close.classList.add('go')
  head.append(close)
  const rawText = (text, language) => {
    const block = el('pre', 'file-text')
    const code = el('code', '', text)
    block.append(code)

    if (language && hljs.getLanguage(language) && text.length < 400000) {
      code.className = `language-${language}`
      hljs.highlightElement(code)
    }

    return block
  }
  const body = el('div', 'file-body')

  if (got.kind === 'markdown') {
    body.append(markdown(got.text))
  } else if (got.kind === 'text') {
    body.append(rawText(got.text, { mjs: 'javascript', cjs: 'javascript', js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', ps1: 'powershell', yml: 'yaml', htm: 'xml', html: 'xml', svg: 'xml', sh: 'bash', bat: 'dos', cmd: 'dos', gd: 'gdscript' }[got.language] ?? got.language))
  } else if (got.kind === 'picture') {
    const picture = el('img')
    picture.src = got.url
    picture.alt = got.name
    body.append(picture)
  } else {
    body.append(el('p', 'sheet-note', got.note ?? 'This file cannot be shown here.'))
  }

  fileSheet.replaceChildren(head, body)

  if (!fileSheet.open) {
    fileSheet.showModal()
  }
  body.scrollTop = 0
}

const markdown = text => {
  const holder = el('div', 'msg-body')
  holder.innerHTML = DOMPurify.sanitize(marked.parse(String(text ?? ''), { gfm: true, breaks: false }), CLEAN)

  // A link's words can differ from where it leads: the address shows on hover.
  for (const link of holder.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')

    if (href.startsWith('#file:')) {
      let name = href.slice(6)

      try {
        name = decodeURIComponent(name)
      } catch {
        // Kept as written.
      }
      link.removeAttribute('href')
      asFileLink(link, name)
    } else {
      link.title = href
    }
  }

  // A file's name written in code type opens the same way.
  for (const code of holder.querySelectorAll('code')) {
    if (code.parentElement?.nodeName !== 'PRE' && !code.closest('a') && FILE_NAME.test(code.textContent.trim())) {
      asFileLink(code, code.textContent.trim())
    }
  }

  for (const code of holder.querySelectorAll('pre > code')) {
    const language = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) ?? ''

    if (language && hljs.getLanguage(language)) {
      hljs.highlightElement(code)
    }

    const head = el('div', 'code-head')
    head.append(el('span', '', language || 'code'))
    const copy = el('button', '', 'Copy')
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(code.textContent ?? '')
      copy.textContent = 'Copied'
      setTimeout(() => (copy.textContent = 'Copy'), 1200)
    })
    head.append(copy)
    code.parentElement.prepend(head)
  }

  return holder
}

// The demo lets a test draw text and events the way real ones are drawn.
if (isDemo) {
  window.demoMarkdown = markdown
  window.demoEvent = event => {
    apply(active(), { ts: Date.now(), ...event })
    renderChat()
    renderProjects()
  }
}

const toolSummary = (name, input) => {
  const value =
    input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.description ?? input.url ?? input.query ?? ''

  return name === 'Bash' || !input.file_path ? String(value) : baseName(value)
}

/** A tool call in a few words: Claude's own description of it when it gave one. */
const toolSays = part => String(part.input.description || toolSummary(part.name, part.input))

const groupLabel = parts => {
  const count = parts.length
  const isAll = names => parts.every(part => names.includes(part.name))

  if (isAll(['Bash', 'PowerShell'])) {
    return `Ran ${count} commands`
  }

  if (isAll(['Read'])) {
    return `Read ${count} files`
  }

  if (isAll(['Edit', 'Write', 'NotebookEdit'])) {
    return `Made ${count} edits`
  }

  if (isAll(['Grep', 'Glob'])) {
    return `Searched ${count} times`
  }

  return `Used ${count} tools`
}

/** Finished tool calls that sit together fold into one line, as "Ran 5 commands". */
const paintTools = parts => {
  if (parts.length === 1) {
    return paintTool(parts[0])
  }

  const first = parts[0]
  const group = el('details', 'ran own')
  const summary = el('summary', '', groupLabel(parts))
  // A group of file changes starts unfolded, so the changes can be read without a click; other groups start folded.
  group.open = first.isGroupOpen ?? parts.every(part => ['Edit', 'Write', 'NotebookEdit'].includes(part.name))
  summary.addEventListener('click', () => (first.isGroupOpen = !group.open))
  group.append(summary, ...parts.map(paintTool))

  return group
}

/** The pictures tools gave back (a screenshot, an image file that was read), shown under their lines. */
const paintPictures = parts => {
  const all = parts.flatMap(part => (part.pictures ?? []).map(src => ({ src, part })))

  if (all.length === 0) {
    return ''
  }

  const box = el('div', 'tool-pics')

  for (const { src, part } of all) {
    if (!String(src).startsWith('file:')) {
      continue
    }

    const picture = el('img')
    picture.src = src
    picture.loading = 'lazy'
    picture.alt = `Picture from ${part.name}`
    picture.title = `${toolSays(part)}. Click to open it in the picture viewer.`
    box.append(picture)
  }

  return box
}

/** Pinned replies are kept by the start of their text, per project, on this computer. */
const pinKey = text => text.replace(/\s+/g, ' ').trim().slice(0, 160)

const pinsOf = project => {
  try {
    const saved = JSON.parse(localStorage.getItem(`pins:${project?.id}`) ?? '[]')

    return Array.isArray(saved) ? saved.filter(one => typeof one === 'string') : []
  } catch {
    return []
  }
}

const renderPins = () => {
  const project = active()
  const pins = project ? pinsOf(project) : []
  const bar = $('pinBar')
  bar.classList.toggle('hidden', pins.length === 0)
  bar.replaceChildren(
    el('span', 'pin-label', 'Pinned'),
    ...pins.map(key => {
      const button = el('button', 'pin-chip', key.slice(0, 60))
      button.title = 'Go to this reply'
      button.addEventListener('click', () => {
        const item = project.items.find(one => one.kind === 'assistant' && pinKey(replyText(one)) === key)

        if (item?.node) {
          item.node.scrollIntoView({ block: 'start', behavior: 'smooth' })
        } else {
          button.textContent = 'Not in this chat'
        }
      })

      return button
    }),
  )
}

const replyText = item => item.parts.filter(part => part.type === 'text').map(part => part.text).join('\n\n')

/** "Just now", "5 min ago", "3 h ago", else the day. */
const agoOf = ts => {
  const minutes = Math.floor((Date.now() - ts) / 60000)

  return minutes < 1 ? 'Just now'
    : minutes < 60 ? `${minutes} min ago`
    : minutes < 24 * 60 ? `${Math.floor(minutes / 60)} h ago`
    : new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

let speaking = null

/** File names in a reply that look like videos: whole paths, and names in code marks or links. */
const videoNames = item => {
  const kinds = '(?:mp4|webm|mkv|mov|m4v|ogv)'
  const words = item.parts
    .map(part => (part.type === 'text' ? part.text : part.type === 'tool' ? `${part.input?.file_path ?? ''}\n${part.input?.command ?? ''}\n${String(part.result ?? '').slice(0, 4000)}` : ''))
    .join('\n')
  const names = new Set()

  for (const pattern of [
    new RegExp(`[A-Za-z]:[\\\\/][^\\r\\n"'<>|*?\`]*?\\.${kinds}(?![\\w.])`, 'gi'),
    new RegExp(`[\`(]([^\`()\\r\\n"'<>|*?]+?\\.${kinds})[\`)]`, 'gi'),
  ]) {
    for (const match of words.matchAll(pattern)) {
      names.add((match[1] ?? match[0]).trim())
    }
  }

  return [...names].slice(0, 8)
}

/** Opens a video in the floating player. */
const showVideo = one => {
  $('videoEl').src = one.url
  $('videoName').textContent = one.name
  $('videoWin').classList.remove('hidden')
  void $('videoEl').play()
}

/** Play buttons for the videos a finished reply names. The files are looked for once, then the reply is drawn again. */
const paintVideos = item => {
  if (item.videos === undefined) {
    const names = videoNames(item)
    item.videos = []

    if (names.length > 0) {
      void call('video:find', activeId, names).then(found => {
        if (Array.isArray(found) && found.length > 0) {
          item.videos = found
          item.isDirty = true
          renderChat()
        }
      })
    }
  }

  if (item.videos.length === 0) {
    return ''
  }

  const row = el('div', 'video-chips')

  for (const one of item.videos) {
    const button = el('button', 'video-chip', `\u25B6 ${one.name}`)
    button.title = 'Play this video in the floating player'
    button.addEventListener('click', () => showVideo(one))
    row.append(button)
  }

  return row
}

/** The row under a finished reply: copy, fork, pin, read aloud, and when it was posted. */
// The reply buttons' pictures: 16 by 16, drawn in the text's colour.
const ACT_ICONS = {
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  done: '<path d="M3 8.5l3.2 3.2L13 4.8"/>',
  fork: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="11.5" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4.5 5v1.5a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2V5M8 8.5V11"/>',
  pin: '<path d="M9.5 2.5l4 4-2 .6-2.2 2.2.2 2.7-1 1-2.6-2.6L3 13.3 2.7 13l2.9-2.9L3 7.5l1-1 2.7.2 2.2-2.2z"/>',
  quote: '<path d="M3 11.5c1.6-.6 2.5-1.8 2.5-3.5V5H2.5v3.5H4M9.5 11.5c1.6-.6 2.5-1.8 2.5-3.5V5H9v3.5h1.5"/>',
  read: '<path d="M2.5 6.5v3h2.3l3.2 2.7V3.8L4.8 6.5z"/><path d="M10.5 6a3 3 0 0 1 0 4M12.3 4.2a5.5 5.5 0 0 1 0 7.6"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5"/>',
}
const actIcon = (button, name) => {
  button.innerHTML = `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ACT_ICONS[name]}</svg>`
}

const paintActions = item => {
  const text = replyText(item)
  const row = el('div', 'msg-actions')
  const project = active()
  const add = (icon, title, run, isOn = false) => {
    const button = el('button', `act${isOn ? ' on' : ''}`)
    actIcon(button, icon)
    button.title = title
    button.setAttribute('aria-label', title)
    button.addEventListener('click', () => run(button))
    row.append(button)

    return button
  }

  add('copy', 'Copy this reply', button => {
    void call('text:copy', text)
    actIcon(button, 'done')
    button.classList.add('on')
    setTimeout(() => {
      actIcon(button, 'copy')
      button.classList.remove('on')
    }, 1500)
  })

  add('quote', 'Quote: put the text you marked in this reply (or the whole reply) in your message', () => quote(markedInChat() || text))

  if (item.uuid) {
    add('fork', 'Fork: start a new chat that holds this one up to this reply. This chat stays as it is.', async button => {
      button.disabled = true
      const opened = await call('chats:fork', project.id, item.uuid)
      button.disabled = false

      if (!opened?.events) {
        alert(opened?.error ?? 'The fork could not be made.')

        return
      }

      // The fork holds the same messages, so without a word it looks as if nothing happened.
      project.chatId = opened.forkId ?? project.chatId
      showConversation(project, opened.events)
      project.items.push({ kind: 'note', text: 'Forked: this is a new chat that holds the old one up to the reply you chose. The chat you forked from is unchanged and still in the Code tab.' })
      openChatId = opened.forkId ?? openChatId
      renderChat()
      goToEnd()
      void loadChats()
    })
  }

  const key = pinKey(text)
  const isPinned = pinsOf(project).includes(key)
  add(
    'pin',
    isPinned ? 'Unpin: take this reply off the pinned row' : 'Pin: keep this reply one click away, in a row above the chat',
    () => {
      const pins = pinsOf(project).filter(one => one !== key)
      localStorage.setItem(`pins:${project.id}`, JSON.stringify(isPinned ? pins : [...pins, key].slice(-12)))
      item.isDirty = true
      renderChat()
    },
    isPinned,
  )

  const isSpoken = speaking === item
  add(isSpoken ? 'stop' : 'read', isSpoken ? 'Stop reading' : 'Read this reply aloud, with the voice Windows has', () => {
    speechSynthesis.cancel()

    if (isSpoken) {
      speaking = null
    } else {
      // Read as speech: no code blocks, no markup signs.
      const words = text.replace(/```[\s\S]*?```/g, ' (code) ').replace(/[*_#`>|]/g, '').slice(0, 12000)
      const voice = new SpeechSynthesisUtterance(words)
      const done = () => {
        if (speaking === item) {
          speaking = null
          item.isDirty = true
          renderChat()
        }
      }
      voice.addEventListener('end', done)
      voice.addEventListener('error', done)
      speaking = item
      speechSynthesis.speak(voice)
    }
    item.isDirty = true
    renderChat()
  }, isSpoken)

  const when = el('span', 'act-time', agoOf(item.ts))
  when.title = new Date(item.ts).toLocaleString()
  row.append(when)
  row.classList.toggle('pinned', isPinned)

  return row
}

/** The least width the chat keeps: columns stop growing, and the window stops narrowing, at it. */
const CHAT_LEAST = 460

// ---- changes to files, drawn line by line.
const CODE_KIND = { mjs: 'javascript', cjs: 'javascript', js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', ps1: 'powershell', yml: 'yaml', htm: 'xml', html: 'xml', svg: 'xml', sh: 'bash', bat: 'dos', cmd: 'dos', gd: 'gdscript', md: 'markdown', rs: 'rust', cs: 'csharp', rb: 'ruby' }
const codeKindOf = file => {
  const end = String(file ?? '').split('.').pop().toLowerCase()
  const kind = CODE_KIND[end] ?? end

  return hljs.getLanguage(kind) ? kind : ''
}

/** Two texts, line by line: [kind, line] with kind 'ctx' (in both), 'del' (only before) or 'add' (only after). */
const lineDiff = (before, after) => {
  // A last line's own ending is not one more, empty line.
  const linesOf = text => (text === '' ? [] : text.replace(/\r?\n$/, '').split('\n'))
  const a = linesOf(before)
  const b = linesOf(after)

  // Too long to compare line against line: the old text, then the new.
  if (a.length * b.length > 250000) {
    return [...a.map(line => ['del', line]), ...b.map(line => ['add', line])]
  }

  // The longest run of lines the two share, found from the end backwards.
  const most = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      most[i][j] = a[i] === b[j] ? most[i + 1][j + 1] + 1 : Math.max(most[i + 1][j], most[i][j + 1])
    }
  }

  const lines = []
  let i = 0
  let j = 0

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(['ctx', a[i]])
      i += 1
      j += 1
    } else if (j < b.length && (i >= a.length || most[i][j + 1] > most[i + 1][j])) {
      lines.push(['add', b[j]])
      j += 1
    } else {
      lines.push(['del', a[i]])
      i += 1
    }
  }

  return lines
}

/** How many lines a change puts in and takes out. */
const diffCount = (before, after) => {
  const lines = lineDiff(String(before ?? '').slice(0, 60000), String(after ?? '').slice(0, 60000))

  return { plus: lines.filter(one => one[0] === 'add').length, minus: lines.filter(one => one[0] === 'del').length }
}

const diffStat = ({ plus, minus }) => {
  const stat = el('span', 'diff-stat')
  stat.append(el('span', 'plus', `+${plus}`), el('span', 'minus', `\u2212${minus}`))
  stat.title = `${plus} ${plus === 1 ? 'line' : 'lines'} put in, ${minus} taken out`

  return stat
}

/** Wraps the letters from `from` up to `to` of a line in a mark, whatever colour spans they lie in. */
const markPart = (code, from, to) => {
  if (to <= from) {
    return
  }

  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  const texts = []

  while (walker.nextNode()) {
    texts.push(walker.currentNode)
  }

  let at = 0

  for (const text of texts) {
    const end = at + text.data.length
    const start = Math.max(from, at)
    const stop = Math.min(to, end)

    if (stop > start) {
      const part = start > at ? text.splitText(start - at) : text

      if (stop < end) {
        part.splitText(stop - start)
      }

      const mark = document.createElement('mark')
      part.replaceWith(mark)
      mark.append(part)
    }
    at = end
  }
}

/** Where two lines differ: what they share at the start and at the end is left out. */
const changedPart = (before, after) => {
  let head = 0

  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1
  }

  let tail = 0

  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
    tail += 1
  }

  // Lines with too little in common are simply different lines: the whole line's shade says so.
  return head + tail < Math.min(before.length, after.length) * 0.3 ? null : { head, tail }
}

/** A change drawn line by line, the code in its colours. */
const diffView = (before, after, file) => {
  const box = el('div', 'diff')
  const kind = codeKindOf(file)
  const lines = lineDiff(String(before ?? '').slice(0, 60000), String(after ?? '').slice(0, 60000))
  const MOST = 600

  for (const [what, text] of lines.slice(0, MOST)) {
    const row = el('div', `dl ${what}`)
    const code = el('code')

    if (kind && text.length < 2000) {
      // highlight.js returns its own markup with the text escaped.
      code.innerHTML = hljs.highlight(text, { language: kind, ignoreIllegals: true }).value
    } else {
      code.textContent = text
    }
    row.append(el('span', 'dm', what === 'add' ? '+' : what === 'del' ? '\u2212' : ''), code)
    box.append(row)
  }

  // A run of lines taken out followed by as many put in is the same lines rewritten:
  // in each pair, the part that changed gets the stronger shade.
  const rows = [...box.querySelectorAll('.dl')]

  for (let i = 0; i < rows.length; i += 1) {
    if (!rows[i].classList.contains('del') || rows[i - 1]?.classList.contains('del')) {
      continue
    }

    let dels = 0

    while (rows[i + dels]?.classList.contains('del')) {
      dels += 1
    }

    let adds = 0

    while (rows[i + dels + adds]?.classList.contains('add')) {
      adds += 1
    }

    for (let k = 0; dels === adds && k < dels; k += 1) {
      const out = rows[i + k].querySelector('code')
      const put = rows[i + dels + k].querySelector('code')
      const part = changedPart(out.textContent, put.textContent)

      if (part) {
        markPart(out, part.head, out.textContent.length - part.tail)
        markPart(put, part.head, put.textContent.length - part.tail)
      }
    }
  }

  if (lines.length > MOST) {
    box.append(el('div', 'diff-more', `${lines.length - MOST} more lines are not shown here. Click the file's name to see all of it.`))
  }

  return box
}

/** The files a reply changed, each with its count and a click to open it. */
const paintFiles = item => {
  const files = new Map()

  for (const part of item.parts) {
    const input = part.input ?? {}

    if (part.type !== 'tool' || !part.isDone || part.isError || typeof input.file_path !== 'string' || !['Edit', 'Write', 'NotebookEdit'].includes(part.name)) {
      continue
    }

    const count = part.name === 'Edit' ? diffCount(input.old_string, input.new_string) : diffCount('', input.content ?? input.new_source ?? '')
    const kept = files.get(input.file_path) ?? { plus: 0, minus: 0, edits: 0, writes: 0 }
    files.set(input.file_path, { plus: kept.plus + count.plus, minus: kept.minus + count.minus, edits: kept.edits + (part.name === 'Write' ? 0 : 1), writes: kept.writes + (part.name === 'Write' ? 1 : 0) })
  }

  if (files.size === 0) {
    return ''
  }

  const box = el('div', 'files-changed')
  box.append(el('b', '', files.size === 1 ? '1 file changed' : `${files.size} files changed`))

  for (const [file, count] of files) {
    const row = el('div', 'fc-row')
    const name = el('span', '', baseName(file))
    asFileLink(name, file)
    row.append(name, diffStat(count), el('small', '', [count.writes > 0 ? (count.writes > 1 ? `written ${count.writes} times` : 'written') : '', count.edits > 0 ? (count.edits > 1 ? `edited ${count.edits} times` : 'edited') : ''].filter(Boolean).join(', then ')))
    box.append(row)
  }

  return box
}

// ---- "In this chat": what the chat has named, gathered in one panel.
const DOC_END = /\.(md|markdown|txt|pdf|html?|docx?|csv|xlsx?|pptx?)$/i
/** Two names (forward slashes, small letters) for one file: alike, or one is the tail of the other. */
const isSameFile = (a, b) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
const isArtifactLink = url => {
  try {
    const at = new URL(url)

    return (at.hostname === 'claude.ai' && /^\/(public\/)?artifacts?\//.test(at.pathname)) || at.hostname === 'claude.site' || at.hostname.endsWith('.claude.site')
  } catch {
    return false
  }
}
/** What one message names. Kept with the message, and read again only while it is still being written. */
const refsKept = new WeakMap()
const refsOf = (item, isLive) => {
  const size = item.kind === 'assistant' ? item.parts.length : 0
  const kept = refsKept.get(item)

  if (kept && !isLive && kept.size === size) {
    return kept.refs
  }

  const refs = { links: [], docs: [], changed: [], onlyRead: [] }
  const takeText = text => {
    const words = String(text ?? '').slice(0, 200000)
    const named = new Set()

    // Named links first, so a web address keeps the words it was given.
    for (const [, label, target] of words.matchAll(/\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/g)) {
      if (/^https?:\/\//i.test(target)) {
        named.add(target)
        refs.links.push({ url: target, label })
      } else if (!target.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(target.replace(/^[a-z]:[\\/]/i, ''))) {
        // A name written with %20 and the like is read as the file's real name.
        let file = target

        try {
          file = decodeURIComponent(target)
        } catch {
          // Not such a name: taken as written.
        }
        refs.docs.push(file)
      }
    }

    for (const [found] of words.matchAll(/https?:\/\/[^\s<>"'`)\]]{4,2000}/gi)) {
      const url = found.replace(/[.,;:!?]+$/, '')

      if (!named.has(url)) {
        refs.links.push({ url, label: '' })
      }
    }

    // A document named in code marks, such as `docs/plan.md`.
    for (const [, name] of words.matchAll(/`([^`\n]{3,260})`/g)) {
      if (DOC_END.test(name) && FILE_NAME.test(name.trim())) {
        refs.docs.push(name.trim())
      }
    }
  }

  if (item.kind === 'user') {
    takeText(item.text)
  } else if (item.kind === 'assistant') {
    for (const part of item.parts) {
      const input = part.input ?? {}

      if (part.type === 'text') {
        takeText(part.text)
      } else if (part.type === 'tool' && typeof input.file_path === 'string' && !part.isError) {
        if (['Edit', 'Write', 'NotebookEdit'].includes(part.name)) {
          refs.changed.push(input.file_path)
        }

        if (DOC_END.test(input.file_path)) {
          refs.docs.push(input.file_path)

          // A document Claude only looked at is listed in the panel, but gets no card under the reply.
          if (part.name === 'Read') {
            refs.onlyRead.push(input.file_path)
          }
        }
      } else if (part.type === 'tool' && typeof input.url === 'string' && /^https?:\/\//i.test(input.url)) {
        refs.links.push({ url: input.url, label: '' })
      }
    }
  }
  refsKept.set(item, { size, refs })

  return refs
}

const DOC_KIND = { md: 'Markdown', markdown: 'Markdown', txt: 'Text', pdf: 'PDF', html: 'Web page', htm: 'Web page', doc: 'Word document', docx: 'Word document', csv: 'Table', xls: 'Spreadsheet', xlsx: 'Spreadsheet', ppt: 'Slides', pptx: 'Slides' }

/**
 * The cards under a finished reply: one for each artifact it links and each
 * document it wrote or names, with what it is and a click to open it.
 */
const paintCards = item => {
  const refs = refsOf(item, true)
  const cards = []
  const seen = new Set()

  for (const link of refs.links) {
    if (isArtifactLink(link.url) && !seen.has(link.url)) {
      seen.add(link.url)
      let host = 'claude.ai'

      try {
        host = new URL(link.url).hostname
      } catch {
        // Kept as claude.ai.
      }
      cards.push({ mark: '\u2726', kind: 'art', title: link.label || 'Artifact', note: `Artifact \u00b7 ${host}`, open: () => window.open(link.url), tip: link.url })
    }
  }

  for (const file of refs.docs) {
    const key = file.replace(/\\/g, '/').toLowerCase()
    const isOnlyRead = refs.onlyRead.includes(file) && refs.docs.filter(one => one === file).length === 1

    if ([...seen].some(one => isSameFile(one, key)) || isOnlyRead) {
      continue
    }

    seen.add(key)
    const end = (/\.([a-z0-9]+)$/i.exec(file)?.[1] ?? '').toLowerCase()
    const isMade = refs.changed.includes(file)
    cards.push({ mark: end.slice(0, 4).toUpperCase() || 'FILE', kind: 'doc', title: baseName(file), note: `${DOC_KIND[end] ?? 'File'}${isMade ? ' \u00b7 written in this reply' : ''}`, file, tip: file })
  }

  if (cards.length === 0) {
    return ''
  }

  const box = el('div', 'ref-cards')

  for (const card of cards.slice(0, 8)) {
    const one = el('div', `ref-card ${card.kind}`)
    const words = el('div', 'ref-card-words')
    words.append(el('b', '', card.title), el('small', '', card.note))
    one.append(el('span', 'ref-card-mark', card.mark), words)
    one.title = card.tip

    if (card.file) {
      // The same click and right-click as a file's name in a reply.
      asFileLink(one, card.file)
      one.classList.remove('file-link')
    } else {
      one.tabIndex = 0
      one.setAttribute('role', 'button')
      one.addEventListener('click', card.open)
      one.addEventListener('contextmenu', event => popMenu(event, [['Open the artifact', card.open], ['Copy the link', () => void navigator.clipboard.writeText(card.tip)]]))
    }
    box.append(one)
  }

  if (cards.length > 8) {
    box.append(el('div', 'ref-more', `and ${cards.length - 8} more, in the In this chat panel`))
  }

  return box
}

let refsKey = ''
/** Draws the panel: artifacts, documents, files changed and links, the newest first, each once. */
const renderRefs = () => {
  const project = active()
  const items = project?.items ?? []
  const last = items[items.length - 1]
  const key = `${activeId}|${items.length}|${last?.parts?.length ?? 0}|${last?.parts?.[last.parts.length - 1]?.text?.length ?? 0}`

  if (key === refsKey) {
    return
  }

  refsKey = key
  const links = new Map()
  const docs = new Map()
  const changed = new Map()

  // From the newest message back, so each thing sits where it was last named.
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const refs = refsOf(items[at], items[at] === project.current || at === items.length - 1)

    for (const link of refs.links) {
      const had = links.get(link.url)
      links.set(link.url, { label: had?.label || link.label, times: (had?.times ?? 0) + 1 })
    }

    for (const file of refs.docs) {
      const key = file.replace(/\\/g, '/').toLowerCase()

      // The same file named in full and by a shorter path is listed once.
      if (![...docs.keys()].some(one => isSameFile(one, key))) {
        docs.set(key, file)
      }
    }

    for (const file of refs.changed) {
      const had = changed.get(file)
      changed.set(file, (had ?? 0) + 1)
    }
  }

  const box = $('refs')
  const MOST = 25
  const section = (title, rows) => {
    if (rows.length === 0) {
      return
    }

    const head = el('div', 'sub', title)
    head.append(el('span', 'right', String(rows.length)))
    box.append(head, ...rows.slice(0, MOST))

    if (rows.length > MOST) {
      box.append(el('div', 'ref-more', `and ${rows.length - MOST} more, earlier in the chat`))
    }
  }
  const fileRow = (file, note) => {
    const row = el('div', 'ref-row')
    const name = el('span', 'ref-name', baseName(file))
    asFileLink(name, file)
    const where = file.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    row.append(name, el('small', '', note || where))
    row.title = file
    row.addEventListener('click', event => {
      if (event.target !== name) {
        name.click()
      }
    })

    return row
  }
  const linkRow = ([url, { label, times }]) => {
    const row = el('div', 'ref-row')
    let host = ''
    let tail = ''

    try {
      const at = new URL(url)
      host = at.hostname.replace(/^www\./, '')
      tail = decodeURIComponent(at.pathname.split('/').filter(Boolean).join('/'))
    } catch {
      host = url
    }

    const name = el('a', 'ref-name', label || tail || host)
    name.href = url
    row.append(name, el('small', '', times > 1 ? `${host} \u00b7 ${times} times` : host))
    row.title = url
    // Opened in the browser, as a link in a reply is; the main process checks the address again.
    row.addEventListener('click', event => {
      event.preventDefault()
      window.open(url)
    })
    row.addEventListener('contextmenu', event => popMenu(event, [['Open the link', () => window.open(url)], ['Copy the link', () => void navigator.clipboard.writeText(url)]]))

    return row
  }
  box.replaceChildren()
  const all = [...links]
  section('Artifacts', all.filter(([url]) => isArtifactLink(url)).map(linkRow))
  section('Documents', [...docs.values()].map(file => fileRow(file)))
  section('Files changed', [...changed].map(([file, times]) => fileRow(file, times > 1 ? `changed ${times} times` : '')))
  section('Links', all.filter(([url]) => !isArtifactLink(url)).map(linkRow))
  const total = links.size + docs.size + changed.size
  $('refsCount').textContent = total > 0 ? String(total) : ''

  if (total === 0) {
    box.append(el('div', 'empty', project ? 'Documents, files, links and artifacts this chat names will be listed here.' : 'Open a chat to see what it names.'))
  }
}

/**
 * A command and what it printed, drawn as a terminal: a prompt, the command
 * in its colours with a copy button, then the output on a darker ground.
 * Long output shows its first lines with a line to show the rest.
 */
const TERM_FOLD = 14
const paintTerminal = part => {
  const box = el('div', 'term')
  const command = String(part.input.command)
  const kind = part.name === 'PowerShell' ? 'powershell' : 'bash'
  const line = el('div', 'term-cmd')
  const code = el('code')

  if (hljs.getLanguage(kind) && command.length < 8000) {
    // highlight.js returns its own markup with the text escaped.
    code.innerHTML = hljs.highlight(command, { language: kind, ignoreIllegals: true }).value
  } else {
    code.textContent = command
  }

  const copy = el('button', 'term-copy', 'Copy')
  copy.type = 'button'
  copy.title = 'Copy the command'
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(command)
    copy.textContent = 'Copied'
    setTimeout(() => (copy.textContent = 'Copy'), 1200)
  })
  line.append(el('span', 'term-ps', kind === 'powershell' ? 'PS>' : '$'), code, copy)
  box.append(line)

  if (part.result) {
    // Colour codes meant for a real terminal are left out.
    const text = part.result.slice(0, 20000).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, '')
    const lines = text.split('\n')
    const out = el('div', `term-out${part.isError ? ' bad' : ''}`)
    const pre = el('pre')
    const isFolded = lines.length > TERM_FOLD + 4 && part.isOutOpen !== true
    pre.textContent = isFolded ? lines.slice(0, TERM_FOLD).join('\n') : text
    out.append(el('div', 'term-meta', `${part.isError ? 'failed \u00b7 ' : ''}${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`), pre)

    if (isFolded) {
      const more = el('button', 'term-more', `Show all ${lines.length} lines`)
      more.type = 'button'
      more.addEventListener('click', () => {
        part.isOutOpen = true
        pre.textContent = text
        more.remove()
      })
      out.append(more)
    }
    box.append(out)
  }

  return box
}

/** What a tool was asked, as short rows of name and value, in place of raw JSON. */
const paintArgs = input => {
  const box = el('div', 'tool-args')

  for (const [name, value] of Object.entries(input ?? {})) {
    // What the tool is for is already in the card's heading.
    if (name === 'description' || value === undefined || value === null || value === '') {
      continue
    }

    const row = el('div', 'tool-arg')
    const words = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const shown = el('span', '', words.slice(0, 3000))

    if (/(^|_)(file_?path|path|notebook_path)$/i.test(name) && typeof value === 'string') {
      asFileLink(shown, value)
    }
    row.append(el('b', '', name.replace(/_/g, ' ')), shown)
    box.append(row)
  }

  return box.children.length > 0 ? box : ''
}

/** A long block shows its first lines, with a line to show the rest. `fill` draws the given lines into the block. */
const foldLong = (part, holder, lines, fill, most = 24) => {
  const isFolded = lines.length > most + 6 && part.isOutOpen !== true
  fill(isFolded ? lines.slice(0, most) : lines)

  if (isFolded) {
    const more = el('button', 'term-more', `Show all ${lines.length} lines`)
    more.type = 'button'
    more.addEventListener('click', () => {
      part.isOutOpen = true
      fill(lines)
      more.remove()
    })
    holder.append(more)
  }
}

/** What a tool gave back, as plain lines on a quiet ground. */
const paintOutput = part => {
  const box = el('div', `tool-out${part.isError ? ' bad' : ''}`)
  const pre = el('pre')
  const lines = part.result.slice(0, 20000).replace(/\s+$/, '').split('\n')
  box.append(el('div', 'term-meta', `${part.isError ? 'failed \u00b7 ' : ''}${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`), pre)
  foldLong(part, box, lines, shown => (pre.textContent = shown.join('\n')), 14)

  return box
}

/**
 * A file Claude read: its name and which lines, then the lines themselves as
 * code, each with its number in a margin and the code in its colours.
 */
const paintRead = part => {
  const input = part.input
  const box = el('div', 'read-view')
  const head = el('div', 'read-head')
  const name = el('span', '', input.file_path)
  asFileLink(name, input.file_path)
  const from = Number(input.offset) > 0 ? Number(input.offset) : 0
  const range = from > 0 || Number(input.limit) > 0 ? `from line ${from || 1}${Number(input.limit) > 0 ? `, ${input.limit} lines` : ''}` : (input.pages ? `pages ${input.pages}` : 'the whole file')
  head.append(name, el('small', '', range))
  box.append(head)

  if (!part.result) {
    return box
  }

  // The tool numbers each line: "  12<tab>text" (older versions use an arrow).
  const rows = part.result.slice(0, 60000).replace(/\s+$/, '').split('\n').map(line => /^\s*(\d+)(?:\t|\u2192| {1,2})(.*)$/.exec(line))

  if (part.isError || rows.filter(Boolean).length < rows.length * 0.8) {
    box.append(paintOutput(part))

    return box
  }

  const kind = codeKindOf(input.file_path)
  const code = el('div', 'code-view')
  box.append(code)
  foldLong(part, box, rows, shown => {
    code.replaceChildren(
      ...shown.map(row => {
        const line = el('div', 'cl')
        const text = el('code')

        if (kind && row && row[2].length < 2000) {
          // highlight.js returns its own markup with the text escaped.
          text.innerHTML = hljs.highlight(row[2], { language: kind, ignoreIllegals: true }).value
        } else {
          text.textContent = row ? row[2] : ''
        }
        line.append(el('span', 'cn', row ? row[1] : ''), text)

        return line
      }),
    )
  })

  return box
}

const paintTool = part => {
  const box = el('details', `tool own${part.isDone ? (part.isError ? ' failed' : ' done') : ' running'}`)
  const summary = el('summary')
  // A command still running shows what it is doing; once done it folds, unless the person opened it.
  // A change to a file shows itself; so does a command still running. The rest start folded.
  box.open = part.isOpen ?? (['Edit', 'Write'].includes(part.name) || (!part.isDone && typeof part.input.command === 'string'))
  summary.addEventListener('click', () => (part.isOpen = !box.open))
  const input = part.input
  const says = el('span', '', toolSays(part))
  const isEdit = part.name === 'Edit' && typeof input.old_string === 'string'
  const isWrite = part.name === 'Write' && typeof input.content === 'string'
  summary.append(el('b', '', part.name), says)

  // A change to a file: the file's name opens it, and the card says how many lines went in and out.
  if ((isEdit || isWrite) && typeof input.file_path === 'string') {
    asFileLink(says, input.file_path)
    summary.append(diffStat(isEdit ? diffCount(input.old_string, input.new_string) : diffCount('', input.content)))
  }
  summary.append(el('i', '', part.isDone ? (part.isError ? '\u2717' : '\u2713') : '\u2026'))
  box.append(summary)

  if (isEdit) {
    box.append(diffView(input.old_string, input.new_string ?? '', input.file_path))
  } else if (isWrite) {
    box.append(diffView('', input.content, input.file_path))
  } else if (typeof input.command === 'string') {
    box.append(paintTerminal(part))

    return box
  } else if (part.name === 'Read' && typeof input.file_path === 'string') {
    box.append(paintRead(part))

    return box
  } else {
    box.append(paintArgs(input))
  }

  if (part.result) {
    box.append(paintOutput(part))
  }

  return box
}

const decide = (ask, decision, answers) => {
  void call('project:permission', activeId, ask.id, decision, answers)
}

const paintAsk = ask => {
  const box = el('div', `ask${ask.isSettled ? ' settled' : ''}`)

  if (ask.tool === 'AskUserQuestion' && Array.isArray(ask.input?.questions)) {
    const answers = {}

    for (const question of ask.input.questions) {
      box.append(el('h4', '', question.question))
      const row = el('div', 'ask-row')

      for (const option of question.options ?? []) {
        const button = el('button', 'pill', option.label)
        button.title = option.description ?? ''
        button.disabled = Boolean(ask.isSettled)
        button.addEventListener('click', () => {
          answers[question.question] = option.label

          for (const other of row.children) {
            other.classList.toggle('go', other === button)
          }

          if (Object.keys(answers).length === ask.input.questions.length) {
            decide(ask, 'answer', answers)
          }
        })
        row.append(button)
      }
      box.append(row)
    }

    return box
  }

  box.append(el('h4', '', ask.isSettled ? `${ask.tool}: ${ask.isAllowed ? 'allowed' : 'not allowed'}` : `Claude wants to use ${ask.tool}`))
  const input = ask.input ?? {}
  const shown = []
  const show = (text, className = '') => {
    const whole = String(text)
    const pre = el('pre', className, whole.slice(0, 20000))
    shown.push(pre)
    box.append(pre)

    if (whole.length > 20000) {
      box.append(el('div', 'ask-note', `Only the first 20,000 of ${count(whole.length)} characters are shown.`))
    }
  }

  // Everything that would happen is on the card: the whole command, the whole change.
  if (typeof input.command === 'string') {
    show(input.command)
    const { command: _command, description: _description, ...rest } = input

    if (Object.keys(rest).length > 0) {
      show(JSON.stringify(rest, null, 2))
    }
  } else if (typeof input.file_path === 'string' && typeof input.old_string === 'string') {
    show(input.file_path)
    const change = diffView(input.old_string, input.new_string ?? '', input.file_path)
    shown.push(change)
    box.append(change)
  } else if (typeof input.file_path === 'string' && typeof input.content === 'string') {
    show(input.file_path)
    const change = diffView('', input.content, input.file_path)
    shown.push(change)
    box.append(change)
  } else {
    show(JSON.stringify(input, null, 2))
  }

  const always = Array.isArray(ask.always) ? ask.always : []

  if (!ask.isSettled) {
    // Text below the fold is easy to miss: say so, once the card is on screen.
    requestAnimationFrame(() => {
      if (shown.some(pre => pre.scrollHeight > pre.clientHeight + 2) && !box.querySelector('.ask-more')) {
        const more = el('div', 'ask-note ask-more')
        more.append(el('b', '', 'There is more than fits: '), 'scroll the box above to read all of it before you answer.')
        box.querySelector('.ask-row')?.before(more)
      }
    })

    if (always.length > 0) {
      const note = el('div', 'ask-note')
      note.append('Always allow would stop asking for: ', el('b', '', always.join(', ')))
      box.append(note)
    }

    const row = el('div', 'ask-row')

    for (const [label, decision, style] of [
      ['Allow', 'allow', 'go'],
      ...(always.length > 0 ? [['Always allow', 'always', '']] : []),
      ['Deny', 'deny', 'no'],
    ]) {
      const button = el('button', `pill ${style}`, label)
      button.addEventListener('click', () => decide(ask, decision))
      row.append(button)
    }
    box.append(row)
  }

  return box
}

const paint = item => {
  if (item.kind === 'note') {
    return el('div', `note${item.isBad ? ' bad' : ''}`, item.text)
  }

  const row = el('div', 'msg')
  const main = el('div', 'msg-main')
  const isUser = item.kind === 'user'
  row.append(el('div', `avatar${isUser ? '' : ' claude'}`), main)
  const head = el('div', 'msg-head')
  head.append(el('span', 'msg-who', isUser ? 'You' : 'Claude'), el('span', 'msg-time', timeOf(item.ts)))
  main.append(head)

  if (isUser) {
    main.append(el('div', 'msg-body plain', item.text))

    // Pictures attached to the message.
    if ((item.pictures ?? []).length > 0) {
      const box = el('div', 'tool-pics')

      for (const src of item.pictures.filter(one => String(one).startsWith('file:'))) {
        const picture = el('img')
        picture.src = src
        picture.loading = 'lazy'
        picture.alt = 'Attached picture'
        picture.title = 'Click to open it in the picture viewer.'
        box.append(picture)
      }
      main.append(box)
    }
  } else if (item.kind === 'ask') {
    main.append(paintAsk(item))
  } else {
    let done = []
    const flush = () => {
      if (done.length > 0) {
        main.append(paintTools(done), paintPictures(done))
        done = []
      }
    }

    for (const part of item.parts) {
      if (part.type === 'tool' && part.isQuiet) {
        continue
      }

      if (part.type === 'tool' && part.isDone) {
        done.push(part)

        continue
      }
      flush()

      if (part.type === 'tool') {
        main.append(paintTool(part), paintPictures([part]))
      } else if (part.type === 'thinking') {
        // Open while Claude is thinking; afterwards it folds, and stays as the person leaves it.
        const thought = el('details', `thought own${part.isLive ? ' live' : ''}`)
        const label = el('summary', '', part.isLive ? 'Thinking' : 'Thought')
        thought.open = part.isOpen ?? part.isLive === true
        label.addEventListener('click', () => (part.isOpen = !thought.open))
        thought.append(label, el('div', '', part.text))
        main.append(thought)
      } else {
        const body = markdown(part.text)

        if (part.isLive) {
          body.classList.add('cursor')
        }
        main.append(body)
      }
    }
    flush()

    if (item !== active()?.current && !item.parts.some(part => part.isLive || (part.type === 'tool' && !part.isDone))) {
      main.append(paintVideos(item))
    }

    // Once the reply is whole and has words in it. The last reply of a chat
    // read from its file is still the "current" one, but nothing is writing it.
    const isBeingWritten = item === active()?.current && (active()?.status === 'working' || elsewhere(active()) !== undefined)

    // Which files this reply changed, once it is whole.
    if (!isBeingWritten) {
      main.append(paintCards(item), paintFiles(item))
    }

    if (!isBeingWritten && !item.parts.some(part => part.isLive) && replyText(item).trim() !== '') {
      main.append(paintActions(item))
    }
  }

  return row
}

let chatFor = null
// Whether the chat keeps to its end as a reply arrives (set by followChat's listeners below).
let isFollowingChat = true
// Where the chat stood when the program last looked or last moved it, to tell
// the person's own scrolling from the chat's moving by itself.
let chatTop = 0

// Where the person was reading in each chat, kept between runs: the message
// at the top of the view and how far into it. A chat that is followed to its
// end keeps nothing and opens at its end.
const spots = (() => {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem('spots') ?? '{}')))
  } catch {
    return new Map()
  }
})()
let spotTimer = 0

const keepSpot = () => {
  clearTimeout(spotTimer)
  spotTimer = setTimeout(() => {
    const project = active()
    const key = draftKeyOf(project)

    // Only a chat that is fully on show: one still being read from its file says nothing yet.
    if (!key || !project.isLoaded || chatFor !== activeId) {
      return
    }

    spots.delete(key)

    if (!isFollowingChat) {
      const top = $('chat').getBoundingClientRect().top
      const index = project.items.findIndex(item => item.node && item.node.getBoundingClientRect().bottom > top + 1)

      if (index >= 0) {
        spots.set(key, [index, Math.round(top - project.items[index].node.getBoundingClientRect().top)])
      }
    }

    while (spots.size > 80) {
      spots.delete(spots.keys().next().value)
    }
    localStorage.setItem('spots', JSON.stringify(Object.fromEntries(spots)))
  }, 400)
}

/** Puts a chat that was just drawn back where the person was reading. False when there is no such place. */
const backToSpot = project => {
  const spot = project.isLoaded ? spots.get(draftKeyOf(project)) : undefined
  const node = spot ? project.items[spot[0]]?.node : undefined

  if (!node) {
    return false
  }

  const chat = $('chat')
  setFollow(false)
  chat.scrollTop += node.getBoundingClientRect().top - chat.getBoundingClientRect().top + (Number(spot[1]) || 0)

  return true
}

/** Starts or stops keeping to the end. Stopped, a button to go back to the newest message shows. */
const setFollow = isOn => {
  isFollowingChat = isOn
  $('toEnd').classList.toggle('hidden', isOn || !active() || active().items.length === 0)
}

/** Goes to the newest message and keeps to it. */
const goToEnd = () => {
  const chat = $('chat')
  setFollow(true)
  chat.scrollTop = chat.scrollHeight
  chatTop = chat.scrollTop
}

/**
 * The card a new person sees: what Cla-Amp is, then sign in, pick a
 * folder, type. Each step's button presses the window's own button for it,
 * and the sign-in step shows by itself whether it is still to do
 * (body.signed-out, set by checkSignIn).
 */
const startCard = () => {
  const card = el('div', 'start-card')
  const press = (label, id, tip) => {
    const button = el('button', 'pill go', label)
    button.type = 'button'
    button.title = tip
    button.addEventListener('click', () => (typeof id === 'string' ? $(id) : id())?.click())

    return button
  }
  const step = (number, title, text, ...extra) => {
    const row = el('div', 'start-step')
    const body = el('div', 'start-body')
    body.append(el('b', '', title), el('span', '', text), ...extra)
    row.append(el('span', 'start-num', String(number)), body)

    return row
  }
  const signed = el('span', 'start-done when-in', 'You are signed in.')
  const signButton = press('Sign in', 'signInButton', "Opens Claude's own sign-in in your browser")
  signButton.classList.add('when-out')
  const buttons = el('div', 'start-buttons')
  buttons.append(
    press('Add a project folder', 'addProject', 'Pick the folder Claude should work in'),
    press('Show my Claude Code chats', () => document.querySelector('.tab[data-tab="chats"]'), 'Every chat Claude Code saved on this computer, by folder. Click one to carry on with it.'),
  )
  buttons.lastChild.classList.replace('go', 'plain')
  const more = el('div', 'start-more')
  const guide = press('Open the guide', 'guidesBtn', 'How to use Cla-Amp')
  guide.classList.replace('go', 'plain')
  more.append(
    el('span', '', 'Music is on the right: your own files, or YouTube Music and Spotify in your browser. The Claude.ai button opens your regular Claude chats in a browser window beside this one; you sign in there separately, on Claude\'s own page.'),
    guide,
  )
  card.append(
    el('b', 'start-title', 'Welcome to Cla-Amp'),
    el(
      'span',
      'start-what',
      'A music-player-style workspace that runs Claude Code. Claude reads and changes the files in a folder you pick while you chat with it, and your music plays alongside. It uses the same Claude Code and the same saved chats as the Claude desktop app and the terminal.',
    ),
    step(1, 'Sign in to Claude', 'Your browser opens on Claude\'s own sign-in page. Cla-Amp never sees your password. You need your own Claude account.', signButton, signed),
    step(2, 'Pick a folder', 'Claude works inside one folder at a time. Add a new one, or carry on with a chat you already have in Claude Code.', buttons),
    step(3, 'Type a message', 'Use the box at the bottom. Claude asks before it changes a file or runs a command, unless you choose otherwise there.'),
    more,
    el('span', 'start-what', 'Privacy: Cla-Amp has no server and collects nothing. What leaves your computer, and when, is in the Privacy guide (the ? button).'),
  )

  return card
}

const renderChat = () => {
  const chat = $('chat')
  const project = active()

  const isAnew = chatFor !== activeId

  if (isAnew) {
    chatFor = activeId
    // Another chat, or this one read anew: it opens at its end, or where the person left it (see below).
    setFollow(true)
    chat.replaceChildren()

    for (const item of project?.items ?? []) {
      item.node = null
    }
  }

  if (!project) {
    // Nothing open yet: say what this is and how to start.
    if (!chat.querySelector('.start-card')) {
      chat.replaceChildren(startCard())
    }

    return
  }

  if (project.items.length === 0) {
    const welcome = el('div', 'welcome')
    welcome.append(el('b', '', project.name), el('span', '', `Claude Code will work in ${project.cwd}. Type a message to start.`))
    chat.replaceChildren(welcome)

    return
  }

  chat.querySelector('.welcome')?.remove()
  // Following the end is the person's choice (see followChat), not a guess
  // from where the view happens to be: a reply that grows by a screenful at
  // once must not end the following, and a small scroll up must end it.
  const isAtEnd = isFollowingChat
  const keptTop = chat.scrollTop

  for (const item of project.items) {
    if (!item.node) {
      item.node = paint(item)
      item.isDirty = false
      chat.append(item.node)
    } else if (item.isDirty) {
      // Tool cards, groups and thoughts remember their own fold; the rest keep theirs by place.
      const open = [...item.node.querySelectorAll('details:not(.own)')].map(one => one.open)
      const fresh = paint(item)
      fresh.querySelectorAll('details:not(.own)').forEach((one, i) => (one.open = open[i] ?? false))
      // A picture already on show is kept as it is. Drawn anew it would be
      // empty for a moment, and the chat would jump with every word that arrives.
      const loaded = new Map([...item.node.querySelectorAll('img')].filter(one => one.complete && one.naturalWidth > 0).map(one => [one.getAttribute('src'), one]))

      for (const picture of fresh.querySelectorAll('img')) {
        const old = loaded.get(picture.getAttribute('src'))

        if (old && old.className === picture.className) {
          loaded.delete(picture.getAttribute('src'))
          picture.replaceWith(old)
        }
      }
      item.node.replaceWith(fresh)
      item.node = fresh
      item.isDirty = false
    }
  }

  renderTail()
  renderPins()

  if (isAtEnd) {
    chat.scrollTop = chat.scrollHeight
  } else if (chat.scrollTop !== keptTop) {
    // Reading further up: the view stays exactly where it is while the reply grows below.
    chat.scrollTop = keptTop
  }
  // A chat opened again goes back to where the person was reading it.
  if (isAnew) {
    backToSpot(project)
  }

  // What the drawing itself moved is not the person's scrolling.
  chatTop = chat.scrollTop
  setFollow(isFollowingChat)
}

// Whether the chat keeps to its end as a reply arrives. Scrolling up, even a
// little, stops it, and it stays stopped until the person scrolls down to the
// end themselves or presses the button. Being near the end is not enough: a
// slow scroll up is near the end for its first moments.
{
  const chat = $('chat')
  chat.addEventListener('scroll', () => {
    const top = chat.scrollTop
    const left = chat.scrollHeight - top - chat.clientHeight

    if (top < chatTop - 1 && left > 2) {
      setFollow(false)
    } else if (top > chatTop + 1 && left < 24) {
      setFollow(true)
    }
    chatTop = top
    keepSpot()
  })
  // The person's own wheel or keys count at once, before the view has moved far.
  chat.addEventListener('wheel', event => {
    if (event.deltaY >= 0 || chat.scrollHeight <= chat.clientHeight) {
      return
    }

    // The wheel over a box inside the chat that can itself scroll up (a long output, a file) moves that box, not the chat.
    for (let node = event.target; node instanceof Element && node !== chat; node = node.parentElement) {
      if (node.scrollTop > 0) {
        return
      }
    }
    setFollow(false)
  }, { passive: true })
  chat.addEventListener('keydown', event => {
    if (['PageUp', 'ArrowUp', 'Home'].includes(event.key) && chat.scrollHeight > chat.clientHeight) {
      setFollow(false)
    }
  })
  $('toEnd').addEventListener('click', goToEnd)
  // A picture that finishes loading makes the chat taller: stay at the end if that is where the person is.
  chat.addEventListener(
    'load',
    event => {
      if (isFollowingChat && event.target instanceof HTMLImageElement) {
        goToEnd()
      }
    },
    true,
  )
}

/** The work another app (the desktop app, a terminal) is doing in this chat right now, if any. */
const elsewhere = project => (project && project.status !== 'working' ? outside.list.find(one => one.projectId === project.id && one.isWorking) : undefined)

/** A running time the way the desktop app writes it: "42s", "2m 17s", "1h 4m". */
const span = seconds => {
  const whole = Math.max(0, Math.floor(seconds))

  return whole < 60 ? `${whole}s` : whole < 3600 ? `${Math.floor(whole / 60)}m ${whole % 60}s` : `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`
}

/** What Claude is doing this second, and since when. */
const liveNow = project => {
  const away = elsewhere(project)
  const parts = (away ? project.items[project.items.length - 1]?.parts : project.current?.parts) ?? []
  const tool = [...parts].reverse().find(part => part.type === 'tool' && !part.isDone && !part.isQuiet)

  if (tool) {
    return { text: toolSays(tool) || tool.name, since: tool.startedAt }
  }

  // Worked on elsewhere: what that app's own chat file says it is doing.
  if (away) {
    return { text: away.doing || 'Working', since: 0 }
  }

  const isThinking = parts.some(part => part.isLive && part.type === 'thinking')

  return { text: isThinking ? 'Thinking' : project.detail || 'Working', since: project.startedAt }
}

/** Under the last message: Claude's task list, and a line for what it is doing now. */
const renderTail = () => {
  const chat = $('chat')
  const project = active()
  let tail = $('tail')
  const away = elsewhere(project)
  const isWorking = project?.status === 'working' || away !== undefined

  if (!project || project.items.length === 0 || (!isWorking && project.tasks.length === 0)) {
    tail?.remove()

    return
  }

  if (!tail) {
    tail = el('div')
    tail.id = 'tail'
  }
  tail.replaceChildren()

  if (project.tasks.length > 0) {
    const list = el('div', 'tasks')

    for (const task of project.tasks) {
      const row = el('div', `task ${task.status}`)
      row.append(el('i'), el('span', '', task.content))
      list.append(row)
    }

    // Every step done and nothing working: the list folds into one line.
    if (!isWorking && project.tasks.every(task => task.status === 'completed')) {
      const fold = el('details', 'tasks-done own')
      const summary = el('summary', '', `${project.tasks.length} ${project.tasks.length === 1 ? 'step' : 'steps'} done`)
      fold.open = project.isTasksOpen === true
      summary.addEventListener('click', () => (project.isTasksOpen = !fold.open))
      fold.append(summary, list)
      tail.append(fold)
    } else {
      tail.append(list)
    }
  }

  if (isWorking) {
    const now = liveNow(project)
    const line = el('div', 'live-line')
    const dots = el('span', 'dots')
    dots.append(el('b'), el('b'), el('b'))
    const time = el('em', '', now.since ? span((Date.now() - now.since) / 1000) : '')
    time.id = 'liveTime'
    time.dataset.since = String(now.since || '')
    line.append(dots, el('span', '', now.text), time)

    if (away) {
      line.append(el('small', 'live-where', 'in another app'))
      line.title = 'This chat is being worked on outside Cla-Amp (the Claude desktop app or a terminal). Cla-Amp shows it as that app saves it, a few seconds behind.'
    }
    tail.append(line)
  }

  if (chat.lastElementChild !== tail) {
    chat.append(tail)
  }
}

// ---------------------------------------------------------------- left column

// The spectrum shows the music, not Cla-Amp's own sounds. While one of those
// plays and no music is sounding, what the speakers play is left out of it.
// With music on, the music is what shows and the chime is lost in it.
let ownSoundUntil = 0
document.addEventListener('own-sound', event => {
  if (!deck.isSounding) {
    ownSoundUntil = performance.now() + (Number(event.detail) || 2000)
  }
})

// The speaker by each volume slider shows whether that music is muted.
const putMutes = () => {
  for (const mute of document.querySelectorAll('.vol-mute')) {
    const isMuted = Number(mute.parentElement.querySelector('input[type="range"]')?.value) === 0
    mute.classList.toggle('on', isMuted)
    mute.title = isMuted ? 'Muted. Press to bring the sound back.' : 'Mute this music'
    mute.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute')
  }
}
// The bell in the title bar: lit while the chime is on, struck through while muted.
const putChime = () => {
  const isOn = noticeChoice() === 'all'
  $('chimeBtn').classList.toggle('on', isOn)
  $('chimeBtn').classList.toggle('muted', !isOn)
  $('chimeBtn').textContent = isOn ? '\u{1F514}' : '\u{1F515}'
}

// A project whose chat finished, or stopped to ask, while the person was
// looking elsewhere is marked in the list until they open it or come back to it.
const seen = project => {
  if (project?.news) {
    project.news = ''
    renderProjects()
  }
}
const tell = (project, news) => {
  if (project.id !== activeId || !document.hasFocus()) {
    project.news = news
    renderProjects()
  }
}
window.addEventListener('focus', () => seen(projects.get(activeId)))

const renderProjects = () => {
  const list = $('projectList')
  list.replaceChildren()

  if (projects.size === 0) {
    list.append(el('div', 'empty', 'No projects yet. Add a folder below.'))
  }

  for (const project of projects.values()) {
    const row = el('div', `proj${project.id === activeId ? ' active' : ''}${project.news ? ` news ${project.news}` : ''}`)

    if (project.news) {
      row.title = project.news === 'asks' ? 'Claude is waiting for your answer here' : project.news === 'failed' ? 'This chat ended with an error since you last looked' : 'This chat finished since you last looked'
    }
    const text = el('div', 'proj-text')
    text.append(el('div', 'proj-name', project.name), el('div', 'proj-detail', project.detail ?? ''))
    const remove = el('button', 'proj-x', '\u2715')
    remove.title = 'Take this project off the list. Its chats and its folder are kept.'
    remove.addEventListener('click', async event => {
      event.stopPropagation()

      if (confirm(`Take "${project.name}" off Cla-Amp's project list?

Nothing is deleted: its chats stay saved (find them again with Open chat, the Code tab, or the Claude desktop app) and the folder is not touched.`)) {
        await call('project:remove', project.id)
        projects.delete(project.id)
        void select(projects.keys().next().value ?? null)
      }
    })
    row.append(el('div', 'proj-ico'), text, el('span', `badge ${project.status}`, BADGES[project.status] ?? ''), remove)
    row.addEventListener('click', () => void select(project.id))
    asKey(row)
    list.append(row)

    const shown = project.subs.filter(one => !agentsGone.has(one.id))

    for (const sub of shown) {
      const child = asKey(el('div', 'proj sub'))
      const words = el('div', 'proj-text')
      const isOver = sub.status !== 'working'
      const drop = () => {
        agentsGone.add(sub.id)
        keepAgentsGone()
        renderProjects()
      }
      // Only work in the background can be stopped by itself; the rest ends with its turn (Stop).
      const canStop = !isOver && sub.isBackground === true
      const stopIt = async () => {
        if (!(confirm(`Stop "${sub.name}"?\n\nIt ends now and what it was doing is left unfinished. The chat itself carries on.`))) {
          return
        }

        if (isDemo) {
          apply(project, { t: 'agent-bg-done', id: sub.id, isOk: true, ts: Date.now() })
          renderProjects()
        } else if ((await call('task:stop', project.id, sub.id)) !== true) {
          alert('It could not be stopped. It may have just ended by itself.')
        }
      }
      words.append(el('div', 'proj-name', sub.name), el('div', 'proj-detail', sub.kind))
      child.append(el('div', `proj-ico agent${sub.isTask ? ' task' : ''}`), words, el('span', `badge ${sub.status}`, BADGES[sub.status]))
      child.title = sub.isTask
        ? `${sub.name}\n${isOver ? 'This background work has ended.' : 'Running in the background. Closing Cla-Amp would stop it.'}`
        : `${sub.name}\nClick to see what this agent did.`
      child.addEventListener('click', () => (sub.isTask ? void select(project.id) : void openAgent(project, sub)))
      child.addEventListener('contextmenu', event =>
        popMenu(event, [
          sub.isTask ? ['Open its chat', () => void select(project.id)] : ['See what it did', () => void openAgent(project, sub)],
          ...(canStop ? [[sub.isTask ? 'Stop it' : 'Stop this agent', () => void stopIt()]] : []),
          ...(isOver ? [['Take it off the list', drop]] : []),
          ['Clear finished agents', clearAgents],
        ]),
      )

      if (canStop) {
        const stop = el('button', 'proj-x proj-stop', '\u25a0')
        stop.type = 'button'
        stop.title = sub.isTask ? 'Stop this background work' : 'Stop this background agent'
        stop.setAttribute('aria-label', stop.title)
        stop.addEventListener('click', event => {
          event.stopPropagation()
          void stopIt()
        })
        child.append(stop)
      }

      if (isOver) {
        const shut = el('button', 'proj-x', '\u00d7')
        shut.type = 'button'
        shut.title = 'Take this finished agent off the list'
        shut.addEventListener('click', event => {
          event.stopPropagation()
          drop()
        })
        child.append(shut)
      }
      list.append(child)
    }

    if (shown.filter(one => one.status !== 'working').length > 1) {
      const clear = el('button', 'sub-clear', 'Clear finished agents')
      clear.type = 'button'
      clear.title = 'Take every finished agent off the list. What they did stays saved in the chat.'
      clear.addEventListener('click', clearAgents)
      list.append(clear)
    }
  }

  const queue = $('queueList')
  queue.replaceChildren()
  const waiting = active()?.queue ?? []

  if (waiting.length === 0) {
    queue.append(el('div', 'empty', 'Nothing queued. Messages you send while Claude is working wait here.'))
  }
  // Each waiting message, in the Queue tab and above the message box: send it now, or take it out.
  const waitingRow = (text, index) => {
    const row = el('div', 'q-item')
    const now = el('button', 'now', 'Send now')
    now.title = 'Stop what Claude is doing and send this message at once. The other waiting messages follow in their order.'
    now.addEventListener('click', () => void call('queue:now', activeId, index))
    const drop = el('button', '', '\u2715')
    drop.title = 'Take this message out of the queue'
    drop.addEventListener('click', () => void call('queue:remove', activeId, index))
    const words = el('span', '', text)
    words.title = text
    row.append(el('b', '', `${index + 1}.`), words, now, drop)

    return row
  }
  queue.append(...waiting.map(waitingRow))
  $('waitingBar').replaceChildren(...waiting.map(waitingRow))
  $('waitingBar').classList.toggle('hidden', waiting.length === 0)
  // The tab says how many are waiting.
  document.querySelector('.tab[data-tab="queue"]').textContent = waiting.length > 0 ? `Queue (${waiting.length})` : 'Queue'
  $('projectList').classList.toggle('hidden', tab !== 'projects')
  $('queueList').classList.toggle('hidden', tab !== 'queue')
  $('chatList').classList.toggle('hidden', tab !== 'chats')
}

// ------------------------------------------------------------------ all chats

let allChats = null
let openChatId = null
const pins = new Set()
const shut = new Set(JSON.parse(localStorage.getItem('shutGroups') ?? '[]'))
const grown = new Set()
const PINNED = '\u2605 Pinned'

const ago = ts => {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60000))

  if (minutes < 60) {
    return `${minutes}m`
  }

  return minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`
}

/** Shows a saved conversation in a project's chat, in place of what was there. */
// ---- agents: what one did, and tidying the list ----

// Finished agents the person took off the list, by the tool call that started them.
const agentsGone = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem('agentsGone') ?? '[]').filter(one => typeof one === 'string'))
  } catch {
    return new Set()
  }
})()
const keepAgentsGone = () => localStorage.setItem('agentsGone', JSON.stringify([...agentsGone].slice(-600)))

const clearAgents = () => {
  for (const project of projects.values()) {
    for (const sub of project.subs) {
      if (sub.status !== 'working') {
        agentsGone.add(sub.id)
      }
    }
  }
  keepAgentsGone()
  renderProjects()
}

let agentSheet = null
let agentTimer = 0

/**
 * Shows what an agent did, drawn as a chat of its own: the task it was
 * given, its thinking, each tool call and what came back, and its report.
 * While the agent works the page follows it.
 */
const openAgent = async (project, sub) => {
  if (agentSheet === null) {
    agentSheet = el('dialog', 'sheet file-sheet agent-sheet')
    document.body.append(agentSheet)
    agentSheet.addEventListener('click', event => {
      if (event.target === agentSheet) {
        agentSheet.close()
      }
    })
    agentSheet.addEventListener('close', () => clearInterval(agentTimer))
  }

  clearInterval(agentTimer)
  const head = el('div', 'file-head')
  const title = el('div', 'agent-title')
  const state = el('small', '', '')
  title.append(el('b', '', sub.name), state)
  const close = el('button', 'pill go', 'Close')
  close.type = 'button'
  close.addEventListener('click', () => agentSheet.close())
  head.append(title, close)
  const body = el('div', 'agent-body')
  body.tabIndex = 0
  body.append(el('div', 'empty', 'Reading what the agent did...'))
  agentSheet.replaceChildren(head, body)

  if (!agentSheet.open) {
    agentSheet.showModal()
  }

  let drawn = -1
  const fill = async () => {
    const got = isDemo
      ? {
          kind: sub.kind,
          isDone: sub.status !== 'working',
          events: [
            { t: 'user', text: 'Check the contrast of the status badges in both themes and report any that are hard to read.' },
            { t: 'assistant', isMain: true, blocks: [{ type: 'thinking', text: 'Find the badge colours first, then compare each with its background.' }, { type: 'tool_use', id: 'a1', name: 'Grep', input: { pattern: 'badge', path: 'src' } }] },
            { t: 'tool_result', id: 'a1', isMain: true, text: 'src/sidebar.tsx:12: <StatusBadge status={status} />' },
            { t: 'assistant', isMain: true, blocks: [{ type: 'text', text: 'All four badges pass in the dark theme. In the light theme the amber one is hard to read.' }] },
          ],
        }
      : await call('agent:read', project.id, sub.id)

    if (!agentSheet.open || !body.isConnected) {
      return
    }

    if (!got || got.error) {
      body.replaceChildren(el('div', 'empty', got?.error ?? 'What this agent did could not be read.'))

      return
    }

    state.textContent = [got.kind, got.model, got.isDone ? 'finished' : 'working', got.isCut ? 'its last part' : ''].filter(Boolean).join('  \u00b7  ')

    // Nothing new since the last look: the page, and what is folded open in it, stay as they are.
    if (got.events.length === drawn) {
      return
    }

    const isFirst = drawn < 0
    const wasAtEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 60
    drawn = got.events.length
    // A chat of its own, drawn the way the chat is, and kept out of the list of projects.
    const own = { id: project.id, name: sub.name, cwd: project.cwd, items: [], current: null, tools: new Map(), asks: new Map(), subs: [], tasks: [], taskAsks: new Map(), usage: null, lastPrompt: '', startedAt: 0, branch: '', isLoaded: true }

    for (const event of got.events) {
      apply(own, { ts: Date.now(), ...event }, true)
    }

    body.replaceChildren(
      ...(own.items.length > 0 ? own.items : [{ kind: 'note', text: 'The agent has not said or done anything yet.' }]).map(item => {
        const node = paint(item)

        // The first message is the task Claude gave it, not something the person wrote.
        if (item.kind === 'user') {
          node.querySelector('.msg-who')?.replaceChildren('Task')
        }

        return node
      }),
    )

    if (isFirst || wasAtEnd) {
      body.scrollTop = body.scrollHeight
    }
  }
  await fill()

  if (sub.status === 'working' && !isDemo) {
    agentTimer = setInterval(() => void fill(), 3000)
  }
}

const showConversation = (project, events, shouldSelect = true) => {
  Object.assign(project, { items: [], current: null, usage: null, subs: [], tasks: [], hasSession: true, lastPrompt: '', isLoaded: true })
  project.taskAsks.clear()
  project.tools.clear()
  project.asks.clear()

  for (const event of events) {
    apply(project, event, true)
  }

  if (!shouldSelect) {
    return
  }
  chatFor = null
  void select(project.id).then(goToEnd)
}

const openSavedChat = async chat => {
  // The row lights up at once: a long chat's first read can take a few seconds.
  const before = openChatId
  openChatId = chat.id
  document.body.classList.add('opening')

  if (tab === 'chats') {
    renderChats()
  }

  const opened = await call('chats:open', chat.id, chat.cwd, activeId)
  document.body.classList.remove('opening')

  if (!opened || opened.error) {
    openChatId = before

    if (tab === 'chats') {
      renderChats()
    }

    if (opened?.error) {
      alert(opened.error)
    }

    return
  }

  openChatId = chat.id

  // A chat that is already open and working is only gone to; its messages are there.
  if (opened.isOpen && projects.has(opened.project.id)) {
    chatFor = null
    void select(opened.project.id)

    return
  }

  const target = projects.get(opened.project.id) ?? addProject(opened.project)
  target.chatId = chat.id
  showConversation(target, opened.events ?? [])
}

const PR_STATES = { MERGED: 'Merged', OPEN: 'Open', CLOSED: 'Closed' }

/** The list of a chat's pull requests, beside its badge. */
const showPrs = (badge, chat) => {
  $('prCard')?.remove()
  const card = el('div', 'pr-card')
  card.id = 'prCard'
  card.append(el('div', 'pr-head', `${chat.prs.length} pull ${chat.prs.length === 1 ? 'request' : 'requests'} from this chat`))

  for (const pr of chat.prs.slice(0, 14)) {
    const line = el('div', `pr-row ${pr.state.toLowerCase()}`)
    line.append(el('b', '', pr.branch || `#${pr.number}`), el('span', '', `${PR_STATES[pr.state] ?? 'Unknown'}  \u00B7  ${pr.repo} #${pr.number}`))
    card.append(line)
  }

  if (chat.prs.length > 14) {
    card.append(el('div', 'pr-head', `and ${chat.prs.length - 14} more`))
  }
  document.body.append(card)
  const at = badge.getBoundingClientRect()
  card.style.left = `${Math.min(at.right + 8, window.innerWidth - card.offsetWidth - 8)}px`
  card.style.top = `${Math.max(8, Math.min(at.top - 6, window.innerHeight - card.offsetHeight - 8))}px`
}

const renderChats = () => {
  const box = $('chatGroups')
  box.replaceChildren()

  if (allChats === null) {
    box.append(el('div', 'empty', 'Looking for chats...'))

    return
  }

  const words = $('chatSearch').value.trim().toLowerCase()
  const shown = allChats.filter(
    chat => words === '' || chat.title.toLowerCase().includes(words) || chat.cwd.toLowerCase().includes(words),
  )
  // Newest first, so the folder worked in last comes first.
  const groups = new Map()
  const pinned = shown.filter(chat => pins.has(chat.id))

  if (pinned.length > 0) {
    groups.set(PINNED, pinned)
  }

  // As in the desktop app: a chat that another chat started sits under it,
  // in that chat's group; a worktree chat sits with its project. A search
  // shows every match in a flat list.
  const byId = new Map(shown.map(chat => [chat.id, chat]))
  const kids = new Map()
  // The chats working right now: in this app, or in another one (with the step they are on).
  const working = new Map([...outside.here.map(id => [id, 'Working in Cla-Amp']), ...outside.list.map(one => [one.id, one.isWorking ? one.doing || 'Working' : 'Waiting for its agents'])])
  // How many working chats sit under a chat, itself not counted.
  const workingUnder = (chat, depth = 0) => (depth > 8 ? 0 : (kids.get(chat.id) ?? []).reduce((sum, kid) => sum + (working.has(kid.id) ? 1 : 0) + workingUnder(kid, depth + 1), 0))
  const parentOf = chat => (words === '' && chat.parent && chat.parent !== chat.id && byId.has(chat.parent) ? chat.parent : '')

  for (const chat of shown) {
    if (parentOf(chat)) {
      kids.set(chat.parent, [...(kids.get(chat.parent) ?? []), chat])
      continue
    }

    const key = chat.group ?? chat.cwd

    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(chat)
  }
  // A chat whose parent chain never reaches a listed chat (a loop) is not lost: it is shown at the top level.
  const reached = new Set()
  const reach = chat => {
    if (!reached.has(chat.id)) {
      reached.add(chat.id)
      ;(kids.get(chat.id) ?? []).forEach(reach)
    }
  }
  ;[...groups.values()].flat().forEach(reach)

  for (const chat of shown) {
    if (!reached.has(chat.id)) {
      const key = chat.group ?? chat.cwd
      groups.set(key, [...(groups.get(key) ?? []), chat])
      reach(chat)
    }
  }

  if (groups.size === 0) {
    box.append(el('div', 'empty', words === '' ? 'No saved chats found.' : 'No chat matches that.'))
  }

  for (const [key, chats] of groups) {
    const isShut = shut.has(key) && words === ''
    const head = el('div', 'group-head')
    head.title = key
    head.append(el('span', '', isShut ? '\u25B8' : '\u25BE'))

    if (key !== PINNED) {
      head.append(el('div', 'proj-ico'))
    }
    head.append(el('b', '', key === PINNED ? key : baseName(key)))
    const busy = key === PINNED ? 0 : chats.reduce((sum, chat) => sum + (working.has(chat.id) ? 1 : 0) + workingUnder(chat), 0)

    if (busy > 0) {
      const mark = el('em', 'running', `${busy} running`)
      mark.title = `${busy} ${busy === 1 ? 'chat is' : 'chats are'} working in this folder right now`
      head.append(mark)
    }
    head.append(el('i', '', String(chats.length)))
    asKey(head)
    head.addEventListener('click', () => {
      if (!shut.delete(key)) {
        shut.add(key)
      }
      localStorage.setItem('shutGroups', JSON.stringify([...shut]))
      renderChats()
    })
    box.append(head)

    if (isShut) {
      continue
    }

    const most = grown.has(key) || words !== '' ? chats.length : 12

    // Each row with the chats it started under it, once their fold is opened.
    const rows = []
    const add = (chat, depth) => {
      rows.push([chat, depth])

      if (!shut.has(`kids:${chat.id}`) || depth > 6) {
        return
      }

      for (const kid of kids.get(chat.id) ?? []) {
        add(kid, depth + 1)
      }
    }
    chats.slice(0, most).forEach(chat => add(chat, 0))

    for (const [chat, depth] of rows) {
      const row = el('div', `chat-row${chat.id === openChatId ? ' open' : ''}`)
      row.title = `${chat.title}\n${chat.cwd}`
      row.style.paddingLeft = depth > 0 ? `${24 + depth * 14}px` : ''

      // A line down the side of each level the row sits in: the folder's, then one per parent chat.
      for (let level = 0; level <= depth; level += 1) {
        const guide = el('em', 'guide')
        guide.style.left = `${level === 0 ? 13 : 17 + level * 14}px`
        row.append(guide)
      }
      const under = kids.get(chat.id)?.length ?? 0

      if (working.has(chat.id)) {
        row.classList.add('running')
        row.title += `\nWorking now: ${working.get(chat.id)}`
        row.append(el('em', 'dot'))
      }

      if (under > 0) {
        // The set holds the folds that are open: they start closed, as a parent can have dozens.
        const isOpen = shut.has(`kids:${chat.id}`)
        const fold = el('button', 'kids', `${isOpen ? '\u25BE' : '\u25B8'} ${under}`)
        const busyUnder = workingUnder(chat)
        fold.classList.toggle('busy', busyUnder > 0)
        fold.title = `${under} ${under === 1 ? 'chat' : 'chats'} started from this one${busyUnder > 0 ? `, ${busyUnder} working now` : ''}`
        fold.addEventListener('click', event => {
          event.stopPropagation()

          if (!shut.delete(`kids:${chat.id}`)) {
            shut.add(`kids:${chat.id}`)
          }
          localStorage.setItem('shutGroups', JSON.stringify([...shut]))
          renderChats()
        })
        row.append(fold)
      }
      const pin = el('button', pins.has(chat.id) ? 'on' : '', pins.has(chat.id) ? '\u2605' : '\u2606')
      pin.title = pins.has(chat.id) ? 'Unpin' : 'Pin to the top'
      pin.addEventListener('click', event => {
        event.stopPropagation()

        if (!pins.delete(chat.id)) {
          pins.add(chat.id)
        }
        void call('prefs:set', 'pins', [...pins])
        renderChats()
      })
      row.append(el('span', '', chat.title))

      // Its pull requests, as the desktop app has them: a count, and the list while the pointer is on it.
      if (chat.prs?.length > 0) {
        const open = chat.prs.filter(pr => pr.state === 'OPEN').length
        const badge = el('em', `prs${open > 0 ? ' open' : chat.prs.every(pr => pr.state === 'CLOSED') ? ' closed' : ''}`)
        badge.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="4" cy="3.5" r="1.7"/><circle cx="4" cy="12.5" r="1.7"/><circle cx="12" cy="9" r="1.7"/><path d="M4 5.2v5.6M4 7.5c0 1.5 2 1.5 6.3 1.5"/></svg>'
        badge.append(String(chat.prs.length))
        badge.addEventListener('mouseenter', () => showPrs(badge, chat))
        badge.addEventListener('mouseleave', () => $('prCard')?.remove())
        row.append(badge)
      }
      row.append(el('i', '', ago(chat.lastModified)))

      // A chat made in this app can be put away from here.
      if (chat.isOurs) {
        for (const [name, title, label] of [['archive', 'Archive: hide this chat from the lists. It stays saved, and sending a message in it brings it back.', '\u25A4'], ['delete', 'Delete this chat for good (asks first)', '\u2715']]) {
          const button = el('button', 'away', label)
          button.title = title
          button.addEventListener('click', async event => {
            event.stopPropagation()
            const done = await call(`chats:${name}`, chat.id, chat.cwd)

            if (done?.error) {
              alert(done.error)
            } else if (done?.isOk) {
              void loadChats()
            }
          })
          row.append(button)
        }
      }
      row.append(pin)
      row.addEventListener('click', () => void openSavedChat(chat))
      asKey(row)
      box.append(row)
    }

    if (chats.length > most) {
      const more = asKey(el('div', 'more', `Show ${chats.length - most} more`))
      more.addEventListener('click', () => {
        grown.add(key)
        renderChats()
      })
      box.append(more)
    }
  }
}

const loadChats = async () => {
  renderChats()
  allChats = (await call('chats:all')) ?? []
  renderChats()
}

// ------------------------------------------------------- status bar and meters

/**
 * The list under "N agents running": every chat that is working, here and
 * outside this app, with the step it is on and its agents beneath it.
 */
const renderWorkList = () => {
  const box = $('workList')

  if (box.classList.contains('hidden')) {
    return
  }

  const closeList = () => {
    box.classList.add('hidden')
    $('agentsBtn').setAttribute('aria-expanded', 'false')
  }
  const row = (kind, title, where, doing, onOpen) => {
    const line = el(onOpen ? 'button' : 'div', kind)
    line.append(el('i', 'dot'), el('span', 'work-title', title), el('span', 'work-where', where), el('span', 'work-doing', doing))

    if (onOpen) {
      line.title = 'Open this chat here'
      line.addEventListener('click', () => {
        closeList()
        onOpen()
      })
    }

    return line
  }
  const rows = []

  for (const one of projects.values()) {
    if (one.status === 'working' || (one.agents ?? 0) > 0) {
      const load = workLoads[one.id]
      const using = load ? ` · ${load.cpu === null ? '' : `${load.cpu}% CPU, `}${load.mb >= 1024 ? `${(load.mb / 1024).toFixed(1)} GB` : `${load.mb} MB`}` : ''
      const line = row('work-row', one.name, `Cla-Amp${using}`, one.detail || 'Working', () => void select(one.id))

      if (load) {
        line.title = `Open this chat here. Its Claude Code, with its agents and the ${load.count - 1} other ${load.count - 1 === 1 ? 'program' : 'programs'} it started, is using ${load.cpu === null ? '' : `${load.cpu}% of the processor and `}${load.mb} MB of memory.`
      }
      rows.push(line)
      rows.push(...(one.subs ?? []).filter(sub => sub.status === 'working').map(sub => row('work-row work-agent', sub.name, sub.kind, '', null)))
    }
  }

  for (const one of outside.list) {
    const doing = one.isWorking ? one.doing : 'Waiting for its agents'
    rows.push(row('work-row', one.title, one.folder || 'Outside Cla-Amp', doing, one.cwd ? () => void openSavedChat({ id: one.id, cwd: one.cwd }) : null))
    rows.push(...(one.agents ?? []).map(sub => row('work-row work-agent', sub.name, sub.kind, sub.doing, null)))
  }

  box.replaceChildren(el('div', 'work-head', rows.length > 0 ? 'Working now' : 'Nothing is working right now.'), ...rows)
}

// Processor and memory per chat, by project id: asked every five seconds while the list is open.
let workLoads = {}
setInterval(() => {
  if (!isDemo && !$('workList').classList.contains('hidden')) {
    void call('work:load').then(said => {
      workLoads = said ?? {}
      renderWorkList()
    })
  }
}, 5000)

/** Chats and agents working outside this app, as the main process counts them. */
let outside = { chats: 0, agents: 0, list: [], here: [] }

const usedTokens = project =>
  project?.usage ? project.usage.input + project.usage.cacheRead + project.usage.cacheWrite : 0

const setMeter = (node, part) => {
  node.style.setProperty('--fill', `${Math.round(Math.min(1, part) * 100)}%`)
  node.style.setProperty('--meter-color', part > 0.85 ? 'var(--red)' : part > 0.65 ? 'var(--amber)' : 'var(--led)')
}

const renderStatus = () => {
  const project = active()
  let running = 0

  for (const one of projects.values()) {
    running += (one.status === 'working' ? 1 : 0) + (one.agents ?? 0)
  }
  // Chats and agents working in the desktop app or a terminal count too.
  const outsideCount = outside.chats + outside.agents
  $('agentsRunning').textContent = `${running + outsideCount} ${running + outsideCount === 1 ? 'agent' : 'agents'} running`
  renderWorkList()
  // From the last reply; for a chat only read from its file, from Claude Code's own count.
  const used = usedTokens(project) || project?.context?.total || 0
  // The larger of the two: a limit remembered from an older reply can be smaller than the window the chat has now.
  const limit = Math.max(project?.contextWindow || 0, project?.context?.max || 0)
  const part = limit > 0 ? used / limit : 0
  const percent = limit > 0 && used > 0 ? `${Math.round(part * 100)}%` : '--'
  $('contextPct').textContent = percent
  $('tokPct').textContent = percent
  notePeak('contextPeak', part * 100)
  setMeter($('contextMeter'), part)
  setMeter($('tokMeter'), part)
  $('tokHead').textContent = percent === '--' ? 'Nothing used yet' : `${percent} used`
  $('tokUsed').textContent = used > 0 ? kilo(used) : '--'
  $('tokLimit').textContent = limit > 0 ? kilo(limit) : '--'
  $('tokUsed').parentElement.title = limit > 0 ? `${count(used)} of ${count(limit)} tokens, from the last reply` : 'The limit is known after the first reply'
  $('tokLeft').textContent = limit > 0 && used > 0 ? kilo(Math.max(0, limit - used)) : '--'
  $('branch').textContent = project?.branch || '--'
  renderBarExtras()
  renderContext()
  // Compacting needs a chat with something in it that nobody is working in.
  const cannotCompact = !project ? 'No project is open' : project.status === 'working' ? 'Claude is working: wait for it to finish' : elsewhere(project) ? 'This chat is being worked on in another app' : !project.hasSession || project.items.length === 0 ? 'There is no chat to compact yet' : ''
  $('compactBtn').disabled = cannotCompact !== ''
  $('compactBtn').title = cannotCompact || 'Summarize the chat so far to free up context (Claude Code\'s /compact). Claude keeps the gist and loses the word-for-word detail of older messages.'
  // The message box offers Claude Code's guess at the next message, when it made one.
  $('input').placeholder = project?.suggestion ? `${project.suggestion}    (Tab to use)` : 'Message Cla-Amp...'
  $('stateChip').textContent =
    { working: 'Now working', attention: 'Needs you', complete: 'Done', waiting: 'Idle' }[project?.status] ?? 'Idle'
  const mode = MODES.find(one => one.id === (project?.mode ?? 'default')) ?? MODES[0]
  $('mode').querySelector('span').textContent = mode.label
  $('mode').title = mode.hint
  $('stop').classList.toggle('hidden', project?.status !== 'working' && project?.status !== 'attention')

  const next = $('upNext')
  next.replaceChildren()
  let line = 1

  for (const text of project?.queue ?? []) {
    const row = el('div', 'up')
    row.append(el('b', '', `${line}.`), el('span', '', text), el('i', 'waiting', '(Queued)'))
    next.append(row)
    line += 1
  }

  for (const one of projects.values()) {
    if (one.id !== activeId) {
      const row = el('div', 'up')
      const label = BADGES[one.status] ?? ''
      row.append(el('b', '', `${line}.`), el('span', '', one.name), el('i', one.status, `(${label[0]}${label.slice(1).toLowerCase()})`))
      next.append(row)
      line += 1
    }
  }

  if (line === 1) {
    next.append(el('div', 'empty', 'Nothing waiting.'))
  }
}

const renderNow = () => {
  const time = $('liveTime')

  if (time?.dataset.since) {
    time.textContent = span((Date.now() - Number(time.dataset.since)) / 1000)
  }
}

// The colours the canvases draw with, read from the skin's variables.
const theme = { led: '#39d353', amber: '#f5a623', red: '#ef4444', off: '#171c27', text: '#e6ebf5', dim: '#b4bccd' }

// The spectrum is always on show, music or not: it is drawn again at the
// start, when a skin lands and when its canvas changes size.
let isSpectrumStale = true

/** Puts the chosen effects on the window: screen lines, the sliding title, the beat glow. */
const applyEffects = () => {
  document.body.classList.toggle('fx-lines', isEffectOn('lines'))
  document.body.classList.toggle('fx-beat', isEffectOn('beat'))

  if (!isEffectOn('beat')) {
    setBeat(0)
  }

  for (const id of ['trackTitle', 'topTitle']) {
    setSaid($(id), $(id).textContent)
  }
}

// How strongly the bass is hitting, 0 to 1, handed to the three parts that glow with it.
let beatShown = 0

const setBeat = beat => {
  if (Math.abs(beat - beatShown) < 0.04 && beat !== 0) {
    return
  }
  beatShown = beat

  for (const node of [$('spectrum'), $('brandEq')?.parentElement, document.querySelector('.titlebar-name')]) {
    node?.style.setProperty('--beat', beat.toFixed(2))
  }
}

/**
 * Sets a one-line title. With "Scrolling song title" on, a title too long
 * for its place slides to its end and back instead of being cut short.
 */
const setSaid = (node, text) => {
  let line = node.firstElementChild

  if (!line || line.className !== 'mq') {
    line = el('span', 'mq')
    node.replaceChildren(line)
  }

  if (line.textContent !== text) {
    line.textContent = text
  }
  const over = isEffectOn('marquee') ? line.offsetWidth - node.clientWidth : 0
  const isSliding = over > 6

  if (isSliding) {
    node.style.setProperty('--mq-shift', `-${over}px`)
    node.style.setProperty('--mq-time', `${Math.max(5, Math.round(over / 20))}s`)
  }

  if (node.classList.contains('sliding') !== isSliding) {
    node.classList.toggle('sliding', isSliding)
  }
}

/** Three colours from a cover picture, dark to bright, for the "Cover" colour set. */
const takeCoverColours = url => {
  if (!url) {
    setCoverColours(null)
    deck.isRedraw = true

    return
  }
  const picture = new Image()
  picture.addEventListener('load', () => {
    try {
      const board = document.createElement('canvas')
      board.width = 24
      board.height = 24
      const context = board.getContext('2d', { willReadFrequently: true })
      context.drawImage(picture, 0, 0, 24, 24)
      const data = context.getImageData(0, 0, 24, 24).data
      const dots = []

      for (let at = 0; at < data.length; at += 4) {
        const [r, g, b] = [data[at], data[at + 1], data[at + 2]]
        dots.push({ r, g, b, light: (Math.max(r, g, b) + Math.min(r, g, b)) / 510, vivid: Math.max(r, g, b) - Math.min(r, g, b) })
      }
      // The more colourful half of the picture, so grey and black edges do not win.
      const vivid = dots.sort((a, b) => b.vivid - a.vivid).slice(0, dots.length / 2).sort((a, b) => a.light - b.light)
      const third = Math.floor(vivid.length / 3)
      const mean = (list, least) => {
        let [r, g, b] = ['r', 'g', 'b'].map(key => list.reduce((sum, one) => sum + one[key], 0) / list.length)
        // Bright enough to show on a dark panel.
        const lift = least / Math.max(1, Math.max(r, g, b))

        if (lift > 1) {
          ;[r, g, b] = [r, g, b].map(value => Math.min(255, value * lift + 12))
        }

        return '#' + [r, g, b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')
      }
      setCoverColours([mean(vivid.slice(0, third), 120), mean(vivid.slice(third, third * 2), 170), mean(vivid.slice(third * 2), 225)])
    } catch {
      // A picture that may not be read: the skin's colours stand in.
      setCoverColours(null)
    }
    deck.isRedraw = true
  })
  picture.addEventListener('error', () => setCoverColours(null))
  picture.src = url
}

const readTheme = () => {
  isSpectrumStale = true
  const style = getComputedStyle(document.documentElement)
  // A skin can ask for screen lines; the person's own choice in the menu wins.
  setSkinLines(style.getPropertyValue('--screen-lines').trim() === 'on')
  applyEffects()

  for (const [key, name] of [
    ['led', '--led'],
    ['amber', '--amber'],
    ['red', '--red'],
    ['off', '--led-off'],
    ['text', '--text'],
    ['dim', '--dim'],
  ]) {
    theme[key] = style.getPropertyValue(name).trim() || theme[key]
  }
}

const ledColor = part => (part >= 0.8 ? theme.red : part >= 0.6 ? theme.amber : theme.led)

/** LED columns on a canvas: `values` are 0 to 1; `caps` are falling peak marks, if given. */
const drawBars = (canvas, values, { caps, labels, steps = 12, pad = 4 } = {}) => {
  const context = canvas.getContext('2d')
  const { width, height } = canvas
  const foot = labels ? 26 : 2
  const tall = height - foot - pad
  const pitch = (width - pad * 2) / values.length
  const stepTall = tall / steps
  context.clearRect(0, 0, width, height)

  values.forEach((value, i) => {
    const x = pad + i * pitch
    const lit = Math.round(Math.min(1, Math.max(0, value)) * steps)

    for (let step = 0; step < steps; step += 1) {
      context.fillStyle = step < lit ? ledColor(step / steps) : theme.off
      context.fillRect(x, pad + tall - (step + 1) * stepTall + 1, pitch - 2, stepTall - 1.5)
    }

    if (caps && caps[i] > 0.02) {
      context.fillStyle = theme.text
      context.fillRect(x, pad + tall - Math.min(1, caps[i]) * tall, pitch - 2, 2)
    }

    if (labels) {
      context.fillStyle = theme.dim
      context.font = '10px Consolas, monospace'
      context.textAlign = 'center'
      context.fillText(labels[i].name, x + pitch / 2 - 1, height - 14)
      context.fillStyle = theme.text
      context.fillText(labels[i].value, x + pitch / 2 - 1, height - 3)
    }
  })
}


// ----------------------------------- usage limits, model, connectors, plugins

const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const SERVER_WORDS = {
  connected: 'Connected',
  pending: 'Connecting...',
  'needs-auth': 'Needs your approval',
  failed: 'Failed to connect',
  disabled: 'Turned off',
}
const FAST_BLOCKS = {
  free: 'not on this plan',
  preference: 'turned off in settings',
  extra_usage_disabled: 'needs extra usage turned on',
  pending: 'checking...',
  network_error: 'could not reach Claude',
  disabled_by_env: 'turned off on this computer',
  not_first_party: 'not with this sign-in',
  model_not_allowed: 'not for this model',
}
const DEMO_INFO = {
  models: [
    { value: 'default', name: 'Default (recommended)', description: 'Fable 5.2', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], hasFast: true },
    { value: 'opus', name: 'Opus 5.5', description: 'For complex work and everyday tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], hasFast: true },
    { value: 'sonnet', name: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', efforts: ['low', 'medium', 'high'], hasFast: false },
  ],
  model: 'default',
  effort: 'high',
  isFast: false,
  fastState: 'off',
  fastBlock: '',
  usage: {
    isAvailable: true,
    plan: 'max',
    rows: [
      { label: '5-hour session', percent: 41, resetsAt: new Date(Date.now() + 2.4 * 3600000).toISOString() },
      { label: 'Week, all models', percent: 70, resetsAt: new Date(Date.now() + 62 * 3600000).toISOString() },
      { label: 'Week, Fable', percent: 26, resetsAt: new Date(Date.now() + 62 * 3600000).toISOString() },
      { label: 'Extra usage credits', percent: 25, resetsAt: null, money: { used: 1234, limit: 5000, currency: 'USD', isOn: true } },
    ],
  },
  servers: [
    { name: 'godot-ai', status: 'connected', scope: 'user', isClaudeAi: false, tools: 41, error: '' },
    { name: 'claude.ai Google Drive', status: 'needs-auth', scope: 'claudeai', isClaudeAi: true, tools: 0, error: '' },
    { name: 'claude.ai ElevenLabs', status: 'disabled', scope: 'claudeai', isClaudeAi: true, tools: 0, error: '' },
  ],
}
const DEMO_PLUGINS = [
  { id: 'art@gamedev', name: 'art', from: 'gamedev', version: '1.1.0', scope: 'user', isOn: true },
  { id: 'audio@gamedev', name: 'audio', from: 'gamedev', version: '1.1.0', scope: 'user', isOn: true },
  { id: 'devops@gamedev', name: 'devops', from: 'gamedev', version: '1.2.0', scope: 'user', isOn: false },
]

const engine = { forId: null, info: null, error: '', isLoading: false, plugins: null, pluginError: '', said: '' }
let pendingTimer = 0
let pendingTries = 0

/** When a limit starts over, in the words a person would use. */
const startsOver = iso => {
  const at = Date.parse(iso ?? '')

  if (Number.isNaN(at)) {
    return ''
  }

  const minutes = Math.round((at - Date.now()) / 60000)

  if (minutes <= 0) {
    return 'Starts over now'
  }

  if (minutes < 60) {
    return `Starts over in ${minutes} min`
  }

  if (minutes < 24 * 60) {
    return `Starts over in ${Math.floor(minutes / 60)} h ${minutes % 60} min`
  }

  return `Starts over ${new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
}

/**
 * A model's name as people say it, from the id a reply names:
 * "claude-fable-5-2" is "Fable 5.2", "claude-sonnet-4-5-20250929" is "Sonnet 4.5".
 */
const modelName = id => {
  const parts = String(id ?? '')
    .replace(/^claude-/, '')
    .replace(/\[.*\]$/, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .filter(Boolean)
  const family = parts.filter(part => /^[a-z]+$/i.test(part)).map(part => part[0].toUpperCase() + part.slice(1))
  const version = parts.filter(part => /^\d+$/.test(part))

  return family.length > 0 ? `${family.join(' ')}${version.length > 0 ? ` ${version.join('.')}` : ''}${/\[1m\]$/i.test(String(id)) ? ' (1M)' : ''}` : String(id ?? '')
}

/** A ring that is full when nothing is used and empties as the limit is used up. */
// The ring fills as the plan is used, and its number is the share used: the same figure Claude's own apps show.
const usageRing = used => {
  const left = used
  const ring = el('div', `ring${used > 90 ? ' low' : used > 75 ? ' mid' : ''}`)
  const round = 2 * Math.PI * 16
  ring.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle class="ring-back" cx="20" cy="20" r="16"/><circle class="ring-fill" cx="20" cy="20" r="16" stroke-dasharray="${((round * left) / 100).toFixed(1)} ${round.toFixed(1)}" transform="rotate(-90 20 20)"/></svg>`
  ring.append(el('b', '', `${Math.round(left)}%`))

  return ring
}

/** The status bar's optional parts: the chat's model, the plan's limits, the date and the time. */
const renderBarExtras = () => {
  const project = active()
  const info = engine.info
  const picked = info?.models.find(one => one.value === info.model)
  // The exact model the chat last ran on when a reply has named it, else the one picked for it.
  $('sbModel').textContent = /^claude-/.test(project?.model ?? '') ? modelName(project.model) : picked ? (picked.value === 'default' ? 'Default' : picked.name) : '--'
  $('sbEffort').textContent = !info ? '--' : info.effort ? (EFFORT_NAMES[info.effort] ?? info.effort) : 'Auto'
  const usage = info?.usage
  const rows = usage?.isAvailable ? usage.rows.filter(row => row.percent !== null) : []
  const short = label => (/week/i.test(label) ? (/opus|sonnet|haiku|fable/i.exec(label)?.[0] ?? 'Week') : /session|hour|5/i.test(label) ? 'Session' : label)
  $('sbLimits').textContent = rows.length > 0 ? rows.slice(0, 3).map(row => `${short(row.label)} ${Math.round(row.percent)}%`).join('  \u00b7  ') : 'Limits: --'
  $('sbLimits').title = rows.length > 0 ? rows.map(row => (row.money && creditWords(row.money) ? `${row.label}: ${creditWords(row.money)}` : `${row.label}: ${Math.round(row.percent)}% used. ${startsOver(row.resetsAt)}`)).join('\n') : 'Your plan\'s limits show here once they have been read'
  const now = new Date()
  $('sbDate').textContent = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  $('sbTime').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// ---- how the plan's limits are going ----

const dayAndTime = at => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * Where a limit stands and where it is heading: what is left, and whether
 * the pace so far reaches the limit before it starts over. The pace is the
 * share used spread over the part of the window that has gone by; too early
 * in a window (its first twentieth) nothing is said about pace.
 * Gives { state: 'reached' | 'ahead' | 'fine' | 'plain', words, short }.
 */
const paceOf = row => {
  if (row.money || typeof row.percent !== 'number') {
    return null
  }

  const used = Math.min(100, Math.max(0, row.percent))
  const left = Math.round(100 - used)
  const isSession = /session|hour/i.test(row.label)
  const model = /week,\s*(.+)$/i.exec(row.label)?.[1]
  const name = isSession ? '5-hour session' : model && !/all models/i.test(model) ? `weekly ${model}` : 'weekly'
  const resets = Date.parse(row.resetsAt ?? '')
  const when = Number.isNaN(resets) ? '' : dayAndTime(resets)

  if (used >= 100) {
    return { state: 'reached', short: when ? `Reached. Starts over ${when}` : 'Reached', words: `You have reached your ${name} limit.${when ? ` It starts over ${when}.` : ''}` }
  }

  const head = `You have ${left}% of your ${name} limit left.`
  const long = (isSession ? 5 : 7 * 24) * 3600000
  const gone = long - (resets - Date.now())

  if (Number.isNaN(resets) || gone < long / 20 || gone > long || used <= 0) {
    return { state: 'plain', short: '', words: when ? `${head} It starts over ${when}.` : head }
  }

  // At the pace so far, when the rest would be used up.
  const reach = Date.now() + ((100 - used) / used) * gone

  return reach < resets
    ? { state: 'ahead', short: `At this pace: reached ${dayAndTime(reach)}`, words: `${head} At this pace you would reach it around ${dayAndTime(reach)}, before it starts over ${when}.` }
    : { state: 'fine', short: 'On track to stay within it', words: `${head} At this pace you are on track to stay within it until it starts over ${when}.` }
}

// The reminder above the message box: shown when a limit is reached, is
// heading to be reached before it starts over, or has a quarter or less
// left. Closed with its cross, it stays away until that limit starts over
// or gets worse.
const renderUsageNote = () => {
  const box = $('usageNote')
  const usage = engine.info?.usage
  const rank = { reached: 0, ahead: 1, plain: 2, fine: 2 }
  const found = (usage?.isAvailable ? usage.rows : [])
    .map(row => ({ row, pace: paceOf(row) }))
    .filter(one => one.pace && (one.pace.state === 'reached' || one.pace.state === 'ahead' || one.row.percent >= 75))
    .sort((a, b) => rank[a.pace.state] - rank[b.pace.state] || b.row.percent - a.row.percent)[0]
  const key = found ? `${found.row.label}|${found.pace.state}|${found.row.resetsAt ?? ''}` : ''

  if (!found || localStorage.getItem('usageNoteShut') === key) {
    box.classList.add('hidden')
    box.dataset.key = ''

    return
  }

  if (box.dataset.key === key && box.dataset.words === found.pace.words) {
    return
  }
  box.dataset.key = key
  box.dataset.words = found.pace.words
  box.className = `usage-note ${found.pace.state}`
  const shut = el('button', 'usage-note-x', '\u2715')
  shut.type = 'button'
  shut.title = 'Close this reminder. It comes back when the limit starts over or gets closer.'
  shut.setAttribute('aria-label', 'Close this reminder')
  shut.addEventListener('click', () => {
    localStorage.setItem('usageNoteShut', key)
    renderUsageNote()
  })
  box.replaceChildren(el('span', '', found.pace.words), shut)
}

/** An amount in a currency's small unit (cents) as money: 1234, 'USD' reads $12.34. */
const asMoney = (small, currency) => {
  try {
    const shape = new Intl.NumberFormat(undefined, { style: 'currency', currency })

    return shape.format(small / 10 ** (shape.resolvedOptions().maximumFractionDigits ?? 2))
  } catch {
    return `${(small / 100).toFixed(2)} ${currency}`
  }
}

/** The credits of extra usage in words: what is spent, the month's limit, and what is left. */
const creditWords = money => {
  if (!money) {
    return ''
  }

  const { used, limit, currency } = money

  if (used !== null && limit !== null) {
    return `${asMoney(Math.max(0, limit - used), currency)} left: ${asMoney(used, currency)} of ${asMoney(limit, currency)} spent this month`
  }

  if (used !== null) {
    return `${asMoney(used, currency)} spent this month, no monthly limit set`
  }

  return limit !== null ? `Monthly limit ${asMoney(limit, currency)}` : ''
}

const renderLimits = () => {
  renderBarExtras()
  renderUsageNote()
  const box = $('limits')
  const usage = engine.info?.usage
  box.replaceChildren()
  $('planName').textContent = usage?.plan ? String(usage.plan).toUpperCase() : ''

  if (!active()) {
    box.append(el('div', 'empty', 'Add a project to see your plan\'s limits.'))
  } else if (!engine.info) {
    box.append(el('div', engine.error ? 'hint bad' : 'empty', engine.error || 'Reading your limits...'))
  } else if (!usage.isAvailable) {
    box.append(el('div', 'empty', 'This sign-in has no plan limits to show (an API key or another provider).'))
  } else {
    for (const row of usage.rows) {
      // The ring and its number say what is used; the line under the name adds what is left.
      const used = Math.min(100, Math.max(0, row.percent ?? 0))

      // The week's limit for all models, for the calendar's report of the day.
      if (row === usage.rows.find(each => /week/i.test(each.label))) {
        notePeak('planUsed', used)
      }

      const one = el('div', 'limit')
      const words = el('div', 'limit-words')
      words.append(
        el('span', 'limit-name', row.label),
        el('small', '', row.money && creditWords(row.money) ? creditWords(row.money) : row.percent === null ? 'Nothing used in this window yet' : `${Math.round(used)}% used, ${Math.round(100 - used)}% left`),
        el('small', '', row.money ? (row.money.isOn ? 'Used once the plan\'s own limits are reached' : 'Switched off: nothing is charged to it') : row.percent === null ? '' : startsOver(row.resetsAt)),
      )
      const pace = paceOf(row)

      if (pace?.short) {
        words.append(el('small', `limit-pace ${pace.state}`, pace.short))
      }
      one.title = row.money
        ? `${row.label}: ${creditWords(row.money) || 'no amount reported'}. Credits bought on top of your plan; change them in your Claude account's settings.`
        : row.percent === null ? `${row.label}: nothing used yet` : (pace?.words ?? `${row.label}: ${Math.round(used)}% used, ${Math.round(100 - used)}% left. ${startsOver(row.resetsAt)}`)
      one.append(usageRing(used), words)
      box.append(one)
    }
  }
}

const renderEngine = () => {
  const info = engine.info
  const project = active()
  const select = $('model')
  const levels = $('effort')
  const chosen = info?.models.find(one => one.value === info.model) ?? info?.models[0]
  select.replaceChildren()
  levels.replaceChildren()
  select.disabled = !info
  // The exact model the chat last ran on, once a reply has named it.
  $('modelNow').textContent = /^claude-/.test(project?.model ?? '') ? modelName(project.model) : ''
  $('modelNow').title = /^claude-/.test(project?.model ?? '') ? `The model this chat last ran on (${project.model})` : ''
  renderBarExtras()

  for (const one of info?.models ?? []) {
    const option = el('option', '', one.value === 'default' ? `Default (${one.description})` : one.name)
    option.value = one.value
    select.append(option)
  }

  if (info && !chosen) {
    return
  }

  if (!info) {
    select.append(el('option', '', engine.error ? 'Not available' : 'Reading the models...'))
    $('modelHint').textContent = ''
  } else {
    select.value = chosen.value
    $('modelHint').textContent = chosen.value === 'default' ? 'The model your plan recommends.' : chosen.description
  }

  const efforts = chosen?.efforts ?? []

  for (const level of [null, ...efforts]) {
    const button = el('button', 'lvl', level === null ? 'Auto' : EFFORT_NAMES[level])
    button.classList.toggle('active', (info?.effort ?? null) === level)
    button.title = level === null ? 'Let the model and your settings decide' : `Think at ${EFFORT_NAMES[level].toLowerCase()} effort`
    button.addEventListener('click', () => void setEngine('effort', level))
    levels.append(button)
  }

  if (info && efforts.length === 0) {
    levels.append(el('div', 'hint', 'This model has no effort levels.'))
  }

  const hasFast = chosen?.hasFast === true && !info.fastBlock
  $('fast').checked = hasFast && info.isFast === true
  $('fast').disabled = !hasFast
  $('fastWrap').classList.toggle('off', !hasFast)
  $('fastHint').textContent = !info
    ? ''
    : !chosen.hasFast
      ? 'not for this model'
      : info.fastBlock
        ? (FAST_BLOCKS[info.fastBlock] ?? 'not available now')
        : info.fastState === 'cooldown'
          ? 'cooling down'
          : ''
  $('engineError').textContent = engine.said
  $('engineError').classList.toggle('hidden', engine.said === '')
}

const renderLinks = () => {
  const box = $('servers')
  const servers = engine.info?.servers
  box.replaceChildren()

  if (!active()) {
    box.append(el('div', 'empty', 'Add a project to see its connectors.'))
  } else if (!servers) {
    box.append(el('div', engine.error ? 'hint bad' : 'empty', engine.error || 'Reading the connectors...'))
  } else if (servers.length === 0) {
    box.append(el('div', 'empty', 'No connectors are set up for this project.'))
  }

  for (const server of servers ?? []) {
    const row = el('div', 'link-row')
    const name = el('div', 'link-name')
    const tools = server.status === 'connected' ? `, ${server.tools} ${server.tools === 1 ? 'tool' : 'tools'}` : ''
    name.append(
      el('b', '', server.name.replace(/^claude\.ai /, '')),
      el('small', '', `${SERVER_WORDS[server.status] ?? server.status}${tools}${server.isClaudeAi ? ' \u00b7 Claude account' : ''}`),
    )
    name.title = server.error || server.name
    row.append(el('i', `link-dot ${server.status}`), name)
    const act = (label, className, title, run) => {
      const button = el('button', `tiny ${className}`, label)
      button.title = title
      button.addEventListener('click', async () => {
        button.disabled = true
        const done = await run()
        engine.said = done?.error ?? ''
        renderEngine()
        await loadServers()
      })
      row.append(button)
    }

    if (server.status === 'needs-auth') {
      act(
        'Approve',
        'go',
        server.isClaudeAi
          ? 'Opens the connectors page of your Claude account in your browser. Press Refresh here when you are done.'
          : 'Opens Claude Code in a console window on its connectors screen. Press Refresh here when you are done.',
        () => call('mcp:authorize', activeId, server.isClaudeAi),
      )
    } else if (server.status === 'failed') {
      act('Retry', '', 'Try to connect again', () => call('mcp:reconnect', activeId, server.name))
    }

    if (server.status === 'disabled') {
      act('Turn on', '', 'Let Claude use this connector in this chat', () => call('mcp:toggle', activeId, server.name, true))
    } else {
      act('Turn off', '', 'Keep Claude from using this connector in this chat', () => call('mcp:toggle', activeId, server.name, false))
    }
    box.append(row)
  }

  const list = $('plugins')
  const plugins = engine.plugins
  const words = $('pluginSearch').value.trim().toLowerCase()
  list.replaceChildren()
  $('pluginCount').textContent = plugins ? `${plugins.filter(one => one.isOn).length} of ${plugins.length} on` : ''

  if (!plugins) {
    list.append(el('div', engine.pluginError ? 'hint bad' : 'empty', engine.pluginError || 'Reading the plugins...'))

    return
  }

  const shown = plugins.filter(one => words === '' || `${one.name} ${one.from}`.toLowerCase().includes(words))

  if (shown.length === 0) {
    list.append(el('div', 'empty', plugins.length === 0 ? 'No plugins are installed.' : 'No plugin matches.'))
  }

  for (const plugin of shown) {
    const row = el('label', 'plug')
    const box2 = el('input')
    box2.type = 'checkbox'
    box2.checked = plugin.isOn
    row.title = `${plugin.id} ${plugin.version}`.trim()
    box2.addEventListener('change', async () => {
      box2.disabled = true
      const isOn = box2.checked
      const done = isDemo ? { isOk: true } : await call('plugins:toggle', plugin.id, isOn)

      if (done?.error) {
        engine.pluginError = done.error
      } else {
        plugin.isOn = isOn
        engine.pluginError = ''
      }
      engine.said = done?.error ?? ''
      renderEngine()
      renderLinks()
    })
    row.append(box2, el('span', '', plugin.name), el('small', '', plugin.from))
    list.append(row)
  }
}

const renderEngineAll = () => {
  renderLimits()
  renderEngine()
  renderLinks()
}

/** Connectors still coming up are read again until they settle. */
const watchPending = () => {
  clearTimeout(pendingTimer)

  if (pendingTries < 15 && engine.info?.servers.some(one => one.status === 'pending')) {
    pendingTries += 1
    pendingTimer = setTimeout(() => void loadServers(), 2500)
  }
}

const loadServers = async () => {
  const id = activeId

  if (isDemo || !id || !engine.info) {
    return
  }

  const got = await call('session:servers', id)

  if (activeId === id && engine.info && got?.servers) {
    engine.info.servers = got.servers
    renderLinks()
    watchPending()
  }
}

const CTX_COLOURS = ['#4f8ff7', '#e8743b', '#19a979', '#d9a400', '#9aa5b8', '#8b7fd6', '#c56fb0', '#5fb3c9']
const kilo = tokens => (tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 100000 ? 0 : 1).replace(/\.0$/, '')}k` : String(tokens))

/** What fills the context, row by row, and where the chat works: the lower half of the Context panel. */
const renderContext = () => {
  const project = active()
  const box = $('ctxRows')
  const env = $('envRows')
  const context = project?.context
  box.replaceChildren()
  env.replaceChildren()

  if (project) {
    const line = (label, value, title = '') => {
      const row = el('div', 'kv env')
      row.append(el('span', '', label), el('b', '', value))
      row.title = title || value
      env.append(row)
    }
    line('Computer', 'This computer')
    line('Folder', project.name, project.cwd)
    line('Branch', project.branch || 'not a git folder')
  }

  $('tokMeter').classList.remove('hidden')
  $('tokLeft').parentElement.classList.remove('hidden')

  if (!context || context.max <= 0) {
    return
  }

  $('tokMeter').classList.add('hidden')
  $('tokLeft').parentElement.classList.add('hidden')
  const used = context.rows.filter(one => one.kind === 'used')
  const bar = el('div', 'ctx-bar')
  box.append(el('div', 'sub', 'What fills it'), bar)
  const row = (name, tokens, share, colour, title) => {
    const one = el('div', 'ctx-row')
    const dot = el('i')
    dot.style.background = colour
    one.append(dot, el('span', '', name), el('em', '', kilo(tokens)), el('b', '', share))
    one.title = title
    box.append(one)
  }
  const share = tokens => `${((tokens / context.max) * 100).toFixed(1)}%`

  used.forEach((one, index) => {
    const colour = CTX_COLOURS[index % CTX_COLOURS.length]
    const part = el('i')
    part.style.cssText = `width: ${Math.max(0.6, (one.tokens / context.max) * 100)}%; background: ${colour}`
    bar.append(part)
    row(one.name, one.tokens, share(one.tokens), colour, `${one.name}: ${count(one.tokens)} tokens`)
  })

  for (const one of context.rows.filter(one => one.kind === 'buffer' || one.kind === 'free')) {
    row(one.name, one.tokens, share(one.tokens), one.kind === 'free' ? 'transparent' : '#5b6474', `${one.name}: ${count(one.tokens)} tokens`)
  }

  for (const one of context.rows.filter(one => one.kind === 'deferred')) {
    row(one.name, one.tokens, '--', '#5b6474', `${one.name}: ${count(one.tokens)} tokens, loaded only when needed, so not in the context now`)
  }

  const counts = [
    ['MCP tools', context.counts.tools],
    ['Skills', context.counts.skills],
    ['Memory files', context.counts.memory],
    ['Custom agents', context.counts.agents],
  ].filter(([, value]) => value > 0)

  if (counts.length > 0) {
    box.append(el('div', 'ctx-counts', counts.map(([name, value]) => `${name} ${value}`).join('  \u00b7  ')))
  }

  const free = context.rows.find(one => one.kind === 'free')
  box.append(
    el(
      'small',
      'ctx-note',
      `${free ? `${kilo(free.tokens)} free before it compacts itself. ` : ''}Counted by Claude Code: ${kilo(context.total)} of ${kilo(context.max)}. Read when the chat is opened and after each reply.`,
    ),
  )
}

// The "/" list of the message box: Claude Code's commands and skills for the open project.
const slash = { all: [], shown: [], at: 0, forId: '' }

const loadCommands = async () => {
  const id = activeId

  if (isDemo || !id) {
    return
  }

  const got = await call('session:commands', id)

  if (activeId === id && Array.isArray(got)) {
    slash.all = got
    slash.forId = id
  }
}

const renderSlash = () => {
  const input = $('input')
  const menu = $('slashMenu')
  const typed = /^\/([\w:.-]*)$/.exec(input.value)
  const words = typed ? typed[1].toLowerCase() : ''
  // Names that start with what was typed come first, then names and descriptions that hold it.
  slash.shown =
    typed && slash.forId === activeId
      ? [...slash.all.filter(one => one.name.toLowerCase().startsWith(words)), ...slash.all.filter(one => !one.name.toLowerCase().startsWith(words) && `${one.name} ${one.description}`.toLowerCase().includes(words))].slice(0, 40)
      : []
  slash.at = Math.min(slash.at, Math.max(0, slash.shown.length - 1))
  menu.classList.toggle('hidden', slash.shown.length === 0)
  menu.replaceChildren(
    ...slash.shown.map((one, index) => {
      const row = el('div', `slash-row${index === slash.at ? ' on' : ''}`)
      row.setAttribute('role', 'option')
      row.append(el('b', '', `/${one.name}`), el('span', '', one.hint ? `${one.hint}  ${one.description}` : one.description))
      row.title = one.description
      row.addEventListener('mousedown', event => {
        event.preventDefault()
        takeSlash(index)
      })

      return row
    }),
  )
  menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
}

const takeSlash = index => {
  const one = slash.shown[index]

  if (one) {
    const input = $('input')
    input.value = `/${one.name} `
    input.focus()
    slash.at = 0
    renderSlash()
  }
}

const loadContext = async () => {
  const id = activeId
  renderContext()

  if (isDemo || !id) {
    return
  }

  const got = await call('session:context', id)
  const project = projects.get(id)

  if (project && got?.rows) {
    project.context = got

    if (activeId === id) {
      renderStatus()
    }
  }
}

const loadUsage = async () => {
  const id = activeId

  if (isDemo || !id || !engine.info) {
    return
  }

  const got = await call('session:usage', id)

  if (activeId === id && engine.info && got?.rows) {
    engine.info.usage = got
    renderLimits()
  }
}

const loadPlugins = async () => {
  const got = isDemo ? DEMO_PLUGINS : await call('plugins:list')
  engine.plugins = Array.isArray(got) ? got : engine.plugins
  engine.pluginError = Array.isArray(got) ? '' : (got?.error ?? 'Could not read the plugin list.')
  renderLinks()
}

/** Reads the active project's limits, models and connectors from its Claude Code process. */
/**
 * The full answer about a chat's model, effort and limits comes from its
 * Claude Code process, which takes a few seconds to start. So the panels
 * are filled at once from what is already known (the same chat's last
 * answer, else the saved model and effort on the last list of models) and
 * corrected when the full answer arrives.
 */
const engineKept = new Map()
let engineLast = null

const loadEngine = async () => {
  const id = activeId
  const key = draftKeyOf(projects.get(id)) ?? id
  clearTimeout(pendingTimer)
  pendingTries = 0

  if (engine.forId !== key) {
    engine.info = engineKept.has(key) ? structuredClone(engineKept.get(key)) : null
    engine.error = ''
    engine.said = ''
  }
  engine.forId = key

  if (!id) {
    renderEngineAll()

    return
  }

  renderEngineAll()

  if (!isDemo && engineLast) {
    // Answered at once: the model and effort saved for this chat.
    const said = await call('project:describe', id).catch(() => null)

    if (activeId !== id || engine.forId !== key) {
      return
    }

    if (said?.model) {
      const base = engine.info ?? structuredClone(engineLast)
      const models = base.models.some(one => one.value === said.model)
        ? base.models
        : [...base.models, { value: said.model, name: modelName(said.model), description: '', efforts: base.models[0]?.efforts ?? [], hasFast: false }]
      engine.info = { ...base, models, model: said.model, effort: said.effort }
      renderEngineAll()
    }
  }

  const got = isDemo ? structuredClone(DEMO_INFO) : await call('session:info', id)

  if (activeId !== id || engine.forId !== key) {
    return
  }

  if (!got || got.error) {
    engine.error = got?.error ?? 'Claude Code did not answer.'
  } else {
    engineKept.set(key, got)
    engineLast = got
    engine.info = got
    engine.error = ''
    const project = projects.get(id)
    project.effort = got.effort
    void loadContext()
    void loadCommands()
  }
  renderEngineAll()
  watchPending()
}

/** A change of model, effort or fast mode: shown at once, then sent to the session. */
const setEngine = async (what, value) => {
  const info = engine.info
  const project = active()

  if (!info || !project) {
    return
  }

  if (what === 'model') {
    info.model = value
    const efforts = info.models.find(one => one.value === value)?.efforts ?? []

    // An effort the new model does not have goes back to Auto.
    if (info.effort !== null && !efforts.includes(info.effort)) {
      info.effort = null
      void call('session:effort', project.id, null)
    }
  } else if (what === 'effort') {
    info.effort = value
  } else {
    info.isFast = value
  }

  engine.said = ''
  renderEngine()
  const done = await call(`session:${what}`, project.id, value)
  engine.said = done?.error ?? ''

  // Fast mode answers with whether the account can have it.
  if (what === 'fast' && typeof done?.fastBlock === 'string') {
    Object.assign(info, { fastBlock: done.fastBlock, fastState: done.fastState, isFast: done.isFast })

    if (value && !done.isFast) {
      engine.said =
        done.fastBlock === 'extra_usage_disabled'
          ? 'Fast mode runs on extra usage, which is turned off for your account. Turn it on at claude.ai, in Settings, under Usage, then try again.'
          : `Fast mode is not available: ${FAST_BLOCKS[done.fastBlock] ?? done.fastBlock}.`
    }
  }
  renderEngine()
}

// ----------------------------------------------------------------- music deck

const deck = {
  // Every song found, the ones the filters leave, the folders they came from,
  // the songs waiting their turn, and the one loaded now.
  library: [],
  files: [],
  folders: [],
  queue: [],
  now: null,
  isShuffle: false,
  isRepeat: false,
  // The playlists kept in the app, and the one whose songs the list shows ('' for all the songs).
  playlists: [],
  playlist: localStorage.getItem('songPlaylist') ?? '',
  // The songs the search and the filters choose from: the library, or the playlist on show.
  pool: [],
  // When shuffling: the song picked to come next, kept so the pick is made once.
  planned: null,
  // The cover on show: what it belongs to, its address and where it came from.
  cover: { key: '', url: '', from: '' },
  // Covers of what other apps play, by song key (a handful at most).
  arts: {},
  // The player of the open tab while another source is live: what it says, and which app was asked for.
  view: null,
  viewApp: 'none',
  // Where the song of the open tab is, for the deck's own time line.
  tabPos: 0,
  tabDur: 0,
  // The person's browser that "Open player" would use; undefined until asked.
  browser: undefined,
  // Browsers whose player window is docked to this one, in a profile of its own.
  docks: [],
  playerSaid: '',
  // The player's browser window: how many are open, and whether they are tucked away.
  player: { count: 0, hidden: false },
  browsers: [],
  spotifySaid: '',
  source: 'files',
  state: 'stopped',
  pos: 0,
  dur: 0,
  web: null,
  lastSeq: 0,
  isSeeking: false,
  isSettingVolume: false,
  // The files' own volume and the docked player's (null: it has made no sound yet), 0 to 1.
  fileVol: 0.7,
  webVol: null,
  target: new Array(24).fill(0),
  bars: new Array(24).fill(0),
  caps: new Array(24).fill(0),
  isSounding: false,
}

const deckCmd = async (command, argument) => {
  // A song from My files plays in this window, through the equalizer, when the window can play it.
  if (!isDemo && (await tuner.take(command, argument))) {
    return
  }

  deck.lastSeq = (await call('deck:cmd', command, argument)) ?? deck.lastSeq
}

/**
 * deck.source is the music that is live: what the top bar and the transport
 * follow. deck.tab is the tab being looked at in the deck. They differ while
 * one source plays and another tab is open; the tab becomes live when
 * something is played from it.
 */
const tabOf = () => deck.tab ?? deck.source
const SOURCE_NAMES = { files: 'My files', web: 'YouTube Music', spotify: 'Spotify' }
const isLivePlaying = () => (deck.source === 'files' ? deck.state === 'playing' : deck.web?.st === 'Playing')
/** The player behind the open tab: the live one, or the one left waiting on that tab. */
const tabWeb = () => (tabOf() === deck.source ? deck.web : deck.view)

/** Tells the helper which waiting player to report, if the open tab is not the live music. */
const syncView = () => {
  const tab = tabOf()
  const wanted = tab !== 'files' && tab !== deck.source ? (tab === 'spotify' ? 'spotify' : 'other') : 'none'

  if (wanted !== deck.viewApp) {
    deck.viewApp = wanted
    deck.view = null
    void deckCmd('view-app', wanted)
  }
}

/** Makes a source the live one. What was playing is paused first. */
const goLive = source => {
  if (source === deck.source) {
    return
  }

  if (isLivePlaying()) {
    if (deck.source === 'files') {
      deck.state = 'paused'
      void deckCmd('pause')
    } else {
      void deckCmd('web-toggle')
    }
  }
  deck.source = source

  // The helper is told which app to follow: Spotify, or anything else.
  if (source !== 'files') {
    // What was already on show for that tab carries over until the helper answers.
    deck.web = source === tabOf() ? deck.view : null
    void deckCmd('web-app', source === 'spotify' ? 'spotify' : 'other')
  }
}

const playSong = song => {
  if (song) {
    deck.now = song
    deck.source = 'files'
    deck.state = 'playing'
    void deckCmd('open', song.path)
    renderDeck()
  }
}

const randomSong = () => {
  const others = deck.files.filter(song => song !== deck.now)
  // The song already picked to come next, when there is one, so what was shown as next is what plays.
  const picked = others.includes(deck.planned) ? deck.planned : others[Math.floor(Math.random() * others.length)]
  deck.planned = null
  playSong(picked ?? deck.files[0])
}

/**
 * The song that plays when this one ends, known ahead so that it can be made
 * ready and follow without a gap: this one again on repeat, else the head of
 * the queue, else one picked at random when shuffling, else the next in the list.
 */
const plannedSong = () => {
  if (deck.isRepeat && deck.now) {
    return deck.now
  }

  if (deck.queue.length > 0) {
    return deck.queue[0]
  }

  if (deck.isShuffle) {
    const others = deck.files.filter(song => song !== deck.now)

    if (!others.includes(deck.planned)) {
      deck.planned = others[Math.floor(Math.random() * others.length)] ?? null
    }

    return deck.planned
  }

  return upcoming(1)[0] ?? null
}

// The song held ready took over by itself as the last one ended: the deck follows.
tuner.onSwap = file => {
  const isRepeat = deck.isRepeat && deck.now?.path === file

  if (!isRepeat && deck.queue[0]?.path === file) {
    deck.now = deck.queue.shift()
  } else if (!isRepeat) {
    deck.now = deck.files.find(song => song.path === file) ?? deck.now
  }
  deck.planned = null
  deck.source = 'files'
  deck.state = 'playing'
  renderDeck()
}

/** Spotify's web player, as a window of the person's browser. */
const renderSpotifyWeb = () => {
  const browser = deck.docks.find(name => name === deck.browser) ?? deck.docks.find(name => deck.browsers.includes(name)) ?? deck.browser
  $('spotifyWeb').textContent = browser ? `Open in ${browser}` : 'Open in browser'
  $('spotifyWeb').disabled = !browser
  $('spWebNote').textContent =
    deck.spotifySaid || 'Open in the browser plays Spotify without the app: sign in there once and start a playlist. The deck shows what is playing, and play, pause, next and previous work from here.'
}

/**
 * Shows the cover of what is playing in place of the spectrum, with a line
 * saying where the picture came from; no cover brings the spectrum back.
 */
const renderCover = () => {
  const tab = tabOf()
  const isWeb = tab !== 'files'
  const web = tabWeb()
  const key = isWeb ? (web ? `${web.app}|${web.title}|${web.artist}` : '') : (deck.now?.path ?? '')
  const show = (url, from) => {
    deck.cover = { key, url, from }
    $('coverBox').classList.toggle('hidden', !url)
    $('spectrum').classList.toggle('hidden', !!url)

    if (url && $('cover').getAttribute('src') !== url) {
      $('cover').src = url
    }

    if (url !== deck.coverRead) {
      deck.coverRead = url
      takeCoverColours(url)
    }
    $('coverFrom').textContent = from
    $('coverBox').title = from
  }

  if (isWeb) {
    const url = deck.arts[key] ?? ''
    show(key ? url : '', url ? `Cover from ${tab === 'spotify' ? 'Spotify' : 'the player'}: ${web?.title ?? ''}` : '')

    return
  }

  if (key === deck.cover.key) {
    return
  }

  show('', '')

  if (key && !isDemo) {
    void call('music:cover', key).then(cover => {
      // Only if the same song is still the one playing.
      if (cover?.url && tabOf() === 'files' && deck.now?.path === key) {
        show(cover.url, cover.from === 'song' ? `Cover from the song: ${deck.now.name}` : `Cover from the folder: ${cover.name}`)
      }
    })
  }
}

/** The songs that will play after this one, as far as can be known: the queue, then the list in order. */
const upcoming = count => {
  const next = deck.queue.slice(0, count)

  if (!deck.isShuffle && deck.files.length > 1) {
    const at = deck.files.indexOf(deck.now)

    for (let step = 1; next.length < count && step < deck.files.length; step += 1) {
      const song = deck.files[(at + step + deck.files.length) % deck.files.length]

      if (!next.includes(song)) {
        next.push(song)
      }
    }
  }

  return next
}

/** The next song: the head of the queue, else a random one when shuffling, else the next in the list. */
const stepSong = by => {
  if (deck.source !== 'files') {
    void deckCmd(by > 0 ? 'web-next' : 'web-prev')

    return
  }

  if (by > 0 && deck.queue.length > 0) {
    playSong(deck.queue.shift())
  } else if (by > 0 && deck.isShuffle) {
    randomSong()
  } else if (deck.files.length > 0) {
    const at = deck.files.indexOf(deck.now)
    playSong(deck.files[(at + by + deck.files.length) % deck.files.length])
  }
}

const songWords = song => `${song.name} ${song.album} ${song.genre} ${song.folder} ${song.group ?? ''}`.toLowerCase()

/** Fills a filter's choices from the songs, keeping what was picked. */
const fillFilter = (select, all, values) => {
  const picked = select.value
  const wanted = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
  select.replaceChildren(el('option', '', all))
  select.firstChild.value = ''

  for (const value of wanted) {
    const option = el('option', '', value)
    option.value = value
    select.append(option)
  }
  select.value = wanted.includes(picked) ? picked : ''
}

// ---- the song list's columns and order: the person's pick, kept on this computer.
const SONG_COLS = [
  ['number', '#', 'The song\'s number on its album'],
  ['artist', 'Artist', ''],
  ['album', 'Album', ''],
  ['genre', 'Genre', ''],
  ['folder', 'Folder', 'The folder the song sits in: an artist\'s or a collection\'s'],
  ['length', 'Time', 'How long the song runs'],
]
const savedPick = (key, usual) => {
  try {
    return { ...usual, ...JSON.parse(localStorage.getItem(key) ?? '{}') }
  } catch {
    return usual
  }
}
const songCols = savedPick('songCols', { number: false, artist: false, album: false, genre: true, folder: false, length: true })
/** What the list is sorted by ('' for the order the songs were found in, or a playlist's own), and whether backwards. */
const songSort = savedPick('songSort', { by: '', isDown: false })
const songTime = seconds => (seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '')
const SONG_VALUE = {
  number: song => song.track ?? 0,
  title: song => (songCols.artist ? song.title : song.name),
  artist: song => song.artist,
  album: song => song.album,
  genre: song => song.genre,
  folder: song => song.group,
  length: song => song.length ?? 0,
}

/** The list in the order picked. Songs that tie stay together by album, then by number. */
const sortSongs = songs => {
  const value = SONG_VALUE[songSort.by]

  if (!value) {
    return songs
  }

  const text = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' })
  // Songs with no album named count their folder as the album.
  const album = (a, b) => text(a.album || a.folder, b.album || b.folder) || (a.track ?? 0) - (b.track ?? 0)

  return [...songs].sort((a, b) => {
    const [x, y] = [value(a), value(b)]
    // By number is by album first: a number alone would shuffle the albums together.
    const order = songSort.by === 'number' ? album(a, b) : typeof x === 'number' ? x - y : text(x, y)

    return (songSort.isDown ? -order : order) || album(a, b)
  })
}

// The order of the columns, left to right: the person's, changed by dragging a column's name onto another's.
const SONG_ORDER = ['number', 'title', 'artist', 'album', 'genre', 'folder', 'length']
const songOrder = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('songOrder') ?? '[]')
    const known = Array.isArray(saved) ? saved.filter((id, at) => SONG_ORDER.includes(id) && saved.indexOf(id) === at) : []

    // A column this version added goes at the end.
    return [...known, ...SONG_ORDER.filter(id => !known.includes(id))]
  } catch {
    return [...SONG_ORDER]
  }
})()
/** The columns on show, in their order. The song's name is always one of them. */
const shownCols = () => songOrder.filter(id => id === 'title' || songCols[id])
const SONG_WIDTH = { number: '26px', title: 'minmax(0, 2.2fr)', length: '40px' }
// A column the person sized keeps that width (in pixels) while there is room, and is never narrower than its least.
const SONG_LEAST = { number: 24, length: 36 }
const leastOf = id => SONG_LEAST[id] ?? 50
const SONG_MOST = 600
const songWidths = savedPick('songWidths', {})
const songTemplate = () =>
  [
    ...shownCols().map(id => {
      const width = Number(songWidths[id])

      return width > 0 ? `minmax(${leastOf(id)}px, ${Math.min(SONG_MOST, Math.max(leastOf(id), width))}px)` : (SONG_WIDTH[id] ?? 'minmax(0, 1fr)')
    }),
    '18px',
  ].join(' ')
const putSongTemplate = () => $('library').style.setProperty('--song-cols', songTemplate())
let movingCol = ''

/** The columns as the rows lay them out, and the line of column names above the list. */
const renderSongHead = () => {
  putSongTemplate()
  const name = id => {
    const [, label, title] = id === 'title' ? ['', songCols.artist ? 'Title' : 'Song', ''] : SONG_COLS.find(one => one[0] === id)
    const head = el('div', `col${id === 'number' ? ' num' : id === 'length' ? ' time' : ''}`, label + (songSort.by === id ? (songSort.isDown ? ' \u25be' : ' \u25b4') : ''))
    head.setAttribute('role', 'button')
    head.tabIndex = 0
    head.draggable = true
    head.classList.toggle('on', songSort.by === id)
    head.title = `${title ? title + '. ' : ''}Click to sort by this; again for the other way round; a third time for the usual order. Drag it onto another column's name to move the column.`
    const sort = () => {
      Object.assign(songSort, songSort.by !== id ? { by: id, isDown: false } : songSort.isDown ? { by: '', isDown: false } : { by: id, isDown: true })
      localStorage.setItem('songSort', JSON.stringify(songSort))
      filterSongs()
    }
    head.addEventListener('click', sort)
    head.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        sort()
      }
    })
    head.addEventListener('dragstart', event => {
      movingCol = id
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', label)
    })
    head.addEventListener('dragover', event => {
      if (movingCol !== '' && movingCol !== id) {
        event.preventDefault()
        head.classList.add('drop')
      }
    })
    head.addEventListener('dragleave', () => head.classList.remove('drop'))
    head.addEventListener('dragend', () => {
      movingCol = ''
      head.classList.remove('drop')
    })
    head.addEventListener('drop', event => {
      event.preventDefault()

      if (movingCol === '' || movingCol === id) {
        return
      }

      // The column takes the place of the one it was dropped on, which moves over towards where it came from.
      const isRightwards = songOrder.indexOf(movingCol) < songOrder.indexOf(id)
      songOrder.splice(songOrder.indexOf(movingCol), 1)
      songOrder.splice(songOrder.indexOf(id) + (isRightwards ? 1 : 0), 0, movingCol)
      movingCol = ''
      localStorage.setItem('songOrder', JSON.stringify(songOrder))
      deck.listKey = ''
      renderDeck()
    })

    // The grip on the column's right edge: drag it to size the column, double click for the usual width.
    const grip = el('i', 'grip')
    grip.title = 'Drag to make this column wider or narrower. Double click for its usual width.'
    grip.addEventListener('click', event => event.stopPropagation())
    grip.addEventListener('dblclick', event => {
      event.stopPropagation()
      delete songWidths[id]
      localStorage.setItem('songWidths', JSON.stringify(songWidths))
      putSongTemplate()
    })
    grip.addEventListener('pointerdown', down => {
      down.stopPropagation()
      // While the grip is held the name is not a thing to drag elsewhere.
      head.draggable = false
      const start = head.getBoundingClientRect().width
      grip.setPointerCapture?.(down.pointerId)
      const move = event => {
        songWidths[id] = Math.round(Math.min(SONG_MOST, Math.max(leastOf(id), start + event.clientX - down.clientX)))
        putSongTemplate()
      }
      const up = () => {
        grip.removeEventListener('pointermove', move)
        head.draggable = true
        localStorage.setItem('songWidths', JSON.stringify(songWidths))
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up, { once: true })
      grip.addEventListener('pointercancel', up, { once: true })
    })
    head.append(grip)

    return head
  }
  $('songHead').replaceChildren(...shownCols().map(name), el('span'))
}

/** The ticks behind "Columns": what each song's row shows. */
const renderSongCols = () => {
  $('songColsBox').replaceChildren(
    ...SONG_COLS.map(([id, label, title]) => {
      const pick = el('label')
      const box = el('input')
      box.type = 'checkbox'
      box.checked = songCols[id] === true
      box.addEventListener('change', () => {
        songCols[id] = box.checked
        localStorage.setItem('songCols', JSON.stringify(songCols))
        deck.listKey = ''
        renderDeck()
      })
      pick.title = title
      pick.append(box, id === 'number' ? 'Number' : label)

      return pick
    }),
  )
}

/** Works out which songs the search box and the filters leave, in the order picked. */
const filterSongs = () => {
  const list = deck.playlists.find(one => one.file === deck.playlist)
  deck.pool = list ? list.files : deck.library
  fillFilter($('songArtist'), 'All artists', deck.pool.map(song => song.artist))
  fillFilter($('songGenre'), 'All genres', deck.pool.map(song => song.genre))
  fillFilter($('songAlbum'), 'All albums', deck.pool.map(song => song.album))
  fillFilter($('songGroup'), 'All folders', deck.pool.map(song => song.group))
  const words = $('songSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const artist = $('songArtist').value
  const genre = $('songGenre').value
  const album = $('songAlbum').value
  const group = $('songGroup').value
  deck.files = sortSongs(
    deck.pool.filter(
      song =>
        (!artist || song.artist === artist) &&
        (!genre || song.genre === genre) &&
        (!album || song.album === album) &&
        (!group || song.group === group) &&
        words.every(word => songWords(song).includes(word)),
    ),
  )
  // The song playing is the same song in the new list, so "next" goes on from it.
  deck.now = deck.files.find(song => song.path === deck.now?.path) ?? deck.now
  deck.listKey = ''
  renderDeck()
}

const setLibrary = scanned => {
  if (scanned) {
    deck.library = scanned.files
    deck.folders = scanned.folders
    deck.playlists = Array.isArray(scanned.playlists) ? scanned.playlists : []

    // A playlist that was taken out is no longer the one on show.
    if (!deck.playlists.some(one => one.file === deck.playlist)) {
      showPlaylist('')
    } else {
      filterSongs()
    }
  }
}

/** Puts one playlist's songs in the list, in the playlist's order; '' brings all the songs back. */
const showPlaylist = file => {
  deck.playlist = file
  localStorage.setItem('songPlaylist', file)
  filterSongs()
}

const songRow = (song, { onPlay, button, onButton, title }) => {
  const row = el('div', 'song')
  const side = el('button', '', button)
  side.title = title
  side.addEventListener('click', event => {
    event.stopPropagation()
    onButton()
  })
  row.title = [song.name, song.album, song.genre, songTime(song.length)].filter(Boolean).join(' \u00b7 ')
  const cell = {
    number: () => el('small', 'num', song.track > 0 ? String(song.track) : ''),
    title: () => el('span', '', songCols.artist ? song.title : song.name),
    artist: () => el('small', '', song.artist),
    album: () => el('small', '', song.album),
    genre: () => el('small', '', song.genre),
    folder: () => el('small', '', song.group),
    length: () => el('small', 'time', songTime(song.length)),
  }
  row.append(...shownCols().map(id => cell[id]()), side)
  row.addEventListener('click', onPlay)
  asKey(row)

  return row
}

const renderDeck = () => {
  syncView()
  // isWeb, isPlaying: the live music (the top bar). tab, shown: the tab open in the deck.
  const isWeb = deck.source !== 'files'
  const song = deck.now
  const isPlaying = isWeb ? deck.web?.st === 'Playing' : deck.state === 'playing'
  const tab = tabOf()
  const isTabWeb = tab !== 'files'
  const shown = tabWeb()
  const webLine = web => `${web.title}${web.artist ? ` - ${web.artist}` : ''}`
  setSaid(
    $('trackTitle'),
    isTabWeb
    ? shown
      ? webLine(shown)
      : tab === 'spotify'
        ? 'Nothing is playing in Spotify. Open Spotify below and press play there.'
        : 'Nothing is playing. Open YouTube Music below and press play there.'
    : song
      ? song.name
      : 'No song loaded',
  )
  // A tab that is not live is waiting: its button offers play.
  $('play').textContent = isPlaying && tab === deck.source ? '\u23F8' : '\u25B6'
  $('topPlay').textContent = isPlaying ? '\u23F8' : '\u25B6'
  $('seek').disabled = tab !== deck.source
  setSaid(
    $('topTitle'),
    isWeb
    ? deck.web
      ? webLine(deck.web)
      : `${deck.source === 'spotify' ? 'Spotify' : 'YouTube Music'}: nothing playing`
    : song
      ? song.name
      : 'No song loaded',
  )
  $('topTitle').title = $('topTitle').textContent
  $('topTime').textContent = `${clock(deck.pos ?? 0)} / ${deck.dur > 0 ? clock(deck.dur) : '-:--'}`
  $('volWrap').classList.toggle('hidden', isTabWeb && deck.webVol === null)
  $('stopSong').classList.toggle('hidden', isTabWeb)
  $('shuffleSongs').classList.toggle('hidden', isTabWeb)
  $('randomSong').classList.toggle('hidden', isTabWeb)
  $('shuffleSongs').classList.toggle('on', deck.isShuffle)
  $('repeatSong').classList.toggle('hidden', isTabWeb)
  $('playerRow').classList.toggle('hidden', tabOf() !== 'web')
  renderCover()
  $('spotifyRow').classList.toggle('hidden', tabOf() !== 'spotify')
  renderSpotifyWeb()
  $('eqWrap').classList.toggle('hidden', tabOf() !== 'files')
  $('liveNote').classList.toggle('hidden', tabOf() === deck.source)
  $('liveNote').textContent = `The top bar stays with ${SOURCE_NAMES[deck.source]}. Press play here, or pick a song, to switch to ${SOURCE_NAMES[tab]}.`

  for (const id of ['playerHide', 'spPlayerHide']) {
    $(id).classList.toggle('hidden', deck.player.count === 0)
    $(id).textContent = deck.player.hidden ? 'Show player' : 'Hide player'
  }
  $('playerBrowser').disabled = deck.browser === ''
  $('playerBrowser').textContent = deck.browser ? `Open in ${deck.browser}` : 'Open player'
  $('spotifyWeb').textContent = `Open in ${deck.docks.find(name => name === deck.browser) ?? deck.docks.find(name => deck.browsers.includes(name)) ?? 'browser'}`
  $('playerNote').textContent =
    deck.playerSaid ||
    (deck.browser
      ? deck.docks.includes(deck.browser)
        ? deck.player.count > 0
          ? deck.player.hidden
            ? 'The player is hidden and the music plays on. Show player brings it back.'
            : 'The player is attached to this window. Hide player tucks it away; the music plays on.'
          : `Opens YouTube Music in ${deck.browser}, in a window attached to this one. The first time, sign in to Google there. It closes when Cla-Amp closes.`
        : `Opens in ${deck.browser}, with its sign-in. Start a playlist there; it keeps playing while that window is open, even minimised, with every other browser window closed.`
      : 'Needs Chrome, Edge or Brave. Music playing in any browser still shows up here.')
  $('repeatSong').classList.toggle('on', deck.isRepeat)

  // The top bar's copy of the same controls.
  for (const id of ['topShuffle', 'topRepeat']) {
    $(id).classList.toggle('hidden', isWeb)
  }
  $('topVol').classList.toggle('hidden', isWeb && deck.webVol === null)
  $('topShuffle').classList.toggle('on', deck.isShuffle)
  $('topRepeat').classList.toggle('on', deck.isRepeat)
  const next = isWeb ? [] : upcoming(2)
  // A player with no list open has nothing to say about what is next.
  $('topUpNext').classList.toggle('hidden', isWeb && next.length === 0)
  $('topUpNext').replaceChildren(
    ...(next.length > 0
      ? next.map((one, index) => {
          const line = el('span')
          line.append(el('b', '', index === 0 ? 'Next ' : 'Then '), one.name)
          line.title = one.name

          return line
        })
      : [el('span', '', deck.isShuffle && deck.files.length > 1 ? 'Next: a random song' : 'Nothing up next')]),
  )
  $('library').classList.toggle('hidden', tabOf() !== 'files')

  for (const button of document.querySelectorAll('.seg-btn')) {
    button.classList.toggle('active', button.dataset.source === tabOf())
  }

  // The song list is rebuilt only when the songs in it change.
  const songs = $('songs')
  const key = `${deck.files.length}|${deck.files[0]?.path}|${deck.files[deck.files.length - 1]?.path}`

  if (deck.listKey !== key) {
    deck.listKey = key
    renderSongHead()
    const list = deck.playlists.find(one => one.file === deck.playlist)
    $('songsTitle').textContent = list ? `Songs in ${list.name}` : 'Songs'
    const shown = deck.files.slice(0, 400)
    songs.replaceChildren(
      ...(deck.pool.length === 0
        ? [el('div', 'empty', list ? (list.isMissing ? 'This playlist\'s file could not be read. It may have been moved.' : 'None of this playlist\'s songs are on this computer.') : 'No music found. Add a folder below.')]
        : shown.length === 0
          ? [el('div', 'empty', 'No song matches.')]
          : shown.map(one =>
              songRow(one, {
                onPlay: () => playSong(one),
                button: '+',
                title: 'Add to Up next',
                onButton: () => {
                  deck.queue.push(one)
                  renderDeck()
                },
              }),
            )),
    )

    if (deck.files.length > shown.length) {
      songs.append(el('div', 'empty', `${count(deck.files.length - shown.length)} more: search to narrow the list.`))
    }
    $('songCount').textContent =
      deck.files.length === deck.pool.length ? `${count(deck.pool.length)}` : `${count(deck.files.length)} of ${count(deck.pool.length)}`
  }

  ;[...songs.children].forEach((row, index) =>
    row.classList.toggle('active', deck.files[index] === deck.now && deck.now !== null && !isWeb && deck.state !== 'stopped'),
  )

  const queue = $('queue')
  $('queueCount').textContent = deck.queue.length > 0 ? String(deck.queue.length) : ''
  $('queueClear').classList.toggle('hidden', deck.queue.length === 0)
  queue.replaceChildren(
    ...(deck.queue.length === 0
      ? [el('div', 'empty', 'Nothing queued. Press + on a song.')]
      : deck.queue.map((one, index) =>
          songRow(one, {
            onPlay: () => {
              deck.queue.splice(index, 1)
              playSong(one)
            },
            button: '\u00d7',
            title: 'Take out of Up next',
            onButton: () => {
              deck.queue.splice(index, 1)
              renderDeck()
            },
          }),
        )),
  )

  // The playlists kept in the app: a click shows one's songs in the list, another brings all the songs back.
  $('playlistsHead').classList.toggle('hidden', deck.playlists.length === 0)
  $('playlists').replaceChildren(
    ...deck.playlists.map(list => {
      const row = el('div', 'music-folder list')
      const drop = el('button', 'tiny', '\u00d7')
      drop.title = 'Take this playlist out of Cla-Amp (its file and its songs stay where they are)'
      drop.addEventListener('click', async event => {
        event.stopPropagation()
        setLibrary(await call('music:unlist', list.file))
      })
      row.classList.toggle('active', list.file === deck.playlist)
      row.title = `${list.file}\nClick to show this playlist's songs in the list; click again for all the songs.`
      asKey(row)
      row.addEventListener('click', () => showPlaylist(list.file === deck.playlist ? '' : list.file))
      row.append(el('span', '', list.name), el('small', '', list.isMissing ? 'file not found' : count(list.files.length)), drop)

      return row
    }),
  )

  const folders = $('musicFolders')
  folders.replaceChildren(
    ...deck.folders.map(folder => {
      const row = el('div', 'music-folder')
      const drop = el('button', 'tiny', '\u00d7')
      drop.title = 'Stop using this folder (its files stay where they are)'
      drop.addEventListener('click', async () => setLibrary(await call('music:remove', folder)))
      row.title = folder
      row.append(el('span', '', folder), drop)

      return row
    }),
  )

  if (deck.folders.length === 0) {
    folders.append(el('div', 'empty', 'No folders yet.'))
  }
}

const onDeck = status => {
  // A one-off line: the picture of what another app is playing. JPEG or PNG only.
  if (status.ev === 'art') {
    const data = typeof status.data === 'string' && /^[A-Za-z0-9+/=]+$/.test(status.data) ? status.data : ''
    const mime = data.startsWith('/9j/') ? 'image/jpeg' : data.startsWith('iVBOR') ? 'image/png' : ''
    if (mime) {
      deck.arts[String(status.key)] = `data:${mime};base64,${data}`

      for (const old of Object.keys(deck.arts).slice(0, -6)) {
        delete deck.arts[old]
      }
    }
    renderCover()

    return
  }

  // While the equalizer's player has the song, its state stands in for the helper's.
  if (tuner.isOn) {
    status = { ...status, st: tuner.state, pos: tuner.pos, dur: tuner.dur, seq: Math.max(status.seq ?? 0, deck.lastSeq), ev: tuner.takeEnded() ? 'ended' : undefined }

    // In a song's last stretch the one that follows is made ready, so it starts with no gap.
    if (deck.source === 'files' && tuner.dur > 0 && tuner.dur - tuner.pos < 20) {
      const next = plannedSong()

      if (next) {
        void tuner.ready(next.path)
      }
    }
  }

  const frame = status.sp?.[status.sp.length - 1]

  // Cla-Amp's own chime, heard through the speakers with no music on, is not shown.
  if (frame && performance.now() >= ownSoundUntil) {
    deck.target = frame
    deck.isSounding = Math.max(...frame) > 0.03
  }

  deck.web = status.web ?? null
  // Each slider shows its own music's level: the deck's the open tab's, the top bar's the live music's.
  const hadWebVol = deck.webVol !== null
  deck.webVol = typeof status.wv === 'number' && status.wv >= 0 ? status.wv : null

  if (!deck.isSettingVolume) {
    const level = source => Math.round((source === 'files' ? deck.fileVol : (deck.webVol ?? 0)) * 100)
    $('volume').value = String(level(tabOf()))
    $('volPct').textContent = `${$('volume').value}%`
    $('topVol').value = String(level(deck.source))
    putMutes()
  }

  if (hadWebVol !== (deck.webVol !== null)) {
    renderDeck()
  }
  deck.view = deck.viewApp === 'none' ? null : (status.view ?? null)
  const isWeb = deck.source !== 'files'

  if (status.seq >= deck.lastSeq) {
    const was = deck.state
    deck.state = status.st

    if (status.ev === 'ended') {
      // Repeat plays the same song again; anything queued still waits its turn.
      if (deck.isRepeat && deck.now && deck.source === 'files') {
        playSong(deck.now)
      } else {
        stepSong(1)
      }
    }

    deck.fileVol = status.vol

    if (was !== deck.state) {
      renderDeck()
    }
  }

  const filePos = deck.state === 'stopped' ? 0 : status.pos
  const fileDur = deck.state === 'stopped' ? 0 : status.dur
  // The top bar's time is the live music's; the deck's own line is the open tab's.
  deck.pos = isWeb ? (deck.web?.pos ?? 0) : filePos
  deck.dur = isWeb ? (deck.web?.dur ?? 0) : fileDur
  const shown = tabWeb()
  deck.tabPos = tabOf() === 'files' ? filePos : (shown?.pos ?? 0)
  deck.tabDur = tabOf() === 'files' ? fileDur : (shown?.dur ?? 0)
  $('dur').textContent = deck.tabDur > 0 ? clock(deck.tabDur) : '-:--'
  $('topTime').textContent = `${clock(deck.pos)} / ${deck.dur > 0 ? clock(deck.dur) : '-:--'}`
  // The long time bar under the top player: the live music's.
  $('topDur').textContent = deck.dur > 0 ? clock(deck.dur) : '-:--'
  $('topSeek').disabled = !(deck.dur > 0)

  if (!deck.isTopSeeking) {
    $('topPos').textContent = clock(deck.pos)
    $('topSeek').value = String(deck.dur > 0 ? Math.round((deck.pos / deck.dur) * 1000) : 0)
  }

  if (!deck.isSeeking) {
    $('pos').textContent = clock(deck.tabPos)
    $('seek').value = String(deck.tabDur > 0 ? Math.round((deck.tabPos / deck.tabDur) * 1000) : 0)
  }

  // A new song or a new state in either player redraws the deck.
  const title = `${deck.web?.title ?? ''}|${deck.web?.st ?? ''}|${deck.view?.title ?? ''}|${deck.view?.st ?? ''}`

  if (title !== deck.webKey) {
    deck.webKey = title
    renderDeck()
  }
}

// One loop draws both the deck's spectrum and the small one in the header.
let lastDraw = 0
const animate = now => {
  requestAnimationFrame(animate)

  if (now - lastDraw < 33) {
    return
  }
  lastDraw = now
  const isWorking = [...projects.values()].some(one => one.status === 'working')

  if (isDemo || (!deck.isSounding && isWorking)) {
    // No sound to show: a slow pulse while Claude works (and in the demo).
    deck.target = deck.target.map((_, i) =>
      isDemo || isWorking ? 0.25 + 0.3 * Math.abs(Math.sin(now / 420 + i * 0.7)) + 0.25 * Math.abs(Math.sin(now / 173 + i * 1.9)) : 0,
    )
  } else if (!deck.isSounding) {
    deck.target = deck.target.map(() => 0)
  }

  // Calm (Widgets, or Windows' own setting): nothing moves by itself, so the spectrum rests.
  if (document.body.classList.contains('calm')) {
    deck.target = deck.target.map(() => 0)
  }

  // Scale to the loudest band, so quiet music still fills the display.
  const top = Math.max(0.35, ...deck.target)
  let isMoving = false

  for (let i = 0; i < deck.bars.length; i += 1) {
    const want = deck.target[i] / top
    deck.bars[i] += (want - deck.bars[i]) * (want > deck.bars[i] ? 0.6 : 0.25)
    deck.caps[i] = Math.max(deck.bars[i], deck.caps[i] - 0.012)
    isMoving = isMoving || deck.caps[i] > 0.01
  }

  if (isMoving || deck.wasMoving || deck.isRedraw || isSpectrumStale) {
    const style = spectrumStyle()
    deck.isRedraw = false
    isSpectrumStale = false

    for (const [id, pad] of [['spectrum', 4], ['brandEq', 2]]) {
      try {
        drawStyle($(id), deck.bars, style, theme, { caps: deck.caps, pad })
      } catch {
        // A look that fails must not leave the spectrum dead: the plain bars stand in.
        try {
          drawStyle($(id), deck.bars, 'Solid bars', theme, { caps: deck.caps, pad })
        } catch {
          // Nothing more to try this frame.
        }
      }
    }

    if (isEffectOn('beat')) {
      // The lowest bands, sharpened so only real hits glow.
      const bass = (deck.bars[0] + deck.bars[1] + deck.bars[2]) / 3
      setBeat(isMoving ? Math.max(0, (bass - 0.35) / 0.65) ** 1.5 : 0)
    }
  }
  deck.wasMoving = isMoving
}

// ---------------------------------------------------------------------- skins

let skins = []
let skinPictureNames = []
// Added to the skin sheet's address after a live update, so it is read again.
let skinStamp = ''
const skinHref = () => $('skinSheet')?.getAttribute('href')?.replace(/\?v=\d+$/, '')

// What the skin in use asks for beyond colours, read from its variables:
// --window-glass (acrylic, mica or tabbed: the desktop shows through the
// window). The big picture buttons are the person's choice (Widgets), not a
// skin's: the basic buttons sit in the same places in every skin (places.js).
let sentGlass = ''
const skinExtras = () => {
  const look = getComputedStyle(document.documentElement)
  const glass = look.getPropertyValue('--window-glass').trim().toLowerCase()
  const kind = ['acrylic', 'mica', 'tabbed', 'clear'].includes(glass) ? glass : 'none'

  if (kind !== sentGlass) {
    sentGlass = kind
    void call('window:glass', kind).then(isOn => document.body.classList.toggle('glass', isOn === true))
  }
}

// Under real glass a skin may draw light streaks that stay put on the screen
// while the window moves over them, as a pane of glass would: it gets the
// window's place as --win-x and --win-y. Only looked at while glass is on.
let sentPlace = ''
setInterval(() => {
  if (!document.body.classList.contains('glass')) {
    return
  }

  const place = `${window.screenX},${window.screenY}`

  if (place !== sentPlace) {
    sentPlace = place
    document.documentElement.style.setProperty('--win-x', `${-window.screenX}px`)
    document.documentElement.style.setProperty('--win-y', `${-window.screenY}px`)
  }
}, 200)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// The widgets of the right column: each its own panel, in every skin. Which
// ones show and the extra time zones are the person's
// choice, kept in this window's own storage.
// Keeps the panels' order and columns; filled in when the columns are wired.
let savePanels = () => {}

const WIDGETS = [
  ['time', 'Time and time zones'],
  ['calendar', 'Calendar'],
  ['chat', 'This chat in numbers'],
  ['today', 'Today in numbers'],
]
const kept = (key, otherwise) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? otherwise
  } catch {
    return otherwise
  }
}
const widgets = {
  shown: new Set(kept('widgets', ['time', 'calendar', 'chat', 'today'])),
  zones: kept('zones', []).filter(one => typeof one === 'string').slice(0, 5),
  today: null,
  todayAt: 0,
}
const isShown = name => widgets.shown.has(name)

// Any panel of the side columns can be put away: right-click it, or untick it
// under Widgets, where it is brought back. Kept by the panel's own name.
const gonePanels = new Set(kept('hiddenPanels', []).filter(one => typeof one === 'string'))
const panelName = panel => panel.querySelector('h3')?.firstChild?.textContent.replace(/^[^\p{L}]+/u, '').trim() || panel.dataset.panel
const putGone = () => {
  for (const panel of document.querySelectorAll('.cols .panel:not(.widget)')) {
    panel.classList.toggle('gone', gonePanels.has(panel.dataset.panel))
  }
  localStorage.setItem('hiddenPanels', JSON.stringify([...gonePanels]))
}

/**
 * A side column with nothing on show in it is put away with its divider, and
 * comes back when something in it is shown again. With both empty the whole
 * side goes, as the title bar's button for it would do.
 */
const putColumns = () => {
  const isEmpty = id => ![...$(id).children].some(one => !one.matches('.hidden, .gone'))
  const hasSecond = document.body.classList.contains('col2')
  const firstEmpty = isEmpty('right')
  const secondEmpty = !hasSecond || isEmpty('right2')
  document.body.classList.toggle('r1-empty', firstEmpty && !secondEmpty)
  document.body.classList.toggle('r2-empty', hasSecond && secondEmpty && !firstEmpty)
  document.body.classList.toggle('no-right', localStorage.getItem('hide-right') === '1' || (firstEmpty && secondEmpty))
}

/** A small menu at the mouse: each row a thing to do; `note` is a line of small print under them. */
const popMenu = (event, rows, note = '') => {
  event.preventDefault()
  document.querySelector('.wg-menu.ctx')?.remove()
  const box = el('div', 'wg-menu ctx')

  for (const [label, run] of rows) {
    const row = el('button', 'wg-pick', label)
    row.type = 'button'
    row.addEventListener('click', () => {
      box.remove()
      run()
    })
    box.append(row)
  }

  if (note) {
    box.append(el('small', '', note))
  }
  document.body.append(box)
  const size = box.getBoundingClientRect()
  box.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - size.width - 4))}px`
  box.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - size.height - 4))}px`
  const shut = closing => {
    if (closing.type === 'keydown' ? closing.key === 'Escape' : !box.contains(closing.target)) {
      box.remove()
      document.removeEventListener('pointerdown', shut, true)
      document.removeEventListener('keydown', shut, true)
    }
  }
  document.addEventListener('pointerdown', shut, true)
  document.addEventListener('keydown', shut, true)
}

const showWidgets = () => {
  for (const [name] of WIDGETS) {
    document.querySelector(`[data-panel="wg-${name}"]`)?.classList.toggle('hidden', !isShown(name))
  }
  localStorage.setItem('widgets', JSON.stringify([...widgets.shown]))
}

const statRows = (box, rows) =>
  box.replaceChildren(
    ...rows.map(([name, count]) => {
      const row = el('div', 'wg-stat')
      row.append(el('span', '', name), el('b', '', String(count)))

      return row
    }),
  )

const zoneName = zone => zone.split('/').pop().replaceAll('_', ' ')
const timeIn = (now, zone) => now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(zone ? { timeZone: zone } : {}) })

const renderZones = now => {
  $('wgZones').replaceChildren(
    ...widgets.zones.map(zone => {
      const row = el('div', 'wg-zone')
      let shown = ''
      let offset = ''

      try {
        shown = timeIn(now, zone)
        offset = new Intl.DateTimeFormat([], { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(now).find(part => part.type === 'timeZoneName')?.value ?? ''
      } catch {
        shown = '?'
      }

      const drop = el('button', 'wg-x', '\u2715')
      drop.title = 'Take this time zone off'
      drop.addEventListener('click', () => {
        widgets.zones = widgets.zones.filter(one => one !== zone)
        localStorage.setItem('zones', JSON.stringify(widgets.zones))
        renderWidgets()
      })
      row.append(el('span', '', zoneName(zone)), el('i', '', offset), el('b', '', shown), drop)

      return row
    }),
  )
}

const loadToday = async () => {
  widgets.todayAt = Date.now()
  widgets.today = isDemo ? null : await call('today:stats')
  // Kept for the calendar's report of each day.
  noteToday(widgets.today)
  renderWidgets()
}

/** Draws the widgets that are on show. Called every two seconds and when the chat changes. */
const renderWidgets = () => {
  const project = active()
  const now = new Date()
  // The status bar's clock ticks with the widgets.
  renderBarExtras()
  // So does the list of what the chat names: drawn again only when the chat has changed.
  renderRefs()

  if (isShown('time')) {
    const state = project?.status === 'working' ? 'Working' : project?.status === 'attention' ? 'Needs you' : elsewhere(project) ? 'Working in another app' : 'Idle'
    $('wgState').textContent = state
    $('wgOrb').className = `wg-orb ${state === 'Idle' ? '' : state === 'Needs you' ? 'ask' : 'busy'}`
    $('wgClock').textContent = timeIn(now)
    $('wgDate').textContent = `${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}  \u00B7  ${Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ')}`
    renderZones(now)
  }

  if (isShown('calendar')) {
    // The month, weeks starting on Sunday, today marked. Drawn again only when the day
    // changes; the calendar draws itself again after a change to a due date or a note.
    const key = dayKey(now)

    if ($('wgCal').dataset.day !== key) {
      $('wgCal').dataset.day = key
      drawCalendar({ month: $('wgMonth'), grid: $('wgCal'), next: $('wgDue') }, now, {
        // The chat in view, for a due date that belongs to a chat.
        chatNow: () => {
          const here = active()

          return here?.chatId ? { id: here.chatId, title: (allChats ?? []).find(one => one.id === here.chatId)?.title ?? here.name, cwd: here.cwd } : null
        },
        openChat: chat => void openSavedChat(chat),
        quote,
      })
    }
  }

  if (isShown('chat')) {
    const items = project?.items ?? []
    const parts = items.flatMap(item => item.parts ?? [])
    statRows($('wgStats'), [
      ['Your messages', items.filter(item => item.kind === 'user').length],
      ["Claude's replies", items.filter(item => item.kind === 'assistant').length],
      ['Tool calls', parts.filter(part => part.type === 'tool').length],
      ['Agents', (project?.subs ?? []).length],
      ['Steps done', `${(project?.tasks ?? []).filter(task => task.status === 'completed').length} of ${(project?.tasks ?? []).length}`],
    ])
  }

  if (isShown('today')) {
    const got = widgets.today
    statRows($('wgToday'), [
      ['Chats worked on', got?.chats ?? '--'],
      ['Messages you sent', got?.prompts ?? '--'],
      ['Working now', outside.here.length + outside.chats],
      ['Agents working now', outside.agents + [...projects.values()].reduce((sum, one) => sum + (one.subs ?? []).filter(sub => sub.status === 'working').length, 0)],
    ])

    // Counted from the chats' files: once a minute is plenty.
    if (Date.now() - widgets.todayAt > 60000) {
      void loadToday()
    }
  }

}
setInterval(() => {
  skinExtras()
  renderWidgets()
}, 2000)

/** Buttons and lists of the widgets, wired once the window is up. */
const wireWidgets = () => {
  showWidgets()
  putGone()
  // Whatever shows, hides or moves a panel, the columns follow: looked at once after each batch of changes.
  let columnsTimer = null
  const columnsChanged = new MutationObserver(() => {
    clearTimeout(columnsTimer)
    columnsTimer = setTimeout(putColumns, 30)
  })

  for (const id of ['right', 'right2']) {
    columnsChanged.observe($(id), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
  }
  new MutationObserver(putColumns).observe(document.body, { attributes: true, attributeFilter: ['class'] })
  putColumns()

  // Right-click a panel to put it away. Boxes to type in, and parts with a menu of their own, keep theirs.
  for (const panel of document.querySelectorAll('.cols .panel')) {
    panel.addEventListener('contextmenu', event => {
      if (event.defaultPrevented || event.target.closest('input, textarea, select, canvas, a') || String(getSelection()).trim() !== '') {
        return
      }

      const id = panel.dataset.panel
      const isPanel = one => one?.classList.contains('panel') && !one.classList.contains('gone') && !one.classList.contains('hidden')
      let above = panel.previousElementSibling
      let below = panel.nextElementSibling

      while (above && !isPanel(above)) {
        above = above.previousElementSibling
      }

      while (below && !isPanel(below)) {
        below = below.nextElementSibling
      }

      const moved = () => {
        savePanels()
        putColumns()
        panel.querySelector('h3')?.focus()
      }
      popMenu(
        event,
        [
          ...(above ? [['Move up', () => (above.before(panel), moved())]] : []),
          ...(below ? [['Move down', () => (below.after(panel), moved())]] : []),
          ...(document.body.classList.contains('col2') ? [['Move to the other column', () => ((panel.parentElement === $('right2') ? $('right') : $('right2')).append(panel), moved())]] : []),
          [
            `Hide ${panelName(panel)}`,
            () => {
              if (id.startsWith('wg-')) {
                widgets.shown.delete(id.slice(3))
                showWidgets()
              } else {
                gonePanels.add(id)
                putGone()
              }
            },
          ],
        ],
        'Bring it back with Widgets, at the top of the window.',
      )
    })
  }

  // The same for a part of the status bar.
  for (const part of document.querySelectorAll('.statusbar .sb-item')) {
    part.addEventListener('contextmenu', event => {
      const label = STATUS_ITEMS.find(([id]) => id === part.dataset.sb)?.[1] ?? 'this'
      popMenu(
        event,
        [
          [
            `Hide ${label} from the status bar`,
            () => {
              statusItems[part.dataset.sb] = false
              localStorage.setItem('statusItems', JSON.stringify(statusItems))
              putStatusItems()
            },
          ],
        ],
        'Bring it back with Widgets, at the top of the window.',
      )
    })
  }

  for (const button of document.querySelectorAll('.wg-x[data-hide]')) {
    button.addEventListener('click', event => {
      event.stopPropagation()
      widgets.shown.delete(button.dataset.hide)
      showWidgets()
    })
  }

  const menu = $('wgMenu')
  $('wgChoose').addEventListener('click', () => {
    menu.replaceChildren(
      ...WIDGETS.map(([name, label]) => {
        const row = el('label', 'wg-pick')
        const box = el('input')
        box.type = 'checkbox'
        box.checked = isShown(name)
        box.addEventListener('change', () => {
          widgets.shown[box.checked ? 'add' : 'delete'](name)
          showWidgets()
          renderWidgets()
        })
        row.append(box, el('span', '', label))

        return row
      }),
    )
    // The other panels of the side columns: each ticked on or off the same way.
    const others = el('div', 'wg-two')

    for (const panel of document.querySelectorAll('.cols .panel:not(.widget)')) {
      const row = el('label', 'wg-pick')
      const tick = el('input')
      tick.type = 'checkbox'
      tick.checked = !gonePanels.has(panel.dataset.panel)
      tick.addEventListener('change', () => {
        gonePanels[tick.checked ? 'delete' : 'add'](panel.dataset.panel)
        putGone()
      })
      row.append(tick, el('span', '', panelName(panel)))
      others.append(row)
    }
    menu.prepend(el('div', 'wg-head', 'Widgets'))
    menu.append(el('hr'), el('div', 'wg-head', 'Panels'), others)
    const second = el('label', 'wg-pick')
    const box = el('input')
    box.type = 'checkbox'
    box.checked = document.body.classList.contains('col2')
    box.addEventListener('change', () => {
      const right2 = $('right2')
      document.body.classList.toggle('col2', box.checked)
      localStorage.setItem('col2', box.checked ? '1' : '0')

      if (box.checked && right2.children.length === 0) {
        // It starts with the widgets in it.
        right2.append(...document.querySelectorAll('#right .panel.widget'))
      } else if (!box.checked) {
        // Its panels go back to the first column.
        $('right').prepend(...right2.querySelectorAll('.panel'))
      }
      savePanels()
    })
    second.append(box, el('span', '', 'A second column (drag panels into it)'))
    const tall = el('label', 'wg-pick')
    const tallBox = el('input')
    tallBox.type = 'checkbox'
    tallBox.checked = document.body.classList.contains('side-tall')
    tallBox.addEventListener('change', () => {
      document.body.classList.toggle('side-tall', tallBox.checked)
      localStorage.setItem('sideTall', tallBox.checked ? '1' : '0')
    })
    tall.append(tallBox, el('span', '', 'Side columns run the whole height of the window'))
    const linked = el('label', 'wg-pick')
    const linkedBox = el('input')
    linkedBox.type = 'checkbox'
    linkedBox.checked = localStorage.getItem('sideLinked') === '1'
    linkedBox.addEventListener('change', () => localStorage.setItem('sideLinked', linkedBox.checked ? '1' : '0'))
    linked.title = 'Off: each side column has its own width, and the divider in front of each sizes it. On: dragging either divider sizes both alike.'
    linked.append(linkedBox, el('span', '', 'Resize the two side columns together'))
    const arrange = el('button', 'pill', 'Arrange the window...')
    arrange.type = 'button'
    arrange.title = 'Drag the logo, the top player, the buttons, the spectrum and the panels to other parts of the window'
    arrange.addEventListener('click', () => {
      menu.classList.add('hidden')
      setArranging(true)
    })
    // What the status bar shows: each part ticked on or off.
    const barPicks = el('div', 'wg-bar')

    for (const [id, label] of STATUS_ITEMS) {
      const pick = el('label', 'wg-pick')
      const box = el('input')
      box.type = 'checkbox'
      box.checked = statusItems[id] === true
      box.addEventListener('change', () => {
        statusItems[id] = box.checked
        localStorage.setItem('statusItems', JSON.stringify(statusItems))
        putStatusItems()
      })
      pick.append(box, el('span', '', label))
      barPicks.append(pick)
    }
    menu.append(el('hr'), second, tall, linked, el('hr'), el('div', 'wg-head', 'Status bar shows'), barPicks, el('hr'), el('div', 'wg-head', 'Layout'), arrange)

    // Where the sections of the window sit. A theme keeps these too.
    for (const [key, label, choices] of LAYOUT_CHOICES) {
      const row = el('label', 'wg-layout')
      const pick = el('select')
      pick.append(...choices.map(([value, words]) => Object.assign(el('option', '', words), { value })))
      pick.value = layout[key] ?? choices[0][0]
      pick.addEventListener('change', () => {
        layout[key] = pick.value
        localStorage.setItem('layout', JSON.stringify(layout))
        putLayout()
      })
      row.append(el('span', '', label), pick)
      menu.append(row)
    }

    // The typeface of the window's text.
    const fontRow = el('label', 'wg-layout')
    const fontPick = el('select')
    const group = (label, names) => {
      const box = document.createElement('optgroup')
      box.label = label
      box.append(...names.map(name => Object.assign(el('option', '', name), { value: name })))

      return box
    }
    const open = FONTS_OPEN.filter(hasFont)
    fontPick.append(Object.assign(el('option', '', "The skin's own"), { value: '' }), group('Comes with Windows', FONTS_WINDOWS.filter(hasFont)))

    if (open.length > 0) {
      fontPick.append(group('Open source, installed here', open))
    }
    fontPick.value = layout.font ?? ''
    fontPick.addEventListener('change', () => {
      layout.font = fontPick.value
      localStorage.setItem('layout', JSON.stringify(layout))
      putLayout()
    })
    fontRow.append(el('span', '', 'Text'), fontPick)
    menu.append(fontRow, el('div', 'wg-note', 'Free, open-source typefaces you install on this computer (Inter, Roboto, Noto Sans, JetBrains Mono, Atkinson Hyperlegible and others) show up in this list.'))
    // Calm, and the size of everything.
    const calmRow = el('label', 'wg-layout')
    const calmPick = el('select')
    calmPick.append(...[['', 'Same as Windows'], ['on', 'On'], ['off', 'Off']].map(([value, words]) => Object.assign(el('option', '', words), { value })))
    calmPick.value = calmChoice()
    calmPick.addEventListener('change', () => setCalm(calmPick.value))
    calmRow.append(el('span', '', 'Calm'), calmPick)
    const sizeRow = el('label', 'wg-layout')
    const sizePick = el('select')
    sizePick.append(...SIZES.map(size => Object.assign(el('option', '', `${size}%`), { value: String(size) })))
    sizePick.value = String(sizeNow())
    sizePick.addEventListener('change', () => setSize(Number(sizePick.value)))
    sizeRow.append(el('span', '', 'Size'), sizePick)
    calmRow.title = 'Calm keeps the window still: no moving spectrum, glow, sliding title or blinking.'
    sizeRow.title = 'The size of everything in the window. Ctrl and + or - change it too; Ctrl and 0 puts it back.'
    // The button row: small buttons, picture beside the words, or big ones, picture above, and three more.
    const bigRow = el('label', 'wg-layout')
    const bigPick = el('select')
    bigPick.append(...[['', 'Small'], ['1', 'Big']].map(([value, words]) => Object.assign(el('option', '', words), { value })))
    bigPick.value = isBig() ? '1' : ''
    bigPick.addEventListener('change', () => setBig(bigPick.value === '1'))
    bigRow.append(el('span', '', 'Buttons'), bigPick)
    bigRow.title = 'The row of buttons under the top row: small, with each picture beside its words, or big, with the picture above them and three more buttons (Customize, Settings, Guides). It stays as you set it in every skin.'
    // What tells the person a chat is done or waits for them.
    const noticeRow = el('label', 'wg-layout')
    const noticePick = el('select')
    noticePick.append(...[['all', 'Flash and chime'], ['flash', 'Flash only'], ['off', 'Off']].map(([value, words]) => Object.assign(el('option', '', words), { value })))
    noticePick.value = noticeChoice()
    noticePick.addEventListener('change', () => {
      setNotices(noticePick.value)
      putChime()
      chime()
    })
    noticeRow.append(el('span', '', 'Notices'), noticePick)
    noticeRow.title = 'When a chat is done or waits for your answer, the taskbar button flashes if Cla-Amp is not in front. A chime sounds when a chat is done.'
    // The language of the window's own text. Each language is listed under its own name.
    const langRow = el('label', 'wg-layout')
    const langPick = el('select')
    langPick.dataset.ownWords = ''
    langPick.append(Object.assign(el('option', '', 'Same as Windows'), { value: '' }), ...LANGS.map(([code, name]) => Object.assign(el('option', '', name), { value: code })))
    langPick.value = langChoice()
    langPick.addEventListener('change', () => setLang(langPick.value))
    langRow.append(el('span', '', 'Language'), langPick)
    langRow.title = 'Changes the words of the window itself. Messages, code and the guides stay as they were written. The window draws itself again; chats keep running.'
    // First in the menu: what a person looks for before anything else.
    menu.prepend(el('div', 'wg-head', 'Window'), langRow, sizeRow, calmRow, bigRow, noticeRow, el('hr'))
    // It opens under its button, at the top of the window.
    const at = $('wgChoose').getBoundingClientRect()
    menu.style.top = `${Math.round(at.bottom + 4)}px`
    menu.style.right = `${Math.max(8, Math.round(window.innerWidth - at.right))}px`
    menu.classList.toggle('hidden')
  })
  document.addEventListener('click', event => {
    if (!event.target.closest('#wgChoose, #wgMenu')) {
      menu.classList.add('hidden')
    }
  })

  // Escape closes whatever is open on top of the window, one thing per press:
  // a dialog and a right-click menu close themselves, the "/" list and the
  // working list have their own handlers; the rest is closed here.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open], .wg-menu.ctx')) {
      return
    }

    if (!menu.classList.contains('hidden')) {
      menu.classList.add('hidden')
      $('wgChoose').focus()
    } else if (!$('picker').classList.contains('hidden')) {
      $('pickerClose').click()
    } else if (!$('videoWin').classList.contains('hidden')) {
      $('videoClose').click()
    } else if (document.body.classList.contains('arranging')) {
      setArranging(false)
    } else {
      return
    }
    event.preventDefault()
  })

  // More time zones: every zone the computer knows, by city.
  const pick = $('wgZonePick')
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  pick.append(el('option', '', 'Add a time zone...'), ...zones.map(zone => Object.assign(el('option', '', `${zoneName(zone)} (${zone.split('/')[0]})`), { value: zone })))
  pick.addEventListener('change', () => {
    if (pick.value && !widgets.zones.includes(pick.value)) {
      widgets.zones = [...widgets.zones, pick.value].slice(-5)
      localStorage.setItem('zones', JSON.stringify(widgets.zones))
    }
    pick.selectedIndex = 0
    renderWidgets()
  })

  renderWidgets()
}


const applySkin = async id => {
  let skin = skins.find(one => one.id === id) ?? skins.find(one => one.id === 'built-in/classic')
  const allowed = skin ? await call('skins:use', skin.id) : null

  // A skin that was refused, or that the person turned down, leaves the look as it was.
  if (skin && !allowed?.url) {
    engine.said = allowed?.error ?? ''
    renderEngine()
    skin = skins.find(one => one.url === skinHref()) ?? skins.find(one => one.id === 'built-in/classic')

    if (skin?.isOwn && !$('skinSheet')) {
      skin = skins.find(one => one.id === 'built-in/classic')
    }
  }

  let link = $('skinSheet')

  if (!link) {
    link = document.createElement('link')
    link.id = 'skinSheet'
    link.rel = 'stylesheet'
    // The canvases read their colours once the sheet has landed.
    link.addEventListener('load', () => {
      readTheme()
    })
    document.head.append(link)
  }

  if (skin && link.getAttribute('href') !== skin.url + skinStamp) {
    link.href = skin.url + skinStamp
  }

  // The skin's pictures, each with its full address, go on top of its variables.
  for (const name of skinPictureNames) {
    document.documentElement.style.removeProperty(name)
  }
  skinPictureNames = allowed?.url && skin ? Object.keys(allowed.pictures ?? {}) : []

  for (const name of skinPictureNames) {
    document.documentElement.style.setProperty(name, allowed.pictures[name])
  }
  $('skin').value = skin?.id ?? ''
  $('skin').title = skin ? `Skin: ${skin.name}${skin.author ? ` by ${skin.author}` : ''}${skin.description ? `. ${skin.description}` : ''}` : 'Skin'

  return skin?.id ?? ''
}

const loadSkins = async wanted => {
  skins = (await call('skins:list')) ?? []
  const select = $('skin')
  select.replaceChildren()
  select.classList.toggle('hidden', skins.length === 0)

  for (const skin of skins) {
    const option = el('option', '', `${skin.name}${skin.isOwn ? ' (mine)' : ''}${skin.kind === 'refused' ? ' - not loadable' : ''}`)
    option.value = skin.id
    option.title = skin.why || skin.description
    select.append(option)
  }

  const winamp = el('option', '', 'Import a Winamp skin (.wsz)...')
  winamp.value = '#winamp'
  const folder = el('option', '', 'Open my skins folder...')
  folder.value = '#folder'
  select.append(winamp, folder)
  await applySkin(wanted)
}

// -------------------------------------------------------------------- sign-in

let signInTimer = 0

const checkSignIn = async () => {
  const status = await call('auth:status')
  const isSignedIn = status?.isSignedIn !== false
  $('signIn').classList.toggle('hidden', isSignedIn)
  // The first-start card shows its sign-in step as done or still to do.
  document.body.classList.toggle('signed-out', !isSignedIn)

  if (isSignedIn && engine.error !== '') {
    void loadEngine()
  }

  if (isSignedIn) {
    clearInterval(signInTimer)
    $('signInButton').textContent = 'Sign in'
  }

  return isSignedIn
}

const signIn = async () => {
  await call('auth:login')
  $('signInButton').textContent = 'Waiting for the sign-in...'
  clearInterval(signInTimer)
  let checks = 0
  // Look again every few seconds, for ten minutes, until the sign-in lands.
  signInTimer = setInterval(() => {
    checks += 1

    if (checks > 200) {
      clearInterval(signInTimer)
      $('signInButton').textContent = 'Sign in'
    } else {
      void checkSignIn()
    }
  }, 3000)
}

// -------------------------------------------------------------------- actions

/** Files waiting to go with the next message: full paths, as dropped, pasted or picked. */
let attached = []
const PICTURE_END = /\.(png|jpe?g|gif|webp)$/i

const renderAttached = () => {
  const list = $('attachList')
  list.classList.toggle('hidden', attached.length === 0)
  list.replaceChildren(
    ...attached.map(file => {
      const chip = el('span', 'attach-chip')
      const name = file.split(/[\\/]/).pop()
      const off = el('button', '', '✕')
      off.type = 'button'
      off.title = 'Do not send this file'
      off.addEventListener('click', () => {
        attached = attached.filter(one => one !== file)
        renderAttached()
      })
      chip.title = file

      if (PICTURE_END.test(name)) {
        const picture = el('img')
        picture.src = encodeURI(`file:///${file.replace(/\\/g, '/')}`).replace(/#/g, '%23').replace(/\?/g, '%3F')
        picture.alt = ''
        picture.title = 'Click to open it in the picture viewer'
        picture.addEventListener('click', () => viewPicture(picture.src, name))
        picture.addEventListener('error', () => picture.remove())
        chip.classList.add('has-picture')
        chip.append(picture, el('span', '', name), off)
      } else {
        chip.append(el('i', '', '▤'), el('span', '', name), off)
      }

      return chip
    }),
  )
}

const attach = files => {
  for (const file of files) {
    if (typeof file === 'string' && file !== '' && !attached.includes(file)) {
      attached.push(file)
    }
  }
  renderAttached()
}

/** Files from a drop or a paste: those on disk by their path, a pasted picture saved first. */
const attachFrom = async transfer => {
  const found = []

  for (const file of [...(transfer?.files ?? [])]) {
    const where = window.amp.pathOf(file)

    if (where) {
      found.push(where)
    } else if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      const data = await new Promise(resolve => {
        const reader = new FileReader()
        reader.addEventListener('load', () => resolve(reader.result))
        reader.addEventListener('error', () => resolve(''))
        reader.readAsDataURL(file)
      })
      found.push(await call('attach:paste', data))
    }
  }
  attach(found)
}

/** Puts text into the message box as a quote, above whatever is being written. */
const quote = text => {
  const words = String(text ?? '').trim()

  if (words === '') {
    return
  }

  const input = $('input')
  const lines = (words.length > 3000 ? words.slice(0, 3000) + '…' : words).split('\n').map(line => `> ${line}`).join('\n')
  input.value = `${input.value.trimEnd()}${input.value.trim() ? '\n\n' : ''}${lines}\n\n`
  input.dispatchEvent(new Event('input'))
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  input.scrollTop = input.scrollHeight
}

/** The text marked with the mouse inside the chat, or ''. */
const markedInChat = () => {
  const marked = getSelection()

  return marked && !marked.isCollapsed && marked.rangeCount > 0 && $('chat').contains(marked.getRangeAt(0).commonAncestorContainer) ? marked.toString().trim() : ''
}

const submit = (text, files = [], isNow = false) => {
  // Sending a message goes to the end and follows the answer.
  setFollow(true)
  const project = active()
  const words = text.trim()

  if (!project || (words === '' && files.length === 0)) {
    return false
  }

  void call('project:send', project.id, words, files, isNow)

  return true
}

const renderAll = () => {
  renderProjects()
  renderChat()
  renderStatus()
  renderNow()
}

let isPaintQueued = false
const queuePaint = () => {
  if (!isPaintQueued) {
    isPaintQueued = true
    requestAnimationFrame(() => {
      isPaintQueued = false
      renderChat()
    })
  }
}

const wire = () => {
  // Any picture in the chat opens in the picture viewer, over the window, and not inside the chat.
  $('chat').addEventListener('click', event => {
    if (event.target instanceof HTMLImageElement && event.target.naturalWidth > 0) {
      event.preventDefault()
      viewPicture(event.target.src, event.target.alt)
    }
  })
  const input = $('input')
  // The box grows with what is written, up to a little under half the window.
  const fit = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(Math.max(160, Math.round(window.innerHeight * 0.45)), input.scrollHeight)}px`
  }
  const send = (isNow = false) => {
    if (!submit(input.value, attached, isNow)) {
      return
    }
    input.value = ''
    attached = []
    renderAttached()
    fit()
    keepDraft()
  }
  // A message being written is kept when the window reloads or the app restarts.
  window.addEventListener('pagehide', keepDraft)
  $('attach').addEventListener('click', async () => attach((await call('attach:pick')) ?? []))
  // A file dropped anywhere on the window goes with the next message.
  const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files')
  let dropLeave = 0
  window.addEventListener('dragover', event => {
    if (hasFiles(event)) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      $('composer').classList.add('dropping')
      clearTimeout(dropLeave)
      dropLeave = setTimeout(() => $('composer').classList.remove('dropping'), 200)
    }
  })
  window.addEventListener('drop', event => {
    if (hasFiles(event)) {
      event.preventDefault()
      $('composer').classList.remove('dropping')
      void attachFrom(event.dataTransfer)
      input.focus()
    }
  })
  input.addEventListener('paste', event => {
    if ((event.clipboardData?.files?.length ?? 0) > 0) {
      event.preventDefault()
      void attachFrom(event.clipboardData)
    }
  })
  // Marking text in the chat offers a Quote button beside it.
  const quotePop = el('button', 'quote-pop hidden', '❝ Quote')
  quotePop.type = 'button'
  quotePop.title = 'Put the marked text in your message as a quote'
  document.body.append(quotePop)
  quotePop.addEventListener('mousedown', event => event.preventDefault())
  quotePop.addEventListener('click', () => {
    quote(markedInChat())
    getSelection()?.removeAllRanges()
    quotePop.classList.add('hidden')
  })
  $('chat').addEventListener('mouseup', () =>
    setTimeout(() => {
      const marked = markedInChat()
      quotePop.classList.toggle('hidden', marked === '')

      if (marked !== '') {
        const box = getSelection().getRangeAt(0).getBoundingClientRect()
        quotePop.style.left = `${Math.max(8, Math.min(window.innerWidth - 90, box.right - 40))}px`
        quotePop.style.top = `${Math.max(8, box.top - 30)}px`
      }
    }, 0),
  )
  document.addEventListener('mousedown', event => {
    if (event.target !== quotePop) {
      quotePop.classList.add('hidden')
    }
  })
  $('chat').addEventListener('scroll', () => quotePop.classList.add('hidden'), { passive: true })
  window.addEventListener('resize', fit)
  $('composer').addEventListener('submit', event => {
    event.preventDefault()
    send()
  })
  input.addEventListener('keydown', event => {
    // With the "/" list open: arrows move in it, Tab or Enter takes the marked one, Escape closes it.
    if (slash.shown.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        slash.at = (slash.at + (event.key === 'ArrowDown' ? 1 : slash.shown.length - 1)) % slash.shown.length
        renderSlash()

        return
      }

      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        takeSlash(slash.at)

        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        slash.shown = []
        $('slashMenu').classList.add('hidden')

        return
      }
    }

    // Tab on an empty box takes the suggested message, to edit or send.
    if (event.key === 'Tab' && !event.shiftKey && input.value === '' && active()?.suggestion) {
      event.preventDefault()
      input.value = active().suggestion
      input.dispatchEvent(new Event('input'))

      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      // Ctrl+Enter while Claude is working: the message does not wait its turn.
      send(event.ctrlKey)
    }
  })
  input.addEventListener('blur', () => $('slashMenu').classList.add('hidden'))
  input.addEventListener('input', () => {
    slash.at = 0
    renderSlash()
    fit()
  })
  $('signInButton').addEventListener('click', () => void signIn())
  // Picks a Winamp skin file, converts it, and puts it on. A problem is said in a box.
  const importSkin = async before => {
    const made = await call('skins:import')
    engine.said = made?.error ?? ''
    renderEngine()
    await loadSkins(made?.id ?? skins.find(one => one.url === before)?.id)

    if (made?.id) {
      void call('prefs:set', 'skin', made.id)
    } else if (made?.error) {
      alert(made.error)
    }
  }
  $('skinImport').addEventListener('click', () => void importSkin(skinHref()))
  $('guidesBtn').addEventListener('click', () => void openGuides())
  $('claudeChat').addEventListener('click', async () => {
    const opened = await call('claude:open')

    if (opened?.error) {
      alert(opened.error)
    } else if (opened && opened.isAuto === false) {
      alert(`claude.ai was opened in ${opened.browser}, as an ordinary window.`)
    }
  })
  $('settingsBtn').addEventListener('click', () => void openSettings(activeId, { look: () => openLook(), guides: () => void openGuides(), about: () => void openAbout() }))
  $('skin').addEventListener('change', async () => {
    const picked = $('skin').value
    const before = skinHref()

    // The last entry is not a skin: it opens the folder, then the list is read again.
    // Not a skin either: picks a Winamp skin file, converts it, and puts it on.
    if (picked === '#winamp') {
      await importSkin(before)

      return
    }

    if (picked === '#folder') {
      await call('skins:folder')
      await loadSkins(skins.find(one => one.url === before)?.id)

      return
    }

    void call('prefs:set', 'skin', await applySkin(picked))
  })
  // Skins made or changed while the app is open show up when the list is opened.
  $('skin').addEventListener('pointerdown', () => {
    const before = skinHref()
    void call('skins:list').then(found => {
      if (found && JSON.stringify(found.map(one => one.id)) !== JSON.stringify(skins.map(one => one.id))) {
        void loadSkins(skins.find(one => one.url === before)?.id)
      }
    })
  })
  $('model').addEventListener('change', () => void setEngine('model', $('model').value))
  // The same two picks from the status bar: a click on the model or the effort opens its choices.
  const tick = isOn => (isOn ? '\u2713 ' : '\u2003 ')
  $('sbModelBtn').addEventListener('click', event => {
    const info = engine.info

    if (!info) {
      return
    }

    const now = (info.models.find(one => one.value === info.model) ?? info.models[0])?.value
    popMenu(
      event,
      info.models.map(one => [tick(one.value === now) + (one.value === 'default' ? `Default (${one.description})` : one.name), () => void setEngine('model', one.value)]),
    )
  })
  $('sbEffortBtn').addEventListener('click', event => {
    const info = engine.info

    if (!info) {
      return
    }

    const efforts = (info.models.find(one => one.value === info.model) ?? info.models[0])?.efforts ?? []
    popMenu(
      event,
      [null, ...efforts].map(level => [tick((info.effort ?? null) === level) + (level === null ? 'Auto' : EFFORT_NAMES[level]), () => void setEngine('effort', level)]),
      efforts.length === 0 ? 'This model has no effort levels.' : '',
    )
  })
  $('fast').addEventListener('change', () => void setEngine('fast', $('fast').checked))
  $('pluginSearch').addEventListener('input', renderLinks)
  $('linksRefresh').addEventListener('click', () => {
    void loadEngine()
    void loadPlugins()
  })
  $('stop').addEventListener('click', () => void call('project:stop', activeId))
  $('mode').addEventListener('click', () => {
    const project = active()

    if (project) {
      const at = MODES.findIndex(one => one.id === (project.mode ?? 'default'))
      const wanted = MODES[(at + 1) % MODES.length].id
      project.mode = wanted
      renderStatus()
      void call('project:mode', project.id, wanted).then(said => {
        // Claude Code may refuse a mode (Auto is not offered everywhere): step on to the next one.
        if (said?.error && project.mode === wanted) {
          project.mode = MODES[(MODES.findIndex(one => one.id === wanted) + 1) % MODES.length].id
          void call('project:mode', project.id, project.mode)
          renderStatus()
          project.items.push({ kind: 'note', text: `${MODES.find(one => one.id === wanted).label} mode could not be switched on here: ${said.error}` })
          renderChat()
        }
      })
    }
  })
  $('newChat').addEventListener('click', async () => {
    const project = active()

    // A new chat never removes the one that was open: that stays saved, in the Chats tab.
    // Only when Claude is in the middle of working is there something to ask about.
    const isWorking = project?.status === 'working' || (project?.agents ?? 0) > 0

    // While Claude works here, the new chat opens beside it: one more entry for the same folder.
    if (project && isWorking) {
      const made = await call('project:another', project.id)

      if (made) {
        const other = projects.get(made.id) ?? addProject(made)
        Object.assign(other, { items: [], current: null, usage: null, subs: [], hasSession: false, lastPrompt: '', isLoaded: true, chatId: null })
        other.tools.clear()
        other.asks.clear()
        chatFor = null
        void select(other.id)
      }

      return
    }

    if (project) {
      await call('project:new', project.id)
      keepDraft()
      Object.assign(project, { items: [], current: null, usage: null, subs: [], hasSession: false, lastPrompt: '', chatId: null })
      takeDraft()
      project.tools.clear()
      project.asks.clear()
      chatFor = null
      renderAll()
    }
  })
  $('chatSearch').addEventListener('input', renderChats)
  const picker = $('picker')
  $('openChat').addEventListener('click', async () => {
    const project = active()

    if (!project) {
      return
    }

    const list = $('pickerList')
    $('pickerNote').textContent = `Conversations saved for ${project.cwd}, from Cla-Amp, the Claude desktop app or the terminal. Opening one continues that same conversation here. Use one app at a time on a chat.`
    list.replaceChildren(el('div', 'empty', 'Looking for conversations...'))
    picker.classList.remove('hidden')
    const found = (await call('sessions:list', project.id)) ?? []
    list.replaceChildren()

    if (found.length === 0) {
      list.append(el('div', 'empty', 'No saved conversations for this folder.'))
    }

    for (const one of found) {
      const row = asKey(el('div', `pick${one.isCurrent ? ' current' : ''}`))
      row.append(el('span', 'pick-title', one.title), el('span', 'pick-when', `${one.isCurrent ? 'open now' : ago(one.lastModified)}  ·  ${one.size > 1048576 ? `${Math.round(one.size / 1048576)} MB` : `${Math.max(1, Math.round(one.size / 1024))} KB`}`))
      row.addEventListener('click', async () => {
        list.replaceChildren(el('div', 'empty', 'Opening...'))
        const opened = await call('sessions:open', project.id, one.id)
        const events = opened?.events

        if (opened?.error) {
          alert(opened.error)
        }
        picker.classList.add('hidden')

        // The chat may open in another entry for the same folder, when this one is working.
        if (opened?.isOpen && projects.has(opened.project.id)) {
          chatFor = null
          void select(opened.project.id)
        } else if (events) {
          const target = projects.get(opened.project.id) ?? addProject(opened.project)
          target.chatId = one.id
          showConversation(target, events)
        }
      })
      list.append(row)
    }
  })
  $('pickerClose').addEventListener('click', () => picker.classList.add('hidden'))
  picker.addEventListener('click', event => {
    if (event.target === picker) {
      picker.classList.add('hidden')
    }
  })

  $('shuffle').addEventListener('click', () => {
    const others = [...projects.keys()].filter(id => id !== activeId)

    if (others.length > 0) {
      void select(others[Math.floor(Math.random() * others.length)])
    }
  })
  $('addProject').addEventListener('click', async () => {
    const info = await call('project:add')

    if (info) {
      if (!projects.has(info.id)) {
        addProject(info)
      }
      void select(info.id)
    }
  })

  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => {
      tab = button.dataset.tab
      localStorage.setItem('tab', tab)

      if (tab === 'chats') {
        void loadChats()
      }
      document.querySelectorAll('.tab').forEach(one => one.classList.toggle('active', one === button))
      renderProjects()
    })
  }

  for (const button of document.querySelectorAll('[data-win]')) {
    button.addEventListener('click', () => void call('win', button.dataset.win))
  }

  // Links in a reply open in the browser, never inside this window.
  $('chat').addEventListener('click', event => {
    const link = event.target.closest?.('a[href]')

    if (link) {
      event.preventDefault()

      // Web links only; the main process checks again before the browser opens.
      if (/^https?:\/\//i.test(link.href)) {
        window.open(link.href)
      }
    }
  })

  // --- layout: column widths, hidden columns, panel order and folding
  const root = document.documentElement

  const savedRight2 = localStorage.getItem('width-right2')

  if (savedRight2) {
    root.style.setProperty('--right2', `${savedRight2}px`)
  }

  for (const side of ['left', 'right']) {
    const saved = localStorage.getItem(`width-${side}`)

    if (saved) {
      root.style.setProperty(`--${side}`, `${saved}px`)
    }
    document.body.classList.toggle(`no-${side}`, localStorage.getItem(`hide-${side}`) === '1')
    $(side === 'left' ? 'toggleLeft' : 'toggleRight').addEventListener('click', () => {
      const isHidden = document.body.classList.toggle(`no-${side}`)
      localStorage.setItem(`hide-${side}`, isHidden ? '1' : '0')
    })
  }

  for (const splitter of document.querySelectorAll('.splitter')) {
    // With the keyboard: Tab to the divider, then the left and right arrows.
    asKey(splitter, 'separator')
    splitter.setAttribute('aria-orientation', 'vertical')
    splitter.setAttribute('aria-label', 'Column width: left and right arrows change it')
    splitter.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }

      event.preventDefault()
      const side = splitter.dataset.side
      const column = $(side)
      const width = column.getBoundingClientRect().width
      const grows = column.getBoundingClientRect().left < splitter.getBoundingClientRect().left ? 1 : -1
      const room = Math.max(0, $('center').getBoundingClientRect().width - CHAT_LEAST)
      const next = Math.round(Math.min(Math.max(width, Math.min(900, width + room)), Math.max(200, width + (event.key === 'ArrowRight' ? 24 : -24) * grows)))
      root.style.setProperty(`--${side}`, `${next}px`)
      localStorage.setItem(`width-${side}`, String(next))
    })
    splitter.addEventListener('pointerdown', down => {
      const side = splitter.dataset.side
      const column = $(side)
      const start = column.getBoundingClientRect().width
      // The two side columns as one (Widgets): a drag on either divider sizes both alike.
      const isPair = side !== 'left' && document.body.classList.contains('col2') && localStorage.getItem('sideLinked') === '1'
      const put = (name, width) => {
        root.style.setProperty(`--${name}`, `${width}px`)
        localStorage.setItem(`width-${name}`, String(width))
      }
      // A column grows only into the room the chat can spare, and never past 900.
      const room = Math.max(0, $('center').getBoundingClientRect().width - CHAT_LEAST)
      const pairStart = isPair ? ($('right').getBoundingClientRect().width + $('right2').getBoundingClientRect().width) / 2 : start
      const most = Math.max(pairStart, Math.min(900, pairStart + (isPair ? room / 2 : room)))
      splitter.setPointerCapture(down.pointerId)
      const move = event => {
        // The column grows away from its divider, whichever side of it the layout puts it on.
        const grows = column.getBoundingClientRect().left < splitter.getBoundingClientRect().left ? 1 : -1
        const delta = (event.clientX - down.clientX) * grows

        if (isPair) {
          // The outer divider moves both columns, so each takes half of the way the mouse went.
          const width = Math.round(Math.min(most, Math.max(200, pairStart + (side === 'right' ? delta / 2 : delta))))
          put('right', width)
          put('right2', width)

          return
        }

        put(side, Math.round(Math.min(most, Math.max(200, start + delta))))
      }
      splitter.addEventListener('pointermove', move)
      splitter.addEventListener('pointerup', () => splitter.removeEventListener('pointermove', move), { once: true })
    })
  }

  const right = $('right')
  const right2 = $('right2')
  // Each panel's place: its name, whether it is folded, and its column (0 or 1), in order.
  savePanels = () => {
    const panels = [...right.querySelectorAll('.panel'), ...right2.querySelectorAll('.panel')]
    localStorage.setItem('panels', JSON.stringify(panels.map(one => [one.dataset.panel, one.classList.contains('closed'), one.parentElement === right2 ? 1 : 0])))

    // Arrange mode keeps its own record of what sits where, and that record
    // is put back last at the start. A panel moved outside Arrange mode
    // (dragged, or Move up and Move down) goes into it too, or the older
    // record would put the panel back where it was.
    if (localStorage.getItem('places') !== null) {
      savePlaces()
    }
  }
  document.body.classList.toggle('col2', localStorage.getItem('col2') === '1')
  document.body.classList.toggle('side-tall', localStorage.getItem('sideTall') === '1')
  // The title bar's height, for side columns that start right under it.
  new ResizeObserver(() => document.body.style.setProperty('--title-h', `${document.querySelector('.titlebar').offsetHeight}px`)).observe(document.querySelector('.titlebar'))

  try {
    for (const [name, isClosed, column] of JSON.parse(localStorage.getItem('panels') ?? '[]')) {
      const panel = document.querySelector(`.cols [data-panel="${name}"]`)

      if (panel) {
        panel.classList.toggle('closed', isClosed === true)
        ;(column === 1 ? right2 : right).append(panel)
      }
    }
  } catch {
    // A saved layout that no longer parses: keep the default order.
  }

  // A panel newer than the saved order ("In this chat") goes under the music deck, not above everything.
  if (!(localStorage.getItem('panels') ?? '').includes('"refs"')) {
    document.querySelector('.cols [data-panel="deck"]')?.after(document.querySelector('.cols [data-panel="refs"]'))
  }

  // Blocks moved in Arrange mode go back where they were left.
  putPlaces()

  if (localStorage.getItem('deckOnTop') !== '1') {
    localStorage.setItem('deckOnTop', '1')
    right.prepend(right.querySelector('[data-panel="deck"]'))
    savePanels()
  }

  let dragged = null

  // A panel dropped on a column's empty room goes to its end.
  for (const column of [right, right2]) {
    column.addEventListener('dragover', event => {
      if (event.target === column) {
        event.preventDefault()
        column.classList.add('over')
      }
    })
    column.addEventListener('dragleave', () => column.classList.remove('over'))
    column.addEventListener('drop', event => {
      column.classList.remove('over')

      if (event.target === column && dragged) {
        event.preventDefault()
        column.append(dragged)
        savePanels()
      }
    })
  }

  for (const panel of document.querySelectorAll('.cols .panel')) {
    const head = asKey(panel.querySelector('h3'))
    head.addEventListener('click', () => {
      panel.classList.toggle('closed')
      savePanels()
    })
    head.addEventListener('dragstart', () => (dragged = panel))
    panel.addEventListener('dragover', event => {
      event.preventDefault()
      panel.classList.add('over')
    })
    panel.addEventListener('dragleave', () => panel.classList.remove('over'))
    panel.addEventListener('drop', event => {
      event.preventDefault()
      panel.classList.remove('over')

      if (dragged && dragged !== panel) {
        const isAfter = event.clientY > panel.getBoundingClientRect().top + panel.offsetHeight / 2
        panel[isAfter ? 'after' : 'before'](dragged)
        savePanels()
      }
    })
  }

  // --- music deck
  for (const button of document.querySelectorAll('.seg-btn')) {
    button.addEventListener('click', () => {
      deck.tab = button.dataset.source

      // With both players open, the one for this tab is the one on show.
      if (deck.tab !== 'files' && deck.player.count > 0) {
        void call('player:hide', deck.player.hidden, deck.tab === 'spotify' ? 'spotify' : 'ytm')
      }

      // Looking at another tab does not take the music over: what is playing
      // stays live, and stays up top, until something is played from here.
      if (!isLivePlaying()) {
        goLive(deck.tab)
      }
      renderDeck()
    })
  }
  const pressPlay = isFromDeck => {
    // Play in the deck, on a tab that is not live yet, switches the music to that tab.
    if (isFromDeck) {
      goLive(tabOf())
    }

    if (deck.source !== 'files') {
      const site = deck.source === 'spotify' ? 'spotify' : 'ytm'

      // Nothing to play yet: pressing play brings the player up by itself.
      if (deck.web === null && deck.player.count === 0 && deck.docks.some(name => deck.browsers.includes(name))) {
        void openIn(site, true).then(() => renderDeck())
      } else {
        void deckCmd('web-toggle')
      }
    } else if (deck.state === 'playing') {
      deck.state = 'paused'
      void deckCmd('pause')
    } else if (deck.state === 'paused') {
      deck.state = 'playing'
      void deckCmd('resume')
    } else {
      playSong(deck.now ?? deck.queue.shift() ?? deck.files[0])
    }
    renderDeck()
  }
  $('play').addEventListener('click', () => pressPlay(true))
  $('stopSong').addEventListener('click', () => {
    deck.state = 'stopped'
    void deckCmd('stop')
    renderDeck()
  })
  $('topPrev').addEventListener('click', () => stepSong(-1))
  // The top bar's play button belongs to the live music, whatever tab is open.
  $('topPlay').addEventListener('click', () => pressPlay(false))

  for (const id of ['spectrum', 'brandEq']) {
    $(id).addEventListener('click', () => {
      const style = nextSpectrumStyle()
      $('spectrum').title = $('brandEq').title = `Spectrum: ${style}. Click for another look, right-click for all the choices.`
      deck.wasMoving = true
      deck.isRedraw = true
    })
    // Right-click: every look, the colours, the bands and the extras.
    $(id).addEventListener('contextmenu', event => {
      event.preventDefault()
      openSpectrumMenu(event, () => {
        deck.wasMoving = true
        deck.isRedraw = true
        applyEffects()
      })
    })
  }
  // The effects chosen earlier go on at the start, before any skin lands.
  readTheme()
  $('topNext').addEventListener('click', () => stepSong(1))
  $('topShuffle').addEventListener('click', () => $('shuffleSongs').click())

  // The YouTube Music player: a window of the person's own browser.
  $('spotifyOpen').addEventListener('click', () => void call('spotify:open'))
  for (const id of ['playerHide', 'spPlayerHide']) {
    $(id).addEventListener('click', () => void call('player:hide', !deck.player.hidden, tabOf() === 'spotify' ? 'spotify' : 'ytm'))
  }
  const noteOutside = said => {
    outside = { chats: Number(said?.chats) || 0, agents: Number(said?.agents) || 0, list: Array.isArray(said?.list) ? said.list : [], here: Array.isArray(said?.here) ? said.here : [] }
    renderStatus()

    // The Code tab marks the chats that are working.
    if (tab === 'chats') {
      renderChats()
    }
    // The open chat may have started or stopped being worked on elsewhere.
    renderTail()
  }
  window.amp.on('amp:outside', noteOutside)
  const shutWorkList = () => {
    $('workList').classList.add('hidden')
    $('agentsBtn').setAttribute('aria-expanded', 'false')
  }
  $('agentsBtn').addEventListener('click', event => {
    event.stopPropagation()
    const isOpen = $('workList').classList.toggle('hidden') === false
    $('agentsBtn').setAttribute('aria-expanded', String(isOpen))
    renderWorkList()

    if (isOpen && !isDemo) {
      void call('work:load').then(said => {
        workLoads = said ?? {}
        renderWorkList()
      })
    }
  })
  $('workList').addEventListener('click', event => event.stopPropagation())
  document.addEventListener('click', shutWorkList)
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      shutWorkList()
    }
  })
  void call('outside:state').then(noteOutside)
  window.amp.on('amp:player', said => {
    deck.player = { count: Number(said?.count) || 0, hidden: said?.hidden === true }
    renderDeck()
  })
  void call('player:state').then(said => {
    deck.player = { count: Number(said?.count) || 0, hidden: said?.hidden === true }
    renderDeck()
  })
  $('pagesBtn').addEventListener('click', async () => {
    const said = await call('pages:toggle')

    if (said?.error) {
      alert(said.error)
    }
  })
  const openIn = (site, isQuiet = false) => {
    const browser = site === 'spotify' ? (deck.docks.find(name => name === deck.browser) ?? deck.docks.find(name => deck.browsers.includes(name)) ?? deck.browser) : deck.browser

    return call('player:browser', browser, site, isQuiet)
  }
  $('spotifyWeb').addEventListener('click', async () => {
    const opened = await openIn('spotify')
    deck.spotifySaid = opened?.error ?? ''

    // Opening a player makes it the live one, unless other music is playing now.
    if (!opened?.error && !isLivePlaying()) {
      goLive('spotify')
    }
    renderDeck()
  })
  $('playerBrowser').addEventListener('click', async () => {
    const opened = await openIn('ytm')
    deck.playerSaid = opened?.error ?? (opened?.browser && !opened.isAuto ? `Opened in ${opened.browser}. The deck follows it once a song plays.` : '')

    if (!opened?.error && !isLivePlaying()) {
      goLive('web')
    }
    renderDeck()
  })
  $('playerWhich').addEventListener('change', () => {
    deck.browser = $('playerWhich').value
    deck.playerSaid = ''
    localStorage.setItem('playerBrowser', deck.browser)
    renderDeck()
  })
  void call('player:which').then(found => {
    const names = found?.browsers ?? []
    deck.docks = found?.docks ?? []
    deck.browsers = names
    const kept = localStorage.getItem('playerBrowser')
    deck.browser = names.includes(kept) ? kept : (names[0] ?? '')
    $('playerWhich').replaceChildren(...names.map(name => el('option', '', `Use ${name}`)))
    names.forEach((name, index) => ($('playerWhich').options[index].value = name))
    $('playerWhich').value = deck.browser
    $('playerWhich').classList.toggle('hidden', names.length < 2)
    renderDeck()
  })
  $('topRepeat').addEventListener('click', () => $('repeatSong').click())
  $('repeatSong').addEventListener('click', () => {
    deck.isRepeat = !deck.isRepeat
    renderDeck()
  })
  // Each volume slider sets its own music: the deck's the open tab's, the top bar's the live music's.
  const wireVolume = (slider, sourceOf) => {
    slider.addEventListener('input', () => {
      deck.isSettingVolume = true

      if (slider.id === 'volume') {
        $('volPct').textContent = `${slider.value}%`
      }
      void deckCmd(sourceOf() === 'files' ? 'vol' : 'web-vol', (Number(slider.value) / 100).toFixed(2))
    })
    slider.addEventListener('change', () => {
      if (sourceOf() === 'files') {
        void call('prefs:set', 'volume', Number(slider.value) / 100)
      }
      setTimeout(() => (deck.isSettingVolume = false), 900)
    })
  }
  wireVolume($('topVol'), () => deck.source)
  wireVolume($('volume'), tabOf)
  // The little speaker by each volume slider mutes that music and brings it
  // back to where it was. Muted is simply the slider at nothing.
  for (const [slider, sourceOf] of [[$('topVol'), () => deck.source], [$('volume'), tabOf]]) {
    const picture = slider.parentElement.querySelector('.sl-ico')
    const mute = el('button', 'vol-mute')
    mute.type = 'button'
    picture.replaceWith(mute)
    mute.append(picture)
    mute.addEventListener('click', () => {
      const key = `volBefore-${sourceOf()}`

      if (Number(slider.value) > 0) {
        localStorage.setItem(key, slider.value)
        slider.value = '0'
      } else {
        slider.value = String(Math.max(5, Number(localStorage.getItem(key)) || 70))
      }
      slider.dispatchEvent(new Event('input'))
      slider.dispatchEvent(new Event('change'))
      putMutes()
    })
    slider.addEventListener('input', () => putMutes())
  }
  putMutes()
  const showTopPlayer = isOn => {
    document.body.classList.toggle('no-top-player', !isOn)
    $('topPlayerOn').checked = isOn
  }
  showTopPlayer(localStorage.getItem('topPlayer') !== '0')
  $('topPlayerOn').addEventListener('change', () => {
    localStorage.setItem('topPlayer', $('topPlayerOn').checked ? '1' : '0')
    showTopPlayer($('topPlayerOn').checked)
  })
  // The deck's own buttons act on the open tab, which becomes the live music.
  $('prev').addEventListener('click', () => {
    goLive(tabOf())
    stepSong(-1)
  })
  $('next').addEventListener('click', () => {
    goLive(tabOf())
    stepSong(1)
  })
  $('shuffleSongs').addEventListener('click', () => {
    deck.isShuffle = !deck.isShuffle
    renderDeck()
  })
  wireWidgets()
  // The top player's size, kept for this window.
  const sizeOf = () => (['s', 'm', 'l'].includes(localStorage.getItem('playerSize')) ? localStorage.getItem('playerSize') : 'm')
  const putSize = () => {
    for (const one of ['s', 'm', 'l']) {
      document.body.classList.toggle(`player-${one}`, one === sizeOf())
    }
    $('topPlayerSize').value = sizeOf()
  }
  $('topPlayerSize').addEventListener('click', event => event.stopPropagation())
  $('topPlayerSize').addEventListener('change', () => {
    localStorage.setItem('playerSize', $('topPlayerSize').value)
    putSize()
  })
  putSize()
  // The spectrum in the button row is drawn as wide, and as tall, as the room it has.
  new ResizeObserver(([entry]) => {
    const width = Math.max(60, Math.round(entry.contentRect.width))
    const height = Math.max(20, Math.round(entry.contentRect.height))

    if ($('brandEq').width !== width || $('brandEq').height !== height) {
      $('brandEq').width = width
      $('brandEq').height = height
      isSpectrumStale = true
    }
  }).observe(document.querySelector('.top-eq'))
  // The picture toolbar's extra buttons press the title bar's own.
  for (const [from, to] of [['tbTheme', 'themesBtn'], ['tbSettings', 'settingsBtn'], ['tbHelp', 'guidesBtn']]) {
    $(from).addEventListener('click', () => $(to).click())
  }
  $('compactBtn').addEventListener('click', () => {
    const project = active()

    if (project && !$('compactBtn').disabled && confirm(`Compact the chat in "${project.name}"?\n\nClaude Code summarizes everything so far to free up context. Claude keeps the gist, not the word-for-word detail of older messages. This cannot be undone, and it uses a little of your plan.`)) {
      void call('project:send', project.id, '/compact')
    }
  })
  const topSeek = $('topSeek')
  topSeek.addEventListener('input', () => {
    deck.isTopSeeking = true
    $('topPos').textContent = clock((Number(topSeek.value) / 1000) * deck.dur)
  })
  topSeek.addEventListener('change', () => {
    if (deck.dur > 0) {
      const to = Math.min(deck.dur - 1, (Number(topSeek.value) / 1000) * deck.dur)
      void deckCmd(deck.source !== 'files' ? 'web-seek' : 'seek', to.toFixed(1))
    }
    // Hold the knob where it was dropped until the deck has caught up.
    setTimeout(() => (deck.isTopSeeking = false), 700)
  })
  const seek = $('seek')
  seek.addEventListener('input', () => {
    deck.isSeeking = true
    $('pos').textContent = clock((Number(seek.value) / 1000) * deck.tabDur)
  })
  seek.addEventListener('change', () => {
    if (deck.tabDur > 0 && tabOf() === deck.source) {
      const to = Math.min(deck.tabDur - 1, (Number(seek.value) / 1000) * deck.tabDur)
      void deckCmd(deck.source !== 'files' ? 'web-seek' : 'seek', to.toFixed(1))
    }
    // Hold the knob where it was dropped until the deck has caught up.
    setTimeout(() => (deck.isSeeking = false), 700)
  })
  $('randomSong').addEventListener('click', randomSong)
  $('songSearch').addEventListener('input', filterSongs)
  $('songArtist').addEventListener('change', filterSongs)
  $('songGenre').addEventListener('change', filterSongs)
  $('songGroup').addEventListener('change', filterSongs)
  $('songAlbum').addEventListener('change', filterSongs)
  renderSongCols()
  $('songColsBtn').addEventListener('click', () => $('songColsBox').classList.toggle('hidden'))
  $('queueClear').addEventListener('click', () => {
    deck.queue = []
    renderDeck()
  })
  $('addMusic').addEventListener('click', async () => setLibrary(await call('music:add')))
  $('importPlaylist').addEventListener('click', async () => {
    const list = await call('music:playlist')

    if (list?.error) {
      engine.said = list.error
      renderEngine()
    } else if (list) {
      // The playlist is kept, and its songs are put in the list; with nothing playing, the first one starts.
      deck.playlist = list.picked ?? ''
      localStorage.setItem('songPlaylist', deck.playlist)
      setLibrary(list)

      if (deck.state === 'stopped' && deck.source === 'files' && deck.playlist !== '' && deck.files.length > 0) {
        playSong(deck.files[0])
      }
    }
  })

  // --- floating video
  const video = $('videoWin')
  // The floating video player has no button any more; it stays for videos opened from the chat.
  $('video')?.addEventListener('click', async () => {
    const picked = await call('pick:video')

    if (picked) {
      $('videoEl').src = picked.url
      $('videoName').textContent = picked.name
      video.classList.remove('hidden')
      void $('videoEl').play()
    }
  })
  $('videoClose').addEventListener('click', () => {
    $('videoEl').pause()
    $('videoEl').removeAttribute('src')
    video.classList.add('hidden')
  })
  video.querySelector('.video-bar').addEventListener('pointerdown', down => {
    if (down.target.closest('button')) {
      return
    }

    const box = video.getBoundingClientRect()
    const bar = down.currentTarget
    bar.setPointerCapture(down.pointerId)
    const move = event => {
      video.style.left = `${Math.max(0, box.left + event.clientX - down.clientX)}px`
      video.style.top = `${Math.max(0, box.top + event.clientY - down.clientY)}px`
      video.style.right = 'auto'
      video.style.bottom = 'auto'
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', () => bar.removeEventListener('pointermove', move), { once: true })
  })
}

// ----------------------------------------------------------------------- demo

const loadDemo = () => {
  const rows = [
    ['sidebar-revamp', 'Fix, polish, ship', 'working'],
    ['doc-generator', 'Update docs + examples', 'waiting'],
    ['test-suite', 'Add coverage for new API', 'complete'],
    ['refactor-tools', 'Cleanup + modularize', 'working'],
    ['deploy-staging', 'Push to staging + smoke test', 'waiting'],
    ['bug-bash', 'Triage 7 open issues', 'attention'],
    ['research-rag', 'Evaluate retrieval options', 'complete'],
  ]

  for (const [name, detail, status] of rows) {
    addProject({ id: name, name, cwd: `C:\\work\\${name}`, mode: 'default', status, detail, queue: [], agents: 0, contextWindow: 204800, hasSession: true })
  }

  const project = projects.get('sidebar-revamp')
  const start = Date.now() - 154000
  project.isLoaded = true
  project.branch = 'feature/sidebar-fix'
  project.queue = ['Add tests for the status badge', 'Update the changelog']
  const events = [
    { t: 'user', ts: start, text: 'Fix the sidebar status indicators, make them more informative, and add a retro media-player vibe.' },
    {
      t: 'assistant',
      ts: start + 60000,
      isMain: true,
      usage: { input: 5200, cacheRead: 118000, cacheWrite: 24256, output: 1900 },
      blocks: [
        { type: 'text', text: "On it. I'll update the sidebar with clear status indicators and keep the workflow features.\n\n```tsx\nconst StatusBadge = ({ status }: { status: Status }) => (\n  <span className={`badge badge--${status}`}>\n    {STATUS_LABELS[status]}\n  </span>\n);\n```" },
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/sidebar.tsx', old_string: '<span>{status}</span>', new_string: '<StatusBadge status={status} />' } },
      ],
    },
    { t: 'tool_result', ts: start + 61000, id: 't1', text: 'The file src/sidebar.tsx has been updated.', isError: false, isMain: true },
    {
      t: 'assistant',
      ts: start + 62000,
      isMain: true,
      blocks: [
        { type: 'thinking', text: 'The badge needs a label per status. Tests cover the old markup, so they need a look too.' },
        { type: 'tool_use', id: 'k1', name: 'TaskCreate', input: { subject: 'Add the status badge' } },
        { type: 'tool_use', id: 'k2', name: 'TaskCreate', input: { subject: 'Update the sidebar tests' } },
        { type: 'tool_use', id: 'k3', name: 'TaskCreate', input: { subject: 'Run the test suite' } },
      ],
    },
    { t: 'tool_result', ts: start + 62500, id: 'k1', text: 'Task #1 created successfully', isError: false, isMain: true },
    { t: 'tool_result', ts: start + 62600, id: 'k2', text: 'Task #2 created successfully', isError: false, isMain: true },
    { t: 'tool_result', ts: start + 62700, id: 'k3', text: 'Task #3 created successfully', isError: false, isMain: true },
    {
      t: 'assistant',
      ts: start + 63000,
      isMain: true,
      blocks: [
        { type: 'tool_use', id: 'k4', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
        { type: 'tool_use', id: 'k5', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } },
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git status --short', description: 'Show changed files' } },
        { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'npm run lint', description: 'Lint the sidebar' } },
        { type: 'tool_use', id: 'b3', name: 'Bash', input: { command: 'npm run build', description: 'Build the app' } },
      ],
    },
    { t: 'tool_result', ts: start + 64000, id: 'b1', text: ' M src/sidebar.tsx', isError: false, isMain: true },
    { t: 'tool_result', ts: start + 65000, id: 'b2', text: 'No problems found.', isError: false, isMain: true },
    { t: 'tool_result', ts: start + 66000, id: 'b3', text: 'Built in 4.2 s.', isError: false, isMain: true },
    {
      t: 'assistant',
      ts: Date.now() - 87000,
      isMain: true,
      blocks: [
        { type: 'text', text: 'The badge is in. Running the sidebar tests now.' },
        { type: 'tool_use', id: 'b4', name: 'Bash', input: { command: 'npm test -- sidebar', description: 'Running the sidebar tests' } },
      ],
    },
  ]

  for (const event of events) {
    apply(project, event)
  }
  project.startedAt = start
  project.detail = 'Updating status indicators'
  project.subs = [{ id: 's1', name: 'Check badge contrast', kind: 'Explore', status: 'working' }]
  deck.library = [
    ['Night Drive', 'The Deck', 'Synthwave'],
    ['Glass Arcade', 'The Deck', 'Synthwave'],
    ['Second Sun', 'Other Band', 'Ambient'],
    ['Low Tide', 'Other Band', 'Ambient'],
    ['Paper Planes', 'Third Act', 'Rock'],
  ].map(([title, artist, genre]) => ({ path: title, name: `${artist} - ${title}`, title, artist, album: '', genre, folder: 'Music', group: artist }))
  deck.folders = ['C:\\Users\\you\\Music', 'D:\\Albums']
  deck.now = deck.library[0]
  deck.queue = [deck.library[2], deck.library[4]]
  deck.state = 'playing'
  deck.pos = 74
  deck.dur = 215
  $('pos').textContent = clock(74)
  $('dur').textContent = clock(215)
  $('seek').value = '344'
  filterSongs()
  void select('sidebar-revamp')
}

// ------------------------------------------------------------------ dictation

/**
 * The microphone button: while it is on, a helper listens with Windows' own
 * speech recogniser and each phrase it hears is added to the message.
 */
let isDictating = false

const renderMic = note => {
  $('mic').classList.toggle('on', isDictating)
  $('micNote').textContent = note ?? (isDictating ? 'Listening... click the microphone to stop.' : '')
}

const onDictate = heard => {
  if (heard.text) {
    const input = $('input')
    input.value = `${input.value}${input.value && !/\s$/.test(input.value) ? ' ' : ''}${heard.text}`
    input.dispatchEvent(new Event('input'))
  }

  if (heard.error || heard.done) {
    isDictating = false
    renderMic(heard.error ?? '')
  }
}

const toggleMic = async () => {
  if (isDictating) {
    isDictating = false
    renderMic()
    await call('dictate:stop')

    return
  }

  isDictating = true
  renderMic('Starting the microphone...')
  const started = await call('dictate:start')

  if (started?.error) {
    isDictating = false
    renderMic(started.error)
  }
}

// --------------------------------------------------------------- live updates

/**
 * The app's files changed on disk while it was open. Styles and skins are
 * read again at once; changed page code or app code shows a chip in the
 * title bar, because reloading is the person's call.
 */
const updates = { page: false, app: false, isWaiting: false }

const renderUpdate = () => {
  const chip = $('update')
  chip.classList.toggle('hidden', !updates.page && !updates.app)
  chip.textContent = updates.isWaiting ? 'Restarts when work is done' : updates.app ? 'Restart to update' : 'Reload to update'
  chip.title = updates.isWaiting
    ? 'Cla-Amp restarts by itself once every chat here has finished. Click to change that.'
    : updates.app
      ? "Cla-Amp's own code changed. Click to close and reopen it. If a chat is working, you choose: wait for it to finish, or restart now and have it carry on afterwards."
      : "Cla-Amp's window code changed. Click to reload the window. Chats keep running and your unsent message is kept."
}

const onUpdate = async ({ kind }) => {
  if (kind === 'styles') {
    const stamp = `?v=${Date.now()}`
    const main = document.querySelector('link[href^="styles.css"]')

    if (main) {
      main.addEventListener('load', () => readTheme(), { once: true })
      main.href = `styles.css${stamp}`
    }

    const current = skins.find(one => one.url === skinHref())?.id
    skinStamp = stamp
    await loadSkins(current)

    return
  }

  if (kind === 'page' || kind === 'app' || kind === 'waiting') {
    updates.isWaiting = kind === 'waiting'
    updates[kind === 'waiting' ? 'app' : kind] = true
    renderUpdate()
  }
}

const takeUpdate = () => {
  if (updates.app) {
    // With work going on, the app asks: wait for it, or restart now and carry on.
    void call('app:restart')

    return
  }

  sessionStorage.setItem('draft', $('input').value)
  void call('app:reload')
}

// ---------------------------------------------------------------------- start

const start = async () => {
  wire()
  $('update').addEventListener('click', takeUpdate)
  $('mic').addEventListener('click', () => void toggleMic())
  window.amp.on('amp:dictate', heard => {
    if (heard.ready && isDictating) {
      renderMic()
    }
    onDictate(heard)
  })
  window.amp.on('amp:update', update => void onUpdate(update))

  // A message being written when the window was reloaded for an update.
  if (sessionStorage.getItem('draft')) {
    $('input').value = sessionStorage.getItem('draft')
    sessionStorage.removeItem('draft')
  }
  requestAnimationFrame(animate)
  setInterval(renderNow, 1000)

  // The bell: Cla-Amp's own sounds, on or muted. The flash stays as it is set.
  putChime()
  $('chimeBtn').addEventListener('click', () => {
    setNotices(noticeChoice() === 'all' ? 'flash' : 'all')
    putChime()
    chime()
    announce(noticeChoice() === 'all' ? 'Sounds on' : 'Sounds muted')
  })

  if (isDemo) {
    loadDemo()
    renderDeck()
    void loadPlugins()

    return
  }

  const loaded = await call('state:load')

  for (const info of loaded.projects) {
    addProject(info)
  }

  window.amp.on('amp:event', event => {
    const project = projects.get(event.projectId)

    if (!project) {
      return
    }

    // Another app added to this conversation: show it as it now stands.
    if (event.t === 'reload') {
      if (project.isLoaded) {
        const chat = $('chat')
        const wasFollowing = isFollowingChat
        const keptTop = chat.scrollTop
        showConversation(project, event.events, false)

        if (project.id === activeId) {
          chatFor = null
          renderChat()

          // Someone reading further up stays where they were.
          if (!wasFollowing) {
            chat.scrollTop = keptTop
            chatTop = chat.scrollTop
            setFollow(false)
          }
        }
      }

      return
    }

    // A project not opened yet reads these from its saved transcript later.
    if (project.isLoaded || event.t === 'status' || event.t === 'init') {
      apply(project, event)
    }

    if (event.t === 'delta') {
      if (project.id === activeId) {
        queuePaint()
      }

      return
    }

    if (event.t === 'permission') {
      announce(`Claude asks to use ${event.tool} in ${project.name}`, true)
      flash()
      tell(project, 'asks')
    } else if (event.t === 'result') {
      flash()
      tell(project, event.isOk === false ? 'failed' : 'done')
      chime(event.isOk !== false)
      announce(event.isOk === false ? `${project.name}: the reply ended with an error` : `${project.name}: Claude finished replying`)
    }

    if (event.t === 'result' && !event.isOk && /not signed in/i.test(event.error ?? '')) {
      void checkSignIn()
    }

    // A reply spent some of the plan: read the limits again.
    if ((event.t === 'result' || event.t === 'limit') && project.id === activeId) {
      void loadUsage()

      if (event.t === 'result') {
        void loadContext()
      }

      if (event.t === 'limit') {
        return
      }
    }

    if (event.t === 'init' && project.id === activeId) {
      renderEngine()
    }

    if (project.id === activeId) {
      renderChat()
    }
    renderProjects()
    renderStatus()
    renderNow()
  })
  window.amp.on('amp:deck', onDeck)

  void checkSignIn()
  void loadSkins(loaded.prefs.skin)
  void startLook()
  buildEqualizer($('eqBox'))
  $('lookBtn').addEventListener('click', () => openLook())
  $('themesBtn').addEventListener('click', () => void openThemes())
  $('aboutBtn').addEventListener('click', () => void openAbout())
  void loadPlugins()
  // The plan is also used by other apps and chats, so the limits are read again every minute.
  setInterval(() => void loadUsage(), 60 * 1000)

  for (const id of Array.isArray(loaded.prefs.pins) ? loaded.prefs.pins : []) {
    pins.add(id)
  }
  setLibrary(await call('music:scan'))

  // The window is never narrower than its columns need: the side columns
  // at their widths, and room for the chat between them.
  let leastTimer = null
  let leastSaid = 0
  const tellLeast = () => {
    clearTimeout(leastTimer)
    leastTimer = setTimeout(() => {
      const sides = ['left', 'right', 'right2'].reduce((sum, id) => sum + ($(id).offsetWidth > 0 ? $(id).offsetWidth + 10 : 0), 0)
      const least = sides + CHAT_LEAST + 24

      if (least !== leastSaid) {
        leastSaid = least
        void call('win:least', least)
      }
    }, 150)
  }
  const sized = new ResizeObserver(tellLeast)

  for (const id of ['left', 'right', 'right2']) {
    sized.observe($(id))
  }
  tellLeast()

  // Claude in Chrome: one switch for the whole app, read when a chat starts.
  $('useChrome').checked = loaded.prefs.useChrome === true
  $('useChrome').addEventListener('change', () => {
    void call('prefs:set', 'useChrome', $('useChrome').checked)
    $('useChromeHint').textContent = $('useChrome').checked ? 'on from your next new chat, or after a restart' : 'off from your next new chat, or after a restart'
  })

  if (typeof loaded.prefs.volume === 'number') {
    void deckCmd('vol', loaded.prefs.volume.toFixed(2))
  }
  renderDeck()
  // Stay awake: as it was left.
  const putAwake = isOn => {
    $('awakeBtn').classList.toggle('on', isOn)
    $('awakeBtn').textContent = isOn ? 'Staying awake' : 'Stay awake'
  }
  putAwake(loaded.prefs.keepAwake === true)
  $('awakeBtn').addEventListener('click', async () => {
    const isOn = (await call('awake:set', !$('awakeBtn').classList.contains('on'))) === true
    putAwake(isOn)
    announce(isOn ? 'The computer will stay awake' : 'The computer may sleep again')
  })
  // The tab that was open last time.
  document.querySelector(`.tab[data-tab="${localStorage.getItem('tab') ?? ''}"]:not(.active)`)?.click()
  const remembered = localStorage.getItem('active')
  await select(projects.has(remembered) ? remembered : (projects.keys().next().value ?? null))
}

void start()
