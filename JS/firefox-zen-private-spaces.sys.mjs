// ==UserScript==
// @name           Firefox-Zen Private Spaces
// @description    Password-locked spaces that run in a private window and are saved encrypted
// ==/UserScript==

// Background module (loaded once by fx-autoconfig, shared by every window).
// The window side is in JS/firefox-zen-spaces.uc.js.
//
// Model
// - A private space is an entry in the space list with private: true. Its
//   name and icon are in prefs like any space; everything else is here.
// - Unlocking decrypts it into memory only. Its tabs open in its own private
//   window when asked for, so Firefox writes none of it to places.sqlite,
//   cookies.sqlite, the cache or sessionstore. Tabs can be moved in (their
//   SessionStore state is added) and out while it's unlocked.
// - Its tabs (with back/forward history) and private cookies are saved in
//   <profile>/firefox-zen-private/<id>.json, encrypted with AES-GCM using a key
//   derived from the password (PBKDF2-SHA256). The space id is bound in as
//   additional data, so a file can't be swapped onto another space. The file
//   is rewritten whenever the space changes, when its window closes and at
//   quit, so it survives restarts and crashes; the browser always starts
//   with every private space locked.
// - Any number can be unlocked (tabs move between them), but only one has its
//   window open at a time: all private windows share one cookie jar, so
//   opening another's window first saves and closes this one's (it stays
//   unlocked) and clears the private data in memory before restoring the
//   other's cookies.
// - Private spaces are hidden from the footer and the Library at every start
//   until shown (Library toggle, + menu, Ctrl+Alt+P); hiding locks them all.
// - Closing the space's window keeps it unlocked (saved, window-less); Lock
//   or quitting forgets the key. "Clear and Close" empties it for good;
//   deleting the space deletes its file.

import { setInterval, clearInterval } from "resource://gre/modules/Timer.sys.mjs";
import { AsyncShutdown } from "resource://gre/modules/AsyncShutdown.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  TabStateFlusher: "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
});

const VERSION = 1;
const ITERATIONS = 600000;
const SAVE_INTERVAL_MS = 5000;
const DIR_NAME = "firefox-zen-private";
const CHANGED_TOPIC = "firefox-zen-private-spaces-changed";
const PRIVATE_OA = { privateBrowsingId: 1 };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong password");
    this.name = "WrongPasswordError";
  }
}

// ---- crypto ----

const b64 = bytes => ChromeUtils.base64URLEncode(bytes, { pad: false });
const unb64 = text => ChromeUtils.base64URLDecode(text, { padding: "ignore" });

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// A fresh salt and key for a password; a new password gets a new salt.
async function newKey(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveKey(password, salt, ITERATIONS), salt, iterations: ITERATIONS };
}

async function seal(id, keyInfo, snapshot) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(id) },
    keyInfo.key,
    encoder.encode(JSON.stringify(snapshot))
  );
  return {
    version: VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: keyInfo.iterations, salt: b64(keyInfo.salt) },
    cipher: { name: "AES-GCM", iv: b64(iv) },
    data: b64(new Uint8Array(data)),
  };
}

async function open(id, file, password) {
  const salt = unb64(file.kdf.salt);
  const keyInfo = { key: await deriveKey(password, salt, file.kdf.iterations), salt, iterations: file.kdf.iterations };
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(file.cipher.iv), additionalData: encoder.encode(id) },
      keyInfo.key,
      unb64(file.data)
    );
  } catch (e) {
    // GCM's tag check fails for a wrong key (or a tampered file).
    throw new WrongPasswordError();
  }
  return { keyInfo, snapshot: JSON.parse(decoder.decode(plain)) };
}

// ---- files ----

const dirPath = () => PathUtils.join(PathUtils.profileDir, DIR_NAME);
const filePath = id => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(`bad private space id: ${id}`);
  }
  return PathUtils.join(dirPath(), `${id}.json`);
};

async function readFile(id) {
  try {
    return await IOUtils.readJSON(filePath(id));
  } catch (e) {
    if (DOMException.isInstance(e) && e.name === "NotFoundError") {
      return null;
    }
    throw e;
  }
}

