// Reads docs/whats-new.md: the notes on what changed, written for the people
// who use Cla-Amp. "Check for updates" compares the page on GitHub with the
// one in this folder and shows the notes this copy does not have yet.

// A note is shown as plain text: no control characters, no markdown marks, and short.
// eslint-disable-next-line no-control-regex
const plain = text => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()

/** The page as [{ when, notes: [text] }], newest first as written. */
export const readNotes = page => {
  const found = []
  let now = null

  for (const line of String(page).split(/\r?\n/)) {
    const head = /^##\s+(.+)$/.exec(line)
    const note = /^\s*[-*]\s+(.+)$/.exec(line)

    if (head) {
      now = { when: plain(head[1]).slice(0, 40), notes: [] }
      found.push(now)
    } else if (note && now) {
      now.notes.push(plain(note[1]).slice(0, 400))
    }
  }

  return found.filter(one => one.notes.length > 0)
}

/** The notes in `theirs` that `mine` does not have, kept under their dates, at most `most` notes. */
export const notesNewTo = (theirs, mine, most = 12) => {
  const have = new Set(readNotes(mine).flatMap(one => one.notes))
  const out = []
  let left = most
  let more = 0

  for (const one of readNotes(theirs)) {
    const fresh = one.notes.filter(note => !have.has(note))

    if (fresh.length > 0 && left > 0) {
      out.push({ when: one.when, notes: fresh.slice(0, left) })
    }
    more += Math.max(0, fresh.length - Math.max(left, 0))
    left -= fresh.length
  }

  return { groups: out, more }
}
