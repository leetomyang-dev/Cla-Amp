// The equalizer: a preamp and ten bands, as on Winamp's. To shape the sound
// the song has to pass through this window, so songs from My files are
// played here (the file's bytes come from the main process, for songs in the
// music library only) instead of by the deck's helper. A kind of file this
// window cannot play goes to the helper as before, without the equalizer.
// YouTube Music and Spotify play in their own browser window, out of reach.

const call = (name, ...args) => window.amp.call(name, ...args)
const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text

  return node
}

const BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000]
const LABELS = ['60', '170', '310', '600', '1K', '3K', '6K', '12K', '14K', '16K']
/** Each: preamp, then the ten bands, in decibels (-12 to 12). */
const PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock: [0, 5, 3, -3, -5, -2, 2, 5, 7, 7, 7],
  Pop: [0, -1, 3, 4, 5, 3, 0, -1, -1, -1, -1],
  Jazz: [0, 3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  Classical: [0, 0, 0, 0, 0, 0, 0, -4, -4, -4, -6],
  Dance: [0, 6, 4, 1, 0, 0, -3, -4, -4, 0, 0],
  'Full bass': [0, 6, 6, 6, 3, 1, -2, -5, -6, -7, -7],
  'Full treble': [0, -6, -6, -6, -2, 2, 7, 10, 10, 10, 11],
  'Bass and treble': [0, 5, 4, 0, -4, -3, 1, 5, 7, 8, 8],
  Vocal: [0, -3, -2, 0, 3, 5, 5, 3, 1, 0, -1],
  Soft: [0, 3, 1, 0, -1, 0, 2, 5, 6, 7, 8],
  Live: [0, -3, 0, 2, 3, 3, 3, 2, 1, 1, 1],
}
const KINDS = { mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm' }

const clamp = value => Math.max(-12, Math.min(12, Number(value) || 0))

const load = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('equalizer') ?? '{}')
    const gains = Array.isArray(saved.gains) && saved.gains.length === 11 ? saved.gains.map(clamp) : [...PRESETS.Flat]

    return { isOn: saved.isOn !== false, preset: typeof saved.preset === 'string' ? saved.preset : 'Flat', gains }
  } catch {
    return { isOn: true, preset: 'Flat', gains: [...PRESETS.Flat] }
  }
}

const settings = load()
const save = () => localStorage.setItem('equalizer', JSON.stringify(settings))

// Two players take turns, so one song can follow another without a gap, as
// on a CD: while one plays, the other holds the next song, loaded and still,
// and starts as the first one reaches its end.
const makePlayer = () => {
  const one = new Audio()
  one.preload = 'auto'

  return one
}
let audio = makePlayer()
let spare = makePlayer()
/** The address each player's song was given, to be let go of after. */
const addresses = new Map()
/** What the spare holds: the song, and whether it can be played. */
let ahead = { song: '', isGood: false }
let fetching = ''
let swapTimer = null
/** How long before the end the next song is started, to cover the moment a player takes to sound. */
const LEAD_MS = 30
let context = null
let preamp = null
let filters = []

const give = (player, bytes, kind) => {
  URL.revokeObjectURL(addresses.get(player) ?? '')
  addresses.set(player, URL.createObjectURL(new Blob([bytes], { type: kind })))
  player.src = addresses.get(player)
}

const empty = player => {
  player.pause()
  player.removeAttribute('src')
  player.load()
  URL.revokeObjectURL(addresses.get(player) ?? '')
  addresses.delete(player)
}

const dropAhead = () => {
  clearTimeout(swapTimer)
  swapTimer = null
  fetching = ''

  if (ahead.song !== '') {
    empty(spare)
  }
  ahead = { song: '', isGood: false }
}

/** The song held ready takes over. False when there is none, or the song is no longer at its end. */
const swap = () => {
  clearTimeout(swapTimer)
  swapTimer = null
  const left = audio.duration - audio.currentTime

  if (!ahead.isGood || tuner.state !== 'playing' || !(left < 0.3)) {
    return false
  }

  const old = audio
  audio = spare
  spare = old
  void audio.play().catch(() => {})
  tuner.song = ahead.song
  ahead = { song: '', isGood: false }
  // The old player sounds its last moment, then lets go of its song.
  setTimeout(() => {
    if (spare === old && ahead.song === '') {
      empty(old)
    }
  }, 600)
  tuner.onSwap?.(tuner.song)

  return true
}

