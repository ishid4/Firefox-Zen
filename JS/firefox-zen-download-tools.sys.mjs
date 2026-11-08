// ==UserScript==
// @name           Firefox-Zen Download Tools
// @description    Retry failed downloads, check finished ones on VirusTotal
// ==/UserScript==

// Background module (shared by every window). JS/firefox-zen-library.uc.js
// calls FzDownloadTools.init() at startup and shows what it reports in the
// Library's Downloads tab.
//
// - Retry on error (firefox-zen.download-retry): a download that fails
//   because of the network or the server is started again after a short wait,
//   up to firefox-zen.download-retry.attempts times. Not when it was blocked,
//   canceled, or the file couldn't be written (disk full, no permission):
//   those fail the same way again.
// - VirusTotal (firefox-zen.virustotal): the file's SHA-256 is looked up on
//   VirusTotal. Only the hash is sent (a few KB), never the file, unless you
//   press Upload. Firefox already hashes every download while saving it, so
//   usually nothing is read again from disk.
//   With an API key (firefox-zen.virustotal.api-key, free from virustotal.com)
//   finished downloads are checked automatically and the verdict shows on the
//   row; a file VirusTotal doesn't know can then be uploaded, or its link sent
//   for VirusTotal to download itself. Without a key, the row's VirusTotal
//   button opens the file's report page in a tab.
//   Besides Firefox's Downloads, it takes stand-ins for a private space's
//   saved downloads: { target: { path }, source: { url }, succeeded: true }
//   (JS/firefox-zen-private-spaces.sys.mjs keeps their verdicts, encrypted).

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
});

const RETRY_PREF = "firefox-zen.download-retry";
const ATTEMPTS_PREF = "firefox-zen.download-retry.attempts";
const VT_PREF = "firefox-zen.virustotal";
const VT_KEY_PREF = "firefox-zen.virustotal.api-key";

// firefox-zen.virustotal.dev-url points the API at a test server.
const apiBase = () =>
  Services.prefs.getStringPref("firefox-zen.virustotal.dev-url", "") || "https://www.virustotal.com/api/v3";
const GUI = "https://www.virustotal.com/gui";
// Direct upload limit; bigger files go through an upload URL (up to 650 MB).
const SMALL_UPLOAD = 32 * 1024 * 1024;
const MAX_UPLOAD = 650 * 1024 * 1024;
// The free API allows 4 requests a minute.
const RATE = 4;
const RATE_MS = 60000;

const log = e => console.error("firefox-zen-download-tools:", e);

// Waits before retry 1, 2, 3, ... (the last one repeats).
const RETRY_DELAYS = [3000, 10000, 30000];

const retryOn = () => Services.prefs.getBoolPref(RETRY_PREF, true);
const maxAttempts = () => Math.min(Math.max(Services.prefs.getIntPref(ATTEMPTS_PREF, 3), 1), 10);
const vtOn = () => Services.prefs.getBoolPref(VT_PREF, false);
const apiKey = () => Services.prefs.getStringPref(VT_KEY_PREF, "").trim();

// Download -> { tries, timer }
const retries = new WeakMap();
// Download -> VirusTotal state, see vtState().
const vt = new WeakMap();
// SHA-256 -> last verdict, so the same file isn't asked about twice.
const verdicts = new Map();
const listeners = new Set();

function notify(download) {
  for (const fn of listeners) {
    try {
      fn(download);
    } catch (e) {
      log(e);
    }
  }
}

// ---- retry ----

// Worth starting again: the network or the server failed, not the file.
function retryable(d) {
  const err = d.error;
  return (
    !!err &&
    !d.succeeded &&
    !d.canceled &&
    !err.becauseBlocked &&
    !err.becauseTargetFailed &&
    d.stopped
  );
}

