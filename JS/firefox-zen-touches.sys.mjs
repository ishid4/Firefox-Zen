// ==UserScript==
// @name           Firefox-Zen Touches
// @description    Touches: your own CSS for websites, several per site, each with its own switch
// ==/UserScript==

// Background module (loaded once by fx-autoconfig, shared by every window).
// The window side (the address bar button and its panel) is in
// JS/firefox-zen-touches.uc.js.
//
// A touch is { id, name, enabled, scope, edits, css, created, updated };
// scope is { type, value } (see JS/FzTouch/FzTouchScope.sys.mjs), edits are
// what the element picker made (see "element edits" below), css is typed by
// hand. They're kept in chrome/.firefox-zen/touches.json, which updates never
// touch.
//
// How a touch reaches a page: the touches that are on go into
// Services.ppmm.sharedData (SHARED_KEY), which every content process can read
// synchronously. The FzTouch actor (JS/FzTouch/) reads it as each page's
// window is created, before anything is drawn, and adds a style sheet per
// matching touch to that page alone; an edit here reaches open pages at once
// through sharedData's change event. Sheets added that way aren't subject to
// the page's Content-Security-Policy.
//
// Firefox-Zen Settings → Touches (PREF) turns them all off: pages then get an
// empty list and the button goes away.

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { SHARED_KEY, SCOPE_TYPES, matchesScope, pagePath } from "chrome://userscripts/content/FzTouch/FzTouchScope.sys.mjs";

const PREF = "firefox-zen.touches";
const CHANGED_TOPIC = "firefox-zen-touches-changed";
const STATE_DIR = PathUtils.join(PathUtils.profileDir, "chrome", ".firefox-zen");
const FILE = PathUtils.join(STATE_DIR, "touches.json");
const SAVE_DELAY = 400;

const MAX_NAME = 80;
const MAX_CSS = 256 * 1024;
const MAX_SCOPE = 2048;
const ID_RE = /^[a-z0-9-]{1,64}$/;

/** @type {Map<string, object>} id -> touch, in the order they apply */
const touches = new Map();
let saveTimer = null;

const isOn = () => Services.prefs.getBoolPref(PREF, true);
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const newId = () => Services.uuid.generateUUID().toString().slice(1, -1);

function cleanScope(scope) {
  const type = SCOPE_TYPES.includes(scope?.type) ? scope.type : null;
  let value = text(scope?.value, MAX_SCOPE).trim();
  if (type !== "prefix") {
    value = value.toLowerCase();
  }
  return type && value ? { type, value } : null;
}

// ---- element edits ----
//
// What the picker and the panel's element view make: one entry per element
// (selector), { id, sel, hide, style, text, insert }.
// - hide and style become CSS (editCSS), ahead of the touch's own CSS.
// - text (the element's new text) and insert ({ where, html }: HTML added
//   before/after/at the start/at the end of it) are done to the page by
//   FzTouchChild, again whenever the page adds matching elements. The HTML is
//   cleaned there (FzTouchDOM.sanitize): no scripts, handlers or forms.

