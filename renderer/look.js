// "Customize": change each part of the window without writing a skin. Per
// part: a background colour, a picture and how strongly it shows, how
// see-through the part is, its edge colour, its text colour, its corners.
// The choices lie on top of whichever skin is in use and are kept by the
// main process (which also keeps the chosen pictures, in this app's own
// folder). A skin file can do far more: docs/skins.md.

import { openGuides } from './guides.js'

const call = (name, ...args) => window.amp.call(name, ...args)
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text

  return node
}

/** The parts, in the order they sit in the window: key, name, where it is in the page. */
const PARTS = [
  ['window', 'Whole window', '#app'],
  ['titlebar', 'Title bar', '.titlebar'],
  ['banner', 'Banner (name and top player)', '.brand'],
  ['buttons', 'Button row', '.transport'],
  ['status', 'Status bar', '.statusbar'],
  ['left', 'Projects column', '#left'],
  ['chat', 'Chat', '#center'],
  ['composer', 'Message box', '#composer'],
  ['panels', 'Right-hand panels', '.cols .panel'],
  ['deck', 'Music deck', '#right .panel[data-panel="deck"]'],
]

let look = {}
const sheet = document.createElement('style')
sheet.id = 'lookStyle'
document.head.append(sheet)

const rgb = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')

/** The choices as style rules. Each also sets the skin's own variables inside its part, so the text and lines within follow. */
const apply = () => {
  sheet.textContent = PARTS.map(([key, , where]) => {
    const one = look[key] ?? {}
    const lines = []

    if (one.picture) {
      // The colour lies over the picture; the stronger the picture, the thinner the colour.
      const veil = 1 - (one.show ?? 70) / 100
      const tint = `rgba(${rgb(one.back ?? '#000000')}, ${veil.toFixed(2)})`
      lines.push(`background: linear-gradient(${tint}, ${tint}), url("${one.picture}") center / cover no-repeat !important`)
    } else if (one.back) {
      lines.push(`background: ${one.back} !important`)
    }

    if (one.edge) {
      lines.push(`border-color: ${one.edge} !important`, `--line: ${one.edge}`)
    }

    if (one.text) {
      lines.push(`color: ${one.text} !important`, `--text: ${one.text}`, `--dim: color-mix(in srgb, ${one.text} 62%, transparent)`)
    }

    if (typeof one.opacity === 'number' && one.opacity < 100 && key !== 'window') {
      lines.push(`opacity: ${(one.opacity / 100).toFixed(2)}`)
    }

    if (typeof one.round === 'number') {
      lines.push(`border-radius: ${one.round}px !important`)
    }

    return lines.length > 0 ? `${where} { ${lines.join('; ')}; }` : ''
  })
    .filter(Boolean)
    .join('\n')
}

let saveTimer = null
const save = () => {
  apply()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void call('look:set', look), 300)
}

const dialog = el('dialog', 'sheet look-sheet')
document.body.append(dialog)

