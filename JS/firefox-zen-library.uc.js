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
// - Spaces: one column per space with its folders and tabs, Essentials
//   (pinned tabs) on top. Drag columns to reorder spaces; drag tabs and folders
//   between and within columns, onto Essentials, onto the space buttons in the
//   footer, or onto "New space".
// - History: places history by last visit, grouped by day, searchable. Drag an
//   entry onto a space to open it there.
//
// Drag and drop uses pointer events (not HTML drag and drop), captured on the
// panel, so a drag can leave the panel and land on the footer.

(function () {
  "use strict";

  const PREF = "firefox-zen.library";
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

  const enabled = () => Services.prefs.getBoolPref(PREF, false);
  const api = () => window.FirefoxZenSpaces;
  const spacesOn = () => !!api()?.enabled();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let root = null;
  let main = null;
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
    // sidebar): start next to it instead of under it.
    const side = document.getElementById("sidebar-container")?.getBoundingClientRect();
    if (sidebarHeld && side?.width && side.right > left && side.left < right) {
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
  // { wasExpanded, isMenuPopupOpen } while held.
  let sidebarHeld = null;

  function holdSidebar() {
    if (sidebarHeld) {
      return;
    }
    const sc = window.SidebarController;
    sidebarHeld = { wasExpanded: false, isMenuPopupOpen: null };
    // Compact sidebar: stay slid in (theme/general.css).
    document.getElementById("sidebar-container")?.setAttribute("fz-library-hold", "");
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
    document.getElementById("sidebar-container")?.removeAttribute("fz-library-hold");
    if (!sc?._state) {
      return;
    }
    if (held.isMenuPopupOpen) {
      sc._isMenuPopupOpen = held.isMenuPopupOpen;
      // Collapses unless the pointer is on the sidebar.
      sc._reconcileHoverState?.();
    } else if (!held.wasExpanded && sc._state.launcherExpanded) {
      sc._state.launcherExpanded = false;
    }
  }

  function syncFooterButton() {
    const button = document.querySelector("sidebar-main")?.shadowRoot?.querySelector(".fz-library");
    button?.setAttribute("aria-pressed", String(isOpen()));
  }

  function open(newView) {
    if (!enabled()) {
      return;
    }
    if (newView) {
      setView(newView, { render: false });
    }
    if (!root) {
      picked.clear();
      holdSidebar();
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
    resizeObserver.disconnect();
    const old = root;
    root = null;
    main = null;
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
    if (root) {
      close();
    } else {
      open();
    }
  }

  function setView(name, { render = true } = {}) {
    view = name === "history" ? "history" : "spaces";
    Services.prefs.setStringPref(VIEW_PREF, view);
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
        h("div", { class: "fz-lib-rail-spacer" }),
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
    if (view === "history") {
      main.replaceChildren(...buildHistoryView());
      loadHistory({ reset: true });
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
      text: "New space",
      onclick: () => newSpace(),
    });
    board = h("div", { class: "fz-lib-board-wrap" });
    return [h("header", { class: "fz-lib-toolbar" }, filter, add), board];
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

    const columns = api()
      .list()
      .map(space => buildColumn(space));
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
    board.replaceChildren(
      buildEssentials(),
      h("div", { class: "fz-lib-board", "data-drop": "board" }, ...columns, newColumn)
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

  function buildEssentials() {
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
        },
        h("img", { src: tabIcon(tab), alt: "" })
      );
    });
    return h(
      "div",
      { class: "fz-lib-essentials", "data-drop": "pinned", "aria-label": "Essentials (pinned tabs)" },
      h("span", { class: "fz-lib-section-label", text: "Essentials" }),
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
      } else if (matches(tab)) {
        // The sidebar's line between folders and loose tabs (tab sections).
        if (list.lastElementChild?.classList.contains("fz-lib-group")) {
          list.append(h("div", { class: "fz-lib-separator", "aria-hidden": "true" }));
        }
        list.append(buildTabRow(tab));
      }
    }
    if (!list.children.length) {
      list.append(h("div", { class: "fz-lib-hint fz-lib-column-empty", text: filterText ? "No matches" : "No tabs" }));
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

  function buildGroup(group, tabs) {
    const shown = tabs.filter(matches);
    if (filterText && !shown.length && !group.label.toLowerCase().includes(filterText)) {
      return null;
    }
    const key = keyOf(group);
    groupByKey.set(key, group);
    const collapsed = collapsedGroups.has(group.id) && !filterText;
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
      collapsed ? null : h("div", { class: "fz-lib-group-tabs" }, ...(filterText ? shown : tabs).map(buildTabRow))
    );
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
  // drag = { kind: "tab" | "group" | "space" | "history", source, x0, y0,
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
        const space = api().list().find(s => s.id === column?.dataset.space);
        if (!space) {
          return false;
        }
        d.payload = space.id;
        label = `${space.icon || ""} ${space.name}`.trim();
        column.classList.add("fz-lib-dragging");
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

    // Tabs and folders.
    const pinned = hit?.closest?.(".fz-lib-essentials");
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
    const firstLoose = column.querySelector(".fz-lib-tabs > .fz-lib-tab:not(.fz-lib-dragging)");
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
        const ids = api()
          .list()
          .map(s => s.id)
          .filter(id => id !== d.payload);
        const index = target.beforeSpace ? ids.indexOf(target.beforeSpace) : ids.length;
        ids.splice(index < 0 ? ids.length : index, 0, d.payload);
        api().reorder(ids);
        break;
      }
      case "history":
        if (target.space) {
          openUrl(d.payload.url, { spaceId: target.space, background: true });
        }
        break;
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

  // ---- history view ----

  let historyQuery = "";
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
    const clear = h("button", {
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
      h("header", { class: "fz-lib-toolbar" }, search, clear),
      h(
        "div",
        { class: "fz-lib-history-body" },
        h("div", { class: "fz-lib-drop-spaces" }, h("span", { class: "fz-lib-section-label", text: "Open in" }), ...chips),
        historyList
      ),
    ];
  }

  async function queryHistory(text, offset) {
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
        onclick: e => openUrl(entry.url, { background: e.ctrlKey || e.metaKey }),
        onauxclick: e => {
          if (e.button === 1) {
            e.preventDefault();
            openUrl(entry.url, { background: true });
          }
        },
        onkeydown: e => {
          if (e.key === "Enter") {
            openUrl(entry.url);
          } else if (e.key === "Delete") {
            removeHistory(entry.url, row);
          }
        },
      },
      h("img", { class: "fz-lib-favicon", src: `page-icon:${entry.url}`, alt: "" }),
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
    PlacesUtils.history.remove(url).catch(ex => console.error("firefox-zen-library:", ex));
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
      if (name === PREF && !enabled()) {
        close();
      } else if (name === SPACES_PREF) {
        onTabsChanged();
      }
    },
  };

  window.FirefoxZenLibrary = { isOpen, open, close, toggle };

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
    ]) {
      tc.addEventListener(type, onTabsChanged);
    }
    window.addEventListener("FzSpacesChanged", onTabsChanged);
    window.addEventListener("resize", place);
    // Clicking a tab in the sidebar means "show me the page".
    document.getElementById("tabbrowser-tabs")?.addEventListener("mousedown", e => {
      if (root && e.button === 0 && e.target.closest?.(".tabbrowser-tab")) {
        close();
      }
    });

    Services.prefs.addObserver(PREF, prefObserver);
    Services.prefs.addObserver(SPACES_PREF, prefObserver);
    window.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(PREF, prefObserver);
        Services.prefs.removeObserver(SPACES_PREF, prefObserver);
      },
      { once: true }
    );
  }

  start().catch(e => console.error("firefox-zen-library:", e));
})();
