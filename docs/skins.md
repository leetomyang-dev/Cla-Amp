# Making a skin

A skin changes how Cla-Amp looks. It is a folder with two files:

```
my-skin/
  skin.json   the name shown in the picker
  skin.css    the look
  (any pictures the stylesheet uses)
```

A skin holds no code. Cla-Amp loads the stylesheet and never runs a script
from a skin folder, and a skin cannot load anything from the internet.


## Three ways to change how Cla-Amp looks

1. **Pick a skin.** The box at the top right of the window lists them.
2. **Customize, without files.** The pencil button at the top right opens
   Customize. Pick a part of the window (title bar, banner, button row,
   status bar, projects column, chat, message box, right-hand panels, music
   deck, or the whole window) and set its background colour, a picture of
   your own and how strongly it shows, how see-through the part is, its edge
   colour, its text colour and how round its corners are. Changes show at
   once, lie on top of whichever skin is in use, and are kept. "Undo all
   changes" takes them away; the skin is never touched.
3. **Edit a skin by hand.** For anything Customize cannot reach. In
   Customize, press **Open my skins folder**: the first time, a starter skin
   called `my-skin` is put there. Open its `skin.css` in any text editor
   (Notepad will do), change a colour or name a picture you put in the same
   folder, and save: the window updates by itself. The rest of this guide
   lists everything a skin can set.

What Customize cannot do: make the window see-through to the desktop behind
it, restyle single buttons or rows, or change sizes and positions. A picture
set on a part lies behind that part's own pieces (buttons, song rows), which
keep their own background.

## The quick way

1. In the title bar, open the skin list and choose **Open my skins folder...**
   The first time, a starter skin called `my-skin` is put there for you.
2. Open `my-skin/skin.css` in any text editor and change some colours.
3. Open the skin list again and pick **My Skin (mine)**. After each later
   change, pick another skin and then yours again to see it.

Your skins live in `%APPDATA%\Cla-Amp\skins`. The ones that ship with the
app are in the app's own `skins` folder; copy one of those to start from a
finished look. The folder name may hold letters, numbers and dashes. A folder
whose name starts with `_` is skipped, which is how `_template` stays out of
the list.

To share a skin, zip its folder. To install one, unzip it into your skins
folder.

## Starting from a Winamp skin

