# Security

Cla-Amp sits between a person and Claude Code, which can read files and run
commands on their computer. This page says what the app does to keep that
safe, what it leaves to the person, and what anyone changing the code must
keep true.

Last reviewed 16 November 2026 (an independent read of the code, plus the
tests listed at the end).

## What the app protects against

### Text in the chat cannot run or reach out

Everything Claude writes, and everything it quotes from a web page, a file or
a tool, is untrusted text.

- Replies are turned into HTML by `marked` and then cleaned by `DOMPurify`
  with a strict list (`CLEAN` in `renderer/app.js`): formatting, tables, code
  and plain web links only. No pictures, video, frames, forms, buttons,
  styles, `id`, `class` or `style` attributes. The one class kept is a code
  block's language.
- Links may only be `http:`, `https:` or `mailto:`. A link shows its real
  address when the mouse rests on it. Clicking opens the person's browser;
  the main process checks the address again and refuses anything else.
- Everything that is not a reply (your messages, thinking, tool input and
  output, permission cards, chat titles, folder names, song titles, plugin
  and connector names, skin names) is put on screen as plain text, never as
  HTML.
- The page's content policy allows no inline script, no script or picture
  from the internet, no frames, no forms.
- The window loads nothing from the network at all: every request that is
  not a local file is cancelled in the main process.

### The window is locked down

- The page runs sandboxed, isolated from Node, with no access to the
  computer except through a fixed list of calls (`preload.cjs`).
- Every call is refused unless it comes from the app's own page.
- The page cannot navigate away, open another window, embed another page, or
  use the camera, microphone or location. The only thing it may do is copy to
  the clipboard (the Copy button).
- Developer tools are off outside development.
- One copy of the app runs at a time.

### Calls are checked

Each handler in `main.mjs` checks what it is given:

- Folders are made into full paths and must be real folders; a chat is opened
  only if it is really saved for that folder.
- The music helper takes a fixed set of commands, and only plays files the
  app itself found in the music folders or in a playlist the person picked.
  Music folders and playlists are chosen in system dialogs; the window cannot
  name a path. A playlist's web addresses and network shares are left out.
  Song tags are read from a capped slice of each file, every length in them
  is checked, and they are only ever shown as text.
- Preferences are a fixed set of keys, each with a shape.
- Plugin names, effort levels and permission modes are checked against
  patterns or lists. The mode that skips all permission checks cannot be set
  from the window.
- No command line is ever built from text the window sent. Programs are
  started by full path with fixed arguments.

### A folder's own settings need your say-so

A folder can carry Claude Code settings that run programs when a chat starts
or let tools run without asking. When a folder is added, Cla-Amp asks, in a
system dialog the page cannot imitate, whether you trust it. If not, the chat
still works but only your own settings load.

### Permission cards show everything

When Claude asks to use a tool, the card shows the whole command, or the file
with the full change, and says when there is more than fits in the box.
"Always allow" appears only when there is a rule to save, names that rule,
and can only add an allow rule: it cannot change the mode or add folders.

### Skins are checked before they load

A skin is a stylesheet. Before the window may load one, the main process
reads it:

- **Refused** if it pulls in another stylesheet, uses a backslash (which can
  disguise a rule), or loads any file that is not a plain file name in its
  own folder. That rules out the internet, network shares and other folders.
- **Colours only** (nothing but variables in one `:root` block): loaded.
- **Full** (rules of its own): for a skin you added, you are asked first in
  a system dialog, once per version of the stylesheet, because such a skin
  can move, cover or hide any part of the window, including permission
  cards.

A skin can never run a program or send anything anywhere.

A Winamp skin file comes from the internet, so the importer
(`winamp-skin.mjs`) reads it with care: the file and each thing inside it are
size-capped, nothing inside it is saved to disk as it is, and all that reaches
the new stylesheet is colours the importer worked out and a font name stripped
to letters, numbers, spaces and dashes. No picture from the skin is kept. The result is a colours-only skin.

