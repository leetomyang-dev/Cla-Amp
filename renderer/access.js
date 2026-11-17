// What makes the window usable without a mouse, without sharp eyes, without
// sight, or by someone whom movement on screen troubles:
// - Calm: nothing moves by itself (follows Windows' "animation effects"
//   setting until the person chooses)
// - the size of everything in the window (Ctrl + plus, minus and 0)
// - words spoken by a screen reader when something happens (announce)
// - Enter and Space press whatever can be clicked; tabs and switches say
//   what they are and whether they are on
// The rules that go with it are at the end of styles.css.

const stillWanted = window.matchMedia('(prefers-reduced-motion: reduce)')

/** The person's own choice for Calm: 'on', 'off', or '' to follow Windows. */
export const calmChoice = () => ({ 1: 'on', 0: 'off' })[localStorage.getItem('calm')] ?? ''

/** Whether the window keeps still: no moving spectrum, glow, sliding title or blinking. */
export const isCalm = () => (calmChoice() ? calmChoice() === 'on' : stillWanted.matches)

const putCalm = () => document.body.classList.toggle('calm', isCalm())

export const setCalm = choice => {
  if (choice) {
    localStorage.setItem('calm', choice === 'on' ? '1' : '0')
  } else {
    localStorage.removeItem('calm')
  }
  putCalm()
}

stillWanted.addEventListener('change', putCalm)
putCalm()

// ---- size ----

export const SIZES = [80, 90, 100, 110, 125, 150, 175, 200]

/** The size of everything in the window, in percent. */
export const sizeNow = () => {
  const kept = Number(localStorage.getItem('zoom'))

  return SIZES.includes(kept) ? kept : 100
}

/** Sets the size and keeps it. The main process scales the whole page, as a browser's zoom does. */
export const setSize = percent => {
  const size = SIZES.includes(percent) ? percent : 100
  localStorage.setItem('zoom', String(size))
  // An older main process (before a restart) does not know this call: the size then waits for the restart.
  void window.amp.call('zoom:set', size / 100).catch(() => {})
  announce(`Size ${size} percent`)
  document.dispatchEvent(new CustomEvent('size-changed'))
}

if (sizeNow() !== 100) {
  void window.amp.call('zoom:set', sizeNow() / 100).catch(() => {})
}

document.addEventListener('keydown', event => {
  if (!event.ctrlKey || event.altKey || event.metaKey) {
    return
  }

  const at = SIZES.indexOf(sizeNow())

  if (event.key === '=' || event.key === '+') {
    event.preventDefault()
    setSize(SIZES[Math.min(SIZES.length - 1, at + 1)])
  } else if (event.key === '-' || event.key === '_') {
    event.preventDefault()
    setSize(SIZES[Math.max(0, at - 1)])
  } else if (event.key === '0') {
    event.preventDefault()
    setSize(100)
  }
})

// ---- spoken words ----

const makeVoice = manner => {
  const box = document.createElement('div')
  box.className = 'sr-only'
  box.setAttribute('aria-live', manner)
  box.setAttribute('aria-atomic', 'true')
  box.setAttribute('role', manner === 'assertive' ? 'alert' : 'status')
  document.body.append(box)

  return box
}

const voices = { polite: makeVoice('polite'), assertive: makeVoice('assertive') }

/**
 * Has a screen reader say something that happened and that shows only as a
 * change on screen: a reply finished, Claude asks to use a tool. `isNow`
 * breaks in on what is being read; keep it for what needs an answer.
 */
export const announce = (text, isNow = false) => {
  const box = voices[isNow ? 'assertive' : 'polite']
  // The same words twice in a row are only read when the box was emptied in between.
  box.textContent = ''
  setTimeout(() => (box.textContent = String(text).replace(/\s+/g, ' ').slice(0, 400)), 60)
}

// ---- keys ----

// Whether the person is using the keyboard right now (a key was the last thing pressed) or the mouse.
let isByKeys = false
document.addEventListener('keydown', () => (isByKeys = true), true)
document.addEventListener('pointerdown', () => (isByKeys = false), true)

/** Makes something that is clicked, and is not a button, reachable with Tab and pressed with Enter or Space. */
export const asKey = (node, role = 'button') => {
  node.tabIndex = 0
  node.setAttribute('role', role)

  return node
}

