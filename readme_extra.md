# Firefox-Zen: full reference
## Settings

Settings live in the Library's **Settings** tab, grouped by category (Core,
Tabs & spaces, Address bar, Layout, Browsing), each feature with a live preview
and a switch. Turning a feature on unfolds tips and its own options under it
(Library: pin limit; Spaces: footer size and private space auto-lock; Glance:
shortcut and size). The Firefox-Zen toolbar button opens the Library on
Settings, so it works on first startup, before Spaces and its footer are on.

- **Search** (top right) filters by anything a row shows: title, description,
  tips and option names. Esc clears it.
- A **dot** next to a title marks a setting changed from its default (the
  feature or any of its options); hover the row for **Reset**, which resets
  just that one.
- **Reset to defaults** and **Import…** show **Undo** next to the result.
- On first startup the settings script has to turn on two Firefox prefs the
  theme needs, which only take effect after a restart; the tab shows a
  **Restart now** banner until then.

**Export…** / **Import…** at the bottom save and load every setting on that tab
as a small JSON file (`"format": "firefox-zen-settings"`), to share a setup or
move it to another profile. Importing skips keys it doesn't know (from a newer
version) and keeps numbers in range. Undo puts back what an import changed.
The file also lists which [mods](#mods) are on and their options (not the mods
themselves): importing turns on the ones installed there, except mods with a
script that profile hasn't trusted yet.

Everything needs the
[fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) loader (MPL-2.0):

- `utils/`: loader files that live in the profile (already in place).
- `program/`: copy these into the Firefox install folder once, as admin:
  - `program/config.js` → `C:\Program Files\Mozilla Firefox\config.js`
  - `program/defaults/pref/config-prefs.js` → `C:\Program Files\Mozilla Firefox\defaults\pref\config-prefs.js`

Then open `about:support`, click **Clear startup cache…**, and restart.

