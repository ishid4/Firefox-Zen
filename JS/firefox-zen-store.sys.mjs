// ==UserScript==
// @name           Firefox-Zen Store
// @description    Install on the Firefox-Zen Mods store page: installs a mod in one click
// ==/UserScript==

// Background module: registers the FzStore window actor (JS/FzStore/) for the
// store page, and nothing else. The actor lives in a folder of its own so
// fx-autoconfig doesn't load its two modules as background modules too.
//
// How the page and Firefox talk (see FzStoreChild):
// - Firefox -> page: <html data-fz-mods="{installed, busy, error}"> and a
//   "fz-store-state" event when it changes. installed maps each installed
//   mod's id to its version.
// - page -> Firefox: a "fz-store-install" CustomEvent whose detail is a mod
//   id, from a click. Firefox looks the mod up in the store's own index.json,
//   downloads it from the store's release, and asks in a tab prompt before
//   installing. A mod that's already installed opens in the Library's Mods
//   tab instead, where its update is reviewed as usual.
//
// For trying the store locally (`npx serve _site`), set
// firefox-zen.mods.store-dev to true and restart: http://localhost and
// 127.0.0.1 (any port) then count as the store too.

const STORE_URL = "https://ishid4.github.io/Firefox-Zen-Mods/";
// Every mod's downloadURL starts with this (scripts/lib.mjs in the store).
const RELEASE_URL = "https://github.com/ishid4/Firefox-Zen-Mods/releases/download/mods/";
const DEV_PREF = "firefox-zen.mods.store-dev";
const DEV_HOSTS = ["localhost", "127.0.0.1"];

const dev = Services.prefs.getBoolPref(DEV_PREF, false);
const matches = [`${STORE_URL}*`, ...(dev ? DEV_HOSTS.map(host => `http://${host}/*`) : [])];

// The store's root URL for a page of it (an nsIURI), or null for any other page.
function storeRoot(uri) {
  const url = uri?.spec ?? "";
  if (url.startsWith(STORE_URL)) {
    return STORE_URL;
  }
  if (dev && uri.scheme === "http" && DEV_HOSTS.includes(uri.host)) {
    return `${uri.prePath}/`;
  }
  return null;
}

try {
  ChromeUtils.registerWindowActor("FzStore", {
    parent: { esModuleURI: "chrome://userscripts/content/FzStore/FzStoreParent.sys.mjs" },
    child: {
      esModuleURI: "chrome://userscripts/content/FzStore/FzStoreChild.sys.mjs",
      events: {
        DOMContentLoaded: {},
        "fz-store-install": { wantUntrusted: true },
      },
    },
    matches,
  });
} catch (e) {
  console.error("Firefox-Zen store: couldn't register the store actor", e);
}

export const FzStore = { STORE_URL, RELEASE_URL, storeRoot };