Classic Winamp skins (`.wsz` files, such as the ones at
<https://skins.webamp.org>) can be brought over:

1. Download a skin in your browser. On skins.webamp.org, open a skin and use
   its download link; you get a `.wsz` file.
2. In Cla-Amp's skin list choose **Import a Winamp skin (.wsz)...** and
   pick the file.

Cla-Amp makes a new skin in your skins folder named `winamp-<name>` and
switches to it.

What carries over is the skin's **colours and font**: the
body, title bar and button colours are read from its pictures, the lights from
its spectrum colours, and the accent and font from its playlist settings. The pictures do not carry over, because Winamp's small fixed window and
Cla-Amp's are laid out differently. The window stays dark whatever the
skin, so text stays readable.

The result is an ordinary colours-only skin, so you can open its `skin.css`
and adjust any value. Modern Winamp skins (`.wal`) are a different format and
are not read.

Winamp skins are their authors' work. Converting one for your own use is
fine; ask the author before you pass a converted skin on.

## skin.json

```json
{
  "name": "My Skin",
  "author": "Your name",
  "description": "One line about the look.",
  "version": "1.0.0"
}
```

Only `name` matters to the picker; the rest shows when the mouse rests on it.

## skin.css: the variables

Most skins only set variables. Put them in a `:root { }` block and leave out
the ones you are not changing. `skins/_template/skin.css` lists every one with
its default.

| Variable | What it colours |
| --- | --- |
| `--bg` | Behind everything. |
| `--panel` | The three columns. |
| `--panel-2` | Panels in the right column, cards. |
| `--row`, `--row-hover` | A row in a list, and under the mouse. |
| `--line` | Thin borders. |
| `--text`, `--dim` | Main text, secondary text. |
| `--font`, `--mono` | The interface font, the fixed-width font. |
| `--screen-lines` | `on` puts an old monitor's faint lines over the window, until the person switches them off in the spectrum's menu. |
| `--led`, `--amber`, `--red` | Lights and meters: fine, getting full, nearly full. The equalizer and the spectrum use them too. |
| `--blue` | The COMPLETE badge. |
| `--led-off` | An unlit equalizer segment. |
| `--display` | The dark glass behind LED text. |
| `--violet` | The accent: selected project, send button, active choice. |
| `--accent-hi`, `--accent-fill`, `--accent-glow`, `--accent-soft` | The accent's light edge, its gradient, its glow, text on top of it. |
| `--app-bg`, `--app-edge` | The window's background and outer edge. |
| `--titlebar`, `--titlebar-text` | The title bar. |
| `--button`, `--button-text` | The big buttons. |
| `--chrome-button` | The small window buttons. |
| `--tab`, `--tab-active`, `--tab-active-text` | The Projects / Chats / Queue tabs. |
| `--logo` | The logo picture. |
| `--banner` | What is behind the top banner: a gradient, or a picture such as `url('banner.png') center / cover`. |
| `--banner-pixels` | `pixelated` keeps a small picture crisp when it is enlarged; `auto` smooths it. |
| `--brand-a`, `--brand-b` | The two halves of the name: "Claude" and "Amp". |

Colours, gradients and pictures all work as values. A picture in your skin
folder is written `url('my-logo.png')`.

## skin.css: beyond the variables

The stylesheet is ordinary CSS loaded after the app's own, so any rule you
write wins over the app's rule for the same thing. Useful hooks:

| Selector | Part |
| --- | --- |
| `.titlebar`, `.brand`, `.transport`, `.statusbar` | The four strips at the top. |
| `#left`, `#center`, `#right` | The three columns. |
| `.proj`, `.proj.active` | A project row, and the selected one. |
| `.badge.working` / `.waiting` / `.complete` / `.attention` | Status badges. |
| `#chat`, `.msg`, `.avatar`, `.avatar.claude` | The chat, a message, the two pictures. |
| `.tool`, `.ran`, `.thought`, `.tasks`, `.live-line` | Tool card, folded tool group, thinking, task list, the "now doing" line. |
| `.panel`, `.panel h3` | A right-column panel and its heading. |
| `.deck-btn`, `.mini`, `.pill`, `.tiny` | The button kinds. |

Example, a wallpaper behind the chat:

```css
#chat { background: url('wallpaper.jpg') center / cover; }
```

To find the selector for something else, read `renderer/index.html` and
`renderer/styles.css`, or run `npm run demo` and look around.

## Two kinds of skin, and what is refused

Cla-Amp reads a skin's stylesheet before loading it.

- **Colours only.** The stylesheet is one `:root { }` block of variables and
  nothing else. It loads straight away. This is the kind to share: nobody has
  to trust you to use it.
- **Full.** The stylesheet has rules of its own. Because such a skin can
  move, cover or hide any part of the window, including the cards that ask
  for permission, the person is asked once before it loads, and again
  whenever the stylesheet changes.
- **Refused.** A stylesheet is not loaded at all if it:
  - uses `@import`, `@namespace` or `image-set(`;
  - contains a backslash anywhere;
  - has a `url(...)` that is anything but a plain file name in the skin's own
    folder (no `http://`, no `//server`, no `C:/`, no `..`).

  The skin list marks it "not loadable" and says why when the mouse rests on
  it.

## See your changes as you save

While Cla-Amp is open it watches your skins folder. Save `skin.css`, or
swap a picture, and the window puts the skin on again by itself: no restart,
no picking it again. A skin that needs your approval asks again after a
change, because what you approved is no longer what is in the file.

A picture named in a variable (`--logo`, `--banner`) is
looked for in the skin's own folder.

## Limits

- No scripts, and nothing from the internet: web fonts and remote pictures do
  not load. Put pictures and font files in the skin folder, with simple names
  (letters, numbers, spaces, dashes, dots).
- A stylesheet over 2 MB is ignored.
- The equalizer and spectrum are drawn by code; a skin changes their colours
  through `--led`, `--amber`, `--red`, `--led-off`, `--text` and `--dim`, not
  their shape.
