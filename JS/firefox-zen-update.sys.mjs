// ==UserScript==
// @name           Firefox-Zen Updates
// @description    The theme's version, a check for a newer one on GitHub at startup, and updating the chrome folder without losing local edits
// ==/UserScript==

// Background module (loaded once by fx-autoconfig, shared by every window).
// The Library's About tab (JS/firefox-zen-about.uc.js) shows what's here.
//
// Version: chrome/version.json, { version, repository, branch, history }.
// "version" is MAJOR.MINOR.PATCH (see readme_extra.md, Updates). "history" is
// every release, newest first: [{ version, date: "YYYY-MM-DD", notes }]; the
// About tab shows it, and what's new since the installed version. "repository"
// and "branch" say where updates come from, so a fork only edits this file;
// updating keeps the local ones (see mergeVersionFile).
//
// Checks: GitHub's version.json on that branch (raw.githubusercontent.com).
// While AUTO_CHECK_PREF is on (Check at startup): once per Firefox start,
// after the browser has settled. Off: only when asked (Check for updates).
// What it found is kept in prefs (LATEST_PREF, NOTES_PREF: the releases
// newer than this one, as JSON), so every window
// can show it right away at the next start, before any new check.
//
// Updating, two kinds of install:
// - git checkout (chrome/.git, the installer's choice when git is there):
//   `git pull --ff-only`, which stops instead of overwriting local changes.
// - downloaded files: the branch's zip from GitHub, compared file by file
//   with what's on disk and with RECORD_FILE (each file's hash as the theme
//   shipped it), so a file edited here is told apart from one the update
//   changes. Nothing changes until commit(); every file it replaces or
//   removes is copied to BACKUP_DIR first. chrome/mods (but mods/example) and
//   chrome/.firefox-zen are never touched.
// An install without RECORD_FILE (the installer, or an older version) gets
// one at startup from the files on disk: they count as unedited from then on.
//
// For trying a release locally, set DEV_PREF to a http://localhost:<port>
// folder serving version.json and main.zip, and restart: updates then come
// from there instead of GitHub.
//
// Updated scripts load at the next start (the startup cache is dropped then).
// The loader in Firefox's install folder (program/) can't be written from
// here: when it changed, the About tab says to run the installer again.

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const PREF_BRANCH = "firefox-zen.update.";
const AUTO_CHECK_PREF = PREF_BRANCH + "auto-check";
const LAST_CHECK_PREF = PREF_BRANCH + "last-check";
// The newest version found on GitHub and its notes.
const LATEST_PREF = PREF_BRANCH + "latest";
const NOTES_PREF = PREF_BRANCH + "latest-notes";
// The newest version whose About tab was opened: until then the Library
// button shows the update icon and opens on About.
const SEEN_PREF = PREF_BRANCH + "seen";
const DEV_PREF = PREF_BRANCH + "dev-url";
const CHANGED_TOPIC = "firefox-zen-update-changed";

const MAX_DOWNLOAD = 20 * 1024 * 1024;
const MAX_HASHED = 5 * 1024 * 1024;

const CHROME_DIR = PathUtils.join(PathUtils.profileDir, "chrome");
const VERSION_FILE = "version.json";
const STATE_DIR = PathUtils.join(CHROME_DIR, ".firefox-zen");
const RECORD_FILE = PathUtils.join(STATE_DIR, "installed.json");
const BACKUP_DIR = PathUtils.join(STATE_DIR, "backups");

const DEFAULT_REPO = "https://github.com/ishid4/Firefox-Zen";
const REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
// Text files hash with CRLF read as LF: git can check them out either way.
const TEXT_FILE = /\.(css|js|mjs|json|txt|md|svg|html|xhtml|manifest|ps1|sh|yml|yaml)$|(^|\/)(LICENSE[^/]*|\.git\w+)$/i;

const text = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ---- paths ----

// Relative paths ("/"-separated) the updater leaves alone: git's and our own
// state, and the user's mods (the theme only ships mods/example).
function isSkipped(rel) {
  const p = `${rel}/`;
  return (
    p.startsWith(".git/") ||
    p.startsWith(".firefox-zen/") ||
    (p.startsWith("mods/") && p !== "mods/" && !p.startsWith("mods/example/"))
  );
}

function resolveIn(dir, rel) {
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || parts.some(x => x === "." || x === ".." || /[\\:\0]/.test(x))) {
    return null;
  }
  return PathUtils.join(dir, ...parts);
}

const fileOf = path => {
  const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  f.initWithPath(path);
  return f;
};

