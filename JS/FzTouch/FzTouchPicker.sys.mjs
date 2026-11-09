// Touches' element picker, highlighter and selector maker. Runs in the
// page's content process, for FzTouchChild.
//
// The outlines are anonymous content: drawn over the page by Firefox, out of
// the page's reach (its CSS, scripts and MutationObservers don't see them).
// Styles go through the CSSOM, which a Content-Security-Policy doesn't block.

// ---- selectors ----

const MAX_COUNT = 9999;
// Attributes made to find elements by: worth more than any class.
const TEST_ATTRS = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "data-a-target", "data-test-selector", "data-target", "data-component"];
// Attributes that describe the element; used when classes don't do.
const DESCRIBING_ATTRS = ["aria-label", "name", "itemprop", "alt", "title", "type", "role"];

// Class names a build generates, which change with the next deploy:
// styled-components (Layout-sc-1xcs6mc-0, esivyI), emotion (css-1x2y3z),
// CSS modules (Foo_bar__a1B2c), and anything with numbers mixed in.
function isHashed(c) {
  return (
    /\d{3,}/.test(c) ||
    /(^|-)(sc|css|jsx|emotion|svelte|astro|tw)-/.test(c) ||
    /[a-z]\d+[a-z]|\d[a-z]+\d/i.test(c) ||
    /__[a-zA-Z0-9-]{5,}$/.test(c) ||
    /^_/.test(c) ||
    /^[a-z]{1,3}[A-Z0-9][a-zA-Z0-9]{4,}$/.test(c) ||
    // Short random mixed case: esivyI, jKpVsI.
    (c.length <= 8 && /[a-z][A-Z]/.test(c) && (/[A-Z]$/.test(c) || (c.match(/[A-Z]/g)?.length ?? 0) >= 2))
  );
}

const plainValue = v => v && v.length < 60 && !/["\\{};\n]/.test(v) && !/\d{4,}/.test(v);

function count(doc, sel) {
  try {
    return Math.min(MAX_COUNT, doc.querySelectorAll(sel).length);
  } catch {
    return -1;
  }
}

function makeSelectors(win) {
  const doc = win.document;
  const esc = s => win.CSS.escape(s);

  const stableId = id => id && id.length < 60 && !/\d{4,}|^\d|:/.test(id) && !isHashed(id);
  const classesOf = el => [...el.classList].filter(c => c.length < 40 && !isHashed(c) && !/[:[\]/@!]/.test(c)).slice(0, 3);
  const attr = (el, name) => {
    const v = el.getAttribute(name);
    return plainValue(v) ? `${el.localName}[${name}="${v}"]` : null;
  };

  // The element alone, as specific as reads well, best first.
  function owns(el) {
    const tag = el.localName;
    const list = [];
    for (const name of TEST_ATTRS) {
      list.push(attr(el, name));
    }
    if (stableId(el.id)) {
      list.push(`#${esc(el.id)}`);
    }
    const classes = classesOf(el);
    if (classes.length) {
      list.push(tag + classes.map(c => "." + esc(c)).join(""));
    }
    for (const name of DESCRIBING_ATTRS) {
      list.push(attr(el, name));
    }
    list.push(tag);
    return list.filter(Boolean);
  }

  // The first of owns() that finds this element alone, else the first.
  function own(el) {
    const list = owns(el);
    return list.find(sel => count(doc, sel) === 1) ?? list[0];
  }

  // Unique if it can be: the element's own selector, else a path up to an
  // ancestor that's unique on its own, with :nth-of-type where siblings look
  // the same.
  function unique(el) {
    const mine = own(el);
    if (count(doc, mine) === 1) {
      return mine;
    }
    const parts = [];
    for (let node = el; node && node !== doc.documentElement; node = node.parentElement) {
      let seg = own(node);
      const alone = count(doc, seg) === 1;
      if (!alone && node.parentElement) {
        const siblings = [...node.parentElement.children];
        if (siblings.filter(c => c.matches(seg)).length > 1) {
          seg += `:nth-of-type(${siblings.filter(c => c.localName === node.localName).indexOf(node) + 1})`;
        }
      }
      parts.unshift(seg);
      const sel = parts.join(" > ");
      if (alone || count(doc, sel) === 1) {
        return sel;
      }
    }
    return parts.join(" > ");
  }

  // Choices for the panel: this element first, then ones that also take in
  // elements like it (most alike first).
  function candidates(el) {
    const list = [];
    const add = sel => {
      if (sel && !list.some(c => c.sel === sel)) {
        const n = count(doc, sel);
        if (n > 0) {
          list.push({ sel, count: n });
        }
      }
    };
    add(unique(el));
    const parent = el.parentElement;
    for (const sel of owns(el)) {
      if (count(doc, sel) > 1) {
        if (parent && parent !== doc.documentElement && parent !== doc.body) {
          add(`${own(parent)} > ${sel}`);
        }
        add(sel);
      }
    }
    return list.slice(0, 5);
  }

  return { unique, candidates };
}

// A short name for an element: tag, then #id or the first good class.
function nameOf(el) {
  const id = el.id && el.id.length < 30 ? `#${el.id}` : "";
  const cls = [...el.classList].find(c => !isHashed(c) && c.length < 30);
  return { tag: el.localName, extra: id || (cls ? `.${cls}` : "") };
}

// What the panel needs about a picked element.
export function describe(win, el, { similar = false } = {}) {
  const { candidates } = makeSelectors(win);
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  const name = nameOf(el);
  return {
    candidates: candidates(el),
    // Shift+click: start on "all like it".
    similar,
    tag: el.localName,
    name: name.tag + name.extra,
    text: text.slice(0, 300),
  };
}

export function selectorCount(win, sel) {
  return count(win.document, sel);
}

// ---- current styles (the panel shows them as the fields' defaults) ----

function hex(color) {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(color ?? "");
  if (!m) {
    return color;
  }
  const alpha = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  if (alpha === 0) {
    return "transparent";
  }
  const h = [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, "0")).join("");
  return alpha < 1 ? `#${h}${Math.round(alpha * 255).toString(16).padStart(2, "0")}` : `#${h}`;
}

