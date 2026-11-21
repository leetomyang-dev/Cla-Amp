// Cla-Amp's main process: the window, the saved state, one Claude Code
// session per project (through the Agent SDK), and the audio deck helper.
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { archiveSession, deleteSession, forkSession, getSessionInfo, getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, ipcMain, powerSaveBlocker, screen, session as webSession, shell } from 'electron'

import { describeSong, readCover, readPlaylist, scanFolders } from './music-library.mjs'
import { chatsFolder, countOutside, listOutside } from './outside-work.mjs'
import { readCapped, readCappedLater, readEndLater, readTail, sizeAndBytes } from './safe-read.mjs'
import { notesNewTo } from './whats-new.mjs'
import { convertWinampSkin } from './winamp-skin.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// The program had another name before. Its settings folder is carried over
// once, whole, under the new name, so nothing has to be set up again.
try {
  const now = app.getPath('userData')
  const before = path.join(path.dirname(now), ['Claude', 'Amp'].join(''))

  // Only for the real thing: never in the demo, and only when the earlier
  // folder holds settings and the new one holds none yet.
  const isWanted =
    !process.argv.includes('--demo') &&
    path.basename(now) === 'Cla-Amp' &&
    fs.existsSync(path.join(before, ['claude', 'amp.json'].join(''))) &&
    !fs.existsSync(path.join(now, 'claamp.json'))

  if (isWanted) {
    // A new folder without settings holds only what the window engine put there.
    fs.rmSync(now, { recursive: true, force: true })

    if (!fs.existsSync(now)) {
      fs.renameSync(before, now)

      for (const end of ['.json', '.json.bak']) {
        const old = path.join(now, ['claude', 'amp'].join('') + end)

        if (fs.existsSync(old) && !fs.existsSync(path.join(now, 'claamp' + end))) {
          fs.renameSync(old, path.join(now, 'claamp' + end))
        }
      }
    }
  }
} catch {
  dialog.showErrorBox('Cla-Amp', 'The earlier version of this program is still running. Close it and its player windows, then start Cla-Amp again.')
  app.exit(1)
}

// The window's own player (the equalizer's) is not offered to Windows as a
// media session: the deck would otherwise take it for another app's music.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService')
const IS_DEMO = process.argv.includes('--demo')
// The screenshot and scripted-test flags run only for a developer who set
// CLAAMP_DEV=1 and started the app from its source folder: a shortcut or a
// link that passes flags to an installed app gets nothing from them.
const IS_DEV = process.env.CLAAMP_DEV === '1' && !app.isPackaged
const SHOT = IS_DEV ? process.argv.find(arg => arg.startsWith('--shot='))?.slice(7) : undefined
// For the hidden screenshot test: how long to wait, and how tall a window.
const numberArg = (name, fallback) => Number(process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1]) || fallback
const AUDIO = /\.(mp3|wav|m4a|wma|flac|aac)$/i
// 'auto': Claude Code's own checker decides each step and asks the person only when it cannot.
const MODES = ['default', 'acceptEdits', 'auto', 'plan']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// A process started only to answer the panels is ended after this long idle.
const SLEEP_AFTER = 10 * 60 * 1000

// The copy of Claude Code that ships with the Agent SDK: the sessions run on
// it, and its own `auth` commands do the sign-in.
const CLAUDE_BIN = path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')

// Started from inside another Claude session, this app would inherit that
// session's private settings; Claude Code must not see them.
const childEnv = () => {
  const env = { ...process.env }

  if (env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDECODE) {
    for (const name of Object.keys(env)) {
      if (/^(CLAUDE|ANTHROPIC_BASE_URL|AI_AGENT|BAGGAGE)/i.test(name)) {
        delete env[name]
      }
    }
  }

  return env
}

const authStatus = () =>
  new Promise(resolve => {
    execFile(CLAUDE_BIN, ['auth', 'status'], { env: childEnv(), windowsHide: true, timeout: 20000 }, (_error, out) => {
      try {
        resolve({ isSignedIn: JSON.parse(out).loggedIn === true })
      } catch {
        resolve({ isSignedIn: false })
      }
    })
  })

// Models that cannot show their thinking as they go; learnt from the model list.
const plainModels = new Set()

let desktopRead = { at: 0, chats: new Map() }

/**
 * What the Claude desktop app saved for each of its chats: the model and the
 * effort the chat ran on, by conversation id. Read only; the files are the
 * desktop app's own and their layout is not documented, so anything
 * unexpected is skipped.
 */
const desktopChats = () => {
  if (Date.now() - desktopRead.at < 20000) {
    return desktopRead.chats
  }

  const chats = new Map()
  const roots = []

  try {
    const base = path.join(process.env.LOCALAPPDATA ?? '', 'Claude-Data')

    for (const name of fs.readdirSync(base)) {
      roots.push(path.join(base, name, 'claude-code-sessions'))
    }
  } catch {
    // No desktop app data in that place.
  }
  roots.push(path.join(process.env.APPDATA ?? '', 'Claude', 'claude-code-sessions'))

  const walk = (folder, depth) => {
    let entries = []

    try {
      entries = fs.readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(folder, entry.name)

      if (entry.isDirectory() && depth < 4) {
        walk(full, depth + 1)
      } else if (entry.isFile() && /^local_.*\.json$/.test(entry.name)) {
        try {
          const saved = JSON.parse(fs.readFileSync(full, 'utf8'))
          const at = Number(saved.lastActivityAt) || 0

          if (typeof saved.cliSessionId === 'string' && at >= (chats.get(saved.cliSessionId)?.at ?? 0)) {
            chats.set(saved.cliSessionId, {
              at,
              model: typeof saved.model === 'string' ? saved.model : null,
              effort: EFFORTS.includes(saved.effort) ? saved.effort : null,
            })
          }
        } catch {
          // A record being written, or one this app cannot read.
        }
      }
    }
  }

  for (const one of roots) {
    walk(one, 0)
  }
  desktopRead = { at: Date.now(), chats }

  return chats
}

/** Puts a project on the model and effort its chat has in the desktop app. */
const followDesktop = (project, sessionId) => {
  const original = Object.entries(state.copies ?? {}).find(([, copy]) => copy === sessionId)?.[0] ?? sessionId
  const saved = desktopChats().get(original)

  if (!saved) {
    return false
  }

  project.model = saved.model
  project.effort = saved.effort

  return true
}

/** Runs the bundled Claude Code with arguments and gives back what it printed. */
const claudeCli = args =>
  new Promise(resolve => {
    execFile(
      CLAUDE_BIN,
      args,
      { env: childEnv(), windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 },
      (error, out, err) => resolve({ isOk: !error, out: String(out ?? ''), err: String(err ?? '') }),
    )
  })

/** The plan's limits as rows for the Usage panel: each a share used and when it starts over. */
const shapeUsage = usage => {
  const limits = usage?.rate_limits

  if (!usage?.rate_limits_available || !limits) {
    return { isAvailable: false, plan: usage?.subscription_type ?? null, rows: [] }
  }

  const rows = []
  const add = (label, percent, resetsAt, isAlways = false) => {
    const isKnown = typeof percent === 'number'

    if ((isKnown || isAlways) && !rows.some(row => row.label === label)) {
      rows.push({ label, percent: isKnown ? percent : null, resetsAt: resetsAt ?? null })
    }
  }
  // Not every plan has a 5-hour window: the row shows only when the plan reports one.
  add('5-hour session', limits.five_hour?.utilization, limits.five_hour?.resets_at, limits.five_hour !== null && limits.five_hour !== undefined)
  add('Week, all models', limits.seven_day?.utilization, limits.seven_day?.resets_at, true)

  // One weekly row per model the plan counts on its own (Fable, for one).
  for (const one of Array.isArray(limits.limits) ? limits.limits : []) {
    const name = one?.scope?.model?.display_name

    if (one?.kind === 'weekly_scoped' && name) {
      add(`Week, ${name}`, one.percent, one.resets_at)
    }
  }

  for (const one of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    add(`Week, ${one.display_name}`, one.utilization, one.resets_at)
  }
  add('Week, Opus', limits.seven_day_opus?.utilization, limits.seven_day_opus?.resets_at)
  add('Week, Sonnet', limits.seven_day_sonnet?.utilization, limits.seven_day_sonnet?.resets_at)

  // Extra usage: credits bought on top of the plan. The row shows when the
  // account has it switched on, or has an amount to report. Amounts come in
  // the currency's small unit (cents) and are passed on as they are.
  const extra = limits.extra_usage
  const amount = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
  const spent = amount(extra?.used_credits)
  const cap = amount(extra?.monthly_limit)

  if (extra?.is_enabled || spent !== null || cap !== null) {
    const share = typeof extra.utilization === 'number' ? extra.utilization : spent !== null && cap !== null && cap > 0 ? (spent / cap) * 100 : null
    add('Extra usage credits', share, null, true)
    const row = rows.find(one => one.label === 'Extra usage credits')
    row.money = { used: spent, limit: cap, currency: typeof extra.currency === 'string' && /^[A-Za-z]{3}$/.test(extra.currency) ? extra.currency.toUpperCase() : 'USD', isOn: extra.is_enabled === true }
  }

  return { isAvailable: true, plan: usage.subscription_type ?? null, rows }
}

const shapeServers = servers =>
  (servers ?? []).map(one => ({
    name: one.name,
    status: one.status,
    scope: one.scope ?? '',
    isClaudeAi: one.config?.type === 'claudeai-proxy' || one.scope === 'claudeai',
    tools: one.tools?.length ?? 0,
    error: one.error ?? '',
  }))

let win = null

// ---------------------------------------------------------------- saved state

const dataDir = () => app.getPath('userData')
const stateFile = () => path.join(dataDir(), 'claamp.json')
const transcriptFile = id => path.join(dataDir(), 'transcripts', `${id}.jsonl`)

let state = { projects: [], prefs: {} }

const loadState = () => {
  try {
    state = { projects: [], prefs: {}, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }
  } catch {
    state = { projects: [], prefs: {} }
  }
}

// Where a Winamp skin may be fetched from by its link: the Winamp Skin
// Museum's pages name the skin, its file store holds it.
const SKIN_STORE = 'r2.webampskins.org'
const SKIN_SITES = ['skins.webamp.org', SKIN_STORE]

/** Turns a Winamp skin file's bytes into a skin in the person's skins folder. */
const keepWinampSkin = (bytes, name) => {
  const made = convertWinampSkin(bytes, name)
  const slug =
    made.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'skin'
  const folder = path.join(userSkins(), `winamp-${slug}`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'skin.css'), made.css)
  fs.writeFileSync(path.join(folder, 'skin.json'), made.json)

  for (const [file, data] of Object.entries(made.files ?? {})) {
    fs.writeFileSync(path.join(folder, file), data)
  }

  return { id: `mine/winamp-${slug}`, name: made.name }
}

// Whether this run's window was made see-through (clear glass).
let isClearWindow = false

const saveState = () => {
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))
}

const appendTranscript = (id, event) => {
  const file = transcriptFile(id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFile(file, `${JSON.stringify(event)}\n`, () => {})
}

const readTranscript = id => {
  try {
    return fs
      .readFileSync(transcriptFile(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-3000)
      .map(line => JSON.parse(line))
  } catch {
    return []
  }
}

// The demo (--demo) is for pictures and for trying the window out. It must
// show nothing of the person's: no account, chats, settings, themes or music,
// and it must change nothing they keep. So the main process itself answers
// the demo window with made-up values, whatever part of the window asks.
// Only these calls do their real work there: they read nothing personal.
const DEMO_REAL = new Set(['about:info', 'update:check', 'docs:read', 'app:reload', 'win', 'win:least', 'window:glass', 'zoom:set', 'text:copy', 'outside:state'])
const DEMO_SAYS = {
  'settings:read': () => ({ account: { isSignedIn: true, email: 'you@example.com', organization: 'Example', plan: 'max', method: 'Claude subscription' }, files: [] }),
  'look:get': () => ({}),
  'themes:list': () => [],
  // The skins that come with the app, never the person's own.
  'skins:list': () => listSkins().filter(one => !one.isOwn).map(({ sheet: _sheet, ...skin }) => skin),
}
// What the main process tells the window by itself: only that its code changed.
const DEMO_HEARS = new Set(['amp:update'])

const send = (channel, payload) => {
  if (IS_DEMO && !DEMO_HEARS.has(channel)) {
    return
  }

  if (win !== null && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

// ------------------------------------------------------------------- sessions

const flatten = content => {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map(block => (block.type === 'text' ? block.text : block.type === 'image' ? '[image]' : ''))
    .join('\n')
}

/**
 * The pictures in a tool's answer (a screenshot, an image file Claude read),
 * saved once each in this app's own pictures folder and given as addresses
 * the chat can show. Only the four common picture kinds, at most six a time.
 */
const PICTURE_KINDS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
// Files the person attached to a message. Pictures small enough are shown to
// Claude directly; every file is also named by its path, for Claude to read.
// Any number of files can go with a message. Only so many pictures are shown to Claude
// directly in one message (the service limits that); the rest go by their path like other files.
const ATTACH_PICTURES_MOST = 20
const ATTACH_PICTURE_BYTES = 3500000
const PICTURE_ENDS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

/** Only full paths of things that exist, each once. */
const cleanFiles = files => {
  const found = []

  for (const one of Array.isArray(files) ? files : []) {
    if (typeof one === 'string' && one.length < 1000 && path.isAbsolute(one) && !found.includes(one) && fs.existsSync(one)) {
      found.push(one)
    }
  }

  return found
}

/** A prompt is its text, or { text, files } when files are attached. */
const promptLine = prompt => (typeof prompt === 'string' ? prompt : `${prompt.text || '(files only)'}  [+${prompt.files.length} ${prompt.files.length === 1 ? 'file' : 'files'}]`)

/** What goes to Claude for a prompt: plain text, or text and picture blocks. */
const promptContent = prompt => {
  if (typeof prompt === 'string') {
    return prompt
  }

  const list = prompt.files.map(one => `- ${one}`).join('\n')
  const blocks = [{ type: 'text', text: `${prompt.text}${prompt.text ? '\n\n' : ''}Attached files:\n${list}` }]

  for (const one of prompt.files) {
    const kind = PICTURE_ENDS[path.extname(one).toLowerCase()]

    try {
      const bytes = kind && blocks.length <= ATTACH_PICTURES_MOST ? readCapped(one, ATTACH_PICTURE_BYTES) : null

      if (bytes !== null) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: kind, data: bytes.toString('base64') } })
      }
    } catch {
      // A picture that cannot be read stays a path in the text.
    }
  }

  return blocks
}

const picturesOf = content => {
  const found = []

  for (const block of Array.isArray(content) ? content : []) {
    const source = block?.type === 'image' ? block.source : null
    const kind = PICTURE_KINDS[source?.media_type]

    if (source?.type !== 'base64' || !kind || typeof source.data !== 'string' || source.data.length > 16000000 || found.length >= 6) {
      continue
    }

    try {
      const folder = path.join(dataDir(), 'pictures')
      const file = path.join(folder, `${createHash('sha1').update(source.data).digest('hex')}.${kind}`)

      fs.mkdirSync(folder, { recursive: true })

      try {
        // 'wx': written only when it is not there yet, in one step.
        fs.writeFileSync(file, Buffer.from(source.data, 'base64'), { flag: 'wx' })
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw error
        }
      }
      found.push(pathToFileURL(file).href)
    } catch {
      // A picture that cannot be saved is just not shown.
    }
  }

  return found
}

// What the person typed, as opposed to what the engine added around it.
const isSaid = text => text.trim() !== '' && !text.trim().startsWith('<')

/**
 * A saved Claude Code conversation (the desktop app's or the terminal's) as
 * the events this app's chat is drawn from.
 */
const toEvents = (projectId, messages, ts) => {
  const events = []
  let at = ts
  const push = event => events.push({ projectId, ts: at, ...event })

  for (const one of messages) {
    at = Date.parse(one.timestamp ?? '') || ts
    const content = one.message?.content
    const isMain = one.parent_tool_use_id === null

    if (one.type === 'user') {
      if (typeof content === 'string') {
        if (isMain && isSaid(content)) {
          push({ t: 'user', text: content })
        }
      } else if (Array.isArray(content)) {
        const said = content
          .filter(block => block.type === 'text' && isSaid(block.text))
          .map(block => block.text)
          .join('\n')

        if (isMain && said !== '') {
          push({ t: 'user', text: said, pictures: picturesOf(content) })
        }

        for (const block of content) {
          if (block.type === 'tool_result') {
            push({
              t: 'tool_result',
              id: block.tool_use_id,
              text: flatten(block.content).slice(0, 20000),
              pictures: picturesOf(block.content),
              isError: block.is_error === true,
              isMain,
            })
          }
        }
      }
    } else if (one.type === 'assistant' && Array.isArray(content)) {
      const blocks = []

      for (const block of content) {
        if (block.type === 'text' && block.text.trim() !== '') {
          blocks.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking' && String(block.thinking ?? '').trim() !== '') {
          blocks.push({ type: 'thinking', text: block.thinking })
        } else if (block.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
        }
      }

      const used = one.message.usage
      const usage =
        isMain && used
          ? {
              input: used.input_tokens ?? 0,
              cacheRead: used.cache_read_input_tokens ?? 0,
              cacheWrite: used.cache_creation_input_tokens ?? 0,
              output: used.output_tokens ?? 0,
            }
          : undefined

      if (blocks.length > 0 || usage) {
        push({ t: 'assistant', blocks, usage, isMain, uuid: one.uuid })
      }
    }
  }

  return events
}

// "Stay awake": while it is on, Windows does not put the computer to sleep
// by itself, so long work is not cut off. The screen may still turn off, and
// closing a laptop's lid or choosing Sleep still sleeps. It ends with the app.
let awakeId = null

const setAwake = isOn => {
  if (isOn && awakeId === null) {
    awakeId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!isOn && awakeId !== null) {
    powerSaveBlocker.stop(awakeId)
    awakeId = null
  }

  return awakeId !== null
}

/**
 * What one agent of a chat did, as the events a chat is drawn from. Claude
 * Code saves each agent's own conversation beside the chat's
 * (<chat>/subagents/agent-*.jsonl, with a .meta.json naming the tool call
 * that started it). Read only, and only for a project in this app's list.
 */
const readAgent = (projectId, toolId) => {
  const project = state.projects.find(one => one.id === projectId)

  if (!project || typeof toolId !== 'string' || !/^[\w-]{1,100}$/.test(toolId)) {
    return { error: 'That agent was not found.' }
  }

  const home = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(app.getPath('home'), '.claude'), 'projects')
  const folders = []

  try {
    // The chat's own folder first, then the other chats of the same project folder (a chat carried on under a new id).
    const mine = path.join(home, project.cwd.replace(/[^A-Za-z0-9]/g, '-'))
    const chats = fs.readdirSync(mine, { withFileTypes: true }).filter(one => one.isDirectory()).map(one => one.name)

    for (const chat of [...chats.filter(one => one === project.sessionId), ...chats.filter(one => one !== project.sessionId).slice(-200)]) {
      folders.push(path.join(mine, chat, 'subagents'))
    }
  } catch {
    // No saved chats for this folder.
  }

  for (const folder of folders) {
    let names = []

    try {
      names = fs.readdirSync(folder).filter(one => /^agent-[\w-]+\.meta\.json$/.test(one))
    } catch {
      continue
    }

    for (const name of names) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))

        // By the tool call that started it, or by the agent's own id (its file's
        // name): an agent that was resumed comes back under a new tool call.
        if (meta.toolUseId !== toolId && name !== `agent-${toolId}.meta.json`) {
          continue
        }

        const file = path.join(folder, name.replace(/\.meta\.json$/, '.jsonl'))
        // A very long one: its last part.
        const most = 6 * 1024 * 1024
        const bytes = readTail(file, most)
        const messages = []

        for (const line of bytes.toString('utf8').split('\n')) {
          try {
            const one = JSON.parse(line)

            if ((one.type === 'user' || one.type === 'assistant') && one.isMeta !== true) {
              // In its own conversation the agent is the one speaking.
              messages.push({ ...one, parent_tool_use_id: null })
            }
          } catch {
            // A cut first line, or one still being written.
          }
        }

        return {
          name: String(meta.description ?? 'Agent').slice(0, 200),
          kind: String(meta.agentType ?? 'agent').slice(0, 80),
          model: String(meta.model ?? meta.pickedEffortModel ?? '').slice(0, 80),
          isDone: meta.finished === true,
          isCut: bytes.length >= most,
          // How it is going: when it began and last wrote, and how many tool calls it has made.
          started: Date.parse(messages[0]?.timestamp ?? '') || 0,
          last: Date.parse(messages.at(-1)?.timestamp ?? '') || 0,
          tools: messages.reduce((sum, one) => sum + (one.type === 'assistant' && Array.isArray(one.message?.content) ? one.message.content.filter(block => block?.type === 'tool_use').length : 0), 0),
          events: toEvents(projectId, messages.slice(-800), Date.now()),
        }
      } catch {
        // An unreadable one is passed over.
      }
    }
  }

  return { error: 'What this agent did is not saved on this computer.' }
}

/** One project's Claude Code session: its process, its queue of prompts, its permission asks. */
class Session {
  constructor(project) {
    this.project = project
    this.query = null
    this.life = 0
    this.pending = []
    this.waiters = []
    this.queue = []
    this.isBusy = false
    this.isStopping = false
    // True while the work in hand is being cut short so that a waiting message can go next.
    this.isJumping = false
    this.status = 'waiting'
    this.detail = project.sessionId ? 'Ready to pick up where it left off' : 'Waiting for a prompt'
    this.asks = new Map()
    this.agents = new Set()
    // Agents the engine runs in the background: task id to { id, name, kind, isBackground }.
    // They outlive the tool call that started them and the turn itself.
    this.tasks = new Map()
    // Background work that has ended, by its row's id: see readTask.
    this.ended = new Map()
    // When this app last wrote to the conversation, so the watcher can tell
    // its own writes from another app's.
    this.touched = Date.now()
    this.seen = undefined
    this.watched = null
  }

