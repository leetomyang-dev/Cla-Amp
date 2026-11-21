// Keeps Cla-Amp in step with the engine it runs (Claude Code, through the
// Claude Agent SDK) and with Electron.
//
//   node tools/engine-check.mjs          the contract: everything Cla-Amp uses
//                                        from the SDK is still in the installed
//                                        SDK. Offline; part of `npm test`, so a
//                                        pull request that updates the SDK is
//                                        checked by itself.
//   node tools/engine-check.mjs --news   what is newer than the installed
//                                        versions, with the change notes that
//                                        touch what Cla-Amp uses marked. Reads
//                                        public pages (the npm registry, the
//                                        two change logs on GitHub and the
//                                        Claude desktop app's release notes);
//                                        sends nothing of yours. `npm run engine`.
//   ... --news --all                     every note, not only the marked ones.
//   node tools/engine-check.mjs --advisories
//                                        Claude Code's published security
//                                        advisories (on GitHub): ends with an
//                                        error when one is fixed only in a
//                                        Claude Code newer than the one Cla-Amp
//                                        carries. Also part of --news.
//
// This is a tool for whoever keeps Cla-Amp; the app itself never runs it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SDK = '@anthropic-ai/claude-agent-sdk'
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const installed = name => JSON.parse(read(`node_modules/${name}/package.json`))

/** What Cla-Amp's own code uses from the SDK, read out of the code so the list cannot go stale. */
export const usedFromSdk = () => {
  const used = { imports: new Set(), methods: new Set(), messages: new Set(), options: new Set() }

  for (const file of ['main.mjs', 'outside-work.mjs']) {
    const text = read(file)

    for (const [, names] of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'@anthropic-ai\/claude-agent-sdk'/g)) {
      for (const name of names.split(',')) {
        used.imports.add(name.trim().split(/\s+as\s+/)[0])
      }
    }

    // Calls on a running query: `this.query.name(` and `running.name(`.
    for (const [, name] of text.matchAll(/\b(?:this\.query|running)\.([A-Za-z_]\w*)\s*\(/g)) {
      used.methods.add(name)
    }

    // The engine's messages the app acts on.
    for (const [, name] of text.matchAll(/subtype === '([a-z_]+)'/g)) {
      used.messages.add(name)
    }
  }

  used.imports.delete('')

  return used
}

/** The contract: each of those must still be named in the installed SDK's types. Returns what is missing. */
export const missingFromSdk = () => {
  const folder = path.join(ROOT, 'node_modules', SDK)
  const types = fs
    .readdirSync(folder)
    .filter(name => name.endsWith('.d.ts'))
    .map(name => fs.readFileSync(path.join(folder, name), 'utf8'))
    .join('\n')
  const used = usedFromSdk()
  const missing = []

  for (const name of used.imports) {
    if (!new RegExp(`\\b${name}\\b`).test(types)) {
      missing.push(`the function ${name}`)
    }
  }

  for (const name of used.methods) {
    if (!new RegExp(`\\b${name}\\s*\\(`).test(types)) {
      missing.push(`the query method ${name}()`)
    }
  }

  for (const name of used.messages) {
    if (!types.includes(`'${name}'`)) {
      missing.push(`the message subtype '${name}'`)
    }
  }

  return { missing, used }
}

// --- the news --------------------------------------------------------------

const get = async address => {
  const headers = { 'user-agent': 'engine-check' }

  // On GitHub's own runners the run's read-only token keeps its API from turning the run away as one of too many.
  if (address.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }
  const answer = await fetch(address, { headers, signal: AbortSignal.timeout(30000) })

  if (!answer.ok) {
    throw new Error(`${address}: ${answer.status}`)
  }

  return answer.text()
}

const parts = version => String(version).split('.').map(part => Number.parseInt(part, 10) || 0)
const isNewer = (one, than) => {
  const [a, b] = [parts(one), parts(than)]

  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] > b[i]
    }
  }

  return false
}

