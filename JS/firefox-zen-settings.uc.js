// ==UserScript==
// @name           Firefox-Zen Settings
// @description    Toolbar button + panel to toggle firefox-zen.* prefs with live preview
// @include        main
// ==/UserScript==

(function () {
  "use strict";

  const PREF_BRANCH = "firefox-zen.";
  const WIDGET_ID = "firefox-zen-settings-button";
  const PANEL_ID = "firefox-zen-settings-panel";
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  // CSS reads these with -moz-pref(), which treats an unset pref as false.
  // Settings that default to true get written once on first run (see applyDefaults).
  const SETTINGS = [
    {
      pref: "compact-mode",
      default: false,
      label: "Compact mode",
      description: "Hide the toolbar until you hover the top of the window.",
      preview: "compact",
    },
    {
      pref: "floating-urlbar",
      default: true,
      label: "Floating address bar",
      description: "Open the address bar in the middle of the window, like a command bar.",
      preview: "urlbar",
    },
    {
      pref: "show-folder-icons",
      default: true,
      label: "Tab group folders",
      description: "Show tab groups as colored Arc-style folders.",
      preview: "folders",
    },
    {
      pref: "show-menu-icons",
      default: true,
      label: "Context menu icons",
      description: "Show icons next to items in right-click menus.",
      preview: "menu",
    },
  ];

  // Old inverted prefs -> new positive prefs.
  const MIGRATIONS = {
    "native-urlbar": "floating-urlbar",
    "hide-folder-icons": "show-folder-icons",
    "hide-menu-icons": "show-menu-icons",
  };

  const isOn = s => Services.prefs.getBoolPref(PREF_BRANCH + s.pref, false);

  function setOn(s, on) {
    const name = PREF_BRANCH + s.pref;
    // Keep prefs.js clean: unset already reads as false.
    if (on || s.default) {
      Services.prefs.setBoolPref(name, on);
    } else {
      Services.prefs.clearUserPref(name);
    }
  }

  function applyDefaults() {
    for (const [oldPref, newPref] of Object.entries(MIGRATIONS)) {
      const oldName = PREF_BRANCH + oldPref;
      if (Services.prefs.prefHasUserValue(oldName)) {
        Services.prefs.setBoolPref(PREF_BRANCH + newPref, !Services.prefs.getBoolPref(oldName));
        Services.prefs.clearUserPref(oldName);
      }
    }
    for (const s of SETTINGS) {
      if (s.default && !Services.prefs.prefHasUserValue(PREF_BRANCH + s.pref)) {
        Services.prefs.setBoolPref(PREF_BRANCH + s.pref, true);
      }
    }
  }

  function h(tag, attrs = {}, ...children) {
    const el = document.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") {
        el.textContent = v;
      } else {
        el.setAttribute(k, v);
      }
    }
    el.append(...children);
    return el;
  }

  // Miniature mockups; their look is driven by [data-on] in settings.css.
  function buildPreview(kind) {
    const mock = h("div", { class: `fz-mock fz-preview-${kind}`, "aria-hidden": "true" });
    switch (kind) {
      case "compact":
        mock.append(
          h("div", { class: "fz-mock-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h("div", { class: "fz-mock-page" })
        );
        break;
      case "urlbar":
        mock.append(
          h("div", { class: "fz-mock-toolbar" }, h("div", { class: "fz-mock-urlbar" })),
          h("div", { class: "fz-mock-page" }),
          h("div", { class: "fz-mock-float" }, h("div"), h("div"), h("div"))
        );
        break;
      case "folders":
        for (let i = 0; i < 3; i++) {
          mock.append(
            h("div", { class: "fz-mock-row" }, h("span", { class: "fz-mock-icon" }), h("span", { class: "fz-mock-line" }))
          );
        }
        break;
      case "menu":
        for (let i = 0; i < 4; i++) {
          mock.append(
            h("div", { class: "fz-mock-row" }, h("span", { class: "fz-mock-icon" }), h("span", { class: "fz-mock-line" }))
          );
        }
        break;
    }
    return mock;
  }

  function buildPanel() {
    const panel = document.createXULElement("panel");
    panel.id = PANEL_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "fz-settings-title");

    const cards = SETTINGS.map(s => {
      const input = h("input", { type: "checkbox", role: "switch", class: "fz-switch" });
      input.addEventListener("change", () => setOn(s, input.checked));

      const card = h(
        "label",
        { class: "fz-card", "data-pref": s.pref },
        buildPreview(s.preview),
        h(
          "div",
          { class: "fz-card-body" },
          h("div", { class: "fz-card-head" }, h("span", { class: "fz-card-title", text: s.label }), input),
          h("p", { class: "fz-card-desc", text: s.description })
        )
      );
      return card;
    });

    const reset = h("button", { class: "fz-reset", type: "button", text: "Reset to defaults" });
    reset.addEventListener("click", () => {
      for (const s of SETTINGS) {
        setOn(s, s.default);
      }
    });

    panel.append(
      h(
        "div",
        { class: "fz-settings" },
        h(
          "header",
          { class: "fz-header" },
          h("h2", { id: "fz-settings-title", text: "Firefox-Zen" }),
          h("span", { class: "fz-subtitle", text: "Changes apply instantly" })
        ),
        h("div", { class: "fz-grid" }, ...cards),
        h(
          "footer",
          { class: "fz-footer" },
          h("span", { class: "fz-hint", text: "Stored in about:config under firefox-zen.*" }),
          reset
        )
      )
    );

    document.getElementById("mainPopupSet").append(panel);
    return panel;
  }

  function sync(panel) {
    for (const s of SETTINGS) {
      const card = panel.querySelector(`.fz-card[data-pref="${s.pref}"]`);
      const on = isOn(s);
      card.toggleAttribute("data-on", on);
      card.querySelector(".fz-switch").checked = on;
    }
  }

  function openPanel(win, anchor) {
    const doc = win.document;
    const panel = doc.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }
    if (panel.state === "open") {
      panel.hidePopup();
      return;
    }
    sync(panel);
    panel.openPopup(anchor, "bottomright topright");
  }

  // ---- per-window setup ----
  applyDefaults();
  const panel = buildPanel();
  sync(panel);

  const observer = { observe: () => sync(panel) };
  Services.prefs.addObserver(PREF_BRANCH, observer);
  window.addEventListener("unload", () => Services.prefs.removeObserver(PREF_BRANCH, observer), { once: true });

  // ---- one-time widget registration (shared across windows) ----
  if (CustomizableUI.getWidget(WIDGET_ID)?.provider !== CustomizableUI.PROVIDER_API) {
    CustomizableUI.createWidget({
      id: WIDGET_ID,
      type: "button",
      label: "Firefox-Zen Settings",
      tooltiptext: "Firefox-Zen Settings",
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(event) {
        // event.target can lack ownerGlobal here; fall back to the focused browser window.
        const win =
          event?.target?.ownerGlobal ??
          event?.view ??
          Services.wm.getMostRecentWindow("navigator:browser");
        if (!win) {
          return;
        }
        const anchor =
          CustomizableUI.getWidget(WIDGET_ID).forWindow(win)?.anchor ??
          win.document.getElementById(WIDGET_ID);
        openPanel(win, anchor);
      },
    });
  }
})();
