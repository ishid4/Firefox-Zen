// ==UserScript==
// @name           Firefox-Zen Floating URL Bar
// @description    Lifts the URL bar input into the top layer while it is active, so it can float centered over the page
// @include        main
// ==/UserScript==

// Toolbar ancestors trap and clip `position: fixed`, so CSS alone can't float the
// input. Showing it as a manual popover moves it to the top layer (the same layer
// Firefox uses for the results list), and theme/general.css positions it there.
//
// With the address bar in the sidebar (JS/firefox-zen-sidebar-urlbar.uc.js),
// editing it (click, Ctrl+L) floats it in place instead, Arc-style: over the
// sidebar's field and wider than it ([fz-float="anchored"], placed from
// --fz-anchor-* set here). A new tab (JS/firefox-zen-urlbar-newtab.uc.js), or a
// field that isn't on screen (sidebar collapsed or slid away), still gets the
// centered bar.

(function () {
  "use strict";

  const PREF = "firefox-zen.floating-urlbar";
  const MODE_ATTR = "fz-float";
  const ANCHORED_WIDTH = 560; // px, at most; never narrower than the field
  const ANCHORED_HEIGHT = 48; // matches --fz-urlbar-height
  const MARGIN = 8;

  const urlbar = document.getElementById("urlbar");
  const box = urlbar?.querySelector(":scope > .urlbar-input-container");
  if (!box) {
    return;
  }

  // Where the field is in the sidebar, if it's on screen to anchor to
  function sidebarField() {
    if (!document.documentElement.hasAttribute("fz-sidebar-urlbar") || urlbar.hasAttribute("fz-newtab")) {
      return null;
    }
    const rect = urlbar.getBoundingClientRect();
    const onScreen = rect.width >= 120 && rect.height > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
    return onScreen ? rect : null;
  }

  function place() {
    const rect = sidebarField();
    if (!rect) {
      urlbar.setAttribute(MODE_ATTR, "center");
      return;
    }
    const width = Math.max(rect.width, Math.min(ANCHORED_WIDTH, window.innerWidth - 2 * MARGIN));
    // Grow away from the window edge the sidebar is on
    const left =
      rect.left + width <= window.innerWidth - MARGIN ? rect.left : Math.max(MARGIN, rect.right - width);
    const top = Math.max(MARGIN / 2, rect.top + rect.height / 2 - ANCHORED_HEIGHT / 2);
    urlbar.style.setProperty("--fz-anchor-left", `${left}px`);
    urlbar.style.setProperty("--fz-anchor-top", `${top}px`);
    urlbar.style.setProperty("--fz-anchor-width", `${width}px`);
    urlbar.setAttribute(MODE_ATTR, "anchored");
  }

  function update() {
    const active = urlbar.hasAttribute("focused") || urlbar.hasAttribute("popover-open");
    const want = active && Services.prefs.getBoolPref(PREF, false);
    const shown = box.matches(":popover-open");

    if (want && !shown) {
      place();
      // Only carry the popover attribute while shown; the UA hides closed popovers.
      box.setAttribute("popover", "manual");
      box.showPopover();
    } else if (want && shown) {
      // Turned into a new tab's bar (Ctrl+T while editing): re-place it
      const mode = urlbar.getAttribute(MODE_ATTR);
      if (mode === "anchored" && !sidebarField()) {
        place();
      }
    } else if (!want && shown) {
      box.hidePopover();
      box.removeAttribute("popover");
      urlbar.removeAttribute(MODE_ATTR);
    }
  }

  const mo = new MutationObserver(update);
  mo.observe(urlbar, { attributes: true, attributeFilter: ["focused", "popover-open", "fz-newtab"] });

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