/** A change log's notes, by version, for the versions newer than `from`. Plain text only: control characters are dropped. */
const notesSince = (log, from) => {
  const found = []
  let now = null

  for (const raw of log.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, '')
    const head = /^##\s+v?(\d+\.\d+\.\d+)/.exec(line)

    if (head) {
      now = isNewer(head[1], from) ? { version: head[1], notes: [] } : null

      if (now) {
        found.push(now)
      }
    } else if (now && /^\s*[-*]\s+/.test(line)) {
      now.notes.push(line.replace(/^\s*[-*]\s+/, '').slice(0, 600))
    }
  }

  return found
}

const ADVISORIES = 'https://api.github.com/repos/anthropics/claude-code/security-advisories?per_page=100&state=published'

/** The Claude Code this copy of Cla-Amp carries: the SDK 0.3.N carries Claude Code 2.1.N. */
const codeInstalled = () => installed(SDK).claudeCodeVersion ?? `2.1.${parts(installed(SDK).version)[2]}`

/**
 * Claude Code's published security advisories, split into the ones fixed only
 * in a Claude Code newer than `codeNow` (open against this copy) and the rest.
 * Advisories about other products (the desktop app) are left out.
 */
export const advisoriesFor = (list, codeNow) => {
  const open = []
  let closed = 0

  for (const one of list) {
    const fixes = (one.vulnerabilities ?? [])
      .filter(item => /claude-code/i.test(item.package?.name ?? ''))
      .map(item => /(\d+\.\d+\.\d+)/.exec(item.patched_versions ?? '')?.[1])

    if (fixes.length === 0) {
      continue
    }

    // No fixed version named counts as open: better read once too often.
    if (fixes.some(fix => !fix || isNewer(fix, codeNow))) {
      // eslint-disable-next-line no-control-regex
      const summary = String(one.summary ?? '').replace(/[\u0000-\u001f\u007f\u009b]/g, ' ').slice(0, 200)
      open.push({ id: one.ghsa_id, severity: one.severity ?? 'unknown', date: String(one.published_at ?? '').slice(0, 10), summary, fixed: fixes.filter(Boolean).join(', ') || 'no fixed version named', address: one.html_url })
    } else {
      closed += 1
    }
  }

  return { open, closed }
}

const advisoryLines = (result, codeNow) => {
  const out = [
    result.open.length === 0
      ? `Claude Code security advisories: ${result.closed} published, all fixed in or before ${codeNow}, the one Cla-Amp carries.`
      : `Claude Code security advisories: ${result.open.length} NOT FIXED in ${codeNow}, the one Cla-Amp carries. Take the engine update.`,
  ]

  for (const one of result.open) {
    out.push(`  ! ${one.id}  ${one.severity}  ${one.date}  fixed in ${one.fixed}`, `      ${one.summary}`, `      ${one.address}`)
  }

  return out
}

const DESKTOP_LOG = 'https://claude.com/docs/cowork/changelog.md'

/**
 * The Claude desktop app's release notes, newest first: each release with its
 * date, the Claude Code it carries and its notes by part (General, Code,
 * Cowork, 3P). Plain text only: control characters are dropped.
 */
export const desktopReleases = log => {
  const found = []
  let now = null
  let part = ''

  for (const raw of log.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, '').trim()
    const head = /^\*\*v(\d+(?:\.\d+)+)\*\*$/.exec(line)

    if (head) {
      now = { version: head[1], date: '', code: '', notes: [] }
      part = ''
      found.push(now)
    } else if (!now) {
      continue
    } else if (/^\d{4}-\d\d-\d\d$/.test(line)) {
      now.date ||= line
    } else if (/^Bundled Claude Code version:/i.test(line)) {
      now.code = /(\d+\.\d+\.\d+)/.exec(line)?.[1] ?? ''
    } else if (/^\*\*[^*]+\*\*$/.test(line)) {
      part = line.slice(2, -2)
    } else if (/^[-*]\s+/.test(line) && !/^[-*]\s+No user-facing changes\.?$/i.test(line)) {
      now.notes.push({ part, text: line.replace(/^[-*]\s+/, '').slice(0, 600) })
    }
  }

  return found
}