function onChanged(d) {
  if (d.succeeded) {
    const r = retries.get(d);
    if (r) {
      clearTimeout(r.timer);
      retries.delete(d);
    }
    if (vtOn() && apiKey() && !vt.has(d) && d.target?.path) {
      // Finished: look it up. Errors show on the row.
      check(d).catch(log);
    }
    return;
  }
  if (!retryOn() || !retryable(d)) {
    return;
  }
  const r = retries.get(d) ?? { tries: 0, timer: null };
  if (r.timer || r.tries >= maxAttempts()) {
    return;
  }
  const delay = RETRY_DELAYS[Math.min(r.tries, RETRY_DELAYS.length - 1)];
  r.tries++;
  r.timer = setTimeout(() => {
    r.timer = null;
    // Retried or removed meanwhile.
    if (retryable(d)) {
      d.start().catch(() => {});
    }
    notify(d);
  }, delay);
  retries.set(d, r);
  notify(d);
}

// ---- VirusTotal ----

function hex(binary) {
  let out = "";
  for (let i = 0; i < binary.length; i++) {
    out += binary.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return out;
}

// The file's SHA-256 as hex: Firefox's own (computed while saving), else
// read from disk in chunks.
async function sha256(d) {
  try {
    const own = d.saver?.getSha256Hash?.();
    if (own && own.length === 32) {
      return hex(own);
    }
  } catch (e) {
    // Not kept (restored from an earlier session).
  }
  const path = d.target.path;
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.SHA256);
  const CHUNK = 8 * 1024 * 1024;
  for (let offset = 0; ; offset += CHUNK) {
    const bytes = await IOUtils.read(path, { offset, maxBytes: CHUNK });
    if (bytes.length) {
      hash.update(bytes, bytes.length);
    }
    if (bytes.length < CHUNK) {
      break;
    }
  }
  return hex(hash.finish(false));
}

