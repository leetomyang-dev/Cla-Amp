# Cla-Amp's deck: one hidden process for the life of the mod.
# - plays a local file with Windows' media player (volume, seek, position)
# - listens to what the default speakers play and reports its level and its
#   frequency spectrum, twelve frames a second (nothing is recorded or kept)
# - reads and controls what another app is playing (a browser tab on YouTube
#   Music, say) through Windows' own media controls
# Commands arrive as lines `seq|command|argument` in the file $env:CA_CMD.
# Status leaves as lines `@{json}` on standard output.
$ErrorActionPreference = 'SilentlyContinue'
# One status line out. Every letter outside plain ASCII goes as \uXXXX, so a
# title in Chinese, Japanese, Korean, Thai, Arabic, with accents or with
# emoji arrives whole whatever code page this hidden console has.
function Say([string]$json) {
  [Console]::Out.WriteLine('@' + [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value }))
}
Add-Type -AssemblyName PresentationCore
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ClaAmp {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int NotImpl1();
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  }
  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
    [PreserveSig] int GetMeteringChannelCount(out int count);
    [PreserveSig] int GetChannelsPeakValues(int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] values);
  }
  [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long usual, out long least);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }
  [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong clockPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
  }
  // Listens to what the default speakers are playing (loopback: nothing is
  // recorded or kept) and answers how loud each band of frequencies is.
  public static class Spectrum {
    const int Size = 2048;
    static IAudioClient client;
    static IAudioCaptureClient capture;
    static int channels, rate, fresh, head, waits;
    static bool isFloat;
    static float[] ring = new float[4096];

    static void Open() {
      var all = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice device;
      if (all.GetDefaultAudioEndpoint(0, 1, out device) != 0) return;
      var iid = typeof(IAudioClient).GUID;
      object found;
      if (device.Activate(ref iid, 23, IntPtr.Zero, out found) != 0) return;
      var opened = (IAudioClient)found;
      IntPtr format;
      if (opened.GetMixFormat(out format) != 0) return;
      int tag = (ushort)Marshal.ReadInt16(format, 0);
      channels = Marshal.ReadInt16(format, 2);
      rate = Marshal.ReadInt32(format, 4);
      int bits = Marshal.ReadInt16(format, 14);
      isFloat = tag == 3 || (tag == 0xFFFE && bits == 32);
      // Shared mode, loopback, a fifth of a second of buffer.
      int result = opened.Initialize(0, 0x00020000, 2000000, 0, format, IntPtr.Zero);
      Marshal.FreeCoTaskMem(format);
      if (result != 0) return;
      var serviceId = typeof(IAudioCaptureClient).GUID;
      object service;
      if (opened.GetService(ref serviceId, out service) != 0) return;
      if (opened.Start() != 0) return;
      client = opened;
      capture = (IAudioCaptureClient)service;
    }

    // Moves what the speakers played since the last call into the ring.
    public static void Pump() {
      try {
        if (capture == null) {
          if (waits-- > 0) return;
          waits = 50;
          Open();
          if (capture == null) return;
        }
        while (true) {
          uint frames;
          if (capture.GetNextPacketSize(out frames) != 0) { capture = null; client = null; return; }
          if (frames == 0) return;
          IntPtr data; uint got, flags; ulong at, clock;
          if (capture.GetBuffer(out data, out got, out flags, out at, out clock) != 0) { capture = null; client = null; return; }
          int count = (int)got * channels;
          if ((flags & 2) == 0 && isFloat && count > 0) {
            var block = new float[count];
            Marshal.Copy(data, block, 0, count);
            for (int i = 0; i < (int)got; i++) {
              float sum = 0;
              for (int c = 0; c < channels; c++) sum += block[i * channels + c];
              ring[head] = sum / channels;
              head = (head + 1) & 4095;
            }
          } else {
            for (int i = 0; i < (int)got; i++) { ring[head] = 0; head = (head + 1) & 4095; }
          }
          fresh += (int)got;
          capture.ReleaseBuffer(got);
        }
      } catch {
        capture = null; client = null;
      }
    }

    static void Transform(double[] re, double[] im) {
      int n = re.Length;
      for (int i = 1, j = 0; i < n; i++) {
        int bit = n >> 1;
        for (; (j & bit) != 0; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (int len = 2; len <= n; len <<= 1) {
        double angle = -2 * Math.PI / len;
        double wr = Math.Cos(angle), wi = Math.Sin(angle);
        for (int i = 0; i < n; i += len) {
          double cr = 1, ci = 0;
          for (int k = 0; k < len / 2; k++) {
            int a = i + k, b = i + k + len / 2;
            double xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
            re[b] = re[a] - xr; im[b] = im[a] - xi;
            re[a] += xr; im[a] += xi;
            double nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
          }
        }
      }
    }

    // The loudness of `count` bands from 50 Hz to 16 kHz, each 0 to 1 over
    // -66 to -6 dB; all zero when nothing has played since the last call.
    public static double[] Bands(int count) {
      var bands = new double[count];
      if (fresh == 0 || rate == 0) return bands;
      fresh = 0;
      var re = new double[Size];
      var im = new double[Size];
      for (int i = 0; i < Size; i++) {
        double window = 0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (Size - 1));
        re[i] = ring[(head - Size + i + 8192) & 4095] * window;
      }
      Transform(re, im);
      double low = 50, high = Math.Min(16000, rate / 2.0 - 1);
      for (int b = 0; b < count; b++) {
        double from = low * Math.Pow(high / low, (double)b / count);
        double to = low * Math.Pow(high / low, (double)(b + 1) / count);
        int first = Math.Max(1, (int)(from * Size / rate));
        int last = Math.Max(first + 1, (int)Math.Ceiling(to * Size / rate));
        double most = 0;
        for (int i = first; i < last && i < Size / 2; i++) {
          double power = re[i] * re[i] + im[i] * im[i];
          if (power > most) most = power;
        }
        double level = 20 * Math.Log10(Math.Sqrt(most) * 4 / Size + 1e-9);
        bands[b] = Math.Round(Math.Min(1, Math.Max(0, (level + 66) / 60)), 2);
      }
      return bands;
    }
  }
  // Windows' per-program volume (the rows of its volume mixer).
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int Skip1(); int Skip2();
    [PreserveSig] int GetSessionEnumerator([MarshalAs(UnmanagedType.IUnknown)] out object list);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
  }
  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int Skip1(); int Skip2(); int Skip3(); int Skip4(); int Skip5(); int Skip6(); int Skip7(); int Skip8(); int Skip9(); int Skip10(); int Skip11();
    [PreserveSig] int GetProcessId(out uint pid);
  }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid context);
    [PreserveSig] int GetMasterVolume(out float level);
  }
  public static class AppVolume {
    // Sets (level 0 to 1) or reads (level below 0) the volume of the given
    // programs' sound. Returns the level found, or -1 when none of them is
    // making sound through Windows right now.
    public static float Use(int[] pids, float level) {
      float found = -1;
      try {
        var all = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        if (all.GetDefaultAudioEndpoint(0, 1, out device) != 0) return -1;
        var iid = typeof(IAudioSessionManager2).GUID;
        object got;
        if (device.Activate(ref iid, 23, IntPtr.Zero, out got) != 0) return -1;
        object listObject;
        if (((IAudioSessionManager2)got).GetSessionEnumerator(out listObject) != 0) return -1;
        var list = (IAudioSessionEnumerator)listObject;
        int count;
        list.GetCount(out count);
        var none = Guid.Empty;
        for (int i = 0; i < count; i++) {
          object session;
          if (list.GetSession(i, out session) != 0) continue;
          uint pid;
          if (((IAudioSessionControl2)session).GetProcessId(out pid) != 0) continue;
          if (Array.IndexOf(pids, (int)pid) < 0) continue;
          var volume = (ISimpleAudioVolume)session;
          if (level >= 0) volume.SetMasterVolume(Math.Min(1f, level), ref none);
          float now;
          if (volume.GetMasterVolume(out now) == 0) found = now;
        }
      } catch { return found; }
      return found;
    }
  }
  public static class Meter {
    static IAudioMeterInformation meter;
    static int reads;
    // Left and right peak of the default output device, 0 to 1.
    public static float[] Read() {
      try {
        // Ask again now and then: the default device can change.
        if (meter == null || ++reads > 250) {
          reads = 0;
          var all = (IMMDeviceEnumerator)new MMDeviceEnumerator();
          IMMDevice device;
          if (all.GetDefaultAudioEndpoint(0, 1, out device) != 0) return new float[] { 0, 0 };
          var iid = typeof(IAudioMeterInformation).GUID;
          object found;
          if (device.Activate(ref iid, 23, IntPtr.Zero, out found) != 0) return new float[] { 0, 0 };
          meter = (IAudioMeterInformation)found;
        }
        int count;
        meter.GetMeteringChannelCount(out count);
        if (count < 1) return new float[] { 0, 0 };
        var values = new float[count];
        meter.GetChannelsPeakValues(count, values);
        return new float[] { values[0], count > 1 ? values[1] : values[0] };
      } catch {
        meter = null;
        return new float[] { 0, 0 };
      }
    }
  }
}
'@

