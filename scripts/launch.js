#!/usr/bin/env node
// On macOS, launching the Electron binary directly from a terminal inherits
// ELECTRON_RUN_AS_NODE and skips LaunchServices — both break things.
// LaunchServices is required for TCC (Local Network permission dialog) to fire.
// On other platforms we just exec the binary directly.

const { execFileSync, spawn } = require('child_process');
const path = require('path');

const appPath = path.resolve(__dirname, '../node_modules/electron/dist/Electron.app');
const mainJs  = path.resolve(__dirname, '../dist/main.js');

if (process.platform === 'darwin') {
  // 'open -W' blocks until the app exits.
  // '--args' passes everything after as argv to the Electron app.
  // Unset ELECTRON_RUN_AS_NODE so Electron APIs work normally.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn('open', ['-W', '-a', appPath, '--args', mainJs], {
    env,
    stdio: 'inherit',
  });

  child.on('exit', code => process.exit(code ?? 0));
} else {
  const electronBin = require('electron');
  const child = spawn(electronBin, [mainJs], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: 'inherit',
  });
  child.on('exit', code => process.exit(code ?? 0));
}
