// ==UserScript==
// @name           Firefox-Zen Colors
// @description    Paints the window with the active color scheme and switches it between light and dark
// @include        main
// ==/UserScript==

// The schemes and the palette engine are the background module
// JS/firefox-zen-colors.sys.mjs; theme/colors.css maps the tokens set here
// onto Firefox's own variables.
//
// - Scheme: the active space's own (JS/firefox-zen-spaces.uc.js), else
//   firefox-zen.colors.active. Its tokens go inline on <html> as --fz-<name>
//   (both halves as light-dark()), then [fz-colors] turns the mapping on.
//   "Firefox theme" removes both. Going from one scheme to another (switching
//   spaces, say) fades the window from the old paint: --fz-prev-* hold it
//   for theme/colors.css while [fz-colors-fade] is set.
// - Mode: firefox-zen.colors.mode (system / light / dark), or the scheme's
//   own mode when it forces one. Light/dark sets this window's
//   prefers-color-scheme override, the same switch Firefox's theme code uses;
//   system leaves Firefox's own choice. Firefox resets the override on every
//   theme update, so it's put back after each one (windowlwthemeupdate).
//   Websites follow through a pref the module sets (the Settings mode and
//   scheme only: it's one pref for every window).

(function () {
  "use strict";

  const { FzColors } = ChromeUtils.importESModule("chrome://userscripts/content/firefox-zen-colors.sys.mjs");
  const ATTR = "fz-colors";
  const root = document.documentElement;

  // What Firefox's theme code chose ("light", "dark" or "none"), to give back
  // in system mode
  let themeOverride = window.browsingContext.prefersColorSchemeOverride;
  let applied = [];
  // The scheme painted now, as JSON, so unchanged updates (FzSpacesChanged
  // comes with every tab switch) cost nothing
  let paintedKey = null;
  let paintedTokens = null;
  let fadeTimer = null;

  const FADE_MS = 400;
  const PREV = ["frame-bg", "frame-gradient-light", "frame-gradient-dark"];

  // The active space's scheme, else the Settings one
  function windowScheme() {
    const spaces = window.FirefoxZenSpaces;
    if (spaces?.enabled()) {
      const space = spaces.list().find(s => s.id === spaces.activeId());
      const scheme = space?.scheme && FzColors.schemeById(space.scheme);
      if (scheme) {
        return scheme;
      }
    }
    return FzColors.activeScheme();
  }

  // Keeps the old paint on top and fades it out
  function fadeFrom(tokens) {
    clearTimeout(fadeTimer);
    for (const name of PREV) {
      root.style.setProperty(`--fz-prev-${name}`, tokens[name]);
    }
    root.setAttribute("fz-colors-fade", "start");
    // Flush, so the fade starts from the old paint
    getComputedStyle(document.body, "::before").opacity;
    root.setAttribute("fz-colors-fade", "run");
    fadeTimer = setTimeout(() => {
      root.removeAttribute("fz-colors-fade");
      for (const name of PREV) {
        root.style.removeProperty(`--fz-prev-${name}`);
      }
    }, FADE_MS);
  }

  function paint(scheme) {
    const key = JSON.stringify(scheme);
    if (key === paintedKey) {
      return;
    }
    paintedKey = key;
    const tokens = FzColors.tokens(scheme);
    const previous = paintedTokens;
    paintedTokens = tokens;
    if (!tokens) {
      root.removeAttribute(ATTR);
      for (const name of applied) {
        root.style.removeProperty(name);
      }
      applied = [];
      return;
    }
    const names = Object.keys(tokens).map(n => `--fz-${n}`);
    for (const name of applied) {
      if (!names.includes(name)) {
        root.style.removeProperty(name);
      }
    }
    // Tokens before the attribute: the mapping reads them, and --fz-accent
    // would otherwise fall back to the accent it overrides
    for (const [name, value] of Object.entries(tokens)) {
      root.style.setProperty(`--fz-${name}`, value);
    }
    applied = names;
    root.setAttribute(ATTR, scheme.id);
    if (previous) {
      fadeFrom(previous);
    }
  }

  function setMode(scheme) {
    const mode = FzColors.effectiveMode(scheme);
    const want = mode == "system" ? themeOverride : mode;
    if (window.browsingContext.prefersColorSchemeOverride != want) {
      window.browsingContext.prefersColorSchemeOverride = want;
    }
  }

  function update() {
    const scheme = windowScheme();
    paint(scheme);
    setMode(scheme);
  }

  function onThemeUpdate() {
    themeOverride = window.browsingContext.prefersColorSchemeOverride;
    setMode(windowScheme());
  }

  const prefObserver = { observe: update };
  Services.prefs.addObserver(FzColors.PREF_BRANCH, prefObserver);
  window.addEventListener("windowlwthemeupdate", onThemeUpdate);
  // Switched spaces, or a space's scheme changed
  window.addEventListener("FzSpacesChanged", update);

  window.addEventListener(
    "unload",
    () => {
      Services.prefs.removeObserver(FzColors.PREF_BRANCH, prefObserver);
      window.removeEventListener("windowlwthemeupdate", onThemeUpdate);
      window.removeEventListener("FzSpacesChanged", update);
    },
    { once: true }
  );

  window.FirefoxZenColors = { update };

  update();
})();
