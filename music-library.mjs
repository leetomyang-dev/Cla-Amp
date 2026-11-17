// The music deck's library: finds audio files in the person's music folders,
// reads each song's title, artist, album, genre, number and length, and reads
// playlist files.
//
// Song files and playlists can come from anywhere, so they are read with care:
// only a capped slice of each file is looked at, every length is checked
// against what was read, and nothing in a tag is ever run or used as a path.
import fs from 'node:fs'
import path from 'node:path'

export const AUDIO = /\.(mp3|wav|m4a|wma|flac|aac)$/i
const MAX_SONGS = 5000
const MAX_TAG = 512 * 1024
const MAX_PLAYLIST = 2 * 1024 * 1024

// The numbered genres of the first tag format, which newer tags still point at as "(17)".
const GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age',
  'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska',
  'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion',
  'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'AlternRock',
  'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic',
  'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy',
  'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave',
  'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro',
  'Musical', 'Rock & Roll', 'Hard Rock',
]

/** Tag text made safe to show: no control characters, trimmed, capped. */
const tidy = text =>
  String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 200)

const genreName = text => {
  const found = /^\(?(\d{1,3})\)?$/.exec(text)

  return found ? (GENRES[Number(found[1])] ?? '') : text.replace(/^\(\d{1,3}\)/, '')
}

/** The text of one ID3 frame: a byte saying how it is encoded, then the words. */
const frameText = bytes => {
  if (bytes.length < 2) {
    return ''
  }

  const body = bytes.subarray(1)
  let text = ''

  if (bytes[0] === 1 || bytes[0] === 2) {
    const isBig = bytes[0] === 2 || (body[0] === 0xfe && body[1] === 0xff)
    const start = body[0] === 0xff || body[0] === 0xfe ? 2 : 0
    const words = Buffer.from(body.subarray(start, start + ((body.length - start) & ~1)))

    if (isBig) {
      words.swap16()
    }
    text = words.toString('utf16le')
  } else {
    text = body.toString(bytes[0] === 3 ? 'utf8' : 'latin1')
  }

  return tidy(text.split('\u0000')[0])
}

