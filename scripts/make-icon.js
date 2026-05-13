#!/usr/bin/env node
/**
 * Generates assets/icon.png (22×22 white circle on transparent BG).
 * Requires the 'canvas' npm package: npm install canvas --save-dev
 *
 * Run once: npm run make-icon
 */
const fs = require('fs');
const path = require('path');

let canvas;
try {
  canvas = require('canvas');
} catch {
  console.error('Install canvas first: npm install canvas --save-dev');
  process.exit(1);
}

const SIZE = 22;
const c = canvas.createCanvas(SIZE, SIZE);
const ctx = c.getContext('2d');

// White filled circle (macOS template image friendly)
ctx.clearRect(0, 0, SIZE, SIZE);
ctx.fillStyle = 'white';
ctx.beginPath();
ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
ctx.fill();

const outPath = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(outPath, c.toBuffer('image/png'));
console.log('Written:', outPath);
