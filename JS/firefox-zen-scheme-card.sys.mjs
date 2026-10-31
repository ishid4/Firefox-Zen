// ==UserScript==
// @name           Firefox-Zen Scheme Cards
// @description    Share cards: a color scheme drawn as a PNG card that imports back as the scheme
// ==/UserScript==

// Background module, used by the Settings scheme editor
// (JS/firefox-zen-settings.uc.js). Nothing here touches prefs: it draws a
// card for a scheme and reads a scheme back from a card.
//
// The card (W x H) shows Firefox's logo in the scheme's colors, its name, the names
// of its colors and the date it was first made, in its own palette (its
// light look, or the one look it forces). The scheme is in it twice:
// - a tEXt chunk with the scheme as JSON: exact, but sites that recompress
//   images (most of them) strip it.
// - the dot code: CODE_BYTES of the scheme packed (packScheme) and drawn as
//   a grid of dots, which survives resizing and JPEG. The name is cut short
//   there if it doesn't fit. It's read at fixed places relative to the
//   card's size, so a cropped card doesn't read.
// The JSON is read first; the dot code when it's missing.

import { FzColors } from "chrome://userscripts/content/firefox-zen-colors.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const FORMAT = "firefox-zen-scheme";
const VERSION = 1;

// The card, in pixels (2:3)
const W = 1080;
const H = 1620;
const PAD = 72;
// The logo's square; text below spans TEXT_W
const ART = { x: (W - 864) / 2, y: PAD, w: 864, h: 864 };
const TEXT_W = W - 2 * PAD;
// The installed Firefox's own logo (Nightly and others have theirs)
const LOGO_URL = "chrome://branding/content/about-logo.svg";
// Dot code: 64 x 10 cells, one bit each (row by row, high bit first)
const CODE = { x: PAD, y: 1250, cols: 64, rows: 10, cell: (W - 2 * PAD) / 64 };
const CODE_BYTES = (CODE.cols * CODE.rows) / 8;
// A blank spot of the card, right of the dot code: its background
const BLANK = { x: W - PAD / 2, y: CODE.y + 40 };
const PILL = { x: PAD, y: 1476, h: 68 };

const SANS = "system-ui, -apple-system, sans-serif";
const MONO = "ui-monospace, Menlo, monospace";
const SERIF = "ui-serif, Georgia, serif";

const TYPES = ["linear", "radial", "corners"];
const MODES = ["", "light", "dark"];
const DAY = 86400000;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- color names, for the line under the name ----

// Upper bounds of OKLCH hue
const HUES = [
  [20, "Rose"],
  [45, "Red"],
  [70, "Orange"],
  [95, "Amber"],
  [115, "Yellow"],
  [135, "Lime"],
  [165, "Green"],
  [190, "Teal"],
  [225, "Cyan"],
  [250, "Sky"],
  [275, "Blue"],
  [295, "Indigo"],
  [315, "Violet"],
  [335, "Magenta"],
  [360, "Pink"],
];

function colorName(hex) {
  const { hue, chroma } = FzColors.wheelOf(hex);
  return chroma < 0.025 ? "Gray" : HUES.find(([max]) => hue < max)[1];
}

/** "Blue · Cyan", plus the look a scheme forces */
export function subtitle(scheme) {
  const names = [...new Set(scheme.seeds.map(colorName))];
  return [...names, ...(scheme.mode ? [scheme.mode] : [])].join(" · ").toUpperCase();
}

/** A created date ("YYYY-MM-DD") as "Oct 31, 2026" */
export function formatDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---- packing (the dot code) ----

// CRC-16/CCITT
function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// Bytes the code is XORed with, so it looks the same noisy way whatever the
// scheme (no blank rows after a short name)
function whitening() {
  let x = 0x9e3779b9;
  return Array.from({ length: CODE_BYTES }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x & 255;
  });
}

const tweakBytes = t => [
  Math.round(clamp(t?.tint ?? 1, 0, 2) * 100),
  Math.round(clamp(t?.shift ?? 0, -0.1, 0.1) * 1000) + 100,
];