  emit(event, shouldKeep = true) {
    const full = { projectId: this.project.id, ts: Date.now(), ...event }
    this.touched = Date.now()

    if (shouldKeep) {
      appendTranscript(this.project.id, full)
    }
    send('amp:event', full)
  }

  setStatus(status, detail) {
    this.status = status
    this.detail = detail ?? this.detail
    this.emit(
      { t: 'status', status, detail: this.detail, agents: this.agentCount, queue: this.queue.map(promptLine) },
      false,
    )
  }

  /**
   * A prompt from the person: runs now, or waits its turn in the queue.
   * `isNow`: it does not wait; the work in hand is cut short for it.
   */
  submit(text, files = [], isNow = false) {
    const prompt = files.length > 0 ? { text, files } : text

    if (this.isBusy) {
      this.queue.push(prompt)
      this.setStatus(this.status)

      if (isNow) {
        void this.sendNow(this.queue.length - 1)
      }

      return
    }

    this.begin(prompt)
  }

  /**
   * A waiting message goes next, at once: it moves to the head of the queue
   * and the work in hand is cut short, as Stop would, but the queue is kept.
   * The other waiting messages follow in their order.
   */
  async sendNow(index) {
    const [prompt] = Number.isInteger(index) ? this.queue.splice(index, 1) : []

    if (prompt === undefined) {
      return
    }

    this.queue.unshift(prompt)

    if (this.query !== null && this.isBusy && !this.isStopping) {
      this.isJumping = true
      this.setStatus('working', 'Stopping for your message')
      await this.query.interrupt().catch(() => {})
    } else {
      this.setStatus(this.status)
    }
  }

  begin(prompt) {
    this.isBusy = true
    this.isStopping = false
    // Read once here, so the chat shows exactly what Claude is sent.
    const content = promptContent(prompt)
    this.emit(typeof content === 'string' ? { t: 'user', text: content } : { t: 'user', text: content[0].text, pictures: picturesOf(content) })
    this.setStatus('working', 'Thinking')
    const waiter = this.waiters.shift()

    if (waiter) {
      waiter(content)
    } else {
      this.pending.push(content)
    }

    if (this.query === null) {
      this.start()
    }
  }

  nextPrompt() {
    if (this.pending.length > 0) {
      return Promise.resolve(this.pending.shift())
    }

    return new Promise(resolve => this.waiters.push(resolve))
  }

  async *prompts(life) {
    for (;;) {
      const content = await this.nextPrompt()

      if (content === null || life !== this.life) {
        return
      }

      yield {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: this.project.sessionId ?? '',
      }
    }
  }

  start() {
    // Claude Code counts tokens and cost from the start of each process: so does this.
    this.spent = { cost: 0, tokens: 0 }
    this.life += 1
    const life = this.life
    const project = this.project
    // Connectors from the folder's own .mcp.json that the person has not allowed stay off.
    const serversOff = project.isTrusted === true ? serversNotAllowed(project) : []
    const running = query({
      prompt: this.prompts(life),
      options: {
        cwd: project.cwd,
        // Claude Code keeps a task list in sessions that ask for it; the chat shows it.
        env: { ...childEnv(), CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
        resume: project.sessionId || undefined,
        permissionMode: project.mode ?? 'default',
        model: project.model || undefined,
        effort: project.effort || undefined,
        // Claude's thinking is sent as it goes, in a short form, where the model can.
        thinking: plainModels.has(project.model) ? undefined : { type: 'adaptive', display: 'summarized' },
        includePartialMessages: true,
        // After each turn Claude Code may guess the next message; the message box offers it.
        promptSuggestions: true,
        // A folder's own settings can start programs and pre-approve tools, so they
        // load only for a folder the person has said they trust.
        settingSources: project.isTrusted === true ? ['user', 'project', 'local'] : ['user'],
        settings: serversOff.length > 0 ? { disabledMcpjsonServers: serversOff } : undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        canUseTool: (tool, input, options) => this.ask(tool, input, options),
        // The person's own switch: Claude Code connects to the Claude in Chrome
        // add-on they installed, so Claude can work in their Chrome. Off unless
        // they turn it on; each use is still asked about like any other tool.
        extraArgs: state.prefs.useChrome === true ? { chrome: null } : undefined,
        stderr: text => {
          if (process.env.CLAAMP_DEBUG) {
            process.stderr.write(text)
          }
        },
      },
    })
    this.query = running
    this.woke = Date.now()

    if (typeof project.isFast === 'boolean') {
      void running.applyFlagSettings({ fastMode: project.isFast }).catch(() => {})
    }

    void (async () => {
      try {
        for await (const message of running) {
          if (life !== this.life) {
            return
          }

          this.handle(message)
        }

        if (life === this.life) {
          this.ended()
        }
      } catch (error) {
        if (life === this.life) {
          this.ended(error instanceof Error ? error.message : String(error))
        }
      }
    })()
  }

  handle(message) {
    const project = this.project

    if (message.type === 'system' && message.subtype === 'init') {
      project.sessionId = message.session_id
      // Conversations this app started or copied: it may continue them directly.
      state.own ??= []

      if (!state.own.includes(message.session_id)) {
        state.own.push(message.session_id)
      }
      project.modelName = message.model
      saveState()
      this.emit({ t: 'init', sessionId: message.session_id, model: message.model }, false)

      return
    }

    // The plan's limits moved: the Usage panel reads them again.
    if (message.type === 'rate_limit_event') {
      const info = message.rate_limit_info ?? {}
      this.emit({ t: 'limit', status: info.status, kind: info.rateLimitType, resetsAt: info.resetsAt }, false)

      return
    }

    if (message.type === 'stream_event') {
      const event = message.event

      if (
        message.parent_tool_use_id === null &&
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        this.emit({ t: 'delta', text: event.delta.text }, false)
      } else if (
        message.parent_tool_use_id === null &&
        event.type === 'content_block_delta' &&
        event.delta.type === 'thinking_delta'
      ) {
        this.emit({ t: 'think', text: event.delta.thinking }, false)
      }

      return
    }

    if (message.type === 'assistant') {
      const isMain = message.parent_tool_use_id === null
      const blocks = []

      for (const block of message.message.content) {
        if (block.type === 'text' && block.text.trim() !== '') {
          blocks.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking' && String(block.thinking ?? '').trim() !== '') {
          blocks.push({ type: 'thinking', text: block.thinking })
        } else if (block.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })

          if (block.name === 'Agent' || block.name === 'Task') {
            this.agents.add(block.id)
          }
        }
      }

      const used = message.message.usage
      const usage =
        isMain && used
          ? {
              input: used.input_tokens ?? 0,
              cacheRead: used.cache_read_input_tokens ?? 0,
              cacheWrite: used.cache_creation_input_tokens ?? 0,
              output: used.output_tokens ?? 0,
            }
          : undefined

      if (blocks.length > 0 || usage) {
        this.emit({ t: 'assistant', blocks, usage, isMain, uuid: message.uuid })
      }

      const tool = [...blocks].reverse().find(block => block.type === 'tool_use')

      // A turn the engine began by itself (Claude reacting to a background agent
      // that ended): it is a turn like any other, so its end is told too.
      if (isMain && !this.isBusy) {
        this.isBusy = true
      }

      if (isMain && this.status !== 'attention') {
        this.setStatus('working', tool ? tool.name : 'Writing')
      } else {
        this.setStatus(this.status)
      }

      return
    }

    if (message.type === 'user') {
      const content = message.message.content

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            this.agents.delete(block.tool_use_id)
            this.emit({
              t: 'tool_result',
              id: block.tool_use_id,
              text: flatten(block.content).slice(0, 20000),
              pictures: picturesOf(block.content),
              isError: block.is_error === true,
              isMain: message.parent_tool_use_id === null,
            })
          }
        }
        this.setStatus(this.status)
      }

      return
    }

    // Agents, and other work (a command, a workflow, a monitor), as the engine
    // tracks them. One started in the background, or moved there later, stays
    // listed until the engine says it ended: closing Cla-Amp would stop it.
    if (message.type === 'system' && message.subtype === 'task_started') {
      const isAgent = message.task_type === 'local_agent' || Boolean(message.subagent_type)

      // Work in the cloud is not stopped by closing, and "ambient" work is the engine's own housekeeping.
      if (message.ambient !== true && message.task_type !== 'remote_agent') {
        const task = {
          id: String(message.tool_use_id ?? message.task_id),
          name: String(message.description || (isAgent ? 'Agent' : 'Background work')).slice(0, 120),
          kind: isAgent ? String(message.subagent_type ?? 'agent').slice(0, 60) : taskKind(message.task_type),
          isAgent,
          // The engine's own id for it; an agent's saved conversation is filed under this.
          key: String(message.task_id),
          isBackground: message.is_backgrounded === true,
          started: Date.now(),
        }
        this.tasks.set(message.task_id, task)

        if (task.isBackground) {
          this.emit({ t: 'agent-bg', id: task.id, name: task.name, kind: task.kind, isTask: !task.isAgent, key: task.key })
          this.setStatus(this.status)
        }
      }

      return
    }

    if (message.type === 'system' && message.subtype === 'task_updated') {
      const task = this.tasks.get(message.task_id)

      if (task && !task.isBackground && message.patch?.is_backgrounded === true) {
        task.isBackground = true
        this.emit({ t: 'agent-bg', id: task.id, name: task.name, kind: task.kind, isTask: !task.isAgent, key: task.key })
        this.setStatus(this.status)
      }

      return
    }

    if (message.type === 'system' && message.subtype === 'task_notification') {
      const task = this.tasks.get(message.task_id)
      this.tasks.delete(message.task_id)

      if (task?.isBackground) {
        // What it came to, kept so its row can still show it: the engine's own
        // summary and the file it wrote the output to. The newest forty are kept.
        this.ended.set(task.id, {
          ...task,
          status: String(message.status),
          summary: String(message.summary ?? '').slice(0, 4000),
          outputFile: typeof message.output_file === 'string' ? message.output_file : '',
          ended: Date.now(),
        })

        for (const old of [...this.ended.keys()].slice(0, -40)) {
          this.ended.delete(old)
        }
        // One the person stopped is not a failure.
        this.emit({ t: 'agent-bg-done', id: task.id, isOk: message.status === 'completed' || message.status === 'stopped' })
        this.setStatus(this.status)
      }

      return
    }

    // Claude Code summarized the chat so far (asked for, or by itself when the context filled up).
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      this.emit({ t: 'compacted', before: Number(message.compact_metadata?.pre_tokens) || 0 })

      return
    }

    if (message.type === 'prompt_suggestion') {
      if (typeof message.suggestion === 'string' && message.suggestion.trim() !== '') {
        this.emit({ t: 'suggest', text: message.suggestion.trim().slice(0, 400) })
      }

      return
    }

    if (message.type === 'result') {
      noteSpend(this, message)
      // A process woken only to fill the panels can end a turn nobody asked for: not chat news.
      if (!this.isBusy) {
        return
      }

      const windows = Object.values(message.modelUsage ?? {}).map(one => one.contextWindow ?? 0)
      const contextWindow = Math.max(0, ...windows)

      if (contextWindow > 0) {
        project.contextWindow = contextWindow
        saveState()
      }

      const isOk = message.subtype === 'success' && message.is_error !== true
      const failure = String(message.result ?? message.subtype)
      // The commonest first-run failure: Claude Code itself is not signed in.
      const hint = /authenticat|oauth|log ?in|api key/i.test(failure)
        ? 'Claude Code is not signed in on this computer. Press Sign in above the chat, finish the sign-in in your browser, then send your message again.'
        : failure
      this.emit({
        t: 'result',
        isOk,
        wasStopped: this.isStopping || this.isJumping,
        cost: message.total_cost_usd,
        durationMs: message.duration_ms,
        turns: message.num_turns,
        contextWindow,
        error: isOk || this.isStopping || this.isJumping ? undefined : hint,
      })
      this.isJumping = false
      this.isBusy = false
      this.agents.clear()
      const next = this.queue.shift()

      if (next !== undefined && !this.isStopping) {
        this.begin(next)
      } else if (this.isStopping) {
        this.setStatus('waiting', 'Stopped')
      } else {
        this.setStatus(isOk ? 'complete' : 'attention', isOk ? 'Finished' : 'Ended with an error')
      }
      this.isStopping = false
    }
  }

  /** The Claude Code process ended: by itself, by a crash, or by New chat. */
  ended(error) {
    this.query = null
    this.pending = []

    for (const answer of this.asks.values()) {
      answer({ behavior: 'deny', message: 'The session ended.' })
    }
    this.asks.clear()

    // A process that was only answering the panels ends without a word in the chat.
    if (this.isBusy) {
      this.isBusy = false
      this.emit({ t: 'error', message: error ?? 'Claude Code stopped before it finished.' })
      this.setStatus('attention', 'Stopped unexpectedly')
    }
  }

  /** Claude Code asks whether a tool may run: the window shows a card and answers. */
  ask(tool, input, options) {
    return new Promise(resolve => {
      const id = randomUUID()
      const before = { status: this.status, detail: this.detail }
      const answer = result => {
        if (!this.asks.delete(id)) {
          return
        }

        this.emit({ t: 'permission-done', id, isAllowed: result.behavior === 'allow' })

        if (this.isBusy) {
          this.setStatus('working', before.detail)
        }
        resolve(result)
      }
      this.asks.set(id, answer)
      answer.input = input
      // "Always allow" may only add allow rules; a change of mode or of folders is not offered.
      answer.suggestions = (options.suggestions ?? []).filter(one => one?.type === 'addRules' && one.behavior === 'allow')
      options.signal.addEventListener('abort', () =>
        answer({ behavior: 'deny', message: 'The request was cancelled.' }),
      )
      const rules = answer.suggestions.flatMap(one =>
        (one.rules ?? []).map(rule => `${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ''}`),
      )
      this.emit({ t: 'permission', id, tool, input, always: rules.slice(0, 12) })
      this.setStatus('attention', tool === 'AskUserQuestion' ? 'Has a question' : `Asks to use ${tool}`)
    })
  }

  decide(id, decision, answers) {
    const answer = this.asks.get(id)

    if (!answer) {
      return
    }

    if (decision === 'deny') {
      answer({ behavior: 'deny', message: 'The user declined this action.' })
    } else if (decision === 'answer') {
      answer({ behavior: 'allow', updatedInput: { ...answer.input, answers } })
    } else if (decision === 'always' && answer.suggestions.length > 0) {
      answer({ behavior: 'allow', updatedInput: answer.input, updatedPermissions: answer.suggestions })
    } else {
      answer({ behavior: 'allow', updatedInput: answer.input })
    }
  }

  async stop() {
    if (this.query !== null && this.isBusy) {
      this.isStopping = true
      this.queue = []
      this.setStatus('working', 'Stopping')
      await this.query.interrupt().catch(() => {})
    }
  }

  /**
   * What one piece of background work that is not an agent (a command, a
   * workflow, a monitor) is doing or did: its state, the engine's summary once
   * it ended, and the end of what it printed. The output file's path comes
   * only from the engine (its end notice, or the folder Claude Code keeps a
   * chat's task output in), never from the window. Read only.
   */
  async readTask(id) {
    const live = [...this.tasks.values()].find(task => task.id === id && task.isBackground)
    const task = live ?? this.ended.get(id)

    if (!task) {
      return { error: 'What this did is no longer kept. Its result is in the chat.' }
    }

    let output = ''
    let isCut = false

    for (const file of [task.outputFile, ...taskOutputFiles(this.project.sessionId, task.key)].filter(Boolean)) {
      try {
        const read = await readEndLater(file, 200000)
        output = read.bytes.toString('utf8')
        isCut = read.isCut
        break
      } catch {
        // Not there (yet); the next place is tried.
      }
    }

    return {
      name: task.name,
      kind: task.kind,
      status: live ? 'working' : task.status,
      summary: live ? '' : task.summary,
      started: task.started ?? 0,
      ended: live ? 0 : task.ended,
      output,
      isCut,
    }
  }

  /**
   * Stops one piece of background work (an agent, a command, a workflow, a
   * monitor) by the id its row carries. The engine then says it ended, which
   * takes it off the count. True when the engine was asked.
   */
  async stopTask(id) {
    const found = [...this.tasks.entries()].find(([, task]) => task.id === id && task.isBackground)

    if (this.query === null || !found) {
      return false
    }

    try {
      await this.query.stopTask(found[0])

      return true
    } catch {
      return false
    }
  }

  /** Ends the process and forgets the conversation, for a fresh one. */
  reset() {
    this.life += 1
    const old = this.query
    this.query = null

    for (const waiter of this.waiters) {
      waiter(null)
    }
    this.waiters = []
    this.pending = []
    this.queue = []
    this.isBusy = false
    this.agents.clear()
    this.tasks.clear()

    for (const answer of [...this.asks.values()]) {
      answer({ behavior: 'deny', message: 'The session ended.' })
    }

    if (old !== null) {
      void old.return?.().catch(() => {})
    }

    this.project.sessionId = null
    saveState()
    fs.rm(transcriptFile(this.project.id), { force: true }, () => {})
    this.setStatus('waiting', 'Waiting for a prompt')
  }

  /** Switches to a saved conversation: the process ends, and the next prompt resumes that one. */
  /** Agents at work: those a tool call is waiting for, and those running in the background. */
  /** Agents at work plus everything else running in the background: all of it stops if the app closes. */
  get agentCount() {
    return this.agents.size + [...this.tasks.values()].filter(one => one.isBackground && !this.agents.has(one.id)).length
  }

  /** The part of agentCount that is not an agent: background commands, workflows and monitors. */
  get taskCount() {
    return [...this.tasks.values()].filter(one => one.isBackground && !one.isAgent && !this.agents.has(one.id)).length
  }

  adopt(sessionId, events) {
    this.life += 1
    const old = this.query
    this.query = null

    for (const waiter of this.waiters) {
      waiter(null)
    }
    this.waiters = []
    this.pending = []
    this.queue = []
    this.isBusy = false
    this.agents.clear()
    this.tasks.clear()
    this.asks.clear()

    if (old !== null) {
      void old.return?.().catch(() => {})
    }

    this.project.sessionId = sessionId
    saveState()
    const file = transcriptFile(this.project.id)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, events.map(event => `${JSON.stringify(event)}\n`).join(''))
    this.setStatus('waiting', 'Ready to pick up where it left off')
  }

  /** The running Claude Code process, started without a prompt when there is none. */
  live() {
    if (this.query === null) {
      this.start()
    }

    return this.query
  }

  /** Ends an idle process. The conversation is kept: the next prompt resumes it. */
  sleep() {
    if (this.query === null || this.isBusy || this.asks.size > 0 || this.queue.length > 0) {
      return
    }

    this.life += 1
    const old = this.query
    this.query = null

    for (const waiter of this.waiters) {
      waiter(null)
    }
    this.waiters = []
    void old.return?.().catch(() => {})
  }

  /** What the Usage, Model and Connectors panels show for this project. */
  async info() {
    const project = this.project
    const running = this.live()
    const [init, usage, servers] = await Promise.all([
      running.initializationResult(),
      running.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => null),
      running.mcpServerStatus().catch(() => []),
    ])

    for (const one of init.models ?? []) {
      if (one.supportsAdaptiveThinking !== true) {
        plainModels.add(one.value)
        plainModels.add(one.resolvedModel)
      }
    }

    const models = (init.models ?? []).map(one => ({
      value: one.value,
      name: one.displayName,
      description: one.description ?? '',
      efforts: one.supportsEffort ? (one.supportedEffortLevels ?? []) : [],
      hasFast: one.supportsFastMode === true,
    }))

    // A model the desktop app had this chat on that the list does not name.
    if (project.model && !models.some(one => one.value === project.model)) {
      const twin = (init.models ?? []).find(one => one.resolvedModel === project.model)
      models.push({
        value: project.model,
        name: twin?.displayName ?? String(project.model).replace(/^claude-/, ''),
        description: twin?.description ?? 'The model this chat was on in the desktop app',
        efforts: twin ? (twin.supportedEffortLevels ?? []) : EFFORTS,
        hasFast: twin?.supportsFastMode === true,
      })
    }

    return {
      models,
      model: project.model || 'default',
      effort: project.effort || null,
      isFast: typeof project.isFast === 'boolean' ? project.isFast : init.fast_mode_state === 'on',
      ...(await this.fastNow().catch(() => ({ fastState: 'off', fastBlock: '' }))),
      usage: shapeUsage(usage),
      servers: shapeServers(servers),
    }
  }

  /** The slash commands and skills Claude Code has for this project, for the message box's "/" list. */
  async commands() {
    const all = await this.live()
      .supportedCommands()
      .catch(() => [])

    return (Array.isArray(all) ? all : [])
      .filter(one => typeof one?.name === 'string' && /^[\w:.-]{1,80}$/.test(one.name) && !one.name.startsWith('__'))
      .slice(0, 400)
      .map(one => ({ name: one.name, description: String(one.description ?? '').slice(0, 200), hint: String(one.argumentHint ?? '').slice(0, 80) }))
  }

  /** What fills the context, row by row, as Claude Code counts it (its /context report). */
  async context() {
    const got = await this.live()
      .getContextUsage({ detail: 'summary' })
      .catch(() => null)

    if (!got || !Array.isArray(got.categories)) {
      return null
    }

    const number = value => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)

    return {
      model: String(got.model ?? ''),
      total: number(got.totalTokens),
      max: number(got.rawMaxTokens ?? got.maxTokens),
      rows: got.categories
        .filter(one => number(one.tokens) > 0)
        .slice(0, 30)
        .map(one => ({ id: String(one.id ?? ''), name: String(one.name ?? '').slice(0, 60), tokens: number(one.tokens), kind: ['used', 'free', 'buffer', 'deferred'].includes(one.kind) ? one.kind : 'used' })),
      counts: {
        tools: Array.isArray(got.mcpTools) ? got.mcpTools.length : 0,
        memory: Array.isArray(got.memoryFiles) ? got.memoryFiles.length : 0,
        agents: Array.isArray(got.agents) ? got.agents.length : 0,
        skills: Array.isArray(got.skills) ? got.skills.length : 0,
      },
    }
  }

  async usage() {
    if (this.query === null) {
      return null
    }

    return shapeUsage(
      await this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }).catch(() => null),
    )
  }

  async servers() {
    return shapeServers(await this.live().mcpServerStatus())
  }

  async setModel(value) {
    const model = value === 'default' ? null : value
    this.project.model = model
    saveState()

    if (this.query !== null) {
      await this.query.setModel(model ?? undefined)
    }
  }

  async setEffort(level) {
    this.project.effort = level
    saveState()

    if (this.query !== null) {
      await this.query.applyFlagSettings({ effortLevel: level })
    }
  }

  async setFast(isFast) {
    this.project.isFast = isFast
    saveState()

    if (this.query === null) {
      return undefined
    }

    await this.query.applyFlagSettings({ fastMode: isFast })
    const now = await this.fastNow()

    // Asked for, but the account cannot have it: put it back, and say why.
    if (isFast && now.fastBlock !== '') {
      this.project.isFast = false
      saveState()
      await this.query.applyFlagSettings({ fastMode: false }).catch(() => {})

      return { ...now, isFast: false }
    }

    return { ...now, isFast }
  }

  /**
   * Whether fast mode can run, asked of the process as it now stands. Until a
   * session asks for fast mode the process only says an app must ask first,
   * which is no reason to grey the switch out.
   */
  async fastNow() {
    const init = await this.query.reinitialize()
    const block = init.fast_mode_disabled_reason ?? ''

    return { fastState: init.fast_mode_state ?? 'off', fastBlock: block === 'sdk_opt_in_required' ? '' : block }
  }

  async setMode(mode) {
    const before = this.project.mode ?? 'default'
    this.project.mode = mode
    saveState()

    if (this.query !== null) {
      try {
        await this.query.setPermissionMode(mode)
      } catch (error) {
        // Auto is not offered for every account or model: the mode stays as it was, and the window says so.
        this.project.mode = before
        saveState()

        return { error: String(error?.message ?? error).slice(0, 300), mode: before }
      }
    }

    return { mode }
  }
}