/** Built on the first song: the sound path song, preamp, ten bands, speakers. */
const wire = () => {
  if (context !== null) {
    return
  }

  context = new AudioContext()
  preamp = context.createGain()

  for (const player of [audio, spare]) {
    context.createMediaElementSource(player).connect(preamp)
  }
  filters = BANDS.map((frequency, index) => {
    const filter = context.createBiquadFilter()
    filter.type = index === 0 ? 'lowshelf' : index === BANDS.length - 1 ? 'highshelf' : 'peaking'
    filter.frequency.value = frequency
    filter.Q.value = 1.1

    return filter
  })
  ;[preamp, ...filters, context.destination].reduce((from, to) => (from.connect(to), to))
  tune()
}

/** Puts the sliders' values on the sound path. Off: everything flat. */
const tune = () => {
  if (context === null) {
    return
  }

  const gains = settings.isOn ? settings.gains : PRESETS.Flat
  preamp.gain.value = 10 ** (gains[0] / 20)
  filters.forEach((filter, index) => (filter.gain.value = gains[index + 1]))
}

/** What app.js reads in place of the helper's status while a song plays here. */
export const tuner = {
  isOn: false,
  state: 'stopped',
  isEnded: false,
  song: '',
  /** Called with the song's file when the song held ready has taken over by itself. */
  onSwap: null,
  get pos() {
    return Number.isFinite(audio.currentTime) ? audio.currentTime : 0
  },
  get dur() {
    return Number.isFinite(audio.duration) ? audio.duration : 0
  },
  /** True once, after a song ran to its end. */
  takeEnded() {
    const was = this.isEnded
    this.isEnded = false

    return was
  },
  /**
   * Offered every deck command before the helper gets it. True: handled here,
   * the helper is not told.
   */
  async take(command, argument) {
    if (command === 'open') {
      return this.open(String(argument))
    }

    if (command === 'vol') {
      audio.volume = Math.max(0, Math.min(1, Number(argument) || 0))
      spare.volume = audio.volume

      return false
    }

    if (!this.isOn) {
      return false
    }

    if (command === 'pause') {
      audio.pause()
      this.state = 'paused'
    } else if (command === 'resume') {
      void call('deck:cmd', 'hush')
      void audio.play()
      this.state = 'playing'
    } else if (command === 'stop') {
      this.unload()
    } else if (command === 'seek') {
      audio.currentTime = Number(argument) || 0
    } else {
      // The other players are being driven: this one steps aside.
      if (command === 'web-toggle' && this.state === 'playing') {
        audio.pause()
        this.state = 'paused'
      }

      return false
    }

    return true
  },
  unload() {
    dropAhead()
    empty(audio)
    this.state = 'stopped'
    this.isOn = false
  },
  async open(file) {
    const kind = KINDS[file.split('.').pop().toLowerCase()]
    const bytes = kind ? await call('music:bytes', file) : null

    if (!bytes) {
      // Not a kind this window plays: the helper plays it, without the equalizer.
      this.unload()
      setNote('This kind of file plays without the equalizer.')

      return false
    }

    wire()
    void context.resume()
    dropAhead()
    give(audio, bytes, kind)
    this.song = file
    this.isOn = true
    this.isEnded = false
    this.state = 'playing'
    setNote('')
    // The helper's own player is stopped, and other apps' music paused, as it would do itself.
    void call('deck:cmd', 'stop')
    void call('deck:cmd', 'hush')
    void audio.play().catch(() => {})

    return true
  },
  /**
   * Gets the song that comes next loaded and still, so that it starts with no
   * gap when this one ends. Asked again with another song, that one replaces it.
   */
  async ready(file) {
    if (!this.isOn || file === ahead.song || file === fetching) {
      return
    }

    fetching = file
    const kind = KINDS[file.split('.').pop().toLowerCase()]
    const bytes = kind ? await call('music:bytes', file) : null

    if (fetching !== file || !this.isOn) {
      return
    }

    dropAhead()
    // A song this window cannot play is remembered too, so it is not asked for again; it starts the usual way.
    ahead = { song: file, isGood: !!bytes }

    if (bytes) {
      wire()
      spare.volume = audio.volume
      give(spare, bytes, kind)
    }
  },
}

