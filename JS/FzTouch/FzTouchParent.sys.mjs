// Firefox's side of the FzTouch actor (see JS/firefox-zen-touches.sys.mjs).
// Passes the page's messages to the browser window the page is in
// (JS/firefox-zen-touches.uc.js). They come from a web content process, so
// they're untrusted: the window checks selectors and decodes and cleans a
// shared touch before anything uses it.
// - "picked", "zapped", "pickEnd": the picker.
// - "isStorePage": whether this is the Firefox-Zen store (its touch page).
// - "try" { data }: Try it on the store's touch page; ignored elsewhere.

import { FzStore } from "chrome://userscripts/content/firefox-zen-store.sys.mjs";

export class FzTouchParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    const isStore = !!FzStore.storeRoot(this.manager.documentURI);
    if (name === "isStorePage") {
      return isStore;
    }
    if (!["picked", "zapped", "pickEnd", "try"].includes(name) || (name === "try" && !isStore)) {
      return null;
    }
    const browser = this.browsingContext.top.embedderElement;
    // (browser.ownerGlobal is undefined from this module.)
    this.browsingContext.top.topChromeWindow?.FzTouchesUI?.onPageMessage(browser, name, data);
    return null;
  }
}
