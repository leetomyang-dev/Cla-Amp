// Checks the Winamp skin converter on a skin built here in memory.
// Run with: node tests/winamp-skin.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import zlib from 'node:zlib'

import { convertWinampSkin, readBmp, readZip, typical } from '../winamp-skin.mjs'

/** A 24-bit bitmap of one colour, with a stripe of another across the top rows. */
const bmp = (width, height, [r, g, b], stripe) => {
  const stride = Math.floor((24 * width + 31) / 32) * 4
  const buffer = Buffer.alloc(54 + stride * height)
  buffer.write('BM')
  buffer.writeUInt32LE(buffer.length, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)

  for (let y = 0; y < height; y += 1) {
    const colour = stripe && y < stripe.rows ? stripe.colour : [r, g, b]

    for (let x = 0; x < width; x += 1) {
      const at = 54 + stride * (height - 1 - y) + x * 3
      buffer[at] = colour[2]
      buffer[at + 1] = colour[1]
      buffer[at + 2] = colour[0]
    }
  }

  return buffer
}

/** A zip of the given files; `isPacked` chooses deflate or stored. */
const zip = (files, isPacked) => {
  const locals = []
  const directory = []
  let offset = 0

  for (const [name, data] of Object.entries(files)) {
    const packed = isPacked ? zlib.deflateRawSync(data) : data
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(isPacked ? 8 : 0, 8)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.write(name, 30, 'latin1')
    const entry = Buffer.alloc(46 + name.length)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(isPacked ? 8 : 0, 10)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    entry.write(name, 46, 'latin1')
    locals.push(local, packed)
    directory.push(entry)
    offset += local.length + packed.length
  }

  const table = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(directory.length, 8)
  end.writeUInt16LE(directory.length, 10)
  end.writeUInt32LE(table.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, table, end])
}

const viscolor = Array.from({ length: 24 }, (_, i) => (i === 0 ? '0,0,0' : i < 10 ? `255,${i * 20},0` : `0,${100 + i * 6},60`)).join('\r\n')
const skin = {
  'Skin/MAIN.BMP': bmp(275, 116, [40, 60, 120]),
  'Skin/TitleBar.bmp': bmp(344, 87, [20, 20, 20], { rows: 14, colour: [200, 40, 40] }),
  'Skin/cbuttons.bmp': bmp(136, 36, [180, 180, 200]),
  'Skin/pledit.txt': Buffer.from('[Text]\r\nNormal=#00FF80\r\nCurrent=#FFFFFF\r\nNormalBG=#000010\r\nSelectedBG=#3050D0\r\nFont=Tahoma"; } body { x\r\n'),
  'Skin/viscolor.txt': Buffer.from(viscolor),
  'Skin/readme.txt': Buffer.from('not wanted'),
}

for (const isPacked of [false, true]) {
  const files = readZip(zip(skin, isPacked))
  assert.deepEqual([...files.keys()].sort(), ['cbuttons.bmp', 'main.bmp', 'pledit.txt', 'titlebar.bmp', 'viscolor.txt'])
  assert.deepEqual(typical(readBmp(files.get('main.bmp')), 0, 14, 275, 116), [40, 60, 120])
  assert.deepEqual(typical(readBmp(files.get('titlebar.bmp')), 27, 0, 302, 14), [200, 40, 40])
}

const made = convertWinampSkin(zip(skin, true), 'My <Cool> Skin */ v2.wsz'.replace(/\.wsz$/, ''))
assert.equal(made.name, 'My Cool Skin v2')
assert.match(made.css, /--led: #00ff80;/)
assert.match(made.css, /--violet: #3050d0;/)
assert.match(made.css, /--red: #ff2800;/)
assert.match(made.css, /--titlebar-text: #ffffff;/)
// The font name is cleaned: nothing in it can close the rule.
assert.match(made.css, /--font: 'Tahoma  body  x', 'Segoe UI'/)
assert.equal(made.css.split('}').length, 2)
assert.equal(JSON.parse(made.json).name, 'My Cool Skin v2')

// The stylesheet must pass the app's own check as "colours", so it loads without a question.
const source = fs.readFileSync(new URL('../main.mjs', import.meta.url), 'utf8')
const from = source.indexOf('const checkSkin = css => {')
const checkSkin = new Function(`${source.slice(from, source.indexOf('\n}\n', from) + 3)}; return checkSkin`)()
assert.equal(checkSkin(made.css).kind, 'colours')

// No picture carries over: the skin is colours and a font.
assert.doesNotMatch(made.css, /url\(|--banner|--deck-art/)
assert.deepEqual(Object.keys(made.files), [])

// Files that are not skins are turned down with words, not a crash.
assert.throws(() => readZip(Buffer.from('hello, not a zip at all, just some words here')), /not a zip/)
assert.throws(() => convertWinampSkin(zip({ 'readme.txt': Buffer.from('x') }, true), 'x'), /No Winamp skin/)
assert.equal(readBmp(Buffer.from('BM, but far too short')), null)

// A zip that claims a huge entry is not inflated past the cap.
const bomb = zip({ 'main.bmp': Buffer.alloc(9 * 1024 * 1024) }, true)
assert.equal(readZip(bomb).has('main.bmp'), false)

console.log('winamp-skin: all checks passed')