The file is either one the person picked on their computer or, with
**Import from link** in Themes, the one skin their pasted link names. That
is downloaded only when the button is pressed, over https, from
skins.webamp.org's own file store; a link to any other site is refused.

### Sign-in

Cla-Amp never sees your Claude password or the sign-in token Claude Code
keeps. Sign in opens Claude Code's own sign-in in a console window, which
uses your browser; Claude Code stores the result, as it does when used by
itself. Cla-Amp passes no sign-in on to anyone and runs no server. It holds
no password, key or token for any service.

### Live updates read only the app's own files

The open app watches its own source folder (only when it runs from source,
never as an installed copy) and the person's skins folder. A change makes
the window read the same local files again that it reads when it opens;
nothing is fetched, and no file from anywhere else is loaded. Reloading the
window and restarting the app happen only when the person clicks the chip in
the title bar. A changed skin goes through the same check as before, and a
full skin that changed asks for approval again. Anything that can write to
the app's folder could already change what the app runs at its next start,
so this adds no new way in; it only shortens the wait.

### Players open in your own browser

**Open player** starts your own browser (Chrome, Edge or Brave, found only in
the folders their installers use) with one fixed address, YouTube Music or
Spotify's web player, as a window without tabs. That window uses a browser
profile of Cla-Amp's own, kept in Cla-Amp's data folder, so it can be
attached to the Cla-Amp window; you sign in there once, on the service's
own page. In Chrome it is the same profile as Cla-Amp's browser (the
**Browser** button), so the Browser, the players and claude.ai are windows
of one Chrome that shares nothing with your everyday Chrome. In Edge and
Brave the players have a profile of their own.

Cla-Amp adds nothing to the browser: no extension, no script, no stylesheet.
It does not read or change the pages, and it does not read the browser's
cookies, passwords or profile. Nothing about the sign-in passes through it.
The music deck only sees what Windows reports as playing, and its buttons
are Windows' own media controls.

### Closing Cla-Amp stops its own browsers

When Cla-Amp closes, the browsers it started are stopped with it, so no
player plays on and nothing of Cla-Amp's stays in Task Manager. They are
stopped outright, not asked to close (a player that is playing answers a
polite close with a "Leave app?" box of its own and stays open).

Which browsers: only a Chrome, Edge or Brave whose command line names one
of Cla-Amp's own profile folders (`player-profile` or `pages-profile` in
`%APPDATA%\Cla-Amp`). Your everyday browser runs on another profile and is
never matched; this was measured on a computer with other browsers open,
and none of their processes was touched. The work is done by
`deck/close-browsers.ps1`, started by full path with fixed arguments, and
it writes what it found (a time and a count, no title or address) to
`%APPDATA%\Cla-Amp\last-close.log`. A restart of Cla-Amp leaves the
player playing. When Cla-Amp starts and finds a browser of its own still
running, it takes its windows back; it never adopts a window of any other
browser.

### One source at a time

When one player starts, the music helper pauses the others through Windows'
own media controls. It pauses any app Windows reports as playing media, not
only the ones Cla-Amp opened, and never closes or stops anything.

### Spotify and other players

**Open Spotify** asks Windows to start the Spotify app; the address is fixed
in the code.

The deck never talks to Spotify or YouTube Music itself. It asks Windows
what is playing and sends play, pause, next, previous and seek through
Windows' own media controls. No account, password or token is involved.

### Test switches

The screenshot and scripted-test flags work only when `CLAAMP_DEV=1` is
set and the app runs from its source folder.

## What stays the person's call

- **What Claude is allowed to do.** In Ask mode Claude asks before each
  command or change; read the card before pressing Allow. Auto-edit lets it
  change files without asking. In Auto, Claude Code's own checker allows
  or refuses each step and a card appears only when it cannot decide; that
  is less of a check than Ask, so use it in folders you trust. A prompt hidden in a web page or file can try
  to steer Claude; the permission card is the check on that.
