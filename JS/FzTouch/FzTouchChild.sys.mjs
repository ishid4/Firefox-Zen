// The page side of Touches (see JS/firefox-zen-touches.sys.mjs). Runs in the
// page's content process, top-level http(s) pages only.
//
// The touches that are on come from sharedData, read synchronously when the
// page's window is created, so their CSS is there before the first paint.
// Each matching touch is an author style sheet on this page alone (like the
// page's own CSS, but outside its Content-Security-Policy), plus its DOM
// edits (FzTouchDOM). They're re-checked when the list changes (an edit, a
// switch) and when the page changes its URL without loading ("recheck", for
// single-page apps).
//
// Also the picker (FzTouchPicker) when the panel asks for it. Messages:
// - from the window: "recheck", "pick" { mode }, "stopPick",
//   "highlight" { sel } (→ how many match; sel null hides it),
//   "styles" { sel } (→ the first match's current colors, font, sizes),
//   "contextTarget" (→ describe() of the element last right-clicked, or null),
//   "preview" { touch } / "endPreview": a touch on this page only, not saved
//   (a shared one being tried), on top of the others whatever its scope.
// - to the window (through FzTouchParent): "picked" info, "zapped" { sel },
//   "pickEnd" { mode, reason }, "try" { data } (the store's touch page:
//   Try it, see FzTouchParent).
//
// The store's touch page has <meta name="fz-touch-page">; on it (and only
// there, FzTouchParent checks) <html> gets data-fz-touches, so the page can
// offer Try it instead of explaining what Firefox-Zen is.

import { SHARED_KEY, matchesScope } from "chrome://userscripts/content/FzTouch/FzTouchScope.sys.mjs";
import { DomEdits } from "chrome://userscripts/content/FzTouch/FzTouchDOM.sys.mjs";
import { Picker, Highlighter, describe, currentStyles } from "chrome://userscripts/content/FzTouch/FzTouchPicker.sys.mjs";

const AUTHOR_SHEET = Ci.nsIDOMWindowUtils.AUTHOR_SHEET;

const sheetURL = (id, css) =>
  // The id keeps two touches with the same CSS apart.
  `data:text/css;charset=utf-8,${encodeURIComponent(`/* Firefox-Zen touch ${id} */\n${css}`)}`;

export class FzTouchChild extends JSWindowActorChild {
  // Sheet URLs on the page, in the order they were added.
  #sheets = [];
  #listening = false;
  #dom = null;
  #picker = null;
  #highlighter = null;
  // The element last right-clicked, for "Touch up this element".
  #contextTarget = null;
  // A shared touch being tried here: { id, scope, css, dom }.
  #preview = null;

  #onChange = event => {
    if (event.changedKeys.includes(SHARED_KEY)) {
      this.#apply();
    }
  };

  handleEvent(event) {
    if (event.type === "DOMWindowCreated") {
      if (!this.#listening) {
        this.#listening = true;
        Services.cpmm.sharedData.addEventListener("change", this.#onChange);
      }
      this.#apply();
    } else if (event.type === "contextmenu") {
      const target = event.composedTarget ?? event.target;
      this.#contextTarget = target?.nodeType === 1 ? Cu.getWeakReference(target) : null;
    } else if (event.type === "DOMContentLoaded") {
      // DOM edits need the page's elements.
      this.#apply();
      this.#markStorePage();
    } else if (event.type === "fz-touch-try") {
      // From a click on the store's touch page; the parent checks the page.
      const data = typeof event.detail === "string" ? event.detail : null;
      if (data && data.length < 600000 && this.document.hasValidTransientUserGestureActivation) {
        this.#send("try", { data });
      }
    }
  }

  receiveMessage({ name, data }) {
    switch (name) {
      case "recheck":
        this.#apply();
        return null;
      case "pick":
        this.#startPicker(data?.mode === "zap" ? "zap" : "pick");
        return null;
      case "stopPick":
        this.#picker?.stop("cancel");
        return null;
      case "highlight": {
        if (typeof data?.sel !== "string") {
          this.#highlighter?.hide();
          this.#highlighter = null;
          return null;
        }
        this.#highlighter ??= new Highlighter(this.contentWindow);
        return this.#highlighter.show(data.sel);
      }
      case "styles":
        return typeof data?.sel === "string" ? currentStyles(this.contentWindow, data.sel) : null;
      case "preview":
        this.#preview = data?.touch && typeof data.touch.css === "string" ? data.touch : null;
        this.#apply();
        return null;
      case "endPreview":
        this.#preview = null;
        this.#apply();
        return null;
      case "contextTarget": {
        const el = this.#contextTarget?.get();
        return el?.isConnected ? describe(this.contentWindow, el) : null;
      }
    }
    return null;
  }

  didDestroy() {
    if (this.#listening) {
      Services.cpmm.sharedData.removeEventListener("change", this.#onChange);
      this.#listening = false;
    }
    this.#dom?.destroy();
    this.#picker = null;
    this.#highlighter = null;
  }

  async #markStorePage() {
    if (!this.document.querySelector('meta[name="fz-touch-page"]')) {
      return;
    }
    try {
      if (await this.sendQuery("isStorePage")) {
        this.document.documentElement.setAttribute("data-fz-touches", "");
        this.document.dispatchEvent(new this.contentWindow.Event("fz-touches-ready"));
      }
    } catch {}
  }

  #send(name, data) {
    try {
      this.sendAsyncMessage(name, data);
    } catch {}
  }

  #startPicker(mode) {
    this.#picker?.stop("cancel");
    this.#highlighter?.hide();
    this.#highlighter = null;
    this.#picker = new Picker(this.contentWindow, mode, {
      onPick: info => this.#send("picked", info),
      onZap: sel => this.#send("zapped", { sel }),
      onEnd: reason => {
        this.#picker = null;
        this.#send("pickEnd", { mode, reason });
      },
    });
  }

  #apply() {
    let utils, href;
    try {
      utils = this.contentWindow.windowUtils;
      href = this.document.URL;
    } catch {
      // The page went away.
      return;
    }
    const list = Services.cpmm.sharedData.get(SHARED_KEY);
    const touches = (Array.isArray(list) ? list : []).filter(t => typeof t?.css === "string" && matchesScope(t.scope, href));
    if (this.#preview) {
      touches.push(this.#preview);
    }
    this.#applySheets(
      utils,
      touches.filter(t => t.css.trim()).map(t => sheetURL(t.id, t.css))
    );
    const dom = touches.flatMap(t =>
      (Array.isArray(t.dom) ? t.dom : []).map(e => ({ ...e, key: `${t.id}/${e.id}/${JSON.stringify([e.sel, e.text, e.insert])}` }))
    );
    if (dom.length || this.#dom) {
      // Before the page has a body there's nothing to change yet;
      // DOMContentLoaded comes back here.
      if (this.document.readyState !== "loading" || !dom.length) {
        this.#dom ??= new DomEdits(this.contentWindow);
        this.#dom.set(dom);
      }
    }
  }

  #applySheets(utils, want) {
    if (want.length === this.#sheets.length && want.every((url, i) => url === this.#sheets[i])) {
      return;
    }
    // Everything again, so later touches still come after earlier ones.
    for (const url of this.#sheets) {
      try {
        utils.removeSheetUsingURIString(url, AUTHOR_SHEET);
      } catch {}
    }
    this.#sheets = [];
    for (const url of want) {
      try {
        utils.loadSheetUsingURIString(url, AUTHOR_SHEET);
        this.#sheets.push(url);
      } catch (e) {
        console.error("Firefox-Zen Touches: couldn't add a touch to the page", e);
      }
    }
  }
}
