// ==UserScript==
// @name           Firefox-Zen Tab Unload
// @description    Settings shared by every window for Unload tabs: excluded sites and Firefox's own unload prefs
// ==/UserScript==

// Background module (shared by every window). JS/firefox-zen-tab-unload.uc.js
// unloads each window's inactive tabs; this holds what they share:
// - the excluded sites (firefox-zen.tab-unload.exclude, a JSON array of
//   hosts, or hosts with a path: "github.com/ishid4"),
// - Firefox's own low-memory unloader prefs, written from ours while Unload
//   tabs is on and cleared (back to Firefox's defaults) when it's turned off.
//
// Firefox's unloader (moz-src:///browser/components/tabbrowser/TabUnloader.sys.mjs,
// also what about:unloads shows) never unloads a tab with `undiscardable`
// set; the window script sets it on tabs of excluded sites.

const BRANCH = "firefox-zen.tab-unload";
export const PREFS = {
  enabled: BRANCH,
  minutes: `${BRANCH}.minutes`,
  lowMemory: `${BRANCH}.low-memory`,
  threshold: `${BRANCH}.threshold-mb`,
  keepPinned: `${BRANCH}.keep-pinned`,
  keepAudio: `${BRANCH}.keep-audio`,
  exclude: `${BRANCH}.exclude`,
};

export const DEFAULTS = { minutes: 30, lowMemory: true, threshold: 200, keepPinned: true, keepAudio: true };

// Firefox's prefs. The threshold is Windows only: how much of the system's
// commit space (RAM + page file) may be left, in MB, before Firefox calls
// memory low. Firefox reads the inactive duration once at startup.
const NATIVE = {
  lowMemory: "browser.tabs.unloadOnLowMemory",
  minInactive: "browser.tabs.min_inactive_duration_before_unload",
  threshold: "browser.low_commit_space_threshold_mb",
};

export const IS_WINDOWS = Services.appinfo.OS === "WINNT";

const MAX_SITES = 500;

// An entry is a site, "example.com", or a part of one, "example.com/docs".
// "https://www.Example.com:8080/Docs/?q=1#top" -> "example.com/docs"; null
// when it isn't one. A leading www. is dropped (an entry covers its
// subdomains anyway), and so are the port, query and fragment.
export function normalizeSite(text) {
  let value = String(text ?? "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    value = "https://" + value;
  }
  let uri;
  try {
    uri = Services.io.newURI(value);
  } catch {
    return null;
  }
  const host = uri.host.replace(/^www\./, "").replace(/\.$/, "");
  // A name with a dot, an IP address or localhost
  if (!host || (!host.includes(".") && !host.includes(":") && host !== "localhost")) {
    return null;
  }
  return host + pathOf(uri);
}

