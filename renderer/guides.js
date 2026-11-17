// "Guides": Cla-Amp's own guides, read inside the window. The text comes
// from the app's docs folder through the main process (only the guides named
// here), is turned from Markdown into a page, and is cleaned before it is
// shown. A link to another guide opens it here; links to the web are shown
// as plain text, since this window loads nothing from the network.

import DOMPurify from '../node_modules/dompurify/dist/purify.es.mjs'
import { marked } from '../node_modules/marked/lib/marked.esm.js'

const call = (name, ...args) => window.amp.call(name, ...args)
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text

  return node
}

/** Key (the file's name in docs, or 'readme'), and the name shown. */
const GUIDES = [
  ['quick-start', 'Quick start: make it yours'],
  ['user-guide', 'Using Cla-Amp'],
  ['skins', 'Skins and looks'],
  ['privacy', 'Privacy'],
  ['security', 'Security'],
  ['readme', 'Installing it from the source'],
  ['code-guide', 'For developers: how the code is laid out'],
]

const dialog = el('dialog', 'sheet guide-sheet')
document.body.append(dialog)

const show = async key => {
  const head = el('div', 'guide-head')
  const which = el('select', 'guide-which')
  which.setAttribute('aria-label', 'Guide')

  for (const [id, name] of GUIDES) {
    which.append(new Option(name, id))
  }
  which.value = key
  which.addEventListener('change', () => void show(which.value))
  const close = el('button', 'pill go', 'Close')
  close.addEventListener('click', () => dialog.close())
  head.append(el('h2', '', 'Guides'), which, close)

  const text = await call('docs:read', key)
  const page = el('div', 'msg-body guide-page')
  page.innerHTML = DOMPurify.sanitize(marked.parse(typeof text === 'string' ? text : 'This guide could not be read.'), { FORBID_TAGS: ['img', 'style', 'form', 'input'] })

  for (const link of page.querySelectorAll('a')) {
    const to = (link.getAttribute('href') ?? '').replace(/^(\.\/|docs\/)/, '').replace(/#.*$/, '')
    const guide = GUIDES.find(([id]) => to === `${id}.md` || (id === 'readme' && /(^|\/)README\.md$/i.test(to)))

    if (guide) {
      link.href = '#'
      link.title = `Open the guide: ${guide[1]}`
      link.addEventListener('click', event => {
        event.preventDefault()
        void show(guide[0])
      })
    } else {
      // A web address or a file: shown as words, with the address after it.
      const plain = el('span', '', /^https?:/.test(to) && link.textContent !== to ? `${link.textContent} (${to})` : link.textContent)
      link.replaceWith(plain)
    }
  }

  dialog.replaceChildren(head, page)
  page.scrollTop = 0
}

/** Opens the guides, on one of them if named. */
export const openGuides = async (key = 'user-guide') => {
  await show(GUIDES.some(([id]) => id === key) ? key : 'user-guide')

  if (!dialog.open) {
    dialog.showModal()
  }
}
