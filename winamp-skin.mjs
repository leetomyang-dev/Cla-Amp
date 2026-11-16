// Turns a classic Winamp skin (.wsz, a zip of bitmaps and text files) into a
// Cla-Amp skin. Winamp's window and this one are laid out differently, so
// the pictures cannot be reused as they are: what carries over is the skin's
// colours and font. The result is a colours-only stylesheet.
//
// A .wsz comes from the internet, so it is read with care: sizes are capped,
// nothing in it is written to disk as it is, and the only thing that reaches
// the stylesheet is colours this file computed and a cleaned font name.
import zlib from 'node:zlib'

const MAX_FILE = 30 * 1024 * 1024
const MAX_ENTRY = 8 * 1024 * 1024
const MAX_ENTRIES = 2000

/** The files in a zip the converter cares about, by lower-case base name. */
export const readZip = buffer => {
  if (buffer.length > MAX_FILE) {
    throw new Error('The file is too large to be a Winamp skin.')
  }

  // The directory of a zip sits at its end, after a marker.
  let end = -1

  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65535); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  }

  if (end < 0) {
    throw new Error('This is not a zip file, so it is not a Winamp skin.')
  }

  const count = Math.min(buffer.readUInt16LE(end + 10), MAX_ENTRIES)
  let at = buffer.readUInt32LE(end + 16)
  const wanted = /^(pledit\.txt|viscolor\.txt|main\.bmp|titlebar\.bmp|cbuttons\.bmp|pledit\.bmp|text\.bmp)$/
  const files = new Map()

  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) {
      break
    }

    const method = buffer.readUInt16LE(at + 10)
    const packed = buffer.readUInt32LE(at + 20)
    const size = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const noteLength = buffer.readUInt16LE(at + 32)
    const local = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('latin1', at + 46, at + 46 + nameLength)
    const base = name.split(/[\\/]/).pop().toLowerCase()
    at += 46 + nameLength + extraLength + noteLength

    if (!wanted.test(base) || files.has(base) || size > MAX_ENTRY || local + 30 > buffer.length) {
      continue
    }

    if (buffer.readUInt32LE(local) !== 0x04034b50) {
      continue
    }

    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28)
    const data = buffer.subarray(start, start + packed)

    try {
      if (method === 0) {
        files.set(base, Buffer.from(data))
      } else if (method === 8) {
        files.set(base, zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }))
      }
    } catch {
      // A damaged entry: the skin is converted from what else it holds.
    }
  }

  return files
}

/**
 * A Windows bitmap as rows of colours. Handles the plain kinds Winamp skins
 * use (1, 4, 8, 24 and 32 bits not compressed, and run-length packed 8 bits);
 * anything else gives null.
 */