function tweakOf(tint, shift) {
  const t = { tint: tint / 100, shift: (shift - 100) / 1000 };
  return t.tint === 1 && t.shift === 0 ? null : t;
}

const dayOf = date => {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
};

const dateOfDay = day => new Date(day * DAY).toISOString().slice(0, 10);

/**
 * CODE_BYTES: version, flags (colors - 1, gradient type, mode, has
 * gradient), angle (2), grain, light tint/shift, dark tint/shift, created
 * day (2, 0 = unknown), the colors (3 each), name length, name (UTF-8),
 * CRC-16 of all that, then padding; all XORed with whitening().
 */
function packScheme(scheme, created) {
  const g = scheme.gradient ? FzColors.gradientOf(scheme) : null;
  const day = created ? dayOf(created) : 0;
  const bytes = [
    VERSION,
    (scheme.seeds.length - 1) |
      ((g ? TYPES.indexOf(g.type) : 0) << 2) |
      (MODES.indexOf(scheme.mode ?? "") << 4) |
      (g ? 64 : 0),
    g ? g.angle >> 8 : 0,
    g ? g.angle & 255 : 0,
    Math.round(clamp(scheme.grain || 0, 0, 1) * 100),
    ...tweakBytes(scheme.light),
    ...tweakBytes(scheme.dark),
    day >> 8,
    day & 255,
    ...scheme.seeds.flatMap(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))),
  ];
  // Whole characters only, as many as fit
  const room = CODE_BYTES - bytes.length - 3;
  const encoder = new TextEncoder();
  let chars = [...scheme.name];
  let name = encoder.encode(scheme.name);
  while (name.length > room) {
    chars = chars.slice(0, -1);
    name = encoder.encode(chars.join(""));
  }
  bytes.push(name.length, ...name);
  const crc = crc16(bytes);
  bytes.push(crc >> 8, crc & 255);
  const mask = whitening();
  return Array.from({ length: CODE_BYTES }, (_, i) => (bytes[i] ?? 0) ^ mask[i]);
}

function unpackScheme(code) {
  const mask = whitening();
  const b = code.map((x, i) => x ^ mask[i]);
  if (b[0] !== VERSION) {
    return null;
  }
  const count = (b[1] & 3) + 1;
  const start = 11 + count * 3;
  const length = b[start];
  const end = start + 1 + length;
  if (end + 2 > CODE_BYTES || crc16(b.slice(0, end)) !== (b[end] << 8) + b[end + 1]) {
    return null;
  }
  const hex = n => n.toString(16).padStart(2, "0");
  const scheme = {
    name: new TextDecoder().decode(new Uint8Array(b.slice(start + 1, end))),
    seeds: Array.from({ length: count }, (_, i) => "#" + b.slice(11 + i * 3, 14 + i * 3).map(hex).join("")),
  };
  if (b[1] & 64) {
    scheme.gradient = { type: TYPES[(b[1] >> 2) & 3] ?? "linear", angle: ((b[2] << 8) + b[3]) % 360 };
  }
  if (MODES[(b[1] >> 4) & 3]) {
    scheme.mode = MODES[(b[1] >> 4) & 3];
  }
  if (b[4]) {
    scheme.grain = b[4] / 100;
  }
  const light = tweakOf(b[5], b[6]);
  const dark = tweakOf(b[7], b[8]);
  if (light) {
    scheme.light = light;
  }
  if (dark) {
    scheme.dark = dark;
  }
  const day = (b[9] << 8) + b[10];
  if (day) {
    scheme.created = dateOfDay(day);
  }
  return scheme;
}

// ---- PNG text chunk ----

const CRC32_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c = CRC32_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const isPng = bytes => PNG_SIGNATURE.every((b, i) => bytes[i] === b);
const ascii = bytes => String.fromCharCode(...bytes);

// tEXt is Latin-1: JSON escapes the rest
const latin1Json = value => JSON.stringify(value).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** The PNG with a tEXt chunk FORMAT = text after its header chunk */
function withText(png, text) {
  const data = [...FORMAT, "\0", ...text].map(c => c.charCodeAt(0));
  const body = [..."tEXt"].map(c => c.charCodeAt(0)).concat(data);
  const crc = crc32(body);
  const n = data.length;
  const chunk = new Uint8Array([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255, ...body, crc >>> 24, (crc >> 16) & 255, (crc >> 8) & 255, crc & 255]);
  // Signature (8) + IHDR (4 length + 4 type + 13 data + 4 CRC)
  const at = 33;
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at));
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}

