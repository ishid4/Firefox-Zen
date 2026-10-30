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
//   spaces, say) fades the window from the old paint: --fz-fade-image-* hold
//   it, with alphas scaled by --fz-fade, which animates from 1 to 0.
// - Mode: firefox-zen.colors.mode (system / light / dark), or the scheme's
//   own mode when it forces one. Light/dark sets this window's
//   prefers-color-scheme override, the same switch Firefox's theme code uses;
//   system leaves Firefox's own choice. Firefox resets the override on every
//   theme update, so it's put back after each one (windowlwthemeupdate).
//   Websites follow through a pref the module sets (the Settings mode and
//   scheme only: it's one pref for every window).
// - Drafts: the Settings editor's unsaved edits of a scheme, by scheme id.
//   This window shows a scheme's draft in its place until it's saved or
//   reverted; other windows only see saved schemes. Gone at restart.

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
  let paintedScheme = null;
  let fade = null;

  const FADE_MS = 350;

  // The active space's scheme, else the Settings one
  /** @type {Map<string, object>} scheme id -> unsaved edit */
  const drafts = new Map();

  // A scheme as this window shows it: its draft, if it has one
  function withDraft(scheme) {
    return drafts.get(scheme?.id) ?? scheme;
  }

  // The active space's scheme, else the Settings one
  function windowScheme() {
    const spaces = window.FirefoxZenSpaces;
    if (spaces?.enabled()) {
      const space = spaces.list().find(s => s.id === spaces.activeId());
      const scheme = space?.scheme && FzColors.schemeById(space.scheme);
      if (scheme) {
        return withDraft(scheme);
      }
    }
    return withDraft(FzColors.activeScheme());
  }

  // null drops it (saved, reverted). A draft of a deleted scheme is dropped.
  function setDraft(id, scheme) {
    if (scheme) {
      drafts.set(id, scheme);
    } else {
      drafts.delete(id);
    }
    update();
  }

  // Lays the old paint on top and fades it out
  function fadeFrom(scheme) {
    fade?.cancel();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    root.style.setProperty("--fz-fade-image-light", FzColors.fadeImage(scheme, "light"));
    root.style.setProperty("--fz-fade-image-dark", FzColors.fadeImage(scheme, "dark"));
    fade = root.animate([{ "--fz-fade": 1 }, { "--fz-fade": 0 }], { duration: FADE_MS, easing: "ease" });
    const done = fade;
    const clear = () => {
      if (fade === done) {
        fade = null;
        root.style.removeProperty("--fz-fade-image-light");
        root.style.removeProperty("--fz-fade-image-dark");
      }
    };
    fade.finished.then(clear, clear);
  }

  function paint(scheme) {
    const key = JSON.stringify(scheme);
    if (key === paintedKey) {
      return;
    }
    paintedKey = key;
    const tokens = FzColors.tokens(scheme);
    const previous = paintedScheme;
    paintedScheme = tokens ? scheme : null;
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
    // Another scheme, not an edit of this one (the editor writes as you drag)
    if (previous && previous.id !== scheme.id) {
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

  const prefObserver = {
    observe() {
      for (const id of drafts.keys()) {
        if (!FzColors.savedSchemes().some(x => x.id === id)) {
          drafts.delete(id);
        }
      }
      update();
    },
  };
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

  window.FirefoxZenColors = {
    update,
    draft: id => drafts.get(id) ?? null,
    setDraft,
    withDraft,
  };

  update();
})();
