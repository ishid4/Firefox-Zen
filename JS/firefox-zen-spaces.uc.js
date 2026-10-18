// ==UserScript==
// @name           Firefox-Zen Spaces
// @description    Zen-style Spaces: each unpinned tab belongs to a space; switching hides the other spaces' tabs
// @include        main
// ==/UserScript==

// Model
// - Space list (global, all windows): JSON in pref firefox-zen.spaces.list
//   [{ id, name, icon }]. Prefs always persist, even without session restore.
// - Tab's space: SessionStore custom tab value (survives restarts/restore).
// - Window's active space: SessionStore custom window value.
// - Pinned tabs are global "Essentials": never assigned, never hidden
//   (gBrowser.hideTab refuses pinned tabs anyway).
// Switching shows the target space's tabs and hides the rest with
// gBrowser.showTab/hideTab, so the tab strip, Ctrl+Tab etc. follow natively.

(function () {
  "use strict";

  const ENABLED_PREF = "firefox-zen.spaces";
  const LIST_PREF = "firefox-zen.spaces.list";
  const TAB_KEY = "firefox-zen-space";
  const WINDOW_KEY = "firefox-zen-active-space";
  const HIDE_SOURCE = "firefox-zen-spaces";
  const BAR_ID = "fz-spaces-bar";
  const MENU_ID = "fz-spaces-menu";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const DEFAULT_ICONS = ["🏠", "💼", "🎮", "📚", "🎵", "🛒", "✈️", "🧪", "🎨"];

  let activeId = null;
  // Last selected tab per space in this window, to restore on switch.
  const lastSelected = new Map();
  let applying = false;
  // Set while replacing a space's last closed tab, so the tab Firefox selects
  // in the meantime doesn't drag us into another space.
  let holdSpace = false;

  const enabled = () => Services.prefs.getBoolPref(ENABLED_PREF, false);

  // ---- space list ----

  function readSpaces() {
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

  function writeSpaces(list) {
    Services.prefs.setStringPref(LIST_PREF, JSON.stringify(list));
  }

  function ensureSpaces() {
    let list = readSpaces();
    if (!list.length) {
      list = [{ id: crypto.randomUUID(), name: "Home", icon: DEFAULT_ICONS[0] }];
      writeSpaces(list);
    }
    return list;
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
      const ids = new Set(readSpaces().map(s => s.id));
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

  function openTabInActiveSpace() {
    if (window.BrowserCommands?.openTab) {
      window.BrowserCommands.openTab();
    } else {
      gBrowser.selectedTab = gBrowser.addTrustedTab(window.BROWSER_NEW_TAB_URL || "about:newtab");
    }
    setSpaceOf(gBrowser.selectedTab, activeId);
  }

  function switchTo(id, { keepSelection = false } = {}) {
    if (!enabled() || !readSpaces().some(s => s.id === id)) {
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

  function setSpaceName(id, name) {
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
    const name = space && promptText("Rename Space", "Space name:", space.name);
    if (name) {
      space.name = name;
      writeSpaces(list);
    }
  }

  function changeIcon(id) {
    const list = readSpaces();
    const space = list.find(s => s.id === id);
    const icon = space && promptText("Change Space Icon", "Icon (emoji or a short text):", space.icon);
    if (icon) {
      space.icon = [...icon].slice(0, 2).join("");
      writeSpaces(list);
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
    const list = readSpaces();
    if (list.length < 2) {
      return;
    }
    const index = list.findIndex(s => s.id === id);
    const space = list[index];
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
    writeSpaces(list.filter(s => s.id !== id));
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

  function ensureBar() {
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      const host = document.getElementById("vertical-tabs");
      if (!host) {
        return null;
      }
      bar = h("div", { id: BAR_ID, role: "toolbar", "aria-label": "Spaces" });
      // Tell CustomizableUI this isn't a widget it should manage.
      bar.setAttribute("removable", "false");
      host.append(bar);
    }
    return bar;
  }

  function renderBar() {
    const bar = ensureBar();
    if (!bar) {
      return;
    }
    if (!enabled()) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const list = readSpaces();
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
      btn.addEventListener("click", () => switchTo(space.id));
      // The clicks already switched to it, so its name is in the (re-rendered) label.
      btn.addEventListener("dblclick", () => {
        const label = document.querySelector(`#${BAR_ID} .fz-space-name`);
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

    const add = h("button", { class: "fz-space fz-space-add", type: "button", title: "New Space", "aria-label": "New Space", text: "+" });
    add.addEventListener("click", () => createSpace());

    const name = h("span", { class: "fz-space-name", text: active?.name ?? "", title: "Double-click to rename" });
    name.addEventListener("dblclick", () => active && startInlineRename(active.id, name));

    bar.replaceChildren(
      name,
      h("div", { class: "fz-space-list" }, ...buttons, add)
    );
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
    menu.append(
      item("Rename Space…", "rename"),
      item("Change Icon…", "icon"),
      item("Unload Space", "unload"),
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
    menu.querySelector('[data-action="delete"]').disabled = readSpaces().length < 2;
    menu.querySelector('[data-action="unload"]').disabled = !unloadableTabs(id).length;
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
      const items = readSpaces()
        .filter(space => space.id !== from)
        .map(space => {
          const mi = document.createXULElement("menuitem");
          mi.setAttribute("label", `${space.icon ? space.icon + "  " : ""}${space.name}`);
          mi.addEventListener("command", () => moveTabs(contextTabs(), space.id));
          return mi;
        });
      const create = document.createXULElement("menuitem");
      create.setAttribute("label", "New Space");
      create.addEventListener("command", () => {
        const tabs = contextTabs();
        const id = createSpace({ switchToIt: false });
        moveTabs(tabs, id);
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
    const list = ensureSpaces();
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
      if (name === LIST_PREF && enabled()) {
        const list = readSpaces();
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

  async function start() {
    await window.delayedStartupPromise;
    await SessionStore.promiseInitialized;

    const tc = gBrowser.tabContainer;
    tc.addEventListener("TabOpen", onTabOpen);
    tc.addEventListener("TabSelect", onTabSelect);
    tc.addEventListener("TabClose", onTabClose);
    tc.addEventListener("TabUnpinned", onTabUnpinned);
    tc.addEventListener("SSTabRestoring", () => enabled() && apply());
    window.addEventListener("SSWindowRestored", init);
    ensureTabMenu();

    // Pref observers match by prefix: this one also covers LIST_PREF.
    Services.prefs.addObserver(ENABLED_PREF, prefObserver);
    window.addEventListener("unload", () => Services.prefs.removeObserver(ENABLED_PREF, prefObserver), {
      once: true,
    });

    init();
  }

  start().catch(e => console.error("firefox-zen-spaces:", e));
})();