/** Title, artist, album and genre from the ID3 tag at the start of an MP3. */
const readId3 = (bytes, tags) => {
  const version = bytes[3]
  const end = Math.min(bytes.length, 10 + (((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127)))
  const names =
    version === 2
      ? { TT2: 'title', TP1: 'artist', TAL: 'album', TCO: 'genre', TRK: 'track' }
      : { TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre', TRCK: 'track' }
  const idLength = version === 2 ? 3 : 4
  const headLength = version === 2 ? 6 : 10
  let at = 10

  while (at + headLength <= end) {
    const id = bytes.toString('latin1', at, at + idLength)

    if (!/^[A-Z0-9]+$/.test(id)) {
      break
    }

    const size =
      version === 2
        ? (bytes[at + 3] << 16) | (bytes[at + 4] << 8) | bytes[at + 5]
        : version === 4
          ? ((bytes[at + 4] & 127) << 21) | ((bytes[at + 5] & 127) << 14) | ((bytes[at + 6] & 127) << 7) | (bytes[at + 7] & 127)
          : bytes.readUInt32BE(at + 4)
    const start = at + headLength

    if (size <= 0 || start + size > end) {
      break
    }

    if (names[id] && !tags[names[id]]) {
      tags[names[id]] = frameText(bytes.subarray(start, start + Math.min(size, 2000)))
    }
    at = start + size
  }
}

/** The same four from the comment block of a FLAC file. */
const readFlac = (bytes, tags) => {
  let at = 4

  while (at + 4 <= bytes.length) {
    const isLast = (bytes[at] & 128) !== 0
    const kind = bytes[at] & 127
    const size = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]
    const start = at + 4

    if (kind === 4 && start + size <= bytes.length) {
      let here = start + 4 + bytes.readUInt32LE(start)
      const count = here + 4 <= start + size ? Math.min(bytes.readUInt32LE(here), 200) : 0
      here += 4

      for (let index = 0; index < count && here + 4 <= start + size; index += 1) {
        const length = bytes.readUInt32LE(here)
        here += 4

        if (here + length > start + size) {
          break
        }

        const [, key, value] = /^([A-Za-z]+)=([\s\S]*)$/.exec(bytes.toString('utf8', here, here + Math.min(length, 2000))) ?? []
        const name = { title: 'title', artist: 'artist', album: 'album', genre: 'genre', tracknumber: 'track' }[key?.toLowerCase()]

        if (name && !tags[name]) {
          tags[name] = tidy(value)
        }
        here += length
      }

      return
    }

    if (isLast) {
      return
    }
    at = start + size
  }
}

// ---- how long a song runs, from the file's own headers. A few small reads
// at known places; every number is checked before it is used.
const MP3_RATES = [44100, 48000, 32000]
const MP3_KBPS = {
  one: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  two: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}

/** MP3: the count of frames its first frame states (Xing, Info or VBRI), else its size over its bit rate. */
const mp3Length = (read, size, start) => {
  const bytes = read(start, 8192)

  for (let at = 0; at + 4 <= bytes.length; at += 1) {
    if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) {
      continue
    }

    const version = (bytes[at + 1] >> 3) & 3
    const layer = (bytes[at + 1] >> 1) & 3
    const kbps = (version === 3 ? MP3_KBPS.one : MP3_KBPS.two)[bytes[at + 2] >> 4]
    const rate = MP3_RATES[(bytes[at + 2] >> 2) & 3] / (version === 3 ? 1 : version === 2 ? 2 : 4)

    // Layer 3 only, with a bit rate and a sample rate that exist: anything else is not a frame's start.
    if (version === 1 || layer !== 1 || !kbps || !rate) {
      continue
    }

    const perFrame = version === 3 ? 1152 : 576
    const isMono = bytes[at + 3] >> 6 === 3
    const note = at + 4 + (version === 3 ? (isMono ? 17 : 32) : isMono ? 9 : 17)
    const word = bytes.toString('latin1', note, note + 4)

    if ((word === 'Xing' || word === 'Info') && note + 12 <= bytes.length && (bytes[note + 7] & 1) === 1) {
      return (bytes.readUInt32BE(note + 8) * perFrame) / rate
    }

    if (bytes.toString('latin1', at + 36, at + 40) === 'VBRI' && at + 54 <= bytes.length) {
      return (bytes.readUInt32BE(at + 50) * perFrame) / rate
    }

    return ((size - start - at) * 8) / (kbps * 1000)
  }

  return 0
}

/** WAV: the size of its sound over its bytes a second. */
const wavLength = (read, size) => {
  let at = 12
  let perSecond = 0

  for (let step = 0; step < 40 && at + 8 <= size; step += 1) {
    const head = read(at, 8)

    if (head.length < 8) {
      break
    }

    const id = head.toString('latin1', 0, 4)
    const length = head.readUInt32LE(4)

    if (id === 'fmt ') {
      const body = read(at + 8, 16)
      perSecond = body.length >= 12 ? body.readUInt32LE(8) : 0
    } else if (id === 'data') {
      return perSecond > 0 ? Math.min(length, size - at - 8) / perSecond : 0
    }
    at += 8 + length + (length % 2)
  }

  return 0
}

/** M4A: the length its "mvhd" box states, found by stepping from box to box. */
const m4aLength = (read, size) => {
  const find = (from, to, wanted) => {
    let at = from

    for (let step = 0; step < 200 && at + 8 <= to; step += 1) {
      const head = read(at, 16)

      if (head.length < 8) {
        break
      }

      const short = head.readUInt32BE(0)
      const isLong = short === 1 && head.length >= 16
      const length = isLong ? Number(head.readBigUInt64BE(8)) : short === 0 ? to - at : short

      if (length < 8 || at + length > to) {
        break
      }

      if (head.toString('latin1', 4, 8) === wanted) {
        return { start: at + (isLong ? 16 : 8), end: at + length }
      }
      at += length
    }

    return null
  }
  const film = find(0, size, 'moov')
  const stated = film && find(film.start, film.end, 'mvhd')

  if (!stated) {
    return 0
  }

  const body = read(stated.start, 32)

  if (body.length < 32) {
    return 0
  }

  const [scale, length] = body[0] === 1 ? [body.readUInt32BE(20), Number(body.readBigUInt64BE(24))] : [body.readUInt32BE(12), body.readUInt32BE(16)]

  return scale > 0 ? length / scale : 0
}