const MAX_SEL = 500;
const MAX_TEXT = 4000;
const MAX_HTML = 16 * 1024;
const MAX_EDITS = 200;
const WHERE = ["before", "after", "prepend", "append"];
export const FONTS = {
  system: "system-ui, sans-serif",
  sans: "sans-serif",
  serif: "serif",
  mono: "ui-monospace, monospace",
};
// [key, CSS property, min, max] for the number styles, in px.
const SIZES = [
  ["fontSize", "font-size", 6, 200],
  ["maxWidth", "max-width", 100, 4000],
  ["padding", "padding", 0, 200],
  ["radius", "border-radius", 0, 200],
];
// A CSS color as typed: names, #hex, rgb()/hsl()/oklch()…, but nothing that
// could end the declaration or rule it goes in.
const COLOR_RE = /^[#a-zA-Z0-9(),.%\s/-]{1,60}$/;

// A selector that can't break out of its rule. Whether it parses is checked
// where there's a document (the panel, the page).
export function safeSelector(sel) {
  return typeof sel === "string" && sel.trim().length > 0 && sel.length <= MAX_SEL && !/[{};]|\/\*|\\$/.test(sel);
}

function cleanEdit(e) {
  const sel = typeof e?.sel === "string" ? e.sel.trim() : "";
  if (!safeSelector(sel)) {
    return null;
  }
  const style = {};
  for (const key of ["color", "background"]) {
    const v = text(e.style?.[key], 60).trim();
    if (COLOR_RE.test(v) && !v.includes("//")) {
      style[key] = v;
    }
  }
  if (Object.hasOwn(FONTS, e.style?.fontFamily)) {
    style.fontFamily = e.style.fontFamily;
  }
  for (const [key, , min, max] of SIZES) {
    const n = Number(e.style?.[key]);
    if (e.style?.[key] !== "" && e.style?.[key] != null && Number.isFinite(n)) {
      style[key] = Math.min(max, Math.max(min, Math.round(n)));
    }
  }
  const insertHTML = text(e.insert?.html, MAX_HTML);
  return {
    id: ID_RE.test(e.id ?? "") ? e.id : newId(),
    sel,
    hide: e.hide === true,
    style,
    text: typeof e.text === "string" && e.text.length ? e.text.slice(0, MAX_TEXT) : null,
    insert: insertHTML.trim() ? { where: WHERE.includes(e.insert.where) ? e.insert.where : "after", html: insertHTML } : null,
  };
}

const editIsEmpty = e => !e.hide && !Object.keys(e.style).length && e.text == null && !e.insert;

function editCSS(edits) {
  const rules = [];
  for (const e of edits) {
    if (e.hide) {
      rules.push(`${e.sel} { display: none !important; }`);
      continue;
    }
    const decls = [];
    if (e.style.color) {
      decls.push(`color: ${e.style.color} !important;`);
    }
    if (e.style.background) {
      decls.push(`background: ${e.style.background} !important;`);
    }
    if (e.style.fontFamily) {
      decls.push(`font-family: ${FONTS[e.style.fontFamily]} !important;`);
    }
    for (const [key, prop] of SIZES) {
      if (e.style[key] != null) {
        decls.push(`${prop}: ${e.style[key]}px !important;`);
      }
    }
    if (e.style.maxWidth != null) {
      decls.push("margin-inline: auto !important;");
    }
    if (decls.length) {
      rules.push(`${e.sel} {\n  ${decls.join("\n  ")}\n}`);
    }
  }
  return rules.join("\n");
}

// One line about what an edit does, for the panel.
function editSummary(e) {
  const parts = [];
  if (e.hide) {
    return "Hidden";
  }
  if (e.style.color || e.style.background) {
    parts.push("colors");
  }
  if (e.style.fontFamily || e.style.fontSize != null) {
    parts.push("font");
  }
  if (e.style.maxWidth != null || e.style.padding != null) {
    parts.push("size");
  }
  if (e.style.radius != null) {
    parts.push("corners");
  }
  if (e.text != null) {
    parts.push("text");
  }
  if (e.insert) {
    parts.push("added HTML");
  }
  return parts.length ? parts.join(", ").replace(/^./, c => c.toUpperCase()) : "No changes";
}

function cleanTouch(t) {
  const scope = cleanScope(t?.scope);
  if (!scope) {
    return null;
  }
  const now = Date.now();
  const edits = [];
  for (const raw of Array.isArray(t.edits) ? t.edits.slice(0, MAX_EDITS) : []) {
    const e = cleanEdit(raw);
    if (e && !edits.some(x => x.id === e.id)) {
      edits.push(e);
    }
  }
  return {
    id: ID_RE.test(t.id ?? "") ? t.id : newId(),
    name: text(t.name, MAX_NAME).trim() || "Touch",
    enabled: t.enabled !== false,
    scope,
    edits,
    css: text(t.css, MAX_CSS),
    created: Number.isFinite(t.created) ? t.created : now,
    updated: Number.isFinite(t.updated) ? t.updated : now,
  };
}

// Whether a touch changes anything on a page.
const hasContent = t => !!t.css.trim() || t.edits.some(e => !editIsEmpty(e));

// ---- storage ----

async function load() {
  let data = null;
  try {
    data = await IOUtils.readJSON(FILE);
  } catch (e) {
    if (e.name !== "NotFoundError") {
      console.error("Firefox-Zen Touches: couldn't read touches.json", e);
    }
  }
  for (const raw of Array.isArray(data?.touches) ? data.touches : []) {
    const t = cleanTouch(raw);
    if (t && !touches.has(t.id)) {
      touches.set(t.id, t);
    }
  }
  publish();
}

async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await IOUtils.makeDirectory(STATE_DIR, { createAncestors: true });
    await IOUtils.writeJSON(FILE, { version: 1, touches: [...touches.values()] }, { tmpPath: FILE + ".tmp" });
  } catch (e) {
    console.error("Firefox-Zen Touches: couldn't save touches.json", e);
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY);
}

