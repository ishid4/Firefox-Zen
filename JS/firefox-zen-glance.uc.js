// ==UserScript==
// @name           Firefox-Zen Glance
// @description    Alt+click (or another modifier+click) a link to peek at it in a floating window
// @include        main
// ==/UserScript==

// A glance is a real tab, kept out of the tab strip, whose panel is shown on top
// of the selected tab (theme/glance.css). Being a real tab, "open as tab" and
// "split view" just hand it over to Firefox, with nothing reloaded.
//
// The window sees Alt+clicks on pages and knows the hovered link (see
// onClick), so no code has to run inside web pages. A plain Alt+click on a
// link does nothing by default (it saves the link only with
// browser.altClickSave), so pages are left alone.
//
// The modifiers are firefox-zen.glance.modifiers ("alt", "ctrl+shift", ...).
// With Ctrl or Shift in them, Firefox also opens the link in a new tab/window
// (ClickHandlerParent, after our click): that one open is swallowed in
// window.openLinkIn (see claimClick).

(function () {
  "use strict";

  const PREF = "firefox-zen.glance";
  const ATTR = "fz-glance";
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  const OPEN_MS = 560;
  const CLOSE_MS = 320;
  // Closing: quick start, soft landing in the clicked spot.
  const CLOSE_EASE = "cubic-bezier(0.32, 0, 0.15, 1)";
  // Card corner radius; it grows as the card shrinks so the small card still
  // reads as rounded (see --fz-glance-radius in theme/glance.css).
  const RADIUS = 12;
  // How far the page underneath sinks back while a glance is open.
  const PUSH_BACK = 0.97;

  // Size of the box the glance grows out of, centered on the click
  // (the link's real size isn't known out here).
  const ORIGIN_SIZE = { width: 220, height: 130 };

  // Glance size as a share of the content area, in thousandths. Dragging the
  // card's edges changes it (see startResize).
  const WIDTH_PREF = "firefox-zen.glance.width";
  const HEIGHT_PREF = "firefox-zen.glance.height";
  const MODIFIERS_PREF = "firefox-zen.glance.modifiers";
  const MODIFIER_KEYS = ["ctrl", "alt", "shift"];
  const DEFAULT_WIDTH = 700;
  const DEFAULT_HEIGHT = 940;
  const MIN_SIZE = { width: 360, height: 240 };
  // Kept free on each side (both sides, so the card stays centered): room for
  // the buttons left and right, a sliver above and below.
  const ROOM_X = 56;
  const ROOM_Y = 8;
  const LAYOUT_PROPS = ["inset", "left", "top", "width", "height"];
  const RESIZE_EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

  // ---- geometry ----
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const ms = duration => (reducedMotion.matches ? 0 : duration);

  // Damped spring sampled into a CSS linear() easing: overshoots ~3%, then
  // settles, so the card lands with a little life instead of just stopping.
  const SPRING = (() => {
    const zeta = 0.75;
    const omega = 12;
    const damped = omega * Math.sqrt(1 - zeta ** 2);
    const points = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const v =
        1 -
        Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
      points.push(i === 60 ? 1 : +v.toFixed(4));
    }
    return `linear(${points.join(", ")})`;
  })();

  // Lets --fz-glance-radius animate smoothly instead of jumping.
  try {
    CSS.registerProperty({ name: "--fz-glance-radius", syntax: "<length>", inherits: false, initialValue: `${RADIUS}px` });
  } catch {}

  // Transform that shrinks the box `to` onto `from` (uniform scale, centered),
  // so it reads as the page growing out of the clicked link. Also returns the
  // scale, for the matching corner radius.
  function shrinkOnto(from, to) {
    let scale = Math.max(from.width / to.width, from.height / to.height);
    if (!from.width || !from.height || !(scale > 0)) {
      from = { x: to.x + to.width / 2, y: to.y + to.height / 2, width: 0, height: 0 };
      scale = 0.9;
    }
    scale = Math.min(Math.max(scale, 0.1), 1);
    const dx = from.x + from.width / 2 - (to.x + (to.width * scale) / 2);
    const dy = from.y + from.height / 2 - (to.y + (to.height * scale) / 2);
    return { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, scale };
  }

  const radiusAt = scale => `${RADIUS / scale}px`;

  // Every running animation of the glance, page underneath included.
  const glanceAnimations = g => [
    ...g.panel.getAnimations({ subtree: true }),
    ...(g.parentContainer?.getAnimations() ?? []),
    ...g.backdrop.getAnimations(),
  ];

  const finished = anim => anim.finished.catch(() => {});

  // ---- glance ----
  // { tab, parentTab, panel, container, parentContainer, backdrop, buttons,
  //   resizers, origin, rect }
  let glance = null;

  function h(tag, attrs = {}) {
    const el = document.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, v);
    }
    return el;
  }

  function buildButtons() {
    const box = h("div", { class: "fz-glance-buttons" });
    const add = (cls, title, action) => {
      const button = h("button", { class: `fz-glance-button ${cls}`, title, "aria-label": title });
      button.addEventListener("click", action);
      box.append(button);
    };
    add("fz-glance-close", "Close (Esc)", () => close());
    add("fz-glance-expand", "Open as tab", () => expand());
    if (typeof gBrowser.addTabSplitView === "function" && Services.prefs.getBoolPref("browser.tabs.splitView.enabled", false)) {
      add("fz-glance-split", "Open in split view", () => expand({ split: true }));
    }
    return box;
  }

  // A non-selected tab only paints while its docshell is active; a process
  // switch (cross-site navigation) gives it a fresh, inactive one.
  function keepRendering() {
    if (glance) {
      glance.tab.linkedBrowser.docShellIsActive = true;
    }
  }

  // `origin`: box in window coordinates to grow out of, or null for the center.
  function open(browser, href, origin) {
    if (glance) {
      // A glance click inside the glance navigates the glance.
      if (browser === glance.tab.linkedBrowser) {
        browser.fixupAndLoadURIString(href, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
        return;
      }
      close({ animate: false });
    }

    const parentTab = gBrowser.getTabForBrowser(browser);
    if (!parentTab?.selected) {
      return;
    }

    const tab = gBrowser.addTrustedTab(href, {
      relatedToCurrent: true,
      skipAnimation: true,
      userContextId: parentTab.userContextId,
    });
    tab.setAttribute(ATTR, "");

    const panel = document.getElementById(tab.linkedPanel);
    const parentPanel = document.getElementById(parentTab.linkedPanel);
    if (!panel || !parentPanel) {
      gBrowser.removeTab(tab, { animate: false });
      return;
    }

    const backdrop = h("div", { id: "fz-glance-backdrop" });
    backdrop.addEventListener("click", () => close());
    parentPanel.append(backdrop);

    const buttons = buildButtons();
    const resizers = buildResizers(panel);
    panel.setAttribute(ATTR, "");
    panel.append(resizers, buttons);

    glance = {
      tab,
      parentTab,
      panel,
      container: panel.querySelector(".browserContainer"),
      parentContainer: parentPanel.querySelector(".browserContainer"),
      backdrop,
      buttons,
      resizers,
      origin: origin ?? { x: 0, y: 0, width: 0, height: 0 },
      rect: layout(panel),
    };
    tab.addEventListener("TabRemotenessChange", keepRendering);
    keepRendering();

    // Grow out of the click on a spring; fade in only at the very start, so
    // you see the card grow rather than a fade.
    const start = shrinkOnto(glance.origin, glance.rect);
    panel.animate([{ transform: start.transform }, { transform: "none" }], {
      duration: ms(OPEN_MS),
      easing: SPRING,
    });
    panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(OPEN_MS * 0.25), easing: "ease-out" });
    glance.container?.animate(
      [{ "--fz-glance-radius": radiusAt(start.scale) }, { "--fz-glance-radius": `${RADIUS}px` }],
      { duration: ms(OPEN_MS), easing: SPRING }
    );
    glance.parentContainer?.animate([{ transform: "none" }, { transform: `scale(${PUSH_BACK})` }], {
      duration: ms(OPEN_MS),
      easing: SPRING,
      fill: "forwards",
    });
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(OPEN_MS * 0.6), easing: "ease-out" });

    tab.linkedBrowser.focus();
  }

  function clampSize(area, width, height) {
    const maxWidth = area.width - 2 * ROOM_X;
    const maxHeight = area.height - 2 * ROOM_Y;
    return {
      width: Math.min(Math.max(width, Math.min(MIN_SIZE.width, maxWidth)), maxWidth),
      height: Math.min(Math.max(height, Math.min(MIN_SIZE.height, maxHeight)), maxHeight),
    };
  }

  // Centers the panel over the visible content area at `size` (pixels; the
  // saved size when omitted). Percentages in CSS would resolve against
  // whatever box contains the panel, which isn't necessarily the content
  // area, so measure both and set pixels. Returns the card's box.
  function layout(panel, size) {
    const area = gBrowser.tabpanels.getBoundingClientRect();
    const { width, height } = clampSize(
      area,
      size?.width ?? (area.width * Services.prefs.getIntPref(WIDTH_PREF, DEFAULT_WIDTH)) / 1000,
      size?.height ?? (area.height * Services.prefs.getIntPref(HEIGHT_PREF, DEFAULT_HEIGHT)) / 1000
    );

    panel.style.inset = "0";
    for (const prop of LAYOUT_PROPS.slice(1)) {
      panel.style.removeProperty(prop);
    }
    const box = panel.getBoundingClientRect();

    panel.style.inset = "auto";
    panel.style.left = `${area.left + (area.width - width) / 2 - box.left}px`;
    panel.style.top = `${area.top + (area.height - height) / 2 - box.top}px`;
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    return {
      x: area.left + (area.width - width) / 2,
      y: area.top + (area.height - height) / 2,
      width,
      height,
    };
  }

  // Edge and corner grips. Dragging one moves both opposite sides, so the
  // card stays centered; the size is saved when the drag ends.
  function buildResizers(panel) {
    const box = h("div", { class: "fz-glance-resizers" });
    for (const edge of RESIZE_EDGES) {
      const grip = h("div", { class: "fz-glance-resizer", "data-edge": edge });
      grip.addEventListener("pointerdown", event => startResize(event, panel, edge));
      box.append(grip);
    }
    return box;
  }

  function startResize(event, panel, edge) {
    if (event.button !== 0 || panel.getAnimations().length) {
      return;
    }
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    panel.toggleAttribute("fz-glance-resizing", true);

    const area = gBrowser.tabpanels.getBoundingClientRect();
    const cx = area.left + area.width / 2;
    const cy = area.top + area.height / 2;
    const start = panel.getBoundingClientRect();
    let size = { width: start.width, height: start.height };

    const onMove = e => {
      size = clampSize(
        area,
        edge.includes("e") || edge.includes("w") ? 2 * Math.abs(e.clientX - cx) : size.width,
        edge.includes("n") || edge.includes("s") ? 2 * Math.abs(e.clientY - cy) : size.height
      );
      const rect = layout(panel, size);
      if (glance?.panel === panel) {
        glance.rect = rect;
      }
    };
    const onEnd = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onEnd);
      grip.removeEventListener("lostpointercapture", onEnd);
      panel.removeAttribute("fz-glance-resizing");
      Services.prefs.setIntPref(WIDTH_PREF, Math.round((size.width / area.width) * 1000));
      Services.prefs.setIntPref(HEIGHT_PREF, Math.round((size.height / area.height) * 1000));
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onEnd);
    grip.addEventListener("lostpointercapture", onEnd);
  }

  function onResize() {
    if (glance && !glance.panel.getAnimations().length) {
      glance.rect = layout(glance.panel);
    }
  }

  // Undo the overlay; `closeTab` also closes the glance tab.
  function teardown(g, { closeTab }) {
    g.tab.removeEventListener("TabRemotenessChange", keepRendering);
    g.backdrop.remove();
    g.buttons.remove();
    g.resizers.remove();
    g.panel.removeAttribute(ATTR);
    g.panel.removeAttribute("fz-glance-resizing");
    g.tab.removeAttribute(ATTR);
    for (const prop of LAYOUT_PROPS) {
      g.panel.style.removeProperty(prop);
    }
    for (const anim of glanceAnimations(g)) {
      anim.cancel();
    }
    if (closeTab && !g.tab.closing) {
      gBrowser.removeTab(g.tab, { animate: false });
    }
  }

  async function close({ animate = true, tabGone = false } = {}) {
    const g = glance;
    if (!g) {
      return;
    }
    glance = null;

    if (animate) {
      // Freeze whatever is mid-flight (e.g. closing while still opening) and
      // carry on from there.
      const elements = [g.panel, g.container, g.parentContainer, g.backdrop].filter(Boolean);
      for (const anim of glanceAnimations(g)) {
        if (elements.includes(anim.effect?.target)) {
          try {
            anim.commitStyles();
          } catch {}
        }
        anim.cancel();
      }
      const now = el => getComputedStyle(el);
      const current = {
        transform: now(g.panel).transform,
        opacity: now(g.panel).opacity,
        radius: g.container && now(g.container).getPropertyValue("--fz-glance-radius"),
        parent: g.parentContainer && now(g.parentContainer).transform,
        backdrop: now(g.backdrop).opacity,
      };
      for (const el of elements) {
        for (const prop of ["transform", "opacity", "--fz-glance-radius"]) {
          el.style.removeProperty(prop);
        }
      }
      g.buttons.hidden = true;
      g.resizers.hidden = true;

      // Shrink back into the clicked spot, fading out only near the end.
      const end = shrinkOnto(g.origin, g.rect);
      const timing = { duration: ms(CLOSE_MS), easing: CLOSE_EASE, fill: "forwards" };
      const anim = g.panel.animate([{ transform: current.transform }, { transform: end.transform }], timing);
      g.panel.animate([{ opacity: current.opacity }, { opacity: current.opacity, offset: 0.55 }, { opacity: 0 }], {
        duration: ms(CLOSE_MS),
        fill: "forwards",
      });
      g.container?.animate(
        [{ "--fz-glance-radius": current.radius || `${RADIUS}px` }, { "--fz-glance-radius": radiusAt(end.scale) }],
        timing
      );
      g.parentContainer?.animate([{ transform: current.parent }, { transform: "none" }], timing);
      g.backdrop.animate([{ opacity: current.backdrop }, { opacity: 0 }], timing);
      await finished(anim);
    }

    teardown(g, { closeTab: !tabGone });
    if (g.parentTab.selected) {
      g.parentTab.linkedBrowser.focus();
    }
  }

  // Hand the glance tab over to Firefox as a normal tab (or a split view).
  function expand({ split = false } = {}) {
    const g = glance;
    if (!g) {
      return;
    }
    glance = null;

    teardown(g, { closeTab: false });
    if (split) {
      try {
        gBrowser.addTabSplitView([g.parentTab, g.tab], { insertBefore: g.parentTab });
      } catch (ex) {
        console.error("Firefox-Zen Glance: split view failed", ex);
      }
    }
    gBrowser.selectedTab = g.tab;
  }

  // ---- events ----
  function onTabSelect(event) {
    if (!glance || event.target === glance.parentTab) {
      return;
    }
    // Ctrl+Tab etc. landed on the glance itself: just keep it as a tab.
    if (event.target === glance.tab) {
      const g = glance;
      glance = null;
      teardown(g, { closeTab: false });
    } else {
      close({ animate: false });
    }
  }

  function onTabClose(event) {
    if (glance && (event.target === glance.parentTab || event.target === glance.tab)) {
      close({ animate: false, tabGone: event.target === glance.tab });
    }
  }

  function onKeyDown(event) {
    if (
      glance &&
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !document.documentElement.hasAttribute("inDOMFullscreen")
    ) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  // The link under the mouse, as the page reports it for the status panel
  // (Firefox's Link Preview reads it the same way). Raw URL, unlike
  // XULBrowserWindow.overLink, which is trimmed for display.
  let hoveredLink = "";

  function onOverLink(event) {
    hoveredLink = event.detail?.url ?? "";
  }

  // Unknown or empty: Alt.
  function modifiers() {
    const set = new Set(Services.prefs.getStringPref(MODIFIERS_PREF, "alt").split("+"));
    return MODIFIER_KEYS.some(k => set.has(k)) ? set : new Set(["alt"]);
  }

  function matchesModifiers(event) {
    const want = modifiers();
    if (
      event.metaKey ||
      event.ctrlKey !== want.has("ctrl") ||
      event.altKey !== want.has("alt") ||
      event.shiftKey !== want.has("shift")
    ) {
      return false;
    }
    // Plain Alt+click saves the link with this on: leave it to Firefox.
    return !(want.size === 1 && want.has("alt") && Services.prefs.getBoolPref("browser.altClickSave", false));
  }

  // The <browser> whose next Firefox link open (new tab/window for Ctrl or
  // Shift) belongs to a glance click, until `until`.
  let claimed = null;
  const CLAIM_MS = 1000;

  function claimClick(browser) {
    claimed = { browser, until: performance.now() + CLAIM_MS };
  }

  const originalOpenLinkIn = window.openLinkIn;
  window.openLinkIn = function (url, where, params) {
    if (claimed && params?.openerBrowser === claimed.browser && performance.now() < claimed.until) {
      claimed = null;
      return undefined;
    }
    return originalOpenLinkIn.apply(this, arguments);
  };

  // The window sees clicks on pages too (target: the <browser>), which is all
  // Glance needs, so no code has to run inside web pages.
  function onClick(event) {
    if (
      event.button !== 0 ||
      event.target.localName !== "browser" ||
      !Services.prefs.getBoolPref(PREF, false) ||
      !matchesModifiers(event)
    ) {
      return;
    }
    const url = URL.parse(hoveredLink);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return;
    }
    claimClick(event.target);

    const origin = {
      x: event.clientX - ORIGIN_SIZE.width / 2,
      y: event.clientY - ORIGIN_SIZE.height / 2,
      ...ORIGIN_SIZE,
    };
    open(event.target, url.href, origin);
  }

  const prefObserver = {
    observe() {
      if (!Services.prefs.getBoolPref(PREF, false)) {
        close({ animate: false });
      }
    },
  };

  gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
  gBrowser.tabContainer.addEventListener("TabClose", onTabClose);
  window.addEventListener("OverLink", onOverLink);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onResize);
  Services.prefs.addObserver(PREF, prefObserver);

  window.addEventListener(
    "unload",
    () => {
      Services.prefs.removeObserver(PREF, prefObserver);
    },
    { once: true }
  );
})();
