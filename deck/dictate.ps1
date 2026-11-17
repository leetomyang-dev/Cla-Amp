# Cla-Amp's dictation: turns speech into text for the message box.
# Started when the microphone button is switched on and killed when it is
# switched off. It uses Windows' own built-in speech recogniser, which works
# on this computer without the internet. Nothing is recorded, kept or sent
# anywhere: each recognised phrase leaves as one line `@{json}` on standard
# output and is forgotten.
# It stops by itself after a minute with no speech, so the microphone is
# never left open by accident.
# For tests, $env:CA_WAV names a sound file to listen to instead of the
# microphone.
$ErrorActionPreference = 'Stop'

function Say($thing) {
  # Letters outside plain ASCII go as \uXXXX, so they arrive whole whatever code page this hidden console has.
  [Console]::Out.WriteLine('@' + [regex]::Replace(($thing | ConvertTo-Json -Compress), '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Speech
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))

  if ($env:CA_WAV) {
    $engine.SetInputToWaveFile($env:CA_WAV)
  } else {
    $engine.SetInputToDefaultAudioDevice()
  }
} catch {
  Say @{ error = 'Dictation could not start. Windows needs a speech recogniser for your language and a working microphone.' }
  exit 1
}

Say @{ ready = $true }
$quietSince = Get-Date

while ($true) {
  $heard = $null

  try {
    $heard = $engine.Recognize([TimeSpan]::FromSeconds(4))
  } catch {
    Say @{ error = 'The microphone stopped answering.' }
    break
  }

  if ($null -ne $heard -and $heard.Text) {
    $quietSince = Get-Date
    Say @{ text = [string]$heard.Text }
  } elseif ($env:CA_WAV) {
    # A sound file has an end.
    break
  } elseif (((Get-Date) - $quietSince).TotalSeconds -gt 60) {
    break
  }
}

Say @{ done = $true }
$engine.Dispose()
