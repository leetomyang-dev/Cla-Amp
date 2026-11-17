// The window in other languages. The code keeps writing English; this file
// swaps each piece of the window's own text for its translation as it is
// put on screen, from one file of pairs per language (renderer/lang/xx.js,
// English text to translated text). A piece with no translation stays in
// English, so new features work before they are translated.
// What a person or Claude wrote (messages, code, file and song names) is
// never touched. tools/lang-strings.mjs lists the English pieces and says
// what each language's file lacks.

/** The languages there are files for, each under its own name. */
export const LANGS = [
  ['en', 'English'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['hi', 'हिन्दी'],
  ['id', 'Bahasa Indonesia'],
  ['it', 'Italiano'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['pt-BR', 'Português (Brasil)'],
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
]

/** The language of the computer, when there is a file for it; English otherwise. */
const ofComputer = () => {
  for (const one of navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']) {
    const wanted = one.toLowerCase()

    if (wanted.startsWith('zh')) {
      return /-(tw|hk|mo)|hant/.test(wanted) ? 'zh-TW' : 'zh-CN'
    }

    const hit = LANGS.find(([code]) => code.toLowerCase() === wanted) ?? LANGS.find(([code]) => code.split('-')[0] === wanted.split('-')[0])

    if (hit) {
      return hit[0]
    }
  }

  return 'en'
}

/** The person's own choice: a language's code, or '' to follow the computer. */
export const langChoice = () => {
  const kept = localStorage.getItem('lang') ?? ''

  return LANGS.some(([code]) => code === kept) ? kept : ''
}

/** The language the window is in. */
export const lang = langChoice() || ofComputer()

/** Keeps the choice and draws the window again in it. Chats keep running. */
export const setLang = code => {
  if (code) {
    localStorage.setItem('lang', code)
  } else {
    localStorage.removeItem('lang')
  }
  // The window may not reload itself (the main process refuses every navigation): the main process does it.
  void window.amp.call('app:reload')
}

// Whole pieces, and pieces with changing parts ("Show all {} lines").
const whole = new Map()
// By their first three letters, so a piece of text is tried against a few patterns and not all.
const byStart = new Map()
const loose = []
const done = new Map()

const tidy = text => text.trim().replace(/\s+/g, ' ')

const learn = words => {
  for (const [from, to] of Object.entries(words)) {
    if (typeof to !== 'string' || to === '' || to === from) {
      continue
    }

    if (!from.includes('{}')) {
      whole.set(tidy(from), to)
      continue
    }

    const fixed = from.replace(/\{\}/g, '')
    const start = from.split('{}')[0]

    // A pattern that is nearly all changing parts would match anything.
    if ((fixed.match(/[A-Za-z]/g) ?? []).length < (start.length >= 3 ? 3 : 4)) {
      continue
    }

    const pattern = { size: fixed.length, to, test: new RegExp(`^${tidy(from).split('{}').map(one => one.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.*?)')}$`, 's') }

    if (start.length >= 3) {
      const key = start.slice(0, 3)
      byStart.set(key, [...(byStart.get(key) ?? []), pattern])
    } else {
      loose.push(pattern)
    }
  }

  // The pattern with the most fixed text first: it is the closest fit.
  for (const list of [...byStart.values(), loose]) {
    list.sort((a, b) => b.size - a.size)
  }
}

/** A piece of the window's text in the window's language, or null when there is no translation. */
const translate = text => {
  if (text.length > 700 || !/[A-Za-z]{2}/.test(text)) {
    return null
  }

  if (done.has(text)) {
    return done.get(text)
  }

  const key = tidy(text)
  let out = whole.get(key) ?? null

  if (out === null) {
    for (const pattern of [...(byStart.get(key.slice(0, 3)) ?? []), ...(key.length < 400 ? loose : [])]) {
      const parts = pattern.test.exec(key)

      if (parts) {
        let count = 0
        // {} takes the changing parts in order; {2} takes the second, where the order differs.
        out = pattern.to.replace(/\{(\d*)\}/g, (_all, which) => {
          const part = parts[which ? Number(which) : (count += 1)] ?? ''

          return whole.get(part) ?? part
        })
        break
      }
    }
  }

  if (out !== null) {
    out = /^\s*/.exec(text)[0] + out + /\s*$/.exec(text)[0]
  }

  if (done.size > 6000) {
    done.clear()
  }
  done.set(text, out)

  return out
}

/** The same for code that shows text outside the page (a message box). */
export const say = text => translate(String(text)) ?? String(text)

// Where the words are a person's or Claude's own, or a file's: left as they are.
const OWN = 'pre, code, script, style, .msg-body, .term-cmd, .tool-args, .code-view, .diff, .file-body, .song:not(.song-head), .proj-name, .proj-detail, .ref-name, .mq, [data-own-words]'
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label']

const putText = node => {
  const out = translate(node.nodeValue)

  if (out === null || out === node.nodeValue) {
    return
  }

  // A choice in a list with no value of its own stands for its English text: the code goes by that.
  const holder = node.parentElement

  if (holder?.tagName === 'OPTION' && !holder.hasAttribute('value')) {
    holder.setAttribute('value', holder.value)
  }
  node.nodeValue = out
}

const putAttr = (node, name) => {
  const now = node.getAttribute(name)
  const out = now ? translate(now) : null

  if (out !== null && out !== now) {
    node.setAttribute(name, out)
  }
}

const putAll = root => {
  if (root.nodeType === Node.TEXT_NODE) {
    if (!root.parentElement?.closest(OWN)) {
      putText(root)
    }

    return
  }

  if (root.nodeType !== Node.ELEMENT_NODE || root.closest(OWN)) {
    return
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      if (node.nodeType !== Node.ELEMENT_NODE || !node.matches(OWN)) {
        return NodeFilter.FILTER_ACCEPT
      }

      // Not in the window's language: a screen reader should not read it in that language's voice.
      if (!node.hasAttribute('lang')) {
        node.setAttribute('lang', '')
      }

      return NodeFilter.FILTER_REJECT
    },
  })

  for (let node = root; node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      putText(node)
    } else {
      for (const name of ATTRS) {
        if (node.hasAttribute(name)) {
          putAttr(node, name)
        }
      }
    }
  }
}

if (lang !== 'en') {
  try {
    learn((await import(`./lang/${lang}.js`)).default)
    document.documentElement.lang = lang
    putAll(document.body)
    new MutationObserver(changes => {
      for (const change of changes) {
        if (change.type === 'childList') {
          change.addedNodes.forEach(putAll)
        } else if (change.type === 'characterData') {
          putAll(change.target)
        } else if (!change.target.closest(OWN)) {
          putAttr(change.target, change.attributeName)
        }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })

    // Message boxes are drawn by Windows, outside the page.
    for (const name of ['alert', 'confirm']) {
      const shown = window[name].bind(window)
      window[name] = text => shown(say(text))
    }
  } catch {
    // No file for this language, or a broken one: the window stays in English.
  }
}
