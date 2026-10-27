// ==UserScript==
// @name           Firefox-Zen Mods
// @description    Mods registry: user mods from chrome/mods, their on/off state, page styles, install/remove
// ==/UserScript==

// Background module (loaded once by fx-autoconfig, shared by every window).
// The window side (browser UI styles, scripts, the Library's Mods tab) is in
// JS/firefox-zen-mods.uc.js.
//
// A mod is a folder chrome/mods/<id>/ with a mod.json manifest and any of:
// - styles: CSS for the browser UI, loaded in each browser window.
// - contentStyles: CSS registered with the style sheet service, so it applies
//   to every document (web pages, about: pages and the browser UI).
// - script: JS run in each browser window with a `mod` API (see the window
//   side). It has full chrome privileges, so a mod with a script only turns
//   on after the user confirmed it once (TRUSTED_PREF).
// - options: values the Mods tab edits, stored as firefox-zen.mods.<id>.<pref>
//   (button options store nothing: they call the script).
//
// The folder name is the mod's id. On/off state is ENABLED_PREF (a JSON list
// of ids), so it survives reinstalling a mod and goes into settings files.
// Every scan bumps `stamp`, which windows use to reload what they loaded.

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const PREF_BRANCH = "firefox-zen.mods.";
const ENABLED_PREF = PREF_BRANCH + "enabled";
const TRUSTED_PREF = PREF_BRANCH + "trusted";
const SAFE_MODE_PREF = PREF_BRANCH + "safe-mode";
// Ids that would collide with the prefs above.
const RESERVED = new Set(["enabled", "trusted", "safe-mode", "auto-update-check", "last-update-check"]);
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PREF_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const CHANGED_TOPIC = "firefox-zen-mods-changed";
const MODS_DIR = PathUtils.join(PathUtils.profileDir, "chrome", "mods");
const MANIFEST = "mod.json";

// Files a mod gets without listing them in mod.json.
const DEFAULT_FILES = {
  styles: ["style.css"],
  contentStyles: ["content.css"],
  script: "mod.uc.js",
  preview: ["preview.png", "preview.svg", "preview.jpg", "preview.webp"],
};

// Skips every mod for one start, for a mod that breaks the browser: set it in
// about:config (or user.js) and restart. Cleared right away, so the start
// after is normal again.
const safeMode = Services.prefs.getBoolPref(SAFE_MODE_PREF, false);
Services.prefs.clearUserPref(SAFE_MODE_PREF);

const sss = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);

/** @type {Map<string, object>} id -> mod */
const mods = new Map();
let stamp = 0;

const notify = () => Services.obs.notifyObservers(null, CHANGED_TOPIC);