// Spaces API calls so the free key's 4 a minute isn't exceeded.
const calls = [];
async function api(path, { method = "GET", body = null, url = null } = {}) {
  for (;;) {
    const now = Date.now();
    while (calls.length && now - calls[0] > RATE_MS) {
      calls.shift();
    }
    if (calls.length < RATE) {
      break;
    }
    await new Promise(r => setTimeout(r, RATE_MS - (now - calls[0]) + 50));
  }
  calls.push(Date.now());
  const res = await fetch(url ?? `${apiBase()}${path}`, {
    method,
    body,
    headers: { "x-apikey": apiKey(), accept: "application/json" },
    credentials: "omit",
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      message = (await res.json())?.error?.message || message;
    } catch (e) {
      // Not JSON.
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// A file report -> { malicious, suspicious, total } or null while VirusTotal
// is still scanning it.
function verdictOf(report) {
  const attrs = report?.data?.attributes;
  const stats = attrs?.last_analysis_stats;
  if (!stats || !attrs.last_analysis_date) {
    return null;
  }
  const total = ["malicious", "suspicious", "undetected", "harmless"].reduce((n, k) => n + (stats[k] || 0), 0);
  return { malicious: stats.malicious || 0, suspicious: stats.suspicious || 0, total };
}

function setState(d, state) {
  vt.set(d, state);
  notify(d);
}

const failText = e =>
  e?.status === 401 || e?.status === 403
    ? "API key not accepted"
    : e?.status === 429
      ? "Daily limit reached, try later"
      : "Couldn't reach VirusTotal";

// Asks about a file until VirusTotal has scanned it (after an upload or a
// link scan, that takes a minute or two).
async function waitForReport(d, hash, { until = 6 * 60000 } = {}) {
  const end = Date.now() + until;
  for (;;) {
    const report = await api(`/files/${hash}`);
    const verdict = report && verdictOf(report);
    if (verdict) {
      verdicts.set(hash, verdict);
      setState(d, { status: "done", hash, verdict });
      return;
    }
    if (Date.now() > end) {
      setState(d, { status: report ? "scanning" : "unknown", hash, note: "Still scanning, check again later" });
      return;
    }
    await new Promise(r => setTimeout(r, 20000));
  }
}

// Looks the download up. Without an API key, opens its report page instead
// (returns that URL).
async function check(d) {
  if (!d.succeeded || !d.target?.path) {
    return null;
  }
  setState(d, { status: "hashing" });
  let hash;
  try {
    hash = await sha256(d);
  } catch (e) {
    log(e);
    setState(d, { status: "error", note: "File not found" });
    return null;
  }
  if (!apiKey()) {
    vt.delete(d);
    notify(d);
    return `${GUI}/file/${hash}`;
  }
  const known = verdicts.get(hash);
  if (known) {
    setState(d, { status: "done", hash, verdict: known });
    return null;
  }
  setState(d, { status: "checking", hash });
  try {
    const report = await api(`/files/${hash}`);
    if (!report) {
      setState(d, { status: "unknown", hash });
      return null;
    }
    const verdict = verdictOf(report);
    if (!verdict) {
      setState(d, { status: "scanning", hash });
      await waitForReport(d, hash);
      return null;
    }
    verdicts.set(hash, verdict);
    setState(d, { status: "done", hash, verdict });
  } catch (e) {
    log(e);
    setState(d, { status: "error", hash, note: failText(e) });
  }
  return null;
}

// Sends the file to VirusTotal (it becomes visible to VirusTotal's partners).
async function upload(d) {
  const state = vt.get(d);
  const hash = state?.hash ?? (await sha256(d));
  const path = d.target.path;
  const size = (await IOUtils.stat(path)).size;
  if (size > MAX_UPLOAD) {
    setState(d, { status: "unknown", hash, note: "Too big to upload (650 MB max)" });
    return;
  }
  setState(d, { status: "uploading", hash });
  try {
    const file = await File.createFromFileName(path);
    const form = new FormData();
    form.append("file", file, PathUtils.filename(path));
    let url = null;
    if (size > SMALL_UPLOAD) {
      url = (await api("/files/upload_url"))?.data;
    }
    await api("/files", { method: "POST", body: form, url });
    setState(d, { status: "scanning", hash });
    await waitForReport(d, hash);
  } catch (e) {
    log(e);
    setState(d, { status: "error", hash, note: failText(e) });
  }
}

// Gives VirusTotal the download's link: it fetches the file itself, so
// nothing is uploaded from here. Links that need your login or expire
// won't work; then the file's hash stays unknown.
async function scanLink(d) {
  const state = vt.get(d);
  const hash = state?.hash ?? (await sha256(d));
  setState(d, { status: "scanning", hash });
  try {
    const form = new FormData();
    form.append("url", d.source.url);
    await api("/urls", { method: "POST", body: form });
    await waitForReport(d, hash, { until: 4 * 60000 });
  } catch (e) {
    log(e);
    setState(d, { status: "error", hash, note: failText(e) });
  }
}

let started = false;

export const FzDownloadTools = {
  async init() {
    if (started) {
      return;
    }
    started = true;
    try {
      const list = await lazy.Downloads.getList(lazy.Downloads.ALL);
      await list.addView({ onDownloadChanged: d => onChanged(d) });
    } catch (e) {
      log(e);
    }
  },

  // fn(download) whenever its retry or VirusTotal state changes.
  addListener(fn) {
    listeners.add(fn);
  },
  removeListener(fn) {
    listeners.delete(fn);
  },

  vtEnabled: vtOn,
  hasApiKey: () => !!apiKey(),

  // { tries, max, waiting } while auto-retry is handling a failed download.
  retryInfo(d) {
    const r = retries.get(d);
    return r && retryOn() ? { tries: r.tries, max: maxAttempts(), waiting: !!r.timer } : null;
  },

  // { status: "hashing" | "checking" | "unknown" | "uploading" | "scanning"
  //   | "done" | "error", hash?, verdict?: { malicious, suspicious, total },
  //   note? } or null when not checked.
  vtState: d => vt.get(d) ?? null,
  // A verdict known from before (a private space's saved one), shown
  // without asking VirusTotal again.
  seed(d, state) {
    if (!vt.has(d)) {
      vt.set(d, state);
    }
  },
  reportUrl: hash => `${GUI}/file/${hash}`,

  check,
  upload,
  scanLink,
};
