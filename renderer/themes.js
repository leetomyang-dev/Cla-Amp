// "Themes": every look Cla-Amp can wear, in one list, with where each came
// from. A skin sets colours and shapes; a theme is a skin plus what the
// person changed on top of it (Customize, which panels and widgets show and
// where, the second column, the top player's size), saved under a name.
// Themes are small files in Cla-Amp's own folder; they can be exported and
// imported. Putting a theme on reloads the window (chats keep running).

const call = (name, ...args) => window.amp.call(name, ...args)
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text

  return node
}

// What this window keeps of the layout, by the name it is kept under.
const LAYOUT_KEYS = ['panels', 'widgets', 'playerSize', 'col2', 'zones']
// Added later: where the sections sit, the columns' widths and which are hidden.
// A theme saved before these existed says nothing about them and leaves them as they are.
const LATER_KEYS = ['places', 'layout', 'sideTall', 'width-left', 'width-right', 'width-right2', 'sideLinked', 'statusItems', 'hiddenPanels', 'hide-left', 'hide-right', 'topPlayer']

const dialog = el('dialog', 'sheet theme-sheet')
document.body.append(dialog)

const kept = key => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return localStorage.getItem(key)
  }
}

/** The look in use right now: the skin, the Customize choices and the layout. */
const snapshot = async () => ({
  skin: document.getElementById('skin').value,
  look: (await call('look:get')) ?? {},
  layout: Object.fromEntries([...LAYOUT_KEYS.map(key => [key, kept(key)]).filter(([, value]) => value !== null), ...LATER_KEYS.map(key => [key, localStorage.getItem(key) ?? ''])]),
})
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Puts a look on: its skin, its Customize choices and its layout, then reloads the window. */
const putOn = async (name, data) => {
  for (const key of LAYOUT_KEYS) {
    if (data.layout && key in data.layout) {
      localStorage.setItem(key, typeof data.layout[key] === 'string' ? data.layout[key] : JSON.stringify(data.layout[key]))
    } else if (data.layout) {
      localStorage.removeItem(key)
    }
  }
  for (const key of LATER_KEYS) {
    const value = data.layout?.[key]

    if (value === '') {
      localStorage.removeItem(key)
    } else if (typeof value === 'string') {
      localStorage.setItem(key, value)
    }
  }
  await call('look:set', data.look ?? {})
  await call('prefs:set', 'skin', data.skin)
  localStorage.setItem('themeName', name)
  localStorage.setItem('themeBase', JSON.stringify({ skin: data.skin, look: (await call('look:get')) ?? {}, layout: data.layout ?? null }))
  // The page may not navigate, not even to itself: the app reloads it.
  await call('app:reload')
}