# Windows' media controls: what any app says it is playing.
$manager = $null
$asTask = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $task = $asTask.MakeGenericMethod($managerType).Invoke($null, @($managerType::RequestAsync()))
  if ($task.Wait(3000)) { $manager = $task.Result }
} catch { $manager = $null }

# Which app's playback to follow: 'spotify', 'other' (anything but Spotify,
# such as a browser tab on YouTube Music), or '' for whatever Windows calls current.
$wantApp = ''
# A player opened as its own browser window is named by Windows with its site
# ("MSEdge.open.spoti...": Windows cuts the middle out of a long name, so only
# "spoti" can be counted on), which tells Spotify from YouTube Music. An
# ordinary browser window is named by the browser alone; for that case the app
# says which player the browser's music window holds: 'spotify', 'ytm' or ''.
$browserSite = ''
# A second app that is only looked at: the player of the deck tab that is open
# while another source is the live one. '' for none.
$viewApp = ''

# Both lean on PowerShell's scoping: Pick-Session, called from here, reads this
# function's own $wantApp.
function Get-View { $wantApp = $viewApp; return Get-Web }
function View-Session { $wantApp = $viewApp; return Pick-Session }

function Pick-Session {
  if ($null -eq $manager) { return $null }
  $current = $manager.GetCurrentSession()
  if ($wantApp -eq '') { return $current }
  # Only the player's own sound counts. Anything else that plays on the
  # computer (a video in another browser, a game) belongs to neither tab.
  $plain = '^(msedge|brave|chrome)(\.exe)?$'
  $isMine = if ($wantApp -eq 'spotify') {
    { param($one) $name = [string]$one.SourceAppUserModelId; ($name -match 'spoti') -or ($browserSite -eq 'spotify' -and $name -match $plain) }
  } else {
    { param($one) $name = [string]$one.SourceAppUserModelId; ($name -match 'youtube|music\.you') -or ($browserSite -eq 'ytm' -and $name -match $plain) }
  }
  if ($null -ne $current -and (& $isMine $current)) { return $current }
  foreach ($one in $manager.GetSessions()) {
    if (& $isMine $one) { return $one }
  }
  return $null
}