// "/a/b/" -> "/a/b"; "" for the root. Lowercase, like normalizeSite.
function pathOf(uri) {
  let path = (uri.pathQueryRef ?? "/").replace(/[?#].*/s, "");
  try {
    path = decodeURIComponent(path);
  } catch {}
  return path.toLowerCase().replace(/\/+$/, "");
}

// The site part of a tab's address, or null for about:, file: etc.
export function hostOf(uri) {
  try {
    if (!/^https?$/.test(uri?.scheme)) {
      return null;
    }
    return uri.host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

// The site and path of a tab's address ("github.com/ishid4/firefox-zen"), or null.
export function siteOf(uri) {
  const host = hostOf(uri);
  return host ? host + pathOf(uri) : null;
}

const split = entry => {
  const slash = entry.indexOf("/");
  return slash < 0 ? [entry, ""] : [entry.slice(0, slash), entry.slice(slash)];
};

// Whether an entry keeps a site (or page, or other entry): the same host or a
// subdomain, and the same path or one under it.
export function covers(entry, target) {
  const [host, path] = split(entry);
  const [targetHost, targetPath] = split(target);
  return (
    (targetHost === host || targetHost.endsWith("." + host)) &&
    (!path || targetPath === path || targetPath.startsWith(path + "/"))
  );
}

// Parsed again only when the pref's text changed. Keyed on the text, not
// cleared by an observer: windows' pref observers may run before ours would.
let cache = { raw: null, sites: [] };

export function excludedSites() {
  const raw = Services.prefs.getStringPref(PREFS.exclude, "[]");
  if (raw !== cache.raw) {
    let list = [];
    try {
      list = JSON.parse(raw);
    } catch {}
    const sites = Array.isArray(list) ? [...new Set(list.map(normalizeSite).filter(Boolean))] : [];
    cache = { raw, sites };
  }
  return cache.sites;
}

// Writes the list cleaned up and sorted; an empty one clears the pref.
// Returns false when it isn't a list.
export function saveExcludedSites(list) {
  if (!Array.isArray(list)) {
    return false;
  }
  const sites = [...new Set(list.map(normalizeSite).filter(Boolean))].sort().slice(0, MAX_SITES);
  if (sites.length) {
    Services.prefs.setStringPref(PREFS.exclude, JSON.stringify(sites));
  } else {
    Services.prefs.clearUserPref(PREFS.exclude);
  }
  return true;
}

// The entry that keeps this site (or "site/path") loaded, or null.
export function exclusionFor(site) {
  return site ? (excludedSites().find(entry => covers(entry, site)) ?? null) : null;
}

export const isExcluded = uri => !!exclusionFor(siteOf(uri));

// Adds the site, or removes every entry that covers it.
export function setExcluded(text, excluded) {
  const site = normalizeSite(text);
  if (!site) {
    return;
  }
  const sites = excludedSites().filter(s => !covers(s, site));
  saveExcludedSites(excluded ? [...sites, site] : sites);
}

// ---- Firefox's own prefs ----

const enabled = () => Services.prefs.getBoolPref(PREFS.enabled, false);

function int(name, fallback, min, max) {
  return Math.min(max, Math.max(min, Services.prefs.getIntPref(name, fallback)));
}

// A value equal to Firefox's default is cleared rather than written.
function setNative(name, value) {
  const defaults = Services.prefs.getDefaultBranch("");
  let fallback;
  try {
    fallback = typeof value === "boolean" ? defaults.getBoolPref(name) : defaults.getIntPref(name);
  } catch {}
  if (value === fallback) {
    Services.prefs.clearUserPref(name);
  } else if (typeof value === "boolean") {
    Services.prefs.setBoolPref(name, value);
  } else {
    Services.prefs.setIntPref(name, value);
  }
}

function clearNative() {
  for (const name of Object.values(NATIVE)) {
    Services.prefs.clearUserPref(name);
  }
}

function syncNative() {
  if (!enabled()) {
    return;
  }
  setNative(NATIVE.lowMemory, Services.prefs.getBoolPref(PREFS.lowMemory, DEFAULTS.lowMemory));
  // 0 (only when memory is low): Firefox's own wait.
  const minutes = int(PREFS.minutes, DEFAULTS.minutes, 0, 1440);
  if (minutes) {
    setNative(NATIVE.minInactive, minutes * 60000);
  } else {
    Services.prefs.clearUserPref(NATIVE.minInactive);
  }
  if (IS_WINDOWS) {
    setNative(NATIVE.threshold, int(PREFS.threshold, DEFAULTS.threshold, 50, 16384));
  }
}

// Turning the feature off hands the prefs back to Firefox. On startup with it
// off, prefs someone set by hand in about:config are left alone.
const observer = {
  observe(_subject, _topic, name) {
    if (name === PREFS.enabled && !enabled()) {
      clearNative();
      return;
    }
    if (name !== PREFS.exclude) {
      syncNative();
    }
  },
};
Services.prefs.addObserver(BRANCH, observer);
syncNative();

export const FzTabUnload = {
  PREFS,
  DEFAULTS,
  IS_WINDOWS,
  normalizeSite,
  hostOf,
  siteOf,
  covers,
  excludedSites,
  saveExcludedSites,
  exclusionFor,
  isExcluded,
  setExcluded,
};