// Writes for one space go one after another, so an older snapshot never
// lands after a newer one.
const writeQueues = new Map();

function writeFile(id, sealed) {
  const previous = writeQueues.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await IOUtils.makeDirectory(dirPath(), { ignoreExisting: true });
      const path = filePath(id);
      await IOUtils.writeJSON(path, sealed, { tmpPath: `${path}.tmp` });
    });
  writeQueues.set(id, next);
  next.finally(() => {
    if (writeQueues.get(id) === next) {
      writeQueues.delete(id);
    }
  });
  return next;
}

// ---- snapshots ----

const EMPTY_SNAPSHOT = { window: null, cookies: [] };

function collectCookies() {
  return Services.cookies.getCookiesWithOriginAttributes(JSON.stringify(PRIVATE_OA)).map(c => ({
    host: c.host,
    path: c.path,
    name: c.name,
    value: c.value,
    isSecure: c.isSecure,
    isHttpOnly: c.isHttpOnly,
    isSession: c.isSession,
    expiry: c.expiry,
    originAttributes: c.originAttributes,
    sameSite: c.sameSite,
    schemeMap: c.schemeMap,
    isPartitioned: !!c.isPartitioned,
  }));
}

function restoreCookies(cookies) {
  const now = Date.now();
  for (const c of cookies ?? []) {
    // nsICookie.expiry is in ms (Firefox 158).
    if (!c.isSession && c.expiry <= now) {
      continue;
    }
    try {
      Services.cookies.add(
        c.host,
        c.path,
        c.name,
        c.value,
        c.isSecure,
        c.isHttpOnly,
        c.isSession,
        c.expiry,
        { ...c.originAttributes, privateBrowsingId: 1 },
        c.sameSite,
        c.schemeMap,
        c.isPartitioned
      );
    } catch (e) {
      console.error("firefox-zen-private-spaces: cookie not restored", c.host, e);
    }
  }
}

// Everything private browsing keeps in memory: cookies, storage, cache.
function clearPrivateData() {
  return new Promise(resolve => {
    try {
      Services.clearData.deleteDataFromOriginAttributesPattern(PRIVATE_OA, resolve);
    } catch (e) {
      console.error("firefox-zen-private-spaces: clearing private data failed", e);
      resolve();
    }
  });
}

// `fillGaps`: tabs SessionStore hasn't collected yet (opened a moment ago)
// get their current page as their only history entry, for when there's no
// time to flush (the window is closing).
function windowSnapshot(win, { fillGaps = false } = {}) {
  let state;
  try {
    state = lazy.SessionStore.getWindowState(win)?.windows?.[0] ?? null;
  } catch (e) {
    // Not tracked (yet or anymore).
    return null;
  }
  const tabs = win.gBrowser?.tabs;
  if (fillGaps && state && tabs?.length === state.tabs.length) {
    state.tabs.forEach((tabState, i) => {
      const browser = tabs[i].linkedBrowser;
      const url = browser?.currentURI?.spec;
      const blank = !tabState.entries.length || (tabState.entries.length === 1 && tabState.entries[0].url === "about:blank");
      if (blank && url && url !== "about:blank") {
        tabState.entries = [{ url, title: browser.contentTitle || url }];
        tabState.index = 1;
      }
    });
  }
  return state;
}

// ---- unlocked spaces ----

// id -> { keyInfo, window, snapshot, cookies, timer, lastJson, closing }
// While its window is open the window is the truth; without one (unlocked
// but not shown, or after its window closed) `snapshot` (a SessionStore
// window state) and `cookies` are.
const unlocked = new Map();

function notifyChanged() {
  Services.obs.notifyObservers(null, CHANGED_TOPIC);
}

function entryForWindow(win) {
  for (const [id, entry] of unlocked) {
    if (entry.window === win) {
      return [id, entry];
    }
  }
  return [null, null];
}

const liveWindow = entry => (entry.window && !entry.window.closed ? entry.window : null);

