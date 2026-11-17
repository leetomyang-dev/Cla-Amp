# Keeps the music player's browser window, and Cla-Amp's browser, attached
# to the Cla-Amp window.
#
# Two browsers can be followed. Cla-Amp's own browser (Chrome when it is
# installed) has a profile of its own: its ordinary window with tabs is the
# Browser, and its windows without tabs are the players and claude.ai. A
# player opened in Edge or Brave has a second profile of its own. This helper only moves, shows, hides and closes
# those windows; it reads only a window's title (to tell the YouTube Music
# window from the Spotify one), never what is in it, and it touches no other
# window: only top-level browser windows of the two browser processes that
# were started with those profile folders.
#
# In:  CA_PROFILE  the player's profile folder
#      CA_PAGES    the profile folder of Cla-Amp's browser
#      CA_OWNER    the Cla-Amp window's handle, as a number
# Commands, one per line on standard input:
#   find           the browser was just started: look for its window for a while
#   place x y w h  where the player goes, in screen pixels
#   hide | show    tuck the player away (the music keeps playing) or bring it back
#   site ytm|spotify|claude|pages  which window is wanted on show; the others stay tucked away
#   close          close the player's windows
#   release        let go of the player and stop, leaving it open (app restart)
# When standard input ends (Cla-Amp is gone) the player is closed.
# Out: a line '#width N' when the person has dragged the window on show to a
# new width (N in screen pixels), so Cla-Amp can make room for it; and
# lines of '@' + JSON: { count, hidden, shown, sites }; shown = windows on show now,
# sites = which windows are open (ytm, spotify, claude, pages).

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PlayerWin {
  delegate bool EachWindow(IntPtr window, IntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EachWindow each, IntPtr extra);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int most);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int how);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr a, IntPtr b);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int which, out Rect rect, int size);

  const int OWNER = -8;

  // Real pixels on every screen, whatever its scaling.
  static void Pixels() { try { SetThreadDpiAwarenessContext((IntPtr)(-4)); } catch { } }

  // The browser windows of one process: on show, or ones this helper hid.
  public static List<long> Windows(uint processId, long[] known, bool tabsToo, bool hiddenToo) {
    var found = new List<long>();
    var mine = new HashSet<long>(known);
    EnumWindows((window, extra) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner != processId) { return true; }
      var name = new StringBuilder(64);
      GetClassName(window, name, 64);
      if (name.ToString() != "Chrome_WidgetWin_1" || GetWindowTextLength(window) == 0) { return true; }
      // Real windows only (ones with a sizing frame), not the browser's small helper windows.
      long style = GetWindowLongPtr(window, -16).ToInt64(), more = GetWindowLongPtr(window, -20).ToInt64();
      if ((style & 0x00040000) == 0 || (more & 0x00000080) != 0) { return true; }
      // The player's own windows have no tabs; an ordinary browser window
      // (its title ends with the browser's name) is left alone.
      var title = new StringBuilder(300);
      GetWindowText(window, title, 300);
      string shown = title.ToString();
      if (!tabsToo && shown.Contains(" - ") && (shown.EndsWith("Edge") || shown.EndsWith("Brave") || shown.EndsWith("Chrome"))) { return true; }
      // A window that is not on show counts when it is one of ours already, or
      // (hiddenToo) while a browser left running is being taken back at the start.
      if (IsWindowVisible(window) || hiddenToo || mine.Contains(window.ToInt64())) { found.Add(window.ToInt64()); }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Makes the player belong to the Cla-Amp window: it stays in front of
  // it, minimises with it and has no taskbar button of its own.
  public static bool Attach(long window, long owner) {
    var w = (IntPtr)window;
    if (GetWindowLongPtr(w, OWNER) == (IntPtr)owner) { return true; }
    bool wasShown = IsWindowVisible(w);
    if (wasShown) { ShowWindow(w, 0); }
    SetWindowLongPtr(w, OWNER, (IntPtr)owner);
    if (wasShown) { ShowWindow(w, 8); }
    return GetWindowLongPtr(w, OWNER) == (IntPtr)owner;
  }

  // Puts the window's visible frame exactly on the rectangle given.
  public static void Place(long window, int x, int y, int w, int h) {
    Pixels();
    var win = (IntPtr)window;
    if (IsIconic(win) || IsZoomed(win)) { ShowWindow(win, 4); }
    Rect whole, frame;
    int left = 0, top = 0, right = 0, bottom = 0;
    if (GetWindowRect(win, out whole) && DwmGetWindowAttribute(win, 9, out frame, 16) == 0) {
      left = frame.Left - whole.Left; top = frame.Top - whole.Top;
      right = whole.Right - frame.Right; bottom = whole.Bottom - frame.Bottom;
      if (left < 0 || left > 40 || right < 0 || right > 40 || top < 0 || top > 40 || bottom < 0 || bottom > 40) { left = top = right = bottom = 0; }
    }
    SetWindowPos(win, IntPtr.Zero, x - left, y - top, w + left + right, h + top + bottom, 0x0004 | 0x0010);
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int most);
  public static string Title(long window) {
    var text = new StringBuilder(120); GetWindowText((IntPtr)window, text, 120);
    Rect r; GetWindowRect((IntPtr)window, out r);
    return text + " [" + (r.Right - r.Left) + "x" + (r.Bottom - r.Top) + " at " + r.Left + "," + r.Top + "]";
  }
  // An ordinary browser window, with tabs: its title ends with the browser's name.
  public static bool IsTabbed(long window) {
    string shown = Name(window);
    return shown.EndsWith("Google Chrome") || (shown.Contains(" - ") && (shown.EndsWith("Edge") || shown.EndsWith("Brave") || shown.EndsWith("Chrome")));
  }
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  // True while the main mouse button is held: a window may be mid-drag.
  public static bool MouseDown() { return (GetAsyncKeyState(1) & 0x8000) != 0; }
  // The width of a window's visible frame, in screen pixels; 0 when it is minimised or maximised.
  public static int FrameWidth(long window) {
    Pixels();
    var win = (IntPtr)window;
    if (IsIconic(win) || IsZoomed(win) || !IsWindowVisible(win)) { return 0; }
    Rect frame;
    if (DwmGetWindowAttribute(win, 9, out frame, 16) != 0) { return 0; }
    return frame.Right - frame.Left;
  }
  public static string Name(long window) { var text = new StringBuilder(300); GetWindowText((IntPtr)window, text, 300); return text.ToString(); }
  public static void Show(long window, bool isShown) { ShowWindow((IntPtr)window, isShown ? 8 : 0); }
  public static void Close(long window) { PostMessage((IntPtr)window, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@

$playerDir = [string]$env:CA_PROFILE
$pagesDir = [string]$env:CA_PAGES
$owner = [long]$env:CA_OWNER
# One table holds the state, changed in place: this file is run as a block of
# text, where a function cannot assign to the variables outside it.
# browser: process id of the player's browser (0 when not known); windows: its
# windows, as numbers; rect: x, y, w, h.
# site: the player wanted on show; sites: which player each window is; shown: how things were last arranged.
# pages: process id of Cla-Amp's browser; pageWins: its windows.
# baseWidth: how wide the window on show was after it was last put in place (0: not looked at yet).
$s = @{ baseWidth = 0; pages = 0; pageWins = @(); browser = 0; windows = @(); hidden = $false; rect = $null; lookUntil = [DateTime]::MinValue; startUntil = [DateTime]::MinValue; said = ''; site = 'ytm'; sites = @{}; shown = '' }

# The one browser process started with a profile folder of this app's.
function Find-Browser($dir) {
  if ([string]$dir -eq '') { return 0 }
  $all = Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='brave.exe' OR Name='chrome.exe'"
  foreach ($one in $all) {
    $line = [string]$one.CommandLine
    if ($line.Contains($dir) -and -not $line.Contains('--type=')) { return [int]$one.ProcessId }
  }
  return 0
}

function Say {
  $shown = 0
  if (-not $s.hidden) { foreach ($one in $s.windows) { if ((Site-Of $one) -eq $s.site) { $shown += 1 } } }
  $open = @($s.windows | ForEach-Object { '"' + (Site-Of $_) + '"' }) -join ','
  $text = '{"count":' + $s.windows.Count + ',"hidden":' + $(if ($s.hidden) { 'true' } else { 'false' }) + ',"shown":' + $shown + ',"sites":[' + $open + ']}'
  if ($text -ne $s.said) {
    $s.said = $text
    [Console]::Out.WriteLine('@' + $text)
    [Console]::Out.Flush()
  }
}

# Which player a window is, by its title. A title that says neither (a song's
# name while Spotify plays) keeps what the window was before; a window never
# told apart counts as the player that was wanted when it appeared.
function Site-Of($one) {
  # The window with tabs of Cla-Amp's browser is the Browser; its windows without tabs are told apart below.
  if (($s.pageWins -contains $one) -and [PlayerWin]::IsTabbed($one)) { return 'pages' }
  $name = [PlayerWin]::Name($one)
  if ($name -like '*YouTube Music*') { $s.sites[$one] = 'ytm' }
  elseif ($name -like '*Spotify*') { $s.sites[$one] = 'spotify' }
  elseif ($name -like '*Claude*') { $s.sites[$one] = 'claude' }
  elseif (-not $s.sites.ContainsKey($one)) { $s.sites[$one] = $s.site }
  return $s.sites[$one]
}

# Shows the wanted player's window in its place and tucks every other away.
function Arrange($isForced) {
  $plan = "$($s.hidden)|$($s.site)|" + (($s.windows | ForEach-Object { "$_=$(Site-Of $_)" }) -join ',')
  if (-not $isForced -and $plan -eq $s.shown) { return }
  $s.shown = $plan
  $s.baseWidth = 0
  foreach ($one in $s.windows) {
    if ($s.hidden -or (Site-Of $one) -ne $s.site) { [PlayerWin]::Show($one, $false) }
    else {
      [PlayerWin]::Show($one, $true)
      if ($s.rect) { [PlayerWin]::Place($one, $s.rect[0], $s.rect[1], $s.rect[2], $s.rect[3]) }
    }
  }
}

# Looks at the player's windows: takes in new ones, forgets closed ones.
function Look {
  if ($s.browser -ne 0 -and $null -eq (Get-Process -Id $s.browser)) { $s.browser = 0 }
  if ($s.browser -eq 0 -and [DateTime]::Now -lt $s.lookUntil) { $s.browser = Find-Browser $playerDir }
  if ($s.pages -ne 0 -and $null -eq (Get-Process -Id $s.pages)) { $s.pages = 0 }
  if ($s.pages -eq 0 -and [DateTime]::Now -lt $s.lookUntil) { $s.pages = Find-Browser $pagesDir }
  $now = @()
  # At the start, a browser of Cla-Amp's own that was left running (the app
  # was closed and its browser lived on) is taken back with all its windows,
  # tucked-away ones too, so the deck knows of them and can show or close them.
  $isStart = [DateTime]::Now -lt $s.startUntil
  if ($s.browser -ne 0) { $now = @([PlayerWin]::Windows([uint32]$s.browser, [long[]]$s.windows, $false, $isStart)) }
  # Cla-Amp's browser is an ordinary window with tabs: those count too.
  $pagesNow = @()
  if ($s.pages -ne 0) { $pagesNow = @([PlayerWin]::Windows([uint32]$s.pages, [long[]]$s.windows, $true, $isStart)) }
  $s.pageWins = $pagesNow
  $now = @($now) + @($pagesNow)
  # One claude.ai window at a time: a link opened from a chat takes the place
  # of the claude.ai window that was there. Two in one spot lie over each other.
  # Only windows whose title says Claude: a player whose title is a song's name is never taken for one.
  $claudeAll = @($now | Where-Object { -not [PlayerWin]::IsTabbed($_) -and [PlayerWin]::Name($_) -like '*Claude*' })
  $claudeNew = @($claudeAll | Where-Object { $s.windows -notcontains $_ })
  if ($claudeNew.Count -gt 0 -and $claudeAll.Count -gt 1) {
    $keep = $claudeNew[$claudeNew.Count - 1]
    foreach ($old in @($claudeAll | Where-Object { $_ -ne $keep })) { [PlayerWin]::Close($old) }
  }
  # One window per music player too: two in one spot lie over each other and
  # take turns in front. The one that was already here stays (it may be the
  # one playing); the newcomer is closed. Only windows whose title names the
  # player: a sign-in window or any other the player opens is left alone.
  foreach ($word in @('*YouTube Music*', '*Spotify*')) {
    $same = @($now | Where-Object { -not [PlayerWin]::IsTabbed($_) -and [PlayerWin]::Name($_) -like $word })
    if ($same.Count -gt 1) {
      $known = @($same | Where-Object { $s.windows -contains $_ })
      $keep = if ($known.Count -gt 0) { $known[0] } else { $same[0] }
      foreach ($extra in @($same | Where-Object { $_ -ne $keep })) { [PlayerWin]::Close($extra) }
      $now = @($now | Where-Object { $_ -eq $keep -or $same -notcontains $_ })
    }
  }
  foreach ($one in $now) {
    if ($s.windows -notcontains $one) {
      if ($owner -ne 0) { [void][PlayerWin]::Attach($one, $owner) }
    }
  }
  if ($env:CA_DEBUG -and $now.Count -ne $s.windows.Count) { foreach ($one in $now) { [Console]::Error.WriteLine('window: ' + [PlayerWin]::Title($one)) } }
  if ($env:CA_DEBUG) { [Console]::Error.WriteLine('look: browser=' + $s.browser + ' pages=' + $s.pages + ' now=' + ($now -join ',') + ' known=' + ($s.windows -join ',')) }
  $s.windows = $now
  foreach ($gone in @($s.sites.Keys | Where-Object { $now -notcontains $_ })) { $s.sites.Remove($gone) }
  Arrange $false
  # The person dragged the window on show wider or narrower: say so, once the mouse is let go.
  if ($s.rect -and -not $s.hidden -and -not [PlayerWin]::MouseDown()) {
    foreach ($one in $s.windows) {
      if ((Site-Of $one) -ne $s.site) { continue }
      $wide = [PlayerWin]::FrameWidth($one)
      if ($wide -le 0) { break }
      # The width right after placing is what later widths are held against: a
      # browser that will not go as narrow as asked is not a drag.
      if ($s.baseWidth -eq 0) { $s.baseWidth = $wide; break }
      if ([Math]::Abs($wide - $s.baseWidth) -gt 6) {
        $s.baseWidth = $wide
        if ($env:CA_DEBUG) { [Console]::Error.WriteLine('dragged: ' + $wide + ' placed ' + $s.rect[2]) }
        [Console]::Out.WriteLine('#width ' + $wide)
        [Console]::Out.Flush()
      }
      break
    }
  }
  Say
}

# Closes the docked windows, hidden ones too, by stopping their browser. Only
# the browser processes that were started with this app's own profile folders.
function Shut {
  # The windows are tucked away at once, then their browser is stopped with
  # every process it started. They are not asked to close: a player that is
  # playing answers that with its own "Leave app?" box and stays open.
  foreach ($one in $s.windows) { [PlayerWin]::Show($one, $false) }
  if ($s.browser -eq 0) { $s.browser = Find-Browser $playerDir }
  if ($s.pages -eq 0) { $s.pages = Find-Browser $pagesDir }
  foreach ($key in @('browser', 'pages')) {
    if ($s[$key] -eq 0) { continue }
    if ($null -ne (Get-Process -Id $s[$key] -ErrorAction SilentlyContinue)) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID $s[$key] /T /F | Out-Null
    }
    $s[$key] = 0
  }
  $s.windows = @()
}

function Let-Go {
  foreach ($one in $s.windows) {
    [void][PlayerWin]::Attach($one, 0)
    [PlayerWin]::Show($one, $true)
  }
}

# A look at the start: a player left open over an app restart, or left
# running when the app was closed, is taken back.
$s.lookUntil = [DateTime]::Now.AddSeconds(15)
$s.startUntil = $s.lookUntil
# Read through a plain stream: the console's own reader would block the loop.
$reader = New-Object IO.StreamReader([Console]::OpenStandardInput())
$line = $reader.ReadLineAsync()

while ($true) {
  if ($line.Wait(1000)) {
    $text = $line.Result
    if ($null -eq $text) {
      Shut
      break
    }
    $line = $reader.ReadLineAsync()
    $parts = $text.Trim() -split ' '
    switch ($parts[0]) {
      'find' { $s.lookUntil = [DateTime]::Now.AddSeconds(40) }
      'place' {
        if ($parts.Count -eq 5) {
          $s.rect = @([int]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4])
          if ($env:CA_DEBUG) { [Console]::Error.WriteLine('place: ' + ($s.rect -join ' ')) }
          Arrange $true
        }
        continue
      }
      'hide' { $s.hidden = $true; Arrange $true }
      'site' { if ($parts.Count -eq 2 -and (@('ytm', 'spotify', 'claude', 'pages') -contains $parts[1])) { $s.site = $parts[1]; Arrange $true } }
      'show' {
        $s.hidden = $false
        Arrange $true
      }
      'close' { Shut }
      'release' { Let-Go; exit }
    }
  }
  Look
}
