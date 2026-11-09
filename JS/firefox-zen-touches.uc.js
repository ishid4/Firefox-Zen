// ==UserScript==
// @name           Firefox-Zen Touches (window)
// @description    The Touches button in the address bar and its panel: list, switch, write a site's touches, pick and change elements
// @include        main
// ==/UserScript==

// The touches themselves (storage, how pages get them) are in
// JS/firefox-zen-touches.sys.mjs. This adds:
// - #fz-touches-button, a page action in the address bar, shown on websites.
//   Filled while a touch is on for the page. With the address bar in the
//   sidebar it's a tile in the page actions panel instead
//   (JS/firefox-zen-sidebar-urlbar.uc.js), which clicks it.
// - #fz-touches-panel, three views:
//   list: the page's touches with a switch each, Zap, New touch.
//   touch: name, where it applies, its element edits (Pick, Zap), its CSS.
//   element: one picked element: which elements (selector), hide, colors,
//   font, size, corners, new text, added HTML.
//   Everything applies to the page as you change it.
// - "Touch up this element…" in the page's context menu.
//
// Picking happens in the page (JS/FzTouch/FzTouchPicker.sys.mjs); the panel
// closes meanwhile and comes back with the element. Zap hides each element
// clicked until Esc. What the page sends back is checked here
// (validSelector) before it goes into a touch.
//
// Single-page apps change their URL without loading a page; the FzTouch
// actor is told to check its touches again when that happens.

