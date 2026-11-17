/**
 * Reading files without a gap between looking and reading.
 *
 * Asking a file's size by its path and then reading it by its path leaves a
 * moment in which the file can be swapped for another one. These open the file
 * once and ask the size of what was opened, so what is measured is what is read.
 */

import fs from 'node:fs'

/** The whole file, or null when it is larger than `most` bytes. Throws when it cannot be opened. */
export const readCapped = (file, most) => {
  const handle = fs.openSync(file, 'r')

  try {
    return fs.fstatSync(handle).size > most ? null : fs.readFileSync(handle)
  } finally {
    fs.closeSync(handle)
  }
}

/** The same, without holding the program up. */
export const readCappedLater = async (file, most) => {
  const handle = await fs.promises.open(file, 'r')

  try {
    return (await handle.stat()).size > most ? null : await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** The last `most` bytes of a file (all of it when it is shorter). */
export const readTail = (file, most) => {
  const handle = fs.openSync(file, 'r')

  try {
    const size = fs.fstatSync(handle).size
    const bytes = Buffer.alloc(Math.min(size, most))
    fs.readSync(handle, bytes, 0, bytes.length, size - bytes.length)

    return bytes
  } finally {
    fs.closeSync(handle)
  }
}

/** The file's size and, when it is no larger than `most` and `isWanted`, its bytes; all from one opening. */
export const sizeAndBytes = (file, most, isWanted = true) => {
  const handle = fs.openSync(file, 'r')

  try {
    const size = fs.fstatSync(handle).size

    return { size, bytes: isWanted && size <= most ? fs.readFileSync(handle) : null }
  } finally {
    fs.closeSync(handle)
  }
}
