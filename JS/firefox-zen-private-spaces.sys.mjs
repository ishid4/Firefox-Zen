// ==UserScript==
// @name           Firefox-Zen Private Spaces
// @description    Password-locked spaces that run in a private window and are saved encrypted
// ==/UserScript==

// Background module (loaded once by fx-autoconfig, shared by every window).
// The window side is in JS/firefox-zen-spaces.uc.js.
//
// Model
// - A private space is an entry in the space list with just its id and
//   private: true. Its name and icon are encrypted with the rest (`meta`);
//   while it's locked the window side shows a placeholder.
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
// - It keeps its own history (pages its tabs visited) and download list,
//   encrypted with it; Firefox's private ones are dropped when its window
//   closes. Downloaded files themselves stay on disk, unencrypted.
// - It can have its own download folder (meta.downloadDir, so encrypted too):
//   firefox-zen-download-folders sends its window's downloads there.
// - After AUTOLOCK_PREF minutes of no input (0 = off) every private space locks
//   and they're hidden.
// - Export writes its encrypted file (with its id) for import elsewhere.
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
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  FzDownloadTools: "chrome://userscripts/content/firefox-zen-download-tools.sys.mjs",
});

const VERSION = 1;
const ITERATIONS = 600000;
const SAVE_INTERVAL_MS = 5000;
const DIR_NAME = "firefox-zen-private";
const CHANGED_TOPIC = "firefox-zen-private-spaces-changed";
const PRIVATE_OA = { privateBrowsingId: 1 };
const HISTORY_TOPIC = "firefox-zen-private-history-changed";
const DOWNLOADS_TOPIC = "firefox-zen-private-downloads-changed";
const AUTOLOCK_PREF = "firefox-zen.private-spaces.autolock-minutes";
// Downloads keep going after the space's window closes or it locks (see
// keepPartialData). Off: they stop there, like Firefox's own private
// downloads, and Retry resumes them.
const BACKGROUND_DOWNLOADS_PREF = "firefox-zen.private-spaces.background-downloads";
const backgroundDownloads = () => Services.prefs.getBoolPref(BACKGROUND_DOWNLOADS_PREF, true);
const AUTOLOCK_DEFAULT = 1;
const HISTORY_MAX = 5000;
const EXPORT_FORMAT = "firefox-zen-private-space";

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

// window: SessionStore window state; meta: { name, icon, scheme }; history:
// [{ url, title, time }] oldest first; downloads: see downloadRecord().
const EMPTY_SNAPSHOT = { window: null, cookies: [], meta: null, history: [], downloads: [] };

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
  const snapshot = {
    window: state,
    cookies: win ? collectCookies() : entry.cookies,
    meta: entry.meta,
    history: entry.history,
    downloads: entry.downloads,
  };
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
  // Its verdicts leave memory with it.
  for (const d of entry.downloads ?? []) {
    vtSubjects.delete(d.key);
  }
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

// Favicons the Library may show: ones already in memory (private tabs keep
// theirs as data: URIs). Anything that would be fetched is dropped, so
// showing a private space's tabs never touches the network.
const localImage = src => (/^(data|chrome|moz-icon|resource):/.test(src ?? "") ? src : null);

