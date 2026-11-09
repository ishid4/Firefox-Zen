// Firefox's side of the FzTouch actor (see JS/firefox-zen-touches.sys.mjs).
// Passes the picker's messages ("picked", "zapped", "pickEnd") to the
// browser window the page is in (JS/firefox-zen-touches.uc.js). They come
// from a web content process, so the window treats them as untrusted: only
// selectors and short text, checked again there.

export class FzTouchParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (!["picked", "zapped", "pickEnd"].includes(name)) {
      return null;
    }
    const browser = this.browsingContext.top.embedderElement;
    // (browser.ownerGlobal is undefined from this module.)
    this.browsingContext.top.topChromeWindow?.FzTouchesUI?.onPageMessage(browser, name, data);
    return null;
  }
}
