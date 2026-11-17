// The calendar widget's optional extras: due dates for a day (on their own
// or tied to a chat) and a report for each day, kept on this computer so a
// day can be looked up later. Nothing here is needed to use the calendar:
// a person who never clicks a day sees only the month.

const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text

  return node
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const two = number => String(number).padStart(2, '0')

/** A day as the text it is kept under: "2026-11-16", in the computer's own time. */
export const dayKey = date => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
const dayOf = key => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
const dayName = key => {
  const date = dayOf(key)

  return `${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`
}

/**
 * What is kept: `due` (each { id, date, text, chat: { id, title, cwd } or
 * null, isDone }) and `days` (date to { note, chats, prompts, titles }).
 */
let book = null

const read = () => {
  if (book === null) {
    try {
      const saved = JSON.parse(localStorage.getItem('calendar') ?? '{}')
      book = { due: Array.isArray(saved.due) ? saved.due : [], days: saved.days && typeof saved.days === 'object' ? saved.days : {} }
    } catch {
      book = { due: [], days: {} }
    }
  }

  return book
}

const save = () => {
  localStorage.setItem('calendar', JSON.stringify(read()))
  onChange()
}

// Set by the window: draws the month again after a change.
let onChange = () => {}

/** The day's numbers, kept as the day goes so the report is there afterwards. */
export const noteToday = stats => {
  if (typeof stats?.chats !== 'number') {
    return
  }

  const key = dayKey(new Date())
  const day = (read().days[key] ??= {})
  const titles = Array.isArray(stats.titles) ? stats.titles.slice(0, 40) : (day.titles ?? [])

  const spend = stats.spend && typeof stats.spend === 'object' ? stats.spend : (day.spend ?? null)

  if (day.chats !== stats.chats || day.prompts !== stats.prompts || JSON.stringify(day.titles ?? []) !== JSON.stringify(titles) || JSON.stringify(day.spend ?? null) !== JSON.stringify(spend)) {
    Object.assign(day, { chats: stats.chats, prompts: stats.prompts ?? 0, titles, ...(spend ? { spend } : {}) })
    localStorage.setItem('calendar', JSON.stringify(read()))
  }
}

/**
 * Keeps the highest a meter reached today: 'contextPeak' (how full a chat's
 * context got) or 'planUsed' (how much of the week's plan limit was used).
 */
export const notePeak = (what, percent) => {
  const value = Math.round(Number(percent))

  if (!['contextPeak', 'planUsed'].includes(what) || !(value > 0) || value > 100) {
    return
  }

  const day = (read().days[dayKey(new Date())] ??= {})

  if (!(day[what] >= value)) {
    day[what] = value
    localStorage.setItem('calendar', JSON.stringify(read()))
  }
}

const count = number => (number >= 1e9 ? `${(number / 1e9).toFixed(2)} billion` : number >= 1e6 ? `${(number / 1e6).toFixed(1)} million` : number >= 1e3 ? `${Math.round(number / 1e3)} thousand` : String(Math.round(number)))

/** The day's usage in plain lines: tokens, what they would cost, and how full the meters got. */
const usageLines = day => {
  const lines = []
  const spend = day.spend

  if (spend && (spend.input || spend.output || spend.cacheRead || spend.cacheWrite)) {
    const fresh = (spend.input ?? 0) + (spend.output ?? 0) + (spend.cacheWrite ?? 0)
    lines.push(`Tokens in Cla-Amp: ${count(fresh)} new (${count(spend.output ?? 0)} written by Claude), plus ${count(spend.cacheRead ?? 0)} re-read from cache.`)
    lines.push(`Cost at API prices: $${(spend.cost ?? 0).toFixed(2)} over ${spend.turns ?? 0} ${spend.turns === 1 ? 'turn' : 'turns'}. A plan is not billed this way.`)
  }

  if (day.contextPeak > 0) {
    lines.push(`Fullest a chat's context got: ${day.contextPeak}%.`)
  }

  if (day.planUsed > 0) {
    lines.push(`Week's plan limit used by the end of the day: ${day.planUsed}%.`)
  }

  return lines
}

const dueOn = key => read().due.filter(one => one.date === key)
const isLate = (one, today) => !one.isDone && one.date < today