const sessions = new Map()

const sessionOf = id => {
  let session = sessions.get(id)

  if (!session) {
    const project = state.projects.find(one => one.id === id)

    if (!project) {
      return null
    }

    session = new Session(project)
    sessions.set(id, session)
  }

  return session
}

const describe = project => {
  const session = sessionOf(project.id)

  return {
    id: project.id,
    name: project.name,
    cwd: project.cwd,
    mode: project.mode ?? 'default',
    isTrusted: project.isTrusted === true,
    model: project.model || 'default',
    effort: project.effort || null,
    contextWindow: project.contextWindow ?? 0,
    hasSession: Boolean(project.sessionId),
    // Which saved chat is open here: the window keeps a half-written message for each chat.
    chatId: project.sessionId ?? null,
    status: session.status,
    detail: session.detail,
    queue: session.queue.map(promptLine),
    agents: session.agentCount,
  }
}

/**
 * Asks, in a system dialog the page cannot draw over, whether a newly added
 * folder is trusted. Trusted: the folder's own Claude Code settings load
 * (hooks, allowed tools, connectors). Not trusted: only the person's own do.
 */
const askTrust = async folder => {
  const picked = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Cla-Amp',
    message: 'Do you trust this folder?',
    detail: `${folder}\n\nA folder can carry its own Claude Code settings. Those can run programs when a chat starts and let Claude use tools without asking you. Trust only folders whose contents you know, such as your own projects.\n\nYou can still chat in a folder you do not trust: its own settings are left out.\n\nPrograms that a trusted folder asks to start as connectors (its .mcp.json file) are asked about separately, by name.`,
    buttons: ['Open without its settings', 'Trust this folder'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })

  return picked.response === 1
}

/**
 * The connectors a folder's own .mcp.json asks to start: name -> { print, line }.
 * `print` is a fingerprint of the definition, so a yes holds only for the
 * program that was shown; `line` is that program, for showing.
 */
const folderServers = cwd => {
  const found = {}

  try {
    const bytes = readCapped(path.join(cwd, '.mcp.json'), 1 << 20)
    const said = bytes === null ? null : JSON.parse(bytes.toString('utf8')).mcpServers

    for (const [name, one] of Object.entries(said && typeof said === 'object' ? said : {})) {
      const line = typeof one?.command === 'string' ? [one.command, ...(Array.isArray(one.args) ? one.args : [])].join(' ') : String(one?.url ?? one?.type ?? '')

      found[name] = {
        print: createHash('sha256').update(JSON.stringify(one ?? null)).digest('hex').slice(0, 16),
        // eslint-disable-next-line no-control-regex
        line: line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 300),
      }
    }
  } catch {
    // No such file, or not one Claude Code could read either.
  }

  return found
}

/** The names in a folder's .mcp.json that the person has not said yes to, as each stands now. */
const serversNotAllowed = project =>
  Object.entries(folderServers(project.cwd))
    .filter(([name, one]) => project.serversOk?.[name] !== one.print)
    .map(([name]) => name)

// For the off-screen tests, which must show no dialog: the answer to give.
const SERVERS_ANSWER = IS_DEV ? process.env.CLAAMP_SERVERS : undefined
const askingServers = new Map()

/**
 * A trusted folder's .mcp.json can start programs. Claude Code asks about each
 * in its terminal; run by an app it does not, so this asks: once for each
 * connector, and again when its definition changes. Until the person says
 * yes, the connector is left switched off.
 */
const askServers = project => {
  if (project.isTrusted !== true || IS_DEMO) {
    return Promise.resolve()
  }

  if (askingServers.has(project.id)) {
    return askingServers.get(project.id)
  }

  const found = folderServers(project.cwd)
  const fresh = Object.entries(found).filter(([name, one]) => project.serversOk?.[name] !== one.print && project.serversNo?.[name] !== one.print)

  if (fresh.length === 0) {
    return Promise.resolve()
  }

  const asking = (async () => {
    const list = fresh.slice(0, 12).map(([name, one]) => `${name.slice(0, 80)}\n    ${one.line || '(nothing to show)'}`)
    const isYes =
      SERVERS_ANSWER !== undefined
        ? SERVERS_ANSWER === 'yes'
        : (
            await dialog.showMessageBox(win, {
              type: 'question',
              title: 'Cla-Amp',
              message: fresh.length === 1 ? 'This folder asks to start a connector' : `This folder asks to start ${fresh.length} connectors`,
              detail: `${project.cwd}\n\nIts .mcp.json file names ${fresh.length === 1 ? 'a program' : 'programs'} for Claude Code to start with each chat here, and Claude can then use ${fresh.length === 1 ? 'its' : 'their'} tools:\n\n${list.join('\n\n')}${fresh.length > 12 ? `\n\nand ${fresh.length - 12} more` : ''}\n\nAllow only what you know. You are asked again if one of them changes.`,
              buttons: ['Leave switched off', fresh.length === 1 ? 'Allow it' : 'Allow them'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
          ).response === 1

    project.serversOk ??= {}
    project.serversNo ??= {}

    for (const [name, one] of fresh) {
      delete project.serversOk[name]
      delete project.serversNo[name]
      ;(isYes ? project.serversOk : project.serversNo)[name] = one.print
    }
    saveState()

    // A chat already waiting was started with them off: it starts afresh with the next message.
    if (isYes) {
      sessions.get(project.id)?.sleep()
    }
  })().finally(() => askingServers.delete(project.id))

  askingServers.set(project.id, asking)

  return asking
}

/** A folder path as a call gave it, made whole and checked to be a real folder. */
const realFolder = raw => {
  const folder = path.resolve(String(raw))

  try {
    return /["%\r\n]/.test(folder) || !fs.statSync(folder).isDirectory() ? null : folder
  } catch {
    return null
  }
}

/** Starts the bundled Claude Code in its own console window, for a step the person does there. */
const openClaudeConsole = (args, cwd) => {
  // The arguments are fixed words chosen by this app; the folder goes in as
  // the working folder, never onto the command line.
  if (/["%^&|<>\r\n]/.test(CLAUDE_BIN) || args.some(one => !/^[\w/-]+$/.test(one))) {
    return false
  }

  try {
    spawn(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      ['/d', '/s', '/c', `"start "Cla-Amp" "${CLAUDE_BIN}" ${args.join(' ')}"`],
      { cwd, env: childEnv(), windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' },
    ).unref()

    return true
  } catch {
    return false
  }
}

const BROWSER_ENDS = ['.html', '.htm', '.pdf', '.svg']

/** The file a reply names: a full path, or one inside the project's folder. A line number after it is dropped. null when there is no such file. */
/**
 * A path written in a reply, as a place on this computer: { path, kind } with
 * kind 'file' or 'folder', or null when there is nothing there. A relative one
 * is read from the project's folder; %APPDATA% and the like, and a leading ~,
 * are filled in. Read only: it looks, and changes nothing.
 */
const placeNamed = (id, name) => {
  const project = state.projects.find(one => one.id === id)

  if (typeof name !== 'string' || name.length > 600 || name.includes('\0')) {
    return null
  }

  const KNOWN = ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'PROGRAMFILES', 'PROGRAMDATA', 'PUBLIC', 'ONEDRIVE']
  const plain = name
    .trim()
    .replace(/^file:\/\/\/?/i, '')
    .replace(/^%([A-Za-z]+)%/, (all, key) => (KNOWN.includes(key.toUpperCase()) ? (process.env[key.toUpperCase()] ?? process.env[key] ?? all) : all))
    .replace(/^~(?=[\\/]|$)/, () => app.getPath('home'))

  try {
    const full = path.isAbsolute(plain) ? path.normalize(plain) : project ? path.resolve(project.cwd, plain) : null

    if (full === null) {
      return null
    }
    const found = fs.statSync(full)

    return found.isFile() ? { path: full, kind: 'file' } : found.isDirectory() ? { path: full, kind: 'folder' } : null
  } catch {
    return null
  }
}

const fileNamed = (id, name) => {
  const project = state.projects.find(one => one.id === id)

  if (typeof name !== 'string' || name.length > 600) {
    return null
  }

  const plain = name.replace(/^file:\/\/\/?/i, '').replace(/[#?].*$/, '').replace(/:\d+(?::\d+)?$/, '')

  try {
    const file = path.isAbsolute(plain) ? path.normalize(plain) : project ? path.resolve(project.cwd, plain) : null

    return file !== null && fs.statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

const sameFolder = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/**
 * Opens a saved conversation in a project and continues that very
 * conversation, so this app and the one that made it (the desktop app, the
 * terminal) show the same chat. Only a chat copied by an older version of
 * this app still goes to its copy, which holds the newer messages.
 */
/** The last few chats read from their files: chat id to { stamp, messages }. */
const readChats = new Map()

/** A project with nothing going on: no turn, no agents out, nothing waiting. */
const isFree = project => {
  const session = sessions.get(project.id)

  return !session || !(session.isBusy || session.agentCount > 0 || session.queue.length > 0)
}

/** One more entry in the list for a folder that is already there, so a second chat can run in it. */
const anotherFor = first => {
  const count = state.projects.filter(one => sameFolder(one.cwd, first.cwd)).length
  const project = {
    id: randomUUID(),
    name: `${String(first.name).replace(/ \(\d+\)$/, '')} (${count + 1})`,
    cwd: first.cwd,
    mode: first.mode ?? 'default',
    sessionId: null,
    isTrusted: first.isTrusted === true,
  }
  state.projects.push(project)
  saveState()

  return project
}

/**
 * Where a saved chat of a folder opens. The entry that already holds it,
 * else one for that folder with nothing going on (the one in view first),
 * else a new entry for the same folder: a chat that is working is never
 * pushed aside. `isOpen`: the chat is already open and at work there.
 */
const placeFor = (folder, sessionId, hint) => {
  const here = state.projects.filter(one => sameFolder(one.cwd, folder))
  const ours = state.copies?.[sessionId] ?? sessionId
  const holding = here.find(one => one.sessionId === sessionId || one.sessionId === ours)

  if (holding) {
    return { project: holding, isOpen: !isFree(holding) }
  }

  const free = here.find(one => one.id === hint && isFree(one)) ?? here.find(isFree)

  return here.length === 0 ? null : { project: free ?? anotherFor(here[0]), isOpen: false }
}

const openSaved = async (project, sessionId) => {
  const session = sessionOf(project.id)

  if (session.isBusy) {
    return { error: `Claude is still working in ${project.name}. Stop it first, then open another chat.` }
  }

  // Only a chat that is really saved for this folder can be opened.
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !(await getSessionInfo(sessionId, { dir: project.cwd }).catch(() => undefined))) {
    return { error: 'That chat is not saved for this folder any more.' }
  }

  let ours = state.copies?.[sessionId] ?? sessionId

  if (ours !== sessionId && !(await getSessionInfo(ours, { dir: project.cwd }).catch(() => undefined))) {
    ours = sessionId
  }

  // A chat's file is read whole (seconds for a long chat), so what was read is
  // kept for the last few chats and used again while the file has not changed.
  const stamp = (await getSessionInfo(ours, { dir: project.cwd }).catch(() => undefined))?.lastModified ?? 0
  const kept = readChats.get(ours)
  let messages = kept?.stamp === stamp && stamp > 0 ? kept.messages : null

  if (messages === null) {
    messages = (await getSessionMessages(ours, { dir: project.cwd })).slice(-600)
    readChats.delete(ours)
    readChats.set(ours, { stamp, messages })

    if (readChats.size > 8) {
      readChats.delete(readChats.keys().next().value)
    }
  }

  const events = toEvents(project.id, messages, Date.now())
  // The chat runs here on the model and effort it has in the desktop app.
  followDesktop(project, sessionId)
  session.adopt(ours, events)

  return { project: describe(project), events }
}

const WATCH_EVERY = 4000
const OWN_WRITES = 15000

/**
 * Keeps an open chat the same as its saved conversation: when another app
 * adds to it while this one is idle, the chat is read again and shown anew.
 */
const watchChats = async () => {
  for (const [id, session] of sessions) {
    const project = session.project

    if (!project.sessionId || !state.projects.includes(project)) {
      continue
    }

    const info = await getSessionInfo(project.sessionId, { dir: project.cwd }).catch(() => undefined)

    if (!info) {
      continue
    }

    const isOurs = session.isBusy || session.agentCount > 0 || Date.now() - session.touched < OWN_WRITES

    const isFirstLook = session.seen === undefined || session.watched !== project.sessionId
    session.watched = project.sessionId

    if (isOurs) {
      // This app's own writing counts as read. Merely having opened the chat a
      // moment ago does not: the first look waits until that moment has passed.
      if (!isFirstLook || session.isBusy || session.agentCount > 0) {
        session.seen = info.lastModified
        // Kept with the project (saved along with its next change): how far this app has read the chat.
        project.readTo = info.lastModified
      }

      continue
    }

    if (isFirstLook) {
      // A chat that moved on in another app while this one was closed (or before
      // it first looked) is read afresh: its file is newer than what was read here.
      if (info.lastModified <= (project.readTo ?? 0)) {
        session.seen = info.lastModified

        continue
      }
    } else if (info.lastModified <= session.seen) {
      continue
    }

    session.seen = info.lastModified
    project.readTo = info.lastModified
    saveState()
    const messages = await getSessionMessages(project.sessionId, { dir: project.cwd }).catch(() => null)

    if (messages === null || session.isBusy) {
      continue
    }

    const events = toEvents(id, messages.slice(-600), Date.now())
    session.adopt(project.sessionId, events)
    session.touched = 0
    send('amp:event', { projectId: id, ts: Date.now(), t: 'reload', events })
  }
}

/**
 * Chats and agents working outside this app (the desktop app, a terminal),
 * for the status bar. The chats this app is running itself are left out:
 * the window counts those from its own sessions.
 */
let outsideSaid = ''

const watchOutside = () => {
  const skip = new Set()

  for (const session of sessions.values()) {
    if (session.project.sessionId && (session.isBusy || session.agentCount > 0)) {
      skip.add(session.project.sessionId)
    }
  }

  // Each chat that is also open here as a project says which one, so its window can show the work live.
  const openHere = new Map([...sessions].filter(([, session]) => session.project.sessionId).map(([id, session]) => [session.project.sessionId, id]))
  const list = listOutside({ skip }).map(one => (openHere.has(one.id) ? { ...one, projectId: openHere.get(one.id) } : one))
  // "here": the chats this app itself is working in, so the Code tab can mark them too.
  const found = { ...countOutside(undefined, list), list, here: [...skip] }
  const said = JSON.stringify(found)

  if (said !== outsideSaid) {
    outsideSaid = said
    send('amp:outside', found)
  }

  return found
}

const branchOf = cwd =>
  new Promise(resolve => {
    // The branch's name, also in a new repository with no commit yet; a
    // checkout that is on no branch gives the short id of its commit.
    execFile('git', ['branch', '--show-current'], { cwd, windowsHide: true }, (error, out) => {
      if (error || out.trim() !== '') {
        resolve(error ? '' : out.trim())

        return
      }
      execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd, windowsHide: true }, (failed, id) => resolve(failed ? '' : id.trim()))
    })
  })

// ------------------------------------------------------- look, about, guides

/**
 * "Customize": the person's own changes to parts of the window, on top of
 * the skin. Only known parts and fields are kept, each checked for shape; a
 * picture must be one this app copied into its own look folder.
 */
const LOOK_PARTS = ['window', 'titlebar', 'banner', 'buttons', 'status', 'left', 'chat', 'composer', 'panels', 'deck']
const lookFolder = () => path.join(dataDir(), 'look')

const cleanLook = raw => {
  const look = {}
  const number = (value, min, max) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : undefined)
  const home = pathToFileURL(lookFolder()).href + '/'

  for (const part of LOOK_PARTS) {
    const from = raw?.[part]

    if (!from || typeof from !== 'object') {
      continue
    }

    const one = {}

    for (const field of ['back', 'edge', 'text']) {
      if (typeof from[field] === 'string' && /^#[0-9a-f]{6}$/i.test(from[field])) {
        one[field] = from[field]
      }
    }

    if (typeof from.picture === 'string' && from.picture.startsWith(home) && /^[0-9a-f]{40}\.(png|jpg|gif|webp)$/.test(from.picture.slice(home.length))) {
      one.picture = from.picture
    }

    for (const [field, min, max] of [['show', 0, 100], ['opacity', 20, 100], ['round', 0, 24]]) {
      const value = number(from[field], min, max)

      if (value !== undefined) {
        one[field] = value
      }
    }

    if (Object.keys(one).length > 0) {
      look[part] = one
    }
  }

  return look
}

// Where Cla-Amp's own newest version is asked about, and nothing else.
const HOME_API = 'https://api.github.com/repos/leetomyang-dev/Cla-Amp'
const HOME_NOTES = 'https://raw.githubusercontent.com/leetomyang-dev/Cla-Amp/main/docs/whats-new.md'

/** The notes on GitHub's "What's new" page that this copy's page does not have. Nothing, when they cannot be read. */
const notesNotHere = async () => {
  try {
    // For the off-screen tests: a file standing in for the page on GitHub.
    const standIn = IS_DEV ? process.env.CLAAMP_NOTES_FILE : undefined
    const answer = standIn
      ? { ok: true, text: async () => fs.readFileSync(standIn, 'utf8') }
      : await fetch(HOME_NOTES, { headers: { 'user-agent': 'Cla-Amp' }, signal: AbortSignal.timeout(15000), redirect: 'error', credentials: 'omit' })

    if (!answer.ok) {
      return { groups: [], more: 0 }
    }

    let mine = ''

    try {
      mine = readCapped(path.join(ROOT, 'docs', 'whats-new.md'), 1 << 20)?.toString('utf8') ?? ''
    } catch {
      // A copy from before the page existed: everything on it is new.
    }

    return notesNewTo((await answer.text()).slice(0, 1 << 20), mine)
  } catch {
    return { groups: [], more: 0 }
  }
}

/** The commit this copy is at, when the folder was made with git; otherwise null. */
const ownCommit = () => {
  const isSha = text => /^[0-9a-f]{40}$/.test(text)

  try {
    const head = readCapped(path.join(ROOT, '.git', 'HEAD'), 4096)?.toString('utf8').trim() ?? ''

    if (isSha(head)) {
      return head
    }

    const ref = /^ref: (refs\/heads\/[\w./-]+)$/.exec(head)?.[1]

    if (!ref || ref.includes('..')) {
      return null
    }

    try {
      const loose = readCapped(path.join(ROOT, '.git', ...ref.split('/')), 4096)?.toString('utf8').trim() ?? ''

      if (isSha(loose)) {
        return loose
      }
    } catch {
      // Not a loose ref: it is in the packed list.
    }

    const packed = readCapped(path.join(ROOT, '.git', 'packed-refs'), 4 << 20)?.toString('utf8') ?? ''
    const line = packed.split('\n').find(one => one.endsWith(` ${ref}`))

    return line && isSha(line.slice(0, 40)) ? line.slice(0, 40) : null
  } catch {
    return null
  }
}

/**
 * "Check for updates", and only when the person presses it: asks GitHub what
 * the newest Cla-Amp is and says how this copy compares. It downloads and
 * runs nothing; updating stays Update.bat, run by hand.
 */
const checkForUpdate = async () => {
  const ask = async address => {
    const answer = await fetch(address, {
      headers: { 'user-agent': 'Cla-Amp', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
      credentials: 'omit',
    })

    return answer.ok ? JSON.parse((await answer.text()).slice(0, 2 << 20)) : { status: answer.status }
  }
  // What GitHub says is shown as plain text, short.
  // eslint-disable-next-line no-control-regex
  const short = text => String(text ?? '').split('\n')[0].replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 120)

  try {
    const newest = await ask(`${HOME_API}/commits/main`)

    if (!/^[0-9a-f]{40}$/.test(newest.sha ?? '')) {
      return { state: 'error', why: newest.status === 403 || newest.status === 429 ? 'GitHub is turning requests away for now. Try again in an hour.' : 'GitHub did not answer as expected.' }
    }

    const about = { date: short(newest.commit?.committer?.date).slice(0, 10), what: short(newest.commit?.message) }
    const mine = ownCommit()

    if (mine === newest.sha) {
      return { state: 'same', ...about }
    }

    if (mine !== null) {
      const gap = await ask(`${HOME_API}/compare/${mine}...${newest.sha}`)

      if (Number.isInteger(gap.ahead_by) && Number.isInteger(gap.behind_by)) {
        // "ahead_by" is how far the newest is ahead of this copy.
        return gap.ahead_by > 0
          ? { state: 'behind', count: gap.ahead_by, isOwn: gap.behind_by > 0, ...about, news: await notesNotHere() }
          : { state: gap.behind_by > 0 ? 'own' : 'same', ...about }
      }

      return { state: 'own', ...about }
    }

    // A copy from the ZIP has no record of its version: its files carry the date of the version they came from.
    const filed = fs.statSync(path.join(ROOT, 'main.mjs')).mtimeMs
    const made = Date.parse(newest.commit?.committer?.date ?? '')

    // Without a version to compare, the notes say it best: any this copy lacks means it is behind.
    const news = await notesNotHere()

    return { state: news.groups.length > 0 || (Number.isFinite(made) && made > filed + 3600000) ? 'maybe-behind' : 'maybe-same', ...about, news }
  } catch {
    return { state: 'error', why: 'GitHub could not be reached.' }
  }
}

/** What the About page shows: versions, and the parts the app is built from with their licences. */
const aboutInfo = () => {
  const read = file => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }
  const own = read(path.join(ROOT, 'package.json'))
  const parts = Object.keys({ ...own.dependencies, ...own.devDependencies }).map(name => {
    const one = read(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json'))

    return { name, version: String(one.version ?? ''), licence: typeof one.license === 'string' ? one.license : 'see its own licence file' }
  })

  return { version: String(own.version ?? ''), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, parts }
}

/** Who is signed in to Claude Code: what `claude auth status` says, a few fields of it. */
const accountInfo = () =>
  new Promise(resolve => {
    execFile(CLAUDE_BIN, ['auth', 'status'], { env: childEnv(), windowsHide: true, timeout: 20000 }, (_error, out) => {
      try {
        const said = JSON.parse(out)
        const text = value => (typeof value === 'string' ? value.slice(0, 200) : '')

        resolve({
          isSignedIn: said.loggedIn === true,
          email: text(said.email),
          organization: text(said.orgName ?? said.organization),
          plan: text(said.subscriptionType),
          method: text(said.authMethod),
        })
      } catch {
        resolve({ isSignedIn: false })
      }
    })
  })

/** Claude Code's settings files for the person and for one project: user, project, local. */
const settingsFiles = project => [
  { which: 'user', label: 'Yours, for every project', file: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(app.getPath('home'), '.claude'), 'settings.json') },
  ...(project
    ? [
        { which: 'project', label: `This project (${project.name}), shared with it`, file: path.join(project.cwd, '.claude', 'settings.json') },
        { which: 'local', label: `This project (${project.name}), yours only`, file: path.join(project.cwd, '.claude', 'settings.local.json') },
      ]
    : []),
]

/** What a settings file sets, as short lists. Environment variables by name only: their values can be secrets. */
const summarizeSettings = file => {
  try {
    const said = JSON.parse(fs.readFileSync(file, 'utf8'))
    const words = value => (Array.isArray(value) ? value.filter(one => typeof one === 'string').slice(0, 200).map(one => one.slice(0, 160)) : [])
    const known = ['model', 'permissions', 'hooks', 'env', 'enabledPlugins']

    return {
      model: typeof said.model === 'string' ? said.model.slice(0, 80) : '',
      defaultMode: typeof said.permissions?.defaultMode === 'string' ? said.permissions.defaultMode.slice(0, 40) : '',
      allow: words(said.permissions?.allow),
      ask: words(said.permissions?.ask),
      deny: words(said.permissions?.deny),
      hooks: Object.entries(said.hooks ?? {}).map(([event, rules]) => `${event}: ${Array.isArray(rules) ? rules.length : 1}`).slice(0, 40),
      env: Object.keys(said.env ?? {}).slice(0, 80).map(one => one.slice(0, 80)),
      plugins: Object.entries(said.enabledPlugins ?? {}).filter(([, isOn]) => isOn === true).map(([name]) => name.slice(0, 80)).slice(0, 200),
      other: Object.keys(said).filter(key => !known.includes(key)).slice(0, 60).map(one => one.slice(0, 80)),
    }
  } catch {
    return { error: 'This file could not be read as settings (it may be half-written or not valid).' }
  }
}

// -------------------------------------------------------------- player window

/**
 * The music player is a real browser window with a profile of its own. A
 * small helper (deck/player-window.ps1) makes that window belong to the
 * Cla-Amp window: it sits docked beside it, minimises with it, has no
 * taskbar button, can be hidden while the music plays on, and closes with
 * the app. The helper only moves, shows, hides and closes the window; nothing
 * in it is read.
 */
let playerHelper = null
let playerState = { count: 0, hidden: false, shown: 0, hasClaude: false, hasPages: false }
// Cla-Amp was maximised and gave the player its strip of the screen: where it was before.
let dockedFrom = null
let isFitting = false
const PLAYER_LEAST = 340
let isRestarting = false
// The person said yes to closing while Claude works; not asked twice.
let isCloseAgreed = false
// Set while a restart waits for the work here to finish.
let idleRestart = null
/**
 * Where Claude Code writes a background task's output while it runs:
 * <temp>/claude/<a folder per project>/<chat id>/tasks/<task id>.output.
 * Both ids must be plain ids, so no other path can be made from them.
 */
const taskOutputFiles = (sessionId, taskId) => {
  if (!/^[\w-]{1,80}$/.test(String(sessionId ?? '')) || !/^[\w-]{1,80}$/.test(String(taskId ?? ''))) {
    return []
  }

  try {
    const base = path.join(os.tmpdir(), 'claude')

    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter(one => one.isDirectory())
      .slice(0, 400)
      .map(one => path.join(base, one.name, sessionId, 'tasks', `${taskId}.output`))
  } catch {
    return []
  }
}

/** What a background task that is not an agent is called in the list. */
const taskKind = type => {
  const name = String(type ?? '')

  return name.includes('workflow') ? 'Background workflow' : name.includes('monitor') ? 'Background monitor' : 'Background command'
}

const busySessions = () => [...sessions.values()].filter(one => one.isBusy || one.agentCount > 0 || one.queue.length > 0)

const restartNow = () => {
  let isGone = false
  const go = () => {
    if (!isGone) {
      isGone = true
      playerHelper?.kill()
      app.relaunch()
      app.quit()
    }
  }

  // The player is let go first, so the music plays on; the new run takes it back.
  // A restart the person asked for is not asked about again when the window closes.
  isRestarting = true

  if (playerHelper === null) {
    go()
  } else {
    playerHelper.once('exit', go)
    playerSay('release')
    setTimeout(go, 2500)
  }
}

/** After "Restart now and carry on": each chat that was working is told to go on, and its waiting messages are sent again. */
const CARRY_ON =
  'Cla-Amp was restarted to update itself, which stopped your last turn partway. Check what was already done, then carry on from where you stopped. Agents that were running in the background were stopped too; start them again only if their work is still needed.'

const carryOn = () => {
  const list = Array.isArray(state.carryOn) ? state.carryOn : []

  if (state.carryOn !== undefined) {
    delete state.carryOn
    saveState()
  }

  for (const one of IS_DEMO ? [] : list) {
    const session = sessionOf(one?.id)

    if (!session) {
      continue
    }

    if (one.wasWorking === true) {
      session.submit(CARRY_ON)
    }

    for (const prompt of Array.isArray(one.queue) ? one.queue : []) {
      if (typeof prompt === 'string') {
        session.submit(prompt)
      } else if (typeof prompt?.text === 'string') {
        session.submit(prompt.text, cleanFiles(prompt.files))
      }
    }
  }
}
let tray = null

/**
 * The icon by the clock: one place to bring Cla-Amp up, show or tuck away
 * its docked window, and quit. Quitting from here closes everything that
 * belongs to Cla-Amp, the hidden browser windows included.
 */
const refreshTray = () => {
  if (tray === null || win === null || win.isDestroyed()) {
    return
  }

  const hasDocked = playerState.count > 0 || playerState.hasClaude || playerState.hasPages
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Cla-Amp',
        click: () => {
          win.show()
          win.restore()
          win.focus()
        },
      },
      {
        label: playerState.hidden ? 'Show the docked window' : 'Hide the docked window',
        enabled: hasDocked,
        click: () => {
          state.prefs.playerHidden = !playerState.hidden
          saveState()
          playerSay(state.prefs.playerHidden ? 'hide' : 'show')
        },
      },
      { type: 'separator' },
      { label: 'Quit Cla-Amp (closes its player, claude.ai and browser windows too)', click: () => win.close() },
    ]),
  )
}

