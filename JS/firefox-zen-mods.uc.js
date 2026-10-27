// ==UserScript==
// @name           Firefox-Zen Mods
// @description    Mods tab of the Library, and each window's side of the mods: browser UI styles, scripts, option variables
// @include        main
// ==/UserScript==

// The registry (scanning chrome/mods, on/off state, page styles, install and
// remove) is the background module JS/firefox-zen-mods.sys.mjs. This window
// side loads what an active mod has for the browser window and builds the
// Library's Mods tab (JS/firefox-zen-library.uc.js calls
// window.FirefoxZenMods.buildView()).
//
// For each active mod, in each browser window:
// - its styles are loaded as author sheets of this window;
// - <html> gets the attribute fz-mod-<id>, and its options become CSS
//   variables --mod-<id>-<pref> (bool: 1/0, number: with its unit when that's
//   a CSS unit) and, for bool and select options, the attribute
//   fz-mod-<id>-<pref> (present / the value), so a CSS-only mod has options;
//   button options only call the script's mod.onButton handler;
// - its script runs with `mod` in scope (see buildApi). Everything registered
//   through `mod` is undone when the mod is turned off or reloaded.
// A script that throws turns its mod off and shows the error on its row.
//
// Updates (checked by the module): a mod with one gets a badge and "Review
// update…", which downloads it and shows every changed file as a diff, with
// Update / Cancel, before anything is replaced.