function Get-Web {
  if ($null -eq $manager) { return $null }
  $session = Pick-Session
  if ($null -eq $session) { return $null }
  $title = ''; $artist = ''
  try {
    $task = $asTask.MakeGenericMethod($propsType).Invoke($null, @($session.TryGetMediaPropertiesAsync()))
    if ($task.Wait(1000)) { $title = [string]$task.Result.Title; $artist = [string]$task.Result.Artist }
  } catch {}
  $line = $session.GetTimelineProperties()
  $info = $session.GetPlaybackInfo()
  $state = [string]$info.PlaybackStatus
  $at = $line.Position.TotalSeconds
  if ($state -eq 'Playing' -and $line.LastUpdatedTime.Year -gt 2000) {
    $at += ([DateTimeOffset]::Now - $line.LastUpdatedTime).TotalSeconds
  }
  $end = $line.EndTime.TotalSeconds
  if ($end -gt 0 -and $at -gt $end) { $at = $end }
  return [ordered]@{
    app = [string]$session.SourceAppUserModelId; title = $title; artist = $artist
    st = $state; pos = [math]::Round($at, 1); dur = [math]::Round($end, 1)
  }
}

# The picture Windows holds for what another app is playing (Spotify, a
# browser on YouTube Music), sent once per song as its own line.
$artKey = ''
$artTries = 0
$streamType = $null
$asStream = $null
try {
  $streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $inputType = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [type[]]@($inputType))
} catch {}

