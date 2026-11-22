// ==UserScript==
// @name           Firefox-Zen Menu Customizer
// @description    Customize menu… at the bottom of right-click menus: edit the menu in place, hide, move and add items
// @include        main
// ==/UserScript==

// With firefox-zen.menu-customizer on, every right-click menu of the window
// (the page's, a tab's, the toolbar's, bookmarks', the Library's…) ends in
// Customize menu…. Clicking it keeps the menu open and turns it into its own
// editor: the rows it shows on the left, and beside them a Hidden column and
// chips to add commands. Rows are dragged to reorder (press and drag, or hold,
// then release), dragged to Hidden or clicked to hide them, and back to show
// them; chips are clicked (added last) or dragged into place. The footer has
// Restore default, Cancel and Done.
//
// Changes are kept per menu (by the menupopup's id) in
// firefox-zen.menu-customizer.menus, a JSON object:
//   { "<menu id>": { removed: [key…], added: [{ uid, action }],
//                    moves: [{ key, after }] } }
// An item's key is "#<id>", "label:<label>" for items without an id, or
// "+<uid>" for an added item. Removed items are hidden with an agent sheet (so
// they stay hidden whatever Firefox does to the item's `hidden`). Added items
// are real menuitems. `moves`, top to bottom, puts an item right after the one
// keyed `after` (null: first) each time the menu opens; only items that were
// moved, and every added item, have one. Firefox's own items go back where
// they were when their move goes away.
//
// The editor shows what the menu showed where it was opened: a page menu on a
// link has other items than one on an image, so items changed elsewhere keep
// their change until a menu that shows them is edited.