// Tabs in the window-less snapshot, as the Library lists them.
function snapshotTabs(entry) {
  const tabs = entry.snapshot?.tabs ?? [];
  return tabs.map((tab, index) => {
    const current = tab.entries[(tab.index || tab.entries.length) - 1] ?? {};
    return {
      index,
      label: current.title || (/^about:(blank|newtab|home|privatebrowsing)?$/.test(current.url ?? "") ? "New Tab" : current.url),
      url: current.url || "",
      image: localImage(tab.image),
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
        image: localImage(tab.getAttribute("image")),
        selected: tab.selected,
        tab,
      }));
  },

  HISTORY_TOPIC,
  DOWNLOADS_TOPIC,

  // A new, empty private space protected by `password`.
  async create(id, password, meta = null) {
    await writeFile(id, await seal(id, await newKey(password), { ...EMPTY_SNAPSHOT, meta }));
  },

  // Its name, icon and color scheme ({ name, icon, scheme }) while unlocked, else null.
  meta: id => unlocked.get(id)?.meta ?? null,

  async setMeta(id, meta) {
    const entry = unlocked.get(id);
    if (!entry) {
      throw new Error("This private space is locked.");
    }
    entry.meta = { ...entry.meta, ...meta };
    notifyChanged();
    await saveLogged(id);
  },

  // ---- history ----

  // Pages its tabs visited, newest first.
  history: id => [...(unlocked.get(id)?.history ?? [])].reverse(),

  // From the space's window (see firefox-zen-spaces).
  recordVisit(win, url, title = "") {
    const [id, entry] = entryForWindow(win);
    if (!id || !/^(https?|file|ftp):/.test(url)) {
      return;
    }
    if (entry.restoring?.delete(url)) {
      return;
    }
    const last = entry.history.at(-1);
    // The same page again right away (reload, redirect back): refresh it.
    if (last?.url === url && Date.now() - last.time < 30000) {
      last.time = Date.now();
      last.title ||= title;
    } else {
      entry.history.push({ url, title, time: Date.now() });
      if (entry.history.length > HISTORY_MAX) {
        entry.history.splice(0, entry.history.length - HISTORY_MAX);
      }
    }
    Services.obs.notifyObservers(null, HISTORY_TOPIC, id);
  },

  recordTitle(win, url, title) {
    const [id, entry] = entryForWindow(win);
    const visit = id && entry.history.findLast(v => v.url === url);
    if (visit && title && visit.title !== title) {
      visit.title = title;
      Services.obs.notifyObservers(null, HISTORY_TOPIC, id);
    }
  },

  async removeHistory(id, url) {
    const entry = unlocked.get(id);
    if (entry) {
      entry.history = entry.history.filter(v => v.url !== url);
      Services.obs.notifyObservers(null, HISTORY_TOPIC, id);
      await saveLogged(id);
    }
  },

  // ---- downloads ----

  // Its downloads, newest first (see downloadRecord()).
  downloads: id => [...(unlocked.get(id)?.downloads ?? [])].sort((a, b) => b.startTime - a.startTime),

  // Firefox's Download for a record, while it still has it.
  liveDownload: key => liveDownloads.get(key) ?? null,

  // What the VirusTotal check (JS/firefox-zen-download-tools.sys.mjs) works
  // on for a finished download Firefox no longer has: a stand-in with its
  // file and link, showing its saved verdict. Null while locked or not done.
  vtSubject(id, key) {
    const record = unlocked.get(id)?.downloads.find(d => d.key === key);
    if (!record || record.state !== "done" || !record.path) {
      return null;
    }
    let subject = vtSubjects.get(key);
    if (!subject || subject.target.path !== record.path) {
      subject = { target: { path: record.path }, source: { url: record.url }, succeeded: true, stopped: true };
      vtSubjects.set(key, subject);
      downloadKeys.set(subject, { id, key });
    }
    if (record.vt?.hash && record.vt.verdict) {
      lazy.FzDownloadTools.seed(subject, { status: "done", hash: record.vt.hash, verdict: record.vt.verdict });
    }
    return subject;
  },

  // Starts a stopped download again from where it stopped (its kept partial
  // file, asking the server for the rest), like Firefox's own Retry.
  // Resolves false when that can't be done (no partial file, or the server
  // gave no resume id): then only downloading it again from its link works.
  async resumeDownload(id, key) {
    const entry = unlocked.get(id);
    const record = entry?.downloads.find(d => d.key === key);
    if (!record || liveDownloads.has(key) || record.state === "done") {
      return false;
    }
    if (!record.path || !record.partPath || !record.entityID || !(await IOUtils.exists(record.partPath))) {
      return false;
    }
    const source = { url: record.url, isPrivate: true };
    if (record.referrer) {
      try {
        const ReferrerInfo = Components.Constructor("@mozilla.org/referrer-info;1", "nsIReferrerInfo", "init");
        source.referrerInfo = new ReferrerInfo(
          Ci.nsIReferrerInfo.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          true,
          Services.io.newURI(record.referrer)
        );
      } catch (e) {
        // Not a URL anymore: go without.
      }
    }
    const download = await lazy.Downloads.createDownload({
      source,
      target: { path: record.path, partFilePath: record.partPath },
      saver: { type: "copy", entityID: record.entityID },
      tryToKeepPartialData: true,
      hasPartialData: true,
      totalBytes: record.totalBytes,
      startTime: new Date(record.startTime),
    });
    downloadKeys.set(download, { id, key });
    keepPartialData(download);
    const list = await lazy.Downloads.getList(lazy.Downloads.PRIVATE);
    await list.add(download);
    // Failures show on its row (Retry again).
    download.start().catch(() => {});
    return true;
  },

  async removeDownload(id, key) {
    const live = liveDownloads.get(key);
    if (live?.stopped) {
      liveDownloads.delete(key);
      lazy.Downloads.getList(lazy.Downloads.PRIVATE)
        .then(list => list.remove(live))
        .catch(() => {});
    }
    const entry = unlocked.get(id);
    if (entry) {
      entry.downloads = entry.downloads.filter(d => d.key !== key);
      Services.obs.notifyObservers(null, DOWNLOADS_TOPIC, id);
      await saveLogged(id);
    }
  },

  // Its own download folder's path while unlocked, or null (Firefox's folder).
  // Set with setMeta(id, { downloadDir }).
  downloadDir: id => unlocked.get(id)?.meta?.downloadDir || null,

  // Deletes the files its downloads saved; resolves with how many.
  async deleteDownloadedFiles(id) {
    let count = 0;
    for (const d of unlocked.get(id)?.downloads ?? []) {
      if (d.path && (await IOUtils.exists(d.path))) {
        await IOUtils.remove(d.path, { ignoreAbsent: true });
        count++;
      }
    }
    return count;
  },

  // ---- export / import ----

  // Writes its encrypted file (and id) to `path`. An unlocked space is saved first.
  async exportTo(id, path) {
    if (unlocked.has(id)) {
      await saveLogged(id, { flush: true });
      await writeQueues.get(id);
    }
    const file = await readFile(id);
    if (!file) {
      throw new Error("This private space's saved data is missing.");
    }
    await IOUtils.writeJSON(path, { format: EXPORT_FORMAT, id, file });
  },

  // Reads an export; resolves with its space id (the caller lists it).
  // Refuses an id that already has data here.
  async importFrom(path) {
    const data = await IOUtils.readJSON(path);
    if (data?.format !== EXPORT_FORMAT || !data.file?.data || typeof data.id !== "string") {
      throw new Error("This isn't an exported private space.");
    }
    filePath(data.id); // throws for a malformed id
    if (await readFile(data.id)) {
      throw new Error("This private space is already here.");
    }
    await writeFile(data.id, data.file);
    return data.id;
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
    watchDownloads();
    // Downloads that kept going while it was locked (see keepPartialData)
    // get their current state; others still marked running were stopped.
    let refreshed = false;
    for (const [i, d] of (snapshot.downloads ?? []).entries()) {
      const live = liveDownloads.get(d.key);
      if (live) {
        snapshot.downloads[i] = { ...downloadRecord(live, d.key), ...(d.vt ? { vt: d.vt } : {}) };
        refreshed = true;
      } else if (d.state === "downloading") {
        d.state = "interrupted";
      }
    }
    unlocked.set(id, {
      keyInfo,
      window: null,
      snapshot: snapshot.window ?? { tabs: [], selected: 0 },
      cookies: snapshot.cookies ?? [],
      meta: snapshot.meta ?? null,
      history: snapshot.history ?? [],
      downloads: snapshot.downloads ?? [],
      timer: null,
      lastJson: JSON.stringify(snapshot),
      closing: false,
    });
    if (refreshed) {
      // lastJson already has them: save explicitly.
      unlocked.get(id).lastJson = "";
      saveLogged(id);
    }
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
          // Their pages loading again isn't a new visit (see recordVisit()).
          entry.restoring = new Set(snapshotTabs(entry).map(t => t.url));
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
    // Keeps its name and icon.
    await writeFile(id, await seal(id, entry.keyInfo, { ...EMPTY_SNAPSHOT, meta: entry.meta }));
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

// ---- downloads ----

// Private downloads (Firefox drops its own list of them when the last private
// window closes) are recorded in the space whose window started them.
let downloadsWatched = false;
const downloadKeys = new WeakMap();
// Record key -> Firefox's Download, while Firefox still has it (until the
// private windows close), so the Library can pause, cancel or retry it.
const liveDownloads = new Map();

// The private space whose window a download came from.
function spaceOfDownload(download) {
  const topId = BrowsingContext.get(download.source.browsingContextId ?? 0)?.top?.id;
  if (!topId) {
    return null;
  }
  for (const [id, entry] of unlocked) {
    const win = liveWindow(entry);
    if (win?.gBrowser.browsers.some(b => b.browsingContext?.id === topId)) {
      return id;
    }
  }
  return null;
}

// { key, url, referrer, path, partPath, entityID, startTime, totalBytes,
//   currentBytes, state, vt? }
// vt: { hash, verdict } once VirusTotal knows the file (onVtChanged).
// referrer: the page it started from ("" when not known).
// partPath, entityID: its partial file and the server's resume id, so a
// stopped download can continue where it stopped (resumeDownload).
// state: "downloading" | "done" | "failed" | "canceled" | "interrupted"
// ("interrupted": it was still running when Firefox dropped it, e.g. its
// private window closed or the space locked).
function referrerOf(download) {
  try {
    return download.source.referrerInfo?.originalReferrer?.spec ?? "";
  } catch (e) {
    return "";
  }
}

function downloadRecord(download, key) {
  return {
    key,
    url: download.source.url,
    referrer: referrerOf(download),
    path: download.target?.path ?? "",
    partPath: download.target?.partFilePath ?? "",
    entityID: download.saver?.entityID ?? "",
    startTime: download.startTime?.getTime?.() ?? Date.now(),
    totalBytes: download.totalBytes || 0,
    currentBytes: download.currentBytes || 0,
    state: download.succeeded
      ? "done"
      : download.error
        ? "failed"
        : download.canceled
          ? "canceled"
          : "downloading",
  };
}

function updateDownload(download) {
  let tracked = downloadKeys.get(download);
  if (!tracked) {
    const id = spaceOfDownload(download);
    if (!id) {
      return;
    }
    tracked = { id, key: crypto.randomUUID() };
    downloadKeys.set(download, tracked);
    keepPartialData(download);
  }
  liveDownloads.set(tracked.key, download);
  if (backgroundDownloads() && abortedInBackground(download)) {
    restartInBackground(download);
  }
  const entry = unlocked.get(tracked.id);
  if (!entry) {
    return;
  }
  const record = downloadRecord(download, tracked.key);
  const index = entry.downloads.findIndex(d => d.key === tracked.key);
  // Its verdict, if checked (onVtChanged).
  if (index >= 0 && entry.downloads[index].vt) {
    record.vt = entry.downloads[index].vt;
  }
  if (index < 0) {
    entry.downloads.push(record);
  } else {
    entry.downloads[index] = record;
  }
  Services.obs.notifyObservers(null, DOWNLOADS_TOPIC, tracked.id);
  if (record.state !== "downloading") {
    saveLogged(tracked.id);
  }
}

// When the last private window closes (closed by hand, or the space locked
// after idle time), Firefox ends private browsing: its network cleanup aborts
// running private transfers, and it drops its private downloads, canceling
// them and deleting their partial files (finalize(true)). A private space's
// download that was running keeps going in the background instead: it's put
// back in the private list (so the Library still shows and controls it once
// the space is unlocked) and, when the transfer was aborted, started again
// from its partial file (the server is asked for the rest; one that can't
// resume sends it all again). With BACKGROUND_DOWNLOADS_PREF off it stops
// instead. Either way a stopped one keeps its partial file, so Retry can
// resume it. Removing it from the Library deletes the file.
// (While a private window is open, finalize(true) is a deliberate delete.)
function privateWindowOpen() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (!win.closed && lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return true;
    }
  }
  return false;
}