(function () {
  "use strict";

  const { FzMods } = ChromeUtils.importESModule("chrome://userscripts/content/firefox-zen-mods.sys.mjs");
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const AUTHOR = Ci.nsIDOMWindowUtils.AUTHOR_SHEET;
  const CSS_UNIT = /^(px|em|rem|%|vw|vh|ms|s|deg|ch|ex)$/;
  const root = document.documentElement;

  // ---- loading mods into this window ----

  /** @type {Map<string, {stamp: number, sheets: string[], vars: string[], attrs: string[], cleanups: Function[], buttons: Map<string, Function>}>} */
  const running = new Map();

  function runCleanups(mod, cleanups) {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        console.error(`Firefox-Zen mod ${mod.id}: cleanup failed`, e);
      }
    }
  }

  function buildApi(mod, entry) {
    const { cleanups } = entry;
    const option = (name, type) => {
      const o = mod.options.find(x => x.pref === name && (!type || x.type === type));
      if (!o) {
        throw new Error(`mod.json of ${mod.id} has no ${type ? `${type} ` : ""}option "${name}"`);
      }
      return o;
    };
    const api = {
      id: mod.id,
      name: mod.name,
      version: mod.version,
      dir: mod.dir,
      window,
      // file:// URL of a file in the mod's folder (icons, images).
      url: rel => PathUtils.toFileURI(PathUtils.join(mod.dir, ...rel.split(/[\\/]/))),
      pref: name => FzMods.getOption(mod, option(name)),
      setPref: (name, value) => FzMods.setOption(mod, option(name), value),
      // fn(prefName) when one of this mod's options changes.
      onPrefChange(fn) {
        const branch = FzMods.prefName(mod.id, "");
        const observer = { observe: (_s, _t, name) => fn(name.slice(branch.length)) };
        Services.prefs.addObserver(branch, observer);
        cleanups.push(() => Services.prefs.removeObserver(branch, observer));
      },
      // Adds CSS to this window until the mod is turned off; returns a remover.
      addStyle(css) {
        const uri = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
        window.windowUtils.loadSheetUsingURIString(uri, AUTHOR);
        let removed = false;
        const remove = () => {
          if (!removed) {
            removed = true;
            window.windowUtils.removeSheetUsingURIString(uri, AUTHOR);
          }
        };
        cleanups.push(remove);
        return remove;
      },
      listen(target, type, fn, options) {
        target.addEventListener(type, fn, options);
        cleanups.push(() => target.removeEventListener(type, fn, options));
      },
      onCleanup(fn) {
        cleanups.push(fn);
      },
      // fn() when the button option `name` is clicked in this window's Mods
      // tab; may be async, and a returned string shows as its status.
      onButton(name, fn) {
        option(name, "button");
        entry.buttons.set(name, fn);
        cleanups.push(() => entry.buttons.get(name) === fn && entry.buttons.delete(name));
      },
      log: (...args) => console.log(`[mod ${mod.id}]`, ...args),
    };
    return Object.freeze(api);
  }

  // The script runs in its own sandbox with the window as its prototype: its
  // top-level names stay out of the window, while window globals (gBrowser,
  // document…) still resolve. loadSubScript would refuse file:// URLs.
  async function runScript(mod, entry) {
    const source = await IOUtils.readUTF8(mod.script);
    if (running.get(mod.id) !== entry) {
      return; // turned off while reading
    }
    const sandbox = Cu.Sandbox(window, {
      sandboxPrototype: window,
      wantXrays: false,
      sandboxName: `Firefox-Zen mod ${mod.id}`,
    });
    sandbox.mod = buildApi(mod, entry);
    entry.cleanups.unshift(() => Cu.nukeSandbox(sandbox));
    Cu.evalInSandbox(source, sandbox, "latest", PathUtils.toFileURI(mod.script), 1);
  }

  function load(mod) {
    const entry = {
      stamp: mod.stamp,
      sheets: [],
      vars: [],
      attrs: [`fz-mod-${mod.id}`],
      cleanups: [],
      buttons: new Map(),
    };
    running.set(mod.id, entry);
    root.setAttribute(`fz-mod-${mod.id}`, "");
    for (const path of mod.styles) {
      const uri = FzMods.fileURL(mod, path);
      window.windowUtils.loadSheetUsingURIString(uri, AUTHOR);
      entry.sheets.push(uri);
    }
    applyOptions(mod, entry);
    return mod.script ? runScript(mod, entry) : null;
  }

  // A mod whose script throws is turned off, with the error on its row.
  function fail(mod, error) {
    console.error(`Firefox-Zen mod ${mod.id}:`, error);
    const entry = running.get(mod.id);
    if (entry) {
      unload(mod, entry);
    }
    FzMods.setEnabled(mod.id, false);
    FzMods.reportError(mod.id, error);
  }

  function unload(mod, entry) {
    running.delete(mod.id);
    runCleanups(mod, entry.cleanups);
    for (const uri of entry.sheets) {
      window.windowUtils.removeSheetUsingURIString(uri, AUTHOR);
    }
    for (const name of entry.vars) {
      root.style.removeProperty(name);
    }
    for (const name of entry.attrs) {
      root.removeAttribute(name);
    }
  }

  function applyOptions(mod, entry) {
    for (const o of mod.options) {
      if (o.type === "button") {
        continue;
      }
      const value = FzMods.getOption(mod, o);
      const name = `--mod-${mod.id}-${o.pref}`;
      const attr = `fz-mod-${mod.id}-${o.pref}`;
      let css = String(value);
      if (o.type === "bool") {
        css = value ? "1" : "0";
        root.toggleAttribute(attr, value);
      } else if (o.type === "number" && CSS_UNIT.test(o.unit)) {
        css = `${value}${o.unit}`;
      } else if (o.type === "select") {
        root.setAttribute(attr, value);
      }
      root.style.setProperty(name, css);
      if (!entry.vars.includes(name)) {
        entry.vars.push(name);
        if (o.type === "bool" || o.type === "select") {
          entry.attrs.push(attr);
        }
      }
    }
  }

  // Makes this window match the registry: unloads what's off, removed or
  // rescanned, loads what's newly on, and refreshes option values.
  function syncWindow() {
    for (const [id, entry] of running) {
      const mod = FzMods.get(id);
      if (!mod || !FzMods.isActive(id) || mod.stamp !== entry.stamp) {
        unload(mod ?? { id }, entry);
      }
    }
    for (const mod of FzMods.list()) {
      if (!FzMods.isActive(mod.id)) {
        continue;
      }
      const entry = running.get(mod.id);
      if (entry) {
        applyOptions(mod, entry);
        continue;
      }
      // fail() runs async, after this loop: it re-enters syncWindow through
      // the pref observer.
      let loading;
      try {
        loading = load(mod);
      } catch (e) {
        loading = Promise.reject(e);
      }
      Promise.resolve(loading).catch(e => fail(mod, e));
    }
  }

  // ---- Mods tab ----

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

  function pickFile(mode, title, { filter, defaultName } = {}) {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window.browsingContext, title, mode);
    if (filter) {
      fp.appendFilter(...filter);
      fp.appendFilters(Ci.nsIFilePicker.filterAll);
    }
    if (defaultName) {
      fp.defaultString = defaultName;
      fp.defaultExtension = "zip";
    }
    return new Promise(resolve =>
      fp.open(rv => resolve(rv === Ci.nsIFilePicker.returnCancel ? null : fp.file.path))
    );
  }

  // Two-button prompt; true for the first.
  function confirm(title, message, accept) {
    const p = Services.prompt;
    const flags =
      p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1 * p.BUTTON_TITLE_CANCEL + p.BUTTON_POS_1_DEFAULT;
    return p.confirmEx(window, title, message, flags, accept, null, null, null, {}) === 0;
  }

  function confirmScript(mod) {
    return confirm(
      `Turn on “${mod.name}”?`,
      `This mod runs its own code (${PathUtils.filename(mod.script)}) with full access to Firefox: ` +
        "your tabs, browsing data, saved passwords and files.\n\n" +
        `Only turn it on if you trust ${mod.author || "its author"}. You'll be asked again if the mod is reinstalled.`,
      "Turn on"
    );
  }

  function restartFirefox() {
    const cancel = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
    Services.obs.notifyObservers(cancel, "quit-application-requested", "restart");
    if (!cancel.data) {
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    }
  }

  // ---- options (Each returns { el, sync }; sync() re-reads the pref.) ----

  function buildOption(mod, o) {
    let control;
    let sync;
    switch (o.type) {
      case "bool":
        control = h("input", {
          type: "checkbox",
          role: "switch",
          class: "fz-switch",
          "aria-label": o.label,
          onchange: e => FzMods.setOption(mod, o, e.target.checked),
        });
        sync = () => (control.checked = FzMods.getOption(mod, o));
        break;
      case "number": {
        const input = h("input", {
          type: "number",
          class: "fz-number",
          min: o.min,
          max: o.max,
          step: 1,
          "aria-label": o.label,
          onkeydown: e => e.key === "Enter" && input.blur(),
        });
        // Empty or invalid snaps back.
        input.addEventListener("change", () => {
          if (input.value === "" || !FzMods.setOption(mod, o, Number(input.value))) {
            sync();
          }
        });
        control = h("span", { class: "fz-number-wrap" }, input, h("span", { class: "fz-option-unit", text: o.unit }));
        sync = () => (input.value = FzMods.getOption(mod, o));
        break;
      }
      case "select":
        control = h(
          "select",
          { class: "fz-select", "aria-label": o.label, onchange: e => FzMods.setOption(mod, o, e.target.value) },
          ...o.choices.map(c => h("option", { value: c.value, text: c.label }))
        );
        sync = () => (control.value = FzMods.getOption(mod, o));
        break;
      case "color":
        control = h("input", {
          type: "color",
          class: "fz-color",
          "aria-label": o.label,
          onchange: e => FzMods.setOption(mod, o, e.target.value),
        });
        sync = () => (control.value = FzMods.getOption(mod, o));
        break;
      case "button":
        control = h("button", {
          type: "button",
          class: "fz-reset",
          text: o.text,
          onclick: e => {
            // Inside the row's <label>: don't flip the switch too.
            e.preventDefault();
            run(() => pressButton(mod, o));
          },
        });
        sync = () => {};
        break;
    }
    const el = h(
      "div",
      { class: "fz-option" },
      h("span", { class: "fz-option-label", text: o.label }),
      control,
      o.hint && h("p", { class: "fz-option-hint", text: o.hint })
    );
    return { el, sync };
  }

  async function pressButton(mod, o) {
    const fn = running.get(mod.id)?.buttons.get(o.pref);
    if (!fn) {
      throw new Error(`${mod.name}'s script doesn't handle “${o.label}” (mod.onButton("${o.pref}", …))`);
    }
    if (o.confirm && !confirm(o.label, o.confirm, o.text)) {
      return null;
    }
    const result = await fn();
    return typeof result === "string" ? result : `${o.label}: done.`;
  }

  // ---- view ----

  let view = null;
  let list = null;
  let search = null;
  let setStatus = () => {};
  const syncers = [];

  function searchText(mod) {
    const options = mod.options.flatMap(o => [o.label, o.hint, ...(o.choices ?? []).map(c => c.label)]);
    return [mod.name, mod.id, mod.author, mod.description, ...options].filter(Boolean).join(" ").toLowerCase();
  }

  function buildPreview(mod) {
    if (mod.preview) {
      return h("img", { class: "fz-mock fz-mod-preview", src: mod.preview, alt: "" });
    }
    return h("div", { class: "fz-mock fz-mod-preview fz-mod-initial", "aria-hidden": "true", text: mod.name[0] ?? "?" });
  }

  // `action` returns a status message, or null when cancelled.
  async function run(action) {
    try {
      const message = await action();
      if (message) {
        setStatus(message);
      }
    } catch (e) {
      setStatus(`Couldn't do that: ${e.message}`, { error: true });
    }
  }

  async function exportMod(mod) {
    const path = await pickFile(Ci.nsIFilePicker.modeSave, `Export ${mod.name}`, {
      filter: ["Zip archive", "*.zip"],
      defaultName: `${mod.id}.zip`,
    });
    if (!path) {
      return null;
    }
    await FzMods.exportMod(mod.id, path);
    return `Exported ${mod.name}.`;
  }

  async function removeMod(mod) {
    if (
      !confirm(
        `Remove “${mod.name}”?`,
        `This deletes the folder chrome/mods/${mod.id} and the mod's settings. It can't be undone.`,
        "Remove"
      )
    ) {
      return null;
    }
    await FzMods.remove(mod.id);
    return `Removed ${mod.name}.`;
  }

  async function install(dir) {
    const path = dir
      ? await pickFile(Ci.nsIFilePicker.modeGetFolder, "Install Mod from Folder")
      : await pickFile(Ci.nsIFilePicker.modeOpen, "Install Mod from Zip", { filter: ["Zip archive", "*.zip"] });
    if (!path) {
      return null;
    }
    const pending = await FzMods.prepareInstall(path);
    if (
      pending.replaces &&
      !confirm(`Replace “${pending.replaces}”?`, `A mod named ${pending.id} is already installed.`, "Replace")
    ) {
      await pending.cancel();
      return null;
    }
    await pending.commit();
    return pending.script
      ? `Installed ${pending.name}. It runs its own code, so it starts off: turn it on below.`
      : `Installed ${pending.name}.`;
  }

  function buildMod(mod) {
    const action = (text, fn) =>
      h("button", {
        type: "button",
        class: "fz-option-reset",
        text,
        onclick: e => {
          // Inside the row's <label>: don't flip the switch too.
          e.preventDefault();
          run(fn);
        },
      });

    const control = mod.broken
      ? h("span", { class: "fz-badge fz-mod-broken", text: "Broken" })
      : h("input", {
          type: "checkbox",
          role: "switch",
          class: "fz-switch",
          "aria-label": mod.name,
          onchange: e => {
            const on = e.target.checked;
            if (on && mod.script && !FzMods.isTrusted(mod.id)) {
              if (!confirmScript(mod)) {
                e.target.checked = false;
                return;
              }
              FzMods.setTrusted(mod.id, true);
            }
            FzMods.setEnabled(mod.id, on);
          },
        });

    const kinds = [
      mod.styles.length && "CSS",
      mod.contentStyles.length && "Page CSS",
      mod.script && "Script",
    ].filter(Boolean);

    const options = mod.options.map(o => buildOption(mod, o));
    const errors = h("ul", { class: "fz-mod-errors" });
    const reset = h("button", {
      type: "button",
      class: "fz-row-reset",
      text: "Reset",
      title: `Reset ${mod.name}'s options`,
      onclick: e => {
        e.preventDefault();
        FzMods.resetOptions(mod);
      },
    });

    const more = options.length
      ? h(
          "div",
          { class: "fz-setting-more" },
          h("div", { class: "fz-setting-more-inner" }, h("div", { class: "fz-options" }, ...options.map(b => b.el)))
        )
      : null;

    const row = h(
      "div",
      { class: "fz-setting fz-mod", "data-mod": mod.id },
      h(
        mod.broken ? "div" : "label",
        { class: "fz-setting-main" },
        buildPreview(mod),
        h(
          "div",
          { class: "fz-setting-body" },
          h(
            "span",
            { class: "fz-setting-head" },
            h("span", { class: "fz-setting-title", text: mod.name }),
            mod.version && h("span", { class: "fz-hint", text: mod.version }),
            mod.update && h("span", { class: "fz-badge fz-mod-update", text: `Update: ${mod.update.version}` }),
            ...kinds.map(k => h("span", { class: "fz-badge fz-mod-kind", text: k })),
            h("span", { class: "fz-modified", title: "Options changed from the defaults", "aria-label": "Changed" }),
            reset
          ),
          mod.description && h("p", { class: "fz-setting-desc", text: mod.description }),
          errors,
          h(
            "span",
            { class: "fz-mod-actions" },
            h("span", { class: "fz-hint", text: mod.author ? `by ${mod.author}` : mod.id }),
            mod.update && action("Review update…", () => reviewUpdate(mod)),
            mod.homepage && action("Homepage", () => openWebLinkIn(mod.homepage, "tab") ?? null),
            action("Folder", () => FzMods.openFolder(mod.dir) ?? null),
            !mod.broken && action("Export…", () => exportMod(mod)),
            action("Remove…", () => removeMod(mod))
          )
        ),
        control
      ),
      more
    );
    row.fzSearch = searchText(mod);

    syncers.push(() => {
      const on = !mod.broken && FzMods.isEnabled(mod.id) && (!mod.script || FzMods.isTrusted(mod.id));
      const problems = [...(mod.errors ?? []), mod.runtimeError, mod.updateError].filter(Boolean);
      row.toggleAttribute("data-on", on);
      row.toggleAttribute("data-modified", !mod.broken && FzMods.isOptionsModified(mod));
      row.toggleAttribute("data-error", problems.length > 0);
      errors.replaceChildren(...problems.map(p => h("li", { text: p })));
      if (!mod.broken) {
        control.checked = on;
      }
      // Collapsed options stay out of the tab order.
      more?.toggleAttribute("inert", !on);
      if (on) {
        options.forEach(b => b.sync());
      }
    });
    return row;
  }

  // Every word must appear somewhere in the row.
  function applySearch() {
    if (!view) {
      return;
    }
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let any = false;
    for (const row of list.querySelectorAll(".fz-mod")) {
      row.hidden = !words.every(w => row.fzSearch.includes(w));
      any ||= !row.hidden;
    }
    const empty = !FzMods.list().length;
    view.querySelector(".fz-mods-empty").hidden = !empty;
    view.querySelector(".fz-no-results").hidden = empty || any;
  }

  function renderList() {
    if (!view?.isConnected) {
      return;
    }
    syncers.length = 0;
    list.replaceChildren(...FzMods.list().map(buildMod));
    applySearch();
    sync();
  }

  function sync() {
    if (view?.isConnected) {
      syncers.forEach(fn => fn());
    }
  }

  function buildView() {
    // ---- footer status ----
    const status = h("span", { class: "fz-hint fz-status", role: "status", "data-empty": true });
    setStatus = (message, { error = false } = {}) => {
      status.textContent = message;
      status.toggleAttribute("data-error", error);
      status.toggleAttribute("data-empty", !message);
    };

    search = h("input", {
      type: "search",
      class: "fz-lib-search fz-settings-search",
      placeholder: "Search mods",
      "aria-label": "Search mods",
      oninput: applySearch,
      onkeydown: e => {
        // Esc clears the search first, then closes the Library.
        if (e.key === "Escape" && search.value) {
          e.stopPropagation();
          search.value = "";
          applySearch();
        }
      },
    });

    const button = (text, fn) => h("button", { type: "button", class: "fz-reset", text, onclick: () => run(fn) });

    list = h("div", { class: "fz-list" });
    view = h(
      "div",
      { class: "fz-settings-view fz-mods-view" },
      h(
        "header",
        { class: "fz-header" },
        h("h2", { text: "Mods" }),
        h("span", { class: "fz-subtitle", text: "Your own looks and features, on top of the theme" }),
        search
      ),
      FzMods.safeMode &&
        h(
          "div",
          { class: "fz-banner", role: "status" },
          h(
            "span",
            { class: "fz-banner-text" },
            h("strong", { text: "Safe mode: no mods are loaded." }),
            " firefox-zen.mods.safe-mode was on for this start. Restart to load them again."
          ),
          h("button", { type: "button", class: "fz-reset", text: "Restart now", onclick: restartFirefox })
        ),
      h(
        "div",
        { class: "fz-mods-toolbar" },
        button("Install from folder…", () => install(true)),
        button("Install from zip…", () => install(false)),
        button("Open mods folder", () => FzMods.openFolder() ?? null),
        button("Reload", async () => {
          await FzMods.rescan();
          return `Reloaded ${FzMods.list().length} mods.`;
        }),
        button("Check for updates", async () => {
          const count = await FzMods.checkUpdates();
          return count ? `${count} update${count === 1 ? "" : "s"} available.` : "Every mod is up to date.";
        })
      ),
      h(
        "section",
        { class: "fz-category", "aria-labelledby": "fz-mods-installed" },
        h("h3", { class: "fz-category-title", id: "fz-mods-installed", text: "Installed" }),
        list,
        h(
          "p",
          { class: "fz-mods-empty fz-hint", hidden: true },
          "No mods yet. Install one, or put a folder with a mod.json into chrome/mods and press Reload. ",
          "See the README's Mods section, or chrome/mods/example, to make your own."
        ),
        h("p", { class: "fz-no-results fz-hint", text: "No mods match.", hidden: true })
      ),
      h(
        "footer",
        { class: "fz-footer" },
        h(
          "div",
          { class: "fz-footer-text" },
          h("span", { class: "fz-hint", text: "Mods live in chrome/mods. Changes apply instantly." }),
          status
        )
      )
    );
    // Built detached; fill once the Library has put it in place.
    Promise.resolve().then(renderList);
    FzMods.ready.then(renderList);
    return view;
  }

  // ---- update review ----
  // Like a userscript manager's update page: what the new version changes,
  // file by file, before anything is replaced. It takes the Mods tab's place
  // until Update or Cancel.

  const CONTEXT = 3;
  // Line diffs past this many line pairs just say the file changed.
  const MAX_DIFF_CELLS = 4e6;

  // [{ t: " " | "-" | "+", text, a, b }] (a/b: 1-based line numbers in the
  // old/new text), or null when the files are too big to compare.
  function diffLines(before, after) {
    // The newline that ends a file doesn't start another line.
    const lines = text => (text === null ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/));
    const A = lines(before);
    const B = lines(after);
    let start = 0;
    while (start < A.length && start < B.length && A[start] === B[start]) {
      start++;
    }
    let endA = A.length;
    let endB = B.length;
    while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
      endA--;
      endB--;
    }
    const n = endA - start;
    const m = endB - start;
    if (n * m > MAX_DIFF_CELLS) {
      return null;
    }
    // Longest common subsequence lengths from (i, j) to the end.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          A[start + i] === B[start + j]
            ? lcs[(i + 1) * w + j + 1] + 1
            : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    const ops = [];
    let a = 0;
    let b = 0;
    const push = (t, text) => ops.push({ t, text, a: t === "+" ? null : ++a, b: t === "-" ? null : ++b });
    for (let k = 0; k < start; k++) {
      push(" ", A[k]);
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[start + i] === B[start + j]) {
        push(" ", A[start + i]);
        i++;
        j++;
      } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        push("-", A[start + i++]);
      } else {
        push("+", B[start + j++]);
      }
    }
    for (let k = endA; k < A.length; k++) {
      push(" ", A[k]);
    }
    return ops;
  }

  // Groups changed lines with CONTEXT lines around them, like `diff -u`.
  function hunks(ops) {
    const out = [];
    let current = null;
    let lastChange = -Infinity;
    ops.forEach((op, i) => {
      if (op.t === " ") {
        return;
      }
      if (!current || i - lastChange > CONTEXT * 2) {
        current = { from: Math.max(0, i - CONTEXT), to: i };
        out.push(current);
      }
      current.to = i;
      lastChange = i;
    });
    return out.map(({ from, to }) => ops.slice(from, Math.min(ops.length, to + CONTEXT + 1)));
  }

  function hunkHeader(lines) {
    const a = lines.filter(l => l.t !== "+");
    const b = lines.filter(l => l.t !== "-");
    const range = (list, key) => `${list[0]?.[key] ?? 0},${list.length}`;
    return `@@ -${range(a, "a")} +${range(b, "b")} @@`;
  }

  function buildFileDiff(file) {
    const labels = { added: "Added", removed: "Removed", changed: "Changed" };
    const binary = (file.status !== "added" && file.before === null) || (file.status !== "removed" && file.after === null);
    const ops = binary ? null : diffLines(file.status === "added" ? null : file.before, file.after);
    const added = ops?.filter(o => o.t === "+").length ?? 0;
    const removed = ops?.filter(o => o.t === "-").length ?? 0;
    let body;
    if (binary) {
      body = h("p", { class: "fz-hint fz-diff-note", text: "Binary file: not shown." });
    } else if (!ops) {
      body = h("p", { class: "fz-hint fz-diff-note", text: "Too large to compare line by line." });
    } else {
      body = h(
        "pre",
        { class: "fz-diff" },
        ...hunks(ops).flatMap(lines => [
          h("span", { class: "fz-diff-hunk", text: hunkHeader(lines) }),
          ...lines.map(l =>
            h("span", { class: `fz-diff-line`, "data-t": l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx", text: `${l.t}${l.text}` })
          ),
        ])
      );
    }
    return h(
      "section",
      { class: "fz-diff-file", "data-status": file.status },
      h(
        "header",
        { class: "fz-diff-head" },
        h("span", { class: "fz-diff-path", text: file.path }),
        h("span", { class: "fz-badge fz-diff-status", text: labels[file.status] }),
        ops && h("span", { class: "fz-diff-stat", "data-t": "add", text: `+${added}` }),
        ops && h("span", { class: "fz-diff-stat", "data-t": "del", text: `−${removed}` })
      ),
      body
    );
  }

  async function reviewUpdate(mod) {
    const listView = view;
    const page = h(
      "div",
      { class: "fz-settings-view fz-mods-view fz-update-view" },
      h(
        "header",
        { class: "fz-header" },
        h("h2", { text: `Update ${mod.name}` }),
        h("span", { class: "fz-subtitle", text: `Downloading ${mod.update.version}…` })
      )
    );
    listView.replaceWith(page);
    const back = message => {
      page.replaceWith(listView);
      renderList();
      if (message) {
        setStatus(message.text, { error: message.error });
      }
    };

    let pending;
    try {
      pending = await FzMods.prepareUpdate(mod.id);
    } catch (e) {
      back({ text: `Couldn't download the update: ${e.message}`, error: true });
      return null;
    }
    if (!page.isConnected) {
      // The Library closed meanwhile.
      await pending.cancel();
      return null;
    }

    const codeChanged = pending.files.some(f => /\.(m?js)$/i.test(f.path));
    const summary = pending.files.length
      ? `${pending.files.length} file${pending.files.length === 1 ? "" : "s"} changed.`
      : "No files changed (only the version number is new).";
    const done = async update => {
      if (!update) {
        await pending.cancel();
        back(null);
        return;
      }
      try {
        await pending.commit();
        back({ text: `Updated ${pending.name} to ${pending.to}.` });
      } catch (e) {
        back({ text: `Couldn't update: ${e.message}`, error: true });
      }
    };

    page.replaceChildren(
      h(
        "header",
        { class: "fz-header" },
        h("h2", { text: `Update ${pending.name}` }),
        h("span", { class: "fz-subtitle", text: `${pending.from || "?"} → ${pending.to}` })
      ),
      h(
        "dl",
        { class: "fz-update-facts" },
        h("dt", { text: "Installed version" }),
        h("dd", { text: pending.from || "—" }),
        h("dt", { text: "New version" }),
        h("dd", { text: pending.to }),
        h("dt", { text: "From" }),
        h("dd", { text: mod.update.downloadURL }),
        h("dt", { text: "Changes" }),
        h("dd", { text: summary })
      ),
      pending.modified &&
        h(
          "div",
          { class: "fz-banner fz-banner-warning", role: "alert" },
          h(
            "span",
            { class: "fz-banner-text" },
            h("strong", { text: "This mod was changed locally." }),
            " Updating replaces its folder, so your edits will be lost. Export it first to keep a copy."
          )
        ),
      codeChanged &&
        h(
          "div",
          { class: "fz-banner fz-banner-warning", role: "alert" },
          h(
            "span",
            { class: "fz-banner-text" },
            h("strong", { text: "This update changes the mod's script." }),
            " Scripts run with full access to Firefox. Check the changes below; if the mod is on, the new code runs right after updating."
          )
        ),
      h(
        "div",
        { class: "fz-mods-toolbar fz-update-actions" },
        h("button", { type: "button", class: "fz-reset fz-primary", text: "Update", onclick: () => done(true) }),
        h("button", { type: "button", class: "fz-reset", text: "Cancel", onclick: () => done(false) })
      ),
      h(
        "section",
        { class: "fz-category", "aria-labelledby": "fz-update-changes" },
        h("h3", { class: "fz-category-title", id: "fz-update-changes", text: "Changes" }),
        ...pending.files.map(buildFileDiff)
      )
    );
    return null;
  }

  window.FirefoxZenMods = { buildView };

  // ---- per-window setup ----

  const prefObserver = {
    observe() {
      syncWindow();
      sync();
    },
  };
  // A dot on the Library's Mods button while an update is waiting.
  const syncUpdateDot = () => root.toggleAttribute("fz-mods-updates", FzMods.list().some(m => m.update));
  const changedObserver = {
    observe() {
      syncWindow();
      syncUpdateDot();
      renderList();
    },
  };
  Services.prefs.addObserver(FzMods.PREF_BRANCH, prefObserver);
  Services.obs.addObserver(changedObserver, FzMods.CHANGED_TOPIC);
  window.addEventListener(
    "unload",
    () => {
      Services.prefs.removeObserver(FzMods.PREF_BRANCH, prefObserver);
      Services.obs.removeObserver(changedObserver, FzMods.CHANGED_TOPIC);
      for (const [id, entry] of running) {
        runCleanups({ id }, entry.cleanups);
      }
    },
    { once: true }
  );
  FzMods.ready.then(() => {
    syncWindow();
    syncUpdateDot();
  });
})();
