// Lists the words the window can show, for translators: every piece of
// English in the window's code and page that reads like words for a person.
// Run: node tools/lang-strings.mjs            (prints how many, and what each language lacks)
//      node tools/lang-strings.mjs --write    (also writes renderer/lang/strings.json)
// A piece with a changing part is listed with {} where that part goes:
// `Show all ${count} lines` is "Show all {} lines".
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const found = new Map()

/** Whether a piece of text in the code is words for a person and not a name the code uses. */
const isWords = text => {
  const plain = text.replace(/\{\}/g, '').trim()

  if (plain.length < 2 || plain.length > 600 || !/[A-Za-z]{2}/.test(plain)) {
    return false
  }

  // Names of things in the code: classes, selectors, paths, keys, addresses, colours.
  if (/^[a-z0-9_.:#>\[\]=*"'()\-\s,/\\@%+~^$|!?&;<]+$/.test(plain) && !/^[a-z]+( [a-z]+){2,}[.!?]?$/.test(plain)) {
    return false
  }

  if (/^(https?:|file:|data:|[A-Za-z]:[\\/]|\.{0,2}\/)/.test(plain) || /^[A-Z0-9_]+$/.test(plain) || /^[a-z]+[A-Z][A-Za-z]*$/.test(plain) || /^[\w-]+\.(js|mjs|css|md|json|png|svg|webp|txt|html)$/i.test(plain)) {
    return false
  }

  // Code, markup and patterns kept in text.
  if (/[{};]\s*$|^\s*<|=>|\\[dwsb]|^\(\?|function |const |\$\(|<\/|^--|^\[|\]$|^#|^@/.test(plain) || /^[A-Za-z]+-[A-Za-z-]+$/.test(plain) || /^[A-Za-z0-9]+([_:][A-Za-z0-9]+)+$/.test(plain)) {
    return false
  }

  // Commands and typefaces handed to Windows.
  if (/\$env|::|^"|^\d+px |^&\s*\(|^(ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|ContextMenu|Home|End|Enter|Escape|Tab)$/.test(plain)) {
    return false
  }

  return /\s/.test(plain) ||/^[A-Z][a-z]+[.!?:…]?$/.test(plain) || /^[A-Z][a-z]+ ?[A-Za-z]*$/.test(plain)
}

const take = (text, where) => {
  const words = text.replace(/\s+/g, ' ').trim()

  if (isWords(words) && !found.has(words)) {
    found.set(words, where)
  }
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', b: '\b', f: '\f', v: '\v' }

/**
 * Reads JavaScript far enough to find its quoted text: it steps over
 * comments and patterns, and follows `${...}` inside back-quoted text.
 * Stops at `until` (the brace that ends a `${...}`) and gives where it stopped.
 */
const scan = (code, where, from = 0, until = '') => {
  let at = from
  let depth = 0
  // Whether a slash here would start a pattern (true) or divide (false).
  let canPattern = true

  const quoted = quote => {
    let text = ''
    at += 1

    while (at < code.length && code[at] !== quote) {
      if (code[at] === '\\') {
        const next = code[at + 1]

        if (next === 'u' && code[at + 2] === '{') {
          const end = code.indexOf('}', at)
          text += String.fromCodePoint(parseInt(code.slice(at + 3, end), 16))
          at = end + 1
        } else if (next === 'u') {
          text += String.fromCharCode(parseInt(code.slice(at + 2, at + 6), 16))
          at += 6
        } else if (next === 'x') {
          text += String.fromCharCode(parseInt(code.slice(at + 2, at + 4), 16))
          at += 4
        } else if (next === '\n') {
          at += 2
        } else {
          text += ESCAPES[next] ?? next
          at += 2
        }
      } else if (quote === '`' && code[at] === '$' && code[at + 1] === '{') {
        text += '{}'
        at = scan(code, where, at + 2, '}') + 1
      } else {
        text += code[at]
        at += 1
      }
    }
    at += 1

    return text
  }

  while (at < code.length) {
    const one = code[at]

    if (one === '/' && code[at + 1] === '/') {
      at = code.indexOf('\n', at)
      at = at < 0 ? code.length : at
    } else if (one === '/' && code[at + 1] === '*') {
      at = code.indexOf('*/', at) + 2
    } else if (one === '/' && canPattern) {
      // A pattern: to its closing slash, a slash inside [...] not counting.
      let isInSet = false
      at += 1

      while (at < code.length && (code[at] !== '/' || isInSet) && code[at] !== '\n') {
        if (code[at] === '\\') {
          at += 1
        } else if (code[at] === '[') {
          isInSet = true
        } else if (code[at] === ']') {
          isInSet = false
        }
        at += 1
      }
      at += 1
      canPattern = false
    } else if (one === "'" || one === '"' || one === '`') {
      take(quoted(one), where)
      canPattern = false
    } else if (one === '{') {
      depth += 1
      at += 1
      canPattern = true
    } else if (one === '}') {
      if (depth === 0 && until === '}') {
        return at
      }

      depth -= 1
      at += 1
      canPattern = true
    } else if (/\s/.test(one)) {
      at += 1
    } else if (/[\w$]/.test(one)) {
      const word = /^[\w$]+/.exec(code.slice(at, at + 80))[0]
      at += word.length
      canPattern = ['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'new', 'else', 'do', 'await', 'yield'].includes(word)
    } else {
      canPattern = one !== ')' && one !== ']'
      at += 1
    }
  }

  return at
}

const SOURCES = ['renderer/app.js', 'renderer/access.js', 'renderer/about.js', 'renderer/calendar.js', 'renderer/equalizer.js', 'renderer/guides.js', 'renderer/look.js', 'renderer/settings.js', 'renderer/spectrum.js', 'renderer/themes.js', 'main.mjs']

for (const name of SOURCES) {
  scan(fs.readFileSync(path.join(ROOT, name), 'utf8'), name)
}

// The page: the words between tags, and the ones in title, placeholder, aria-label and alt.
/**
 * The text with every stretch from `open` to the end of `close` taken out,
 * whatever the case of the letters. Found by position, start to end, so
 * nothing that is left can join up into a new stretch; one that never closes
 * goes to the end. A `close` without its last bracket ('</script') reaches to
 * the next '>' so a closing tag with spaces in it is taken whole.
 */
const without = (text, open, close) => {
  const low = text.toLowerCase()
  let kept = ''
  let at = 0

  for (;;) {
    const start = low.indexOf(open, at)

    if (start === -1) {
      return kept + text.slice(at)
    }
    kept += text.slice(at, start)
    const end = low.indexOf(close, start + open.length)

    if (end === -1) {
      return kept
    }

    if (close.endsWith('>')) {
      at = end + close.length
    } else {
      const shut = low.indexOf('>', end)

      if (shut === -1) {
        return kept
      }
      at = shut + 1
    }
  }
}

// This reads Cla-Amp's own page to list its words; nothing here is shown as HTML.
const page = without(without(fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8'), '<!--', '-->'), '<script', '</script')
const NAMED = { darr: '↓', uarr: '↑', times: '×', hellip: '…', middot: '·', amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' }
// Each &...; is turned once, in one pass, so what one turns into is never read as another.
const plain = text => text.replace(/&(?:#(\d+)|([a-z]+));/g, (all, code, name) => (code ? String.fromCodePoint(Number(code)) : NAMED[name] ?? all))

for (const [, text] of page.matchAll(/>([^<>]+)</g)) {
  take(plain(text), 'renderer/index.html')
}

for (const [, text] of page.matchAll(/\s(?:title|placeholder|aria-label|alt|data-slot-name)="([^"]+)"/g)) {
  take(plain(text), 'renderer/index.html')
}

// Pieces the code puts together from parts, written here as the window shows
// them, so they can be translated whole. Add one when a count or a status
// word still shows in English.
const TOGETHER = [
  '{} agent running',
  '{} agents running',
  '{} line',
  '{} lines',
  'failed · {} line',
  'failed · {} lines',
  '{} line put in, {} taken out',
  '{} lines put in, {} taken out',
  '{} step done',
  '{} steps done',
  '{} pull request from this chat',
  '{} pull requests from this chat',
  '{} chat is working in this folder right now',
  '{} chats are working in this folder right now',
  '{} of {} tokens, from the last reply',
  '{}% used',
  '{}% used, {}% left',
  '{}: {}% used, {}% left. {}',
  '{}: {}% used. {}',
  '{}: nothing used yet',
  '{}: the reply ended with an error',
  '{} used',
  'WORKING',
  'WAITING',
  'COMPLETE',
  'ATTENTION',
  "{} Click for due dates and the day's report",
  'Connected, {} tool',
  'Connected, {} tools',
  'Queue ({})',
  ...['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map(one => `${one} {}`),
]

for (const one of TOGETHER) {
  found.set(one, 'tools/lang-strings.mjs')
}

const all = [...found.keys()].sort((a, b) => a.localeCompare(b))
console.log(`${all.length} pieces of text`)

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.join(ROOT, 'renderer/lang'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'renderer/lang/strings.json'), `${JSON.stringify(all, null, 1)}\n`)
}

if (process.argv.includes('--list')) {
  console.log(all.join('\n'))
}

// What each language's file lacks, and what it has that is no longer in the code.
const folder = path.join(ROOT, 'renderer/lang')

for (const file of fs.existsSync(folder) ? fs.readdirSync(folder).filter(one => /^[a-z]{2}(-[A-Z]{2})?\.js$/.test(one)) : []) {
  // Each file is "export default" and then plain JSON.
  let words = null

  try {
    words = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8').replace(/^\s*export default\s*/, ''))
  } catch (error) {
    console.log(`${file}: NOT READABLE (${error.message})`)
    process.exitCode = 1
    continue
  }

  const lacks = all.filter(one => typeof words[one] !== 'string')
  const extra = Object.keys(words).filter(one => !found.has(one))
  console.log(`${file}: ${Object.keys(words).length} translated, ${lacks.length} not yet, ${extra.length} no longer used`)

  // A translation must keep every changing part: as many {} (or {1}, {2}) as the English has.
  const count = text => (text.match(/\{\d*\}/g) ?? []).length
  const wrong = Object.keys(words).filter(one => typeof words[one] === 'string' && count(one) !== count(words[one]))

  if (wrong.length > 0) {
    console.log(`  ${wrong.length} with the wrong number of {}:`)
    console.log(wrong.map(one => `    ${one}`).join('\n'))
    process.exitCode = 1
  }

  if (process.argv.includes('--missing')) {
    console.log(lacks.map(one => `  ${one}`).join('\n'))
  }
}
