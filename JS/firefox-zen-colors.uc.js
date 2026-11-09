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

  // ---- grain ----
  // A square of gray noise, repeated over the window from its corner
  // (theme/colors.css: --fz-grain-tile, keep the two in step). One device
  // pixel per noise dot, so it stays crisp at any zoom, and a PNG: a raster
  // tile repeats for free, where an SVG noise filter is redrawn at full
  // window size on every resize and change.
  const GRAIN_TILE = 256;
  // Tiles kept by strength@pixel ratio, as blob: URLs
  const GRAIN_CACHE = 12;
  /** @type {Map<string, Promise<string>>} */
  const grainTiles = new Map();
  let grainWanted = "";

  const grainKey = amount => `${amount}@${window.devicePixelRatio}`;

  function drawGrain(amount) {
    const size = Math.round(GRAIN_TILE * window.devicePixelRatio);
    const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const alpha = Math.round(amount * FzColors.GRAIN_OPACITY * 255);
    for (let i = 0; i < data.length; i += 4) {
      // Bell-shaped around mid gray: soft film grain, not harsh static
      const v = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 64;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = alpha;
    }
    ctx.putImageData(img, 0, 0);
    return new Promise((resolve, reject) =>
      canvas.toBlob(blob => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("grain tile"))), "image/png")
    );
  }

  /**
   * The grain tile for a strength (FzColors.grainOf) as a CSS image, "none"
   * for 0. Made once per strength and pixel ratio.
   * @returns {Promise<string>}
   */
  function grainImage(amount) {
    if (!amount) {
      return Promise.resolve("none");
    }
    const key = grainKey(amount);
    let tile = grainTiles.get(key);
    if (tile) {
      // Most recently used last
      grainTiles.delete(key);
    } else {
      tile = drawGrain(amount);
    }
    grainTiles.set(key, tile);
    // Drop the oldest, never the one this window shows
    for (const [old, url] of grainTiles) {
      if (grainTiles.size <= GRAIN_CACHE) {
        break;
      }
      if (old !== grainWanted) {
        grainTiles.delete(old);
        url.then(u => URL.revokeObjectURL(u), () => {});
      }
    }
    return tile.then(url => `url("${url}")`);
  }

  // The tile comes a moment later; the old one stays until then, so
  // dragging the Grain slider doesn't flicker
  function setGrain(scheme) {
    const amount = FzColors.grainOf(scheme);
    const key = amount ? grainKey(amount) : "";
    if (key === grainWanted && root.style.getPropertyValue("--fz-frame-grain")) {
      return;
    }
    grainWanted = key;
    grainImage(amount).then(
      image => {
        if (grainWanted === key && root.hasAttribute(ATTR)) {
          root.style.setProperty("--fz-frame-grain", image);
        }
      },
      console.error
    );
  }

  // Another pixel ratio (zoom, a move to another screen): sharper tiles
  function watchResolution() {
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        if (paintedScheme) {
          setGrain(paintedScheme);
        }
        watchResolution();
      },
      { once: true }
    );
  }
  watchResolution();

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
      grainWanted = "";
      return;
    }
    // The grain is set apart (setGrain), but goes with the rest
    const names = [...Object.keys(tokens).map(n => `--fz-${n}`), "--fz-frame-grain"];
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
    setGrain(scheme);
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
    grainImage,
  };

  update();
})();