const startTray = () => {
  if (tray !== null || SHOT) {
    return
  }

  try {
    tray = new Tray(path.join(ROOT, 'renderer', 'brand', 'icon.ico'))
    tray.setToolTip('Cla-Amp')
    tray.on('click', () => {
      win?.show()
      win?.restore()
      win?.focus()
    })
    refreshTray()
  } catch {
    // No tray on this system: the window's own buttons do the same.
    tray = null
  }
}
let placeTimer = null
// YouTube Music's page fits a narrow window. Spotify's does not: below about
// 800 its sign-in button and song lists are cut off.
const PLAYER_WIDTH = { ytm: 460, spotify: 900, claude: 960, pages: 960 }
const playerProfile = () => path.join(dataDir(), 'player-profile')
// The profile of Cla-Amp's browser: its own, apart from the players' and from the person's everyday browser.
const pagesProfile = () => path.join(dataDir(), 'pages-profile')

/** How wide the attached window is: the width the person dragged it to, else the one that suits its page. */
const playerWidth = () => {
  const site = state.prefs.playerSite
  const own = Number(state.prefs.playerWidths?.[site])

  return own >= PLAYER_LEAST ? own : (PLAYER_WIDTH[site] ?? PLAYER_WIDTH.ytm)
}
let widthTimer = null

/** Remembers a width for the window on show. Saved a moment later, so a drag does not write the file at every step. */
const keepPlayerWidth = width => {
  const site = ['ytm', 'spotify', 'claude', 'pages'].includes(state.prefs.playerSite) ? state.prefs.playerSite : 'ytm'
  state.prefs.playerWidths = { ...(state.prefs.playerWidths ?? {}), [site]: Math.round(width) }
  clearTimeout(widthTimer)
  widthTimer = setTimeout(saveState, 800)
}

/**
 * The person dragged the attached window to a new width (in screen pixels):
 * the two windows stay locked side by side, so Cla-Amp gives up or takes
 * back the difference.
 */
const playerDragged = pixels => {
  if (isFitting || win === null || win.isDestroyed() || win.isMinimized() || win.isFullScreen() || win.isMaximized()) {
    return
  }

  const own = win.getBounds()
  const area = screen.getDisplayMatching(own).workArea
  const least = win.getMinimumSize()[0]
  const asked = screen.screenToDipRect(win, { x: 0, y: 0, width: pixels, height: 1 }).width
  const width = Math.round(Math.max(PLAYER_LEAST, Math.min(asked, area.width - least)))
  const right = area.x + area.width
  keepPlayerWidth(width)
  isFitting = true

  try {
    if (dockedFrom !== null) {
      // The two fill the screen: Cla-Amp takes what the other leaves.
      win.setBounds({ x: area.x, y: area.y, width: area.width - width, height: area.height })
    } else if (own.x + own.width + width > right && own.x - width < area.x) {
      // No room beside Cla-Amp for the new width: Cla-Amp narrows, down to its smallest.
      const mine = Math.max(least, right - width - Math.max(own.x, area.x))
      win.setBounds({ x: Math.max(area.x, Math.min(own.x, right - width - mine)), y: own.y, width: mine, height: own.height })
    }
  } finally {
    isFitting = false
  }
  placePlayer()
}

const playerSay = line => {
  if (playerHelper !== null && playerHelper.stdin.writable) {
    playerHelper.stdin.write(line + '\n')
  }
}

/**
 * The two windows share the screen. When Cla-Amp is maximised, or made so
 * wide that the player has no room beside it, Cla-Amp stops where the
 * player begins: it never lies under the player. Cla-Amp comes first: it
 * keeps at least its smallest width and the player narrows to what is left.
 */
const makeRoom = () => {
  if (isFitting || win === null || win.isDestroyed() || win.isMinimized() || win.isFullScreen() || playerState.shown === 0) {
    return
  }

  const isMax = win.isMaximized()
  const own = win.getBounds()
  const area = screen.getDisplayMatching(own).workArea
  const want = playerWidth()
  const least = win.getMinimumSize()[0]
  const width = Math.min(want, area.width - least)

  // A screen too small for both: the player lies over the edge, as before.
  if (width < PLAYER_LEAST) {
    return
  }

  const right = area.x + area.width

  if (!isMax && (own.x + own.width + PLAYER_LEAST <= right || own.x - want >= area.x)) {
    return
  }

  isFitting = true

  try {
    if (isMax) {
      dockedFrom = win.getNormalBounds()
      win.unmaximize()
      win.setBounds({ x: area.x, y: area.y, width: area.width - width, height: area.height })
    } else {
      const mine = Math.min(own.width, area.width - width)
      win.setBounds({ x: Math.max(area.x, Math.min(own.x, right - width - mine)), y: own.y, width: mine, height: own.height })
    }
  } finally {
    isFitting = false
  }
  send('amp:docked', dockedFrom !== null)
  placePlayer()
}

/** The player came on show or went away: Cla-Amp gives it room, or takes the whole screen back. */
const playerCameOrWent = () => {
  if (win === null || win.isDestroyed()) {
    return
  }

  if (playerState.shown > 0) {
    makeRoom()
  } else if (dockedFrom !== null) {
    dockedFrom = null
    win.maximize()
  }
}

/** Where the player goes: right of the Cla-Amp window, else left of it, else over its right edge. */
const playerRect = () => {
  if (win === null || win.isDestroyed() || win.isMinimized()) {
    return null
  }

  const own = win.getBounds()
  const area = screen.getDisplayMatching(own).workArea
  const want = Math.min(playerWidth(), area.width)
  const beside = area.x + area.width - (own.x + own.width)
  // While the two fill the screen, the attached window takes all that Cla-Amp
  // leaves: drag Cla-Amp's edge and the other follows, and keeps that width.
  const isLocked = dockedFrom !== null && !isFitting && beside >= PLAYER_LEAST

  if (isLocked && Math.abs(beside - want) > 2) {
    keepPlayerWidth(beside)
  }

  // Narrower than it likes, when that is what fits beside Cla-Amp.
  const width = isLocked ? beside : beside >= want || own.x - want >= area.x || beside < PLAYER_LEAST ? want : beside
  const y = Math.max(own.y, area.y)
  const height = Math.max(Math.min(own.y + own.height, area.y + area.height) - y, 200)
  const x = own.x + own.width + width <= area.x + area.width ? own.x + own.width : own.x - width >= area.x ? own.x - width : area.x + area.width - width

  return screen.dipToScreenRect(win, { x, y, width, height })
}

const placePlayer = () => {
  if (playerHelper === null || placeTimer !== null) {
    return
  }

  placeTimer = setTimeout(() => {
    placeTimer = null
    const rect = playerRect()

    if (rect !== null) {
      playerSay(`place ${Math.round(rect.x)} ${Math.round(rect.y)} ${Math.round(rect.width)} ${Math.round(rect.height)}`)
    }
  }, 30)
}