function Send-Art($session, [string]$key) {
  $data = ''
  try {
    $task = $asTask.MakeGenericMethod($propsType).Invoke($null, @($session.TryGetMediaPropertiesAsync()))
    if ($task.Wait(1000) -and $null -ne $task.Result.Thumbnail -and $null -ne $asStream) {
      $open = $asTask.MakeGenericMethod($streamType).Invoke($null, @($task.Result.Thumbnail.OpenReadAsync()))
      if ($open.Wait(1500)) {
        # Through reflection: PowerShell cannot see the stream's own type to pick the method itself.
        $from = $asStream.Invoke($null, @($open.Result))
        $into = New-Object System.IO.MemoryStream
        $from.CopyTo($into)
        $from.Dispose()
        if ($into.Length -gt 100 -and $into.Length -lt 3000000) { $data = [Convert]::ToBase64String($into.ToArray()) }
        $into.Dispose()
      }
    }
  } catch {}
  if ($data -ne '') {
    Say (@{ ev = 'art'; key = $key; data = $data } | ConvertTo-Json -Compress)
    return $true
  }
  return $false
}

# One source at a time. Whatever starts playing last takes over: the others
# are paused, never stopped, so they can be picked up again.
# $wasPlaying holds the apps that were playing at the last look, so a new
# starter can be told from one that simply ignored a pause.
$wasPlaying = @()

