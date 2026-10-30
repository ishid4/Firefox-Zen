// ==UserScript==
// @name           Firefox-Zen Colors
// @description    Color schemes: built-in presets, saved schemes and the palette engine that turns 1-4 colors into light and dark palettes
// ==/UserScript==

// Background module (loaded once by fx-autoconfig, shared by every window).
// The window side (applying a palette, light/dark mode) is in
// JS/firefox-zen-colors.uc.js; theme/colors.css maps the palette onto
// Firefox's own variables.
//
// A scheme is { id, name, seeds, gradient?, grain?, mode?, light?, dark? }:
// - seeds: 1-4 "#rrggbb" colors. 1 paints a flat window, more a gradient.
//   Only their hue and colorfulness count (the editor's wheel): how light
//   each surface is comes from the mode.
// - gradient: { type, angle }. type "linear" (along angle), "radial" (from
//   the window edge at angle) or "corners" (each color from its own corner);
//   missing: corners for 4 colors, else linear at 135deg.
// - grain: 0-1, film grain over the window.
// - mode: "light" / "dark" forces that mode while the scheme is shown
//   (missing: the mode setting decides).
// - light / dark: tweaks for that half only, { tint, shift }: tint scales how
//   much color the backgrounds take (0-2, default 1), shift moves their
//   lightness (-0.1 to 0.1, default 0). So each half is tuned on its own
//   instead of one being the other inverted.
// The scheme "firefox" means no scheme: Firefox's theme shows as it is.
//
// Mode (MODE_PREF): system / light / dark. Each window applies it to its own
// UI. Websites follow it through Firefox's "Website appearance" pref
// (layout.css.prefers-color-scheme.content-override) while WEBSITES_PREF is
// on; this module keeps that pref in step. It's only written when the mode
// is light or dark, or changes back to system, so a Website appearance the
// user picked in Firefox's settings stays until they pick a mode here.
//
// Colors are worked out in OKLCH, so equal lightness steps look equal for
// every hue. Text, muted text and the accent are then moved in lightness
// until they reach their contrast targets against every background they sit
// on (WCAG ratios), so any seed stays readable.

const PREF_BRANCH = "firefox-zen.colors.";
const ACTIVE_PREF = PREF_BRANCH + "active";
const SCHEMES_PREF = PREF_BRANCH + "schemes";
const MODE_PREF = PREF_BRANCH + "mode";
const WEBSITES_PREF = PREF_BRANCH + "websites";
const CONTENT_PREF = "layout.css.prefers-color-scheme.content-override";
// CONTENT_PREF values: what Firefox's Website appearance setting stores
const CONTENT_VALUES = { dark: 0, light: 1, system: 2 };
const MODES = ["system", "light", "dark"];
export const FIREFOX_ID = "firefox";
const HEX_RE = /^#[0-9a-f]{6}$/i;
const MAX_SEEDS = 4;
const GRADIENTS = ["linear", "radial", "corners"];
// Chroma at the color wheel's rim; seeds beyond it look the same anyway
// (accents stop at 0.2, backgrounds well before)
export const WHEEL_CHROMA = 0.2;
// Lightness the wheel and its seeds are shown at
const WHEEL_LIGHTNESS = 0.7;
// Grain at 100%: opacity of the noise
const GRAIN_OPACITY = 0.22;

// Contrast targets (WCAG ratio)
const TEXT_CONTRAST = 7;
const MUTED_CONTRAST = 4.5;
const ACCENT_CONTRAST = 3;
const ACCENT_TEXT_CONTRAST = 4.5;

// Lightness (OKLCH L) of each surface per mode, before a scheme's shift.
// The frame is the window behind everything; fields, popups and the selected
// tab sit on it.
const SURFACES = {
  light: { frame: 0.9, field: 0.97, popup: 0.975, selected: 0.985, maxChroma: 0.06 },
  dark: { frame: 0.2, field: 0.26, popup: 0.235, selected: 0.32, maxChroma: 0.05 },
};

