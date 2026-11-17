# Run by Cla-Amp as it closes, and waited for: makes sure the browsers that
# belong to Cla-Amp are closed too.
#
# Only a browser that was started with one of Cla-Amp's own profile folders
# (CA_PROFILE: the players', CA_PAGES: its own browser's) is touched. The
# person's everyday browser has another profile folder and is never one of
# them. Whatever is there is stopped at once, with every process it
# started. They are never asked to close: a player that is playing answers
# that with its own "Leave app?" box and stays open.
$dirs = @($env:CA_PROFILE, $env:CA_PAGES) | Where-Object { [string]$_ -ne '' }
if ($dirs.Count -eq 0) { exit }

# What happened at the last close, in one small file that is written over
# each time: when, and how many browsers were found and stopped. No address,
# title or anything else of what was open goes in it.
function Note($text) {
  if ([string]$env:CA_LOG -ne '') {
    try { Add-Content -LiteralPath $env:CA_LOG -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $text) -Encoding utf8 } catch {}
  }
}
if ([string]$env:CA_LOG -ne '') { try { Set-Content -LiteralPath $env:CA_LOG -Value '' -Encoding utf8 } catch {} }
Note 'Cla-Amp closed; looking for its browsers'

function Own-Browsers {
  $all = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='brave.exe' OR Name='chrome.exe'"
  foreach ($one in $all) {
    $line = [string]$one.CommandLine
    # The browser's first process: the others (--type=...) go with it.
    if ($line.Contains('--type=')) { continue }
    foreach ($dir in $dirs) { if ($line.Contains($dir)) { [int]$one.ProcessId; break } }
  }
}

$left = @(Own-Browsers)
if ($left.Count -eq 0) { Note 'none was open'; exit }
Note "open: $($left.Count); stopping them"
foreach ($id in $left) {
  & "$env:SystemRoot\System32\taskkill.exe" /PID $id /T /F | Out-Null
}
Start-Sleep -Milliseconds 300
Note "open after stopping: $(@(Own-Browsers).Count)"