| Pref | Default | Effect |
| --- | --- | --- |
| `firefox-zen.compact-toolbar` | false | Hide the toolbar until hovered (with the address bar in the sidebar: the window controls hide too and the sidebar/page use the full window height) |
| `firefox-zen.compact-sidebar` | false | Hide the vertical tabs sidebar until its edge is hovered (the Auto-hide layouts in Settings → Sidebar) |
| `firefox-zen.window-border` | true | A thin frame in the toolbar's color around the page, with rounded corners (not in fullscreen) |
| `firefox-zen.window-border.width` | 6 | The window border's width in pixels (1-24) |
| `firefox-zen.spaces` | false | Zen-style Spaces (see below) |
| `firefox-zen.tab-sections` | true | Folders (and tabs you drag there) above a line, New Tab and new tabs below it; hover the sidebar for **Clear** (see below) |
| `firefox-zen.show-customize-button` | true | Firefox's "Customize sidebar" gear in the sidebar tools (toggle it under Customize Sidebar → Tools) |
| `firefox-zen.sidebar-urlbar` | false | Toolbar + address bar at the top of the sidebar. With "Expand sidebar on hover" it stays there and shows when the sidebar expands; otherwise it goes back to the top while the sidebar is collapsed. Also back on top while customizing the toolbar |
| `firefox-zen.floating-urlbar` | true | Open the address bar centered, like a command bar |
| `firefox-zen.urlbar-newtab` | true | No New Tab page, like Arc/Zen: Ctrl+T and the + buttons open the address bar (floating, if that's on) and what you pick opens in a new tab. Esc or clicking away cancels without creating a tab. Shift+click (new window), middle-click paste and the tab Spaces needs for an empty space still make a real tab |
| `firefox-zen.glance` | true | Alt+click a link to open it in a floating Glance window (see below) |
| `firefox-zen.glance.modifiers` | alt | Keys held while clicking a link to open Glance: `ctrl`, `alt`, `shift`, joined with `+` |
| `firefox-zen.glance.width` / `.height` | 700 / 940 | Glance size in thousandths of the content area (Settings sliders, or drag its edges) |
| `firefox-zen.pins.max` | 9 | Most pinned tabs (1-36) |
| `firefox-zen.private-spaces.autolock-minutes` | 1 | Lock and hide every private space after this many idle minutes (0 = never) |
| `firefox-zen.show-folder-icons` | true | Arc folder icons on tab groups |
| `firefox-zen.download-cue` | true | A new download flies to the Library button, which ripples, shows a progress ring and opens on Downloads (see [Downloads](#downloads)) |
| `firefox-zen.download-cue.icon-seconds` | 7 | How long the Library button shows the downloads icon after a download starts (0-10, 0 = never) |
| `firefox-zen.show-menu-icons` | true | Icons in context menus |
| `firefox-zen.mods.enabled` | [] | Ids of the [mods](#mods) that are on (JSON); `firefox-zen.mods.trusted` lists the scripts confirmed to run |
| `firefox-zen.mods.safe-mode` | false | Load no mods on the next start (then clears itself) |
| `firefox-zen.mods.auto-update-check` | true | Check mods for updates at startup, at most once a day |

Settings → Sidebar → **Sidebar layout** sets the sidebar in one click:
**Always shown** (Full, Icons, Expand on hover) or **Auto-hide** (compact
sidebar: Full, Icons). The Icons layouts have no room for the address bar, so
picking one turns Address bar in sidebar off. While Settings is open the
sidebar shows the real layout, as a live preview (other Library views keep it
expanded for dragging). Each layout sets compact
sidebar, Firefox's `sidebar.visibility` and the expanded/collapsed state (as
Firefox's sidebar button does) together, and turns on vertical tabs if needed.
Compact sidebar and Firefox's own "Expand sidebar on hover" fight at the window
edge, so they never stay on together: turning on "Expand sidebar on hover"
while compact sidebar is on turns compact sidebar off.

Prefs that default to `true` are written by the settings script on first run.
Without the loader they stay unset and read as `false`.

### Spaces

Each unpinned tab belongs to one space; switching spaces hides the other
spaces' tabs (Firefox's own tab hiding, so Ctrl+Tab and the tab strip follow).
Pinned tabs are global "Pins" and show in every space.

- The **+** button opens a menu: Create Space, Create Folder (a new tab in a new
  tab group; Firefox asks for its name and color) and New Tab.
- While Spaces is on, Firefox's sidebar tools sit in one smaller row above the
  footer; hover its first/last visible button to scroll it, like the spaces row.
- Switch and manage spaces from the bar under the vertical tabs;
  right-click a space to rename it, change its icon, unload it (frees memory;
  tabs stay and reload when opened; the tab you're on stays loaded) or delete
  it (its tabs move to a neighboring space, nothing is closed).
- Right-click a space → **Set Container** (Firefox's own container list) to
  give it a default container: new tabs in that space (Ctrl+T, +) open in it.
  Existing tabs keep theirs (Firefox can't move a tab into a container without
  reopening it). The space's icon gets a bar in the container's color.
- Double-click a space's name or icon to rename it inline. Hover the space's
  name above its tabs for a **…** button with the space's menu.
- Right-click a space → **Export…** saves it as a `.fzspace` file (plain
  JSON: its name, icon, container name and its tabs with their back/forward
  history; folders aren't kept). **+** → **Import…** (or the Library's
  **New** menu) adds it back as a new space; a container with the same name is
  used if there is one. Private spaces export encrypted (below).
- Tab right-click menu → **Move to Space** moves the selected tab(s) to another
  (or a new) space.
- New tabs open in the current space; closing a space's last tab opens a fresh
  tab there.
- The space list is stored in `firefox-zen.spaces.list`; each tab's space and
  each window's current space are kept in the session, so they survive restarts.
- Turning Spaces off shows every tab again.
- Conflicts with other tab-hiding extensions (e.g. Simple Tab Groups).

#### Private spaces

**+** → **Create Private Space…** asks for a password and opens the space in
its own private window (private browsing is per window in Firefox). The
Library's **New** → **New Private Space…** does the same but stays in the
Library, with the new space unlocked there. Firefox writes nothing from it to
history, cookies, cache or the session file. Its tabs (with back/forward
history), cookies, name and icon, history and downloads list are saved instead
to `firefox-zen-private/<id>.json` in the profile, encrypted with AES-256-GCM
using a key derived from the password (PBKDF2-SHA256, 600,000 rounds), and
rewritten every few seconds while it changes.

- **Hidden by default**: every time Firefox starts, private spaces are hidden
  from the footer, the Library and **Move to Space**. Show or hide them with
  the Library's **Private** button, **+** → **Show/Hide Private Spaces**, or
  **Ctrl+Alt+P** (in every window at once). Hiding also locks them all.
  Creating one shows them. This only keeps them out of sight; it adds no
  security beyond the password.
- **Locked**: its real name and icon are encrypted, so it shows as
  "Private 1", "Private 2"… with a blurred icon and a padlock. Clicking its
  footer icon asks for the password and opens its private window.
- **Unlocking** (the Library's **Unlock…** or right-click → **Unlock…**) only
  decrypts it; no window opens. The Library then lists its tabs (kept up to
  date). Clicking the column's header, or one of its tabs, opens its window.
- **Locking**: middle-click its footer icon, the mask button on its Library
  column, or right-click → **Lock Space**. Closing its window keeps it
  unlocked (saved). Quitting Firefox locks it; after a restart every private
  space starts locked.
- **Auto-lock**: after `firefox-zen.private-spaces.autolock-minutes` minutes
  (default 1, 0 = off) with no keyboard or mouse input on the computer, every
  private space locks and they're hidden again.
- **Moving tabs**: drag tabs onto its Library column or footer button, or use
  the tab menu's **Move to Space** (a locked space asks for its password).
  Drag its tabs to another column, or use **Move to Space** in its window, to
  move them out, to a normal space or to another private space. A tab's
  history moves with it; visits it made before moving in stay in normal
  history. Container tabs lose their container.
- **Its own history and downloads**: pages its tabs visit and files they
  download are listed only there. In the Library's **History** and
  **Downloads**, pick it from the list next to the search box (it's there
  while it's unlocked, and a private space's own window starts on it);
  **All spaces** shows Firefox's own lists, without any private space's.
  Downloads still running work as usual there (pause, cancel, speed,
  progress); once Firefox drops them (its private windows closed) the saved
  entries can still be opened, shown in their folder or removed. A download
  still running when its window closes or the space locks is cancelled by
  Firefox and shows as **Interrupted**, with **Retry** (starts it again from
  its link, in the space) and remove.
- A private space's window's Library lists the other private spaces too
  (locked ones blurred, with **Unlock…**), so tabs can be dragged between
  them from there.
- From a private space's window, new spaces and imports are off (they'd only
  show in other windows); **Create Private Space…** still works. The downloaded files themselves are ordinary files on disk,
  not encrypted.
- Right-click a private space: **Rename Space…**, **Change Icon…** (both ask for the
  password if it's locked), **Change Password…**, **Clear and Lock…** (erases
  its tabs, history, downloads list and cookies; its name and password stay),
  **Export…** and **Delete Space…** (erases it all for good). Clear and
  Delete can also delete its downloaded files from disk.
- **Export / import**: **Export…** saves it, still encrypted, as a `.fzspace`
  file; **+** → **Import…** (or the Library's **New** menu) adds one to
  another profile or PC. Its password is needed to open it there too.
- It always opens in its own window: Firefox only supports private browsing
  per window, and forcing a private tab into a normal window crashes Firefox.
- Its history never shows up in other spaces. Its address bar still suggests
  your normal history and bookmarks.
- Several private spaces can be unlocked at once, but only one has its window
  open: private windows share one cookie jar, so opening another's window
  saves and closes the current one (it stays unlocked) to keep their cookies
  apart. For the same reason, opening a private space's window or locking one
  clears the cookies of any other private window (Ctrl+Shift+P) you have open,
  and the Library's **All spaces** downloads leave out those windows' downloads.
- The password can't be recovered. A weak one can be guessed by anyone who
  copies the file. Downloaded files, extensions allowed in private windows and
  Windows' page file are outside what this protects.

### Library

The Library is core (always on). The first button in the spaces footer, or
the Firefox-Zen toolbar button (on its Settings tab), opens it over the page. The
sidebar expands and stays out while it's open, with the Library next to it
(also with compact sidebar and expand-on-hover), and goes back to how it was
when it closes. Esc, the button again, or clicking a tab closes it.

**Spaces**: every space as a column with its folders and tabs, pinned tabs
(Pins, with a 3/12 count) on top.

- Drag a column's header to reorder spaces (the footer follows).
- Drag tabs between columns or within one; drop on a folder's header to put
  them in that folder. Ctrl+click / Shift+click picks several tabs to drag
  together.
- Drag a folder to move it, with all its tabs, to another space.
- With tab sections, each column has the sidebar's line: drop a tab above it
  to keep it there without a folder, or below it to make it a loose tab again.
- Drop tabs on Pins to pin them, or drag pinned tabs into a space.
- Drop tabs on **New space**, or on a space button in the footer.
- Click a space's icon for an icon picker, its name to rename it, its header
  to switch to it, ⋯ for container / unload / delete.
- Click a tab to go to it; middle-click or × closes it. Filter searches tab
  titles and addresses in every space.

**History**: by last visit, grouped by day, searchable, loads more as you
scroll. Click opens in the current space (Ctrl/middle-click: in the
background); drag an entry onto a space to open it there; × deletes it from
history.

**Downloads**: Firefox's downloads, newest first and grouped by day, with
progress, Pause / Resume / Cancel, Retry, Show in folder, search, Clear
finished and Open downloads folder. Click a finished download to open it.
Failed downloads (the ones that need Retry) are tinted yellow.

### Mods

Mods change or add to Firefox-Zen without editing its files. The Library's
**Mods** tab (above Settings) lists them with a switch each; changes apply
instantly, in every window.

- **Install from folder…** / **Install from zip…** copy a mod into
  `chrome/mods/<id>/`. Or put the folder there yourself and press **Reload**
  (which also reloads every mod's files after you edit them).
- Each row: **Folder** opens it, **Export…** zips it to share, **Remove…**
  deletes it and its options. Options unfold while the mod is on; a dot marks
  options changed from their defaults, with **Reset** on hover.
- Problems (bad `mod.json`, missing files, a script that threw) show in red on
  the row. A script that throws turns its mod off.
- A mod that breaks the browser: set `firefox-zen.mods.safe-mode` to `true` in
  about:config (or user.js) and restart. That start loads no mods (the pref
  clears itself), so it can be turned off or removed.

**Mods with a script run with full access to Firefox** (tabs, browsing data,
saved passwords, files). They start off, and the first time one is turned on
Firefox-Zen asks to confirm. Installing a new version asks again. Only turn on
scripts you trust. CSS-only mods turn on when installed.

#### Updates

A mod that lists an `updateURL` is checked for a newer version at startup (at
most once a day; `firefox-zen.mods.auto-update-check` turns that off) and by
**Check for updates** in the Mods tab. A mod with an update gets an
**Update: x.y** badge, and the Library's Mods button a dot.

**Review update…** downloads it and shows, before anything changes:

- the installed and new versions and where it comes from;
- a warning when the mod's files were edited since it was installed or last
  updated (updating replaces the folder: **Export…** first to keep them), and
  when the update changes its script;
- every added, removed and changed file, with a line-by-line diff.

**Update** replaces the mod's folder and keeps it on (a mod with a script
doesn't ask for confirmation again: reviewing the changes is that); its options
are kept. **Cancel** leaves everything as it was. A failed check shows on the
mod's row.

#### Making a mod

Copy `chrome/mods/example` (a selected-tab accent bar plus a shortcut). The
folder name is the mod's id (lower-case letters, digits, `-`, `_`).

`mod.json`:

```json
{
  "name": "My Mod",
  "version": "1.0.0",
  "author": "you",
  "description": "What it does.",
  "homepage": "https://example.com",
  "updateURL": "https://example.com/my-mod/mod.json",
  "downloadURL": "https://example.com/my-mod/my-mod.zip",
  "styles": ["style.css"],
  "contentStyles": ["content.css"],
  "script": "mod.uc.js",
  "preview": "preview.png",
  "options": [
    { "type": "bool", "pref": "compact", "label": "Compact", "default": false },
    { "type": "number", "pref": "size", "label": "Size", "default": 32, "min": 16, "max": 64, "unit": "px" },
    { "type": "select", "pref": "side", "label": "Side", "default": "left",
      "choices": [{ "value": "left", "label": "Left" }, { "value": "right", "label": "Right" }] },
    { "type": "color", "pref": "accent", "label": "Accent", "default": "#7c5cff", "hint": "Shown under it." },
    { "type": "button", "pref": "clear", "label": "Clear the list", "text": "Clear", "confirm": "Clear it?" }
  ]
}
```

Every field is optional except that there must be something to load. Without
`styles` / `contentStyles` / `script` / `preview`, the files `style.css`,
`content.css`, `mod.uc.js` and `preview.png` (or `.svg`, `.jpg`, `.webp`) are
used when present.

- `updateURL` / `downloadURL` (both `https://`): where updates come from.
  `updateURL` is the newest `mod.json`; when its `version` is higher than the
  installed one (`1.10.0` > `1.9.2`), the mod has an update. The zip comes from
  that file's `downloadURL`, or this one. The zip holds the mod (its `mod.json`
  at the top, or in one folder), like **Export…** makes, and must contain the
  new version. Or it's a whole repository's zip with `#<folder>` at the end,
  the mod's folder inside it. The example mod updates from this repository
  that way, so pushing a higher `version` to `main` is a release:

  ```json
  "updateURL": "https://raw.githubusercontent.com/ishid4/Firefox-Zen/main/mods/example/mod.json",
  "downloadURL": "https://github.com/ishid4/Firefox-Zen/archive/refs/heads/main.zip#mods/example"
  ```

  For a mod in its own repository, drop the folder (`…/main.zip`); to publish
  only on purpose, point `downloadURL` at a release asset instead
  (`https://github.com/<you>/<repo>/releases/latest/download/my-mod.zip`).
- `styles`: CSS for the browser UI (each browser window).
- `contentStyles`: CSS for every document: web pages, about: pages and the
  browser UI. Scope it with `@-moz-document domain(example.com) { … }`.
- **Options** are stored as `firefox-zen.mods.<id>.<pref>`. While the mod is
  on, the browser window's `<html>` has `fz-mod-<id>`, each option as the
  variable `--mod-<id>-<pref>` (bool: `1`/`0`; number: with its unit when it's
  a CSS unit like `px`, `%`, `ms`), and bool/select options also as the
  attribute `fz-mod-<id>-<pref>` (present / the chosen value):

  ```css
  :root[fz-mod-my-mod-compact] #tabbrowser-tabs { --tab-min-height: var(--mod-my-mod-size); }
  ```

  There are five kinds of option (`chrome/mods/example` uses all five). Every
  option has `type`, `pref` (lower-case letters, digits, `-`, `_`; unique in
  the mod), and optionally `label` (defaults to `pref`) and `hint` (a line
  under it). The other fields depend on the type:

  | `type` | Control | Fields | Stored as | In CSS (`<id>` / `<pref>` from the mod) |
  | --- | --- | --- | --- | --- |
  | `bool` | Switch | `default`: `true` / `false` (false) | bool pref | `--mod-<id>-<pref>: 1` or `0`; attribute `fz-mod-<id>-<pref>` while on |
  | `number` | Number box (Enter, blur or the arrows apply it; out of range snaps back) | `min` (0), `max` (100), `default` (min), `unit`: text after the box | int pref | `--mod-<id>-<pref>: 12px` (unit added when it's `px` `em` `rem` `%` `vw` `vh` `ms` `s` `deg` `ch` `ex`, else just `12`) |
  | `select` | Dropdown | `choices`: list of `{ "value", "label" }` or plain strings (at least one); `default`: one of the values (the first) | string pref | `--mod-<id>-<pref>: <value>`; attribute `fz-mod-<id>-<pref>="<value>"` |
  | `color` | Color picker | `default`: `#rrggbb` (`#000000`) | string pref | `--mod-<id>-<pref>: #rrggbb` |
| `button` | Button | `text`: the button's caption (`Run`); `confirm`: a question asked first (none) | nothing | nothing: it calls the script's `mod.onButton("<pref>", fn)` in the window it was clicked in |

  Defaults in brackets apply when a field is missing. A script reads the
  others with `mod.pref("<pref>")`: a boolean, a number or a string. A button
  needs a script: its handler may be async, and a string it returns shows as
  the Mods tab's status line (errors show there too).
- `script` runs once in each browser window with `mod` in scope; window
  globals (`gBrowser`, `document`, `Services`) work as usual. Register what you
  add through `mod`, so turning the mod off undoes it:

  | `mod.` | |
  | --- | --- |
  | `id`, `name`, `version`, `dir`, `window` | About the mod |
  | `pref(name)` / `setPref(name, value)` | Read / write an option |
  | `onPrefChange(fn)` | `fn(name)` when an option changes |
  | `onButton(name, fn)` | `fn()` when the button option `name` is clicked |
  | `listen(target, type, fn, options)` | `addEventListener`, removed when off |
  | `addStyle(css)` | CSS for this window; returns a remover |
  | `onCleanup(fn)` | Anything else to undo when off |
  | `url(path)` | `file://` URL of a file in the mod's folder |
  | `log(...)` | `console.log` tagged with the mod |

  Turning the mod off, Reload, or reinstalling runs the cleanups (last first)
  and runs the script again when it's back on.

### Pins

At most 9 pinned tabs by default (Settings → Library, `firefox-zen.pins.max`). The tab right-click menu shows the count next to
Pin Tab / Unpin Tab (e.g. 3/9), and Pin Tab is disabled once they're full;
dragging a tab into the pinned area or onto the Library's Pins does nothing
then. Windows restored from a session keep all their pinned tabs.

Dragging a tab over the pinned tabs opens an empty tile where it will go;
dropping it there pins it in that spot.

### Downloads

A download you start flies, as its file icon, from where you clicked to the
Library button in the spaces footer, which ripples and shows the downloads
icon for a few seconds (Settings: 0-10, default 7). A compact sidebar slides
out meanwhile. While it shows that icon, the button opens the Library on
**Downloads** (otherwise on the view you used last); that tab keeps a dot
until you've looked at it. While downloads run, a ring
around the button fills with their progress. Without the
footer it flies to Firefox's Downloads toolbar button, if that's showing.
Settings → Browsing → **Download animation** (`firefox-zen.download-cue`)
turns it off.

Firefox's own download lists (toolbar Downloads panel, Library window,
about:downloads) also tint failed downloads yellow, so the ones waiting for
Retry stand out (theme/downloads.css).

### Tab sections

Like Zen and Arc, the vertical tab list is split by a line: tab groups
(folders) sit above it, New Tab and ungrouped tabs below it. Folders are kept
first in the real tab order too, so Ctrl+Tab, keyboard navigation and dragging
follow what you see; a folder dragged below the line goes back above it.

Hovering the sidebar shows **↓ Clear** on the line: it closes every tab below
the line in the current space (Firefox asks first when closing many tabs;
Ctrl+Shift+T reopens them). Folders and pinned tabs stay.

### Glance

Like Zen's Glance: Alt+click (Option+click on macOS) a link and the page grows out of it into a
floating window over the current tab, with the tab dimmed behind it. The
shortcut can be any mix of Ctrl, Alt and Shift (Control, Option and Shift on
macOS; Settings → Glance → Open with).
With Ctrl or Shift in it, Firefox's own new tab / new window for that click is
skipped; other clicks behave as usual.

- **Esc**, a click on the dimmed area, or **×** closes it (it shrinks back
  into the link).
- **Open as tab** switches to it as a normal tab next to the current one;
  **Split view** puts both in Firefox's split view.
  Nothing reloads: the glance already is a (hidden) tab.
- Drag any edge or corner of the glance to resize it; it stays centered, and
  the size is remembered (`firefox-zen.glance.width` / `.height`, in
  thousandths of the content area).
- The shortcut inside a glance navigates the glance. Switching tabs closes it.
- Works on links whose address Firefox shows at the bottom on hover (that's
  where the link comes from; no code runs inside pages).
- A plain Alt shortcut is off while `browser.altClickSave` is on (Alt+click
  saves the link instead).
- Pages that handle the click themselves (rare) keep their own behavior.

### Address bar in sidebar

The toolbar follows your Customize Toolbar layout: items placed **left** of the
address bar stay in the row above it; items placed **right** of it, plus
toolbar-pinned extension buttons, move into the panel opened by the Extensions
button at the end of the address bar ("All extensions" there opens Firefox's own
Extensions panel, "Manage" opens about:addons). Everything goes back into the
toolbar while customizing or when the address bar leaves the sidebar.

### Required prefs

Both must be `true` (the settings script turns them on; without the loader, set
them in `about:config`). Restart Firefox afterwards.

- `toolkit.legacyUserProfileCustomizations.stylesheets`: lets Firefox load
  `userChrome.css` and `userContent.css` at all.
- `svg.context-properties.content.enabled`: the theme's icons are SVGs that take
  Firefox's text color (`context-fill`). Firefox ignores that for icons loaded
  from the profile folder unless this pref is on, so icons render black and
  disappear in dark mode.
