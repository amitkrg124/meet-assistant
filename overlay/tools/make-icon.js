// Generates icons/app.png — the 256x256 application icon electron-builder needs
// for the Windows/macOS/Linux targets. The two existing icons are 32x32 tray
// glyphs and are too small for an app icon, which builder rejects outright.
//
// Written as a script rather than a committed binary so the icon stays
// editable: tweak the constants below and re-run `node tools/make-icon.js`.
//
// No image libraries are used. zlib ships with Node, and a PNG is little more
// than a zlib-deflated stream of scanlines plus three CRC-checked chunks.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256;
const SS = 4; // supersampling factor per axis; 16 samples/pixel of antialiasing

// Palette lifted from overlay.css so the icon matches the UI it launches.
const BG_TOP = [27, 32, 48];
const BG_BOTTOM = [13, 16, 22];
const THEM = [104, 168, 255]; // --them
const ME = [176, 147, 255]; // --me
const RIM = [255, 255, 255];
const RIM_ALPHA = 0.1;

const CARD_RADIUS = SIZE * 0.22;
const RIM_WIDTH = 1.5;

// A five-bar level meter, the same motif the overlay uses to show it is hearing
// something. Heights are deliberately asymmetric so it reads as live audio
// rather than a static bar chart.
const BAR_W = 18;
const BAR_GAP = 14;
const BAR_HEIGHTS = [56, 98, 134, 92, 62];

const barsWidth = BAR_HEIGHTS.length * BAR_W + (BAR_HEIGHTS.length - 1) * BAR_GAP;
const barsX0 = (SIZE - barsWidth) / 2;
const CENTER_Y = SIZE / 2;

/** Signed-distance test for a rounded rectangle; negative is inside. */
function roundedRectDist(x, y, x0, y0, w, h, r) {
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const qx = Math.abs(x - cx) - (w / 2 - r);
  const qy = Math.abs(y - cy) - (h / 2 - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Source-over composite of a straight-alpha colour onto an accumulator. */
function over(dst, src, srcA) {
  const outA = srcA + dst[3] * (1 - srcA);
  if (outA <= 0) return [0, 0, 0, 0];
  for (let i = 0; i < 3; i++) {
    dst[i] = (src[i] * srcA + dst[i] * dst[3] * (1 - srcA)) / outA;
  }
  dst[3] = outA;
  return dst;
}

/** Colour of a single supersample, as straight-alpha RGBA. */
function sample(x, y) {
  const px = [0, 0, 0, 0];

  // Card body.
  const cardD = roundedRectDist(x, y, 0, 0, SIZE, SIZE, CARD_RADIUS);
  if (cardD < 0) {
    over(px, mixRgb(BG_TOP, BG_BOTTOM, y / SIZE), 1);
  }

  // Inner rim, just inside the card edge.
  if (cardD < 0 && cardD > -RIM_WIDTH) {
    over(px, RIM, RIM_ALPHA);
  }

  // Meter bars.
  for (let i = 0; i < BAR_HEIGHTS.length; i++) {
    const h = BAR_HEIGHTS[i];
    const bx = barsX0 + i * (BAR_W + BAR_GAP);
    const d = roundedRectDist(x, y, bx, CENTER_Y - h / 2, BAR_W, h, BAR_W / 2);
    if (d < 0) {
      const t = i / (BAR_HEIGHTS.length - 1);
      over(px, mixRgb(THEM, ME, t), 1);
    }
  }

  return px;
}

function render() {
  // One filter byte (0 = None) plus RGBA per pixel, per scanline.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  const step = 1 / SS;
  const offset = step / 2;

  for (let py = 0; py < SIZE; py++) {
    const rowStart = py * (1 + SIZE * 4);
    raw[rowStart] = 0;
    for (let px = 0; px < SIZE; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const s = sample(px + sx * step + offset, py + sy * step + offset);
          // Premultiply before averaging, or edge pixels pick up colour from
          // fully transparent samples.
          r += s[0] * s[3];
          g += s[1] * s[3];
          b += s[2] * s[3];
          a += s[3];
        }
      }
      const n = SS * SS;
      const i = rowStart + 1 + px * 4;
      if (a > 0) {
        raw[i] = Math.round(Math.min(255, r / a));
        raw[i + 1] = Math.round(Math.min(255, g / a));
        raw[i + 2] = Math.round(Math.min(255, b / a));
      }
      raw[i + 3] = Math.round((a / n) * 255);
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(raw, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, "..", "icons", "app.png");
fs.writeFileSync(out, encodePng(render(), SIZE));
console.log(`wrote ${out} (${SIZE}x${SIZE})`);
