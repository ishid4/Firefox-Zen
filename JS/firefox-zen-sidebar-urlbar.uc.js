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
    panel.setAttribute("aria-label", "Page actions");

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

    body.append(makeToolbar("fz-up-page-actions"), makeToolbar("fz-up-actions"), head, extensions);
    panel.append(body);
    // Like Firefox's own panels: mark the anchor open="true" while showing, so
    // the button looks pressed and the compact sidebar stays out meanwhile.
    panel.addEventListener("popupshowing", e => {
      if (e.target === panel) {
        panel.anchorNode?.setAttribute("open", "true");
        buildPageActionTiles(panel);
      }
    });
    panel.addEventListener("popupshown", e => {
      if (e.target === panel) {
        document.addEventListener("popupshowing", onOtherPopupShowing, true);
      }
    });
    panel.addEventListener("popuphidden", e => {
      if (e.target === panel) {
        document.getElementById("unified-extensions-button")?.removeAttribute("open");
        document.removeEventListener("popupshowing", onOtherPopupShowing, true);
      }
    });
    toolbox.append(panel);
    return panel;
  }

  // On Windows, panels at the default "parent" level are slotted in just
  // above the browser window when they open, so one opened from this panel
  // (Settings, bookmark editor, …) lands behind it. Opened while this panel
  // is open, it gets the "top" level instead (Firefox reads it when it creates
  // the popup's window, on opening), which keeps it above this one.
  function onOtherPopupShowing(e) {
    const panel = document.getElementById(PANEL_ID);
    const popup = e.target;
    if (popup.localName !== "panel" || popup === panel || popup.hasAttribute("level")) {
      return;
    }
    popup.setAttribute("level", "top");
    const restore = ev => {
      if (ev.target === popup) {
        popup.removeEventListener("popuphidden", restore);
        popup.removeAttribute("level");
      }
    };
    popup.addEventListener("popuphidden", restore);
  }

  // ---- URL bar page actions (pin to taskbar, translations, bookmark,
  // extension page actions, …) ----
  //
  // CSS hides them in the URL bar; the panel shows a tile for each one that is
  // currently available. They stay in #page-action-buttons (Firefox inserts new
  // ones relative to their siblings), so a tile clicks the original: it is
  // revealed ([fz-reveal]) while that happens, since its panel anchors to it.

  const PAGE_ACTION_SKIP = "#unified-extensions-button, #userContext-icons, #urlbar-zoom-button";

  function pageActionIcon(node) {
    const icon = node.querySelector(".urlbar-icon, image") ?? node;
    const image = getComputedStyle(icon).listStyleImage;
    if (image && image !== "none") {
      return image;
    }
    const src = icon.getAttribute("src");
    return src ? `url("${src}")` : null;
  }

  // The panel stays open; an action's own panel opens on top of it.
  function activatePageAction(node) {
    node.setAttribute("fz-reveal", "true");
    let opened = false;
    const done = () => {
      node.removeAttribute("fz-reveal");
      // Refresh tiles (a page may now be bookmarked, translated, …)
      const panel = document.getElementById(PANEL_ID);
      if (panel?.state === "open") {
        buildPageActionTiles(panel);
      }
    };
    const onShowing = e => {
      const anchor = e.target.anchorNode;
      if (!opened && anchor && node.contains(anchor)) {
        opened = true;
        e.target.addEventListener("popuphidden", done, { once: true });
      }
    };
    document.addEventListener("popupshowing", onShowing, true);
    // Actions without a panel (or that never open one) hide again shortly
    setTimeout(() => {
      document.removeEventListener("popupshowing", onShowing, true);
      if (!opened) {
        done();
      }
    }, 1000);
    // Some actions listen for mousedown (Page actions), others for click
    // (bookmark star, translations, …): send a full left click.
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1, view: window }));
    }
  }

  // Whether Firefox itself would show the button (not just our CSS hiding it):
  // some, like the Page actions "…" button without extra actions, are hidden
  // by Firefox's CSS rather than [hidden], and can't open anything.
  function shownByFirefox(node) {
    if (node.hidden) {
      return false;
    }
    const revealed = node.hasAttribute("fz-reveal");
    node.setAttribute("fz-reveal", "true");
    const shown = getComputedStyle(node).display !== "none";
    if (!revealed) {
      node.removeAttribute("fz-reveal");
    }
    return shown;
  }

  function buildPageActionTiles(panel) {
    const row = panel.querySelector("#fz-up-page-actions");
    const pageActions = document.getElementById("page-action-buttons");
    row.replaceChildren();
    for (const node of pageActions?.children ?? []) {
      if (node.matches(PAGE_ACTION_SKIP) || node.localName === "toolbarseparator" || !shownByFirefox(node)) {
        continue;
      }
      const image = pageActionIcon(node);
      if (!image) {
        continue;
      }
      const tile = document.createXULElement("toolbarbutton");
      tile.className = "toolbarbutton-1 fz-up-page-action";
      tile.style.listStyleImage = image;
      const label =
        node.getAttribute("tooltiptext") ||
        node.querySelector("[tooltiptext]")?.getAttribute("tooltiptext") ||
        node.getAttribute("aria-label") ||
        node.querySelector("[aria-label]")?.getAttribute("aria-label");
      if (label) {
        tile.setAttribute("tooltiptext", label);
      }
      for (const attr of ["starred", "checked"]) {
        if (node.hasAttribute(attr) || node.querySelector(`[${attr}]`)) {
          tile.setAttribute("checked", "true");
        }
      }
      tile.addEventListener("command", () => activatePageAction(node));
      row.append(tile);
    }
    row.hidden = !row.children.length;
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

  // In this layout the Extensions button is the "Page actions" button (icon
  // from CSS). Firefox localizes its tooltip through data-l10n-id and changes
  // that id when an extension needs attention: keep the latest one to restore.
  const EXT_LABEL = "Page actions";
  let extL10nId = null;

  function labelExtensionsButton(ext) {
    const id = ext.getAttribute("data-l10n-id");
    if (id) {
      extL10nId = id;
      ext.removeAttribute("data-l10n-id");
    }
    for (const attr of ["tooltiptext", "label", "aria-label"]) {
      if (ext.getAttribute(attr) !== EXT_LABEL) {
        ext.setAttribute(attr, EXT_LABEL);
      }
    }
  }

  function unlabelExtensionsButton(ext) {
    if (extL10nId) {
      document.l10n.setAttributes(ext, extL10nId);
      extL10nId = null;
    }
  }

  // Firefox auto-hides the Extensions button unless the pointer is over the
  // toolbar; as the panel's entry point it stays visible in this layout.
  const extVisibility = new MutationObserver(records => {
    if (!document.documentElement.hasAttribute(ROOT_ATTR)) {
      return;
    }
    for (const { target, attributeName } of records) {
      if (attributeName === "hidden") {
        if (target.hidden) {
          target.hidden = false;
        }
      } else {
        labelExtensionsButton(target);
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
      labelExtensionsButton(ext);
      extVisibility.observe(ext, {
        attributes: true,
        attributeFilter: ["hidden", "data-l10n-id", "tooltiptext", "label", "aria-label"],
      });
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
    if (ext) {
      unlabelExtensionsButton(ext);
    }
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
