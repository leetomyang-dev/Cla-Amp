// Which account a saved chat was made with, for the account filter over the
// Projects and Code lists. Claude Code writes the account's organisation id
// into a chat's own file (`organizationUuid`); this reads it back. Nothing
// else of the chat is looked at, and nothing is written to Claude Code's files.

import fs from 'node:fs'
import path from 'node:path'

const HEAD = 512 * 1024
const TAIL = 256 * 1024
const STEP = 4 * 1024 * 1024
const MARK = /"organizationUuid"\s*:\s*"([0-9a-fA-F-]{8,64})"/

/** The organisation id named in a piece of a chat's file, or ''. */
export const ownerIn = text => MARK.exec(text)?.[1].toLowerCase() ?? ''

/** The organisation id in one chat file: looked for at its start, then at its end, then all through it. { size, org }. */
export const ownerOfFile = async file => {
  const handle = await fs.promises.open(file, 'r')

  try {
    const { size } = await handle.stat()
    const piece = async (from, length) => {
      const bytes = Buffer.alloc(length)
      const { bytesRead } = await handle.read(bytes, 0, length, from)

      return bytes.subarray(0, bytesRead).toString('utf8')
    }
    let org = ownerIn(await piece(0, Math.min(size, HEAD)))

    if (org === '' && size > HEAD) {
      org = ownerIn(await piece(Math.max(HEAD, size - TAIL), Math.min(TAIL, size - HEAD)))
    }

    // A long chat can name it only somewhere in the middle. Read through in
    // pieces, each started a little before the last one ended so that a mark
    // lying across two pieces is still seen. Done once: the answer is kept.
    for (let from = HEAD - 256; org === '' && from < size - TAIL; from += STEP - 256) {
      org = ownerIn(await piece(from, STEP))
    }

    return { size, org }
  } finally {
    await handle.close()
  }
}

/**
 * The owner of every chat under Claude Code's projects folder: Map of chat id
 * to organisation id ('' when its file names none). `known` is what earlier
 * looks found, { id: { size, org } }: a chat already matched is not read
 * again, and one without a match is read again only when its file has grown.
 * `known` is brought up to date in place; returns { owners, isChanged }.
 */
export const ownersOnDisk = async (projectsDir, known = {}) => {
  const owners = new Map()
  let isChanged = false
  let folders = []

  try {
    folders = (await fs.promises.readdir(projectsDir, { withFileTypes: true })).filter(one => one.isDirectory())
  } catch {
    return { owners, isChanged }
  }

  for (const folder of folders) {
    let files = []

    try {
      files = await fs.promises.readdir(path.join(projectsDir, folder.name), { withFileTypes: true })
    } catch {
      continue
    }

    for (const one of files) {
      const id = /^([0-9a-f-]{16,64})\.jsonl$/i.exec(one.name)?.[1]

      if (!id || !one.isFile()) {
        continue
      }

      const had = Object.hasOwn(known, id) ? known[id] : null

      if (had?.org) {
        owners.set(id, had.org)
        continue
      }

      try {
        const file = path.join(projectsDir, folder.name, one.name)

        // No owner found before: worth another look only if the file has grown.
        if (had && (await fs.promises.stat(file)).size === had.size) {
          owners.set(id, '')
          continue
        }

        const now = await ownerOfFile(file)
        known[id] = now
        isChanged = true
        owners.set(id, now.org)
      } catch {
        owners.set(id, '')
      }
    }
  }

  return { owners, isChanged }
}
