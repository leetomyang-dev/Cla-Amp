// The basic buttons keep their places in every skin.
//
// A skin colours and shapes the buttons of the title bar, the button row and
// the message box, and may bring its own typeface. It does not move them:
// - their heights, gaps and edges are fixed by the rules at the end of
//   styles.css ("The basic buttons keep their places")
// - the width of each button with words on it is fixed here. It is what the
//   words need in the window's standard typeface plus some room, so a skin
//   with a wider typeface still fits, and one whose words are wider than
//   that gets them a little smaller instead of a wider button.
// What a person changes themselves (the language, Size, the Text choice in
// Widgets, Big buttons, Arrange) does move things: that is theirs to do.

/** The buttons whose width follows their words. */
const WORDED = '.titlebar .chrome-btn.wide, .titlebar select, .transport .deck-btn, .composer-row .chip-btn'
// The window's standard typeface: what the widths are worked out in.
const STANDARD = "'Segoe UI', system-ui, sans-serif"
// How much room the words get, against what they need in the standard typeface.
const ROOM = 1.15
// Words that do not fit get smaller, down to this share of their size.
const LEAST = 0.7

/** Whether the person chose the big picture buttons for the button row. */
export const isBig = () => localStorage.getItem('bigButtons') === '1'

export const setBig = isOn => {
  if (isOn) {
    localStorage.setItem('bigButtons', '1')
  } else {
    localStorage.removeItem('bigButtons')
  }
  document.body.classList.toggle('has-toolbar', isOn)
  fit()
}

// The widest a button has been in the standard typeface, so one whose words
// change as it is used ("Stay awake", "Staying awake") moves its neighbours once at most.
const widest = new Map()

const fitOne = node => {
  const style = node.style

  style.width = ''
  style.fontSize = ''

  if (node.getClientRects().length === 0) {
    return
  }

  style.fontFamily = STANDARD
  style.letterSpacing = 'normal'
  style.textTransform = 'none'
  style.fontWeight = node.matches('.chrome-btn, select') ? '400' : '600'
  // Small and big buttons each have their own widest.
  const key = node.id ? `${node.id} ${document.body.classList.contains('has-toolbar')}` : ''
  const look = getComputedStyle(node)
  const plain = node.getBoundingClientRect().width
  const edges = parseFloat(look.paddingLeft) + parseFloat(look.paddingRight) + parseFloat(look.borderLeftWidth) + parseFloat(look.borderRightWidth)
  const room = Math.max(Math.ceil(plain + Math.max(0, plain - edges) * (ROOM - 1)), widest.get(key) ?? 0)
  style.fontFamily = ''
  style.letterSpacing = ''
  style.textTransform = ''
  style.fontWeight = ''

  if (key) {
    widest.set(key, room)
  }

  // A list keeps its words' size: it cuts what does not fit, as lists do.
  if (!node.matches('select')) {
    // In the skin's own typeface now: words too wide for the room get smaller.
    let size = parseFloat(look.fontSize)
    const least = size * LEAST

    while (node.getBoundingClientRect().width > room + 0.5 && size > least) {
      size -= 0.5
      style.fontSize = `${size}px`
    }
  }
  style.width = `${room}px`
}

let isWaiting = false
let isFitting = false

/** Works the widths out again. Called by itself whenever a skin, a typeface or a button's words change. */
export const fit = () => {
  if (isWaiting) {
    return
  }
  isWaiting = true
  requestAnimationFrame(() => {
    isWaiting = false
    isFitting = true
    document.querySelectorAll(WORDED).forEach(fitOne)
    // What was just written here is not a change to answer.
    watch.takeRecords()
    isFitting = false
  })
}

const watch = new MutationObserver(() => {
  if (!isFitting) {
    fit()
  }
})

document.body.classList.toggle('has-toolbar', isBig())

for (const row of document.querySelectorAll('.titlebar, .transport, .composer-row')) {
  // Words that change (another language, a state), and buttons that come and go.
  watch.observe(row, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] })
}
// A skin put on or changed, and the Customize choices, which sit on the page itself.
watch.observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] })
watch.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
document.addEventListener('load', event => event.target instanceof HTMLLinkElement && fit(), true)
document.addEventListener('size-changed', fit)
void document.fonts.ready.then(fit)
document.fonts.addEventListener('loadingdone', fit)
fit()
