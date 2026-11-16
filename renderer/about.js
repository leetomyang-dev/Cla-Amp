// "About Cla-Amp": what it is, who made it and with what, and whose the
// names and pieces in it are. The versions and the list of parts it is built
// from come from the main process, read from the installed packages.

import { openGuides } from './guides.js'

const call = (name, ...args) => window.amp.call(name, ...args)
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text

  return node
}

const dialog = el('dialog', 'sheet about-sheet')
document.body.append(dialog)

const section = (title, ...lines) => {
  const box = el('section', 'about-part')
  box.append(el('h3', '', title), ...lines.map(line => (typeof line === 'string' ? el('p', '', line) : line)))

  return box
}

export const openAbout = async () => {
  const info = (await call('about:info')) ?? {}
  const head = el('div', 'about-head')
  const picture = el('img')
  picture.src = 'brand/icon.png'
  picture.alt = ''
  const name = el('div')
  name.append(el('h2', '', 'Cla-Amp'), el('p', 'sheet-note', `Version ${info.version ?? '?'}. A retro music-player-style workspace that runs Claude Code.`))
  head.append(picture, name)

  const parts = el('table', 'about-table')

  for (const one of info.parts ?? []) {
    const row = el('tr')
    row.append(el('td', '', one.name), el('td', '', one.version), el('td', '', one.licence))
    parts.append(row)
  }

  const foot = el('div', 'sheet-foot')
  const docs = el('button', 'pill', 'Guides')
  docs.title = 'Cla-Amp’s own guides, read here: skins, the playlists, security, how the code is laid out'
  docs.addEventListener('click', () => {
    dialog.close()
    void openGuides()
  })
  const close = el('button', 'pill go', 'Close')
  close.addEventListener('click', () => dialog.close())
  foot.append(docs, el('span', 'grow'), close)

  dialog.replaceChildren(
    head,
    section(
      'Credits',
      'The program was written with Claude Code, Anthropic’s coding assistant.',
      'The icon was made with ChatGPT’s image models.',
    ),
    section('Built with', parts, `Runs on Electron ${info.electron ?? '?'} (Chromium ${info.chrome ?? '?'}, Node.js ${info.node ?? '?'}).`),
    section(
      'Whose is what',
      'Cla-Amp is free, with its source public, under the MIT License with the Commons Clause (LICENSE.md): use it for anything, your paid work included; selling Cla-Amp itself is not allowed. Claude Code and the other parts it is built with keep their own licences.',
      'Cla-Amp is an independent project. It is not made, sponsored or endorsed by Anthropic, by the makers of Winamp, by Spotify, or by Google and YouTube. Those names and marks belong to their owners and are used here only to say what Cla-Amp works with.',
      'Winamp skins you import were made by their own authors and stay theirs; Cla-Amp only reads the file you give it.',
      'The music is yours or your music service’s. Cla-Amp plays your own files and steers the players you are signed in to; it does not copy or keep any of it.',
    ),
    section(
      'What it does with your data',
      'Your chats go to Claude through Claude Code, exactly as they do in Claude Code itself. Cla-Amp has no accounts of its own, no tracking and no server.',
      'One thing goes out, and only when you use it: a Winamp skin link you paste is fetched from the Winamp Skin Museum. The Privacy guide has the full list.',
    ),
    foot,
  )

  if (!dialog.open) {
    dialog.showModal()
  }
}