- **Which folders to trust**, and which full skins to use.
- **Connectors and plugins.** They are Claude Code's own and run with its
  rights. Cla-Amp only switches them on and off.

## What the app reads and writes

- Reads and continues Claude Code's saved chats in `~/.claude/projects`.
- Reads, never writes, the Claude desktop app's record of each chat: its
  model and effort, its title, whether it is archived, the project it belongs
  to and the chat that started it. Only those session records are opened;
  the desktop app's sign-in and settings files are not.
- Keeps its own state in `%APPDATA%\Cla-Amp`.
- The **Let Claude use my Chrome** switch is off by default. Turned on, Cla-Amp
  starts Claude Code with its own Chrome option, and Claude Code connects
  to Anthropic's Claude in Chrome add-on, if you installed it. Claude can
  then open, read and act on pages in your Chrome, where you are signed in
  to your sites, so treat it like any other tool that can act for you:
  each use goes through the same asking as a command or a file change,
  and the add-on keeps its own site permissions. Cla-Amp installs nothing
  in the browser, does not talk to the add-on itself, and sees no cookie,
  password or page.
- While the list of working chats is open, Cla-Amp asks Windows for its
  process list (ids, memory and processor time) to show what each chat's
  Claude Code is using. Only numbers are kept, only for Cla-Amp's own
  chat processes and what they started; nothing is sent anywhere.
- A file's name in a reply can be clicked to read that file in the
  window. Cla-Amp reads it only on your click and shows it as text or as
  a picture: a Markdown file is drawn through the same cleaning as a
  reply, and nothing in any file is run. A web page or a PDF is never
  loaded inside the window; **Open in browser** hands it to Cla-Amp's
  browser.
- Cla-Amp's browser (the **Browser** button) is a real browser window,
  started the same way as the players': Chrome when it is installed (else
  Edge or Brave), found only in its installer's folder, with a browser
  profile of its own in `%APPDATA%\Cla-Amp\pages-profile`. That profile is used for
  nothing else, so a page opened there cannot see your everyday browser's
  sign-ins, cookies, history or add-ons, and the browser's own sandbox
  applies to it as to any page. Cla-Amp itself sends only two kinds of
  address there: a page or PDF file you opened from the viewer, and a
  link to this computer (localhost); where you browse from there is up to
  you. A claude.ai link in a reply opens in the attached claude.ai window
  instead. Each address is checked and passed as one whole argument. Cla-Amp adds nothing to that browser and
  reads nothing from its pages; if you sign in to claude.ai there, the
  browser keeps that sign-in and Cla-Amp never sees it. The window closes
  with Cla-Amp.
- Files you attach to a message (dropped, pasted or picked) are given to
  Claude Code: pictures as they are, other files by their path, which Claude
  Code then reads under its usual rules. Only files you attached yourself
  go; the page cannot name a file by itself, since a path is taken only
  from a real drop, paste or the file picker. A pasted picture is saved in
  `%APPDATA%\Cla-Amp\attachments` first.
- To draw the spectrum, the music helper captures the sound the computer is
  playing, whatever program it comes from, a moment at a time and in memory
  only. Each moment is measured and discarded. It is never saved to disk and
  never sent anywhere.
- Sends nothing anywhere by itself. One thing goes out, and only when you
  use it: with **Import from link**, the one skin file your pasted link
  names is fetched from the Winamp Skin Museum's file store. Apart from
  the program, **Update.bat** is a script the person runs by hand: it
  downloads Cla-Amp's newest version from its GitHub page over HTTPS and
  copies it over the folder. Cla-Amp never runs it.
- **Stay awake**, while switched on, asks Windows not to sleep by itself.
  Nothing else about power is changed, and it ends with the app.
- When a chat is done or waits for you, the taskbar button may flash and a
  chime may sound. The chime is made in the window from plain tones: there
  is no sound file, and nothing is fetched.
- What an agent of a chat did is read, on your click, from Claude Code's
  own saved file for that chat. Read only.