function readList(pref) {
  try {
    const list = JSON.parse(Services.prefs.getStringPref(pref, "[]"));
    return Array.isArray(list) ? list.filter(id => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeList(pref, list) {
  if (list.length) {
    Services.prefs.setStringPref(pref, JSON.stringify([...new Set(list)]));
  } else {
    Services.prefs.clearUserPref(pref);
  }
}

function fileOf(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

// A path inside the mod's folder, or null for anything that would leave it.
function resolve(dir, rel) {
  if (typeof rel !== "string") {
    return null;
  }
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length || parts.some(p => p === "." || p === ".." || p.includes(":"))) {
    return null;
  }
  return PathUtils.join(dir, ...parts);
}

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

// ---- manifest ----

function parseOption(o, errors) {
  if (!o || typeof o !== "object" || !PREF_RE.test(o.pref ?? "")) {
    errors.push(`An option has no valid "pref" (lower-case letters, digits, - and _).`);
    return null;
  }
  const base = { type: o.type, pref: o.pref, label: text(o.label, 80) || o.pref, hint: text(o.hint, 300) || null };
  switch (o.type) {
    case "bool":
      return { ...base, default: o.default === true };
    case "number": {
      const min = Number.isFinite(o.min) ? Math.round(o.min) : 0;
      const max = Number.isFinite(o.max) ? Math.round(o.max) : 100;
      if (max < min) {
        errors.push(`Option "${o.pref}": max is below min.`);
        return null;
      }
      const value = Number.isFinite(o.default) ? Math.round(o.default) : min;
      return { ...base, min, max, unit: text(o.unit, 12), default: Math.min(max, Math.max(min, value)) };
    }
    case "select": {
      const choices = (Array.isArray(o.choices) ? o.choices : [])
        .map(c => (typeof c === "string" ? { value: c, label: c } : c))
        .filter(c => c && typeof c.value === "string" && c.value)
        .map(c => ({ value: c.value, label: text(c.label, 60) || c.value }));
      if (!choices.length) {
        errors.push(`Option "${o.pref}" has no choices.`);
        return null;
      }
      const value = choices.some(c => c.value === o.default) ? o.default : choices[0].value;
      return { ...base, choices, default: value };
    }
    case "color": {
      const value = typeof o.default === "string" ? o.default.toLowerCase() : "";
      return { ...base, default: COLOR_RE.test(value) ? value : "#000000" };
    }
    // Runs the script's mod.onButton(pref) handler; stores nothing.
    case "button":
      return { ...base, text: text(o.text, 30) || "Run", confirm: text(o.confirm, 300) || null, default: null };
    default:
      errors.push(`Option "${o.pref}" has an unknown type "${o.type}" (bool, number, select, color or button).`);
      return null;
  }
}

// Listed files must exist; unlisted defaults are used when present.
async function files(dir, listed, defaults, errors) {
  const found = [];
  if (listed === undefined) {
    for (const rel of defaults) {
      const path = resolve(dir, rel);
      if (await IOUtils.exists(path)) {
        found.push(path);
      }
    }
    return found;
  }
  for (const rel of [listed].flat()) {
    const path = resolve(dir, rel);
    if (!path) {
      errors.push(`"${rel}" is not a path inside the mod's folder.`);
    } else if (!(await IOUtils.exists(path))) {
      errors.push(`Missing file: ${rel}`);
    } else {
      found.push(path);
    }
  }
  return found;
}

async function readMod(id) {
  const dir = PathUtils.join(MODS_DIR, id);
  const mod = {
    id,
    dir,
    name: id,
    version: "",
    author: "",
    description: "",
    homepage: null,
    styles: [],
    contentStyles: [],
    script: null,
    preview: null,
    options: [],
    errors: [],
    runtimeError: null,
    updateURL: null,
    downloadURL: null,
    update: null,
    updateError: null,
    broken: false,
    stamp,
  };
  let manifest;
  try {
    manifest = await IOUtils.readJSON(PathUtils.join(dir, MANIFEST));
  } catch (e) {
    mod.broken = true;
    mod.errors.push(e.name === "NotFoundError" ? `No ${MANIFEST} in this folder.` : `${MANIFEST}: ${e.message}`);
    return mod;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    mod.broken = true;
    mod.errors.push(`${MANIFEST} must be an object.`);
    return mod;
  }
  mod.name = text(manifest.name, 60) || id;
  mod.version = text(manifest.version, 20);
  mod.author = text(manifest.author, 60);
  mod.description = text(manifest.description, 400);
  mod.homepage = /^https?:\/\//.test(manifest.homepage ?? "") ? manifest.homepage : null;
  mod.updateURL = isUpdateURL(manifest.updateURL) ? manifest.updateURL : null;
  mod.downloadURL = isUpdateURL(manifest.downloadURL) ? manifest.downloadURL : null;
  if ((manifest.updateURL && !mod.updateURL) || (manifest.downloadURL && !mod.downloadURL)) {
    mod.errors.push("updateURL and downloadURL must be https.");
  }
  mod.styles = await files(dir, manifest.styles, DEFAULT_FILES.styles, mod.errors);
  mod.contentStyles = await files(dir, manifest.contentStyles, DEFAULT_FILES.contentStyles, mod.errors);
  const script = await files(dir, manifest.script, [DEFAULT_FILES.script], mod.errors);
  mod.script = script[0] ?? null;
  const preview = await files(dir, manifest.preview, DEFAULT_FILES.preview, mod.errors);
  mod.preview = preview[0] ? PathUtils.toFileURI(preview[0]) : null;
  const options = Array.isArray(manifest.options) ? manifest.options : [];
  const seen = new Set();
  for (const raw of options) {
    const o = parseOption(raw, mod.errors);
    if (o && seen.has(o.pref)) {
      mod.errors.push(`Option "${o.pref}" is listed twice.`);
    } else if (o) {
      seen.add(o.pref);
      mod.options.push(o);
    }
  }
  if (!mod.styles.length && !mod.contentStyles.length && !mod.script) {
    mod.errors.push("Nothing to load: no styles and no script.");
  }
  return mod;
}

async function scan() {
  stamp++;
  await IOUtils.makeDirectory(MODS_DIR, { createAncestors: true });
  const found = new Map();
  for (const path of await IOUtils.getChildren(MODS_DIR)) {
    const id = PathUtils.filename(path);
    // Leftovers of an interrupted install start with a dot.
    if (id.startsWith(".install-")) {
      await IOUtils.remove(path, { recursive: true, ignoreAbsent: true }).catch(() => {});
      continue;
    }
    if (id.startsWith(".") || (await IOUtils.stat(path)).type !== "directory") {
      continue;
    }
    if (!ID_RE.test(id) || RESERVED.has(id)) {
      found.set(id, {
        id,
        dir: path,
        name: id,
        broken: true,
        errors: ["Folder names must be lower-case letters, digits, - and _ (and not a firefox-zen.mods.* pref name)."],
        options: [],
        styles: [],
        contentStyles: [],
        stamp,
      });
      continue;
    }
    found.set(id, await readMod(id));
  }
  // Runtime errors stay until the mod is turned on again; a found update
  // until it's installed (the version comparison is redone).
  for (const [id, mod] of found) {
    const old = mods.get(id);
    mod.runtimeError = old?.runtimeError ?? null;
    mod.updateError = old?.updateError ?? null;
    if (old?.update && compareVersions(old.update.version, mod.version || "0") > 0) {
      mod.update = old.update;
    }
  }
  mods.clear();
  for (const mod of [...found.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    mods.set(mod.id, mod);
  }
  syncContentSheets();
  notify();
}

// ---- state ----

const isEnabled = id => readList(ENABLED_PREF).includes(id);
const isTrusted = id => readList(TRUSTED_PREF).includes(id);

// Whether this session loads the mod.
function isActive(id) {
  const mod = mods.get(id);
  return !safeMode && !!mod && !mod.broken && isEnabled(id) && !(mod.script && !isTrusted(id));
}

function setEnabled(id, on) {
  const list = readList(ENABLED_PREF).filter(x => x !== id);
  if (on) {
    const mod = mods.get(id);
    if (mod?.script && !isTrusted(id)) {
      throw new Error("a mod with a script needs to be trusted first");
    }
    if (mod) {
      mod.runtimeError = null;
    }
    list.push(id);
  }
  writeList(ENABLED_PREF, list);
}

function setTrusted(id, on) {
  const list = readList(TRUSTED_PREF).filter(x => x !== id);
  writeList(TRUSTED_PREF, on ? [...list, id] : list);
}

function reportError(id, error) {
  const mod = mods.get(id);
  if (mod) {
    mod.runtimeError = String(error?.message ?? error);
    notify();
  }
}

// ---- options ----

const prefName = (id, pref) => `${PREF_BRANCH}${id}.${pref}`;

function getOption(mod, o) {
  const name = prefName(mod.id, o.pref);
  switch (o.type) {
    case "bool":
      return Services.prefs.getBoolPref(name, o.default);
    case "number": {
      const value = Services.prefs.getIntPref(name, o.default);
      return Math.min(o.max, Math.max(o.min, value));
    }
    case "select": {
      const value = Services.prefs.getStringPref(name, o.default);
      return o.choices.some(c => c.value === value) ? value : o.default;
    }
    case "color": {
      const value = Services.prefs.getStringPref(name, o.default).toLowerCase();
      return COLOR_RE.test(value) ? value : o.default;
    }
  }
  return o.default;
}

// Returns false when the value doesn't fit the option.
function setOption(mod, o, value) {
  const name = prefName(mod.id, o.pref);
  switch (o.type) {
    case "bool":
      if (typeof value !== "boolean") {
        return false;
      }
      break;
    case "number":
      if (!Number.isFinite(value)) {
        return false;
      }
      value = Math.min(o.max, Math.max(o.min, Math.round(value)));
      break;
    case "select":
      if (!o.choices.some(c => c.value === value)) {
        return false;
      }
      break;
    case "color":
      value = typeof value === "string" ? value.toLowerCase() : "";
      if (!COLOR_RE.test(value)) {
        return false;
      }
      break;
    default:
      return false;
  }
  // Keep prefs.js clean: unset reads as the default.
  if (value === o.default) {
    Services.prefs.clearUserPref(name);
  } else if (o.type === "bool") {
    Services.prefs.setBoolPref(name, value);
  } else if (o.type === "number") {
    Services.prefs.setIntPref(name, value);
  } else {
    Services.prefs.setStringPref(name, value);
  }
  return true;
}

const isOptionsModified = mod => mod.options.some(o => getOption(mod, o) !== o.default);

function resetOptions(mod) {
  for (const o of mod.options) {
    Services.prefs.clearUserPref(prefName(mod.id, o.pref));
  }
}

// The cache-busting query makes a reload pick up edited files.
const fileURL = (mod, path) => `${PathUtils.toFileURI(path)}?fzmod=${mod.stamp}`;

// ---- page styles (every document, through the style sheet service) ----

/** @type {Map<string, {stamp: number, uris: nsIURI[]}>} */
const contentSheets = new Map();

function syncContentSheets() {
  for (const [id, entry] of contentSheets) {
    if (!isActive(id) || mods.get(id).stamp !== entry.stamp) {
      for (const uri of entry.uris) {
        if (sss.sheetRegistered(uri, sss.AUTHOR_SHEET)) {
          sss.unregisterSheet(uri, sss.AUTHOR_SHEET);
        }
      }
      contentSheets.delete(id);
    }
  }
  for (const mod of mods.values()) {
    if (!isActive(mod.id) || contentSheets.has(mod.id)) {
      continue;
    }
    const uris = [];
    for (const path of mod.contentStyles) {
      const uri = Services.io.newURI(fileURL(mod, path));
      try {
        sss.loadAndRegisterSheet(uri, sss.AUTHOR_SHEET);
        uris.push(uri);
      } catch (e) {
        mod.runtimeError = `Couldn't load ${PathUtils.filename(path)}: ${e.message}`;
      }
    }
    contentSheets.set(mod.id, { stamp: mod.stamp, uris });
  }
}

// ---- install / remove / export ----

// With `folder`, only that folder of the zip is extracted, into `into`
// itself. It may sit under one top folder, as in GitHub's repository zips.
async function extractZip(path, into, folder = null) {
  const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
  reader.open(fileOf(path));
  try {
    const names = [];
    const entries = reader.findEntries(null);
    while (entries.hasMore()) {
      names.push(entries.getNext());
    }
    let prefix = "";
    if (folder) {
      const want = `${folder.split(/[\\/]/).filter(Boolean).join("/")}/`;
      const below = name => name.slice(name.indexOf("/") + 1);
      const hit = names.find(n => n.startsWith(want) || below(n).startsWith(want));
      if (!hit) {
        throw new Error(`no folder ${folder} in the download`);
      }
      prefix = hit.startsWith(want) ? want : hit.slice(0, hit.indexOf("/") + 1) + want;
    }
    for (const name of names) {
      const entry = name.startsWith(prefix) ? name.slice(prefix.length) : "";
      if (!entry) {
        continue;
      }
      const target = resolve(into, entry);
      // Zip-slip: refuse entries that point outside the folder.
      if (!target) {
        throw new Error(`unsafe path in zip: ${entry}`);
      }
      if (entry.endsWith("/")) {
        await IOUtils.makeDirectory(target, { createAncestors: true });
        continue;
      }
      await IOUtils.makeDirectory(PathUtils.parent(target), { createAncestors: true });
      reader.extract(name, fileOf(target));
      // Zips (GitHub's among them) can mark files read-only, which would keep
      // this folder, and the installed mod, from being removed or replaced.
      await IOUtils.setPermissions(target, 0o644, false);
    }
  } finally {
    reader.close();
  }
}

const slug = name =>
  name
    .toLowerCase()
    .replace(/\.zip$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|-+$/g, "")
    .slice(0, 64);

// Reads a mod folder or .zip without installing it yet, so the caller can ask
// about replacing one. Returns { id, name, version, src, script, replaces,
// commit, cancel }. With `update` (the id of an installed mod) it installs
// over that mod whatever the download calls itself, and keeps it on/trusted:
// the user reviewed the changes (see prepareUpdate). `folder` is where the
// mod is inside the zip (a downloadURL's #fragment), for a whole repository's
// zip (see extractZip).
async function prepareInstall(path, { update = null, folder = null } = {}) {
  await IOUtils.makeDirectory(MODS_DIR, { createAncestors: true });
  const isDir = (await IOUtils.stat(path)).type === "directory";
  let tmp = null;
  let src = path;
  if (!isDir) {
    tmp = PathUtils.join(MODS_DIR, `.install-${Date.now()}`);
    await IOUtils.makeDirectory(tmp);
    src = tmp;
  }
  // Best effort: Windows can hold a file just extracted; scan() removes
  // leftover .install-* folders later.
  const cancel = async () => {
    if (tmp) {
      await IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true }).catch(() => {});
    }
  };
  try {
    if (tmp) {
      await extractZip(path, tmp, folder);
    }
    // Either mod.json at the top, or one folder holding it.
    if (!(await IOUtils.exists(PathUtils.join(src, MANIFEST)))) {
      const children = await IOUtils.getChildren(src);
      const only = children.length === 1 && children[0];
      if (!only || !(await IOUtils.exists(PathUtils.join(only, MANIFEST)))) {
        throw new Error(`no ${MANIFEST} found`);
      }
      src = only;
    }
    const manifest = await IOUtils.readJSON(PathUtils.join(src, MANIFEST));
    const fallback = src === tmp ? PathUtils.filename(path) : PathUtils.filename(src);
    const id = update ?? (ID_RE.test(manifest?.id ?? "") ? manifest.id : slug(fallback));
    if (!ID_RE.test(id) || RESERVED.has(id)) {
      throw new Error(`"${id}" can't be used as a mod id`);
    }
    const target = PathUtils.join(MODS_DIR, id);
    const inPlace = PathUtils.normalize(src).toLowerCase() === PathUtils.normalize(target).toLowerCase();
    const hasScript = (await files(src, manifest.script, [DEFAULT_FILES.script], [])).length > 0;
    return {
      id,
      name: text(manifest.name, 60) || id,
      version: text(manifest.version, 20),
      src,
      script: hasScript,
      replaces: !inPlace && (await IOUtils.exists(target)) ? mods.get(id)?.name ?? id : null,
      cancel,
      async commit() {
        try {
          if (!inPlace) {
            const wasEnabled = isEnabled(id);
            await IOUtils.remove(target, { recursive: true, ignoreAbsent: true });
            await IOUtils.copy(src, target, { recursive: true });
            if (!update) {
              // New code: ask again before running it.
              setTrusted(id, false);
              if (hasScript) {
                setEnabled(id, false);
              } else if (!wasEnabled) {
                setEnabled(id, true);
              }
            }
          }
          await recordInstall(id);
          await scan();
          return id;
        } finally {
          await cancel();
        }
      },
    };
  } catch (e) {
    await cancel();
    throw e;
  }
}

// ---- updates ----
// A mod can list "updateURL" (its newest mod.json, to read "version" from)
// and "downloadURL" (a .zip of the mod, like Export makes, or of a whole
// repository with #path/to/the/mod's/folder at the end). Both must be
// https (or http on localhost, for testing). Checks run at startup at most
// once per CHECK_INTERVAL while AUTO_CHECK_PREF is on, and from the Mods tab.
// Updating downloads the zip and shows what changed before anything is
// replaced (prepareUpdate). INSTALLED_FILE keeps a hash of each mod's files
// as installed, so edits made since then can be warned about.

const AUTO_CHECK_PREF = PREF_BRANCH + "auto-update-check";
const LAST_CHECK_PREF = PREF_BRANCH + "last-update-check";
const CHECK_INTERVAL = 24 * 60 * 60; // seconds
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const INSTALLED_FILE = PathUtils.join(MODS_DIR, ".installed.json");

function isUpdateURL(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || (protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname));
  } catch {
    return false;
  }
}