(function () {
  "use strict";

  const { FzTouches } = ChromeUtils.importESModule("chrome://userscripts/content/firefox-zen-touches.sys.mjs");

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const BUTTON_ID = "fz-touches-button";
  const PANEL_ID = "fz-touches-panel";
  const CONTEXT_ID = "fz-touches-context";
  // How long typing waits before the page gets the change.
  const TYPE_DELAY = 150;
  const PLACEHOLDER = "/* CSS for this site, applied as you type. For example: */\n\nheader {\n  display: none;\n}";
  const FONT_LABELS = { "": "Default", system: "System", sans: "Sans serif", serif: "Serif", mono: "Monospace" };
  const WHERE_LABELS = { after: "After it", before: "Before it", prepend: "Inside, at the start", append: "Inside, at the end" };

  const pageActions = document.getElementById("page-action-buttons");
  if (!pageActions) {
    return;
  }

  function h(tag, attrs = {}, ...children) {
    const el = document.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) {
        continue;
      }
      if (k === "text") {
        el.textContent = v;
      } else if (typeof v === "function") {
        el.addEventListener(k.replace(/^on/, ""), v);
      } else {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
    el.append(...children.filter(c => c != null && c !== false));
    return el;
  }

  const isWebsite = uri => uri?.schemeIs("http") || uri?.schemeIs("https");
  const currentURI = () => gBrowser.selectedBrowser.currentURI;
  const clip = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

  // A selector that parses and can't break out of the rule it goes in.
  function validSelector(sel) {
    if (!FzTouches.safeSelector(sel)) {
      return false;
    }
    try {
      document.createDocumentFragment().querySelector(sel);
      return true;
    } catch {
      return false;
    }
  }

  function actorFor(browser) {
    try {
      return browser.browsingContext?.currentWindowGlobal?.getActor("FzTouch") ?? null;
    } catch {
      // Not a website: no actor there.
      return null;
    }
  }

  // ---- button ----

  const button = document.createXULElement("hbox");
  button.id = BUTTON_ID;
  button.className = "urlbar-page-action";
  button.setAttribute("role", "button");
  button.setAttribute("tooltiptext", "Touches");
  button.setAttribute("aria-label", "Touches");
  button.hidden = true;
  const icon = document.createXULElement("image");
  icon.className = "urlbar-icon";
  button.append(icon);
  // Firefox's own page actions sit after it (bookmark star last).
  pageActions.prepend(button);

  button.addEventListener("click", e => {
    if (e.button === 0) {
      togglePanel();
    }
  });
  button.addEventListener("keypress", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      togglePanel();
    }
  });

  function updateButton() {
    const uri = currentURI();
    const shown = FzTouches.enabled && isWebsite(uri);
    button.hidden = !shown;
    const count = shown ? FzTouches.activeCount(uri) : 0;
    button.toggleAttribute("fz-active", count > 0);
    // Others shared touches for this site: a dot on the button.
    const community = shown ? FzGallery.forPage(uri).filter(e => !addedFromGallery().has(e.id)).length : 0;
    button.toggleAttribute("fz-community", community > 0);
    button.setAttribute(
      "tooltiptext",
      [count ? `Touches (${count} on)` : "Touches", community ? `${community} shared by others` : null].filter(Boolean).join(" · ")
    );
  }

  // ---- panel state ----

  let panel = null;
  // { view: "list" }
  // { view: "touch", id, draft }  draft: made by New touch, dropped if left empty
  // { view: "element", id, editId, candidates, info, draft }
  let state = { view: "list" };
  // While picking, the panel is closed and keeps its state; the page wears
  // the Touché frame (touchMode) meanwhile.
  let picking = null; // { browser, mode }
  // Pending typed changes: key -> { timer, run }
  const pending = new Map();

  function later(key, run) {
    clearTimeout(pending.get(key)?.timer);
    pending.set(key, { run, timer: setTimeout(() => flushOne(key), TYPE_DELAY) });
  }

  function flushOne(key) {
    const p = pending.get(key);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(key);
      p.run();
    }
  }

  function flushTyping() {
    for (const key of [...pending.keys()]) {
      flushOne(key);
    }
  }

  const isOpen = () => panel?.state === "open" || panel?.state === "showing";

  function ensurePanel() {
    if (panel) {
      return panel;
    }
    panel = document.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Touches");
    panel.setAttribute("orient", "vertical");
    panel.append(h("div", { class: "fz-touches-body" }));
    panel.addEventListener("popupshowing", e => {
      if (e.target === panel) {
        button.setAttribute("open", "true");
      }
    });
    panel.addEventListener("popuphidden", e => {
      if (e.target !== panel) {
        return;
      }
      button.removeAttribute("open");
      flushTyping();
      highlight(null);
      if (picking) {
        return;
      }
      leaveElement();
      dropEmptyDraft();
      state = { view: "list" };
    });
    document.getElementById("mainPopupSet").append(panel);
    return panel;
  }

  function openPanel() {
    ensurePanel();
    render();
    // With the address bar in the sidebar the button only shows while its
    // tile is clicked; anchor to the address bar then.
    const anchor = button.getBoundingClientRect().width ? button : gURLBar.textbox ?? gURLBar;
    panel.openPopup(anchor, "bottomright topright");
  }

  function togglePanel() {
    if (isOpen()) {
      panel.hidePopup();
      return;
    }
    if (!FzTouches.enabled || !isWebsite(currentURI())) {
      return;
    }
    if (picking) {
      stopPicking();
    }
    state = { view: "list" };
    openPanel();
  }

  const body = () => panel.querySelector(".fz-touches-body");

  // Every view, with the last note (flash) kept if it's still fresh.
  function render() {
    renderView();
    if (panel && lastFlash && Date.now() < lastFlash.until) {
      flash(lastFlash.message, lastFlash.until);
    }
  }

  function renderView() {
    if (!panel) {
      return;
    }
    if (state.view === "preview") {
      renderPreview();
      return;
    }
    if (state.view === "signin") {
      renderSignIn();
      return;
    }
    if (state.view === "publish") {
      renderPublish();
      return;
    }
    const t = state.id ? FzTouches.get(state.id) : null;
    if (state.view === "element" && t && FzTouches.getEdit(t.id, state.editId)) {
      renderElement(t, FzTouches.getEdit(t.id, state.editId));
    } else if ((state.view === "touch" || state.view === "element") && t) {
      state = { view: "touch", id: t.id, draft: state.draft };
      renderTouch(t);
    } else {
      state = { view: "list" };
      renderList();
    }
  }

  function host(uri) {
    try {
      return uri.host.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  // The touch picking adds to: the one open in the panel, else the page's
  // first touch that's on, else a new one.
  function targetTouch() {
    const uri = currentURI();
    const open = state.id ? FzTouches.get(state.id) : null;
    if (open && FzTouches.forPage(uri).includes(open)) {
      return { touch: open, draft: !!state.draft };
    }
    const list = FzTouches.forPage(uri);
    const existing = list.find(t => t.enabled) ?? list[0];
    return existing ? { touch: existing, draft: false } : { touch: FzTouches.create(uri), draft: true };
  }

  // ---- list view ----

  function renderList() {
    const uri = currentURI();
    FzGallery.refresh();
    const list = FzTouches.forPage(uri);
    const rows = list.map(t =>
      h(
        "li",
        { class: "fz-touch", "data-id": t.id, "data-off": !t.enabled || null },
        h(
          "button",
          { class: "fz-touch-main", title: "Edit", onclick: () => openTouch(t.id) },
          h("span", { class: "fz-touch-name", text: t.name }),
          h("span", { class: "fz-touch-scope", text: FzTouches.hasContent(t) ? FzTouches.scopeLabel(t.scope) : "Empty" })
        ),
        h("input", {
          type: "checkbox",
          role: "switch",
          class: "fz-switch",
          "aria-label": `${t.name} on`,
          checked: t.enabled,
          onchange: e => FzTouches.setEnabled(t.id, e.target.checked),
        })
      )
    );
    body().replaceChildren(
      h(
        "div",
        { class: "fz-touches-head" },
        h("span", { class: "fz-touches-title", text: "Touches" }),
        h("span", { class: "fz-touches-host", text: host(uri) }),
        menuButton("More", listMenu)
      ),
      rows.length
        ? h("ul", { class: "fz-touches-list" }, ...rows)
        : h("p", {
            class: "fz-touches-empty",
            text: "Restyle this site: pick an element to change, zap what's in the way, or write CSS. Each touch has its own switch.",
          }),
      ...communitySection(uri),
      h(
        "div",
        { class: "fz-touches-foot" },
        h("button", { class: "fz-touches-btn fz-touches-zap", text: "Zap", title: "Click things on the page to hide them", onclick: () => startPicking("zap") }),
        h("button", { class: "fz-touches-btn", text: "Pick element", onclick: () => startPicking("pick") }),
        h("button", { class: "fz-touches-btn fz-touches-primary", text: "New touch", onclick: newTouch })
      )
    );
  }

  function newTouch() {
    const t = FzTouches.create(currentURI());
    state = { view: "touch", id: t.id, draft: true };
    render();
  }

  function openTouch(id) {
    state = { view: "touch", id };
    render();
  }

  function backToList() {
    flushTyping();
    dropEmptyDraft();
    state = { view: "list" };
    render();
  }

  function dropEmptyDraft() {
    const t = state.draft ? FzTouches.get(state.id) : null;
    if (t && !FzTouches.hasContent(t)) {
      FzTouches.remove(t.id);
    }
  }

  // ---- touch view ----

  function renderTouch(t) {
    const uri = currentURI();
    const scopes = FzTouches.scopesFor(uri);
    if (!scopes.some(s => FzTouches.sameScope(s, t.scope))) {
      scopes.unshift(t.scope);
    }
    const scopeSelect = h(
      "select",
      {
        class: "fz-touches-select",
        "aria-label": "Applies to",
        onchange: e => {
          flushTyping();
          FzTouches.update(t.id, { scope: scopes[e.target.selectedIndex] });
        },
      },
      ...scopes.map(s => h("option", { text: FzTouches.scopeLabel(s), selected: FzTouches.sameScope(s, t.scope) }))
    );
    const name = h("input", {
      type: "text",
      class: "fz-touches-name",
      value: t.name,
      maxlength: 80,
      "aria-label": "Name",
      oninput: e => later("name", () => FzTouches.update(t.id, { name: e.target.value })),
    });
    const css = h("textarea", {
      class: "fz-touches-css",
      spellcheck: "false",
      wrap: "off",
      placeholder: PLACEHOLDER,
      "aria-label": "CSS",
      oninput: e => later("css", () => FzTouches.update(t.id, { css: e.target.value })),
      onkeydown: onCodeKey,
    });
    css.value = t.css;

    body().replaceChildren(
      h(
        "div",
        { class: "fz-touches-head" },
        h("button", { class: "fz-touches-icon fz-touches-back", title: "Back", "aria-label": "Back", onclick: backToList }),
        name,
        h("input", {
          type: "checkbox",
          role: "switch",
          class: "fz-switch",
          "aria-label": "On",
          checked: t.enabled,
          onchange: e => FzTouches.setEnabled(t.id, e.target.checked),
        }),
        menuButton("Share or export", anchor => touchMenu(anchor, t))
      ),
      h("label", { class: "fz-touches-field" }, h("span", { text: "Applies to" }), scopeSelect),
      h(
        "div",
        { class: "fz-touches-section" },
        h("span", { text: "Elements" }),
        h("button", { class: "fz-touches-btn fz-touches-small fz-touches-zap", text: "Zap", title: "Click things on the page to hide them", onclick: () => startPicking("zap") }),
        h("button", { class: "fz-touches-btn fz-touches-small", text: "Pick", title: "Click an element on the page to change it", onclick: () => startPicking("pick") })
      ),
      editsList(t),
      h("div", { class: "fz-touches-section" }, h("span", { text: "CSS" })),
      css,
      h(
        "div",
        { class: "fz-touches-foot" },
        h("button", {
          class: "fz-touches-btn fz-touches-danger",
          text: "Delete",
          onclick: () => {
            pending.clear();
            const id = t.id;
            state = { view: "list" };
            FzTouches.remove(id);
            render();
          },
        }),
        h("button", { class: "fz-touches-btn fz-touches-primary", text: "Done", onclick: backToList })
      )
    );
    if (state.draft && !FzTouches.hasContent(t)) {
      css.focus();
    }
  }

  // The touch's element edits; editsShown is what's on screen, so a change
  // elsewhere only rebuilds this list (refreshEdits).
  let editsShown = "";
  const editsKey = t => t.edits.map(e => `${e.id} ${e.sel} ${FzTouches.editSummary(e)}`).join("|");

  function editsList(t) {
    editsShown = editsKey(t);
    if (!t.edits.length) {
      return h("p", { class: "fz-touches-hint fz-edits", text: "Pick an element to restyle it, or zap things away." });
    }
    const rows = t.edits.map(e =>
      h(
        "li",
        { class: "fz-edit" },
        h(
          "button",
          { class: "fz-touch-main", title: "Change", onclick: () => openElement(t.id, e.id) },
          h("span", { class: "fz-edit-sel", text: e.sel }),
          h("span", { class: "fz-touch-scope", text: FzTouches.editSummary(e) })
        ),
        h("button", {
          class: "fz-touches-icon fz-touches-remove",
          title: "Remove",
          "aria-label": `Remove ${e.sel}`,
          onclick: () => FzTouches.removeEdit(t.id, e.id),
        })
      )
    );
    return h("ul", { class: "fz-touches-list fz-edits" }, ...rows);
  }

  function refreshEdits() {
    const t = FzTouches.get(state.id);
    const shown = body().querySelector(".fz-edits");
    if (t && shown && editsKey(t) !== editsShown) {
      shown.replaceWith(editsList(t));
    }
  }

  // Tab indents instead of leaving the box; Shift+Tab un-indents.
  function onCodeKey(e) {
    if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey) {
      return;
    }
    e.preventDefault();
    const box = e.target;
    const { selectionStart: start, selectionEnd: end, value } = box;
    if (!e.shiftKey && start === end) {
      box.setRangeText("  ", start, end, "end");
    } else {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const lines = value.slice(lineStart, end).split("\n");
      const changed = lines.map(l => (e.shiftKey ? l.replace(/^ {1,2}/, "") : "  " + l)).join("\n");
      box.setRangeText(changed, lineStart, end, "select");
    }
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ---- element view ----

  function openElement(touchId, editId, extra = {}) {
    state = { view: "element", id: touchId, editId, draft: state.draft, ...extra };
    render();
  }

  // Leaving the element view: an edit that changes nothing goes.
  function leaveElement() {
    if (state.view !== "element") {
      return;
    }
    flushTyping();
    highlight(null);
    const e = FzTouches.getEdit(state.id, state.editId);
    if (e && FzTouches.editIsEmpty(e)) {
      FzTouches.removeEdit(state.id, e.id);
    }
  }

  function backToTouch() {
    leaveElement();
    state = { view: "touch", id: state.id, draft: state.draft };
    render();
  }

  async function highlight(sel) {
    const actor = actorFor(gBrowser.selectedBrowser);
    try {
      return (await actor?.sendQuery("highlight", { sel })) ?? -1;
    } catch {
      return -1;
    }
  }

  // Colors offered under a color field (the field takes any CSS color too).
  const PALETTE = ["#ffffff", "#f4f4f5", "#a1a1aa", "#3f3f46", "#18181b", "#000000", "#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "transparent"];

  // ---- color picker ----
  //
  // In the panel itself: Firefox's <input type=color> opens the system's
  // color dialog, which takes focus from the window and so closes the panel.
  // A saturation/brightness square, hue and opacity sliders, all dragged
  // with the pointer or moved with the arrow keys.

  let colorCanvas = null;

  // Any CSS color → { r, g, b, a } (0-255, a 0-1), or null.
  function parseColor(value) {
    if (!value || !CSS.supports("color", value)) {
      return null;
    }
    colorCanvas ??= document.createElementNS(HTML_NS, "canvas").getContext("2d");
    colorCanvas.fillStyle = "#000";
    colorCanvas.fillStyle = value;
    const out = colorCanvas.fillStyle;
    if (out.startsWith("#")) {
      return { r: parseInt(out.slice(1, 3), 16), g: parseInt(out.slice(3, 5), 16), b: parseInt(out.slice(5, 7), 16), a: 1 };
    }
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(out);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] } : null;
  }

  function toHex({ r, g, b, a }) {
    const hex = n => Math.round(n).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(a * 255) : ""}`;
  }

  function rgbToHsv({ r, g, b, a }) {
    [r, g, b] = [r / 255, g / 255, b / 255];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    let hue = 0;
    if (d) {
      hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    }
    return { h: (hue * 60 + 360) % 360, s: max ? d / max : 0, v: max, a };
  }

  function hsvToRgb({ h: hue, s, v, a }) {
    const f = n => {
      const k = (n + hue / 60) % 6;
      return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
    };
    return { r: f(5), g: f(3), b: f(1), a };
  }

  // Calls move(x, y) with 0-1 fractions of el while the pointer drags in it.
  function draggable(el, move) {
    const at = ev => {
      const r = el.getBoundingClientRect();
      move(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    el.addEventListener("pointerdown", ev => {
      if (ev.button !== 0) {
        return;
      }
      ev.preventDefault();
      el.focus();
      el.setPointerCapture(ev.pointerId);
      at(ev);
      const onMove = mv => at(mv);
      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("lostpointercapture", onUp);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("lostpointercapture", onUp);
    });
  }

  // onInput(hex) as the color changes. set(value) shows a color.
  function colorPicker(onInput) {
    let hsv = { h: 0, s: 0, v: 0, a: 1 };
    const thumb = cls => h("div", { class: `fz-cp-thumb ${cls ?? ""}` });
    const svThumb = thumb();
    const sv = h("div", { class: "fz-cp-sv", tabindex: 0, role: "slider", "aria-label": "Saturation and brightness" }, svThumb);
    const hueThumb = thumb("fz-cp-bar-thumb");
    const hue = h("div", { class: "fz-cp-bar fz-cp-hue", tabindex: 0, role: "slider", "aria-label": "Hue", "aria-valuemin": 0, "aria-valuemax": 360 }, hueThumb);
    const alphaThumb = thumb("fz-cp-bar-thumb");
    const alphaFill = h("div", { class: "fz-cp-alpha-fill" });
    const alpha = h(
      "div",
      { class: "fz-cp-bar fz-cp-alpha", tabindex: 0, role: "slider", "aria-label": "Opacity", "aria-valuemin": 0, "aria-valuemax": 100 },
      alphaFill,
      alphaThumb
    );
    const preview = h("div", { class: "fz-cp-preview" });

    const show = () => {
      const rgb = hsvToRgb({ ...hsv, a: 1 });
      const solid = toHex(rgb);
      const value = hsv.a === 0 ? "transparent" : toHex({ ...rgb, a: Math.round(hsv.a * 100) / 100 });
      sv.style.setProperty("--hue", `hsl(${hsv.h} 100% 50%)`);
      svThumb.style.left = `${hsv.s * 100}%`;
      svThumb.style.top = `${(1 - hsv.v) * 100}%`;
      svThumb.style.background = solid;
      hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
      hue.setAttribute("aria-valuenow", Math.round(hsv.h));
      alphaFill.style.background = `linear-gradient(to right, transparent, ${solid})`;
      alphaThumb.style.left = `${hsv.a * 100}%`;
      alpha.setAttribute("aria-valuenow", Math.round(hsv.a * 100));
      preview.style.setProperty("--swatch", value);
      return value;
    };
    const changed = () => onInput(show());

    // Picking a shade or hue for a see-through color (a transparent
    // background) makes it opaque, or the change wouldn't show.
    const visible = () => {
      if (hsv.a === 0) {
        hsv.a = 1;
      }
    };
    draggable(sv, (x, y) => {
      hsv.s = x;
      hsv.v = 1 - y;
      visible();
      changed();
    });
    draggable(hue, x => {
      hsv.h = x * 360;
      visible();
      changed();
    });
    draggable(alpha, x => {
      hsv.a = Math.round(x * 100) / 100;
      changed();
    });
    const keys = (el, step) =>
      el.addEventListener("keydown", ev => {
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[ev.key];
        if (!d) {
          return;
        }
        ev.preventDefault();
        step(d[0] * (ev.shiftKey ? 10 : 1), d[1] * (ev.shiftKey ? 10 : 1));
        changed();
      });
    const clamp = n => Math.min(1, Math.max(0, n));
    keys(sv, (dx, dy) => {
      hsv.s = clamp(hsv.s + dx / 100);
      hsv.v = clamp(hsv.v + dy / 100);
      visible();
    });
    keys(hue, (dx, dy) => {
      hsv.h = (hsv.h + (dx || dy) + 360) % 360;
      visible();
    });
    keys(alpha, (dx, dy) => (hsv.a = clamp(Math.round((hsv.a + (dx || dy) / 100) * 100) / 100)));

    return {
      el: h("div", { class: "fz-cp" }, sv, h("div", { class: "fz-cp-row" }, preview, h("div", { class: "fz-cp-bars" }, hue, alpha))),
      set(value) {
        const rgb = parseColor(value) ?? { r: 255, g: 255, b: 255, a: 1 };
        // Keep the hue for grays (it can't be read back from them).
        const next = rgbToHsv(rgb);
        hsv = next.s === 0 || next.v === 0 ? { ...next, h: hsv.h } : next;
        show();
      },
    };
  }

  async function currentStyles(sel) {
    try {
      return (await actorFor(gBrowser.selectedBrowser)?.sendQuery("styles", { sel })) ?? null;
    } catch {
      return null;
    }
  }

  function renderElement(t, e) {
    const ids = { touch: t.id, edit: e.id };
    const change = patch => FzTouches.updateEdit(ids.touch, ids.edit, patch);
    // Fields showing the element's current value until changed.
    const showCurrent = [];

    // ---- which elements ----
    const count = h("span", { class: "fz-el-count" });
    const refresh = async sel => {
      const n = await highlight(sel);
      count.textContent = n < 0 ? "" : n === 0 ? "No match" : n === 1 ? "1 element" : `${n} elements`;
      count.toggleAttribute("data-none", n === 0);
      const styles = await currentStyles(sel);
      for (const fn of showCurrent) {
        fn(styles);
      }
    };
    const candidates = (state.candidates ?? []).slice();
    if (!candidates.some(c => c.sel === e.sel)) {
      candidates.unshift({ sel: e.sel, count: 0, custom: true });
    }
    const selInput = h("input", {
      type: "text",
      class: "fz-touches-input fz-touches-code-input",
      value: e.sel,
      spellcheck: "false",
      "aria-label": "Selector",
      oninput: ev => {
        const sel = ev.target.value.trim();
        const ok = validSelector(sel);
        ev.target.toggleAttribute("data-invalid", !ok);
        if (ok) {
          later("sel", () => {
            change({ sel });
            refresh(sel);
          });
        }
      },
    });
    const which = h(
      "select",
      {
        class: "fz-touches-select",
        "aria-label": "Applies to",
        onchange: ev => {
          const sel = candidates[ev.target.selectedIndex].sel;
          selInput.value = sel;
          selInput.removeAttribute("data-invalid");
          change({ sel });
          refresh(sel);
        },
      },
      ...candidates.map((c, i) =>
        h("option", {
          text: c.custom ? "Custom selector" : i === 0 ? "Only this element" : `All ${c.count} like it`,
          title: c.sel,
          selected: c.sel === e.sel,
        })
      )
    );

    // ---- fields ----
    const field = (label, control, reset) => {
      const row = h("div", { class: "fz-el-field" }, h("span", { class: "fz-el-label", text: label }), control);
      if (reset) {
        row.append(
          h("button", {
            class: "fz-touches-icon fz-el-reset",
            title: "Back to the page's own",
            "aria-label": `Reset ${label}`,
            onclick: reset,
          })
        );
      }
      return row;
    };
    const markSet = (row, set) => row.toggleAttribute("data-set", !!set);

    const color = (key, label) => {
      const swatch = h("button", { class: "fz-el-swatch", title: "Pick a color", "aria-label": `${label}: pick a color` });
      const input = h("input", {
        type: "text",
        class: "fz-touches-input",
        value: e.style[key] ?? "",
        placeholder: "Default",
        spellcheck: "false",
        "aria-label": label,
      });
      let current = null;
      let row = null;
      const paint = () => {
        const v = input.value.trim();
        const shown = v && CSS.supports("color", v) ? v : current;
        swatch.style.setProperty("--swatch", shown && CSS.supports("color", shown) ? shown : "transparent");
        swatch.toggleAttribute("data-none", !shown || shown === "transparent" || !CSS.supports("color", shown));
        if (row) {
          markSet(row, v);
        }
      };
      const set = v => {
        input.value = v;
        input.removeAttribute("data-invalid");
        paint();
        flushOne(key);
        change({ style: { [key]: v } });
      };
      input.addEventListener("input", () => {
        const v = input.value.trim();
        const ok = !v || CSS.supports("color", v);
        input.toggleAttribute("data-invalid", !ok);
        paint();
        if (ok) {
          later(key, () => change({ style: { [key]: v } }));
        }
      });
      const picker = colorPicker(v => {
        input.value = v;
        input.removeAttribute("data-invalid");
        paint();
        later(key, () => change({ style: { [key]: v } }));
      });
      const palette = h(
        "div",
        { class: "fz-el-palette", hidden: true },
        picker.el,
        h(
          "div",
          { class: "fz-el-chips" },
          ...PALETTE.map(c =>
            h("button", {
              class: "fz-el-chip",
              title: c,
              "aria-label": c,
              "data-none": c === "transparent" || null,
              style: `--swatch: ${c}`,
              onclick: () => {
                set(c);
                picker.set(c);
              },
            })
          )
        )
      );
      swatch.addEventListener("click", () => {
        palette.hidden = !palette.hidden;
        swatch.toggleAttribute("data-open", !palette.hidden);
        if (!palette.hidden) {
          picker.set(input.value.trim() || current);
        }
      });
      row = field(label, h("div", { class: "fz-el-color" }, swatch, input), () => set(""));
      showCurrent.push(styles => {
        current = styles?.[key] ?? null;
        input.placeholder = current ? (current.includes("image") ? `${current} (picture)`.replace(" + image", "") : current) : "Default";
        paint();
      });
      paint();
      return [row, palette];
    };

    const number = (key, label, { min, max, current: show }) => {
      const input = h("input", {
        type: "number",
        class: "fz-touches-input",
        min,
        max,
        value: e.style[key] ?? "",
        placeholder: "Default",
        "aria-label": `${label} in pixels`,
      });
      const row = field(label, h("div", { class: "fz-el-number" }, input, h("span", { text: "px" })), () => {
        input.value = "";
        markSet(row, false);
        flushOne(key);
        change({ style: { [key]: "" } });
      });
      input.addEventListener("input", () => {
        markSet(row, input.value !== "");
        later(key, () => change({ style: { [key]: input.value } }));
      });
      markSet(row, input.value !== "");
      showCurrent.push(styles => {
        const v = styles ? show(styles) : null;
        input.placeholder = v ? v.replace(/px/g, "") : "Default";
      });
      return row;
    };

    const fontSelect = h(
      "select",
      {
        class: "fz-touches-select",
        "aria-label": "Font",
        onchange: ev => {
          change({ style: { fontFamily: ev.target.value } });
          markSet(fontRow, ev.target.value);
        },
      },
      ...Object.entries(FONT_LABELS).map(([value, text]) => h("option", { value, text, selected: (e.style.fontFamily ?? "") === value }))
    );
    const fontRow = field("Font", fontSelect, () => {
      fontSelect.value = "";
      markSet(fontRow, false);
      change({ style: { fontFamily: "" } });
    });
    markSet(fontRow, e.style.fontFamily);
    showCurrent.push(styles => {
      fontSelect.options[0].textContent = styles?.font ? `Default (${styles.font})` : "Default";
    });

    const [textColor, textPalette] = color("color", "Text color");
    const [bgColor, bgPalette] = color("background", "Background");
    const styles = h(
      "div",
      { class: "fz-el-styles", "data-hidden": e.hide || null },
      h("div", { class: "fz-el-group", text: "Colors" }),
      textColor,
      textPalette,
      bgColor,
      bgPalette,
      h("div", { class: "fz-el-group", text: "Text" }),
      fontRow,
      number("fontSize", "Size", { min: 6, max: 200, current: s => s.fontSize }),
      h("div", { class: "fz-el-group", text: "Box" }),
      number("maxWidth", "Max width", { min: 100, max: 4000, current: s => (s.maxWidth === "none" ? "None" : s.maxWidth) }),
      number("padding", "Padding", { min: 0, max: 200, current: s => s.padding }),
      number("radius", "Corners", { min: 0, max: 200, current: s => s.radius })
    );

    // ---- text and HTML ----
    const info = state.info;
    const text = h("textarea", {
      class: "fz-touches-text",
      rows: 2,
      placeholder: info?.text ? info.text : "New text for it",
      "aria-label": "New text",
      oninput: ev => later("text", () => change({ text: ev.target.value })),
    });
    text.value = e.text ?? "";
    const html = h("textarea", {
      class: "fz-touches-text fz-touches-code-input",
      rows: 3,
      spellcheck: "false",
      placeholder: "<p>A note of yours</p>",
      "aria-label": "HTML to add",
    });
    html.value = e.insert?.html ?? "";
    const where = h(
      "select",
      {
        class: "fz-touches-select",
        "aria-label": "Where",
        onchange: ev => {
          flushOne("insert");
          change({ insert: { where: ev.target.value, html: html.value } });
        },
      },
      ...Object.entries(WHERE_LABELS).map(([value, label]) => h("option", { value, text: label, selected: (e.insert?.where ?? "after") === value }))
    );
    html.addEventListener("input", () => later("insert", () => change({ insert: { where: where.value, html: html.value } })));

    const more = h(
      "details",
      { class: "fz-el-more", open: e.text != null || !!e.insert || null, "data-hidden": e.hide || null },
      h("summary", { text: "Change its text or add HTML" }),
      h("span", { class: "fz-el-label", text: "Replace its text with" }),
      text,
      h("span", { class: "fz-el-label", text: "Add HTML" }),
      where,
      html,
      h("p", { class: "fz-touches-hint", text: "Scripts, forms and frames are removed." })
    );
    const hide = h("input", {
      type: "checkbox",
      role: "switch",
      class: "fz-switch",
      "aria-label": "Hide this element",
      checked: e.hide,
      onchange: ev => {
        change({ hide: ev.target.checked });
        styles.toggleAttribute("data-hidden", ev.target.checked);
        more.toggleAttribute("data-hidden", ev.target.checked);
      },
    });

    body().replaceChildren(
      h(
        "div",
        { class: "fz-touches-head" },
        h("button", { class: "fz-touches-icon fz-touches-back", title: "Back", "aria-label": "Back", onclick: backToTouch }),
        h("span", { class: "fz-touches-title", text: "Change element" }),
        h("span", { class: "fz-touches-host", text: t.name })
      ),
      h(
        "div",
        { class: "fz-el-target" },
        h(
          "div",
          { class: "fz-el-target-head" },
          h("span", { class: "fz-el-name", text: info?.name || e.sel }),
          info?.text ? h("span", { class: "fz-el-snippet", text: `“${info.text}”` }) : null,
          count,
          h("button", {
            class: "fz-touches-btn fz-touches-small fz-el-repick",
            text: "Pick again",
            onclick: () => startPicking("pick", gBrowser.selectedBrowser, { repick: ids.edit }),
          })
        ),
        which,
        h("details", { class: "fz-el-selector" }, h("summary", { text: "Selector" }), selInput)
      ),
      h("label", { class: "fz-el-hide" }, h("span", { text: "Hide this element" }), hide),
      styles,
      more,
      h(
        "div",
        { class: "fz-touches-foot" },
        h("button", {
          class: "fz-touches-btn fz-touches-danger",
          text: "Remove",
          title: "Undo everything done to this element",
          onclick: () => {
            pending.clear();
            highlight(null);
            FzTouches.removeEdit(ids.touch, ids.edit);
            state = { view: "touch", id: ids.touch, draft: state.draft };
            render();
          },
        }),
        h("button", { class: "fz-touches-btn fz-touches-primary", text: "Done", onclick: backToTouch })
      )
    );
    refresh(e.sel);
  }

  // ---- picking ----

  // repick: an edit whose elements the pick replaces ("Pick again").
  function startPicking(mode, browser = gBrowser.selectedBrowser, { repick = null } = {}) {
    const actor = actorFor(browser);
    if (!actor || !FzTouches.enabled) {
      return;
    }
    flushTyping();
    if (!repick) {
      leaveElement();
    }
    const { touch, draft } = targetTouch();
    state = { view: "touch", id: touch.id, draft, repick };
    if (picking) {
      touchMode(picking.browser, null);
    }
    picking = { browser, mode };
    touchMode(browser, mode);
    panel?.hidePopup();
    actor.sendAsyncMessage("pick", { mode });
  }

  function endPicking() {
    if (picking) {
      touchMode(picking.browser, null);
      picking = null;
    }
  }

  function stopPicking() {
    const p = picking;
    endPicking();
    actorFor(p.browser)?.sendAsyncMessage("stopPick");
  }

  // Touché mode: an animated frame around the page (and a badge saying
  // which mode) for as long as Pick or Zap is on.
  function touchMode(browser, mode) {
    const stack = browser?.closest(".browserStack") ?? browser?.parentNode;
    stack?.querySelector(":scope > .fz-touch-mode")?.remove();
    if (!stack || !mode) {
      return;
    }
    stack.append(
      h(
        "div",
        { class: "fz-touch-mode", "data-mode": mode },
        h("div", { class: "fz-touch-frame" }),
        h(
          "div",
          { class: "fz-touch-badge" },
          h("span", { class: "fz-touch-badge-icon" }),
          h("span", { text: mode === "zap" ? "Touché · Zap" : "Touché · Pick" })
        )
      )
    );
  }

  // What the page's picker found (untrusted: checked here).
  function picked(info) {
    const candidates = (Array.isArray(info?.candidates) ? info.candidates : [])
      .slice(0, 5)
      .filter(c => validSelector(c?.sel))
      .map(c => ({ sel: c.sel.trim(), count: Number.isFinite(c.count) ? c.count : 0 }));
    const t = state.id ? FzTouches.get(state.id) : null;
    if (!candidates.length || !t) {
      openPanel();
      return;
    }
    // Shift+click starts on "all like it".
    const first = info.similar === true && candidates[1] ? candidates[1] : candidates[0];
    const again = state.repick ? FzTouches.getEdit(t.id, state.repick) : null;
    const e = again ? FzTouches.updateEdit(t.id, again.id, { sel: first.sel }) : FzTouches.addEdit(t.id, { sel: first.sel });
    if (!e) {
      openPanel();
      return;
    }
    openElement(t.id, e.id, {
      candidates,
      info: { text: clip(info.text, 300), name: clip(info.name, 80) },
    });
    openPanel();
  }

  window.FzTouchesUI = {
    onPageMessage(browser, name, data) {
      if (name === "try") {
        // Try it on the store's touch page (FzTouchParent checked the page).
        readShare(data?.data).then(shared => shared && tryShared(shared, { from: browser }));
        return;
      }
      if (!picking || browser !== picking.browser) {
        return;
      }
      if (name === "picked") {
        endPicking();
        if (browser === gBrowser.selectedBrowser) {
          picked(data);
        }
      } else if (name === "zapped") {
        const sel = typeof data?.sel === "string" ? data.sel.trim() : "";
        if (state.id && validSelector(sel)) {
          FzTouches.addEdit(state.id, { sel, hide: true });
        }
      } else if (name === "pickEnd") {
        const { mode } = picking;
        endPicking();
        // Back to the touch, unless the page went away or another tab is up.
        if (data?.reason !== "picked" && data?.reason !== "navigated" && browser === gBrowser.selectedBrowser) {
          if (mode === "pick" || FzTouches.get(state.id)) {
            openPanel();
          }
        } else if (data?.reason === "navigated") {
          dropEmptyDraft();
          state = { view: "list" };
        }
      }
    },
  };

  // ---- sharing ----
  //
  // A share link is the store's touch page with the touch in its #fragment
  // (never sent to the server): `${SHARE_PAGE}#1.<data>`, data being the
  // touch's shareable JSON (FzTouches.exportable), deflated and base64url'd.
  // The page shows what it is, and Try it (through the FzTouch actor) brings
  // it here as a preview. Copied links can be pasted from the panel too.
  //
  // Anything that comes in (link, file) is cleaned (cleanCSS, cleanHTML on
  // top of FzTouches.fromShared): nothing in it loads from another site.

  const { FzStore } = ChromeUtils.importESModule("chrome://userscripts/content/firefox-zen-store.sys.mjs");
  const { matchesScope } = ChromeUtils.importESModule("chrome://userscripts/content/FzTouch/FzTouchScope.sys.mjs");
  const SHARE_PAGE = `${FzStore.STORE_URL}touch/`;
  const MAX_SHARE_CHARS = 600000;
  const MAX_SHARE_BYTES = 2 * 1024 * 1024;

  function toBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const fromBase64Url = str => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

  async function shareLink(t) {
    const json = JSON.stringify(FzTouches.exportable(t));
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    return `${SHARE_PAGE}#1.${toBase64Url(bytes)}`;
  }

  // The shared data in a link (or its "#1.…" part, or that alone), or null.
  async function readShare(textIn) {
    const m = /(?:#|^)1\.([A-Za-z0-9_-]{8,})/.exec(String(textIn ?? "").trim());
    if (!m || m[1].length > MAX_SHARE_CHARS) {
      return null;
    }
    try {
      const reader = new Blob([fromBase64Url(m[1])]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.length;
        if (size > MAX_SHARE_BYTES) {
          reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      return JSON.parse(await new Blob(chunks).text());
    } catch {
      return null;
    }
  }

  // ---- cleaning what comes in ----

  // Values that can make the page load something.
  const LOADERS = /image-set\(|cross-fade\(|\bsrc\(|\bimage\(|element\(/i;

  function loadsRemote(prop, value) {
    for (const m of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      if (!/^data:/i.test(m[2].trim())) {
        return true;
      }
    }
    // A custom property keeps its value as written, CSS escapes and all: it
    // could spell url( so that only var() reads it. Any escape, url or
    // address in one goes.
    return LOADERS.test(value) || (prop.startsWith("--") && /\\|url|\/\//i.test(value));
  }

  // The CSS as Firefox reads it, without what would load from elsewhere.
  // Parsing resolves CSS escapes (\75 rl( is url(); @import is dropped by
  // replaceSync.
  function cleanCSS(css, removed) {
    if (!css.trim()) {
      return css;
    }
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(css);
    } catch {
      removed.count++;
      return "";
    }
    const walk = rules => {
      for (const rule of rules) {
        if (rule.style) {
          for (const prop of [...rule.style]) {
            if (loadsRemote(prop, rule.style.getPropertyValue(prop))) {
              rule.style.removeProperty(prop);
              removed.count++;
            }
          }
        }
        if (rule.cssRules) {
          walk(rule.cssRules);
        }
      }
    };
    walk(sheet.cssRules);
    return [...sheet.cssRules].map(r => r.cssText).join("\n");
  }

  // Attributes that load something.
  const LOADING_ATTRS = new Set(["src", "srcset", "poster", "background", "data", "lowsrc", "dynsrc", "ping", "action", "formaction"]);

  // The HTML as Firefox parses it (entities resolved), without what would
  // load from elsewhere. The page side cleans it again when adding it.
  function cleanHTML(html, removed) {
    const doc = new DOMParser().parseFromString(`<body>${html}`, "text/html");
    for (const el of doc.body.querySelectorAll("*")) {
      for (const { name, value } of [...el.attributes]) {
        const n = name.toLowerCase();
        if ((LOADING_ATTRS.has(n) && !/^data:/i.test(value.trim())) || (n === "style" && (loadsRemote("style", value) || value.includes("\\")))) {
          el.removeAttribute(name);
          removed.count++;
        }
      }
    }
    return doc.body.innerHTML;
  }

  const fromShared = (data, kind) => FzTouches.fromShared(data, kind, { css: cleanCSS, html: cleanHTML });

  // The page a touch is for (where Try it goes).
  function siteOf(scope) {
    return scope.type === "prefix" ? scope.value : `https://${scope.value}/`;
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : word.endsWith("ch") ? "es" : "s"}`;

  // ---- preview: a shared touch on one tab, not saved ----

  // browser -> { fields, removed, on, notification }
  const previews = new Map();
  const PREVIEW_ID = "fz-touch-preview";

  function sendPreview(browser) {
    const p = previews.get(browser);
    if (p) {
      actorFor(browser)?.sendAsyncMessage(p.on ? "preview" : "endPreview", { touch: FzTouches.pageForm({ id: "preview", ...p.fields }) });
    }
  }

  function endPreview(browser) {
    const p = previews.get(browser);
    if (!p) {
      return;
    }
    previews.delete(browser);
    actorFor(browser)?.sendAsyncMessage("endPreview");
    p.notification?.close();
    if (state.view === "preview" && state.browser === browser && isOpen()) {
      panel.hidePopup();
    }
  }

  function keepPreview(browser) {
    const p = previews.get(browser);
    if (!p) {
      return;
    }
    const t = FzTouches.create(null, { ...p.fields, enabled: true });
    endPreview(browser);
    if (browser === gBrowser.selectedBrowser && t) {
      state = { view: "touch", id: t.id };
      openPanel();
    }
  }

  function startPreview(browser, fields, removed) {
    endPreview(browser);
    const p = { fields, removed, on: true, notification: null, bar: false };
    previews.set(browser, p);
    sendPreview(browser);
    // A new tab gets its bar once it's on the touch's page (onLocationChange):
    // before, the navigation would sweep it away.
    if (browser.currentURI.spec !== "about:blank") {
      showPreviewBar(browser, p);
    }
  }

  async function showPreviewBar(browser, p) {
    p.bar = true;
    const { fields, removed } = p;
    const box = gBrowser.getNotificationBox(browser);
    const by = fields.source?.author ? ` by ${fields.source.author}` : "";
    const label =
      `Trying “${fields.name}”${by}, a shared touch (${FzTouches.scopeLabel(fields.scope).replace(/^./, c => c.toLowerCase())}), on this tab only.` +
      (removed ? ` ${plural(removed, "outside load")} removed from it.` : "");
    const notification = await box.appendNotification(
      PREVIEW_ID,
      {
        label,
        priority: box.PRIORITY_INFO_HIGH,
        eventCallback: event => {
          if (event === "removed" && previews.get(browser) === p) {
            p.notification = null;
            endPreview(browser);
          }
        },
      },
      [
        { label: "Keep it", accessKey: "K", callback: () => keepPreview(browser) },
        {
          label: "Before / after",
          accessKey: "B",
          callback: () => {
            p.on = !p.on;
            sendPreview(browser);
            return true;
          },
        },
        {
          label: "Show what it does",
          accessKey: "S",
          callback: () => {
            state = { view: "preview", browser };
            openPanel();
            return true;
          },
        },
        { label: "Discard", accessKey: "D", callback: () => {} },
      ]
    );
    if (previews.get(browser) === p) {
      // Firefox drops a tab's notifications when it navigates; this one
      // stays while the tab stays on the touch's pages (onLocationChange
      // ends it otherwise), including the page a new tab is opening.
      if (notification) {
        notification.persistence = Number.MAX_SAFE_INTEGER;
      }
      p.notification = notification;
    } else {
      notification?.close();
    }
  }

  // A shared touch to try: here if it's for this page, else in a new tab on
  // its site.
  async function tryShared(data, { from = gBrowser.selectedBrowser, kind = "link" } = {}) {
    const result = fromShared(data, kind);
    if (!result) {
      return false;
    }
    const { fields, removed } = result;
    let browser = from;
    if (!matchesScope(fields.scope, from.currentURI.spec)) {
      const tab = gBrowser.addTab(siteOf(fields.scope), {
        triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
        relatedToCurrent: true,
        ownerTab: gBrowser.getTabForBrowser(from),
      });
      gBrowser.selectedTab = tab;
      browser = tab.linkedBrowser;
    }
    startPreview(browser, fields, removed);
    return true;
  }

  // The panel's view of a preview: what it changes, Keep / Discard.
  function renderPreview() {
    const p = previews.get(state.browser);
    if (!p) {
      state = { view: "list" };
      renderList();
      return;
    }
    const { fields, removed } = p;
    const edits = fields.edits.map(e =>
      h(
        "li",
        { class: "fz-edit" },
        h("div", { class: "fz-touch-main" }, h("span", { class: "fz-edit-sel", text: e.sel }), h("span", { class: "fz-touch-scope", text: FzTouches.editSummary(e) }))
      )
    );
    const css = h("textarea", { class: "fz-touches-css", readonly: true, spellcheck: "false", wrap: "off", "aria-label": "CSS" });
    css.value = fields.css.trim() || "/* No CSS of its own */";
    body().replaceChildren(
      h(
        "div",
        { class: "fz-touches-head" },
        h("span", { class: "fz-touches-title", text: fields.name }),
        h("span", { class: "fz-touches-host", text: fields.source?.author ? `by ${fields.source.author}` : "Shared touch" })
      ),
      h("label", { class: "fz-touches-field" }, h("span", { text: "Applies to" }), h("span", { class: "fz-touches-value", text: FzTouches.scopeLabel(fields.scope) })),
      ...(removed
        ? [h("p", { class: "fz-touches-note", text: `${plural(removed, "outside load")} removed: images or fonts from other sites, which could also tell them what you do on the page.` })]
        : []),
      h("div", { class: "fz-touches-section" }, h("span", { text: "Elements" })),
      edits.length ? h("ul", { class: "fz-touches-list fz-edits" }, ...edits) : h("p", { class: "fz-touches-hint", text: "None." }),
      h("div", { class: "fz-touches-section" }, h("span", { text: "CSS" })),
      css,
      h(
        "div",
        { class: "fz-touches-foot" },
        h("button", { class: "fz-touches-btn fz-touches-danger", text: "Discard", onclick: () => endPreview(state.browser) }),
        h("button", { class: "fz-touches-btn fz-touches-primary", text: "Keep it", onclick: () => keepPreview(state.browser) })
      )
    );
  }

  // ---- files, clipboard, menus ----

  function pickFile(mode, title, { defaultName } = {}) {
    const fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window.browsingContext, title, mode);
    fp.appendFilter("Touches", "*.json");
    fp.appendFilters(Ci.nsIFilePicker.filterAll);
    if (defaultName) {
      fp.defaultString = defaultName;
      fp.defaultExtension = "json";
    }
    return new Promise(resolve => fp.open(rv => resolve(rv === Ci.nsIFilePicker.returnCancel ? null : fp.file.path)));
  }

  const fileName = name => `${name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "touch"}.touch.json`;

  async function exportTouches(list) {
    if (!list.length) {
      return "No touches to export.";
    }
    const path = await pickFile(Ci.nsIFilePicker.modeSave, list.length === 1 ? `Export “${list[0].name}”` : "Export touches", {
      defaultName: list.length === 1 ? fileName(list[0].name) : "touches.json",
    });
    if (!path) {
      return null;
    }
    const data =
      list.length === 1
        ? FzTouches.exportable(list[0])
        : { format: "firefox-zen-touches", version: 1, touches: list.map(t => FzTouches.exportable(t)) };
    await IOUtils.writeUTF8(path, JSON.stringify(data, null, 2));
    return `Exported ${plural(list.length, "touch")}.`;
  }

  async function importFile() {
    const path = await pickFile(Ci.nsIFilePicker.modeOpen, "Import touches");
    if (!path) {
      return null;
    }
    let data;
    try {
      data = JSON.parse(await IOUtils.readUTF8(path));
    } catch {
      return "That file isn't a touch.";
    }
    const items = Array.isArray(data?.touches) ? data.touches : Array.isArray(data) ? data : [data];
    let added = 0;
    let removed = 0;
    for (const item of items.slice(0, 500)) {
      const r = fromShared(item, "file");
      if (r) {
        FzTouches.create(null, r.fields);
        added++;
        removed += r.removed;
      }
    }
    if (!added) {
      return "No touches in that file.";
    }
    return `Imported ${plural(added, "touch")}.${removed ? ` ${plural(removed, "outside load")} removed.` : ""}`;
  }

  async function copyLink(t) {
    const link = await shareLink(t);
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(link);
    return link.length > 8000 ? "Link copied. It's long: some apps cut links that long, a file is safer." : "Link copied.";
  }

  async function pasteLink() {
    let textIn = "";
    try {
      textIn = await navigator.clipboard.readText();
    } catch {}
    const data = await readShare(textIn);
    if (!data || !(await tryShared(data))) {
      return "No touch link on the clipboard. Copy one first.";
    }
    return null;
  }

  // A small menu (XUL, so it can leave the panel's bounds).
  function showMenu(anchor, items) {
    let menu = document.getElementById("fz-touches-menu");
    if (!menu) {
      menu = document.createXULElement("menupopup");
      menu.id = "fz-touches-menu";
      document.getElementById("mainPopupSet").append(menu);
    }
    menu.replaceChildren(
      ...items.filter(Boolean).map(item => {
        if (item === "-") {
          return document.createXULElement("menuseparator");
        }
        const mi = document.createXULElement("menuitem");
        mi.setAttribute("label", item.label);
        mi.addEventListener("command", () => item.run());
        return mi;
      })
    );
    menu.openPopup(anchor, "after_end");
  }

  // A line in the panel saying how an action went (for 5 seconds, across
  // re-renders).
  let lastFlash = null;

  function flash(message, until = Date.now() + 5000) {
    if (!message || !panel) {
      return;
    }
    lastFlash = { message, until };
    let note = body().querySelector(".fz-touches-flash");
    if (!note) {
      note = h("p", { class: "fz-touches-flash", role: "status" });
      body().querySelector(".fz-touches-head")?.after(note);
    }
    note.textContent = message;
    clearTimeout(note.fzTimer);
    note.fzTimer = setTimeout(() => note.remove(), Math.max(0, until - Date.now()));
  }

  async function runFlash(action) {
    try {
      flash(await action());
    } catch (e) {
      console.error("Firefox-Zen Touches:", e);
      flash(`That didn't work: ${e.message || e}`);
    }
  }

  function listMenu(anchor) {
    showMenu(anchor, [
      { label: "Try a copied link", run: () => runFlash(pasteLink) },
      { label: "Import from a file…", run: () => runFlash(importFile) },
      "-",
      {
        label: "All touches…",
        run: () => {
          panel.hidePopup();
          window.FirefoxZenLibrary?.open("touches");
        },
      },
    ]);
  }

  function touchMenu(anchor, t) {
    const now = FzTouches.get(t.id) ?? t;
    showMenu(anchor, [
      { label: now.published ? "Published to the gallery…" : "Publish to the gallery…", run: () => openPublish(now) },
      "-",
      { label: "Copy share link", run: () => runFlash(() => copyLink(FzTouches.get(t.id) ?? t)) },
      { label: "Export to a file…", run: () => runFlash(() => exportTouches([FzTouches.get(t.id) ?? t])) },
    ]);
  }

  const menuButton = (label, open) =>
    h("button", {
      class: "fz-touches-icon fz-touches-more-btn",
      title: label,
      "aria-label": label,
      "aria-haspopup": "menu",
      onclick: e => open(e.currentTarget),
    });

  // ---- the gallery: touches others published ----
  //
  // FzGallery (JS/firefox-zen-touches-gallery.sys.mjs) has the index and the
  // GitHub side. Here: the page's community touches in the list (Try, Like,
  // Added / Update), sign-in, and the publish view.

  const { FzGallery } = ChromeUtils.importESModule("chrome://userscripts/content/firefox-zen-touches-gallery.sys.mjs");
  // Issue bodies are at most this long on GitHub.
  const MAX_ISSUE = 60000;

  // Local touches added from the gallery, by gallery id.
  const addedFromGallery = () => new Map(FzTouches.list().filter(t => t.source?.kind === "gallery" && t.source.id).map(t => [t.source.id, t]));

  function communitySection(uri) {
    const entries = FzGallery.forPage(uri);
    if (!entries.length) {
      return [];
    }
    const added = addedFromGallery();
    const mine = new Set(FzTouches.list().map(t => t.published?.id).filter(Boolean));
    const rows = entries.slice(0, 30).map(entry => {
      const local = added.get(entry.id);
      const newer = local && entry.updated && local.source.updated && entry.updated > local.source.updated;
      const liked = FzGallery.isLiked(entry.id);
      let action;
      if (newer) {
        action = h("button", { class: "fz-touches-btn fz-touches-small", text: "Update", title: "Get its new version", onclick: () => runFlash(() => updateFromGallery(entry, local)) });
      } else if (local) {
        action = h("span", { class: "fz-community-added", text: "Added" });
      } else {
        action = h("button", { class: "fz-touches-btn fz-touches-small", text: "Try", title: "See it on this page first", onclick: () => runFlash(() => tryGallery(entry)) });
      }
      return h(
        "li",
        { class: "fz-touch fz-community-touch" },
        h(
          "div",
          { class: "fz-touch-main" },
          h("span", { class: "fz-touch-name", text: entry.name }),
          h("span", { class: "fz-touch-scope", text: `by ${entry.author}${mine.has(entry.id) ? " (you)" : ""}` })
        ),
        h(
          "button",
          {
            class: "fz-like",
            "aria-pressed": String(liked),
            title: liked ? "You like it" : "Like it",
            "aria-label": `${liked ? "Unlike" : "Like"} ${entry.name}`,
            onclick: () => runFlash(() => toggleLike(entry)),
          },
          h("span", { class: "fz-like-icon" }),
          h("span", { text: String(FzGallery.likeCount(entry)) })
        ),
        action
      );
    });
    return [h("div", { class: "fz-touches-section" }, h("span", { text: "Shared by others" })), h("ul", { class: "fz-touches-list fz-community" }, ...rows)];
  }

  async function tryGallery(entry) {
    const data = await FzGallery.fetchTouch(entry.id);
    if (!(await tryShared(data, { kind: "gallery" }))) {
      return "That touch couldn't be read.";
    }
    return null;
  }

  async function updateFromGallery(entry, local) {
    const result = fromShared(await FzGallery.fetchTouch(entry.id), "gallery");
    if (!result) {
      return "That touch couldn't be read.";
    }
    const { name, scope, edits, css, source } = result.fields;
    FzTouches.update(local.id, { name, scope, edits, css, source });
    return `Updated ${name}.${result.removed ? ` ${plural(result.removed, "outside load")} removed.` : ""}`;
  }

  // ---- account ----

  // What to do once signed in (and where), set while a sign-in runs.
  let signIn = null; // { flow, then, tab, githubTab }

  function needAccount(then) {
    if (!FzGallery.configured) {
      return "Publishing and likes aren't set up in this copy of Firefox-Zen (see the readme's Touches gallery setup).";
    }
    if (FzGallery.account) {
      return null;
    }
    state = { view: "signin", then };
    render();
    return null;
  }

  async function toggleLike(entry) {
    const blocked = needAccount({ like: entry.id });
    if (blocked || !FzGallery.account) {
      return blocked;
    }
    if (FzGallery.isLiked(entry.id)) {
      await FzGallery.unlike(entry.id);
    } else {
      await FzGallery.like(entry.id);
    }
    return null;
  }

  async function beginSignIn() {
    signIn?.flow.cancel();
    const flow = await FzGallery.startSignIn();
    signIn = { flow, then: state.then, tab: gBrowser.selectedTab, githubTab: null };
    render();
    flow.done.then(
      user => finishSignIn(user),
      e => {
        if (e.message !== "cancelled") {
          signIn = null;
          state = { view: "signin", then: state.then, error: e.message };
          if (isOpen()) {
            render();
          }
        }
      }
    );
  }

  // Back to the tab it started on, and on with what it was for.
  function finishSignIn(user) {
    const s = signIn;
    signIn = null;
    if (!s) {
      return;
    }
    if (s.githubTab && !s.githubTab.closing && s.githubTab.linkedBrowser?.currentURI.spec.startsWith(FzGalleryWeb())) {
      gBrowser.removeTab(s.githubTab);
    }
    if (s.tab && !s.tab.closing && gBrowser.tabs.includes(s.tab)) {
      gBrowser.selectedTab = s.tab;
    }
    state = s.then?.publish ? { view: "publish", id: s.then.publish } : { view: "list" };
    openPanel();
    flash(`Signed in as ${user}.`);
    if (s.then?.like) {
      const entry = FzGallery.get(s.then.like);
      if (entry && !FzGallery.isLiked(entry.id)) {
        runFlash(() => toggleLike(entry));
      }
    }
  }

  const FzGalleryWeb = () => Services.prefs.getStringPref("firefox-zen.touches.github-web", "https://github.com");

  function renderSignIn() {
    const flow = signIn?.flow;
    const back = () => {
      signIn?.flow.cancel();
      signIn = null;
      state = state.then?.publish ? { view: "touch", id: state.then.publish } : { view: "list" };
      render();
    };
    const parts = flow
      ? [
          h("p", { class: "fz-touches-hint", text: "Enter this code on GitHub. You'll be brought back here once it's done." }),
          h("div", { class: "fz-signin-code", text: flow.userCode }),
          h(
            "div",
            { class: "fz-touches-foot" },
            h("button", { class: "fz-touches-btn", text: "Cancel", onclick: back }),
            h("button", {
              class: "fz-touches-btn fz-touches-primary",
              text: "Copy code and open GitHub",
              onclick: () => {
                Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(flow.userCode);
                if (signIn) {
                  signIn.githubTab = gBrowser.addTab(flow.verificationUri, {
                    triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({}),
                    relatedToCurrent: true,
                  });
                  gBrowser.selectedTab = signIn.githubTab;
                }
              },
            })
          ),
        ]
      : [
          h("p", {
            class: "fz-touches-hint",
            text:
              (state.then?.like ? "Likes" : "Publishing") +
              " use your GitHub account: touches are listed from issues in the gallery's repository, likes are 👍 on them. " +
              "Firefox-Zen gets a code for you to enter on github.com; it never sees your password.",
          }),
          state.error ? h("p", { class: "fz-touches-note", text: state.error }) : null,
          h(
            "div",
            { class: "fz-touches-foot" },
            h("button", { class: "fz-touches-btn", text: "Back", onclick: back }),
            h("button", { class: "fz-touches-btn fz-touches-primary", text: "Sign in with GitHub", onclick: () => runFlash(beginSignIn) })
          ),
        ];
    body().replaceChildren(
      h("div", { class: "fz-touches-head" }, h("span", { class: "fz-touches-title", text: "Sign in with GitHub" })),
      ...parts.filter(Boolean)
    );
  }

  // ---- publishing ----

  async function issueFor(t) {
    const data = FzTouches.exportable(t, FzGallery.account);
    const site = siteKey(t.scope);
    const link = await shareLink(t);
    const body = [
      `**${t.name}**, a touch for ${site}, published from [Firefox-Zen](https://github.com/ishid4/Firefox-Zen).`,
      "",
      `[Try it](${link}) · 👍 this issue to like it.`,
      "",
      "<!-- firefox-zen-touch -->",
      "```json",
      JSON.stringify(data, null, 2),
      "```",
      "",
    ].join("\n");
    if (body.length > MAX_ISSUE) {
      throw new Error("It's too big to publish (GitHub takes issues up to 64 KB). Share it as a file instead.");
    }
    return { title: `Touch: ${t.name} · ${site}`, body };
  }

  function openPublish(t) {
    const blocked = needAccount({ publish: t.id });
    if (blocked) {
      flash(blocked);
      return;
    }
    if (FzGallery.account) {
      state = { view: "publish", id: t.id };
      render();
    }
  }

  function renderPublish() {
    const t = FzTouches.get(state.id);
    if (!t) {
      state = { view: "list" };
      renderList();
      return;
    }
    const back = () => {
      state = { view: "touch", id: t.id };
      render();
    };
    const busy = (button, work) => async () => {
      button.disabled = true;
      try {
        flash(await work());
      } catch (e) {
        flash(`That didn't work: ${e.message || e}`);
      } finally {
        button.disabled = false;
      }
    };
    const publishBtn = h("button", { class: "fz-touches-btn fz-touches-primary", text: t.published ? "Update it" : "Publish" });
    publishBtn.addEventListener(
      "click",
      busy(publishBtn, async () => {
        const issue = await issueFor(FzTouches.get(t.id));
        const done = t.published ? await FzGallery.updatePublished(t.published.id, issue) : await FzGallery.publish(issue);
        FzTouches.update(t.id, { published: { ...done, at: Date.now() } });
        back();
        return t.published ? "Updated. The gallery shows the new version within a few minutes." : "Published. It's listed for everyone within a few minutes.";
      })
    );
    const unpublishBtn = t.published ? h("button", { class: "fz-touches-btn fz-touches-danger", text: "Unpublish" }) : null;
    unpublishBtn?.addEventListener(
      "click",
      busy(unpublishBtn, async () => {
        await FzGallery.unpublish(t.published.id);
        FzTouches.update(t.id, { published: null });
        back();
        return "Unpublished. It leaves the gallery within a few minutes; copies others kept stay theirs.";
      })
    );
    body().replaceChildren(
      h(
        "div",
        { class: "fz-touches-head" },
        h("button", { class: "fz-touches-icon fz-touches-back", title: "Back", "aria-label": "Back", onclick: back }),
        h("span", { class: "fz-touches-title", text: t.published ? "Published" : "Publish" }),
        h("span", { class: "fz-touches-host", text: t.name })
      ),
      h(
        "p",
        { class: "fz-touches-hint fz-publish-text" },
        t.published
          ? "Everyone on its site can find it under Shared by others. Update it to send your latest changes."
          : `Everyone on ${siteKey(t.scope)} will find it under Shared by others, and can try it, keep it and like it. It's checked automatically and listed within a few minutes; things that load from other sites aren't allowed.`
      ),
      h(
        "div",
        { class: "fz-publish-account" },
        h("span", { text: `As ${FzGallery.account}` }),
        t.published ? h("button", { class: "fz-option-link", text: "Open on GitHub", onclick: () => openWebLinkIn(t.published.url, "tab") }) : null,
        h(
          "button",
          {
            class: "fz-option-link",
            text: "Sign out",
            onclick: async () => {
              await FzGallery.signOut();
              back();
            },
          }
        )
      ),
      h("div", { class: "fz-touches-foot" }, unpublishBtn, publishBtn)
    );
  }

  // ---- the Library's Touches view ----

  let libraryView = null;
  let librarySearch = null;

  function siteKey(scope) {
    try {
      return scope.type === "prefix" ? new URL(scope.value).hostname.replace(/^www\./, "") : scope.value;
    } catch {
      return scope.value;
    }
  }

  function librarySummary(t) {
    const n = t.edits.filter(e => !FzTouches.editIsEmpty(e)).length;
    const parts = [n ? plural(n, "element") : null, t.css.trim() ? "CSS" : null].filter(Boolean);
    return parts.length ? parts.join(" · ") : "Empty";
  }

  function libraryStatus(message) {
    const status = libraryView?.querySelector(".fz-status");
    if (status && message) {
      status.textContent = message;
      status.removeAttribute("data-empty");
    }
  }

  async function libraryRun(action) {
    try {
      libraryStatus(await action());
    } catch (e) {
      libraryStatus(`That didn't work: ${e.message || e}`);
    }
  }

  function libraryRow(t) {
    const site = siteKey(t.scope);
    const action = (text, fn) =>
      h("button", {
        type: "button",
        class: "fz-option-reset",
        text,
        onclick: e => {
          e.preventDefault();
          libraryRun(fn);
        },
      });
    return h(
      "div",
      { class: "fz-setting fz-touch-row", "data-on": t.enabled || null },
      h(
        "div",
        { class: "fz-setting-main" },
        h("div", { class: "fz-mock fz-touch-site", "aria-hidden": "true" }, h("img", { src: `page-icon:https://${site}/`, alt: "", onerror: e => (e.target.hidden = true) }), h("span", { text: site[0] ?? "?" })),
        h(
          "div",
          { class: "fz-setting-body" },
          h(
            "span",
            { class: "fz-setting-head" },
            h("span", { class: "fz-setting-title", text: t.name }),
            t.source?.kind !== "local" &&
              h("span", { class: "fz-badge", text: { link: "Shared", file: "Imported", gallery: "Gallery" }[t.source.kind] ?? "Shared" }),
            t.published && h("span", { class: "fz-badge", text: "Published" }),
            t.source?.author && h("span", { class: "fz-hint", text: `by ${t.source.author}` })
          ),
          h("p", { class: "fz-setting-desc", text: `${FzTouches.scopeLabel(t.scope)} · ${librarySummary(t)}` }),
          h(
            "span",
            { class: "fz-mod-actions" },
            action("Open site", () => {
              window.FirefoxZenLibrary?.close();
              openWebLinkIn(siteOf(t.scope), "tab");
              return null;
            }),
            action("Copy link", () => copyLink(t)),
            action("Export…", () => exportTouches([t])),
            action("Delete…", () => {
              const p = Services.prompt;
              const flags = p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1 * p.BUTTON_TITLE_CANCEL + p.BUTTON_POS_1_DEFAULT;
              if (p.confirmEx(window, `Delete “${t.name}”?`, "It can't be undone (export it first to keep a copy).", flags, "Delete", null, null, null, {}) !== 0) {
                return null;
              }
              FzTouches.remove(t.id);
              return `Deleted ${t.name}.`;
            })
          )
        ),
        h("input", {
          type: "checkbox",
          role: "switch",
          class: "fz-switch",
          "aria-label": `${t.name} on`,
          checked: t.enabled,
          onchange: e => FzTouches.setEnabled(t.id, e.target.checked),
        })
      )
    );
  }

  function renderLibrary() {
    const list = libraryView?.querySelector(".fz-touches-library");
    if (!list) {
      return;
    }
    const q = (librarySearch?.value ?? "").trim().toLowerCase();
    const all = FzTouches.list().filter(t => !q || `${t.name} ${siteKey(t.scope)}`.toLowerCase().includes(q));
    const bySite = new Map();
    for (const t of all) {
      const site = siteKey(t.scope);
      bySite.set(site, [...(bySite.get(site) ?? []), t]);
    }
    const sites = [...bySite.keys()].sort((a, b) => a.localeCompare(b));
    list.replaceChildren(
      ...sites.map(site =>
        h(
          "section",
          { class: "fz-category" },
          h("h3", { class: "fz-category-title", text: site }),
          h("div", { class: "fz-list" }, ...bySite.get(site).map(libraryRow))
        )
      )
    );
    libraryView.querySelector(".fz-touches-library-empty").hidden = FzTouches.list().length > 0;
    libraryView.querySelector(".fz-no-results").hidden = !(FzTouches.list().length && !all.length);
  }

  function buildView() {
    const button = (text, fn, title) => h("button", { type: "button", class: "fz-reset", text, title, onclick: () => libraryRun(fn) });
    librarySearch = h("input", {
      type: "search",
      class: "fz-lib-search fz-settings-search",
      placeholder: "Search touches",
      "aria-label": "Search touches",
      oninput: renderLibrary,
      onkeydown: e => {
        if (e.key === "Escape" && librarySearch.value) {
          e.stopPropagation();
          librarySearch.value = "";
          renderLibrary();
        }
      },
    });
    libraryView = h(
      "div",
      { class: "fz-settings-view fz-touches-view" },
      h("header", { class: "fz-header" }, h("h2", { text: "Touches" }), h("span", { class: "fz-subtitle", text: "Your restyles of websites, by site" }), librarySearch),
      h(
        "div",
        { class: "fz-mods-toolbar" },
        button("Import…", importFile, "Touches exported to a file"),
        button("Try a copied link", async () => {
          const message = await pasteLink();
          if (!message) {
            window.FirefoxZenLibrary?.close();
          }
          return message;
        }),
        button("Export all…", () => exportTouches(FzTouches.list()))
      ),
      h("div", { class: "fz-touches-library" }),
      h(
        "p",
        { class: "fz-touches-library-empty fz-hint", hidden: true },
        "No touches yet. On a website, click the sparkle button in the address bar (or right-click something → Touch up this element…)."
      ),
      h("p", { class: "fz-no-results fz-hint", text: "No touches match.", hidden: true }),
      h(
        "footer",
        { class: "fz-footer" },
        h(
          "div",
          { class: "fz-footer-text" },
          h("span", { class: "fz-hint", text: "Kept in chrome/.firefox-zen/touches.json. Shared and imported touches never load anything from other sites." }),
          h("span", { class: "fz-hint fz-status", role: "status", "data-empty": true })
        )
      )
    );
    Promise.resolve().then(renderLibrary);
    FzTouches.ready.then(renderLibrary);
    return libraryView;
  }

  window.FirefoxZenTouches = { buildView };

  // ---- context menu ----

  const contextMenu = document.getElementById("contentAreaContextMenu");
  const contextItem = document.createXULElement("menuitem");
  contextItem.id = CONTEXT_ID;
  contextItem.className = "menuitem-iconic";
  contextItem.setAttribute("label", "Touch up this element…");
  contextItem.setAttribute("accesskey", "u");
  const inspectSeparator = document.getElementById("inspect-separator");
  if (inspectSeparator) {
    inspectSeparator.before(contextItem);
  } else {
    contextMenu?.append(contextItem);
  }

  const onContextShowing = e => {
    if (e.target !== contextMenu) {
      return;
    }
    const ctx = window.gContextMenu;
    contextItem.hidden = !(
      FzTouches.enabled &&
      ctx &&
      !ctx.inFrame &&
      ctx.browser === gBrowser.selectedBrowser &&
      isWebsite(ctx.browser.currentURI)
    );
  };
  contextMenu?.addEventListener("popupshowing", onContextShowing);

  contextItem.addEventListener("command", async () => {
    const browser = gBrowser.selectedBrowser;
    const actor = actorFor(browser);
    if (!actor) {
      return;
    }
    let info = null;
    try {
      info = await actor.sendQuery("contextTarget");
    } catch {}
    if (picking) {
      stopPicking();
    }
    // (The context menu already closed the panel.)
    const { touch, draft } = targetTouch();
    state = { view: "touch", id: touch.id, draft };
    if (info) {
      picked(info);
    } else {
      startPicking("pick", browser);
    }
  });

  // ---- keeping up ----

  const observer = {
    observe() {
      updateButton();
      if (libraryView?.isConnected) {
        renderLibrary();
      }
      // Lists follow changes (from here or other windows); the element view
      // keeps its fields (they'd lose the caret), unless its edit is gone.
      if (!isOpen()) {
        return;
      }
      if (state.view === "list" || !FzTouches.get(state.id)) {
        render();
      } else if (state.view === "touch") {
        refreshEdits();
      } else if (state.view === "element" && !FzTouches.getEdit(state.id, state.editId)) {
        render();
      }
    },
  };
  Services.obs.addObserver(observer, FzTouches.CHANGED_TOPIC);
  Services.obs.addObserver(observer, FzGallery.CHANGED_TOPIC);

  const SAME_DOCUMENT = Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT;
  const tabsListener = {
    onLocationChange(browser, webProgress, request, location, flags) {
      if (!webProgress?.isTopLevel) {
        return;
      }
      const preview = previews.get(browser);
      // (A new tab says about:blank before its page: that isn't leaving.)
      if (preview && location.spec !== "about:blank") {
        if (!matchesScope(preview.fields.scope, location.spec)) {
          endPreview(browser);
        } else {
          if (!(flags & SAME_DOCUMENT)) {
            // The new page's actor is there once its location is.
            setTimeout(() => sendPreview(browser), 0);
          }
          if (!preview.bar) {
            preview.bar = true;
            // After Firefox has swept this navigation's notifications.
            setTimeout(() => previews.get(browser) === preview && showPreviewBar(browser, preview), 0);
          }
        }
      }
      if (flags & SAME_DOCUMENT) {
        actorFor(browser)?.sendAsyncMessage("recheck");
      }
      if (browser === gBrowser.selectedBrowser) {
        updateButton();
        // A new page has other touches. A single-page app moving on keeps
        // the panel (it may be mid-edit).
        if (isOpen() && !(flags & SAME_DOCUMENT)) {
          panel.hidePopup();
        } else if (isOpen() && state.view === "list") {
          render();
        }
      }
    },
  };
  gBrowser.addTabsProgressListener(tabsListener);
  const onTabSelect = () => {
    updateButton();
    if (picking) {
      stopPicking();
    }
    panel?.hidePopup();
  };
  gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);
  const onTabClose = e => previews.delete(e.target.linkedBrowser);
  gBrowser.tabContainer.addEventListener("TabClose", onTabClose);

  FzTouches.ready.then(updateButton);
  updateButton();

  window.addEventListener(
    "unload",
    () => {
      flushTyping();
      delete window.FzTouchesUI;
      delete window.FirefoxZenTouches;
      for (const browser of [...previews.keys()]) {
        endPreview(browser);
      }
      gBrowser.tabContainer.removeEventListener("TabClose", onTabClose);
      Services.obs.removeObserver(observer, FzTouches.CHANGED_TOPIC);
      Services.obs.removeObserver(observer, FzGallery.CHANGED_TOPIC);
      signIn?.flow.cancel();
      contextMenu?.removeEventListener("popupshowing", onContextShowing);
      gBrowser.removeTabsProgressListener(tabsListener);
      gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
    },
    { once: true }
  );
})();
