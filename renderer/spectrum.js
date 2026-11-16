// The spectrum: its looks, its colours and its other choices, the effects
// around it (beat glow, scrolling title, screen lines), and the menu that
// sets them. Click the spectrum (in the music deck or the top bar) for
// the next look; right-click it for the menu with everything.

export const STYLES = [
  'LED bars',
  'Solid bars',
  'Thin bars',
  'Blocks',
  'Line',
  'Filled wave',
  'Ribbon',
  'Skyline',
  'Mirror',
  'Dots',
  'Peaks only',
  'Rings',
  'Waterfall',
  'Bouncing bars',
  'Flames',
  'Sparks',
  'Starfield',
  'VU needles',
  'Pixel rain',
]

/** The colour sets. "Skin" is the skin's own quiet, loud and peak colours. */
export const COLOURS = ['Skin', 'Cover', 'Rainbow', 'Fire', 'Ice', 'Sunset', 'Forest', 'Candy', 'One colour']

/** Effects outside the spectrum's own picture: switches in the same menu. */
export const EFFECTS = [
  ['beat', 'Beat glow'],
  ['marquee', 'Scrolling song title'],
  ['lines', 'Screen lines'],
]

export const BANDS = ['Auto', '12', '24', '48', '96']

const SETS = {
  Fire: ['#7a1500', '#ff7a00', '#fff3a0'],
  Ice: ['#0b3d91', '#35b7ff', '#e6fbff'],
  Sunset: ['#5b2a86', '#ff5e7e', '#ffd166'],
  Forest: ['#0f5132', '#49c46b', '#eaff8f'],
  Candy: ['#7b5cff', '#ff6ad5', '#8ef6ff'],
}

// `lines` is null until the person chooses: until then the skin decides.
const DEFAULTS = { colours: 'Skin', bands: 'Auto', peaks: true, glow: false, centre: false, reflect: false, grid: false, beat: false, marquee: false, lines: null }

/** The look in use, kept on this computer. */
export const spectrumStyle = () => {
  const saved = localStorage.getItem('spectrum')

  return STYLES.includes(saved) ? saved : STYLES[0]
}

export const setSpectrumStyle = style => {
  if (STYLES.includes(style)) {
    localStorage.setItem('spectrum', style)
  }

  return spectrumStyle()
}

export const nextSpectrumStyle = () => setSpectrumStyle(STYLES[(STYLES.indexOf(spectrumStyle()) + 1) % STYLES.length])

let options = null

/** The other choices: colours, how many bands, peak marks, glow, centre out, reflection, grid. */
export const spectrumOptions = () => {
  if (options === null) {
    let saved = {}

    try {
      saved = JSON.parse(localStorage.getItem('spectrumOptions') ?? '{}') ?? {}
    } catch {
      saved = {}
    }
    options = { ...DEFAULTS }

    if (COLOURS.includes(saved.colours)) options.colours = saved.colours
    if (BANDS.includes(saved.bands)) options.bands = saved.bands

    for (const key of ['peaks', 'glow', 'centre', 'reflect', 'grid', 'beat', 'marquee', 'lines']) {
      if (typeof saved[key] === 'boolean') options[key] = saved[key]
    }
  }

  return options
}

export const setSpectrumOption = (key, value) => {
  options = { ...spectrumOptions(), [key]: value }
  localStorage.setItem('spectrumOptions', JSON.stringify(options))

  return options
}

// Whether the skin in use asks for screen lines (its --screen-lines variable).
let isSkinLined = false

export const setSkinLines = isOn => {
  isSkinLined = isOn === true
}

/** Whether an effect is on. Screen lines follow the skin until the person chooses. */
export const isEffectOn = key => {
  const value = spectrumOptions()[key]

  return key === 'lines' ? (value ?? isSkinLined) : value === true
}

// Three colours taken from the cover of what is playing, quiet to loud; null without a cover.
let coverStops = null

export const setCoverColours = colours => {
  coverStops = Array.isArray(colours) && colours.length === 3 ? colours : null
}

// What a look keeps between frames (positions of sparks, stars, needles...), per canvas.
const memory = new WeakMap()

const remember = (canvas, key, make) => {
  let kept = memory.get(canvas)

  if (!kept || kept.key !== key) {
    kept = { key, ...make() }
    memory.set(canvas, kept)
  }

  return kept
}