// 1.10.0 > 1.9.2; numeric parts compare as numbers, others as text.
function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/);
  const pb = String(b).split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    const diff = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (diff) {
      return Math.sign(diff);
    }
  }
  return 0;
}

async function request(url, type) {
  if (!isUpdateURL(url)) {
    throw new Error(`not an https URL: ${url}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { cache: "no-cache", credentials: "omit", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${[response.status, response.statusText].filter(Boolean).join(" ")} from ${url}`);
    }
    if (type === "json") {
      return await response.json();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD) {
      throw new Error("the download is over 20 MB");
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

// Every file under dir, as paths relative to it ("/"-separated), sorted.
async function listFiles(dir, prefix = "") {
  const out = [];
  for (const child of await IOUtils.getChildren(dir)) {
    const rel = prefix + PathUtils.filename(child);
    if ((await IOUtils.stat(child)).type === "directory") {
      out.push(...(await listFiles(child, `${rel}/`)));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

async function hashDir(dir) {
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.SHA256);
  const encoder = new TextEncoder();
  for (const rel of await listFiles(dir)) {
    const name = encoder.encode(`${rel}\0`);
    hash.update(name, name.length);
    const bytes = await IOUtils.read(PathUtils.join(dir, ...rel.split("/")));
    hash.update(bytes, bytes.length);
  }
  return hash.finish(true);
}

async function readInstalled() {
  try {
    return await IOUtils.readJSON(INSTALLED_FILE);
  } catch {
    return {};
  }
}

async function recordInstall(id) {
  const installed = await readInstalled();
  installed[id] = { hash: await hashDir(PathUtils.join(MODS_DIR, id)), time: Date.now() };
  await IOUtils.writeJSON(INSTALLED_FILE, installed);
}

// Whether the mod's files changed since it was installed or updated through
// the Mods tab (false when that isn't known: copied in by hand).
async function isModifiedLocally(id) {
  const record = (await readInstalled())[id];
  return !!record && record.hash !== (await hashDir(PathUtils.join(MODS_DIR, id)));
}

async function checkMod(mod) {
  mod.update = null;
  mod.updateError = null;
  if (!mod.updateURL) {
    return;
  }
  try {
    const manifest = await request(mod.updateURL, "json");
    const version = text(manifest?.version, 20);
    if (version && compareVersions(version, mod.version || "0") > 0) {
      const downloadURL = isUpdateURL(manifest.downloadURL) ? manifest.downloadURL : mod.downloadURL;
      if (!downloadURL) {
        throw new Error("no downloadURL to get it from");
      }
      mod.update = { version, downloadURL };
    }
  } catch (e) {
    mod.updateError = `Update check failed: ${e.message}`;
  }
}

// Checks every mod with an updateURL (or just `id`). Returns how many have one.
async function checkUpdates(id = null) {
  await ready;
  const list = id ? [mods.get(id)].filter(Boolean) : [...mods.values()];
  await Promise.all(list.filter(m => !m.broken).map(checkMod));
  if (!id) {
    Services.prefs.setIntPref(LAST_CHECK_PREF, Math.floor(Date.now() / 1000));
  }
  notify();
  return [...mods.values()].filter(m => m.update).length;
}

const TEXT_FILE = /\.(css|js|mjs|json|txt|md|svg|html|xhtml)$/i;

async function readForDiff(path) {
  const bytes = await IOUtils.read(path);
  return { bytes, text: TEXT_FILE.test(path) ? new TextDecoder().decode(bytes) : null };
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Downloads the mod's update and compares it with what's installed. Returns
// { id, name, from, to, modified, files: [{ path, status, before, after }],
// commit, cancel }: status is "added", "removed" or "changed"; before/after
// are the texts (null for binary files). Nothing changes until commit().
async function prepareUpdate(id) {
  const mod = mods.get(id);
  if (!mod?.update) {
    throw new Error("no update for this mod");
  }
  await IOUtils.makeDirectory(MODS_DIR, { createAncestors: true });
  const zip = PathUtils.join(MODS_DIR, `.install-${Date.now()}.zip`);
  try {
    await IOUtils.write(zip, await request(mod.update.downloadURL, "bytes"));
    const folder = decodeURIComponent(new URL(mod.update.downloadURL).hash.slice(1)) || null;
    const pending = await prepareInstall(zip, { update: id, folder });
    // updateURL and downloadURL out of step (often a cached zip).
    if (compareVersions(pending.version || "0", mod.version || "0") <= 0) {
      await pending.cancel();
      throw new Error(`the download is version ${pending.version || "?"}, not ${mod.update.version}`);
    }
    const before = await listFiles(mod.dir);
    const after = await listFiles(pending.src);
    const files = [];
    for (const rel of [...new Set([...before, ...after])].sort()) {
      const parts = rel.split("/");
      const a = before.includes(rel) ? await readForDiff(PathUtils.join(mod.dir, ...parts)) : null;
      const b = after.includes(rel) ? await readForDiff(PathUtils.join(pending.src, ...parts)) : null;
      if (a && b && sameBytes(a.bytes, b.bytes)) {
        continue;
      }
      files.push({
        path: rel,
        status: !a ? "added" : !b ? "removed" : "changed",
        before: a?.text ?? null,
        after: b?.text ?? null,
      });
    }
    return {
      id,
      name: mod.name,
      from: mod.version,
      to: pending.version || mod.update.version,
      modified: await isModifiedLocally(id),
      files,
      cancel: pending.cancel,
      async commit() {
        await pending.commit();
        await checkUpdates(id);
      },
    };
  } finally {
    await IOUtils.remove(zip, { ignoreAbsent: true });
  }
}

async function remove(id) {
  const mod = mods.get(id);
  if (!mod) {
    return;
  }
  setEnabled(id, false);
  setTrusted(id, false);
  Services.prefs.getBranch(`${PREF_BRANCH}${id}.`).deleteBranch("");
  await IOUtils.remove(mod.dir, { recursive: true, ignoreAbsent: true });
  await scan();
}

async function exportMod(id, path) {
  const mod = mods.get(id);
  const writer = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
  // PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE
  writer.open(fileOf(path), 0x04 | 0x08 | 0x20);
  try {
    const add = async (dir, prefix) => {
      for (const child of await IOUtils.getChildren(dir)) {
        const name = prefix + PathUtils.filename(child);
        const info = await IOUtils.stat(child);
        if (info.type === "directory") {
          writer.addEntryDirectory(`${name}/`, info.lastModified * 1000, false);
          await add(child, `${name}/`);
        } else {
          writer.addEntryFile(name, Ci.nsIZipWriter.COMPRESSION_DEFAULT, fileOf(child), false);
        }
      }
    };
    writer.addEntryDirectory(`${id}/`, Date.now() * 1000, false);
    await add(mod.dir, `${id}/`);
  } finally {
    writer.close();
  }
}

// ---- settings files (JS/firefox-zen-settings.uc.js) ----

function exportState() {
  const options = {};
  for (const mod of mods.values()) {
    for (const o of mod.options) {
      const value = getOption(mod, o);
      if (value !== o.default) {
        (options[mod.id] ??= {})[o.pref] = value;
      }
    }
  }
  return { enabled: readList(ENABLED_PREF), options };
}

// On/off becomes exactly `state.enabled` for installed mods. A mod with a
// script that isn't trusted here stays off. Returns what couldn't be applied.
function importState(state) {
  const result = { missing: [], held: [] };
  if (!state || typeof state !== "object") {
    return result;
  }
  const wanted = new Set(Array.isArray(state.enabled) ? state.enabled : []);
  const list = readList(ENABLED_PREF).filter(id => !mods.has(id));
  for (const id of wanted) {
    const mod = mods.get(id);
    if (!mod || mod.broken) {
      result.missing.push(id);
    } else if (mod.script && !isTrusted(id)) {
      result.held.push(id);
    } else {
      list.push(id);
    }
  }
  writeList(ENABLED_PREF, list);
  const options = state.options && typeof state.options === "object" ? state.options : {};
  for (const mod of mods.values()) {
    for (const o of mod.options) {
      const value = options[mod.id]?.[o.pref];
      if (value === undefined || !setOption(mod, o, value)) {
        Services.prefs.clearUserPref(prefName(mod.id, o.pref));
      }
    }
  }
  return result;
}

Services.prefs.addObserver(ENABLED_PREF, () => syncContentSheets());
Services.prefs.addObserver(TRUSTED_PREF, () => syncContentSheets());

const ready = scan().catch(e => console.error("Firefox-Zen mods:", e));

// Startup check, once the browser has settled.
setTimeout(() => {
  const last = Services.prefs.getIntPref(LAST_CHECK_PREF, 0);
  if (
    !safeMode &&
    Services.prefs.getBoolPref(AUTO_CHECK_PREF, true) &&
    Date.now() / 1000 - last > CHECK_INTERVAL &&
    [...mods.values()].some(m => m.updateURL)
  ) {
    checkUpdates().catch(e => console.error("Firefox-Zen mods: update check", e));
  }
}, 15000);

export const FzMods = {
  CHANGED_TOPIC,
  PREF_BRANCH,
  ENABLED_PREF,
  dir: MODS_DIR,
  safeMode,
  ready,
  list: () => [...mods.values()],
  get: id => mods.get(id),
  rescan: scan,
  isEnabled,
  isTrusted,
  isActive,
  setEnabled,
  setTrusted,
  reportError,
  prefName,
  getOption,
  setOption,
  isOptionsModified,
  resetOptions,
  fileURL,
  prepareInstall,
  remove,
  exportMod,
  exportState,
  importState,
  checkUpdates,
  prepareUpdate,
  AUTO_CHECK_PREF,
  openFolder: (path = MODS_DIR) => fileOf(path).launch(),
};