// A pending save goes out before Firefox quits (IOUtils finishes writes it
// was given before the profile goes away).
Services.obs.addObserver(() => saveTimer && save(), "quit-application-granted");

// ---- pages ----

function publish() {
  const list = isOn()
    ? [...touches.values()]
        .filter(t => t.enabled && hasContent(t))
        .map(({ id, scope, css, edits }) => ({
          id,
          scope,
          css: [editCSS(edits), css].filter(s => s.trim()).join("\n"),
          dom: edits.filter(e => e.text != null || e.insert).map(({ id: eid, sel, text: t, insert }) => ({ id: eid, sel, text: t, insert })),
        }))
    : [];
  Services.ppmm.sharedData.set(SHARED_KEY, list);
  // Without it, content processes only see the change when the parent is idle.
  Services.ppmm.sharedData.flush();
  Services.obs.notifyObservers(null, CHANGED_TOPIC);
}

function changed() {
  publish();
  saveSoon();
}

Services.prefs.addObserver(PREF, () => publish());

// ---- scopes for a page ----

// The scopes the panel offers for a page (an nsIURI or URL string), broadest
// last: the site, its whole registrable domain when that's wider
// (gist.github.com → github.com), the folder the page is in, the page.
function scopesFor(uri) {
  let url;
  try {
    url = new URL(typeof uri === "string" ? uri : uri.spec);
  } catch {
    return [];
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return [];
  }
  const host = url.hostname.toLowerCase();
  const site = host.replace(/^www\./, "");
  const scopes = [{ type: "domain", value: site }];
  let base = null;
  try {
    base = Services.eTLD.getBaseDomainFromHost(host);
  } catch {}
  if (base && base !== site) {
    scopes.push({ type: "domain", value: base });
  }
  const page = pagePath(url);
  const folder = page.slice(0, page.lastIndexOf("/") + 1);
  if (url.pathname !== "/" && folder !== url.origin + "/") {
    scopes.push({ type: "prefix", value: folder });
  }
  if (url.pathname !== "/") {
    scopes.push({ type: "prefix", value: page });
  }
  return scopes;
}