/** `values` stretched or squeezed to `count` bands, smoothly. */
const spread = (values, count) => {
  if (count === values.length) {
    return values
  }
  const out = []

  for (let i = 0; i < count; i += 1) {
    const at = (i * (values.length - 1)) / Math.max(1, count - 1)
    const low = Math.floor(at)
    const high = Math.min(values.length - 1, low + 1)
    out.push(values[low] + (values[high] - values[low]) * (at - low))
  }

  return out
}

/** Loudest in the middle, falling away to both sides. */
const fromCentre = values => {
  const half = spread(values, Math.ceil(values.length / 2))

  return [...half.slice().reverse(), ...half].slice(0, values.length)
}

// What each canvas showed last, for looks that build on their own picture.
const seen = new WeakMap()

/** Draws `values` (0 to 1) in the look named; `caps` are falling peak marks, where the look has them. */
export const drawStyle = (canvas, values, style, theme, { caps, pad = 4 } = {}) => {
  const context = canvas.getContext('2d')
  const { width, height } = canvas
  const chosen = spectrumOptions()
  const wide = width - pad * 2
  const full = height - pad * 2
  // With a reflection the picture keeps the upper part and its faint copy lies under it.
  const tall = chosen.reflect && !['Rings', 'Waterfall', 'Mirror', 'Ribbon', 'Starfield', 'VU needles', 'Pixel rain'].includes(style) ? full * 0.72 : full
  const floor = pad + tall
  const level = value => Math.min(1, Math.max(0, value))

  const count = chosen.bands === 'Auto' ? Math.max(values.length, Math.min(96, Math.round(wide / 11))) : Number(chosen.bands)
  let bands = spread(values, count)
  let marks = caps && chosen.peaks ? spread(caps, count) : null

  if (chosen.centre) {
    bands = fromCentre(bands)
    marks = marks ? fromCentre(marks) : null
  }
  const pitch = wide / bands.length
  const last = seen.get(canvas)
  const key = `${style}|${width}|${height}`
  seen.set(canvas, key)

  // Bottom to top: three colours.
  const skinStops = [theme.led, theme.amber, theme.red]
  const stops =
    chosen.colours === 'Cover' ? (coverStops ?? skinStops) : chosen.colours === 'Skin' || chosen.colours === 'Rainbow' ? skinStops : chosen.colours === 'One colour' ? [theme.led, theme.led, theme.led] : SETS[chosen.colours]
  const heat = context.createLinearGradient(0, floor, 0, pad)
  heat.addColorStop(0, stops[0])
  heat.addColorStop(0.65, stops[1])
  heat.addColorStop(1, stops[2])
  const isRainbow = chosen.colours === 'Rainbow'
  const hue = i => `hsl(${Math.round((i / bands.length) * 300)}, 92%, 60%)`
  const paint = i => (isRainbow ? hue(i) : heat)
  const byLevel = (part, i) => (isRainbow ? hue(i) : part >= 0.8 ? stops[2] : part >= 0.6 ? stops[1] : stops[0])

  if (style === 'Waterfall') {
    // Time runs to the left; each new column is the bands, bass at the bottom.
    // A wide strip moves faster, so it fills in about the same time as a small one.
    const step = Math.max(2, Math.round(width / 260))
    // A short strip gets fewer, taller rows: each stays at least three pixels high.
    const rows = spread(bands, Math.max(4, Math.min(bands.length, Math.floor(full / 3))))
    const cell = full / rows.length

    if (last !== key) {
      context.clearRect(0, 0, width, height)
    } else {
      context.drawImage(canvas, step, 0, width - step, height, 0, 0, width - step, height)
      context.clearRect(width - step, 0, step, height)
    }

    rows.forEach((value, i) => {
      const part = level(value)

      if (part > 0.03) {
        // The colour says how loud: quiet is dim and cool, loud is bright and hot.
        context.globalAlpha = Math.min(1, 0.25 + part * 0.9)
        context.fillStyle = isRainbow ? `hsl(${Math.round(260 - part * 260)}, 95%, ${Math.round(35 + part * 35)}%)` : part >= 0.8 ? stops[2] : part >= 0.6 ? stops[1] : stops[0]
        context.fillRect(width - step, pad + full - (i + 1) * cell, step, Math.ceil(cell))
      }
    })
    context.globalAlpha = 1

    return
  }
  context.clearRect(0, 0, width, height)
  // The floor line: there with no music too, so the spectrum never looks missing.
  context.fillStyle = theme.dim
  context.globalAlpha = 0.35
  if (style !== 'Starfield' && style !== 'Pixel rain') {
    context.fillRect(pad, style === 'Mirror' || style === 'Ribbon' ? pad + full / 2 : floor - 1, wide, 1)
  }
  context.globalAlpha = 1

  if (chosen.grid) {
    context.fillStyle = theme.text
    context.globalAlpha = 0.08

    for (let line = 1; line < 4; line += 1) {
      context.fillRect(pad, pad + (tall * line) / 4, wide, 1)
    }
    context.globalAlpha = 1
  }
  if (chosen.glow) {
    context.shadowBlur = Math.max(4, Math.min(12, height / 5))
    context.shadowColor = stops[1]
  }
  const points = bands.map((value, i) => [pad + (i + 0.5) * pitch, floor - level(value) * tall])
  const curve = () => {
    context.moveTo(pad, points[0][1])

    for (let i = 0; i < points.length - 1; i += 1) {
      // A smooth curve through the bands.
      const [x, y] = points[i]
      const [nextX, nextY] = points[i + 1]
      context.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2)
    }
    context.lineTo(pad + wide, points[points.length - 1][1])
  }
  const peakMarks = bar => {
    if (marks === null) {
      return
    }
    context.fillStyle = theme.text

    marks.forEach((mark, i) => {
      if (mark > 0.02) {
        context.fillRect(pad + i * pitch + (pitch - bar) / 2, floor - level(mark) * tall, bar, 2)
      }
    })
  }

  if (style === 'LED bars' || style === 'Blocks') {
    // Stacked lamps; Blocks are square and close together.
    const gap = style === 'Blocks' ? 1 : 2
    const bar = Math.max(1, pitch - gap)
    const rows = style === 'Blocks' ? Math.max(4, Math.round(tall / Math.max(3, bar))) : Math.max(6, Math.round(tall / 5))
    const row = tall / rows

    bands.forEach((value, i) => {
      const lit = Math.round(level(value) * rows)
      const x = pad + i * pitch + (pitch - bar) / 2

      for (let at = 0; at < rows; at += 1) {
        const part = (at + 1) / rows
        context.fillStyle = at < lit ? byLevel(part, i) : theme.off
        context.fillRect(x, floor - (at + 1) * row + 1, bar, Math.max(1, row - 1))
      }
    })
    peakMarks(bar)
  } else if (style === 'Solid bars' || style === 'Thin bars') {
    const bar = style === 'Thin bars' ? Math.max(1, pitch * 0.3) : Math.max(1, pitch - 2)

    bands.forEach((value, i) => {
      context.fillStyle = paint(i)
      context.fillRect(pad + i * pitch + (pitch - bar) / 2, floor - level(value) * tall, bar, Math.max(1, level(value) * tall))
    })
    peakMarks(bar)
  } else if (style === 'Line' || style === 'Filled wave') {
    context.beginPath()
    curve()

    if (style === 'Filled wave') {
      context.lineTo(pad + wide, floor)
      context.lineTo(pad, floor)
      context.closePath()
      context.globalAlpha = 0.55
      context.fillStyle = heat
      context.fill()
      context.globalAlpha = 1
    }
    context.lineWidth = 2
    context.strokeStyle = heat
    context.stroke()
  } else if (style === 'Ribbon') {
    // A band of sound around the middle line, wider where it is louder.
    const middle = pad + full / 2
    const both = context.createLinearGradient(0, pad, 0, pad + full)
    both.addColorStop(0, stops[2])
    both.addColorStop(0.3, stops[1])
    both.addColorStop(0.5, stops[0])
    both.addColorStop(0.7, stops[1])
    both.addColorStop(1, stops[2])
    context.beginPath()
    bands.forEach((value, i) => context.lineTo(pad + (i + 0.5) * pitch, middle - Math.max(1, (level(value) * full) / 2)))

    for (let i = bands.length - 1; i >= 0; i -= 1) {
      context.lineTo(pad + (i + 0.5) * pitch, middle + Math.max(1, (level(bands[i]) * full) / 2))
    }
    context.closePath()
    context.globalAlpha = 0.75
    context.fillStyle = both
    context.fill()
    context.globalAlpha = 1
  } else if (style === 'Skyline') {
    // Flat tops joined by steps, filled faintly beneath.
    context.beginPath()
    context.moveTo(pad, floor)
    bands.forEach((value, i) => {
      const y = floor - level(value) * tall
      context.lineTo(pad + i * pitch, y)
      context.lineTo(pad + (i + 1) * pitch, y)
    })
    context.lineTo(pad + wide, floor)
    context.closePath()
    context.globalAlpha = 0.3
    context.fillStyle = heat
    context.fill()
    context.globalAlpha = 1
    context.lineWidth = 1.5
    context.strokeStyle = heat
    context.stroke()
  } else if (style === 'Mirror') {
    const middle = pad + full / 2
    const both = context.createLinearGradient(0, pad, 0, pad + full)
    both.addColorStop(0, stops[2])
    both.addColorStop(0.25, stops[1])
    both.addColorStop(0.5, stops[0])
    both.addColorStop(0.75, stops[1])
    both.addColorStop(1, stops[2])

    bands.forEach((value, i) => {
      const half = Math.max(0.5, (level(value) * full) / 2)
      context.fillStyle = isRainbow ? hue(i) : both
      context.fillRect(pad + i * pitch, middle - half, Math.max(1, pitch - 2), half * 2)
    })
  } else if (style === 'Peaks only') {
    // Just the falling marks, each with a short fading tail.
    const bar = Math.max(1, pitch - 2)
    const tops = caps ? (chosen.centre ? fromCentre(spread(caps, count)) : spread(caps, count)) : bands

    tops.forEach((value, i) => {
      const part = level(value)
      const y = floor - part * tall
      const x = pad + i * pitch + (pitch - bar) / 2
      context.fillStyle = byLevel(part, i)
      context.globalAlpha = 0.18
      context.fillRect(x, y, bar, Math.min(tall * 0.25, floor - y))
      context.globalAlpha = 1
      context.fillRect(x, y, bar, 2)
    })
  } else if (style === 'Rings') {
    // The bands as spokes around a circle. A wide strip gets a row of circles,
    // bass on the left, each drawing its own share of the bands.
    const reach = Math.min(wide, full) / 2
    const inner = reach * 0.32
    const rings = Math.max(1, Math.min(16, Math.floor(wide / (reach * 2.3))))
    const share = bands.length / rings
    context.lineCap = 'round'

    for (let ring = 0; ring < rings; ring += 1) {
      const own = rings === 1 ? bands : bands.slice(Math.floor(ring * share), Math.max(Math.floor(ring * share) + 1, Math.floor((ring + 1) * share)))
      // Each circle is the same on both sides, so it reads as one shape.
      const spokes = rings === 1 ? own : fromCentre(spread(own, Math.max(12, Math.min(28, Math.round(reach * 1.4)))))
      const centreX = pad + (wide / rings) * (ring + 0.5)
      const centreY = pad + full / 2
      const loud = own.reduce((sum, value) => sum + level(value), 0) / own.length
      context.lineWidth = Math.max(1, Math.min(4, (Math.PI * 2 * inner) / spokes.length - 1))

      if (rings > 1) {
        // The middle glows with that circle's share of the sound.
        context.fillStyle = byLevel(loud, Math.floor(ring * share))
        context.globalAlpha = 0.15 + loud * 0.6
        context.beginPath()
        context.arc(centreX, centreY, inner * (0.5 + loud * 0.4), 0, Math.PI * 2)
        context.fill()
        context.globalAlpha = 1
      }

      spokes.forEach((value, i) => {
        const angle = (i / spokes.length) * Math.PI * 2 - Math.PI / 2
        const length = Math.max(1, level(value) * (reach - inner))
        context.strokeStyle = byLevel(level(value), rings === 1 ? i : Math.floor(ring * share))
        context.beginPath()
        context.moveTo(centreX + Math.cos(angle) * inner, centreY + Math.sin(angle) * inner)
        context.lineTo(centreX + Math.cos(angle) * (inner + length), centreY + Math.sin(angle) * (inner + length))
        context.stroke()
      })
    }
    context.lineCap = 'butt'
  } else if (style === 'Bouncing bars') {
    // Bars with weight: they overshoot a loud hit and settle.
    const kept = remember(canvas, key, () => ({ at: [], speed: [] }))
    const bar = Math.max(1, pitch - 2)

    bands.forEach((value, i) => {
      const at = kept.at[i] ?? 0
      const speed = ((kept.speed[i] ?? 0) + (level(value) - at) * 0.32) * 0.74
      kept.speed[i] = speed
      kept.at[i] = Math.max(0, Math.min(1.06, at + speed))
      const high = Math.max(1, Math.min(tall + pad - 1, kept.at[i] * tall))
      const round = Math.min(bar / 2, 4, high)
      context.fillStyle = paint(i)
      context.beginPath()
      context.roundRect(pad + i * pitch + (pitch - bar) / 2, floor - high, bar, high, [round, round, 0, 0])
      context.fill()
    })
    peakMarks(bar)
  } else if (style === 'Flames') {
    // Each band is a tongue of fire: three layers, leaning and flickering.
    const now = performance.now()
    const half = Math.max(1.5, pitch * 0.6)
    context.globalCompositeOperation = 'lighter'

    bands.forEach((value, i) => {
      const part = level(value)

      if (part < 0.03) {
        return
      }
      const high = part * tall * (0.84 + 0.16 * Math.sin(now / 70 + i * 2.3) * Math.sin(now / 113 + i * 0.9))
      const x = pad + (i + 0.5) * pitch
      const lean = Math.sin(now / 160 + i * 1.3) * pitch * 0.4
      const tongue = (scale, colour, alpha) => {
        context.globalAlpha = alpha
        context.fillStyle = colour
        context.beginPath()
        context.moveTo(x - half * scale, floor)
        context.quadraticCurveTo(x - half * scale, floor - high * scale * 0.55, x + lean * scale, floor - high * scale)
        context.quadraticCurveTo(x + half * scale, floor - high * scale * 0.55, x + half * scale, floor)
        context.closePath()
        context.fill()
      }
      tongue(1, isRainbow ? hue(i) : stops[0], 0.5)
      tongue(0.7, isRainbow ? hue(i) : stops[1], 0.65)
      tongue(0.4, stops[2], 0.8)
    })
    context.globalAlpha = 1
    context.globalCompositeOperation = 'source-over'
  } else if (style === 'Sparks') {
    // Faint bars; a band that jumps throws sparks, which fall and fade.
    const kept = remember(canvas, key, () => ({ before: [], sparks: [] }))
    const bar = Math.max(1, pitch * 0.5)
    const push = Math.max(0.5, tall / 60)

    bands.forEach((value, i) => {
      const part = level(value)
      context.globalAlpha = 0.4
      context.fillStyle = paint(i)
      context.fillRect(pad + i * pitch + (pitch - bar) / 2, floor - part * tall, bar, Math.max(1, part * tall))

      if (part > 0.45 && part - (kept.before[i] ?? 0) > 0.07 && kept.sparks.length < 260) {
        for (let n = 0; n < 3; n += 1) {
          kept.sparks.push({ x: pad + (i + 0.5) * pitch, y: floor - part * tall, dx: (Math.random() - 0.5) * 2.6, dy: -(0.6 + Math.random() * 2.2) * push, life: 1, colour: byLevel(part, i) })
        }
      }
      kept.before[i] = part
    })
    kept.sparks = kept.sparks.filter(one => one.life > 0 && one.y < floor + 2)

    for (const one of kept.sparks) {
      one.x += one.dx
      one.y += one.dy
      one.dy += 0.12 * push
      one.life -= 0.035
      context.globalAlpha = Math.max(0, one.life)
      context.fillStyle = one.colour
      context.fillRect(one.x - 1, one.y - 1, 2, 2)
    }
    context.globalAlpha = 1
  } else if (style === 'Starfield') {
    // Stars fly out from the middle; the bass sets the speed.
    const fresh = () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: 1 })
    const kept = remember(canvas, key, () => ({
      stars: Array.from({ length: Math.max(60, Math.min(240, Math.round((wide * full) / 130))) }, () => ({ ...fresh(), z: Math.random() * 0.9 + 0.1 })),
    }))
    const low = bands.slice(0, Math.max(1, Math.floor(bands.length / 4)))
    const speed = 0.004 + (low.reduce((sum, value) => sum + level(value), 0) / low.length) * 0.035
    const centreX = pad + wide / 2
    const centreY = pad + full / 2
    context.lineCap = 'round'

    kept.stars.forEach((star, i) => {
      const beforeZ = star.z
      star.z -= speed
      const x = centreX + (star.x / star.z) * (wide / 2)
      const y = centreY + (star.y / star.z) * (full / 2)

      if (star.z <= 0.02 || x < pad || x > pad + wide || y < pad || y > pad + full) {
        Object.assign(star, fresh())

        return
      }
      const near = 1 - star.z
      context.globalAlpha = 0.25 + near * 0.75
      context.strokeStyle = isRainbow ? `hsl(${(i * 47) % 360}, 92%, 65%)` : near > 0.7 ? stops[2] : near > 0.4 ? stops[1] : stops[0]
      context.lineWidth = 1 + near * 2.2
      context.beginPath()
      context.moveTo(centreX + (star.x / beforeZ) * (wide / 2), centreY + (star.y / beforeZ) * (full / 2))
      context.lineTo(x, y)
      context.stroke()
    })
    context.globalAlpha = 1
    context.lineCap = 'butt'
  } else if (style === 'VU needles') {
    // Swinging meters, bass on the left: more of them on a wide strip.
    const meters = Math.max(2, Math.min(8, Math.floor(wide / (full * 2.6))))
    const kept = remember(canvas, key, () => ({ at: [] }))
    const cell = wide / meters
    const radius = Math.min(cell * 0.46, full * 0.92)
    const swing = Math.PI * 0.3
    const up = -Math.PI / 2
    const share = bands.length / meters

    for (let meter = 0; meter < meters; meter += 1) {
      const own = bands.slice(Math.floor(meter * share), Math.max(Math.floor(meter * share) + 1, Math.floor((meter + 1) * share)))
      const want = own.reduce((sum, value) => sum + level(value), 0) / own.length
      kept.at[meter] = (kept.at[meter] ?? 0) + (want - (kept.at[meter] ?? 0)) * 0.3
      const x = pad + cell * (meter + 0.5)
      const y = pad + full
      context.lineWidth = Math.max(1, radius * 0.06)
      // The scale, with its loud end marked.
      context.strokeStyle = isRainbow ? hue(Math.floor(meter * share)) : stops[0]
      context.beginPath()
      context.arc(x, y, radius, up - swing, up + swing * 0.45)
      context.stroke()
      context.strokeStyle = stops[2]
      context.beginPath()
      context.arc(x, y, radius, up + swing * 0.45, up + swing)
      context.stroke()
      context.strokeStyle = theme.dim
      context.lineWidth = 1

      for (let tick = 0; tick <= 6; tick += 1) {
        const angle = up - swing + (tick / 6) * swing * 2
        context.beginPath()
        context.moveTo(x + Math.cos(angle) * radius * 0.82, y + Math.sin(angle) * radius * 0.82)
        context.lineTo(x + Math.cos(angle) * radius * 0.94, y + Math.sin(angle) * radius * 0.94)
        context.stroke()
      }
      const angle = up - swing + Math.min(1, kept.at[meter]) * swing * 2
      context.strokeStyle = theme.text
      context.lineWidth = Math.max(1.2, radius * 0.05)
      context.beginPath()
      context.moveTo(x, y)
      context.lineTo(x + Math.cos(angle) * radius * 0.9, y + Math.sin(angle) * radius * 0.9)
      context.stroke()
      context.fillStyle = theme.text
      context.beginPath()
      context.arc(x, y, Math.max(1.5, radius * 0.08), 0, Math.PI * 2)
      context.fill()
    }
  } else if (style === 'Pixel rain') {
    // Falling columns: a louder band falls faster with a longer tail.
    const columns = spread(bands, Math.max(4, Math.min(bands.length, Math.floor(wide / 5))))
    const cell = wide / columns.length
    const size = Math.max(2, Math.min(8, cell - 1))
    const rows = Math.max(4, Math.floor(full / (size + 1)))
    const row = full / rows
    const kept = remember(canvas, key, () => ({ head: [] }))

    columns.forEach((value, i) => {
      const part = level(value)
      const tail = Math.round(3 + part * rows * 0.7)
      let head = (kept.head[i] ?? Math.random() * rows) + 0.08 + part * 0.9

      if (head - tail > rows) {
        // Off the bottom: a sounding band starts again from the top, a silent one waits.
        head = part > 0.04 ? -Math.random() * rows * 0.3 : rows + tail + 1
      }
      kept.head[i] = head
      const colour = isRainbow ? hue(Math.floor((i * bands.length) / columns.length)) : part >= 0.6 ? stops[1] : stops[0]

      for (let n = 0; n <= tail; n += 1) {
        const at = Math.floor(head) - n

        if (at >= 0 && at < rows) {
          context.globalAlpha = n === 0 ? 1 : Math.max(0.06, (1 - n / tail) * 0.7)
          context.fillStyle = n === 0 ? theme.text : colour
          context.fillRect(pad + i * cell + (cell - size) / 2, pad + at * row, size, Math.max(2, row - 1))
        }
      }
    })
    context.globalAlpha = 1
  } else {
    // Dots: one for each band's level, with a fainter trail beneath.
    bands.forEach((value, i) => {
      const [x, y] = points[i]
      const size = Math.max(1.5, Math.min(pitch / 2 - 1, 4))
      context.fillStyle = byLevel(level(value), i)
      context.globalAlpha = 0.25
      context.fillRect(x - 0.5, y, 1, floor - y)
      context.globalAlpha = 1
      context.beginPath()
      context.arc(x, Math.min(y, floor - size), size, 0, Math.PI * 2)
      context.fill()
    })
  }
  context.shadowBlur = 0

  if (tall !== full) {
    // The reflection: the picture upside down under itself, faint.
    context.save()
    context.globalAlpha = 0.22
    context.translate(0, floor * 2)
    context.scale(1, -1)
    context.drawImage(canvas, 0, floor - (full - tall), width, full - tall, 0, floor - (full - tall), width, full - tall)
    context.restore()
  }
}

