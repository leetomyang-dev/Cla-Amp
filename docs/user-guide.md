# Using Cla-Amp

Cla-Amp is a window for working with Claude Code that looks and behaves
like a music player. Your projects are the playlist, the chat is in the
middle, and your music, your plan's limits and a few widgets sit on the
right.

## Getting it running

Download the ZIP from the project's GitHub page (green Code button, Download ZIP), unzip it, and double-click **Cla-Amp.bat**. The first time, it sets itself up; that needs the free program Node.js, which it offers to install if it is missing. After that a double-click starts Cla-Amp at once.

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
  before each change), **Auto-edit** (edits files without asking) or **Plan**
  (only plans). **Stop** halts Claude while it is working.
- When Claude wants to run a command or change a file, a card asks you.
  **Always allow** remembers your answer for that kind of action.
- Under each reply: copy it, fork the chat from that point, pin it, or have
  it read aloud.
- If you send a message while Claude is busy, it waits in the **Queue** tab.

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

- Press **Widgets...** at the bottom of the right column to choose widgets:
  time and time zones, calendar, this chat in numbers, today in numbers.
- Every panel can be folded by clicking its heading and moved by dragging
  its heading.
- Tick **A second column** in the Widgets menu to get another column, then
  drag panels into it.

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