// The desktop app is another product, so most of its notes are about its own
// screens. What matters here is what it says about the Claude Code they share:
// the notes under Code (and General) that are breaking, about safety, or about
// the same ground Cla-Amp stands on (Windows, background work, sessions that
// an app starts, sign-in, permissions).
const DESKTOP =
  /\(breaking\)|\b(security|vulnerab|data loss|corrupt|deleted without|powershell|background (?:agent|subagent|command|task|shell)|subagent|sign-?in|log-?in|credential|permission|auto mode|bypass permissions|environment variables?|compact|resum|mcp server)\b/i
// Things Cla-Amp does not have: remote hosts, the app's own updater, other systems.
const NOT_OURS = /\b(SSH|WSL|macOS|Macs?|Windows Server|configuration profile|Check for Updates|keyboard layouts?|contrast)\b/
const markedDesktop = note =>
  (note.part === 'Code' || note.part === 'General') && !NOT_OURS.test(note.text) && (DESKTOP.test(note.text) || SYSTEM.test(note.text))

// A note is marked when it names something Cla-Amp uses, or a kind of fault no one wants to sit on.
const ALWAYS = /\b(security|vulnerab|data loss|lost|corrupt|crash|freez|hang|hung|leak|windows|powershell|electron)\b/i
const OURS =
  /\b(sdk|headless|stream-json|background|subagent|agent tool|task_|stoptask|permission|canusetool|resume|continue|fork|session|compact|usage|rate limit|interrupt|settings? sources?|mcp server status|sign-?in|log-?in|oauth|api key|model|effort|todo|bash tool|output file)\b/i

// Claude Code's own log is long and mostly about its terminal: there only the notes about
// running under an app, Windows, background work and safety are marked.
// "Windows" with its capital letter is the system; "narrow windows" are not.
const SYSTEM = /\bWindows\b(?! Terminal)/
const CODE = /\b(powershell|sdk|headless|stream-json|run by an app|security|vulnerab|data loss|corrupt|background (?:agent|subagent|command|task|shell)|stopped background)\b/i

const marked = (note, used, isCodeLog = false) => {
  if (isCodeLog) {
    return CODE.test(note) || SYSTEM.test(note)
  }

  if (ALWAYS.test(note)) {
    return true
  }

  for (const name of [...used.imports, ...used.methods, ...used.messages]) {
    if (note.includes(name)) {
      return true
    }
  }

  return /^(fixed|changed|removed|deprecated|breaking)/i.test(note) && OURS.test(note)
}