// "8px 8px 8px 8px" → "8px", "4px 8px 4px 8px" → "4px 8px".
function shorthand(values) {
  const [t, r, b, l] = values.map(v => v.replace(/\.\d+px$/, "px"));
  if (t === r && r === b && b === l) {
    return t;
  }
  if (t === b && r === l) {
    return `${t} ${r}`;
  }
  return `${t} ${r} ${b} ${l}`;
}

export function currentStyles(win, sel) {
  let el = null;
  try {
    el = win.document.querySelector(sel);
  } catch {}
  if (!el) {
    return null;
  }
  const s = win.getComputedStyle(el);
  const font = s.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
  let background = hex(s.backgroundColor);
  if (s.backgroundImage !== "none") {
    background = background === "transparent" ? "image" : `${background} + image`;
  }
  return {
    color: hex(s.color),
    background,
    font,
    fontSize: s.fontSize.replace(/\.\d+px$/, "px"),
    maxWidth: s.maxWidth === "none" ? "none" : s.maxWidth,
    padding: shorthand([s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft]),
    radius: shorthand([s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius]),
  };
}

// ---- drawing ----

const ACCENT = [0, 120, 255];
const ZAP = [230, 40, 80];
const rgb = (c, a = 1) => `rgb(${c.join(" ")} / ${a})`;
const FONT = "12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif";

class Overlay {
  #doc;
  #content = null;
  #hostEl = null;
  #root;
  #boxes = [];
  #label;
  #labelTag;
  #labelExtra;
  #labelSize;
  #hint;

