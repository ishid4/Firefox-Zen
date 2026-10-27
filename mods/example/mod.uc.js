// Runs once in every browser window while the mod is on, with `mod` in scope:
//   mod.id, mod.name, mod.dir, mod.window
//   mod.pref(name) / mod.setPref(name, value)   the options from mod.json
//   mod.onPrefChange(fn)                        fn(name) when an option changes
//   mod.onButton(name, fn)                      fn() when a button option is clicked
//   mod.listen(target, type, fn, options)       addEventListener, removed on off
//   mod.addStyle(css)                           CSS for this window, removed on off
//   mod.onCleanup(fn)                           anything else to undo on off
//   mod.url(path)                               file:// URL of a file in the folder
//   mod.log(...)                                console.log with the mod's name
// Window globals (gBrowser, document, Services…) work as usual. Turning the
// mod off (or Reload) runs the cleanups, so undo everything you add.

mod.listen(window, "keydown", event => {
  if (!mod.pref("shortcut")) {
    return;
  }
  if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === "KeyD") {
    event.preventDefault();
    event.stopPropagation();
    gBrowser.duplicateTab(gBrowser.selectedTab, true, { index: gBrowser.selectedTab._tPos + 1 });
  }
}, true);

// A "button" option: runs when clicked in this window's Mods tab (after its
// "confirm" prompt). A returned string shows as the tab's status line.
mod.onButton("dedupe", () => {
  const seen = new Set();
  const duplicates = gBrowser.visibleTabs.filter(tab => {
    const url = tab.linkedBrowser.currentURI.spec;
    if (tab.pinned || url === "about:blank" || !seen.has(url)) {
      seen.add(url);
      return false;
    }
    return true;
  });
  gBrowser.removeTabs(duplicates);
  return `Closed ${duplicates.length} duplicate tab${duplicates.length === 1 ? "" : "s"}.`;
});