function keepPartialData(download) {
  // Firefox's own downloads keep it whenever they write a .part file.
  if (download.target?.partFilePath) {
    download.tryToKeepPartialData = true;
  }
  const finalize = download.finalize;
  download.finalize = function (removePartialData) {
    if (privateWindowOpen()) {
      return finalize.call(this, removePartialData);
    }
    if (backgroundDownloads() && (!this.stopped || abortedInBackground(this))) {
      // Firefox removed it from the list just before this. Back in it,
      // updateDownload restarts it if its transfer was aborted.
      lazy.Downloads.getList(lazy.Downloads.PRIVATE)
        .then(list => list.add(this))
        .catch(e => console.error("firefox-zen-private-spaces: keeping download", e));
      return Promise.resolve();
    }
    return finalize.call(this, false);
  };
}

// A private space's download whose transfer Firefox aborted because private
// browsing ended (no private window left). Not a cancel by you: that sets
// `canceled`, without an error.
function abortedInBackground(download) {
  return (
    download.stopped &&
    !download.canceled &&
    !download.succeeded &&
    download.error?.result === Cr.NS_ERROR_ABORT &&
    !privateWindowOpen()
  );
}

// Starts it again (bounded: the space's data clearing on lock can abort the
// restarted transfer once more).
const MAX_BACKGROUND_RESTARTS = 5;
function restartInBackground(download) {
  const restarts = backgroundRestarts.get(download) ?? 0;
  if (restarts >= MAX_BACKGROUND_RESTARTS) {
    return;
  }
  backgroundRestarts.set(download, restarts + 1);
  download.start().catch(() => {});
}
const backgroundRestarts = new WeakMap();

