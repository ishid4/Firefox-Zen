// The store page's side of the FzStore actor (see JS/firefox-zen-store.sys.mjs).
// Runs in the page's content process: it only passes the page's clicks on to
// FzStoreParent and shows the page what's installed.

export class FzStoreChild extends JSWindowActorChild {
  #state = { installed: {}, busy: null, error: null };

  async handleEvent(event) {
    if (event.type === "DOMContentLoaded") {
      this.#show({ installed: await this.sendQuery("state") });
      return;
    }
    // fz-store-install: only from a click, one at a time.
    const id = typeof event.detail === "string" ? event.detail : null;
    if (!id || this.#state.busy || !this.document.hasValidTransientUserGestureActivation) {
      return;
    }
    this.#show({ busy: id, error: null });
    try {
      this.#show({ installed: await this.sendQuery("install", { id }), busy: null });
    } catch (e) {
      this.#show({ busy: null, error: { id, message: e.message || String(e) } });
    }
  }

  #show(change) {
    Object.assign(this.#state, change);
    // The page may have gone away while a query was out.
    try {
      this.document.documentElement.setAttribute("data-fz-mods", JSON.stringify(this.#state));
      this.document.dispatchEvent(new this.contentWindow.Event("fz-store-state"));
    } catch {}
  }
}
