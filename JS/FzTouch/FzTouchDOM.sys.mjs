// Touches' DOM edits on a page (see JS/firefox-zen-touches.sys.mjs, element
// edits): an element's text replaced, HTML added next to or inside it.
// Runs in the page's content process, for FzTouchChild.
//
// Pages keep changing (single-page apps re-render, feeds load more), so a
// MutationObserver applies the edits again to elements that appear later or
// lose them. Everything is undone when an edit goes away: the element gets
// its own children back and added HTML is removed.

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

// Most elements one edit touches.
const MAX_MATCHES = 500;
const RERUN_DELAY = 60;

// ---- added HTML: cleaned, rebuilt in the page ----

// Kept as they are; anything else is unwrapped (its content kept), and DROP
// goes with its content.
const TAGS = new Set(
  (
    "a abbr article aside b blockquote br caption code dd del details div dl dt em figcaption figure footer " +
    "h1 h2 h3 h4 h5 h6 header hr i img ins kbd li mark nav ol p pre q s section small span strong sub " +
    "summary sup table tbody td tfoot th thead time tr u ul"
  ).split(" ")
);
const DROP = new Set(
  "script style template iframe frame frameset object embed applet form input button select textarea option link meta base noscript svg math video audio source track canvas portal dialog".split(
    " "
  )
);
const ATTRS = new Set(["class", "title", "style", "alt", "width", "height", "dir", "lang", "colspan", "rowspan", "open"]);
const URL_ATTRS = { a: "href", img: "src" };

function safeURL(tag, value) {
  const v = value.trim();
  if (/^https?:\/\//i.test(v) || (tag === "a" && /^(mailto:|#)/i.test(v))) {
    return v;
  }
  if (tag === "img" && /^data:image\/(png|gif|jpeg|webp|avif);/i.test(v)) {
    return v;
  }
  return null;
}

// A fragment of `doc` with only the allowed parts of `html`. The HTML is
// parsed in an inert document (nothing runs or loads there) and copied over
// node by node, so nothing the parser could produce reaches the page as is.
export function sanitize(doc, html) {
  const inert = doc.implementation.createHTMLDocument("");
  inert.body.innerHTML = html;
  const out = doc.createDocumentFragment();
  const copy = (from, to) => {
    for (const node of from.childNodes) {
      if (node.nodeType === 3) {
        to.append(doc.createTextNode(node.data));
        continue;
      }
      if (node.nodeType !== 1) {
        continue;
      }
      const tag = node.localName;
      if (DROP.has(tag) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") {
        continue;
      }
      if (!TAGS.has(tag)) {
        copy(node, to);
        continue;
      }
      const el = doc.createElement(tag);
      for (const { name, value } of node.attributes) {
        if (ATTRS.has(name)) {
          el.setAttribute(name, value);
        } else if (URL_ATTRS[tag] === name) {
          const url = safeURL(tag, value);
          if (url) {
            el.setAttribute(name, url);
          }
        }
      }
      if (tag === "a") {
        el.setAttribute("rel", "noopener noreferrer");
      }
      copy(node, el);
      to.append(el);
    }
  };
  copy(inert.body, out);
  return out;
}

// ---- applying ----

export class DomEdits {
  #win;
  #edits = []; // [{ key, sel, text, insert }]
  // key -> { texts: Map(el -> its original children), inserts: Map(el -> added nodes) }
  #done = new Map();
  #observer = null;
  #timer = null;

  constructor(win) {
    this.#win = win;
  }

  // The edits the page should have now; key identifies one across updates
  // (touch id + edit id + what it does, so a change re-applies it).
  set(edits) {
    const keys = new Set(edits.map(e => e.key));
    for (const key of [...this.#done.keys()]) {
      if (!keys.has(key)) {
        this.#revert(key);
      }
    }
    this.#edits = edits;
    this.#run();
    if (edits.length && !this.#observer) {
      this.#observer = new this.#win.MutationObserver(() => this.#soon());
      this.#observer.observe(this.#win.document, { childList: true, subtree: true, characterData: true });
    } else if (!edits.length) {
      this.#stop();
    }
  }

  destroy() {
    this.#stop();
  }

  #stop() {
    clearTimeout(this.#timer);
    this.#observer?.disconnect();
    this.#observer = null;
  }

  #soon() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#run(), RERUN_DELAY);
  }

  #run() {
    const doc = this.#win.document;
    if (!doc) {
      return;
    }
    for (const edit of this.#edits) {
      let els;
      try {
        els = [...doc.querySelectorAll(edit.sel)].slice(0, MAX_MATCHES);
      } catch {
        continue;
      }
      let done = this.#done.get(edit.key);
      if (!done) {
        done = { texts: new Map(), inserts: new Map() };
        this.#done.set(edit.key, done);
      }
      for (const el of els) {
        if (edit.text != null && el.textContent !== edit.text) {
          if (!done.texts.has(el)) {
            done.texts.set(el, [...el.childNodes]);
          }
          el.textContent = edit.text;
        }
        if (edit.insert) {
          const nodes = done.inserts.get(el);
          if (!nodes?.some(n => n.isConnected)) {
            const fragment = sanitize(doc, edit.insert.html);
            const added = [...fragment.childNodes];
            el[edit.insert.where](fragment);
            done.inserts.set(el, added);
          }
        }
      }
      // Forget elements the page dropped.
      for (const el of done.texts.keys()) {
        if (!el.isConnected) {
          done.texts.delete(el);
        }
      }
      for (const el of done.inserts.keys()) {
        if (!el.isConnected) {
          done.inserts.delete(el);
        }
      }
    }
    // Our own changes aren't news.
    this.#observer?.takeRecords();
  }

  #revert(key) {
    const done = this.#done.get(key);
    this.#done.delete(key);
    for (const [el, children] of done?.texts ?? []) {
      if (el.isConnected) {
        el.replaceChildren(...children);
      }
    }
    for (const nodes of done?.inserts.values() ?? []) {
      for (const n of nodes) {
        n.remove();
      }
    }
    this.#observer?.takeRecords();
  }
}
