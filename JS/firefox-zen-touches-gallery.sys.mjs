// ==UserScript==
// @name           Firefox-Zen Touches gallery
// @description    Touches others published: the gallery's index, GitHub sign-in, publishing and likes
// ==/UserScript==

// Background module (loaded once by fx-autoconfig, shared by every window).
// The window side is in JS/firefox-zen-touches.uc.js.
//
// The gallery lives in the store's repository (REPO, Firefox-Zen-Mods):
// - A published touch is an issue there with the touch in it; the repo's
//   Touches workflow checks it and commits touches/<issue>.json, no pull
//   request (scripts/touches.mjs there). Editing the issue updates it,
//   closing it takes it down.
// - The store site has touches/index.json (every listed touch with its likes)
//   and touches/<issue>.json. The whole index is downloaded, at most hourly,
//   so nothing tells the gallery which sites you visit.
// - A like is a 👍 on the touch's issue.
//
// Publishing and liking need a GitHub account: sign-in is GitHub's device
// flow for the Firefox-Zen Touches GitHub App (CLIENT_ID): a code to enter on
// github.com, no password typed here. The token goes into Firefox's saved
// logins (encrypted with the Primary Password, if there is one) and can only
// do what the app may: issues and reactions on REPO.

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { FzStore } from "chrome://userscripts/content/firefox-zen-store.sys.mjs";
import { matchesScope } from "chrome://userscripts/content/FzTouch/FzTouchScope.sys.mjs";

// The GitHub App's client id (github.com → Settings → Developer settings →
// GitHub Apps → the app). Empty: publishing and likes say they aren't set up.
const CLIENT_ID = "";

const PREF_BRANCH = "firefox-zen.touches.";
const pref = (name, fallback) => Services.prefs.getStringPref(PREF_BRANCH + name, fallback);
// Overrides, for forks and for testing against local stand-ins.
const REPO = () => pref("gallery-repo", "ishid4/Firefox-Zen-Mods");
const GALLERY_URL = () => pref("gallery-url", `${FzStore.STORE_URL}touches/`);
const API = () => pref("github-api", "https://api.github.com");
const WEB = () => pref("github-web", "https://github.com");
const clientId = () => pref("github-client-id", CLIENT_ID);

const LOGIN_PREF = PREF_BRANCH + "github-user";
const LIKES_PREF = PREF_BRANCH + "liked";
const CHANGED_TOPIC = "firefox-zen-touches-gallery-changed";
const STATE_DIR = PathUtils.join(PathUtils.profileDir, "chrome", ".firefox-zen");
const CACHE_FILE = PathUtils.join(STATE_DIR, "gallery.json");
const LOGIN_ORIGIN = "chrome://firefox-zen";
const LOGIN_REALM = "Firefox-Zen Touches (GitHub)";
const MAX_AGE = 60 * 60 * 1000;
const MAX_INDEX = 8 * 1024 * 1024;

const notify = () => Services.obs.notifyObservers(null, CHANGED_TOPIC);

// ---- index ----

let index = { generated: null, touches: [] };
let fetched = 0;
let refreshing = null;

function cleanEntry(t) {
  if (!Number.isInteger(t?.id) || typeof t.name !== "string" || !t.scope || typeof t.scope.value !== "string") {
    return null;
  }
  return {
    id: t.id,
    name: t.name.slice(0, 80),
    author: typeof t.author === "string" ? t.author.slice(0, 40) : "",
    scope: { type: String(t.scope.type), value: t.scope.value.slice(0, 2048) },
    site: typeof t.site === "string" ? t.site.slice(0, 253) : "",
    elements: Number.isInteger(t.elements) ? t.elements : 0,
    css: !!t.css,
    likes: Number.isInteger(t.likes) ? t.likes : 0,
    url: typeof t.url === "string" && t.url.startsWith(`${WEB()}/`) ? t.url : null,
    updated: typeof t.updated === "string" ? t.updated : null,
  };
}

function setIndex(data) {
  index = {
    generated: typeof data?.generated === "string" ? data.generated : null,
    touches: (Array.isArray(data?.touches) ? data.touches : []).map(cleanEntry).filter(Boolean),
  };
}