/**
 * The spectrum's menu, at the pointer: every look, the colours, how many
 * bands, and the switches. `onChange` runs after each choice.
 */
export const openSpectrumMenu = (event, onChange) => {
  document.querySelector('.spec-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'spec-menu'
  const chosen = spectrumOptions()

  const group = (title, names, current, pick) => {
    const box = document.createElement('div')
    box.className = 'spec-group'
    const head = document.createElement('div')
    head.className = 'spec-head'
    head.textContent = title
    box.append(head)

    for (const name of names) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `spec-row${name === current ? ' on' : ''}`
      row.textContent = name
      row.addEventListener('click', () => {
        pick(name)
        onChange()
        openSpectrumMenu(event, onChange)
      })
      box.append(row)
    }

    return box
  }
  const switches = document.createElement('div')
  switches.className = 'spec-group'
  const head = document.createElement('div')
  head.className = 'spec-head'
  head.textContent = 'Extras'
  switches.append(head)

  for (const [key, label] of [
    ['peaks', 'Peak marks'],
    ['glow', 'Glow'],
    ['centre', 'Loudest in the middle'],
    ['reflect', 'Reflection'],
    ['grid', 'Grid lines'],
  ]) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `spec-row tick${chosen[key] ? ' on' : ''}`
    row.textContent = label
    row.addEventListener('click', () => {
      setSpectrumOption(key, !spectrumOptions()[key])
      onChange()
      openSpectrumMenu(event, onChange)
    })
    switches.append(row)
  }
  const effects = document.createElement('div')
  effects.className = 'spec-sub'
  const effectsHead = document.createElement('div')
  effectsHead.className = 'spec-head'
  effectsHead.textContent = 'Effects'
  effects.append(effectsHead)

  for (const [key, label] of EFFECTS) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `spec-row tick${isEffectOn(key) ? ' on' : ''}`
    row.textContent = label
    row.addEventListener('click', () => {
      setSpectrumOption(key, !isEffectOn(key))
      onChange()
      openSpectrumMenu(event, onChange)
    })
    effects.append(row)
  }
  switches.append(effects)
  menu.append(
    group('Look', STYLES, spectrumStyle(), setSpectrumStyle),
    group('Colours', COLOURS, chosen.colours, name => setSpectrumOption('colours', name)),
    group('Bands', BANDS, chosen.bands, name => setSpectrumOption('bands', name)),
    switches,
  )
  document.body.append(menu)
  // Kept inside the window.
  const box = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - box.width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - box.height - 4))}px`

  const close = closing => {
    if (closing.type === 'keydown' ? closing.key === 'Escape' : !menu.contains(closing.target)) {
      menu.remove()
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', close, true)
    }
  }
  document.addEventListener('pointerdown', close, true)
  document.addEventListener('keydown', close, true)
}
