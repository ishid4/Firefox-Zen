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
| `firefox-zen.tab-sections` | true | Folders above a line, New Tab and new tabs below it; hover the sidebar for **Clear** (see below) |
| `firefox-zen.show-customize-button` | true | Firefox's "Customize sidebar" gear in the sidebar tools (toggle it under Customize Sidebar → Tools) |
| `firefox-zen.sidebar-urlbar` | false | Toolbar + address bar at the top of the sidebar. With "Expand sidebar on hover" it stays there and shows when the sidebar expands; otherwise it goes back to the top while the sidebar is collapsed. Also back on top while customizing the toolbar |
| `firefox-zen.floating-urlbar` | true | Open the address bar centered, like a command bar |
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
Pinned tabs are global "Essentials" and show in every space.

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
- Tab right-click menu → **Move to Space** moves the selected tab(s) to another
  (or a new) space.
- New tabs open in the current space; closing a space's last tab opens a fresh
  tab there.
- The space list is stored in `firefox-zen.spaces.list`; each tab's space and
  each window's current space are kept in the session, so they survive restarts.
- Turning Spaces off shows every tab again.
- Conflicts with other tab-hiding extensions (e.g. Simple Tab Groups).

### Tab sections

Like Zen and Arc, the vertical tab list is split by a line: tab groups
(folders) sit above it, New Tab and ungrouped tabs below it. Folders are kept
first in the real tab order too, so Ctrl+Tab, keyboard navigation and dragging
follow what you see; a folder dragged below the line goes back above it.

Hovering the sidebar shows **↓ Clear** on the line: it closes every tab below
the line in the current space (Firefox asks first when closing many tabs;
Ctrl+Shift+T reopens them). Folders and pinned tabs stay.

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