// Encrypts and writes the space's state if it changed since the last write.
async function save(id, { flush = false, fillGaps = false } = {}) {
  const entry = unlocked.get(id);
  if (!entry) {
    return;
  }
  let win = liveWindow(entry);
  if (win && flush) {
    try {
      await lazy.TabStateFlusher.flushWindow(win);
    } catch (e) {
      // Window went away mid-flush; save what we have.
    }
    win = liveWindow(entry);
  }
  const state = win ? windowSnapshot(win, { fillGaps }) : entry.snapshot;
  if (!state) {
    return;
  }
  const snapshot = { window: state, cookies: win ? collectCookies() : entry.cookies };
  const json = JSON.stringify(snapshot);
  if (json === entry.lastJson) {
    return;
  }
  entry.lastJson = json;
  await writeFile(id, await seal(id, entry.keyInfo, snapshot));
}

function saveLogged(id, options) {
  return save(id, options).catch(e => console.error("firefox-zen-private-spaces: save failed", e));
}

function stopTracking(id) {
  const entry = unlocked.get(id);
  if (!entry) {
    return null;
  }
  clearInterval(entry.timer);
  unlocked.delete(id);
  return entry;
}

// Closed by the user (or its last tab closed): the space stays unlocked
// without a window. The window is still tracked here, so read its state now.
function onWindowClosing(event) {
  const [id, entry] = entryForWindow(event.currentTarget);
  if (!id || entry.closing) {
    return;
  }
  entry.snapshot = windowSnapshot(entry.window, { fillGaps: true }) ?? entry.snapshot;
  entry.cookies = collectCookies();
  entry.window = null;
  clearInterval(entry.timer);
  saveLogged(id)
    .then(clearPrivateData)
    .then(notifyChanged);
}

// Saves and closes an unlocked space's window; it stays unlocked, window-less.
async function hideWindow(id, entry) {
  const win = liveWindow(entry);
  if (!win) {
    return;
  }
  try {
    await lazy.TabStateFlusher.flushWindow(win);
  } catch (e) {
    // Save what SessionStore has.
  }
  entry.snapshot = windowSnapshot(win, { fillGaps: true }) ?? entry.snapshot;
  entry.cookies = collectCookies();
  clearInterval(entry.timer);
  await closeWindow(entry);
  entry.closing = false;
  await saveLogged(id);
}

async function closeWindow(entry) {
  const win = liveWindow(entry);
  entry.closing = true;
  if (win) {
    const closed = new Promise(resolve => win.addEventListener("unload", resolve, { once: true }));
    win.close();
    await closed;
  }
  entry.window = null;
}

// Tabs in the window-less snapshot, as the Library lists them.
function snapshotTabs(entry) {
  const tabs = entry.snapshot?.tabs ?? [];
  return tabs.map((tab, index) => {
    const current = tab.entries[(tab.index || tab.entries.length) - 1] ?? {};
    return {
      index,
      label: current.title || (/^about:(blank|newtab|home|privatebrowsing)?$/.test(current.url ?? "") ? "New Tab" : current.url),
      url: current.url || "",
      image: tab.image || null,
      selected: index === (entry.snapshot.selected || 1) - 1,
      tab: null,
    };
  });
}

// Whether private spaces show in the footer and the Library. Not saved:
// every start begins hidden.
let shown = false;

// ---- API ----