export const PRESETS = [
  { id: FIREFOX_ID, name: "Firefox theme", seeds: [] },
  { id: "graphite", name: "Graphite", seeds: ["#71717a"] },
  { id: "ocean", name: "Ocean", seeds: ["#2563eb", "#06b6d4"] },
  { id: "forest", name: "Forest", seeds: ["#15803d", "#84cc16"] },
  { id: "rose", name: "Rose", seeds: ["#e11d48"] },
  { id: "lavender", name: "Lavender", seeds: ["#8b5cf6", "#ec4899"] },
  { id: "sunset", name: "Sunset", seeds: ["#f97316", "#db2777", "#7c3aed"] },
  { id: "aurora", name: "Aurora", seeds: ["#22d3ee", "#a78bfa", "#34d399", "#f472b6"] },
  { id: "midnight", name: "Midnight", seeds: ["#1e3a8a", "#4c1d95"], mode: "dark" },
];

// ---- color math ----

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
}

function rgbToHex(rgb) {
  return "#" + rgb.map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("");
}

const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  const H = C < 1e-4 ? 0 : (Math.atan2(B, A) * 180) / Math.PI;
  return { L, C, H: (H + 360) % 360 };
}

// Linear sRGB, possibly out of gamut
function oklchToLinear({ L, C, H }) {
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = lin => lin.every(v => v >= -1e-4 && v <= 1 + 1e-4);

// Into sRGB by lowering chroma (keeps lightness and hue)
function oklchToRgb(c) {
  let lo = 0;
  let hi = c.C;
  if (!inGamut(oklchToLinear(c))) {
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...c, C: mid }))) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    c = { ...c, C: lo };
  }
  return oklchToLinear(c).map(v => fromLinear(clamp(v, 0, 1)));
}

const oklchHex = c => rgbToHex(oklchToRgb(c));

function luminance(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const minContrast = (fg, bgs) => Math.min(...bgs.map(bg => contrast(fg, bg)));

// Moves `color` toward `towardLight` (true: lighter) until it reaches `target`
// against every background, keeping hue and as much chroma as fits.
function reach(color, bgs, target, towardLight) {
  const end = towardLight ? 1 : 0;
  let hex = oklchHex(color);
  if (minContrast(hex, bgs) >= target) {
    return hex;
  }
  for (let i = 1; i <= 40; i++) {
    const L = color.L + ((end - color.L) * i) / 40;
    hex = oklchHex({ ...color, L });
    if (minContrast(hex, bgs) >= target) {
      return hex;
    }
  }
  return hex;
}

// "#rrggbb" + alpha as rgb()
function withAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex).map(v => Math.round(v * 255));
  return `rgb(${r} ${g} ${b} / ${alpha})`;
}

// ---- palettes ----

function seedsOf(scheme) {
  const seeds = (scheme?.seeds || []).filter(s => HEX_RE.test(s)).slice(0, MAX_SEEDS);
  return seeds.map(s => rgbToOklch(hexToRgb(s)));
}

function tweaksOf(scheme, mode) {
  const t = scheme?.[mode] || {};
  return {
    tint: clamp(Number.isFinite(t.tint) ? t.tint : 1, 0, 2),
    shift: clamp(Number.isFinite(t.shift) ? t.shift : 0, -0.1, 0.1),
  };
}

// A seed as a background of lightness L: same hue, gentle chroma
function surface(seed, L, mode, tweaks) {
  const s = SURFACES[mode];
  const C = Math.min(seed.C * 0.4, s.maxChroma) * tweaks.tint;
  return { L: clamp(L + tweaks.shift, 0, 1), C, H: seed.H };
}

// The window background: flat (1 seed), a linear gradient (2-3) or one color
// per corner (4). Its colors are also what text has to be readable on.
export function gradientOf(scheme) {
  const g = scheme?.gradient || {};
  const count = seedsOf(scheme).length;
  return {
    type: GRADIENTS.includes(g.type) ? g.type : count == 4 ? "corners" : "linear",
    angle: Number.isFinite(g.angle) ? ((Math.round(g.angle) % 360) + 360) % 360 : 135,
  };
}

// Where each color sits for "corners", by count; turned by the angle
const CORNERS = {
  2: [[0, 0], [100, 100]],
  3: [[0, 0], [100, 0], [50, 100]],
  4: [[0, 0], [100, 0], [100, 100], [0, 100]],
};

