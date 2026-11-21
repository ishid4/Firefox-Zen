// ==UserScript==
// @name           Firefox-Zen Notifications
// @description    The Library's Notifications board, a count on the Library button and a bubble above it
// @include        main
// ==/UserScript==

// What's shown comes from the background module
// JS/firefox-zen-notifications.sys.mjs (updates from
// JS/firefox-zen-update.sys.mjs, VirusTotal detections from
// JS/firefox-zen-download-tools.sys.mjs). This window shows it three ways:
// - the Library's Notifications board (JS/firefox-zen-library.uc.js calls
//   window.FirefoxZenNotifications.buildView()), newest first by day.
//   Opening it marks everything read; what was unread stays highlighted
//   while it's open. Clicking one does its action (open About, the
//   VirusTotal report, Downloads);
// - a count on the spaces footer's Library button while some are unread
//   (also on the collapsed sidebar), and on the board's rail button;
// - a bubble above the Library button for the newest unread one (expanded
//   sidebar only, theme/spaces-footer.css). Clicking it opens the board, its
//   × marks that one read.
// While some are unread, the Library button opens on the board.

(function () {
  "use strict";

  const { FzNotifications } = ChromeUtils.importESModule(
    "chrome://userscripts/content/firefox-zen-notifications.sys.mjs"
  );
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  function h(tag, attrs = {}, ...children) {
    const el = document.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) {
        continue;
      }
      if (k === "text") {
        el.textContent = v;
      } else if (typeof v === "function") {
        el.addEventListener(k.replace(/^on/, ""), v);
      } else {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
    el.append(...children.filter(c => c != null && c !== false));
    return el;
  }

  const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

  function dayLabel(ms) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (ms >= start.getTime()) {
      return "Today";
    }
    if (ms >= start.getTime() - 86400000) {
      return "Yesterday";
    }
    return dateFormat.format(ms);
  }

  // ---- actions ----

  // What clicking it does; also marks it read.
  function run(n, action = n.action) {
    FzNotifications.markRead(n.id);
    if (action?.view) {
      window.FirefoxZenLibrary?.open(action.view);
    } else if (action?.url) {
      window.FirefoxZenLibrary?.close();
      window.openWebLinkIn(action.url, "tab");
    }
  }

  // [label, action] buttons for a notification.
  function actionsOf(n) {
    const out = [];
    if (n.action?.view === "about") {
      out.push(["See what's new", n.action]);
    } else if (n.action?.view) {
      out.push([`Open ${n.action.view[0].toUpperCase()}${n.action.view.slice(1)}`, n.action]);
    } else if (n.action?.url) {
      out.push([n.kind === "virustotal" ? "Open report" : "Open", n.action]);
    }
    if (n.kind === "virustotal" && n.action?.view !== "downloads") {
      out.push(["Show in Downloads", { view: "downloads" }]);
    }
    return out;
  }

  // ---- the board ----

  let view = null;
  let list = null;
  // Unread when the board opened: highlighted while it stays open.
  let fresh = new Set();

  function buildView() {
    fresh = new Set(FzNotifications.list().filter(n => !n.read).map(n => n.id));
    FzNotifications.markRead();
    const clearRead = h("button", {
      type: "button",
      class: "fz-lib-button",
      text: "Clear read",
      title: "Remove the notifications you've already seen",
      onclick: () => FzNotifications.clear(n => n.read && !fresh.has(n.id)),
    });
    const clearAll = h("button", {
      type: "button",
      class: "fz-lib-button",
      text: "Clear all",
      onclick: () => {
        fresh.clear();
        FzNotifications.clear();
      },
    });
    list = h("div", { class: "fz-lib-history-list fz-notify-list", role: "list" });
    view = h(
      "div",
      { class: "fz-notify-view" },
      h(
        "header",
        { class: "fz-lib-toolbar" },
        h("h2", { class: "fz-notify-heading", text: "Notifications" }),
        h("div", { class: "fz-lib-rail-spacer" }),
        clearRead,
        clearAll
      ),
      list
    );
    render();
    return view;
  }

  function row(n) {
    const buttons = actionsOf(n).map(([label, action]) =>
      h("button", {
        type: "button",
        class: "fz-lib-button fz-lib-dl-action",
        text: label,
        onclick: e => {
          e.stopPropagation();
          run(n, action);
        },
      })
    );
    return h(
      "div",
      {
        class: "fz-notify-row",
        role: "listitem",
        tabindex: "0",
        "data-kind": n.kind,
        "data-level": n.level,
        unread: fresh.has(n.id),
        clickable: !!n.action,
        onclick: () => n.action && run(n),
        onkeydown: e => {
          if (e.key === "Enter" && n.action) {
            run(n);
          } else if (e.key === "Delete") {
            FzNotifications.remove(n.id);
          }
        },
      },
      h("span", { class: "fz-notify-icon", "aria-hidden": "true" }),
      h(
        "div",
        { class: "fz-notify-text" },
        h("span", { class: "fz-notify-title", text: n.title }),
        n.body && h("span", { class: "fz-notify-body", text: n.body })
      ),
      h("span", { class: "fz-lib-history-time", text: timeFormat.format(n.time) }),
      ...buttons,
      h("button", {
        type: "button",
        class: "fz-lib-icon-button fz-lib-close-tab",
        title: "Remove",
        "aria-label": "Remove",
        onclick: e => {
          e.stopPropagation();
          FzNotifications.remove(n.id);
        },
      })
    );
  }

  function render() {
    if (!list) {
      return;
    }
    const children = [];
    let lastDay = null;
    for (const n of FzNotifications.list()) {
      const day = dayLabel(n.time);
      if (day !== lastDay) {
        lastDay = day;
        children.push(h("h3", { class: "fz-lib-day", text: day }));
      }
      children.push(row(n));
    }
    if (!children.length) {
      children.push(
        h(
          "div",
          { class: "fz-lib-empty" },
          h("span", { class: "fz-notify-empty-icon", "aria-hidden": "true" }),
          h("span", { text: "No notifications." })
        )
      );
    }
    const scroll = list.scrollTop;
    list.replaceChildren(...children);
    list.scrollTop = scroll;
  }

  // ---- the Library button: count and bubble ----

  const bar = () =>
    document.querySelector("sidebar-main")?.shadowRoot?.getElementById("fz-spaces-bar") ??
    document.getElementById("fz-spaces-bar");

  let bubble = null;

  function syncBadges() {
    const count = FzNotifications.unreadCount();
    const label = count > 99 ? "99+" : String(count);
    const footer = bar();
    const library = footer?.querySelector(".fz-library");
    footer?.toggleAttribute("fz-notify", count > 0);
    if (library) {
      let badge = library.querySelector(".fz-notify-count");
      if (count && !badge) {
        badge = h("span", { class: "fz-notify-count", "aria-hidden": "true" });
        library.append(badge);
      }
      if (badge) {
        badge.textContent = count ? label : "";
        badge.hidden = !count;
      }
      library.setAttribute("aria-label", count ? `Library, ${count} unread notification${count === 1 ? "" : "s"}` : "Library");
    }
    for (const nav of document.querySelectorAll("#fz-library .fz-lib-nav-notifications")) {
      if (count) {
        nav.dataset.count = label;
      } else {
        delete nav.dataset.count;
      }
    }
    syncBubble(footer, library);
  }

  function syncBubble(footer, library) {
    const n = FzNotifications.latestUnread();
    const show = !!library && !!n && !window.FirefoxZenLibrary?.isOpen();
    if (!show || bubble?.dataset.id !== n.id) {
      bubble?.remove();
      bubble = null;
    }
    if (!show) {
      return;
    }
    if (!bubble) {
      bubble = buildBubble(footer.ownerDocument, n);
    }
    // The footer is rebuilt with the spaces, so it's added again on each sync.
    if (bubble.parentNode !== footer) {
      footer.append(bubble);
    }
  }

  function buildBubble(doc, n) {
    const el = (tag, cls, text) => {
      const node = doc.createElementNS(HTML_NS, tag);
      if (cls) {
        node.className = cls;
      }
      if (text) {
        node.textContent = text;
      }
      return node;
    };
    const node = el("div", "fz-notify-bubble");
    node.dataset.id = n.id;
    node.dataset.level = n.level;
    node.setAttribute("role", "status");
    node.title = "Open Notifications";
    // Its entrance plays once, not again each time the footer is rebuilt.
    node.addEventListener("animationend", () => node.setAttribute("fz-shown", ""), { once: true });
    const more = FzNotifications.unreadCount() - 1;
    const text = el("div", "fz-notify-bubble-text");
    text.append(
      el("strong", null, n.title),
      el("span", null, more > 0 ? `and ${more} more` : n.kind === "update" ? "Click to see what's new" : "Click to see it")
    );
    const close = el("button", "fz-notify-bubble-close");
    close.type = "button";
    close.title = "Dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", e => {
      e.stopPropagation();
      FzNotifications.markRead(n.id);
    });
    node.append(text, close);
    node.addEventListener("click", () => window.FirefoxZenLibrary?.open("notifications"));
    return node;
  }

  window.FirefoxZenNotifications = {
    buildView,
    // Unread ones: the Library button opens on the board.
    opensBoard: () => FzNotifications.unreadCount() > 0,
    syncBadges,
  };

  const observer = {
    observe() {
      syncBadges();
      if (view?.isConnected) {
        // Arrived while the board is open: seen, and shown as new.
        for (const n of FzNotifications.list()) {
          if (!n.read) {
            fresh.add(n.id);
          }
        }
        if (FzNotifications.unreadCount()) {
          FzNotifications.markRead();
          return; // that notifies again
        }
        render();
      }
    },
  };
  Services.obs.addObserver(observer, FzNotifications.TOPIC);
  // The footer is rebuilt with the spaces.
  window.addEventListener("FzSpacesChanged", syncBadges);
  // The Library opening or closing hides or shows the bubble.
  const pressed = new MutationObserver(() => syncBadges());
  window.addEventListener("FzSpacesChanged", () => {
    const library = bar()?.querySelector(".fz-library");
    pressed.disconnect();
    if (library) {
      pressed.observe(library, { attributes: true, attributeFilter: ["aria-pressed"] });
    }
  });
  window.addEventListener(
    "unload",
    () => {
      Services.obs.removeObserver(observer, FzNotifications.TOPIC);
      window.removeEventListener("FzSpacesChanged", syncBadges);
      pressed.disconnect();
    },
    { once: true }
  );
  FzNotifications.ready.then(syncBadges);
  window.delayedStartupPromise?.then(syncBadges);
})();
