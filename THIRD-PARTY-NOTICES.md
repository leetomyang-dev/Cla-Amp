# Third-party notices

Cla-Amp is an independent project. It is not made, sponsored or endorsed by
Anthropic, by the makers of Winamp, by Spotify, by Google or YouTube, or by
Microsoft. Their names and marks belong to their owners and are used only to
say what Cla-Amp works with.

## Software Cla-Amp is built with

These are installed by `npm install`; none of them is copied into this
repository. Each keeps its own licence, found in its folder under
`node_modules` after installing.

| Package | Licence | Used for |
| --- | --- | --- |
| [Electron](https://www.electronjs.org) | MIT | The window Cla-Amp runs in. |
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) (`@anthropic-ai/claude-agent-sdk`) | Not open source: © Anthropic PBC, used under [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance) | Running Claude Code. |
| [marked](https://github.com/markedjs/marked) | MIT | Turning Claude's Markdown into a page. |
| [DOMPurify](https://github.com/cure53/DOMPurify) | MPL-2.0 or Apache-2.0 | Cleaning that page before it is shown. |
| [highlight.js](https://highlightjs.org) (`@highlightjs/cdn-assets`) | BSD-3-Clause | Colouring code. |

Cla-Amp's own licence (MIT with the Commons Clause, in LICENSE.md) covers Cla-Amp's own files only. It does not cover
the Claude Agent SDK or Claude Code, which you use under your own agreement
with Anthropic.

## Services Cla-Amp can talk to

- **Claude and Claude Code** (Anthropic). You sign in with your own account,
  in Claude Code's own sign-in, and your use is under Anthropic's terms.
- **Winamp Skin Museum** (skins.webamp.org). "Import from link" downloads the
  one skin you point it at. Skins were made by their own authors and stay
  theirs; Cla-Amp reads a skin's colours and font and does not include or
  pass on any skin.
- **YouTube Music and Spotify's web player.** Cla-Amp opens them in your own
  browser and follows what Windows reports as playing. It adds nothing to
  their pages, reads nothing from them, and does not download or keep any
  music.

## Pictures and looks

- The icon was made with ChatGPT's image models.
- The skins are drawn with gradients in CSS. No picture, icon, sound or
  wallpaper from any operating system or media player is included.