function scopeLabel(scope) {
  if (scope.type === "domain") {
    return `All of ${scope.value}`;
  }
  if (scope.type === "host") {
    return `Only ${scope.value}`;
  }
  const shown = scope.value.replace(/^https?:\/\//, "");
  return shown.endsWith("/") ? `Pages under ${shown}` : `Only ${shown}`;
}

const sameScope = (a, b) => a?.type === b?.type && a?.value === b?.value;

// ---- API ----

export const FzTouches = {
  PREF,
  CHANGED_TOPIC,
  ready: load(),

  get enabled() {
    return isOn();
  },

  list() {
    return [...touches.values()];
  },

  get(id) {
    return touches.get(id) ?? null;
  },

  // Touches whose scope covers this page (nsIURI or string), on or off.
  forPage(uri) {
    const href = typeof uri === "string" ? uri : uri?.spec ?? "";
    return [...touches.values()].filter(t => matchesScope(t.scope, href));
  },

  // How many touches that are on (and change something) apply to the page.
  activeCount(uri) {
    return this.forPage(uri).filter(t => t.enabled && hasContent(t)).length;
  },

  hasContent,
  scopesFor,
  scopeLabel,
  sameScope,
  safeSelector,
  editSummary,
  editIsEmpty,
  FONTS,

  // ---- element edits ----

  getEdit(touchId, editId) {
    return touches.get(touchId)?.edits.find(e => e.id === editId) ?? null;
  },

  // Adds an edit for a selector, or changes the one the touch already has for
  // it (so zapping the same thing twice doesn't add it twice).
  addEdit(touchId, fields) {
    const t = touches.get(touchId);
    if (!t || !safeSelector(fields?.sel)) {
      return null;
    }
    const sel = fields.sel.trim();
    const existing = t.edits.find(e => e.sel === sel);
    if (existing) {
      return this.updateEdit(touchId, existing.id, fields);
    }
    if (t.edits.length >= MAX_EDITS) {
      return null;
    }
    const e = cleanEdit({ hide: false, style: {}, ...fields, sel, id: undefined });
    this.update(touchId, { edits: [...t.edits, e] });
    return this.getEdit(touchId, e.id);
  },

  updateEdit(touchId, editId, patch) {
    const t = touches.get(touchId);
    const i = t?.edits.findIndex(e => e.id === editId) ?? -1;
    if (i < 0) {
      return null;
    }
    const e = cleanEdit({ ...t.edits[i], ...patch, style: { ...t.edits[i].style, ...patch.style }, id: editId });
    if (!e) {
      return t.edits[i];
    }
    // A key set to "" or null in patch.style clears it.
    for (const [k, v] of Object.entries(patch.style ?? {})) {
      if (v === "" || v == null) {
        delete e.style[k];
      }
    }
    const edits = t.edits.slice();
    edits[i] = e;
    this.update(touchId, { edits });
    return e;
  },

  removeEdit(touchId, editId) {
    const t = touches.get(touchId);
    if (t?.edits.some(e => e.id === editId)) {
      this.update(touchId, { edits: t.edits.filter(e => e.id !== editId) });
    }
  },

  // A new, empty touch for the page, on, covering its site.
  create(uri, fields = {}) {
    const scope = cleanScope(fields.scope) ?? scopesFor(uri)[0];
    if (!scope) {
      throw new Error("Touches only work on websites");
    }
    const count = this.forPage(uri).length;
    const t = cleanTouch({ name: count ? `Touch ${count + 1}` : "Touch", css: "", ...fields, scope });
    touches.set(t.id, t);
    changed();
    return t;
  },

  // Changes name, enabled, scope and/or css.
  update(id, patch) {
    const t = touches.get(id);
    if (!t) {
      return null;
    }
    const next = cleanTouch({ ...t, ...patch, id, updated: Date.now() });
    if (!next) {
      return t;
    }
    touches.set(id, next);
    changed();
    return next;
  },

  setEnabled(id, enabled) {
    return this.update(id, { enabled: !!enabled });
  },

  remove(id) {
    if (touches.delete(id)) {
      changed();
    }
  },
};

try {
  ChromeUtils.registerWindowActor("FzTouch", {
    parent: { esModuleURI: "chrome://userscripts/content/FzTouch/FzTouchParent.sys.mjs" },
    child: {
      esModuleURI: "chrome://userscripts/content/FzTouch/FzTouchChild.sys.mjs",
      events: {
        // Before the page is drawn, so a touch never flashes in.
        DOMWindowCreated: {},
        // DOM edits, once there are elements.
        DOMContentLoaded: {},
        // The element "Touch up this element" is about.
        contextmenu: { capture: true, mozSystemGroup: true },
      },
    },
    matches: ["http://*/*", "https://*/*"],
    // Web pages are in web content processes. What the child sends up (the
    // picker's selectors and text) is checked by the window before use.
    safeForUntrustedWebProcess: true,
  });
} catch (e) {
  console.error("Firefox-Zen Touches: couldn't register the page actor", e);
}
