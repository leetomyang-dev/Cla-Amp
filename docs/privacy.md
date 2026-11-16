# Privacy

Cla-Amp is a program that runs on your own computer. Its author runs no
server, has no accounts for it, and collects nothing: no usage numbers, no
crash reports, no tracking. Nothing you do in Cla-Amp reaches the author.

This page says what Cla-Amp keeps on your computer, what leaves it, and how
to remove it all.

## What stays on your computer

| What | Where | Notes |
| --- | --- | --- |
| Cla-Amp's settings: your project folders, window layout, skins, themes, widgets | `%APPDATA%\Cla-Amp` | Plain files. |
| Your Claude Code chats | `%USERPROFILE%\.claude\projects` | Claude Code's own files. Cla-Amp reads and continues them, as Claude Code does. |
| The Claude desktop app's record of each chat (title, model, whether archived) | The desktop app's own folder | Read only, to show titles and grouping. Never changed. |
| Song titles and covers from your music folders | `%APPDATA%\Cla-Amp` | Read from the files you chose. |
| The browser profile for the docked players and claude.ai (Edge, Brave) | `%APPDATA%\Cla-Amp\player-profile` | Written and read by the browser only. It holds the sign-ins you make in those windows. Cla-Amp never opens it. |

The sound your computer plays is captured a moment at a time, in memory, to
draw the spectrum. It is measured and discarded: never saved, never sent.

Dictation, if you use it, is done by the speech recogniser built into
Windows, on your computer.

## What leaves your computer

Cla-Amp sends nothing by itself. These go out, each only when you use it:

| When | What is sent | To whom |
| --- | --- | --- |
| You chat | Your messages and the files Claude reads, exactly as in Claude Code | Anthropic, through Claude Code, under your own agreement with Anthropic |
| You press Import from link | A request for the one skin file your link names | The Winamp Skin Museum's file store |
| You click a link in a chat | Your browser opens that page | The page's owner |

Each of those services sees your internet address, as any website does, and
handles what it receives under its own privacy policy.

The players (YouTube Music, Spotify's web player) and claude.ai are those
services' own pages in your own browser. What they send is between your
browser and them, as in any browser window. Cla-Amp adds nothing to those
pages and reads nothing from them.

## Signing in

- **Claude.** The sign-in is Claude Code's own, in your browser, on
  Anthropic's page. Claude Code keeps it. Cla-Amp never sees your password or
  that sign-in.
- **YouTube Music, Spotify's web player, claude.ai.** You sign in on the
  service's own page in the browser window. Cla-Amp never sees it.
Cla-Amp itself holds no password, key or token for any service.

## Removing your data

- **Sign-ins in the player windows:** sign out in those windows, or delete
  the `player-profile` folder while Cla-Amp is closed.
- **Everything of Cla-Amp's:** close it and delete `%APPDATA%\Cla-Amp` and the
  folder you unzipped it into. Your Claude Code chats are Claude Code's and
  stay; delete them in Claude Code or the Claude desktop app if you wish.
- **Your Claude account and chats held by Anthropic:** in your Claude account
  settings.

## Children

Cla-Amp is a tool for people who use Claude Code and is not directed at
children. Each service it works with has its own age rules.

## Questions and changes

There is no company behind Cla-Amp and no support. Questions and problems go
to the Issues page of the project on GitHub. If what Cla-Amp sends or keeps
ever changes, this page changes with it, in the same release.
