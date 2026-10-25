// ==UserScript==
// @name           Firefox-Zen Sidebar Tools
// @description    Lets the always-on "Customize sidebar" gear be hidden, from a checkbox in Customize Sidebar's Tools section
// @include        main
// ==/UserScript==

// Firefox always shows the Customize sidebar button (the gear) in the sidebar
// tools and leaves it out of the Tools checklist. This adds a "Customize
// sidebar button" checkbox to that list, backed by
// firefox-zen.show-customize-button (default true). With it off, the panel is
// still reachable from the sidebar's right-click menu → Customize sidebar.

(function () {
  "use strict";

  const PREF = "firefox-zen.show-customize-button";
  const CHECKBOX_ID = "fz-customize-button-tool";
  const CUSTOMIZE_URL = "chrome://browser/content/sidebar/sidebar-customize.html";

  const showGear = () => Services.prefs.getBoolPref(PREF, true);

  // ---- hide the gear in <sidebar-main>'s shadow root ----

  const hideGearSheet = new CSSStyleSheet();
  hideGearSheet.replaceSync(`moz-button[view="viewCustomizeSidebar"] { display: none !important; }`);

  function applyGear() {
    const root = document.querySelector("sidebar-main")?.shadowRoot;
    if (!root) {
      return;
    }
    const sheets = root.adoptedStyleSheets.filter(s => s !== hideGearSheet);
    root.adoptedStyleSheets = showGear() ? sheets : [...sheets, hideGearSheet];
  }

  // ---- pinned tabs as an icon grid with "Expand sidebar on hover" ----

  // Firefox only grids pinned tabs outside expand-on-hover (rows with titles
  // there). The grid lives on the arrowscrollbox's <slot part="items-wrapper">;
  // a ::part() rule from userChrome.css doesn't take, so style it from inside
  // the shadow root. Tile width/padding and the column template come from
  // general.css's variables.
  const pinnedGridSheet = new CSSStyleSheet();
  // Added/removed with the pref rather than an -moz-pref() media query, which
  // may not parse in a constructed sheet.
  pinnedGridSheet.replaceSync(`
    :host([orient="vertical"]) slot[part~="items-wrapper"] {
      display: grid !important;
      grid-template-columns: var(
        --fz-pinned-columns,
        repeat(auto-fit, minmax(var(--tab-pinned-min-width), auto))
      ) !important;
      grid-auto-rows: var(--tab-height-with-margin-padding);
      padding-inline: var(--fz-pinned-padding-inline, 0);
    }
  `);

  // Other sidebar modes (incl. compact sidebar, which uses "always show"):
  // Firefox's own grid, with general.css's column template (3 per row when
  // expanded). Firefox sets it via ::part(), which an !important rule in the
  // shadow root beats.
  const pinnedColumnsSheet = new CSSStyleSheet();
  pinnedColumnsSheet.replaceSync(`
    :host([orient="vertical"]) slot[part~="items-wrapper"] {
      grid-template-columns: var(
        --fz-pinned-columns,
        repeat(auto-fit, minmax(var(--tab-pinned-min-width), auto))
      ) !important;
    }
  `);

  function applyPinnedGrid() {
    const root = document.getElementById("pinned-tabs-container")?.shadowRoot;
    if (!root) {
      return;
    }
    const hoverMode = Services.prefs.getStringPref("sidebar.visibility", "always-show") === "expand-on-hover";
    const sheets = root.adoptedStyleSheets.filter(s => s !== pinnedGridSheet && s !== pinnedColumnsSheet);
    root.adoptedStyleSheets = [...sheets, hoverMode ? pinnedGridSheet : pinnedColumnsSheet];
  }

  const visibilityObserver = { observe: () => applyPinnedGrid() };

  // Rows the expanded grid needs (3 tiles per row). general.css sizes the
  // container to exactly that in both sidebar states, so the tabs below don't
  // jump on expand; the collapsed single column scrolls the rest.
  const PINNED_PER_ROW = 3;

  function updatePinnedRows() {
    const container = document.getElementById("pinned-tabs-container");
    if (container) {
      const rows = Math.max(1, Math.ceil(gBrowser.pinnedTabCount / PINNED_PER_ROW));
      container.style.setProperty("--fz-pinned-rows", String(rows));
    }
  }

  // TabClose fires before the tab leaves the strip.
  const queuePinnedRows = () => setTimeout(updatePinnedRows, 0);

  // ---- at most MAX_PINS pinned tabs ----

  // Pins the user makes (tab menu, dragging into the pinned area) go through
  // gBrowser.pinTab with a user-triggered metrics context; refuse those once
  // the pins are full. Session restore isn't user-triggered, so a restored
  // window keeps all its pins. The Library checks the limit itself.
  const MAX_PINS = 12;
  const pinCount = () => gBrowser.pinnedTabCount;

  window.FirefoxZenPins = { max: MAX_PINS, count: pinCount, room: () => Math.max(0, MAX_PINS - pinCount()) };

  function limitPinTab() {
    const original = gBrowser.pinTab;
    if (typeof original !== "function" || original.__fzLimit) {
      return;
    }
    const limited = function (tab, options) {
      if (!tab?.pinned && options?.metricsContext?.isUserTriggered && pinCount() >= MAX_PINS) {
        return;
      }
      return original.call(this, tab, options);
    };
    limited.__fzLimit = true;
    gBrowser.pinTab = limited;
  }

  // Tab menu: "3/12" on the right of Pin Tab / Unpin Tab; Pin is disabled
  // when the tabs wouldn't fit. Runs after Firefox's own popupshowing
  // handler (an attribute handler, so it's registered first).
  function onTabMenuShowing(e) {
    if (e.target.id !== "tabContextMenu") {
      return;
    }
    const tabs = window.TabContextMenu?.contextTabs ?? [];
    const newPins = tabs.filter(t => !t.pinned).length;
    const count = `${pinCount()}/${MAX_PINS}`;
    for (const id of ["context_pinTab", "context_pinSelectedTabs"]) {
      const item = document.getElementById(id);
      if (item) {
        item.setAttribute("acceltext", count);
        item.disabled = pinCount() + newPins > MAX_PINS;
      }
    }
    for (const id of ["context_unpinTab", "context_unpinSelectedTabs"]) {
      document.getElementById(id)?.setAttribute("acceltext", count);
    }
  }

  // ---- hold the compact sidebar out while its popups are open ----

  // A right-click menu (tab, sidebar, space menus) is a popup outside the
  // sidebar, so the compact sidebar would lose :hover and slide away under it.
  // While a popup triggered from inside the sidebar is open, mark
  // #sidebar-container[fz-hold]; general.css keeps it out meanwhile.
  const heldPopups = new Set();

  function isInSidebar(node) {
    const container = document.getElementById("sidebar-container");
    while (node && container) {
      if (container.contains(node)) {
        return true;
      }
      // Footer/space menus are triggered from inside <sidebar-main>'s shadow DOM.
      node = node.getRootNode?.()?.host;
    }
    return false;
  }

  function updateHold() {
    document.getElementById("sidebar-container")?.toggleAttribute("fz-hold", heldPopups.size > 0);
  }

  function onPopupShowing(e) {
    const popup = e.target;
    if (!["menupopup", "panel"].includes(popup.localName)) {
      return;
    }
    const trigger = popup.triggerNode ?? popup.anchorNode;
    if (trigger && isInSidebar(trigger)) {
      heldPopups.add(popup);
      updateHold();
    }
  }

  function onPopupHidden(e) {
    if (heldPopups.delete(e.target)) {
      updateHold();
    }
  }

  // ---- checkbox in Customize Sidebar → Tools ----

  async function injectCheckbox() {
    const browser = window.SidebarController?.browser;
    const doc = browser?.contentDocument;
    if (!doc || !doc.documentURI.startsWith(CUSTOMIZE_URL)) {
      return;
    }
    const panel = doc.querySelector("sidebar-customize");
    if (!panel) {
      return;
    }
    await panel.updateComplete;
    const fieldset = panel.shadowRoot?.querySelector("moz-fieldset.customize-group.tools");
    if (!fieldset) {
      return;
    }

    const ensure = () => {
      let box = fieldset.querySelector(`#${CHECKBOX_ID}`);
      if (!box) {
        box = doc.createElement("moz-checkbox");
        box.id = CHECKBOX_ID;
        box.className = "tool";
        box.setAttribute("type", "checkbox");
        box.setAttribute("label", "Customize sidebar button");
        box.setAttribute("iconsrc", "chrome://global/skin/icons/settings.svg");
        box.addEventListener("change", () => Services.prefs.setBoolPref(PREF, box.checked));
        fieldset.append(box);
      }
      box.checked = showGear();
    };
    ensure();

    // The panel re-renders its tool list when tools change; keep ours in it.
    if (!fieldset.__fzObserved) {
      fieldset.__fzObserved = true;
      new MutationObserver(() => {
        if (!fieldset.querySelector(`#${CHECKBOX_ID}`)) {
          ensure();
        }
      }).observe(fieldset, { childList: true });
    }
  }

  const prefObserver = {
    observe() {
      applyGear();
      const box = window.SidebarController?.browser?.contentDocument
        ?.querySelector("sidebar-customize")
        ?.shadowRoot?.querySelector(`#${CHECKBOX_ID}`);
      if (box) {
        box.checked = showGear();
      }
    },
  };

  async function start() {
    await window.delayedStartupPromise;
    await window.SidebarController?.promiseInitialized;

    applyGear();
    applyPinnedGrid();
    window.addEventListener("popupshowing", onPopupShowing, true);
    window.addEventListener("popuphidden", onPopupHidden, true);
    updatePinnedRows();
    limitPinTab();
    document.getElementById("tabContextMenu")?.addEventListener("popupshowing", onTabMenuShowing);
    for (const type of ["TabPinned", "TabUnpinned", "TabOpen", "TabClose"]) {
      gBrowser.tabContainer.addEventListener(type, queuePinnedRows);
    }
    window.addEventListener("SSWindowRestored", queuePinnedRows);
    window.addEventListener("SidebarShown", () => {
      injectCheckbox().catch(e => console.error("firefox-zen-sidebar-tools:", e));
    });
    // The sidebar can re-create its shadow content; re-apply when it renders.
    window.addEventListener("SidebarItemChanged", applyGear);

    Services.prefs.addObserver(PREF, prefObserver);
    Services.prefs.addObserver("sidebar.visibility", visibilityObserver);
    window.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(PREF, prefObserver);
        Services.prefs.removeObserver("sidebar.visibility", visibilityObserver);
      },
      { once: true }
    );

    // Customize panel may already be open at startup.
    injectCheckbox().catch(e => console.error("firefox-zen-sidebar-tools:", e));
  }

  start().catch(e => console.error("firefox-zen-sidebar-tools:", e));
})();