/** A song's length in whole seconds; 0 when the file does not say, or is a kind not read here. */
const readLength = (handle, size) => {
  const read = (at, length) => {
    const bytes = Buffer.alloc(length)

    return bytes.subarray(0, fs.readSync(handle, bytes, 0, length, at))
  }
  const head = read(0, 64)
  let seconds = 0

  if (head.length < 12) {
    return 0
  }

  if (head.toString('latin1', 0, 4) === 'fLaC') {
    // The first block says the sample rate (20 bits) and the count of samples (36 bits).
    if (head.length >= 26 && (head[4] & 127) === 0) {
      const rate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4)
      seconds = rate > 0 ? ((head[21] & 15) * 2 ** 32 + head.readUInt32BE(22)) / rate : 0
    }
  } else if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') {
    seconds = wavLength(read, size)
  } else if (head.toString('latin1', 4, 8) === 'ftyp') {
    seconds = m4aLength(read, size)
  } else {
    const isId3 = head.toString('latin1', 0, 3) === 'ID3'
    seconds = mp3Length(read, size, isId3 ? 10 + (((head[6] & 127) << 21) | ((head[7] & 127) << 14) | ((head[8] & 127) << 7) | (head[9] & 127)) : 0)
  }

  return Number.isFinite(seconds) && seconds > 0 && seconds < 86400 ? Math.round(seconds) : 0
}

/**
 * A song's details: from its tag where it has one, else from its file name
 * ("Artist - Title", with its number in front when it has one). `track` is
 * its number on the album and `length` its seconds; 0 when not known.
 */
export const readTags = file => {
  const tags = { title: '', artist: '', album: '', genre: '', track: '' }
  let length = 0

  try {
    const handle = fs.openSync(file, 'r')

    try {
      const head = Buffer.alloc(10)
      fs.readSync(handle, head, 0, 10, 0)
      const isId3 = head.toString('latin1', 0, 3) === 'ID3' && head[3] >= 2 && head[3] <= 4
      const isFlac = head.toString('latin1', 0, 4) === 'fLaC'

      if (isId3 || isFlac) {
        const bytes = Buffer.alloc(MAX_TAG)
        const got = fs.readSync(handle, bytes, 0, MAX_TAG, 0)
        ;(isId3 ? readId3 : readFlac)(bytes.subarray(0, got), tags)
      }

      try {
        length = readLength(handle, fs.fstatSync(handle).size)
      } catch {
        // A file cut short: its length stays unknown.
      }
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    // A file that cannot be read keeps the details its name gives.
  }

  const name = path.basename(file).replace(/\.[^.]+$/, '')
  const [, artist, title] = /^(?:\d{1,3}[ ._-]+)?(.+?) - (.+)$/.exec(name) ?? []
  // The number: the tag's ("3" or "3/12"), else the one the file's name starts with ("03 - ...", "03. ...", "03 ...").
  const numbered = /^(\d{1,3})\s*[._-]/.exec(name)?.[1] ?? /^(\d{2}) /.exec(name)?.[1]
  const track = Number.parseInt(tags.track, 10) || Number.parseInt(numbered ?? '', 10) || 0

  return {
    title: tags.title || tidy(title ?? name),
    artist: tags.artist || tidy(artist ?? ''),
    album: tags.album,
    genre: tidy(genreName(tags.genre)),
    track: track > 0 && track < 1000 ? track : 0,
    length,
  }
}

const walk = (folder, depth, found) => {
  let entries = []

  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= MAX_SONGS) {
      return
    }

    const full = path.join(folder, entry.name)

    if (entry.isFile() && AUDIO.test(entry.name) && !/[|\r\n]/.test(full)) {
      found.push({ file: full, root: found.root })
    } else if (entry.isDirectory() && depth < 4) {
      walk(full, depth + 1, found)
    }
  }
}

