# Security

Cla-Amp runs Claude Code on your computer, so it is fair to ask what else it
does there. This page is the short answer; the long one, with the limits it
knows of, is [docs/security.md](docs/security.md), and what it does with
your data is in [docs/privacy.md](docs/privacy.md).

## Why you can check it yourself

- **It is source code, not a program file.** There is no installer and no
  `.exe` or `.dll` of Cla-Amp's own in this repository (a check on every
  push fails if one appears). What runs is the text you can read here, on
  Electron and the packages named in `package.json`, each pinned to an exact
  version in `package-lock.json`.
- **Every push is checked in the open.** The tests, a search for known
  vulnerabilities in the packages (`npm audit`), and GitHub's code scanner
  (CodeQL) run on GitHub; their results are on the
  [Actions](https://github.com/leetomyang-dev/Cla-Amp/actions) page for anyone to see.
- **You can run the same checks.** `npm ci --ignore-scripts`, `npm test`
  and `npm audit` in the folder.

No one can promise that any program is free of faults, and this page does
not. What it can do is say plainly what the app does, so nothing it does is
a surprise.

## What it does on your computer, plainly

Things a careful person, or an antivirus program, might notice:

| What | Why | Where to read it |
| --- | --- | --- |
| Starts Claude Code, which can read and change files and run commands in the folder you picked | It is what the app is for. Claude asks first unless you chose otherwise | `main.mjs` |
| Runs small PowerShell scripts of its own, hidden | Windows has no other built-in way to play music, read what is playing, listen for dictation or place a window. The scripts are in the repository and are started by full path with fixed arguments; none is built from text | `deck/*.ps1` |
| Listens to what the speakers play | To draw the spectrum. Measured in memory a moment at a time, never saved or sent | `deck/deck.ps1` |
| Starts Chrome, Edge or Brave with a profile folder of its own | For the music players, claude.ai and its own Browser, kept apart from your everyday browser | `main.mjs` (`openBrowserPlayer`) |
| Stops those browsers when you close Cla-Amp | So nothing of its own plays on or lingers. Only a browser started with Cla-Amp's own profile folder is ever stopped; your everyday browser is never matched | `deck/close-browsers.ps1` |
| Keeps the computer awake | Only while you switch **Stay awake** on | `main.mjs` (`awake:set`) |
| Reads Claude Code's saved chats and the Claude desktop app's list of chats | To show them. The desktop app's files are never changed | `main.mjs` |
| Goes on the internet by itself | It does not. Claude Code talks to Anthropic as it always does; the players are the services' own pages in your browser. Two things fetch something, each only when you press them: **Import from link** (one Winamp skin) and `Update.bat` (the newest Cla-Amp, run by hand) | `docs/privacy.md` |

What it does not do: it has no server and no account of its own, listens on
no port, holds no password, key or token, adds nothing to your browser, and
reads nothing from the pages of the players or claude.ai.

## If your antivirus says something

Cla-Amp is not code-signed, and hidden PowerShell scripts and a program that
stops browser processes are things antivirus programs look at closely. If
one objects, the file it names is in this repository to read; please open an
issue saying which file and which antivirus, so it can be looked into.

## Getting it safely

Download it only from this repository
(`https://github.com/leetomyang-dev/Cla-Amp`). A copy from anywhere else may have been
changed.

## Reporting a security problem

Please do not put the details in a public issue. Use **Report a
vulnerability** on the repository's
[Security page](https://github.com/leetomyang-dev/Cla-Amp/security/advisories/new), which
reaches the maintainer privately. If that is not on offer, open an issue
that says only that you have a security problem to report.

Cla-Amp is a spare-time project shared as it is, with no promise of support
or of a fix by a given time. The newest version on the `main` branch is the
only one looked after.
