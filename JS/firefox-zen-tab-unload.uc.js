// ==UserScript==
// @name           Firefox-Zen Tab Unload
// @description    Unloads tabs you haven't used for a while, with Firefox's own unload; excluded sites stay loaded
// @include        main
// ==/UserScript==

// Firefox only unloads tabs by itself when memory is low (about:unloads).
// With Unload tabs on, this also unloads this window's tabs once they've
// gone unused for the set minutes, the same way Firefox does it
// (prepareDiscardBrowser + discardBrowser). An unloaded tab keeps its place,
// title and icon, and loads again when you select it.
//
// Never unloaded: the selected tab, the other half of a split view, a glance,
// tabs that are loading, playing sound (unless turned off), in
// picture-in-picture or using the camera, microphone or screen sharing,
// pinned tabs (unless turned off), excluded sites, and private windows (as
// Firefox's own unloader). Pages that would ask before leaving (unsaved
// forms) refuse: discardBrowser doesn't force them.
//
// Excluded and kept pinned tabs also get Firefox's `undiscardable`, so the
// low-memory unloader skips them too. Only what this script set is cleared
// again: an extension may have set it as well (tabs.update autoDiscardable).

(function () {
  "use strict";

  const { FzTabUnload } = ChromeUtils.importESModule("chrome://userscripts/content/firefox-zen-tab-unload.sys.mjs");
  const { webrtcUI } = ChromeUtils.importESModule("resource:///modules/webrtcUI.sys.mjs");
  const { PREFS, DEFAULTS } = FzTabUnload;

  const CHECK_MS = 60_000;
  const MENU_ID = "fz-context-never-unload";
  const GLANCE_ATTR = "fz-glance";

  if (!window.gBrowser?.discardBrowser || !gBrowser.prepareDiscardBrowser) {
    return;
  }

  const isPrivate = PrivateBrowsingUtils.isWindowPrivate(window);
  const enabled = () => Services.prefs.getBoolPref(PREFS.enabled, false);
  const minutes = () => Math.min(1440, Math.max(0, Services.prefs.getIntPref(PREFS.minutes, DEFAULTS.minutes)));
  const keepPinned = () => Services.prefs.getBoolPref(PREFS.keepPinned, DEFAULTS.keepPinned);
  const keepAudio = () => Services.prefs.getBoolPref(PREFS.keepAudio, DEFAULTS.keepAudio);

  const excluded = tab => FzTabUnload.isExcluded(tab.linkedBrowser?.currentURI);

  // ---- undiscardable, for Firefox's low-memory unloader ----

  const marked = new WeakSet();

  function updateTab(tab) {
    if (!tab?.isConnected || tab.closing) {
      return;
    }
    const keep = enabled() && ((keepPinned() && tab.pinned) || excluded(tab));
    if (keep && !tab.undiscardable) {
      tab.undiscardable = true;
      marked.add(tab);
    } else if (!keep && marked.has(tab)) {
      marked.delete(tab);
      tab.undiscardable = false;
    }
  }

  const updateAll = () => [...gBrowser.tabs].forEach(updateTab);

  // ---- unloading after the set minutes ----

  function canUnload(tab, now, wait) {
    const browser = tab.linkedBrowser;
    return (
      !tab.selected &&
      !tab.closing &&
      !!tab.linkedPanel &&
      !tab.hasAttribute("pending") &&
      !tab.hasAttribute("busy") &&
      !tab.hasAttribute(GLANCE_ATTR) &&
      !tab.splitview?.hasActiveTab &&
      !tab.pictureinpicture &&
      !(keepAudio() && tab.soundPlaying) &&
      !(keepPinned() && tab.pinned) &&
      // Set by an extension, or by us for an excluded site
      !tab.undiscardable &&
      !excluded(tab) &&
      !!browser?.isRemoteBrowser &&
      !webrtcUI.browserHasStreams(browser) &&
      now - tab.lastAccessed >= wait
    );
  }

  let checking = false;

  // Returns how many tabs it unloaded. `now` is for tests.
  async function check(now = Date.now()) {
    const wait = minutes() * 60000;
    if (!enabled() || !wait || isPrivate || checking || window.closed) {
      return 0;
    }
    checking = true;
    let count = 0;
    try {
      for (const tab of [...gBrowser.tabs]) {
        if (!canUnload(tab, now, wait)) {
          continue;
        }
        // Saves its state for session restore, so nothing typed is lost.
        await gBrowser.prepareDiscardBrowser(tab);
        // It may have been selected or closed meanwhile.
        if (canUnload(tab, now, wait) && gBrowser.discardBrowser(tab)) {
          count++;
        }
      }
    } catch (e) {
      console.error("firefox-zen-tab-unload:", e);
    } finally {
      checking = false;
    }
    return count;
  }

  let timer = null;

  function schedule() {
    const run = enabled() && minutes() > 0 && !isPrivate;
    if (run && !timer) {
      timer = setInterval(check, CHECK_MS);
    } else if (!run && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // ---- tab menu: Never unload > this page, its parent paths, its domains ----

  const contextTabs = () => window.TabContextMenu?.contextTabs ?? [];
  const covers = FzTabUnload.covers;

  // "github.com/ishid4/firefox-zen" for each tab, without repeats.
  function contextSites() {
    const sites = contextTabs().map(t => FzTabUnload.siteOf(t.linkedBrowser?.currentURI));
    return [...new Set(sites.filter(Boolean))];
  }

  // "github.com/a/b/c/d/e" -> github.com/a/b/c/d/e, …/a/b/c, …/a/b, …/a:
  // the page itself, then the widest paths (the middle ones of a deep page
  // are rarely wanted).
  const MAX_PATHS = 4;
  function pathsOf(site) {
    const list = [];
    for (let name = site; name.includes("/"); name = name.slice(0, name.lastIndexOf("/"))) {
      list.push(name);
    }
    return list.length > MAX_PATHS ? [list[0], ...list.slice(1 - MAX_PATHS)] : list;
  }

  // "a.b.example.co.uk" -> a.b.example.co.uk, b.example.co.uk, example.co.uk
  function domainsOf(site) {
    const host = site.split("/")[0];
    let base;
    try {
      base = Services.eTLD.getBaseDomainFromHost(host);
    } catch {
      return [host]; // An IP address, localhost
    }
    const list = [];
    for (let name = host; name.length >= base.length; name = name.slice(name.indexOf(".") + 1)) {
      list.push(name);
      if (name === base || !name.includes(".")) {
        break;
      }
    }
    return list;
  }

  function toggleSite(site) {
    const sites = FzTabUnload.excludedSites();
    if (sites.includes(site)) {
      FzTabUnload.saveExcludedSites(sites.filter(s => s !== site));
    } else {
      // Entries it covers (subdomains, pages under it) aren't needed any more
      FzTabUnload.saveExcludedSites([...sites.filter(s => !covers(site, s)), site]);
    }
  }

  const MAX_ITEMS = 12;

  function fillSubmenu(popup, sites) {
    popup.replaceChildren();
    const excluded = FzTabUnload.excludedSites();
    const pages = [...new Set(sites.flatMap(pathsOf))];
    const domains = [...new Set(sites.flatMap(domainsOf))];
    const add = name => {
      const item = document.createXULElement("menuitem");
      item.setAttribute("type", "checkbox");
      item.setAttribute("label", name);
      item.dataset.site = name;
      const parent = excluded.find(s => s !== name && covers(s, name));
      // checked="false" still shows the tick: set it only when on
      if (excluded.includes(name) || parent) {
        item.setAttribute("checked", "true");
      }
      if (parent) {
        // Kept by a wider entry: change that one instead
        item.disabled = true;
        item.setAttribute("tooltiptext", `Kept loaded by ${parent}`);
      }
      popup.append(item);
    };
    pages.slice(0, MAX_ITEMS - domains.length).forEach(add);
    if (pages.length && domains.length) {
      popup.append(document.createXULElement("menuseparator"));
    }
    domains.slice(0, MAX_ITEMS).forEach(add);
  }

  function ensureMenuItem() {
    const menu = document.getElementById("tabContextMenu");
    if (!menu || document.getElementById(MENU_ID)) {
      return;
    }
    const submenu = document.createXULElement("menu");
    submenu.id = MENU_ID;
    submenu.setAttribute("label", "Never unload");
    submenu.hidden = true;
    const popup = document.createXULElement("menupopup");
    popup.addEventListener("command", e => {
      const site = e.target.dataset?.site;
      if (site) {
        toggleSite(site);
      }
    });
    submenu.append(popup);

    // After Firefox's own popupshowing handler (an attribute, so registered first).
    menu.addEventListener("popupshowing", e => {
      if (e.target !== menu) {
        return;
      }
      const sites = enabled() ? contextSites() : [];
      submenu.hidden = !sites.length;
      if (sites.length) {
        fillSubmenu(popup, sites);
      }
    });

    const anchor = document.getElementById("context_unloadTab");
    if (anchor) {
      anchor.after(submenu);
    } else {
      menu.append(submenu);
    }
  }

  // ---- wiring ----

  const onTab = e => updateTab(e.target);

  const progressListener = {
    onLocationChange(browser, webProgress) {
      if (webProgress?.isTopLevel) {
        updateTab(gBrowser.getTabForBrowser(browser));
      }
    },
  };

  const prefObserver = {
    observe() {
      schedule();
      updateAll();
    },
  };

  ensureMenuItem();
  schedule();
  updateAll();
  Services.prefs.addObserver("firefox-zen.tab-unload", prefObserver);
  for (const type of ["TabOpen", "TabPinned", "TabUnpinned"]) {
    gBrowser.tabContainer.addEventListener(type, onTab);
  }
  gBrowser.addTabsProgressListener(progressListener);

  window.FirefoxZenTabUnload = { check };

  window.addEventListener(
    "unload",
    () => {
      clearInterval(timer);
      Services.prefs.removeObserver("firefox-zen.tab-unload", prefObserver);
      for (const type of ["TabOpen", "TabPinned", "TabUnpinned"]) {
        gBrowser.tabContainer.removeEventListener(type, onTab);
      }
      gBrowser.removeTabsProgressListener(progressListener);
    },
    { once: true }
  );
})();
