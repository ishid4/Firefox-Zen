# Firefox-Zen
## Settings panel

A toolbar button opens the Firefox-Zen settings panel, where you can toggle theme
features and preview them live. The panel needs the
[fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) loader (MPL-2.0):

- `utils/`: loader files that live in the profile (already in place).
- `program/`: copy these into the Firefox install folder once, as admin:
  - `program/config.js` → `C:\Program Files\Mozilla Firefox\config.js`
  - `program/defaults/pref/config-prefs.js` → `C:\Program Files\Mozilla Firefox\defaults\pref\config-prefs.js`

Then open `about:support`, click **Clear startup cache…**, and restart.

| Pref | Default | Effect |
| --- | --- | --- |
| `firefox-zen.compact-toolbar` | false | Hide the toolbar until hovered (with the address bar in the sidebar: the window controls hide too and the sidebar/page use the full window height) |
| `firefox-zen.compact-sidebar` | false | Hide the vertical tabs sidebar until its edge is hovered |
| `firefox-zen.spaces` | false | Zen-style Spaces (see below) |
| `firefox-zen.library` | true | The spaces footer's first button opens the Library instead of the History sidebar (see below) |
| `firefox-zen.tab-sections` | true | Folders above a line, New Tab and new tabs below it; hover the sidebar for **Clear** (see below) |
| `firefox-zen.show-customize-button` | true | Firefox's "Customize sidebar" gear in the sidebar tools (toggle it under Customize Sidebar → Tools) |
| `firefox-zen.sidebar-urlbar` | false | Toolbar + address bar at the top of the sidebar. With "Expand sidebar on hover" it stays there and shows when the sidebar expands; otherwise it goes back to the top while the sidebar is collapsed. Also back on top while customizing the toolbar |
| `firefox-zen.floating-urlbar` | true | Open the address bar centered, like a command bar |
| `firefox-zen.urlbar-newtab` | true | No New Tab page, like Arc/Zen: Ctrl+T and the + buttons open the address bar (floating, if that's on) and what you pick opens in a new tab. Esc or clicking away cancels without creating a tab. Shift+click (new window), middle-click paste and the tab Spaces needs for an empty space still make a real tab |
| `firefox-zen.glance` | true | Alt+click a link to open it in a floating Glance window (see below) |
| `firefox-zen.show-folder-icons` | true | Arc folder icons on tab groups |
| `firefox-zen.show-menu-icons` | true | Icons in context menus |

Compact sidebar replaces Firefox's own "Expand sidebar on hover" (the two fight
at the window edge): turning it on saves your `sidebar.visibility` and switches
it to "always show"; turning it off restores it. Re-enabling "Expand sidebar on
hover" while compact sidebar is on turns compact sidebar off.

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
- Double-click a space's name or icon to rename it inline.
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
  (default 10, 0 = off) with no keyboard or mouse input on the computer, every
  private space locks.
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

The first button in the spaces footer opens the Library over the page. The
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

### Pins

At most 12 pinned tabs. The tab right-click menu shows the count next to
Pin Tab / Unpin Tab (e.g. 3/12), and Pin Tab is disabled once they're full;
dragging a tab into the pinned area or onto the Library's Pins does nothing
then. Windows restored from a session keep all their pinned tabs.

### Downloads

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

Like Zen's Glance: Alt+click a link and the page grows out of it into a
floating window over the current tab, with the tab dimmed behind it.

- **Esc**, a click on the dimmed area, or **×** closes it (it shrinks back
  into the link).
- **Open as tab** switches to it as a normal tab next to the current one;
  **Split view** puts both in Firefox's split view.
  Nothing reloads: the glance already is a (hidden) tab.
- Drag any edge or corner of the glance to resize it; it stays centered, and
  the size is remembered (`firefox-zen.glance.width` / `.height`, in
  thousandths of the content area).
- Alt+click inside a glance navigates the glance. Switching tabs closes it.
- Works on links whose address Firefox shows at the bottom on hover (that's
  where the link comes from; no code runs inside pages).
- Off while `browser.altClickSave` is on (Alt+click saves the link instead).
- Pages that handle Alt+click themselves (rare) keep their own behavior.

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