function Get-Playing {
  $found = @()
  if ($null -eq $manager) { return $found }
  try {
    foreach ($one in $manager.GetSessions()) {
      if ([string]$one.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { $found += [string]$one.SourceAppUserModelId }
    }
  } catch {}
  return $found
}

# Pauses every other app that is playing; $keep is the one app left alone ('' for none).
function Pause-Others([string]$keep) {
  if ($null -eq $manager) { return }
  try {
    foreach ($one in $manager.GetSessions()) {
      if ([string]$one.SourceAppUserModelId -ne $keep -and [string]$one.GetPlaybackInfo().PlaybackStatus -eq 'Playing') {
        [void]$one.TryPauseAsync()
      }
    }
  } catch {}
}

function To-Number([string]$text) {
  return [double]::Parse($text, [cultureinfo]::InvariantCulture)
}

$player = New-Object System.Windows.Media.MediaPlayer
$volume = 0.7
$player.Volume = $volume
$state = 'stopped'
$length = 0.0
$opened = 0
$lastSeq = 0
$tick = 0
$note = ''
$web = $null
# The docked player's own volume: the programs it is made of (found by its
# profile folder, plus the Spotify app when that is the one followed), looked
# up again every fifteen seconds, and the level Windows has for them (-1: silent so far).
$webVol = -1.0
$volPids = @()
$volLooked = [DateTime]::MinValue
function Player-Pids {
  if (([DateTime]::Now - $script:volLooked).TotalSeconds -lt 15) { return $script:volPids }
  $script:volLooked = [DateTime]::Now
  $found = @()
  $dir = [string]$env:CA_PROFILE
  if ($dir -ne '') {
    foreach ($one in (Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='brave.exe' OR Name='chrome.exe'")) {
      $line = [string]$one.CommandLine
      if ($line.Contains($dir) -or ([string]$env:CA_PAGES -ne '' -and $line.Contains([string]$env:CA_PAGES))) { $found += [int]$one.ProcessId }
    }
  }
  if ($wantApp -eq 'spotify' -or $viewApp -eq 'spotify') { foreach ($one in @(Get-Process -Name Spotify)) { $found += [int]$one.Id } }
  $script:volPids = $found
  return $found
}
$view = $null
$viewArtKey = ''
$viewArtTries = 0
$frames = New-Object System.Collections.ArrayList
$left = 0.0; $right = 0.0
$quiet = 0
# The app asks for a status twelve times a second; the mod, three.
$every = if ($env:CA_FAST) { 2 } else { 8 }
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId

while ($true) {
  Start-Sleep -Milliseconds 40
  $tick++

  $peak = [ClaAmp.Meter]::Read()
  [ClaAmp.Spectrum]::Pump()
  if ($tick % 2 -eq 0) { [void]$frames.Add([ClaAmp.Spectrum]::Bands(24)) }
  if ($peak[0] -gt $left) { $left = $peak[0] }
  if ($peak[1] -gt $right) { $right = $peak[1] }

  if ($tick % 3 -eq 0) {
    foreach ($row in @(Get-Content -LiteralPath $env:CA_CMD -Encoding UTF8)) {
      $part = ([string]$row).Split('|', 3)
      if ($part.Count -lt 2) { continue }
      $seq = 0
      if (-not [int]::TryParse($part[0], [ref]$seq) -or $seq -le $lastSeq) { continue }
      $lastSeq = $seq
      $arg = if ($part.Count -gt 2) { $part[2] } else { '' }
      $session = Pick-Session
      switch ($part[1]) {
        'open' { Pause-Others ''; $player.Open([Uri]$arg); $player.Play(); $state = 'playing'; $length = 0.0; $opened = $tick }
        'pause' { if ($state -eq 'playing') { $player.Pause(); $state = 'paused' } }
        'resume' { if ($state -eq 'paused') { Pause-Others ''; $player.Play(); $state = 'playing' } }
        'stop' { $player.Stop(); $player.Close(); $state = 'stopped'; $length = 0.0 }
        # A song is starting in the Cla-Amp window itself (the equalizer's player): other apps' music pauses.
        'hush' { Pause-Others '' }
        'vol' { $volume = [math]::Min(1.0, [math]::Max(0.0, (To-Number $arg))); $player.Volume = $volume }
        'web-vol' {
          $pids = @(Player-Pids)
          if ($pids.Count -gt 0) { $webVol = [ClaAmp.AppVolume]::Use([int[]]$pids, [float][math]::Min(1.0, [math]::Max(0.0, (To-Number $arg)))) }
        }
        'seek' { if ($state -ne 'stopped') { $player.Position = [TimeSpan]::FromSeconds((To-Number $arg)) } }
        'web-app' { if (@('spotify', 'other', '') -contains $arg) { $wantApp = $arg; $web = Get-Web } }
        'web-site' { if (@('spotify', 'ytm', '') -contains $arg) { $browserSite = $arg; $web = Get-Web } }
        'view-app' {
          if (@('spotify', 'other', 'none') -contains $arg) {
            $viewApp = if ($arg -eq 'none') { '' } else { $arg }
            $view = if ($viewApp -ne '') { Get-View } else { $null }
            $viewArtKey = ''
          }
        }
        'web-toggle' {
          if ($session) {
            # About to start it: it takes over from the files and from every other app.
            if ([string]$session.GetPlaybackInfo().PlaybackStatus -ne 'Playing') {
              if ($state -eq 'playing') { $player.Pause(); $state = 'paused' }
              Pause-Others ([string]$session.SourceAppUserModelId)
            }
            [void]$session.TryTogglePlayPauseAsync()
          }
        }
        'web-next' { if ($session) { [void]$session.TrySkipNextAsync() } }
        'web-prev' { if ($session) { [void]$session.TrySkipPreviousAsync() } }
        'web-seek' { if ($session) { [void]$session.TryChangePlaybackPositionAsync([long]((To-Number $arg) * 10000000)) } }
      }
    }
  }

  if ($state -ne 'stopped') {
    if ($length -eq 0 -and $player.NaturalDuration.HasTimeSpan) {
      $length = $player.NaturalDuration.TimeSpan.TotalSeconds
    }
    if ($state -eq 'playing' -and $length -gt 0 -and $player.Position.TotalSeconds -ge ($length - 0.15)) {
      $player.Stop(); $player.Close(); $state = 'stopped'; $length = 0.0; $note = 'ended'
    } elseif ($length -eq 0 -and ($tick - $opened) -gt 150) {
      $player.Stop(); $player.Close(); $state = 'stopped'; $note = 'failed'
    }
  }

  if ($tick % 25 -eq 0) {
    # An app that was started from its own window (not from here) takes over too.
    $nowPlaying = @(Get-Playing)
    $starter = @($nowPlaying | Where-Object { $wasPlaying -notcontains $_ }) | Select-Object -First 1
    if ($starter) {
      if ($state -eq 'playing') { $player.Pause(); $state = 'paused' }
      Pause-Others ([string]$starter)
    }
    $wasPlaying = $nowPlaying
    $web = Get-Web
    $pids = @(Player-Pids)
    $webVol = if ($pids.Count -gt 0) { [ClaAmp.AppVolume]::Use([int[]]$pids, [float]-1) } else { -1.0 }
    # A new song: fetch its picture. It can arrive a moment after the title, so try a few times.
    $key = if ($null -ne $web) { $web.app + '|' + $web.title + '|' + $web.artist } else { '' }
    if ($key -ne $artKey) { $artKey = $key; $artTries = if ($key -eq '') { 0 } else { 4 } }
    if ($artTries -gt 0) {
      $artTries -= 1
      $session = Pick-Session
      if ($null -ne $session -and (Send-Art $session $key)) { $artTries = 0 }
    }
    # The same for the app that is only looked at.
    if ($viewApp -ne '' -and $viewApp -ne $wantApp) {
      $view = Get-View
      $key = if ($null -ne $view) { $view.app + '|' + $view.title + '|' + $view.artist } else { '' }
      if ($key -ne $viewArtKey) { $viewArtKey = $key; $viewArtTries = if ($key -eq '') { 0 } else { 4 } }
      if ($viewArtTries -gt 0) {
        $viewArtTries -= 1
        $session = View-Session
        if ($null -ne $session -and (Send-Art $session $key)) { $viewArtTries = 0 }
      }
    } else { $view = $null }
  }

  if ($tick % 125 -eq 0 -and -not (Get-Process -Id $parent)) { exit 0 }

  if ($tick % $every -eq 0) {
    # With nothing sounding, say so once a second instead of three times.
    $isSilent = ($left -eq 0 -and $right -eq 0 -and $state -ne 'playing' -and $note -eq '')
    if ($isSilent) { $quiet++ } else { $quiet = 0 }
    if (-not $isSilent -or $quiet % 12 -eq 1) {
      $status = [ordered]@{
        seq = $lastSeq; st = $state; ev = $note
        pos = [math]::Round($player.Position.TotalSeconds, 1); dur = [math]::Round($length, 1)
        vol = $volume; l = [math]::Round($left, 3); r = [math]::Round($right, 3)
        sp = @($frames); web = $web; view = $view; wv = [math]::Round($webVol, 2)
      }
      Say ($status | ConvertTo-Json -Compress -Depth 4)
      [Console]::Out.Flush()
      $note = ''
    }
    $frames.Clear(); $left = 0.0; $right = 0.0
  }
}
