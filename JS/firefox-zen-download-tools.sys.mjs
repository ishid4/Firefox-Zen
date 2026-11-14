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
//   New downloads are checked when they finish (firefox-zen.virustotal.auto),
//   key or not; earlier ones only when asked. First through
//   VirusTotal's own report page, loaded in a hidden browser (the result the
//   page fetches for itself is read as it arrives, nothing is clicked or
//   faked). If that can't tell (a challenge page, a timeout) and there's an
//   API key (firefox-zen.virustotal.api-key, free from virustotal.com), the
//   API is asked instead.
//   A file VirusTotal doesn't know can, with a key, be uploaded or its link
//   sent for VirusTotal to download itself; without one, the row's button
//   opens VirusTotal's upload page in a tab.
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
const VT_AUTO_PREF = "firefox-zen.virustotal.auto";

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
const vtAuto = () => Services.prefs.getBoolPref(VT_AUTO_PREF, true);
const apiKey = () => Services.prefs.getStringPref(VT_KEY_PREF, "").trim();

// Downloads seen unfinished: only these are checked automatically when they
// finish, never ones already done from earlier sessions.
const fresh = new WeakSet();

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
    if (fresh.has(d)) {
      fresh.delete(d);
      if (vtOn() && vtAuto() && !vt.has(d) && d.target?.path) {
        // Just finished: look it up. Errors show on the row.
        check(d).catch(log);
      }
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

// ---- keyless lookup through VirusTotal's report page ----
// The page at /gui/file/<hash> asks www.virustotal.com/ui/files/<hash> (or
// /ui/search?query=<hash>) for the same report the API gives. A hidden browser
// loads the page and the answer is copied as the page receives it.

const PAGE_WAIT = 30000;
const UI_HOST = "www.virustotal.com";
// hash -> fn(result), while a page lookup waits for it.
const pageWaiters = new Map();
let observing = false;

const BinaryInputStream = Components.Constructor(
  "@mozilla.org/binaryinputstream;1",
  "nsIBinaryInputStream",
  "setInputStream"
);
function byteStream(data) {
  const s = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
  s.setByteStringData(data);
  return s;
}

// The hash a /ui/ request is about, and whether it's a search.
function uiRequest(uri) {
  if (uri.scheme !== "https" || uri.host !== UI_HOST) {
    return null;
  }
  const file = /^\/ui\/files\/([0-9a-f]{64})$/i.exec(uri.filePath);
  if (file) {
    return { hash: file[1].toLowerCase(), search: false };
  }
  if (uri.filePath === "/ui/search") {
    const q = new URLSearchParams(uri.query).get("query")?.trim().toLowerCase();
    if (q && /^[0-9a-f]{64}$/.test(q)) {
      return { hash: q, search: true };
    }
  }
  return null;
}

// Body of a finished /ui/ response -> report, null (not on VirusTotal), or
// undefined (no answer: a challenge, a rate limit).
function pageResult(status, body, search, hash) {
  if (status === 404) {
    return null;
  }
  if (status !== 200) {
    return undefined;
  }
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(Uint8Array.from(body, c => c.charCodeAt(0))));
  } catch (e) {
    return undefined;
  }
  if (!search) {
    return json?.data ? json : undefined;
  }
  if (!Array.isArray(json?.data)) {
    return undefined;
  }
  const item = json.data.find(x => x?.type === "file" && x.id?.toLowerCase() === hash);
  return item ? { data: item } : null;
}

// Copies the response the page gets, passing it on unchanged.
function capture(channel, { hash, search }) {
  let encoding = "";
  try {
    encoding = channel.getResponseHeader("Content-Encoding").trim().toLowerCase();
  } catch (e) {
    // Not encoded.
  }
  const status = channel.responseStatus;
  const chunks = [];
  const sink = {
    QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
    onStartRequest() {},
    onDataAvailable(request, stream, offset, count) {
      chunks.push(new BinaryInputStream(stream).readBytes(count));
    },
    onStopRequest() {
      const result = pageResult(status, chunks.join(""), search, hash);
      if (result !== undefined) {
        pageWaiters.get(hash)?.(result);
      }
    },
  };
  // In e10s the parent sees the body still compressed.
  let copy = sink;
  if (encoding && encoding !== "identity") {
    try {
      copy = Cc["@mozilla.org/streamConverters;1"]
        .getService(Ci.nsIStreamConverterService)
        .asyncConvertData(encoding, "uncompressed", sink, null);
    } catch (e) {
      return;
    }
  }
  const quiet = fn => {
    try {
      fn();
    } catch (e) {
      log(e);
    }
  };
  let original = null;
  const tee = {
    QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
    onStartRequest(request) {
      quiet(() => copy.onStartRequest(request));
      original.onStartRequest(request);
    },
    onDataAvailable(request, stream, offset, count) {
      const data = new BinaryInputStream(stream).readBytes(count);
      quiet(() => copy.onDataAvailable(request, byteStream(data), offset, count));
      original.onDataAvailable(request, byteStream(data), offset, count);
    },
    onStopRequest(request, code) {
      quiet(() => copy.onStopRequest(request, code));
      original.onStopRequest(request, code);
    },
  };
  original = channel.QueryInterface(Ci.nsITraceableChannel).setNewListener(tee);
}

