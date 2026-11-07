// ==UserScript==
// @name           Firefox-Zen About
// @description    About tab of the Library: version, updates, links, and how the scripts fit together
// @include        main
// ==/UserScript==

// The version, checks and updating are the background module
// JS/firefox-zen-update.sys.mjs; this builds the Library's About tab
// (JS/firefox-zen-library.uc.js calls window.FirefoxZenAbout.buildView()) and
// marks the window while an update waits:
// - <html fz-update-available>: a dot on the Library's About button;
// - <html fz-update-unseen> and [fz-update] on the spaces footer: the Library
//   button and the toolbar's Firefox-Zen button show the update icon, and
//   open the Library on About, until About has been seen for that version.
//
// Updating a downloaded-files install shows every file the update would
// add, change or remove first, each with a checkbox; files edited here are
// marked, listed first and backed up whatever is chosen.

(function () {
  "use strict";

  const { FzUpdate } = ChromeUtils.importESModule("chrome://userscripts/content/firefox-zen-update.sys.mjs");
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const root = document.documentElement;

  const LINKS = repo => [
    { label: "GitHub repository", url: repo, hint: "Source, README and the installer" },
    { label: "Report a problem", url: `${repo}/issues`, hint: "Bugs and ideas" },
    { label: "Recent changes", url: `${repo}/commits`, hint: "Every commit" },
    { label: "Mods store", url: "https://ishid4.github.io/Firefox-Zen-Mods/", hint: "Looks and features made by others" },
    { label: "fx-autoconfig", url: "https://github.com/MrOtherGuy/fx-autoconfig", hint: "The script loader (MPL-2.0)" },
  ];

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

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const when = ms => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never");

  function openLink(url) {
    window.FirefoxZenLibrary?.close();
    window.openWebLinkIn(url, "tab");
  }

  // The installer's one-liner for this system.
  function installerCommand(repo) {
    const raw = repo.replace("https://github.com/", "https://raw.githubusercontent.com/");
    return AppConstants.platform === "win"
      ? `irm ${raw}/main/install.ps1 | iex`
      : `curl -fsSL ${raw}/main/install.sh | bash`;
  }

  // ---- the view ----

  let view = null;
  let renderStatus = () => {};

  function buildView() {
    FzUpdate.markSeen();
    const status = h("span", { class: "fz-hint fz-status", role: "status", "data-empty": true });
    const setStatus = (message, { error = false } = {}) => {
      status.textContent = message ?? "";
      status.toggleAttribute("data-error", error);
      status.toggleAttribute("data-empty", !message);
    };

    const autoCheck = h("input", {
      type: "checkbox",
      role: "switch",
      class: "fz-switch",
      onchange: e => Services.prefs.setBoolPref(FzUpdate.AUTO_CHECK_PREF, e.target.checked),
    });

    const versionBox = h("div", { class: "fz-about-version" });
    const subtitle = h("span", { class: "fz-subtitle" });
    const restartBanner = h("div", { class: "fz-banner", role: "status", hidden: true });
    const loaderSlot = h("div", { class: "fz-about-slot" });

    const run = async (button, fn) => {
      button.disabled = true;
      try {
        const message = await fn();
        if (message !== undefined) {
          setStatus(message);
        }
      } catch (e) {
        setStatus(e.message, { error: true });
      } finally {
        button.disabled = false;
      }
    };

    renderStatus = () => {
      const s = FzUpdate.status();
      subtitle.textContent = s.version ? `Version ${s.version}` : "Version unknown (no version.json)";
      autoCheck.checked = Services.prefs.getBoolPref(FzUpdate.AUTO_CHECK_PREF, true);

      const check = h("button", { type: "button", class: "fz-reset", text: s.checking ? "Checking…" : "Check for updates" });
      check.disabled = s.checking;
      check.onclick = () =>
        run(check, async () => {
          const r = await FzUpdate.check();
          if (r.error) {
            throw new Error(r.error);
          }
          return r.available ? `Version ${r.latest} is available.` : "Firefox-Zen is up to date.";
        });
      const update =
        s.available &&
        !s.updated &&
        h("button", {
          type: "button",
          class: "fz-reset fz-primary",
          text: s.git ? `Update to ${s.latest} with git` : `Update to ${s.latest}…`,
          onclick: e => (s.git ? updateWithGit(e.currentTarget, setStatus) : reviewUpdate(setStatus)),
        });

      let state;
      if (s.updated) {
        state = h("span", { class: "fz-badge", text: "Restart to finish" });
      } else if (s.available) {
        state = h("span", { class: "fz-badge fz-about-new", text: "Update available" });
      } else if (s.latest && !s.error) {
        state = h("span", { class: "fz-badge fz-mod-kind", text: "Up to date" });
      }

      versionBox.replaceChildren(
        ...[
        h(
          "div",
          { class: "fz-about-version-head" },
          h("img", { class: "fz-about-logo", src: "chrome://branding/content/icon64.png", alt: "" }),
          h(
            "div",
            { class: "fz-about-version-text" },
            h("strong", { class: "fz-about-name", text: "Firefox-Zen" }),
            h("span", { class: "fz-about-number", text: s.version ? `Version ${s.version}` : "Version unknown" }),
            // Latest · checked · source · install kind, on one line.
            h("span", {
              class: "fz-hint fz-about-facts",
              text: [
                s.latest ? `Latest ${s.latest}` : "Not checked yet",
                s.checkedAt && `checked ${when(s.checkedAt)}`,
                `${s.repository.replace("https://github.com/", "")} (${s.branch})`,
                s.git ? "git checkout" : "downloaded files",
              ]
                .filter(Boolean)
                .join(" · "),
            })
          ),
          state
        ),
        s.available && s.newer.length && buildReleases(s.newer, { title: "What's new" }),
        s.error && h("p", { class: "fz-about-error", text: s.error }),
        h(
          "div",
          { class: "fz-mods-toolbar fz-about-actions" },
          update,
          check,
          h("label", { class: "fz-mods-auto-check", title: "Check for a new version each time Firefox starts. Off: only when you click Check for updates." }, autoCheck, "Check at startup")
        ),
        ].filter(c => c && typeof c === "object") // parts not shown
      );

      restartBanner.hidden = !s.updated;
      if (s.updated) {
        restartBanner.replaceChildren(
          h(
            "span",
            { class: "fz-banner-text" },
            h("strong", { text: `Firefox-Zen ${s.updated.to} is installed.` }),
            " Restart Firefox to load it.",
            s.updated.backup ? ` Replaced files were saved in ${s.updated.backup}.` : ""
          ),
          h("button", { type: "button", class: "fz-reset fz-primary", text: "Restart now", onclick: () => FzUpdate.restart() })
        );
      }
      loaderSlot.replaceChildren(...(s.updated?.loader ? [loaderBanner(s.repository)] : []));
    };

    const scriptsList = h("div", { class: "fz-about-scripts" });
    const scriptsCount = h("span", { class: "fz-about-fold-count" });
    const changesList = h("div", { class: "fz-about-changes" });
    const changesCount = h("span", { class: "fz-about-fold-count" });
    const historySection = h("div", { class: "fz-about-slot" });

    view = h(
      "div",
      { class: "fz-settings-view fz-about-view" },
      h("header", { class: "fz-header" }, h("h2", { text: "About" }), subtitle),
      restartBanner,
      loaderSlot,
      h(
        "section",
        { class: "fz-category", "aria-labelledby": "fz-about-version-title" },
        h("h3", { class: "fz-category-title", id: "fz-about-version-title", text: "Version" }),
        versionBox
      ),
      h(
        "nav",
        { class: "fz-about-links", "aria-label": "Links" },
        ...LINKS(FzUpdate.status().repository).map(l =>
          h("button", {
            type: "button",
            class: "fz-reset fz-about-link",
            title: `${l.hint}\n${l.url}`,
            text: l.label,
            onclick: () => openLink(l.url),
          })
        )
      ),
      historySection,
      fold("How it works", scriptsCount, false, buildHowItWorks(), scriptsList),
      fold(
        "Your changes",
        changesCount,
        false,
        h(
          "p",
          { class: "fz-hint fz-about-para" },
          "Files that aren't as Firefox-Zen shipped them. Updates never overwrite these without asking, and back up what they replace. chrome/mods is never touched."
        ),
        changesList,
        h(
          "div",
          { class: "fz-mods-toolbar fz-about-actions" },
          h("button", { type: "button", class: "fz-reset", text: "Open chrome folder", onclick: () => FzUpdate.openFolder() }),
          h("button", {
            type: "button",
            class: "fz-reset",
            text: "Open backups",
            onclick: () => {
              try {
                FzUpdate.openFolder(FzUpdate.status().backupDir);
              } catch {}
            },
          })
        )
      ),
      h(
        "footer",
        { class: "fz-footer" },
        h("div", { class: "fz-footer-text" }, h("span", { class: "fz-hint", text: FzUpdate.status().dir }), status)
      )
    );

    renderStatus();
    FzUpdate.ready.then(() => {
      renderStatus();
      fillHistory(historySection);
      fillScripts(scriptsList, scriptsCount);
      fillChanges(changesList, changesCount);
    });
    return view;
  }

  function loaderBanner(repo) {
    return h(
      "div",
      { class: "fz-banner fz-banner-warning", role: "alert" },
      h(
        "span",
        { class: "fz-banner-text" },
        h("strong", { text: "The loader changed." }),
        " It lives in Firefox's install folder, which Firefox-Zen can't write to. Close Firefox and run the installer again: ",
        h("code", { class: "fz-about-code", text: installerCommand(repo) })
      )
    );
  }

  // A folded section: the title, a count beside it, open on click.
  function fold(title, count, open, ...content) {
    return h(
      "details",
      { class: "fz-category fz-about-fold", open },
      h("summary", { class: "fz-category-title fz-about-fold-title" }, h("span", { text: title }), count),
      ...content
    );
  }

  // Releases as a compact list: version, date, notes.
  function buildReleases(list, { title = null, current = null } = {}) {
    const date = d => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");
    return h(
      "div",
      { class: "fz-about-releases" },
      title && h("strong", { class: "fz-about-releases-title", text: title }),
      ...list.map(e =>
        h(
          "div",
          { class: "fz-about-release" },
          h(
            "div",
            { class: "fz-about-release-head" },
            h("span", { class: "fz-about-release-version", text: e.version }),
            e.date && h("span", { class: "fz-hint", text: date(e.date) }),
            e.version === current && h("span", { class: "fz-badge fz-mod-kind", text: "Installed" })
          ),
          e.notes && h("p", { class: "fz-about-release-notes", text: e.notes })
        )
      )
    );
  }

  const SHOWN_RELEASES = 3;

  function fillHistory(slot) {
    const { history, version } = FzUpdate.status();
    if (!history.length) {
      slot.replaceChildren();
      return;
    }
    const older = history.slice(SHOWN_RELEASES);
    slot.replaceChildren(
      h(
        "section",
        { class: "fz-category", "aria-labelledby": "fz-about-history-title" },
        h("h3", { class: "fz-category-title", id: "fz-about-history-title", text: "Version history" }),
        buildReleases(history.slice(0, SHOWN_RELEASES), { current: version }),
        older.length
          ? h(
              "details",
              { class: "fz-about-older" },
              h("summary", { class: "fz-about-older-title", text: `${older.length} older version${older.length === 1 ? "" : "s"}` }),
              buildReleases(older, { current: version })
            )
          : null
      )
    );
  }

  function buildHowItWorks() {
    const code = t => h("code", { class: "fz-about-code", text: t });
    const item = (term, ...parts) => h("li", {}, h("strong", { text: term }), " ", ...parts);
    return h(
      "ul",
      { class: "fz-about-how" },
      item("Loader:", code("config.js"), " in Firefox's folder starts fx-autoconfig (", code("chrome/utils"), "), which loads ", code("chrome/JS"), "."),
      item("Scripts:", code(".uc.js"), " run in each window; ", code(".sys.mjs"), " load once, shared by all windows."),
      item("Styles:", code("userChrome.css"), " imports ", code("theme/*.css"), "; settings switch them with ", code("firefox-zen.*"), " prefs."),
      item("Mods:", code("chrome/mods"), ", loaded after the theme. Edited scripts reload only with Firefox.")
    );
  }

  async function fillScripts(list, count) {
    let scripts;
    let changes = [];
    try {
      scripts = await FzUpdate.scripts();
    } catch (e) {
      list.replaceChildren(h("p", { class: "fz-about-error", text: `Couldn't list the scripts: ${e.message}` }));
      return;
    }
    try {
      changes = await FzUpdate.localChanges();
    } catch {}
    const state = new Map(changes.map(c => [c.path, c.state]));
    const label = { edited: "Edited", added: "Added by you" };
    // One line each: name and what it does (file and whole text on hover).
    const row = s =>
      h(
        "div",
        { class: "fz-about-script", "data-state": state.get(s.file) ?? "", title: `${s.file}\n${s.description}` },
        h("span", { class: "fz-about-script-name", text: s.name.replace(/^Firefox-Zen /, "") }),
        h("span", { class: "fz-about-script-desc", text: s.description }),
        state.get(s.file) && h("span", { class: "fz-badge fz-about-edited", text: label[state.get(s.file)] ?? state.get(s.file) })
      );
    const windows = scripts.filter(s => !s.background);
    const background = scripts.filter(s => s.background);
    const edited = scripts.filter(x => state.has(x.file)).length;
    count.textContent = `${scripts.length} scripts` + (edited ? ` · ${edited} edited` : "");
    list.replaceChildren(
      h("h4", { class: "fz-about-subtitle", text: `Window scripts (${windows.length})` }),
      ...windows.map(row),
      h("h4", { class: "fz-about-subtitle", text: `Background modules (${background.length})` }),
      ...background.map(row)
    );
  }

  async function fillChanges(list, count) {
    list.replaceChildren(h("p", { class: "fz-hint", text: "Looking for changes…" }));
    let changes;
    try {
      changes = await FzUpdate.localChanges();
    } catch (e) {
      count.textContent = "";
      list.replaceChildren(h("p", { class: "fz-about-error", text: `Couldn't compare the files: ${e.message}` }));
      return;
    }
    count.textContent = changes.length ? `${changes.length} file${changes.length === 1 ? "" : "s"}` : "none";
    if (!changes.length) {
      list.replaceChildren(h("p", { class: "fz-hint", text: "None: every file is as shipped." }));
      return;
    }
    const label = { edited: "Edited", added: "Added", missing: "Missing" };
    list.replaceChildren(
      ...changes.map(c =>
        h(
          "div",
          { class: "fz-about-change", "data-state": c.state },
          h("code", { class: "fz-about-script-file", text: c.path }),
          h("span", { class: "fz-badge fz-about-edited", text: label[c.state] })
        )
      )
    );
  }

  // ---- updating ----

  async function updateWithGit(button, setStatus) {
    button.disabled = true;
    setStatus("Running git pull…");
    try {
      const output = await FzUpdate.gitPull();
      setStatus(output.split("\n").pop() || "Updated.");
    } catch (e) {
      setStatus(
        `git pull stopped: ${e.message.split("\n").slice(-3).join(" ")}. Commit or stash your changes in the chrome folder, then try again.`,
        { error: true }
      );
      button.disabled = false;
    }
  }

  async function reviewUpdate(setStatus) {
    const aboutView = view;
    const s = FzUpdate.status();
    const page = h(
      "div",
      { class: "fz-settings-view fz-mods-view fz-update-view" },
      h(
        "header",
        { class: "fz-header" },
        h("h2", { text: "Update Firefox-Zen" }),
        h("span", { class: "fz-subtitle", text: `Downloading ${s.latest}…` })
      )
    );
    aboutView.replaceWith(page);
    view = page;
    const back = message => {
      page.replaceWith(aboutView);
      view = aboutView;
      renderStatus();
      const counts = aboutView.querySelectorAll(".fz-about-fold-count");
      fillScripts(aboutView.querySelector(".fz-about-scripts"), counts[0]);
      fillChanges(aboutView.querySelector(".fz-about-changes"), counts[1]);
      if (message) {
        setStatus(message.text, { error: message.error });
      }
    };

    let pending;
    try {
      pending = await FzUpdate.prepareUpdate();
    } catch (e) {
      back({ text: `Couldn't download the update: ${e.message}`, error: true });
      return;
    }
    if (!page.isConnected) {
      await pending.cancel(); // the Library closed meanwhile
      return;
    }

    const boxes = new Map();
    const edited = pending.items.filter(i => i.edited);
    const counts = ["added", "changed", "removed"]
      .map(st => [st, pending.items.filter(i => i.status === st).length])
      .filter(([, n]) => n)
      .map(([st, n]) => `${n} ${st}`)
      .join(", ");

    const applyButton = h("button", { type: "button", class: "fz-reset fz-primary", text: "Update" });
    const syncCount = () => {
      const n = [...boxes.values()].filter(b => b.checked).length;
      applyButton.textContent = `Update (${plural(n, "file")})`;
    };
    applyButton.onclick = async () => {
      applyButton.disabled = true;
      const paths = [...boxes].filter(([, b]) => b.checked).map(([p]) => p);
      try {
        const backup = await pending.commit(paths);
        back({ text: `Updated to ${pending.to}. Restart Firefox to load it.${backup ? ` Replaced files: ${backup}` : ""}` });
      } catch (e) {
        back({ text: `Couldn't update: ${e.message}`, error: true });
      }
    };

    const diff = window.FirefoxZenMods?.buildFileDiff;
    const fileRow = item => {
      const box = h("input", { type: "checkbox", class: "fz-about-apply", onchange: syncCount });
      box.checked = item.apply;
      boxes.set(item.path, box);
      const title =
        item.status === "removed"
          ? item.edited
            ? "Remove (you edited it; a copy is saved)"
            : "Remove"
          : item.edited
            ? "Replace your version (a copy is saved)"
            : "Apply";
      const section = diff
        ? diff(item)
        : h(
            "section",
            { class: "fz-diff-file", "data-status": item.status },
            h(
              "header",
              { class: "fz-diff-head" },
              h("span", { class: "fz-diff-path", text: item.path }),
              h("span", { class: "fz-badge fz-diff-status", text: item.status })
            )
          );
      section.classList.add("fz-about-file");
      const head = section.querySelector(".fz-diff-head");
      head.prepend(h("label", { class: "fz-about-apply-label", title }, box));
      if (item.edited) {
        head.querySelector(".fz-diff-path")?.after(h("span", { class: "fz-badge fz-about-edited", text: "Edited by you" }));
      }
      // Only edited files start unfolded: they need a look.
      section.toggleAttribute("data-collapsed", !item.edited);
      head.addEventListener("click", e => {
        if (!e.target.closest(".fz-about-apply-label")) {
          section.toggleAttribute("data-collapsed");
        }
      });
      return section;
    };

    page.replaceChildren(
      h(
        "header",
        { class: "fz-header" },
        h("h2", { text: "Update Firefox-Zen" }),
        h("span", { class: "fz-subtitle", text: `${pending.from ?? "?"} → ${pending.to}` })
      ),
      h(
        "dl",
        { class: "fz-update-facts" },
        h("dt", { text: "Installed version" }),
        h("dd", { text: pending.from ?? "—" }),
        h("dt", { text: "New version" }),
        h("dd", { text: pending.to }),
        h("dt", { text: "From" }),
        h("dd", { text: pending.url }),
        h("dt", { text: "Changes" }),
        h("dd", { text: counts || "Only the version number is new." })
      ),
      pending.newer.length ? buildReleases(pending.newer, { title: "What's new" }) : "",
      edited.length
        ? h(
            "div",
            { class: "fz-banner fz-banner-warning", role: "alert" },
            h(
              "span",
              { class: "fz-banner-text" },
              h("strong", { text: `You edited ${plural(edited.length, "file")} that this update also changes.` }),
              " They're listed first. Checked ones get the new version, and your copy is saved in chrome/.firefox-zen/backups; " +
                "unchecked ones keep your version, which may not work with the rest of the update."
            )
          )
        : "",
      pending.loader ? loaderBanner(FzUpdate.status().repository) : "",
      h(
        "p",
        { class: "fz-hint fz-about-para" },
        "Your mods and settings stay. version.json keeps your repository and branch if you changed them. Scripts load at the next restart."
      ),
      h(
        "div",
        { class: "fz-mods-toolbar fz-update-actions" },
        applyButton,
        h("button", {
          type: "button",
          class: "fz-reset",
          text: "Cancel",
          onclick: async () => {
            await pending.cancel();
            back(null);
          },
        })
      ),
      h(
        "section",
        { class: "fz-category", "aria-labelledby": "fz-update-changes" },
        h("h3", { class: "fz-category-title", id: "fz-update-changes", text: "Files" }),
        ...(pending.items.length
          ? pending.items.map(fileRow)
          : [h("p", { class: "fz-hint", text: "No files change." })])
      )
    );
    syncCount();
  }

  window.FirefoxZenAbout = {
    buildView,
    // The Library button shows the update icon: open on About.
    opensAbout: () => FzUpdate.status().unseen,
  };

  // ---- badges ----

  const bar = () =>
    document.querySelector("sidebar-main")?.shadowRoot?.getElementById("fz-spaces-bar") ??
    document.getElementById("fz-spaces-bar");

  function syncBadges() {
    const s = FzUpdate.status();
    root.toggleAttribute("fz-update-available", s.available && !s.updated);
    root.toggleAttribute("fz-update-unseen", s.unseen && !s.updated);
    bar()?.toggleAttribute("fz-update", s.unseen && !s.updated);
    const library = bar()?.querySelector(".fz-library");
    if (library) {
      library.title = s.unseen && !s.updated ? `Firefox-Zen ${s.latest} is available` : "Library";
    }
  }

  const observer = {
    observe() {
      syncBadges();
      if (view?.isConnected && view.classList.contains("fz-about-view")) {
        FzUpdate.markSeen(); // found while About is open: seen
        renderStatus();
      }
    },
  };
  Services.prefs.addObserver(FzUpdate.PREF_BRANCH, observer);
  Services.obs.addObserver(observer, FzUpdate.CHANGED_TOPIC);
  // The footer is rebuilt with the spaces.
  window.addEventListener("FzSpacesChanged", syncBadges);
  window.addEventListener(
    "unload",
    () => {
      Services.prefs.removeObserver(FzUpdate.PREF_BRANCH, observer);
      Services.obs.removeObserver(observer, FzUpdate.CHANGED_TOPIC);
      window.removeEventListener("FzSpacesChanged", syncBadges);
    },
    { once: true }
  );
  FzUpdate.ready.then(syncBadges);
  window.delayedStartupPromise?.then(syncBadges);
})();