/** The words of a day's report, for the message box or the clipboard. */
export const reportText = key => {
  const day = read().days[key] ?? {}
  const lines = [`Report for ${dayName(key)}`]

  if (typeof day.chats === 'number') {
    lines.push(`Chats worked on: ${day.chats}. Messages sent: ${day.prompts ?? 0}.`)
  }

  lines.push(...usageLines(day))

  if ((day.titles ?? []).length > 0) {
    lines.push('Chats:', ...day.titles.map(title => `- ${title}`))
  }
  const due = dueOn(key)

  if (due.length > 0) {
    lines.push('Due:', ...due.map(one => `- [${one.isDone ? 'x' : ' '}] ${one.text}${one.chat ? ` (chat: ${one.chat.title})` : ''}`))
  }

  if (day.note) {
    lines.push('Notes:', day.note)
  }

  return lines.join('\n')
}

// ------------------------------------------------------------------ the month

// The month in view: 0 is this month, -1 the one before.
let monthShift = 0

/**
 * Draws the month into the widget. `hooks`: { chatNow() for the chat in
 * view, openChat(chat), quote(text) }.
 */
export const drawCalendar = (parts, now, hooks) => {
  onChange = () => drawCalendar(parts, new Date(), hooks)
  const today = dayKey(now)
  const shown = new Date(now.getFullYear(), now.getMonth() + monthShift, 1)
  const first = shown.getDay()
  const days = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate()
  const turn = (label, by, title) => {
    const button = el('button', 'cal-turn', label)
    button.type = 'button'
    button.title = title
    button.addEventListener('click', () => {
      monthShift = by === 0 ? 0 : monthShift + by
      drawCalendar(parts, new Date(), hooks)
    })

    return button
  }
  const name = el('span', 'cal-name', `${MONTHS[shown.getMonth()]} ${shown.getFullYear()}`)
  parts.month.replaceChildren(turn('‹', -1, 'The month before'), name, turn('›', 1, 'The month after'))

  if (monthShift !== 0) {
    parts.month.append(turn('Today', 0, 'Back to this month'))
  }

  const cells = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => el('i', '', day))

  for (let at = 0; at < first; at += 1) {
    cells.push(el('span', 'blank', ''))
  }

  for (let day = 1; day <= days; day += 1) {
    const key = dayKey(new Date(shown.getFullYear(), shown.getMonth(), day))
    const weekday = (first + day - 1) % 7
    const due = dueOn(key)
    const kept = read().days[key]
    const kinds = [key === today ? 'today' : key < today ? 'past' : '', weekday === 0 || weekday === 6 ? 'weekend' : '']

    if (due.some(one => !one.isDone)) {
      kinds.push(due.some(one => isLate(one, today)) ? 'has-late' : 'has-due')
    } else if (due.length > 0) {
      kinds.push('has-done')
    }

    if (kept?.note || typeof kept?.chats === 'number') {
      kinds.push('has-report')
    }

    const cell = el('span', kinds.filter(Boolean).join(' '), String(day))
    cell.tabIndex = 0
    cell.setAttribute('role', 'button')
    cell.title = [dayName(key), ...due.map(one => `${one.isDone ? 'Done' : 'Due'}: ${one.text}`), kept?.note ? 'Has notes' : '', 'Click for due dates and the day\'s report'].filter(Boolean).join('\n')
    cell.addEventListener('click', () => openDay(key, hooks))
    cell.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openDay(key, hooks)
      }
    })
    cells.push(cell)
  }

  while ((cells.length - 7) % 7 !== 0) {
    cells.push(el('span', 'blank', ''))
  }
  parts.grid.replaceChildren(...cells)

  // What is due next, and what is overdue: the three nearest.
  const open = read().due.filter(one => !one.isDone).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3)
  parts.next.replaceChildren(
    ...open.map(one => {
      const row = el('button', `cal-next${isLate(one, today) ? ' late' : ''}`)
      const left = Math.round((dayOf(one.date) - dayOf(today)) / 86400000)
      row.type = 'button'
      row.title = `${dayName(one.date)}${one.chat ? `\nChat: ${one.chat.title}` : ''}\nClick to open the day`
      row.append(el('b', '', left === 0 ? 'Today' : left === 1 ? 'Tomorrow' : left < 0 ? `${-left}d late` : `In ${left}d`), el('span', '', one.text))
      row.addEventListener('click', () => openDay(one.date, hooks))

      return row
    }),
  )
}

// -------------------------------------------------------------------- one day

const sheet = el('dialog', 'sheet day-sheet')
document.body.append(sheet)
sheet.addEventListener('click', event => {
  if (event.target === sheet) {
    sheet.close()
  }
})

