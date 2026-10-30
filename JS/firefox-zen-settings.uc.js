// ==UserScript==
// @name           Firefox-Zen Settings
// @description    Settings tab of the Library: firefox-zen.* prefs by category, with live previews
// @include        main
// ==/UserScript==

// The settings live in the Library's Settings tab (JS/firefox-zen-library.uc.js
// calls window.FirefoxZenSettings.buildView()). The toolbar button opens the
// Library on that tab, so the settings can be found before Spaces (and with it
// the footer's Library button) is turned on.

(function () {
  "use strict";

  const PREF_BRANCH = "firefox-zen.";
  const WIDGET_ID = "firefox-zen-settings-button";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const { FzMods } = ChromeUtils.importESModule("chrome://userscripts/content/firefox-zen-mods.sys.mjs");
  const { FzColors } = ChromeUtils.importESModule("chrome://userscripts/content/firefox-zen-colors.sys.mjs");

  // Options shown under a feature while it's on. Each reads and writes its own
  // pref; `default` is what an unset pref means to the feature's script.
  const AUTOLOCK = {
    type: "number",
    pref: "private-spaces.autolock-minutes",
    default: 10,
    min: 0,
    max: 1440,
    unit: "minutes",
    label: "Lock private spaces after",
    hint: "Without input, anywhere on the computer. 0 never locks.",
  };

  // JS/firefox-zen-sidebar-tools.uc.js
  const PIN_LIMIT = {
    type: "number",
    pref: "pins.max",
    default: 12,
    min: 1,
    max: 36,
    unit: "pinned tabs",
    label: "Allow up to",
    hint: "Pinned tabs show in every space. Pins you already have stay when you lower it.",
  };

  // JS/firefox-zen-spaces.uc.js
  const SPACES_VISIBLE = {
    type: "number",
    pref: "spaces.visible",
    default: 4,
    min: 2,
    max: 8,
    unit: "spaces",
    label: "Footer shows",
    hint: "Hover the first or last one to scroll to the rest.",
  };

  // JS/firefox-zen-download-cue.uc.js
  const DOWNLOAD_ICON = {
    type: "number",
    pref: "download-cue.icon-seconds",
    default: 7,
    min: 0,
    max: 10,
    unit: "seconds",
    label: "Show the downloads icon for",
    hint: "The Library button turns into a downloads icon after one starts. 0 keeps the Library icon.",
  };

  // Applied here (applyBorderWidth), read by theme/general.css.
  const BORDER_WIDTH = {
    type: "number",
    pref: "window-border.width",
    default: 6,
    min: 1,
    max: 24,
    unit: "px",
    label: "Border width",
  };

  // Which modifiers + click open a glance (JS/firefox-zen-glance.uc.js).
  const GLANCE_MODIFIERS = {
    type: "modifiers",
    pref: "glance.modifiers",
    default: "alt",
    keys: [
      { key: "ctrl", label: "Ctrl" },
      { key: "alt", label: "Alt" },
      { key: "shift", label: "Shift" },
    ],
    label: "Open with",
    hint: "With Ctrl or Shift, Firefox doesn't also open the link in a new tab or window.",
  };

  // Glance size, in thousandths of the content area (JS/firefox-zen-glance.uc.js).
  const GLANCE_SIZE = [
    { type: "range", pref: "glance.width", default: 700, min: 400, max: 1000, step: 10, label: "Width" },
    { type: "range", pref: "glance.height", default: 940, min: 400, max: 1000, step: 10, label: "Height" },
  ];

  // Light/dark for the color scheme (JS/firefox-zen-colors.uc.js)
  const COLOR_MODE = {
    type: "choice",
    pref: "colors.mode",
    default: "system",
    choices: [
      { key: "system", label: "Auto" },
      { key: "light", label: "Light" },
      { key: "dark", label: "Dark" },
    ],
    label: "Mode",
    hint: "Auto follows your system's light or dark setting.",
    // A scheme that uses one look only wins over this (the space's, if any)
    note: () => {
      const scheme = FzColors.schemeById(schemeSpace()?.scheme) ?? FzColors.activeScheme();
      return scheme.mode ? `${scheme.name} uses only its ${scheme.mode} look.` : "";
    },
  };

  // Schemes you made (JS/firefox-zen-colors.sys.mjs). In settings files and
  // Undo, but Reset to defaults keeps them: only which one is picked resets.
  const SAVED_SCHEMES = { type: "schemes", pref: "colors.schemes", default: [], keepOnReset: true };

  // CSS reads these with -moz-pref(), which treats an unset pref as false.
  // Settings that default to true get written once on first run (see applyDefaults).
  const CATEGORIES = [
    {
      id: "core",
      label: "Core",
      settings: [
        {
          core: true,
          label: "Library",
          description: "Your spaces, history and downloads in one place, over the page.",
          preview: "library",
          tips: [
            "Opens from the first button of the spaces footer, or the Firefox-Zen toolbar button.",
            "Drag spaces, folders and tabs between columns; drop tabs on Pins to pin them.",
            "History and downloads are searchable; drag a history entry onto a space to open it there.",
            "Esc, the button again, or clicking a tab in the sidebar closes it.",
          ],
          options: [PIN_LIMIT],
        },
      ],
    },
    {
      id: "appearance",
      label: "Appearance",
      settings: [
        {
          // Shown as the scheme picker (buildColorsSetting)
          type: "scheme",
          pref: "colors.active",
          default: FzColors.FIREFOX_ID,
          colors: true,
          label: "Color scheme",
          description: "Colors for the whole window, each tuned for light and dark. With Spaces, each space has its own.",
          keywords: "theme color colour gradient accent palette dark light mode",
          tips: [
            "The left half of each preview is its light look, the right half its dark one.",
            "+ makes a scheme from the one you have now; pick up to 4 colors for a gradient.",
            "A space's right-click menu sets its scheme too, without opening Settings.",
            "Text and the accent are adjusted so they stay readable on any colors.",
          ],
          options: [COLOR_MODE],
        },
        {
          pref: "colors.websites",
          default: true,
          label: "Websites follow the mode",
          description: "Light or Dark also switches websites and Firefox's own pages.",
          preview: "websites",
          tips: ["With Auto, Firefox's Website appearance setting decides."],
        },
      ],
    },
    {
      id: "tabs",
      label: "Tabs & spaces",
      settings: [
        {
          pref: "spaces",
          default: false,
          label: "Spaces",
          description: "Separate sets of tabs, switched from the bar under the sidebar. Pinned tabs show in every space.",
          preview: "spaces",
          tips: [
            "Right-click a space to rename it, set its icon or container, unload, export or delete it.",
            "+ in the footer creates spaces, folders and password-protected private spaces.",
          ],
          options: [SPACES_VISIBLE, AUTOLOCK],
        },
        {
          pref: "tab-sections",
          default: true,
          label: "Tab sections",
          description: "Folders above a line, new tabs below it.",
          preview: "sections",
          tips: [
            "Drag a tab above the line to keep it there without a folder.",
            "Hover the sidebar for a Clear button that closes the tabs below the line.",
          ],
        },
        {
          pref: "show-folder-icons",
          default: true,
          label: "Tab group folders",
          description: "Show tab groups as colored Arc-style folders.",
          preview: "folders",
        },
      ],
    },
    {
      id: "sidebar",
      label: "Sidebar",
      settings: [
        {
          // Shown as the layout picker (buildLayoutSetting); the pref is what
          // a settings file and Reset to defaults cover.
          pref: "compact-sidebar",
          default: false,
          layout: true,
          label: "Sidebar layout",
          description: "How the tabs sidebar shows. Sets Firefox's own sidebar options too.",
          keywords: "compact collapse collapsed expand expanded icons hover auto-hide autohide hide vertical tabs",
          tips: [
            "Firefox's sidebar button still switches between full and icons.",
            "Auto-hide slides the sidebar out over the page when you hover the window edge.",
          ],
        },
        {
          pref: "sidebar-urlbar",
          default: false,
          label: "Address bar in sidebar",
          description: "Move the toolbar and address bar to the top of the expanded sidebar.",
          preview: "sidebarurl",
          // Set while the switch can't be used (buildSetting).
          unavailable: () =>
            currentLayout()?.icons && "Not available with the Icons layouts. Pick Full or Expand on hover to use it.",
          tips: [
            "Goes back to the top while the sidebar is collapsed, and while customizing the toolbar.",
          ],
        },
        {
          pref: "show-customize-button",
          default: true,
          label: "Customize sidebar button",
          description: "Firefox's gear in the sidebar tools.",
          preview: "gear",
          tips: ["Turned off, Customize sidebar is still in the sidebar's right-click menu."],
        },
      ],
    },
    {
      id: "urlbar",
      label: "Address bar",
      settings: [
        {
          pref: "floating-urlbar",
          default: true,
          label: "Floating address bar",
          description: "Open the address bar in the middle of the window, like a command bar.",
          preview: "urlbar",
        },
        {
          pref: "urlbar-newtab",
          default: true,
          label: "No New Tab page",
          description: "Ctrl+T and the + button open the address bar; what you pick opens in a new tab.",
          preview: "newtab",
          tips: [
            "Esc or clicking away cancels without creating a tab.",
            "Shift+click (new window) and middle-click paste still open a real tab.",
          ],
        },
      ],
    },
    {
      id: "layout",
      label: "Layout",
      settings: [
        {
          pref: "compact-toolbar",
          default: false,
          label: "Compact toolbar",
          description: "Hide the toolbar until you hover the top of the window.",
          preview: "compact",
          tips: ["With the address bar in the sidebar, the window controls hide too."],
        },
        {
          pref: "window-border",
          default: true,
          label: "Window border",
          description: "A thin frame in the toolbar's color around the page, with rounded corners.",
          preview: "border",
          tips: ["Hidden in fullscreen."],
          options: [BORDER_WIDTH],
        },
      ],
    },
    {
      id: "browsing",
      label: "Browsing",
      settings: [
        {
          pref: "glance",
          default: true,
          label: "Glance",
          description: "Click a link with a shortcut held (Alt by default) to peek at it in a floating window.",
          preview: "glance",
          tips: ["Esc or a click outside closes it. Drag its edges to resize; the size is kept."],
          options: [GLANCE_MODIFIERS, ...GLANCE_SIZE],
        },
        {
          pref: "download-cue",
          default: true,
          label: "Download animation",
          description: "A new download flies to the Library button, which then opens on Downloads.",
          preview: "download",
          tips: [
            "While downloads run, a ring around the button fills with their progress.",
            "The Library's Downloads tab has a dot until you've seen the new download.",
            "A compact sidebar slides out to show it.",
            "Without the spaces footer, it flies to Firefox's Downloads button when that's in the toolbar.",
          ],
          options: [DOWNLOAD_ICON],
        },
        {
          pref: "show-menu-icons",
          default: true,
          label: "Context menu icons",
          description: "Show icons next to items in right-click menus.",
          preview: "menu",
        },
      ],
    },
  ];

  const SETTINGS = CATEGORIES.flatMap(c => c.settings).filter(s => !s.core);
  const OPTIONS = CATEGORIES.flatMap(c => c.settings).flatMap(s => s.options ?? []);
  // Everything a settings file, Reset and Undo cover.
  // Saved schemes first, so a file's picked scheme exists when it's applied.
  const ALL = [SAVED_SCHEMES, ...SETTINGS, ...OPTIONS];

  // Renamed prefs: old name -> new name, and whether the meaning flipped.
  const MIGRATIONS = [
    { from: "native-urlbar", to: "floating-urlbar", invert: true },
    { from: "hide-folder-icons", to: "show-folder-icons", invert: true },
    { from: "hide-menu-icons", to: "show-menu-icons", invert: true },
    { from: "compact-mode", to: "compact-toolbar", invert: false },
  ];

  // Prefs that are no longer read (the Library is always on now; the layout
  // picker sets sidebar.visibility itself instead of saving and restoring it).
  const RETIRED = ["library", "saved-sidebar-visibility"];

  const isOn = s => s.core || (!s.type && Services.prefs.getBoolPref(PREF_BRANCH + s.pref, false));

  function setOn(s, on) {
    const name = PREF_BRANCH + s.pref;
    // Keep prefs.js clean: unset already reads as false.
    if (on || s.default) {
      Services.prefs.setBoolPref(name, on);
    } else {
      Services.prefs.clearUserPref(name);
    }
  }

  const getInt = o => Services.prefs.getIntPref(PREF_BRANCH + o.pref, o.default);

  function setInt(o, value) {
    const name = PREF_BRANCH + o.pref;
    if (value === o.default) {
      Services.prefs.clearUserPref(name);
    } else {
      Services.prefs.setIntPref(name, value);
    }
  }

  // "ctrl+alt" etc., in the order of o.keys; null when no known key is in it.
  function normalizeModifiers(o, text) {
    const set = new Set(String(text).toLowerCase().split("+"));
    const keys = o.keys.map(k => k.key).filter(k => set.has(k));
    return keys.length ? keys.join("+") : null;
  }

  const getModifiers = o =>
    normalizeModifiers(o, Services.prefs.getStringPref(PREF_BRANCH + o.pref, o.default)) ?? o.default;

  function setString(o, value) {
    const name = PREF_BRANCH + o.pref;
    if (value === o.default) {
      Services.prefs.clearUserPref(name);
    } else {
      Services.prefs.setStringPref(name, value);
    }
  }

  // ---- export / import ----
  // A settings file holds every pref the Settings tab shows, so a setup can be
  // shared and loaded elsewhere. Keys this version doesn't know are skipped.
  // `mods` holds which mods are on and their options (JS/firefox-zen-mods.sys.mjs);
  // the mods themselves aren't in the file.

  const FILE_FORMAT = "firefox-zen-settings";
  const FILE_VERSION = 1;

  const getString = o => Services.prefs.getStringPref(PREF_BRANCH + o.pref, o.default);

  function readValue(o) {
    switch (o.type) {
      case undefined:
        return isOn(o);
      case "modifiers":
        return getModifiers(o);
      case "choice": {
        const value = getString(o);
        return o.choices.some(c => c.key === value) ? value : o.default;
      }
      case "scheme":
        return FzColors.schemeById(getString(o)) ? getString(o) : o.default;
      case "schemes":
        return FzColors.savedSchemes();
      default:
        return getInt(o);
    }
  }

  // Returns false when the value doesn't fit the pref.
  function writeValue(o, value) {
    if (!o.type) {
      if (typeof value !== "boolean") {
        return false;
      }
      setOn(o, value);
    } else if (o.type === "modifiers") {
      const keys = typeof value === "string" && normalizeModifiers(o, value);
      if (!keys) {
        return false;
      }
      setString(o, keys);
    } else if (o.type === "choice") {
      if (!o.choices.some(c => c.key === value)) {
        return false;
      }
      setString(o, value);
    } else if (o.type === "scheme") {
      if (typeof value !== "string" || !FzColors.schemeById(value)) {
        return false;
      }
      setString(o, value);
    } else if (o.type === "schemes") {
      if (!Array.isArray(value)) {
        return false;
      }
      FzColors.saveSchemes(value);
    } else {
      if (!Number.isFinite(value)) {
        return false;
      }
      setInt(o, Math.min(o.max, Math.max(o.min, Math.round(value))));
    }
    return true;
  }

  const isDefault = o => JSON.stringify(readValue(o)) === JSON.stringify(o.default);

  // A setting differs from its default, the feature or any of its options.
  const isModified = s => (!s.core && !isDefault(s)) || (s.options ?? []).some(o => !isDefault(o));

  function resetSetting(s) {
    for (const o of [...(s.core ? [] : [s]), ...(s.options ?? [])]) {
      writeValue(o, o.default);
    }
  }

  // What Reset to defaults puts back
  const RESETTABLE = ALL.filter(o => !o.keepOnReset);

  // For Undo after Import and Reset to defaults.
  const snapshot = () => ({ prefs: new Map(ALL.map(o => [o, readValue(o)])), mods: FzMods.exportState() });

  function restore(saved) {
    for (const [o, value] of saved.prefs) {
      writeValue(o, value);
    }
    FzMods.importState(saved.mods);
  }

  function pickFile(mode, title) {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window.browsingContext, title, mode);
    fp.appendFilter("Firefox-Zen settings", "*.json");
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.defaultString = "firefox-zen-settings.json";
    fp.defaultExtension = "json";
    return new Promise(resolve =>
      fp.open(rv => resolve(rv === Ci.nsIFilePicker.returnCancel ? null : fp.file.path))
    );
  }

  // Both return a status line for the footer, or null when cancelled.
  async function exportSettings() {
    const path = await pickFile(Ci.nsIFilePicker.modeSave, "Export Firefox-Zen Settings");
    if (!path) {
      return null;
    }
    const settings = {};
    for (const o of ALL) {
      settings[o.pref] = readValue(o);
    }
    const mods = FzMods.exportState();
    await IOUtils.writeJSON(path, { format: FILE_FORMAT, version: FILE_VERSION, settings, mods });
    return `Exported ${Object.keys(settings).length} settings` + (mods.enabled.length ? ` and ${mods.enabled.length} mods.` : ".");
  }

  async function importSettings() {
    const path = await pickFile(Ci.nsIFilePicker.modeOpen, "Import Firefox-Zen Settings");
    if (!path) {
      return null;
    }
    const data = await IOUtils.readJSON(path);
    if (data?.format !== FILE_FORMAT || typeof data.settings !== "object" || !data.settings) {
      throw new Error("not a Firefox-Zen settings file");
    }
    const known = new Map(ALL.map(o => [o.pref, o]));
    let applied = 0;
    let skipped = 0;
    for (const [pref, value] of Object.entries(data.settings)) {
      if (known.has(pref) && writeValue(known.get(pref), value)) {
        applied++;
      } else {
        skipped++;
      }
    }
    let message = `Imported ${applied} settings` + (skipped ? `; skipped ${skipped} unknown or invalid.` : ".");
    if (data.mods) {
      const { missing, held } = FzMods.importState(data.mods);
      if (missing.length) {
        message += ` Not installed: ${missing.join(", ")}.`;
      }
      if (held.length) {
        message += ` Left off (they run code; turn on in Mods): ${held.join(", ")}.`;
      }
    }
    return message;
  }

  // The theme's icons are file:// SVGs using context-fill. Firefox only honors
  // context-fill for chrome:// / resource:// images unless this pref is on, so
  // without it every icon renders black (invisible in dark mode).
  // toolkit.legacyUserProfileCustomizations.stylesheets: without it Firefox
  // doesn't load userChrome.css / userContent.css at all.
  const REQUIRED_PREFS = [
    "toolkit.legacyUserProfileCustomizations.stylesheets",
    "svg.context-properties.content.enabled",
  ];

  // Set (on the default branch, so only until Firefox quits) when
  // applyDefaults had to turn a required pref on: the Settings tab then asks
  // for a restart, in every window.
  const RESTART_PREF = "restart-needed";
  const restartNeeded = () => Services.prefs.getBoolPref(PREF_BRANCH + RESTART_PREF, false);

  function applyDefaults() {
    // Takes effect on the next restart.
    for (const name of REQUIRED_PREFS) {
      if (!Services.prefs.getBoolPref(name, false)) {
        Services.prefs.setBoolPref(name, true);
        Services.prefs.getDefaultBranch(PREF_BRANCH).setBoolPref(RESTART_PREF, true);
      }
    }

    for (const { from, to, invert } of MIGRATIONS) {
      const oldName = PREF_BRANCH + from;
      if (Services.prefs.prefHasUserValue(oldName)) {
        Services.prefs.setBoolPref(PREF_BRANCH + to, Services.prefs.getBoolPref(oldName) !== invert);
        Services.prefs.clearUserPref(oldName);
      }
    }
    for (const name of RETIRED) {
      Services.prefs.clearUserPref(PREF_BRANCH + name);
    }
    for (const s of SETTINGS) {
      if (!s.type && s.default && !Services.prefs.prefHasUserValue(PREF_BRANCH + s.pref)) {
        Services.prefs.setBoolPref(PREF_BRANCH + s.pref, true);
      }
    }
  }

  function h(tag, attrs = {}, ...children) {
    const el = document.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) {
        continue;
      }
      if (k === "text") {
        el.textContent = v;
      } else if (typeof v === "function") {
        el.addEventListener(k.replace(/^on/, ""), v);
      } else {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
    el.append(...children.filter(c => c != null && c !== false));
    return el;
  }

  // Miniature mockups; their look is driven by [data-on] in settings.css.
  function buildPreview(kind) {
    const mock = h("div", { class: `fz-mock fz-preview-${kind}`, "aria-hidden": "true" });
    switch (kind) {
      case "compact":
        mock.append(
          h("div", { class: "fz-mock-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h("div", { class: "fz-mock-page" })
        );
        break;
      case "sidebarurl":
        mock.append(
          h("div", { class: "fz-mock-toolbar fz-mock-top-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h(
            "div",
            { class: "fz-mock-body" },
            h(
              "div",
              { class: "fz-mock-side fz-mock-url-side" },
              h("i", { class: "fz-mock-side-url" }),
              h("span"),
              h("span"),
              h("span")
            ),
            h("div", { class: "fz-mock-page" })
          )
        );
        break;
      case "spaces":
        mock.append(
          h(
            "div",
            { class: "fz-mock-body" },
            h(
              "div",
              { class: "fz-mock-side fz-mock-spaces-side" },
              h("span"),
              h("span"),
              h("span"),
              h("div", { class: "fz-mock-spaces-bar" }, h("i"), h("i"), h("i"))
            ),
            h("div", { class: "fz-mock-page" })
          )
        );
        break;
      case "border":
        mock.append(h("div", { class: "fz-mock-page" }));
        break;
      case "gear":
        mock.append(
          h(
            "div",
            { class: "fz-mock-body" },
            h(
              "div",
              { class: "fz-mock-side fz-mock-tools-side" },
              h("span"),
              h("span"),
              h("div", { class: "fz-mock-tools" }, h("i"), h("i"), h("i", { class: "fz-mock-gear" }))
            ),
            h("div", { class: "fz-mock-page" })
          )
        );
        break;
      case "urlbar":
        mock.append(
          h("div", { class: "fz-mock-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h("div", { class: "fz-mock-page" }),
          h("div", { class: "fz-mock-float" }, h("div"), h("div"), h("div"))
        );
        break;
      case "newtab":
        mock.append(
          h("div", { class: "fz-mock-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h("div", { class: "fz-mock-page" }, h("div", { class: "fz-mock-tiles" }, h("i"), h("i"), h("i"), h("i"))),
          h("div", { class: "fz-mock-float" }, h("div"), h("div"), h("div"))
        );
        break;
      case "glance":
        mock.append(
          h("div", { class: "fz-mock-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h("div", { class: "fz-mock-page" }),
          h("div", { class: "fz-mock-glance" }, h("div"), h("div"), h("div"))
        );
        break;
      case "library": {
        const column = rows => h("div", {}, ...Array.from({ length: rows }, () => h("i")));
        mock.append(
          h("div", { class: "fz-mock-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h("div", { class: "fz-mock-page" }),
          h("div", { class: "fz-mock-library" }, column(4), column(2), column(3))
        );
        break;
      }
      case "download":
        mock.append(
          h(
            "div",
            { class: "fz-mock-body" },
            h(
              "div",
              { class: "fz-mock-side fz-mock-spaces-side" },
              h("span"),
              h("span"),
              h("div", { class: "fz-mock-spaces-bar" }, h("i"), h("i"), h("i"))
            ),
            h("div", { class: "fz-mock-page" })
          ),
          h("i", { class: "fz-mock-download" })
        );
        break;
      case "websites":
        mock.append(
          h("div", { class: "fz-mock-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h("div", { class: "fz-mock-page" }, h("i"), h("i"), h("i"))
        );
        break;
      case "folders":
        for (let i = 0; i < 3; i++) {
          mock.append(
            h("div", { class: "fz-mock-row" }, h("span", { class: "fz-mock-icon" }), h("span", { class: "fz-mock-line" }))
          );
        }
        break;
      case "sections": {
        const row = () =>
          h("div", { class: "fz-mock-row" }, h("span", { class: "fz-mock-icon" }), h("span", { class: "fz-mock-line" }));
        mock.append(row(), row(), h("div", { class: "fz-mock-separator" }), row(), row());
        break;
      }
      case "menu":
        for (let i = 0; i < 4; i++) {
          mock.append(
            h("div", { class: "fz-mock-row" }, h("span", { class: "fz-mock-icon" }), h("span", { class: "fz-mock-line" }))
          );
        }
        break;
    }
    return mock;
  }

  // ---- options (under a feature that's on) ----
  // Each returns { el, sync }; sync() re-reads the pref.

  function buildNumber(o) {
    const input = h("input", {
      type: "number",
      class: "fz-number",
      min: o.min,
      max: o.max,
      step: 1,
      "aria-label": o.label,
    });
    const sync = () => (input.value = getInt(o));
    // On change (Enter, blur, the spinner), not per keystroke. Out of range or
    // empty snaps back into range.
    input.addEventListener("change", () => {
      const value = Math.round(Number(input.value));
      if (input.value === "" || Number.isNaN(value)) {
        sync();
        return;
      }
      setInt(o, Math.min(o.max, Math.max(o.min, value)));
      sync();
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        input.blur();
      }
    });
    const el = h(
      "div",
      { class: "fz-option" },
      h("label", { class: "fz-option-label", text: o.label, onclick: () => input.focus() }),
      h("span", { class: "fz-number-wrap" }, input, h("span", { class: "fz-option-unit", text: o.unit })),
      o.hint && h("p", { class: "fz-option-hint", text: o.hint })
    );
    return { el, sync };
  }

  function buildRange(o) {
    const input = h("input", {
      type: "range",
      class: "fz-range",
      min: o.min,
      max: o.max,
      step: o.step,
      "aria-label": o.label,
    });
    const value = h("output", { class: "fz-option-value" });
    const show = v => (value.textContent = `${Math.round(v / 10)}%`);
    input.addEventListener("input", () => show(input.value));
    input.addEventListener("change", () => setInt(o, Number(input.value)));
    const el = h(
      "label",
      { class: "fz-option fz-option-range" },
      h("span", { class: "fz-option-label", text: o.label }),
      input,
      value
    );
    const sync = () => {
      const v = Math.min(o.max, Math.max(o.min, getInt(o)));
      input.value = v;
      show(v);
    };
    return { el, sync };
  }

  // Toggle chips; at least one key stays on.
  function buildModifiers(o) {
    const shortcut = h("span", { class: "fz-option-unit" });
    const chips = o.keys.map(k =>
      h("button", {
        type: "button",
        class: "fz-chip",
        "data-key": k.key,
        text: k.label,
        onclick: () => {
          const on = new Set(getModifiers(o).split("+"));
          if (on.has(k.key)) {
            on.delete(k.key);
          } else {
            on.add(k.key);
          }
          const keys = normalizeModifiers(o, [...on].join("+"));
          if (keys) {
            setString(o, keys);
          }
        },
      })
    );
    const el = h(
      "div",
      { class: "fz-option" },
      h("span", { class: "fz-option-label", text: o.label }),
      h("span", { class: "fz-chips", role: "group", "aria-label": o.label }, ...chips),
      shortcut,
      o.hint && h("p", { class: "fz-option-hint", text: o.hint })
    );
    const sync = () => {
      const on = getModifiers(o).split("+");
      for (const chip of chips) {
        chip.setAttribute("aria-pressed", String(on.includes(chip.dataset.key)));
      }
      const labels = o.keys.filter(k => on.includes(k.key)).map(k => k.label);
      shortcut.textContent = `${labels.join("+")}+click`;
    };
    return { el, sync };
  }

  // One of a few values, as a segmented row of chips
  function buildChoice(o) {
    const chips = o.choices.map(c =>
      h("button", {
        type: "button",
        role: "radio",
        class: "fz-chip",
        "data-key": c.key,
        text: c.label,
        onclick: () => setString(o, c.key),
      })
    );
    const note = h("span", { class: "fz-option-unit" });
    const el = h(
      "div",
      { class: "fz-option" },
      h("span", { class: "fz-option-label", text: o.label }),
      h("span", { class: "fz-chips", role: "radiogroup", "aria-label": o.label }, ...chips),
      note,
      o.hint && h("p", { class: "fz-option-hint", text: o.hint })
    );
    const sync = () => {
      const value = readValue(o);
      for (const chip of chips) {
        chip.setAttribute("aria-checked", String(chip.dataset.key === value));
      }
      note.textContent = o.note?.() || "";
    };
    return { el, sync };
  }

  const OPTION_BUILDERS = { number: buildNumber, range: buildRange, modifiers: buildModifiers, choice: buildChoice };

  function buildOptions(options) {
    const built = options.map(o => OPTION_BUILDERS[o.type](o));
    const ranges = options.filter(o => o.type === "range");
    const reset =
      ranges.length > 0 &&
      h("button", {
        type: "button",
        class: "fz-option-reset",
        text: "Reset size",
        onclick: () => ranges.forEach(o => setInt(o, o.default)),
      });
    return {
      el: h("div", { class: "fz-options" }, ...built.map(b => b.el), reset),
      sync: () => built.forEach(b => b.sync()),
    };
  }

  // ---- view ----

  const syncers = [];

  // Lower-cased text a search matches against: everything the row shows.
  function searchText(s) {
    const options = (s.options ?? []).flatMap(o => [o.label, o.unit, o.hint, ...(o.keys ?? []).map(k => k.label)]);
    const layouts = s.layout ? LAYOUTS.flatMap(l => [l.group, l.label, l.hint]) : [];
    const schemes = s.colors ? FzColors.allSchemes().map(x => x.name) : [];
    return [s.label, s.description, s.keywords, ...(s.tips ?? []), ...options, ...layouts, ...schemes]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  // Sidebar layout: one row of tiles, each setting compact sidebar,
  // sidebar.visibility and the expanded state together (applyLayout).
  function buildLayoutSetting(s) {
    // Says so when a layout turned Address bar in sidebar off.
    const notice = h("p", {
      class: "fz-hint fz-layout-notice",
      role: "status",
      text: "Address bar in sidebar is off: the Icons layouts have no room for it.",
      hidden: true,
    });
    const pick = l => (notice.hidden = !applyLayout(s, l));

    const tiles = LAYOUTS.map(l =>
      h(
        "button",
        {
          type: "button",
          role: "radio",
          class: "fz-layout-tile",
          "data-layout": l.id,
          title: l.hint,
          "aria-label": `${l.group}: ${l.label}`,
          onclick: () => pick(l),
        },
        h(
          "div",
          { class: `fz-mock fz-layout-mock fz-layout-${l.id}`, "aria-hidden": "true" },
          h(
            "div",
            { class: "fz-mock-body" },
            h("div", { class: "fz-mock-side" }, h("span"), h("span"), h("span")),
            h("div", { class: "fz-mock-page" })
          )
        ),
        h("span", { class: "fz-layout-label", text: l.label })
      )
    );

    // Arrow keys pick the next layout, like a radio group.
    const group = h(
      "div",
      {
        class: "fz-layout-tiles",
        role: "radiogroup",
        "aria-label": s.label,
        onkeydown: e => {
          const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          if (!step) {
            return;
          }
          e.preventDefault();
          const from = Math.max(0, tiles.indexOf(e.target));
          const i = (from + step + tiles.length) % tiles.length;
          tiles[i].focus();
          pick(LAYOUTS[i]);
        },
      },
      ...[ALWAYS_SHOWN, AUTO_HIDE].map(name =>
        h(
          "div",
          { class: "fz-layout-group", "data-count": LAYOUTS.filter(l => l.group === name).length },
          h("span", { class: "fz-layout-group-title", text: name }),
          h("div", { class: "fz-layout-group-tiles" }, ...tiles.filter((_, i) => LAYOUTS[i].group === name))
        )
      )
    );

    // Shown when the current setup isn't one of the tiles.
    const note = h("p", { class: "fz-hint fz-layout-note" });

    const reset = h("button", {
      type: "button",
      class: "fz-row-reset",
      text: "Reset",
      title: `Reset ${s.label} to ${LAYOUTS[0].group}: ${LAYOUTS[0].label}`,
      onclick: () => pick(LAYOUTS[0]),
    });

    const row = h(
      "div",
      { class: "fz-setting fz-layout-setting", "data-pref": s.pref },
      h(
        "div",
        { class: "fz-setting-body" },
        h(
          "span",
          { class: "fz-setting-head" },
          h("span", { class: "fz-setting-title", text: s.label }),
          h("span", { class: "fz-modified", title: "Changed from the default", "aria-label": "Changed" }),
          reset
        ),
        h("p", { class: "fz-setting-desc", text: s.description })
      ),
      group,
      note,
      notice,
      h("ul", { class: "fz-tips" }, ...s.tips.map(t => h("li", { text: t })))
    );
    row.fzSearch = searchText(s);

    syncers.push(() => {
      const current = currentLayout();
      tiles.forEach((tile, i) => {
        const on = LAYOUTS[i] === current;
        tile.setAttribute("aria-checked", String(on));
        // One tab stop: the picked tile, or the first when none is.
        tile.tabIndex = on || (!current && i === 0) ? 0 : -1;
      });
      row.toggleAttribute("data-modified", current !== LAYOUTS[0]);
      note.hidden = !!current;
      if (!Services.prefs.getBoolPref(VERTICAL_TABS_PREF, false)) {
        note.textContent = "Tabs are horizontal now. Picking a layout turns on vertical tabs.";
      } else {
        note.textContent = "Firefox's sidebar is set to hide. Pick a layout to switch back.";
      }
    });
    return row;
  }

  // ---- color schemes ----
  // One tile per scheme (presets, then yours, then +), each a small window
  // painted with it: its light look on the left half, its dark look on the
  // right (one look on both for a scheme that forces a mode). Picking one of
  // your schemes shows its editor under the tiles.

  // Colors a new scheme's added color starts from, the first one not in it
  const NEW_SEEDS = ["#5b8def", "#e5508a", "#2bb673", "#f2a33a"];

  // Variables a tile half paints with (theme/settings.css)
  function paintHalf(half, scheme, mode) {
    const p = FzColors.palette(scheme, mode);
    if (!p) {
      return;
    }
    half.style.setProperty("--fz-sw-frame", p["frame-bg"]);
    half.style.setProperty("--fz-sw-gradient", p["frame-gradient"]);
    half.style.setProperty("--fz-sw-selected", p["tab-selected-bg"]);
    half.style.setProperty("--fz-sw-text", p.text);
    half.style.setProperty("--fz-sw-accent", p.accent);
  }

  function buildSchemeTile(scheme, pick) {
    const halves = ["light", "dark"].map(mode => {
      const half = h(
        "div",
        { class: "fz-scheme-half", "data-mode": scheme.mode || mode },
        h("i", { class: "fz-scheme-tab" }),
        h("i", { class: "fz-scheme-line" }),
        h("i", { class: "fz-scheme-dot" })
      );
      paintHalf(half, scheme, scheme.mode || mode);
      return half;
    });
    return h(
      "button",
      {
        type: "button",
        role: "radio",
        class: "fz-scheme-tile",
        "data-scheme": scheme.id,
        title: scheme.name,
        "aria-label": scheme.name,
        onclick: () => pick(scheme.id),
      },
      h(
        "div",
        { class: "fz-scheme-mock", "data-firefox": scheme.id === FzColors.FIREFOX_ID, "aria-hidden": "true" },
        ...halves
      ),
      h("span", { class: "fz-scheme-label", text: scheme.name })
    );
  }

  // With spaces on, the picker is for the space this window shows. Spaces
  // without their own scheme use the default (the pref), as does everything
  // with spaces off.
  function schemeSpace() {
    const spaces = window.FirefoxZenSpaces;
    return spaces?.enabled() ? (spaces.list().find(x => x.id === spaces.activeId()) ?? null) : null;
  }

  // What the picker shows: the space's own scheme, else the default
  function shownScheme(s) {
    const own = schemeSpace()?.scheme;
    return own && FzColors.schemeById(own) ? own : readValue(s);
  }

  function pickScheme(s, id) {
    const space = schemeSpace();
    if (space) {
      window.FirefoxZenSpaces.setScheme(space.id, id);
    } else {
      setString(s, id);
    }
  }

  function updateSaved(id, change) {
    FzColors.saveSchemes(FzColors.savedSchemes().map(x => (x.id === id ? change(structuredClone(x)) : x)));
  }

  // A copy of the shown scheme's colors and tweaks (not a forced mode, which
  // the editor can't take off again), picked right away
  function newScheme(s) {
    const shown = FzColors.schemeById(shownScheme(s));
    const from = window.FirefoxZenColors?.withDraft(shown) ?? shown;
    const saved = FzColors.savedSchemes();
    let n = saved.length + 1;
    while (saved.some(x => x.name === `Custom ${n}`)) {
      n++;
    }
    const scheme = {
      id: `custom-${Date.now().toString(36)}`,
      name: `Custom ${n}`,
      seeds: from.seeds.length ? [...from.seeds] : [NEW_SEEDS[0]],
    };
    for (const half of ["light", "dark"]) {
      if (from[half]) {
        scheme[half] = structuredClone(from[half]);
      }
    }
    FzColors.saveSchemes([...saved, scheme]);
    pickScheme(s, scheme.id);
  }

  function deleteScheme(s, scheme) {
    if (!Services.prompt.confirm(window, "Delete Color Scheme", `Delete “${scheme.name}”? This can't be undone.`)) {
      return;
    }
    // Spaces that had it go back to the default
    if (readValue(s) === scheme.id) {
      setString(s, FzColors.FIREFOX_ID);
    }
    FzColors.saveSchemes(FzColors.savedSchemes().filter(x => x.id !== scheme.id));
  }

  // ---- scheme editor ----

  // The color wheel: angle = hue, distance from the middle = how colorful
  // (lightness is the mode's business). Drawn once per window.
  const WHEEL_SIZE = 168;
  let wheelImage = null;

  function drawWheel(canvas) {
    const ctx = canvas.getContext("2d");
    const n = canvas.width;
    if (!wheelImage) {
      wheelImage = ctx.createImageData(n, n);
      const r = n / 2;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const dx = x + 0.5 - r;
          const dy = r - (y + 0.5);
          const d = Math.hypot(dx, dy) / r;
          if (d > 1) {
            continue;
          }
          const hue = (Math.atan2(dy, dx) * 180) / Math.PI;
          const [R, G, B] = FzColors.wheelRgb((hue + 360) % 360, d * FzColors.WHEEL_CHROMA);
          const i = (y * n + x) * 4;
          wheelImage.data.set([R, G, B, d > 0.985 ? Math.round(((1 - d) / 0.015) * 255) : 255], i);
        }
      }
    }
    ctx.putImageData(wheelImage, 0, 0);
  }

  // Wheel position (px from the wheel's top left) of a seed, and back
  function wheelPoint(hex) {
    const { hue, chroma } = FzColors.wheelOf(hex);
    const R = WHEEL_SIZE / 2;
    const r = (chroma / FzColors.WHEEL_CHROMA) * R;
    const a = (hue * Math.PI) / 180;
    return { x: R + r * Math.cos(a), y: R - r * Math.sin(a) };
  }

  function wheelSeed(x, y) {
    const R = WHEEL_SIZE / 2;
    const dx = x - R;
    const dy = R - y;
    const hue = (Math.atan2(dy, dx) * 180) / Math.PI;
    return FzColors.fromWheel(hue, (Math.min(1, Math.hypot(dx, dy) / R)) * FzColors.WHEEL_CHROMA);
  }

  // A slider row; `get`/`set` work in the slider's own units. `title`: its
  // explanation, on hover.
  function buildSlider({ label, title, min, max, step = 1, get, set, format }) {
    const input = h("input", { type: "range", class: "fz-range", min, max, step, "aria-label": label });
    const value = h("output", { class: "fz-option-value" });
    input.addEventListener("input", () => {
      value.textContent = format(Number(input.value));
      set(Number(input.value), false);
    });
    input.addEventListener("change", () => set(Number(input.value), true));
    const el = h("label", { class: "fz-option fz-option-range", title }, h("span", { class: "fz-option-label", text: label }), input, value);
    const sync = view => {
      const v = get(view);
      if (document.activeElement !== input) {
        input.value = v;
      }
      value.textContent = format(Number(input.value));
    };
    return { el, input, sync };
  }

  // Segmented chips; `get`/`set` take the chip keys. A choice's `title` and
  // the row's `title` explain them on hover.
  function buildChips(label, choices, get, set, title = null) {
    const chips = choices.map(c =>
      h("button", {
        type: "button",
        role: "radio",
        class: "fz-chip",
        "data-key": c.key,
        text: c.label,
        title: c.title,
        onclick: () => set(c.key),
      })
    );
    const el = h(
      "div",
      { class: "fz-option" },
      h("span", { class: "fz-option-label", text: label, title }),
      h("span", { class: "fz-chips", role: "radiogroup", "aria-label": label }, ...chips)
    );
    const sync = view => {
      const value = get(view);
      for (const chip of chips) {
        chip.setAttribute("aria-checked", String(chip.dataset.key === value));
      }
    };
    return { el, sync };
  }

  const GRADIENT_STYLES = [
    { key: "linear", label: "Linear", title: "The colors run in a straight line across the window, in the angle's direction." },
    { key: "radial", label: "Radial", title: "The colors spread in rings from a point on the window's edge, set by the angle." },
    { key: "corners", label: "Corners", title: "Each color glows from its own corner; the angle turns them around the window." },
  ];
  // Which of a scheme's looks it uses: both (Mode picks), or always one
  const SCHEME_LOOKS = [
    { key: "", label: "Both", title: "Uses the light or dark look, whichever the Mode setting picks." },
    { key: "light", label: "Light only", title: "Always uses the light look, whatever Mode says." },
    { key: "dark", label: "Dark only", title: "Always uses the dark look, whatever Mode says." },
  ];

  // Everything about the picked scheme, when it's one of yours. Edits go to
  // a draft this window shows right away (JS/firefox-zen-colors.uc.js):
  // Save changes stores it, Revert drops it. A draft outlives the Library
  // being closed, not a restart.
  function buildSchemeEditor(s) {
    const el = h("div", { class: "fz-options fz-scheme-editor", hidden: true });
    // Scheme id + color count the controls were built for
    let shape = "";
    let parts = null;
    let editing = null;
    let queued = [];
    let frame = 0;

    const colors = () => window.FirefoxZenColors;
    const savedOf = id => FzColors.savedSchemes().find(x => x.id === id);
    // The draft, else the saved scheme
    const view = () => colors()?.draft(editing) ?? savedOf(editing);

    // Edits queued this frame go into the draft together (dragging makes a lot)
    function applyEdits() {
      cancelAnimationFrame(frame);
      frame = 0;
      const changes = queued;
      queued = [];
      const saved = savedOf(editing);
      if (!saved || !changes.length) {
        return;
      }
      const next = changes.reduce((acc, change) => change(structuredClone(acc)), view());
      if (!FzColors.validScheme(next)) {
        return;
      }
      // Edited back to what's saved: no draft
      colors()?.setDraft(editing, JSON.stringify(next) === JSON.stringify(saved) ? null : next);
      sync();
    }

    // `change` maps a scheme copy to the edited one
    const edit = change => {
      queued.push(change);
      frame ||= requestAnimationFrame(applyEdits);
    };

    const save = () => {
      applyEdits();
      const draft = colors()?.draft(editing);
      if (draft) {
        updateSaved(editing, () => draft);
        colors().setDraft(editing, null);
      }
      sync();
    };

    const revert = () => {
      queued = [];
      colors()?.setDraft(editing, null);
      sync();
    };

    const actions = h(
      "div",
      { class: "fz-scheme-actions", hidden: true },
      h("span", { class: "fz-hint", text: "Unsaved changes, shown in this window only" }),
      h("button", { type: "button", class: "fz-reset", text: "Revert", title: "Back to the saved scheme", onclick: revert }),
      h("button", { type: "button", class: "fz-reset fz-primary", text: "Save changes", onclick: save })
    );

    const setSeed = (i, hex, now) =>
      edit(x => ({ ...x, seeds: x.seeds.map((c, j) => (j === i ? hex : c)) }), now);
    const addSeed = hex => edit(x => ({ ...x, seeds: [...x.seeds, hex].slice(0, FzColors.MAX_SEEDS) }), true);
    const removeSeed = i => edit(x => ({ ...x, seeds: x.seeds.filter((_, j) => j !== i) }), true);

    // One half's tweak; a half back at its defaults is dropped
    const setTweak = (half, key, value, now) =>
      edit(x => {
        const t = { tint: 1, shift: 0, ...x[half], [key]: value };
        const out = { ...x, [half]: t };
        if (t.tint === 1 && t.shift === 0) {
          delete out[half];
        }
        return out;
      }, now);

    function buildWheel(scheme) {
      const canvas = h("canvas", { class: "fz-wheel-canvas", width: WHEEL_SIZE * 2, height: WHEEL_SIZE * 2 });
      drawWheel(canvas);
      const wheel = h("div", { class: "fz-wheel", role: "group", "aria-label": "Color wheel" }, canvas);
      let dragging = -1;
      const dots = scheme.seeds.map((seed, i) => {
        const dot = h("button", {
          type: "button",
          class: "fz-wheel-dot",
          title: "Drag to change; arrow keys move it",
          "aria-label": `Color ${i + 1}`,
        });
        dot.addEventListener("pointerdown", e => {
          e.preventDefault();
          e.stopPropagation();
          dot.focus();
          dot.setPointerCapture(e.pointerId);
          dragging = i;
          dot.toggleAttribute("dragging", true);
        });
        dot.addEventListener("pointermove", e => {
          if (dragging !== i) {
            return;
          }
          const box = wheel.getBoundingClientRect();
          const hex = wheelSeed(e.clientX - box.left, e.clientY - box.top);
          place(dot, hex);
          setSeed(i, hex, false);
        });
        const drop = () => {
          if (dragging === i) {
            dragging = -1;
            dot.removeAttribute("dragging");
          }
        };
        dot.addEventListener("pointerup", drop);
        dot.addEventListener("lostpointercapture", drop);
        // Arrows: left/right turn the hue, up/down change how colorful
        dot.addEventListener("keydown", e => {
          const step = { ArrowLeft: [5, 0], ArrowRight: [-5, 0], ArrowUp: [0, 0.01], ArrowDown: [0, -0.01] }[e.key];
          if (!step) {
            return;
          }
          e.preventDefault();
          const { hue, chroma } = FzColors.wheelOf(view().seeds[i]);
          const hex = FzColors.fromWheel(hue + step[0], chroma + step[1]);
          place(dot, hex);
          setSeed(i, hex, false);
        });
        return dot;
      });
      const place = (dot, hex) => {
        const { x, y } = wheelPoint(hex);
        dot.style.left = `${x}px`;
        dot.style.top = `${y}px`;
        dot.style.backgroundColor = hex;
      };
      // A click on the wheel adds a color there, or moves the nearest one
      // when there are 4
      canvas.addEventListener("pointerdown", e => {
        const box = wheel.getBoundingClientRect();
        const x = e.clientX - box.left;
        const y = e.clientY - box.top;
        if (Math.hypot(x - WHEEL_SIZE / 2, y - WHEEL_SIZE / 2) > WHEEL_SIZE / 2) {
          return;
        }
        const hex = wheelSeed(x, y);
        const seeds = view().seeds;
        if (seeds.length < FzColors.MAX_SEEDS) {
          addSeed(hex);
          return;
        }
        const near = seeds
          .map((c, i) => ({ i, d: Math.hypot(wheelPoint(c).x - x, wheelPoint(c).y - y) }))
          .reduce((a, b) => (b.d < a.d ? b : a));
        place(dots[near.i], hex);
        setSeed(near.i, hex, true);
      });
      wheel.append(...dots);
      const sync = v => v.seeds.forEach((c, i) => i !== dragging && place(dots[i], c));
      return { el: wheel, sync };
    }

    function build(scheme) {
      const name = h("input", {
        type: "text",
        class: "fz-number fz-scheme-name",
        value: scheme.name,
        maxlength: 40,
        "aria-label": "Scheme name",
        onchange: () => {
          const value = name.value.trim();
          if (value) {
            edit(x => ({ ...x, name: value }), true);
          } else {
            name.value = view().name;
          }
        },
        onkeydown: e => {
          if (e.key === "Enter") {
            name.blur();
          }
        },
      });

      const wheel = buildWheel(scheme);

      // Swatches: the native picker for exact colors, × to remove
      const swatches = scheme.seeds.map((seed, i) => {
        const input = h("input", {
          type: "color",
          class: "fz-seed-input",
          value: seed,
          "aria-label": `Color ${i + 1}`,
          oninput: () => setSeed(i, input.value, false),
          onchange: () => setSeed(i, input.value, true),
        });
        const remove =
          scheme.seeds.length > 1 &&
          h("button", {
            type: "button",
            class: "fz-seed-remove",
            title: "Remove this color",
            "aria-label": `Remove color ${i + 1}`,
            onclick: () => removeSeed(i),
          });
        return { input, el: h("span", { class: "fz-seed" }, input, remove) };
      });
      const add =
        scheme.seeds.length < FzColors.MAX_SEEDS &&
        h("button", {
          type: "button",
          class: "fz-seed-add",
          title: "Add a color (or click the wheel)",
          "aria-label": "Add a color",
          onclick: () => addSeed(NEW_SEEDS.find(c => !view().seeds.includes(c)) ?? NEW_SEEDS[0]),
        });

      const style = buildChips(
        "Style",
        GRADIENT_STYLES,
        v => FzColors.gradientOf(v).type,
        type => edit(x => ({ ...x, gradient: { ...FzColors.gradientOf(x), type } }), true),
        "How the colors blend across the window. Needs 2 or more colors."
      );
      const angle = buildSlider({
        label: "Angle",
        title: "Which way the gradient goes: the line's direction, where the rings start, or how far the corners turn.",
        min: 0,
        max: 359,
        get: v => FzColors.gradientOf(v).angle,
        set: (value, now) => edit(x => ({ ...x, gradient: { ...FzColors.gradientOf(x), angle: value } }), now),
        format: v => `${v}\u00b0`,
      });
      const grain = buildSlider({
        label: "Grain",
        title: "Film-like noise over the window, for a softer, textured look. 0% turns it off.",
        min: 0,
        max: 100,
        get: v => Math.round((v.grain || 0) * 100),
        set: (value, now) =>
          edit(x => {
            const out = { ...x, grain: value / 100 };
            if (!value) {
              delete out.grain;
            }
            return out;
          }, now),
        format: v => `${v}%`,
      });
      const look = buildChips(
        "Uses",
        SCHEME_LOOKS,
        v => v.mode || "",
        mode =>
          edit(x => {
            const out = { ...x, mode };
            if (!mode) {
              delete out.mode;
            }
            return out;
          }, true),
        "Which of this scheme's two looks it uses."
      );

      // Light and dark are tuned apart
      const halves = ["light", "dark"].map(half => {
        const color = buildSlider({
          label: "Color",
          min: 0,
          max: 200,
          step: 5,
          get: v => Math.round((v[half]?.tint ?? 1) * 100),
          set: (value, now) => setTweak(half, "tint", value / 100, now),
          format: v => `${v}%`,
        });
        const brightness = buildSlider({
          label: "Brightness",
          min: -10,
          max: 10,
          get: v => Math.round((v[half]?.shift ?? 0) * 100),
          set: (value, now) => setTweak(half, "shift", value / 100, now),
          format: v => (v > 0 ? `+${v}` : `${v}`),
        });
        const el = h(
          "div",
          { class: "fz-scheme-half-tweaks", "data-half": half },
          h("span", { class: "fz-layout-group-title", text: half === "light" ? "Light look" : "Dark look" }),
          color.el,
          brightness.el
        );
        return {
          el,
          sync: v => {
            [color, brightness].forEach(c => c.sync(v));
            // The other look is never shown: hide its sliders
            el.hidden = !!v.mode && v.mode !== half;
          },
        };
      });

      el.replaceChildren(
        h(
          "div",
          { class: "fz-option" },
          h("label", { class: "fz-option-label", text: "Name", onclick: () => name.focus() }),
          name,
          h("button", { type: "button", class: "fz-reset", text: "Delete", onclick: () => deleteScheme(s, view()) })
        ),
        h(
          "div",
          { class: "fz-scheme-studio" },
          wheel.el,
          h(
            "div",
            { class: "fz-options" },
            h(
              "div",
              { class: "fz-option" },
              h("span", { class: "fz-option-label", text: "Colors" }),
              h("span", { class: "fz-seeds" }, ...swatches.map(c => c.el), add)
            ),
            style.el,
            angle.el,
            grain.el
          )
        ),
        look.el,
        h("div", { class: "fz-scheme-halves" }, ...halves.map(x => x.el)),
        h("p", {
          class: "fz-option-hint",
          text: "Drag the dots, or click the wheel to add a color. The middle is gray, the rim most colorful.",
        }),
        actions
      );

      const gradientParts = [style.el, angle.el];
      parts = {
        name,
        sync: v => {
          wheel.sync(v);
          swatches.forEach((c, i) => (c.input.value = v.seeds[i]));
          // A gradient needs 2 colors
          for (const part of gradientParts) {
            part.toggleAttribute("data-disabled", v.seeds.length < 2);
          }
          [style, angle, grain, look, ...halves].forEach(c => c.sync(v));
        },
      };
    }

    const syncEditor = () => {
      const id = savedOf(shownScheme(s))?.id ?? null;
      if (id !== editing) {
        // Edits still queued belong to the scheme they were made on
        applyEdits();
        editing = id;
      }
      const v = id && view();
      el.hidden = !v;
      if (!v) {
        shape = "";
        return;
      }
      const next = `${v.id}/${v.seeds.length}`;
      if (next !== shape) {
        shape = next;
        build(v);
      }
      // Take changes made elsewhere, but not over a field being typed in
      if (document.activeElement !== parts.name) {
        parts.name.value = v.name;
      }
      parts.sync(v);
      actions.hidden = !colors()?.draft(editing);
    };
    return { el, sync: syncEditor };
  }

  function buildColorsSetting(s) {
    const pick = id => pickScheme(s, id);
    let radios = [];
    // Arrow keys pick the next scheme, like a radio group
    const tiles = h("div", {
      class: "fz-scheme-tiles",
      role: "radiogroup",
      "aria-label": s.label,
      onkeydown: e => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        const from = radios.indexOf(e.target);
        if (!step || from < 0) {
          return;
        }
        e.preventDefault();
        const next = radios[(from + step + radios.length) % radios.length];
        next.focus();
        pick(next.dataset.scheme);
      },
    });
    const add = h(
      "button",
      {
        type: "button",
        class: "fz-scheme-tile fz-scheme-add",
        title: "New scheme from the one you have now",
        "aria-label": "New color scheme",
        onclick: () => newScheme(s),
      },
      h("div", { class: "fz-scheme-mock", "aria-hidden": "true" }),
      h("span", { class: "fz-scheme-label", text: "New" })
    );
    const editor = buildSchemeEditor(s);
    const options = buildOptions(s.options);
    const reset = h("button", {
      type: "button",
      class: "fz-row-reset",
      text: "Reset",
      title: `Reset ${s.label} to Firefox theme and Auto`,
      onclick: () => {
        const space = schemeSpace();
        if (space?.scheme) {
          window.FirefoxZenSpaces.setScheme(space.id, null);
        }
        resetSetting(s);
      },
    });

    // With spaces: whose scheme this is, and the default the others use
    const scopeText = h("span");
    const useDefault = h("button", {
      type: "button",
      class: "fz-option-reset",
      text: "Use default",
      title: "This space follows the default scheme again",
      onclick: () => window.FirefoxZenSpaces.setScheme(schemeSpace().id, null),
    });
    const makeDefault = h("button", {
      type: "button",
      class: "fz-option-reset",
      text: "Make default",
      title: "Spaces without their own scheme use this one",
      onclick: () => setString(s, shownScheme(s)),
    });
    const scope = h("p", { class: "fz-hint fz-scheme-scope" }, scopeText, useDefault, makeDefault);

    const row = h(
      "div",
      { class: "fz-setting fz-colors-setting", "data-pref": s.pref },
      h(
        "div",
        { class: "fz-setting-body" },
        h(
          "span",
          { class: "fz-setting-head" },
          h("span", { class: "fz-setting-title", text: s.label }),
          h("span", { class: "fz-modified", title: "Changed from the default", "aria-label": "Changed" }),
          reset
        ),
        h("p", { class: "fz-setting-desc", text: s.description })
      ),
      scope,
      tiles,
      editor.el,
      options.el,
      h("ul", { class: "fz-tips" }, ...s.tips.map(t => h("li", { text: t })))
    );

    // Tiles are rebuilt only when a scheme changes
    let listKey = "";
    syncers.push(() => {
      // As this window shows them: unsaved drafts in place, marked
      const drafts = window.FirefoxZenColors;
      const list = FzColors.allSchemes().map(x => drafts?.withDraft(x) ?? x);
      // Which ones are drafts counts too: saving one changes no color
      const key = JSON.stringify([list, list.map(x => !!drafts?.draft(x.id))]);
      if (key !== listKey) {
        listKey = key;
        radios = list.map(scheme => {
          const tile = buildSchemeTile(scheme, pick);
          if (drafts?.draft(scheme.id)) {
            tile.setAttribute("data-unsaved", "");
            tile.title = `${scheme.name} (unsaved changes)`;
          }
          return tile;
        });
        tiles.replaceChildren(...radios, add);
        row.fzSearch = searchText(s);
      }
      const active = shownScheme(s);
      for (const tile of radios) {
        const on = tile.dataset.scheme === active;
        tile.setAttribute("aria-checked", String(on));
        tile.tabIndex = on ? 0 : -1;
      }
      const space = schemeSpace();
      const own = !!(space?.scheme && FzColors.schemeById(space.scheme));
      const fallback = FzColors.activeScheme().name;
      scope.hidden = !space;
      if (space) {
        scopeText.textContent = own
          ? `For ${space.icon} ${space.name}. Spaces without their own scheme use ${fallback}.`
          : `For ${space.icon} ${space.name}, which uses the default, ${fallback}. Picking one gives it its own.`;
      }
      useDefault.hidden = !own;
      makeDefault.hidden = !own || active === readValue(s);
      row.toggleAttribute("data-modified", isModified(s) || own);
      editor.sync();
      options.sync();
    });
    return row;
  }

  function buildSetting(s) {
    if (s.layout) {
      return buildLayoutSetting(s);
    }
    if (s.colors) {
      return buildColorsSetting(s);
    }
    const control = s.core
      ? h("span", { class: "fz-badge", text: "Core" })
      : h("input", {
          type: "checkbox",
          role: "switch",
          class: "fz-switch",
          "aria-label": s.label,
          onchange: e => setOn(s, e.target.checked),
        });

    const options = s.options && buildOptions(s.options);
    const more =
      (s.tips || options) &&
      h(
        "div",
        { class: "fz-setting-more" },
        h(
          "div",
          { class: "fz-setting-more-inner" },
          s.tips && h("ul", { class: "fz-tips" }, ...s.tips.map(t => h("li", { text: t }))),
          options?.el
        )
      );

    const unavailableNote = s.unavailable && h("p", { class: "fz-setting-unavailable", hidden: true });

    // Shown while the setting differs from its default.
    const reset = h("button", {
      type: "button",
      class: "fz-row-reset",
      text: "Reset",
      title: `Reset ${s.label} to its default`,
      onclick: e => {
        // Inside the row's <label>: don't flip the switch too.
        e.preventDefault();
        resetSetting(s);
      },
    });

    const row = h(
      "div",
      { class: "fz-setting", "data-pref": s.pref ?? "core" },
      h(
        s.core ? "div" : "label",
        { class: "fz-setting-main" },
        buildPreview(s.preview),
        h(
          "div",
          { class: "fz-setting-body" },
          h(
            "span",
            { class: "fz-setting-head" },
            h("span", { class: "fz-setting-title", text: s.label }),
            h("span", { class: "fz-modified", title: "Changed from the default", "aria-label": "Changed" }),
            reset
          ),
          h("p", { class: "fz-setting-desc", text: s.description }),
          unavailableNote
        ),
        control
      ),
      more
    );
    row.fzSearch = searchText(s);

    syncers.push(() => {
      // Unavailable: shown off and disabled; the pref is left as it is.
      const why = s.unavailable?.() || "";
      const on = isOn(s) && !why;
      row.toggleAttribute("data-on", on);
      row.toggleAttribute("data-modified", isModified(s));
      row.toggleAttribute("data-unavailable", !!why);
      if (unavailableNote) {
        unavailableNote.textContent = why;
        unavailableNote.hidden = !why;
      }
      if (!s.core) {
        control.checked = on;
        control.disabled = !!why;
      }
      // Collapsed options stay out of the tab order.
      more?.toggleAttribute("inert", !on);
      if (on) {
        options?.sync();
      }
    });
    return row;
  }

  // Every word must appear somewhere in the row.
  function applySearch(view, text) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    let any = false;
    for (const section of view.querySelectorAll(".fz-category")) {
      let shown = 0;
      for (const row of section.querySelectorAll(".fz-setting")) {
        const match = words.every(w => row.fzSearch.includes(w));
        row.hidden = !match;
        shown += match;
      }
      section.hidden = !shown;
      any ||= shown > 0;
    }
    view.querySelector(".fz-no-results").hidden = any;
  }

  function restartFirefox() {
    const cancel = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
    Services.obs.notifyObservers(cancel, "quit-application-requested", "restart");
    if (!cancel.data) {
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    }
  }

  function buildView() {
    syncers.length = 0;
    const sections = CATEGORIES.map(c =>
      h(
        "section",
        { class: "fz-category", "aria-labelledby": `fz-category-${c.id}` },
        h("h3", { class: "fz-category-title", id: `fz-category-${c.id}`, text: c.label }),
        h("div", { class: "fz-list" }, ...c.settings.map(buildSetting))
      )
    );

    // ---- footer status: a message, and Undo after Import / Reset ----
    const statusText = h("span");
    const undo = h("button", { type: "button", class: "fz-option-reset", text: "Undo", hidden: true });
    const status = h("span", { class: "fz-hint fz-status", role: "status" }, statusText, undo);
    let undoState = null;

    function setStatus(message, { error = false, saved = null } = {}) {
      statusText.textContent = message;
      status.toggleAttribute("data-error", error);
      status.toggleAttribute("data-empty", !message);
      undoState = saved;
      undo.hidden = !saved;
    }
    undo.addEventListener("click", () => {
      if (undoState) {
        restore(undoState);
        setStatus("Undone.");
      }
    });
    setStatus("");

    // `action` returns a status message, or null when cancelled. With
    // `undoable`, what it changed can be put back.
    const footerAction = (text, action, { undoable = false } = {}) =>
      h("button", {
        class: "fz-reset",
        type: "button",
        text,
        onclick: async () => {
          const saved = undoable ? snapshot() : null;
          try {
            const message = await action();
            if (message) {
              setStatus(message, { saved });
            }
          } catch (e) {
            setStatus(`Couldn't do that: ${e.message}`, { error: true });
          }
        },
      });

    const resetAll = () => {
      for (const o of RESETTABLE) {
        writeValue(o, o.default);
      }
      return "Everything is back to its default.";
    };

    // ---- header: title and search ----
    const search = h("input", {
      type: "search",
      class: "fz-lib-search fz-settings-search",
      placeholder: "Search settings",
      "aria-label": "Search settings",
      oninput: () => applySearch(view, search.value),
      onkeydown: e => {
        // Esc clears the search first, then closes the Library.
        if (e.key === "Escape" && search.value) {
          e.stopPropagation();
          search.value = "";
          applySearch(view, "");
        }
      },
    });

    const restartBanner = h(
      "div",
      { class: "fz-banner", role: "status" },
      h(
        "span",
        { class: "fz-banner-text" },
        h("strong", { text: "Restart Firefox to finish setting up." }),
        " The theme's styles and icons load from the next start."
      ),
      h("button", { type: "button", class: "fz-reset", text: "Restart now", onclick: restartFirefox })
    );
    syncers.push(() => (restartBanner.hidden = !restartNeeded()));

    const view = h(
      "div",
      { class: "fz-settings-view" },
      h(
        "header",
        { class: "fz-header" },
        h("h2", { text: "Settings" }),
        h("span", { class: "fz-subtitle", text: "Changes apply instantly" }),
        search
      ),
      restartBanner,
      ...sections,
      h("p", { class: "fz-no-results fz-hint", text: "No settings match.", hidden: true }),
      h(
        "footer",
        { class: "fz-footer" },
        h(
          "div",
          { class: "fz-footer-text" },
          h("span", { class: "fz-hint", text: "Stored in about:config under firefox-zen.*" }),
          status
        ),
        h(
          "div",
          { class: "fz-footer-actions" },
          footerAction("Import…", importSettings, { undoable: true }),
          footerAction("Export…", exportSettings),
          footerAction("Reset to defaults", resetAll, { undoable: true })
        )
      )
    );
    sync();
    return view;
  }

  // Only the latest view has syncers; a closed Library's view is just dropped.
  function sync() {
    syncers.forEach(fn => fn());
  }

  window.FirefoxZenSettings = { buildView };

  // ---- sidebar layout ----
  // A layout is compact sidebar (theme/general.css) + Firefox's
  // sidebar.visibility + whether the launcher is expanded (Firefox's sidebar
  // button, per window). The picker shows whichever tile matches, so changes
  // made with Firefox's own controls show up in it.
  const COMPACT_SIDEBAR_PREF = PREF_BRANCH + "compact-sidebar";
  const VISIBILITY_PREF = "sidebar.visibility";
  const VERTICAL_TABS_PREF = "sidebar.verticalTabs";
  const ALWAYS_SHOW = "always-show";
  const EXPAND_ON_HOVER = "expand-on-hover";

  // Tiles in two groups: compact sidebar off ("Always shown") and on
  // ("Auto-hide"). The first one is the default (Firefox's own). `icons`:
  // the sidebar stays collapsed, so there's no room for the address bar.
  const ALWAYS_SHOWN = "Always shown";
  const AUTO_HIDE = "Auto-hide";
  const LAYOUTS = [
    { id: "full", group: ALWAYS_SHOWN, label: "Full", compact: false, visibility: ALWAYS_SHOW, expanded: true, hint: "Tabs with titles, always shown." },
    { id: "icons", group: ALWAYS_SHOWN, label: "Icons", icons: true, compact: false, visibility: ALWAYS_SHOW, expanded: false, hint: "A strip of tab icons, always shown." },
    { id: "hover", group: ALWAYS_SHOWN, label: "Expand on hover", compact: false, visibility: EXPAND_ON_HOVER, expanded: false, hint: "Icons that expand to full tabs while hovered." },
    { id: "autohide", group: AUTO_HIDE, label: "Full", compact: true, visibility: ALWAYS_SHOW, expanded: true, hint: "Hidden; full tabs slide out at the window edge." },
    { id: "autohide-icons", group: AUTO_HIDE, label: "Icons", icons: true, compact: true, visibility: ALWAYS_SHOW, expanded: false, hint: "Hidden; tab icons slide out at the window edge." },
  ];

  // The tile matching this window, or null (horizontal tabs, "hide sidebar").
  function currentLayout() {
    if (!Services.prefs.getBoolPref(VERTICAL_TABS_PREF, false)) {
      return null;
    }
    const compact = Services.prefs.getBoolPref(COMPACT_SIDEBAR_PREF, false);
    const visibility = Services.prefs.getStringPref(VISIBILITY_PREF, ALWAYS_SHOW);
    // Expand on hover expands while hovered: not part of the choice.
    const expanded = sidebarExpanded(window);
    return (
      LAYOUTS.find(
        l =>
          l.compact === compact &&
          l.visibility === visibility &&
          (visibility === EXPAND_ON_HOVER || l.expanded === expanded)
      ) ?? null
    );
  }

  // Returns true when it turned Address bar in sidebar off.
  function applyLayout(s, l) {
    const urlbar = SETTINGS.find(x => x.pref === "sidebar-urlbar");
    const urlbarOff = !!l.icons && isOn(urlbar);
    if (urlbarOff) {
      setOn(urlbar, false);
    }
    // Compact off before leaving always-show and on after reaching it, so
    // syncSidebarVisibility never sees compact + expand-on-hover.
    if (!l.compact) {
      setOn(s, false);
    }
    if (!Services.prefs.getBoolPref(VERTICAL_TABS_PREF, false)) {
      Services.prefs.setBoolPref(VERTICAL_TABS_PREF, true);
    }
    // Firefox expands the launcher when this switches to always-show.
    Services.prefs.setStringPref(VISIBILITY_PREF, l.visibility);
    if (l.compact) {
      setOn(s, true);
    }
    if (l.visibility !== EXPAND_ON_HOVER) {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        // An open Library holds the sidebar expanded: it applies this on close.
        if (win.FirefoxZenLibrary?.setSidebarExpanded(l.expanded)) {
          continue;
        }
        // Otherwise the same as clicking Firefox's sidebar button.
        if (sidebarExpanded(win) !== l.expanded) {
          win.SidebarController?.handleToolbarButtonClick();
        }
      }
      // The picker reads the held state, which no attribute change announces.
      sync();
    }
    return urlbarOff;
  }

  // Expanded or collapsed, apart from an open Library's hold on it.
  const sidebarExpanded = win =>
    win.FirefoxZenLibrary?.sidebarExpanded() ??
    !!win.document.getElementById("tabbrowser-tabs")?.hasAttribute("expanded");

  // Compact sidebar and Firefox's "Expand sidebar on hover" both reveal the
  // sidebar on hover and fight at the window edge (it flickers open/closed),
  // so they never stay on together; the newest choice wins. Idempotent, so
  // running it in each window is harmless.
  function syncSidebarVisibility(changed) {
    const compact = Services.prefs.getBoolPref(COMPACT_SIDEBAR_PREF, false);
    const visibility = Services.prefs.getStringPref(VISIBILITY_PREF, "");
    if (!compact || visibility !== EXPAND_ON_HOVER) {
      return;
    }
    if (changed === VISIBILITY_PREF) {
      Services.prefs.clearUserPref(COMPACT_SIDEBAR_PREF);
    } else {
      Services.prefs.setStringPref(VISIBILITY_PREF, ALWAYS_SHOW);
    }
  }

  // CSS can't read a number pref: pass the window border's width on.
  function applyBorderWidth() {
    const { pref, default: fallback, min, max } = BORDER_WIDTH;
    const width = Math.min(max, Math.max(min, Services.prefs.getIntPref(PREF_BRANCH + pref, fallback)));
    document.documentElement.style.setProperty("--fz-window-border-width", `${width}px`);
  }

  // ---- per-window setup ----
  applyDefaults();
  syncSidebarVisibility();
  applyBorderWidth();

  const observer = {
    observe(_subject, _topic, name) {
      if (name === COMPACT_SIDEBAR_PREF || name === VISIBILITY_PREF) {
        syncSidebarVisibility(name);
      }
      if (name === PREF_BRANCH + BORDER_WIDTH.pref) {
        applyBorderWidth();
      }
      sync();
    },
  };
  Services.prefs.addObserver(PREF_BRANCH, observer);
  Services.prefs.addObserver(VISIBILITY_PREF, observer);
  Services.prefs.addObserver(VERTICAL_TABS_PREF, observer);
  // Switched spaces: the scheme picker shows the new one's
  window.addEventListener("FzSpacesChanged", sync);
  // Firefox's sidebar button expands/collapses: keep the layout picker current.
  const expandedObserver = new MutationObserver(sync);
  const tabs = document.getElementById("tabbrowser-tabs");
  if (tabs) {
    expandedObserver.observe(tabs, { attributes: true, attributeFilter: ["expanded"] });
  }
  window.addEventListener(
    "unload",
    () => {
      Services.prefs.removeObserver(PREF_BRANCH, observer);
      Services.prefs.removeObserver(VISIBILITY_PREF, observer);
      Services.prefs.removeObserver(VERTICAL_TABS_PREF, observer);
      window.removeEventListener("FzSpacesChanged", sync);
      expandedObserver.disconnect();
    },
    { once: true }
  );

  // ---- one-time widget registration (shared across windows) ----
  if (CustomizableUI.getWidget(WIDGET_ID)?.provider !== CustomizableUI.PROVIDER_API) {
    CustomizableUI.createWidget({
      id: WIDGET_ID,
      type: "button",
      label: "Firefox-Zen",
      tooltiptext: "Firefox-Zen Library and Settings",
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(event) {
        // event.target can lack ownerGlobal here; fall back to the focused browser window.
        const win =
          event?.target?.ownerGlobal ??
          event?.view ??
          Services.wm.getMostRecentWindow("navigator:browser");
        const library = win?.FirefoxZenLibrary;
        if (!library) {
          return;
        }
        if (library.isOpen() && library.view() === "settings") {
          library.close();
        } else {
          library.open("settings");
        }
      },
    });
  }
})();