// Every file under dir as relative paths, sorted, without skipped ones.
async function listFiles(dir, prefix = "") {
  const out = [];
  let children = [];
  try {
    children = await IOUtils.getChildren(dir);
  } catch {
    return out;
  }
  for (const child of children) {
    const rel = prefix + PathUtils.filename(child);
    if (isSkipped(rel)) {
      continue;
    }
    const info = await IOUtils.stat(child).catch(() => null);
    if (info?.type === "directory") {
      out.push(...(await listFiles(child, `${rel}/`)));
    } else if (info) {
      out.push(rel);
    }
  }
  return out.sort();
}

// ---- versions ----

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

function parseVersionFile(data) {
  const repo = text(data?.repository);
  const branch = text(data?.branch, 100);
  return {
    version: VERSION_RE.test(text(data?.version, 40)) ? text(data.version, 40) : null,
    repository: REPO_RE.test(repo) ? repo.replace(/(\.git)?\/?$/, "") : DEFAULT_REPO,
    branch: BRANCH_RE.test(branch) ? branch : "main",
    history: parseHistory(data),
  };
}

// [{ version, date, notes }], newest first. An older version.json with only
// "notes" gives one entry.
function parseHistory(data) {
  const list = Array.isArray(data?.history) ? data.history : [];
  const out = [];
  for (const e of list.slice(0, 200)) {
    const version = text(e?.version, 40);
    if (VERSION_RE.test(version) && !out.some(x => x.version === version)) {
      const date = text(e.date, 10);
      out.push({ version, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null, notes: text(e.notes, 4000) });
    }
  }
  const version = text(data?.version, 40);
  if (VERSION_RE.test(version) && !out.some(x => x.version === version)) {
    out.push({ version, date: null, notes: text(data?.notes, 4000) });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

function readNewer() {
  try {
    const list = JSON.parse(Services.prefs.getStringPref(NOTES_PREF, "[]"));
    return Array.isArray(list) ? list : [];
  } catch {
    return []; // the 1.0.0 format: plain text
  }
}

// version.json on disk now (what the next start runs, after an update).
async function readLocal() {
  let data = null;
  try {
    data = await IOUtils.readJSON(PathUtils.join(CHROME_DIR, VERSION_FILE));
  } catch {}
  return {
    ...parseVersionFile(data),
    git: await IOUtils.exists(PathUtils.join(CHROME_DIR, ".git")),
  };
}

const devURL = (() => {
  const url = Services.prefs.getStringPref(DEV_PREF, "").replace(/\/+$/, "");
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "http:" && ["localhost", "127.0.0.1"].includes(hostname) ? url : null;
  } catch {
    return null;
  }
})();

const rawURL = l => {
  if (devURL) {
    return `${devURL}/${VERSION_FILE}`;
  }
  const [, owner, repo] = l.repository.match(REPO_RE);
  return `https://raw.githubusercontent.com/${owner}/${repo}/${l.branch}/${VERSION_FILE}`;
};
const zipURL = l => (devURL ? `${devURL}/main.zip` : `${l.repository}/archive/refs/heads/${l.branch}.zip`);

// ---- state ----

let local = { version: null, repository: DEFAULT_REPO, branch: "main", history: [], git: false };
let checking = false;
let lastError = null;
// { to, backup, git } after an update this session: a restart loads it.
let updated = null;
// { version, count, backup } after a restore this session: a restart loads it.
let restored = null;

const notify = () => Services.obs.notifyObservers(null, CHANGED_TOPIC);

function status() {
  const latest = Services.prefs.getStringPref(LATEST_PREF, "");
  const available = !!latest && !!local.version && compareVersions(latest, local.version) > 0;
  return {
    version: local.version,
    repository: local.repository,
    branch: local.branch,
    // Releases up to this one, newest first.
    history: local.history.filter(e => !local.version || compareVersions(e.version, local.version) <= 0),
    git: local.git,
    latest: latest || null,
    // Releases newer than this one (what an update brings), newest first.
    newer: available ? readNewer().filter(e => compareVersions(e.version, local.version) > 0) : [],
    available,
    unseen: available && Services.prefs.getStringPref(SEEN_PREF, "") !== latest,
    checkedAt: Services.prefs.getIntPref(LAST_CHECK_PREF, 0) * 1000 || null,
    checking,
    error: lastError,
    updated,
    restored,
    dir: CHROME_DIR,
    backupDir: BACKUP_DIR,
  };
}

function markSeen() {
  const { available, latest } = status();
  if (available) {
    Services.prefs.setStringPref(SEEN_PREF, latest);
  }
}

// ---- network ----

async function request(url, type) {
  if (!url.startsWith("https://") && !(devURL && url.startsWith(devURL))) {
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

async function check() {
  if (checking) {
    return status();
  }
  checking = true;
  notify();
  try {
    local = await readLocal();
    const remote = parseVersionFile(await request(rawURL(local), "json"));
    if (!remote.version) {
      throw new Error(`no version in ${rawURL(local)}`);
    }
    Services.prefs.setStringPref(LATEST_PREF, remote.version);
    const newer = remote.history.filter(e => !local.version || compareVersions(e.version, local.version) > 0);
    Services.prefs.setStringPref(NOTES_PREF, JSON.stringify(newer.slice(0, 30)));
    lastError = null;
  } catch (e) {
    lastError = `Update check failed: ${e.message}`;
  } finally {
    Services.prefs.setIntPref(LAST_CHECK_PREF, Math.floor(Date.now() / 1000));
    checking = false;
    notify();
  }
  return status();
}

// ---- hashes and the install record ----

const looksBinary = bytes => bytes.subarray(0, 8000).includes(0);

function normalize(rel, bytes) {
  if (!TEXT_FILE.test(rel) || looksBinary(bytes)) {
    return bytes;
  }
  // Drop the CR of every CRLF.
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (!(bytes[i] === 13 && bytes[i + 1] === 10)) {
      out[n++] = bytes[i];
    }
  }
  return out.subarray(0, n);
}

function hashBytes(rel, bytes) {
  const data = normalize(rel, bytes);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(Ci.nsICryptoHash.SHA256);
  hash.update(data, data.length);
  return hash.finish(true);
}

async function hashFile(dir, rel) {
  const path = resolveIn(dir, rel);
  const info = await IOUtils.stat(path).catch(() => null);
  if (!info || info.type !== "regular") {
    return null;
  }
  if (info.size > MAX_HASHED) {
    return `size:${info.size}:${info.lastModified}`;
  }
  return hashBytes(rel, await IOUtils.read(path));
}

async function readRecord() {
  try {
    const r = await IOUtils.readJSON(RECORD_FILE);
    if (r && typeof r.files === "object") {
      return r;
    }
  } catch {}
  return null;
}

async function writeRecord(record) {
  await IOUtils.makeDirectory(STATE_DIR, { createAncestors: true });
  await IOUtils.writeJSON(RECORD_FILE, record);
}

// A downloaded-files install's record, made from the files on disk when
// there's none for this version (installed or updated outside Firefox).
async function ensureRecord() {
  if (local.git) {
    return null;
  }
  const record = await readRecord();
  if (record && record.version === local.version) {
    return record;
  }
  const files = {};
  for (const rel of await listFiles(CHROME_DIR)) {
    files[rel] = await hashFile(CHROME_DIR, rel);
  }
  const fresh = { version: local.version, source: "baseline", time: Date.now(), files };
  await writeRecord(fresh);
  return fresh;
}

// ---- local changes ----

const WIN = Services.appinfo.OS === "WINNT";

// PATH as Windows has it saved (machine, then user): Firefox started from
// Explorer has it as "Path", which Subprocess.pathSearch doesn't read, and a
// Firefox started before git was installed doesn't have it at all.
function registryPath() {
  const out = [];
  const read = (root, key) => {
    const reg = Cc["@mozilla.org/windows-registry-key;1"].createInstance(Ci.nsIWindowsRegKey);
    try {
      reg.open(root, key, Ci.nsIWindowsRegKey.ACCESS_READ);
      if (reg.hasValue("Path")) {
        out.push(reg.readStringValue("Path"));
      }
    } catch {
    } finally {
      reg.close();
    }
  };
  read(Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE, "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment");
  read(Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER, "Environment");
  return out.join(";");
}

// %VAR% in a registry PATH entry.
const expand = dir => dir.replace(/%([^%]+)%/g, (m, name) => Services.env.get(name) || m);

function gitCandidates() {
  const name = WIN ? "git.exe" : "git";
  const sep = WIN ? ";" : ":";
  const dirs = [Services.env.get("PATH"), WIN ? registryPath() : ""]
    .join(sep)
    .split(sep)
    .map(d => expand(d.trim().replace(/^"|"$/g, "")))
    .filter(Boolean);
  if (WIN) {
    const pf = Services.env.get("ProgramFiles") || "C:\\Program Files";
    const pf86 = Services.env.get("ProgramFiles(x86)") || "C:\\Program Files (x86)";
    const local = Services.env.get("LOCALAPPDATA");
    dirs.push(`${pf}\\Git\\cmd`, `${pf}\\Git\\bin`, `${pf86}\\Git\\cmd`);
    if (local) {
      dirs.push(`${local}\\Programs\\Git\\cmd`);
    }
  } else {
    dirs.push("/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin");
  }
  return [...new Set(dirs)].map(d => {
    try {
      return PathUtils.join(d, name);
    } catch {
      return null; // not an absolute path
    }
  });
}

// Found once; not finding it is tried again next time (git installed since).
let gitPath = null;
async function findGit() {
  if (gitPath) {
    return gitPath;
  }
  for (const path of gitCandidates()) {
    if (path && (await IOUtils.exists(path).catch(() => false))) {
      return (gitPath = path);
    }
  }
  return null;
}

// What to run by hand when Firefox can't.
const gitCommand = () => `git -C "${CHROME_DIR}" pull --ff-only`;

async function run(command, args) {
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const proc = await Subprocess.call({
    command,
    arguments: args,
    workdir: CHROME_DIR,
    stderr: "stdout",
    environmentAppend: true,
    // No credential prompt that nobody can answer.
    environment: { GIT_TERMINAL_PROMPT: "0" },
  });
  let output = "";
  let chunk;
  while ((chunk = await proc.stdout.readString())) {
    output += chunk;
  }
  const { exitCode } = await proc.wait();
  return { exitCode, output };
}

// Files that differ from the theme as installed:
// [{ path, state: "edited" | "added" | "missing" }]. "added" is a file the
// theme didn't ship. Git checkouts ask git.
async function localChanges() {
  await ready;
  if (local.git) {
    const git = await findGit();
    if (!git) {
      throw new Error("git wasn't found, so changes can't be listed");
    }
    const { exitCode, output } = await run(git, ["-c", "core.quotepath=off", "status", "--porcelain=v1", "--untracked-files=all"]);
    if (exitCode) {
      throw new Error(output.trim() || `git status exited with ${exitCode}`);
    }
    return output
      .split("\n")
      .filter(line => line.length > 3)
      .map(line => {
        const code = line.slice(0, 2);
        const path = line.slice(3).replace(/^"|"$/g, "").replace(/^.* -> /, "");
        return { path, state: code === "??" ? "added" : code.includes("D") ? "missing" : "edited" };
      })
      .filter(c => !isSkipped(c.path));
  }
  const record = await ensureRecord();
  const out = [];
  for (const [rel, hash] of Object.entries(record.files)) {
    const now = await hashFile(CHROME_DIR, rel);
    if (now === null) {
      out.push({ path: rel, state: "missing" });
    } else if (now !== hash) {
      out.push({ path: rel, state: "edited" });
    }
  }
  for (const rel of await listFiles(CHROME_DIR)) {
    if (!(rel in record.files)) {
      out.push({ path: rel, state: "added" });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// The scripts in chrome/JS with their header: [{ file, name, description,
// background }]. background: a .sys.mjs module, loaded once.
async function scripts() {
  const dir = PathUtils.join(CHROME_DIR, "JS");
  const out = [];
  for (const path of await IOUtils.getChildren(dir).catch(() => [])) {
    const file = PathUtils.filename(path);
    if (!/\.(uc\.js|uc\.mjs|sys\.mjs)$/.test(file)) {
      continue;
    }
    let head = "";
    try {
      head = new TextDecoder().decode((await IOUtils.read(path, { maxBytes: 2048 })));
    } catch {}
    const field = key => text(head.match(new RegExp(`^//\\s*@${key}\\s+(.+)$`, "m"))?.[1] ?? "", 300);
    out.push({
      file: `JS/${file}`,
      name: field("name") || file,
      description: field("description"),
      background: file.endsWith(".sys.mjs") || /^\/\/\s*@backgroundmodule\b/m.test(head),
    });
  }
  return out.sort((a, b) => a.background - b.background || a.name.localeCompare(b.name));
}

// ---- updating ----

async function extractZip(zip, into) {
  const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
  reader.open(fileOf(zip));
  try {
    const names = [];
    const entries = reader.findEntries(null);
    while (entries.hasMore()) {
      names.push(entries.getNext());
    }
    // GitHub's zips hold one folder, <repo>-<branch>/.
    const top = names[0]?.slice(0, names[0].indexOf("/") + 1);
    const prefix = top && names.every(n => n.startsWith(top)) ? top : "";
    for (const name of names) {
      const rel = name.slice(prefix.length);
      if (!rel || rel.endsWith("/")) {
        continue;
      }
      const target = resolveIn(into, rel);
      if (!target) {
        throw new Error(`unsafe path in zip: ${rel}`);
      }
      await IOUtils.makeDirectory(PathUtils.parent(target), { createAncestors: true });
      reader.extract(name, fileOf(target));
      // GitHub's zips can mark files read-only.
      await IOUtils.setPermissions(target, 0o644, false);
    }
  } finally {
    reader.close();
  }
}

const decode = (rel, bytes) =>
  bytes && TEXT_FILE.test(rel) && !looksBinary(bytes) ? new TextDecoder().decode(bytes) : null;

// The loader files the installer copies into Firefox's install folder, and
// whether the new version's differ from the ones there.
async function loaderChanged(src) {
  const gre = Services.dirsvc.get("GreD", Ci.nsIFile).path;
  const pairs = [
    ["program/config.js", PathUtils.join(gre, "config.js")],
    ["program/defaults/pref/config-prefs.js", PathUtils.join(gre, "defaults", "pref", "config-prefs.js")],
  ];
  for (const [rel, installed] of pairs) {
    const from = resolveIn(src, rel);
    if (!(await IOUtils.exists(from))) {
      continue;
    }
    const a = hashBytes(rel, await IOUtils.read(from));
    const b = (await IOUtils.exists(installed)) ? hashBytes(rel, await IOUtils.read(installed)) : null;
    if (a !== b) {
      return true;
    }
  }
  return false;
}

// version.json from the update, but with this install's repository and
// branch when they were changed here (a fork): edited links stay. Returns
// null when there's nothing to keep (the file is then copied as it is, so it
// doesn't read as edited).
async function mergeVersionFile(srcPath, record) {
  const incoming = await IOUtils.readJSON(srcPath);
  let merged = false;
  let mine = null;
  try {
    mine = await IOUtils.readJSON(PathUtils.join(CHROME_DIR, VERSION_FILE));
  } catch {}
  const shipped = record?.files?.[VERSION_FILE];
  const edited = mine && shipped && shipped !== (await hashFile(CHROME_DIR, VERSION_FILE));
  if (edited || (mine && !shipped)) {
    for (const key of ["repository", "branch"]) {
      if (typeof mine[key] === "string" && mine[key] !== incoming[key]) {
        incoming[key] = mine[key];
        merged = true;
      }
    }
  }
  return merged ? JSON.stringify(incoming, null, 2) + "\n" : null;
}

// Downloads the newest version and compares it with the files here. Returns
// { from, to, newer, url, loader, items, cancel, commit(paths) } (newer: the
// releases it brings, from its history); each item
// is { path, status: "added" | "changed" | "removed", edited, apply, before,
// after } (before/after: texts, null when binary or absent). edited: the file
// here isn't what the theme shipped. apply: the suggested choice. Files
// edited here that the update doesn't change aren't listed: they stay.
async function prepareUpdate() {
  await ready;
  local = await readLocal();
  if (local.git) {
    throw new Error("this install is a git checkout: update it with git");
  }
  const record = await ensureRecord();
  const tmp = PathUtils.join(STATE_DIR, `update-${Date.now()}`);
  await IOUtils.makeDirectory(tmp, { createAncestors: true });
  const cancel = () => IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true }).catch(() => {});
  try {
    const url = zipURL(local);
    const zip = PathUtils.join(tmp, "download.zip");
    await IOUtils.write(zip, await request(url, "bytes"));
    const src = PathUtils.join(tmp, "files");
    await extractZip(zip, src);
    let meta = null;
    try {
      meta = parseVersionFile(await IOUtils.readJSON(PathUtils.join(src, VERSION_FILE)));
    } catch {}
    if (!meta?.version || compareVersions(meta.version, local.version ?? "0") <= 0) {
      throw new Error(`the download is version ${meta?.version ?? "?"}, not newer than ${local.version ?? "?"}`);
    }

    const incoming = await listFiles(src);
    const shipped = {};
    const items = [];
    for (const rel of incoming) {
      const after = await IOUtils.read(resolveIn(src, rel));
      shipped[rel] = hashBytes(rel, after);
      if (rel === VERSION_FILE) {
        continue; // always written, merged (mergeVersionFile)
      }
      const target = resolveIn(CHROME_DIR, rel);
      const info = await IOUtils.stat(target).catch(() => null);
      if (!info) {
        items.push({ path: rel, status: "added", edited: false, apply: true, before: null, after: decode(rel, after) });
        continue;
      }
      const before = info.type === "regular" ? await IOUtils.read(target) : null;
      const mine = before ? hashBytes(rel, before) : null;
      if (mine === shipped[rel]) {
        continue;
      }
      const base = record.files[rel];
      const edited = mine !== base;
      if (edited && base === shipped[rel]) {
        continue; // edited here, unchanged by the update: keep it
      }
      items.push({
        path: rel,
        status: "changed",
        edited,
        apply: true,
        before: decode(rel, before),
        after: decode(rel, after),
      });
    }
    for (const [rel, base] of Object.entries(record.files)) {
      if (rel in shipped || isSkipped(rel)) {
        continue;
      }
      const target = resolveIn(CHROME_DIR, rel);
      if (!(await IOUtils.exists(target))) {
        continue;
      }
      const edited = (await hashFile(CHROME_DIR, rel)) !== base;
      // A record made from the disk may list the user's own files too: only
      // offer to remove what's surely the theme's (an old script would still run).
      const ours = record.source === "download" || /^JS\/firefox-zen-[^/]+\.(uc\.js|sys\.mjs)$/.test(rel);
      const bytes = await IOUtils.read(target).catch(() => null);
      items.push({ path: rel, status: "removed", edited, apply: ours && !edited, before: decode(rel, bytes), after: null });
    }
    items.sort((a, b) => b.edited - a.edited || a.path.localeCompare(b.path));

    return {
      from: local.version,
      to: meta.version,
      newer: meta.history.filter(e => compareVersions(e.version, local.version ?? "0") > 0),
      url,
      loader: await loaderChanged(src),
      items,
      cancel,
      // Applies the items whose path is in `paths` (default: the suggested
      // ones). Returns where the replaced files were saved, or null.
      async commit(paths = items.filter(i => i.apply).map(i => i.path)) {
        const chosen = new Set(paths);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const backup = PathUtils.join(BACKUP_DIR, `${local.version}-to-${meta.version}-${stamp}`);
        let saved = 0;
        const save = async rel => {
          const from = resolveIn(CHROME_DIR, rel);
          if (await IOUtils.exists(from)) {
            const to = resolveIn(backup, rel);
            await IOUtils.makeDirectory(PathUtils.parent(to), { createAncestors: true });
            await IOUtils.copy(from, to);
            saved++;
          }
        };
        try {
          for (const item of items) {
            if (!chosen.has(item.path)) {
              continue;
            }
            await save(item.path);
            const target = resolveIn(CHROME_DIR, item.path);
            if (item.status === "removed") {
              await IOUtils.remove(target, { ignoreAbsent: true });
            } else {
              await IOUtils.makeDirectory(PathUtils.parent(target), { createAncestors: true });
              await IOUtils.copy(resolveIn(src, item.path), target);
              await IOUtils.setPermissions(target, 0o644, false);
            }
          }
          // Last, so a failure above leaves the old version number.
          await save(VERSION_FILE);
          const merged = await mergeVersionFile(PathUtils.join(src, VERSION_FILE), record);
          if (merged) {
            await IOUtils.writeUTF8(PathUtils.join(CHROME_DIR, VERSION_FILE), merged);
          } else {
            await IOUtils.copy(PathUtils.join(src, VERSION_FILE), PathUtils.join(CHROME_DIR, VERSION_FILE));
          }
          // What the theme shipped: a file kept as edited still reads as edited.
          await writeRecord({ version: meta.version, source: "download", time: Date.now(), files: shipped });
          Services.appinfo.invalidateCachesOnRestart();
          local = await readLocal();
          updated = { to: meta.version, backup: saved ? backup : null, loader: await loaderChanged(src), git: false };
          notify();
          return updated.backup;
        } catch (e) {
          e.message += saved ? ` (replaced files so far are saved in ${backup})` : "";
          throw e;
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

// ---- restoring ----
// Puts back the files of the installed version as Firefox-Zen shipped them:
// edited ones get the original again, deleted ones come back. Files the
// theme doesn't ship (your own) and chrome/mods stay. Like updating, it lists
// every file first ({ version, source, items, cancel, commit(paths) }, items
// as in prepareUpdate, with `label`), and saves what it replaces in
// BACKUP_DIR. version.json keeps its repository and branch.
// Downloaded files: the version's zip, from the tag v<version> (each release
// is tagged), else the branch's zip when that is still the same version.
// git checkouts: the files of the checked-out commit (git checkout HEAD).

const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function backupTo(backup, rel) {
  const from = resolveIn(CHROME_DIR, rel);
  if (!(await IOUtils.exists(from))) {
    return false;
  }
  const to = resolveIn(backup, rel);
  await IOUtils.makeDirectory(PathUtils.parent(to), { createAncestors: true });
  await IOUtils.copy(from, to);
  return true;
}

async function prepareRestore() {
  await ready;
  local = await readLocal();
  if (!local.version) {
    throw new Error("version.json is missing or has no version, so the original files aren't known");
  }
  return local.git ? prepareGitRestore() : prepareFilesRestore();
}

async function prepareFilesRestore() {
  const record = await ensureRecord();
  const tmp = PathUtils.join(STATE_DIR, `update-${Date.now()}`);
  await IOUtils.makeDirectory(tmp, { createAncestors: true });
  const cancel = () => IOUtils.remove(tmp, { recursive: true, ignoreAbsent: true }).catch(() => {});
  try {
    const tagURL = devURL ? `${devURL}/v${local.version}.zip` : `${local.repository}/archive/refs/tags/v${local.version}.zip`;
    const zip = PathUtils.join(tmp, "download.zip");
    const src = PathUtils.join(tmp, "files");
    let url = null;
    for (const candidate of [tagURL, zipURL(local)]) {
      try {
        await IOUtils.write(zip, await request(candidate, "bytes"));
      } catch {
        continue;
      }
      await IOUtils.remove(src, { recursive: true, ignoreAbsent: true });
      await extractZip(zip, src);
      let meta = null;
      try {
        meta = parseVersionFile(await IOUtils.readJSON(PathUtils.join(src, VERSION_FILE)));
      } catch {}
      if (meta?.version === local.version) {
        url = candidate;
        break;
      }
    }
    if (!url) {
      throw new Error(
        `couldn't download version ${local.version}'s files (no tag v${local.version}, and the branch has moved on). ` +
          "Updating to the newest version also brings back its files."
      );
    }

    const shipped = {};
    const items = [];
    for (const rel of await listFiles(src)) {
      const after = await IOUtils.read(resolveIn(src, rel));
      shipped[rel] = hashBytes(rel, after);
      if (rel === VERSION_FILE) {
        continue; // written merged (mergeVersionFile)
      }
      const target = resolveIn(CHROME_DIR, rel);
      const info = await IOUtils.stat(target).catch(() => null);
      const before = info?.type === "regular" ? await IOUtils.read(target) : null;
      if (before && hashBytes(rel, before) === shipped[rel]) {
        continue;
      }
      items.push({
        path: rel,
        status: before ? "changed" : "added",
        label: before ? "Edited" : "Missing",
        edited: !!before,
        apply: true,
        before: decode(rel, before),
        after: decode(rel, after),
      });
    }
    items.sort((a, b) => a.path.localeCompare(b.path));

    return {
      version: local.version,
      source: url,
      items,
      cancel,
      async commit(paths = items.map(i => i.path)) {
        const chosen = new Set(paths);
        const backup = PathUtils.join(BACKUP_DIR, `restore-${local.version}-${stampNow()}`);
        let saved = 0;
        try {
          for (const item of items.filter(i => chosen.has(i.path))) {
            saved += (await backupTo(backup, item.path)) ? 1 : 0;
            const target = resolveIn(CHROME_DIR, item.path);
            await IOUtils.makeDirectory(PathUtils.parent(target), { createAncestors: true });
            await IOUtils.copy(resolveIn(src, item.path), target);
            await IOUtils.setPermissions(target, 0o644, false);
          }
          const merged = await mergeVersionFile(PathUtils.join(src, VERSION_FILE), record);
          if (merged) {
            await IOUtils.writeUTF8(PathUtils.join(CHROME_DIR, VERSION_FILE), merged);
          } else {
            saved += (await backupTo(backup, VERSION_FILE)) ? 1 : 0;
            await IOUtils.copy(PathUtils.join(src, VERSION_FILE), PathUtils.join(CHROME_DIR, VERSION_FILE));
          }
          await writeRecord({ version: local.version, source: "download", time: Date.now(), files: shipped });
          return finishRestore(chosen.size, saved ? backup : null);
        } catch (e) {
          e.message += saved ? ` (replaced files so far are saved in ${backup})` : "";
          throw e;
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

async function prepareGitRestore() {
  const git = await findGit();
  if (!git) {
    throw Object.assign(new Error("Firefox couldn't find git. Install it from git-scm.com, or run this in a terminal:"), {
      command: `git -C "${CHROME_DIR}" checkout HEAD -- .`,
    });
  }
  const { exitCode, output } = await run(git, ["-c", "core.quotepath=off", "status", "--porcelain=v1", "--untracked-files=no"]);
  if (exitCode) {
    throw new Error(output.trim() || `git status exited with ${exitCode}`);
  }
  const items = [];
  for (const line of output.split("\n")) {
    const code = line.slice(0, 2);
    const rel = line.slice(3).trim().replace(/^"|"$/g, "");
    // Not in the commit (added, renamed): nothing to restore it to.
    if (line.length < 4 || code.includes("A") || code.includes("R") || isSkipped(rel)) {
      continue;
    }
    const missing = code.includes("D");
    const target = resolveIn(CHROME_DIR, rel);
    const before = missing || !target ? null : await IOUtils.read(target).catch(() => null);
    const shown = TEXT_FILE.test(rel) ? await run(git, ["show", `HEAD:${rel}`]).catch(() => null) : null;
    items.push({
      path: rel,
      status: before ? "changed" : "added",
      label: before ? "Edited" : "Missing",
      edited: !!before,
      apply: true,
      before: decode(rel, before),
      after: shown && !shown.exitCode ? shown.output : null,
    });
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return {
    version: local.version,
    source: "git (the checked-out commit)",
    items,
    cancel: async () => {},
    async commit(paths = items.map(i => i.path)) {
      const backup = PathUtils.join(BACKUP_DIR, `restore-${local.version}-${stampNow()}`);
      let saved = 0;
      for (const rel of paths) {
        saved += (await backupTo(backup, rel)) ? 1 : 0;
      }
      if (paths.length) {
        const r = await run(git, ["checkout", "HEAD", "--", ...paths]);
        if (r.exitCode) {
          throw new Error((r.output.trim() || `git checkout exited with ${r.exitCode}`) + (saved ? ` (your files are saved in ${backup})` : ""));
        }
      }
      return finishRestore(paths.length, saved ? backup : null);
    },
  };
}

function finishRestore(count, backup) {
  Services.appinfo.invalidateCachesOnRestart();
  restored = { version: local.version, count, backup };
  notify();
  return backup;
}

// A git checkout: git pull --ff-only. Returns git's output. Errors carry
// `command` (what to run in a terminal instead) and `kind`: "no-git",
// "pull" (git refused, its output is the message), "version-edited" (pulled,
// but a locally edited version.json still names an older version) or
// "behind" (git is up to date, yet GitHub has a newer version).
async function gitPull() {
  await ready;
  const fail = (message, kind) => Object.assign(new Error(message), { kind, command: gitCommand() });
  const git = await findGit();
  if (!git) {
    throw fail("Firefox couldn't find git. Install it from git-scm.com, or run this in a terminal:", "no-git");
  }
  const before = local.version;
  let result;
  try {
    result = await run(git, ["pull", "--ff-only"]);
  } catch (e) {
    throw fail(`Couldn't run ${git}: ${e.message}`, "no-git");
  }
  const { exitCode, output } = result;
  if (exitCode) {
    throw fail(output.trim() || `git pull exited with ${exitCode}`, "pull");
  }
  local = await readLocal();
  if (local.version !== before) {
    Services.appinfo.invalidateCachesOnRestart();
    updated = { to: local.version, backup: null, loader: false, git: true };
  }
  notify();
  // Pulled (or already up to date), yet still older than GitHub: git keeps
  // a version.json edited here, which then names an old version.
  const { available, latest } = status();
  if (available) {
    const edited = await run(git, ["status", "--porcelain", "--", VERSION_FILE]).catch(() => null);
    if (edited?.output.trim()) {
      throw Object.assign(
        new Error(
          `git is up to date, but version.json here was edited and says ${local.version} (GitHub has ${latest}). ` +
            "git keeps local edits, so restore the file to get the shipped one:"
        ),
        { kind: "version-edited", command: `git -C "${CHROME_DIR}" restore ${VERSION_FILE}` }
      );
    }
    throw fail(
      `git says "${output.trim().split("\n").pop()}", but GitHub has ${latest} and this checkout is ${local.version}. ` +
        "It may follow another remote or branch than the one in version.json.",
      "behind"
    );
  }
  return output.trim();
}

function restart() {
  const cancel = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
  Services.obs.notifyObservers(cancel, "quit-application-requested", "restart");
  if (!cancel.data) {
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
  }
}

// ---- startup ----

const ready = (async () => {
  local = await readLocal();
  // Leftovers of an update that didn't finish (Firefox closed meanwhile).
  for (const child of await IOUtils.getChildren(STATE_DIR).catch(() => [])) {
    if (PathUtils.filename(child).startsWith("update-")) {
      await IOUtils.remove(child, { recursive: true, ignoreAbsent: true }).catch(() => {});
    }
  }
  notify();
})().catch(e => console.error("Firefox-Zen update:", e));

// One check per Firefox start, once the browser has settled; off, only the
// About tab's Check for updates checks.
function autoCheck() {
  if (Services.prefs.getBoolPref(AUTO_CHECK_PREF, true)) {
    check().catch(e => console.error("Firefox-Zen update check:", e));
  }
}
setTimeout(() => {
  ready
    .then(() => ensureRecord())
    .catch(e => console.error("Firefox-Zen update: install record", e))
    .then(autoCheck);
}, 20000);

export const FzUpdate = {
  CHANGED_TOPIC,
  PREF_BRANCH,
  AUTO_CHECK_PREF,
  ready,
  status,
  check,
  markSeen,
  localChanges,
  scripts,
  prepareUpdate,
  prepareRestore,
  gitPull,
  restart,
  openFolder: path => {
    const f = fileOf(path ?? CHROME_DIR);
    if (f.exists()) {
      f.launch();
    }
  },
};
