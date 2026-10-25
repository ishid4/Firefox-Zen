// ==UserScript==
// @name           Firefox-Zen Sidebar Tools
// @description    Lets the always-on "Customize sidebar" gear be hidden, from a checkbox in Customize Sidebar's Tools section
// @include        main
// ==/UserScript==

// Firefox always shows the Customize sidebar button (the gear) in the sidebar
// tools and leaves it out of the Tools checklist. This adds a "Customize
// sidebar button" checkbox to that list, backed by
// firefox-zen.show-customize-button (default true). With it off, the panel is
// still reachable from the sidebar's right-click menu → Customize sidebar.

(function () {
  "use strict";

  const PREF = "firefox-zen.show-customize-button";
  const CHECKBOX_ID = "fz-customize-button-tool";
  const CUSTOMIZE_URL = "chrome://browser/content/sidebar/sidebar-customize.html";

  const showGear = () => Services.prefs.getBoolPref(PREF, true);

  // ---- hide the gear in <sidebar-main>'s shadow root ----

  const hideGearSheet = new CSSStyleSheet();
  hideGearSheet.replaceSync(`moz-button[view="viewCustomizeSidebar"] { display: none !important; }`);

  function applyGear() {
    const root = document.querySelector("sidebar-main")?.shadowRoot;
    if (!root) {
      return;
    }
    const sheets = root.adoptedStyleSheets.filter(s => s !== hideGearSheet);
    root.adoptedStyleSheets = showGear() ? sheets : [...sheets, hideGearSheet];
  }

  // ---- checkbox in Customize Sidebar → Tools ----

  async function injectCheckbox() {
    const browser = window.SidebarController?.browser;
    const doc = browser?.contentDocument;
    if (!doc || !doc.documentURI.startsWith(CUSTOMIZE_URL)) {
      return;
    }
    const panel = doc.querySelector("sidebar-customize");
    if (!panel) {
      return;
    }
    await panel.updateComplete;
    const fieldset = panel.shadowRoot?.querySelector("moz-fieldset.customize-group.tools");
    if (!fieldset) {
      return;
    }

    const ensure = () => {
      let box = fieldset.querySelector(`#${CHECKBOX_ID}`);
      if (!box) {
        box = doc.createElement("moz-checkbox");
        box.id = CHECKBOX_ID;
        box.className = "tool";
        box.setAttribute("type", "checkbox");
        box.setAttribute("label", "Customize sidebar button");
        box.setAttribute("iconsrc", "chrome://global/skin/icons/settings.svg");
        box.addEventListener("change", () => Services.prefs.setBoolPref(PREF, box.checked));
        fieldset.append(box);
      }
      box.checked = showGear();
    };
    ensure();

    // The panel re-renders its tool list when tools change; keep ours in it.
    if (!fieldset.__fzObserved) {
      fieldset.__fzObserved = true;
      new MutationObserver(() => {
        if (!fieldset.querySelector(`#${CHECKBOX_ID}`)) {
          ensure();
        }
      }).observe(fieldset, { childList: true });
    }
  }

  const prefObserver = {
    observe() {
      applyGear();
      const box = window.SidebarController?.browser?.contentDocument
        ?.querySelector("sidebar-customize")
        ?.shadowRoot?.querySelector(`#${CHECKBOX_ID}`);
      if (box) {
        box.checked = showGear();
      }
    },
  };

  async function start() {
    await window.delayedStartupPromise;
    await window.SidebarController?.promiseInitialized;

    applyGear();
    window.addEventListener("SidebarShown", () => {
      injectCheckbox().catch(e => console.error("firefox-zen-sidebar-tools:", e));
    });
    // The sidebar can re-create its shadow content; re-apply when it renders.
    window.addEventListener("SidebarItemChanged", applyGear);

    Services.prefs.addObserver(PREF, prefObserver);
    window.addEventListener("unload", () => Services.prefs.removeObserver(PREF, prefObserver), { once: true });

    // Customize panel may already be open at startup.
    injectCheckbox().catch(e => console.error("firefox-zen-sidebar-tools:", e));
  }

  start().catch(e => console.error("firefox-zen-sidebar-tools:", e));
})();