export const readBmp = buffer => {
  try {
    if (buffer.length < 54 || buffer.toString('latin1', 0, 2) !== 'BM') {
      return null
    }

    const offset = buffer.readUInt32LE(10)
    const header = buffer.readUInt32LE(14)
    const width = buffer.readInt32LE(18)
    const rawHeight = buffer.readInt32LE(22)
    const bits = buffer.readUInt16LE(28)
    const compression = buffer.readUInt32LE(30)
    const height = Math.abs(rawHeight)

    if (width <= 0 || height <= 0 || width > 4000 || height > 4000 || ![1, 4, 8, 24, 32].includes(bits)) {
      return null
    }

    const paletteStart = 14 + header

    // Run-length packed 8-bit pictures, which some skins use: unpacked here
    // into one colour number per dot, every step checked against both ends.
    if (compression === 1 && bits === 8) {
      const dots = new Uint8Array(width * height)
      let at = offset
      let x = 0
      let y = 0

      while (at + 1 < buffer.length && y < height) {
        const count = buffer[at]
        const value = buffer[at + 1]
        at += 2

        if (count > 0) {
          for (let i = 0; i < count && x < width; i += 1, x += 1) {
            dots[y * width + x] = value
          }
        } else if (value === 0) {
          x = 0
          y += 1
        } else if (value === 1) {
          break
        } else if (value === 2) {
          x += buffer[at] ?? 0
          y += buffer[at + 1] ?? 0
          at += 2
        } else {
          for (let i = 0; i < value && at + i < buffer.length; i += 1, x += 1) {
            if (x < width && y < height) {
              dots[y * width + x] = buffer[at + i]
            }
          }
          at += value + (value % 2)
        }
      }

      // Packed rows run from the bottom of the picture up.
      const packedPixel = (px, py) => {
        const colour = paletteStart + dots[(height - 1 - py) * width + px] * 4

        return colour + 2 < buffer.length ? [buffer[colour + 2], buffer[colour + 1], buffer[colour]] : [0, 0, 0]
      }

      return { width, height, pixel: packedPixel }
    }

    if (compression !== 0 && !(compression === 3 && bits === 32)) {
      return null
    }

    const stride = Math.floor((bits * width + 31) / 32) * 4

    if (offset + stride * height > buffer.length) {
      return null
    }

    const paletteAt = 14 + header
    const pixel = (x, y) => {
      const row = offset + stride * (rawHeight > 0 ? height - 1 - y : y)

      if (bits >= 24) {
        const at = row + x * (bits / 8)

        return [buffer[at + 2], buffer[at + 1], buffer[at]]
      }

      const index =
        bits === 8
          ? buffer[row + x]
          : bits === 4
            ? (buffer[row + (x >> 1)] >> (x % 2 === 0 ? 4 : 0)) & 15
            : (buffer[row + (x >> 3)] >> (7 - (x % 8))) & 1
      const at = paletteAt + index * 4

      return at + 2 < buffer.length ? [buffer[at + 2], buffer[at + 1], buffer[at]] : [0, 0, 0]
    }

    return { width, height, pixel }
  } catch {
    return null
  }
}

/** The usual colour of a part of a picture: the middle value of each channel, which ignores stray text and edges. */
export const typical = (image, x0, y0, x1, y1) => {
  if (!image) {
    return null
  }

  const reds = []
  const greens = []
  const blues = []
  const right = Math.min(image.width, x1)
  const bottom = Math.min(image.height, y1)

  for (let y = Math.max(0, y0); y < bottom; y += 1) {
    for (let x = Math.max(0, x0); x < right; x += 1) {
      const [r, g, b] = image.pixel(x, y)
      reds.push(r)
      greens.push(g)
      blues.push(b)
    }
  }

  if (reds.length === 0) {
    return null
  }

  const middle = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]

  return [middle(reds), middle(greens), middle(blues)]
}

// ---------------------------------------------------------------- colour maths

const clamp = value => Math.max(0, Math.min(255, Math.round(value)))
const hex = colour => `#${colour.map(one => clamp(one).toString(16).padStart(2, '0')).join('')}`
const mix = (a, b, part) => a.map((one, i) => one + (b[i] - one) * part)
const lighten = (colour, part) => mix(colour, [255, 255, 255], part)
const darken = (colour, part) => mix(colour, [0, 0, 0], part)
const light = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
const vivid = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) / 255

const parseHex = text => {
  const found = /#?([0-9a-f]{6})\b/i.exec(text ?? '')

  return found ? [0, 2, 4].map(at => parseInt(found[1].slice(at, at + 2), 16)) : null
}

/** pledit.txt: the playlist's text colours and font, as `Key=Value` lines. */
export const readPledit = text => {
  const found = {}

  for (const line of String(text ?? '').split(/\r?\n/)) {
    const [, key, value] = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(line) ?? []

    if (key) {
      found[key.toLowerCase()] = value
    }
  }

  return {
    normal: parseHex(found.normal),
    current: parseHex(found.current),
    normalBg: parseHex(found.normalbg),
    selectedBg: parseHex(found.selectedbg),
    font: (found.font ?? '').replace(/[^\w -]/g, '').trim().slice(0, 40),
  }
}