(function () {
  "use strict";

  const PREF = "firefox-zen.menu-customizer";
  const DATA_PREF = "firefox-zen.menu-customizer.menus";
  // Off: no Customize menu… entry, but the menus keep their changes
  const BUTTON_PREF = "firefox-zen.menu-customizer.button";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const ENTRY_CLASS = "fz-menu-customize";
  const ENTRY_SEP_CLASS = "fz-menu-customize-sep";
  const ADDED_ATTR = "fz-menu-added";
  const ACTION_ATTR = "fz-menu-action";
  const SEP_HIDDEN_ATTR = "fz-menu-sep-hidden";
  const EDITING_ATTR = "fz-menu-editing";
  const EDIT_CLASS = "fz-mc-edit-part";

  // Menus opened from content (no contextmenu event reaches the chrome document)
  const KNOWN_CONTEXT_MENUS = new Set(["contentAreaContextMenu"]);
  // A menu shown this soon after a contextmenu event is that event's menu
  const CONTEXT_WINDOW_MS = 1000;
  // Holding a row this long picks it up without moving
  const HOLD_MS = 250;
  const DRAG_THRESHOLD = 4;

  const MENU_NAMES = {
    contentAreaContextMenu: "Page menu",
    tabContextMenu: "Tab menu",
    "toolbar-context-menu": "Toolbar menu",
    placesContext: "Bookmarks menu",
    "sidebar-context-menu": "Sidebar menu",
    "urlbar-input-context-menu": "Address bar menu",
  };

  // What can be added. `command` runs a <command> of the window; `run` gets
  // the tab the menu is about (the right-clicked one in the tab menu).
  const ACTIONS = [
    { id: "separator", label: "Separator", separator: true },
    { id: "new-tab", label: "New tab", command: "cmd_newNavigatorTab" },
    { id: "new-window", label: "New window", command: "cmd_newNavigator" },
    { id: "private-window", label: "New private window", command: "Tools:PrivateBrowsing" },
    { id: "reopen-tab", label: "Reopen closed tab", command: "History:UndoCloseTab" },
    { id: "reload", label: "Reload tab", run: tab => gBrowser.reloadTab(tab) },
    {
      id: "duplicate-tab",
      label: "Duplicate tab",
      run: tab => (gBrowser.selectedTab = gBrowser.duplicateTab(tab)),
    },
    { id: "close-tab", label: "Close tab", run: tab => gBrowser.removeTab(tab, { animate: true }) },
    {
      id: "copy-link",
      label: "Copy page link",
      run: tab => {
        const uri = tab.linkedBrowser?.currentURI;
        if (uri) {
          Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(uri.displaySpec);
        }
      },
    },
    { id: "bookmark", label: "Bookmark page…", command: "Browser:AddBookmarkAs" },
    { id: "screenshot", label: "Take screenshot", command: "Browser:Screenshot" },
    { id: "print", label: "Print…", command: "cmd_print" },
    { id: "find", label: "Find in page…", command: "cmd_find" },
    { id: "fullscreen", label: "Full screen", command: "View:FullScreen" },
    {
      id: "downloads",
      label: "Downloads",
      run: () =>
        window.FirefoxZenLibrary ? window.FirefoxZenLibrary.open("downloads") : doCommand("Tools:Downloads"),
    },
    {
      id: "library",
      label: "Firefox-Zen Library",
      run: () => window.FirefoxZenLibrary?.open(),
      available: () => !!window.FirefoxZenLibrary,
    },
    {
      id: "zen-settings",
      label: "Firefox-Zen settings",
      run: () => window.FirefoxZenLibrary?.open("settings"),
      available: () => !!window.FirefoxZenLibrary,
    },
    { id: "addons", label: "Add-ons and themes", command: "Tools:Addons" },
    { id: "firefox-settings", label: "Firefox settings", run: () => window.openPreferences() },
  ];
  const ACTION_BY_ID = new Map(ACTIONS.map(a => [a.id, a]));

  const enabled = () => Services.prefs.getBoolPref(PREF, false);
  const showButton = () => Services.prefs.getBoolPref(BUTTON_PREF, true);

  function doCommand(id) {
    const command = document.getElementById(id);
    if (command && command.getAttribute("disabled") !== "true") {
      command.doCommand();
    }
  }

  // ---- stored layouts ----

  const emptyMenu = () => ({ removed: [], added: [], moves: [] });
  const isEmpty = menu => !menu.removed.length && !menu.added.length && !menu.moves.length;
  const validAfter = a => a === null || typeof a === "string";

  function readMenus() {
    let data;
    try {
      data = JSON.parse(Services.prefs.getStringPref(DATA_PREF, "{}"));
    } catch {
      return {};
    }
    const menus = {};
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return menus;
    }
    for (const [id, menu] of Object.entries(data)) {
      if (!menu || typeof menu !== "object") {
        continue;
      }
      const removed = Array.isArray(menu.removed) ? menu.removed.filter(k => typeof k === "string" && k) : [];
      const added = (Array.isArray(menu.added) ? menu.added : []).filter(
        a => a && typeof a.uid === "string" && ACTION_BY_ID.has(a.action)
      );
      let moves = (Array.isArray(menu.moves) ? menu.moves : []).filter(
        m => m && typeof m.key === "string" && validAfter(m.after)
      );
      // Added items used to carry their own `after`
      if (!Array.isArray(menu.moves)) {
        moves = added.filter(a => validAfter(a.after)).map(a => ({ key: "+" + a.uid, after: a.after }));
      }
      const clean = {
        removed,
        added: added.map(({ uid, action }) => ({ uid, action })),
        moves: moves.map(({ key, after }) => ({ key, after })),
      };
      if (!isEmpty(clean)) {
        menus[id] = clean;
      }
    }
    return menus;
  }

  function writeMenu(id, menu) {
    const menus = readMenus();
    if (menu && !isEmpty(menu)) {
      menus[id] = menu;
    } else {
      delete menus[id];
    }
    if (Object.keys(menus).length) {
      Services.prefs.setStringPref(DATA_PREF, JSON.stringify(menus));
    } else {
      Services.prefs.clearUserPref(DATA_PREF);
    }
  }

  // ---- keys ----

  function keyOf(el) {
    if (el.hasAttribute(ADDED_ATTR)) {
      return "+" + el.getAttribute(ADDED_ATTR);
    }
    if (el.id) {
      return "#" + el.id;
    }
    const label = el.getAttribute("label");
    return label ? "label:" + label : null;
  }

  function findByKey(popup, key) {
    if (key.startsWith("+")) {
      return popup.querySelector(`:scope > [${ADDED_ATTR}="${CSS.escape(key.slice(1))}"]`);
    }
    if (key.startsWith("#")) {
      return popup.querySelector(`:scope > #${CSS.escape(key.slice(1))}`);
    }
    const label = key.slice("label:".length);
    return [...popup.children].find(c => !c.id && c.getAttribute("label") === label) ?? null;
  }

  const cssString = s => `"${s.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ")}"`;

  function selectorOf(key) {
    if (key.startsWith("#")) {
      return `#${CSS.escape(key.slice(1))}`;
    }
    if (key.startsWith("label:")) {
      return `:is(menuitem, menu):not([id])[label=${cssString(key.slice(6))}]`;
    }
    return null;
  }

  // ---- hiding removed items ----

  let sheetURI = null;

  function applySheet() {
    const utils = window.windowUtils;
    if (sheetURI) {
      try {
        utils.removeSheetUsingURIString(sheetURI, utils.AGENT_SHEET);
      } catch {}
      sheetURI = null;
    }
    if (!enabled()) {
      return;
    }
    const rules = [
      `[${SEP_HIDDEN_ATTR}] { display: none !important; }`,
      // While editing, the menu shows only the editor's rows
      `menupopup[${EDITING_ATTR}] > :not(.${EDIT_CLASS}) { display: none !important; }`,
    ];
    for (const [id, menu] of Object.entries(readMenus())) {
      const selectors = menu.removed.map(selectorOf).filter(Boolean);
      if (selectors.length) {
        rules.push(`#${CSS.escape(id)} > :is(${selectors.join(", ")}) { display: none !important; }`);
      }
    }
    sheetURI = "data:text/css;charset=utf-8," + encodeURIComponent(rules.join("\n"));
    utils.loadSheetUsingURIString(sheetURI, utils.AGENT_SHEET);
  }

  // ---- what the menu shows ----

  function isShown(el) {
    if (el.hidden || el.collapsed || el.hasAttribute(SEP_HIDDEN_ATTR)) {
      return false;
    }
    return getComputedStyle(el).display !== "none";
  }

  // Separators left first, last or next to another by hidden or moved items.
  function tidySeparators(popup) {
    for (const sep of popup.querySelectorAll(`:scope > [${SEP_HIDDEN_ATTR}]`)) {
      sep.removeAttribute(SEP_HIDDEN_ATTR);
    }
    let previous = null; // last shown element
    for (const el of popup.children) {
      if (!isShown(el)) {
        continue;
      }
      if (el.localName === "menuseparator" && (!previous || previous.localName === "menuseparator")) {
        el.setAttribute(SEP_HIDDEN_ATTR, "true");
        continue;
      }
      previous = el;
    }
    if (previous?.localName === "menuseparator") {
      previous.setAttribute(SEP_HIDDEN_ATTR, "true");
    }
  }

  // ---- added items and moves ----

  function tabFor(popup) {
    if (popup.id === "tabContextMenu" && window.TabContextMenu?.contextTab) {
      return window.TabContextMenu.contextTab;
    }
    return gBrowser.selectedTab;
  }

  function buildAddedItem(entry, action) {
    if (action.separator) {
      const sep = document.createXULElement("menuseparator");
      sep.setAttribute(ADDED_ATTR, entry.uid);
      return sep;
    }
    const item = document.createXULElement("menuitem");
    item.setAttribute(ADDED_ATTR, entry.uid);
    item.setAttribute(ACTION_ATTR, action.id);
    item.setAttribute("label", action.label);
    item.addEventListener("command", () => {
      const popup = item.parentNode;
      if (popup?.hasAttribute(EDITING_ATTR)) {
        return;
      }
      if (action.command) {
        doCommand(action.command);
      } else {
        action.run(tabFor(popup));
      }
    });
    return item;
  }

  // Firefox's items we moved: popup -> [el…] in the order moved, and where
  // each was before (the element it followed, null when first).
  const movedIn = new WeakMap();
  const origins = new WeakMap();
  // The layout last applied to each popup
  const applied = new WeakMap();

  function undoMoves(popup) {
    const moved = movedIn.get(popup) ?? [];
    for (const el of moved.reverse()) {
      if (!origins.has(el) || el.parentNode !== popup) {
        continue;
      }
      const prev = origins.get(el);
      if (prev === null) {
        popup.prepend(el);
      } else if (prev.parentNode === popup) {
        prev.after(el);
      }
      origins.delete(el);
    }
    movedIn.delete(popup);
    applied.delete(popup);
  }

  function moveAfter(popup, el, anchor) {
    if (!el.hasAttribute(ADDED_ATTR) && !origins.has(el)) {
      origins.set(el, el.previousElementSibling);
      const moved = movedIn.get(popup) ?? [];
      moved.push(el);
      movedIn.set(popup, moved);
    }
    if (anchor) {
      if (anchor.nextElementSibling !== el) {
        anchor.after(el);
      }
    } else if (popup.firstElementChild !== el) {
      popup.prepend(el);
    }
  }

  function applyLayout(popup, menu) {
    const stamp = JSON.stringify(menu ?? null);
    if (applied.get(popup) !== stamp) {
      undoMoves(popup);
      applied.set(popup, stamp);
    }

    // Added items: drop stale ones, make missing ones (at the end for now)
    const wanted = new Map((menu?.added ?? []).map(a => [a.uid, a]));
    const existing = new Map();
    for (const el of popup.querySelectorAll(`:scope > [${ADDED_ATTR}]`)) {
      const uid = el.getAttribute(ADDED_ATTR);
      if (wanted.has(uid) && !existing.has(uid)) {
        existing.set(uid, el);
      } else {
        el.remove();
      }
    }
    if (!menu) {
      return;
    }
    const end = popup.querySelector(`:scope > .${ENTRY_SEP_CLASS}`);
    for (const entry of menu.added) {
      const action = ACTION_BY_ID.get(entry.action);
      let el = existing.get(entry.uid);
      if (!el) {
        el = buildAddedItem(entry, action);
        if (end) {
          end.before(el);
        } else {
          popup.append(el);
        }
      }
      if (action.command) {
        el.disabled = document.getElementById(action.command)?.getAttribute("disabled") === "true";
      }
      el.hidden = action.available ? !action.available() : false;
    }

    for (const move of menu.moves) {
      const el = findByKey(popup, move.key);
      if (!el) {
        continue;
      }
      if (move.after === null) {
        moveAfter(popup, el, null);
        continue;
      }
      const anchor = findByKey(popup, move.after);
      // Without its anchor here, Firefox's item stays put; an added one ends the menu
      if (anchor) {
        moveAfter(popup, el, anchor);
      }
    }
  }

  // ---- the Customize menu… entry ----

  function ensureEntry(popup) {
    let item = popup.querySelector(`:scope > .${ENTRY_CLASS}`);
    let sep = popup.querySelector(`:scope > .${ENTRY_SEP_CLASS}`);
    if (!item) {
      sep = document.createXULElement("menuseparator");
      sep.className = ENTRY_SEP_CLASS;
      item = document.createXULElement("menuitem");
      item.className = ENTRY_CLASS;
      item.setAttribute("label", "Customize menu…");
      // The menu stays open and turns into the editor
      item.setAttribute("closemenu", "none");
      item.addEventListener("command", () => startEditing(popup));
    }
    // Last, even after items Firefox appended since
    if (item.nextElementSibling || item.parentNode !== popup) {
      popup.append(sep, item);
    }
    sep.hidden = false;
    item.hidden = false;
  }

  // Items added once the menu is open (extensions', for one) would end up
  // after Customize menu…: move it back to the end.
  const watched = new WeakSet();

  function watchLateItems(popup) {
    if (watched.has(popup)) {
      return;
    }
    watched.add(popup);
    new MutationObserver(() => {
      const item = popup.querySelector(`:scope > .${ENTRY_CLASS}`);
      if (
        !item ||
        item.hidden ||
        !item.nextElementSibling ||
        popup.hasAttribute(EDITING_ATTR) ||
        !["showing", "open"].includes(popup.state)
      ) {
        return;
      }
      ensureEntry(popup);
      if (popup.state === "open") {
        tidySeparators(popup);
      }
    }).observe(popup, { childList: true });
  }

  function hideEntry(popup) {
    for (const el of popup.querySelectorAll(`:scope > :is(.${ENTRY_CLASS}, .${ENTRY_SEP_CLASS})`)) {
      el.hidden = true;
    }
  }

  // ---- telling right-click menus apart ----

  let contextMenuTime = 0;

  const onContextMenu = () => (contextMenuTime = Date.now());
  // A left click or a key before the menu opens means it's not that menu.
  const onOtherInput = e => {
    if (e.type === "keydown" ? e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10") : e.button !== 2) {
      contextMenuTime = 0;
    }
  };

  function isContextMenu(popup) {
    if (KNOWN_CONTEXT_MENUS.has(popup.id)) {
      return true;
    }
    if (Date.now() - contextMenuTime < CONTEXT_WINDOW_MS) {
      contextMenuTime = 0;
      return true;
    }
    return false;
  }

  const isTopLevel = popup => popup.localName === "menupopup" && popup.parentNode?.localName !== "menu";

  // Bubbling on the window: Firefox's own popupshowing handlers (on the
  // popup) have already decided which items show.
  function onPopupShowing(e) {
    const popup = e.target;
    if (e.defaultPrevented || !enabled() || !isTopLevel(popup) || popup.hasAttribute(EDITING_ATTR)) {
      return;
    }
    // Menus without an id can't be told apart next time, so they can't be customized.
    const context = isContextMenu(popup) && !!popup.id && showButton();
    if (context) {
      ensureEntry(popup);
      watchLateItems(popup);
    } else {
      hideEntry(popup);
    }
    const menu = popup.id ? readMenus()[popup.id] : null;
    applyLayout(popup, menu);
    if (context || menu) {
      tidySeparators(popup);
    }
  }

  // Items some menus add once they're open (extensions', for one)
  function onPopupShown(e) {
    const popup = e.target;
    if (
      enabled() &&
      isTopLevel(popup) &&
      !popup.hasAttribute(EDITING_ATTR) &&
      popup.querySelector(`:scope > .${ENTRY_CLASS}:not([hidden])`)
    ) {
      if (popup.lastElementChild?.classList.contains(ENTRY_CLASS) === false) {
        ensureEntry(popup);
      }
      tidySeparators(popup);
    }
  }

  function removeAll() {
    for (const popup of document.querySelectorAll(`menupopup[${EDITING_ATTR}]`)) {
      popup.hidePopup();
    }
    for (const popup of document.querySelectorAll("menupopup")) {
      if (movedIn.has(popup)) {
        undoMoves(popup);
      }
    }
    for (const el of document.querySelectorAll(
      `.${ENTRY_CLASS}, .${ENTRY_SEP_CLASS}, menupopup > [${ADDED_ATTR}], .${EDIT_CLASS}`
    )) {
      el.remove();
    }
    for (const el of document.querySelectorAll(`[${SEP_HIDDEN_ATTR}]`)) {
      el.removeAttribute(SEP_HIDDEN_ATTR);
    }
  }

  // ---- editing in the menu ----

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

  function menuName(popup) {
    if (MENU_NAMES[popup.id]) {
      return MENU_NAMES[popup.id];
    }
    const words = popup.id
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " ")
      .replace(/\b(context|popup|menupopup|menu)\b/gi, "")
      .trim()
      .toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) + " menu" : "This menu";
  }

  function labelOf(el) {
    const own = el.getAttribute("label") || el.getAttribute("aria-label") || el.getAttribute("tooltiptext");
    if (own) {
      return own;
    }
    // A row of buttons (the page menu's Back, Forward, Reload, Bookmark)
    const parts = [...el.children]
      .filter(c => !c.hidden)
      .map(c => c.getAttribute("aria-label") || c.getAttribute("tooltiptext") || c.getAttribute("label"))
      .filter(Boolean);
    return parts.length ? parts.join(", ") : el.id;
  }

  // The theme draws menu icons as background images; Firefox's own iconic
  // items use an image child.
  function iconOf(el) {
    const style = getComputedStyle(el);
    if (style.backgroundImage.startsWith("url(")) {
      return style.backgroundImage;
    }
    const image = el.getAttribute("image");
    if (image) {
      return `url(${cssString(image)})`;
    }
    const icon = el.querySelector(":scope > .menu-iconic-left .menu-iconic-icon, :scope > .menu-icon");
    const list = icon && getComputedStyle(icon).listStyleImage;
    return list?.startsWith("url(") ? list : null;
  }

  // Rows for the editor: what the menu shows now, plus what was removed
  // from it that would show here. Each keeps its element, to put the rows
  // back in Firefox's order for Restore default.
  function snapshot(popup) {
    const menu = readMenus()[popup.id] ?? emptyMenu();
    const removed = new Set(menu.removed);
    const addedByUid = new Map(menu.added.map(a => [a.uid, a]));
    const rows = [];
    for (const el of popup.children) {
      if (el.classList.contains(ENTRY_CLASS) || el.classList.contains(ENTRY_SEP_CLASS)) {
        continue;
      }
      if (el.hasAttribute(ADDED_ATTR)) {
        const entry = addedByUid.get(el.getAttribute(ADDED_ATTR));
        if (entry && !el.hidden) {
          rows.push({ kind: "added", uid: entry.uid, action: entry.action, el });
        }
        continue;
      }
      const key = keyOf(el);
      const separator = el.localName === "menuseparator";
      if (!key) {
        // Can't be told apart next time: shown for orientation only
        if (separator && !el.hidden && !el.collapsed && getComputedStyle(el).display !== "none") {
          rows.push({ kind: "divider", el });
        }
        continue;
      }
      if (el.hidden || el.collapsed) {
        continue;
      }
      const isRemoved = removed.has(key);
      if (!isRemoved && getComputedStyle(el).display === "none") {
        continue;
      }
      rows.push({
        kind: separator ? "separator" : "item",
        key,
        el,
        label: separator ? "Separator" : labelOf(el),
        icon: separator ? null : iconOf(el),
        removed: isRemoved,
        disabled: el.disabled || el.getAttribute("disabled") === "true",
        submenu: el.localName === "menu",
        // A row of buttons: drawn as its icons
        buttons:
          el.localName === "menugroup"
            ? [...el.children].filter(c => !c.hidden).map(c => ({ icon: iconOf(c), label: labelOf(c) }))
            : null,
      });
    }
    return rows;
  }

  // Indices (into `values`) of a longest increasing run: the rows that kept
  // their order, so only the others count as moved.
  function longestIncreasing(values) {
    const tails = [];
    const prev = new Array(values.length).fill(-1);
    for (let i = 0; i < values.length; i++) {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[tails[mid]] < values[i]) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      prev[i] = lo > 0 ? tails[lo - 1] : -1;
      tails[lo] = i;
    }
    const keep = new Set();
    for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]) {
      keep.add(i);
    }
    return keep;
  }

  let session = null; // the menu being edited

  function startEditing(popup) {
    if (session) {
      return;
    }
    session = new EditSession(popup);
  }

  // The menu turned into its editor: the rows the menu shows on the left,
  // a Hidden column and the Add chips on the right. Rows move between the
  // menu and Hidden by their switch, a click, or a drag.
  class EditSession {
    constructor(popup) {
      this.popup = popup;
      this.menuId = popup.id;
      this.original = readMenus()[popup.id] ?? emptyMenu();
      this.reset = false;
      this.saved = false;
      this.nextRid = 0;
      this.rows = snapshot(popup).map(r => this.withRid(r));
      this.markOrder();
      this.drag = null;

      this.build();
      popup.setAttribute(EDITING_ATTR, "true");
      popup.append(...this.parts);
      this.render();

      this.onHidden = e => e.target === popup && this.end();
      this.onKey = e => this.keydown(e);
      popup.addEventListener("popuphidden", this.onHidden);
      window.addEventListener("keydown", this.onKey, true);
      this.awaitLabels();
    }

    // The first time a menu opens, Fluent may not have set its labels yet
    async awaitLabels() {
      const pending = this.rows.filter(
        r => r.el && r.kind === "item" && !r.el.getAttribute("label") && r.el.hasAttribute("data-l10n-id")
      );
      if (!pending.length) {
        return;
      }
      try {
        await document.l10n.translateElements(pending.map(r => r.el));
      } catch {}
      if (session !== this || this.drag) {
        return;
      }
      for (const row of pending) {
        row.label = labelOf(row.el);
        row.icon = iconOf(row.el);
      }
      this.render();
    }

    withRid(row) {
      return { ...row, rid: String(++this.nextRid) };
    }

    // The order moves are measured against
    markOrder() {
      this.startIndex = new Map(this.rows.map((r, i) => [r.rid, i]));
    }

    build() {
      this.list = h("div", { class: "fz-mc-list", role: "list", "aria-label": "In the menu" });
      this.hiddenList = h("div", { class: "fz-mc-list fz-mc-hidden-list", role: "list", "aria-label": "Hidden" });
      this.hiddenEmpty = h("p", {
        class: "fz-mc-empty",
        text: "Items you switch off wait here. Drag a row here to hide it.",
      });
      this.hiddenCount = h("span", { class: "fz-mc-count" });
      this.addGrid = h("div", { class: "fz-mc-add-grid", role: "group", "aria-label": "Add to the menu" });
      this.menuScroll = h("div", { class: "fz-mc-scroll fz-mc-menu-scroll" }, this.list);
      this.hiddenScroll = h("div", { class: "fz-mc-scroll fz-mc-hidden-scroll" }, this.hiddenList, this.hiddenEmpty);
      this.resetButton = h("button", {
        type: "button",
        class: "fz-mc-button fz-mc-reset",
        text: "Restore default",
        title: "Show every item again, put them back in order and remove what you added",
        onclick: () => this.restoreDefault(),
      });

      const header = h(
        "div",
        { class: `${EDIT_CLASS} fz-mc-header` },
        h("span", { class: "fz-mc-header-icon", "aria-hidden": "true" }),
        h(
          "div",
          { class: "fz-mc-heading" },
          h("div", { class: "fz-mc-title", text: `Customize ${menuName(this.popup).toLowerCase()}` }),
          h("div", {
            class: "fz-mc-subtitle",
            text: "Drag rows to move them. × or a drag to Hidden hides them; ↺ brings them back.",
          })
        )
      );
      this.body = h(
        "div",
        { class: `${EDIT_CLASS} fz-mc-body` },
        h(
          "section",
          { class: "fz-mc-col fz-mc-col-menu" },
          h("div", { class: "fz-mc-col-title", text: "In the menu" }),
          this.menuScroll
        ),
        h(
          "section",
          { class: "fz-mc-col fz-mc-col-side" },
          h("div", { class: "fz-mc-col-title" }, "Hidden", this.hiddenCount),
          this.hiddenScroll,
          h("div", { class: "fz-mc-col-title", text: "Add" }),
          h("div", { class: "fz-mc-scroll fz-mc-add-scroll" }, this.addGrid)
        )
      );
      const sep = document.createXULElement("menuseparator");
      sep.className = EDIT_CLASS;
      const footer = h(
        "div",
        { class: `${EDIT_CLASS} fz-mc-footer` },
        this.resetButton,
        h("span", { class: "fz-mc-spacer" }),
        h("button", {
          type: "button",
          class: "fz-mc-button",
          text: "Cancel",
          onclick: () => this.popup.hidePopup(),
        }),
        h("button", {
          type: "button",
          class: "fz-mc-button fz-mc-done",
          text: "Done",
          onclick: () => this.done(),
        })
      );
      this.parts = [header, this.body, sep, footer];
    }

    newAddedRow(action) {
      return this.withRid({ kind: "added", uid: Math.random().toString(36).slice(2, 10), action: action.id });
    }

    flash(rid) {
      const el = this.body.querySelector(`[data-rid="${rid}"]`);
      el?.scrollIntoView({ block: "nearest" });
      el?.animate(
        [{ backgroundColor: "color-mix(in srgb, var(--fz-accent, AccentColor) 30%, transparent)" }, {}],
        { duration: 900, easing: "ease-out" }
      );
    }

    isChanged() {
      return (
        this.rows.some(r => r.removed || r.kind === "added") ||
        (!this.reset && this.original.moves.length > 0) ||
        this.rows.some((r, i) => this.startIndex.get(r.rid) !== i)
      );
    }

    // ---- rows ----

    buildRow(row) {
      if (row.kind === "divider") {
        return h("div", { class: "fz-mc-row fz-mc-divider", "data-rid": row.rid, "aria-hidden": "true" });
      }
      const action = row.kind === "added" ? ACTION_BY_ID.get(row.action) : null;
      const separator = row.kind === "separator" || action?.separator;
      const label = action ? action.label : row.label;
      // Hidden rows are listed by name, separators included
      const inMenu = !row.removed;

      const grip = h("span", { class: "fz-mc-grip", "aria-hidden": "true" });
      let body;
      if (separator && inMenu) {
        body = [h("span", { class: "fz-mc-sep-line", "aria-hidden": "true" })];
      } else if (row.buttons?.length && inMenu) {
        body = [
          h(
            "span",
            { class: "fz-mc-buttons", title: label },
            ...row.buttons.map(b => {
              const icon = h("span", { class: "fz-mc-icon fz-mc-button-icon", title: b.label });
              if (b.icon) {
                icon.style.backgroundImage = b.icon;
              }
              return icon;
            })
          ),
        ];
      } else {
        const icon = h("span", { class: `fz-mc-icon${separator ? " fz-mc-sep-icon" : ""}`, "aria-hidden": "true" });
        if (action && !separator) {
          icon.setAttribute("data-action", action.id);
        } else if (row.icon) {
          icon.style.backgroundImage = row.icon;
        }
        body = [icon, h("span", { class: "fz-mc-label", text: label, title: label })];
      }

      // × hides (or deletes what you added); Hidden rows have a restore button
      let control;
      if (action) {
        control = h("button", {
          type: "button",
          class: "fz-mc-x",
          title: "Remove",
          "aria-label": `Remove ${label}`,
          onclick: () => {
            this.rows = this.rows.filter(r => r !== row);
            this.render();
          },
        });
      } else if (inMenu) {
        control = h("button", {
          type: "button",
          class: "fz-mc-x",
          title: "Hide",
          "aria-label": `Hide ${label}`,
          onclick: () => this.setRemoved(row, true),
        });
      } else {
        control = h("button", {
          type: "button",
          class: "fz-mc-restore",
          title: "Show in the menu again",
          "aria-label": `Show ${label}`,
          onclick: () => this.setRemoved(row, false),
        });
      }

      const el = h(
        "div",
        {
          class: `fz-mc-row${separator && inMenu ? " fz-mc-sep-row" : ""}`,
          role: "listitem",
          "data-rid": row.rid,
          "data-disabled": !action && row.disabled,
          "data-submenu": !action && row.submenu,
          "data-added": !!action,
        },
        grip,
        ...body,
        control
      );
      el.addEventListener("pointerdown", e => this.pointerDown(e, { row, el }));
      return el;
    }

    setRemoved(row, removed) {
      if (row.kind === "added" || row.kind === "divider") {
        return;
      }
      row.removed = removed;
      this.render();
      this.flash(row.rid);
    }

    render() {
      const hidden = this.rows.filter(r => r.removed);
      this.list.replaceChildren(...this.rows.filter(r => !r.removed).map(r => this.buildRow(r)));
      this.hiddenList.replaceChildren(...hidden.map(r => this.buildRow(r)));
      this.hiddenEmpty.hidden = hidden.length > 0;
      this.hiddenCount.textContent = hidden.length ? String(hidden.length) : "";
      this.renderAdd();
      this.resetButton.disabled = !this.isChanged();
    }

    renderAdd() {
      const taken = new Set(this.rows.filter(r => r.kind === "added").map(r => r.action));
      this.addGrid.replaceChildren(
        ...ACTIONS.filter(a => !a.available || a.available()).map(a => {
          const chip = h(
            "button",
            {
              type: "button",
              class: `fz-mc-chip${a.separator ? " fz-mc-chip-sep" : ""}`,
              title: `Click to add ${a.label} at the end, or drag it into the menu`,
              disabled: !a.separator && taken.has(a.id),
            },
            a.separator
              ? h("span", { class: "fz-mc-sep-line", "aria-hidden": "true" })
              : h("span", { class: "fz-mc-icon", "data-action": a.id, "aria-hidden": "true" }),
            h("span", { text: a.label })
          );
          chip.addEventListener("pointerdown", e => !chip.disabled && this.pointerDown(e, { action: a, chip }));
          return chip;
        })
      );
    }

    // ---- dragging ----
    // A drag starts after a small move, or after holding still for a moment.
    // From a chip, the new row appears once the pointer is over the menu.

    pointerDown(e, source) {
      if (e.button !== 0 || this.drag || e.target.closest(".fz-mc-x, .fz-mc-restore")) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const target = source.el ?? source.chip;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {}
      const drag = {
        ...source,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        started: false,
        timer: setTimeout(() => this.beginDrag(), HOLD_MS),
      };
      this.drag = drag;
      const move = ev => {
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        if (
          !drag.started &&
          Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) > DRAG_THRESHOLD
        ) {
          this.beginDrag();
        }
        if (drag.started) {
          this.follow();
        }
      };
      const up = ev => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        clearTimeout(drag.timer);
        if (this.drag !== drag) {
          return; // Esc ended it
        }
        this.drag = null;
        if (drag.started) {
          this.endDrag(drag, ev.type === "pointercancel");
        } else if (ev.type === "pointerup") {
          this.click(drag);
        }
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    }

    click(drag) {
      if (drag.chip) {
        const row = this.newAddedRow(drag.action);
        this.rows.push(row);
        this.render();
        this.flash(row.rid);
      } else if (drag.row.removed) {
        // A click on a hidden row shows it again
        this.setRemoved(drag.row, false);
      }
    }

    beginDrag() {
      const drag = this.drag;
      if (!drag || drag.started || drag.row?.kind === "divider") {
        return;
      }
      clearTimeout(drag.timer);
      drag.started = true;
      if (drag.el) {
        const r = drag.el.getBoundingClientRect();
        drag.offsetX = drag.startX - r.left;
        drag.offsetY = drag.startY - r.top;
        drag.el.setAttribute("data-dragging", "true");
      } else {
        // The row a chip will become
        drag.row = this.newAddedRow(drag.action);
        drag.el = this.buildRow(drag.row);
        drag.el.setAttribute("data-dragging", "true");
        drag.offsetX = 24;
        drag.offsetY = 14;
        drag.chip.setAttribute("data-dragging", "true");
      }
      this.body.setAttribute("data-dragging", "true");
      this.follow();
    }

    inside(box, x, y) {
      const r = box.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    follow() {
      const drag = this.drag;
      const { el, x, y } = drag;
      const overHidden = drag.row.kind !== "added" && this.inside(this.hiddenScroll, x, y);
      const overMenu = this.inside(this.menuScroll.parentNode, x, y);
      this.hiddenScroll.toggleAttribute("data-over", overHidden);

      if (overHidden) {
        if (el.parentNode !== this.hiddenList) {
          this.hiddenList.append(el);
          this.hiddenEmpty.hidden = true;
        }
      } else if (overMenu || (drag.row && !drag.chip)) {
        // Over the menu (a row also keeps its last place when it strays)
        if (overMenu || el.parentNode !== this.list) {
          this.placeInMenu(el, y);
        }
      } else if (el.parentNode) {
        // A chip's row leaves the menu again
        el.remove();
      }

      if (drag.chip) {
        // The chip follows the pointer until its row is in the menu
        drag.chip.style.transform = el.parentNode
          ? ""
          : `translate(${x - drag.startX}px, ${y - drag.startY}px)`;
        drag.chip.toggleAttribute("data-placed", !!el.parentNode);
      }
      if (el.parentNode) {
        el.style.transform = "";
        const natural = el.getBoundingClientRect();
        el.style.transform = `translate(${x - drag.offsetX - natural.left}px, ${y - drag.offsetY - natural.top}px)`;
      }

      // Scroll the column under the pointer near its edges
      for (const scroller of [this.menuScroll, this.hiddenScroll]) {
        const box = scroller.getBoundingClientRect();
        if (x >= box.left && x <= box.right) {
          if (y < box.top + 24 && y > box.top - 40) {
            scroller.scrollTop -= 8;
          } else if (y > box.bottom - 24 && y < box.bottom + 40) {
            scroller.scrollTop += 8;
          }
        }
      }
    }

    placeInMenu(el, y) {
      const siblings = [...this.list.children].filter(c => c !== el);
      const before =
        siblings.find(c => {
          const r = c.getBoundingClientRect();
          return r.top + r.height / 2 > y;
        }) ?? null;
      if (el.parentNode === this.list && before === el.nextElementSibling) {
        return;
      }
      // Slide the rows that make room (FLIP)
      const tops = new Map(siblings.map(c => [c, c.getBoundingClientRect().top]));
      this.list.insertBefore(el, before);
      for (const c of siblings) {
        const delta = tops.get(c) - c.getBoundingClientRect().top;
        if (delta) {
          c.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
            duration: 140,
            easing: "ease-out",
          });
        }
      }
    }

    endDrag(drag, cancelled) {
      this.body.removeAttribute("data-dragging");
      this.hiddenScroll.removeAttribute("data-over");
      if (drag.chip) {
        drag.chip.removeAttribute("data-dragging");
        drag.chip.removeAttribute("data-placed");
        drag.chip.style.transform = "";
      }
      drag.el.removeAttribute("data-dragging");
      drag.el.style.transform = "";
      if (cancelled || (drag.chip && drag.el.parentNode !== this.list)) {
        drag.el.remove();
        this.render();
        return;
      }

      const byRid = new Map(this.rows.map(r => [r.rid, r]));
      byRid.set(drag.row.rid, drag.row);
      drag.row.removed = drag.el.parentNode === this.hiddenList;
      const old = drag.chip ? [...this.rows, drag.row] : this.rows;
      // The menu's new order, with hidden rows kept after the row they followed
      const result = [...this.list.children].map(c => byRid.get(c.dataset.rid));
      const placed = new Set(result);
      old.forEach((row, i) => {
        if (placed.has(row)) {
          return;
        }
        let at = 0;
        for (let j = i - 1; j >= 0; j--) {
          // Not after the row being dragged: it left that place
          if (old[j] === drag.row && row !== drag.row) {
            continue;
          }
          const index = result.indexOf(old[j]);
          if (index >= 0) {
            at = index + 1;
            break;
          }
        }
        result.splice(at, 0, row);
        placed.add(row);
      });
      this.rows = result;
      this.render();
      this.flash(drag.row.rid);
    }

    keydown(e) {
      if (e.key !== "Escape") {
        return;
      }
      // Esc drops a drag first, then the edit
      e.preventDefault();
      e.stopPropagation();
      const drag = this.drag;
      if (drag) {
        clearTimeout(drag.timer);
        this.drag = null;
        if (drag.started) {
          this.endDrag(drag, true);
        }
      } else {
        this.popup.hidePopup();
      }
    }

    // ---- results ----

    restoreDefault() {
      this.reset = true;
      // Firefox's own order: undo the moves (they come back on Cancel)
      undoMoves(this.popup);
      const order = new Map([...this.popup.children].map((el, i) => [el, i]));
      this.rows = this.rows
        .filter(r => r.kind !== "added")
        .map(r => ({ ...r, removed: false }))
        .sort((a, b) => order.get(a.el) - order.get(b.el));
      this.markOrder();
      this.render();
    }

    save() {
      const native = this.rows.filter(r => r.key);
      const keep = longestIncreasing(native.map(r => this.startIndex.get(r.rid)));
      const movedNow = new Set(native.filter((r, i) => !keep.has(i)).map(r => r.key));
      const oldMoves = this.reset ? [] : this.original.moves;
      const oldMoved = new Set(oldMoves.map(m => m.key));
      const shown = new Set(native.map(r => r.key));

      // Moves of items this menu didn't show here stay, first
      const moves = oldMoves.filter(m => !m.key.startsWith("+") && !shown.has(m.key));
      let after = null;
      for (const row of this.rows) {
        if (row.kind === "divider") {
          continue;
        }
        const key = row.kind === "added" ? "+" + row.uid : row.key;
        if (row.kind === "added" || movedNow.has(key) || oldMoved.has(key)) {
          moves.push({ key, after });
        }
        after = key;
      }

      const removed = this.reset ? [] : this.original.removed.filter(k => !shown.has(k));
      removed.push(...this.rows.filter(r => r.removed).map(r => r.key));
      const added = this.rows.filter(r => r.kind === "added").map(r => ({ uid: r.uid, action: r.action }));
      writeMenu(this.menuId, { removed: [...new Set(removed)], added, moves });
    }

    done() {
      this.save();
      this.saved = true;
      this.leave();
      // Show the result in the same, still open menu
      applyLayout(this.popup, readMenus()[this.menuId] ?? null);
      tidySeparators(this.popup);
    }

    leave() {
      if (this.drag) {
        clearTimeout(this.drag.timer);
        this.drag = null;
      }
      this.popup.removeEventListener("popuphidden", this.onHidden);
      window.removeEventListener("keydown", this.onKey, true);
      for (const part of this.parts) {
        part.remove();
      }
      this.popup.removeAttribute(EDITING_ATTR);
      if (session === this) {
        session = null;
      }
    }

    // The menu closed: Cancel (Restore default's undone moves come back
    // when the menu next opens).
    end() {
      if (!this.saved) {
        this.leave();
      }
    }
  }

  // ---- on / off ----

  function update() {
    applySheet();
    if (!enabled()) {
      removeAll();
      return;
    }
    if (!showButton()) {
      session?.popup.hidePopup();
      for (const el of document.querySelectorAll(`.${ENTRY_CLASS}, .${ENTRY_SEP_CLASS}`)) {
        el.remove();
      }
    }
    // Added items follow the new layout next time each menu opens
    const menus = readMenus();
    for (const el of document.querySelectorAll(`menupopup > [${ADDED_ATTR}]`)) {
      const popup = el.parentNode;
      if (!menus[popup.id]?.added.some(a => a.uid === el.getAttribute(ADDED_ATTR))) {
        el.remove();
      }
    }
  }

  const prefObserver = { observe: update };
  Services.prefs.addObserver(PREF, prefObserver);
  Services.prefs.addObserver(DATA_PREF, prefObserver);
  Services.prefs.addObserver(BUTTON_PREF, prefObserver);
  window.addEventListener("contextmenu", onContextMenu, true);
  window.addEventListener("mousedown", onOtherInput, true);
  window.addEventListener("keydown", onOtherInput, true);
  window.addEventListener("popupshowing", onPopupShowing);
  window.addEventListener("popupshown", onPopupShown);

  window.addEventListener(
    "unload",
    () => {
      Services.prefs.removeObserver(PREF, prefObserver);
      Services.prefs.removeObserver(DATA_PREF, prefObserver);
      Services.prefs.removeObserver(BUTTON_PREF, prefObserver);
    },
    { once: true }
  );

  function restoreAll() {
    session?.popup.hidePopup();
    Services.prefs.clearUserPref(DATA_PREF);
  }

  window.FirefoxZenMenuCustomizer = { actions: ACTIONS, readMenus, writeMenu, restoreAll };

  update();
})();
