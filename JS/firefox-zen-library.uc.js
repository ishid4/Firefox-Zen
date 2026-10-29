// ==UserScript==
// @name           Firefox-Zen Library
// @description    Library over the content area: arrange spaces and their tabs, browse history
// @include        main
// ==/UserScript==

// Opened from the first button of the spaces footer (JS/firefox-zen-spaces.uc.js,
// which exposes window.FirefoxZenSpaces). The panel is plain HTML in the
// browser window, placed over the content area (gBrowser.tabpanels), so the
// sidebar and its space buttons stay usable while it's open.
//
// Views
// - Spaces: one column per space with its folders and tabs, Pins (pinned
//   tabs, at most FirefoxZenPins.max) on top. Drag columns to reorder spaces; drag tabs and folders
//   between and within columns, onto Pins, onto the space buttons in the
//   footer, or onto "New space".
// - History: places history by last visit, grouped by day, searchable. Drag an
//   entry onto a space to open it there.
// - Downloads: Firefox's downloads (or a private space's).
// - Mods: built by JS/firefox-zen-mods.uc.js (window.FirefoxZenMods).
// - Settings: built by JS/firefox-zen-settings.uc.js (window.FirefoxZenSettings).
//
// The Library is core: always on. The toolbar's Firefox-Zen button opens it on
// Settings, so it can be reached before Spaces (and its footer) is on.
//
// Drag and drop uses pointer events (not HTML drag and drop), captured on the
// panel, so a drag can leave the panel and land on the footer.

