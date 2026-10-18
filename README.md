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
| `firefox-zen.compact-mode` | false | Hide the toolbar until hovered |
| `firefox-zen.floating-urlbar` | true | Open the address bar centered, like a command bar |
| `firefox-zen.show-folder-icons` | true | Arc folder icons on tab groups |
| `firefox-zen.show-menu-icons` | true | Icons in context menus |

Prefs that default to `true` are written by the settings script on first run.
Without the loader they stay unset and read as `false`.