// ---- VirusTotal verdicts ----
// A private space's download keeps its VirusTotal verdict in its record, so
// in the space's encrypted data only; only the file's hash was asked about.
// Record key -> stand-in (see vtSubject), while its space is unlocked.
const vtSubjects = new Map();

function onVtChanged(subject) {
  const tracked = downloadKeys.get(subject);
  const state = lazy.FzDownloadTools.vtState(subject);
  const entry = tracked && unlocked.get(tracked.id);
  if (!entry || state?.status !== "done") {
    return;
  }
  const record = entry.downloads.find(d => d.key === tracked.key);
  if (
    !record ||
    (record.vt?.hash === state.hash && JSON.stringify(record.vt.verdict) === JSON.stringify(state.verdict))
  ) {
    return;
  }
  record.vt = { hash: state.hash, verdict: state.verdict };
  Services.obs.notifyObservers(null, DOWNLOADS_TOPIC, tracked.id);
  saveLogged(tracked.id);
}

// Records still "downloading" with no download behind them anymore.
function markInterrupted(entry) {
  for (const d of entry?.downloads ?? []) {
    if (d.state === "downloading" && !liveDownloads.has(d.key)) {
      d.state = "interrupted";
    }
  }
}

function watchDownloads() {
  if (downloadsWatched) {
    return;
  }
  downloadsWatched = true;
  try {
    lazy.FzDownloadTools.addListener(onVtChanged);
  } catch (e) {
    console.error("firefox-zen-private-spaces: VirusTotal", e);
  }
  lazy.Downloads.getList(lazy.Downloads.PRIVATE)
    .then(list =>
      list.addView({
        onDownloadAdded: updateDownload,
        onDownloadChanged: updateDownload,
        onDownloadRemoved: download => {
          const tracked = downloadKeys.get(download);
          if (tracked && liveDownloads.get(tracked.key) === download) {
            liveDownloads.delete(tracked.key);
            markInterrupted(unlocked.get(tracked.id));
            Services.obs.notifyObservers(null, DOWNLOADS_TOPIC, tracked.id);
          }
        },
      })
    )
    .catch(e => console.error("firefox-zen-private-spaces: downloads", e));
}

// ---- auto-lock ----

// Hides (and so locks) every private space after AUTOLOCK_PREF minutes
// without input (anywhere on the computer, as Firefox's idle service counts it).
const idleService = Cc["@mozilla.org/widget/useridleservice;1"].getService(Ci.nsIUserIdleService);
let idleSeconds = 0;
const idleObserver = {
  observe(_subject, topic) {
    if (topic === "idle" && (unlocked.size || shown)) {
      FzPrivateSpaces.setShown(false).catch(e => console.error("firefox-zen-private-spaces: auto-lock", e));
    }
  },
};

function setUpAutoLock() {
  if (idleSeconds) {
    idleService.removeIdleObserver(idleObserver, idleSeconds);
  }
  const minutes = Services.prefs.getIntPref(AUTOLOCK_PREF, AUTOLOCK_DEFAULT);
  idleSeconds = Math.max(0, minutes) * 60;
  if (idleSeconds) {
    idleService.addIdleObserver(idleObserver, idleSeconds);
  }
}

setUpAutoLock();
Services.prefs.addObserver(AUTOLOCK_PREF, setUpAutoLock);

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
