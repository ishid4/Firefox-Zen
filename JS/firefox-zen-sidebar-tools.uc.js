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

  // ---- pinned tabs as an icon grid with "Expand sidebar on hover" ----

  // Firefox only grids pinned tabs outside expand-on-hover (rows with titles
  // there). The grid lives on the arrowscrollbox's <slot part="items-wrapper">;
  // a ::part() rule from userChrome.css doesn't take, so style it from inside
  // the shadow root. Tile width/padding and the column template come from
  // general.css's variables.
  const pinnedGridSheet = new CSSStyleSheet();
  // Added/removed with the pref rather than an -moz-pref() media query, which
  // may not parse in a constructed sheet.
  pinnedGridSheet.replaceSync(`
    :host([orient="vertical"]) slot[part~="items-wrapper"] {
      display: grid !important;
      grid-template-columns: var(
        --fz-pinned-columns,
        repeat(auto-fit, minmax(var(--tab-pinned-min-width), auto))
      ) !important;
      grid-auto-rows: var(--tab-height-with-margin-padding);
      padding-inline: var(--fz-pinned-padding-inline, 0);
    }
  `);

  // Other sidebar modes (incl. compact sidebar, which uses "always show"):
  // Firefox's own grid, with general.css's column template (3 per row when
  // expanded). Firefox sets it via ::part(), which an !important rule in the
  // shadow root beats.
  const pinnedColumnsSheet = new CSSStyleSheet();
  pinnedColumnsSheet.replaceSync(`
    :host([orient="vertical"]) slot[part~="items-wrapper"] {
      grid-template-columns: var(
        --fz-pinned-columns,
        repeat(auto-fit, minmax(var(--tab-pinned-min-width), auto))
      ) !important;
    }
  `);

  function applyPinnedGrid() {
    const root = document.getElementById("pinned-tabs-container")?.shadowRoot;
    if (!root) {
      return;
    }
    const hoverMode = Services.prefs.getStringPref("sidebar.visibility", "always-show") === "expand-on-hover";
    const sheets = root.adoptedStyleSheets.filter(s => s !== pinnedGridSheet && s !== pinnedColumnsSheet);
    root.adoptedStyleSheets = [...sheets, hoverMode ? pinnedGridSheet : pinnedColumnsSheet];
  }

  const visibilityObserver = { observe: () => applyPinnedGrid() };

  // Rows the expanded grid needs (3 tiles per row). general.css sizes the
  // container to exactly that in both sidebar states, so the tabs below don't
  // jump on expand; the collapsed single column scrolls the rest.
  const PINNED_PER_ROW = 3;

  function updatePinnedRows() {
    const container = document.getElementById("pinned-tabs-container");
    if (container) {
      const rows = Math.max(1, Math.ceil(gBrowser.pinnedTabCount / PINNED_PER_ROW));
      container.style.setProperty("--fz-pinned-rows", String(rows));
    }
  }

  // TabClose fires before the tab leaves the strip.
  const queuePinnedRows = () => setTimeout(updatePinnedRows, 0);

  // ---- at most maxPins() pinned tabs ----

  // Pins the user makes (tab menu, dragging into the pinned area) go through
  // gBrowser.pinTab with a user-triggered metrics context; refuse those once
  // the pins are full. Session restore isn't user-triggered, so a restored
  // window keeps all its pins. The Library checks the limit itself.
  // firefox-zen.pins.max, 1-36 (Settings → Library).
  const MAX_PINS_PREF = "firefox-zen.pins.max";
  const maxPins = () => Math.min(36, Math.max(1, Services.prefs.getIntPref(MAX_PINS_PREF, 9)));
  const pinCount = () => gBrowser.pinnedTabCount;

  window.FirefoxZenPins = {
    get max() {
      return maxPins();
    },
    count: pinCount,
    room: () => Math.max(0, maxPins() - pinCount()),
  };

  function limitPinTab() {
    const original = gBrowser.pinTab;
    if (typeof original !== "function" || original.__fzLimit) {
      return;
    }
    const limited = function (tab, options) {
      if (!tab?.pinned && options?.metricsContext?.isUserTriggered && pinCount() >= maxPins()) {
        return;
      }
      return original.call(this, tab, options);
    };
    limited.__fzLimit = true;
    gBrowser.pinTab = limited;
  }

  // Tab menu: "3/12" on the right of Pin Tab / Unpin Tab; Pin is disabled
  // when the tabs wouldn't fit. Runs after Firefox's own popupshowing
  // handler (an attribute handler, so it's registered first).
  function onTabMenuShowing(e) {
    if (e.target.id !== "tabContextMenu") {
      return;
    }
    const tabs = window.TabContextMenu?.contextTabs ?? [];
    const newPins = tabs.filter(t => !t.pinned).length;
    const count = `${pinCount()}/${maxPins()}`;
    for (const id of ["context_pinTab", "context_pinSelectedTabs"]) {
      const item = document.getElementById(id);
      if (item) {
        item.setAttribute("acceltext", count);
        item.disabled = pinCount() + newPins > maxPins();
      }
    }
    for (const id of ["context_unpinTab", "context_unpinSelectedTabs"]) {
      document.getElementById(id)?.setAttribute("acceltext", count);
    }
  }

  // ---- dragging a tab into the pinned tabs: show where it lands ----

  // Firefox pins a tab dropped on the pinned tabs, always as the last one, and
  // shows nothing while it's dragged there. While an unpinned tab is over
  // them, the tiles slide apart to open a slot at the pointer, an empty tile
  // (#fz-pin-slot, theme/general.css) marks it, and the drop pins the tab
  // into that slot. A new row is added when the slot needs one.
  const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
  const SLOT_ID = "fz-pin-slot";

  let pinSlot = null; // { grid, index, tabs, grown } while showing a slot

  const pinnedTiles = () =>
    [...(document.getElementById("pinned-tabs-container")?.children ?? [])].filter(
      t => t.localName === "tab" && !t.hidden
    );

  // Unpinned tabs of this window being dragged (none for other drags)
  function draggedToPin(e) {
    const dragged = e.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    if (!dragged || dragged.ownerDocument !== document || dragged.pinned || e.dataTransfer.dropEffect === "copy") {
      return [];
    }
    return (dragged._dragData?.movingTabs ?? [dragged]).filter(t => t.localName === "tab" && !t.pinned);
  }

  // A tile's box where it sits in the grid: screenX/Y leave out the slides
  // and Firefox's drag transforms
  function tileBox(t) {
    const { width, height } = window.windowUtils.getBoundsWithoutFlushing(t);
    return { left: t.screenX - window.mozInnerScreenX, top: t.screenY - window.mozInnerScreenY, width, height };
  }

  // Positions of the grid's slots, from the tiles already in it
  function gridOf(tiles, container) {
    const first = tileBox(tiles[0]);
    const rowCount = tiles.filter(t => Math.abs(tileBox(t).top - first.top) < 1).length;
    const width = container.shadowRoot?.querySelector("[part~='items-wrapper']")?.clientWidth ?? container.clientWidth;
    const cols = rowCount < tiles.length ? rowCount : Math.max(rowCount, Math.floor(width / first.width) || 1);
    const pitchX = tiles[1] && rowCount > 1 ? tileBox(tiles[1]).left - first.left : first.width;
    const pitchY = first.height;
    // Where the background sits in the tile (both moved alike)
    const tileRect = tiles[0].getBoundingClientRect();
    const bgRect = tiles[0].querySelector(".tab-background")?.getBoundingClientRect() ?? tileRect;
    const bg = {
      left: first.left + bgRect.left - tileRect.left,
      top: first.top + bgRect.top - tileRect.top,
      width: bgRect.width,
      height: bgRect.height,
    };
    return {
      cols,
      slot(i) {
        const left = first.left + (i % cols) * pitchX;
        const top = first.top + Math.floor(i / cols) * pitchY;
        // The tile's visible background, not its whole box
        return {
          left: left + bg.left - first.left,
          top: top + bg.top - first.top,
          width: bg.width,
          height: bg.height,
          dx: (i % cols) * pitchX,
          dy: Math.floor(i / cols) * pitchY,
        };
      },
      rows: n => Math.ceil(n / cols),
      // The slot under a point, by the tiles' boxes
      at(x, y) {
        const col = Math.min(cols - 1, Math.max(0, Math.floor((x - first.left) / pitchX)));
        return Math.max(0, Math.floor((y - first.top) / pitchY)) * cols + col;
      },
      pitchY,
      tileWidth: first.width,
    };
  }

  // The dragged tab(s) as a pinned-tab-sized tile under the pointer
  // (theme/general.css hides the title meanwhile). Firefox moves them only
  // up and down; this moves them sideways too.
  function placeGhost(e, tabs, grid) {
    const tc = gBrowser.tabContainer;
    tc.style.setProperty("--fz-pin-ghost-width", `${grid.tileWidth}px`);
    pinSlot.ghostLeft ??= Math.min(...tabs.map(t => t.getBoundingClientRect().left));
    const box = tc.getBoundingClientRect();
    const left = Math.min(Math.max(e.clientX - grid.tileWidth / 2, box.left), box.right - grid.tileWidth);
    for (const tab of tabs) {
      tab.style.translate = `${left - pinSlot.ghostLeft}px 0`;
    }
  }

  // The empty tile marking a slot
  function showSlotTile(s) {
    let slot = document.getElementById(SLOT_ID);
    if (!slot) {
      slot = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      slot.id = SLOT_ID;
      gBrowser.tabContainer.append(slot);
    }
    const origin = gBrowser.tabContainer.getBoundingClientRect();
    Object.assign(slot.style, {
      left: `${s.left - origin.left}px`,
      top: `${s.top - origin.top}px`,
      width: `${s.width}px`,
      height: `${s.height}px`,
    });
  }

  function hidePinSlot() {
    if (!pinSlot) {
      return;
    }
    for (const tab of [...pinnedTiles(), ...(pinSlot.tabs ?? [])]) {
      tab.style.removeProperty("translate");
    }
    document.getElementById(SLOT_ID)?.remove();
    gBrowser.tabContainer.removeAttribute("fz-pin-drop");
    gBrowser.tabContainer.style.removeProperty("--fz-pin-ghost-width");
    const container = document.getElementById("pinned-tabs-container");
    if (pinSlot.grown && container) {
      container.style.setProperty("--fz-pinned-rows", pinSlot.grown.rows);
      container.style.minHeight = pinSlot.grown.minHeight;
      container.scrollbox.style.height = pinSlot.grown.height;
    }
    pinSlot = null;
  }

  function onPinDragOver(e) {
    const container = document.getElementById("pinned-tabs-container");
    const tiles = pinnedTiles();
    const tabs = tiles.length ? draggedToPin(e) : [];
    const box = container?.getBoundingClientRect();
    const over =
      box && e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!tabs.length || !over || pinCount() + tabs.length > maxPins()) {
      hidePinSlot();
      return;
    }
    // Measured once: the tiles move while the slot shows
    const grid = pinSlot?.grid ?? gridOf(tiles, container);
    // Before the first tile whose row is below the pointer, or that starts
    // right of it in the pointer's row
    let index = tiles.findIndex((t, i) => {
      const s = grid.slot(i);
      return e.clientY < s.top - 2 || (e.clientY < s.top + s.height + 2 && e.clientX < s.left + s.width / 2);
    });
    if (index === -1) {
      index = tiles.length;
    }
    pinSlot ??= {};
    placeGhost(e, tabs, grid);
    if (pinSlot.index === index) {
      return;
    }

    // Room for a new row
    if (!pinSlot.grown && grid.rows(tiles.length + 1) > grid.rows(tiles.length)) {
      const grown = {
        rows: container.style.getPropertyValue("--fz-pinned-rows"),
        minHeight: container.style.minHeight,
        height: container.scrollbox.style.height,
      };
      const height = container.getBoundingClientRect().height + grid.pitchY;
      container.style.setProperty("--fz-pinned-rows", String(grid.rows(tiles.length + 1)));
      container.style.minHeight = `${height}px`;
      container.scrollbox.style.height = `${container.scrollbox.getBoundingClientRect().height + grid.pitchY}px`;
      pinSlot = { ...pinSlot, grown };
    }

    // Tiles from the slot on move one slot forward
    tiles.forEach((tile, i) => {
      if (i < index) {
        tile.style.removeProperty("translate");
      } else {
        const here = grid.slot(i);
        const next = grid.slot(i + 1);
        tile.style.translate = `${next.dx - here.dx}px ${next.dy - here.dy}px`;
      }
    });

    showSlotTile(grid.slot(index));
    gBrowser.tabContainer.setAttribute("fz-pin-drop", "");
    pinSlot = { ...pinSlot, grid, index, tabs, before: tiles[index] ?? null };
  }

  // Firefox pins the tabs (at the end) in its own drop handler, after this
  // capturing one: move them into the slot afterwards, before the tile that
  // was there (tab indexes also count pinned tabs hidden in other spaces).
  function onPinDrop() {
    const drop = pinSlot;
    hidePinSlot();
    if (drop?.before) {
      setTimeout(() => {
        for (const tab of drop.tabs) {
          if (tab.pinned && !tab.closing && drop.before.pinned) {
            gBrowser.moveTabTo(tab, { tabIndex: drop.before.index });
          }
        }
      }, 0);
    }
  }

  // ---- reordering the pinned tabs: show where it lands ----

  // Firefox slides the other tiles out of a dragged pinned tile's way by its
  // own idea of the rows, and marks nothing. Here the tiles slide to leave the
  // grid slot under the pointer free, the empty tile marks it, and the drop
  // moves the tile there.
  let reorderSlot = null; // { grid, all, others, index, tabs } while showing a slot
  let reorderDrop = null; // where the drop goes, until Firefox's drop is done

  // Pinned tabs of this window being dragged (none for other drags)
  function draggedPinned(e) {
    const dragged = e.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    if (!dragged || dragged.ownerDocument !== document || !dragged.pinned || e.dataTransfer.dropEffect === "copy") {
      return [];
    }
    return (dragged._dragData?.movingTabs ?? [dragged]).filter(t => t.localName === "tab" && t.pinned);
  }

  function hideReorderSlot() {
    if (!reorderSlot) {
      return;
    }
    for (const tile of [...reorderSlot.all, ...reorderSlot.tabs]) {
      tile.style.removeProperty("translate");
    }
    document.getElementById(SLOT_ID)?.remove();
    reorderSlot = null;
  }

  // Runs after Firefox's own dragover handler (bubbling, on the same
  // container), which has just moved the dragged tile and slid the others.
  function onReorderDragOver(e) {
    const container = document.getElementById("pinned-tabs-container");
    const tabs = container ? draggedPinned(e) : [];
    const box = container?.getBoundingClientRect();
    const over =
      box && e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!tabs.length || !over) {
      hideReorderSlot();
      return;
    }
    // Measured once: the tiles move while the slot shows
    const all = reorderSlot?.all ?? pinnedTiles();
    const others = all.filter(t => !tabs.includes(t));
    reorderSlot ??= { all, others, tabs, grid: others.length ? gridOf(all, container) : null };
    // Firefox's slides are replaced by these
    for (const tile of others) {
      tile.style.transform = "";
    }
    // Firefox moves the tile only up and down outside the expanded grid
    if (!gBrowser.tabContainer.isContainerVerticalPinnedGrid?.(tabs[0])) {
      for (const tab of tabs) {
        const { left, width } = tileBox(tab);
        const edge = Math.min(Math.max(e.clientX - width / 2, box.left), box.right - width);
        tab.style.translate = `${edge - left}px 0`;
      }
    }
    const { grid } = reorderSlot;
    if (!grid) {
      return;
    }
    const index = Math.min(grid.at(e.clientX, e.clientY), others.length);
    if (reorderSlot.index === index) {
      return;
    }
    reorderSlot.index = index;

    // Every other tile in order, skipping the slot
    others.forEach((tile, i) => {
      const from = grid.slot(all.indexOf(tile));
      const to = grid.slot(i < index ? i : i + 1);
      const dx = to.dx - from.dx;
      const dy = to.dy - from.dy;
      if (dx || dy) {
        tile.style.translate = `${dx}px ${dy}px`;
      } else {
        tile.style.removeProperty("translate");
      }
    });
    showSlotTile(grid.slot(index));
  }

  // Before Firefox's drop handler: note the slot, and keep Firefox from
  // moving (and animating) the tile to the spot its own drag code picked.
  function onReorderDrop(e) {
    const slot = reorderSlot;
    hideReorderSlot();
    reorderDrop = null;
    if (!slot || slot.index === undefined) {
      return;
    }
    const dragData = e.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0)?._dragData;
    if (dragData) {
      dragData.dropElement = null;
      dragData.translateX = 0;
      dragData.translateY = 0;
    }
    reorderDrop = { tabs: slot.tabs, before: slot.others[slot.index] ?? null, after: slot.others.at(-1) };
  }

  // After Firefox's drop handler (bubbling)
  function onReorderDropDone() {
    const drop = reorderDrop;
    reorderDrop = null;
    const tabs = drop?.tabs.filter(t => t.pinned && !t.closing && t.isConnected) ?? [];
    for (const tab of tabs) {
      tab.style.removeProperty("translate");
    }
    if (!tabs.length) {
      return;
    }
    if (drop.before?.pinned) {
      gBrowser.moveTabsBefore(tabs, drop.before);
    } else if (drop.after?.pinned) {
      gBrowser.moveTabsAfter(tabs, drop.after);
    }
  }

  // ---- dragging a pinned tab out into the tab list: show where it lands ----

  // Firefox keeps a dragged pinned tab above New Tab, at its tile size, and
  // unpins one dropped on the list as the first tab. While a pinned tab is over
  // the list here, it becomes a tab row under the pointer ([fz-unpin-drop],
  // theme/general.css), the items from the pointer on slide down to open its
  // slot, and the drop unpins it into that slot: with tab sections
  // (JS/firefox-zen-tab-sections.uc.js) above or below the line, by which side
  // of the line the slot is on.
  //
  // Positions come from screenY, which leaves out the slides (and Firefox's
  // drag transforms), so nothing needs measuring before the slot opens.
  const PERIPHERY_ID = "tabbrowser-arrowscrollbox-periphery";

  let unpinSlot = null; // { tabs, items, index } while showing a slot
  let unpinDrop = null; // where the drop goes, until Firefox has unpinned

  // Pinned tabs of this window being dragged (none for other drags)
  function draggedToUnpin(e) {
    const dragged = e.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
    if (!dragged || dragged.ownerDocument !== document || !dragged.pinned || e.dataTransfer.dropEffect === "copy") {
      return [];
    }
    return (dragged._dragData?.movingTabs ?? [dragged]).filter(t => t.localName === "tab" && t.pinned);
  }

  const boundsOf = el => window.windowUtils.getBoundsWithoutFlushing(el);

  // The list's shown items, top to bottom, with the screen Y a slot opens
  // before. The line splits the periphery (line + New Tab): a slot over the
  // line's top half is above it, anything lower below it.
  function listItems(box) {
    const items = [];
    for (const el of box.children) {
      const height = boundsOf(el).height;
      if (!height) {
        continue;
      }
      let mid = el.screenY + height / 2;
      const line = el.id === PERIPHERY_ID && document.getElementById("fz-tab-separator");
      if (line && boundsOf(line).height) {
        mid = el.screenY + boundsOf(line).top - boundsOf(el).top + boundsOf(line).height / 2;
      }
      items.push({ el, mid });
    }
    return items.sort((a, b) => a.mid - b.mid);
  }

  // A tab row in the list to size the dragged tab like, read when the slot
  // first shows: the first loose tab, or New Tab's row
  function rowStyle(box) {
    const tc = gBrowser.tabContainer;
    const ref = [...box.children].find(el => el.localName === "tab" && boundsOf(el).height);
    const row = ref ?? document.getElementById("tabs-newtab-button") ?? box;
    tc.style.setProperty("--fz-unpin-width", `${boundsOf(row).width}px`);
    const content = ref?.querySelector(".tab-content");
    const icon = ref?.querySelector(".tab-icon-stack");
    const label = ref?.querySelector(".tab-label-container");
    const background = ref?.querySelector(".tab-background");
    if (content && icon && label && background) {
      const style = getComputedStyle(content);
      tc.style.setProperty("--fz-unpin-padding", `${style.paddingInlineStart} ${style.paddingInlineEnd}`);
      tc.style.setProperty("--fz-unpin-gap", `${Math.max(0, boundsOf(label).left - boundsOf(icon).right)}px`);
      tc.style.setProperty("--fz-unpin-margin", getComputedStyle(background).marginInline);
    }
    return { x: row.screenX, height: boundsOf(row).height || boundsOf(unpinSlot.tabs[0]).height };
  }

  function hideUnpinSlot() {
    if (!unpinSlot) {
      return;
    }
    for (const { el } of unpinSlot.items ?? []) {
      el.style.removeProperty("translate");
    }
    const tc = gBrowser.tabContainer;
    tc.removeAttribute("fz-unpin-drop");
    for (const name of ["--fz-unpin-width", "--fz-unpin-padding", "--fz-unpin-gap", "--fz-unpin-margin"]) {
      tc.style.removeProperty(name);
    }
    unpinSlot = null;
  }

  // Runs after Firefox's own dragover handler (bubbling, on the same
  // container), which has just placed the dragged tab inside the pinned area.
  function onUnpinDragOver(e) {
    const box = document.getElementById("tabbrowser-arrowscrollbox");
    const tabs = box?.getAttribute("orient") === "vertical" ? draggedToUnpin(e) : [];
    const rect = box?.getBoundingClientRect();
    const over = rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!tabs.length || !over) {
      hideUnpinSlot();
      return;
    }
    if (!unpinSlot) {
      unpinSlot = { tabs };
      unpinSlot.row = rowStyle(box);
      gBrowser.tabContainer.setAttribute("fz-unpin-drop", "");
    }
    const { row } = unpinSlot;

    // The dragged tab as a row under the pointer
    for (const tab of tabs) {
      tab.style.transform = `translate(${row.x - tab.screenX}px, ${e.screenY - row.height / 2 - tab.screenY}px)`;
    }

    const items = listItems(box);
    let index = items.findIndex(item => item.mid > e.screenY);
    if (index === -1) {
      index = items.length;
    }
    if (unpinSlot.index === index && unpinSlot.items?.length === items.length) {
      return;
    }
    for (const { el } of unpinSlot.items ?? []) {
      el.style.removeProperty("translate");
    }
    items.forEach(({ el }, i) => {
      if (i >= index) {
        el.style.translate = `0 ${row.height}px`;
      }
    });
    unpinSlot = { ...unpinSlot, items, index };
  }

  // Before Firefox's drop handler: note the slot, and keep Firefox from moving
  // the tab next to the pinned tab its own drag animation picked.
  function onUnpinDrop(e) {
    const slot = unpinSlot;
    hideUnpinSlot();
    unpinDrop = null;
    if (!slot?.items) {
      return;
    }
    const dragData = e.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0)?._dragData;
    if (dragData) {
      dragData.dropElement = null;
    }
    const items = slot.items.map(item => item.el);
    const line = items.findIndex(el => el.id === PERIPHERY_ID);
    const notLine = el => el && el.id !== PERIPHERY_ID;
    const prev = items.slice(0, slot.index).findLast(notLine) ?? null;
    const next = items.slice(slot.index).find(notLine) ?? null;
    const sections = !!window.FirefoxZenTabSections?.active() && line !== -1;
    const above = sections ? slot.index <= line : undefined;
    // Above the line (or without one): right after the item before the slot;
    // below it: right before the item after
    const [after, before] = above !== false ? [prev, prev ? null : next] : [next ? null : prev, next];
    unpinDrop = { tabs: slot.tabs, after, before, above };
  }

  // After Firefox's drop handler (bubbling), which unpinned the tabs as the
  // first ones in the list: move them into the slot before it's drawn.
  function onUnpinDropDone() {
    const drop = unpinDrop;
    unpinDrop = null;
    const tabs = drop?.tabs.filter(t => !t.pinned && !t.closing && t.isConnected) ?? [];
    if (!tabs.length) {
      return;
    }
    if (drop.after?.isConnected && !tabs.includes(drop.after)) {
      gBrowser.moveTabsAfter(tabs, drop.after);
    } else if (drop.before?.isConnected && !tabs.includes(drop.before)) {
      gBrowser.moveTabsBefore(tabs, drop.before);
    }
    // Right after a folder can land a tab in it
    for (const tab of tabs) {
      if (tab.group) {
        gBrowser.ungroupTab(tab);
      }
    }
    if (drop.above !== undefined) {
      window.FirefoxZenTabSections.setAbove(tabs, drop.above, { now: true });
    }
  }

  // ---- hold the compact sidebar out while its popups are open ----

  // A right-click menu (tab, sidebar, space menus) is a popup outside the
  // sidebar, so the compact sidebar would lose :hover and slide away under it.
  // While a popup triggered from inside the sidebar is open, mark
  // #sidebar-container[fz-hold]; general.css keeps it out meanwhile.
  const heldPopups = new Set();

  function isInSidebar(node) {
    const container = document.getElementById("sidebar-container");
    while (node && container) {
      if (container.contains(node)) {
        return true;
      }
      // Footer/space menus are triggered from inside <sidebar-main>'s shadow DOM.
      node = node.getRootNode?.()?.host;
    }
    return false;
  }

  function updateHold() {
    document.getElementById("sidebar-container")?.toggleAttribute("fz-hold", heldPopups.size > 0);
  }

  function onPopupShowing(e) {
    const popup = e.target;
    if (!["menupopup", "panel"].includes(popup.localName)) {
      return;
    }
    const trigger = popup.triggerNode ?? popup.anchorNode;
    if (trigger && isInSidebar(trigger)) {
      heldPopups.add(popup);
      updateHold();
    }
  }

  function onPopupHidden(e) {
    if (heldPopups.delete(e.target)) {
      updateHold();
    }
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
    applyPinnedGrid();
    window.addEventListener("popupshowing", onPopupShowing, true);
    window.addEventListener("popuphidden", onPopupHidden, true);
    updatePinnedRows();
    limitPinTab();
    document.getElementById("tabContextMenu")?.addEventListener("popupshowing", onTabMenuShowing);
    for (const type of ["TabPinned", "TabUnpinned", "TabOpen", "TabClose"]) {
      gBrowser.tabContainer.addEventListener(type, queuePinnedRows);
    }
    window.addEventListener("SSWindowRestored", queuePinnedRows);
    gBrowser.tabContainer.addEventListener("dragover", onPinDragOver, true);
    gBrowser.tabContainer.addEventListener("drop", onPinDrop, true);
    gBrowser.tabContainer.addEventListener("dragover", onReorderDragOver);
    gBrowser.tabContainer.addEventListener("drop", onReorderDrop, true);
    gBrowser.tabContainer.addEventListener("drop", onReorderDropDone);
    gBrowser.tabContainer.addEventListener("dragover", onUnpinDragOver);
    gBrowser.tabContainer.addEventListener("drop", onUnpinDrop, true);
    gBrowser.tabContainer.addEventListener("drop", onUnpinDropDone);
    // Left the tab strip, or the drag ended anywhere else
    gBrowser.tabContainer.addEventListener("dragleave", e => {
      if (!gBrowser.tabContainer.contains(e.relatedTarget)) {
        hidePinSlot();
        hideReorderSlot();
        hideUnpinSlot();
      }
    });
    window.addEventListener("dragend", hidePinSlot, true);
    window.addEventListener("dragend", hideReorderSlot, true);
    window.addEventListener("dragend", hideUnpinSlot, true);
    window.addEventListener("SidebarShown", () => {
      injectCheckbox().catch(e => console.error("firefox-zen-sidebar-tools:", e));
    });
    // The sidebar can re-create its shadow content; re-apply when it renders.
    window.addEventListener("SidebarItemChanged", applyGear);

    Services.prefs.addObserver(PREF, prefObserver);
    Services.prefs.addObserver("sidebar.visibility", visibilityObserver);
    window.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(PREF, prefObserver);
        Services.prefs.removeObserver("sidebar.visibility", visibilityObserver);
      },
      { once: true }
    );

    // Customize panel may already be open at startup.
    injectCheckbox().catch(e => console.error("firefox-zen-sidebar-tools:", e));
  }

  start().catch(e => console.error("firefox-zen-sidebar-tools:", e));
})();