document.addEventListener('keydown', event => {
  const node = event.target

  // A thing that handles the key itself has already been pressed: once is enough.
  if ((event.key !== 'Enter' && event.key !== ' ') || event.ctrlKey || event.altKey || event.defaultPrevented || !(node instanceof HTMLElement)) {
    return
  }

  // Only what was made pressable here; a real button, link or field handles its own keys.
  if (node.matches('[role="button"], [role="tab"][tabindex], [role="row"][tabindex]') && !node.matches('button, a[href], input, select, textarea, summary')) {
    event.preventDefault()
    node.click()
  }
})

// Shift+F10 and the menu key open the right-click menu of what has the focus, at that thing.
document.addEventListener('keydown', event => {
  if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) {
    return
  }

  const node = document.activeElement

  // A box to type in keeps Windows' own menu (cut, copy, paste).
  if (node instanceof HTMLElement && node !== document.body && !node.matches('input, textarea')) {
    const at = node.getBoundingClientRect()
    event.preventDefault()
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(at.left + Math.min(24, at.width / 2)), clientY: Math.round(at.top + Math.min(16, at.height / 2)) }))
  }
})

// ---- what things are, and whether they are on ----

const SWITCHES = '#shuffleSongs, #repeatSong, #topShuffle, #topRepeat, #mic, .lvl'
const TABS = '.tab, .seg-btn'

const putState = node => {
  if (node.matches(SWITCHES)) {
    node.setAttribute('aria-pressed', String(node.classList.contains('on') || node.classList.contains('active')))
  } else if (node.matches(TABS)) {
    node.setAttribute('role', 'tab')
    node.setAttribute('aria-selected', String(node.classList.contains('active')))
    node.parentElement?.setAttribute('role', 'tablist')
  } else if (node.matches('.panel > h3')) {
    node.setAttribute('aria-expanded', String(!node.parentElement.classList.contains('closed')))
  } else if (node.matches('.panel')) {
    node.querySelector(':scope > h3')?.setAttribute('aria-expanded', String(!node.classList.contains('closed')))
  }
}

const KNOWN = `${SWITCHES}, ${TABS}, .panel > h3, .panel`

const putStates = root => {
  if (root.nodeType !== Node.ELEMENT_NODE) {
    return
  }

  if (root.matches(KNOWN)) {
    putState(root)
  }
  root.querySelectorAll(KNOWN).forEach(putState)
  // Drawings that only decorate, and close buttons that show only a cross.
  root.querySelectorAll('canvas:not([aria-hidden])').forEach(one => one.setAttribute('aria-hidden', 'true'))
}

putStates(document.body)
new MutationObserver(changes => {
  for (const change of changes) {
    if (change.type === 'attributes') {
      if (change.target.matches(KNOWN)) {
        putState(change.target)
      }
    } else {
      change.addedNodes.forEach(putStates)
    }
  }
}).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })

// ---- the right-click menu, by keyboard ----

// A menu that opens takes the focus; the arrows move in it; when it closes the focus goes back.
new MutationObserver(changes => {
  for (const change of changes) {
    for (const node of change.addedNodes) {
      if (node instanceof HTMLElement && node.matches('.wg-menu.ctx')) {
        const before = document.activeElement
        node.setAttribute('role', 'menu')
        const rows = [...node.querySelectorAll('button')]
        rows.forEach(one => one.setAttribute('role', 'menuitem'))
        // Opened with the mouse, the menu leaves the focus where it was.
        if (isByKeys) {
          rows[0]?.focus()
        }
        node.addEventListener('keydown', event => {
          const at = rows.indexOf(document.activeElement)

          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            rows[(at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus()
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            rows[event.key === 'Home' ? 0 : rows.length - 1]?.focus()
          } else if (event.key === 'Tab') {
            // Tab would walk out of the menu and leave it open.
            event.preventDefault()
          }
        })
        new MutationObserver((_seen, watch) => {
          if (!node.isConnected) {
            watch.disconnect()

            if (before instanceof HTMLElement && before.isConnected && (document.activeElement === document.body || document.activeElement === null)) {
              before.focus()
            }
          }
        }).observe(document.body, { childList: true })
      }
    }
  }
}).observe(document.body, { childList: true })
