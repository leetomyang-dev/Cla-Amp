# Cla-Amp in detail

Every part of the window and the things worth knowing about each. For a first start see the [README](../README.md) and the [user guide](user-guide.md).

## What is where

| Place | What it does |
| --- | --- |
| Title bar | Skin picker, show or hide the left and right columns, window buttons. |
| Top bar | The song that is playing, with previous, play and next. |
| Button row | Open chat, New chat, Video, Shuffle projects. |
| Message box | Type and press Enter (Shift+Enter for a new line); the box grows as you write. **Files:** drop files anywhere on the window, paste a picture, or press the paperclip; each shows as a chip above the text until you send, and its "x" takes it off. Any number of files of any kind can go with a message. Pictures are shown to Claude directly (the first 20, each up to 3.5 MB; more or larger ones go by path); every other file, video and music included, is given by its path for Claude to read or work on with its tools. **Quote:** mark text in the chat and press the Quote button that appears, or use the quote button under a reply; the text goes into your message as a quote. Under the text: how Claude asks before it acts (Ask / Auto-edit / Auto / Plan, click to change; in Auto, Claude Code checks each step itself and asks you only for the risky ones), the microphone for dictation, and Stop while Claude is working. |
| Status strip | Agents running, how full the context is, the git branch. |
| Left: Projects | Folders with a chat in Cla-Amp, and their agents. |
| Left: Chats | Every saved chat on this computer by folder, the desktop app's and the terminal's included. Search, pin, click to open. |
| Left: Queue | Messages you sent while Claude was busy; they run in turn. |
| Middle | The chat: Claude's thinking as it comes, tool calls (finished ones fold into "Ran 5 commands"), the task list, a line with a timer for what is running, and cards that ask your permission. |
| Right | Music deck, Usage limits, Model (model, effort, fast mode), Context EQ, Context (tokens), Up next, Connectors and plugins. Click a heading to fold a panel; drag a heading to reorder. |

## Things to know

- **Same chats as the desktop app.** Opening a chat continues that very
  conversation, and it opens on the model and effort the desktop app had it
  on. Type in one app at a time: two apps writing to one chat at once can
  scramble it.
- **Trusting a folder.** When you add a folder, Cla-Amp asks whether you
  trust it. A trusted folder's own Claude Code settings load; an untrusted
  one still works, with only your own settings.
- **Permission cards.** Unless you switch the mode, Claude asks before it runs
  a command or changes a file. **Always allow** saves the rule Claude Code suggests for
  that kind of action, so it will not ask again.
- **Usage limits** come from an SDK call marked experimental; an SDK update
  may change it.
- **Fast mode** needs extra usage turned on for your Claude account.
- **Music.** "My files" plays the audio files in your music folders (mp3,
  wav, m4a, wma, flac, aac). Add as many folders as you like. Search the
  songs, or narrow them by artist, genre or folder; songs with no tags are
  sorted by the folder they sit in. Press **+** on a song to put it in **Up
  next**, or the dice for a random song. **Columns** picks what each
  song's row shows (number, artist, album, genre, folder, time); click a
  column's name to sort by it. **Import playlist** adds an .m3u, .m3u8
  or .pls file to **Playlists**, where it stays until you take it out. "YouTube Music" has **Open player**: YouTube Music as a
  window of its own that belongs to your browser (Chrome, Edge or Brave; pick
  which if you have several). The window is attached to
  Cla-Amp and has a browser profile of its own: sign in to Google there
  once. Start a playlist there and it keeps playing while that window is
  open, even hidden. "Spotify" has **Open Spotify app**, which starts the
  Spotify app, and **Open in Edge**, which opens Spotify's web player the
  same way. The deck shows what Windows reports as playing, and play, pause,
  next and previous work from the deck. Cla-Amp adds nothing to those pages
  and reads nothing from them, and it never sees a password for either.
  The spectrum is drawn from the sound your computer is putting out. The
  bar at the top of the window has a small copy of the player: shuffle,
  repeat, volume and the next two songs. Untick **Player in the top bar** in
  the music deck to hide it and the small spectrum.
- **One source at a time.** Whatever you press play on last takes over: the
  files, YouTube Music, Spotify or any other player Windows knows about. The
  others are paused, not stopped.
- **Closing a player window stops its music**, because that window is the
  player. **Hide player** tucks it away instead and the music plays on.
- **Dictation.** Click the microphone under the message box and speak; the
  words are typed into the message. It uses the speech recogniser built into
  Windows, on this computer: nothing is recorded or sent anywhere, and it
  switches itself off after a minute of silence. It is the older Windows
  recogniser, so expect mistakes; Windows' own dictation (Win+H) also works
  in the message box.
- **Cover art.** When the playing song has a picture, the music deck shows
  it in place of the spectrum, with a line saying where it came from: inside
  the song file, a picture in the song's folder (cover, folder, front or
  album .jpg/.png, or the only picture there), or the player (Spotify,
  YouTube Music).
- **Live updates.** Run from its source folder, the open app notices when its
  own files change. A changed stylesheet or skin shows at once. Changed
  window code shows **Reload to update** in the title bar (chats keep
  running, your unsent message is kept); changed app code shows **Restart to
  update**. Claude Code runs inside Cla-Amp, so a restart stops work that is
  running; if a chat is working you choose between **Restart when the work
  is done** (nothing is stopped, it restarts by itself afterwards) and
  **Restart now and carry on** (each working chat is told to carry on after
  the restart, and waiting messages are kept). So you can ask Claude, in Cla-Amp, to change Cla-Amp.

## Skins

Pick one from the title bar. **Import a Winamp skin (.wsz)...** in that list
brings over the colours and the font from a classic Winamp skin. To make your own, choose **Open my skins
folder...** in that list: a starter skin is waiting there. A skin is a
stylesheet and nothing else; it is checked before it loads and cannot run
anything or reach the internet. See [docs/skins.md](skins.md).

## Safety

What the app does to keep the people who use it safe, and what stays their
own call, is in [docs/security.md](security.md).

## For people changing the code

[docs/code-guide.md](code-guide.md) covers how the pieces fit, every
message between the window and the main process, and how to test without a
visible window.
