// Cla-Amp's window: projects on the left, the chat in the middle, meters and
// the music deck on the right. The main process runs the sessions and sends
// events; this file turns them into what is on screen.
import hljs from '../node_modules/@highlightjs/cdn-assets/es/highlight.min.js'
import DOMPurify from '../node_modules/dompurify/dist/purify.es.mjs'
import { marked } from '../node_modules/marked/lib/marked.esm.js'

import { openAbout } from './about.js'
import { buildEqualizer, tuner } from './equalizer.js'
import { openGuides } from './guides.js'
import { openLook, startLook } from './look.js'
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

const select = async id => {
  activeId = id
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
      project.items.push({ kind: 'user', ts: event.ts, text: event.text })
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
        project.subs.push({ id: event.id, name: event.name || 'Agent', kind: event.kind || 'agent', status: 'working', isBackground: true })
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

// The one class a reply keeps: a code block's language, for the colouring.
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'class' && node.nodeName === 'CODE' && /^language-[\w+#.-]{1,30}$/.test(data.attrValue)) {
    data.forceKeepAttr = true
  }
})

const markdown = text => {
  const holder = el('div', 'msg-body')
  holder.innerHTML = DOMPurify.sanitize(marked.parse(String(text ?? ''), { gfm: true, breaks: false }), CLEAN)

  // A link's words can differ from where it leads: the address shows on hover.
  for (const link of holder.querySelectorAll('a[href]')) {
    link.title = link.getAttribute('href')
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
  group.open = first.isGroupOpen === true
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
    picture.title = `${toolSays(part)}. Click to see it larger or smaller.`
    picture.addEventListener('click', () => picture.classList.toggle('big'))
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
      showConversation(project, opened.events)
      project.items.push({ kind: 'note', text: 'Forked: this is a new chat that holds the old one up to the reply you chose. The chat you forked from is unchanged and still in the Code tab.' })
      openChatId = opened.forkId ?? openChatId
      renderChat()
      $('chat').scrollTop = $('chat').scrollHeight
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

const paintTool = part => {
  const box = el('details', `tool own${part.isDone ? (part.isError ? ' failed' : ' done') : ' running'}`)
  const summary = el('summary')
  // A command still running shows what it is doing; once done it folds, unless the person opened it.
  box.open = part.isOpen ?? (!part.isDone && typeof part.input.command === 'string')
  summary.addEventListener('click', () => (part.isOpen = !box.open))
  summary.append(el('b', '', part.name), el('span', '', toolSays(part)))
  summary.append(el('i', '', part.isDone ? (part.isError ? '\u2717' : '\u2713') : '\u2026'))
  box.append(summary)
  const input = part.input

  if (part.name === 'Edit' && typeof input.old_string === 'string') {
    box.append(el('pre', 'del', input.old_string.slice(0, 4000)), el('pre', 'add', String(input.new_string ?? '').slice(0, 4000)))
  } else if (part.name === 'Write' && typeof input.content === 'string') {
    box.append(el('pre', 'add', input.content.slice(0, 6000)))
  } else if (typeof input.command === 'string') {
    box.append(el('pre', '', `$ ${input.command}`))
  } else {
    box.append(el('pre', '', JSON.stringify(input, null, 2).slice(0, 4000)))
  }

  if (part.result) {
    box.append(el('pre', '', part.result.slice(0, 6000)))
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
    show(input.old_string, 'del')
    show(input.new_string ?? '', 'add')
  } else if (typeof input.file_path === 'string' && typeof input.content === 'string') {
    show(input.file_path)
    show(input.content, 'add')
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

    if (!isBeingWritten && !item.parts.some(part => part.isLive) && replyText(item).trim() !== '') {
      main.append(paintActions(item))
    }
  }

  return row
}

let chatFor = null

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

  if (chatFor !== activeId) {
    chatFor = activeId
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
  const isAtEnd = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80

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
      item.node.replaceWith(fresh)
      item.node = fresh
      item.isDirty = false
    }
  }

  renderTail()
  renderPins()

  if (isAtEnd) {
    chat.scrollTop = chat.scrollHeight
  }
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

const renderProjects = () => {
  const list = $('projectList')
  list.replaceChildren()

  if (projects.size === 0) {
    list.append(el('div', 'empty', 'No projects yet. Add a folder below.'))
  }

  for (const project of projects.values()) {
    const row = el('div', `proj${project.id === activeId ? ' active' : ''}`)
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
    list.append(row)

    for (const sub of project.subs) {
      const child = el('div', 'proj sub')
      const words = el('div', 'proj-text')
      words.append(el('div', 'proj-name', sub.name), el('div', 'proj-detail', sub.kind))
      child.append(el('div', 'proj-ico agent'), words, el('span', `badge ${sub.status}`, BADGES[sub.status]))
      list.append(child)
    }
  }

  const queue = $('queueList')
  queue.replaceChildren()
  const waiting = active()?.queue ?? []

  if (waiting.length === 0) {
    queue.append(el('div', 'empty', 'Nothing queued. Messages you send while Claude is working wait here.'))
  }
  waiting.forEach((text, index) => {
    const row = el('div', 'q-item')
    const drop = el('button', '', '\u2715')
    drop.addEventListener('click', () => void call('queue:remove', activeId, index))
    row.append(el('b', '', `${index + 1}.`), el('span', '', text), drop)
    queue.append(row)
  })
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
  void select(project.id).then(() => ($('chat').scrollTop = $('chat').scrollHeight))
}

const openSavedChat = async chat => {
  // The row lights up at once: a long chat's first read can take a few seconds.
  const before = openChatId
  openChatId = chat.id
  document.body.classList.add('opening')

  if (tab === 'chats') {
    renderChats()
  }

  const opened = await call('chats:open', chat.id, chat.cwd)
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
  showConversation(projects.get(opened.project.id) ?? addProject(opened.project), opened.events)
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
      box.append(row)
    }

    if (chats.length > most) {
      const more = el('div', 'more', `Show ${chats.length - most} more`)
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
      rows.push(row('work-row', one.name, 'Cla-Amp', one.detail || 'Working', () => void select(one.id)))
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
  setMeter($('contextMeter'), part)
  setMeter($('tokMeter'), part)
  $('tokHead').textContent = percent === '--' ? 'Nothing used yet' : `${percent} used`
  $('tokUsed').textContent = used > 0 ? kilo(used) : '--'
  $('tokLimit').textContent = limit > 0 ? kilo(limit) : '--'
  $('tokUsed').parentElement.title = limit > 0 ? `${count(used)} of ${count(limit)} tokens, from the last reply` : 'The limit is known after the first reply'
  $('tokLeft').textContent = limit > 0 && used > 0 ? kilo(Math.max(0, limit - used)) : '--'
  $('branch').textContent = project?.branch || '--'
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
      { label: 'Week, all models', percent: 38, resetsAt: new Date(Date.now() + 62 * 3600000).toISOString() },
      { label: 'Week, Fable', percent: 26, resetsAt: new Date(Date.now() + 62 * 3600000).toISOString() },
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
const usageRing = left => {
  const ring = el('div', `ring${left < 10 ? ' low' : left < 25 ? ' mid' : ''}`)
  const round = 2 * Math.PI * 16
  ring.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle class="ring-back" cx="20" cy="20" r="16"/><circle class="ring-fill" cx="20" cy="20" r="16" stroke-dasharray="${((round * left) / 100).toFixed(1)} ${round.toFixed(1)}" transform="rotate(-90 20 20)"/></svg>`
  ring.append(el('b', '', `${Math.round(left)}%`))

  return ring
}

const renderLimits = () => {
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
      // The ring and its number say what is left; the line under the name says what is used.
      const used = Math.min(100, Math.max(0, row.percent ?? 0))
      const one = el('div', 'limit')
      const words = el('div', 'limit-words')
      words.append(
        el('span', 'limit-name', row.label),
        el('small', '', row.percent === null ? 'Nothing used in this window yet' : `${Math.round(100 - used)}% left, ${Math.round(used)}% used`),
        el('small', '', row.percent === null ? '' : startsOver(row.resetsAt)),
      )
      one.title = row.percent === null ? `${row.label}: nothing used yet` : `${row.label}: ${Math.round(used)}% used, ${Math.round(100 - used)}% left. ${startsOver(row.resetsAt)}`
      one.append(usageRing(100 - used), words)
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
const loadEngine = async () => {
  const id = activeId
  clearTimeout(pendingTimer)
  pendingTries = 0

  if (engine.forId !== id) {
    engine.info = null
    engine.error = ''
    engine.said = ''
  }
  engine.forId = id

  if (!id) {
    renderEngineAll()

    return
  }

  renderEngineAll()
  const got = isDemo ? structuredClone(DEMO_INFO) : await call('session:info', id)

  if (activeId !== id) {
    return
  }

  if (!got || got.error) {
    engine.error = got?.error ?? 'Claude Code did not answer.'
  } else {
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
  playSong(others[Math.floor(Math.random() * others.length)] ?? deck.files[0])
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

/** Works out which songs the search box and the two filters leave. */
const filterSongs = () => {
  fillFilter($('songArtist'), 'All artists', deck.library.map(song => song.artist))
  fillFilter($('songGenre'), 'All genres', deck.library.map(song => song.genre))
  fillFilter($('songGroup'), 'All folders', deck.library.map(song => song.group))
  const words = $('songSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const artist = $('songArtist').value
  const genre = $('songGenre').value
  const group = $('songGroup').value
  deck.files = deck.library.filter(
    song => (!artist || song.artist === artist) && (!genre || song.genre === genre) && (!group || song.group === group) && words.every(word => songWords(song).includes(word)),
  )
  deck.listKey = ''
  renderDeck()
}

const setLibrary = scanned => {
  if (scanned) {
    deck.library = scanned.files
    deck.folders = scanned.folders
    filterSongs()
  }
}

const songRow = (song, { onPlay, button, onButton, title }) => {
  const row = el('div', 'song')
  const side = el('button', '', button)
  side.title = title
  side.addEventListener('click', event => {
    event.stopPropagation()
    onButton()
  })
  row.title = [song.name, song.album, song.genre].filter(Boolean).join(' \u00b7 ')
  row.append(el('span', '', song.name), el('small', '', song.genre || song.album || song.group), side)
  row.addEventListener('click', onPlay)

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
    const shown = deck.files.slice(0, 400)
    songs.replaceChildren(
      ...(deck.library.length === 0
        ? [el('div', 'empty', 'No music found. Add a folder below.')]
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
      deck.files.length === deck.library.length ? `${count(deck.library.length)}` : `${count(deck.files.length)} of ${count(deck.library.length)}`
  }

  ;[...songs.children].forEach((row, index) =>
    row.classList.toggle('active', deck.files[index] === deck.now && deck.now !== null && !isWeb && deck.state !== 'stopped'),
  )

  const queue = $('queue')
  $('queueCount').textContent = deck.queue.length > 0 ? String(deck.queue.length) : ''
  $('queueClear').classList.toggle('hidden', deck.queue.length === 0)
  queue.replaceChildren(
    ...(deck.queue.length === 0
      ? [el('div', 'empty', 'Nothing queued. Press + on a song, or import a playlist.')]
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
  }

  const frame = status.sp?.[status.sp.length - 1]

  if (frame) {
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
// window) and --toolbar (on: the picture toolbar and its extra buttons).
let sentGlass = ''
const skinExtras = () => {
  const look = getComputedStyle(document.documentElement)
  const glass = look.getPropertyValue('--window-glass').trim().toLowerCase()
  const kind = ['acrylic', 'mica', 'tabbed', 'clear'].includes(glass) ? glass : 'none'

  if (kind !== sentGlass) {
    sentGlass = kind
    void call('window:glass', kind).then(isOn => document.body.classList.toggle('glass', isOn === true))
  }
  document.body.classList.toggle('has-toolbar', look.getPropertyValue('--toolbar').trim() === 'on')
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
  renderWidgets()
}

/** Draws the widgets that are on show. Called every two seconds and when the chat changes. */
const renderWidgets = () => {
  const project = active()
  const now = new Date()

  if (isShown('time')) {
    const state = project?.status === 'working' ? 'Working' : project?.status === 'attention' ? 'Needs you' : elsewhere(project) ? 'Working in another app' : 'Idle'
    $('wgState').textContent = state
    $('wgOrb').className = `wg-orb ${state === 'Idle' ? '' : state === 'Needs you' ? 'ask' : 'busy'}`
    $('wgClock').textContent = timeIn(now)
    $('wgDate').textContent = `${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}  \u00B7  ${Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ')}`
    renderZones(now)
  }

  if (isShown('calendar')) {
    // This month, weeks starting on Sunday, today marked. Drawn again only when the day changes.
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`

    if ($('wgCal').dataset.day !== key) {
      $('wgCal').dataset.day = key
      $('wgMonth').textContent = `${MONTHS[now.getMonth()]} ${now.getFullYear()}`
      const first = new Date(now.getFullYear(), now.getMonth(), 1).getDay()
      const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
      const cells = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(name => el('i', '', name))

      for (let at = 0; at < first; at += 1) {
        cells.push(el('span', '', ''))
      }

      for (let day = 1; day <= days; day += 1) {
        cells.push(el('span', day === now.getDate() ? 'today' : '', String(day)))
      }
      $('wgCal').replaceChildren(...cells)
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
    menu.append(el('hr'), second)
    menu.classList.toggle('hidden')
  })
  document.addEventListener('click', event => {
    if (!event.target.closest('.wg-chooser')) {
      menu.classList.add('hidden')
    }
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

const submit = text => {
  const project = active()
  const words = text.trim()

  if (!project || words === '') {
    return
  }

  void call('project:send', project.id, words)
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
  const input = $('input')
  const send = () => {
    submit(input.value)
    input.value = ''
    input.style.height = 'auto'
  }
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
      send()
    }
  })
  input.addEventListener('blur', () => $('slashMenu').classList.add('hidden'))
  input.addEventListener('input', () => {
    slash.at = 0
    renderSlash()
    input.style.height = 'auto'
    input.style.height = `${Math.min(160, input.scrollHeight)}px`
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
      alert(`claude.ai was opened in ${opened.browser}, as an ordinary window. Docking needs Edge or Brave.`)
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
      project.mode = MODES[(at + 1) % MODES.length].id
      void call('project:mode', project.id, project.mode)
      renderStatus()
    }
  })
  $('newChat').addEventListener('click', async () => {
    const project = active()

    // A new chat never removes the one that was open: that stays saved, in the Chats tab.
    // Only when Claude is in the middle of working is there something to ask about.
    const isWorking = project?.status === 'working'

    if (project && (!isWorking || confirm('Claude is still working in this chat. Starting a new chat stops that work. The chat itself stays saved in the Chats tab. Start a new chat?'))) {
      await call('project:new', project.id)
      Object.assign(project, { items: [], current: null, usage: null, subs: [], hasSession: false, lastPrompt: '' })
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
      const row = el('div', `pick${one.isCurrent ? ' current' : ''}`)
      row.append(el('span', 'pick-title', one.title), el('span', 'pick-when', `${one.isCurrent ? 'open now' : ago(one.lastModified)}  ·  ${one.size > 1048576 ? `${Math.round(one.size / 1048576)} MB` : `${Math.max(1, Math.round(one.size / 1024))} KB`}`))
      row.addEventListener('click', async () => {
        list.replaceChildren(el('div', 'empty', 'Opening...'))
        const opened = await call('sessions:open', project.id, one.id)
        const events = opened?.events

        if (opened?.error) {
          alert(opened.error)
        }
        picker.classList.add('hidden')

        if (events) {
          Object.assign(project, { items: [], current: null, usage: null, subs: [], hasSession: true, lastPrompt: '', isLoaded: true })
          project.tools.clear()
          project.asks.clear()

          for (const event of events) {
            apply(project, event, true)
          }
          chatFor = null
          renderAll()
          $('chat').scrollTop = $('chat').scrollHeight
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
    splitter.addEventListener('pointerdown', down => {
      const side = splitter.dataset.side
      const column = $(side)
      const start = column.getBoundingClientRect().width
      splitter.setPointerCapture(down.pointerId)
      const move = event => {
        const delta = (event.clientX - down.clientX) * (side === 'left' ? 1 : -1)
        const width = Math.round(Math.min(560, Math.max(200, start + delta)))
        root.style.setProperty(`--${side}`, `${width}px`)
        localStorage.setItem(`width-${side}`, String(width))
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
  }
  document.body.classList.toggle('col2', localStorage.getItem('col2') === '1')

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

  if (localStorage.getItem('deckOnTop') !== '1') {
    localStorage.setItem('deckOnTop', '1')
    right.prepend(right.querySelector('[data-panel="deck"]'))
    savePanels()
  }

  right.append(document.querySelector('.wg-chooser'))
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
        column === right ? document.querySelector('.wg-chooser').before(dragged) : column.append(dragged)
        savePanels()
      }
    })
  }

  for (const panel of document.querySelectorAll('.cols .panel')) {
    const head = panel.querySelector('h3')
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
  // The spectrum in the button row is drawn as wide as the room it has.
  new ResizeObserver(([entry]) => {
    const width = Math.max(60, Math.round(entry.contentRect.width))

    if ($('brandEq').width !== width) {
      $('brandEq').width = width
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
      // A playlist's songs go to the end of Up next; with nothing playing, the first one starts.
      deck.queue.push(...list.files)

      if (deck.state === 'stopped' && deck.source === 'files') {
        stepSong(1)
      } else {
        renderDeck()
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
const updates = { page: false, app: false }

const renderUpdate = () => {
  const chip = $('update')
  chip.classList.toggle('hidden', !updates.page && !updates.app)
  chip.textContent = updates.app ? 'Restart to update' : 'Reload to update'
  chip.title = updates.app
    ? "Cla-Amp's own code changed. Click to close and reopen it. A chat that is working right now is stopped; nothing already said is lost."
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

  if (kind === 'page' || kind === 'app') {
    updates[kind] = true
    renderUpdate()
  }
}

const takeUpdate = () => {
  if (updates.app) {
    const isWorking = [...projects.values()].some(one => one.status === 'working')

    if (!isWorking || confirm('A chat is working right now. Restarting stops it. Restart anyway?')) {
      void call('app:restart')
    }

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
        const wasAtEnd = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80
        showConversation(project, event.events, false)

        if (project.id === activeId) {
          chatFor = null
          renderChat()

          if (wasAtEnd) {
            chat.scrollTop = chat.scrollHeight
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
  setInterval(() => void loadUsage(), 5 * 60 * 1000)

  for (const id of Array.isArray(loaded.prefs.pins) ? loaded.prefs.pins : []) {
    pins.add(id)
  }
  setLibrary(await call('music:scan'))

  if (typeof loaded.prefs.volume === 'number') {
    void deckCmd('vol', loaded.prefs.volume.toFixed(2))
  }
  renderDeck()
  const remembered = localStorage.getItem('active')
  await select(projects.has(remembered) ? remembered : (projects.keys().next().value ?? null))
}

void start()