const show = async () => {
  const [skins, themes, now] = await Promise.all([call('skins:list'), call('themes:list'), snapshot()])
  const skinName = id => (skins ?? []).find(one => one.id === id)?.name ?? id
  const base = kept('themeBase')
  const name = localStorage.getItem('themeName') ?? ''
  // Changed since it was put on: the layout only counts when the look came with one.
  const isChanged = !base || base.skin !== now.skin || !same(base.look, now.look) || (base.layout !== null && !same(base.layout, now.layout))
  const current = (themes ?? []).find(one => one.name === name)

  const head = el('div', 'guide-head')
  const close = el('button', 'pill go', 'Close')
  close.addEventListener('click', () => dialog.close())
  head.append(el('h2', '', 'Themes'), el('span', 'grow'), close)

  // ---- what is on now, and saving it.
  const nowBox = el('div', 'theme-now')
  const title = !isChanged && name ? name : `Custom theme${name ? ` (changed from ${name})` : ''}`
  nowBox.append(el('b', '', `In use: ${title}`), el('span', 'sheet-note', `Skin: ${skinName(now.skin)}. ${isChanged ? 'Your changes are in use but not saved under a name yet.' : 'Nothing changed since it was put on.'}`))
  const saveRow = el('form', 'theme-save')
  const input = el('input')
  input.type = 'text'
  input.maxLength = 60
  input.placeholder = 'Name for this theme'
  input.value = current ? current.name : ''
  const saveAs = el('button', 'pill go', current && isChanged ? 'Save changes' : 'Save as a theme')
  saveAs.type = 'submit'
  saveRow.append(input, saveAs)
  saveRow.addEventListener('submit', async event => {
    event.preventDefault()
    const wanted = input.value.trim()

    if (wanted === '') {
      input.focus()

      return
    }

    const saved = await call('themes:save', { ...now, name: wanted })

    if (saved?.error) {
      alert(saved.error)

      return
    }
    localStorage.setItem('themeName', saved.name)
    localStorage.setItem('themeBase', JSON.stringify({ skin: now.skin, look: now.look, layout: now.layout }))
    void show()
  })
  const tools = el('div', 'sheet-foot')
  const customize = el('button', 'pill', 'Customize this look...')
  customize.title = 'Change colours, pictures, edges and text of each part of the window'
  customize.addEventListener('click', () => {
    dialog.close()
    document.getElementById('lookBtn').click()
  })
  tools.append(customize, el('span', 'sheet-note', 'Panels and widgets: drag their headings, or use Widgets, at the top of the window.'))
  nowBox.append(saveRow, tools)

  // ---- the list.
  const list = el('div', 'theme-list')
  const row = (label, source, isOn, buttons) => {
    const line = el('div', `theme-row${isOn ? ' on' : ''}`)
    const words = el('div', 'theme-words')
    words.append(el('b', '', label), el('span', '', source))
    line.append(words, ...buttons)
    list.append(line)
  }
  const button = (label, tip, run, kind = 'pill') => {
    const one = el('button', kind, label)
    one.title = tip
    one.addEventListener('click', run)

    return one
  }

  list.append(el('h3', '', 'Your saved themes'))

  if ((themes ?? []).length === 0) {
    list.append(el('div', 'sheet-note', 'None yet. Set the window up the way you like it, then save it above.'))
  }

  for (const theme of themes ?? []) {
    row(theme.name, `Saved theme  ·  skin: ${skinName(theme.skin)}  ·  saved ${new Date(theme.savedAt).toLocaleDateString()}`, theme.name === name && !isChanged, [
      button('Use', 'Put this theme on. The window reloads; chats keep running.', () => void putOn(theme.name, theme)),
      button('Rename', 'Give this theme another name', event => {
        // The name becomes a box to type in; Enter keeps it, Escape leaves it.
        const words = event.target.closest('.theme-row').querySelector('.theme-words')
        const box = el('input')
        box.type = 'text'
        box.maxLength = 60
        box.value = theme.name
        words.replaceChildren(box)
        box.focus()
        box.select()
        box.addEventListener('keydown', async pressed => {
          if (pressed.key === 'Escape') {
            pressed.preventDefault()
            void show()
          } else if (pressed.key === 'Enter') {
            const wanted = box.value.trim()

            if (wanted && wanted !== theme.name) {
              const done = await call('themes:save', { ...theme, name: wanted, replaces: theme.file })

              if (done?.error) {
                alert(done.error)
              } else if (theme.name === name) {
                localStorage.setItem('themeName', done.name)
              }
            }
            void show()
          }
        })
      }),
      button('Export', 'Save this theme as a file you can share or keep', () => void call('themes:export', theme.file)),
      button('Delete', 'Delete this saved theme. The skin it uses stays.', async () => {
        if (confirm(`Delete the theme "${theme.name}"? This cannot be undone. The skin it uses is not touched.`)) {
          await call('themes:delete', theme.file)
          void show()
        }
      }),
    ])
  }

  list.append(el('h3', '', 'Skins'))

  for (const skin of skins ?? []) {
    const source = skin.kind === 'refused' ? 'Not usable: it holds something a skin may not' : skin.id.startsWith('built-in/') ? 'Comes with Cla-Amp' : 'From your skins folder (made, copied or imported by you)'
    row(skin.name, `${source}${skin.author ? `  ·  by ${skin.author}` : ''}${skin.description ? `  ·  ${skin.description}` : ''}`, skin.id === now.skin && !name, [
      button('Use', 'Put this skin on as it is: your Customize changes are taken off, your panels stay where they are.', () => void putOn('', { skin: skin.id, look: {}, layout: null })),
    ])
  }

  const foot = el('div', 'sheet-foot')
  foot.append(
    button('Import a theme...', 'Add a theme from a file someone exported', async () => {
      const got = await call('themes:import')

      if (got?.error) {
        alert(got.error)
      }
      void show()
    }),
    button('Import a Winamp skin...', 'Pick a .wsz file: its colours and font become a skin', () => {
      dialog.close()
      document.getElementById('skinImport').click()
    }),
    button('Open my skins folder', 'Where your own skins live. A starter skin is put there the first time.', () => void call('skins:folder')),
  )
  // A skin by its link: the address of its page on the Winamp Skin Museum.
  const byLink = el('div', 'theme-link')
  const linkBox = el('input')
  linkBox.type = 'text'
  linkBox.placeholder = 'Paste the link of a skin on skins.webamp.org'
  linkBox.spellcheck = false
  const linkNote = el('span', 'sheet-note', 'Open a skin on skins.webamp.org, copy its address, paste it here. Its colours and font become a skin.')
  const fetchIt = button('Import from link', 'Download that Winamp skin and put it on', async () => {
    if (linkBox.value.trim() === '') {
      linkBox.focus()

      return
    }
    fetchIt.disabled = true
    linkNote.textContent = 'Downloading...'
    const made = await call('skins:link', linkBox.value)
    fetchIt.disabled = false

    if (made?.id) {
      linkNote.textContent = `Imported "${made.name}". Putting it on...`
      await putOn('', { skin: made.id, look: {}, layout: null })
    } else {
      linkNote.textContent = made?.error ?? 'That did not work.'
    }
  })
  linkBox.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      fetchIt.click()
    }
  })
  const linkRow = el('div', 'theme-link-row')
  linkRow.append(linkBox, fetchIt)
  byLink.append(linkRow, linkNote)
  dialog.replaceChildren(head, nowBox, list, byLink, foot)
}

export const openThemes = async () => {
  await show()

  if (!dialog.open) {
    dialog.showModal()
  }
}
