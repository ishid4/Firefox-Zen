// ==UserScript==
// @name           Firefox-Zen Sidebar URL Bar
// @description    Zen/Arc layout: moves the navigation toolbar (buttons + URL bar) to the top of the expanded sidebar
// @include        main
// ==/UserScript==

// On with firefox-zen.sidebar-urlbar. Moves #navigator-toolbox (with #nav-bar)
// into #vertical-tabs (the sidebar's tab-strip slot) above the tabs;
// theme/sidebar-urlbar.css lays it out as a button row + a full-width URL bar.
// The window controls stay at the top of the window in a thin draggable row
// (#fz-titlebar).
//
// With Firefox's "Expand sidebar on hover", the toolbar stays in the sidebar for
// good (moving it on every hover would jump); CSS shrinks it to nothing while
// the sidebar is the collapsed strip, and hovering shows it. Otherwise it goes
// back to the top while the sidebar is collapsed. Also back to the top with
// horizontal tabs and during Customize Toolbar (so customization works on the
// real toolbar).

(function () {
  "use strict";

  const PREF = "firefox-zen.sidebar-urlbar";
  const ROOT_ATTR = "fz-sidebar-urlbar";
  const TITLEBAR_ID = "fz-titlebar";

  const navBar = document.getElementById("nav-bar");
  const toolbox = document.getElementById("navigator-toolbox");
  if (!navBar || !toolbox) {
    return;
  }

  // The whole #navigator-toolbox moves, not just #nav-bar: Firefox handles
  // most toolbar buttons (Extensions, Downloads, account, Library, bookmarks
  // menu…) with mousedown/command/popupshowing listeners on the toolbox, so
  // buttons taken out of it stop working.
  let toolboxHome = null; // { parent, next } of the toolbox in <body>
  let buttonbox = null; // the window controls moved out of #nav-bar
  let extHome = null; // { parent, next } of the Extensions button
  let navOrder = null; // #nav-bar-customization-target children before moving
  let customizing = false;

  // ---- URL bar panel (Zen-style): opened by the Extensions button ----
  //
  // Toolbar items placed RIGHT of the address bar (in Customize Toolbar) and
  // toolbar-pinned extension buttons move into this panel; items LEFT of it
  // stay in the row above the address bar. The panel is a child of
  // #navigator-toolbox, so Firefox's delegated toolbar handlers still see
  // clicks on the moved buttons.

  const PANEL_ID = "fz-urlbar-panel";

  const isExtensionItem = n =>
    n.matches?.(".webextension-browser-action, [id$='-browser-action'], .unified-extensions-item");
  const isLayoutItem = n => n.matches?.("toolbarspring, toolbarspacer, toolbarseparator, #vertical-spacer");

  function makeToolbar(id) {
    const tb = document.createXULElement("toolbar");
    tb.id = id;
    tb.setAttribute("mode", "icons");
    tb.className = "fz-up-toolbar";
    return tb;
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) {
      return panel;
    }
    panel = document.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Toolbar and extensions");

    const body = document.createXULElement("vbox");
    body.className = "fz-up-body";

    const head = document.createXULElement("hbox");
    head.className = "fz-up-head";
    head.setAttribute("align", "center");
    const title = document.createXULElement("label");
    title.className = "fz-up-title";
    title.setAttribute("value", "Extensions");
    const manage = document.createXULElement("label");
    manage.className = "fz-up-manage text-link";
    manage.setAttribute("value", "Manage");
    manage.addEventListener("click", () => {
      panel.hidePopup();
      window.BrowserAddonUI?.openAddonsMgr("addons://list/extension");
    });
    const spacer = document.createXULElement("spacer");
    spacer.setAttribute("flex", "1");
    head.append(title, spacer, manage);

    const extensions = makeToolbar("fz-up-extensions");
    // Firefox's full Extensions panel (unpinned extensions, permissions, …)
    const all = document.createXULElement("toolbarbutton");
    all.id = "fz-up-all-extensions";
    all.className = "toolbarbutton-1";
    all.setAttribute("tooltiptext", "All extensions");
    all.addEventListener("command", () => {
      panel.hidePopup();
      window.gUnifiedExtensions?.togglePanel();
    });
    extensions.append(all);

    body.append(makeToolbar("fz-up-actions"), head, extensions);
    panel.append(body);
    // Like Firefox's own panels: mark the anchor open="true" while showing, so
    // the button looks pressed and the compact sidebar stays out meanwhile.
    panel.addEventListener("popupshowing", e => {
      if (e.target === panel) {
        panel.anchorNode?.setAttribute("open", "true");
      }
    });
    panel.addEventListener("popuphidden", e => {
      if (e.target === panel) {
        document.getElementById("unified-extensions-button")?.removeAttribute("open");
      }
    });
    toolbox.append(panel);
    return panel;
  }

  function relocateItems() {
    const target = document.getElementById("nav-bar-customization-target");
    const urlbarItem = document.getElementById("urlbar-container");
    if (!target || !urlbarItem) {
      return;
    }
    const panel = ensurePanel();
    const actions = panel.querySelector("#fz-up-actions");
    const extensions = panel.querySelector("#fz-up-extensions");
    const all = panel.querySelector("#fz-up-all-extensions");

    navOrder = [...target.children];
    const urlbarIndex = navOrder.indexOf(urlbarItem);
    navOrder.forEach((node, i) => {
      if (isLayoutItem(node) || node === urlbarItem) {
        return;
      }
      if (isExtensionItem(node)) {
        extensions.insertBefore(node, all);
      } else if (i > urlbarIndex) {
        actions.append(node);
      }
    });
    actions.hidden = !actions.children.length;
  }

  // Put moved items back into the toolbar in their original order.
  function restoreItems() {
    const target = document.getElementById("nav-bar-customization-target");
    if (!target || !navOrder) {
      return;
    }
    navOrder.forEach((node, i) => {
      if (node.parentNode === target || !node.isConnected) {
        return;
      }
      const ref = navOrder.slice(i + 1).find(n => n.parentNode === target) ?? null;
      target.insertBefore(node, ref);
    });
    navOrder = null;
    document.getElementById(PANEL_ID)?.hidePopup();
  }

  function togglePanel(anchor, event) {
    const panel = ensurePanel();
    if (panel.state === "open" || panel.state === "showing") {
      panel.hidePopup();
      return;
    }
    panel.openPopup(anchor, { position: "bottomright topright", triggerEvent: event });
  }

  // Firefox auto-hides the Extensions button unless the pointer is over the
  // toolbar; as the panel's entry point it stays visible in this layout.
  const extVisibility = new MutationObserver(records => {
    for (const { target } of records) {
      if (target.hidden && document.documentElement.hasAttribute(ROOT_ATTR)) {
        target.hidden = false;
      }
    }
  });

  // In the sidebar layout the Extensions button opens our panel instead of
  // Firefox's (reachable from "All extensions" inside it). Stopping the event
  // at the button keeps it from reaching the toolbox's delegated handler.
  function onExtensionsButton(event) {
    if (
      (event.type === "mousedown" && event.button !== 0) ||
      (event.type === "keypress" && event.key !== "Enter" && event.key !== " ")
    ) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    togglePanel(event.currentTarget, event);
  }

  function wanted() {
    const tabs = document.getElementById("tabbrowser-tabs");
    const hoverMode = Services.prefs.getStringPref("sidebar.visibility", "always-show") === "expand-on-hover";
    return (
      Services.prefs.getBoolPref(PREF, false) &&
      Services.prefs.getBoolPref("sidebar.verticalTabs", false) &&
      !customizing &&
      (hoverMode || !!tabs?.hasAttribute("expanded")) &&
      !!document.getElementById("vertical-tabs")
    );
  }

  function moveIn() {
    const host = document.getElementById("vertical-tabs");
    toolboxHome = { parent: toolbox.parentNode, next: toolbox.nextSibling };

    // Window controls stay at the top of the window, in a row that takes the
    // toolbox's place in <body>.
    const row = document.createXULElement("hbox");
    row.id = TITLEBAR_ID;
    row.setAttribute("align", "center");
    buttonbox = navBar.querySelector(":scope > .titlebar-buttonbox-container");
    if (buttonbox) {
      row.append(buttonbox);
    }
    toolboxHome.parent.insertBefore(row, toolbox);

    // Extensions button goes into the URL bar (right end, with the page
    // actions), like Zen; toolbar-pinned extension buttons are hidden by CSS
    // and stay reachable from its panel.
    const ext = document.getElementById("unified-extensions-button");
    const pageActions = document.getElementById("page-action-buttons");
    if (ext && pageActions) {
      extHome = { parent: ext.parentNode, next: ext.nextSibling };
      pageActions.append(ext);
      ext.addEventListener("mousedown", onExtensionsButton);
      ext.addEventListener("keypress", onExtensionsButton);
      ext.hidden = false;
      extVisibility.observe(ext, { attributes: true, attributeFilter: ["hidden"] });
    }

    relocateItems();
    host.prepend(toolbox);
    document.documentElement.setAttribute(ROOT_ATTR, "");
  }

  function moveOut() {
    const parent = toolboxHome?.parent ?? document.body;
    const titlebar = document.getElementById(TITLEBAR_ID);
    const next =
      titlebar?.parentNode === parent ? titlebar : toolboxHome?.next?.parentNode === parent ? toolboxHome.next : null;
    parent.insertBefore(toolbox, next);

    restoreItems();
    const ext = document.getElementById("unified-extensions-button");
    ext?.removeEventListener("mousedown", onExtensionsButton);
    ext?.removeEventListener("keypress", onExtensionsButton);
    extVisibility.disconnect();
    window.gUnifiedExtensions?.updateButtonVisibility?.();
    if (ext && extHome) {
      const extNext = extHome.next?.parentNode === extHome.parent ? extHome.next : null;
      extHome.parent.insertBefore(ext, extNext);
    }
    extHome = null;
    if (buttonbox) {
      navBar.append(buttonbox);
      buttonbox = null;
    }
    titlebar?.remove();
    document.documentElement.removeAttribute(ROOT_ATTR);
    toolboxHome = null;
  }

  function update() {
    const inSidebar = toolbox.parentNode?.id === "vertical-tabs";
    const want = wanted();
    if (want && !inSidebar) {
      moveIn();
    } else if (!want && inSidebar) {
      moveOut();
    }
  }

  // ---- triggers ----

  const prefObserver = { observe: () => update() };
  const PREFS = [PREF, "sidebar.verticalTabs", "sidebar.visibility"];

  async function start() {
    await window.delayedStartupPromise;
    await window.SidebarController?.promiseInitialized;

    for (const p of PREFS) {
      Services.prefs.addObserver(p, prefObserver);
    }

    // Sidebar expanded/collapsed is mirrored on #tabbrowser-tabs[expanded].
    const tabs = document.getElementById("tabbrowser-tabs");
    const mo = new MutationObserver(update);
    if (tabs) {
      mo.observe(tabs, { attributes: true, attributeFilter: ["expanded"] });
    }

    window.addEventListener("customizationstarting", () => {
      customizing = true;
      update();
    });
    window.addEventListener("aftercustomization", () => {
      customizing = false;
      update();
    });

    window.addEventListener(
      "unload",
      () => {
        mo.disconnect();
        for (const p of PREFS) {
          Services.prefs.removeObserver(p, prefObserver);
        }
      },
      { once: true }
    );

    update();
  }

  start().catch(e => console.error("firefox-zen-sidebar-urlbar:", e));
})();
