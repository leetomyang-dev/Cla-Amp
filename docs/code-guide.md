# Code guide

How Cla-Amp is put together, for anyone changing it. There is no build
step: the files run as they are.

## The pieces

| File | Job |
| --- | --- |
| `main.mjs` | Electron's main process. Owns the window, the saved state, one Claude Code session per project (through `@anthropic-ai/claude-agent-sdk`), the music helper, and every call the window may make. |
| `preload.cjs` | The only bridge to the window: a fixed list of call names and two event streams. |
| `renderer/index.html` | The window's layout. |
| `renderer/app.js` | Everything on screen: turns events into the chat, lists, meters and panels. Plain JavaScript, no framework. |
| `renderer/styles.css` | The look. The variables at the top are what skins change. |
| `deck/deck.ps1` | PowerShell helper: plays files, measures the sound the computer is putting out (for the spectrum), and reads and controls the Windows media session (for YouTube Music). |
| `music-library.mjs` | The deck's library: finds songs in the music folders, reads title, artist, album, genre and number (ID3 and FLAC tags, else the file name) and length (MP3, FLAC, WAV and M4A headers), and reads playlists. Tested by `tests/music-library.test.mjs`. |
| `tools/engine-check.mjs` | Keeps Cla-Amp in step with its engine. With no argument (part of `npm test`): the contract, that every SDK function, query method and message subtype the code uses (read out of `main.mjs` and `outside-work.mjs`, so the list cannot go stale) is still in the installed SDK's types. With `--news` (`npm run engine`): installed and newest versions of the SDK, the Claude Code inside it and Electron, and the change notes in between with the ones touching Cla-Amp marked; `--all` for every note. See "Taking an engine update" below. |
| `tools/policy-watch.mjs`, `tools/policy-watch.json` | Watches the public pages whose rules Cla-Amp follows (`npm run policy`, and daily in `.github/workflows/watch.yml`): says which page changed since it was last looked over and whether each sentence relied on is still there, and fails when either is so. The list holds a fingerprint per page and those sentences; the pages' text stays in `.policy-cache/` on this computer only. What each rule means for the code is in [compliance.md](compliance.md). |
| `tools/undefined-names.eslint.mjs` | The one lint check, run by the Checks on GitHub (`npx eslint@10.15.0 -c tools/undefined-names.eslint.mjs .`): a name used but never defined, in the main process, the window's code, the tools and the tests. It lists the names each side is given by what runs it; add one there when the code starts using it. The lint tool is not a package of Cla-Amp's. |
| `safe-read.mjs` | Reading a file with a size limit, or only its end, from one opening of it (`readCapped`, `readCappedLater`, `readTail`, `sizeAndBytes`). Use these, not a size check by path followed by a read by path: the code scanner reports that pair as a race, since the file could be swapped in between. To write a file only when it is not there yet, write with the `wx` flag and let "already exists" pass. |
| `winamp-skin.mjs` | Turns a classic Winamp skin file (.wsz) into a colours-only Cla-Amp skin: a small zip reader, a bitmap reader (plain and RLE8-packed pictures), and the colour mapping (no picture carries over). Tested by `tests/winamp-skin.test.mjs` (`node tests/winamp-skin.test.mjs`). |
| `skins/` | The skins that ship with the app, and `_template`. |
| `docs/` | This guide, the skin guide, the security notes. |

Markdown is drawn with `marked`, cleaned with `DOMPurify`, and code is
coloured with `highlight.js`; the window imports all three straight from
`node_modules`.

## Where things are saved

| What | Where |
| --- | --- |
| Projects, preferences, the chosen skin | `%APPDATA%\Cla-Amp\claamp.json` |
| What each project's chat shows | `%APPDATA%\Cla-Amp\transcripts\<project id>.jsonl` |
| The person's own skins | `%APPDATA%\Cla-Amp\skins\` |
| The conversations themselves | `~/.claude/projects/...`, Claude Code's own store, shared with the desktop app and the terminal |
| Column widths, folded panels | The window's `localStorage` |

## A session's life (`class Session` in `main.mjs`)

One `Session` per project. It holds the SDK `query()`, a queue of prompts,
and the permission asks that are waiting.

- `submit(text)` runs a prompt, or queues it if Claude is busy.
- `start()` opens the Claude Code process with the project's folder, saved
  conversation (`resume`), permission mode, model, effort, summarized
  thinking, and `canUseTool` pointed at `ask()`.
- `handle(message)` turns each SDK message into an event for the window.
- `ask()` / `decide()` are the permission cards: Claude Code waits on the
  promise until the person answers.
- `live()` starts the process without a prompt, so the panels can be filled;
  `sleep()` ends an idle one. `info()` gathers models, plan limits and
  connectors.
- `adopt(sessionId, events)` switches the project to a saved conversation.
- `watchChats()` (outside the class) re-reads a conversation that another app
  added to while this one was idle.

A project carries `isTrusted`, set by a system dialog when its folder is
added (`askTrust()`); only a trusted folder's own Claude Code settings are
loaded.

A trusted folder's `.mcp.json` can name programs to start as connectors, and
Claude Code run by an app starts them without asking. So `askServers()` asks
before a message is sent (`project:send`), in a system dialog, about each one
not yet answered for; the answers are kept on the project as `serversOk` and
`serversNo`, name to a fingerprint of the definition (`folderServers()`), so
a changed definition is asked about again. `start()` passes every name not in
`serversOk` as `settings.disabledMcpjsonServers`. In the off-screen tests
`CLAAMP_SERVERS=yes` or `no` (with `CLAAMP_DEV=1`) gives the answer, so no
dialog shows.

**The account filter.** Claude Code writes the organisation id of the account
in use into each chat's file. `chat-owners.mjs` reads it back (the start of the
file, then its end; `tests/chat-owners.test.mjs`), and `accountsKnown()`
(`accounts:known`) gives the window the account signed in now, the accounts
seen so far (`state.accounts`: email and organisation name by organisation
id) and the owner of every saved chat, remembered in `chat-owners.json` so a
chat is read once. In the window, `passesAccount()` narrows `renderProjects()`
and `renderChats()` by the choice in `#accountFilter`. It is a convenience
for telling chats apart, not a wall: the files are untouched. To test it,
`mk-owner-case`-style: a scratch `CLAUDE_CONFIG_DIR` with chat files naming
two made-up organisation ids, and a scratch profile whose `accounts` names
them.