const responseObserver = {
  observe(subject) {
    if (!pageWaiters.size) {
      return;
    }
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const req = uiRequest(channel.URI);
      if (req && pageWaiters.has(req.hash)) {
        capture(channel, req);
      }
    } catch (e) {
      log(e);
    }
  },
};
const RESPONSE_TOPICS = ["http-on-examine-response", "http-on-examine-cached-response", "http-on-examine-merged-response"];

// An off-screen content browser in a browser window showing `url`.
function hiddenBrowser(win, url) {
  const doc = win.document;
  const b = doc.createXULElement("browser");
  let remoteType = "web";
  try {
    const { E10SUtils } = ChromeUtils.importESModule("resource://gre/modules/E10SUtils.sys.mjs");
    remoteType = E10SUtils.getRemoteTypeForURI(url, true, true);
  } catch (e) {
    // The default content process; it switches on load.
  }
  const attrs = {
    type: "content",
    remote: "true",
    remoteType,
    maychangeremoteness: "true",
    disableglobalhistory: "true",
    messagemanagergroup: "fz-virustotal",
    nodefaultsrc: "true",
  };
  for (const [k, v] of Object.entries(attrs)) {
    b.setAttribute(k, v);
  }
  b.style.cssText = "position: fixed; left: -20000px; top: 0; width: 1200px; height: 800px; pointer-events: none;";
  doc.documentElement.append(b);
  b.loadURI(Services.io.newURI(url), {
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  return b;
}

// One page at a time; each resolves to a report, null (not on VirusTotal)
// or undefined (couldn't tell).
let pageQueue = Promise.resolve();
function pageLookup(hash) {
  const run = () =>
    new Promise(resolve => {
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      if (!win || win.closed) {
        resolve(undefined);
        return;
      }
      if (!observing) {
        observing = true;
        for (const topic of RESPONSE_TOPICS) {
          Services.obs.addObserver(responseObserver, topic);
        }
      }
      let browser = null;
      let timer = null;
      const finish = result => {
        clearTimeout(timer);
        if (pageWaiters.get(hash) === finish) {
          pageWaiters.delete(hash);
        }
        try {
          browser?.remove();
        } catch (e) {
          // Its window closed.
        }
        browser = null;
        resolve(result);
      };
      pageWaiters.set(hash, finish);
      timer = setTimeout(() => finish(undefined), PAGE_WAIT);
      try {
        browser = hiddenBrowser(win, `${GUI}/file/${hash}`);
      } catch (e) {
        log(e);
        finish(undefined);
      }
    });
  const p = pageQueue.then(run, run);
  pageQueue = p.catch(() => {});
  return p;
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

// Looks the download up: VirusTotal's report page first, then the API when
// the page couldn't tell and there's a key. Returns a URL to open when
// neither could (no key): the file's report page.
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
  const known = verdicts.get(hash);
  if (known) {
    setState(d, { status: "done", hash, verdict: known });
    return null;
  }
  setState(d, { status: "checking", hash });
  let page;
  try {
    page = await pageLookup(hash);
  } catch (e) {
    log(e);
  }
  if (page === null) {
    // Not on VirusTotal: with a key it can be uploaded or its link scanned,
    // without one the button opens the upload page.
    setState(d, { status: "unknown", hash });
    return null;
  }
  if (page) {
    const verdict = verdictOf(page);
    if (verdict) {
      verdicts.set(hash, verdict);
      setState(d, { status: "done", hash, verdict });
      return null;
    }
    if (!apiKey()) {
      setState(d, { status: "scanning", hash, note: "VirusTotal is still scanning it, check again later" });
      return null;
    }
  }
  if (!apiKey()) {
    // The page didn't answer (a challenge, a timeout): open it in a tab.
    vt.delete(d);
    notify(d);
    return `${GUI}/file/${hash}`;
  }
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
      await list.addView({
        onDownloadAdded: d => {
          if (!d.succeeded) {
            fresh.add(d);
          }
        },
        onDownloadChanged: d => onChanged(d),
      });
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
  // Where to check a file VirusTotal doesn't know yet, without a key.
  uploadUrl: `${GUI}/home/upload`,

  check,
  upload,
  scanLink,
};
