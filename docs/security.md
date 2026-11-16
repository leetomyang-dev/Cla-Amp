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
Spotify's web player, as a window without tabs. In Edge and Brave that
window gets a browser profile of its own, kept in Cla-Amp's data folder, so
it can be attached to the Cla-Amp window; you sign in there once, on the
service's own page. In Chrome it is an ordinary window with the sign-in you
already have.

Cla-Amp adds nothing to the browser: no extension, no script, no stylesheet.
It does not read or change the pages, and it does not read the browser's
cookies, passwords or profile. Nothing about the sign-in passes through it.
The music deck only sees what Windows reports as playing, and its buttons
are Windows' own media controls.

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
  change files without asking. A prompt hidden in a web page or file can try
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
- To draw the spectrum, the music helper captures the sound the computer is
  playing, whatever program it comes from, a moment at a time and in memory
  only. Each moment is measured and discarded. It is never saved to disk and
  never sent anywhere.
- Sends nothing anywhere by itself. One thing goes out, and only when you
  use it: with **Import from link**, the one skin file your pasted link
  names is fetched from the Winamp Skin Museum's file store.
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
- The app is not code-signed or packaged. Before handing out an installer:
  package it, sign it, and switch off Electron's run-as-Node and inspect
  fuses.

## Rules for anyone changing the code

1. Untrusted text goes on screen with `textContent`. The only `innerHTML` is
   in `markdown()`, behind `DOMPurify` with `CLEAN`. Do not add another.
2. A new call gets a name in `preload.cjs` and a handler that checks every
   argument's type, range or pattern. Treat the window as hostile.
3. Never build a command line or a script file from text. Start programs by
   full path with an argument list.
4. Anything that grants trust (a folder, a skin, a standing permission) is
   asked in a system dialog from the main process, not in the page.
5. Do not loosen the content policy in `index.html` or the request block in
   `main.mjs`.
6. Run `npm audit` before a release and keep Electron current.

## How this was checked

- `npm audit`: no known vulnerabilities (15 November 2026).
- Hostile markup drawn through the chat's own code in the demo: nothing ran,
  only the plain web link survived.
- Bad arguments sent to the real app's calls (a path trick, an unknown chat,
  a web address as a song, an option as a plugin name, an unknown preference):
  all refused.
- Thirteen sample stylesheets through the skin check: every unsafe one
  refused.

## Reporting a problem

Open an issue on the project's GitHub page with what you did and what happened. Issues are public, so for a security problem say only that you have one to report and leave out the details of how to use it.

Cla-Amp is shared as it is, with no promise of support.

## claude.ai in a docked window

The Claude.ai button opens claude.ai in the same separate browser profile the music players use, as a real browser window attached to Cla-Amp. You sign in there yourself; the browser keeps that sign-in in its own protected store and Cla-Amp never opens it. Cla-Amp cannot see your chats or projects, adds nothing to the page and changes nothing on it: its helper moves, shows and hides the window and reads only its title. The page keeps claude.ai's own look.