(function () {
  "use strict";

  const VIEW_PREF = "firefox-zen.library.view";
  const SPACES_PREF = "firefox-zen.spaces";
  const ROOT_ID = "fz-library";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg";

  const DRAG_THRESHOLD = 5;
  // Distance from a scroll container's edge that auto-scrolls during a drag.
  const SCROLL_EDGE = 40;
  const SCROLL_STEP = 14;
  const HISTORY_PAGE = 150;
  const OPEN_MS = 180;

  const ICONS = [
    "🏠", "💼", "🎮", "📚", "🎵", "🛒", "✈️", "🧪", "🎨", "💻", "📰", "🎬",
    "📷", "🍳", "⚽", "🏋️", "💬", "📝", "📊", "💰", "🔬", "🌱", "🐾", "☕",
    "⭐", "❤️", "🔥", "🚀", "🧠", "🎓", "🛠️", "🗂️", "🌍", "🏖️", "🎧", "🕹️",
  ];

  const api = () => window.FirefoxZenSpaces;
  const spacesOn = () => !!api()?.enabled();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let root = null;
  let main = null;
  const VIEWS = ["spaces", "history", "downloads", "mods", "settings"];
  let view = Services.prefs.getStringPref(VIEW_PREF, "spaces");
  let filterText = "";
  let renderQueued = false;
  // Folders collapsed in the board (by tab group id), for this window.
  const collapsedGroups = new Set();
  // Tabs picked with Ctrl/Shift+click; dragging one of them drags them all.
  const picked = new Set();
  let pickAnchor = null;
  // Space to start renaming right after the next render (a new space).
  let renameAfterRender = null;
  let drag = null;
  let suppressClick = false;

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

  // Stable keys for tabs and groups, so rows can be found again after a
  // re-render (animation, scroll, drop targets).
  const keys = new WeakMap();
  let nextKey = 1;
  const keyOf = obj => {
    if (!keys.has(obj)) {
      keys.set(obj, nextKey++);
    }
    return keys.get(obj);
  };
  let tabByKey = new Map();
  let groupByKey = new Map();

  const tabIcon = tab => tab.getAttribute("image") || DEFAULT_FAVICON;
  const tabUrl = tab => tab.linkedBrowser?.currentURI?.spec ?? "";
  const isLoaded = tab => !!tab.linkedPanel && !tab.hasAttribute("pending");

  // ---- open / close ----

  function isOpen() {
    return !!root;
  }

  // Where left/top 0 puts the panel in window coordinates (see place()).
  let origin = null;

  function place() {
    if (!root) {
      return;
    }
    const area = gBrowser.tabpanels.getBoundingClientRect();
    let left = area.left;
    let right = area.right;
    // An expanded sidebar that floats over the page (expand on hover, compact
    // sidebar): start next to it instead of under it. Not for a hover-expanded
    // sidebar on Settings (not held): the Library would jump on every hover.
    const side = document.getElementById("sidebar-container")?.getBoundingClientRect();
    const beside = sidebarHeld || Services.prefs.getBoolPref("firefox-zen.compact-sidebar", false);
    if (beside && side?.width && side.right > left && side.left < right) {
      if (side.left <= left + 1) {
        left = side.right;
      } else {
        right = side.left;
      }
    }
    const r = { left, top: area.top, width: Math.max(0, right - left), height: area.height };
    // position: fixed is relative to the tabbox when the theme gives it a
    // containing block (contain/transform), not to the window: measure where
    // (0, 0) lands and offset from there. Not while the open/close animation's
    // transform would skew it.
    if (!origin || !root.getAnimations().length) {
      root.style.left = "0px";
      root.style.top = "0px";
      const box = root.getBoundingClientRect();
      origin = { left: box.left, top: box.top };
    }
    root.style.left = `${r.left - origin.left}px`;
    root.style.top = `${r.top - origin.top}px`;
    root.style.width = `${r.width}px`;
    root.style.height = `${r.height}px`;
  }

  const resizeObserver = new ResizeObserver(() => place());

  // Follow the sidebar for a moment while it expands or slides (its
  // animations don't all resize anything we observe).
  function followSidebar(ms = 600) {
    const until = performance.now() + ms;
    const step = () => {
      place();
      if (root && performance.now() < until) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }

  // ---- sidebar held expanded while open ----
  // Held on every view but Settings, where the sidebar shows its real layout
  // as a live preview of the layout picker (and Firefox's sidebar button works
  // as usual). A compact sidebar stays slid in on every view
  // ([fz-library-hold], theme/general.css; set in open/close).
  // { wasExpanded, isMenuPopupOpen } while held.
  let sidebarHeld = null;

  const holdsSidebar = name => name !== "settings";

  function holdSidebar() {
    if (sidebarHeld) {
      return;
    }
    const sc = window.SidebarController;
    sidebarHeld = { wasExpanded: false, isMenuPopupOpen: null };
    if (!sc?._state || !Services.prefs.getBoolPref("sidebar.verticalTabs", false)) {
      return;
    }
    sidebarHeld.wasExpanded = !!sc._state.launcherExpanded;
    if (sc.sidebarRevampVisibility === "expand-on-hover") {
      // Firefox collapses the hovered launcher on mouse leave unless one of
      // its popups is open: count the Library as one.
      sidebarHeld.isMenuPopupOpen = sc._isMenuPopupOpen;
      sc._isMenuPopupOpen = () => true;
      if (!sidebarHeld.wasExpanded) {
        sc.debouncedMouseEnter();
      }
    } else if (!sidebarHeld.wasExpanded) {
      sc._state.launcherExpanded = true;
    }
  }

  function releaseSidebar() {
    const held = sidebarHeld;
    if (!held) {
      return;
    }
    sidebarHeld = null;
    const sc = window.SidebarController;
    if (!sc?._state) {
      return;
    }
    if (held.isMenuPopupOpen) {
      sc._isMenuPopupOpen = held.isMenuPopupOpen;
    }
    // By the mode now: Settings may have changed it while the Library was open.
    if (sc.sidebarRevampVisibility === "expand-on-hover") {
      // Collapses unless the pointer is on the sidebar.
      sc._reconcileHoverState?.();
    } else if (sc._state.launcherExpanded !== held.wasExpanded) {
      sc._state.launcherExpanded = held.wasExpanded;
      sc.updateToolbarButton?.();
    }
  }

  // Whether the sidebar is expanded apart from the Library's hold: what it
  // goes back to on close. Settings' layout picker reads and sets it.
  function sidebarExpanded() {
    if (sidebarHeld) {
      return sidebarHeld.wasExpanded;
    }
    return !!document.getElementById("tabbrowser-tabs")?.hasAttribute("expanded");
  }

  // Returns false when not held: the caller expands/collapses it itself.
  function setSidebarExpanded(expanded) {
    if (!sidebarHeld) {
      return false;
    }
    sidebarHeld.wasExpanded = expanded;
    return true;
  }

  function syncFooterButton() {
    const button = document.querySelector("sidebar-main")?.shadowRoot?.querySelector(".fz-library");
    button?.setAttribute("aria-pressed", String(isOpen()));
  }

  function open(newView) {
    if (newView) {
      setView(newView, { render: false });
    }
    if (!root) {
      picked.clear();
      document.getElementById("sidebar-container")?.setAttribute("fz-library-hold", "");
      if (holdsSidebar(view)) {
        holdSidebar();
      }
      root = buildRoot();
      gBrowser.tabbox.append(root);
      origin = null;
      place();
      resizeObserver.observe(gBrowser.tabpanels);
      const side = document.getElementById("sidebar-container");
      if (side) {
        resizeObserver.observe(side);
      }
      followSidebar();
      if (!reducedMotion.matches) {
        root.animate(
          [
            { opacity: 0, transform: "translateX(-12px) scale(0.99)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: OPEN_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }
        );
      }
    }
    renderView();
    root.focus();
    syncFooterButton();
  }

  function close() {
    if (!root) {
      return;
    }
    cancelDrag();
    closePopover();
    stopDownloads();
    resizeObserver.disconnect();
    const old = root;
    root = null;
    main = null;
    document.getElementById("sidebar-container")?.removeAttribute("fz-library-hold");
    releaseSidebar();
    syncFooterButton();
    if (reducedMotion.matches) {
      old.remove();
    } else {
      old
        .animate([{ opacity: 1 }, { opacity: 0, transform: "translateX(-8px)" }], {
          duration: OPEN_MS * 0.7,
          easing: "ease-in",
          fill: "forwards",
        })
        .finished.catch(() => {})
        .then(() => old.remove());
    }
    if (gBrowser.selectedBrowser) {
      gBrowser.selectedBrowser.focus();
    }
  }

  function toggle() {
    // Showing the downloads icon for a new download
    // (JS/firefox-zen-download-cue.uc.js): open on Downloads.
    if (window.FirefoxZenDownloadCue?.opensDownloads() && !(root && view === "downloads")) {
      open("downloads");
    } else if (root) {
      close();
    } else {
      open();
    }
  }

  function setView(name, { render = true } = {}) {
    view = VIEWS.includes(name) ? name : "spaces";
    // Mods and Settings are detours: the footer button opens the last content view.
    if (view !== "mods" && view !== "settings") {
      Services.prefs.setStringPref(VIEW_PREF, view);
    }
    if (root) {
      if (holdsSidebar(view)) {
        holdSidebar();
      } else {
        releaseSidebar();
      }
      followSidebar();
    }
    if (render && root) {
      renderView();
    }
  }

  // ---- shell ----

  function buildRoot() {
    const nav = (name, label) =>
      h("button", {
        type: "button",
        class: `fz-lib-nav fz-lib-nav-${name}`,
        "data-view": name,
        title: label,
        text: label,
        onclick: () => setView(name),
      });

    main = h("section", { class: "fz-lib-main" });
    const el = h(
      "div",
      {
        id: ROOT_ID,
        role: "dialog",
        "aria-label": "Library",
        tabindex: "-1",
        onkeydown: onKeyDown,
        onpointerdown: onPointerDown,
        onpointermove: onPointerMove,
        onpointerup: onPointerUp,
        onpointercancel: () => cancelDrag(),
        onlostpointercapture: () => drag?.started && cancelDrag(),
      },
      h(
        "nav",
        { class: "fz-lib-rail", "aria-label": "Library views" },
        h("div", { class: "fz-lib-title", text: "Library" }),
        nav("spaces", "Spaces"),
        nav("history", "History"),
        nav("downloads", "Downloads"),
        h("div", { class: "fz-lib-rail-spacer" }),
        window.FirefoxZenMods && nav("mods", "Mods"),
        window.FirefoxZenSettings && nav("settings", "Settings"),
        h("button", {
          type: "button",
          class: "fz-lib-nav fz-lib-nav-close",
          title: "Close (Esc)",
          text: "Close",
          onclick: () => close(),
        })
      ),
      main
    );
    // A click that ended a drag isn't a click.
    el.addEventListener(
      "click",
      e => {
        if (suppressClick) {
          suppressClick = false;
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
    el.addEventListener("click", e => {
      if (popover && !popover.contains(e.target)) {
        closePopover();
      }
    });
    return el;
  }

  function renderView() {
    if (!root) {
      return;
    }
    for (const button of root.querySelectorAll(".fz-lib-nav[data-view]")) {
      button.setAttribute("aria-current", String(button.dataset.view === view));
    }
    closePopover();
    stopDownloads();
    if (view === "history") {
      main.replaceChildren(...buildHistoryView());
      loadHistory({ reset: true });
    } else if (view === "downloads") {
      main.replaceChildren(...buildDownloadsView());
      startDownloads();
      window.FirefoxZenDownloadCue?.seen();
    } else if (view === "mods" && window.FirefoxZenMods) {
      main.replaceChildren(window.FirefoxZenMods.buildView());
    } else if (view === "settings" && window.FirefoxZenSettings) {
      main.replaceChildren(window.FirefoxZenSettings.buildView());
    } else {
      main.replaceChildren(...buildSpacesShell());
      renderBoard();
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (drag) {
        cancelDrag();
      } else if (popover) {
        closePopover();
      } else if (picked.size) {
        picked.clear();
        renderBoard();
      } else {
        close();
      }
      return;
    }
    const row = e.target.closest?.(".fz-lib-tab");
    if (row && !e.target.closest("input")) {
      const tab = tabByKey.get(Number(row.dataset.tab));
      if (tab && e.key === "Enter") {
        e.preventDefault();
        activateTab(tab);
      } else if (tab && e.key === "Delete") {
        e.preventDefault();
        gBrowser.removeTab(tab);
      }
    }
  }

  // ---- spaces view ----

  let board = null;

  function buildSpacesShell() {
    const filter = h("input", {
      type: "search",
      class: "fz-lib-search",
      placeholder: "Filter tabs in every space",
      value: filterText,
      oninput: e => {
        filterText = e.target.value.trim().toLowerCase();
        renderBoard();
      },
      onkeydown: e => {
        if (e.key === "Escape" && filterText) {
          e.preventDefault();
          e.stopPropagation();
          e.target.value = filterText = "";
          renderBoard();
        }
      },
    });
    const add = h("button", {
      type: "button",
      class: "fz-lib-button fz-lib-new-space",
      text: "New",
      "aria-haspopup": "menu",
      onclick: e => openNewMenu(e.currentTarget),
    });
    // Shows or hides private spaces everywhere (hiding locks them).
    const shown = !!api()?.privateShown?.();
    const privateToggle = h("button", {
      type: "button",
      class: "fz-lib-button fz-lib-private-toggle",
      text: "Private",
      title: `${shown ? "Hide" : "Show"} private spaces (Ctrl+Alt+P)`,
      "aria-pressed": String(shown),
      onclick: () => api()?.togglePrivate?.(),
    });
    board = h("div", { class: "fz-lib-board-wrap" });
    return [h("header", { class: "fz-lib-toolbar" }, filter, add, privateToggle), board];
  }

  function newSpace(tabs) {
    const id = api().create();
    if (tabs?.length) {
      moveTabsTo(tabs, id, null);
    }
    renameAfterRender = id;
    queueRender();
    return id;
  }

  // New ▾: New Space / New Private Space…, like the footer's + menu.
  const NEW_MENU_ID = "fz-lib-new-menu";

  function openNewMenu(anchor) {
    let menu = document.getElementById(NEW_MENU_ID);
    if (!menu) {
      menu = document.createXULElement("menupopup");
      menu.id = NEW_MENU_ID;
      const item = (label, icon, command) => {
        const mi = document.createXULElement("menuitem");
        mi.setAttribute("label", label);
        mi.setAttribute("image", icon);
        mi.classList.add("menuitem-iconic");
        mi.addEventListener("command", command);
        return mi;
      };
      menu.addEventListener("popupshowing", () => {
        // From a private space's window, new spaces would show up in other
        // windows instead; create them there.
        const inPrivate = !!api()?.ownPrivateId?.();
        for (const mi of menu.children) {
          mi.disabled = inPrivate;
        }
      });
      menu.append(
        item("New Space", "chrome://browser/skin/window.svg", () => newSpace()),
        item("New Private Space…", "chrome://browser/skin/privateBrowsing.svg", () => newPrivateSpace()),
        item("Import…", "chrome://browser/skin/import.svg", () => importSpace())
      );
      document.getElementById("mainPopupSet").append(menu);
    }
    menu.openPopup(anchor, "after_start");
  }

  async function importSpace() {
    const id = await api().importSpace?.();
    if (id) {
      renderBoard();
    }
  }

  // Asks for a password; the new space stays here, unlocked, with its column
  // brought into view.
  async function newPrivateSpace() {
    const id = await api().createPrivate?.();
    if (id) {
      renderBoard();
      board?.querySelector(`.fz-lib-column[data-space="${CSS.escape(id)}"]`)?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
  }

  // Re-render the board, keeping scroll positions and animating rows and
  // columns from where they were (FLIP).
  function renderBoard() {
    if (!root || view !== "spaces" || !board) {
      return;
    }
    if (drag?.started || root.querySelector(".fz-lib-rename")) {
      renderQueued = true;
      return;
    }
    renderQueued = false;
    const toggle = root.querySelector(".fz-lib-private-toggle");
    if (toggle) {
      const shown = !!api()?.privateShown?.();
      toggle.setAttribute("aria-pressed", String(shown));
      toggle.title = `${shown ? "Hide" : "Show"} private spaces (Ctrl+Alt+P)`;
    }
    const before = measure();
    const scroll = saveScroll();

    tabByKey = new Map();
    groupByKey = new Map();
    if (!spacesOn()) {
      board.replaceChildren(
        h(
          "div",
          { class: "fz-lib-empty" },
          h("p", { text: "Spaces is off. Turn it on to arrange your tabs into spaces." }),
          h("button", {
            type: "button",
            class: "fz-lib-button",
            text: "Turn on Spaces",
            onclick: () => Services.prefs.setBoolPref(SPACES_PREF, true),
          })
        )
      );
      return;
    }

    // In the space list's order (the footer's), private spaces included.
    const local = api().list();
    const privates = api().privateList?.() ?? [];
    const order = api().shownIds?.() ?? [];
    const rank = id => {
      const i = order.indexOf(id);
      return i < 0 ? order.length : i;
    };
    const columns = [
      ...local.map(space => [space.id, buildColumn(space)]),
      ...privates.map(space => [space.id, buildPrivateColumn(space)]),
    ]
      .sort((a, b) => rank(a[0]) - rank(b[0]))
      .map(([, column]) => column);
    const newColumn = h(
      "button",
      {
        type: "button",
        class: "fz-lib-column fz-lib-new-column",
        "data-drop": "new-space",
        onclick: () => newSpace(),
      },
      h("span", { class: "fz-lib-new-column-plus", "aria-hidden": "true", text: "+" }),
      h("span", { text: "New space" }),
      h("span", { class: "fz-lib-hint", text: "or drop tabs here" })
    );
    // A private space's window lists just it: no new spaces from here.
    const inPrivate = !!api().ownPrivateId?.();
    board.replaceChildren(
      buildPins(),
      h("div", { class: "fz-lib-board", "data-drop": "board" }, ...columns, inPrivate ? null : newColumn)
    );
    restoreScroll(scroll);
    flip(before);

    if (renameAfterRender) {
      const id = renameAfterRender;
      renameAfterRender = null;
      const column = board.querySelector(`.fz-lib-column[data-space="${CSS.escape(id)}"]`);
      column?.scrollIntoView({ block: "nearest", inline: "nearest" });
      const name = column?.querySelector(".fz-lib-space-name");
      if (name) {
        startRename(id, name);
      }
    }
  }

  function queueRender() {
    if (renderQueued && !drag?.started) {
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      if (renderQueued) {
        renderBoard();
      }
    });
  }

  const matches = tab =>
    !filterText || tab.label.toLowerCase().includes(filterText) || tabUrl(tab).toLowerCase().includes(filterText);

  // Pin limit from JS/firefox-zen-sidebar-tools.uc.js (none without it).
  const pinMax = () => window.FirefoxZenPins?.max ?? Infinity;
  const pinRoom = () => window.FirefoxZenPins?.room() ?? Infinity;

  function buildPins() {
    const pinned = gBrowser.tabs.filter(t => t.pinned && !t.closing);
    const tiles = pinned.map(tab => {
      const key = keyOf(tab);
      tabByKey.set(key, tab);
      return h(
        "button",
        {
          type: "button",
          class: "fz-lib-pinned",
          "data-drag": "tab",
          "data-tab": key,
          "data-key": `tab:${key}`,
          title: tab.label,
          current: tab.selected,
          unloaded: !isLoaded(tab),
          onclick: () => activateTab(tab),
          oncontextmenu: e => openTabMenu(e, tab),
        },
        h("img", { src: tabIcon(tab), alt: "" })
      );
    });
    return h(
      "div",
      { class: "fz-lib-essentials", "data-drop": "pinned", "aria-label": "Pins (pinned tabs)", full: pinRoom() <= 0 },
      h("span", { class: "fz-lib-section-label", text: "Pins" }),
      Number.isFinite(pinMax()) ? h("span", { class: "fz-lib-count", text: `${pinned.length}/${pinMax()}` }) : null,
      ...tiles,
      tiles.length ? null : h("span", { class: "fz-lib-hint", text: "Drop tabs here to pin them in every space" })
    );
  }

  function buildColumn(space) {
    const active = space.id === api().activeId();
    const tabs = api().tabsIn(space.id);
    const container = api().containerInfo(space.id);

    const icon = h("button", {
      type: "button",
      class: "fz-lib-space-icon",
      title: "Change icon",
      text: space.icon || "•",
      onclick: e => {
        e.stopPropagation();
        openIconPicker(space.id, e.currentTarget);
      },
    });
    const name = h("span", {
      class: "fz-lib-space-name",
      tabindex: "0",
      title: "Click to rename",
      text: space.name,
      onclick: e => {
        e.stopPropagation();
        startRename(space.id, e.currentTarget);
      },
      onkeydown: e => {
        if (e.key === "Enter" || e.key === "F2") {
          e.preventDefault();
          startRename(space.id, e.currentTarget);
        }
      },
    });
    const more = h("button", {
      type: "button",
      class: "fz-lib-icon-button fz-lib-more",
      title: "More (container, unload, delete)",
      "aria-label": "More",
      onclick: e => {
        e.stopPropagation();
        api().openMenu(space.id, e);
      },
    });

    const head = h(
      "div",
      {
        class: "fz-lib-column-head",
        "data-drag": "space",
        title: active ? "Current space · drag to reorder" : "Click to switch · drag to reorder",
        onclick: () => api().switchTo(space.id),
      },
      icon,
      name,
      h("span", { class: "fz-lib-count", text: String(tabs.length) }),
      container
        ? h("span", {
            class: "fz-lib-container",
            title: container.label,
            style: `--fz-container-color: ${container.color}`,
          })
        : null,
      more
    );

    const list = h("div", { class: "fz-lib-tabs", "data-scroll-key": `space:${space.id}` });
    const seenGroups = new Set();
    const seenSplits = new Set();
    // The sidebar's line (tab sections): folders and tabs dragged above it
    // first, then the loose tabs. Without tab sections, after the folders.
    const sections = !!window.FirefoxZenTabSections?.active();
    const separator = () => h("div", { class: "fz-lib-separator", "aria-hidden": "true" });
    let lineDrawn = false;
    for (const tab of tabs) {
      if (tab.group) {
        if (seenGroups.has(tab.group)) {
          continue;
        }
        seenGroups.add(tab.group);
        const block = buildGroup(tab.group, tabs.filter(t => t.group === tab.group));
        if (block) {
          list.append(block);
        }
      } else {
        const row = buildRow(tab, seenSplits);
        if (!row) {
          continue;
        }
        const below = sections
          ? !tab.hasAttribute("fz-above")
          : list.lastElementChild?.classList.contains("fz-lib-group");
        if (below && !lineDrawn) {
          list.append(separator());
          lineDrawn = true;
        }
        list.append(row);
      }
    }
    if (!list.children.length) {
      list.append(h("div", { class: "fz-lib-hint fz-lib-column-empty", text: filterText ? "No matches" : "No tabs" }));
    } else if (sections && !lineDrawn) {
      list.append(separator());
    }

    return h(
      "div",
      {
        class: "fz-lib-column",
        "data-space": space.id,
        "data-drop-space": space.id,
        "data-key": `space:${space.id}`,
        active,
      },
      head,
      list
    );
  }

  // A private space's tabs open in its own private window (see
  // firefox-zen-spaces). Locked: blurred placeholder rows and Unlock…, which
  // only decrypts it (no window). Unlocked: its tabs, draggable to other
  // spaces; tabs dropped on it move in. The header opens its window.
  const LOCKED_ROWS = [72, 55, 84, 63, 46];

  function buildPrivateColumn(space) {
    const open = api().isUnlocked(space.id);
    const tabs = open ? api().privateTabs(space.id) : [];
    const unlock = e => {
      e.stopPropagation();
      api().unlockPrivate(space.id);
    };
    const lock = h("button", {
      type: "button",
      class: "fz-lib-icon-button fz-lib-private-badge",
      title: open ? "Lock" : "Locked",
      "aria-label": open ? "Lock" : "Locked",
      onclick: e => {
        e.stopPropagation();
        if (open) {
          api().lockPrivate(space.id);
        } else {
          unlock(e);
        }
      },
    });
    const more = h("button", {
      type: "button",
      class: "fz-lib-icon-button fz-lib-more",
      title: "More (lock, password, delete)",
      "aria-label": "More",
      onclick: e => {
        e.stopPropagation();
        api().openMenu(space.id, e);
      },
    });
    const head = h(
      "div",
      {
        class: "fz-lib-column-head",
        "data-drag": "space",
        title: "Private space · click to open its window · drag to reorder",
        onclick: () => {
          close();
          api().showPrivate(space.id);
        },
      },
      h("span", { class: "fz-lib-space-icon", text: space.icon || "•" }),
      h("span", { class: "fz-lib-space-name", text: space.name }),
      open ? h("span", { class: "fz-lib-count", text: String(tabs.length) }) : null,
      lock,
      more
    );

    const list = h("div", { class: "fz-lib-tabs", "data-scroll-key": `space:${space.id}` });
    if (open) {
      const shown = tabs.filter(
        t => !filterText || t.label.toLowerCase().includes(filterText) || t.url.toLowerCase().includes(filterText)
      );
      for (const t of shown) {
        list.append(
          h(
            "div",
            {
              class: "fz-lib-tab",
              tabindex: "0",
              "data-drag": "private-tab",
              "data-index": String(t.index),
              title: `${t.label}\n${t.url}`,
              current: t.selected,
              unloaded: t.tab ? !isLoaded(t.tab) : true,
              onclick: () => {
                close();
                api().showPrivate(space.id, t.index);
              },
            },
            h("img", { class: "fz-lib-favicon", src: t.image || DEFAULT_FAVICON, alt: "" }),
            h("span", { class: "fz-lib-tab-label", text: t.label })
          )
        );
      }
      if (!list.children.length) {
        list.append(h("div", { class: "fz-lib-hint fz-lib-column-empty", text: filterText ? "No matches" : "No tabs" }));
      }
    } else {
      // Fake rows to blur: the real tabs aren't readable until it's unlocked.
      list.append(
        ...LOCKED_ROWS.map(width =>
          h(
            "div",
            { class: "fz-lib-tab fz-lib-locked-row", "aria-hidden": "true" },
            h("span", { class: "fz-lib-favicon" }),
            h("span", { class: "fz-lib-locked-bar", style: `width: ${width}%` })
          )
        ),
        h("button", { type: "button", class: "fz-lib-button fz-lib-unlock", text: "Unlock…", onclick: unlock })
      );
    }

    return h(
      "div",
      {
        class: "fz-lib-column fz-lib-private-column",
        "data-space": space.id,
        "data-drop-space": space.id,
        "data-key": `space:${space.id}`,
        locked: !open,
      },
      head,
      list
    );
  }

  function buildGroup(group, tabs) {
    const shown = tabs.filter(matches);
    if (filterText && !shown.length && !group.label.toLowerCase().includes(filterText)) {
      return null;
    }
    const key = keyOf(group);
    groupByKey.set(key, group);
    const collapsed = collapsedGroups.has(group.id) && !filterText;
    const seenSplits = new Set();
    const head = h(
      "div",
      {
        class: "fz-lib-group-head",
        "data-drag": "group",
        title: "Click to fold · drag to move the folder",
        onclick: () => {
          if (collapsedGroups.has(group.id)) {
            collapsedGroups.delete(group.id);
          } else {
            collapsedGroups.add(group.id);
          }
          renderBoard();
        },
      },
      h("span", { class: "fz-lib-chevron", "aria-hidden": "true" }),
      h("span", { class: "fz-lib-folder", "aria-hidden": "true" }),
      h("span", { class: "fz-lib-group-label", text: group.label || "Unnamed folder" }),
      h("span", { class: "fz-lib-count", text: String(tabs.length) })
    );
    return h(
      "div",
      {
        class: "fz-lib-group",
        "data-group": key,
        "data-key": `group:${key}`,
        collapsed,
        "data-color": group.color,
        style: `--fz-group-color: var(--tab-group-${group.color}, currentColor)`,
      },
      head,
      collapsed ? null : h("div", { class: "fz-lib-group-tabs" }, ...tabs.map(t => buildRow(t, seenSplits)))
    );
  }

  // A tab's row, or its split view's tabs side by side as in the sidebar
  // (once per split view: seenSplits). Null when the filter hides it.
  function buildRow(tab, seenSplits) {
    const split = tab.splitview;
    if (!split) {
      return matches(tab) ? buildTabRow(tab) : null;
    }
    if (seenSplits.has(split)) {
      return null;
    }
    seenSplits.add(split);
    const tabs = split.tabs;
    if (!tabs.some(matches)) {
      return null;
    }
    return h("div", { class: "fz-lib-split", current: tabs.some(t => t.selected) }, ...tabs.map(buildTabRow));
  }

  function buildTabRow(tab) {
    const key = keyOf(tab);
    tabByKey.set(key, tab);
    return h(
      "div",
      {
        class: "fz-lib-tab",
        tabindex: "0",
        "data-drag": "tab",
        "data-tab": key,
        "data-key": `tab:${key}`,
        title: `${tab.label}\n${tabUrl(tab)}`,
        current: tab.selected,
        picked: picked.has(tab),
        unloaded: !isLoaded(tab),
        onclick: e => onTabClick(e, tab),
        oncontextmenu: e => openTabMenu(e, tab),
        onauxclick: e => {
          if (e.button === 1) {
            e.preventDefault();
            gBrowser.removeTab(tab);
          }
        },
      },
      h("img", { class: "fz-lib-favicon", src: tabIcon(tab), alt: "" }),
      h("span", { class: "fz-lib-tab-label", text: tab.label }),
      h("button", {
        type: "button",
        class: "fz-lib-icon-button fz-lib-close-tab",
        title: "Close tab",
        "aria-label": "Close tab",
        onclick: e => {
          e.stopPropagation();
          gBrowser.removeTab(tab);
        },
      })
    );
  }

  function onTabClick(e, tab) {
    if (e.ctrlKey || e.metaKey) {
      if (picked.has(tab)) {
        picked.delete(tab);
      } else {
        picked.add(tab);
      }
      pickAnchor = tab;
      renderBoard();
    } else if (e.shiftKey && pickAnchor && !pickAnchor.closing) {
      const rows = [...board.querySelectorAll(".fz-lib-tab")].map(r => tabByKey.get(Number(r.dataset.tab)));
      const a = rows.indexOf(pickAnchor);
      const b = rows.indexOf(tab);
      if (a >= 0 && b >= 0) {
        picked.clear();
        for (const t of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) {
          picked.add(t);
        }
        renderBoard();
      }
    } else {
      activateTab(tab);
    }
  }

  // Firefox's tab menu, as on the sidebar's tabs. It takes its tab from
  // triggerNode.tab (see TabContextMenu.updateContextMenu).
  function openTabMenu(e, tab) {
    e.preventDefault();
    e.stopPropagation();
    e.target.tab = tab;
    document.getElementById("tabContextMenu")?.openPopupAtScreen(e.screenX, e.screenY, true, e);
  }

  function activateTab(tab) {
    close();
    if (api()) {
      api().selectTab(tab);
    } else {
      gBrowser.selectedTab = tab;
    }
  }

  // ---- rename / icon picker ----

  function startRename(id, label) {
    const space = api().list().find(s => s.id === id);
    if (!space || !label.isConnected) {
      return;
    }
    const input = h("input", { class: "fz-lib-rename", type: "text", value: space.name, "aria-label": "Space name" });
    let done = false;
    const finish = save => {
      if (done) {
        return;
      }
      done = true;
      const value = input.value.trim();
      if (input.isConnected) {
        input.replaceWith(label);
      }
      if (save && value) {
        api().rename(id, value);
      }
      if (renderQueued) {
        renderBoard();
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
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", e => e.stopPropagation());
    input.addEventListener("pointerdown", e => e.stopPropagation());
    label.replaceWith(input);
    input.focus();
    input.select();
  }

  let popover = null;

  function closePopover() {
    popover?.remove();
    popover = null;
  }

  function openIconPicker(id, anchor) {
    closePopover();
    const choose = icon => {
      closePopover();
      api().setIcon(id, icon);
    };
    const custom = h("input", {
      type: "text",
      class: "fz-lib-icon-input",
      placeholder: "Any emoji or 2 letters",
      maxlength: "8",
      onkeydown: e => {
        e.stopPropagation();
        if (e.key === "Enter" && e.target.value.trim()) {
          choose(e.target.value.trim());
        } else if (e.key === "Escape") {
          closePopover();
          anchor.focus();
        }
      },
    });
    popover = h(
      "div",
      { class: "fz-lib-popover", role: "dialog", "aria-label": "Choose an icon" },
      h(
        "div",
        { class: "fz-lib-icon-grid" },
        ...ICONS.map(icon =>
          h("button", { type: "button", class: "fz-lib-icon-choice", text: icon, onclick: () => choose(icon) })
        )
      ),
      custom
    );
    root.append(popover);
    const r = anchor.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const left = Math.min(r.left - box.left, box.width - popover.offsetWidth - 8);
    popover.style.left = `${Math.max(8, left)}px`;
    popover.style.top = `${r.bottom - box.top + 6}px`;
    popover.addEventListener("click", e => e.stopPropagation());
    popover.addEventListener("pointerdown", e => e.stopPropagation());
    custom.focus();
  }

  // ---- scroll + FLIP ----

  function saveScroll() {
    const saved = new Map();
    for (const el of root.querySelectorAll("[data-scroll-key], .fz-lib-board")) {
      saved.set(el.dataset.scrollKey ?? "board", { left: el.scrollLeft, top: el.scrollTop });
    }
    return saved;
  }

  function restoreScroll(saved) {
    for (const el of root.querySelectorAll("[data-scroll-key], .fz-lib-board")) {
      const pos = saved.get(el.dataset.scrollKey ?? "board");
      if (pos) {
        el.scrollLeft = pos.left;
        el.scrollTop = pos.top;
      }
    }
  }

  function measure() {
    const rects = new Map();
    if (root && !reducedMotion.matches) {
      for (const el of root.querySelectorAll("[data-key]")) {
        rects.set(el.dataset.key, el.getBoundingClientRect());
      }
    }
    return rects;
  }

  function flip(before) {
    if (!before.size) {
      return;
    }
    for (const el of root.querySelectorAll("[data-key]")) {
      const old = before.get(el.dataset.key);
      if (!old) {
        continue;
      }
      const now = el.getBoundingClientRect();
      const dx = old.left - now.left;
      const dy = old.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        continue;
      }
      // Rows inside a moved column move with it: only animate the outermost.
      const parent = el.parentElement?.closest("[data-key]");
      if (parent && before.has(parent.dataset.key)) {
        const p0 = before.get(parent.dataset.key);
        const p1 = parent.getBoundingClientRect();
        if (Math.abs(p0.left - p1.left - dx) < 1 && Math.abs(p0.top - p1.top - dy) < 1) {
          continue;
        }
      }
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 200,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
    }
  }

  // ---- drag and drop ----
  // drag = { kind: "tab" | "group" | "space" | "history" | "private-tab", source, x0, y0,
  //          pointerId, started, ghost, indicator, payload, target }

  function onPointerDown(e) {
    if (e.button !== 0 || drag) {
      return;
    }
    const source = e.target.closest("[data-drag]");
    if (!source || e.target.closest("input, .fz-lib-icon-button, .fz-lib-space-icon, .fz-lib-space-name, .fz-lib-popover")) {
      return;
    }
    drag = { kind: source.dataset.drag, source, x0: e.clientX, y0: e.clientY, pointerId: e.pointerId, started: false };
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < DRAG_THRESHOLD) {
        return;
      }
      if (!startDrag()) {
        drag = null;
        return;
      }
      root.setPointerCapture(e.pointerId);
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    moveGhost();
    updateTarget();
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    const d = drag;
    if (!d.started) {
      drag = null;
      return;
    }
    suppressClick = true;
    // A click event may not follow (released outside the panel).
    setTimeout(() => (suppressClick = false), 0);
    const target = d.target;
    endDrag();
    if (target) {
      try {
        drop(d, target);
      } catch (ex) {
        console.error("firefox-zen-library: drop failed", ex);
      }
    }
    if (renderQueued || view === "spaces") {
      renderBoard();
    }
  }

  function startDrag() {
    const d = drag;
    let label = "";
    let icon = null;
    switch (d.kind) {
      case "tab": {
        const tab = tabByKey.get(Number(d.source.dataset.tab));
        if (!tab || tab.closing) {
          return false;
        }
        const tabs = picked.has(tab) ? [...picked].filter(t => !t.closing) : [tab];
        tabs.sort((a, b) => a._tPos - b._tPos);
        d.payload = tabs;
        label = tabs.length > 1 ? `${tabs.length} tabs` : tab.label;
        icon = tabIcon(tab);
        for (const t of tabs) {
          board?.querySelector(`[data-tab="${keyOf(t)}"]`)?.classList.add("fz-lib-dragging");
        }
        break;
      }
      case "group": {
        const block = d.source.closest(".fz-lib-group");
        const group = groupByKey.get(Number(block?.dataset.group));
        if (!group) {
          return false;
        }
        d.payload = group;
        label = group.label || "Folder";
        block.classList.add("fz-lib-dragging");
        break;
      }
      case "space": {
        const column = d.source.closest(".fz-lib-column");
        const space = [...api().list(), ...(api().privateList?.() ?? [])].find(s => s.id === column?.dataset.space);
        if (!space) {
          return false;
        }
        d.payload = space.id;
        label = `${space.icon || ""} ${space.name}`.trim();
        column.classList.add("fz-lib-dragging");
        break;
      }
      case "private-tab": {
        const column = d.source.closest(".fz-lib-column");
        d.payload = { spaceId: column?.dataset.space, index: Number(d.source.dataset.index) };
        if (!d.payload.spaceId) {
          return false;
        }
        label = d.source.querySelector(".fz-lib-tab-label")?.textContent ?? "";
        icon = d.source.querySelector("img")?.src ?? null;
        d.source.classList.add("fz-lib-dragging");
        break;
      }
      case "history": {
        d.payload = { url: d.source.dataset.url, title: d.source.dataset.title };
        label = d.payload.title || d.payload.url;
        icon = `page-icon:${d.payload.url}`;
        if (spacesOn()) {
          main.querySelector(".fz-lib-drop-spaces")?.setAttribute("shown", "");
        }
        break;
      }
      default:
        return false;
    }
    d.started = true;
    root.setAttribute("dragging", d.kind);
    closePopover();
    d.ghost = h(
      "div",
      { class: "fz-lib-ghost" },
      icon ? h("img", { src: icon, alt: "" }) : null,
      h("span", { text: label })
    );
    d.indicator = h("div", { class: "fz-lib-indicator", hidden: true });
    root.append(d.ghost, d.indicator);
    d.scrollTimer = setInterval(autoScroll, 16);
    return true;
  }

  function moveGhost() {
    const box = root.getBoundingClientRect();
    drag.ghost.style.transform = `translate(${drag.x - box.left + 12}px, ${drag.y - box.top + 8}px)`;
  }

  function endDrag() {
    const d = drag;
    drag = null;
    if (!d) {
      return;
    }
    clearInterval(d.scrollTimer);
    d.ghost?.remove();
    d.indicator?.remove();
    setDropHighlight(null);
    if (root) {
      root.removeAttribute("dragging");
      root.querySelector(".fz-lib-essentials[refusing]")?.removeAttribute("refusing");
      for (const el of root.querySelectorAll(".fz-lib-dragging")) {
        el.classList.remove("fz-lib-dragging");
      }
      main?.querySelector(".fz-lib-drop-spaces")?.removeAttribute("shown");
      if (root.hasPointerCapture?.(d.pointerId)) {
        root.releasePointerCapture(d.pointerId);
      }
    }
  }

  function cancelDrag() {
    const started = drag?.started;
    endDrag();
    if (started && renderQueued) {
      renderBoard();
    }
  }

  // Scroll the column / board / history list under the pointer when near an edge.
  function autoScroll() {
    if (!drag?.started) {
      return;
    }
    const hit = document.elementFromPoint(drag.x, drag.y);
    for (const el of [hit?.closest(".fz-lib-tabs, .fz-lib-history-list"), root.querySelector(".fz-lib-board")]) {
      if (!el) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (drag.x < r.left || drag.x > r.right || drag.y < r.top || drag.y > r.bottom) {
        continue;
      }
      if (el.classList.contains("fz-lib-board")) {
        if (drag.x < r.left + SCROLL_EDGE) {
          el.scrollLeft -= SCROLL_STEP;
        } else if (drag.x > r.right - SCROLL_EDGE) {
          el.scrollLeft += SCROLL_STEP;
        }
      } else if (drag.y < r.top + SCROLL_EDGE) {
        el.scrollTop -= SCROLL_STEP;
      } else if (drag.y > r.bottom - SCROLL_EDGE) {
        el.scrollTop += SCROLL_STEP;
      }
    }
  }

  let highlighted = null;

  function setDropHighlight(el) {
    if (highlighted !== el) {
      highlighted?.classList.remove("fz-lib-drop-target");
      el?.classList.add("fz-lib-drop-target");
      highlighted = el;
    }
  }

  function showIndicator(rect, vertical) {
    const box = root.getBoundingClientRect();
    const ind = drag.indicator;
    ind.hidden = false;
    ind.toggleAttribute("vertical", vertical);
    if (vertical) {
      ind.style.left = `${rect.x - box.left - 1}px`;
      ind.style.top = `${rect.top - box.top}px`;
      ind.style.width = "";
      ind.style.height = `${rect.height}px`;
    } else {
      ind.style.left = `${rect.left - box.left}px`;
      ind.style.top = `${rect.y - box.top - 1}px`;
      ind.style.width = `${rect.width}px`;
      ind.style.height = "";
    }
  }

  // What's under the pointer: the element, looking into the sidebar's shadow
  // DOM for the footer's space buttons.
  function hitTest(x, y) {
    let el = document.elementFromPoint(x, y);
    if (el?.localName === "sidebar-main" && el.shadowRoot) {
      el = el.shadowRoot.elementFromPoint(x, y) ?? el;
    }
    return el;
  }

  // Sets drag.target (or null) and draws the indicator / highlight for it.
  function updateTarget() {
    const d = drag;
    d.target = null;
    d.indicator.hidden = true;
    const hit = hitTest(d.x, d.y);
    let highlight = null;

    const footerSpace = hit?.closest?.(".fz-space[data-id]");
    const chip = hit?.closest?.(".fz-lib-drop-space-chip");
    if ((footerSpace || chip) && d.kind !== "space") {
      const id = footerSpace?.dataset.id ?? chip.dataset.dropSpace;
      d.target = { space: id };
      setDropHighlight(footerSpace ?? chip);
      return;
    }

    if (d.kind === "space") {
      const boardEl = hit?.closest?.(".fz-lib-board");
      if (boardEl) {
        const columns = [...boardEl.querySelectorAll(".fz-lib-column[data-space]")].filter(
          c => c.dataset.space !== d.payload
        );
        let index = columns.findIndex(c => {
          const r = c.getBoundingClientRect();
          return d.x < r.left + r.width / 2;
        });
        if (index < 0) {
          index = columns.length;
        }
        d.target = { beforeSpace: columns[index]?.dataset.space ?? null };
        const ref = columns[index] ?? columns.at(-1);
        if (ref) {
          const r = ref.getBoundingClientRect();
          const gap = 6;
          showIndicator(
            { x: columns[index] ? r.left - gap : r.right + gap, top: r.top, height: r.height },
            true
          );
        }
      }
      setDropHighlight(null);
      return;
    }

    if (d.kind === "history") {
      setDropHighlight(null);
      return;
    }

    // A private space's tab: to any other space (no exact spot), or a new one.
    if (d.kind === "private-tab") {
      const column = hit?.closest?.(".fz-lib-column[data-space]");
      const newColumn = hit?.closest?.(".fz-lib-new-column");
      if (newColumn) {
        d.target = { newSpace: true };
      } else if (column && column.dataset.space !== d.payload.spaceId) {
        d.target = { space: column.dataset.space };
      }
      setDropHighlight(d.target ? newColumn ?? column : null);
      return;
    }

    // Tabs and folders. A private space's column takes them, without a spot.
    const privateColumn = hit?.closest?.(".fz-lib-private-column");
    if (privateColumn) {
      d.target = { space: privateColumn.dataset.space };
      setDropHighlight(privateColumn);
      return;
    }
    const pinned = hit?.closest?.(".fz-lib-essentials");
    // Full: pinned tabs can still be reordered, new ones don't fit.
    if (pinned && d.kind === "tab" && d.payload.filter(t => !t.pinned).length > pinRoom()) {
      pinned.setAttribute("refusing", "");
      setDropHighlight(null);
      return;
    }
    root.querySelector(".fz-lib-essentials[refusing]")?.removeAttribute("refusing");
    if (pinned && d.kind === "tab") {
      const tiles = [...pinned.querySelectorAll(".fz-lib-pinned:not(.fz-lib-dragging)")];
      const index = tiles.findIndex(t => {
        const r = t.getBoundingClientRect();
        return d.x < r.left + r.width / 2;
      });
      const ref = tiles[index] ?? null;
      d.target = { pinned: true, before: ref ? tabByKey.get(Number(ref.dataset.tab)) : null };
      const last = tiles.at(-1);
      if (ref || last) {
        const r = (ref ?? last).getBoundingClientRect();
        showIndicator({ x: ref ? r.left - 3 : r.right + 3, top: r.top, height: r.height }, true);
      }
      highlight = pinned;
    } else if (hit?.closest?.(".fz-lib-new-column")) {
      d.target = { newSpace: true };
      highlight = hit.closest(".fz-lib-new-column");
    } else {
      const column = hit?.closest?.(".fz-lib-column[data-space]");
      if (column) {
        highlight = column;
        d.target = d.kind === "group" ? groupTarget(column) : tabTarget(column, hit);
      }
    }
    setDropHighlight(highlight);
  }

  // Where tabs would land in `column`: { space, before?: tab, after?: tab,
  // group?: group (join it) }.
  function tabTarget(column, hit) {
    const d = drag;
    const space = column.dataset.space;
    const groupHead = hit.closest(".fz-lib-group-head");
    if (groupHead) {
      const block = groupHead.closest(".fz-lib-group");
      const group = groupByKey.get(Number(block.dataset.group));
      if (group) {
        const r = groupHead.getBoundingClientRect();
        showIndicator({ left: r.left, y: r.bottom, width: r.width }, false);
        return { space, group, intoGroup: true };
      }
    }
    // Tab sections: between the last item above the line and the line itself,
    // right after that item (above the line); elsewhere, above or below it by
    // the pointer (unless joining a folder)
    const separator = window.FirefoxZenTabSections?.active()
      ? column.querySelector(".fz-lib-tabs > .fz-lib-separator")
      : null;
    if (!separator) {
      return tabSpot(column);
    }
    const line = separator.getBoundingClientRect();
    const lineMiddle = line.top + line.height / 2;
    const aboveItem = separator.previousElementSibling;
    const lastRow = aboveItem?.classList.contains("fz-lib-group")
      ? (aboveItem.querySelector(".fz-lib-group-tabs > :last-child") ?? aboveItem.querySelector(".fz-lib-group-head"))
      : aboveItem;
    const lastRect = lastRow?.getBoundingClientRect();
    if (d.y <= lineMiddle && (!lastRect || d.y > lastRect.top + lastRect.height / 2)) {
      const list = column.querySelector(".fz-lib-tabs").getBoundingClientRect();
      showIndicator({ left: list.left + 4, y: line.top - 1, width: list.width - 8 }, false);
      const rowTab = row => row && tabByKey.get(Number(row.dataset.tab));
      if (aboveItem?.classList.contains("fz-lib-group")) {
        return { space, after: groupByKey.get(Number(aboveItem.dataset.group)), group: null, above: true };
      }
      if (aboveItem) {
        // A tab row, or a split view's (its last tab)
        const after = rowTab(aboveItem.classList.contains("fz-lib-tab") ? aboveItem : aboveItem.querySelector(".fz-lib-tab:last-child"));
        return { space, after, group: null, above: true };
      }
      const next = separator.nextElementSibling;
      const before = rowTab(next?.classList.contains("fz-lib-tab") ? next : next?.querySelector(".fz-lib-tab"));
      return before ? { space, before, group: null, above: true } : { space, above: true };
    }
    const spot = tabSpot(column);
    if (!spot.intoGroup) {
      spot.above = d.y < lineMiddle;
    }
    return spot;
  }

  function tabSpot(column) {
    const d = drag;
    const space = column.dataset.space;
    const rows = [...column.querySelectorAll(".fz-lib-tab:not(.fz-lib-dragging)")];
    const index = rows.findIndex(row => {
      const r = row.getBoundingClientRect();
      return d.y < r.top + r.height / 2;
    });
    const list = column.querySelector(".fz-lib-tabs").getBoundingClientRect();
    if (index >= 0) {
      const row = rows[index];
      const tab = tabByKey.get(Number(row.dataset.tab));
      const r = row.getBoundingClientRect();
      showIndicator({ left: r.left, y: r.top - 1, width: r.width }, false);
      return { space, before: tab, group: tab.group ?? null };
    }
    const last = rows.at(-1);
    if (last) {
      const tab = tabByKey.get(Number(last.dataset.tab));
      const r = last.getBoundingClientRect();
      showIndicator({ left: list.left + 4, y: r.bottom + 1, width: list.width - 8 }, false);
      // Below the last row: loose, after it (or after its folder).
      return { space, after: tab.group ?? tab, group: null };
    }
    showIndicator({ left: list.left + 4, y: list.top + 4, width: list.width - 8 }, false);
    return { space };
  }

  // Folders go between folders (they stay above the loose tabs).
  function groupTarget(column) {
    const d = drag;
    const space = column.dataset.space;
    const blocks = [...column.querySelectorAll(".fz-lib-group:not(.fz-lib-dragging)")];
    const index = blocks.findIndex(b => {
      const r = b.getBoundingClientRect();
      return d.y < r.top + r.height / 2;
    });
    const list = column.querySelector(".fz-lib-tabs").getBoundingClientRect();
    if (index >= 0) {
      const r = blocks[index].getBoundingClientRect();
      showIndicator({ left: r.left, y: r.top - 1, width: r.width }, false);
      return { space, before: groupByKey.get(Number(blocks[index].dataset.group)) };
    }
    const firstLoose = column.querySelector(
      ":is(.fz-lib-tabs, .fz-lib-tabs > .fz-lib-split) > .fz-lib-tab:not(.fz-lib-dragging)"
    );
    if (firstLoose) {
      const r = firstLoose.getBoundingClientRect();
      showIndicator({ left: r.left, y: r.top - 1, width: r.width }, false);
      return { space, before: tabByKey.get(Number(firstLoose.dataset.tab)) };
    }
    const last = blocks.at(-1);
    if (last) {
      const r = last.getBoundingClientRect();
      showIndicator({ left: r.left, y: r.bottom + 1, width: r.width }, false);
      return { space, after: groupByKey.get(Number(last.dataset.group)) };
    }
    showIndicator({ left: list.left + 4, y: list.top + 4, width: list.width - 8 }, false);
    return { space };
  }

  function drop(d, target) {
    switch (d.kind) {
      case "space": {
        // The columns' order, private ones included.
        const ids = [...board.querySelectorAll(".fz-lib-column[data-space]")]
          .map(c => c.dataset.space)
          .filter(id => id !== d.payload);
        const index = target.beforeSpace ? ids.indexOf(target.beforeSpace) : ids.length;
        ids.splice(index < 0 ? ids.length : index, 0, d.payload);
        api().reorder(ids);
        break;
      }
      case "history":
        if (target.space && api().isPrivate?.(target.space)) {
          api().openInPrivate(target.space, d.payload.url, d.payload.title);
        } else if (target.space) {
          openUrl(d.payload.url, { spaceId: target.space, background: true });
        }
        break;
      case "private-tab": {
        const to = target.newSpace ? newSpace() : target.space;
        if (to && to !== d.payload.spaceId) {
          api().movePrivateTabs(d.payload.spaceId, [d.payload.index], to);
        }
        break;
      }
      case "group":
        if (target.newSpace) {
          moveGroupTo(d.payload, newSpace(), {});
        } else if (target.space) {
          moveGroupTo(d.payload, target.space, target);
        }
        break;
      case "tab": {
        const tabs = d.payload.filter(t => !t.closing);
        if (!tabs.length) {
          break;
        }
        if (target.pinned) {
          pinTabs(tabs, target.before);
        } else if (target.newSpace) {
          newSpace(tabs);
        } else if (target.space) {
          moveTabsTo(tabs, target.space, target);
        }
        picked.clear();
        break;
      }
    }
  }

  // Unpin, move into `spaceId`, then place: into a folder, before/after a
  // tab or folder, or (no place) wherever they are.
  function moveTabsTo(tabs, spaceId, place) {
    // Into a private space: its own window takes them, wherever they were.
    if (spacesOn() && api().isPrivate?.(spaceId)) {
      api().moveTabs(tabs, spaceId);
      return;
    }
    for (const tab of tabs) {
      if (tab.pinned) {
        gBrowser.unpinTab(tab);
      }
    }
    if (spacesOn()) {
      api().moveTabs(tabs, spaceId);
    }
    if (!place) {
      return;
    }
    const moving = tabs.filter(t => t !== place.before && t !== place.after);
    if (place.intoGroup) {
      place.group.addTabs(moving);
      return;
    }
    // Leaving a folder for a loose spot (or another folder).
    for (const tab of moving) {
      if (tab.group && tab.group !== place.group) {
        gBrowser.ungroupTab(tab);
      }
    }
    if (place.group && moving.some(t => t.group !== place.group)) {
      place.group.addTabs(moving.filter(t => t.group !== place.group));
    }
    if (place.before) {
      gBrowser.moveTabsBefore(moving, place.before);
    } else if (place.after) {
      gBrowser.moveTabsAfter(moving, place.after);
    }
    // Landing right after a folder can pull a tab into it; take it back out.
    for (const tab of moving) {
      if (tab.group && tab.group !== place.group) {
        gBrowser.ungroupTab(tab);
      }
    }
    if (place.above !== undefined) {
      window.FirefoxZenTabSections?.setAbove(tabs, place.above);
    }
  }

  function moveGroupTo(group, spaceId, place) {
    if (spacesOn()) {
      api().moveTabs(group.tabs, spaceId);
    }
    if (place.before && place.before !== group) {
      gBrowser.moveTabsBefore([group], place.before);
    } else if (place.after && place.after !== group) {
      gBrowser.moveTabsAfter([group], place.after);
    }
  }

  function pinTabs(tabs, before) {
    // As many as the pin limit leaves room for.
    let room = pinRoom();
    tabs = tabs.filter(t => t.pinned || room-- > 0);
    for (const tab of tabs) {
      if (tab.group) {
        gBrowser.ungroupTab(tab);
      }
      if (!tab.pinned) {
        gBrowser.pinTab(tab);
      }
    }
    const moving = tabs.filter(t => t !== before);
    if (before) {
      gBrowser.moveTabsBefore(moving, before);
    } else {
      const lastPinned = gBrowser.tabs.filter(t => t.pinned && !moving.includes(t)).at(-1);
      if (lastPinned) {
        gBrowser.moveTabsAfter(moving, lastPinned);
      }
    }
  }

  // ---- history / downloads source: all spaces, or one unlocked private space ----
  // A private space keeps its own (encrypted) history and downloads list,
  // never mixed into Firefox's; this picks which list the view shows.

  let historySource = "";
  let dlSource = "";
  // A private space's own window starts on its own history and downloads.
  let sourcesDefaulted = false;

  function defaultSources() {
    if (!sourcesDefaulted && spacesOn()) {
      sourcesDefaulted = true;
      historySource = dlSource = api().ownPrivateId?.() ?? "";
    }
  }

  // The private space a source names, if it's still unlocked and shown.
  function privateSource(id) {
    return id && spacesOn() ? (api().unlockedPrivate?.() ?? []).find(s => s.id === id) ?? null : null;
  }

  function buildSourcePicker(current, onPick) {
    const spaces = spacesOn() ? (api().unlockedPrivate?.() ?? []) : [];
    if (!spaces.length) {
      return null;
    }
    const select = h(
      "select",
      { class: "fz-lib-source", "aria-label": "Show", onchange: e => onPick(e.target.value) },
      h("option", { value: "", text: "All spaces" }),
      ...spaces.map(space => h("option", { value: space.id, text: `${space.icon} ${space.name} (private)` }))
    );
    select.value = privateSource(current) ? current : "";
    return select;
  }

  // ---- history view ----

  let historyQuery = "";
  let privateHistoryTimer = null;
  let historyOffset = 0;
  let historyDone = false;
  let historyLoading = false;
  let historyToken = 0;
  let historyList = null;
  let historyLastDay = null;
  let searchTimer = null;

  function buildHistoryView() {
    const search = h("input", {
      type: "search",
      class: "fz-lib-search",
      placeholder: "Search history",
      value: historyQuery,
      oninput: e => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          historyQuery = e.target.value.trim();
          loadHistory({ reset: true });
        }, 150);
      },
      onkeydown: e => {
        if (e.key === "Escape" && e.target.value) {
          e.preventDefault();
          e.stopPropagation();
          e.target.value = historyQuery = "";
          loadHistory({ reset: true });
        }
      },
    });
    defaultSources();
    if (!privateSource(historySource)) {
      historySource = "";
    }
    const source = buildSourcePicker(historySource, id => {
      historySource = id;
      renderView();
    });
    // A private space's history is cleared with Clear and Lock.
    const clear = historySource
      ? null
      : h("button", {
          type: "button",
          class: "fz-lib-button",
          text: "Clear recent history…",
          onclick: () => document.getElementById("Tools:Sanitize")?.doCommand(),
        });
    historyList = h("div", {
      class: "fz-lib-history-list",
      onscroll: e => {
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) {
          loadHistory();
        }
      },
    });
    const chips = spacesOn()
      ? api()
          .list()
          .map(space =>
            h(
              "div",
              { class: "fz-lib-drop-space-chip", "data-drop-space": space.id },
              h("span", { text: space.icon || "•" }),
              h("span", { text: space.name })
            )
          )
      : [];
    return [
      h("header", { class: "fz-lib-toolbar" }, search, source, clear),
      h(
        "div",
        { class: "fz-lib-history-body" },
        h("div", { class: "fz-lib-drop-spaces" }, h("span", { class: "fz-lib-section-label", text: "Open in" }), ...chips),
        historyList
      ),
    ];
  }

  async function queryHistory(text, offset) {
    if (historySource) {
      const q = text.toLowerCase();
      return api()
        .privateHistory(historySource)
        .filter(v => !q || v.url.toLowerCase().includes(q) || (v.title ?? "").toLowerCase().includes(q))
        .slice(offset, offset + HISTORY_PAGE);
    }
    const db = await PlacesUtils.promiseDBConnection();
    let where = "h.last_visit_date NOT NULL AND h.hidden = 0";
    const params = { limit: HISTORY_PAGE, offset };
    if (text) {
      where += " AND (h.url LIKE :q ESCAPE '/' OR h.title LIKE :q ESCAPE '/')";
      params.q = `%${db.escapeStringForLIKE(text, "/")}%`;
    }
    const rows = await db.execute(
      `SELECT h.url, h.title, h.last_visit_date FROM moz_places h
       WHERE ${where} ORDER BY h.last_visit_date DESC LIMIT :limit OFFSET :offset`,
      params
    );
    return rows.map(r => ({
      url: r.getResultByName("url"),
      title: r.getResultByName("title"),
      time: r.getResultByName("last_visit_date") / 1000,
    }));
  }

  const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

  function dayLabel(time) {
    const day = new Date(time);
    day.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - day) / 86400000);
    return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : dayFormat.format(day);
  }

  async function loadHistory({ reset = false } = {}) {
    if (!historyList) {
      return;
    }
    if (reset) {
      historyToken++;
      historyOffset = 0;
      historyDone = false;
      historyLoading = false;
      historyLastDay = null;
      historyList.replaceChildren();
      historyList.scrollTop = 0;
    }
    if (historyLoading || historyDone) {
      return;
    }
    historyLoading = true;
    const token = historyToken;
    let entries;
    try {
      entries = await queryHistory(historyQuery, historyOffset);
    } catch (ex) {
      console.error("firefox-zen-library: history query failed", ex);
      entries = [];
    }
    if (token !== historyToken || !historyList?.isConnected) {
      return;
    }
    historyLoading = false;
    historyOffset += entries.length;
    historyDone = entries.length < HISTORY_PAGE;
    for (const entry of entries) {
      const day = dayLabel(entry.time);
      if (day !== historyLastDay) {
        historyLastDay = day;
        historyList.append(h("h3", { class: "fz-lib-day", text: day }));
      }
      historyList.append(buildHistoryRow(entry));
    }
    if (!historyList.children.length) {
      historyList.append(
        h("div", { class: "fz-lib-empty", text: historyQuery ? "No history matches your search." : "No history yet." })
      );
    }
  }

  function buildHistoryRow(entry) {
    const host = URL.parse(entry.url)?.host ?? "";
    const row = h(
      "div",
      {
        class: "fz-lib-history-row",
        tabindex: "0",
        "data-drag": "history",
        "data-url": entry.url,
        "data-title": entry.title ?? "",
        title: entry.url,
        onclick: e => openUrl(entry.url, { spaceId: historySource || null, background: e.ctrlKey || e.metaKey }),
        onauxclick: e => {
          if (e.button === 1) {
            e.preventDefault();
            openUrl(entry.url, { spaceId: historySource || null, background: true });
          }
        },
        onkeydown: e => {
          if (e.key === "Enter") {
            openUrl(entry.url, { spaceId: historySource || null });
          } else if (e.key === "Delete") {
            removeHistory(entry.url, row);
          }
        },
      },
      h("img", { class: "fz-lib-favicon", src: historySource ? DEFAULT_FAVICON : `page-icon:${entry.url}`, alt: "" }),
      h("span", { class: "fz-lib-history-title", text: entry.title || entry.url }),
      h("span", { class: "fz-lib-history-host", text: host }),
      h("span", { class: "fz-lib-history-time", text: timeFormat.format(entry.time) }),
      h("button", {
        type: "button",
        class: "fz-lib-icon-button fz-lib-close-tab",
        title: "Delete from history",
        "aria-label": "Delete from history",
        onclick: e => {
          e.stopPropagation();
          removeHistory(entry.url, row);
        },
      })
    );
    return row;
  }

  function removeHistory(url, row) {
    if (historySource) {
      api().removePrivateHistory(historySource, url);
    } else {
      PlacesUtils.history.remove(url).catch(ex => console.error("firefox-zen-library:", ex));
    }
    const prev = row.previousElementSibling;
    const next = row.nextElementSibling;
    row.remove();
    // Drop a day heading left with no entries.
    if (prev?.classList.contains("fz-lib-day") && (!next || next.classList.contains("fz-lib-day"))) {
      prev.remove();
    }
  }

  // Opens `url` in a new tab in a space (the current one by default), in that
  // space's container.
  function openUrl(url, { spaceId = null, background = false } = {}) {
    const spaces = spacesOn() ? api() : null;
    const space = spaceId ?? spaces?.activeId();
    // Never load it outside a private space: it's added there, then shown.
    if (space && spaces?.isPrivate?.(space)) {
      spaces
        .openInPrivate(space, url)
        .then(() => {
          if (!background) {
            close();
            spaces.showPrivate(space, spaces.privateTabs(space).length - 1);
          }
        })
        .catch(ex => console.error("firefox-zen-library:", ex));
      return;
    }
    const tab = gBrowser.addTrustedTab(url, {
      inBackground: true,
      userContextId: (space && spaces?.containerInfo(space)?.id) || 0,
    });
    if (spaces && space) {
      spaces.moveTabs([tab], space);
    }
    if (!background) {
      activateTab(tab);
    }
  }

  // ---- downloads view ----
  // Firefox's download list (Downloads.PUBLIC: private ones belong to private
  // spaces, below), kept live with a list view while
  // the view is shown. Failed downloads are marked [attention] (yellow), like
  // Firefox's own lists (theme/downloads.css).

  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");

  let dlList = null;
  let dlView = null;
  let dlListEl = null;
  let dlQuery = "";
  // Download -> row, for the downloads currently in the list.
  const dlRows = new Map();

  function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let n = bytes || 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
  }

  const dlName = d => (d.target?.path ? PathUtils.filename(d.target.path) : d.source.url);
  const dlFailed = d => !!d.error && !d.succeeded;
  const dlBlocked = d => !!d.error?.becauseBlocked;
  const dlPaused = d => d.stopped && !d.succeeded && !d.error && d.canceled && d.hasPartialData;

  function dlStatus(d) {
    const host = URL.parse(d.source.url)?.host ?? "";
    if (d.succeeded) {
      const size = formatBytes(d.target.size || d.totalBytes || d.currentBytes);
      return d.target.exists === false ? "File moved or missing" : [size, host].filter(Boolean).join(" · ");
    }
    if (dlBlocked(d)) {
      return "Blocked";
    }
    if (dlFailed(d)) {
      return "Failed · Retry to try again";
    }
    const progress = d.hasProgress
      ? `${formatBytes(d.currentBytes)} of ${formatBytes(d.totalBytes)}`
      : formatBytes(d.currentBytes);
    if (dlPaused(d)) {
      return `Paused · ${progress}`;
    }
    if (d.canceled) {
      return "Canceled";
    }
    return d.speed ? `${progress} · ${formatBytes(d.speed)}/s` : progress;
  }

  function dlAction(label, cls, action) {
    return h("button", {
      type: "button",
      class: `fz-lib-button fz-lib-dl-action ${cls}`,
      text: label,
      onclick: e => {
        e.stopPropagation();
        // Until it settles, so a quick second click can't hit the
        // button that replaces this one (Pause, then Resume).
        const buttons = [...e.currentTarget.parentElement.querySelectorAll(".fz-lib-dl-action")];
        buttons.forEach(b => (b.disabled = true));
        Promise.resolve()
          .then(action)
          .catch(ex => console.error("firefox-zen-library: download action failed", ex))
          .finally(() => buttons.forEach(b => (b.disabled = false)));
      },
    });
  }

  // What decides a row's buttons and icon; while it holds, progress ticks
  // update the row in place. Rebuilding it on every tick swaps the button
  // under the pointer between mousedown and mouseup, so clicks get lost.
  const dlShape = d =>
    JSON.stringify([
      d.stopped,
      d.hasPartialData,
      dlPaused(d),
      dlFailed(d),
      dlBlocked(d),
      d.canceled,
      d.succeeded,
      d.target?.exists !== false,
      d.target?.path,
    ]);
  let dlRowCache = new WeakMap();

  function downloadRow(d, remove) {
    const shape = dlShape(d);
    const old = dlRowCache.get(d);
    if (old?.fzShape === shape) {
      old.querySelector(".fz-lib-dl-status").textContent = dlStatus(d);
      const bar = old.querySelector(".fz-lib-dl-progress");
      if (bar) {
        bar.toggleAttribute("indeterminate", !d.stopped && !d.hasProgress);
        bar.firstChild.style.width = `${d.hasProgress ? d.progress : 0}%`;
      }
      return old;
    }
    const row = buildDownloadRow(d, remove);
    row.fzShape = shape;
    dlRowCache.set(d, row);
    return row;
  }

  // Leaves rows that didn't change in place (see dlShape).
  function setDownloadChildren(children) {
    const current = dlListEl.children;
    if (
      current.length === children.length &&
      children.every((c, i) => c === current[i] || c.isEqualNode(current[i]))
    ) {
      return;
    }
    const scroll = dlListEl.scrollTop;
    dlListEl.replaceChildren(...children);
    dlListEl.scrollTop = scroll;
  }

  // `remove`: takes it off its list (Firefox's, or a private space's).
  function buildDownloadRow(d, remove = () => dlList?.remove(d)) {
    const running = !d.stopped;
    const actions = [];
    if (running) {
      if (d.hasPartialData) {
        actions.push(dlAction("Pause", "", () => d.cancel()));
      }
      actions.push(dlAction("Cancel", "", () => d.cancel().then(() => d.removePartialData())));
    } else if (dlPaused(d)) {
      actions.push(dlAction("Resume", "", () => d.start()));
      actions.push(dlAction("Cancel", "", () => d.removePartialData().then(() => d.refresh?.())));
    } else if ((dlFailed(d) && !dlBlocked(d)) || (d.canceled && !d.succeeded)) {
      actions.push(dlAction("Retry", "fz-lib-dl-retry", () => d.start()));
    } else if (d.succeeded && d.target.exists !== false) {
      actions.push(dlAction("Show in folder", "", () => d.showContainingDirectory()));
    }

    const progress =
      running || dlPaused(d)
        ? h(
            "div",
            { class: "fz-lib-dl-progress", indeterminate: running && !d.hasProgress },
            h("div", { style: `width: ${d.hasProgress ? d.progress : 0}%` })
          )
        : null;

    const fileUrl = d.target?.path ? PathUtils.toFileURI(d.target.path) : "";
    return h(
      "div",
      {
        class: "fz-lib-dl-row",
        tabindex: "0",
        title: d.target?.path || d.source.url,
        attention: dlFailed(d) && !dlBlocked(d),
        blocked: dlBlocked(d),
        done: d.succeeded,
        onclick: () => {
          if (d.succeeded && d.target.exists !== false) {
            d.launch().catch(ex => console.error("firefox-zen-library:", ex));
          }
        },
        onkeydown: e => {
          if (e.key === "Enter" && d.succeeded) {
            d.launch().catch(() => {});
          } else if (e.key === "Delete" && d.stopped) {
            remove();
          }
        },
      },
      h("img", {
        class: "fz-lib-dl-icon",
        src: fileUrl ? `moz-icon://${fileUrl}?size=32` : DEFAULT_FAVICON,
        alt: "",
      }),
      h(
        "div",
        { class: "fz-lib-dl-text" },
        h("span", { class: "fz-lib-dl-name", text: dlName(d) }),
        h("span", { class: "fz-lib-dl-status", text: dlStatus(d) }),
        progress
      ),
      h("span", { class: "fz-lib-history-time", text: timeFormat.format(d.startTime) }),
      ...actions,
      d.stopped
        ? h("button", {
            type: "button",
            class: "fz-lib-icon-button fz-lib-close-tab",
            title: "Remove from list",
            "aria-label": "Remove from list",
            onclick: e => {
              e.stopPropagation();
              remove();
            },
          })
        : null
    );
  }

  const dlMatches = d =>
    !dlQuery || dlName(d).toLowerCase().includes(dlQuery) || d.source.url.toLowerCase().includes(dlQuery);

  // Rebuild the list: newest first, grouped by day.
  // A private space's download (a saved record, not a live Download).
  // Only shown once Firefox no longer has the download (else the live row is).
  function buildPrivateDownloadRow(spaceId, d) {
    // Still marked running, but nothing is behind it anymore.
    const interrupted = d.state === "interrupted" || d.state === "downloading";
    const name = d.path ? PathUtils.filename(d.path) : d.url;
    const host = URL.parse(d.url)?.host ?? "";
    const file = () => {
      const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      f.initWithPath(d.path);
      return f;
    };
    const status =
      d.state === "done"
        ? [formatBytes(d.totalBytes || d.currentBytes), host].filter(Boolean).join(" · ")
        : d.state === "downloading"
          ? d.totalBytes
            ? `${formatBytes(d.currentBytes)} of ${formatBytes(d.totalBytes)}`
            : formatBytes(d.currentBytes)
          : d.state === "failed"
            ? "Failed"
            : "Canceled";
    const shownStatus = interrupted
      ? `Interrupted · ${d.totalBytes ? `${formatBytes(d.currentBytes)} of ${formatBytes(d.totalBytes)}` : formatBytes(d.currentBytes)}`
      : status;
    const remove = () => {
      // An interrupted download's leftover partial file is useless.
      if (interrupted && d.path) {
        IOUtils.remove(`${d.path}.part`, { ignoreAbsent: true }).catch(() => {});
      }
      api().removePrivateDownload(spaceId, d.key);
    };
    const fileUrl = d.path ? PathUtils.toFileURI(d.path) : "";
    return h(
      "div",
      {
        class: "fz-lib-dl-row",
        tabindex: "0",
        title: d.path || d.url,
        attention: d.state === "failed" || interrupted,
        done: d.state === "done",
        onclick: () => {
          if (d.state === "done" && d.path) {
            try {
              file().launch();
            } catch (ex) {
              console.error("firefox-zen-library:", ex);
            }
          }
        },
      },
      h("img", { class: "fz-lib-dl-icon", src: fileUrl ? `moz-icon://${fileUrl}?size=32` : DEFAULT_FAVICON, alt: "" }),
      h(
        "div",
        { class: "fz-lib-dl-text" },
        h("span", { class: "fz-lib-dl-name", text: name }),
        h("span", { class: "fz-lib-dl-status", text: shownStatus })
      ),
      h("span", { class: "fz-lib-history-time", text: timeFormat.format(d.startTime) }),
      d.state === "done" && d.path
        ? dlAction("Show in folder", "", () => file().reveal())
        : null,
      // Starts it again from its link, in the private space (the old entry goes).
      interrupted || d.state === "failed" || d.state === "canceled"
        ? dlAction("Retry", "fz-lib-dl-retry", () => {
            remove();
            openUrl(d.url, { spaceId });
          })
        : null,
      h("button", {
        type: "button",
        class: "fz-lib-icon-button fz-lib-close-tab",
        title: "Remove from list",
        "aria-label": "Remove from list",
        onclick: e => {
          e.stopPropagation();
          remove();
        },
      })
    );
  }

  function renderPrivateDownloads() {
    const items = api()
      .privateDownloads(dlSource)
      .filter(d => !dlQuery || d.url.toLowerCase().includes(dlQuery) || d.path.toLowerCase().includes(dlQuery));
    const children = [];
    let lastDay = null;
    for (const d of items) {
      const day = dayLabel(d.startTime);
      if (day !== lastDay) {
        lastDay = day;
        children.push(h("h3", { class: "fz-lib-day", text: day }));
      }
      // Still in Firefox's list: the same live row as other downloads.
      const live = api().privateLiveDownload?.(d.key);
      children.push(
        live
          ? downloadRow(live, () => api().removePrivateDownload(dlSource, d.key))
          : buildPrivateDownloadRow(dlSource, d)
      );
    }
    if (!children.length) {
      children.push(
        h("div", { class: "fz-lib-empty", text: dlQuery ? "No downloads match your search." : "No downloads yet." })
      );
    }
    setDownloadChildren(children);
  }

  function renderDownloads() {
    if (!dlListEl) {
      return;
    }
    if (dlSource) {
      renderPrivateDownloads();
      return;
    }
    const downloads = [...dlRows.keys()].filter(dlMatches).sort((a, b) => b.startTime - a.startTime);
    const children = [];
    let lastDay = null;
    for (const d of downloads) {
      const day = dayLabel(d.startTime.getTime());
      if (day !== lastDay) {
        lastDay = day;
        children.push(h("h3", { class: "fz-lib-day", text: day }));
      }
      const row = downloadRow(d);
      dlRows.set(d, row);
      children.push(row);
    }
    if (!children.length) {
      children.push(
        h("div", { class: "fz-lib-empty", text: dlQuery ? "No downloads match your search." : "No downloads yet." })
      );
    }
    setDownloadChildren(children);
  }

  let dlRenderQueued = false;

  function queueDownloadsRender() {
    if (!dlRenderQueued) {
      dlRenderQueued = true;
      requestAnimationFrame(() => {
        dlRenderQueued = false;
        renderDownloads();
      });
    }
  }

  async function startDownloads() {
    if (dlSource) {
      renderDownloads();
      return;
    }
    const list = await Downloads.getList(Downloads.PUBLIC);
    if (view !== "downloads" || !dlListEl?.isConnected || dlView) {
      return;
    }
    dlList = list;
    dlView = {
      onDownloadAdded: d => {
        dlRows.set(d, null);
        queueDownloadsRender();
      },
      onDownloadChanged: d => {
        // Progress ticks: update just this row (in place unless its
        // buttons change).
        const old = dlRows.get(d);
        if (old?.isConnected && dlMatches(d)) {
          const row = downloadRow(d);
          if (row !== old) {
            dlRows.set(d, row);
            old.replaceWith(row);
          }
        } else {
          queueDownloadsRender();
        }
      },
      onDownloadRemoved: d => {
        dlRows.delete(d);
        queueDownloadsRender();
      },
    };
    // Calls onDownloadAdded for the downloads already in the list.
    await list.addView(dlView);
    renderDownloads();
  }

  function stopDownloads() {
    if (dlList && dlView) {
      // Synchronous in current Firefox, a promise in older ones.
      try {
        Promise.resolve(dlList.removeView(dlView)).catch(() => {});
      } catch (ex) {
        console.error("firefox-zen-library:", ex);
      }
    }
    dlList = null;
    dlView = null;
    dlListEl = null;
    dlRows.clear();
    dlRowCache = new WeakMap();
  }

  function buildDownloadsView() {
    const search = h("input", {
      type: "search",
      class: "fz-lib-search",
      placeholder: "Search downloads",
      value: dlQuery,
      oninput: e => {
        dlQuery = e.target.value.trim().toLowerCase();
        renderDownloads();
      },
      onkeydown: e => {
        if (e.key === "Escape" && e.target.value) {
          e.preventDefault();
          e.stopPropagation();
          e.target.value = dlQuery = "";
          renderDownloads();
        }
      },
    });
    const folder = h("button", {
      type: "button",
      class: "fz-lib-button",
      text: "Open downloads folder",
      onclick: async () => {
        const dir = await Downloads.getPreferredDownloadsDirectory();
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(dir);
        file.launch();
      },
    });
    defaultSources();
    if (!privateSource(dlSource)) {
      dlSource = "";
    }
    const source = buildSourcePicker(dlSource, id => {
      dlSource = id;
      renderView();
    });
    const clear = h("button", {
      type: "button",
      class: "fz-lib-button",
      text: "Clear finished",
      onclick: () => {
        if (dlSource) {
          for (const d of api().privateDownloads(dlSource)) {
            if (d.state !== "downloading") {
              api().removePrivateDownload(dlSource, d.key);
            }
          }
        } else {
          dlList?.removeFinished();
        }
      },
    });
    dlListEl = h("div", { class: "fz-lib-history-list fz-lib-dl-list" });
    return [h("header", { class: "fz-lib-toolbar" }, search, source, folder, clear), dlListEl];
  }

  // ---- events ----

  // Attribute changes that show in the board (TabAttrModified also fires for
  // busy/progress etc. while pages load).
  const SHOWN_ATTRS = ["label", "image", "pending", "soundplaying", "muted"];

  function onTabsChanged(e) {
    if (e?.type === "TabAttrModified" && !e.detail?.changed?.some(a => SHOWN_ATTRS.includes(a))) {
      return;
    }
    if (root && view === "spaces") {
      queueRender();
    }
  }

  const prefObserver = {
    observe(_subject, _topic, name) {
      if (name === SPACES_PREF) {
        onTabsChanged();
      }
    },
  };

  window.FirefoxZenLibrary = { isOpen, open, close, toggle, view: () => view, sidebarExpanded, setSidebarExpanded };

  async function start() {
    await window.delayedStartupPromise;
    const tc = gBrowser.tabContainer;
    for (const type of [
      "TabOpen",
      "TabClose",
      "TabMove",
      "TabAttrModified",
      "TabPinned",
      "TabUnpinned",
      "TabGrouped",
      "TabUngrouped",
      "TabGroupCreate",
      "TabGroupRemoved",
      "TabGroupCollapse",
      "TabGroupExpand",
      "TabGroupUpdate",
      "TabSelect",
      "SplitViewCreated",
      "SplitViewRemoved",
    ]) {
      tc.addEventListener(type, onTabsChanged);
    }
    window.addEventListener("FzSpacesChanged", onTabsChanged);
    window.addEventListener("FzTabSectionsChanged", onTabsChanged);
    // An open private space's tabs changed in its own window.
    window.addEventListener("FzPrivateTabsChanged", onTabsChanged);
    // A private space's history / downloads list changed.
    window.addEventListener("FzPrivateHistoryChanged", e => {
      if (root && view === "history" && historySource && e.detail === historySource) {
        clearTimeout(privateHistoryTimer);
        privateHistoryTimer = setTimeout(() => loadHistory({ reset: true }), 300);
      }
    });
    window.addEventListener("FzPrivateDownloadsChanged", e => {
      if (root && view === "downloads" && dlSource && e.detail === dlSource) {
        queueDownloadsRender();
      }
    });
    // Locking/hiding: a private source may be gone; the picker follows.
    window.addEventListener("FzSpacesChanged", () => {
      if (root && ((view === "history" && historySource) || (view === "downloads" && dlSource))) {
        if (!privateSource(view === "history" ? historySource : dlSource)) {
          renderView();
        }
      }
    });
    window.addEventListener("resize", place);
    // Clicking a tab in the sidebar means "show me the page".
    document.getElementById("tabbrowser-tabs")?.addEventListener("mousedown", e => {
      if (root && e.button === 0 && e.target.closest?.(".tabbrowser-tab")) {
        close();
      }
    });

    Services.prefs.addObserver(SPACES_PREF, prefObserver);
    window.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(SPACES_PREF, prefObserver);
      },
      { once: true }
    );
  }

  start().catch(e => console.error("firefox-zen-library:", e));
})();