/** One song as the window gets it. `cache` remembers details by file, so a song is read once. */
export const describeSong = (file, cache = {}, root = path.dirname(file)) => {
  let mark = ''

  try {
    const stat = fs.statSync(file)
    mark = `${stat.size}:${Math.round(stat.mtimeMs)}`
  } catch {
    return null
  }

  // `v` is the form of what is kept: details kept by an older version are read again.
  if (cache[file]?.mark !== mark || cache[file].v !== 2) {
    cache[file] = { mark, v: 2, ...readTags(file) }
  }

  const { title, artist, album, genre, track, length } = cache[file]

  // The collection a song sits in: the folder above its own (an album's
  // artist, a pack's category), which sorts songs that carry no tags.
  const steps = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)
  const group = steps.length >= 2 ? steps[steps.length - 2] : (steps[0] ?? path.basename(root))

  return { path: file, name: artist ? `${artist} - ${title}` : title, title, artist, album, genre, track, length, folder: path.basename(path.dirname(file)), group }
}

/** Every song in the given folders, each once, with its details. */
export const scanFolders = (folders, cache = {}) => {
  const files = []

  for (const folder of folders) {
    files.root = folder
    walk(folder, 0, files)
  }

  const seen = new Set()
  const songs = []

  for (const { file, root } of files) {
    const key = file.toLowerCase()

    if (!seen.has(key)) {
      seen.add(key)
      const song = describeSong(file, cache, root)

      if (song) {
        songs.push(song)
      }
    }
  }

  // Details of files that are gone are dropped from the cache.
  for (const file of Object.keys(cache)) {
    if (!seen.has(file.toLowerCase())) {
      delete cache[file]
    }
  }

  return songs
}

/**
 * The song files a playlist names (.m3u, .m3u8 or .pls), in order. Only files
 * that exist on this computer's own drives are kept: web addresses and
 * network shares are left out.
 */
export const readPlaylist = file => {
  if (fs.statSync(file).size > MAX_PLAYLIST) {
    throw new Error('That playlist is too large.')
  }

  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '')
  const base = path.dirname(file)
  const found = []

  for (const raw of text.split(/\r?\n/)) {
    const line = (/^File\d+=(.*)$/i.exec(raw)?.[1] ?? raw).trim()

    if (line === '' || line.startsWith('#') || line.startsWith('[') || /^(NumberOfEntries|Version|Title\d+|Length\d+)=/i.test(line)) {
      continue
    }

    // A local path only: no address, no network share.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) || /^[\\/]{2}/.test(line) || /[|\r\n]/.test(line)) {
      continue
    }

    const full = path.resolve(base, line)

    try {
      if (AUDIO.test(full) && !/^[\\/]{2}/.test(full) && fs.statSync(full).isFile()) {
        found.push(full)
      }
    } catch {
      // Named in the playlist but not on this computer.
    }

    if (found.length >= MAX_SONGS) {
      break
    }
  }

  return found
}

// ------------------------------------------------------------------ cover art

const MAX_COVER = 6 * 1024 * 1024
const MAX_COVER_TAG = 12 * 1024 * 1024

/** Where a JPEG or PNG starts inside some bytes, with its kind; null when there is none. */
const findPicture = bytes => {
  const jpeg = bytes.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
  const png = bytes.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const starts = [
    [jpeg, 'image/jpeg'],
    [png, 'image/png'],
  ].filter(([at]) => at >= 0 && at < 600)

  if (starts.length === 0) {
    return null
  }

  const [at, mime] = starts.sort((a, b) => a[0] - b[0])[0]
  const data = bytes.subarray(at)

  return data.length > 100 && data.length <= MAX_COVER ? { mime, data } : null
}

const syncsafe = (bytes, at) => ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) | ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f)