export const openDay = (key, hooks) => {
  const today = dayKey(new Date())
  const draw = () => {
    const day = read().days[key] ?? {}
    const list = el('div', 'day-due')

    for (const one of dueOn(key)) {
      const row = el('div', `day-row${one.isDone ? ' done' : isLate(one, today) ? ' late' : ''}`)
      const tick = el('input')
      tick.type = 'checkbox'
      tick.checked = one.isDone === true
      tick.title = 'Done'
      tick.addEventListener('change', () => {
        one.isDone = tick.checked
        save()
        draw()
      })
      const words = el('span', 'day-text', one.text)
      const off = el('button', 'day-x', '✕')
      off.type = 'button'
      off.title = 'Remove this due date'
      off.addEventListener('click', () => {
        read().due = read().due.filter(other => other !== one)
        save()
        draw()
      })
      row.append(tick, words)

      if (one.chat) {
        const link = el('button', 'day-chat', one.chat.title)
        link.type = 'button'
        link.title = 'Open this chat'
        link.addEventListener('click', () => {
          sheet.close()
          hooks.openChat(one.chat)
        })
        row.append(link)
      }
      row.append(off)
      list.append(row)
    }

    if (list.children.length === 0) {
      list.append(el('p', 'sheet-note', 'Nothing is due on this day.'))
    }

    // Adding one: its words, and whether it belongs to the chat in view.
    const add = el('form', 'day-add')
    const what = el('input')
    what.type = 'text'
    what.placeholder = 'What is due on this day?'
    what.maxLength = 200
    const chat = hooks.chatNow()
    const tie = el('label', 'day-tie')
    const tieBox = el('input')
    tieBox.type = 'checkbox'
    tie.append(tieBox, el('span', '', chat ? `For the chat in view: ${chat.title}` : 'No chat is open to tie it to'))
    tieBox.disabled = !chat
    const go = el('button', 'pill go', 'Add')
    go.type = 'submit'
    add.append(what, go, tie)
    add.addEventListener('submit', event => {
      event.preventDefault()
      const text = what.value.trim()

      if (text !== '') {
        read().due.push({ id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`, date: key, text, chat: tieBox.checked && chat ? chat : null, isDone: false })
        save()
        draw()
        sheet.querySelector('.day-add input[type=text]')?.focus()
      }
    })

    // The report: the day's numbers as they were kept, the chats, and the person's own notes.
    const report = el('div', 'day-report')

    if (typeof day.chats === 'number') {
      report.append(el('p', '', `Chats worked on: ${day.chats}. Messages you sent: ${day.prompts ?? 0}.`))
    } else {
      report.append(el('p', 'sheet-note', key > today ? 'This day has not come yet.' : key === today ? 'Today\'s numbers appear here within a minute.' : 'No numbers were kept for this day: Cla-Amp keeps them from the day this was added, on days it is open.'))
    }

    for (const line of usageLines(day)) {
      report.append(el('p', '', line))
    }

    if ((day.titles ?? []).length > 0) {
      const chats = el('ul', 'day-chats')
      chats.append(...day.titles.map(title => el('li', '', title)))
      report.append(chats)
    }

    const note = el('textarea')
    note.rows = 4
    note.placeholder = 'Your own notes for this day: what got done, what is next.'
    note.value = day.note ?? ''
    note.addEventListener('input', () => {
      const kept = (read().days[key] ??= {})
      kept.note = note.value
      localStorage.setItem('calendar', JSON.stringify(read()))
    })
    note.addEventListener('change', () => onChange())
    report.append(note)

    const foot = el('div', 'sheet-foot')
    const toChat = el('button', 'pill', 'Put the report in my message')
    toChat.type = 'button'
    toChat.title = 'Adds this day\'s report to the message box as a quote, so Claude can read it'
    toChat.addEventListener('click', () => {
      sheet.close()
      hooks.quote(reportText(key))
    })
    const close = el('button', 'pill go', 'Close')
    close.type = 'button'
    close.addEventListener('click', () => sheet.close())
    foot.append(toChat, el('span', 'grow'), close)

    sheet.replaceChildren(el('h2', '', dayName(key)), el('h3', '', 'Due dates'), list, add, el('h3', '', 'Report'), report, foot)
  }

  draw()

  if (!sheet.open) {
    sheet.showModal()
  }
}
