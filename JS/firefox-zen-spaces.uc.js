// ==UserScript==
// @name           Firefox-Zen Spaces
// @description    Zen-style Spaces: each unpinned tab belongs to a space; switching hides the other spaces' tabs
// @include        main
// ==/UserScript==

// Model
// - Space list (global, all windows): JSON in pref firefox-zen.spaces.list
//   [{ id, name, icon, container }]. Prefs always persist, even without
//   session restore. container = userContextId new tabs in the space open in
//   (0/missing = no container).
// - Tab's space: SessionStore custom tab value (survives restarts/restore).
// - Window's active space: SessionStore custom window value.
// - Pinned tabs are global "Pins": never assigned, never hidden
//   (gBrowser.hideTab refuses pinned tabs anyway).
// Switching shows the target space's tabs and hides the rest with
// gBrowser.showTab/hideTab, so the tab strip, Ctrl+Tab etc. follow natively.
// - Private spaces (private: true) live in their own private window, locked
//   behind a password and saved encrypted (JS/firefox-zen-private-spaces.sys.mjs).
//   That window has just its private space; other windows have the normal
//   spaces and show private ones in the footer (blurred while locked), where
//   clicking one asks for its password and opens its window.

(function () {
  "use strict";

  const ENABLED_PREF = "firefox-zen.spaces";
  const LIST_PREF = "firefox-zen.spaces.list";
  const TAB_KEY = "firefox-zen-space";
  const WINDOW_KEY = "firefox-zen-active-space";
  const HIDE_SOURCE = "firefox-zen-spaces";
  const BAR_ID = "fz-spaces-bar";
  const HEADER_ID = "fz-space-header";
  const MENU_ID = "fz-spaces-menu";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const DEFAULT_ICONS = ["🏠", "💼", "🎮", "📚", "🎵", "🛒", "✈️", "🧪", "🎨"];
  const PRIVATE_ICON = "🕶️";
  const PRIVATE_MODULE = "chrome://userscripts/content/firefox-zen-private-spaces.sys.mjs";
  const FLUSHER_MODULE = "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs";
  // A private space's window changed its tabs; other windows get FzPrivateTabsChanged.
  const PRIVATE_TABS_TOPIC = "firefox-zen-private-tabs-changed";

  let activeId = null;
  // The private space this window belongs to (null for every other window).
  let ownPrivateId = null;
  // Last selected tab per space in this window, to restore on switch.
  const lastSelected = new Map();
  let applying = false;
  // Set while replacing a space's last closed tab, so the tab Firefox selects
  // in the meantime doesn't drag us into another space.
  let holdSpace = false;

  // Footer carousel: visible() spaces at a time (VISIBLE_PREF, 2-8); hovering
  // the first/last visible slot scrolls one slot that way.
  const VISIBLE_PREF = "firefox-zen.spaces.visible";
  const VISIBLE_DEFAULT = 4;
  const visible = () => Math.min(8, Math.max(2, Services.prefs.getIntPref(VISIBLE_PREF, VISIBLE_DEFAULT)));
  const SCROLL_FIRST_DELAY = 250;
  const SCROLL_REPEAT_DELAY = 350;
  let viewStart = 0;
  let lastRenderedActive = null;
  let scrollTimer = null;

  const enabled = () => Services.prefs.getBoolPref(ENABLED_PREF, false);
  // The Library is always on; History is the fallback without its script.
  const libraryOn = () => !!window.FirefoxZenLibrary;

  // ---- space list ----

  // The list as stored. A private space is just { id, private: true } (older
  // ones may still carry their name/icon until next unlocked).
  function readRawSpaces() {
    try {
      const list = JSON.parse(Services.prefs.getStringPref(LIST_PREF, "[]"));
      if (Array.isArray(list) && list.length) {
        return list.filter(s => s && typeof s.id === "string");
      }
    } catch (e) {
      console.error("firefox-zen-spaces: bad space list, resetting", e);
    }
    return [];
  }

  // Private spaces get their name and icon from their encrypted data while
  // unlocked, and a placeholder ("Private 2") while locked.
  function readSpaces() {
    let n = 0;
    return readRawSpaces().map(space => {
      if (!space.private) {
        return space;
      }
      n++;
      const meta = privateSpaces()?.meta(space.id);
      return {
        id: space.id,
        private: true,
        name: meta?.name || `Private ${n}`,
        icon: meta?.icon || PRIVATE_ICON,
        locked: !isUnlocked(space.id),
      };
    });
  }

  // Never writes a private space's name or icon (an older entry keeps what
  // it had until its data takes it over on unlock).
  function writeSpaces(list) {
    const raw = new Map(readRawSpaces().map(s => [s.id, s]));
    const stored = list.map(space => {
      if (!space.private) {
        return space;
      }
      const old = raw.get(space.id);
      return privateSpaces()?.meta(space.id) || !old?.name
        ? { id: space.id, private: true }
        : { id: space.id, private: true, name: old.name, icon: old.icon };
    });
    Services.prefs.setStringPref(LIST_PREF, JSON.stringify(stored));
  }

  // There's always at least one normal space.
  function ensureSpaces() {
    let list = readSpaces();
    if (!list.some(s => !s.private)) {
      list = [{ id: crypto.randomUUID(), name: "Home", icon: DEFAULT_ICONS[0] }, ...list];
      writeSpaces(list);
    }
    return list;
  }

  // Spaces whose tabs live in this window: a private space's window has just
  // that space, every other window has the normal spaces.
  function localSpaces() {
    const list = readSpaces();
    return ownPrivateId ? list.filter(s => s.id === ownPrivateId) : list.filter(s => !s.private);
  }

  const isLocal = id => localSpaces().some(s => s.id === id);

  // ---- containers ----

  // The space's container, if it still exists (it may have been deleted in
  // Settings since it was chosen).
  function containerOf(space) {
    const id = Number(space?.container) || 0;
    return id && ContextualIdentityService.getPublicIdentityFromId(id) ? id : 0;
  }

  function setSpaceContainer(id, userContextId) {
    const list = readSpaces();
    const space = list.find(s => s.id === id);
    if (space) {
      space.container = userContextId || 0;
      writeSpaces(list);
    }
  }

  // New-tab-page tabs (Ctrl+T, the + button, a space's first tab) open in the
  // active space's container. Firefox's openTab() calls the global
  // openTrustedLinkIn(url, where, params), so add userContextId there. Only
  // the new tab page is touched, plus tabs opened from the address bar while it
  // stands in for one (urlbar-newtab); links, bookmarks etc. keep Firefox's rules.
  function hookNewTabContainer() {
    const original = window.openTrustedLinkIn;
    if (typeof original !== "function" || original.__fzSpaces) {
      return;
    }
    const hooked = function (url, where, params = {}) {
      if (
        enabled() &&
        (url === window.BROWSER_NEW_TAB_URL || window.gURLBar?.hasAttribute("fz-newtab")) &&
        (where === "tab" || where === "tabshifted") &&
        params.userContextId == null
      ) {
        const container = containerOf(readSpaces().find(s => s.id === activeId));
        if (container) {
          params = { ...params, userContextId: container };
        }
      }
      return original.call(this, url, where, params);
    };
    hooked.__fzSpaces = true;
    window.openTrustedLinkIn = hooked;
  }

  // ---- tab / window values ----

  function rawSpaceOf(tab) {
    return SessionStore.getCustomTabValue(tab, TAB_KEY);
  }

  // Untagged tabs (just opened, not yet assigned) count as the active space.
  function spaceOf(tab) {
    return rawSpaceOf(tab) || activeId;
  }

  function setSpaceOf(tab, id) {
    if (!tab.pinned && rawSpaceOf(tab) !== id) {
      SessionStore.setCustomTabValue(tab, TAB_KEY, id);
    }
  }

  function saveActive() {
    try {
      SessionStore.setCustomWindowValue(window, WINDOW_KEY, activeId);
    } catch (e) {
      // Window not tracked by SessionStore yet; saved on the next switch.
    }
  }

  function readActive() {
    try {
      return SessionStore.getCustomWindowValue(window, WINDOW_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  const unpinnedTabs = () => gBrowser.tabs.filter(t => !t.pinned && !t.closing);
  const tabsIn = id => unpinnedTabs().filter(t => spaceOf(t) === id);

  // ---- applying visibility ----

  function apply() {
    if (!enabled() || applying) {
      return;
    }
    applying = true;
    try {
      const ids = new Set(localSpaces().map(s => s.id));
      for (const tab of unpinnedTabs()) {
        const id = rawSpaceOf(tab);
        // Tag stray tabs (deleted space, never tagged) into the active space.
        if (!id || !ids.has(id)) {
          setSpaceOf(tab, activeId);
        }
      }
      // Show first, so hideTab never leaves the strip empty mid-switch.
      for (const tab of unpinnedTabs()) {
        if (spaceOf(tab) === activeId) {
          gBrowser.showTab(tab);
        }
      }
      for (const tab of unpinnedTabs()) {
        if (spaceOf(tab) !== activeId && !tab.selected) {
          gBrowser.hideTab(tab, HIDE_SOURCE);
        }
      }
    } finally {
      applying = false;
    }
    renderBar();
  }

  function showAll() {
    for (const tab of gBrowser.tabs) {
      if (tab.hidden) {
        gBrowser.showTab(tab);
      }
    }
  }

  // ---- switching ----

  // Passing the URL always makes a real tab (an empty space needs one).
  // userInitiated leaves it to openTab(), which may open the address bar
  // instead (urlbar-newtab); then no tab is created and nothing gets tagged.
  function openTabInActiveSpace({ userInitiated = false } = {}) {
    const before = gBrowser.selectedTab;
    if (window.BrowserCommands?.openTab) {
      window.BrowserCommands.openTab(userInitiated ? {} : { url: window.BROWSER_NEW_TAB_URL });
    } else {
      gBrowser.selectedTab = gBrowser.addTrustedTab(window.BROWSER_NEW_TAB_URL || "about:newtab");
    }
    if (gBrowser.selectedTab !== before) {
      setSpaceOf(gBrowser.selectedTab, activeId);
    }
  }

  function switchTo(id, { keepSelection = false } = {}) {
    const space = readSpaces().find(s => s.id === id);
    if (!enabled() || !space) {
      return;
    }
    // A space that lives in another window: a private space opens (or
    // focuses) its own window; from a private space's window, a normal space
    // shows in a normal window.
    if (!isLocal(id)) {
      if (space.private) {
        openPrivateSpace(id);
      } else {
        showInNormalWindow(id);
      }
      return;
    }
    const current = gBrowser.selectedTab;
    if (activeId && !current.pinned && spaceOf(current) === activeId) {
      lastSelected.set(activeId, current);
    }
    activeId = id;
    saveActive();

    if (!keepSelection) {
      const remembered = lastSelected.get(id);
      const candidates = tabsIn(id);
      const target =
        remembered && candidates.includes(remembered) ? remembered : candidates.at(-1);
      if (target) {
        gBrowser.showTab(target);
        gBrowser.selectedTab = target;
      } else if (!current.pinned) {
        // Empty space and no Essential selected: start it with a new tab.
        openTabInActiveSpace();
      }
    }
    apply();
  }

  // ---- space management ----

  function createSpace({ switchToIt = true } = {}) {
    const list = readSpaces();
    const icon = DEFAULT_ICONS[list.length % DEFAULT_ICONS.length];
    const space = { id: crypto.randomUUID(), name: `Space ${list.length + 1}`, icon };
    writeSpaces([...list, space]);
    if (switchToIt) {
      switchTo(space.id);
    }
    return space.id;
  }

  function promptText(title, label, initial) {
    const value = { value: initial };
    return Services.prompt.prompt(window, title, label, value, null, {}) ? value.value.trim() : null;
  }

  // A private space's name/icon live in its encrypted data (asks for its
  // password if it's locked).
  async function setPrivateMeta(id, meta) {
    if (!(await unlockPrivateSpace(id))) {
      return;
    }
    await privateSpaces().setMeta(id, meta);
    writeSpaces(readSpaces());
  }

  function setSpaceName(id, name) {
    if (readSpaces().find(s => s.id === id)?.private) {
      if (name) {
        setPrivateMeta(id, { name }).catch(e => console.error("firefox-zen-spaces:", e));
      }
      return;
    }
    const list = readSpaces();
    const space = list.find(s => s.id === id);
    if (space && name && name !== space.name) {
      space.name = name;
      writeSpaces(list);
    }
  }

  // Double-click the name above the icons to edit it in place.
  // Enter / blur saves, Escape cancels.
  function startInlineRename(id, label) {
    const space = readSpaces().find(s => s.id === id);
    if (!space) {
      return;
    }
    const input = h("input", {
      class: "fz-space-name-input",
      type: "text",
      value: space.name,
      "aria-label": "Space name",
    });
    let done = false;
    const finish = save => {
      if (done) {
        return;
      }
      done = true;
      if (save) {
        setSpaceName(id, input.value.trim());
      }
      // Restore the label (a save re-renders the bar anyway).
      if (input.isConnected) {
        input.replaceWith(label);
      }
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
      // Keep typing out of Firefox's keyboard shortcuts.
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  function renameSpace(id) {
    const list = readSpaces();
    const space = list.find(s => s.id === id);
    if (space?.locked) {
      // Its real name is unknown until it's unlocked.
      unlockPrivateSpace(id).then(ok => ok && renameSpace(id));
      return;
    }
    const name = space && promptText("Rename Space", "Space name:", space.name);
    if (name && space.private) {
      setSpaceName(id, name);
    } else if (name) {
      space.name = name;
      writeSpaces(list);
    }
  }

  function setSpaceIcon(id, icon) {
    if (icon && readSpaces().find(s => s.id === id)?.private) {
      setPrivateMeta(id, { icon: [...icon].slice(0, 2).join("") }).catch(e => console.error("firefox-zen-spaces:", e));
      return;
    }
    const list = readSpaces();
    const space = list.find(s => s.id === id);
    if (space && icon) {
      space.icon = [...icon].slice(0, 2).join("");
      writeSpaces(list);
    }
  }

  function changeIcon(id) {
    const space = readSpaces().find(s => s.id === id);
    if (space?.locked) {
      unlockPrivateSpace(id).then(ok => ok && changeIcon(id));
      return;
    }
    const icon = space && promptText("Change Space Icon", "Icon (emoji or a short text):", space.icon);
    if (icon) {
      setSpaceIcon(id, icon);
    }
  }

  // New order of the space list, by id. Ids missing from `ids` keep their
  // relative order at the end.
  // New order for the spaces in `ids`. Spaces not in it (hidden private
  // ones, say) keep their places; the listed ones fill the other places in
  // the new order.
  function reorderSpaces(ids) {
    const list = readSpaces();
    const byId = new Map(list.map(s => [s.id, s]));
    const queue = ids.filter(id => byId.has(id));
    const moving = new Set(queue);
    const sorted = list.map(s => (moving.has(s.id) ? byId.get(queue.shift()) : s));
    if (sorted.some((s, i) => s !== list[i])) {
      writeSpaces(sorted);
    }
  }

  // Loaded tabs of a space in every window, except each window's selected tab
  // (unloading that would make Firefox select another tab, possibly from
  // another space).
  function unloadableTabs(id) {
    const result = [];
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      const tabs = win.gBrowser.tabs.filter(
        t =>
          !t.pinned &&
          !t.selected &&
          !t.closing &&
          t.linkedPanel &&
          SessionStore.getCustomTabValue(t, TAB_KEY) === id
      );
      if (tabs.length) {
        result.push([win, tabs]);
      }
    }
    return result;
  }

  function unloadSpace(id) {
    for (const [win, tabs] of unloadableTabs(id)) {
      // Same path as Firefox's "Unload Tab": asks pages with unsaved changes first.
      win.gBrowser.explicitUnloadTabs(tabs).catch(e => console.error("firefox-zen-spaces:", e));
    }
  }

  function deleteSpace(id) {
    const space = readSpaces().find(s => s.id === id);
    if (space?.private) {
      deletePrivateSpace(space);
      return;
    }
    // Its tabs go to a neighboring normal space.
    const list = readSpaces().filter(s => !s.private);
    if (list.length < 2) {
      return;
    }
    const index = list.findIndex(s => s.id === id);
    const target = list[index === 0 ? 1 : index - 1];
    const ok = Services.prompt.confirm(
      window,
      "Delete Space",
      `Delete “${space.name}”? Its tabs move to “${target.name}”; no tabs are closed.`
    );
    if (!ok) {
      return;
    }
    // Retag this space's tabs in every window before the list changes.
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of win.gBrowser.tabs) {
        if (SessionStore.getCustomTabValue(tab, TAB_KEY) === id) {
          SessionStore.setCustomTabValue(tab, TAB_KEY, target.id);
        }
      }
    }
    writeSpaces(readSpaces().filter(s => s.id !== id));
  }

  // ---- private spaces ----

  function privateSpaces() {
    try {
      return ChromeUtils.importESModule(PRIVATE_MODULE).FzPrivateSpaces;
    } catch (e) {
      console.error("firefox-zen-spaces: private spaces unavailable", e);
      return null;
    }
  }

  const isUnlocked = id => !!privateSpaces()?.isUnlocked(id);

  // Private spaces are hidden until shown (every start); a private space's
  // own window always shows itself.
  const privateShown = () => !!privateSpaces()?.isShown();
  const visibleSpaces = () => readSpaces().filter(s => !s.private || s.id === ownPrivateId || privateShown());

  function togglePrivateShown() {
    privateSpaces()
      ?.setShown(!privateShown())
      .catch(e => console.error("firefox-zen-spaces:", e));
  }

  function promptPassword(title, text) {
    const value = { value: "" };
    return Services.prompt.promptPassword(window, title, text, value, null, {}) ? value.value : null;
  }

  // A new password, typed twice. null if cancelled.
  function promptNewPassword(title) {
    for (;;) {
      const password = promptPassword(title, "Password for this private space:");
      if (password == null) {
        return null;
      }
      if (!password) {
        Services.prompt.alert(window, title, "The password can't be empty.");
        continue;
      }
      const again = promptPassword(title, "Type the password again:");
      if (again == null) {
        return null;
      }
      if (again !== password) {
        Services.prompt.alert(window, title, "The passwords don't match.");
        continue;
      }
      if (
        password.length < 8 &&
        !Services.prompt.confirm(
          window,
          title,
          "This password is shorter than 8 characters, which makes the saved space easier to break into. Use it anyway?"
        )
      ) {
        continue;
      }
      return password;
    }
  }

  // One unlock at a time (deriving the key takes a moment).
  let unlocking = false;

  // `showWindow`: open its window right away (the Library leaves it
  // unlocked, listing its tabs there instead). Resolves with its id.
  async function createPrivateSpace({ showWindow = true } = {}) {
    const ps = privateSpaces();
    const password = ps && promptNewPassword("Create Private Space");
    if (password == null || unlocking) {
      return;
    }
    const count = readSpaces().filter(s => s.private).length;
    const space = { id: crypto.randomUUID(), private: true };
    const meta = { name: count ? `Private ${count + 1}` : "Private", icon: PRIVATE_ICON };
    unlocking = true;
    try {
      await ps.create(space.id, password, meta);
      await ps.setShown(true);
      writeSpaces([...readSpaces(), space]);
      await ps.unlock(space.id, password);
      if (showWindow) {
        await ps.showWindow(space.id);
      }
      return space.id;
    } catch (e) {
      console.error("firefox-zen-spaces:", e);
      Services.prompt.alert(window, "Create Private Space", `Couldn't create the private space: ${e.message}`);
    } finally {
      unlocking = false;
    }
  }

  // Asks for the password until it's right (or cancelled). Unlocking only
  // decrypts it; no window opens. Resolves true once unlocked.
  async function unlockPrivateSpace(id) {
    const ps = privateSpaces();
    const space = readSpaces().find(s => s.id === id);
    if (!ps || !space || unlocking) {
      return false;
    }
    if (ps.isUnlocked(id)) {
      return true;
    }
    let text = `Password for “${space.name}”:`;
    for (;;) {
      const password = promptPassword("Unlock Private Space", text);
      if (password == null) {
        return false;
      }
      unlocking = true;
      try {
        await ps.unlock(id, password);
        if (!ps.meta(id)) {
          // From before names were encrypted: move it out of prefs.
          const old = readRawSpaces().find(s => s.id === id);
          await ps.setMeta(id, { name: old?.name || space.name, icon: old?.icon || PRIVATE_ICON });
          writeSpaces(readSpaces());
        }
        return true;
      } catch (e) {
        if (e.name !== "WrongPasswordError") {
          console.error("firefox-zen-spaces:", e);
          Services.prompt.alert(window, "Unlock Private Space", e.message);
          return false;
        }
        text = `Wrong password. Password for “${space.name}”:`;
      } finally {
        unlocking = false;
      }
    }
  }

  // Shows the space's window (unlocking it first if needed), optionally
  // selecting its tab at `select`.
  async function openPrivateSpace(id, { select = null } = {}) {
    if (!(await unlockPrivateSpace(id))) {
      return;
    }
    try {
      await privateSpaces().showWindow(id, { select });
    } catch (e) {
      console.error("firefox-zen-spaces:", e);
    }
  }

  function lockPrivateSpace(id) {
    privateSpaces()?.lock(id).catch(e => console.error("firefox-zen-spaces:", e));
  }

  // Asks to confirm, with "Also delete its N downloaded files" when it has
  // any. Resolves { ok, deleteFiles }.
  async function confirmWithFiles(id, title, text) {
    const ps = privateSpaces();
    const files = ps.downloads(id).filter(d => d.path);
    const check = { value: false };
    const ok = files.length
      ? Services.prompt.confirmCheck(
          window,
          title,
          text,
          `Also delete its ${files.length} downloaded file${files.length > 1 ? "s" : ""} from disk`,
          check
        )
      : Services.prompt.confirm(window, title, text);
    return { ok, deleteFiles: ok && check.value };
  }

  async function clearPrivateSpace(id) {
    const ps = privateSpaces();
    const space = readSpaces().find(s => s.id === id);
    const { ok, deleteFiles } = await confirmWithFiles(
      id,
      "Clear and Lock",
      `Erase the tabs, history, downloads list and cookies in “${space.name}” and lock it? The space and its password stay.`
    );
    if (!ok) {
      return;
    }
    if (deleteFiles) {
      await ps.deleteDownloadedFiles(id);
    }
    await ps.clear(id);
  }

  async function changePrivatePassword(id) {
    const ps = privateSpaces();
    const space = readSpaces().find(s => s.id === id);
    if (!ps || !space) {
      return;
    }
    const title = "Change Password";
    let current = null;
    if (!ps.isUnlocked(id)) {
      current = promptPassword(title, `Current password for “${space.name}”:`);
      if (current == null) {
        return;
      }
    }
    const password = promptNewPassword(title);
    if (password == null) {
      return;
    }
    try {
      await ps.changePassword(id, current, password);
    } catch (e) {
      Services.prompt.alert(
        window,
        title,
        e.name === "WrongPasswordError" ? "Wrong password; the password wasn't changed." : e.message
      );
    }
  }

  // Its downloads list is encrypted, so deleting a locked space's files asks
  // for its password first.
  async function deletePrivateSpace(space) {
    const ps = privateSpaces();
    const title = "Delete Private Space";
    const text = `Delete “${space.name}”? Its tabs, history, downloads list and cookies are erased for good.`;
    let ok;
    let deleteFiles = false;
    if (ps.isUnlocked(space.id)) {
      ({ ok, deleteFiles } = await confirmWithFiles(space.id, title, text));
    } else {
      const check = { value: false };
      ok = Services.prompt.confirmCheck(
        window,
        title,
        text,
        "Also delete its downloaded files from disk (asks for its password)",
        check
      );
      deleteFiles = ok && check.value && (await unlockPrivateSpace(space.id));
    }
    if (!ok) {
      return;
    }
    try {
      if (deleteFiles) {
        await ps.deleteDownloadedFiles(space.id);
      }
      await ps.destroy(space.id);
      writeSpaces(readSpaces().filter(s => s.id !== space.id));
    } catch (e) {
      console.error("firefox-zen-spaces:", e);
    }
  }

  // ---- export / import ----

  function pickFile(mode, title, defaultName = "") {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window.browsingContext, title, mode);
    fp.appendFilter("Space", "*.fzspace");
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    fp.defaultString = defaultName;
    fp.defaultExtension = "fzspace";
    return new Promise(resolve =>
      fp.open(rv => resolve(rv === Ci.nsIFilePicker.returnCancel ? null : fp.file.path))
    );
  }

  async function exportPrivateSpace(id) {
    const space = readSpaces().find(s => s.id === id);
    // A locked space's name isn't known here; don't put the placeholder in the file name.
    const name = (space?.locked ? "private-space" : space?.name || "private-space").replace(/[\\/:*?"<>|]+/g, "-");
    const path = await pickFile(Ci.nsIFilePicker.modeSave, "Export Private Space", `${name}.fzspace`);
    if (!path) {
      return;
    }
    try {
      await privateSpaces().exportTo(id, path);
    } catch (e) {
      Services.prompt.alert(window, "Export Private Space", `Couldn't export it: ${e.message}`);
    }
  }

  const SPACE_FORMAT = "firefox-zen-space";

  // A normal space as plain JSON: its name, icon, container and its tabs'
  // SessionStore states (history included), from every window. Folders
  // aren't kept: their tabs come back loose.
  async function exportNormalSpace(id) {
    const space = readSpaces().find(s => s.id === id);
    const name = (space?.name || "space").replace(/[\\/:*?"<>|]+/g, "-");
    const path = await pickFile(Ci.nsIFilePicker.modeSave, "Export Space", `${name}.fzspace`);
    if (!path) {
      return;
    }
    try {
      const { TabStateFlusher } = ChromeUtils.importESModule(FLUSHER_MODULE);
      const tabs = [];
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        for (const tab of win.gBrowser.tabs) {
          if (!tab.pinned && !tab.closing && SessionStore.getCustomTabValue(tab, TAB_KEY) === id) {
            await TabStateFlusher.flush(tab.linkedBrowser).catch(() => {});
            const raw = SessionStore.getTabState(tab);
            const state = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw);
            delete state.groupId;
            delete state.hidden;
            tabs.push(state);
          }
        }
      }
      const container = containerOf(space);
      await IOUtils.writeJSON(path, {
        format: SPACE_FORMAT,
        space: {
          name: space.name,
          icon: space.icon,
          container: container ? ContextualIdentityService.getUserContextLabel(container) : null,
        },
        tabs,
      });
    } catch (e) {
      Services.prompt.alert(window, "Export Space", `Couldn't export it: ${e.message}`);
    }
  }

  function exportSpace(id) {
    if (readSpaces().find(s => s.id === id)?.private) {
      exportPrivateSpace(id);
    } else {
      exportNormalSpace(id);
    }
  }

  // Imports either kind of export; resolves with the new space's id.
  async function importSpace() {
    const path = await pickFile(Ci.nsIFilePicker.modeOpen, "Import Space");
    if (!path) {
      return null;
    }
    try {
      const data = await IOUtils.readJSON(path);
      if (data?.format === SPACE_FORMAT) {
        return await importNormalSpace(data);
      }
      const ps = privateSpaces();
      const id = await ps.importFrom(path);
      await ps.setShown(true);
      writeSpaces([...readSpaces(), { id, private: true }]);
      return id;
    } catch (e) {
      Services.prompt.alert(window, "Import Space", `Couldn't import it: ${e.message}`);
      return null;
    }
  }

  // A new space (new id) with the export's tabs, in a normal window. Its
  // container is matched by name, if one by that name exists.
  async function importNormalSpace(data) {
    const id = crypto.randomUUID();
    const container =
      data.space?.container &&
      ContextualIdentityService.getPublicIdentities().find(
        identity => ContextualIdentityService.getUserContextLabel(identity.userContextId) === data.space.container
      );
    writeSpaces([
      ...readSpaces(),
      {
        id,
        name: String(data.space?.name || "Imported"),
        icon: String(data.space?.icon || DEFAULT_ICONS[0]),
        container: container?.userContextId || 0,
      },
    ]);
    const win = await normalWindow();
    for (const state of Array.isArray(data.tabs) ? data.tabs : []) {
      state.extData = { ...state.extData, [TAB_KEY]: id };
      state.userContextId = container?.userContextId || 0;
      const tab = win.gBrowser.addTrustedTab(null, { inBackground: true, skipAnimation: true, skipLoad: true });
      SessionStore.setTabState(tab, state);
    }
    win.FirefoxZenSpaces?.refresh();
    return id;
  }

  // A normal browser window (this one if it is), opening one if needed.
  async function normalWindow() {
    if (!PrivateBrowsingUtils.isWindowPrivate(window)) {
      return window;
    }
    const win = [...Services.wm.getEnumerator("navigator:browser")]
      .reverse()
      .find(w => !w.closed && !PrivateBrowsingUtils.isWindowPrivate(w));
    if (win) {
      return win;
    }
    const opened = window.OpenBrowserWindow({ private: false });
    await new Promise(resolve => opened.addEventListener("load", resolve, { once: true }));
    await opened.delayedStartupPromise;
    await SessionStore.promiseInitialized;
    return opened;
  }

  // From a private space's window: switch a normal window to `id`.
  async function showInNormalWindow(id) {
    const win = await normalWindow();
    win.focus();
    win.FirefoxZenSpaces?.switchTo(id);
  }

  // Tabs of this (normal) window into a private space: their state (history
  // included) goes into the space and the tabs close here without a trace in
  // recently closed tabs. Their earlier visits stay in normal history.
  async function moveTabsToPrivate(tabs, id) {
    const ps = privateSpaces();
    tabs = tabs.filter(t => !t.closing);
    if (!ps || !tabs.length || !(await unlockPrivateSpace(id))) {
      return;
    }
    const states = [];
    for (const tab of tabs) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
      try {
        await ChromeUtils.importESModule(FLUSHER_MODULE).TabStateFlusher.flush(tab.linkedBrowser);
      } catch (e) {
        // Use what SessionStore has.
      }
      const raw = SessionStore.getTabState(tab);
      const state = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw);
      state.extData = { ...state.extData, [TAB_KEY]: id };
      delete state.pinned;
      delete state.hidden;
      // A private window can't hold container tabs.
      state.userContextId = 0;
      states.push(state);
    }
    if (tabs.includes(gBrowser.selectedTab)) {
      const stay = tabsIn(activeId).filter(t => !tabs.includes(t));
      if (stay.length) {
        gBrowser.selectedTab = stay.at(-1);
      } else {
        holdSpace = true;
        openTabInActiveSpace();
        holdSpace = false;
      }
    }
    for (const tab of tabs) {
      gBrowser.removeTab(tab, { skipSessionStore: true, skipPermitUnload: true, animate: false });
    }
    await ps.addTabs(id, states);
  }

  // Tabs out of an unlocked private space (by index) into space `toId`:
  // another private space (unlocked first if needed), or a normal space in a
  // normal window.
  async function movePrivateTabs(fromId, indexes, toId) {
    const ps = privateSpaces();
    if (!ps?.isUnlocked(fromId) || !indexes.length || fromId === toId) {
      return;
    }
    if (readSpaces().find(s => s.id === toId)?.private) {
      if (!(await unlockPrivateSpace(toId))) {
        return;
      }
      const states = await ps.takeTabs(fromId, indexes);
      for (const state of states) {
        state.extData = { ...state.extData, [TAB_KEY]: toId };
      }
      await ps.addTabs(toId, states);
      return;
    }
    const win = await normalWindow();
    const states = await ps.takeTabs(fromId, indexes);
    const browser = win.gBrowser;
    for (const state of states) {
      state.extData = { ...state.extData, [TAB_KEY]: toId };
      delete state.hidden;
      const tab = browser.addTrustedTab(null, { inBackground: true, skipAnimation: true, skipLoad: true });
      SessionStore.setTabState(tab, state);
    }
    win.FirefoxZenSpaces?.refresh();
  }

  // Moves `tabs` (in this window) to space `id`, whichever kind either is.
  function moveTabsAnywhere(tabs, id) {
    const target = readSpaces().find(s => s.id === id);
    if (ownPrivateId) {
      if (target && target.id !== ownPrivateId) {
        movePrivateTabs(
          ownPrivateId,
          tabs.map(t => gBrowser.tabs.indexOf(t)).filter(i => i >= 0),
          id
        ).catch(e => console.error("firefox-zen-spaces:", e));
      }
      return;
    }
    if (target?.private) {
      moveTabsToPrivate(tabs, id).catch(e => console.error("firefox-zen-spaces:", e));
    } else {
      moveTabs(tabs, id);
    }
  }

  // ---- UI: space bar under the vertical tabs ----

  function h(tag, attrs = {}, ...children) {
    const el = document.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") {
        el.textContent = v;
      } else {
        el.setAttribute(k, v);
      }
    }
    el.append(...children);
    return el;
  }

  // The footer lives in <sidebar-main>'s (open) shadow root, after Firefox's
  // tools row, so it ends up below it; userChrome.css can't reach in there, so
  // theme/spaces-footer.css is loaded into the shadow root too. Falls back to
  // #vertical-tabs (styled via spaces.css, which imports the same sheet).
  const FOOTER_CSS_ID = "fz-spaces-footer-css";
  const FOOTER_CSS_URL = (() => {
    const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
    dir.append("theme");
    dir.append("spaces-footer.css");
    return Services.io.newFileURI(dir).spec;
  })();
  let barEl = null;

  function sidebarMain() {
    return document.querySelector("sidebar-main");
  }

  function ensureBar() {
    if (!barEl) {
      barEl = h("div", { id: BAR_ID, role: "toolbar", "aria-label": "Spaces" });
    }
    const main = sidebarMain();
    const wrapper = main?.shadowRoot?.querySelector(".wrapper");
    if (wrapper) {
      if (!wrapper.querySelector(`#${FOOTER_CSS_ID}`)) {
        wrapper.append(h("link", { id: FOOTER_CSS_ID, rel: "stylesheet", href: FOOTER_CSS_URL }));
      }
      // Keep it last: after .buttons-wrapper (re-append if the sidebar re-rendered).
      if (wrapper.lastElementChild !== barEl) {
        wrapper.append(barEl);
      }
    } else if (!barEl.isConnected) {
      const host = document.getElementById("vertical-tabs");
      if (!host) {
        return null;
      }
      // Tell CustomizableUI this isn't a widget it should manage.
      barEl.setAttribute("removable", "false");
      host.append(barEl);
    }
    return barEl;
  }

  // Arc-style header with the active space's icon and name, between the
  // pinned tabs (Pins) and the space's tabs. #tabbrowser-tabs already
  // holds non-tab children (drop indicator, splitter), so a sibling of the
  // tab scroll box is safe.
  function ensureHeader() {
    let header = document.getElementById(HEADER_ID);
    if (!header) {
      const scrollbox = document.getElementById("tabbrowser-arrowscrollbox");
      if (!scrollbox) {
        return null;
      }
      header = h("div", { id: HEADER_ID });
      scrollbox.before(header);
    }
    return header;
  }

  function renderHeader(active) {
    const header = ensureHeader();
    if (!header) {
      return;
    }
    header.hidden = !enabled() || !active;
    if (header.hidden) {
      return;
    }
    const name = h("span", { class: "fz-space-name", text: active.name, title: "Double-click to rename" });
    name.addEventListener("dblclick", () => startInlineRename(active.id, name));
    header.replaceChildren(h("span", { class: "fz-space-header-icon", text: active.icon || "" }), name);
    header.classList.toggle("fz-space-header-private", !!active.private);
    header.oncontextmenu = e => {
      e.preventDefault();
      openMenu(active.id, e);
    };
  }

  function renderBar() {
    const bar = ensureBar();
    if (!bar) {
      return;
    }
    if (!enabled()) {
      bar.hidden = true;
      sidebarMain()?.removeAttribute("fz-spaces-footer");
      renderHeader(null);
      return;
    }
    bar.hidden = false;
    sidebarMain()?.setAttribute("fz-spaces-footer", "");
    setupToolsRow();
    const list = visibleSpaces();
    const active = list.find(s => s.id === activeId);

    const buttons = list.map(space => {
      const btn = h("button", {
        class: "fz-space",
        type: "button",
        title: space.name,
        "aria-label": space.name,
        "aria-pressed": String(space.id === activeId),
        "data-id": space.id,
        text: space.icon || "•",
      });
      const container = containerOf(space);
      if (container) {
        const identity = ContextualIdentityService.getPublicIdentityFromId(container);
        btn.classList.add("fz-space-has-container");
        btn.style.setProperty(
          "--fz-space-container-color",
          ContextualIdentityService.getContainerColorCode(identity.color)
        );
        btn.title = `${space.name} (${ContextualIdentityService.getUserContextLabel(container)})`;
      }
      if (space.private) {
        // A badge (CSS): mask while unlocked, padlock while locked.
        const locked = space.locked;
        btn.classList.add("fz-space-private");
        btn.toggleAttribute("fz-locked", locked);
        // The icon in its own element, so locking can blur it under the badge.
        btn.replaceChildren(h("span", { class: "fz-space-icon", text: space.icon }));
        // Middle-click locks it.
        btn.addEventListener("auxclick", e => {
          if (e.button === 1 && !locked) {
            e.preventDefault();
            lockPrivateSpace(space.id);
          }
        });
        btn.title = `${space.name} (private, ${locked ? "locked" : "unlocked"})`;
      }
      btn.addEventListener("click", () => switchTo(space.id));
      // The clicks already switched to it, so its name is in the (re-rendered) header.
      btn.addEventListener("dblclick", () => {
        if (!isLocal(space.id)) {
          return;
        }
        const label = document.querySelector(`#${HEADER_ID} .fz-space-name`);
        if (label) {
          startInlineRename(space.id, label);
        }
      });
      btn.addEventListener("contextmenu", e => {
        e.preventDefault();
        openMenu(space.id, e);
      });
      return btn;
    });

    const add = h("button", {
      class: "fz-space fz-space-add",
      type: "button",
      title: "Create…",
      "aria-label": "Create",
      "aria-haspopup": "menu",
      text: "+",
    });
    add.addEventListener("click", () => openPlusMenu(add));

    // Library (JS/firefox-zen-library.uc.js), else Firefox's History sidebar.
    const library = libraryOn();
    const history = h("button", {
      class: `fz-space fz-footer-button ${library ? "fz-library" : "fz-history"}`,
      type: "button",
      title: library ? "Library" : "History",
      "aria-label": library ? "Library" : "History",
    });
    if (library) {
      history.setAttribute("aria-pressed", String(!!window.FirefoxZenLibrary.isOpen()));
    }
    history.addEventListener("click", () => {
      if (libraryOn()) {
        window.FirefoxZenLibrary.toggle();
      } else {
        window.SidebarController?.toggle("viewHistorySidebar");
      }
    });

    // Keep the window inside the list, and bring the active space into view
    // when it changes (not on every re-render, so a hover-scroll sticks).
    const count = list.length;
    const VISIBLE = visible();
    const maxStart = Math.max(0, count - VISIBLE);
    const activeIndex = list.findIndex(s => s.id === activeId);
    if (activeId !== lastRenderedActive && activeIndex >= 0) {
      if (activeIndex < viewStart) {
        viewStart = activeIndex;
      } else if (activeIndex >= viewStart + VISIBLE) {
        viewStart = activeIndex - VISIBLE + 1;
      }
      lastRenderedActive = activeId;
    }
    viewStart = Math.min(Math.max(viewStart, 0), maxStart);

    const track = h("div", { class: "fz-space-list" }, ...buttons);
    const viewport = h("div", { class: "fz-space-viewport" }, track);
    viewport.style.setProperty("--fz-visible-slots", String(Math.min(count, VISIBLE)));
    updateCarousel(viewport, count);
    viewport.addEventListener("mousemove", e => onViewportHover(viewport, count, e));
    viewport.addEventListener("mouseleave", stopScroll);

    bar.replaceChildren(history, viewport, add);
    renderHeader(active);
    window.dispatchEvent(new CustomEvent("FzSpacesChanged"));
  }

  function updateCarousel(viewport, count) {
    viewport.style.setProperty("--fz-view-start", String(viewStart));
    viewport.classList.toggle("fz-more-left", viewStart > 0);
    viewport.classList.toggle("fz-more-right", viewStart + visible() < count);
  }

  function stopScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = null;
  }

  // Which slot the pointer is over decides the direction, rather than which
  // button: buttons slide under a still cursor while scrolling.
  function onViewportHover(viewport, count, e) {
    const VISIBLE = visible();
    if (count <= VISIBLE) {
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const slot = Math.floor(((e.clientX - rect.left) / rect.width) * VISIBLE);
    const dir =
      slot <= 0 && viewStart > 0 ? -1 : slot >= VISIBLE - 1 && viewStart + VISIBLE < count ? 1 : 0;
    if (!dir) {
      stopScroll();
      return;
    }
    if (scrollTimer) {
      return;
    }
    const step = delay => {
      scrollTimer = setTimeout(() => {
        const next = viewStart + dir;
        if (next < 0 || next + VISIBLE > count) {
          stopScroll();
          return;
        }
        viewStart = next;
        // The bar may have re-rendered meanwhile; update the live viewport.
        const live = barEl?.querySelector(".fz-space-viewport");
        if (live) {
          updateCarousel(live, count);
        }
        step(SCROLL_REPEAT_DELAY);
      }, delay);
    };
    step(SCROLL_FIRST_DELAY);
  }

  // ---- Firefox's tools row: one row, scrolled by hovering its edges ----

  const edgeScrollAttached = new WeakSet();

  // For a real scroll container (overflow-x: hidden): hovering the first or
  // last visible item's width scrolls one item that way, repeating while the
  // pointer stays there. Fade attributes mark hidden items on either side.
  function attachEdgeScroll(el) {
    if (edgeScrollAttached.has(el)) {
      return;
    }
    edgeScrollAttached.add(el);
    let timer = null;
    const itemWidth = () => {
      const first = el.firstElementChild;
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      return (first?.getBoundingClientRect().width || 32) + gap;
    };
    const maxScroll = () => el.scrollWidth - el.clientWidth;
    const updateFades = () => {
      el.toggleAttribute("fz-more-left", el.scrollLeft > 1);
      el.toggleAttribute("fz-more-right", el.scrollLeft < maxScroll() - 1);
    };
    const stop = () => {
      clearTimeout(timer);
      timer = null;
    };
    el.addEventListener("scroll", updateFades);
    el.addEventListener("mouseleave", stop);
    el.addEventListener("mousemove", e => {
      if (maxScroll() <= 1) {
        stop();
        return;
      }
      const rect = el.getBoundingClientRect();
      const zone = itemWidth();
      const x = e.clientX - rect.left;
      const dir =
        x < zone && el.scrollLeft > 1 ? -1 : x > rect.width - zone && el.scrollLeft < maxScroll() - 1 ? 1 : 0;
      if (!dir) {
        stop();
        return;
      }
      if (timer) {
        return;
      }
      const step = delay => {
        timer = setTimeout(() => {
          const atEnd = dir < 0 ? el.scrollLeft <= 1 : el.scrollLeft >= maxScroll() - 1;
          if (atEnd) {
            stop();
            return;
          }
          el.scrollBy({ left: dir * itemWidth(), behavior: "smooth" });
          step(SCROLL_REPEAT_DELAY);
        }, delay);
      };
      step(SCROLL_FIRST_DELAY);
    });
    new ResizeObserver(updateFades).observe(el);
    // Tools/extensions added or removed change the scroll width, not the size.
    new MutationObserver(updateFades).observe(el, { childList: true });
    updateFades();
  }

  function setupToolsRow() {
    const tools = sidebarMain()?.shadowRoot?.querySelector(".tools-and-extensions:not(.overflow-button)");
    if (tools) {
      attachEdgeScroll(tools);
    }
  }

  // ---- + button menu: Create Space / Create Folder / New Tab ----

  const PLUS_MENU_ID = "fz-spaces-plus-menu";

  // A Firefox tab group needs a tab: start one in the current space and group
  // it. A user-triggered metrics context makes Firefox open its own "create
  // group" panel (name + color), like making a folder in Zen.
  function createFolder() {
    openTabInActiveSpace();
    const tab = gBrowser.selectedTab;
    const metricsContext = gBrowser.TabMetrics?.userTriggeredContext?.() ?? undefined;
    gBrowser.addTabGroup([tab], { insertBefore: tab, metricsContext });
  }

  function ensurePlusMenu() {
    let menu = document.getElementById(PLUS_MENU_ID);
    if (menu) {
      return menu;
    }
    menu = document.createXULElement("menupopup");
    menu.id = PLUS_MENU_ID;
    const item = (label, icon, action) => {
      const mi = document.createXULElement("menuitem");
      mi.setAttribute("label", label);
      mi.setAttribute("image", icon);
      mi.classList.add("menuitem-iconic");
      mi.dataset.action = action;
      return mi;
    };
    menu.append(
      item("Create Space", "chrome://browser/skin/window.svg", "space"),
      item("Create Private Space…", "chrome://browser/skin/privateBrowsing.svg", "private"),
      item("Import…", "chrome://browser/skin/import.svg", "import"),
      item("Show Private Spaces", "chrome://browser/skin/privateBrowsing.svg", "toggle-private"),
      item("Create Folder", "chrome://browser/skin/tabbrowser/tab-groups.svg", "folder"),
      document.createXULElement("menuseparator"),
      item("New Tab", "chrome://global/skin/icons/plus.svg", "tab")
    );
    menu.addEventListener("command", e => {
      switch (e.target.dataset.action) {
        case "space":
          createSpace();
          break;
        case "private":
          createPrivateSpace();
          break;
        case "toggle-private":
          togglePrivateShown();
          break;
        case "import":
          importSpace();
          break;
        case "folder":
          createFolder();
          break;
        case "tab":
          openTabInActiveSpace({ userInitiated: true });
          break;
      }
    });
    document.getElementById("mainPopupSet").append(menu);
    return menu;
  }

  function openPlusMenu(anchor) {
    const menu = ensurePlusMenu();
    // From a private space's window a new space (or an import) would only show
    // in other windows; a new private space opens its own window, so it stays.
    for (const action of ["space", "import"]) {
      menu.querySelector(`[data-action="${action}"]`).disabled = !!ownPrivateId;
    }
    const toggle = menu.querySelector('[data-action="toggle-private"]');
    toggle.setAttribute("label", `${privateShown() ? "Hide" : "Show"} Private Spaces`);
    toggle.setAttribute("acceltext", "Ctrl+Alt+P");
    toggle.hidden = !readSpaces().some(s => s.private);
    menu.querySelector('[data-action="folder"]').hidden = !Services.prefs.getBoolPref(
      "browser.tabs.groups.enabled",
      true
    );
    // Opens upward from the footer, right-aligned with the + button.
    menu.openPopup(anchor, "before_end");
  }

  function ensureMenu() {
    let menu = document.getElementById(MENU_ID);
    if (menu) {
      return menu;
    }
    menu = document.createXULElement("menupopup");
    menu.id = MENU_ID;
    const item = (label, action) => {
      const mi = document.createXULElement("menuitem");
      mi.setAttribute("label", label);
      mi.dataset.action = action;
      return mi;
    };
    // Set Container ▸ : Firefox's own container list (same builder as "Open in
    // New Container Tab"), with "No Container" first.
    const containerMenu = document.createXULElement("menu");
    containerMenu.setAttribute("label", "Set Container");
    containerMenu.dataset.action = "container";
    const containerPopup = document.createXULElement("menupopup");
    containerMenu.append(containerPopup);
    containerPopup.addEventListener("popupshowing", e => {
      if (e.target !== containerPopup) {
        return;
      }
      createUserContextMenu(e, {
        isContextMenu: true,
        showDefaultTab: true,
        containerSource: "firefox-zen-spaces",
      });
      // Mark the space's current container.
      const space = readSpaces().find(s => s.id === menu.dataset.spaceId);
      const current = String(containerOf(space));
      for (const mi of containerPopup.querySelectorAll("menuitem[data-usercontextid]")) {
        mi.setAttribute("type", "radio");
        mi.toggleAttribute("checked", mi.getAttribute("data-usercontextid") === current);
      }
    });
    // "Add new container" / "Manage containers" stop their own events; this
    // only sees the container items.
    containerPopup.addEventListener("command", e => {
      const ucid = e.target.getAttribute("data-usercontextid");
      if (ucid != null) {
        e.stopPropagation();
        setSpaceContainer(menu.dataset.spaceId, Number(ucid));
      }
    });

    menu.append(
      item("Rename Space…", "rename"),
      item("Change Icon…", "icon"),
      containerMenu,
      item("Unload Space", "unload"),
      item("Unlock…", "unlock"),
      item("Lock Space", "lock"),
      item("Change Password…", "password"),
      item("Clear and Lock…", "clear"),
      item("Export…", "export"),
      document.createXULElement("menuseparator"),
      item("Delete Space…", "delete")
    );
    menu.addEventListener("command", e => {
      const id = menu.dataset.spaceId;
      switch (e.target.dataset.action) {
        case "rename":
          renameSpace(id);
          break;
        case "icon":
          changeIcon(id);
          break;
        case "unload":
          unloadSpace(id);
          break;
        case "unlock":
          unlockPrivateSpace(id);
          break;
        case "lock":
          lockPrivateSpace(id);
          break;
        case "password":
          changePrivatePassword(id);
          break;
        case "clear":
          clearPrivateSpace(id);
          break;
        case "export":
          exportSpace(id);
          break;
        case "delete":
          deleteSpace(id);
          break;
      }
    });
    document.getElementById("mainPopupSet").append(menu);
    return menu;
  }

  function openMenu(id, event) {
    const menu = ensureMenu();
    menu.dataset.spaceId = id;
    const isPrivate = !!readSpaces().find(s => s.id === id)?.private;
    const open = isPrivate && isUnlocked(id);
    const set = (action, prop, value) => (menu.querySelector(`[data-action="${action}"]`)[prop] = value);
    set("delete", "disabled", !isPrivate && readSpaces().filter(s => !s.private).length < 2);
    set("unload", "hidden", isPrivate);
    set("unload", "disabled", !unloadableTabs(id).length);
    // A private window can't hold container tabs.
    set("container", "hidden", isPrivate || !Services.prefs.getBoolPref("privacy.userContext.enabled", false));
    set("unlock", "hidden", !isPrivate || open);
    set("lock", "hidden", !open);
    set("password", "hidden", !isPrivate);
    set("clear", "hidden", !open);
    set("export", "hidden", false);
    menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
  }

  // ---- tab context menu: Move to Space ----

  const MOVE_MENU_ID = "fz-move-to-space";

  function contextTabs() {
    const tabs = window.TabContextMenu?.contextTabs ?? [window.TabContextMenu?.contextTab];
    return tabs.filter(t => t && !t.pinned && !t.closing);
  }

  function moveTabs(tabs, id) {
    if (!tabs.length) {
      return;
    }
    // hideTab won't hide the selected tab: if it's moving out of the current
    // space, select another tab here first (or start a new one).
    if (id !== activeId && tabs.includes(gBrowser.selectedTab)) {
      const stay = tabsIn(activeId).filter(t => !tabs.includes(t));
      if (stay.length) {
        gBrowser.selectedTab = stay.at(-1);
      } else {
        holdSpace = true;
        openTabInActiveSpace();
        holdSpace = false;
      }
    }
    for (const tab of tabs) {
      setSpaceOf(tab, id);
    }
    apply();
  }

  function ensureTabMenu() {
    const tabMenu = document.getElementById("tabContextMenu");
    if (!tabMenu || document.getElementById(MOVE_MENU_ID)) {
      return;
    }
    const menu = document.createXULElement("menu");
    menu.id = MOVE_MENU_ID;
    menu.setAttribute("label", "Move to Space");
    const popup = document.createXULElement("menupopup");
    menu.append(popup);

    popup.addEventListener("popupshowing", () => {
      const tabs = contextTabs();
      const from = tabs.length === 1 ? spaceOf(tabs[0]) : null;
      // Every space but this one. A locked private space asks for its
      // password first.
      const items = visibleSpaces()
        .filter(space => space.id !== from)
        .map(space => {
          const mi = document.createXULElement("menuitem");
          const lock = space.private && !isUnlocked(space.id) ? "  🔒" : "";
          mi.setAttribute("label", `${space.icon ? space.icon + "  " : ""}${space.name}${lock}`);
          mi.addEventListener("command", () => moveTabsAnywhere(contextTabs(), space.id));
          return mi;
        });
      const create = document.createXULElement("menuitem");
      create.setAttribute("label", "New Space");
      create.addEventListener("command", () => {
        const tabs = contextTabs();
        const id = createSpace({ switchToIt: false });
        moveTabsAnywhere(tabs, id);
      });
      popup.replaceChildren(...items, document.createXULElement("menuseparator"), create);
    });

    // Hidden when Spaces is off or only pinned (global) tabs are targeted.
    tabMenu.addEventListener("popupshowing", e => {
      if (e.target === tabMenu) {
        menu.hidden = !enabled() || !contextTabs().length;
      }
    });

    const anchor = document.getElementById("context_moveTabOptions");
    if (anchor) {
      anchor.after(menu);
    } else {
      tabMenu.append(menu);
    }
  }

  // ---- events ----

  function onTabOpen(e) {
    const tab = e.target;
    // Session restore applies its tab values right after creating the tab;
    // only tag tabs that are still untagged a moment later.
    setTimeout(() => {
      if (enabled() && !tab.closing && !tab.pinned && !rawSpaceOf(tab)) {
        setSpaceOf(tab, activeId);
      }
    }, 0);
  }

  function onTabSelect(e) {
    const tab = e.target;
    if (!enabled() || applying || holdSpace || tab.pinned) {
      return;
    }
    // Selected a tab from another space (all-tabs menu, link, extension): follow it.
    const id = rawSpaceOf(tab);
    if (id && id !== activeId) {
      switchTo(id, { keepSelection: true });
    }
  }

  function onTabClose(e) {
    const tab = e.target;
    if (!enabled() || tab.pinned || spaceOf(tab) !== activeId) {
      return;
    }
    const others = tabsIn(activeId).filter(t => t !== tab);
    // Last tab of the space: keep the space alive with a fresh tab instead of
    // letting Firefox select (and drag us into) another space's tab.
    if (!others.length && gBrowser.tabs.length > 1) {
      holdSpace = true;
      setTimeout(() => {
        holdSpace = false;
        if (enabled() && !tabsIn(activeId).length) {
          openTabInActiveSpace();
          apply();
        }
      }, 0);
    }
  }

  function onTabUnpinned(e) {
    if (enabled()) {
      setSpaceOf(e.target, activeId);
    }
  }

  function init() {
    if (!enabled()) {
      renderBar();
      return;
    }
    ensureSpaces();
    const list = localSpaces();
    if (!list.length) {
      // This private space was deleted.
      return;
    }
    const saved = readActive();
    activeId = list.some(s => s.id === saved) ? saved : list[0].id;
    saveActive();
    apply();
  }

  const prefObserver = {
    observe(_subject, _topic, name) {
      if (name === ENABLED_PREF) {
        if (enabled()) {
          init();
        } else {
          showAll();
          renderBar();
        }
        return;
      }
      if (name === VISIBLE_PREF) {
        renderBar();
        return;
      }
      if (name === LIST_PREF && enabled()) {
        const list = localSpaces();
        if (!list.length) {
          init();
          return;
        }
        if (!list.some(s => s.id === activeId)) {
          switchTo(list[0].id);
          return;
        }
        apply();
      }
    },
  };

  // ---- API for the Library (JS/firefox-zen-library.uc.js) ----

  // Select a tab from any space; onTabSelect switches to its space.
  function selectTab(tab) {
    if (tab.hidden) {
      gBrowser.showTab(tab);
    }
    gBrowser.selectedTab = tab;
  }

  function containerInfo(id) {
    const container = containerOf(readSpaces().find(s => s.id === id));
    if (!container) {
      return null;
    }
    const identity = ContextualIdentityService.getPublicIdentityFromId(container);
    return {
      id: container,
      label: ContextualIdentityService.getUserContextLabel(container),
      color: ContextualIdentityService.getContainerColorCode(identity.color),
    };
  }

  window.FirefoxZenSpaces = {
    enabled,
    // The spaces whose tabs are in this window.
    list: localSpaces,
    // Ids of every space shown here (the footer's order).
    shownIds: () => visibleSpaces().map(s => s.id),
    // Private spaces living in their own windows.
    // From a private space's window: the other private spaces.
    privateList: () => (privateShown() ? readSpaces().filter(s => s.private && s.id !== ownPrivateId) : []),
    privateShown,
    togglePrivate: togglePrivateShown,
    isUnlocked,
    // Asks for the password and opens it, keeping this window in front.
    unlockPrivate: id => unlockPrivateSpace(id),
    createPrivate: () => createPrivateSpace({ showWindow: false }),
    importSpace,
    // The private space this window belongs to (null in other windows).
    ownPrivateId: () => ownPrivateId,
    privateLiveDownload: key => privateSpaces()?.liveDownload(key) ?? null,
    // Unlocked private spaces shown here, for the Library's history/downloads.
    unlockedPrivate: () => (privateShown() ? readSpaces().filter(s => s.private && !s.locked) : []),
    privateHistory: id => privateSpaces()?.history(id) ?? [],
    removePrivateHistory: (id, url) => privateSpaces()?.removeHistory(id, url),
    privateDownloads: id => privateSpaces()?.downloads(id) ?? [],
    removePrivateDownload: (id, key) => privateSpaces()?.removeDownload(id, key),
    lockPrivate: lockPrivateSpace,
    // Shows its window, selecting its tab at `index`.
    showPrivate: (id, index = null) => openPrivateSpace(id, { select: index }),
    isPrivate: id => !!readSpaces().find(s => s.id === id)?.private,
    // An unlocked private space's tabs: { index, label, url, image, selected,
    // tab (while its window is open) }.
    privateTabs: id => privateSpaces()?.tabs(id) ?? [],
    // Out of an unlocked private space, into a normal space.
    movePrivateTabs: (fromId, indexes, toId) =>
      movePrivateTabs(fromId, indexes, toId).catch(e => console.error("firefox-zen-spaces:", e)),
    refresh: () => apply(),
    // A new tab in a private space for `url`, never loaded outside it.
    openInPrivate: async (id, url, title = "") => {
      if (await unlockPrivateSpace(id)) {
        await privateSpaces().addTabs(id, [{ entries: [{ url, title }], index: 1, extData: { [TAB_KEY]: id } }]);
      }
    },
    activeId: () => activeId,
    spaceOf,
    tabsIn,
    containerInfo,
    canUnload: id => unloadableTabs(id).length > 0,
    switchTo: id => switchTo(id),
    create: () => createSpace({ switchToIt: false }),
    rename: setSpaceName,
    setIcon: setSpaceIcon,
    reorder: reorderSpaces,
    remove: deleteSpace,
    // Into any space, private ones included (asks for its password if locked).
    moveTabs: moveTabsAnywhere,
    selectTab,
    openMenu,
  };

  async function start() {
    // Registered by the module before this window loaded.
    ownPrivateId = privateSpaces()?.spaceOfWindow(window) ?? null;
    if (ownPrivateId) {
      document.documentElement.setAttribute("fz-private-space", "");
    }
    await window.delayedStartupPromise;
    await SessionStore.promiseInitialized;

    const tc = gBrowser.tabContainer;
    tc.addEventListener("TabOpen", onTabOpen);
    tc.addEventListener("TabSelect", onTabSelect);
    tc.addEventListener("TabClose", onTabClose);
    tc.addEventListener("TabUnpinned", onTabUnpinned);
    tc.addEventListener("SSTabRestoring", () => enabled() && apply());
    // Its own history: top-level pages its tabs land on, and their titles.
    if (ownPrivateId) {
      const ps = privateSpaces();
      const skip =
        Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE |
        Ci.nsIWebProgressListener.LOCATION_CHANGE_RELOAD |
        Ci.nsIWebProgressListener.LOCATION_CHANGE_SESSION_STORE;
      // Loads from session history (restoring its tabs, back/forward) revisit
      // pages already listed. The load command is the type's high 16 bits.
      const LOAD_CMD_HISTORY = 0x4;
      gBrowser.addTabsProgressListener({
        onLocationChange(browser, webProgress, _request, location, flags) {
          const fromHistory = ((webProgress.loadType >>> 16) & LOAD_CMD_HISTORY) !== 0;
          if (webProgress.isTopLevel && !(flags & skip) && !fromHistory) {
            ps.recordVisit(window, location.spec, browser.contentTitle);
          }
        },
      });
      tc.addEventListener("TabAttrModified", e => {
        if (e.detail?.changed?.includes("label")) {
          ps.recordTitle(window, e.target.linkedBrowser.currentURI.spec, e.target.label);
        }
      });
    }
    // Other windows' Libraries list this private space's tabs.
    if (ownPrivateId) {
      const notify = e => {
        if (e.type !== "TabAttrModified" || e.detail?.changed?.some(a => ["label", "image", "pending"].includes(a))) {
          Services.obs.notifyObservers(null, PRIVATE_TABS_TOPIC);
        }
      };
      for (const type of ["TabOpen", "TabClose", "TabSelect", "TabMove", "TabAttrModified"]) {
        tc.addEventListener(type, notify);
      }
    }
    window.addEventListener("SSWindowRestored", init);
    ensureTabMenu();
    hookNewTabContainer();
    // Ctrl+Alt+P shows/hides private spaces (not AltGr+P, which types).
    window.addEventListener(
      "keydown",
      e => {
        if (
          enabled() &&
          e.code === "KeyP" &&
          e.ctrlKey &&
          e.altKey &&
          !e.shiftKey &&
          !e.metaKey &&
          !e.getModifierState("AltGraph") &&
          readSpaces().some(s => s.private)
        ) {
          e.preventDefault();
          e.stopPropagation();
          togglePrivateShown();
        }
      },
      true
    );

    // If the sidebar re-renders its template, put the footer back right away.
    const sidebarRoot = sidebarMain()?.shadowRoot;
    if (sidebarRoot) {
      new MutationObserver(() => {
        if (enabled() && barEl && !barEl.isConnected) {
          renderBar();
        }
      }).observe(sidebarRoot, { childList: true, subtree: true });
    }

    // Pref observers match by prefix: this one also covers LIST_PREF.
    Services.prefs.addObserver(ENABLED_PREF, prefObserver);
    // A private space was locked or unlocked (in any window).
    const privateTopic = privateSpaces()?.CHANGED_TOPIC;
    const privateObserver = { observe: () => renderBar() };
    if (privateTopic) {
      Services.obs.addObserver(privateObserver, privateTopic);
    }
    // Its history / downloads changed: the Library's lists follow.
    const relay = type => ({ observe: (_s, _t, id) => window.dispatchEvent(new CustomEvent(type, { detail: id })) });
    const relays = [
      [privateSpaces()?.HISTORY_TOPIC, relay("FzPrivateHistoryChanged")],
      [privateSpaces()?.DOWNLOADS_TOPIC, relay("FzPrivateDownloadsChanged")],
    ].filter(([topic]) => topic);
    for (const [topic, observer] of relays) {
      Services.obs.addObserver(observer, topic);
    }
    window.addEventListener(
      "unload",
      () => {
        for (const [topic, observer] of relays) {
          Services.obs.removeObserver(observer, topic);
        }
      },
      { once: true }
    );
    const privateTabsObserver = {
      observe: () => window.dispatchEvent(new CustomEvent("FzPrivateTabsChanged")),
    };
    if (!ownPrivateId) {
      Services.obs.addObserver(privateTabsObserver, PRIVATE_TABS_TOPIC);
    }
    window.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(ENABLED_PREF, prefObserver);
        if (privateTopic) {
          Services.obs.removeObserver(privateObserver, privateTopic);
        }
        if (!ownPrivateId) {
          Services.obs.removeObserver(privateTabsObserver, PRIVATE_TABS_TOPIC);
        }
      },
      { once: true }
    );

    init();
  }

  start().catch(e => console.error("firefox-zen-spaces:", e));
})();
