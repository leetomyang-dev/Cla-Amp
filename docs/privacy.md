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
| Pictures shown in a chat, and pictures you pasted into a message | `%APPDATA%\Cla-Amp\pictures` and `attachments` | Copies, so the chat can show them. Files you attach from disk are not copied; they go to Claude with your message, as in Claude Code. |
| The profile of Cla-Amp's browser (its history, cookies and any sign-in you make there) | `%APPDATA%\Cla-Amp\pages-profile` | Written and read by the browser only. Delete the folder to clear it. |
| Each day's token and cost totals (numbers only, from Claude Code's own count) | `%APPDATA%\Cla-Amp\claamp.json` | Stay on your computer. |
| The calendar's due dates, notes and each day's report | `%APPDATA%\Cla-Amp` (the window's own storage) | Stay on your computer. A report goes to Claude only when you put it in a message yourself. |
| The Claude accounts used on this computer: each one's email and organisation name, and which of them made each saved chat | `%APPDATA%\Cla-Amp\claamp.json` and `chat-owners.json` | For the account filter over Projects and Code, so it can name an account after you sign out of it. Read from Claude Code's own answer about who is signed in and from the organisation id Claude Code writes into each chat's file. Never a password, key or sign-in. Stays on your computer. |
| Song titles and covers from your music folders | `%APPDATA%\Cla-Amp` | Read from the files you chose. |
| The browser profile for the docked players and claude.ai when they open in Edge or Brave (in Chrome they use the profile of Cla-Amp's browser, below) | `%APPDATA%\Cla-Amp\player-profile` | Written and read by the browser only. It holds the sign-ins you make in those windows. Cla-Amp never opens it. |

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
| You press Check for updates (in About) | A question: what is Cla-Amp's newest version, and, for a copy made with git, how far this copy's version is from it; and a request for Cla-Amp's "What's new" page. Nothing about you or your use | GitHub |
| You run Update.bat | A request for Cla-Amp's newest version, and for the packages it needs | GitHub, and the npm package registry |
| You click a link in a chat | Your browser opens that page | The page's owner |

Each of those services sees your internet address, as any website does, and
handles what it receives under its own privacy policy.

The players (YouTube Music, Spotify's web player) and claude.ai are those
services' own pages in your own browser. What they send is between your
browser and them, as in any browser window. Cla-Amp adds nothing to those
pages and reads nothing from them.

## What Claude Code sends to Anthropic, and how to change it

Cla-Amp runs Claude Code, and Claude Code talks to Anthropic. That is between
you and Anthropic, under your own account: Cla-Amp's author is not part of it,
receives none of it and cannot see or change it. Cla-Amp adds nothing to it
and takes nothing away; it is the same as running Claude Code yourself.

What follows is a short account of Anthropic's own page,
[Data usage](https://code.claude.com/docs/en/data-usage), as read in November
2026. That page is what counts, and it can change.

| What | What Anthropic's page says | Where you change it |
| --- | --- | --- |
| Your chats: your messages, Claude's answers, the files and command results Claude reads | Sent to Anthropic to get an answer, encrypted on the way. | It is what using Claude is. |
| Whether your chats may be used to train future models | On a personal plan (Free, Pro, Max, Ultra) it is your choice, and it covers Claude Code too. Under commercial terms (Team, Enterprise, an API account) they are not used unless the customer opted in. | [claude.ai/settings/data-privacy-controls](https://claude.ai/settings/data-privacy-controls) |
| How long Anthropic keeps them | Personal plans: 30 days, or 5 years when you allow training. Commercial: 30 days as standard. | The same setting; your organisation's agreement. |
| Usage numbers (speed, reliability, how features are used) | Sent to Anthropic by default with an Anthropic account. The page says they never include your code, prompts or file paths. | Set `DISABLE_TELEMETRY=1` |
| Error reports from Claude Code's own faults | Sent to an error-tracking service when signed in with a personal subscription, with secrets, file paths and personal details removed first. | Set `DISABLE_ERROR_REPORTING=1` |
| The name of a site, before Claude fetches a page from it | Only the site's name goes to Anthropic, to check it against a list of unsafe sites. | `skipWebFetchPreflight` in Claude Code's settings |
| Everything above that is not needed for chatting | | Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` |

To set one of those, either add it to your Windows environment variables and
start Cla-Amp again, or put it in Claude Code's own settings file,
`%USERPROFILE%\.claude\settings.json`, under `"env"`. Cla-Amp passes your
environment and those settings to Claude Code as they are, so what you set
for Claude Code holds in Cla-Amp too. Cla-Amp has no switch of its own for
them: they are Claude Code's.

Claude Code also keeps each chat on your computer as plain, unencrypted files
(the second row of the first table), for 30 days by default; `cleanupPeriodDays`
in its settings changes that.

## Signing in

- **Claude.** The sign-in is Claude Code's own, in your browser, on
  Anthropic's page. Claude Code keeps it. Cla-Amp never sees your password or
  that sign-in.
- **YouTube Music, Spotify's web player, claude.ai.** You sign in on the
  service's own page in the browser window. Cla-Amp never sees it.
- **Signing out does not hide or remove your chats.** They are files on your
  computer and stay on show for whoever uses this Windows account next,
  whichever Claude account they sign in with. The account filter narrows the
  lists; it does not protect anything. To keep chats apart from another
  person, use separate Windows accounts.
- **Signing out of Claude.** **Sign out** and **Switch account** in Settings
  run Claude Code's own sign-out, after asking. Claude Code removes the
  sign-in it keeps; Cla-Amp never reads or touches it. Claude Code in your
  terminal uses the same sign-in and is signed out with it.

Cla-Amp itself holds no password, key or token for any service.

## Removing your data

- **Sign-ins in the player windows:** sign out in those windows, or delete
  the `player-profile` folder while Cla-Amp is closed.
- **Everything of Cla-Amp's:** close it and delete `%APPDATA%\Cla-Amp` and the
  folder you unzipped it into. Your Claude Code chats are Claude Code's and
  stay; delete them in Claude Code or the Claude desktop app if you wish.
- **Your Claude account and chats held by Anthropic:** in your Claude account
  settings. Cla-Amp's author holds none of it and cannot remove it for you.

## Children

Cla-Amp is a tool for people who use Claude Code and is not directed at
children. Each service it works with has its own age rules.

## Questions and changes

There is no company behind Cla-Amp and no support. Questions and problems go
to the Issues page of the project on GitHub. If what Cla-Amp sends or keeps
ever changes, this page changes with it, in the same release.
