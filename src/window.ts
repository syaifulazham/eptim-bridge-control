import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

let win: BrowserWindow | null = null;

export function createMonitorWindow(): BrowserWindow {
  const { height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 500,
    height: Math.min(780, screenH - 40),
    minWidth: 420,
    minHeight: 500,
    title: 'Eptim Bridge Control',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: '#0f0f1a',
    show: false, // show after ready-to-show to avoid flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => win?.show());

  // Hide on close rather than destroy, so it can be reopened from the tray.
  win.on('close', (e) => {
    e.preventDefault();
    win?.hide();
  });

  return win;
}

export function showMonitor(): void {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
}

export function toggleMonitor(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

export function sendToRenderer(channel: string, payload: unknown): void {
  if (!win || win.isDestroyed()) return;
  // If still loading, queue until the renderer is ready.
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      win?.webContents.send(channel, payload);
    });
  } else {
    win.webContents.send(channel, payload);
  }
}
