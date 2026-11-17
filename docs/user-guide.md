# Using Cla-Amp

Cla-Amp is a window for working with Claude Code that looks and behaves
like a music player. Your projects are the playlist, the chat is in the
middle, and your music, your plan's limits and a few widgets sit on the
right.

## Getting it running

Download the ZIP from the project's GitHub page (green Code button, Download ZIP), unzip it, and double-click **Cla-Amp.bat**. The first time, it sets itself up; that needs the free program Node.js, which it offers to install if it is missing. After that a double-click starts Cla-Amp at once.

To get a newer version later, close Cla-Amp and double-click **Update.bat** in the same folder. Nothing updates by itself. For arranging the window to your taste, see the **Quick start** guide.

## First steps

1. **Sign in.** Press **Sign in** above the chat. Your browser opens on
   Claude's own sign-in page. Cla-Amp never sees your password.
2. **Add a project.** Press **+ Add project folder** at the bottom left and
   pick the folder you want Claude to work in. Cla-Amp asks whether you
   trust the folder; say yes only for folders that are yours.
3. **Type a message** in the box at the bottom and press Enter.

## The window at a glance

| Where | What you do there |
| --- | --- |
| Top bar | The song that is playing: previous, play, next, volume and a time bar you can drag. |
| Button row | Open claude.ai beside the window, open a saved chat, start a new chat, jump to a random project. The spectrum of the music fills the rest. |
| Status line | How many chats and agents are working (click it for the list), how full the chat's memory is, and the git branch. |
| Left column | **Projects**: your folders. **Code**: every saved chat on this computer. **Queue**: messages waiting their turn. |
| Middle | The chat. |
| Right column | Panels: widgets, the music deck, usage limits, the model, context, connectors. |

## Chatting

