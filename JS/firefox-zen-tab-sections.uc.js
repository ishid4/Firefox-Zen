// ==UserScript==
// @name           Firefox-Zen Tab Sections
// @description    Zen/Arc-style vertical tab list: folders above a line, New Tab and loose tabs below it, with a Clear button
// @include        main
// ==/UserScript==

// Layout (theme/tab-sections.css): inside #tabbrowser-arrowscrollbox, tab
// groups stay first, then Firefox's own New Tab periphery (with a separator
// line and the Clear button added here), then ungrouped tabs. The CSS does it
// with `order`; this script keeps the DOM in the same order (groups before any
// ungrouped tab), so keyboard navigation, Ctrl+Tab and drag-and-drop match
// what's on screen.

(function () {
  "use strict";

  const PREF = "firefox-zen.tab-sections";
  const SEPARATOR_ID = "fz-tab-separator";
  const CLEAR_ID = "fz-clear-tabs";
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

  // ---- keep folders first in the DOM ----

  let normalizeQueued = false;

  // Move every tab group that comes after an ungrouped tab (or split view) to
  // just before the first one, keeping the groups' own order.
  function normalize() {
    normalizeQueued = false;
    const box = scrollbox();
    if (!enabled() || !box || box.getAttribute("orient") !== "vertical") {
      return;
    }
    let firstLoose = null;
    const late = [];
    for (const el of box.children) {
      if (gBrowser.isTabGroup(el)) {
        if (firstLoose) {
          late.push(el);
        }
      } else if (!firstLoose && (gBrowser.isTab(el) || gBrowser.isSplitViewWrapper?.(el)) && !el.pinned) {
        firstLoose = el;
      }
    }
    if (late.length) {
      gBrowser.moveTabsBefore(late, firstLoose);
    }
  }

  // After the event's own work (a drop, a group being built) has finished.
  function queueNormalize() {
    if (!normalizeQueued) {
      normalizeQueued = true;
      setTimeout(normalize, 0);
    }
  }

  // ---- separator line + Clear ----

  // Ungrouped, unpinned tabs shown in this window (the current space's, when
  // Spaces is on).
  function looseTabs() {
    return gBrowser.tabs.filter(t => !t.pinned && !t.hidden && !t.closing && !t.group);
  }

  function clearTabs() {
    const tabs = looseTabs();
    if (!tabs.length || !gBrowser.warnAboutClosingTabs(tabs.length, gBrowser.closingTabsEnum.MULTI_SELECTED)) {
      return;
    }
    // Never close the window from here: Firefox opens a fresh tab instead.
    gBrowser.removeTabs(tabs, { closeWindowWithLastTab: false });
  }

  function ensureSeparator() {
    const periphery = document.getElementById("tabbrowser-arrowscrollbox-periphery");
    if (!periphery || document.getElementById(SEPARATOR_ID)) {
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

    periphery.prepend(h("div", { id: SEPARATOR_ID }, h("span", { class: "fz-tab-separator-line" }), clear));
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
    for (const type of ["TabGroupCreate", "TabGrouped", "TabUngrouped", "TabGroupMoved", "TabMove", "TabOpen"]) {
      tc.addEventListener(type, queueNormalize);
    }
    window.addEventListener("SSWindowRestored", queueNormalize);
    // Switching to vertical tabs flips the scrollbox's orient.
    new MutationObserver(queueNormalize).observe(scrollbox(), { attributes: true, attributeFilter: ["orient"] });

    Services.prefs.addObserver(PREF, prefObserver);
    window.addEventListener("unload", () => Services.prefs.removeObserver(PREF, prefObserver), { once: true });

    init();
  }

  start().catch(e => console.error("firefox-zen-tab-sections:", e));
})();
