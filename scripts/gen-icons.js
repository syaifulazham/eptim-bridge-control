#!/usr/bin/env node
// Generates all icon assets needed for electron-builder:
//   assets/icon.png   — 1024×1024 source + tray (22×22 used at runtime)
//   assets/icon.icns  — macOS installer icon
//   assets/icon.ico   — Windows installer icon
//
// No external npm packages required — uses built-in zlib, sips (macOS), and iconutil.

'use strict';
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

const ROOT   = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

// ── PNG encoder ───────────────────────────────────────────────────────────────

function crc32(buf) {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const ln = Buffer.alloc(4); ln.writeUInt32BE(data.length);
  const cc = Buffer.alloc(4); cc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([ln, tb, data, cc]);
}

function makePng(w, h, getPixel) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    row[0] = 0; // filter none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = getPixel(x, y, w, h);
      const i = 1 + x * 4;
      row[i] = r; row[i+1] = g; row[i+2] = b; row[i+3] = a;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const comp = zlib.deflateSync(raw, { level: 7 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', comp),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Icon design: dark circle + concentric rings + crosshair ──────────────────

function drawIcon(x, y, w, h) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const R  = w * 0.5;
  const dx = x - cx, dy = y - cy;
  const d  = Math.sqrt(dx * dx + dy * dy) / R; // 0=center, 1=edge

  // Outside circle → transparent
  if (d > 0.97) return [0, 0, 0, 0];

  // Background: dark navy
  const BG = [24, 24, 40, 255];

  // Outer decorative ring
  if (d > 0.82 && d <= 0.91) return [180, 180, 255, 255];

  // Mid ring
  if (d > 0.62 && d <= 0.66) return [140, 140, 220, 200];

  // Crosshair lines (horizontal + vertical, thin)
  const ax = Math.abs(dx) / R, ay = Math.abs(dy) / R;
  if (d > 0.18 && d < 0.95) {
    if (ax < 0.035 || ay < 0.035) return [220, 220, 255, 230];
  }

  // Center dot
  if (d < 0.10) return [255, 255, 255, 255];

  return BG;
}

// ── Generate 1024×1024 PNG ────────────────────────────────────────────────────

console.log('Generating 1024×1024 source PNG…');
const SIZE = 1024;
const srcPng = makePng(SIZE, SIZE, drawIcon);
const srcPath = path.join(ASSETS, 'icon.png');
fs.writeFileSync(srcPath, srcPng);
console.log('  Written:', srcPath);

// ── macOS iconset → .icns  (requires sips + iconutil) ────────────────────────

function run(cmd, args) {
  const r = cp.spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed:\n${r.stderr || r.stdout}`);
}

function makeIcns() {
  const setDir = path.join(ASSETS, 'icon.iconset');
  fs.mkdirSync(setDir, { recursive: true });

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of sizes) {
    const name = `icon_${s}x${s}.png`;
    run('sips', ['--resampleHeightWidth', String(s), String(s), srcPath,
                 '--out', path.join(setDir, name)]);
    // Retina @2x variant (skip for 1024 since there's no 2048)
    if (s <= 512) {
      const s2 = s * 2;
      const n2 = `icon_${s}x${s}@2x.png`;
      run('sips', ['--resampleHeightWidth', String(s2), String(s2), srcPath,
                   '--out', path.join(setDir, n2)]);
    }
  }

  const icnsPath = path.join(ASSETS, 'icon.icns');
  run('iconutil', ['-c', 'icns', setDir, '-o', icnsPath]);
  fs.rmSync(setDir, { recursive: true, force: true });
  console.log('  Written:', icnsPath);
}

if (process.platform === 'darwin') {
  console.log('Generating icon.icns…');
  try { makeIcns(); } catch (e) { console.warn('  WARN:', e.message); }
} else {
  console.log('  (skip icns — not on macOS)');
}

// ── Windows .ico (multi-res PNG container) ────────────────────────────────────
// ICO format: ICONDIR header + ICONDIRENTRY[] + raw image data.
// Modern Windows accepts PNG-inside-ICO starting with Vista.

console.log('Generating icon.ico…');

const icoSizes = [16, 32, 48, 256];

// Render each size as PNG bytes
const pngBuffers = icoSizes.map(s => {
  const buf = makePng(s, s, drawIcon);
  return buf;
});

// ICONDIR header (6 bytes)
const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0,               0); // reserved
iconDir.writeUInt16LE(1,               2); // type: ICO
iconDir.writeUInt16LE(icoSizes.length, 4); // image count

// Each ICONDIRENTRY is 16 bytes
const entrySize = 16;
const headerSize = 6 + entrySize * icoSizes.length;

const entries = [];
let offset = headerSize;
for (let i = 0; i < icoSizes.length; i++) {
  const s = icoSizes[i];
  const data = pngBuffers[i];
  const entry = Buffer.alloc(entrySize);
  entry[0] = s >= 256 ? 0 : s;  // width  (0 means 256 for ICO spec)
  entry[1] = s >= 256 ? 0 : s;  // height
  entry[2] = 0;                  // color count (0 = no palette)
  entry[3] = 0;                  // reserved
  entry.writeUInt16LE(1, 4);     // color planes
  entry.writeUInt16LE(32, 6);    // bits per pixel
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += data.length;
}

const icoPath = path.join(ASSETS, 'icon.ico');
fs.writeFileSync(icoPath, Buffer.concat([iconDir, ...entries, ...pngBuffers]));
console.log('  Written:', icoPath);

console.log('\nDone. Run "npm run package" to build installers.');