export const FzPrivateSpaces = {
  CHANGED_TOPIC,
  WrongPasswordError,

  isUnlocked: id => unlocked.has(id),

  isShown: () => shown,
  // Hiding also locks every private space.
  async setShown(value) {
    shown = !!value;
    if (!shown) {
      for (const id of [...unlocked.keys()]) {
        await this.lock(id);
      }
    }
    notifyChanged();
  },
  windowOf: id => {
    const entry = unlocked.get(id);
    return entry ? liveWindow(entry) : null;
  },
  // The private space a window belongs to, or null.
  spaceOfWindow: win => entryForWindow(win)[0],

  // The space's tabs while unlocked: { index, label, url, image, selected,
  // tab (the <tab> while its window is open, else null) }.
  tabs(id) {
    const entry = unlocked.get(id);
    if (!entry) {
      return [];
    }
    const win = liveWindow(entry);
    if (!win) {
      return snapshotTabs(entry);
    }
    return win.gBrowser.tabs
      .filter(t => !t.closing)
      .map((tab, index) => ({
        index,
        label: tab.label,
        url: tab.linkedBrowser?.currentURI?.spec ?? "",
        image: tab.getAttribute("image") || null,
        selected: tab.selected,
        tab,
      }));
  },

  // A new, empty private space protected by `password`.
  async create(id, password) {
    await writeFile(id, await seal(id, await newKey(password), EMPTY_SNAPSHOT));
  },

  // Checks the password and keeps the space decrypted in memory, without a
  // window. Throws WrongPasswordError.
  async unlock(id, password) {
    if (unlocked.has(id)) {
      return;
    }
    const file = await readFile(id);
    if (!file) {
      throw new Error("This private space's saved data is missing.");
    }
    const { keyInfo, snapshot } = await open(id, file, password);
    unlocked.set(id, {
      keyInfo,
      window: null,
      snapshot: snapshot.window ?? { tabs: [], selected: 0 },
      cookies: snapshot.cookies ?? [],
      timer: null,
      lastJson: JSON.stringify(snapshot),
      closing: false,
    });
    notifyChanged();
  },

  // Opens (or focuses) an unlocked space's private window, optionally
  // selecting the tab at `select`; another private space's open window is
  // saved and closed first. Resolves with the window.
  async showWindow(id, { select = null } = {}) {
    const entry = unlocked.get(id);
    if (!entry) {
      throw new Error("This private space is locked.");
    }
    let win = liveWindow(entry);
    if (!win) {
      if (entry.opening) {
        return entry.opening;
      }
      entry.opening = (async () => {
        for (const [otherId, other] of unlocked) {
          if (otherId !== id) {
            await hideWindow(otherId, other);
          }
        }
        await clearPrivateData();
        restoreCookies(entry.cookies);
        entry.closing = false;
        // Not through a window's OpenBrowserWindow: the caller's window may be
        // the one just closed above.
        win = lazy.BrowserWindowTracker.openWindow({ private: true });
        // Registered before it loads, so the window's spaces script sees it's
        // this space's window as soon as it starts.
        entry.window = win;
        await new Promise(resolve => win.addEventListener("load", resolve, { once: true }));
        await win.delayedStartupPromise;
        await lazy.SessionStore.promiseInitialized;
        win.addEventListener("SSWindowClosing", onWindowClosing);
        if (entry.snapshot?.tabs?.length) {
          const state = { ...entry.snapshot };
          if (select != null) {
            state.selected = select + 1;
          }
          lazy.SessionStore.setWindowState(win, { windows: [state] }, true);
        }
        entry.timer = setInterval(() => saveLogged(id, { flush: true }), SAVE_INTERVAL_MS);
        notifyChanged();
        return win;
      })().finally(() => (entry.opening = null));
      return entry.opening;
    }
    const tab = select != null ? win.gBrowser.tabs[select] : null;
    if (tab) {
      win.gBrowser.selectedTab = tab;
    }
    win.focus();
    return win;
  },

  // Adds tabs (SessionStore tab states) to an unlocked space.
  async addTabs(id, states) {
    const entry = unlocked.get(id);
    if (!entry) {
      throw new Error("This private space is locked.");
    }
    const win = liveWindow(entry);
    if (win) {
      for (const state of states) {
        const tab = win.gBrowser.addTrustedTab(null, { inBackground: true, skipAnimation: true, skipLoad: true });
        lazy.SessionStore.setTabState(tab, state);
      }
    } else {
      entry.snapshot.tabs.push(...states);
      entry.snapshot.selected ||= 1;
      notifyChanged();
    }
    await saveLogged(id, { flush: !!win });
  },

  // Removes the tabs at `indexes` from an unlocked space and returns their
  // SessionStore states, in order.
  async takeTabs(id, indexes) {
    const entry = unlocked.get(id);
    if (!entry) {
      throw new Error("This private space is locked.");
    }
    const sorted = [...new Set(indexes)].sort((a, b) => a - b);
    const win = liveWindow(entry);
    let states;
    if (win) {
      const tabs = sorted.map(i => win.gBrowser.tabs[i]).filter(t => t && !t.closing);
      states = [];
      for (const tab of tabs) {
        try {
          await lazy.TabStateFlusher.flush(tab.linkedBrowser);
        } catch (e) {
          // Use what SessionStore has.
        }
        states.push(lazy.SessionStore.getTabState(tab));
      }
      // Keep the window: closing its last tab would close it.
      if (tabs.length >= win.gBrowser.tabs.length) {
        win.gBrowser.addTrustedTab(win.BROWSER_NEW_TAB_URL || "about:privatebrowsing");
      }
      for (const tab of tabs) {
        win.gBrowser.removeTab(tab, { skipSessionStore: true, skipPermitUnload: true, animate: false });
      }
    } else {
      const tabs = entry.snapshot.tabs;
      states = sorted.map(i => tabs[i]).filter(Boolean);
      entry.snapshot.tabs = tabs.filter((_, i) => !sorted.includes(i));
      entry.snapshot.selected = Math.min(entry.snapshot.selected || 1, entry.snapshot.tabs.length);
      notifyChanged();
    }
    await saveLogged(id, { flush: !!win });
    return states.map(s => (typeof s === "string" ? JSON.parse(s) : structuredClone(s)));
  },

  // Saves it, closes its window and forgets the key; private data in memory
  // is cleared.
  async lock(id) {
    const entry = unlocked.get(id);
    if (!entry) {
      return;
    }
    const hadWindow = !!liveWindow(entry);
    entry.closing = true;
    await saveLogged(id, { flush: true });
    stopTracking(id);
    await closeWindow(entry);
    await writeQueues.get(id);
    if (hadWindow) {
      await clearPrivateData();
    }
    notifyChanged();
  },

  // Forgets everything in the space (tabs, history, cookies) and locks it.
  // The space and its password stay. Only while unlocked.
  async clear(id) {
    const entry = stopTracking(id);
    if (!entry) {
      return;
    }
    await closeWindow(entry);
    await writeFile(id, await seal(id, entry.keyInfo, EMPTY_SNAPSHOT));
    await clearPrivateData();
    notifyChanged();
  },

  // Deletes the space's data for good (the caller removes it from the list).
  async destroy(id) {
    const entry = stopTracking(id);
    if (entry) {
      await closeWindow(entry);
      await clearPrivateData();
    }
    await writeQueues.get(id)?.catch(() => {});
    await IOUtils.remove(filePath(id), { ignoreAbsent: true });
    await IOUtils.remove(`${filePath(id)}.tmp`, { ignoreAbsent: true });
    notifyChanged();
  },

  // Re-encrypts the space with a new password. While locked the current
  // password is needed (throws WrongPasswordError).
  async changePassword(id, currentPassword, newPassword) {
    const keyInfo = await newKey(newPassword);
    const entry = unlocked.get(id);
    if (entry) {
      await saveLogged(id, { flush: true });
      entry.keyInfo = keyInfo;
      entry.lastJson = null;
      await save(id);
      return;
    }
    const file = await readFile(id);
    if (!file) {
      throw new Error("This private space's saved data is missing.");
    }
    const { snapshot } = await open(id, file, currentPassword);
    await writeFile(id, await seal(id, keyInfo, snapshot));
  },
};

// ---- quit ----

// At quit the windows are still there: save them all, and keep the profile
// open until the writes are done.
let quitSaves = null;

function saveAllForQuit() {
  quitSaves ??= Promise.all(
    [...unlocked.keys()].map(id => {
      const entry = unlocked.get(id);
      entry.closing = true;
      clearInterval(entry.timer);
      return saveLogged(id, { fillGaps: true });
    })
  );
  return quitSaves;
}

Services.obs.addObserver(saveAllForQuit, "quit-application-granted");
AsyncShutdown.profileBeforeChange.addBlocker("Firefox-Zen private spaces: save", () =>
  Promise.all([saveAllForQuit(), ...writeQueues.values()]).catch(() => {})
);