- **Enter** sends. **Shift+Enter** starts a new line.
- Type **/** to list commands and skills. Arrow keys move, Tab or Enter picks.
- Under the message box you choose how careful Claude is: **Ask** (asks
  before each change), **Auto-edit** (edits files without asking), **Auto** (works on by
  itself; Claude Code checks each step and asks you only for the risky
  ones) or **Plan** (only plans). **Stop** halts Claude while it is working.
- When Claude wants to run a command or change a file, a card asks you.
  **Always allow** remembers your answer for that kind of action.
- Under a finished reply, a card stands for each artifact it links and
  each document it wrote or names: click the card to open it.
- The **In this chat** panel gathers what the chat has named, the
  newest first: artifacts, documents (Markdown, text, PDF, pages and
  the like), the files Claude changed, and web links. Click one to open
  it; right-click a file for its folder, or a link to copy it.
- A file's name in a reply is a link: click it to view the file in the
  window. Right-click it for **Show in folder**, **View the file**,
  **Copy path**, and for a page or a PDF **Open in browser**.
- A command Claude ran shows as a small terminal: the command in its
  colours behind a prompt (hover for **Copy**), then what it printed.
  Long output shows its first lines with **Show all lines**; a command
  that failed has a red edge.
- The chat follows a reply as it arrives. Scroll up, even a little, and it
  stays where you are; **Latest** at the foot of the chat goes back to the
  newest message and follows again.
- A file Claude read shows as code: its name (a link), which lines, and
  the lines with their numbers in a margin and the code in its colours.
  Other tools show what they were asked as short rows, and what they
  gave back below, long results folded.
- When Claude changes a file, the card shows the change line by line:
  lines taken out in red with a minus, lines put in in green with a
  plus, the code in its colours, and a count such as +12 −3. The same
  view is in the card that asks you before a change. Under a finished
  reply, **files changed** lists every file it touched; click a name to
  open the file.
- Under each reply: copy it, fork the chat from that point, pin it, or have
  it read aloud.
- To send files, drop them on the window, paste a picture, or press the
  paperclip under the message box. To answer one part of a reply, mark the
  text and press **Quote**.
- A file's name in a reply is underlined with dots. Click it to read the
  file inside Cla-Amp: a Markdown file is drawn as a page (**Show as
  written** gives the plain text), code gets its colours, a picture is
  shown. The viewer can also copy the path, show the file in its folder,
  and open a web page or a PDF in Cla-Amp's browser. It only reads;
  nothing in the file is run.
- The **Browser** button opens Cla-Amp's own browser, attached to the
  window: a real browser with tabs and an address bar (Chrome if you have
  it, else Edge or Brave), with a profile used for nothing else. It shares
  no sign-in, history or add-on with your everyday browser. Pages Claude
  made open there as tabs: a web page or PDF from the viewer, and links to
  pages served on your own computer (localhost). Press the button again
  to tuck it away; music keeps playing. The attached window and Cla-Amp
  stay locked side by side: drag the attached window wider or narrower
  and Cla-Amp makes room, and with Cla-Amp maximised, dragging Cla-Amp's
  edge resizes the other to fill what is left. Each kind of window
  remembers its width. YouTube Music, Spotify's web
  player and claude.ai open as windows of that same browser when you pick
  Chrome for them, each shown or tucked away by its own button; you sign
  in to each there once. Opening one music player pauses the other and tucks its
  window away, so its song, its place in the song and its playlist are
  still there when you go back to it. Close a player's window yourself to
  free its memory. A claude.ai link, such as an
  artifact, opens in the attached claude.ai window, where you are already
  signed in; it takes the place of the claude.ai page that was there. Any other web link opens in your everyday browser as before.
- **Let Claude use my Chrome** (in the model panel) lets Claude work in
  your everyday Chrome, where you are already signed in to your sites:
  open pages, read them, click and type. It needs Anthropic's Claude
  add-on for Chrome, which you install yourself from the Chrome Web
  Store. (The Browser button is something else: a separate browser of
  Cla-Amp's own.) It is off until you turn it on, and it takes effect in your next
  new chat or after a restart. Claude asks before each use unless you chose
  a mode that lets it go ahead.
- The message box belongs to the chat in view: a half-written message and
  its attached files wait with that chat while you look at another, and
  are still there after a reload or a restart.
- The calendar widget is also a small planner, if you want one. Click a
  day to add due dates (on their own or tied to the chat in view), tick
  them off, and write notes. Each day keeps a report: how many chats you
  worked on, their names, your notes, and the day's usage (tokens used
  by chats in Cla-Amp, what those would cost at API prices, how full a
  chat's context got, and how much of the week's plan limit was used). **Put the report in my message**
  hands a day's report to Claude.
- The status bar is made of parts you can switch on and off: press
  **Widgets** and tick, under **Status bar shows**, any of agents
  running, context, branch, model, effort, usage limits, date, time and
  the chat's status. Click the model or the effort in the bar to pick
  another, the same as in the **Model** panel. With **Status bar** set to **At the bottom** (under
  **Layout**) it sits along the bottom of the window. With every part
  off the bar is gone. A saved theme keeps your pick.
- The panels on the right can stand as a column of their own, the whole
  height of the window, beside the player and button rows instead of
  under them: press **Widgets** and tick **Side columns run the whole
  height of the window**. It works with one column or two.
- Drag the divider in front of a side column to make it wider or
  narrower. With two columns, each has its own divider and its own
  width; tick **Resize the two side columns together** (under
  **Widgets**) to have a drag on either divider size both alike. A
  column grows only into the room the chat can spare, and never past
  900 pixels.
- **Arrange the window** (under **Widgets**) lets you drag things
  around freely: the logo, the top player, the row of buttons, the
  spectrum and every panel. The areas that can take them are outlined:
  the top row, the button row, the status bar, above the chat, under the
  projects, and the side columns. Drop a block on an area, in front of
  whichever block you point at. Panels go in columns; the rest go
  anywhere. **Done** ends it, **Put everything back** returns to the
  usual arrangement. A saved theme keeps the arrangement.
- **Language** (at the top of the **Widgets** menu) puts the window's
  own words in another language: German, Spanish, French, Hindi,
  Indonesian, Italian, Japanese, Korean, Brazilian Portuguese, Simplified
  or Traditional Chinese. **Same as Windows** follows your computer. The
  translations were made by machine and may be rough in places; anything
  not translated shows in English. Your messages, Claude's replies, code
  and the guides stay as they were written, and message boxes drawn by
  Windows keep their English buttons.
- **Text** (under **Widgets**, **Layout**) changes the typeface of the
  window's text. The list has typefaces that come with Windows and, when
  they are installed on your computer, free open-source ones: Inter,
  Roboto, Open Sans, Noto Sans, Source Sans 3, IBM Plex, Lato, Nunito,
  Ubuntu, Work Sans, Atkinson Hyperlegible, OpenDyslexic, Comic Neue,
  JetBrains Mono, Fira Code, Source Code Pro, Roboto Mono and Cascadia.
  Cla-Amp downloads nothing and ships no font file: install a typeface
  in Windows and it appears in the list. A theme keeps the choice.
- The window can be laid out your way. Under **Widgets**, **Layout**
  puts the Projects column left or right of the chat, the side panels on
  the right or the left, the status bar above the chat or at the bottom,
  and sets the top spectrum's size. Drag the dividers to make a column
  wider (up to 900 pixels). A theme you save keeps all of this with the
  skin: the layout, the column widths, which columns and panels show and
  where, so a theme is a whole arrangement that can be exported and
  shared.
- The list of what is working (click **agents running**) shows, beside
  each chat run in Cla-Amp, how much of the processor and memory its
  Claude Code is using. That figure covers the chat, its agents and the
  commands it started together: agents run inside their chat, so they
  have no figure of their own.
- You can open another chat, or start a new one, while Claude is working.
  The working chat keeps going; the other opens as one more entry for the
  same folder in the **Projects** tab, named like "My folder (2)".
- If you send a message while Claude is busy, it waits its turn. Waiting
  messages show in the **Queue** tab (which counts them) and above the
  message box. **Send now** on one stops what Claude is doing and sends
  it at once; the others follow in their order. **Ctrl+Enter** sends
  the message you are writing that way. The **×** takes one out.

## Your chats (the Code tab)

- Chats are grouped by folder. A chat that started other chats shows a small
  count; click it to see them underneath.
- A pulsing dot marks a chat that is working right now, here or in another
  app.
- A branch icon with a number shows the pull requests a chat made; hold the
  pointer over it for the list.
- The star pins a chat to the top.
- Chats you made in Cla-Amp have two more buttons when you point at them:
  **archive** (hide it; sending a message in it brings it back) and
  **delete** (gone for good, after it asks).
- Chats from the Claude desktop app show here too, with the same names. Use
  one app at a time on the same chat.

## Music

- Songs from **My files** follow one another without a gap, as on a CD:
  near the end of a song the next one is loaded, and it starts as the
  last one ends. This holds for the list in order, the queue, shuffle
  and repeat. Skipping by hand loads the song then, as before.
- The song list is yours to arrange. **Columns** (beside **Songs**)
  ticks what each row shows: the song's number on its album, artist,
  album, genre, folder and time. Click a column's name to sort by it,
  again for the other way round, a third time for the usual order.
  Drag a column's name onto another's to move the column there. Drag
  the line at a column's right edge to make it wider or narrower (each
  has a least width); double click the line for the usual width.
  Sorting by number keeps each album together, in its own order. The
  boxes above the list narrow it to one artist, genre, album or folder.
  The songs play in the order the list shows.
- **Import playlist** adds a playlist file (.m3u, .m3u8, .pls) under
  **Playlists**. It stays there, across restarts, until you press its
  **×**, which only takes it out of Cla-Amp: the file and the songs are
  not touched. Click a playlist to show its songs in the list, in the
  playlist's order; click it again for all your songs.
- **My files** plays the songs in your music folders. **YouTube Music** and
  **Spotify** open those players in a window docked beside Cla-Amp, using
  your browser's own sign-in.
- Whatever you pressed play on last is "live": it shows in the top bar and
  the others pause.
- Each has its own volume slider. For YouTube Music and Spotify it changes
  only that player's volume, not your computer's.
- **Player in the top bar** (in the music deck) hides or shows the top
  player; the box beside it sets its size.

## Widgets and panels

- Press **Widgets**, in the title bar at the top of the window, to choose
  what shows: the widgets (time and time zones, calendar, this chat in
  numbers, today in numbers), every other panel of the side columns,
  and the parts of the status bar.
- Right-click a panel, or a part of the status bar, and pick **Hide** to
  put it away. Tick it again under **Widgets** to bring it back. A side
  column with nothing left on show in it is put away too, and returns
  when you show something in it again. Boxes
  you type in and the spectrum keep their own right-click.
- Every panel can be folded by clicking its heading and moved by dragging
  its heading.
- Tick **A second column** in the Widgets menu to get another column, then
  drag panels into it.

## Stay awake

**Stay awake**, in the title bar, keeps the computer from going to sleep
by itself while it is on, so long work is not cut off when you step away.
It lights up and reads **Staying awake**. The screen may still turn off.
Closing a laptop's lid, or choosing Sleep yourself, still sleeps, and on
battery it will use power until you switch it off. The choice is kept for
the next start and ends when Cla-Amp closes.

## Agents

When Claude hands part of the work to an agent, the agent shows under its
project in the **Projects** tab, with a badge saying whether it is
working or finished.

- **Click an agent** to see what it did, as a chat of its own: the task
  it was given, its thinking, each command and file it touched, and its
  report. While the agent is still working, the page follows it.
- **Take a finished agent off the list** with the cross on its row, or
  right-click it. **Clear finished agents** removes all of them at once.
  This only tidies the list: what they did stays saved in the chat, and
  an agent that is still working cannot be removed here.

## How your limits are going

Each row of the **Usage limits** panel says where that limit is heading:
**On track to stay within it**, or **At this pace: reached** with the
day and time, worked out from how much is used and how much of the
window has gone by. When a limit is reached, is heading to be reached
before it starts over, or has a quarter or less left, a reminder shows
above the message box, for example "You have 30% of your weekly limit
left. At this pace you are on track to stay within it until it starts
over Thu, Nov 19, 11:52 AM." or "You have reached your weekly limit. It
starts over Thu, Nov 19, 11:52 AM." Its cross closes it until that limit
starts over or gets closer. The pace is an estimate from your use so
far, not a promise.

## Credits

If your Claude account has extra usage (credits bought on top of the
plan), the **Usage limits** panel has a row for it, **Extra usage
credits**: how much is left, how much of the month's limit is spent, and
whether it is switched on. Point at **Limits** in the status bar for the
same in one line. Accounts without extra usage have no such row. The
figures are your account's own, read through Claude Code as the other
limits are; buying credits or changing the limit is done in your Claude
account's settings, not here.

## Closing Cla-Amp

Closing always asks first, in a box over the window. When nothing is
running it only asks whether to close. When Claude is still working it
names the projects, says how many agents are running and how many
messages are waiting to be sent, and warns that closing stops that
work; the chats themselves stay saved.

Closing Cla-Amp also closes the browser windows that belong to it: the
music players, its claude.ai window and its own Browser. They are
stopped outright, not asked, so a player that is playing cannot hold
things up with a "Leave app?" box of its own.
Your everyday browser is a different one and is never touched. A
restart of Cla-Amp is the exception: the music plays on through it.

## Picking up where you left off

Close Cla-Amp and open it again, and it comes back as you left it: the
window's size and place (and whether it filled the screen), the project
and chat that were open, the tab on the left, where you were reading in
each chat, and any message you had typed but not sent. A chat you were
following to its end opens at its end. If the screen the window was on is
gone, it opens on the one you have.

## A player left running is taken back

Should a music player of Cla-Amp's be still running when Cla-Amp starts
(left over from a run that did not close it), Cla-Amp finds it in its
first seconds and takes it back, its tucked-away window too: the Music
deck shows what it plays, and it can be shown, paused or closed from
Cla-Amp again.

## One window per music player

YouTube Music has one window and Spotify has one window, never two of
the same. Pressing play may start a player with its window tucked away,
as you last left it; opening that player afterwards brings that same
window out instead of starting another.

## Muting the music

The little speaker beside each volume slider, in the top player and in
the Music deck, mutes that music with one press and brings it back to
where it was with the next. Muted, the speaker is red and struck
through.

## When a chat is done or needs you

When a chat finishes its reply, a short chime sounds, and if Cla-Amp is
not the window in front its taskbar button flashes until you come back.
The button also flashes, without a sound, when Claude stops to ask you
something. A reply that ended with an error has a lower chime of its own.
In the Projects list, a project whose chat finished or asked while you
were looking elsewhere is marked until you open it: a bar down its left
edge and a dot by its name, green for done, amber for waiting on you,
red for ended with an error.
The bell in the title bar mutes and unmutes the chime with one press.
Under **Widgets**, **Notices** picks **Flash and chime**, **Flash only**
or **Off**. The chime is made by Cla-Amp itself and follows the
computer's volume, not the music deck's. The spectrum shows music only:
the chime does not make it move.

## Buttons stay where they are

Whatever skin or theme is on, the buttons of the title bar, the button
row and the message box sit in the same places and have the same size:
a skin changes how they look, not where they are. What moves them is
your own choice: the language, **Size**, **Widgets**, and **Arrange the
window**. Under **Widgets**, **Buttons** picks the button row's kind:
**Small**, a picture beside the words, or **Big**, the picture above the words, which also adds
Theme, Settings and Help. It stays as you set it in every skin.

## Easier to see, hear and reach

- **Escape closes what is open.** Any menu, list, dialog, viewer, the
  floating video and Arrange mode close with the Esc key, one per press,
  the topmost first.

- **Size.** Hold Ctrl and press + or - to make everything in the window
  larger or smaller; Ctrl and 0 puts it back. The same choice is under
  **Widgets**, **Size**. It is kept for next time.
- **Calm.** Under **Widgets**, **Calm** keeps the window still: the
  spectrum rests, nothing glows, slides or blinks. Left at **Same as
  Windows**, it follows Windows' own setting (Settings, Accessibility,
  Visual effects, Animation effects).
- **High Contrast.** A skin for easy reading: white and yellow on black
  with strong edges. Pick it under **Themes**. Windows' own contrast
  themes are respected too.
- **Readable typefaces.** **Widgets**, **Text** lists the typefaces on
  your computer, among them Atkinson Hyperlegible and OpenDyslexic when
  you have installed them.
- **Keyboard.** Tab reaches everything that can be clicked, and what has
  the focus shows an outline. Enter or Space presses it. The menu key
  (or Shift and F10) opens the right-click menu of what has the focus;
  the arrows move in it and Escape closes it. A panel's menu has **Move
  up**, **Move down** and **Move to the other column**, so nothing needs
  dragging. Tab to a divider between columns and the left and right
  arrows make the column wider or narrower. With the focus in the chat,
  the arrows and Page Up and Page Down scroll it.
- **Screen readers.** A screen reader is told when Claude finishes a
  reply and when Claude asks to use a tool. Tabs, switches and folded
  panels say what they are and whether they are on or open.

Not there yet: the song columns and the Arrange mode still need a mouse,
and a screen reader does not read a reply aloud as it arrives.

## Looks: skins and themes

- A **skin** sets the colours and shapes. Pick one from the list in the
  title bar.
- **Customize** (the pencil) changes single parts: colours, a picture of
  your own, edges, text, corners.
- A **theme** is a skin plus everything you changed: Customize, which panels
  and widgets show and where, the second column, the top player's size.
  Press **Themes** in the title bar to save your set-up under a name, switch
  between themes, rename, export one to a file or import one. The list says
  where each look came from.
- Classic Winamp skins (.wsz files) can be imported from the same place.

## Privacy in short

- Cla-Amp never sees or keeps your passwords.
- It sends nothing anywhere by itself. One thing goes out, and only when you
  use it: the link of a Winamp skin you import. Claude Code talks to
  Anthropic as it always does.
- The full account is in the guides **Privacy** and **Security**.

## If something looks wrong

- **A chat seems stuck on "working".** Press Stop, then send your message
  again.
- **A skin looks broken.** Open Themes and use another skin; your chats are
  not affected.
- Problems and ideas go to the project's page on GitHub, under Issues.

## Telling the sliders apart

In the Music deck the bar with a clock is the place in the song; the bar with a speaker, on its own line under the buttons, is the volume, with its level in percent beside it. The player at the top uses the same two signs.

## Glass

The Aqua Glass skin shows your desktop through the window's frame and top bars on Windows 11. The lists and the chat keep a dark tint so they stay readable, and dialogs and menus are never see-through.
Aqua Glass frosts what is behind the frame: colours come through, blurred, under a blue tint.

## The spectrum

Click the spectrum, in the Music deck or the top bar, for its next look. Right-click it for everything: 19 looks, 9 colour sets, how many bands, and extras such as peak marks, glow, a reflection, or the loudest part in the middle. Your choices are kept.

Some looks move by themselves while music plays: **Flames**, **Sparks** (thrown off loud hits), **Starfield** (the bass sets its speed), **VU needles**, **Pixel rain** and **Bouncing bars**. The colour set **Cover** takes its colours from the cover of what is playing, and uses the skin's colours when there is no cover.

The same menu has three effects for the rest of the window:

- **Beat glow**: the spectrum and the name in the title bar glow with the bass.
- **Scrolling song title**: a title too long for its place slides to its end and back.
- **Screen lines**: an old monitor's faint lines over the window. The Amber Terminal skin has them on until you switch them off.

Every effect costs a little graphics power while music plays; switch off what you do not want.

## A Winamp skin by its link

In Themes, paste the address of a skin's page on skins.webamp.org and press Import from link. Cla-Amp downloads that one skin, turns its colours and font into a skin, and puts it on.