// The gradient as CSS images (a comma list for corners). `color` writes a
// stop: a hex, or (for the fade) one whose alpha follows --fz-fade.
function gradientCss(stops, style, color) {
  if (stops.length < 2) {
    return "none";
  }
  const { type, angle } = style;
  const rad = (angle * Math.PI) / 180;
  if (type == "radial") {
    // The center on the window edge, in the angle's direction
    const x = Math.round(50 + 50 * Math.sin(rad));
    const y = Math.round(50 - 50 * Math.cos(rad));
    return `radial-gradient(farthest-corner at ${x}% ${y}%, ${stops.map(c => color(c, 1)).join(", ")})`;
  }
  if (type == "corners") {
    // Rotated about the middle by the angle (135deg: unturned)
    const turn = rad - (135 * Math.PI) / 180;
    return stops
      .map((c, i) => {
        const [px, py] = CORNERS[stops.length][i];
        const dx = px - 50;
        const dy = py - 50;
        const x = Math.round(50 + dx * Math.cos(turn) - dy * Math.sin(turn));
        const y = Math.round(50 + dx * Math.sin(turn) + dy * Math.cos(turn));
        return `radial-gradient(circle at ${x}% ${y}%, ${color(c, 1)}, ${color(c, 0)} 70%)`;
      })
      .join(", ");
  }
  return `linear-gradient(${angle}deg, ${stops.map(c => color(c, 1)).join(", ")})`;
}

const plainColor = (hex, alpha) => (alpha == 1 ? hex : withAlpha(hex, alpha));

function frameOf(seeds, mode, tweaks, style, color = plainColor) {
  const L = SURFACES[mode].frame;
  const stops = seeds.map(seed => oklchHex(surface(seed, L, mode, tweaks)));
  const gradient = gradientCss(stops, style, color);
  // Base under the gradient: the average of the stops
  const avg = { L: surface(seeds[0], L, mode, tweaks).L, C: 0, H: 0 };
  const a = seeds.reduce((acc, seed) => {
    const sc = surface(seed, L, mode, tweaks);
    const h = (sc.H * Math.PI) / 180;
    return [acc[0] + sc.C * Math.cos(h), acc[1] + sc.C * Math.sin(h)];
  }, [0, 0]);
  avg.C = Math.hypot(a[0], a[1]) / seeds.length;
  avg.H = ((Math.atan2(a[1], a[0]) * 180) / Math.PI + 360) % 360;
  return { base: oklchHex(avg), stops, gradient };
}

// Film grain: gray noise drawn once at window size (fixed, never tiled)
function grainCss(scheme) {
  const grain = clamp(Number(scheme?.grain) || 0, 0, 1);
  if (!grain) {
    return "none";
  }
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1600' height='1000'>` +
    `<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/>` +
    `<feColorMatrix type='saturate' values='0'/></filter>` +
    `<rect width='100%' height='100%' filter='url(%23n)' opacity='${(grain * GRAIN_OPACITY).toFixed(3)}'/></svg>`;
  return `url("data:image/svg+xml,${svg}")`;
}

/**
 * The window paint of a scheme for one mode with every color's alpha scaled
 * by var(--fz-fade), as one image list: the gradient, then the base color
 * (as an image). Laid over the new paint while it fades in. "none" for no
 * scheme.
 */
export function fadeImage(scheme, mode) {
  const seeds = seedsOf(scheme);
  if (!seeds.length) {
    return "none";
  }
  const fading = (hex, alpha) => {
    const [r, g, b] = hexToRgb(hex).map(v => Math.round(v * 255));
    return `rgb(${r} ${g} ${b} / calc(var(--fz-fade) * ${alpha}))`;
  };
  const frame = frameOf(seeds, mode, tweaksOf(scheme, mode), gradientOf(scheme), fading);
  const base = fading(frame.base, 1);
  const flat = `linear-gradient(${base}, ${base})`;
  return frame.gradient == "none" ? flat : `${frame.gradient}, ${flat}`;
}

// ---- color wheel ----
// Angle = hue, distance from the middle = colorfulness (OKLCH chroma)

/** { hue (deg), chroma (0..WHEEL_CHROMA) } of a seed */
export function wheelOf(hex) {
  const { C, H } = rgbToOklch(hexToRgb(hex));
  return { hue: H, chroma: Math.min(C, WHEEL_CHROMA) };
}