const startPlayerHelper = () => {
  if (playerHelper !== null || process.platform !== 'win32' || win === null || win.isDestroyed()) {
    return
  }

  const handle = win.getNativeWindowHandle()
  const owner = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
  const helper = spawn(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-Command', '& ([scriptblock]::Create([IO.File]::ReadAllText($env:CA_SCRIPT)))'],
    {
      env: { ...process.env, CA_SCRIPT: path.join(ROOT, 'deck', 'player-window.ps1'), CA_PROFILE: playerProfile(), CA_PAGES: pagesProfile(), CA_OWNER: String(owner) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', IS_DEV && process.env.CA_DEBUG ? 'inherit' : 'ignore'],
    },
  )
  playerHelper = helper
  helper.stdin.on('error', () => {})
  readline.createInterface({ input: helper.stdout }).on('line', line => {
    if (line.startsWith('#width ')) {
      const pixels = Number(line.slice(7))

      if (pixels > 0) {
        playerDragged(pixels)
      }

      return
    }

    if (line.startsWith('@')) {
      try {
        const said = JSON.parse(line.slice(1))
        const hadPlayer = playerState.shown > 0
        const sites = Array.isArray(said.sites) ? said.sites : []
        // count: the music players' windows; the claude.ai window is told apart.
        playerState = {
          count: Array.isArray(said.sites) ? sites.filter(one => one !== 'claude' && one !== 'pages').length : Number(said.count) || 0,
          hidden: said.hidden === true,
          shown: Number(said.shown) || 0,
          hasClaude: sites.includes('claude'),
          claudeCount: sites.filter(one => one === 'claude').length,
          hasPages: sites.includes('pages'),
        }
        playerSites = sites
        tellBrowserSite()

        if (hadPlayer !== playerState.shown > 0) {
          playerCameOrWent()
        }
        refreshTray()
        send('amp:player', playerState)
      } catch {
        // A cut line: the next one is whole.
      }
    }
  })
  helper.on('exit', () => {
    if (playerHelper === helper) {
      playerHelper = null
      playerState = { count: 0, hidden: false, shown: 0, hasClaude: false, hasPages: false }
      playerSites = []
      tellBrowserSite()
      playerCameOrWent()
      refreshTray()
      send('amp:player', playerState)
    }
  })

  playerSay(`site ${['spotify', 'claude', 'pages'].includes(state.prefs.playerSite) ? state.prefs.playerSite : 'ytm'}`)

  if (state.prefs.playerHidden === true) {
    playerSay('hide')
  }
  placePlayer()
}

// ----------------------------------------------------------------- audio deck

let deck = null
let deckSeq = 0
let deckLines = []
// Which players' browser windows are open, and what the music helper was last told.
let playerSites = []
let saidBrowserSite = ''

/**
 * Windows reports a browser's music under the browser's name, not the
 * site's. So the helper is told which player the browser window holds:
 * Spotify's web player then shows on the Spotify tab, not under YouTube
 * Music. With both open, the one on show counts.
 */
const tellBrowserSite = () => {
  const hasSpotify = playerSites.includes('spotify')
  const hasYtm = playerSites.includes('ytm')
  const site = hasSpotify && (!hasYtm || state.prefs.playerSite === 'spotify') ? 'spotify' : hasYtm ? 'ytm' : ''

  if (site !== saidBrowserSite && deck !== null) {
    saidBrowserSite = site
    deckCommand('web-site', site)
  }
}
const deckFile = () => path.join(dataDir(), 'deck-commands.txt')

// When the helper was started again after ending early, to stop a loop of restarts.
let deckRestarts = []

const startDeck = () => {
  if (deck !== null || process.platform !== 'win32') {
    return
  }

  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(deckFile(), '')
  deckSeq = 0
  deckLines = []
  // The script is read and run as text, so no script-policy setting is touched.
  deck = spawn(
    // By full path, so a look-alike elsewhere on the search path is never the one started.
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-Command', '& ([scriptblock]::Create([IO.File]::ReadAllText($env:CA_DECK)))'],
    {
      env: { ...process.env, CA_CMD: deckFile(), CA_DECK: path.join(ROOT, 'deck', 'deck.ps1'), CA_FAST: '1', CA_PROFILE: playerProfile(), CA_PAGES: pagesProfile() },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
  readline.createInterface({ input: deck.stdout }).on('line', line => {
    if (line.startsWith('@')) {
      try {
        send('amp:deck', JSON.parse(line.slice(1)))
      } catch {
        // A cut line: the next one is whole.
      }
    }
  })
  // A new helper knows nothing yet about the browser's player.
  saidBrowserSite = ''
  tellBrowserSite()
  deck.on('exit', () => {
    deck = null
    // The helper should live as long as the window. If it ends early, the
    // spectrum would stay dead: it is started again, a few times at most.
    const now = Date.now()
    deckRestarts = deckRestarts.filter(at => now - at < 300000)

    if (win !== null && !win.isDestroyed() && deckRestarts.length < 5) {
      deckRestarts.push(now)
      setTimeout(() => {
        if (win !== null && !win.isDestroyed()) {
          startDeck()
        }
      }, 2000)
    }
  })
}

const deckCommand = (command, argument = '') => {
  startDeck()
  deckSeq += 1
  deckLines = [...deckLines, `${deckSeq}|${command}|${argument}`].slice(-20)
  fs.writeFileSync(deckFile(), deckLines.join('\n'))

  return deckSeq
}

// The songs the deck may open: the ones found in the music folders, and the
// ones in a playlist the person picked. Never a path the page made up.
let knownSongs = new Set()
let tagCache = null
const tagFile = () => path.join(dataDir(), 'music-tags.json')

const musicFolders = () => {
  const saved = Array.isArray(state.prefs.musicFolders)
    ? state.prefs.musicFolders
    : [state.prefs.musicFolder ?? path.join(app.getPath('home'), 'Music')]

  return saved.filter(one => typeof one === 'string').slice(0, 40)
}

/** The playlist files the person imported: kept until they take one out of the app. */
const playlistFiles = () => (Array.isArray(state.prefs.playlists) ? state.prefs.playlists.filter(one => typeof one === 'string').slice(0, 40) : [])

/** Every song in the person's music folders, and their playlists, with details. Details are kept between runs. */
const scanSongs = () => {
  if (tagCache === null) {
    try {
      tagCache = JSON.parse(fs.readFileSync(tagFile(), 'utf8'))
    } catch {
      tagCache = {}
    }
  }

  const before = JSON.stringify(tagCache)
  const folders = musicFolders()
  const files = scanFolders(folders, tagCache)
  knownSongs = new Set(files.map(one => one.path))
  // Each playlist is read again from its file, so it follows what the file says now.
  const playlists = playlistFiles().map(file => {
    let songs = []
    let isMissing = false

    try {
      songs = readPlaylist(file)
        .map(one => describeSong(one, tagCache))
        .filter(Boolean)
    } catch {
      isMissing = true
    }

    for (const song of songs) {
      knownSongs.add(song.path)
    }

    return { file, name: path.basename(file).replace(/\.[^.]+$/, ''), files: songs, isMissing }
  })

  if (JSON.stringify(tagCache) !== before) {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.writeFile(tagFile(), JSON.stringify(tagCache), () => {})
  }

  return { folders, files, playlists }
}

// ---------------------------------------------------------------------- skins

const SKIN_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/i

/**
 * Reads a skin's stylesheet before the window may load it.
 *  - 'refused': it reaches outside its own folder (the internet, a network
 *    share, another folder) or pulls in another stylesheet. Never loaded.
 *  - 'colours': nothing but variables in one :root block. Safe to load.
 *  - 'full': rules of its own. It can restyle or hide anything in the window,
 *    the permission cards included, so the person is asked first.
 */
const checkSkin = css => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

  if (bare.includes('\\')) {
    return { kind: 'refused', why: 'It uses a backslash, which can hide what a rule really says.' }
  }

  if (/@import|@namespace|image-set\s*\(|expression\s*\(/i.test(bare)) {
    return { kind: 'refused', why: 'It pulls in another stylesheet or picture set.' }
  }

  // A picture or font must be a plain file name in the skin's own folder.
  for (const [, inner] of bare.matchAll(/url\s*\(([^)]*)\)/gi)) {
    if (!/^\s*(['"]?)[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}\1\s*$/.test(inner) || inner.includes('..')) {
      return { kind: 'refused', why: 'It loads a file from outside its own folder.' }
    }
  }

  // Outside url(), a quoted or bare address must not point at another computer.
  if (/(^|[\s:,(])(['"]?)(\/\/|[a-z][a-z0-9+.-]*:\/\/)/i.test(bare.replace(/url\s*\([^)]*\)/gi, ''))) {
    return { kind: 'refused', why: 'It names an address on another computer.' }
  }

  const block = /^\s*:root\s*\{([^{}]*)\}\s*$/.exec(bare)
  const isOnlyVariables =
    bare.trim() === '' ||
    (block !== null &&
      block[1]
        .split(';')
        .map(one => one.trim())
        .filter(Boolean)
        .every(one => /^--[\w-]+\s*:[^@]+$/.test(one)))

  return { kind: isOnlyVariables ? 'colours' : 'full', why: '' }
}
const userSkins = () => path.join(dataDir(), 'skins')

/**
 * The skins on this computer: the ones the app ships with, then the person's
 * own. A skin is a folder holding skin.css and skin.json and nothing that
 * runs: the window loads the stylesheet and never a script from it.
 */
const listSkins = () => {
  const found = []

  for (const [folder, isOwn] of [
    [path.join(ROOT, 'skins'), false],
    [userSkins(), true],
  ]) {
    let names = []

    try {
      names = fs
        .readdirSync(folder, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && SKIN_NAME.test(entry.name))
        .map(entry => entry.name)
        .sort()
    } catch {
      continue
    }

    for (const name of names.slice(0, 200)) {
      const sheet = path.join(folder, name, 'skin.css')
      let about = {}

      try {
        // A stylesheet far larger than any skin needs is left out.
        if (fs.statSync(sheet).size > 2 * 1024 * 1024) {
          continue
        }

        about = JSON.parse(fs.readFileSync(path.join(folder, name, 'skin.json'), 'utf8').slice(0, 20000))
      } catch (error) {
        if (!fs.existsSync(sheet)) {
          continue
        }
      }

      // What the stylesheet holds decides how far it is trusted.
      let kind = 'refused'
      let why = ''

      try {
        const checked = checkSkin(fs.readFileSync(sheet, 'utf8'))
        kind = checked.kind
        why = checked.why
      } catch {
        why = 'The stylesheet could not be read.'
      }

      const words = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : fallback)
      found.push({
        id: `${isOwn ? 'mine' : 'built-in'}/${name}`,
        name: words(about?.name, name),
        author: words(about?.author, ''),
        description: words(about?.description, ''),
        isOwn,
        kind,
        why,
        sheet,
        url: pathToFileURL(sheet).href,
      })
    }
  }

  return found
}

/**
 * The variables of a skin that name a picture, with each picture's address
 * made whole. A picture named in a variable would otherwise be looked for
 * beside the app's own stylesheet, where the variable is used, and not in
 * the skin's folder. Only plain file names get here: checkSkin refuses the rest.
 */
const skinPictures = sheet => {
  const found = {}

  try {
    const bare = fs.readFileSync(sheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const block = /:root\s*\{([^{}]*)\}/.exec(bare)

    for (const one of (block?.[1] ?? '').split(';')) {
      const [, name, value] = /^\s*(--[\w-]+)\s*:([\s\S]+)$/.exec(one) ?? []

      if (name && /url\s*\(/i.test(value)) {
        found[name] = value
          .trim()
          .replace(/url\s*\(\s*(['"]?)([A-Za-z0-9][A-Za-z0-9 _.-]{0,80})\1\s*\)/gi, (_all, _quote, file) =>
            `url("${pathToFileURL(path.join(path.dirname(sheet), file)).href}")`,
          )
      }
    }
  } catch {
    // A sheet that cannot be read has no pictures to place.
  }

  return found
}

// ------------------------------------------------------------------ dictation

/**
 * Speech to text for the message box. A helper script runs only while the
 * microphone button is on; it uses Windows' built-in recogniser, so the
 * sound never leaves the computer and the window itself is never given the
 * microphone. See deck/dictate.ps1.
 */
let dictation = null

const stopDictation = () => {
  dictation?.kill()
  dictation = null
}

const startDictation = () => {
  if (process.platform !== 'win32') {
    return { error: 'Dictation works on Windows only.' }
  }

  if (dictation !== null) {
    return { isOn: true }
  }

  const helper = spawn(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-Command', '& ([scriptblock]::Create([IO.File]::ReadAllText($env:CA_DICTATE)))'],
    {
      env: { ...process.env, CA_DICTATE: path.join(ROOT, 'deck', 'dictate.ps1'), CA_WAV: IS_DEV ? (process.env.CA_WAV ?? '') : '' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
  dictation = helper
  readline.createInterface({ input: helper.stdout }).on('line', line => {
    if (!line.startsWith('@')) {
      return
    }

    try {
      const heard = JSON.parse(line.slice(1))
      // Only the fields the window expects, as plain text.
      send('amp:dictate', {
        ...(heard.ready ? { ready: true } : {}),
        ...(heard.done ? { done: true } : {}),
        ...(typeof heard.text === 'string' ? { text: heard.text.slice(0, 2000) } : {}),
        ...(typeof heard.error === 'string' ? { error: heard.error.slice(0, 300) } : {}),
      })
    } catch {
      // A cut line: the next one is whole.
    }
  })
  helper.on('exit', () => {
    if (dictation === helper) {
      dictation = null
      send('amp:dictate', { done: true })
    }
  })
  helper.on('error', () => {})

  return { isOn: true }
}

// --------------------------------------------------------------- live updates

/**
 * Tells the open window when the app's own files or a skin change on disk, so
 * a change shows without closing the app. Three kinds: 'styles' (put on at
 * once), 'page' (the window offers to reload itself) and 'app' (the window
 * offers a restart). Nothing is fetched and nothing new is run: the window
 * only reads again the same local files it reads when it opens.
 */
const updateKinds = new Set()
let updateTimer = null

const noteUpdate = kind => {
  updateKinds.add(kind)
  clearTimeout(updateTimer)
  // Editors save in several writes; wait for them to settle.
  updateTimer = setTimeout(() => {
    for (const one of updateKinds) {
      send('amp:update', { kind: one })
    }
    updateKinds.clear()
  }, 400)
}

const watchingSince = Date.now()
const lastSaved = new Map()

const watchForUpdates = () => {
  const watch = (folder, isDeep, kindOf) => {
    try {
      const watcher = fs.watch(folder, { recursive: isDeep }, (_change, name) => {
        const kind = name ? kindOf(String(name).replace(/\\/g, '/')) : ''

        if (!kind) {
          return
        }

        // Windows also reports a file being read. Only a save counts: the
        // file's own "last written" time must have moved on.
        const file = path.join(folder, String(name))
        let savedAt = Date.now()

        try {
          savedAt = fs.statSync(file).mtimeMs
        } catch {
          // Gone: a deleted file is a change too.
        }

        if (savedAt > (lastSaved.get(file) ?? watchingSince)) {
          lastSaved.set(file, savedAt)
          noteUpdate(kind)
        }
      })
      watcher.on('error', () => {})
    } catch {
      // A folder that cannot be watched just means no live updates from it.
    }
  }

  // The person's own skins, so a skin maker sees each save.
  watch(dataDir(), true, name => (/^skins\/.+\.(css|json|png|jpe?g|gif|bmp|webp|svg)$/i.test(name) ? 'styles' : ''))

  // An installed copy's own files do not change while it runs.
  if (app.isPackaged) {
    return
  }

  watch(path.join(ROOT, 'skins'), true, name => (/\.(css|json|png|jpe?g|gif|bmp|webp|svg)$/i.test(name) ? 'styles' : ''))
  watch(path.join(ROOT, 'renderer'), true, name => (/\.css$/i.test(name) ? 'styles' : /\.(js|html)$/i.test(name) ? 'page' : ''))
  watch(ROOT, false, name => (/^[^/]+\.(mjs|cjs)$/i.test(name) || name === 'package.json' ? 'app' : ''))
  watch(path.join(ROOT, 'deck'), true, () => 'app')
}

// ---------------------------------------------------------------------- calls

/** A call whose failure is told to the window as words, not thrown at it. */
// What the Claude desktop app knows about its own chats: the title it shows,
// whether it archived the chat, the project a worktree chat belongs to, and
// which chat started it. Only read, never written: the app's records are its
// own, their layout is not documented, and a record that does not look as
// expected is skipped. Kept for twenty seconds.
const desk = { at: 0, byChat: new Map() }

const deskFolders = () => {
  const found = []
  const local = process.env.LOCALAPPDATA

  // Installed from the Store, the app keeps its data one folder further in.
  if (local && fs.existsSync(path.join(local, 'Claude-Data'))) {
    for (const one of fs.readdirSync(path.join(local, 'Claude-Data'), { withFileTypes: true })) {
      if (one.isDirectory()) {
        found.push(path.join(local, 'Claude-Data', one.name, 'claude-code-sessions'))
      }
    }
  }
  found.push(path.join(app.getPath('appData'), 'Claude', 'claude-code-sessions'))

  return found.filter(one => fs.existsSync(one))
}

const deskChats = () => {
  if (IS_DEMO || Date.now() - desk.at < 20000) {
    return desk.byChat
  }

  desk.at = Date.now()
  const records = []
  const walk = (dir, depth) => {
    for (const one of fs.readdirSync(dir, { withFileTypes: true })) {
      if (records.length >= 4000) {
        return
      }

      const full = path.join(dir, one.name)

      if (one.isDirectory() && depth < 3) {
        walk(full, depth + 1)
      } else if (/^local_[0-9a-f-]{36}\.json$/i.test(one.name)) {
        try {
          // Null when it is too large; reading that as JSON fails, and the record is skipped like any unreadable one.
          const said = JSON.parse(String(readCapped(full, 4000000) ?? ''))

          if (typeof said?.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(String(said.cliSessionId))) {
            records.push(said)
          }
        } catch {
          // Half-written or not what was expected: left out this time.
        }
      }
    }
  }

  try {
    for (const dir of deskFolders()) {
      walk(dir, 0)
    }
  } catch {
    return desk.byChat
  }

  const chatOf = new Map(records.map(one => [one.sessionId, one.cliSessionId]))
  const byChat = new Map()

  for (const one of records) {
    const about = {
      title: typeof one.title === 'string' ? one.title.replace(/\s+/g, ' ').trim().slice(0, 140) : '',
      isArchived: one.isArchived === true,
      folder: typeof one.originCwd === 'string' ? one.originCwd.slice(0, 500) : '',
      parent: chatOf.get(one.spawnedFrom?.sessionId) ?? '',
      // Its pull requests as the desktop app last saw them: number, repository, state and branch.
      prs: (Array.isArray(one.prs) ? one.prs : [])
        .filter(pr => Number.isInteger(pr?.prNumber) && typeof pr.repo === 'string')
        .slice(0, 60)
        .map(pr => ({
          number: pr.prNumber,
          repo: pr.repo.slice(0, 100),
          state: ['MERGED', 'OPEN', 'CLOSED'].includes(pr.state) ? pr.state : '',
          branch: String(pr.branch ?? '').slice(0, 120),
        })),
      at: Number(one.lastActivityAt) || 0,
    }
    const ids = [one.cliSessionId, ...(Array.isArray(one.priorCliSessionIds) ? one.priorCliSessionIds : [])]

    for (const id of ids) {
      if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) && (byChat.get(id)?.at ?? -1) < about.at) {
        byChat.set(id, about)
      }
    }
  }
  desk.byChat = byChat

  return byChat
}

// Which saved chats this app's engine started: such a chat's file names the
// engine's entry point in its first lines ("sdk-ts"; the desktop app writes
// "claude-desktop", a terminal "cli"). Only those may be archived or deleted
// from here. The answer for a chat never changes, so it is kept.
const madeHereKept = new Map()

const madeHere = (sessionId, cwd) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId)) || typeof cwd !== 'string') {
    return false
  }

  if (!madeHereKept.has(sessionId)) {
    let isOurs = false

    try {
      const file = path.join(chatsFolder(), cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl')
      const handle = fs.openSync(file, 'r')
      const part = Buffer.alloc(200000)
      const size = fs.readSync(handle, part, 0, part.length, 0)
      fs.closeSync(handle)
      isOurs = /"entrypoint":"([^"]*)"/.exec(part.subarray(0, size).toString('utf8'))?.[1] === 'sdk-ts'
    } catch {
      // Not where expected: treated as not ours.
    }
    madeHereKept.set(sessionId, isOurs)
  }

  return madeHereKept.get(sessionId) && !deskChats().has(sessionId)
}

// A theme's later layout settings, each cleaned to what the window itself would keep. undefined: not in the theme.
const themeSwitch = value => (['0', '1', ''].includes(value) ? value : undefined)
const themeWidth = value => (value === '' ? '' : typeof value === 'string' && /^\d{3}$/.test(value) && Number(value) >= 200 && Number(value) <= 900 ? value : undefined)
const themeText = (value, clean) => {
  if (value === '') {
    return ''
  }

  if (typeof value !== 'string' || value.length > 6000) {
    return undefined
  }

  try {
    return JSON.stringify(clean(JSON.parse(value)))
  } catch {
    return undefined
  }
}

/**
 * Archives or deletes a chat that was made in this app. A chat from the
 * desktop app or a terminal is refused, and so is one that is open here.
 */
const putAway = async (sessionId, cwd, isDelete) => {
  const id = String(sessionId)
  const folder = realFolder(cwd)

  if (folder === null || !madeHere(id, String(cwd)) || !(await getSessionInfo(id, { dir: folder }).catch(() => undefined))) {
    return { error: 'Only a chat that was made in Cla-Amp can be archived or deleted here.' }
  }

  if (state.projects.some(one => one.sessionId === id)) {
    return { error: 'This chat is open in a project. Start a new chat there (or open another one) first.' }
  }

  if (isDelete) {
    const title = titleOf((await getSessionInfo(id, { dir: folder })) ?? {})
    const picked = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Cla-Amp',
      message: 'Delete this chat for good?',
      detail: `${title}\n${folder}\n\nThe saved conversation is removed from this computer. This cannot be undone. Archive it instead to only hide it.`,
      buttons: ['Keep it', 'Delete'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })

    if (picked.response !== 1) {
      return { isOk: false }
    }

    await deleteSession(id, { dir: folder })
  } else {
    await archiveSession(id, { dir: folder })
  }
  readChats.delete(id)

  return { isOk: true }
}

// ---- themes: a skin plus the person's own changes, saved under a name.
// Each is one small file in this app's own "themes" folder. What a file may
// hold is fixed here, and everything read from one is cleaned the same way.
const themesFolder = () => path.join(dataDir(), 'themes')
const THEME_FILE = /^[a-z0-9-]{1,50}$/

const cleanTheme = raw => {
  const layout = raw?.layout && typeof raw.layout === 'object' ? raw.layout : {}
  const words = (list, most, long) => (Array.isArray(list) ? list.filter(one => typeof one === 'string' && one.length <= long).slice(0, most) : undefined)
  const name = String(raw?.name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 60)

  if (name === '' || typeof raw?.skin !== 'string' || raw.skin.length > 80) {
    return null
  }

  const kept = {
    panels: Array.isArray(layout.panels) ? layout.panels.filter(one => Array.isArray(one) && typeof one[0] === 'string' && one[0].length <= 30).slice(0, 40).map(one => [one[0], one[1] === true, one[2] === 1 ? 1 : 0]) : undefined,
    widgets: words(layout.widgets, 10, 20),
    zones: words(layout.zones, 5, 60),
    playerSize: ['s', 'm', 'l'].includes(layout.playerSize) ? layout.playerSize : undefined,
    col2: ['0', '1', 0, 1].includes(layout.col2) ? String(layout.col2) : undefined,
    // Kept as the window keeps them: short strings ('' for "not set"), the two lists as text.
    places: themeText(layout.places, value => {
      const slots = ['brand', 'transport', 'statusbar', 'centerTop', 'leftBottom', 'right', 'right2']

      return Object.fromEntries(slots.filter(slot => Array.isArray(value?.[slot])).map(slot => [slot, value[slot].filter(one => typeof one === 'string' && /^[\w:-]{1,40}$/.test(one)).slice(0, 40)]))
    }),
    layout: themeText(layout.layout, value => {
      const picks = { projects: ['left', 'right'], panels: ['right', 'left'], status: ['top', 'bottom'], eq: ['m', 's', 'l'] }

      return {
        ...Object.fromEntries(Object.entries(picks).filter(([key, allowed]) => allowed.includes(value?.[key])).map(([key]) => [key, value[key]])),
        // A typeface's name only: the window offers it when it is one it knows.
        ...(typeof value?.font === 'string' && /^[\w .-]{1,40}$/.test(value.font) ? { font: value.font } : {}),
      }
    }),
    sideTall: themeSwitch(layout.sideTall),
    'hide-left': themeSwitch(layout['hide-left']),
    'hide-right': themeSwitch(layout['hide-right']),
    topPlayer: themeSwitch(layout.topPlayer),
    'width-left': themeWidth(layout['width-left']),
    'width-right': themeWidth(layout['width-right']),
    'width-right2': themeWidth(layout['width-right2']),
    sideLinked: themeSwitch(layout.sideLinked),
    // The panels put away: their names only.
    hiddenPanels: themeText(layout.hiddenPanels, value => (Array.isArray(value) ? value.filter(one => typeof one === 'string' && /^[\w-]{1,30}$/.test(one)).slice(0, 30) : [])),
    // Which parts of the status bar show: known names, each on or off.
    statusItems: themeText(layout.statusItems, value =>
      Object.fromEntries(['agents', 'context', 'branch', 'model', 'effort', 'limits', 'date', 'time', 'state'].filter(id => typeof value?.[id] === 'boolean').map(id => [id, value[id]])),
    ),
  }

  return {
    name,
    skin: raw.skin,
    look: cleanLook(raw.look),
    layout: Object.fromEntries(Object.entries(kept).filter(([, value]) => value !== undefined)),
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now(),
  }
}

const listThemes = () => {
  try {
    return fs
      .readdirSync(themesFolder())
      .filter(one => one.endsWith('.json') && THEME_FILE.test(one.slice(0, -5)))
      .slice(0, 200)
      .map(one => {
        try {
          const file = path.join(themesFolder(), one)
          const bytes = readCapped(file, 300000)
          const theme = bytes === null ? null : cleanTheme(JSON.parse(bytes.toString('utf8')))

          return theme ? { ...theme, file: one.slice(0, -5) } : null
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

const saveTheme = raw => {
  const theme = cleanTheme({ ...raw, savedAt: Date.now() })

  if (theme === null) {
    return { error: 'A theme needs a name.' }
  }

  const file = theme.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'theme'
  fs.mkdirSync(themesFolder(), { recursive: true })
  fs.writeFileSync(path.join(themesFolder(), file + '.json'), JSON.stringify(theme, null, 2))

  // A rename: the file under the old name goes.
  if (typeof raw?.replaces === 'string' && THEME_FILE.test(raw.replaces) && raw.replaces !== file) {
    fs.rmSync(path.join(themesFolder(), raw.replaces + '.json'), { force: true })
  }

  return { ...theme, file }
}

// ---- widgets: today's numbers.

// Today across every chat on this computer: how many were worked on, and how
// many messages the person sent. Counted from the end of each chat's file
// that changed today (the last four megabytes), at most once a minute.
const todayKept = { at: 0, said: null }

// What each chat's Claude Code is using of the computer: processor and memory,
// for the list of working chats. Windows is asked for its process list (ids,
// memory, processor time; names only for Claude Code's own processes), and
// each chat's process is summed with everything it started (commands,
// connectors). Agents run inside their chat's process, so they are part of
// its numbers and cannot be told apart.
const LOAD_ASK =
  "Get-CimInstance Win32_Process | ForEach-Object { $r = ''; if ($_.Name -eq 'claude.exe' -and [string]$_.CommandLine -match '--resume[= ]([0-9a-f-]{36})') { $r = $Matches[1] }; '{0}|{1}|{2}|{3}|{4}|{5}' -f $_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, ([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime), $_.Name, $r }"
const loadKept = { at: 0, times: new Map(), said: {}, isAsking: false }

const workLoad = () =>
  new Promise(resolve => {
    if (process.platform !== 'win32' || IS_DEMO || loadKept.isAsking || Date.now() - loadKept.at < 3000) {
      resolve(loadKept.said)

      return
    }

    loadKept.isAsking = true
    execFile(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-Command', LOAD_ASK],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (_error, out) => {
        loadKept.isAsking = false
        const now = Date.now()
        const all = new Map()
        const children = new Map()

        for (const line of String(out ?? '').split(/\r?\n/)) {
          const [id, parent, memory, time, name, resume] = line.split('|')

          if (name === undefined || !(Number(id) > 0)) {
            continue
          }

          all.set(Number(id), { id: Number(id), memory: Number(memory) || 0, time: Number(time) || 0, name, resume })
          children.set(Number(parent), [...(children.get(Number(parent)) ?? []), Number(id)])
        }

        // A chat's process and everything under it.
        const sum = root => {
          let memory = 0
          let time = 0
          let count = 0
          const seen = new Set()
          const walk = id => {
            const one = all.get(id)

            if (!one || seen.has(id) || seen.size > 400) {
              return
            }
            seen.add(id)
            memory += one.memory
            time += one.time
            count += 1
            ;(children.get(id) ?? []).forEach(walk)
          }
          walk(root)

          return { memory, time, count }
        }
        const roots = (children.get(process.pid) ?? []).map(id => all.get(id)).filter(one => one?.name === 'claude.exe')
        const said = {}
        const times = new Map()
        const span = (now - loadKept.at) / 1000
        const cores = Math.max(1, os.cpus().length)
        const open = [...sessions.values()].filter(one => one.query)
        const left = new Set(roots.map(one => one.id))
        const tell = (session, root) => {
          const total = sum(root.id)
          const before = loadKept.times.get(root.id)
          left.delete(root.id)
          times.set(root.id, total.time)
          said[session.project.id] = {
            // Share of the whole processor, all its cores together, since the look before.
            cpu: before !== undefined && span > 0 && span < 60 ? Math.max(0, Math.round((((total.time - before) / 1e7 / span) * 100) / cores)) : null,
            mb: Math.round(total.memory / 1048576),
            count: total.count,
          }
        }

        for (const session of open) {
          const root = roots.find(one => one.resume && one.resume === session.project.sessionId)

          if (root) {
            tell(session, root)
          }
        }

        // A new chat's process carries no name yet: when just one of each is left, they belong together.
        const unnamed = open.filter(one => said[one.project.id] === undefined)

        if (unnamed.length === 1 && left.size === 1) {
          tell(unnamed[0], all.get([...left][0]))
        }

        loadKept.at = now
        loadKept.times = times
        loadKept.said = said
        resolve(said)
      },
    )
  })

const two = number => String(number).padStart(2, '0')
const dayKeyOf = date => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
let spendTimer = null

/**
 * Adds a finished turn's tokens and cost to the day's tally, for the
 * calendar. The numbers are Claude Code's own: its running totals for the
 * process, so each turn adds what is new since the turn before. The cost is
 * what the tokens would cost at API prices; a plan is not billed this way.
 */
const noteSpend = (session, message) => {
  const models = Object.values(message.modelUsage ?? {})
  const sum = pick => models.reduce((total, one) => total + (Number(one?.[pick]) || 0), 0)
  const now = {
    cost: Number(message.total_cost_usd) || 0,
    input: sum('inputTokens'),
    output: sum('outputTokens'),
    cacheRead: sum('cacheReadInputTokens'),
    cacheWrite: sum('cacheCreationInputTokens'),
  }
  const before = session.spent ?? { cost: 0 }
  // A total lower than the one before means a new count began.
  const isNew = now.cost < (before.cost ?? 0)
  const more = key => Math.max(0, now[key] - (isNew ? 0 : before[key] ?? 0))
  session.spent = now

  if (IS_DEMO || more('cost') + more('input') + more('output') + more('cacheRead') + more('cacheWrite') === 0) {
    return
  }

  const days = (state.days ??= {})
  const day = (days[dayKeyOf(new Date())] ??= { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })

  for (const key of ['cost', 'input', 'output', 'cacheRead', 'cacheWrite']) {
    day[key] = (day[key] ?? 0) + more(key)
  }
  day.turns = (day.turns ?? 0) + 1

  // About a year is kept.
  for (const old of Object.keys(days).sort().slice(0, -400)) {
    delete days[old]
  }
  clearTimeout(spendTimer)
  spendTimer = setTimeout(saveState, 1500)
}

const todayStats = async () => {
  if (Date.now() - todayKept.at < 55000 && todayKept.said) {
    return todayKept.said
  }

  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const since = start.getTime()
  const chats = (await listSessions({ limit: 5000 })).filter(one => one.lastModified >= since && one.cwd)
  let prompts = 0

  for (const one of chats.slice(0, 60)) {
    try {
      const file = path.join(chatsFolder(), one.cwd.replace(/[^a-zA-Z0-9]/g, '-'), one.sessionId + '.jsonl')
      const part = readTail(file, 4000000)

      for (const line of part.toString('utf8').split('\n')) {
        // A message the person typed: a user entry that is not a tool's answer, a note of the app's or an agent's.
        if (!line.startsWith('{') || !line.includes('"type":"user"') || line.includes('"tool_result"') || line.includes('"isMeta":true') || line.includes('"isSidechain":true')) {
          continue
        }

        const when = /"timestamp":"([^"]+)"/.exec(line)?.[1]

        if (when && Date.parse(when) >= since && !line.includes('<task-notification>') && !line.includes('<system-reminder>\\nCalled')) {
          prompts += 1
        }
      }
    } catch {
      // A chat that moved or is being written: left out this time.
    }
  }
  todayKept.at = Date.now()
  // The names of the chats too, for the calendar's report of the day.
  todayKept.said = { chats: chats.length, prompts, titles: chats.slice(0, 40).map(titleOf) }

  return todayKept.said
}

/** A chat's title: the desktop app's own when it has one for this chat. */
const titleOf = one => String(deskChats().get(one.sessionId)?.title || one.customTitle || one.summary || one.firstPrompt || 'Untitled').slice(0, 140)

const guarded = async run => {
  try {
    return (await run()) ?? { isOk: true }
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)

    return {
      error: /authenticat|oauth|log ?in|api key/i.test(said) ? 'Claude Code is not signed in on this computer.' : said,
    }
  }
}

const handlers = {
  'state:load': () => ({
    isDemo: IS_DEMO,
    projects: state.projects.map(describe),
    prefs: state.prefs,
  }),
  'project:add': async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a project folder',
      properties: ['openDirectory'],
    })
    const cwd = picked.filePaths[0]

    if (picked.canceled || !cwd) {
      return null
    }

    const existing = state.projects.find(one => one.cwd === cwd)

    if (existing) {
      return describe(existing)
    }

    const project = { id: randomUUID(), name: path.basename(cwd), cwd, mode: 'default', sessionId: null }
    project.isTrusted = await askTrust(cwd)
    state.projects.push(project)
    saveState()

    return describe(project)
  },
  'project:remove': id => {
    sessions.get(id)?.reset()
    sessions.delete(id)
    state.projects = state.projects.filter(one => one.id !== id)
    saveState()
  },
  // Stay awake, on or off; kept for the next start.
  'awake:set': isOn => {
    state.prefs.keepAwake = isOn === true
    saveState()

    return setAwake(isOn === true)
  },
  // What an agent of a chat did, from Claude Code's own saved file. Read only.
  'agent:read': (id, toolId) => readAgent(id, toolId),
  'project:transcript': id => (state.projects.some(one => one.id === id) ? readTranscript(id) : []),
  'project:send': async (id, text, files, isNow) => {
    const project = state.projects.find(one => one.id === id)

    if (project) {
      await askServers(project)
    }

    return sessionOf(id)?.submit(String(text), cleanFiles(files), isNow === true)
  },
  // "Attach": the person picks files; only their paths come back.
  'attach:pick': async () => {
    const picked = await dialog.showOpenDialog(win, { title: 'Attach files', properties: ['openFile', 'multiSelections'] })

    return picked.canceled ? [] : cleanFiles(picked.filePaths)
  },
  // A picture pasted from the clipboard has no file, so it is saved in this app's own folder first.
  'attach:paste': dataUrl => {
    const found = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === 'string' && dataUrl.length < 16000000 ? dataUrl : '')

    if (!found) {
      return null
    }

    const folder = path.join(dataDir(), 'attachments')
    const file = path.join(folder, `pasted-${createHash('sha1').update(found[2]).digest('hex').slice(0, 12)}.${PICTURE_KINDS[found[1]]}`)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(file, Buffer.from(found[2], 'base64'))

    return file
  },
  'project:stop': id => sessionOf(id)?.stop(),
  // Stops one background agent or command of a chat; the chat itself carries on.
  // What a background command of a chat is doing or did, for its row.
  'task:read': async (id, taskId) => (typeof taskId === 'string' ? ((await sessionOf(id)?.readTask(taskId)) ?? { error: 'That chat is not open any more.' }) : null),
  'task:stop': async (id, taskId) => (typeof taskId === 'string' ? (await sessionOf(id)?.stopTask(taskId)) === true : false),
  // What is saved about a project (its model and effort among it), answered at once: no Claude Code process is started for it.
  'project:describe': id => {
    const project = state.projects.find(one => one.id === id)

    return project ? describe(project) : null
  },
  'project:new': id => sessionOf(id)?.reset(),
  'project:mode': (id, mode) => (MODES.includes(mode) ? sessionOf(id)?.setMode(mode) : undefined),
  'project:permission': (id, askId, decision, answers) => sessionOf(id)?.decide(askId, decision, answers),
  'project:branch': id => {
    const project = state.projects.find(one => one.id === id)

    return project ? branchOf(project.cwd) : ''
  },
  'sessions:list': async id => {
    const project = state.projects.find(one => one.id === id)

    if (!project) {
      return []
    }

    const found = await listSessions({ dir: project.cwd, limit: 80 })

    return found
      .filter(one => !one.archived && !(deskChats().get(one.sessionId)?.isArchived && one.sessionId !== project.sessionId))
      .sort((a, b) => b.lastModified - a.lastModified)
      .map(one => ({
        id: one.sessionId,
        title: titleOf(one),
        lastModified: one.lastModified,
        size: one.fileSize ?? 0,
        isCurrent: one.sessionId === project.sessionId,
      }))
  },
  // Opens a saved conversation and continues it, whichever app made it.
  'sessions:open': async (id, sessionId) => {
    const project = state.projects.find(one => one.id === id)
    const place = project ? placeFor(project.cwd, String(sessionId), id) : null

    if (!place) {
      return null
    }

    return place.isOpen ? { project: describe(place.project), isOpen: true } : openSaved(place.project, String(sessionId))
  },
  // A new chat in the same folder beside one that is working: one more entry in the list.
  'project:another': id => {
    const project = state.projects.find(one => one.id === id)

    if (!project) {
      return null
    }

    const free = state.projects.find(one => one.id !== id && sameFolder(one.cwd, project.cwd) && isFree(one))

    if (free) {
      sessionOf(free.id)?.reset()
    }

    return describe(free ?? anotherFor(project))
  },
  // A new chat that holds this one up to one of Claude's replies; the first stays as it is.
  'chats:fork': (id, uuid) =>
    guarded(async () => {
      const project = state.projects.find(one => one.id === id)

      if (!project?.sessionId) {
        return { error: 'There is no saved chat here to fork yet.' }
      }

      if (sessionOf(id).isBusy) {
        return { error: 'Claude is still working here. Wait for it or stop it, then fork.' }
      }

      const upTo = /^[0-9a-f-]{36}$/i.test(String(uuid)) ? { upToMessageId: String(uuid) } : {}
      const made = await forkSession(project.sessionId, { dir: project.cwd, ...upTo })
      state.own ??= []
      state.own.push(made.sessionId)
      saveState()

      const opened = await openSaved(project, made.sessionId)

      // The window says so in the chat: a fork looks just like the chat it was made from.
      return opened.error ? opened : { ...opened, forkId: made.sessionId }
    }),
  'text:copy': text => {
    clipboard.writeText(String(text ?? '').slice(0, 400000))

    return true
  },
  // Every saved conversation on this computer, newest first, for the Chats tab.
  'chats:all': async () => {
    const found = await listSessions({ limit: 5000 })
    const copies = state.copies ?? {}
    const hidden = new Set(Object.values(copies))
    const byId = new Map(found.map(one => [one.sessionId, one]))

    const known = deskChats()

    return found
      .filter(one => !one.archived && one.cwd && !hidden.has(one.sessionId) && !known.get(one.sessionId)?.isArchived)
      .map(one => ({
        id: one.sessionId,
        title: titleOf(one),
        cwd: one.cwd,
        // As the desktop app has it: the project a worktree chat belongs to, and the chat that started this one.
        group: known.get(one.sessionId)?.folder || one.cwd,
        parent: known.get(one.sessionId)?.parent ?? '',
        isDesk: known.has(one.sessionId),
        prs: known.get(one.sessionId)?.prs ?? [],
        // Made in this app: it can be archived or deleted from here.
        isOurs: madeHere(one.sessionId, one.cwd),
        // A chat continued here shows when it was last touched here.
        lastModified: Math.max(one.lastModified, byId.get(copies[one.sessionId])?.lastModified ?? 0),
        size: one.fileSize ?? 0,
      }))
      .sort((a, b) => b.lastModified - a.lastModified)
  },
  'themes:list': () => listThemes(),
  'themes:save': raw => guarded(() => saveTheme(raw)),
  'themes:delete': file => {
    if (THEME_FILE.test(String(file))) {
      fs.rmSync(path.join(themesFolder(), file + '.json'), { force: true })
    }

    return true
  },
  // The person picks where a copy of a saved theme goes.
  'themes:export': file =>
    guarded(async () => {
      const theme = listThemes().find(one => one.file === file)

      if (!theme) {
        return { error: 'That theme is not there any more.' }
      }

      const picked = await dialog.showSaveDialog(win, { title: 'Export theme', defaultPath: theme.file + '.claamp-theme.json', filters: [{ name: 'Cla-Amp theme', extensions: ['json'] }] })

      if (!picked.canceled && picked.filePath) {
        const { file: _file, ...plain } = theme
        fs.writeFileSync(picked.filePath, JSON.stringify(plain, null, 2))
      }

      return { isOk: !picked.canceled }
    }),
  // The person picks a theme file; what it holds is cleaned like any theme, then kept.
  'themes:import': () =>
    guarded(async () => {
      const picked = await dialog.showOpenDialog(win, { title: 'Import theme', properties: ['openFile'], filters: [{ name: 'Cla-Amp theme', extensions: ['json'] }] })

      if (picked.canceled || !picked.filePaths[0]) {
        return { isOk: false }
      }

      const bytes = readCapped(picked.filePaths[0], 300000)

      if (bytes === null) {
        return { error: 'That file is too large to be a theme.' }
      }

      let raw

      try {
        raw = JSON.parse(bytes.toString('utf8'))
      } catch {
        return { error: 'That file is not a Cla-Amp theme.' }
      }

      const saved = saveTheme(raw)

      return saved.error ? { error: 'That file is not a Cla-Amp theme.' } : saved
    }),
  // Processor and memory used by each chat's Claude Code, by project id. Asked only while the list of working chats is open.
  'work:load': () => workLoad(),
  'today:stats': () => guarded(async () => ({ ...(await todayStats()), spend: state.days?.[dayKeyOf(new Date())] ?? null })),
  'chats:archive': (sessionId, cwd) => guarded(() => putAway(sessionId, cwd, false)),
  'chats:delete': (sessionId, cwd) => guarded(() => putAway(sessionId, cwd, true)),
  // Opens a chat from the Chats tab, adding its folder as a project if it is not one yet.
  'chats:open': async (sessionId, cwd, hint) => {
    const id = String(sessionId)
    let folder = realFolder(cwd)

    // A chat can be working in another folder than the one it is saved for
    // (a worktree, a subfolder it moved into). The list of working chats
    // knows only where it is working, so the folder it is saved for is asked
    // of Claude Code itself.
    if (/^[0-9a-f-]{36}$/i.test(id) && (folder === null || !(await getSessionInfo(id, { dir: folder }).catch(() => undefined)))) {
      const saved = await getSessionInfo(id).catch(() => undefined)

      if (saved?.cwd) {
        folder = realFolder(saved.cwd)
        cwd = saved.cwd
      }
    }

    if (folder === null) {
      return { error: `The folder ${String(cwd).slice(0, 200)} no longer exists, so this chat cannot be continued.` }
    }

    // The chat must be saved for that folder before anything is added or asked.
    if (!/^[0-9a-f-]{36}$/i.test(id) || !(await getSessionInfo(id, { dir: folder }).catch(() => undefined))) {
      return { error: 'That chat is not saved for this folder any more.' }
    }

    let place = placeFor(folder, String(sessionId), hint)

    if (!place) {
      const project = { id: randomUUID(), name: path.basename(folder), cwd: folder, mode: 'default', sessionId: null }
      project.isTrusted = await askTrust(folder)
      state.projects.push(project)
      saveState()
      place = { project, isOpen: false }
    }

    // Already open and at work here: the window only goes to it.
    return place.isOpen ? { project: describe(place.project), isOpen: true } : openSaved(place.project, String(sessionId))
  },
  // Usage, models and connectors for one project. Its Claude Code process is
  // started for this if it is not running; other idle ones are put to sleep.
  'session:info': id => {
    const session = sessionOf(id)

    if (!session) {
      return { error: 'That project is no longer in the list.' }
    }

    for (const other of sessions.values()) {
      if (other !== session && Date.now() - Math.max(other.touched, other.woke ?? 0) > SLEEP_AFTER) {
        other.sleep()
      }
    }

    return guarded(() => session.info())
  },
  'session:usage': id => guarded(async () => (await sessionOf(id)?.usage()) ?? null),
  'session:commands': id => guarded(async () => (state.projects.some(one => one.id === id) ? ((await sessionOf(id)?.commands()) ?? []) : [])),
  'session:context': id => guarded(async () => (state.projects.some(one => one.id === id) ? ((await sessionOf(id)?.context()) ?? null) : null)),
  'session:servers': id => guarded(async () => ({ servers: (await sessionOf(id)?.servers()) ?? [] })),
  'session:model': (id, value) => guarded(() => sessionOf(id)?.setModel(String(value))),
  'session:effort': (id, level) =>
    level === null || EFFORTS.includes(level) ? guarded(() => sessionOf(id)?.setEffort(level)) : undefined,
  'session:fast': (id, isFast) => guarded(() => sessionOf(id)?.setFast(isFast === true)),
  'mcp:reconnect': (id, name) => guarded(() => sessionOf(id)?.live().reconnectMcpServer(String(name))),
  'mcp:toggle': (id, name, isOn) => guarded(() => sessionOf(id)?.live().toggleMcpServer(String(name), isOn === true)),
  // A connector that needs the person's approval. One from their Claude account
  // is approved on claude.ai; any other, in Claude Code's own /mcp screen. This
  // app never sees a password or a token.
  'mcp:authorize': async (id, isClaudeAi) => {
    if (isClaudeAi === true) {
      await shell.openExternal('https://claude.ai/settings/connectors')

      return true
    }

    const project = state.projects.find(one => one.id === id)

    if (!project) {
      return false
    }

    return openClaudeConsole(['/mcp'], project.cwd)
  },
  'plugins:list': async () => {
    const listed = await claudeCli(['plugin', 'list', '--json'])

    try {
      return JSON.parse(listed.out)
        .map(one => ({
          id: String(one.id),
          name: String(one.id).split('@')[0],
          from: String(one.id).split('@')[1] ?? '',
          version: one.version ?? '',
          scope: one.scope ?? '',
          isOn: one.enabled === true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return { error: listed.err.trim() || 'Could not read the plugin list.' }
    }
  },
  // Turns an installed plugin on or off for Claude Code on this computer, then
  // has the running sessions load the change.
  'plugins:toggle': async (pluginId, isOn) => {
    const id = String(pluginId)

    if (!/^[A-Za-z0-9][\w.-]*(@[A-Za-z0-9][\w.-]*)?$/.test(id)) {
      return { error: 'That is not a plugin name.' }
    }

    const done = await claudeCli(['plugin', isOn === true ? 'enable' : 'disable', id])

    if (!done.isOk) {
      return { error: (done.err || done.out).trim().split('\n').pop() || 'The plugin could not be changed.' }
    }

    for (const session of sessions.values()) {
      void session.query?.reloadPlugins({ refuseIfBusy: true }).catch(() => {})
    }

    return { isOk: true }
  },
  'skins:list': () => listSkins().map(({ sheet: _sheet, ...skin }) => skin),
  // The window asks before it loads a skin. A skin of the person's own that
  // does more than set colours is put to them in a system dialog, once for
  // each version of its stylesheet.
  'skins:use': async id => {
    const skin = listSkins().find(one => one.id === id)

    if (!skin || skin.kind === 'refused') {
      return { error: skin ? `This skin was not loaded. ${skin.why}` : 'That skin is no longer there.' }
    }

    if (skin.isOwn && skin.kind === 'full') {
      const mark = createHash('sha256').update(fs.readFileSync(skin.sheet)).digest('hex')
      state.skinsAllowed ??= []

      if (!state.skinsAllowed.includes(mark)) {
        const picked = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Cla-Amp',
          message: `Use the skin "${skin.name}"?`,
          detail:
            'This skin does more than change colours: it has rules of its own, which can move, cover or hide any part of the window, including the cards that ask your permission. It cannot run a program or reach the internet.\n\nUse it only if you made it or trust who did.',
          buttons: ['Cancel', 'Use this skin'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })

        if (picked.response !== 1) {
          return { error: 'The skin was not loaded.' }
        }

        state.skinsAllowed = [...state.skinsAllowed, mark].slice(-200)
        saveState()
      }
    }

    return { url: skin.url, pictures: skinPictures(skin.sheet) }
  },
  // Opens the person's own skins folder, with a starter skin in it the first time.
  // Makes a Cla-Amp skin from a classic Winamp skin file the person picks.
  // Only its colours and font carry over, so the result is a colours-only
  // skin; nothing from inside the file is saved as it is.
  'skins:import': async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a Winamp skin',
      properties: ['openFile'],
      filters: [{ name: 'Winamp skin', extensions: ['wsz', 'zip'] }],
    })
    const file = picked.filePaths[0]

    if (picked.canceled || !file) {
      return null
    }

    try {
      const bytes = readCapped(file, 30 * 1024 * 1024)

      if (bytes === null) {
        return { error: 'That file is too large to be a Winamp skin.' }
      }

      return keepWinampSkin(bytes, path.basename(file).replace(/\.(wsz|zip)$/i, ''))
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'That file could not be read as a Winamp skin.' }
    }
  },
  // The same from a link the person pasted: a skin's page on the Winamp Skin
  // Museum (skins.webamp.org). Only that site's own file store is fetched
  // from, over https, and only the skin the link names.
  'skins:link': async link => {
    let address = null

    try {
      address = new URL(typeof link === 'string' ? link.trim() : '')
    } catch {
      return { error: 'That is not a link. Copy the address of a skin\'s page on skins.webamp.org.' }
    }
    const id = address.pathname.match(/(?:^|\/)([0-9a-f]{32})(?=[./]|$)/i)?.[1]?.toLowerCase()

    if (address.protocol !== 'https:' || !SKIN_SITES.includes(address.hostname) || !id) {
      return { error: 'Only links to a skin\'s own page on skins.webamp.org can be imported. Open the skin there and copy the address.' }
    }
    // The page's address ends with the skin's file name.
    const parts = address.pathname.split('/').filter(part => part !== '')
    let name = ''

    try {
      name = decodeURIComponent(parts[parts.length - 1] ?? '')
    } catch {
      name = ''
    }
    name = /^[0-9a-f]{32}(\.wsz)?$/i.test(name) ? '' : name.replace(/\.(wsz|zip)$/i, '').replace(/[_]+/g, ' ').trim()

    try {
      const reply = await fetch(`https://${SKIN_STORE}/skins/${id}.wsz`, { redirect: 'error', signal: AbortSignal.timeout(20000) })

      if (!reply.ok) {
        return { error: reply.status === 404 ? 'The site has no skin under that link.' : `The site did not send the skin (answer ${reply.status}).` }
      }
      if (Number(reply.headers.get('content-length') ?? 0) > 30 * 1024 * 1024) {
        return { error: 'That file is too large to be a Winamp skin.' }
      }
      const bytes = Buffer.from(await reply.arrayBuffer())

      if (bytes.length > 30 * 1024 * 1024) {
        return { error: 'That file is too large to be a Winamp skin.' }
      }

      return keepWinampSkin(bytes, name || `Skin ${id.slice(0, 8)}`)
    } catch (error) {
      return { error: error?.name === 'TimeoutError' || error?.cause ? 'The skin could not be downloaded. Check the connection and try again.' : error instanceof Error ? error.message : 'That file could not be read as a Winamp skin.' }
    }
  },
  'skins:folder': async () => {
    const folder = userSkins()

    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true })
      fs.cpSync(path.join(ROOT, 'skins', '_template'), path.join(folder, 'my-skin'), { recursive: true })
    }

    return (await shell.openPath(folder)) === ''
  },
  'dictate:start': () => startDictation(),
  'dictate:stop': () => {
    stopDictation()

    return { isOn: false }
  },
  // Which of the person's browsers "Open player" would use.
  'player:which': async () => ({ browsers: (await findBrowsers()).map(one => one.name), docks: DOCKS }),
  'player:browser': (wanted, site, isQuiet) => openBrowserPlayer(typeof wanted === 'string' ? wanted : '', site === 'spotify' ? 'spotify' : 'ytm', isQuiet === true),
  'player:state': () => playerState,
  // A skin can ask for the window to be glass: the desktop behind it shows
  // through, blurred by Windows (11, 22H2 or later; elsewhere nothing happens).
  'window:glass': kind => {
    const wantsClear = kind === 'clear'

    // Clear glass is a property of the window from its making: remember the
    // wish for the next start.
    if (!SHOT && (state.prefs.clearGlass === true) !== wantsClear) {
      state.prefs.clearGlass = wantsClear
      saveState()
    }

    if (wantsClear && isClearWindow) {
      return true
    }

    // Not made clear this time: the frosted kind stands in until a restart.
    const material = wantsClear ? 'acrylic' : ['acrylic', 'mica', 'tabbed'].includes(kind) ? kind : 'none'

    if (win === null || SHOT || isClearWindow || process.platform !== 'win32' || typeof win.setBackgroundMaterial !== 'function') {
      return false
    }

    try {
      win.setBackgroundColor(material === 'none' ? '#0b0c10' : '#00000000')
      win.setBackgroundMaterial(material)
    } catch {
      return false
    }

    return material !== 'none'
  },
  // The Claude.ai button: opens claude.ai docked to this window, brings it
  // back if it is tucked away, tucks it away if it is on show.
  'claude:open': async () => {
    if (!playerState.hasClaude) {
      return openBrowserPlayer('', 'claude')
    }

    const isOnShow = state.prefs.playerSite === 'claude' && !playerState.hidden
    state.prefs.playerSite = 'claude'
    state.prefs.playerHidden = isOnShow
    saveState()
    playerSay('site claude')
    playerSay(isOnShow ? 'hide' : 'show')
    placePlayer()

    return { isAuto: true, isShown: !isOnShow }
  },
  // The Browser button: opens Cla-Amp's browser, brings it back, or tucks it away.
  'pages:toggle': async () => {
    if (!playerState.hasPages) {
      return (await openPage(null)) ? { isShown: true } : { error: 'No Chrome, Edge or Brave was found.' }
    }

    const isOnShow = state.prefs.playerSite === 'pages' && !playerState.hidden
    state.prefs.playerSite = 'pages'
    state.prefs.playerHidden = isOnShow
    saveState()
    playerSay('site pages')
    playerSay(isOnShow ? 'hide' : 'show')
    placePlayer()

    return { isShown: !isOnShow }
  },
  // A library song's bytes, for the equalizer's player in the window. Only songs the library found.
  'music:bytes': async file => {
    if (typeof file !== 'string' || !knownSongs.has(file)) {
      return null
    }

    try {
      const real = file.startsWith('file:') ? fileURLToPath(file) : file

      return await readCappedLater(real, 400 * 1024 * 1024)
    } catch {
      return null
    }
  },
  'look:get': () => cleanLook(state.look),
  'look:set': look => {
    state.look = cleanLook(look)
    saveState()

    return true
  },
  // The person picks a picture; a copy goes into this app's own look folder.
  'look:picture': async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a picture',
      properties: ['openFile'],
      filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    })
    const file = picked.filePaths[0]

    if (picked.canceled || !file) {
      return null
    }

    const kind = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.gif': 'gif', '.webp': 'webp' }[path.extname(file).toLowerCase()]

    const bytes = kind ? readCapped(file, 40 * 1024 * 1024) : null

    if (bytes === null) {
      return { error: 'That is not a PNG, JPEG, GIF or WebP picture under 40 MB.' }
    }

    const copy = path.join(lookFolder(), `${createHash('sha1').update(bytes).digest('hex')}.${kind}`)
    fs.mkdirSync(lookFolder(), { recursive: true })
    fs.writeFileSync(copy, bytes)

    return { url: pathToFileURL(copy).href }
  },
  'about:info': () => aboutInfo(),
  'update:check': () => checkForUpdate(),
  // The Settings page: the account, and what each of Claude Code's settings files sets. Read only.
  'settings:read': async id => {
    const project = state.projects.find(one => one.id === id)

    return {
      account: await accountInfo(),
      files: settingsFiles(project).map(one => {
        const exists = fs.existsSync(one.file)

        return { ...one, exists, summary: exists ? summarizeSettings(one.file) : null }
      }),
    }
  },
  'settings:open': async (which, id) => {
    const project = state.projects.find(one => one.id === id)
    const target = which === 'data' ? dataDir() : settingsFiles(project).find(one => one.which === which)?.file

    return Boolean(target) && fs.existsSync(target) && (await shell.openPath(target)) === ''
  },
  'settings:web': () => {
    void shell.openExternal('https://claude.ai/settings')

    return true
  },
  // The text of one of this app's own guides, for the Guides page in the window.
  'docs:read': name => {
    const file =
      name === 'readme' ? path.join(ROOT, 'README.md')
      : ['quick-start', 'user-guide', 'whats-new', 'skins', 'privacy', 'security', 'code-guide'].includes(name) ? path.join(ROOT, 'docs', `${name}.md`)
      : null

    try {
      return file === null ? null : fs.readFileSync(file, 'utf8').slice(0, 400000)
    } catch {
      return null
    }
  },
  // Opens one of this app's own guides, or the folder they are in.
  'docs:open': async name => {
    const target = name === 'folder' ? path.join(ROOT, 'docs') : ['skins', 'security', 'code-guide'].includes(name) ? path.join(ROOT, 'docs', `${name}.md`) : null

    return target !== null && (await shell.openPath(target)) === ''
  },
  'outside:state': () => (IS_DEMO ? { chats: 0, agents: 0, list: [] } : watchOutside()),
  // Tucks the player's window away (the music plays on) or brings it back.
  'player:hide': (isHidden, site) => {
    state.prefs.playerHidden = isHidden === true

    // The deck says which player it is on: that one's window is the one shown.
    if (site === 'ytm' || site === 'spotify') {
      state.prefs.playerSite = site
      playerSay(`site ${site}`)
      placePlayer()
      tellBrowserSite()
    }
    saveState()
    playerSay(isHidden === true ? 'hide' : 'show')

    return true
  },
  // Starts the Spotify app through Windows; the address is fixed.
  'spotify:open': () => {
    void shell.openExternal('spotify:')

    return true
  },
  // Reads the window's own page again, to pick up changed window code. The
  // page cannot do this itself: it is not allowed to navigate anywhere.
  'app:reload': () => {
    win?.webContents.reload()

    return true
  },
  // Closes the app and opens it again, to pick up changed app code. Claude
  // Code runs inside this app, so a restart stops work that is running:
  // with work going on, the person picks between waiting for it to finish
  // and restarting now with the work picked up again afterwards.
  'app:restart': async () => {
    const busy = busySessions()

    if (busy.length === 0) {
      restartNow()

      return true
    }

    const names = busy.map(one => one.project.name).slice(0, 6).join(', ')
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Cla-Amp',
      message: `Claude is still working in ${busy.length === 1 ? names : `${busy.length} projects (${names})`}.`,
      detail:
        'Claude Code runs inside Cla-Amp, so a restart stops work that is running.\n\n' +
        'Restart when the work is done: nothing is stopped. Cla-Amp restarts by itself once every chat here has finished.\n\n' +
        'Restart now and carry on: the work is stopped, Cla-Amp restarts, and each chat that was working is told to carry on from where it stopped. Waiting messages are kept. Agents running in the background are stopped; Claude starts them again if they are still needed.',
      buttons: ['Restart when the work is done', 'Restart now and carry on', 'Not now'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })

    clearInterval(idleRestart)
    idleRestart = null

    if (response === 0) {
      send('amp:update', { kind: 'waiting' })
      idleRestart = setInterval(() => {
        if (busySessions().length === 0) {
          clearInterval(idleRestart)
          restartNow()
        }
      }, 2000)
    } else if (response === 1) {
      state.carryOn = busySessions().map(one => ({ id: one.project.id, wasWorking: one.isBusy || one.agentCount > 0, queue: one.queue }))
      saveState()
      isCloseAgreed = true
      restartNow()
    } else {
      send('amp:update', { kind: 'app' })
    }

    return true
  },
  'auth:status': () => authStatus(),
  // Opens Claude Code's own sign-in in a console window: it sends the person
  // to their browser, and this app never sees a password or a token.
  'auth:login': async () => {
    return openClaudeConsole(['auth', 'login'], dataDir())
  },
  // A waiting message is sent at once: the work in hand is cut short for it.
  'queue:now': (id, index) => void sessionOf(id)?.sendNow(index),
  'queue:remove': (id, index) => {
    const session = sessionOf(id)

    if (session) {
      session.queue.splice(index, 1)
      session.setStatus(session.status)
    }
  },
  // A chat is done or waits for an answer: the taskbar button flashes until
  // the person comes back. Nothing happens while Cla-Amp is the window in front.
  'win:flash': () => {
    if (win === null || win.isDestroyed() || SHOT || win.isFocused()) {
      return false
    }
    win.flashFrame(true)
    win.once('focus', () => win !== null && !win.isDestroyed() && win.flashFrame(false))

    return true
  },
  // The window's smallest width follows the columns on show, so the chat is
  // never squeezed and no column is cut off. A window narrower than that is widened.
  'win:least': asked => {
    if (win === null || win.isDestroyed() || SHOT) {
      return false
    }

    const own = win.getBounds()
    const area = screen.getDisplayMatching(own).workArea
    const least = Math.round(Math.max(940, Math.min(Number(asked) || 940, area.width)))
    win.setMinimumSize(least, 600)

    if (!win.isMaximized() && !win.isFullScreen() && !win.isMinimized() && own.width < least) {
      win.setBounds({ x: Math.max(area.x, Math.min(own.x, area.x + area.width - least)), y: own.y, width: least, height: own.height })
      makeRoom()
      placePlayer()
    }

    return true
  },
  win: action => {
    if (action === 'minimize') {
      win.minimize()
    } else if (action === 'maximize') {
      if (dockedFrom !== null) {
        // Sharing the screen with the player counts as maximised: this puts it back.
        const back = dockedFrom
        dockedFrom = null
        win.setBounds(back)
      } else if (win.isMaximized()) {
        win.unmaximize()
      } else {
        win.maximize()
      }
    } else if (action === 'close') {
      win.close()
    }
  },
  'pick:video': async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Choose a video',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'ogv'] }],
    })
    const file = picked.filePaths[0]

    return picked.canceled || !file ? null : { url: pathToFileURL(file).href, name: path.basename(file) }
  },
  // Which of the file names found in a reply are videos that exist: each as an
  // address the floating player can play. A name without a folder is looked
  // for in the project's folder.
  'video:find': (id, names) => {
    const project = state.projects.find(one => one.id === id)
    const found = []

    for (const name of Array.isArray(names) ? names.slice(0, 8) : []) {
      if (typeof name !== 'string' || name.length > 600 || !/\.(mp4|webm|mkv|mov|m4v|ogv)$/i.test(name)) {
        continue
      }

      try {
        const file = path.isAbsolute(name) ? path.normalize(name) : project ? path.resolve(project.cwd, name) : null

        if (file !== null && fs.statSync(file).isFile() && !found.some(one => one.file === file)) {
          found.push({ file, url: pathToFileURL(file).href, name: path.basename(file) })
        }
      } catch {
        // Not there: no button for it.
      }
    }

    return found.slice(0, 4).map(({ url, name }) => ({ url, name }))
  },
  // A file named in a reply, for the window's file viewer: text (shown as
  // it is, or drawn when it is Markdown) or a picture. Only on the person's
  // click, only a regular file, and nothing is run or sent anywhere.
  'file:view': (id, name) => {
    const file = fileNamed(id, name)

    if (file === null) {
      return { error: 'That file was not found.' }
    }

    const end = path.extname(file).toLowerCase()
    // Its size and its text come from one opening of the file.
    const { size, bytes: text } = sizeAndBytes(file, 2000000, !PICTURE_ENDS[end])
    const said = { name: path.basename(file), file, size, canBrowse: BROWSER_ENDS.includes(end) }

    if (PICTURE_ENDS[end]) {
      return { ...said, kind: 'picture', url: pathToFileURL(file).href }
    }

    if (text === null) {
      return { ...said, kind: 'other', note: 'This file is too large to show here.' }
    }

    // A file with empty bytes in it is not text.
    if (text.subarray(0, 8000).includes(0)) {
      return { ...said, kind: 'other', note: 'This is not a text file, so it cannot be shown here.' }
    }

    return { ...said, kind: end === '.md' || end === '.markdown' ? 'markdown' : 'text', text: text.toString('utf8'), language: end.slice(1) }
  },
  // Whether a path written in a reply is a file or a folder on this computer
  // (null when it is neither): only then does the window make it a link.
  'path:kind': (id, name) => placeNamed(id, name)?.kind ?? null,
  // Shows such a place in Windows' own file window: a file is marked in its
  // folder, a folder is opened. Nothing is ever run from a link: a program
  // is shown, and starting it is the person's own double-click.
  'path:show': (id, name) => {
    const place = placeNamed(id, name)

    if (place?.kind === 'file') {
      shell.showItemInFolder(place.path)
    } else if (place?.kind === 'folder') {
      // Asked again at this moment, so that only a folder is ever handed to "open".
      try {
        if (fs.statSync(place.path).isDirectory()) {
          void shell.openPath(place.path)
        }
      } catch {
        return false
      }
    }

    return place !== null
  },
  // Shows the file in its folder, in Windows' own file window.
  'file:reveal': (id, name) => {
    const file = fileNamed(id, name)

    if (file !== null) {
      shell.showItemInFolder(file)
    }

    return file !== null
  },
  // A page or a PDF opens in the person's browser; the window itself never loads one.
  'file:browser': async (id, name) => {
    const file = fileNamed(id, name)

    if (file === null || !BROWSER_ENDS.includes(path.extname(file).toLowerCase())) {
      return false
    }

    // In Cla-Amp's browser when one is found for it; else the person's own browser.
    if (!(await openPage(pathToFileURL(file).href))) {
      void shell.openExternal(pathToFileURL(file).href)
    }

    return true
  },
  'music:scan': () => scanSongs(),
  // Adds a folder of music, picked in a system dialog.
  'music:add': async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Add a music folder',
      properties: ['openDirectory'],
    })
    const folder = picked.filePaths[0]

    if (picked.canceled || !folder) {
      return null
    }

    const folders = musicFolders()

    if (!folders.some(one => sameFolder(one, folder))) {
      state.prefs.musicFolders = [...folders, folder]
      saveState()
    }

    return scanSongs()
  },
  'music:remove': folder => {
    state.prefs.musicFolders = musicFolders().filter(one => one !== folder)
    saveState()

    return scanSongs()
  },
  // The cover of a song this app listed: from inside the file, else from its folder.
  'music:cover': file => {
    if (typeof file !== 'string' || !knownSongs.has(file)) {
      return null
    }

    const cover = readCover(file)

    return cover ? { url: `data:${cover.mime};base64,${cover.data.toString('base64')}`, from: cover.from, name: cover.name } : null
  },
  // Reads a playlist file the person picks; its songs may then be played.
  'music:playlist': async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: 'Import a playlist',
      properties: ['openFile'],
      filters: [{ name: 'Playlist', extensions: ['m3u', 'm3u8', 'pls'] }],
    })
    const file = picked.filePaths[0]

    if (picked.canceled || !file) {
      return null
    }

    try {
      // Read once here, so a file that is no playlist is turned down and not kept.
      readPlaylist(file)
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'That playlist could not be read.' }
    }

    // It stays in the app, across restarts, until the person takes it out.
    const kept = playlistFiles()

    if (!kept.some(one => one.toLowerCase() === file.toLowerCase())) {
      state.prefs.playlists = [...kept, file]
      saveState()
    }

    return { ...scanSongs(), picked: playlistFiles().find(one => one.toLowerCase() === file.toLowerCase()) }
  },
  // The size of everything in the window (Widgets, or Ctrl with + and -), as a browser's zoom does it.
  'zoom:set': factor => {
    if (typeof factor === 'number' && factor >= 0.5 && factor <= 3 && win !== null && !win.isDestroyed()) {
      win.webContents.setZoomFactor(factor)
    }

    return true
  },
  // Takes a playlist out of the app. Its file, and the songs, stay where they are.
  'music:unlist': file => {
    state.prefs.playlists = playlistFiles().filter(one => one !== file)
    saveState()

    return scanSongs()
  },
  // The music helper takes a fixed set of commands. A song is one this app
  // found in the music folder, never a path or an address the page made up.
  'deck:cmd': (command, argument) => {
    const text = String(argument ?? '')

    if (command === 'open') {
      return knownSongs.has(text) ? deckCommand('open', text) : 0
    }

    if (['pause', 'resume', 'stop', 'hush', 'web-toggle', 'web-next', 'web-prev'].includes(command)) {
      return deckCommand(command)
    }

    if (command === 'web-app' && ['spotify', 'other'].includes(text)) {
      return deckCommand(command, text)
    }

    if (command === 'view-app' && ['spotify', 'other', 'none'].includes(text)) {
      return deckCommand(command, text)
    }

    if (['seek', 'web-seek', 'vol', 'web-vol'].includes(command) && /^\d{1,7}(\.\d{1,3})?$/.test(text)) {
      return deckCommand(command, text)
    }

    return 0
  },
  // Only the preferences the window is known to keep, each checked for shape.
  'prefs:set': (key, value) => {
    const checks = {
      volume: one => typeof one === 'number' && one >= 0 && one <= 1,
      skin: one => typeof one === 'string' && one.length < 80,
      useChrome: one => typeof one === 'boolean',
      pins: one => Array.isArray(one) && one.length < 2000 && one.every(id => typeof id === 'string' && id.length < 80),
    }

    if (Object.hasOwn(checks, key) && checks[key](value)) {
      state.prefs[key] = value
      saveState()
    }
  },
}