/** The FORMAT tEXt chunk's text, or null */
function readText(bytes) {
  if (!isPng(bytes)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = ascii(bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === "tEXt") {
      const zero = data.indexOf(0);
      if (zero > 0 && ascii(data.subarray(0, zero)) === FORMAT) {
        return new TextDecoder("latin1").decode(data.subarray(zero + 1));
      }
    }
    if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  return null;
}

// ---- drawing ----

async function loadLogo(doc) {
  const img = new doc.defaultView.Image();
  img.src = LOGO_URL;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

// The logo in the scheme's colors: its own lightness (so the fox and globe
// keep their shading), the colors' hue and colorfulness. A circle when the
// logo can't load.
async function paintLogo(doc, ctx, scheme, box) {
  const logo = await loadLogo(doc);
  const art = doc.createElementNS(HTML_NS, "canvas");
  art.width = box.w;
  art.height = box.h;
  const actx = art.getContext("2d");
  const local = { x: 0, y: 0, w: box.w, h: box.h };
  if (logo) {
    actx.drawImage(logo, 0, 0, box.w, box.h);
    actx.globalCompositeOperation = "color";
    paintSeeds(actx, scheme, local);
    // Back to the logo's outline
    actx.globalCompositeOperation = "destination-in";
    actx.drawImage(logo, 0, 0, box.w, box.h);
  } else {
    paintSeeds(actx, scheme, local);
    actx.globalCompositeOperation = "destination-in";
    actx.beginPath();
    actx.arc(box.w / 2, box.h / 2, box.w / 2, 0, Math.PI * 2);
    actx.fill();
  }
  if (scheme.grain) {
    actx.globalCompositeOperation = "source-atop";
    paintGrain(doc, actx, clamp(scheme.grain, 0, 1), local);
  }
  ctx.drawImage(art, box.x, box.y);
}

const rgba = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
};

function averageHex(seeds) {
  const sum = [0, 0, 0];
  for (const hex of seeds) {
    const n = parseInt(hex.slice(1), 16);
    sum[0] += (n >> 16) & 255;
    sum[1] += (n >> 8) & 255;
    sum[2] += n & 255;
  }
  return "#" + sum.map(v => Math.round(v / seeds.length).toString(16).padStart(2, "0")).join("");
}

// The seeds over a box, laid out like the window's gradient
// (gradientCss in JS/firefox-zen-colors.sys.mjs)
function paintSeeds(ctx, scheme, { x, y, w, h }) {
  const seeds = scheme.seeds;
  const { type, angle } = FzColors.gradientOf(scheme);
  const rad = (angle * Math.PI) / 180;
  const farthest = (px, py) => Math.max(...[[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([cx, cy]) => Math.hypot(cx - px, cy - py)));
  const stops = (g, colors) => colors.forEach((c, i) => g.addColorStop(colors.length > 1 ? i / (colors.length - 1) : 0, c));

  ctx.fillStyle = seeds.length > 1 && type == "corners" ? averageHex(seeds) : seeds[0];
  ctx.fillRect(x, y, w, h);
  if (seeds.length < 2) {
    return;
  }
  if (type == "radial") {
    const cx = x + w * (0.5 + 0.5 * Math.sin(rad));
    const cy = y + h * (0.5 - 0.5 * Math.cos(rad));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, farthest(cx, cy));
    stops(g, seeds);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  } else if (type == "corners") {
    const corners = { 2: [[0, 0], [1, 1]], 3: [[0, 0], [1, 0], [0.5, 1]], 4: [[0, 0], [1, 0], [1, 1], [0, 1]] }[seeds.length];
    const turn = rad - (135 * Math.PI) / 180;
    seeds.forEach((c, i) => {
      const dx = corners[i][0] - 0.5;
      const dy = corners[i][1] - 0.5;
      const cx = x + w * (0.5 + dx * Math.cos(turn) - dy * Math.sin(turn));
      const cy = y + h * (0.5 + dx * Math.sin(turn) + dy * Math.cos(turn));
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, farthest(cx, cy));
      g.addColorStop(0, rgba(c, 1));
      g.addColorStop(0.7, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    });
  } else {
    // CSS linear-gradient: 0deg points up, the line spans the box
    const len = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const dx = (Math.sin(rad) * len) / 2;
    const dy = (-Math.cos(rad) * len) / 2;
    const g = ctx.createLinearGradient(x + w / 2 - dx, y + h / 2 - dy, x + w / 2 + dx, y + h / 2 + dy);
    stops(g, seeds);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }
}

function paintGrain(doc, ctx, grain, { x, y, w, h }) {
  const noise = doc.createElementNS(HTML_NS, "canvas");
  noise.width = w;
  noise.height = h;
  const nctx = noise.getContext("2d");
  const img = nctx.createImageData(w, h);
  const alpha = Math.round(grain * 0.22 * 255);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = alpha;
  }
  nctx.putImageData(img, 0, 0);
  ctx.drawImage(noise, x, y);
}

