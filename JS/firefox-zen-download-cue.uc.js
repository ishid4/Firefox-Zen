// ==UserScript==
// @name           Firefox-Zen Download cue
// @description    A new download flies to the Library button, which then shows its progress and opens on Downloads
// @include        main
// ==/UserScript==

// When a download starts in this window, a small file icon flies from where
// you clicked (or the middle of the page) to the Library button in the spaces
// footer, which ripples and shows the downloads icon for a few seconds
// (firefox-zen.download-cue.icon-seconds, default 7, 0 = never). Meanwhile
// the footer button opens the Library on Downloads (JS/firefox-zen-library.uc.js asks
// window.FirefoxZenDownloadCue). While downloads run, a ring around the button
// fills with their progress.
//
// A compact sidebar slides out for the cue ([fz-download-hold], theme/general.css);
// the icon follows the button while it moves in.
//
// Without the footer (Spaces off), the icon flies to Firefox's Downloads
// toolbar button if it's showing, and that button handles the rest.
//
// firefox-zen.download-cue turns all of it on or off. Looks:
// theme/spaces-footer.css (the footer button), theme/library.css (the dot) and
// theme/downloads.css (the flying icon).

(function () {
  "use strict";

  const PREF = "firefox-zen.download-cue";
  const ICON_PREF = "firefox-zen.download-cue.icon-seconds";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const BAR_ID = "fz-spaces-bar";
  const NEW_ATTR = "fz-download-new";
  const RUNNING_ATTR = "fz-downloading";
  const ICON_ATTR = "fz-download-icon";
  const HOLD_ATTR = "fz-download-hold";

  const FLY_MS = 750;
  const RIPPLE_MS = 630;
  // A click on the page this recent is where the download came from.
  const CLICK_MS = 15000;

  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
  );
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const enabled = () => Services.prefs.getBoolPref(PREF, false);
  const iconSeconds = () => Math.min(Math.max(Services.prefs.getIntPref(ICON_PREF, 7), 0), 10);

  // A new download not yet seen in the Library's Downloads.
  let unseen = false;
  // { x, y, time } of the last click on a page in this window.
  let lastClick = null;
  let holdTimer = null;
  let iconTimer = null;

  function bar() {
    return (
      document.querySelector("sidebar-main")?.shadowRoot?.getElementById(BAR_ID) ??
      document.getElementById(BAR_ID)
    );
  }

  // Laid out (it may still be sliding in with the compact sidebar).
  function shown(el) {
    const r = el?.getBoundingClientRect();
    return !!r && r.width > 0 && r.height > 0;
  }

  // Where the icon lands: the Library button, else Firefox's Downloads button.
  function target() {
    const library = bar()?.querySelector(".fz-library");
    if (shown(library)) {
      return library;
    }
    const downloads = document.getElementById("downloads-button");
    return shown(downloads) ? downloads : null;
  }

  function setUnseen(value) {
    unseen = value;
    document.documentElement.toggleAttribute(NEW_ATTR, value);
  }

  // Keeps a compact sidebar out for `ms` (longer if already held).
  let holdUntil = 0;
  function holdSidebar(ms) {
    const until = performance.now() + ms;
    if (until <= holdUntil) {
      return;
    }
    holdUntil = until;
    document.getElementById("sidebar-container")?.setAttribute(HOLD_ATTR, "");
    clearTimeout(holdTimer);
    holdTimer = setTimeout(releaseSidebar, ms);
  }

  function releaseSidebar() {
    clearTimeout(holdTimer);
    holdUntil = 0;
    document.getElementById("sidebar-container")?.removeAttribute(HOLD_ATTR);
  }

  // The footer button shows the downloads icon for a few seconds. The swap
  // fades and blurs the old icon out and the new one in.
  const SWAP_MS = 160;
  let iconShown = false;

  async function swapIcon(on) {
    const el = bar();
    const button = el?.querySelector(".fz-library");
    iconShown = on;
    if (!button || reducedMotion.matches) {
      el?.toggleAttribute(ICON_ATTR, on);
      return;
    }
    // To the downloads icon: a plain crossfade; back: it also shrinks and
    // springs back.
    const small = on ? "none" : "scale(0.7)";
    try {
      await button.animate(
        [
          { opacity: 1, filter: "blur(0)", transform: "none" },
          { opacity: 0, filter: "blur(3px)", transform: small },
        ],
        { duration: SWAP_MS, easing: "ease-in" }
      ).finished;
    } catch {}
    // Swapped back meanwhile: the newer call finishes the job.
    if (iconShown !== on) {
      return;
    }
    el.toggleAttribute(ICON_ATTR, on);
    button.animate(
      [
        { opacity: 0, filter: "blur(3px)", transform: small },
        { opacity: 1, filter: "blur(0)", transform: on ? "none" : "scale(1.08)", offset: 0.7 },
        { opacity: 1, filter: "blur(0)", transform: "none" },
      ],
      { duration: SWAP_MS * 1.6, easing: "ease-out" }
    );
  }

  function showIcon() {
    const seconds = iconSeconds();
    if (!seconds || !bar()) {
      return;
    }
    clearTimeout(iconTimer);
    iconTimer = setTimeout(hideIcon, seconds * 1000);
    if (!iconShown) {
      swapIcon(true);
    }
  }

  function hideIcon() {
    clearTimeout(iconTimer);
    if (iconShown) {
      swapIcon(false);
    }
  }

  // ---- the flying icon ----

  function fileIcon(download) {
    const name = PathUtils.filename(download.target.path || "") || "file";
    return `moz-icon://${encodeURIComponent(name)}?size=32`;
  }

  function startPoint() {
    if (lastClick && performance.now() - lastClick.time < CLICK_MS) {
      return lastClick;
    }
    const r = gBrowser.tabpanels.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const easeInOut = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

  function land(to) {
    // Ripple once the old icon has faded out.
    const delay = iconSeconds() && !iconShown && !reducedMotion.matches ? SWAP_MS : 0;
    showIcon();
    if (!reducedMotion.matches) {
      to.animate(
        [
          { boxShadow: "0 0 0 0 color-mix(in srgb, AccentColor 60%, transparent)" },
          { boxShadow: "0 0 0 10px transparent" },
        ],
        { duration: RIPPLE_MS, delay, easing: "ease-out", iterations: 2 }
      );
    }
  }

  async function fly(download) {
    // Out for the flight, then while the button shows the downloads icon.
    holdSidebar(FLY_MS + Math.max(iconSeconds() * 1000, RIPPLE_MS * 2));
    // Let a compact sidebar start sliding in before looking for the button.
    await nextFrame();
    await nextFrame();
    const to = target();
    if (!to) {
      releaseSidebar();
      return;
    }
    if (reducedMotion.matches) {
      land(to);
      return;
    }
    const from = startPoint();

    // In the top layer, so it passes over the sidebar and any panel.
    const el = document.createElementNS(HTML_NS, "div");
    el.className = "fz-download-fly";
    el.setAttribute("popover", "manual");
    const img = document.createElementNS(HTML_NS, "img");
    img.src = fileIcon(download);
    img.alt = "";
    el.append(img);
    document.documentElement.append(el);
    el.showPopover();

    // An arc (a quadratic curve whose control point sits above the higher
    // end) to wherever the button is now: it may still be sliding in.
    const start = performance.now();
    for (;;) {
      const t = Math.min((performance.now() - start) / FLY_MS, 1);
      const e = easeInOut(t);
      const r = to.getBoundingClientRect();
      const toX = r.left + r.width / 2;
      const toY = r.top + r.height / 2;
      const cx = (from.x + toX) / 2;
      const cy = Math.min(from.y, toY) - Math.max(80, Math.abs(toX - from.x) * 0.35);
      const x = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * cx + e ** 2 * toX;
      const y = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * cy + e ** 2 * toY;
      el.style.translate = `${x}px ${y}px`;
      el.style.scale = String(t < 0.15 ? 0.6 + (t / 0.15) * 0.6 : 1.2 - (t - 0.15) * 0.8);
      el.style.opacity = String(t < 0.1 ? t / 0.1 : t > 0.9 ? (1 - t) / 0.1 : 1);
      if (t >= 1) {
        break;
      }
      await nextFrame();
    }
    el.remove();
    land(to);
  }

  // ---- which window a download belongs to ----

  function startedHere(download) {
    const id = download.source?.browsingContextId;
    const browser = id && BrowsingContext.get(id)?.top?.embedderElement;
    if (browser) {
      return browser.ownerDocument === document;
    }
    // Saved from a tab that's gone (or no context): the window in front.
    return Services.wm.getMostRecentWindow("navigator:browser") === window;
  }

  // ---- progress ring ----

  function onSummaryChanged(summary) {
    const el = bar();
    if (!el) {
      return;
    }
    const running = enabled() && !summary.allHaveStopped;
    if (!running) {
      el.removeAttribute(RUNNING_ATTR);
      return;
    }
    const total = summary.progressTotalBytes;
    if (total > 0) {
      el.setAttribute(RUNNING_ATTR, "progress");
      el.style.setProperty("--fz-download-progress", String(summary.progressCurrentBytes / total));
    } else {
      el.setAttribute(RUNNING_ATTR, "unknown");
    }
  }

  // ---- setup ----

  // Downloads already in the list when the view is added aren't new.
  let listening = false;
  const listView = {
    onDownloadAdded(download) {
      if (!listening || !enabled() || download.stopped || !startedHere(download)) {
        return;
      }
      const library = window.FirefoxZenLibrary;
      if (!(library?.isOpen() && library.view() === "downloads")) {
        setUnseen(true);
      }
      cuedAt = performance.now();
      fly(download).catch(e => console.error("firefox-zen-download-cue:", e));
    },
  };

  // Firefox opens its downloads panel for a new download
  // (browser.download.alwaysOpenPanel), anchored to its Downloads button. With
  // the address bar in a compact sidebar that open panel holds the sidebar out
  // (theme/general.css), and the cue already shows the download: skip that
  // automatic open while the footer's Library button takes the cue. Clicking
  // the Downloads button still opens the panel.
  const SKIP_PANEL_MS = 2000;
  let cuedAt = -Infinity;

  function wrapDownloadsPanel() {
    const panel = window.DownloadsPanel;
    const showPanel = panel?.showPanel;
    if (typeof showPanel !== "function") {
      return;
    }
    // showPanel(openedManually): true from the button, nothing when automatic.
    panel.showPanel = function (...args) {
      if (args[0] || !enabled() || !bar()?.querySelector(".fz-library")) {
        return showPanel.apply(this, args);
      }
      // Firefox may ask before our list view hears of the download.
      return new Promise(resolve => setTimeout(resolve, 50)).then(() =>
        performance.now() - cuedAt < SKIP_PANEL_MS ? undefined : showPanel.apply(this, args)
      );
    };
  }

  function onClick(event) {
    if (event.button === 0 && event.target.localName === "browser") {
      lastClick = { x: event.clientX, y: event.clientY, time: performance.now() };
    }
  }

  // Also sees firefox-zen.download-cue.icon-seconds (same prefix).
  const prefObserver = {
    observe() {
      if (!enabled()) {
        setUnseen(false);
        releaseSidebar();
        bar()?.removeAttribute(RUNNING_ATTR);
        clearTimeout(iconTimer);
        iconShown = false;
        bar()?.removeAttribute(ICON_ATTR);
      }
    },
  };

  window.FirefoxZenDownloadCue = {
    // Clicking the Library button should open Downloads: it still shows the
    // downloads icon.
    opensDownloads: () => enabled() && iconShown,
    // The Library showed Downloads: the button goes back to the Library icon.
    seen: () => {
      setUnseen(false);
      hideIcon();
    },
  };

  async function start() {
    await window.delayedStartupPromise;
    wrapDownloadsPanel();
    const list = await Downloads.getList(Downloads.ALL);
    await list.addView(listView);
    listening = true;
    const summary = await Downloads.getSummary(
      PrivateBrowsingUtils.isWindowPrivate(window) ? Downloads.PRIVATE : Downloads.PUBLIC
    );
    const summaryView = { onSummaryChanged: () => onSummaryChanged(summary) };
    await summary.addView(summaryView);

    window.addEventListener("click", onClick, true);
    Services.prefs.addObserver(PREF, prefObserver);
    window.addEventListener(
      "unload",
      () => {
        list.removeView(listView);
        summary.removeView(summaryView);
        Services.prefs.removeObserver(PREF, prefObserver);
      },
      { once: true }
    );
  }

  start().catch(e => console.error("firefox-zen-download-cue:", e));
})();