  constructor(doc) {
    this.#doc = doc;
    try {
      this.#content = doc.insertAnonymousContent();
      this.#root = this.#content.root;
    } catch {
      // Older Firefox: a closed shadow root on the page instead.
      const host = doc.createElement("fz-touch-overlay");
      host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
      this.#root = host.attachShadow({ mode: "closed" });
      doc.documentElement.append(host);
      this.#hostEl = host;
    }
    this.#label = this.#make(
      `position: fixed; z-index: 2; display: none; align-items: baseline; gap: 6px; max-width: min(520px, 80vw); padding: 3px 8px; border-radius: 6px; font: ${FONT}; color: white; white-space: nowrap; overflow: hidden; box-shadow: 0 2px 8px rgb(0 0 0 / 0.3);`
    );
    this.#labelTag = this.#make("font-weight: 700;", this.#label);
    this.#labelExtra = this.#make("color: rgb(255 255 255 / 0.9); overflow: hidden; text-overflow: ellipsis;", this.#label);
    this.#labelSize = this.#make("flex: none; color: rgb(255 255 255 / 0.75); font-variant-numeric: tabular-nums;", this.#label);
    this.#hint = this.#make(
      `position: fixed; z-index: 2; bottom: 16px; left: 50%; translate: -50% 0; display: none; align-items: center; gap: 14px; padding: 8px 14px; border-radius: 10px; background: rgb(24 24 28 / 0.92); color: rgb(255 255 255 / 0.85); font: ${FONT}; white-space: nowrap; box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);`
    );
  }

  #make(css, parent = this.#root, tag = "div") {
    const el = this.#doc.createElement(tag);
    el.style.cssText = `pointer-events: none; box-sizing: border-box; ${css}`;
    parent.append(el);
    return el;
  }

  // Outlines around elements (viewport rects). The first one is labeled and,
  // with dim, the rest of the page is dimmed around it.
  draw(els, { color = ACCENT, label = null, dim = false } = {}) {
    const rects = els.map(el => el.getBoundingClientRect()).filter(r => r.width || r.height);
    while (this.#boxes.length < rects.length) {
      this.#boxes.push(this.#make("position: fixed; z-index: 1; border-radius: 3px; transition: left 70ms, top 70ms, width 70ms, height 70ms;"));
    }
    this.#boxes.forEach((box, i) => {
      const r = rects[i];
      if (!r) {
        box.style.display = "none";
        return;
      }
      Object.assign(box.style, {
        display: "block",
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        outline: `2px solid ${rgb(color)}`,
        background: rgb(color, 0.1),
        boxShadow: dim && i === 0 ? "0 0 0 100vmax rgb(0 0 0 / 0.28)" : "none",
      });
    });
    const first = rects[0];
    if (label && first) {
      const win = this.#doc.defaultView;
      this.#labelTag.textContent = label.tag ?? "";
      this.#labelExtra.textContent = label.extra ?? "";
      this.#labelSize.textContent = label.size ?? "";
      const above = first.top > 30;
      Object.assign(this.#label.style, {
        display: "flex",
        background: rgb(color),
        left: `${Math.min(Math.max(4, first.left), win.innerWidth - 120)}px`,
        top: above ? `${first.top - 28}px` : `${Math.min(first.bottom + 6, win.innerHeight - 28)}px`,
      });
    } else {
      this.#label.style.display = "none";
    }
  }

  // A pulse where something was zapped.
  poof(rect) {
    const el = this.#make(
      `position: fixed; left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; height: ${rect.height}px; border-radius: 4px; background: ${rgb(ZAP, 0.35)}; outline: 2px solid ${rgb(ZAP)};`
    );
    try {
      const anim = el.animate(
        [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(0.92)" },
        ],
        { duration: 260, easing: "ease-in" }
      );
      anim.finished.then(() => el.remove(), () => el.remove());
    } catch {
      el.remove();
    }
  }

  // [[keys, what], …] as key chips; a plain string for status text.
  hint(items) {
    if (!items?.length) {
      this.#hint.style.display = "none";
      return;
    }
    this.#hint.replaceChildren();
    for (const item of items) {
      if (typeof item === "string") {
        this.#make("font-weight: 600; color: white;", this.#hint, "span").textContent = item;
        continue;
      }
      const group = this.#make("display: flex; align-items: center; gap: 6px;", this.#hint, "span");
      this.#make(
        "padding: 1px 6px; border: 1px solid rgb(255 255 255 / 0.25); border-radius: 4px; background: rgb(255 255 255 / 0.1); color: white; font-weight: 600;",
        group,
        "span"
      ).textContent = item[0];
      this.#make("", group, "span").textContent = item[1];
    }
    this.#hint.style.display = "flex";
  }

  destroy() {
    try {
      if (this.#content) {
        this.#doc.removeAnonymousContent(this.#content);
      }
      this.#hostEl?.remove();
    } catch {}
  }
}

// ---- highlighting matches (the panel's element view) ----

export class Highlighter {
  #win;
  #overlay = null;
  #sel = null;
  #redraw = () => this.#draw();

  constructor(win) {
    this.#win = win;
  }

