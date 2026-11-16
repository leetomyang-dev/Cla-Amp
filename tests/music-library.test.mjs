// Checks the music library on files made here: tags, file-name fallback,
// several folders, and playlists. Run with: node tests/music-library.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describeSong, readCover, readPlaylist, readTags, scanFolders } from '../music-library.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claamp-music-'))
const a = path.join(root, 'a')
const b = path.join(root, 'b')
fs.mkdirSync(a)
fs.mkdirSync(b)

const syncsafe = size => [(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]
const frame = (id, text, encoding = 3) => {
  const body = Buffer.concat([Buffer.from([encoding]), encoding === 1 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text, 'utf8')])
  const head = Buffer.alloc(10)
  head.write(id, 0, 'latin1')
  head.writeUInt32BE(body.length, 4)

  return Buffer.concat([head, body])
}
const mp3 = frames => {
  const body = Buffer.concat(frames)

  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(body.length)]), body, Buffer.alloc(64)])
}
const flac = comments => {
  const vendor = Buffer.from('test')
  const parts = [Buffer.alloc(4), vendor, Buffer.alloc(4)]
  parts[0].writeUInt32LE(vendor.length)
  parts[2].writeUInt32LE(comments.length)

  for (const one of comments) {
    const text = Buffer.from(one)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(text.length)
    parts.push(size, text)
  }

  const block = Buffer.concat(parts)

  return Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x84, (block.length >> 16) & 255, (block.length >> 8) & 255, block.length & 255]), block])
}

const tagged = path.join(a, 'one.mp3')
const wide = path.join(a, 'two.mp3')
const named = path.join(b, '03 - Some Band - Some Song.mp3')
const lossless = path.join(b, 'four.flac')
const broken = path.join(b, 'five.mp3')
fs.writeFileSync(tagged, mp3([frame('TIT2', 'Night Drive'), frame('TPE1', 'The Deck'), frame('TALB', 'First'), frame('TCON', '(17)')]))
fs.writeFileSync(wide, mp3([frame('TIT2', 'Glass Arcade', 1), frame('TPE1', 'The Deck', 1), frame('TCON', 'Synthwave', 1)]))
fs.writeFileSync(named, Buffer.alloc(128))
fs.writeFileSync(lossless, flac(['TITLE=Second Sun', 'ARTIST=Other Band', 'GENRE=Ambient']))
// A tag whose sizes point past the end of the file must not throw or read on.
fs.writeFileSync(broken, Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 127, 127, 127, 127, 0x54, 0x49, 0x54, 0x32, 255, 255, 255, 255, 0, 0]))
fs.writeFileSync(path.join(a, 'notes.txt'), 'not a song')

assert.deepEqual(readTags(tagged), { title: 'Night Drive', artist: 'The Deck', album: 'First', genre: 'Rock' })
assert.deepEqual(readTags(wide), { title: 'Glass Arcade', artist: 'The Deck', album: '', genre: 'Synthwave' })
assert.deepEqual(readTags(named), { title: 'Some Song', artist: 'Some Band', album: '', genre: '' })
assert.deepEqual(readTags(lossless), { title: 'Second Sun', artist: 'Other Band', album: '', genre: 'Ambient' })
assert.equal(readTags(broken).title, 'five')

const cache = {}
const songs = scanFolders([a, b, a], cache)
assert.equal(songs.length, 5, 'five songs, each once, the text file left out')
assert.equal(songs[0].name, 'The Deck - Night Drive')
assert.equal(songs[0].folder, 'a')
assert.equal(Object.keys(cache).length, 5)
fs.rmSync(wide)
scanFolders([a, b], cache)
assert.equal(Object.keys(cache).length, 4, 'a song that is gone leaves the cache')
assert.equal(describeSong(path.join(a, 'missing.mp3')), null)

const list = path.join(root, 'mix.m3u')
fs.writeFileSync(
  list,
  ['#EXTM3U', '#EXTINF:1,One', 'a/one.mp3', tagged, 'https://example.com/stream.mp3', '//server/share/x.mp3', 'a/notes.txt', 'a/missing.mp3', path.join('b', 'four.flac')].join('\r\n'),
)
assert.deepEqual(readPlaylist(list), [tagged, tagged, lossless], 'only local song files that exist')
const pls = path.join(root, 'mix.pls')
fs.writeFileSync(pls, ['[playlist]', `File1=${lossless}`, 'Title1=Second Sun', 'NumberOfEntries=1'].join('\n'))
assert.deepEqual(readPlaylist(pls), [lossless])

// Cover art: the picture inside the song first, else a picture in its folder.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)])
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 9)])
const apicBody = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0', 'latin1'), Buffer.from([3]), Buffer.from('front\0', 'latin1'), jpeg])
const apic = Buffer.alloc(10)
apic.write('APIC', 0, 'latin1')
apic.writeUInt32BE(apicBody.length, 4)
const covers = path.join(root, 'covers')
fs.mkdirSync(covers)
const withArt = path.join(covers, 'with-art.mp3')
fs.writeFileSync(withArt, mp3([frame('TIT2', 'Has art'), Buffer.concat([apic, apicBody])]))
const inside = readCover(withArt)
assert.equal(inside.from, 'song')
assert.equal(inside.mime, 'image/jpeg')
assert.ok(inside.data.equals(jpeg))

const plain = path.join(covers, 'plain.mp3')
fs.writeFileSync(plain, mp3([frame('TIT2', 'No art')]))
assert.equal(readCover(plain), null)
fs.writeFileSync(path.join(covers, 'Folder.png'), png)
const beside = readCover(plain)
assert.equal(beside.from, 'folder')
assert.equal(beside.name, 'Folder.png')
assert.equal(beside.mime, 'image/png')
// The song's own picture still wins over the folder's.
assert.equal(readCover(withArt).from, 'song')
// A file that only claims to be a picture is not handed on.
fs.rmSync(path.join(covers, 'Folder.png'))
fs.writeFileSync(path.join(covers, 'cover.jpg'), 'not a picture at all')
assert.equal(readCover(plain), null)

fs.rmSync(root, { recursive: true, force: true })
console.log('music library: all checks passed')