/** viscolor.txt: 24 lines of `r,g,b`, the colours of Winamp's spectrum. */
export const readViscolor = text => {
  const colours = []

  for (const line of String(text ?? '').split(/\r?\n/)) {
    const found = /^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(line)

    if (found) {
      colours.push([Number(found[1]), Number(found[2]), Number(found[3])].map(clamp))
    }
  }

  return colours.length >= 18 ? colours : null
}

/**
 * The Cla-Amp variables for a Winamp skin. Cla-Amp stays a dark window
 * whatever the skin, so text stays readable on the parts a skin cannot reach.
 */
export const paletteFrom = files => {
  const text = name => files.get(name)?.toString('latin1')
  const pledit = readPledit(text('pledit.txt'))
  const vis = readViscolor(text('viscolor.txt'))
  const main = readBmp(files.get('main.bmp') ?? Buffer.alloc(0))
  const titlebar = readBmp(files.get('titlebar.bmp') ?? Buffer.alloc(0))
  const buttons = readBmp(files.get('cbuttons.bmp') ?? Buffer.alloc(0))

  if (!main && !vis && !pledit.normal) {
    throw new Error('No Winamp skin was found in that file (no main.bmp, viscolor.txt or pledit.txt).')
  }

  // The body of Winamp's main window, its active title bar, and its play buttons.
  const body = typical(main, 0, 14, 275, 116) ?? [58, 64, 80]
  const bar = typical(titlebar, 27, 0, 302, 14) ?? typical(main, 0, 0, 275, 14) ?? body
  const button = typical(buttons, 0, 0, 114, 18) ?? lighten(body, 0.45)
  // Lights: the playlist's text, or the foot of the spectrum.
  const led = [pledit.normal, vis?.[17], vis?.[18]].find(one => one && light(one) > 0.25) ?? [57, 211, 83]
  const hot = vis ? vis[2] : [239, 68, 68]
  const warm = vis ? vis[9] : [245, 166, 35]
  const glass = pledit.normalBg && light(pledit.normalBg) < 0.35 ? pledit.normalBg : (vis?.[0] ?? [7, 9, 13])
  // The accent: the playlist's selection colour when it has some colour to it,
  // else the title bar, else the lights.
  const accentSource = [pledit.selectedBg, bar, led].find(one => one && vivid(one) > 0.18 && light(one) > 0.08) ?? led
  const accent = light(accentSource) < 0.22 ? lighten(accentSource, 0.3) : light(accentSource) > 0.7 ? darken(accentSource, 0.35) : accentSource
  // Dark surfaces tinted with the skin's body colour.
  const tint = darken(body, 0.2)
  const base = [11, 12, 16]
  const panel = mix(base, tint, 0.18)
  const readable = on => (light(on) > 0.55 ? '#11141c' : '#ffffff')
  const buttonTop = lighten(button, 0.35)
  const buttonLow = darken(button, 0.22)

  return {
    '--bg': hex(mix(base, tint, 0.08)),
    '--panel': hex(panel),
    '--panel-2': hex(mix(base, tint, 0.28)),
    '--row': hex(mix(base, tint, 0.24)),
    '--row-hover': hex(mix(base, tint, 0.45)),
    '--line': hex(mix(base, tint, 0.55)),
    '--text': hex(lighten(mix(tint, [230, 235, 245], 0.9), 0.1)),
    '--dim': hex(mix(tint, [160, 168, 185], 0.8)),
    '--led': hex(led),
    '--amber': hex(light(warm) > 0.2 ? warm : [245, 166, 35]),
    '--red': hex(light(hot) > 0.15 ? hot : [239, 68, 68]),
    '--blue': hex(lighten(accent, 0.35)),
    '--led-off': hex(mix(glass, led, 0.1)),
    '--display': hex(darken(glass, 0.1)),
    '--violet': hex(accent),
    '--accent-hi': hex(lighten(accent, 0.5)),
    '--accent-fill': `linear-gradient(180deg, ${hex(lighten(accent, 0.2))}, ${hex(accent)} 55%, ${hex(darken(accent, 0.3))})`,
    '--accent-glow': `rgba(${accent.map(clamp).join(', ')}, 0.55)`,
    '--accent-soft': hex(lighten(accent, 0.85)),
    '--app-bg': `linear-gradient(180deg, ${hex(lighten(body, 0.05))}, ${hex(darken(body, 0.55))} 28%, ${hex(darken(body, 0.72))})`,
    '--app-edge': hex(lighten(body, 0.25)),
    '--titlebar': `linear-gradient(180deg, ${hex(lighten(bar, 0.18))}, ${hex(bar)} 55%, ${hex(darken(bar, 0.3))})`,
    '--titlebar-text': readable(bar),
    '--button': `linear-gradient(180deg, ${hex(buttonTop)}, ${hex(button)} 48%, ${hex(buttonLow)} 52%, ${hex(button)})`,
    '--button-text': readable(button),
    '--chrome-button': `linear-gradient(180deg, ${hex(buttonTop)}, ${hex(buttonLow)})`,
    '--tab': `linear-gradient(180deg, ${hex(mix(base, tint, 0.5))}, ${hex(mix(base, tint, 0.3))})`,
    '--tab-active': `linear-gradient(180deg, ${hex(buttonTop)}, ${hex(button)})`,
    '--tab-active-text': readable(button),
    '--brand-a': `linear-gradient(180deg, #ffffff, ${hex(lighten(body, 0.55))})`,
    '--brand-b': `linear-gradient(180deg, ${hex(lighten(led, 0.3))}, ${hex(led)})`,
    ...(pledit.font ? { '--font': `'${pledit.font}', 'Segoe UI', system-ui, sans-serif` } : {}),
  }
}

