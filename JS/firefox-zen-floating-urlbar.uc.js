// ==UserScript==
// @name           Firefox-Zen Floating URL Bar
// @description    Lifts the URL bar input into the top layer while it is active, so it can float centered over the page
// @include        main
// ==/UserScript==

// Toolbar ancestors trap and clip `position: fixed`, so CSS alone can't float the
// input. Showing it as a manual popover moves it to the top layer (the same layer
// Firefox uses for the results list), and theme/general.css positions it there.

(function () {
  "use strict";

  const PREF = "firefox-zen.floating-urlbar";

  const urlbar = document.getElementById("urlbar");
  const box = urlbar?.querySelector(":scope > .urlbar-input-container");
  if (!box) {
    return;
  }

  function update() {
    const active = urlbar.hasAttribute("focused") || urlbar.hasAttribute("popover-open");
    const want = active && Services.prefs.getBoolPref(PREF, false);
    const shown = box.matches(":popover-open");

    if (want && !shown) {
      // Only carry the popover attribute while shown; the UA hides closed popovers.
      box.setAttribute("popover", "manual");
      box.showPopover();
    } else if (!want && shown) {
      box.hidePopover();
      box.removeAttribute("popover");
    }
  }

  const mo = new MutationObserver(update);
  mo.observe(urlbar, { attributes: true, attributeFilter: ["focused", "popover-open"] });

  const prefObserver = { observe: update };
  Services.prefs.addObserver(PREF, prefObserver);

  window.addEventListener(
    "unload",
    () => {
      mo.disconnect();
      Services.prefs.removeObserver(PREF, prefObserver);
    },
    { once: true }
  );

  update();
})();
