// ==UserScript==
// @name           Firefox-Zen Notifications
// @description    What the Library's Notifications board shows: updates, VirusTotal detections, ...
// ==/UserScript==

// Background module (shared by every window). Other modules add
// notifications here; JS/firefox-zen-notifications.uc.js shows them: the
// Library's Notifications board, a count on the footer's Library button and
// a bubble above it for the newest unread one.
//
// A notification:
//   { id, kind, level, title, body, time, read, action, private }
// - id: stable, so the same event isn't added twice ("update:1.9.0",
//   "virustotal:<hash>:<path>"). Adding an id again updates its text and
//   keeps whether it was read.
// - kind: "update" | "virustotal" | ... (the board's icon).
// - level: "info" | "warning" | "danger".
// - action: what clicking it does, as data the window interprets:
//   { view: "about" } opens that Library view, { url } opens a tab.
// - private: kept in memory only (never written to disk), e.g. a private
//   space's download; its text names nothing from the space.
//
// Saved in chrome/.firefox-zen/notifications.json (the updater leaves that
// folder alone), at most MAX of them, newest first.

const STATE_DIR = PathUtils.join(PathUtils.profileDir, "chrome", ".firefox-zen");
const FILE = PathUtils.join(STATE_DIR, "notifications.json");
const TOPIC = "firefox-zen-notifications-changed";
const MAX = 100;
const LEVELS = ["info", "warning", "danger"];

const log = e => console.error("firefox-zen-notifications:", e);
const text = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// id -> notification
let items = new Map();

function clean(n) {
  if (!n || typeof n.id !== "string" || !n.id || !text(n.title)) {
    return null;
  }
  const action = {};
  if (typeof n.action?.view === "string") {
    action.view = n.action.view;
  }
  if (typeof n.action?.url === "string" && /^https?:\/\//.test(n.action.url)) {
    action.url = n.action.url;
  }
  return {
    id: n.id.slice(0, 300),
    kind: text(n.kind, 40) || "info",
    level: LEVELS.includes(n.level) ? n.level : "info",
    title: text(n.title, 200),
    body: text(n.body),
    time: Number.isFinite(n.time) ? n.time : Date.now(),
    read: !!n.read,
    action: Object.keys(action).length ? action : null,
    private: !!n.private,
  };
}

const sorted = () => [...items.values()].sort((a, b) => b.time - a.time);

const ready = (async () => {
  try {
    const data = await IOUtils.readJSON(FILE);
    for (const n of Array.isArray(data?.notifications) ? data.notifications : []) {
      const c = clean(n);
      if (c && !c.private) {
        items.set(c.id, c);
      }
    }
  } catch (e) {
    if (e.name !== "NotFoundError") {
      log(e);
    }
  }
  notify();
})();

let saveTimer = null;
let saving = Promise.resolve();
function save() {
  if (saveTimer) {
    return;
  }
  // Batches a burst of changes into one write.
  saveTimer = Promise.resolve().then(() => {
    saveTimer = null;
    const data = { version: 1, notifications: sorted().filter(n => !n.private) };
    saving = saving
      .then(async () => {
        await IOUtils.makeDirectory(STATE_DIR, { createAncestors: true });
        await IOUtils.writeJSON(FILE, data, { tmpPath: FILE + ".tmp" });
      })
      .catch(log);
  });
}

function notify() {
  Services.obs.notifyObservers(null, TOPIC);
}

function changed() {
  // Oldest beyond MAX go.
  const all = sorted();
  for (const n of all.slice(MAX)) {
    items.delete(n.id);
  }
  save();
  notify();
}

export const FzNotifications = {
  TOPIC,
  ready,

  // Newest first.
  list: () => sorted().map(n => ({ ...n })),
  get: id => (items.has(id) ? { ...items.get(id) } : null),
  unreadCount: () => [...items.values()].filter(n => !n.read).length,
  // The newest unread one, or null.
  latestUnread: () => sorted().find(n => !n.read) ?? null,

  // Adds it, or updates the one with its id (keeping `read` unless
  // `renotify`: then it's unread and newest again).
  add(n, { renotify = false } = {}) {
    const c = clean({ ...n, time: n.time ?? Date.now() });
    if (!c) {
      return null;
    }
    const old = items.get(c.id);
    if (old && !renotify) {
      c.read = old.read;
      c.time = old.time;
    }
    if (old && JSON.stringify(old) === JSON.stringify(c)) {
      return { ...old };
    }
    items.set(c.id, c);
    changed();
    return { ...c };
  },

  // id: one, or every one when left out.
  markRead(id) {
    let any = false;
    for (const n of id ? [items.get(id)].filter(Boolean) : items.values()) {
      if (!n.read) {
        n.read = true;
        any = true;
      }
    }
    if (any) {
      changed();
    }
  },

  remove(id) {
    if (items.delete(id)) {
      changed();
    }
  },

  // Removes those that fn(notification) returns true for; every one without fn.
  clear(fn = null) {
    let any = false;
    for (const n of [...items.values()]) {
      if (!fn || fn({ ...n })) {
        items.delete(n.id);
        any = true;
      }
    }
    if (any) {
      changed();
    }
  },
};
