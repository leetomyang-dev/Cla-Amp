// "Settings": what Claude Code itself can tell about the account and its
// settings, read through the main process. Nothing here is changed from this
// page: each settings file has a button that opens it in a text editor.
// What lives on claude.ai (profile, billing, devices, privacy) is behind the
// web sign-in, which Cla-Amp never holds; a button opens that page in the
// browser instead.

const call = (name, ...args) => window.amp.call(name, ...args)
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text

  return node
}

const dialog = el('dialog', 'sheet settings-sheet')
document.body.append(dialog)

const part = (title, ...children) => {
  const box = el('section', 'about-part')
  box.append(el('h3', '', title), ...children)

  return box
}

const fact = (name, value) => {
  const row = el('div', 'set-row')
  row.append(el('span', 'look-name', name), el('span', 'set-value', value || 'not set'))

  return row
}

const list = (name, items) => {
  const row = el('div', 'set-row tall')
  const box = el('div', 'set-list')

  for (const item of items) {
    box.append(el('code', '', item))
  }
  row.append(el('span', 'look-name', `${name} (${items.length})`), box)

  return row
}

/** One settings file: where it is, what it sets, a button to open it. */
const fileBox = (one, projectId) => {
  const box = el('div', 'set-file')
  const head = el('div', 'set-file-head')
  const open = el('button', 'pill', one.exists ? 'Open in editor' : 'No such file yet')
  open.disabled = !one.exists
  open.title = 'Opens this file in your text editor. Claude Code reads it again on the next message.'
  open.addEventListener('click', () => void call('settings:open', one.which, projectId))
  head.append(el('b', '', one.label), el('span', 'grow'), open)
  box.append(head, el('div', 'sheet-note set-path', one.file))

  if (!one.exists) {
    return box
  }

  const said = one.summary

  if (said.error) {
    box.append(el('div', 'sheet-note', said.error))

    return box
  }

  if (said.model) {
    box.append(fact('Model', said.model))
  }

  if (said.defaultMode) {
    box.append(fact('Permission mode', said.defaultMode))
  }

  for (const [name, items] of [
    ['Always allowed', said.allow],
    ['Asked each time', said.ask],
    ['Never allowed', said.deny],
    ['Hooks', said.hooks],
    ['Environment variables (names only)', said.env],
    ['Plugins switched on', said.plugins],
    ['Other settings', said.other],
  ]) {
    if (items.length > 0) {
      box.append(list(name, items))
    }
  }

  if (box.children.length === 2) {
    box.append(el('div', 'sheet-note', 'The file is there but sets nothing.'))
  }

  return box
}

/** Opens Settings for the project that is on show (its own settings files are listed too). */
export const openSettings = async (projectId, hooks = {}) => {
  dialog.replaceChildren(el('h2', '', 'Settings'), el('p', 'sheet-note', 'Reading…'))

  if (!dialog.open) {
    dialog.showModal()
  }

  const read = (await call('settings:read', projectId)) ?? {}
  const account = read.account ?? {}
  const web = el('button', 'pill', 'Open claude.ai settings in my browser')
  web.title = 'Profile, billing, where you are logged in, privacy and notifications are on claude.ai, behind your own sign-in there'
  web.addEventListener('click', () => void call('settings:web'))
  const data = el('button', 'pill', 'Open Cla-Amp’s data folder')
  data.title = 'Where Cla-Amp keeps its own things: skins, pictures, chats it shows, the player’s browser profile'
  data.addEventListener('click', () => void call('settings:open', 'data', projectId))
  const shortcuts = el('div', 'sheet-foot')

  for (const [label, run] of [
    ['Customize the look', hooks.look],
    ['Guides', hooks.guides],
    ['About', hooks.about],
  ]) {
    if (run) {
      const button = el('button', 'pill', label)
      button.addEventListener('click', () => {
        dialog.close()
        run()
      })
      shortcuts.append(button)
    }
  }
  shortcuts.append(data)

  const foot = el('div', 'sheet-foot')
  const close = el('button', 'pill go', 'Close')
  close.addEventListener('click', () => dialog.close())
  foot.append(el('span', 'grow'), close)

  dialog.replaceChildren(
    el('h2', '', 'Settings'),
    part(
      'Account',
      fact('Signed in', account.isSignedIn ? 'Yes, through Claude Code' : 'No'),
      ...(account.isSignedIn ? [fact('Email', account.email), fact('Organization', account.organization), fact('Plan', account.plan), fact('Sign-in kind', account.method)] : []),
      el('p', 'sheet-note', 'Usage limits are in the Usage limits panel on the right; the model and effort are in the Model panel.'),
    ),
    part(
      'Claude Code settings',
      el('p', 'sheet-note', 'Claude Code reads these files, most specific last. This page only shows them: to change one, open it. A project’s own files count only for a folder you said you trust.'),
      ...(read.files ?? []).map(one => fileBox(one, projectId)),
    ),
    part(
      'On claude.ai',
      el('p', 'sheet-note', 'Profile, billing, where you are logged in, privacy, notifications and what Claude should call you are kept on claude.ai. Cla-Amp never holds your web sign-in, so it cannot show or change them.'),
      web,
    ),
    part('Cla-Amp itself', shortcuts),
    foot,
  )
}