/** The seed at a wheel position */
export function fromWheel(hue, chroma) {
  return oklchHex({ L: WHEEL_LIGHTNESS, C: clamp(chroma, 0, WHEEL_CHROMA), H: ((hue % 360) + 360) % 360 });
}

/** [r, g, b] (0-255) shown at a wheel position, for drawing it */
export function wheelRgb(hue, chroma) {
  return oklchToRgb({ L: WHEEL_LIGHTNESS, C: chroma, H: hue }).map(v => Math.round(v * 255));
}

/**
 * The palette of a scheme for one mode, as CSS values by token name (without
 * the --fz- prefix). null for "Use Firefox theme" or a scheme with no colors.
 * @param {object} scheme
 * @param {"light"|"dark"} mode
 */
export function palette(scheme, mode) {
  const seeds = seedsOf(scheme);
  if (!seeds.length) {
    return null;
  }
  const s = SURFACES[mode];
  const dark = mode == "dark";
  const tweaks = tweaksOf(scheme, mode);
  const lead = seeds[0];
  const frame = frameOf(seeds, mode, tweaks, gradientOf(scheme));
  const field = oklchHex(surface(lead, s.field, mode, tweaks));
  const popup = oklchHex(surface(lead, s.popup, mode, tweaks));
  const selected = oklchHex(surface(lead, s.selected, mode, tweaks));
  const backgrounds = [frame.base, ...frame.stops, field, popup, selected];

  // Near-black / near-white with a trace of the lead hue (none for a gray
  // seed, whose hue means nothing)
  const trace = c => Math.min(c, lead.C * 0.3);
  const text = reach({ L: dark ? 0.9 : 0.25, C: trace(0.015), H: lead.H }, backgrounds, TEXT_CONTRAST, dark);
  const muted = reach({ L: dark ? 0.72 : 0.45, C: trace(0.02), H: lead.H }, backgrounds, MUTED_CONTRAST, dark);

  // The most colorful seed, at a lightness that reads as an accent
  const vivid = seeds.reduce((a, b) => (b.C > a.C ? b : a));
  const accentBase = { L: dark ? 0.75 : 0.55, C: vivid.C < 0.02 ? 0 : clamp(vivid.C, 0.02, 0.2), H: vivid.H };
  const accent = reach(accentBase, backgrounds, ACCENT_CONTRAST, dark);
  const accentText = ["#ffffff", "#000000"]
    .map(c => ({ c, r: contrast(c, accent) }))
    .reduce((a, b) => (b.r > a.r ? b : a)).c;
  const tintedAccentText = reach(
    { L: accentText == "#ffffff" ? 0.98 : 0.15, C: Math.min(0.02, vivid.C * 0.3), H: vivid.H },
    [accent],
    ACCENT_TEXT_CONTRAST,
    accentText == "#ffffff"
  );

  const ink = dark ? "#ffffff" : "#000000";
  return {
    "frame-bg": frame.base,
    "frame-gradient": frame.gradient,
    "frame-grain": grainCss(scheme),
    "frame-edge": withAlpha(ink, dark ? 0.08 : 0.1),
    "field-bg": field,
    "popup-bg": popup,
    "tab-selected-bg": selected,
    text,
    "text-muted": muted,
    border: withAlpha(ink, dark ? 0.12 : 0.12),
    hover: withAlpha(ink, dark ? 0.08 : 0.06),
    active: withAlpha(ink, dark ? 0.14 : 0.11),
    accent,
    "accent-text": tintedAccentText,
  };
}

/**
 * Both halves as `light-dark()` values by token name, so the page's
 * color-scheme picks one without the palette being worked out again.
 * light-dark() only takes colors, so the gradient comes as frame-gradient-light
 * and frame-gradient-dark (theme/colors.css picks one by prefers-color-scheme).
 * null for "Use Firefox theme".
 */