// --------------------------------------------------------------------- window

/**
 * Opens a web link from the chat in the person's browser. Only plain web
 * addresses: never a file, a script, or another program's own link type,
 * which is how a link in a reply could otherwise start something.
 */
const openLink = raw => {
  let url = null

  try {
    url = new URL(String(raw))
  } catch {
    return
  }

  if ((url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '') {
    const toBrowser = () => void shell.openExternal(url.href)

    // A claude.ai link goes to the attached claude.ai window, where the person
    // is signed in; a page served from this computer, to Cla-Amp's browser;
    // any other link, to the person's own browser.
    if (isClaudeLink(url)) {
      void openBrowserPlayer('', 'claude', false, url.href).then(opened => {
        if (opened?.error) {
          toBrowser()
        }
      })
    } else if (isLocalLink(url)) {
      void openPage(url.href).then(isOpen => {
        if (!isOpen) {
          toBrowser()
        }
      })
    } else {
      toBrowser()
    }
  }
}

const isClaudeLink = url => url.protocol === 'https:' && (url.hostname === 'claude.ai' || url.hostname.endsWith('.claude.ai') || url.hostname === 'claude.site' || url.hostname.endsWith('.claude.site'))
const isLocalLink = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost')

/**
 * Opens Cla-Amp's browser, on one address or (with none) on its own start
 * page: a real browser window with tabs (Chrome when it is installed, else
 * Edge or Brave) with a browser profile of its own, kept in this app's data
 * folder and read and written by the browser only. It shares nothing with
 * the person's everyday browser: no sign-in, history, cookie or add-on. The
 * window is attached to this one like the players'. Nothing is added to the
 * browser and nothing on its pages is read or changed. An address opens as
 * a new tab when the browser is already open.
 * Resolves false when there is no browser for it, or on another system.
 */
const openPage = async href => {
  if (process.platform !== 'win32' || win === null || win.isDestroyed() || IS_DEMO) {
    return false
  }

  let url = null

  if (href !== null) {
    try {
      url = new URL(String(href))
    } catch {
      return false
    }

    if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      return false
    }
  }

  const found = await findBrowsers()
  const browser = found.find(one => one.name === 'Chrome') ?? found[0]

  if (!browser) {
    return false
  }

  // Every part of the command is fixed here or is one of this app's own folders,
  // but for the address, which is one whole argument and has been read as an address.
  const child = spawn(
    browser.file,
    [...ownFlags(pagesProfile()), ...(url === null ? ['--new-window'] : [url.href])],
    { detached: true, stdio: 'ignore' },
  )
  child.on('error', () => {})
  child.unref()
  state.prefs.playerSite = 'pages'
  state.prefs.playerHidden = false
  saveState()
  startPlayerHelper()
  playerSay('site pages')
  playerSay('show')
  playerSay('find')
  placePlayer()

  return true
}

