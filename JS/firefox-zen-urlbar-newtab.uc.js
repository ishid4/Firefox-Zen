// ==UserScript==
// @name           Firefox-Zen New Tab Address Bar
// @description    Ctrl+T / the + button open the address bar instead of a New Tab page, like Arc and Zen
// @include        main
// ==/UserScript==

// Every user-facing "new tab" (Ctrl+T, the + buttons, File > New Tab) goes
// through BrowserCommands.openTab(). With the pref on, that opens the address
// bar empty instead; what you pick there opens in a new tab. Esc or clicking
// away cancels, and no tab is created. The floating urlbar script floats the
// bar when it's on, since this only focuses it.

(function () {
  "use strict";

  const PREF = "firefox-zen.urlbar-newtab";
  // Set on #urlbar while it stands in for a new tab. Spaces reads it to open
  // the tab in the active space's container.
  const ATTR = "fz-newtab";

  if (!window.BrowserCommands?.openTab || !gURLBar?.controller?.whereToOpen) {
    return;
  }

  let startTab = null;

  const active = () => gURLBar.hasAttribute(ATTR);

  function canTakeOver() {
    return (
      Services.prefs.getBoolPref(PREF, false) &&
      window.toolbar.visible &&
      !gURLBar.readOnly &&
      !document.documentElement.hasAttribute("customizing")
    );
  }

  function enter() {
    startTab = gBrowser.selectedTab;
    gURLBar.setAttribute(ATTR, "true");
    // Empty value + input event: opens the results (top sites) like a new tab would.
    gURLBar.search("");
  }

  function exit({ revert }) {
    if (!active()) {
      return;
    }
    gURLBar.removeAttribute(ATTR);
    // Don't leave the half-typed text on the tab we came from. If the tab
    // changed, Firefox already put that tab's address in the bar.
    if (revert && gBrowser.selectedTab === startTab) {
      gURLBar.handleRevert();
    }
    startTab = null;
  }

  const originalOpenTab = BrowserCommands.openTab;
  BrowserCommands.openTab = function ({ event, url } = {}) {
    const searchClipboard =
      event?.button == 1 &&
      Services.prefs.getBoolPref("middlemouse.paste") &&
      window.gMiddleClickNewTabUsesPasteboard;
    // Shift+click etc. asks for a window; keep Firefox's behavior there.
    const where = event ? BrowserUtils.whereToOpenLink(event, false, true) : "tab";
    if (!url && !searchClipboard && (where == "tab" || where == "current") && canTakeOver()) {
      enter();
      return;
    }
    return originalOpenTab.apply(this, arguments);
  };

  // Enter or a picked result normally loads in the current tab: open a tab
  // instead. Results that already open elsewhere (Alt+Enter, switch-to-tab)
  // are left alone, and so is an empty current tab, which Firefox reuses.
  const controller = gURLBar.controller;
  const originalWhereToOpen = controller.whereToOpen;
  controller.whereToOpen = function (event) {
    let where = originalWhereToOpen.call(this, event);
    if (active() && where == "current" && !gBrowser.selectedTab.isEmpty) {
      where = "tab";
    }
    return where;
  };

  // Esc dismisses right away instead of first closing the results, then
  // reverting. Capture on #urlbar runs before the input's own handler.
  function onKeyDown(event) {
    if (active() && event.key == "Escape" && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      gURLBar.view.close();
      exit({ revert: true });
      gBrowser.selectedBrowser.focus();
    }
  }

  const onBlur = () => exit({ revert: true });
  const onTabSelect = () => exit({ revert: false });

  gURLBar.addEventListener("keydown", onKeyDown, true);
  gURLBar.inputField.addEventListener("blur", onBlur);
  gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);

  const prefObserver = {
    observe() {
      if (!Services.prefs.getBoolPref(PREF, false)) {
        exit({ revert: true });
      }
    },
  };
  Services.prefs.addObserver(PREF, prefObserver);

  window.addEventListener(
    "unload",
    () => {
      Services.prefs.removeObserver(PREF, prefObserver);
      gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
    },
    { once: true }
  );
})();