// Text at most maxWidth wide: smaller down to minSize, then cut with …
function fitText(ctx, text, { weight, size, minSize, family, maxWidth }) {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && s > minSize) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  let chars = [...text];
  while (ctx.measureText(text).width > maxWidth && chars.length > 1) {
    chars = chars.slice(0, -1);
    text = chars.join("").trimEnd() + "…";
  }
  return text;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/**
 * The card for a scheme, as a canvas of `doc`
 * @param {Document} doc
 * @param {object} scheme a scheme with colors (not "Firefox theme")
 */
export async function drawCard(doc, scheme) {
  const canvas = doc.createElementNS(HTML_NS, "canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const p = FzColors.palette(scheme, scheme.mode || "light");
  const ink = p.accent;
  const created = FzColors.createdOf(scheme);

  ctx.fillStyle = p["popup-bg"];
  ctx.fillRect(0, 0, W, H);

  await paintLogo(doc, ctx, scheme, ART);

  ctx.fillStyle = ink;
  ctx.textBaseline = "alphabetic";
  const name = fitText(ctx, scheme.name, { weight: 700, size: 112, minSize: 64, family: SANS, maxWidth: TEXT_W });
  ctx.fillText(name, PAD, ART.y + ART.h + 150);

  const sub = subtitle(scheme);
  ctx.letterSpacing = "2px";
  ctx.fillText(fitText(ctx, sub, { weight: 400, size: 40, minSize: 28, family: MONO, maxWidth: TEXT_W }), PAD, ART.y + ART.h + 228);
  ctx.letterSpacing = "0px";

  // The dot code
  const code = packScheme(scheme, created);
  for (let i = 0; i < CODE.cols * CODE.rows; i++) {
    if ((code[i >> 3] >> (7 - (i & 7))) & 1) {
      const cx = CODE.x + ((i % CODE.cols) + 0.5) * CODE.cell;
      const cy = CODE.y + (Math.floor(i / CODE.cols) + 0.5) * CODE.cell;
      ctx.beginPath();
      ctx.arc(cx, cy, CODE.cell * 0.36, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // The pill: SCHEME | its colors | created date
  ctx.font = `600 31px ${SANS}`;
  const label = "SCHEME";
  const date = created ? formatDate(created) : "Firefox-Zen";
  const pad = 26;
  const swatchW = 64;
  const labelW = ctx.measureText(label).width + pad * 2;
  const dateW = ctx.measureText(date).width + pad * 2;
  const { x, y, h } = PILL;
  const swatch = { x: x + labelW, y, w: swatchW, h };
  ctx.save();
  roundRect(ctx, x, y, labelW + swatchW + dateW, h, 10);
  ctx.clip();
  scheme.seeds.forEach((c, i) => {
    ctx.fillStyle = c;
    const w = swatch.w / scheme.seeds.length;
    ctx.fillRect(swatch.x + i * w, swatch.y, Math.ceil(w), swatch.h);
  });
  ctx.restore();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 3;
  roundRect(ctx, x, y, labelW + swatchW + dateW, h, 10);
  ctx.stroke();
  ctx.beginPath();
  for (const lx of [swatch.x, swatch.x + swatch.w]) {
    ctx.moveTo(lx, y);
    ctx.lineTo(lx, y + h);
  }
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + pad, y + h / 2 + 1);
  ctx.fillText(date, swatch.x + swatch.w + pad, y + h / 2 + 1);

  // Wordmark
  ctx.font = `500 36px ${SERIF}`;
  ctx.textAlign = "right";
  ctx.fillText("FIREFOX", W - PAD, y + 16);
  ctx.fillText("ZEN", W - PAD, y + 54);
  return canvas;
}

/** The card as PNG bytes, with the scheme in it */
export async function cardPng(doc, scheme) {
  const canvas = await drawCard(doc, scheme);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  const png = new Uint8Array(await blob.arrayBuffer());
  const shared = { name: scheme.name, seeds: scheme.seeds };
  for (const key of ["gradient", "grain", "mode", "light", "dark"]) {
    if (scheme[key] != null) {
      shared[key] = scheme[key];
    }
  }
  const created = FzColors.createdOf(scheme);
  if (created) {
    shared.created = created;
  }
  return withText(png, latin1Json({ format: FORMAT, version: VERSION, scheme: shared }));
}

// The dot code read off an image, or null
async function readCode(doc, bytes) {
  const win = doc.defaultView;
  let bitmap;
  try {
    bitmap = await win.createImageBitmap(new win.Blob([bytes]));
  } catch {
    return null;
  }
  const { width, height } = bitmap;
  // Same shape as a card, give or take a few pixels of rounding
  if (Math.abs(width / height - W / H) > 0.02 || width < W / 4) {
    return null;
  }
  const canvas = doc.createElementNS(HTML_NS, "canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  const sx = width / W;
  const sy = height / H;
  // Average brightness of a small square around a card point
  const r = Math.max(1, Math.round(CODE.cell * 0.18 * sx));
  const sample = (px, py) => {
    const cx = Math.round(px * sx);
    const cy = Math.round(py * sy);
    let sum = 0;
    let n = 0;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const i = (y * width + x) * 4;
        sum += pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
        n++;
      }
    }
    return sum / n;
  };
  // Dots are what's far from the background, light or dark card alike
  const background = sample(BLANK.x, BLANK.y);
  const cells = Array.from({ length: CODE.cols * CODE.rows }, (_, i) =>
    Math.abs(sample(CODE.x + ((i % CODE.cols) + 0.5) * CODE.cell, CODE.y + (Math.floor(i / CODE.cols) + 0.5) * CODE.cell) - background)
  );
  const threshold = Math.max(...cells) / 2;
  if (threshold < 15) {
    return null;
  }
  const code = new Array(CODE_BYTES).fill(0);
  cells.forEach((d, i) => {
    if (d > threshold) {
      code[i >> 3] |= 1 << (7 - (i & 7));
    }
  });
  return unpackScheme(code);
}

// A shared scheme as one the user can save (no id yet), or null
function cleanScheme(s) {
  if (!s || typeof s != "object") {
    return null;
  }
  const out = { name: String(s.name ?? "").trim().slice(0, 40) || "Shared scheme", seeds: s.seeds };
  for (const key of ["gradient", "grain", "mode", "light", "dark", "created"]) {
    if (s[key] != null) {
      out[key] = s[key];
    }
  }
  return FzColors.validScheme({ id: "shared", ...out }) ? out : null;
}

/**
 * The scheme in a card image (PNG, JPEG, WebP...), without an id, or null
 * when it isn't a card or can't be read.
 * @param {Document} doc
 * @param {Uint8Array} bytes
 */
export async function readCard(doc, bytes) {
  try {
    const data = JSON.parse(readText(bytes));
    if (data?.format === FORMAT) {
      const scheme = cleanScheme(data.scheme);
      if (scheme) {
        return scheme;
      }
    }
  } catch {}
  return cleanScheme(await readCode(doc, bytes));
}

export const FzSchemeCard = { drawCard, cardPng, readCard, subtitle, formatDate };