export function tokens(scheme) {
  const light = palette(scheme, "light");
  const dark = palette(scheme, "dark");
  if (!light || !dark) {
    return null;
  }
  const out = {};
  for (const name of Object.keys(light)) {
    if (name == "frame-gradient") {
      out["frame-gradient-light"] = light[name];
      out["frame-gradient-dark"] = dark[name];
    } else if (name == "frame-grain") {
      out[name] = light[name];
    } else {
      out[name] = light[name] == dark[name] ? light[name] : `light-dark(${light[name]}, ${dark[name]})`;
    }
  }
  return out;
}

// ---- schemes ----

export function validScheme(s) {
  return (
    s &&
    typeof s.id == "string" &&
    s.id &&
    typeof s.name == "string" &&
    Array.isArray(s.seeds) &&
    s.seeds.length >= 1 &&
    s.seeds.length <= MAX_SEEDS &&
    s.seeds.every(c => HEX_RE.test(c)) &&
    (s.gradient == null || (typeof s.gradient == "object" && (s.gradient.type == null || GRADIENTS.includes(s.gradient.type)))) &&
    (s.grain == null || Number.isFinite(s.grain)) &&
    (s.mode == null || ["light", "dark"].includes(s.mode))
  );
}

/** The user's saved schemes (invalid entries dropped) */
export function savedSchemes() {
  try {
    const list = JSON.parse(Services.prefs.getStringPref(SCHEMES_PREF, "[]"));
    return Array.isArray(list) ? list.filter(validScheme) : [];
  } catch {
    return [];
  }
}

/** Replaces the saved schemes (invalid and preset ids dropped) */
export function saveSchemes(list) {
  const valid = list.filter(s => validScheme(s) && !PRESETS.some(p => p.id == s.id));
  if (valid.length) {
    Services.prefs.setStringPref(SCHEMES_PREF, JSON.stringify(valid));
  } else {
    Services.prefs.clearUserPref(SCHEMES_PREF);
  }
}

/** Presets then saved schemes */
export function allSchemes() {
  const saved = savedSchemes().filter(s => !PRESETS.some(p => p.id == s.id));
  return [...PRESETS, ...saved];
}

export function schemeById(id) {
  return allSchemes().find(s => s.id == id) || null;
}

/** The scheme windows show by default (spaces may pick their own later) */
export function activeScheme() {
  return schemeById(Services.prefs.getStringPref(ACTIVE_PREF, FIREFOX_ID)) || schemeById(FIREFOX_ID);
}

// ---- mode ----

export function modeSetting() {
  const mode = Services.prefs.getStringPref(MODE_PREF, "system");
  return MODES.includes(mode) ? mode : "system";
}

/** "system", "light" or "dark": the scheme's forced mode, else the setting */
export function effectiveMode(scheme) {
  return scheme?.mode == "light" || scheme?.mode == "dark" ? scheme.mode : modeSetting();
}

// Websites follow the default scheme's mode
let lastWebsiteMode = null;
function syncWebsites(initial) {
  const mode = effectiveMode(activeScheme());
  const follow = Services.prefs.getBoolPref(WEBSITES_PREF, true);
  if (!follow) {
    // Turned off: undo a light/dark this module set (back to Firefox's
    // default, follow the browser)
    if (lastWebsiteMode == "light" || lastWebsiteMode == "dark") {
      Services.prefs.clearUserPref(CONTENT_PREF);
    }
    lastWebsiteMode = null;
    return;
  }
  if (mode == lastWebsiteMode || (initial && mode == "system")) {
    lastWebsiteMode = mode;
    return;
  }
  lastWebsiteMode = mode;
  if (mode == "system") {
    Services.prefs.clearUserPref(CONTENT_PREF);
  } else {
    Services.prefs.setIntPref(CONTENT_PREF, CONTENT_VALUES[mode]);
  }
}

Services.prefs.addObserver(PREF_BRANCH, { observe: () => syncWebsites(false) });
syncWebsites(true);

export const FzColors = {
  PREF_BRANCH,
  FIREFOX_ID,
  PRESETS,
  palette,
  tokens,
  contrast,
  MAX_SEEDS,
  WHEEL_CHROMA,
  gradientOf,
  fadeImage,
  wheelOf,
  fromWheel,
  wheelRgb,
  validScheme,
  savedSchemes,
  saveSchemes,
  allSchemes,
  schemeById,
  activeScheme,
  modeSetting,
  effectiveMode,
};
