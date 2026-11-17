// Telling the person, who may be looking elsewhere, that a chat wants them:
// - the taskbar button flashes when a chat is done or waits for an answer
//   and Cla-Amp is not the window in front (it stops when they come back)
// - a short chime sounds when a chat is done
// Both can be switched off under Widgets (Notices). The chime is made here
// from two plain tones: no sound file, nothing from outside.

/** The person's choice: 'all' (flash and chime), 'flash' (no sound) or 'off'. */
export const noticeChoice = () => ({ flash: 'flash', off: 'off' })[localStorage.getItem('notices')] ?? 'all'

export const setNotices = choice => {
  if (choice === 'flash' || choice === 'off') {
    localStorage.setItem('notices', choice)
  } else {
    localStorage.removeItem('notices')
  }
}

let sound = null

// One soft bell note: a sine with a quieter octave above it, fading out.
const note = (at, pitch, loud, long) => {
  const out = sound.createGain()
  out.gain.setValueAtTime(0.0001, at)
  out.gain.exponentialRampToValueAtTime(loud, at + 0.012)
  out.gain.exponentialRampToValueAtTime(0.0001, at + long)
  out.connect(sound.destination)

  for (const [times, share] of [[1, 1], [2, 0.28], [3, 0.08]]) {
    const tone = sound.createOscillator()
    const part = sound.createGain()
    tone.type = 'sine'
    tone.frequency.value = pitch * times
    part.gain.value = share
    tone.connect(part).connect(out)
    tone.start(at)
    tone.stop(at + long + 0.05)
  }
}

/** The chime for a chat that is done: two rising notes, a fifth apart. A lower, single pair when it ended with an error. */
export const chime = (isOk = true) => {
  if (noticeChoice() !== 'all') {
    return
  }

  try {
    sound ??= new AudioContext()
    void sound.resume()
    const at = sound.currentTime + 0.02
    // The spectrum listens to the speakers: it is told, so the chime does not make it dance.
    document.dispatchEvent(new CustomEvent('own-sound', { detail: 2200 }))

    if (isOk) {
      note(at, 659.25, 0.16, 0.9)
      note(at + 0.14, 987.77, 0.14, 1.3)
    } else {
      note(at, 392, 0.15, 0.7)
      note(at + 0.16, 311.13, 0.13, 1.1)
    }
  } catch {
    // No sound device: the flash still tells.
  }
}

/** Flashes the taskbar button, when Cla-Amp is not the window in front. */
export const flash = () => {
  if (noticeChoice() !== 'off') {
    // An older main process (before a restart) does not know this call.
    void window.amp.call('win:flash').catch(() => {})
  }
}