// ------------------------------------------------------- YouTube Music player

const PLAYER_HOME = 'https://music.youtube.com/'

/**
 * The person's own browser, for opening YouTube Music as an "app window": a
 * window with no tabs or address bar that belongs to the browser and so is
 * already signed in to whatever the person is signed in to there. Cla-Amp
 * never sees, copies or stores that sign-in; it only starts the browser.
 *
 * Only Chrome, Edge and Brave are looked for, and only in the folders their
 * installers use, so nothing else can be started by this. The default
 * browser goes first when it is one of them.
 */
const BROWSERS = [
  { name: 'Chrome', id: /chrome/i, paths: [['ProgramFiles', 'Google/Chrome/Application/chrome.exe'], ['ProgramFiles(x86)', 'Google/Chrome/Application/chrome.exe'], ['LOCALAPPDATA', 'Google/Chrome/Application/chrome.exe']] },
  { name: 'Edge', id: /edge/i, paths: [['ProgramFiles(x86)', 'Microsoft/Edge/Application/msedge.exe'], ['ProgramFiles', 'Microsoft/Edge/Application/msedge.exe']] },
  { name: 'Brave', id: /brave/i, paths: [['ProgramFiles', 'BraveSoftware/Brave-Browser/Application/brave.exe'], ['LOCALAPPDATA', 'BraveSoftware/Brave-Browser/Application/brave.exe']] },
]