  show(sel) {
    this.#sel = sel;
    if (!this.#overlay) {
      this.#overlay = new Overlay(this.#win.document);
      this.#win.addEventListener("scroll", this.#redraw, { capture: true, passive: true });
      this.#win.addEventListener("resize", this.#redraw);
    }
    this.#draw();
    return selectorCount(this.#win, sel);
  }

  #draw() {
    let els = [];
    try {
      els = [...this.#win.document.querySelectorAll(this.#sel)].slice(0, 200);
    } catch {}
    const n = selectorCount(this.#win, this.#sel);
    this.#overlay?.draw(els, { label: n > 1 ? { tag: `${n} elements` } : null });
  }

  hide() {
    this.#win.removeEventListener("scroll", this.#redraw, { capture: true });
    this.#win.removeEventListener("resize", this.#redraw);
    this.#overlay?.destroy();
    this.#overlay = null;
  }
}

// ---- picking ----

// mode "pick": the first click picks (onPick gets describe()).
// mode "zap": each click hides an element (onZap gets its selector) until
// Esc. onEnd(reason) when it stops.
export class Picker {
  #win;
  #mode;
  #cb;
  #overlay;
  #current = null;
  #down = []; // elements ArrowUp left, for ArrowDown
  #zapped = 0;
  #selectors;
  #listener = e => this.handleEvent(e);

  constructor(win, mode, callbacks) {
    this.#win = win;
    this.#mode = mode;
    this.#cb = callbacks;
    this.#selectors = makeSelectors(win);
    this.#overlay = new Overlay(win.document);
    for (const type of Picker.#EVENTS) {
      win.addEventListener(type, this.#listener, { capture: true });
    }
    this.#showHint();
  }

  static #EVENTS = ["mousemove", "mousedown", "mouseup", "click", "auxclick", "pointerdown", "pointerup", "dblclick", "contextmenu", "keydown", "scroll", "pagehide"];

  #showHint() {
    this.#overlay.hint(
      this.#mode === "zap"
        ? [this.#zapped ? `${this.#zapped} hidden` : "Zap", ["Click", "hide it"], ["↑ ↓", "bigger / smaller"], ["Esc", "done"]]
        : [["Click", "pick it"], ["Shift+click", "all like it"], ["↑ ↓", "bigger / smaller"], ["Esc", "cancel"]]
    );
  }

  #draw() {
    const el = this.#current;
    if (!el?.isConnected) {
      this.#current = null;
      this.#overlay.draw([]);
      return;
    }
    const r = el.getBoundingClientRect();
    const name = nameOf(el);
    this.#overlay.draw([el], {
      color: this.#mode === "zap" ? ZAP : ACCENT,
      dim: true,
      label: { tag: name.tag, extra: name.extra, size: `${Math.round(r.width)} × ${Math.round(r.height)}` },
    });
  }

  handleEvent(e) {
    if (e.type === "pagehide") {
      this.stop("navigated");
      return;
    }
    if (e.type === "scroll") {
      this.#draw();
      return;
    }
    if (!e.isTrusted) {
      return;
    }
    if (e.type === "keydown") {
      this.#key(e);
      return;
    }
    // The page doesn't see clicks while picking.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "mousemove") {
      const el = e.target?.nodeType === 1 ? e.target : null;
      if (el && el !== this.#current && !this.#down.includes(el) && el !== this.#win.document.documentElement) {
        // Moving inside an element picked with ↑ keeps it.
        if (this.#down.length && this.#current?.contains(el)) {
          return;
        }
        this.#current = el;
        this.#down = [];
        this.#draw();
      }
    } else if (e.type === "click" && e.button === 0) {
      // A click without a move first (the page scrolled under the mouse, or
      // the picker started with the mouse already there): its own target.
      if (!this.#current && e.target?.nodeType === 1 && e.target !== this.#win.document.documentElement) {
        this.#current = e.target;
      }
      this.#pick(e.shiftKey);
    }
  }

  #key(e) {
    const el = this.#current;
    const doc = this.#win.document;
    let handled = true;
    if (e.key === "Escape") {
      this.stop("cancel");
    } else if (e.key === "Enter") {
      this.#pick(e.shiftKey);
    } else if (e.key === "ArrowUp" && el?.parentElement && el.parentElement !== doc.documentElement) {
      this.#down.push(el);
      this.#current = el.parentElement;
      this.#draw();
    } else if (e.key === "ArrowDown" && el) {
      const child = this.#down.pop() ?? el.firstElementChild;
      if (child) {
        this.#current = child;
        this.#draw();
      }
    } else {
      handled = !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  #pick(similar = false) {
    const el = this.#current;
    if (!el) {
      return;
    }
    if (this.#mode === "zap") {
      this.#overlay.poof(el.getBoundingClientRect());
      this.#cb.onZap(this.#selectors.unique(el));
      this.#zapped++;
      this.#current = null;
      this.#down = [];
      this.#draw();
      this.#showHint();
      return;
    }
    // onPick first: the window takes "picked" before "pickEnd".
    this.#cb.onPick(describe(this.#win, el, { similar }));
    this.stop("picked");
  }

  stop(reason = "cancel") {
    if (!this.#overlay) {
      return;
    }
    for (const type of Picker.#EVENTS) {
      this.#win.removeEventListener(type, this.#listener, { capture: true });
    }
    this.#overlay.destroy();
    this.#overlay = null;
    this.#cb.onEnd(reason);
  }
}