- Your plan's limits and extra usage credits are asked of Claude Code, as
  the Usage panel always did. Cla-Amp shows the figures and keeps none.
- Listens on no port, on this computer or the network.
- Claude Code talks to Anthropic as it always does. The players and
  claude.ai are the services' own pages in your browser and talk to their
  own services as any browser window does.

## Known limits

- A full skin you approved is trusted with the look of everything, as above.
- Whether Claude Code would run an untrusted folder's hooks through the SDK
  was not tested; the trust question means such settings are not loaded
  either way.
- Usage limits and the desktop app's chat records rely on formats that can
  change.
- Sign in was run after the rewrite and the sign-in completed, but nobody
  watched the console window itself. The connector console (for a connector
  that is not from the Claude account) has not been clicked through.
- The helper scripts run hidden in Windows PowerShell and one of them
  stops browser processes: an antivirus program may ask about that. See
  [SECURITY.md](../SECURITY.md).
- Closing the app with its own browser behind it, and taking a left-over
  browser back at the start, were proven on a scratch browser, not yet
  watched with a real player.
- The app is not code-signed or packaged. Before handing out an installer:
  package it, sign it, and switch off Electron's run-as-Node and inspect
  fuses.

## Rules for anyone changing the code

1. Untrusted text goes on screen with `textContent`. Untrusted text becomes
   HTML in two places only, both behind `DOMPurify` with `CLEAN`:
   `markdown()` in `renderer/app.js` and the guide page in
   `renderer/guides.js`. The other uses of `innerHTML` are code colouring
   by highlight.js, which escapes what it is given, and fixed drawings
   written in the code. Do not add another kind.
2. A new call gets a name in `preload.cjs` and a handler that checks every
   argument's type, range or pattern. Treat the window as hostile.
3. Never build a command line or a script file from text. Start programs by
   full path with an argument list.
4. Anything that grants trust (a folder, a skin, a standing permission) is
   asked in a system dialog from the main process, not in the page.
5. Do not loosen the content policy in `index.html` or the request block in
   `main.mjs`.
6. Run `npm audit` before a release and keep Electron current. The same
   runs on GitHub on every push (`.github/workflows/checks.yml`), with
   CodeQL (`codeql.yml`) and Dependabot (`.github/dependabot.yml`).
7. A process is stopped only when it is Cla-Amp's own: found by this app's
   own profile folder in its command line, never by name alone.
8. No program file (`.exe`, `.dll` and the like) goes into the repository;
   the check on every push refuses one.

## How this was checked

- `npm audit`: no known vulnerabilities (16 November 2026).
- The code searched for `eval`, `new Function`, a shell started from text
  and every `innerHTML`: none of the first three; the `innerHTML` uses are
  the ones named in rule 1.
- The browser clean-up run against a scratch browser with its own profile,
  with other browsers open: the scratch browser's 13 processes were gone,
  and the 19 other browser processes on the computer were untouched.
- Hostile markup drawn through the chat's own code in the demo: nothing ran,
  only the plain web link survived.
- Bad arguments sent to the real app's calls (a path trick, an unknown chat,
  a web address as a song, an option as a plugin name, an unknown preference):
  all refused.
- Thirteen sample stylesheets through the skin check: every unsafe one
  refused.

## Reporting a problem

Open an issue on the project's GitHub page with what you did and what happened. Issues are public, so a security problem goes another way: [SECURITY.md](../SECURITY.md) says how to report one privately.

Cla-Amp is shared as it is, with no promise of support.

## claude.ai in a docked window

The Claude.ai button opens claude.ai in the same separate browser profile the music players use, as a real browser window attached to Cla-Amp. You sign in there yourself; the browser keeps that sign-in in its own protected store and Cla-Amp never opens it. Cla-Amp cannot see your chats or projects, adds nothing to the page and changes nothing on it: its helper moves, shows and hides the window and reads only its title. The page keeps claude.ai's own look.
