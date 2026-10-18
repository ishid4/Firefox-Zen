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
| `firefox-zen.compact-toolbar` | false | Hide the toolbar until hovered |
| `firefox-zen.compact-sidebar` | false | Hide the vertical tabs sidebar until its edge is hovered |
| `firefox-zen.floating-urlbar` | true | Open the address bar centered, like a command bar |
| `firefox-zen.show-folder-icons` | true | Arc folder icons on tab groups |
| `firefox-zen.show-menu-icons` | true | Icons in context menus |

Compact sidebar replaces Firefox's own "Expand sidebar on hover" (the two fight
at the window edge): turning it on saves your `sidebar.visibility` and switches
it to "always show"; turning it off restores it. Re-enabling "Expand sidebar on
hover" while compact sidebar is on turns compact sidebar off.

Prefs that default to `true` are written by the settings script on first run.
Without the loader they stay unset and read as `false`.

### Required prefs

Both must be `true` (the settings script turns them on; without the loader, set
them in `about:config`). Restart Firefox afterwards.

- `toolkit.legacyUserProfileCustomizations.stylesheets`: lets Firefox load
  `userChrome.css` and `userContent.css` at all.
- `svg.context-properties.content.enabled`: the theme's icons are SVGs that take
  Firefox's text color (`context-fill`). Firefox ignores that for icons loaded
  from the profile folder unless this pref is on, so icons render black and
  disappear in dark mode.
