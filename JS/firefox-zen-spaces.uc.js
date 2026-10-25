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
  const HEADER_ID = "fz-space-header";
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

  // Footer carousel: VISIBLE spaces at a time; hovering the first/last visible
  // slot scrolls one slot that way.
  const VISIBLE = 4;
  const SCROLL_FIRST_DELAY = 250;
  const SCROLL_REPEAT_DELAY = 350;
  let viewStart = 0;
  let lastRenderedActive = null;
  let scrollTimer = null;

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
  // pinned tabs (Essentials) and the space's tabs. #tabbrowser-tabs already
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
      btn.addEventListener("click", () => switchTo(space.id));
      // The clicks already switched to it, so its name is in the (re-rendered) header.
      btn.addEventListener("dblclick", () => {
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

    const history = h("button", {
      class: "fz-space fz-footer-button fz-history",
      type: "button",
      title: "History",
      "aria-label": "History",
    });
    history.addEventListener("click", () => window.SidebarController?.toggle("viewHistorySidebar"));

    // Keep the window inside the list, and bring the active space into view
    // when it changes (not on every re-render, so a hover-scroll sticks).
    const count = list.length;
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
  }

  function updateCarousel(viewport, count) {
    viewport.style.setProperty("--fz-view-start", String(viewStart));
    viewport.classList.toggle("fz-more-left", viewStart > 0);
    viewport.classList.toggle("fz-more-right", viewStart + VISIBLE < count);
  }

  function stopScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = null;
  }

  // Which slot the pointer is over decides the direction, rather than which
  // button: buttons slide under a still cursor while scrolling.
  function onViewportHover(viewport, count, e) {
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
      item("Create Folder", "chrome://browser/skin/tabbrowser/tab-groups.svg", "folder"),
      document.createXULElement("menuseparator"),
      item("New Tab", "chrome://global/skin/icons/plus.svg", "tab")
    );
    menu.addEventListener("command", e => {
      switch (e.target.dataset.action) {
        case "space":
          createSpace();
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
    menu.querySelector('[data-action="container"]').hidden = !Services.prefs.getBoolPref(
      "privacy.userContext.enabled",
      false
    );
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
    hookNewTabContainer();

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
    window.addEventListener("unload", () => Services.prefs.removeObserver(ENABLED_PREF, prefObserver), {
      once: true,
    });

    init();
  }

  start().catch(e => console.error("firefox-zen-spaces:", e));
})();
