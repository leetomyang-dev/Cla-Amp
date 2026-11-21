// Watches the public pages whose rules Cla-Amp is built to follow, so a
// change in them is noticed within a day and not found out by accident.
//
//   node tools/policy-watch.mjs            reads each page in policy-watch.json
//                                          and says which changed since it was
//                                          last looked over, and whether each
//                                          sentence Cla-Amp relies on is still
//                                          there. Ends with an error when any
//                                          page changed or a sentence is gone.
//                                          `npm run policy`.
//   node tools/policy-watch.mjs --accept   after you have read the changes and
//                                          docs/compliance.md still holds (or
//                                          has been brought up to date): takes
//                                          today's pages as the ones looked over.
//
// It only says THAT something changed and shows the lines; whether Cla-Amp
// still complies is for a person to decide, with docs/compliance.md beside it.
// The pages' text is kept only in .policy-cache/ on this computer (not in the
// repository): the repository holds a fingerprint of each and the short
// sentences relied on. It reads public pages and sends nothing of yours.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIST = path.join(HERE, 'policy-watch.json')
const CACHE = path.join(HERE, '..', '.policy-cache')
const isAccept = process.argv.includes('--accept')

/** A page as plain text: for a web page, the words without the code around them. */
const plain = (body, address) => {
  let text = body

  if (!address.endsWith('.md') && /<html|<!doctype/i.test(body.slice(0, 2000))) {
    const main = /<main[\s\S]*<\/main\s*>/i.exec(body)?.[0] ?? body
    text = main
      .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, dec, hex, name) =>
        dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–' }[name.toLowerCase()] ?? all),
      )
  }

  return text
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line !== '')
    .join('\n')
}

// Curly and straight quotes, and runs of spaces, are the same sentence.
const loose = text => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[—–]/g, '-').replace(/\s+/g, ' ').toLowerCase()
const print = text => createHash('sha256').update(text).digest('hex').slice(0, 16)
const fileFor = address => path.join(CACHE, address.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_') + '.txt')

const list = JSON.parse(fs.readFileSync(LIST, 'utf8'))
const out = []
let changed = 0
let gone = 0
let failed = 0

for (const page of list.pages) {
  let text

  try {
    const answer = await fetch(page.url, { headers: { 'user-agent': 'policy-watch' }, signal: AbortSignal.timeout(40000), redirect: 'follow' })

    if (!answer.ok) {
      throw new Error(String(answer.status))
    }
    text = plain(await answer.text(), page.url)
  } catch (error) {
    failed += 1
    out.push(`? ${page.name}: could not be read (${error.message}). ${page.url}`)
    continue
  }

  const now = print(text)
  const missing = (page.relies ?? []).filter(sentence => !loose(text).includes(loose(sentence)))
  const isChanged = page.print !== now
  const cache = fileFor(page.url)
  const before = fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8') : null

  if (missing.length > 0) {
    gone += missing.length
    out.push(`! ${page.name}: ${missing.length} of the sentences Cla-Amp relies on ${missing.length === 1 ? 'is' : 'are'} no longer there:`)

    for (const sentence of missing) {
      out.push(`      "${sentence}"`)
    }
  }

  if (isChanged) {
    changed += 1
    out.push(`* ${page.name}: ${page.print ? `changed since ${page.seen}` : 'not looked over yet'}. ${page.url}`)

    // The lines that came and went, when this computer still has the page as it was.
    if (before !== null && page.print) {
      const was = new Set(before.split('\n'))
      const is = new Set(text.split('\n'))
      const added = [...is].filter(line => !was.has(line))
      const removed = [...was].filter(line => !is.has(line))

      for (const line of removed.slice(0, 40)) {
        out.push(`      - ${line.slice(0, 400)}`)
      }

      for (const line of added.slice(0, 40)) {
        out.push(`      + ${line.slice(0, 400)}`)
      }

      if (added.length + removed.length > 80) {
        out.push(`      (${added.length + removed.length - 80} more changed lines)`)
      }
    } else if (page.print) {
      out.push('      (the earlier text is not on this computer, so the changed lines cannot be shown: read the page)')
    }
  } else if (missing.length === 0) {
    out.push(`  ${page.name}: as last looked over (${page.seen}), ${(page.relies ?? []).length} relied-on ${(page.relies ?? []).length === 1 ? 'sentence' : 'sentences'} present`)
  }

  if (isAccept) {
    page.print = now
    page.seen = new Date().toISOString().slice(0, 10)
    fs.mkdirSync(CACHE, { recursive: true })
    fs.writeFileSync(cache, text)
  } else if (before === null && !isChanged) {
    // Kept for the next comparison.
    fs.mkdirSync(CACHE, { recursive: true })
    fs.writeFileSync(cache, text)
  }
}

console.log(out.join('\n'))

if (isAccept) {
  fs.writeFileSync(LIST, JSON.stringify(list, null, 2) + '\n')
  console.log(`\nTaken as looked over today. ${gone > 0 ? 'Sentences are still missing: bring docs/compliance.md and the list up to date.' : ''}`)
  process.exit(gone > 0 || failed > 0 ? 1 : 0)
}

if (changed > 0 || gone > 0 || failed > 0) {
  console.log(`\n${changed} changed, ${gone} relied-on ${gone === 1 ? 'sentence' : 'sentences'} gone, ${failed} unreadable. Read the changes against docs/compliance.md, then run: node tools/policy-watch.mjs --accept`)
  process.exit(1)
}
console.log('\nNothing changed.')