async function loadCache() {
  try {
    const cache = await IOUtils.readJSON(CACHE_FILE);
    setIndex(cache.data);
    fetched = Number(cache.fetched) || 0;
  } catch {}
}

async function refresh({ force = false } = {}) {
  if (refreshing) {
    return refreshing;
  }
  if (!force && Date.now() - fetched < MAX_AGE) {
    return false;
  }
  refreshing = (async () => {
    try {
      const res = await fetch(`${GALLERY_URL()}index.json`, { cache: "no-cache", credentials: "omit" });
      if (!res.ok) {
        throw new Error(`gallery index: ${res.status}`);
      }
      const text = await res.text();
      if (text.length > MAX_INDEX) {
        throw new Error("gallery index too big");
      }
      const data = JSON.parse(text);
      setIndex(data);
      fetched = Date.now();
      await IOUtils.makeDirectory(STATE_DIR, { createAncestors: true });
      await IOUtils.writeJSON(CACHE_FILE, { fetched, data }, { tmpPath: `${CACHE_FILE}.tmp` });
      notify();
      return true;
    } catch (e) {
      console.warn("Firefox-Zen Touches: couldn't refresh the gallery", e);
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

const ready = loadCache().then(() => {
  // Shortly after startup, not during it.
  setTimeout(() => refresh(), 15000);
});

// ---- GitHub account ----

let token = null;
let login = Services.prefs.getStringPref(LOGIN_PREF, "") || null;

async function savedLogin() {
  try {
    const logins = await Services.logins.searchLoginsAsync({ origin: LOGIN_ORIGIN, httpRealm: LOGIN_REALM });
    return logins[0] ?? null;
  } catch {
    return null;
  }
}

async function getToken() {
  if (token) {
    return token;
  }
  const saved = await savedLogin();
  token = saved?.password ?? null;
  return token;
}

async function saveToken(value, user) {
  const old = await savedLogin();
  if (old) {
    Services.logins.removeLogin(old);
  }
  const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  info.init(LOGIN_ORIGIN, null, LOGIN_REALM, user, value, "", "");
  await Services.logins.addLoginAsync(info);
  token = value;
  login = user;
  Services.prefs.setStringPref(LOGIN_PREF, user);
}

async function signOut() {
  const old = await savedLogin();
  if (old) {
    Services.logins.removeLogin(old);
  }
  token = null;
  login = null;
  Services.prefs.clearUserPref(LOGIN_PREF);
  notify();
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    credentials: "omit",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) {
    throw new Error(`GitHub said ${res.status}`);
  }
  return data;
}

async function api(method, path, body) {
  const t = await getToken();
  if (!t) {
    throw new Error("Sign in with GitHub first.");
  }
  const res = await fetch(`${API()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "omit",
  });
  if (res.status === 401) {
    await signOut();
    throw new Error("GitHub signed you out. Sign in again.");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message ? `GitHub: ${data.message}` : `GitHub said ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// GitHub's device flow: { userCode, verificationUri, expiresIn, done, cancel }.
// done resolves with the GitHub login once the code was entered on github.com
// (and rejects if it's denied, expires or is cancelled).
async function startSignIn() {
  if (!clientId()) {
    throw new Error("Publishing isn't set up in this copy of Firefox-Zen (no GitHub app).");
  }
  const start = await postForm(`${WEB()}/login/device/code`, { client_id: clientId() });
  if (start.error || !start.device_code) {
    throw new Error(start.error_description || start.error || "GitHub didn't start the sign-in.");
  }
  let interval = Math.max(5, Number(start.interval) || 5) * 1000;
  let timer = null;
  let cancelled = false;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    rejectDone = reject;
    const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;
    const poll = async () => {
      if (cancelled) {
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("The code expired. Start again."));
        return;
      }
      try {
        const res = await postForm(`${WEB()}/login/oauth/access_token`, {
          client_id: clientId(),
          device_code: start.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        if (res.access_token) {
          const user = await (async () => {
            token = res.access_token;
            return (await api("GET", "/user")).login;
          })();
          await saveToken(res.access_token, user);
          notify();
          resolve(user);
          return;
        }
        if (res.error === "slow_down") {
          interval += 5000;
        } else if (res.error && res.error !== "authorization_pending") {
          reject(new Error(res.error === "access_denied" ? "Sign-in was cancelled on GitHub." : res.error_description || res.error));
          return;
        }
      } catch (e) {
        // A network hiccup: try again on the next round.
        console.warn("Firefox-Zen Touches: sign-in poll", e);
      }
      timer = setTimeout(poll, interval);
    };
    timer = setTimeout(poll, interval);
  });
  return {
    userCode: start.user_code,
    verificationUri: start.verification_uri || `${WEB()}/login/device`,
    expiresIn: Number(start.expires_in) || 900,
    done,
    cancel() {
      cancelled = true;
      clearTimeout(timer);
      rejectDone(new Error("cancelled"));
    },
  };
}

// ---- publishing ----

const repoPath = () => `/repos/${REPO()}`;

async function publish({ title, body }) {
  const issue = await api("POST", `${repoPath()}/issues`, { title, body });
  return { id: issue.number, url: issue.html_url };
}

async function updatePublished(id, { title, body }) {
  const issue = await api("PATCH", `${repoPath()}/issues/${id}`, { title, body, state: "open" });
  return { id: issue.number, url: issue.html_url };
}

async function unpublish(id) {
  await api("PATCH", `${repoPath()}/issues/${id}`, { state: "closed", state_reason: "not_planned" });
}

// ---- likes ----

// { [issue]: { reaction, at } } for 👍 given from here.
function likesMap() {
  try {
    const map = JSON.parse(Services.prefs.getStringPref(LIKES_PREF, "{}"));
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

function setLikes(map) {
  Services.prefs.setStringPref(LIKES_PREF, JSON.stringify(map));
  notify();
}

async function like(id) {
  const reaction = await api("POST", `${repoPath()}/issues/${id}/reactions`, { content: "+1" });
  setLikes({ ...likesMap(), [id]: { reaction: reaction.id, at: Date.now() } });
}

async function unlike(id) {
  const map = likesMap();
  const mine = map[id];
  if (mine?.reaction) {
    await api("DELETE", `${repoPath()}/issues/${id}/reactions/${mine.reaction}`);
  }
  delete map[id];
  setLikes(map);
}

// Likes as shown: the index's count, plus a like given since it was made.
function likeCount(entry) {
  const mine = likesMap()[entry.id];
  const generated = index.generated ? Date.parse(index.generated) : 0;
  return entry.likes + (mine && mine.at > generated ? 1 : 0);
}

// ---- API ----

export const FzGallery = {
  CHANGED_TOPIC,
  ready,
  refresh,

  get configured() {
    return !!clientId();
  },
  get account() {
    return login;
  },
  get repo() {
    return REPO();
  },

  // Listed touches for a page (nsIURI or string), most liked first.
  forPage(uri) {
    const href = typeof uri === "string" ? uri : uri?.spec ?? "";
    return index.touches
      .filter(t => matchesScope(t.scope, href))
      .sort((a, b) => likeCount(b) - likeCount(a) || String(b.updated).localeCompare(String(a.updated)));
  },

  get(id) {
    return index.touches.find(t => t.id === id) ?? null;
  },

  // A listed touch's full JSON (share format), from the store site.
  async fetchTouch(id) {
    if (!Number.isInteger(id)) {
      throw new Error("not a gallery touch");
    }
    const res = await fetch(`${GALLERY_URL()}${id}.json`, { cache: "no-cache", credentials: "omit" });
    if (!res.ok) {
      throw new Error(res.status === 404 ? "It isn't in the gallery any more." : `The gallery said ${res.status}`);
    }
    return res.json();
  },

  startSignIn,
  signOut,
  publish,
  updatePublished,
  unpublish,

  isLiked: id => !!likesMap()[id],
  like,
  unlike,
  likeCount,
};