`signOut()` (`auth:logout`, the **Sign out** and **Switch account** buttons
in Settings) asks in a system dialog, then runs Claude Code's own
`auth logout`; for a switch the window then starts the ordinary sign-in
(`auth:login`). Nothing of the sign-in is read, kept or chosen here, and
there is no list of accounts: that would mean holding sign-ins. To test it
without signing anyone out, start the test with `CLAUDE_CONFIG_DIR` set to an
empty scratch folder, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` unset (or
`childEnv()` drops the scratch setting), `CLAAMP_SIGNOUT=yes` or `no` as the
dialog's answer, and check first that `auth:status` says not signed in.

`checkForUpdate()` (`update:check`, the **Check for updates** button in
About) is the one place the app asks GitHub anything, and only on that
press: the newest commit on `main`, and for a git copy how far `ownCommit()`
is from it. For a copy that is behind it also reads `docs/whats-new.md` from
GitHub and shows the notes this copy's page lacks (`whats-new.mjs`,
`tests/whats-new.test.mjs`), as plain text. It downloads and runs nothing.

**Every change a person would notice gets a line in `docs/whats-new.md`**, in
the same commit, under the day's date ("20 November 2026"), written for a
user and not a developer: what they can now do or what stopped going wrong,
in a sentence or two, no file or function names. That page is what Check for
updates shows and what the guides list as "What's new".

`desktopChats()` reads the model and effort the Claude desktop app saved for
each chat (`%LOCALAPPDATA%\Claude-Data\*\claude-code-sessions`). That layout
is not documented; the reader skips whatever it does not understand.

## Events: main process to window

Sent on the `amp:event` stream. Every event has `projectId`, `ts` and `t`.

| `t` | Fields | Meaning |
| --- | --- | --- |
| `user` | `text` | A prompt was sent. |
| `think` | `text` | A piece of Claude's thinking, as it comes. |
| `delta` | `text` | A piece of the reply, as it comes. |
| `assistant` | `blocks`, `usage`, `isMain` | A finished message: `text`, `thinking` and `tool_use` blocks. |
| `tool_result` | `id`, `text`, `isError`, `isMain` | What a tool gave back. |
| `permission` | `id`, `tool`, `input` | Claude asks to use a tool. |
| `permission-done` | `id`, `isAllowed` | That ask was answered. |
| `result` | `isOk`, `wasStopped`, `cost`, `durationMs`, `turns`, `contextWindow`, `error` | A turn ended. |
| `error` | `message` | The process stopped mid-turn. |
| `status` | `status`, `detail`, `agents`, `queue` | WORKING / WAITING / COMPLETE / ATTENTION and what it is doing. |
| `init` | `sessionId`, `model` | The process named its conversation and model. |
| `limit` | `status`, `kind`, `resetsAt` | A plan limit moved; the Usage panel reads again. |
| `reload` | `events` | Another app added to the chat; here is the whole chat again. |

`think`, `delta`, `status`, `init` and `limit` are not written to the
transcript file; the rest are, so a chat can be redrawn after a restart.
`apply()` in `renderer/app.js` folds each event into a project's state.

The music helper's status lines arrive on the `amp:deck` stream.

`amp:update` carries `{ kind }` when files change on disk while the app is
open (`watchForUpdates` in `main.mjs`): `styles` (a stylesheet or a skin; the
window reads them again at once), `page` (`renderer/*.js` or `.html`; the
title bar offers Reload) and `app` (`*.mjs`, `preload.cjs`, `deck/`; the
title bar offers Restart). Windows reports reads as changes too, so only a
moved "last written" time counts.

## Calls: window to main process

The window calls `window.amp.call(name, ...args)`. A name not listed in
`preload.cjs` throws. The handlers are the `handlers` object in `main.mjs`.

| Group | Calls |
| --- | --- |
| State | `state:load`, `prefs:set` |
| Projects | `project:add`, `project:remove`, `project:transcript`, `project:send`, `project:stop`, `project:new`, `project:mode`, `project:permission`, `project:branch`, `queue:remove` |
| Saved chats | `sessions:list`, `sessions:open`, `chats:all`, `chats:open` |
| Panels | `session:info`, `session:usage`, `session:servers`, `session:model`, `session:effort`, `session:fast` |
| Connectors, plugins | `mcp:reconnect`, `mcp:toggle`, `mcp:authorize`, `plugins:list`, `plugins:toggle` |
| Skins | `skins:list`, `skins:use` (checks a skin, asks the person if it needs it, and hands back the stylesheet's address plus `pictures`: each variable that names a picture, with the picture's full address in the skin's folder, because a picture named in a variable is otherwise looked for beside `renderer/styles.css`), `skins:import` (a Winamp skin file to a new skin), `skins:folder` |
| Sign-in | `auth:status`, `auth:login` |
| Window, media | `win`, `pick:video`, `music:scan`, `music:add`, `music:remove`, `music:playlist` (keeps the file's path in `prefs.playlists`), `music:unlist` (takes it out), `deck:cmd` (includes `web-app` with `spotify` or `other`: which app's playback the helper follows) |
| YouTube Music player | `player:which` (the browsers found), `player:browser` (opens the fixed address as an app window of that browser: `openBrowserPlayer`). `spotify:open` starts the Spotify app. The app itself holds no web player and uses no internet. |
| Dictation | `dictate:start`, `dictate:stop`; heard text arrives on the `amp:dictate` stream as `{ text }`, then `{ done }` or `{ error }`. Helper: `deck/dictate.ps1` (set `CA_WAV` to a sound file, with `CLAAMP_DEV=1`, to test without a microphone). |
| Cover art | `music:cover` (a listed song's picture as a data address, with `from`: `song` or `folder`; `readCover` in `music-library.mjs`). The picture of what another app plays arrives once per song on `amp:deck` as `{ ev: 'art', key, data }`. |
| Attached player window | `player:state`, `player:hide` (true or false); state arrives on `amp:player` as `{ count, hidden }`. Helper: `deck/player-window.ps1`, started by `startPlayerHelper` with the Cla-Amp window handle and the `player-profile` folder; commands on its standard input are `find`, `place x y w h` (screen pixels, from `playerRect`), `hide`, `show`, `close`, `release`. It makes the Cla-Amp window the owner of the browser's app window; when its input ends it closes the player. `app:restart` sends `release` first so the music plays on. Its state is one table (`$s`) because the file is run as a block of text, where functions cannot assign to outer variables. Set `CA_DEBUG=1` to have the helper name the windows it finds. |
| Agents running, outside the app | `outside-work.mjs` and `watchOutside` in `main.mjs`: every 4 s the end of each Claude Code chat file saved in the last 15 minutes is read to see whether its last turn is finished; working chats and their agents are added to the status bar count, and chats Cla-Amp runs itself are skipped. A turn older than 15 minutes by its own time is not working even in a freshly saved file (the desktop app saves old chats again), and neither is an agent whose last step handed its report back. Test: `tests/outside-work.test.mjs`. |
| Files with a message, quotes | `attached` in `renderer/app.js` holds full paths: from a drop anywhere on the window or a paste (`attachFrom`, which asks `window.amp.pathOf` in `preload.cjs` for a file's path; a pasted picture has none, so `attach:paste` in `main.mjs` saves it in the data folder's `attachments` folder first) or from the paperclip (`attach:pick`). `project:send` takes the paths (`cleanFiles`: full paths that exist, any number); `promptContent` turns the prompt into a text block that lists the paths plus a picture block for each picture up to 3.5 MB, for the first 20 pictures (larger or later ones go by path only, and Claude reads them itself). The chat shows the same text, and the pictures through `picturesOf`. `quote()` puts marked chat text into the message box as `> ` lines; the pop-up button is made in `wire`. The box's height is set by `fit` (up to 45% of the window). Checked hidden with a dropped made-up picture; not yet sent to Claude for real. |
| Pictures in the chat | `picturesOf` in `main.mjs` saves each picture a tool gives back (a screenshot, an image file Claude read) once in the data folder's `pictures` folder; `paintPictures` in `renderer/app.js` shows them under the tool's line. Click one to enlarge it. |
| Row under a reply | `paintActions` in `renderer/app.js`: Copy (`text:copy`), Fork (`chats:fork`, a new chat that holds this one up to that reply, made by Claude Code's own `forkSession`), Pin (kept per project in the window's storage, shown in the row above the chat), Read aloud (the Windows voice), and when it was posted. Saved chats carry each line's real time. |
| Icon and logo | `renderer/brand`: `icon.ico` (window and taskbar), `icon-small.png` (the default `--logo`, which a skin may replace), `icon.png` (About in the window: each skin colours the name itself). |
| Equalizer | `renderer/equalizer.js`: preamp and ten bands (Web Audio). Songs from My files play in the window itself so the sound can be shaped: `music:bytes` in `main.mjs` gives a library song's bytes, `tuner.take` is offered every deck command first, and `onDeck` in `renderer/app.js` reads the tuner's state in place of the helper's. A kind of file the window cannot play goes to `deck/deck.ps1` as before. `hush` in the helper pauses other apps' music. The window is kept out of Windows' media sessions (a switch at the top of `main.mjs`), so the deck never takes Cla-Amp's own song or video for another app's music. |
| Live music and the open tab | In `renderer/app.js`, `deck.source` is the music that is live (the top bar and the transport follow it) and `deck.tab` is the tab being looked at (`tabOf`). Opening another tab while music plays changes only what the deck lists; `goLive` switches the live source when play is pressed in the deck or a song is picked there. |
| The open tab's own music | The deck panel (title, cover, time line, its play button) shows the open tab's music, not the live one: `tabWeb()` gives the live player on the live tab and `deck.view` on any other. `syncView` (run from `renderDeck`) tells the helper which waiting player to report with `view-app spotify|other|none`; `deck/deck.ps1` answers in the status line's `view` field and sends that player's cover too (covers are kept by song key in `deck.arts`). `deck.pos`/`deck.dur` are the live music's (top bar), `deck.tabPos`/`deck.tabDur` the open tab's. On a tab that is not live the time line cannot be dragged, the play button shows play, and Previous/Next first make the tab live. |
| Spectrum looks | `renderer/spectrum.js`: Solid bars, Thin bars, Line, Filled wave, Mirror, Dots, beside the LED bars `drawBars` draws. A click on either spectrum goes to the next; the choice is kept in the window's storage. All use the skin's colours. |
| Customize | `renderer/look.js`: per-part colour, picture, see-through, edge, text and corners, written as style rules on top of the skin. Kept in the state file as `look` by `look:set` (`cleanLook` in `main.mjs` keeps only known parts and fields); chosen pictures are copied into the data folder's `look` folder. |
| About | `renderer/about.js`, filled by `about:info` (versions and each package's licence, read from `node_modules`). |
| Accessibility | `renderer/access.js`, with its rules at the end of `styles.css`. Calm: `body.calm` (localStorage `calm`, else the `prefers-reduced-motion` setting) stops every animation and transition in CSS, and the spectrum loop in `app.js` rests its bars; anything new that moves by itself must stop under `body.calm`. Size: `zoom:set` in `main.mjs` (`setZoomFactor`), kept in localStorage `zoom`, Ctrl with + - 0. `announce(text, isNow)` writes into a hidden live region for screen readers; use it for what happens without the person acting (a reply finished, a permission asked). `asKey(node)` makes a clicked element that is not a button reachable with Tab and pressed with Enter or Space: use it on every new one, or use a `button`. The module also sets `role="tab"` and `aria-selected` on `.tab` and `.seg-btn`, `aria-pressed` on the switches listed in `SWITCHES`, `aria-expanded` on panel headings, hides canvases from screen readers, gives the right-click menu (`popMenu`) arrow keys and focus, and opens that menu from the menu key. Never remove a focus outline without putting another sign of focus in its place. The High Contrast skin is `skins/high-contrast`; `@media (forced-colors: active)` covers Windows' contrast themes. |
| Notices | `renderer/notice.js`: `chime(isOk)` makes the done chime from plain tones with Web Audio (no sound file), `flash()` asks `win:flash` in `main.mjs` to flash the taskbar button until the window has the focus again. Both are called from the `amp:event` handler in `renderer/app.js` on `result` (flash and chime) and `permission` (flash only). The choice is `localStorage` `notices` (`flash`, `off`, or absent for both), set under Widgets, Notices, or with the bell `#chimeBtn` in the title bar. In the same handler `tell(project, news)` marks a project row (`.proj.news` with `done`, `asks` or `failed`) when its chat was not the one being looked at; `seen` clears it when the project is opened or the window gets the focus. |
| Mute, Escape, closing | The speaker by each volume slider is a button (`.vol-mute`, made where the sliders are wired in `renderer/app.js`): muted is the slider at 0, and the level before is kept in `localStorage` `volBefore-<source>`. One `keydown` handler next to the Widgets menu's code closes, on Escape, the Widgets menu, the picker, the floating video and Arrange mode; dialogs, right-click menus, the "/" list and the working list close themselves. The window's `close` handler in `main.mjs` always asks first (`dialog.showMessageBoxSync` over the window): a plain question when nothing runs, a warning that counts agents and waiting messages when something does; a restart asks only when something runs, and a hidden test run never. |
| Languages | The code writes English everywhere. `renderer/lang.js` swaps each piece of the window's own text for its translation as it reaches the page (text, `title`, `placeholder`, `aria-label`; a MutationObserver, only when the language is not English), from one file of pairs per language, `renderer/lang/xx.js` (`export default` and plain JSON, English text to translated text; `{}` stands for a changing part, `{1}` `{2}` where the order differs). Nothing at a call site changes, and a piece with no pair stays English. Areas that hold a person's or Claude's words are skipped (`OWN` in that file; add `data-own-words` to a new one). A list choice with no `value` gets its English text as its value before it is translated, so code that goes by the value still works; do not read English back from `textContent`. The choice is in localStorage `lang` (none: the computer's language); the picker is in the Widgets menu. `node tools/lang-strings.mjs` lists the English pieces found in the code (`--write` puts them in `renderer/lang/strings.json` for translators) and says, per language, what is not translated yet and which pairs have the wrong number of `{}`. Text shown by the main process in Windows' own boxes is not translated. |
| Guides | `renderer/guides.js`: the README and the guides in `docs` read inside the window (`docs:read` in `main.mjs` gives only those files). Links between guides open here; web links are shown as plain text. Opened by the ? button, from Customize (Skin guide) and from About. |
| Settings | `renderer/settings.js`, filled by `settings:read` in `main.mjs`: the account (from `claude auth status`) and what each of Claude Code's settings files sets (user, project, local). Read only; environment variables are shown by name, never by value. `settings:open` opens a file in the editor; `settings:web` opens claude.ai settings in the browser. |
| claude.ai, docked | The Claude.ai button (`claude:open` in `main.mjs`) opens claude.ai in the player's browser profile as a third docked window (`site claude` in `deck/player-window.ps1`, told apart by its title); pressing again tucks it away or brings it back. Nothing is added to the page and nothing there is read: it keeps its own look. |
| Work done in another app, shown live | A chat that is open here as a project but is being worked on elsewhere (the desktop app, a terminal) shows the same "doing now" line under its last message: `watchOutside` in `main.mjs` marks such a chat's row with `projectId`, `elsewhere(project)` in `renderer/app.js` finds it, and `liveNow` takes the last unfinished tool call of the last message (its description and start time; `span` writes "2m 17s"), else what the chat's file says it is doing. The chat itself is re-read by `watchChats` every four seconds when its file changes, and on the first look whenever the file is newer than what this app last read (`readTo`, kept with the project). The desktop app's own task list shows too: `noteTask` reads its `update_plan` calls (the whole list, a step forward, or steps by number) and its `wrap_up` (all done) into the same list Claude Code's task tools fill. |
| Context panel | `session.context()` in `main.mjs` asks Claude Code for its own count of what fills the context (`getContextUsage`, the data behind `/context`); `renderContext` in `renderer/app.js` draws it the way the desktop app does: "N% used" with used / limit, one bar, a row per part, the buffer and free space, the parts loaded only when needed, and under it where the chat works (folder, branch). Read when a project's engine info loads and after each reply. The old Context EQ panel is gone. |
| Usage rings, model name | `usageRing` draws each plan limit as a ring of what is used, the figure Claude's own apps show (amber over 75%, red over 90%); the limits are read again after each reply and every minute, and a 5-hour row shows only when the plan reports one; `modelName` turns the id a reply names into the name people say ("claude-fable-5-2" is "Fable 5.2"). |
| Reply buttons, finished task list | `paintActions` draws copy, fork, pin and read aloud as small icons under each whole reply, the last reply of a chat read from its file included. A fork holds the same messages as the chat it came from, so after one the chat gets a note saying it is a new chat, the Code list is read again and the fork is marked as the open chat (`chats:fork` gives back `forkId`); a fork that fails says so. In `renderTail`, a task list whose steps are all done folds into one line ("5 steps done") once nothing is working. A list from the desktop app's `update_plan` (`project.isDesktopPlan`) is dropped by the next message (`apply`, case `user`) even when steps are open: that app gives every new message its own list, and a copy of its chat run here has no `update_plan` or `wrap_up` to finish the old one. |
| Suggested next message | The engine is started with `promptSuggestions`; its `prompt_suggestion` message becomes a `suggest` event, shown as the message box's placeholder. Tab on an empty box takes it. It only comes for chats Cla-Amp runs itself, after a reply. |
| Following the Claude desktop app's chats | `deskChats` in `main.mjs` reads the desktop app's own session records (one `local_<id>.json` per chat under its `claude-code-sessions` folder: `%LOCALAPPDATA%\Claude-Data\<install>\` for the Store install, `%APPDATA%\Claude\` otherwise), every twenty seconds at most, and only reads: nothing there is ever written, and no sign-in file is opened. From each record: the title the desktop shows, whether it archived the chat, the project a worktree chat belongs to (`originCwd`) and the chat that started it (`spawnedFrom`). `titleOf` prefers the desktop's title; `chats:all` and `sessions:list` leave out chats the desktop archived and add `group` and `parent`; `renderChats` in `renderer/app.js` puts a worktree chat with its project and nests started chats under their parent behind a fold with their count (closed to begin with; a search shows a flat list). Each row carries a thin line per level it sits in (`.guide`: the folder's, then one per parent). Chats working right now are marked: `watchOutside` sends the chats working in other apps (`list`) and in this one (`here`); a working row gets a pulsing dot and the step it is on in its tooltip, a fold with a working chat under it is outlined, and the folder's head says "N running". The layout of those records is not documented, so a desktop update can change it: a record that does not look as expected is skipped and the chat shows as Claude Code alone names it. The desktop's own sidebar groups (a named group holding several folders) are not in these records and are not followed. |
| Opening a chat, speed | `openSaved` in `main.mjs` keeps the messages of the last eight chats it read (`readChats`, checked against the file's last change), because the engine reads a chat's file whole: seconds for a long chat, far more when the file is not in the system's cache. The row lights up and the pointer shows "busy" at once (`openSavedChat` in `renderer/app.js`). Test switch `CLAAMP_TIME=1` prints every call over 150 ms and every stretch in which the app could not answer. |
| Background agents | In a chat this app runs, an agent is listed from its `Agent` tool call until that call's result. A background agent's call answers at once, so those are followed by the engine's own messages instead: `task_started` (with `is_backgrounded`), `task_updated` (moved to the background later) and `task_notification` (ended) fill `session.tasks` in `main.mjs` and send `agent-bg` / `agent-bg-done`; `agentCount` counts both kinds, and a background agent keeps the chat counted as working after its turn ends. Background work that is not an agent (a command, a workflow, a monitor; named by `taskKind`) is kept the same way with `isAgent: false`, sent with `isTask: true`, counted by `taskCount` (part of `agentCount`) and named separately in the close warning; cloud agents (`remote_agent`) and the engine's `ambient` tasks are left out, since closing does not stop the first and the second is housekeeping. A working background row has a stop control (`task:stop` → `session.stopTask` → the SDK's `query.stopTask(task_id)`); the engine answers with a `task_notification` of status `stopped`, which ends the row like any other and is not shown as a failure. `perTaskStopAffordance` is not declared, so the chat's own Stop still ends background work too. In the window (`renderer/app.js`) such an agent keeps its "working" badge until `agent-bg-done`. Agents of chats in other apps are found from their files (`outside-work.mjs`). When a background agent ends, the engine starts a turn by itself so Claude can react; the first reply of such a turn marks the chat as working (`isBusy`), so its end is told like any other turn's. Run for real once: the turn ended at 3 s with the agent still listed as working, the agent ended at 12 s, Claude's own follow-up turn ended at 16 s and the chat went back to Done. |
| Skins "Blue 2001" and "Aqua Glass" | `skins/blue-2001` (light: cream panels, blue title bar and side column, in the style of early-2000s desktops) and `skins/aqua-glass` (see-through blue glass, glows and bubbles, in the style of late-2000s desktops). Variables plus ordinary CSS; every shape is a gradient drawn in the file, and no picture, icon, sound or name of any operating system is used: keep it so. `skins/mystery-98` ("Study 98" on screen; the folder keeps its first name so a person who has it on keeps it) is a third in the same manner (late-1990s desktop in teal, olive, orange and cream; its raised, pressed and set-in edges are the three shadows `--up`, `--down` and `--well` at the top of its file). `skins/silver-2013` is a fourth (early-2010s desktop: silver toolbar, blue-grey side column, white paper, three coloured lights for the window buttons). Blue 2001, Study 98 and Silver 2013 are the light skins, so a new chat piece with a fixed dark background needs a light rule in its `skin.css` (see its last block). Pictures: `docs/pictures/cla-amp.png`, `skin-aqua-glass.png`. |
| Basic buttons keep their places | `renderer/places.js`, with its rules at the end of `styles.css`. The title bar, the button row and the message box's buttons have the same place and size in every skin: the rules fix heights, gaps, margins, padding and order with `!important` (the one place the app overrules a skin), and `places.js` sets the width of each button with words on it from what the words need in the standard typeface (Segoe UI) plus 15%, then makes a skin's wider words smaller (down to 70%) so they fit. It runs again when a skin lands, a typeface loads, the Customize choices change or a button's words change. Check with a hidden demo run that swaps `#skinSheet` through every skin and compares `getBoundingClientRect` of the buttons: nothing may differ. Big picture buttons (body class `has-toolbar`: pictures over labels, drawn as inline SVG in `index.html`, plus Theme, Settings and Help, which press the title bar's own buttons) are the person's choice under Widgets, Buttons (`localStorage` `bigButtons`), no longer a skin's. |
| Window glass | An extra a skin switches on with a variable, read every two seconds by `skinExtras` in `renderer/app.js`: `--window-glass: acrylic` (or `mica`, `tabbed`): `window:glass` in `main.mjs` makes the window's background see-through and asks Windows for the material (`setBackgroundMaterial`, Windows 11 22H2 or later; elsewhere nothing happens and the skin's own backdrop shows). The body gets class `glass` only when Windows took it. Not yet seen on a real screen: off-screen pictures cannot show it. |
| Widgets | Four panels of the right column, in every skin, each its own `.panel.widget` (`wg-time`, `wg-calendar`, `wg-chat`, `wg-today`) that can be dragged and folded like any panel. Which show is the person's choice: the Widgets button at the bottom of the column (`wireWidgets` in `renderer/app.js`) and the small cross in each head; kept in the window's storage (`widgets`, `zones`). Time: the clock, the date, the computer's time zone and up to five more picked from the zones the computer knows. This chat: counts from the open chat. Today: `today:stats` counts the chats changed today and the messages typed in them, from the last four megabytes of each such chat's file, at most once a minute (about half a second for 80 chats). `renderWidgets` runs every two seconds and draws only the widgets on show. |
| Themes | A theme is a skin plus what the person changed on top: the Customize choices, the panels' order, folds and columns, the widgets on show, the second column, the top player's size, the extra time zones. `renderer/themes.js` is the Themes dialog (title bar, and the picture toolbar's Theme button): what is in use ("Custom theme" when it differs from what was last put on, compared with `themeBase` in the window's storage), saving it under a name, and one list of saved themes and skins with where each came from (comes with the app, the person's skins folder, a saved theme). Saved themes are single JSON files in `%APPDATA%\Cla-Amp\themes`; `cleanTheme` in `main.mjs` fixes what one may hold and cleans every file read, an imported one included (`themes:list`, `themes:save` with `replaces` for a rename, `themes:delete`, `themes:export`, `themes:import`). Putting one on (`putOn`) writes the layout into the window's storage, sets the look and the skin, and reloads the window; chats keep running. A picture set in Customize is a file on this computer, so an exported theme does not carry it. |
| Second column | `#right2` beside the right column, shown with body class `col2` (the tick in the Widgets menu; kept as `col2`). Panels are dragged between the columns by their headings; a drop on a column's empty room puts the panel at its end. `savePanels` keeps each panel's name, fold and column. Switched on empty, it takes the widgets; switched off, its panels go back to the first column. It has the first column's width and no splitter of its own yet. |
| Top player | The player in the banner has two lines: buttons, title, next songs and volume, and under them its own time bar, always on show. Three sizes (`playerSize` in the window's storage, body class `player-s`, `-m`, `-l`, set beside "Player in the top bar"). The small spectrum moved to the button row (`.top-eq`), drawn as wide as the room it has (a `ResizeObserver` sets the canvas's width). |
| Guides and dialogs | The first guide is `docs/user-guide.md`, written for people using the app (no code, no install steps); the README and this file come last, named as for developers. Dialogs are wider (`.sheet` 860 px, guides 1180 px, themes 980 px, less on a small window). |
| Floating things are solid | Dialogs, the conversation picker, the working list, the "/" list, the pull-request card and drop-down options use `--solid` (else `--panel`) and no blur, whatever the skin: text over glass was hard to read. A see-through skin sets `--solid`. A skin that gives parts their own blur (each becomes a layer) must also lift the status bar above the columns, or the working list is covered: see the end of `skins/aqua-glass/skin.css`. |
| Pull requests per chat | The desktop app's record of a chat lists its pull requests (number, repository, state, branch; no titles or line counts, which the desktop fetches from GitHub). `deskChats` passes them on, `renderChats` draws a branch icon with the count (green when one is open, grey when all are closed) and `showPrs` lists them while the pointer is on it. Cla-Amp asks GitHub nothing. |
| Archiving and deleting a chat | Only for chats this app's engine made: `madeHere` in `main.mjs` reads the entry point named in the first lines of the chat's file (`sdk-ts`; the desktop writes `claude-desktop`) and the desktop must have no record of it. `chats:archive` (the engine's `archiveSession`: hidden from lists, kept on disk, a new message brings it back) and `chats:delete` (`deleteSession`, after a system box asks) refuse any other chat and one that is open in a project. The two buttons show on such a row in the Code tab. |
| Compact session | The button under the Context rows sends Claude Code's own `/compact` as a message (`project:send`) after a confirm; it is off, with the reason as its tooltip, while Claude is working, while the chat is worked on in another app, or when there is no chat yet. The engine's `compact_boundary` message becomes a `compacted` event, shown as a note with the size the chat had. |
| Commands and skills on "/" | `session.commands()` in `main.mjs` asks the engine what it has for this project (`supportedCommands`: built-in commands, skills, plugin commands), read when a project's engine info loads. Typing "/" in the message box lists them (`renderSlash` in `renderer/app.js`: names that start with what was typed first, then names and descriptions that hold it); arrows move, Tab or Enter fills the name in (`takeSlash`), Escape closes. The command is sent as an ordinary message; Claude Code runs it. |
| The docked player's volume | The YouTube Music and Spotify tabs have a volume slider too. It sets that player's own row in Windows' volume mixer, not the computer's volume: `AppVolume.Use` in `deck/deck.ps1` finds the sound sessions of the player's programs (`Player-Pids`: the browsers started with the player's profile folder, passed in as `CA_PROFILE`, plus Spotify) and reads or sets their level. Command `web-vol`, level in the status line as `wv` (-1 until the player has made sound, and the slider hides until then). `wireVolume` in `renderer/app.js`: the deck's slider sets the open tab's music, the top bar's the live music. |
| Top time bar, button row | The row under the top player starts with Claude.ai, Open chat, New chat and Shuffle projects; the rest of it is a time bar for the live music (`#topSeek`, same commands as the deck's own: `seek` for files, `web-seek` for a docked player). |
| Closing, tray | `win.on('close')` in `main.mjs` asks first (a system box, "Keep Cla-Amp open" / "Close anyway") when any project is working, has agents out or has messages queued; a restart asks the same. Closing tells the player helper `close`, and `Shut` in `deck/player-window.ps1` closes every docked window, hidden ones too, waits four seconds and then stops the player-profile browser if it is still there. The browser is started with `--disable-background-mode` so nothing of it stays behind. `startTray` puts an icon by the clock: Open Cla-Amp, Show/Hide the docked window, Quit (the same close, so it asks too). The tray is left out of test runs that take a picture. |
| Videos named in the chat | `videoNames` and `paintVideos` in `renderer/app.js` pick video file names out of a finished reply (whole paths, names in code marks or links, tool commands and results); `video:find` in `main.mjs` keeps the ones that exist. Each gets a play button that opens the floating player. There is no Video button any more. |
| Players in the browser (YouTube Music, Spotify web) | `player:browser` (browser, site `ytm` or `spotify`, quiet), `player:which` (the browsers found, and `docks`: those whose window is docked). `openBrowserPlayer` starts the browser with `--app=` and, for the browsers in `DOCKS`, a profile of its own (`player-profile` in the data folder). No extension is loaded and no browser protection is switched off. What is playing, and play, pause, next and previous, go through Windows' media controls in `deck/deck.ps1`, which also holds one-source-at-a-time (`Pause-Others`, `Get-Playing`). Nothing reads the players' pages. |
| Live updates | `app:reload` (the main process reloads the window; the page itself may not navigate), `app:restart`. The sessions live in the main process, so a restart ends them. With work going on (`busySessions`), `app:restart` asks in a system box: wait (`idleRestart` checks every 2 s and calls `restartNow` once nothing is busy; the chip reads "Restarts when work is done", sent as `amp:update` kind `waiting`), or restart now and carry on (`state.carryOn` keeps each busy project's id and queue; `carryOn`, 1.5 s after the next window loads, sends `CARRY_ON` to each chat that was working and then its queued messages). Neither path has been run with real work yet. |
| Claude in Chrome | `prefs.useChrome` (set by the `#useChrome` switch through `prefs:set`); when true, `Session` passes `extraArgs: { chrome: null }` to `query()`, which starts Claude Code with `--chrome` and gives the chat the `claude-in-chrome` tools. Read when a session starts, so it applies to the next new chat or after a restart. Every tool use still goes through `canUseTool`. |
| Day usage in the calendar | `noteSpend` in `main.mjs` runs on every `result` message: it takes the new part of Claude Code's running totals (`total_cost_usd`, `modelUsage`) since the turn before and adds it to `state.days[date]` (cost, input, output, cacheRead, cacheWrite, turns). `today:stats` returns today's as `spend`; `noteToday` in `renderer/calendar.js` keeps it with the day, `notePeak` keeps the day's highest context and week-limit percent, and `usageLines` words them for the day sheet and the report. Only chats run in Cla-Amp are counted. |
| Arrange mode | In `renderer/app.js`: blocks carry `data-block` (`logo`, `player`, `buttons`, `spectrum`) or are `.cols .panel`; slots carry `data-slot` (`SLOT_KIND` says row or column). `setArranging` makes blocks draggable and adds `body.arranging`; document-level capture handlers for `dragstart`, `dragover`, `drop` take over all dragging while it is on (the panels' own handlers never see it), `blockAfter` finds the insert point, `settleBlock` marks the block (`moved`, `in-col`, `in-row`). `savePlaces` keeps each slot's blocks in localStorage `places`; `putPlaces` restores them at the start, after the panels' own order. The page is otherwise unchanged: ids keep working wherever a block sits. |
| Layout choices | `LAYOUT_CHOICES` in `renderer/app.js`: each choice (kept in localStorage `layout`) is a class on `body` (`projects-right`, `panels-left`, `status-bottom`, `eq-s`, `eq-l`) set by `putLayout`; the rules in `styles.css` move sections with `order`, never by changing the page. The Widgets menu draws the pickers. `renderer/themes.js` saves them in a theme with the widths and hidden columns (`LATER_KEYS`); a theme from before says nothing about them. |
| Smallest window width | `tellLeast` in `renderer/app.js` watches the side columns (`#left`, `#right`, `#right2`) and sends their widths plus room for the chat (`CHAT_LEAST`) to `win:least`, which sets the window's minimum width (never under 940, never over the screen) and widens a window that is narrower. |
| Locked widths | The helper prints `#width N` when the window on show was dragged to a new width (mouse let go); `playerDragged` in `main.mjs` keeps it in `prefs.playerWidths[site]` (`keepPlayerWidth`, read by `playerWidth()`) and resizes Cla-Amp: while the two fill the screen (`dockedFrom` set) Cla-Amp takes the rest, else it narrows only when the new width does not fit beside it. The other way, `playerRect` gives the attached window all the room Cla-Amp leaves while docked, and keeps that width. |
| Cla-Amp's browser | `openPage(href)` in `main.mjs` starts Chrome (else the first browser found) as an ordinary window with tabs, with `--user-data-dir=pagesProfile()` and the address (none: its start page), sets `prefs.playerSite = 'pages'` and tells the window helper. Callers: `pages:toggle` (the `#pagesBtn` Browser button: open, tuck away, bring back), `file:browser` (a `.html`, `.htm`, `.pdf` or `.svg` file) and `openLink` for localhost links; the last two fall back to `shell.openExternal`. A claude.ai link goes to `openBrowserPlayer('', 'claude', false, address)`: the attached claude.ai window's profile. `deck/player-window.ps1` follows a second browser process (`CA_PAGES`) and counts its windows, tabbed ones included, as site `pages`. It shares the one attached spot with the players: the others stay tucked away and keep playing. |
| File viewer | A name in a reply opens the file in a sheet. In `renderer/app.js`: a `marked` token walk turns a link that is not a web address into `#file:<name>` (so the cleaner keeps it), `markdown()` then makes those links, and inline code that matches `FILE_NAME`, into buttons (`asFileLink`); `openFile` draws the sheet (Markdown through the same `markdown()` cleaner, text through highlight.js, a picture as an `<img>`). In `main.mjs`: `fileNamed` resolves the name (full path, or inside the project's folder; a line number is dropped), `file:view` returns text up to 2 MB or a picture's address, `file:reveal` shows it in its folder, `file:browser` opens only `.html`, `.htm`, `.pdf` and `.svg` in the browser. No file is ever loaded as a page inside the window. |
| Calendar: due dates and day reports | `renderer/calendar.js`: `drawCalendar` draws the month (turn it with the arrows), marks days (a dot for something due, red when late; a bar for a day with a report) and lists the three nearest open due dates; `openDay` is the day's sheet (due dates, each optionally tied to the chat in view; the day's kept numbers and chat names; the person's notes; "Put the report in my message" uses `quote`). Kept in `localStorage` as `calendar` (`due`, `days`). `noteToday` keeps the day's numbers each time `today:stats` answers (which now also gives the chats' titles), so a past day has a report only if the app was open that day. All optional: unused, the widget is just the month. |
| Model panel on a switch | `loadEngine` in `renderer/app.js` fills the panels at once: from `engineKept` (the same chat's last full answer), else from `project:describe` (the saved model and effort, no process started) on the last list of models (`engineLast`); the full answer from `session:info`, which starts the chat's Claude Code process, replaces it seconds later. Timed hidden with two scratch projects: 47 ms on a first visit, at once on later ones. |
| A draft per chat | `drafts` in `renderer/app.js` (a key from `draftKeyOf`: the saved chat's id, which `describe` in `main.mjs` gives as `chatId`, or the project entry for a chat not saved yet; `boxKey` is the chat the box's text belongs to, and `nameChat` moves a draft when a new chat gets its id) to `{ text, files }`, kept in `localStorage` as `drafts`): `select` calls `keepDraft` for the project being left and `takeDraft` for the one opened; sending clears it, and `pagehide` keeps it across a reload or restart. |
| Two chats in one folder | A project entry runs one chat. `placeFor` in `main.mjs` decides where a saved chat opens (`chats:open`, `sessions:open`): the entry already holding it (if it is working there, the window only goes to it: `isOpen`), else an entry for that folder with nothing going on (`isFree`), else a new entry for the same folder (`anotherFor`, named "Name (2)", same trust and mode). "New chat" beside a working chat does the same through `project:another`. So a working chat is never stopped by opening another. The rule was checked with made-up entries; not yet with two real chats working. |
| Which sound belongs to a tab | `Pick-Session` in `deck/deck.ps1`: the Spotify tab takes a media session named with `spoti`, the YouTube Music tab one named with `youtube` (the player's own app window), and a plain Edge, Brave or Chrome session only while the app says that browser holds the player (`web-site`). Anything else playing on the computer (a video in another browser) belongs to neither tab. |

To add a call: write the handler, add its name to `CALLS` in `preload.cjs`,
and check what the window sends before using it (see
[security.md](security.md)).

## Adding a panel to the right column

1. In `index.html`, add `<section class="panel" data-panel="name">` with an
   `<h3 draggable="true">` heading and a `<div class="panel-body">`.
2. Fill it from a `render...` function in `app.js`, and call that from
   `renderStatus()` or wherever its data changes.

Folding, dragging and remembering the order come for free.

## Testing without a visible window

```bash
npm run demo
```

opens the window with made-up data and no Claude Code. For a check that shows
nothing on screen:

```bash
CLAAMP_DEV=1 npx electron . --demo --shot=shot.png
```

writes a screenshot and quits. In the demo, `window.demoMarkdown(text)` and
`window.demoEvent(event)` let a test script draw text and events the way real
ones are drawn. Options: `--wait=<ms>` before the screenshot,
`--height=<px>` for a taller window, and `--do=<file.js>`, a script run in the
page halfway through the wait whose result is printed as `[steps]`. These
flags only work when the app is started from its source folder with
`CLAAMP_DEV=1` set; a packaged app ignores them.

Without `--demo` the test uses your real saved state and starts a real Claude
Code process, so close Cla-Amp first and put back anything the script
changes. `CLAAMP_DEBUG=1` prints Claude Code's own error output.

Started from inside another Claude session, the app would inherit that
session's settings; `childEnv()` strips them.

## Real window glass and the deck's sliders (added 15 Nov)

- A skin that sets `--window-glass: acrylic` gets real glass on Windows 11: `window:glass` in `main.mjs` clears the window's background and turns the material on, and `body.glass` is set. `styles.css` then clears `html` and `body`; without that nothing shows through.
- While `body.glass` is on, `app.js` writes the window's place to `--win-x` and `--win-y` five times a second (only when it changed), so a skin can draw streaks that stay put on the screen. Aqua Glass does, and makes its frame, title bar and top bars clear; the columns keep a dark tint, and dialogs and menus stay solid (`--solid`).
- Seen on screen over a striped card: the desktop shows through, blurred. Not checked: what Windows draws when the window is not the active one.
- The deck's volume has its own line (`.vol-row`: speaker, slider, percent in `#volPct`); time bars carry a clock (`.sl-ico`).
- Aqua Glass under real glass is a thick clear pane (frame, title bar, logo bar) around solid content, with dark glowing title text and the window buttons hanging from the top edge. Windows 11 offers only its heavy frost: the older accent blur (tried through `SetWindowCompositionAttribute`) is just as heavy, and turning the material off leaves black. What Windows draws when the window is not the active one has not been checked.
- `--window-glass: clear` (no built-in skin uses it now; Aqua Glass went back to `acrylic` with a blue tint, because clear showed too much) is glass with no blur: the window is made with `transparent: true`. That can only be chosen when the window is made, so `window:glass` keeps the wish in `prefs.clearGlass` and `isClearWindow` is decided at the next start; until then the frosted kind stands in. The skin gives the pane its own tint, since nothing blurs what is behind. Seen on screen over a test card. Not tried by hand: dragging the window's edges, snapping, maximizing with a clear window.
- The older accent blurs (states 3 and 4) put on a clear window did not let the desktop through in a test; not pursued.

## The spectrum's choices (added 16 Nov)

- `renderer/spectrum.js` draws every look (21, `STYLES`), in 9 colour sets (`COLOURS`; "Skin" is the skin's own three), with a band count (`BANDS`; the deck's own bands are stretched smoothly to it) and five switches: peak marks, glow, loudest in the middle, reflection, grid lines. The look is kept in localStorage `spectrum`, the rest in `spectrumOptions`.
- A click on either spectrum goes to the next look; a right-click opens `openSpectrumMenu` (a solid `.spec-menu`, closed by a click outside or Escape). `app.js` no longer draws the LED look itself.
- Looks with moving parts (Bouncing bars, Sparks, Starfield, VU needles, Pixel rain, Live wires) keep their state per canvas in `memory` through `remember(canvas, key, make)`; a change of look or size starts them afresh. They move only while the draw loop runs, which is while the levels move.
- The colour set "Cover": `takeCoverColours` in `app.js` reads the cover picture on a 24 by 24 canvas and hands three colours (dark to bright, from the more colourful half) to `setCoverColours`; without a cover the skin's colours stand in.
- Effects (`EFFECTS`, switches in the same menu, kept with the other choices): `beat` sets `--beat` (0 to 1, from the three lowest bands) on the deck's spectrum, the top spectrum's box and the title, only when it changes by 0.04 or more; `marquee` makes `setSaid` slide a title that is wider than its place (a CSS animation on an inner `.mq` span, so setting the same text again does not restart it); `lines` puts `body.fx-lines::after` over the window. A skin asks for lines with `--screen-lines: on`; the person's choice wins (`isEffectOn`). `applyEffects` runs from `readTheme` and after each menu choice.
- Waterfall keeps its own picture and shifts it; `seen` remembers what each canvas showed so a change of look starts clean.
- The top player's width follows the window (`clamp` on `.top-song`), up to 1100 px.
- The spectrum is drawn with no music too: `isSpectrumStale` in `app.js` asks for one drawing at the start, when a skin lands (`readTheme`) and when the top canvas changes width; every look has a faint floor line.
- Themes: "Use" reloads through `app:reload` (the page may not navigate, not even to itself). `skins:link` imports a Winamp skin from the link of its page on skins.webamp.org: https only, that site only, the 32-character id in the link names the file, which is fetched from the site's file store (`SKIN_STORE`), at most 30 MB, then goes through the same converter as a picked file (`keepWinampSkin`).
- First start: with no project open the chat shows `startCard()` (`app.js`): what Cla-Amp is, then sign in, pick a folder, type. Its buttons press the window's own (`signInButton`, `addProject`, the Code tab, `guidesBtn`); `checkSignIn` sets `body.signed-out`, which switches the sign-in step between its button and "You are signed in."
- `Cla-Amp.bat` starts the app; when `node_modules` is missing it runs `npm install` first, and when Node.js is missing it offers winget or the download page. There is no installer and nothing is signed: the owner chose source only. Its paths were run in copies where the start, the install and the page were replaced by a printed line.

## Taking an engine update

Cla-Amp runs Claude Code through the Claude Agent SDK, and the SDK version in
`package-lock.json` decides which Claude Code that is (SDK 0.3.N carries Claude
Code 2.1.N). A fix made in Claude Code reaches Cla-Amp only when that version
is raised, and new versions come out nearly every day. Three things keep the
gap short:

1. **Dependabot, daily** (`.github/dependabot.yml`). A new SDK or Electron
   version arrives as a pull request with its release notes.
2. **The contract check** (`node tools/engine-check.mjs`, in `npm test` and so
   in the Checks of that pull request). It fails when the new SDK no longer has
   a function, a query method or a message subtype that Cla-Amp uses. Green
   means nothing Cla-Amp calls has gone; it cannot tell that behaviour changed.
3. **The daily Watch run** on GitHub prints the same review in its log and
   checks the rules (see [compliance.md](compliance.md)).
4. **The review** (`npm run engine`). It lists what is newer and marks the
   change notes that touch what Cla-Amp uses: the SDK's own notes, and from
   Claude Code's long list the ones about running under an app, Windows,
   background work and safety. Read the marked ones; a line that starts
   "Breaking", "Changed", "Removed" or "Deprecated" needs a look at the code
   that uses the thing named.
   It also reads the Claude desktop app's release notes
   (`claude.com/docs/cowork/changelog`): which Claude Code that app carries
   now, how many versions Cla-Amp is behind it, and what its releases since
   then say under Code and General about ground the two share (Windows,
   permissions, background work, sign-in). The desktop app is the yardstick:
   when it carries a newer Claude Code than Cla-Amp, an update is due.
   Claude Code's own change log is read from its GitHub repository; the page
   at `code.claude.com/docs/en/changelog` is made from that same file.
5. **Security advisories** (`node tools/engine-check.mjs --advisories`, in the
   review and as its own step of the daily Watch run). It reads the advisories
   published on Claude Code's GitHub repository and fails when one is fixed
   only in a Claude Code newer than the one Cla-Amp carries: that is the
   update not to sit on.

To take one:

- Merge the pull request when its Checks are green and the marked notes hold
  no surprise, or by hand: `npm install @anthropic-ai/claude-agent-sdk@latest`
  and commit `package.json` with `package-lock.json`.
- Then, on a scratch profile (`--user-data-dir`), send one message, let Claude
  run a command in the background, open an agent's window and stop a task:
  the parts that lean on the engine most. The Checks cannot do this, since
  they have no sign-in.
- A security fix, or a fix for a fault people are hitting, is worth taking the
  same day. Anything else can wait for the next batch.

People who use Cla-Amp get the new engine with `Update.bat`, which fetches the
versions the lock file names.
