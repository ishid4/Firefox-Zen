// Firefox's side of the FzStore actor (see JS/firefox-zen-store.sys.mjs).
// Nothing the page sends is trusted beyond a mod id: the download comes from
// the store's own index.json and must be in the store's release, and the
// user confirms in a tab prompt before anything is installed.

import { FzMods } from "chrome://userscripts/content/firefox-zen-mods.sys.mjs";
import { FzStore } from "chrome://userscripts/content/firefox-zen-store.sys.mjs";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Ids being installed, across every store tab.
const busy = new Set();

const installed = () => Object.fromEntries(FzMods.list().map(m => [m.id, m.version]));

async function storeEntry(root, id) {
  const response = await fetch(new URL("index.json", root), { cache: "no-cache", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`couldn't load the store's mod list (${response.status})`);
  }
  const entry = (await response.json())?.mods?.find(m => m?.id === id);
  if (!entry) {
    throw new Error(`${id} isn't in the store`);
  }
  if (typeof entry.download !== "string" || !entry.download.startsWith(FzStore.RELEASE_URL)) {
    throw new Error(`${id} doesn't download from the store`);
  }
  return entry;
}

export class FzStoreParent extends JSWindowActorParent {
  async receiveMessage({ name, data }) {
    const root = FzStore.storeRoot(this.manager.documentURI);
    if (!root) {
      throw new Error("not the store page");
    }
    await FzMods.ready;
    if (name === "state") {
      return installed();
    }
    if (name === "install") {
      await this.#install(root, String(data?.id ?? ""));
      return installed();
    }
    return null;
  }

  // The browser window this tab is in.
  get #window() {
    // (embedderElement.ownerGlobal is undefined from this module.)
    return this.browsingContext.top.topChromeWindow ?? null;
  }

  #openMods() {
    const win = this.#window;
    win?.FirefoxZenLibrary?.open("mods");
    win?.focus();
  }

  async #install(root, id) {
    if (!ID_RE.test(id) || busy.has(id)) {
      return;
    }
    busy.add(id);
    try {
      // Installed already: updates are reviewed in the Mods tab, file by file.
      if (FzMods.get(id)) {
        await FzMods.checkUpdates(id);
        this.#openMods();
        return;
      }
      const entry = await storeEntry(root, id);
      const pending = await FzMods.prepareDownload(entry.download);
      if (pending.id !== id) {
        await pending.cancel();
        throw new Error(`the download is ${pending.id}, not ${id}`);
      }
      if (!(await this.#confirm(pending))) {
        await pending.cancel();
        return;
      }
      await pending.commit();
      // A mod with a script starts off: turning it on asks once more.
      if (pending.script) {
        this.#openMods();
      }
    } finally {
      busy.delete(id);
    }
  }

  async #confirm(pending) {
    const p = Services.prompt;
    const flags =
      p.BUTTON_POS_0 * p.BUTTON_TITLE_IS_STRING + p.BUTTON_POS_1 * p.BUTTON_TITLE_CANCEL + p.BUTTON_POS_1_DEFAULT;
    const message =
      `${pending.name}${pending.version ? ` ${pending.version}` : ""}, from the Firefox-Zen Mods store.\n\n` +
      (pending.script
        ? "This mod runs its own code with full access to Firefox. It's installed turned off: " +
          "the Mods tab opens so you can turn it on if you trust it."
        : "This mod only has styles. It turns on right away.");
    const result = await p.asyncConfirmEx(
      this.browsingContext.top,
      p.MODAL_TYPE_TAB,
      `Install “${pending.name}”?`,
      message,
      flags,
      "Install",
      null,
      null,
      null,
      false
    );
    return result.getProperty("buttonNumClicked") === 0;
  }
}