const build = key => {
  const one = (look[key] ??= {})
  const [, name] = PARTS.find(part => part[0] === key)
  const body = el('div', 'look-body')
  const row = (label, hint, ...controls) => {
    const line = el('div', 'look-row')
    const text = el('span', 'look-name', label)
    text.title = hint
    line.append(text, ...controls)
    body.append(line)
  }
  /** A colour that can also be left as the skin has it. */
  const colour = (field, label, hint) => {
    const tick = el('input')
    tick.type = 'checkbox'
    tick.checked = Boolean(one[field])
    tick.title = 'Ticked: use this colour. Not ticked: leave it as the skin has it.'
    const pick = el('input')
    pick.type = 'color'
    pick.value = one[field] ?? '#808080'
    pick.setAttribute('aria-label', label)
    const set = () => {
      if (tick.checked) {
        one[field] = pick.value
      } else {
        delete one[field]
      }
      save()
    }
    tick.addEventListener('change', set)
    pick.addEventListener('input', () => {
      tick.checked = true
      set()
    })
    row(label, hint, tick, pick)
  }
  const slide = (field, label, hint, min, max, standard, unit) => {
    const slider = el('input')
    slider.type = 'range'
    slider.min = String(min)
    slider.max = String(max)
    slider.value = String(one[field] ?? standard)
    slider.setAttribute('aria-label', label)
    const says = el('span', 'look-value', `${slider.value}${unit}`)
    slider.addEventListener('input', () => {
      one[field] = Number(slider.value)
      says.textContent = `${slider.value}${unit}`
      save()
    })
    row(label, hint, slider, says)
  }

  colour('back', 'Background colour', 'The colour behind this part. With a picture, it is the tint laid over the picture.')
  const choose = el('button', 'pill', one.picture ? 'Change picture' : 'Choose picture')
  const clear = el('button', 'pill', 'No picture')
  clear.disabled = !one.picture
  choose.addEventListener('click', async () => {
    const picked = await call('look:picture')

    if (picked?.url) {
      one.picture = picked.url
      save()
      show(key)
    } else if (picked?.error) {
      alert(picked.error)
    }
  })
  clear.addEventListener('click', () => {
    delete one.picture
    save()
    show(key)
  })
  row('Picture', 'A picture of yours behind this part: PNG, JPEG, GIF or WebP. It is copied into Cla-Amp’s own folder.', choose, clear)

  if (one.picture) {
    slide('show', 'Picture strength', 'How strongly the picture shows through the colour laid over it. Lower it when text gets hard to read.', 0, 100, 70, '%')
  }

  if (key !== 'window') {
    slide('opacity', 'See-through', 'How solid this part is. Below 100 the window behind it shows through, text and all.', 20, 100, 100, '%')
  }
  colour('edge', 'Edge colour', 'The colour of this part’s border and of the thin lines inside it.')
  colour('text', 'Text colour', 'The colour of the words in this part.')
  slide('round', 'Corners', 'How round this part’s corners are. 0 is square.', 0, 24, 8, ' px')

  const undo = el('button', 'text-btn', `Put "${name}" back as the skin has it`)
  undo.addEventListener('click', () => {
    delete look[key]
    save()
    show(key)
  })
  body.append(undo)

  return body
}

const show = key => {
  const title = el('h2', '', 'Customize')
  const intro = el('p', 'sheet-note', 'Pick a part of the window, then change it. Changes show at once, lie on top of the skin in use, and are kept. Some parts have pieces with a background of their own (buttons, song rows), which stay on top of a picture.')
  const which = el('select', 'look-which')
  which.setAttribute('aria-label', 'Part of the window')

  for (const [id, name] of PARTS) {
    which.append(new Option(name + (look[id] && Object.keys(look[id]).length > 0 ? '  •' : ''), id))
  }
  which.value = key
  which.addEventListener('change', () => show(which.value))

  const more = el('div', 'sheet-foot')
  const all = el('button', 'pill', 'Undo all changes')
  all.title = 'Take every change made here away again. The skin itself is not touched.'
  all.addEventListener('click', () => {
    if (confirm('Take away every change made in Customize? The skin itself is not touched.')) {
      look = {}
      save()
      show(key)
    }
  })
  const folder = el('button', 'pill', 'Open my skins folder')
  folder.title = 'For changes beyond this page: a skin is a folder with a small text file of colours and pictures. A starter skin to edit is put there the first time.'
  folder.addEventListener('click', () => void call('skins:folder'))
  const guide = el('button', 'pill', 'Skin guide')
  guide.title = 'Opens the guide to editing a skin by hand: every colour and picture it can set'
  guide.addEventListener('click', () => {
    dialog.close()
    void openGuides('skins')
  })
  const close = el('button', 'pill go', 'Done')
  close.addEventListener('click', () => dialog.close())
  more.append(all, folder, guide, el('span', 'grow'), close)
  dialog.replaceChildren(title, intro, which, build(key), more)
}

/** Reads the kept choices and puts them on. Called once when the window opens. */
export const startLook = async () => {
  const saved = await call('look:get')
  look = saved && typeof saved === 'object' ? saved : {}
  apply()
}

export const openLook = () => {
  show('window')
  dialog.showModal()
}