const news = async isAll => {
  const { missing, used } = missingFromSdk()
  const sdkNow = installed(SDK).version
  const electronNow = installed('electron').version
  const [sdkPage, electronPage, sdkLog, codeLog, desktopLog, advisoryPage] = await Promise.all([
    get(`https://registry.npmjs.org/${SDK}/latest`),
    get('https://registry.npmjs.org/electron/latest'),
    get('https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md'),
    get('https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'),
    // Another product's notes: when they cannot be read, the rest is still worth having.
    get(DESKTOP_LOG).catch(error => `? ${error.message}`),
    get(ADVISORIES).catch(error => `? ${error.message}`),
  ])
  const sdkNew = JSON.parse(sdkPage).version
  const electronNew = JSON.parse(electronPage).version
  const codeNow = codeInstalled()
  const out = []
  const show = (title, groups, isCodeLog = false) => {
    const all = groups.reduce((sum, one) => sum + one.notes.length, 0)
    const hits = groups.reduce((sum, one) => sum + one.notes.filter(note => marked(note, used, isCodeLog)).length, 0)
    out.push('', `${title}: ${groups.length} newer ${groups.length === 1 ? 'version' : 'versions'}, ${all} notes, ${hits} marked as touching Cla-Amp`)

    for (const one of groups) {
      const mine = one.notes.filter(note => marked(note, used, isCodeLog))
      out.push(`  ${one.version}  (${mine.length} marked of ${one.notes.length})`)

      for (const note of isAll ? one.notes : mine) {
        out.push(`    ${marked(note, used, isCodeLog) ? '*' : ' '} ${note}`)
      }
    }
  }

  out.push(`Claude Agent SDK: installed ${sdkNow}, newest ${sdkNew}${sdkNow === sdkNew ? ' (up to date)' : ''}`)
  out.push(`Claude Code inside it: ${codeNow}`)
  out.push(`Electron: installed ${electronNow}, newest ${electronNew}${electronNow === electronNew ? ' (up to date)' : ''}`)
  out.push(missing.length === 0 ? 'Contract with the installed SDK: holds.' : `Contract with the installed SDK: BROKEN, missing ${missing.join(', ')}`)
  out.push(...(advisoryPage.startsWith('? ') ? [`Claude Code security advisories: could not be read (${advisoryPage.slice(2)})`] : advisoryLines(advisoriesFor(JSON.parse(advisoryPage), codeNow), codeNow)))
  show('Agent SDK change log', notesSince(sdkLog, sdkNow))
  show('Claude Code change log', notesSince(codeLog, codeNow), true)

  // The desktop app: which Claude Code it carries now, and what its releases
  // since the one Cla-Amp's engine matches say about the ground they share.
  const releases = desktopLog.startsWith('? ') ? [] : desktopReleases(desktopLog)

  if (releases.length === 0) {
    out.push('', `Claude desktop app release notes: could not be read${desktopLog.startsWith('? ') ? ` (${desktopLog.slice(2)})` : ' (the page is not laid out as it was)'}. ${DESKTOP_LOG}`)
  } else {
    const [newest] = releases
    const ahead = releases.filter(one => one.code && isNewer(one.code, codeNow))
    const all = ahead.reduce((sum, one) => sum + one.notes.length, 0)
    const hits = ahead.reduce((sum, one) => sum + one.notes.filter(markedDesktop).length, 0)
    const gap = newest.code ? parts(newest.code)[2] - parts(codeNow)[2] : 0

    out.push(
      '',
      `Claude desktop app: newest ${newest.version} (${newest.date}) carries Claude Code ${newest.code || 'unknown'}; Cla-Amp carries ${codeNow}${
        gap > 0 ? `, ${gap} ${gap === 1 ? 'version' : 'versions'} behind it` : gap < 0 ? ', ahead of it' : ', the same'
      }`,
      `Claude desktop app release notes: ${ahead.length} ${ahead.length === 1 ? 'release carries' : 'releases carry'} a newer Claude Code than Cla-Amp, ${all} notes, ${hits} marked as touching Cla-Amp`,
    )

    for (const one of ahead) {
      const mine = one.notes.filter(markedDesktop)
      out.push(`  ${one.version}  ${one.date}  Claude Code ${one.code}  (${mine.length} marked of ${one.notes.length})`)

      for (const note of isAll ? one.notes : mine) {
        out.push(`    ${markedDesktop(note) ? '*' : ' '} [${note.part || 'note'}] ${note.text}`)
      }
    }
  }

  if (sdkNow !== sdkNew) {
    out.push('', 'To take the update: see "Taking an engine update" in docs/code-guide.md.')
  }
  console.log(out.join('\n'))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--news')) {
    await news(process.argv.includes('--all'))
  } else if (process.argv.includes('--advisories')) {
    const codeNow = codeInstalled()
    const result = advisoriesFor(JSON.parse(await get(ADVISORIES)), codeNow)

    console.log(advisoryLines(result, codeNow).join('\n'))
    process.exit(result.open.length > 0 ? 1 : 0)
  } else {
    const { missing, used } = missingFromSdk()
    const count = used.imports.size + used.methods.size + used.messages.size

    if (missing.length > 0) {
      console.error(`engine contract: the installed SDK (${installed(SDK).version}) no longer has ${missing.join(', ')}`)
      process.exit(1)
    }
    console.log(`engine contract: all ${count} things Cla-Amp uses are in SDK ${installed(SDK).version}`)
  }
}
