import { Tray, Menu, app, nativeImage, clipboard, dialog } from 'electron';
import * as path from 'path';
import type { BridgeWebSocketServer } from './wsServer';
import { showMonitor, toggleMonitor } from './window';

let trayRef: Tray | null = null;

export function createTray(server: BridgeWebSocketServer): Tray {
  const icon = loadIcon();
  const tray = new Tray(icon);
  tray.setToolTip('Eptim Bridge Control');

  // macOS: show a short text label so the tray is visible without a proper icon
  if (process.platform === 'darwin') {
    tray.setTitle(' EBC');
  }

  // Single click → toggle the monitor window
  tray.on('click', () => toggleMonitor());

  trayRef = tray;
  rebuildMenu(tray, server, 'Disconnected');
  return tray;
}

export function setTrayStatus(status: string, server: BridgeWebSocketServer): void {
  if (trayRef) rebuildMenu(trayRef, server, status);
}

function rebuildMenu(tray: Tray, server: BridgeWebSocketServer, status: string): void {
  const menu = Menu.buildFromTemplate([
    { label: 'Eptim Bridge Control', enabled: false },
    { label: `Status: ${status}`,    enabled: false },
    { label: `WS: ws://127.0.0.1:${server.port}`, enabled: false },
    { type: 'separator' },
    { label: 'Show Monitor',   click: () => showMonitor() },
    { type: 'separator' },
    {
      label: 'Run Self-Test…',
      click: () => runSelfTestDialog(server),
    },
    { type: 'separator' },
    { label: 'Quit Eptim Bridge Control', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
}

function loadIcon(): Electron.NativeImage {
  const iconFile = path.join(__dirname, '..', 'assets', 'icon.png');
  try {
    const img = nativeImage.createFromPath(iconFile);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  } catch { /**/ }

  // Fallback: minimal 1×1 transparent PNG placeholder
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII='
  );
}

async function runSelfTestDialog(server: BridgeWebSocketServer): Promise<void> {
  const result = await server.droneConnection.runSelfTest();
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Eptim Bridge — Self-Test',
    message: 'Self-Test Results',
    detail: result,
    buttons: ['Copy to Clipboard', 'Close'],
    defaultId: 0,
  });
  if (response === 0) clipboard.writeText(result);
}