const defaultBrowserId = () =>
  new Promise(resolve => {
    if (process.platform !== 'win32') {
      resolve('')

      return
    }

    execFile(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'],
      { windowsHide: true, timeout: 5000 },
      (_error, out) => resolve(/ProgId\s+REG_SZ\s+(\S+)/.exec(String(out ?? ''))?.[1] ?? ''),
    )
  })

/** The browsers found on this computer, the default one first. */
const findBrowsers = async () => {
  const usual = await defaultBrowserId()
  const order = [...BROWSERS.filter(one => one.id.test(usual)), ...BROWSERS.filter(one => !one.id.test(usual))]
  const found = []

  for (const browser of order) {
    for (const [base, rest] of browser.paths) {
      const file = process.env[base] ? path.join(process.env[base], rest) : ''

      if (file && fs.existsSync(file)) {
        found.push({ name: browser.name, file })
        break
      }
    }
  }

  return found
}

/**
 * Browsers whose player window gets a profile of its own and is docked to
 * this window. Chrome uses the one profile of Cla-Amp's own browser, so the
 * Browser, the players and claude.ai are windows of one Chrome; Edge and
 * Brave use the players' profile.
 */
const DOCKS = ['Chrome', 'Edge', 'Brave']
const profileOf = browser => (browser.name === 'Chrome' ? pagesProfile() : playerProfile())
// How a browser of Cla-Amp's own is started. Every part is fixed here or is one of this app's own folders.
const ownFlags = dir => [
  '--user-data-dir=' + dir,
  // A player keeps running at full speed while hidden or covered.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--no-first-run',
  // Nothing of it lives on in the background once its windows are closed.
  '--disable-background-mode',
  '--no-default-browser-check',
]
// Liked Songs. Signed out, Spotify shows its own sign-in page first.
const SPOTIFY_HOME = 'https://open.spotify.com/collection/tracks'
const CLAUDE_HOME = 'https://claude.ai/'

/**
 * Opens a player (or claude.ai) in the browser asked for by name, else in
 * the first one found. In a browser that can be docked, the window gets a
 * browser profile of its own, kept in this app's data folder and read and
 * written by the browser only. The person signs in there themselves, in the
 * real browser. Nothing is added to the browser and nothing on its pages is
 * read or changed: what is playing comes from Windows' own media controls.
 */
const openBrowserPlayer = async (wanted, site = 'ytm', isQuiet = false, address = null) => {
  const found = await findBrowsers()
  // claude.ai goes to Chrome when it is installed, as Cla-Amp's own browser does.
  const browser = (site === 'claude' ? (found.find(one => one.name === 'Chrome') ?? found.find(one => DOCKS.includes(one.name))) : found.find(one => one.name === wanted)) ?? found[0]

  if (!browser) {
    return { error: 'No Chrome, Edge or Brave was found.' }
  }

  const isAuto = DOCKS.includes(browser.name)
  // A claude.ai link from a chat opens on its own address; it has been read as an address by the caller.
  const home = site === 'claude' ? (address ?? CLAUDE_HOME) : site === 'spotify' ? SPOTIFY_HOME : PLAYER_HOME

  // One window per music player. When this player's window is already open,
  // tucked away or not, it is brought out; a second one is never started.
  // (Should two come to be all the same, the helper closes the newcomer.)
  if (isAuto && (site === 'ytm' || site === 'spotify') && playerHelper !== null && playerSites.includes(site)) {
    state.prefs.playerSite = site

    if (!isQuiet) {
      state.prefs.playerHidden = false
      playerSay('show')
    }
    saveState()
    playerSay(`site ${site}`)
    placePlayer()
    tellBrowserSite()

    return { browser: browser.name, isAuto }
  }

  // Every part of the command is fixed here or is one of this app's own folders.
  const child = spawn(
    browser.file,
    [
      ...(isAuto ? ownFlags(profileOf(browser)) : []),
      '--app=' + home,
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.on('error', () => {})
  child.unref()

  if (isAuto) {
    state.prefs.playerSite = site
    saveState()
    startPlayerHelper()

    // Opened by hand: the window is wanted on show. Opened by pressing play: it stays as it was left.
    if (!isQuiet && state.prefs.playerHidden === true) {
      state.prefs.playerHidden = false
      saveState()
      playerSay('show')
    }
    playerSay(`site ${site}`)
    playerSay('find')
    placePlayer()
    tellBrowserSite()

    // One music player sounds at a time: opening one pauses whatever is
    // playing. The other player's window is tucked away, not closed, so its
    // song, its place in the song and its playlist are there to go back to.
    if (!isQuiet && (site === 'ytm' || site === 'spotify') && (playerSites.includes('ytm') || playerSites.includes('spotify'))) {
      deckCommand('hush')
    }
  }

  return { browser: browser.name, isAuto }
}

/** True when a call comes from this app's own page, not from anything else a window might hold. */
const isOurPage = event => {
  const frame = event.senderFrame

  return (
    win !== null &&
    event.sender === win.webContents &&
    frame !== null &&
    frame === win.webContents.mainFrame &&
    frame.url.startsWith(pathToFileURL(path.join(ROOT, 'renderer', 'index.html')).href)
  )
}

// Test switch CLAAMP_PLACE=1: the hidden test window keeps and takes its place too.
const IS_PLACE_TEST = process.env.CLAAMP_PLACE === '1'

/**
 * Where the window stood and how large it was when it was last used, so it
 * opens the same way. Null when nothing is kept, or when that place is no
 * longer on any screen (a monitor was unplugged): the usual size then.
 */
const keptPlace = () => {
  const kept = state.prefs.window

  if ((SHOT && !IS_PLACE_TEST) || IS_DEMO || !kept || ![kept.x, kept.y, kept.width, kept.height].every(Number.isFinite)) {
    return null
  }

  const area = screen.getDisplayMatching(kept).workArea
  const width = Math.round(Math.min(Math.max(kept.width, 940), area.width))
  const height = Math.round(Math.min(Math.max(kept.height, 600), area.height))
  // Wholly on that screen, moved in from an edge it hung over.
  const x = Math.round(Math.min(Math.max(kept.x, area.x), area.x + area.width - width))
  const y = Math.round(Math.min(Math.max(kept.y, area.y), area.y + area.height - height))

  return { x, y, width, height, isMax: kept.isMax === true }
}

let keepTimer = null

/** Keeps the window's place and size. While it has made room for the browser beside it, the place it had before counts. */
const keepPlace = (isNow = false) => {
  if ((SHOT && !IS_PLACE_TEST) || IS_DEMO || win === null || win.isDestroyed() || win.isMinimized() || win.isFullScreen() || isFitting) {
    return
  }

  const own = dockedFrom ?? win.getNormalBounds()
  state.prefs.window = { x: own.x, y: own.y, width: own.width, height: own.height, isMax: dockedFrom === null && win.isMaximized() }
  clearTimeout(keepTimer)

  if (isNow) {
    saveState()
  } else {
    keepTimer = setTimeout(saveState, 600)
  }
}

const createWindow = () => {
  isClearWindow = !SHOT && process.platform === 'win32' && state.prefs.clearGlass === true
  const place = keptPlace()

  win = new BrowserWindow({
    // Clear glass (a skin's --window-glass: clear): nothing is drawn behind the page.
    transparent: isClearWindow,
    ...(place ? { x: place.x, y: place.y, width: place.width, height: place.height } : { width: 1320, height: SHOT ? numberArg('height', 880) : 880 }),
    minWidth: 940,
    minHeight: 600,
    frame: false,
    show: !SHOT,
    backgroundColor: isClearWindow ? '#00000000' : '#0b0c10',
    title: 'Cla-Amp',
    // The window's and the taskbar's icon.
    icon: path.join(ROOT, 'renderer', 'brand', 'icon.ico'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      // The equalizer's player starts the next song by itself.
      autoplayPolicy: 'no-user-gesture-required',
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: IS_DEV,
    },
  })
  win.setMenu(null)

  if (place?.isMax) {
    win.maximize()
  }

  for (const changed of ['resized', 'moved', 'maximize', 'unmaximize']) {
    win.on(changed, () => keepPlace())
  }

  for (const moved of ['move', 'resize', 'restore', 'maximize', 'unmaximize', 'show']) {
    win.on(moved, placePlayer)
  }
  // Maximised, or dragged too wide: Cla-Amp stops where the player begins.
  win.on('maximize', makeRoom)

  for (const done of ['resized', 'moved']) {
    win.on(done, () => {
      // Moved or sized by hand since it made room: it is an ordinary window again.
      if (dockedFrom !== null && !isFitting) {
        const now = win.getBounds()
        const area = screen.getDisplayMatching(now).workArea

        if (now.x !== area.x || now.y !== area.y || now.height !== area.height) {
          dockedFrom = null
        }
      }
      makeRoom()
    })
  }
  // Closing Cla-Amp closes the player with it (a restart lets it play on).
  win.on('close', event => {
    keepPlace(true)
    // Closing always asks first, in a box over the window. Work that was
    // started from here stops when the window closes, so the box says what
    // is still running: chats, their agents, and messages waiting their turn.
    // A restart asks only when something is running.
    const busy = [...sessions.values()].filter(one => one.isBusy || one.agentCount > 0 || one.queue.length > 0)

    if (busy.length === 0 && !isCloseAgreed && !isRestarting && !SHOT) {
      const picked = dialog.showMessageBoxSync(win, {
        type: 'question',
        title: 'Cla-Amp',
        message: 'Close Cla-Amp?',
        detail: 'Nothing is running: no chat is working and no agent is out. Your chats are saved, and Cla-Amp opens again where you left off. The music stops.',
        buttons: ['Keep Cla-Amp open', 'Close'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      })

      if (picked !== 1) {
        event.preventDefault()

        return
      }
      isCloseAgreed = true
    }

    if (busy.length > 0 && !isCloseAgreed) {
      const names = busy.map(one => one.project.name).slice(0, 6).join(', ')
      const tasks = busy.reduce((sum, one) => sum + (one.taskCount || 0), 0)
      const agents = busy.reduce((sum, one) => sum + (one.agentCount || 0), 0) - tasks
      const waiting = busy.reduce((sum, one) => sum + one.queue.length, 0)
      const running = [agents > 0 ? `${agents} ${agents === 1 ? 'agent is' : 'agents are'} running` : '', tasks > 0 ? `${tasks} background ${tasks === 1 ? 'command is' : 'commands are'} running` : '', waiting > 0 ? `${waiting} ${waiting === 1 ? 'message is' : 'messages are'} waiting to be sent` : ''].filter(Boolean).join(', and ')
      const picked = dialog.showMessageBoxSync(win, {
        type: 'warning',
        title: 'Cla-Amp',
        message: `Claude is still working in ${busy.length === 1 ? names : `${busy.length} projects (${names})`}${running ? `: ${running}` : ''}.`,
        detail: `${isRestarting ? 'Restarting' : 'Closing'} Cla-Amp stops that work and drops any messages still waiting in the queue. The chats themselves stay saved.\n\nWork running in the Claude desktop app or a terminal is not touched.`,
        buttons: ['Keep Cla-Amp open', isRestarting ? 'Restart anyway' : 'Close anyway'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })

      if (picked !== 1) {
        event.preventDefault()
        isRestarting = false

        return
      }
      isCloseAgreed = true
    }

    if (!isRestarting) {
      playerSay('close')
      closeOwnBrowsers()
    }
  })
  // The page asks for no camera, microphone, location or anything else.
  win.webContents.session.setPermissionRequestHandler((_contents, permission, answer) =>
    answer(permission === 'clipboard-sanitized-write'),
  )
  win.webContents.session.setPermissionCheckHandler((_contents, permission) => permission === 'clipboard-sanitized-write')
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.webContents.on('will-redirect', event => event.preventDefault())
  // Links open in the person's browser; the window itself never leaves the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url)

    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', event => event.preventDefault())
  // Right-click in a box to type in: spelling suggestions for a misspelt word
  // (Windows' own spell checker), then cut, copy and paste.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) {
      return
    }

    const contents = win.webContents
    const word = params.misspelledWord
    const can = params.editFlags
    const rows = []

    if (word) {
      const fixes = params.dictionarySuggestions.slice(0, 6)
      rows.push(
        ...(fixes.length > 0
          ? fixes.map(fix => ({ label: fix, click: () => contents.replaceMisspelling(fix) }))
          : [{ label: 'No spelling suggestions', enabled: false }]),
        { type: 'separator' },
        { label: `Add "${word.slice(0, 40)}" to the dictionary`, click: () => contents.session.addWordToSpellCheckerDictionary(word) },
        { type: 'separator' },
      )
    }
    rows.push(
      { label: 'Cut', enabled: can.canCut, click: () => contents.cut() },
      { label: 'Copy', enabled: can.canCopy, click: () => contents.copy() },
      { label: 'Paste', enabled: can.canPaste, click: () => contents.paste() },
      { type: 'separator' },
      { label: 'Select all', enabled: can.canSelectAll, click: () => contents.selectAll() },
    )
    Menu.buildFromTemplate(rows).popup({ window: win })
  })
  void win.loadFile(path.join(ROOT, 'renderer', 'index.html'), IS_DEMO ? { query: { demo: '1' } } : {})

  // Work that a restart stopped is picked up once the window can show it.
  win.webContents.once('did-finish-load', () => setTimeout(carryOn, 1500))

  if (SHOT) {
    win.webContents.on('console-message', (_event, level, text) => {
      if (level >= 2) {
        console.error('[window]', text)
      }
    })
    win.webContents.once('did-finish-load', () => {
      // A test may hand the page a script to run halfway through the wait.
      const steps = process.argv.find(arg => arg.startsWith('--do='))?.slice(5)

      if (steps) {
        setTimeout(() => {
          void win.webContents
            .executeJavaScript(fs.readFileSync(path.resolve(steps), 'utf8'))
            .then(said => console.log('[steps]', JSON.stringify(said)))
            .catch(error => console.error('[steps failed]', error.message))
        }, numberArg('wait', 2500) / 2)
      }

      setTimeout(async () => {
        const image = await win.webContents.capturePage()
        fs.writeFileSync(path.resolve(SHOT), image.toPNG())
        app.quit()
      }, numberArg('wait', 2500))
    })
  }

  win.on('closed', () => {
    win = null
    stopDictation()
  })
}

// One Cla-Amp at a time: two would write over each other's saved state.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', () => {
  if (win !== null) {
    if (win.isMinimized()) {
      win.restore()
    }
    win.focus()
  }
})
// No window this app did not make, and no page but its own.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', event => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url)

    return { action: 'deny' }
  })
})

void app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) {
    return
  }

  loadState()

  // Folders added before the trust question existed were the owner's own picks.
  for (const project of state.projects) {
    project.isTrusted ??= true
  }

  // A chat with no model or effort chosen here starts on the desktop app's.
  for (const project of state.projects) {
    if (project.sessionId && !project.model && !project.effort) {
      followDesktop(project, project.sessionId)
    }
  }

  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(name, (event, ...args) => {
      if (!isOurPage(event)) {
        throw new Error('Refused: the call did not come from the Cla-Amp window.')
      }

      if (IS_DEMO && !DEMO_REAL.has(name)) {
        return DEMO_SAYS[name]?.() ?? null
      }

      // Test switch CLAAMP_TIME=1: every call that takes over 150 ms is printed with its time.
      if (process.env.CLAAMP_TIME === '1') {
        const start = performance.now()

        return Promise.resolve(handler(...args)).finally(() => {
          const took = Math.round(performance.now() - start)

          if (took > 150) {
            console.log(`[time] ${name} ${took} ms`)
          }
        })
      }

      return handler(...args)
    })
  }

  // The same switch prints every stretch over 200 ms in which the app could not answer.
  if (process.env.CLAAMP_TIME === '1') {
    let last = performance.now()
    setInterval(() => {
      const now = performance.now()

      if (now - last > 300) {
        console.log(`[time] app busy for ${Math.round(now - last - 100)} ms`)
      }
      last = now
    }, 100)
  }
  // Nothing in this app loads from the network, so nothing may.
  webSession.defaultSession.webRequest.onBeforeRequest((details, answer) => {
    answer({ cancel: !/^(file|devtools|data|blob):/i.test(details.url) })
  })
  createWindow()

  // An earlier version had a built-in YouTube Music window with its own sign-in; wipe what it kept.
  fs.rm(path.join(dataDir(), 'Partitions', 'youtube-music'), { recursive: true, force: true }, () => {})
  watchForUpdates()

  if (!IS_DEMO) {
    setAwake(state.prefs.keepAwake === true)
    startDeck()
    // Takes back a player left open over a restart.
    win.once('ready-to-show', startPlayerHelper)
    win.once('ready-to-show', startTray)
    setTimeout(startPlayerHelper, 3000)

    setInterval(() => void watchChats().catch(() => {}), WATCH_EVERY)
    setInterval(() => {
      try {
        watchOutside()
      } catch {
        // A folder that cannot be read just means no count from it.
      }
    }, 4000)
  }
})

app.on('window-all-closed', () => app.quit())
/**
 * Stops every browser of Cla-Amp's own, with all its processes, so nothing
 * of Cla-Amp's plays on or shows in Task Manager once Cla-Amp is closed.
 * Only browsers started with this app's own profile folders are looked for;
 * the person's everyday browser is never one of them. A restart keeps the
 * player playing, so it is left alone then.
 *
 * It is done here and waited for, before the app goes: a helper left to do
 * it afterwards did not outlive the app (measured: it never ran). It takes
 * a second or two, with the window already out of sight.
 */
let areBrowsersClosed = false

const closeOwnBrowsers = () => {
  if (areBrowsersClosed || isRestarting || IS_DEMO || SHOT || process.platform !== 'win32') {
    return
  }
  areBrowsersClosed = true

  try {
    win?.hide()
    spawnSync(
      path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-Command', '& ([scriptblock]::Create([IO.File]::ReadAllText($env:CA_SCRIPT)))'],
      {
        env: { ...process.env, CA_SCRIPT: path.join(ROOT, 'deck', 'close-browsers.ps1'), CA_PROFILE: playerProfile(), CA_PAGES: pagesProfile(), CA_LOG: path.join(dataDir(), 'last-close.log') },
        windowsHide: true,
        stdio: 'ignore',
        timeout: 12000,
      },
    )
  } catch {
    // Nothing to close them with: they stay, as before.
  }
}

app.on('before-quit', () => {
  stopDictation()
  deck?.kill()
  // The helper closes the player when its input ends.
  playerHelper?.stdin.end()

  closeOwnBrowsers()
  tray?.destroy()
  tray = null

  for (const session of sessions.values()) {
    void session.query?.return?.().catch(() => {})
  }
})
