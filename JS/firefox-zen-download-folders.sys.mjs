// ==UserScript==
// @name           Firefox-Zen Download Folders
// @description    Per-space download folders
// ==/UserScript==

// Background module (shared by every window). A space can have its own
// download folder; JS/firefox-zen-spaces.uc.js keeps it (normal spaces: in the
// space list, private spaces: in their encrypted data) and answers
// window.FirefoxZenSpaces.downloadDirFor(browser) with the folder of the
// space that browser's tab is in, or null for Firefox's folder.
//
// - Downloads: Firefox's helper app dialog decides where a download goes,
//   with or without asking; a download from a space with a folder goes there
//   (asking starts there).
// - Save Link/Page As (contentAreaUtils, in the window's scope) asks the
//   window's Downloads for the folder: each window gets one that answers with
//   the selected tab's space's folder.
// A folder that doesn't exist (anymore, or here: an imported space) is ignored.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  DownloadLastDir: "resource://gre/modules/DownloadLastDir.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  nsUnknownContentTypeDialog: "resource://gre/modules/HelperAppDlg.sys.mjs",
});

const log = e => console.error("firefox-zen-download-folders:", e);

// The folder for a download from `browser` (null: the window's selected tab)
// in browser window `win`, as an nsIFile, or null.
function folderFor(win, browser = null) {
  let path = null;
  try {
    path = win?.FirefoxZenSpaces?.downloadDirFor?.(browser ?? win.gBrowser?.selectedBrowser) ?? null;
  } catch (e) {
    log(e);
  }
  if (!path) {
    return null;
  }
  try {
    const dir = new lazy.FileUtils.File(path);
    return dir.exists() && dir.isDirectory() ? dir : null;
  } catch (e) {
    return null;
  }
}

// Save dialogs start in the last folder used (a pref, or in memory only for
// private windows): make that the space's folder.
function setLastDir(win, dir) {
  try {
    new lazy.DownloadLastDir(win).setFile(null, dir);
  } catch (e) {
    log(e);
  }
}

// The browser window and <browser> a helper app launch came from.
function sourceOf(aLauncher, aContext) {
  let browser = null;
  try {
    browser = BrowsingContext.get(aLauncher.browsingContextId)?.top?.embedderElement ?? null;
  } catch (e) {
    // Not known: the window's selected tab.
  }
  let win = browser?.ownerGlobal ?? null;
  if (!win) {
    try {
      win = aContext.getInterface(Ci.nsIDOMWindow);
      win = win?.browsingContext?.topChromeWindow ?? win;
    } catch (e) {
      // No window anymore.
    }
  }
  return { win, browser: browser?.localName === "browser" ? browser : null };
}

let patched = false;

function patchHelperAppDialog() {
  if (patched) {
    return;
  }
  patched = true;
  const proto = lazy.nsUnknownContentTypeDialog.prototype;
  const original = proto.promptForSaveToFileAsync;
  proto.promptForSaveToFileAsync = function (aLauncher, aContext, aDefaultFileName, aSuggestedFileExtension, aForcePrompt) {
    const { win, browser } = sourceOf(aLauncher, aContext);
    const dir = folderFor(win, browser);
    if (dir) {
      // As Firefox does when it saves without asking, but into the space's folder.
      if (!aForcePrompt && aDefaultFileName && Services.prefs.getBoolPref("browser.download.useDownloadDir", false)) {
        this.mLauncher = aLauncher;
        let file = null;
        try {
          file = this.validateLeafName(dir.clone(), aDefaultFileName, aSuggestedFileExtension);
        } catch (e) {
          // Not writable: Firefox asks where to save it.
        }
        if (file) {
          aLauncher.saveDestinationAvailable(file);
          return;
        }
      }
      setLastDir(win, dir);
    }
    return original.apply(this, arguments);
  };
}

export const FzDownloadFolders = {
  // Called by every browser window (JS/firefox-zen-spaces.uc.js) at startup.
  attach(win) {
    try {
      patchHelperAppDialog();
    } catch (e) {
      log(e);
    }
    const downloads = new Proxy(lazy.Downloads, {
      get(target, prop) {
        if (prop === "getPreferredDownloadsDirectory") {
          return async () => {
            const dir = folderFor(win);
            if (!dir) {
              return target.getPreferredDownloadsDirectory();
            }
            setLastDir(win, dir);
            return dir.path;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      Object.defineProperty(win, "Downloads", { value: downloads, configurable: true, writable: true });
    } catch (e) {
      log(e);
    }
  },
};
