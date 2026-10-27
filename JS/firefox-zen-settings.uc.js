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
          tips: ["Hover the sidebar for a Clear button that closes the tabs below the line."],
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
        {
          pref: "sidebar-urlbar",
          default: false,
          label: "Address bar in sidebar",
          description: "Move the toolbar and address bar to the top of the expanded sidebar.",
          preview: "sidebarurl",
          tips: ["Goes back to the top while the sidebar is collapsed, and while customizing the toolbar."],
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
          pref: "compact-sidebar",
          default: false,
          label: "Compact sidebar",
          description: "Hide the tabs sidebar until you hover the edge of the window.",
          preview: "sidebar",
          tips: [
            "Replaces Firefox's “Expand sidebar on hover”; your choice comes back when this is off.",
            "Turning “Expand sidebar on hover” back on turns this off.",
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
  const ALL = [...SETTINGS, ...OPTIONS];

  // Renamed prefs: old name -> new name, and whether the meaning flipped.
  const MIGRATIONS = [
    { from: "native-urlbar", to: "floating-urlbar", invert: true },
    { from: "hide-folder-icons", to: "show-folder-icons", invert: true },
    { from: "hide-menu-icons", to: "show-menu-icons", invert: true },
    { from: "compact-mode", to: "compact-toolbar", invert: false },
  ];

  // Prefs that are no longer read (the Library is always on now).
  const RETIRED = ["library"];

  const isOn = s => s.core || Services.prefs.getBoolPref(PREF_BRANCH + s.pref, false);

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

  function readValue(o) {
    if (!o.type) {
      return isOn(o);
    }
    return o.type === "modifiers" ? getModifiers(o) : getInt(o);
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
    } else {
      if (!Number.isFinite(value)) {
        return false;
      }
      setInt(o, Math.min(o.max, Math.max(o.min, Math.round(value))));
    }
    return true;
  }

  const isDefault = o => readValue(o) === o.default;

  // A setting differs from its default, the feature or any of its options.
  const isModified = s => (!s.core && !isDefault(s)) || (s.options ?? []).some(o => !isDefault(o));

  function resetSetting(s) {
    for (const o of [...(s.core ? [] : [s]), ...(s.options ?? [])]) {
      writeValue(o, o.default);
    }
  }

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
      if (s.default && !Services.prefs.prefHasUserValue(PREF_BRANCH + s.pref)) {
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
      case "sidebar":
        mock.append(
          h("div", { class: "fz-mock-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h(
            "div",
            { class: "fz-mock-body" },
            h("div", { class: "fz-mock-side" }, h("span"), h("span"), h("span")),
            h("div", { class: "fz-mock-page" })
          )
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

  const OPTION_BUILDERS = { number: buildNumber, range: buildRange, modifiers: buildModifiers };

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
    return [s.label, s.description, ...(s.tips ?? []), ...options].filter(Boolean).join(" ").toLowerCase();
  }

  function buildSetting(s) {
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
          h("p", { class: "fz-setting-desc", text: s.description })
        ),
        control
      ),
      more
    );
    row.fzSearch = searchText(s);

    syncers.push(() => {
      const on = isOn(s);
      row.toggleAttribute("data-on", on);
      row.toggleAttribute("data-modified", isModified(s));
      if (!s.core) {
        control.checked = on;
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
      for (const o of ALL) {
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

  // ---- compact sidebar vs. Firefox's "Expand sidebar on hover" ----
  // Both reveal the sidebar on hover and fight at the window edge (the sidebar
  // flickers open/closed). Compact sidebar takes over while it's on: the user's
  // sidebar.visibility is saved and restored when compact sidebar is turned
  // off. Every step is idempotent, so running it in each window is harmless.
  const COMPACT_SIDEBAR_PREF = PREF_BRANCH + "compact-sidebar";
  const SAVED_VISIBILITY_PREF = PREF_BRANCH + "saved-sidebar-visibility";
  const VISIBILITY_PREF = "sidebar.visibility";
  const EXPAND_ON_HOVER = "expand-on-hover";

  function syncSidebarVisibility(changed) {
    const compact = Services.prefs.getBoolPref(COMPACT_SIDEBAR_PREF, false);
    const visibility = Services.prefs.getStringPref(VISIBILITY_PREF, "");

    // User turned expand-on-hover back on while compact: their newest choice wins.
    if (changed === VISIBILITY_PREF && compact && visibility === EXPAND_ON_HOVER) {
      Services.prefs.clearUserPref(SAVED_VISIBILITY_PREF);
      Services.prefs.clearUserPref(COMPACT_SIDEBAR_PREF);
      return;
    }

    if (compact && visibility === EXPAND_ON_HOVER) {
      Services.prefs.setStringPref(SAVED_VISIBILITY_PREF, visibility);
      Services.prefs.setStringPref(VISIBILITY_PREF, "always-show");
    } else if (!compact && Services.prefs.prefHasUserValue(SAVED_VISIBILITY_PREF)) {
      Services.prefs.setStringPref(VISIBILITY_PREF, Services.prefs.getStringPref(SAVED_VISIBILITY_PREF));
      Services.prefs.clearUserPref(SAVED_VISIBILITY_PREF);
    }
  }

  // ---- per-window setup ----
  applyDefaults();
  syncSidebarVisibility();

  const observer = {
    observe(_subject, _topic, name) {
      if (name === COMPACT_SIDEBAR_PREF || name === VISIBILITY_PREF) {
        syncSidebarVisibility(name);
      }
      sync();
    },
  };
  Services.prefs.addObserver(PREF_BRANCH, observer);
  Services.prefs.addObserver(VISIBILITY_PREF, observer);
  window.addEventListener(
    "unload",
    () => {
      Services.prefs.removeObserver(PREF_BRANCH, observer);
      Services.prefs.removeObserver(VISIBILITY_PREF, observer);
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