for (const player of [audio, spare]) {
  player.addEventListener('timeupdate', () => {
    const left = player.duration - player.currentTime

    // Close to the end with the next song ready: it is started on the moment, a breath early.
    if (player === audio && ahead.isGood && swapTimer === null && tuner.state === 'playing' && left < 0.8) {
      swapTimer = setTimeout(swap, Math.max(0, left * 1000 - LEAD_MS))
    }
  })
  player.addEventListener('ended', () => {
    // The player that just handed over, or a timer that came late: the next song starts now.
    if (player !== audio || swap()) {
      return
    }

    tuner.state = 'stopped'
    tuner.isEnded = true
  })
  player.addEventListener('error', () => {
    if (player !== audio) {
      // The song held ready cannot be played here: it starts the usual way when its turn comes.
      ahead = { ...ahead, isGood: false }

      return
    }

    // The window could not read the song after all: hand it to the helper.
    if (tuner.isOn && tuner.song !== '') {
      const song = tuner.song
      tuner.unload()
      setNote('This song plays without the equalizer.')
      void call('deck:cmd', 'open', song)
    }
  })
}

// ------------------------------------------------------------------ the panel

let noteNode = null
const setNote = text => {
  if (noteNode) {
    noteNode.textContent = text || 'Shapes the sound of My files. YouTube Music and Spotify play in their own window, which the equalizer cannot reach.'
  }
}

/** Draws the equalizer into the box given: on/off, presets, preamp and ten sliders. */
export const buildEqualizer = box => {
  const head = el('div', 'eq-head')
  const on = el('label', 'check-row')
  const tick = el('input')
  tick.type = 'checkbox'
  tick.checked = settings.isOn
  on.append(tick, ' On')
  on.title = 'Switch the equalizer on or off. Off, the song plays as it is.'
  const presets = el('select', 'eq-presets')
  presets.title = 'Ready-made settings'

  for (const name of [...Object.keys(PRESETS), 'Custom']) {
    presets.append(new Option(name, name))
  }
  presets.value = settings.preset in PRESETS ? settings.preset : 'Custom'
  const reset = el('button', 'text-btn', 'Flat')
  reset.type = 'button'
  reset.title = 'Put every slider back to the middle'
  head.append(on, presets, reset)

  const bank = el('div', 'eq-bank')
  const sliders = ['PRE', ...LABELS].map((label, index) => {
    const column = el('label', `eq-col${index === 0 ? ' pre' : ''}`)
    const slider = el('input', 'eq-band')
    slider.type = 'range'
    slider.min = '-12'
    slider.max = '12'
    slider.step = '1'
    slider.value = String(settings.gains[index])
    slider.setAttribute('aria-label', index === 0 ? 'Preamp' : `${label} hertz`)
    const show = () => (slider.title = `${index === 0 ? 'Preamp' : label + ' Hz'}: ${Number(slider.value) > 0 ? '+' : ''}${slider.value} dB`)
    show()
    slider.addEventListener('input', () => {
      settings.gains[index] = clamp(slider.value)
      settings.preset = 'Custom'
      presets.value = 'Custom'
      show()
      tune()
      save()
    })
    // A double click puts one slider back to the middle.
    slider.addEventListener('dblclick', () => {
      slider.value = '0'
      slider.dispatchEvent(new Event('input'))
    })
    column.append(slider, el('span', 'eq-label', label))
    bank.append(column)

    return { slider, show }
  })
  const use = name => {
    settings.gains = [...PRESETS[name]]
    settings.preset = name
    presets.value = name
    sliders.forEach(({ slider, show }, index) => {
      slider.value = String(settings.gains[index])
      show()
    })
    tune()
    save()
  }

  tick.addEventListener('change', () => {
    settings.isOn = tick.checked
    bank.classList.toggle('off', !settings.isOn)
    tune()
    save()
  })
  presets.addEventListener('change', () => {
    if (presets.value in PRESETS) {
      use(presets.value)
    }
  })
  reset.addEventListener('click', () => use('Flat'))
  bank.classList.toggle('off', !settings.isOn)
  noteNode = el('div', 'player-note')
  setNote('')
  box.replaceChildren(head, bank, noteNode)
}