/** The picture stored inside an MP3's ID3 tag (frame APIC, or PIC in the oldest form). */
const id3Picture = bytes => {
  const version = bytes[3]
  const end = Math.min(bytes.length, 10 + syncsafe(bytes, 6))
  let at = 10

  while (at + (version === 2 ? 6 : 10) <= end) {
    const id = bytes.toString('latin1', at, at + (version === 2 ? 3 : 4))

    if (!/^[A-Z0-9]{3,4}$/.test(id)) {
      break
    }

    const size =
      version === 2
        ? (bytes[at + 3] << 16) | (bytes[at + 4] << 8) | bytes[at + 5]
        : version === 4
          ? syncsafe(bytes, at + 4)
          : bytes.readUInt32BE(at + 4)
    const body = at + (version === 2 ? 6 : 10)

    if (size <= 0 || body + size > end) {
      break
    }

    if (id === 'APIC' || id === 'PIC') {
      const found = findPicture(bytes.subarray(body, body + size))

      if (found) {
        return found
      }
    }
    at = body + size
  }

  return null
}

/** The picture stored inside a FLAC file (metadata block 6). */
const flacPicture = bytes => {
  let at = 4

  while (at + 4 <= bytes.length) {
    const isLast = (bytes[at] & 0x80) !== 0
    const kind = bytes[at] & 0x7f
    const size = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]

    if (kind === 6 && at + 4 + size <= bytes.length) {
      // The picture follows a short description; skip to where it starts.
      const block = bytes.subarray(at + 4, at + 4 + size)
      const jpeg = block.indexOf(Buffer.from([0xff, 0xd8, 0xff]))
      const png = block.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const start = [jpeg, png].filter(one => one >= 0).sort((a, b) => a - b)[0]
      const found = start === undefined ? null : findPicture(block.subarray(start))

      if (found) {
        return found
      }
    }

    if (isLast) {
      break
    }
    at += 4 + size
  }

  return null
}

/** A picture file that sits in the song's folder: the usual cover names first, else the only picture there. */
const folderPicture = folder => {
  let names = []

  try {
    names = fs.readdirSync(folder).filter(name => /\.(jpe?g|png)$/i.test(name))
  } catch {
    return null
  }

  const usual = names.find(name => /^(cover|folder|front|album|albumart|artwork)\b.*\.(jpe?g|png)$/i.test(name))
  const pick = usual ?? (names.length === 1 ? names[0] : undefined)

  if (!pick) {
    return null
  }

  try {
    const file = path.join(folder, pick)

    if (fs.statSync(file).size > MAX_COVER) {
      return null
    }

    const found = findPicture(fs.readFileSync(file))

    return found ? { ...found, name: pick } : null
  } catch {
    return null
  }
}

/**
 * A song's cover: the picture inside the song file when it has one, else a
 * picture file from its folder. `from` says which, so the window can tell
 * the person. Null when there is neither. Only JPEG and PNG are handed on,
 * recognised by their first bytes and not by what the file claims.
 */
export const readCover = file => {
  try {
    const handle = fs.openSync(file, 'r')

    try {
      const head = Buffer.alloc(10)
      fs.readSync(handle, head, 0, 10, 0)
      const isId3 = head.toString('latin1', 0, 3) === 'ID3' && head[3] >= 2 && head[3] <= 4
      const isFlac = head.toString('latin1', 0, 4) === 'fLaC'

      if (isId3 || isFlac) {
        const want = isId3 ? Math.min(MAX_COVER_TAG, 10 + syncsafe(head, 6)) : MAX_COVER_TAG
        const bytes = Buffer.alloc(want)
        const got = fs.readSync(handle, bytes, 0, want, 0)
        const found = (isId3 ? id3Picture : flacPicture)(bytes.subarray(0, got))

        if (found) {
          return { ...found, from: 'song', name: path.basename(file) }
        }
      }
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    // Unreadable: fall through to the folder.
  }

  const beside = folderPicture(path.dirname(file))

  return beside ? { ...beside, from: 'folder' } : null
}
