// ==UserScript==
// @name           Firefox-Zen Tab Sections
// @description    Zen/Arc-style vertical tab list: folders above a line, New Tab and loose tabs below it, with a Clear button
// @include        main
// ==/UserScript==

// Layout (theme/tab-sections.css): inside #tabbrowser-arrowscrollbox, the
// items above the line come first (tab groups, and tabs dropped above the line,
// marked [fz-above]), then Firefox's own New Tab periphery (with a separator
// line and the Clear button added here), then the loose tabs. The CSS does it
// with `order`; this script keeps the DOM in the same order (every item above
// the line before any loose tab), so keyboard navigation, Ctrl+Tab and
// drag-and-drop match what's on screen.
//
// A tab is above the line while it has [fz-above] (saved with the session).
// Dropping a tab decides it by where the pointer is relative to the line;
// moving one otherwise (keyboard, tab menu) by its new neighbours.
//
// Firefox's drag code expects the periphery after every tab, on screen too: it
// keeps dragged tabs above it and shifts it to make room. With the periphery
// in the middle of the list, that would pin loose tabs above the line while
// dragging, so the drag geometry is corrected here (patchDrag).

(function () {
  "use strict";

  const PREF = "firefox-zen.tab-sections";
  const SEPARATOR_ID = "fz-tab-separator";
  const CLEAR_ID = "fz-clear-tabs";
  const ABOVE_ATTR = "fz-above";
  const ABOVE_KEY = "fz-above"; // SessionStore custom tab value
  const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  const { ShortcutUtils } = ChromeUtils.importESModule("resource://gre/modules/ShortcutUtils.sys.mjs");

  const enabled = () => Services.prefs.getBoolPref(PREF, false);

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

  const scrollbox = () => document.getElementById("tabbrowser-arrowscrollbox");
  const periphery = () => document.getElementById("tabbrowser-arrowscrollbox-periphery");

  // Firefox 159 moved isTab/isTabGroup/isSplitViewWrapper and closingTabsEnum
  // from the gBrowser instance to static members of its Tabbrowser class.
  const tabbrowser = () => ("closingTabsEnum" in gBrowser.constructor ? gBrowser.constructor : gBrowser);

  // Sections are laid out (vertical tabs, pref on)
  const active = () => enabled() && scrollbox()?.getAttribute("orient") === "vertical";

  // ---- above / below the line ----

  // A tab or split view directly in the list (not in a folder, not pinned)
  function isLooseItem(el) {
    const tb = tabbrowser();
    return (tb.isTab(el) && !el.pinned) || !!tb.isSplitViewWrapper?.(el);
  }

  const tabsOf = el => (tabbrowser().isSplitViewWrapper?.(el) ? [...el.tabs] : [el]);

  function isAboveItem(el) {
    return tabbrowser().isTabGroup(el) || (isLooseItem(el) && tabsOf(el)[0]?.hasAttribute(ABOVE_ATTR));
  }

  // Not hidden in another space
  function isShown(el) {
    return tabbrowser().isTabGroup(el) ? el.tabs.some(t => !t.hidden) : tabsOf(el).some(t => !t.hidden);
  }

  let changed = false; // a tab crossed the line since the last normalize()

  function setAbove(tab, above) {
    if (tab.hasAttribute(ABOVE_ATTR) === above) {
      return;
    }
    changed = true;
    tab.toggleAttribute(ABOVE_ATTR, above);
    try {
      if (above) {
        SessionStore.setCustomTabValue(tab, ABOVE_KEY, "1");
      } else {
        SessionStore.deleteCustomTabValue(tab, ABOVE_KEY);
      }
    } catch (e) {
      // Not tracked by SessionStore (yet)
    }
  }

  function readAbove(tab) {
    try {
      tab.toggleAttribute(ABOVE_ATTR, !!SessionStore.getCustomTabValue(tab, ABOVE_KEY));
    } catch (e) {}
  }

  // Decisions waiting for normalize(): from moves (neighbours), then from drops
  // (the pointer), which win.
  const moved = new Map();
  const dropped = new Map();

  let normalizeQueued = false;
  let normalizing = false;

  // Apply pending decisions, then move every item above the line that comes
  // after a loose tab to just before the first one, keeping their own order.
  function normalize() {
    normalizeQueued = false;
    const box = scrollbox();
    if (!active() || !box) {
      moved.clear();
      dropped.clear();
      return;
    }
    for (const decisions of [moved, dropped]) {
      for (const [tab, above] of decisions) {
        if (tab.isConnected && !tab.closing) {
          setAbove(tab, above);
        }
      }
      decisions.clear();
    }
    // Pinned or put in a folder: no longer a loose tab above the line
    for (const tab of box.querySelectorAll(`.tabbrowser-tab[${ABOVE_ATTR}]`)) {
      if (tab.pinned || tab.group) {
        setAbove(tab, false);
      }
    }

    let firstLoose = null;
    const late = [];
    for (const el of box.children) {
      if (isAboveItem(el)) {
        if (firstLoose) {
          late.push(el);
        }
      } else if (!firstLoose && isLooseItem(el)) {
        firstLoose = el;
      }
    }
    if (late.length) {
      normalizing = true;
      try {
        gBrowser.moveTabsBefore(late, firstLoose);
      } finally {
        normalizing = false;
      }
    }
    // For the Library, which draws the line too
    if (changed) {
      changed = false;
      window.dispatchEvent(new CustomEvent("FzTabSectionsChanged"));
    }
  }

  // After the event's own work (a drop, a group being built) has finished.
  function queueNormalize() {
    if (!normalizeQueued) {
      normalizeQueued = true;
      setTimeout(normalize, 0);
    }
  }

  // Moved by keyboard or the tab menu: above the line when it lands before
  // something above it, below when it lands after a loose tab.
  function onTabMove(e) {
    const tab = e.target;
    if (!normalizing && active() && !tab.pinned && !tab.group) {
      const item = tab.splitview ?? tab;
      const sibling = dir => {
        let el = item[dir];
        while (el && (el === periphery() || !isShown(el))) {
          el = el[dir];
        }
        return el;
      };
      const next = sibling("nextElementSibling");
      const prev = sibling("previousElementSibling");
      const above = next && isAboveItem(next) ? true : prev && !isAboveItem(prev) ? false : null;
      if (above !== null) {
        for (const t of tabsOf(item)) {
          moved.set(t, above);
        }
      }
    }
    queueNormalize();
  }

  // A link opened from a tab above the line starts at the top of the loose
  // tabs (Firefox puts it right after its opener). Restored tabs have no opener.
  function onTabOpen(e) {
    if (e.target.openerTab) {
      moved.set(e.target, false);
    }
    queueNormalize();
  }

  function onTabUnpinned(e) {
    moved.set(e.target, false);
    queueNormalize();
  }

  function onTabRestoring(e) {
    readAbove(e.target);
    moved.delete(e.target);
    queueNormalize();
  }

  // Session restore sets every tab's values (most tabs load later, without
  // SSTabRestoring); moves it made meanwhile weren't the user's.
  function readAll() {
    for (const tab of gBrowser.tabs) {
      readAbove(tab);
    }
    moved.clear();
    queueNormalize();
  }

  // Middle of the line where it sits in the list, not where a drag has slid
  // it to (deciding by the slid line would keep it slid: the pointer would
  // stay "above" it for another tab's height)
  function lineMiddle(separator) {
    const rect = separator.getBoundingClientRect();
    const slid = new DOMMatrix(getComputedStyle(periphery()).transform).m42;
    return rect.top - slid + rect.height / 2;
  }

  // Runs before Firefox's own drop handler (capture on its container).
  function onDrop(e) {
    if (!active()) {
      return;
    }
    const dragged = e.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    const separator = document.getElementById(SEPARATOR_ID);
    if (!dragged || dragged.ownerDocument !== document || !separator || e.dataTransfer.dropEffect === "copy") {
      return;
    }
    const above = e.clientY < lineMiddle(separator);
    for (const item of dragged._dragData?.movingTabs ?? [dragged]) {
      if (isLooseItem(item)) {
        for (const tab of tabsOf(item)) {
          dropped.set(tab, above);
        }
      }
    }
    queueNormalize();
  }

  // The Library (JS/firefox-zen-library.uc.js) moves tabs across the line
  // by dragging them in its Spaces view.
  window.FirefoxZenTabSections = {
    active,
    setAbove(tabs, above) {
      for (const tab of tabs) {
        dropped.set(tab, above);
      }
      queueNormalize();
    },
  };

  // ---- drag geometry ----

  let dragItem = null; // a dragged tab or split view (not a folder)
  let reserved = null; // { el, space } scroll room kept at the list's end

  // Bottom of the last loose item, in screen pixels
  function looseEndScreenY() {
    let end = null;
    for (const el of scrollbox().children) {
      if (isLooseItem(el) && !isAboveItem(el) && isShown(el)) {
        const b = window.windowUtils.getBoundsWithoutFlushing(el);
        end = Math.max(end ?? -Infinity, b.bottom);
      }
    }
    return end === null ? null : window.mozInnerScreenY + end;
  }

  // The last shown item above the line that isn't being dragged, with the
  // bottom of what it shows (a folder: its last shown tab, or its label)
  function lastAboveItem() {
    const notMoving = el => !el.closest("[dragtarget]");
    for (const el of [...scrollbox().children].reverse()) {
      if (!isAboveItem(el) || !isShown(el) || !notMoving(el)) {
        continue;
      }
      const parts = tabbrowser().isTabGroup(el)
        ? [el.labelElement, ...el.tabs.filter(t => t.visible)].filter(p => p && notMoving(p))
        : [el];
      const bottom = Math.max(...parts.map(p => p.getBoundingClientRect().bottom));
      if (Number.isFinite(bottom)) {
        return { el, bottom };
      }
    }
    return null;
  }

  // What Firefox moves for one of its drag items (a folder: its label row)
  function itemNode(el) {
    return tabbrowser().isTabGroupLabel?.(el) ? el.closest(".tab-group-label-container") : el;
  }

  function patchDrag() {
    const dnd = gBrowser.tabContainer.tabDragAndDrop;
    const peri = periphery();
    if (!dnd || !peri || dnd.__fzSections) {
      return;
    }
    dnd.__fzSections = true;

    // Dragged tabs stop at the periphery's top: report the end of the loose
    // tabs instead while a tab (not a folder) is being moved.
    let proto = Object.getPrototypeOf(peri);
    while (proto && !Object.getOwnPropertyDescriptor(proto, "screenY")) {
      proto = Object.getPrototypeOf(proto);
    }
    const screenY = proto && Object.getOwnPropertyDescriptor(proto, "screenY");
    if (screenY?.get) {
      Object.defineProperty(peri, "screenY", {
        configurable: true,
        get() {
          const real = screenY.get.call(this);
          if (!dragItem || !active() || !gBrowser.tabContainer.hasAttribute("movingtab")) {
            return real;
          }
          const end = looseEndScreenY();
          return end === null ? real : Math.max(real, Math.ceil(end) + 1);
        },
      });
    }

    // When the dragged item leaves the layout, Firefox shifts the periphery
    // down by its size (or reserves that space in front of it while the list
    // scrolls). Right for items above the line; a loose tab is below it.
    const updateStyles = dnd._updateTabStylesOnDrag;
    dnd._updateTabStylesOnDrag = function (tab, dropEffect) {
      const el = itemNode(tab);
      if (!active() || tab.pinned || !el || el.hasAttribute("dragtarget")) {
        return updateStyles.call(this, tab, dropEffect);
      }
      const below = el.getBoundingClientRect().top > peri.getBoundingClientRect().top;
      const result = updateStyles.call(this, tab, dropEffect);
      dragItem = el === tab ? tab : null;

      const space = peri.style.marginBlockStart;
      if (space) {
        // Keep the scroll room at the end of the list instead
        peri.style.marginBlockStart = "";
        const last =
          [...scrollbox().children].findLast(c => isLooseItem(c) && !c.hasAttribute("dragtarget") && isShown(c)) ??
          peri;
        last.style.marginBlockEnd = space;
        reserved = { el: last, space };
      }
      if (below) {
        peri.style.top = "";
      } else if (space) {
        peri.style.top = space;
      }
      return result;
    };

    // Firefox slides the tabs out of the dragged tab's way, but not the
    // periphery (separator + New Tab), which isn't one of its items: slide it
    // the same way, as an item between the last one above the line and the
    // first loose one. Indexes are Firefox's: its list holds the pinned tabs,
    // and folders as their label and tabs.
    //
    // Between the last item above the line and the line itself, Firefox would
    // add the tab to the folder just above, or (over no tab) keep whatever
    // drop position it had: drop it right after that item instead, as a tab
    // above the line ("after the group" is Firefox's own target).
    const animateTabMove = dnd._animateTabMove;
    dnd._animateTabMove = function (event) {
      const result = animateTabMove.call(this, event);
      const dragData = dragItem?._dragData;
      const separator = document.getElementById(SEPARATOR_ID);
      if (!dragData || !separator || !active() || !gBrowser.tabContainer.hasAttribute("movingtab")) {
        return result;
      }
      const tb = tabbrowser();
      const items = this._tabbrowserTabs.dragAndDropElements;
      const moving = dragData.movingTabsSet;
      const index = el => el.currentIndex ?? el.elementIndex;
      const size = dragData.tabHeight ?? 0;
      const from = dragItem.elementIndex;
      // How far an item at index i slides when the drop is at index `to`
      const slide = (i, to) => (i < from && i >= to ? size : i > from && i < to ? -size : 0);

      // A dragged tab from above the line counts where it was
      let lineIndex = -0.5;
      for (const el of items) {
        if (
          (el === dragItem || !moving?.has(el)) &&
          (el.pinned || el.group || tb.isTabGroupLabel?.(el) || isAboveItem(el))
        ) {
          lineIndex = Math.max(lineIndex, index(el) + 0.5);
        }
      }

      const last = lastAboveItem();
      const inGap = !!last && event.clientY < lineMiddle(separator) && event.clientY > last.bottom;
      let to = dragData.animDropElementIndex ?? from;
      if (inGap) {
        to = lineIndex + 0.5;
        dragData.animDropElementIndex = to;
        dragData.dropElement = last.el;
        dragData.dropBefore = false;
        delete dragData.shouldCreateGroupOnDrop;
        delete dragData.shouldDropIntoCollapsedTabGroup;
        this._clearDragOverGroupingTimer?.();
        this._setDragOverGroupColor?.(null);
        const tc = gBrowser.tabContainer;
        tc.removeAttribute("movingtab-group");
        tc.removeAttribute("movingtab-addToGroup");
        tc.setAttribute("movingtab-ungroup", "");
        for (const el of items) {
          if (el !== dragItem && !el.pinned && !moving?.has(el)) {
            const shift = slide(index(el), to);
            itemNode(el).style.transform = shift ? `translateY(${shift}px)` : "";
          }
        }
      }
      // In the gap the tab goes above the line: the line slides as if the
      // drop were just before it
      const shift = slide(lineIndex, inGap ? lineIndex - 0.5 : to);
      peri.style.transform = shift ? `translateY(${shift}px)` : "";
      return result;
    };

    const finishAnimateTabMove = dnd.finishAnimateTabMove;
    dnd.finishAnimateTabMove = function (...args) {
      peri.style.transform = "";
      return finishAnimateTabMove.apply(this, args);
    };

    const resetAfterDrop = dnd._resetTabsAfterDrop;
    dnd._resetTabsAfterDrop = function (...args) {
      dragItem = null;
      peri.style.transform = "";
      if (reserved) {
        reserved.el.style.marginBlockEnd = "";
        reserved = null;
      }
      return resetAfterDrop.apply(this, args);
    };
  }

  // ---- separator line + Clear ----

  // Loose tabs below the line shown in this window (the current space's, when
  // Spaces is on).
  function looseTabs() {
    return gBrowser.tabs.filter(t => !t.pinned && !t.hidden && !t.closing && !t.group && !t.hasAttribute(ABOVE_ATTR));
  }

  function clearTabs() {
    const tabs = looseTabs();
    if (!tabs.length || !gBrowser.warnAboutClosingTabs(tabs.length, tabbrowser().closingTabsEnum.MULTI_SELECTED)) {
      return;
    }
    // Never close the window from here: Firefox opens a fresh tab instead.
    gBrowser.removeTabs(tabs, { closeWindowWithLastTab: false });
  }

  function ensureSeparator() {
    const peri = periphery();
    if (!peri || document.getElementById(SEPARATOR_ID)) {
      return;
    }
    const clear = h("button", {
      id: CLEAR_ID,
      type: "button",
      title: "Close all tabs below the line",
      "aria-label": "Clear tabs",
    });
    clear.append(h("span", { class: "fz-clear-icon", "aria-hidden": "true", text: "↓" }), h("span", { text: "Clear" }));
    clear.addEventListener("click", e => {
      e.stopPropagation();
      clearTabs();
    });
    // The periphery is part of the tab strip: keep its clicks from reaching
    // Firefox's double-click-to-open-a-tab and drag handlers.
    clear.addEventListener("mousedown", e => e.stopPropagation());
    clear.addEventListener("dblclick", e => e.stopPropagation());

    peri.prepend(h("div", { id: SEPARATOR_ID }, h("span", { class: "fz-tab-separator-line" }), clear));
  }

  // ---- New Tab shortcut ----

  // The key's letter comes from Fluent, so it may not be there at startup:
  // read it when the button is first hovered.
  function setupNewTabShortcut() {
    const button = document.getElementById("tabs-newtab-button");
    if (!button || button.__fzShortcut) {
      return;
    }
    button.__fzShortcut = true;
    button.addEventListener("mouseenter", () => {
      if (button.hasAttribute("fz-shortcut")) {
        return;
      }
      const key = document.getElementById("key_newNavigatorTab");
      const text = key && ShortcutUtils.prettifyShortcut(key);
      if (text) {
        button.setAttribute("fz-shortcut", text);
      }
    });
  }

  function init() {
    ensureSeparator();
    setupNewTabShortcut();
    patchDrag();
    queueNormalize();
  }

  const prefObserver = {
    observe() {
      if (enabled()) {
        init();
      }
    },
  };

  async function start() {
    await window.delayedStartupPromise;

    const tc = gBrowser.tabContainer;
    for (const type of ["TabGroupCreate", "TabGrouped", "TabUngrouped", "TabGroupMoved", "TabPinned"]) {
      tc.addEventListener(type, queueNormalize);
    }
    tc.addEventListener("TabMove", onTabMove);
    tc.addEventListener("TabOpen", onTabOpen);
    tc.addEventListener("TabUnpinned", onTabUnpinned);
    tc.addEventListener("SSTabRestoring", onTabRestoring);
    tc.addEventListener("drop", onDrop, true);
    window.addEventListener("SSWindowRestored", readAll);
    // Switching to vertical tabs flips the scrollbox's orient.
    new MutationObserver(queueNormalize).observe(scrollbox(), { attributes: true, attributeFilter: ["orient"] });

    Services.prefs.addObserver(PREF, prefObserver);
    window.addEventListener("unload", () => Services.prefs.removeObserver(PREF, prefObserver), { once: true });

    await SessionStore.promiseInitialized;
    readAll();
    init();
  }

  start().catch(e => console.error("firefox-zen-tab-sections:", e));
})();
