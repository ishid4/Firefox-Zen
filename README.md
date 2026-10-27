# Firefox-Zen

Zen / Arc-style browsing for regular Firefox: vertical tabs with Spaces,
a floating address bar, Glance previews and a built-in Library.

## Showcase

<!-- Add screenshots here, e.g. ![Spaces](docs/spaces.png) -->

- **Spaces**: separate sets of tabs, switched from a footer under the sidebar.
- **Private spaces**: password-protected spaces, encrypted on disk.
- **Library**: every space, history and downloads in one panel; drag tabs between spaces.
- **Floating address bar**: Ctrl+T opens a centered command bar instead of a New Tab page.
- **Glance**: Alt+click a link to preview it in a floating window.
- **Tab sections**: folders above a line, new tabs below it, one click to clear them.
- **Compact mode**: hide the toolbar and sidebar until hovered.
- **Mods**: add or change features without editing the theme.

## Install

Close Firefox first. Running the install command again updates Firefox-Zen.

### Windows

**Easy way:** open PowerShell and run

```powershell
irm https://raw.githubusercontent.com/ishid4/Firefox-Zen/main/install.ps1 | iex
```

It asks which profile to use (if you have several), backs up an existing
`chrome` folder, and asks for admin once to copy the loader into the Firefox
folder.

**Manual way:**

1. Download the [ZIP](https://github.com/ishid4/Firefox-Zen/archive/refs/heads/main.zip)
   and extract it.
2. Open your profile folder (`about:support` → **Profile Folder** → **Open Folder**)
   and create a `chrome` folder in it.
3. Copy everything from the extracted `Firefox-Zen-main` folder into `chrome`.
4. Copy the contents of `chrome\program` into `C:\Program Files\Mozilla Firefox`
   (needs admin), so you get `config.js` and `defaults\pref\config-prefs.js` there.

### macOS

**Easy way:** open Terminal and run

```bash
curl -fsSL https://raw.githubusercontent.com/ishid4/Firefox-Zen/main/install.sh | bash
```

If copying into Firefox fails, allow Terminal under System Settings →
Privacy & Security → **App Management** and run it again.

**Manual way:**

1. Do steps 1-3 from Windows (**Profile Folder** → **Show in Finder**).
2. Right-click Firefox in Applications → **Show Package Contents**, and copy the
   contents of `chrome/program` into `Contents/Resources`.

### Linux

**Easy way:** open a terminal and run

```bash
curl -fsSL https://raw.githubusercontent.com/ishid4/Firefox-Zen/main/install.sh | bash
```

It uses `sudo` when the Firefox folder needs it. Snap and Flatpak Firefox
can't load the loader; use Mozilla's `.deb` or `.tar.bz2` build.

**Manual way:**

1. Do steps 1-3 from Windows.
2. Copy the contents of `chrome/program` into the Firefox install folder (the
   one with `application.ini`, often `/usr/lib/firefox` or `/opt/firefox`):

   ```bash
   sudo cp -r chrome/program/. /usr/lib/firefox/
   ```

### Finish

Start Firefox. After a manual install, open `about:support` and click
**Clear startup cache…** first. On the first start Firefox-Zen shows a
**Restart now** banner: click it.

## Usage

- Click the **Firefox-Zen** toolbar button to open **Settings**. Each feature
  has a switch and a preview; turn on what you want (Spaces, compact sidebar,
  address bar in sidebar, …).
- Once Spaces is on, use the bar under the tabs to switch spaces and **+** to
  create spaces, folders or private spaces. Right-click a space for more.
- Its first button opens the **Library** (spaces, history, downloads, mods, settings).

| Windows / Linux | macOS | Does |
| --- | --- | --- |
| Ctrl+T | Cmd+T | Open the floating address bar |
| Alt+click a link | Option+click a link | Open it in Glance |
| Esc | Esc | Close Glance / the Library |
| Ctrl+Alt+P | Ctrl+Option+P | Show or hide private spaces |

Something broke? Set `firefox-zen.mods.safe-mode` to `true` in `about:config`
and restart to load no mods.

Every feature, pref and the mod format are documented in
[readme_extra.md](readme_extra.md).

Uses [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig) (MPL-2.0).
