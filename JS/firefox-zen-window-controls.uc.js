// ==UserScript==
// @name           Firefox-Zen Window Controls
// @description    Keeps the compact toolbar open while the pointer is on the macOS traffic lights
// @include        main
// ==/UserScript==

// macOS draws the traffic lights as native buttons over the page, so moving
// the pointer onto them is a mouse exit for Firefox: the compact toolbar (or
// the window-controls row of the address bar in the sidebar) loses :hover and
// collapses under the pointer. When the pointer leaves one of them over its
// button box, mark it [fz-hold-hover] until the pointer moves in the page
// again; theme/general.css and theme/sidebar-urlbar.css keep it open
// meanwhile.

(function () {
  "use strict";

  if (AppConstants.platform !== "macosx") {
    return;
  }

  const HOLD_ATTR = "fz-hold-hover";
  const HOLDERS = ["navigator-toolbox", "fz-titlebar"];
  // Slack around the button box: the exit point can land just outside it
  const SLOP = 4;

  function overButtons(holder, e) {
    for (const box of holder.querySelectorAll(".titlebar-buttonbox-container")) {
      const r = box.getBoundingClientRect();
      if (
        r.width &&
        e.clientX >= r.left - SLOP &&
        e.clientX <= r.right + SLOP &&
        e.clientY >= r.top - SLOP &&
        e.clientY <= r.bottom + SLOP
      ) {
        return true;
      }
    }
    return false;
  }

  // Out of the page (no relatedTarget) from inside a holder, over its buttons.
  // #fz-titlebar is created later by the sidebar URL bar script, so listen on
  // the window.
  function onMouseOut(e) {
    if (e.relatedTarget) {
      return;
    }
    for (const id of HOLDERS) {
      const holder = document.getElementById(id);
      if (holder?.contains(e.target)) {
        if (overButtons(holder, e)) {
          holder.setAttribute(HOLD_ATTR, "");
        }
        return;
      }
    }
  }

  // Back in the page: :hover takes over again (or the toolbar collapses)
  function onMouseMove() {
    for (const id of HOLDERS) {
      document.getElementById(id)?.removeAttribute(HOLD_ATTR);
    }
  }

  window.addEventListener("mouseout", onMouseOut, true);
  window.addEventListener("mousemove", onMouseMove, true);
})();
