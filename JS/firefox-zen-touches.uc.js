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
    button.setAttribute("tooltiptext", count ? `Touches (${count} on)` : "Touches");
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

  function render() {
    if (!panel) {
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
        h("span", { class: "fz-touches-host", text: host(uri) })
      ),
      rows.length
        ? h("ul", { class: "fz-touches-list" }, ...rows)
        : h("p", {
            class: "fz-touches-empty",
            text: "Restyle this site: pick an element to change, zap what's in the way, or write CSS. Each touch has its own switch.",
          }),
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
        })
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

  const SAME_DOCUMENT = Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT;
  const tabsListener = {
    onLocationChange(browser, webProgress, request, location, flags) {
      if (!webProgress?.isTopLevel) {
        return;
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

  FzTouches.ready.then(updateButton);
  updateButton();

  window.addEventListener(
    "unload",
    () => {
      flushTyping();
      delete window.FzTouchesUI;
      Services.obs.removeObserver(observer, FzTouches.CHANGED_TOPIC);
      contextMenu?.removeEventListener("popupshowing", onContextShowing);
      gBrowser.removeTabsProgressListener(tabsListener);
      gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
    },
    { once: true }
  );
})();