/**
 * Part of a picture as a new, plain 24-bit bitmap file. The bytes are made
 * here from colours this file read one by one, so nothing from the skin's
 * own file reaches the disk as it was.
 */
export const drawBmp = (image, x0, y0, width, height) => {
  const stride = Math.ceil((width * 3) / 4) * 4
  const out = Buffer.alloc(54 + stride * height)
  out.write('BM', 0, 'latin1')
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(stride * height, 34)

  for (let y = 0; y < height; y += 1) {
    // Rows are stored bottom-up.
    const row = 54 + stride * (height - 1 - y)

    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = image.pixel(x0 + x, y0 + y)
      out[row + x * 3] = b
      out[row + x * 3 + 1] = g
      out[row + x * 3 + 2] = r
    }
  }

  return out
}

/**
 * Not used by the importer (the owner found the picture no good in the
 * window); kept for anyone who wants a skin's picture as a new bitmap.
 * The upper part of Winamp's main
 * window (its display, spectrum and song title), which is the part people
 * know a skin by. Null when the skin has no usable main picture.
 */
export const bannerFrom = files => {
  const main = readBmp(files.get('main.bmp') ?? Buffer.alloc(0))

  if (!main || main.width < 100 || main.height < 60) {
    return null
  }

  return drawBmp(main, 0, 14, Math.min(275, main.width), 44)
}

/** A .wsz file's bytes as the files of a Cla-Amp skin. */
export const convertWinampSkin = (buffer, name) => {
  const files = readZip(buffer)
  const palette = paletteFrom(files)

  const title = String(name).replace(/[^\w .()'&+-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Winamp skin'
  const lines = Object.entries(palette).map(([key, value]) => `  ${key}: ${value};`)

  return {
    name: title,
    files: {},
    css: `/* Made by Cla-Amp from the Winamp skin "${title.replace(/\*\//g, '')}". Colours and font. */\n:root {\n${lines.join('\n')}\n}\n`,
    json: `${JSON.stringify(
      {
        name: title,
        author: 'Converted from a Winamp skin',
        description: 'Colours and font taken from a classic Winamp skin (.wsz).',
        version: '1.0.0',
      },
      null,
      2,
    )}\n`,
  }
}
