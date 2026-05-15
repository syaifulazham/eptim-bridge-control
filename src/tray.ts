import { Tray, Menu, app, nativeImage, clipboard, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { BridgeWebSocketServer } from './wsServer';
import { showMonitor, toggleMonitor } from './window';
import { checkForUpdates } from './updater';

let trayRef: Tray | null = null;
let currentStatus = 'Disconnected';
let updateVersion: string | null = null; // set when an update is available/ready

export function createTray(server: BridgeWebSocketServer): Tray {
  const icon = loadIcon();
  const tray = new Tray(icon);
  tray.setToolTip('Eptim Bridge Control');

  if (process.platform === 'darwin') tray.setTitle(' EBC');

  tray.on('click', () => toggleMonitor());

  trayRef = tray;
  rebuildMenu(tray, server);
  return tray;
}

export function setTrayStatus(status: string, server: BridgeWebSocketServer): void {
  currentStatus = status;
  if (trayRef) rebuildMenu(trayRef, server);
}

export function setTrayUpdateAvailable(version: string | null, server: BridgeWebSocketServer): void {
  updateVersion = version;
  if (trayRef) rebuildMenu(trayRef, server);
  if (version && process.platform === 'darwin') {
    trayRef?.setTitle(` EBC ↑`);
  } else if (process.platform === 'darwin') {
    trayRef?.setTitle(' EBC');
  }
}

function rebuildMenu(tray: Tray, server: BridgeWebSocketServer): void {
  const updateSection: Electron.MenuItemConstructorOptions[] = updateVersion
    ? [
        { type: 'separator' },
        {
          label: `↑ Update v${updateVersion} ready — click to install`,
          click: () => showMonitor(),
        },
      ]
    : [];

  const uninstallSection: Electron.MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          { type: 'separator' },
          { label: 'Uninstall Eptim Bridge Control…', click: () => promptUninstall() },
        ]
      : [];

  const menu = Menu.buildFromTemplate([
    { label: 'Eptim Bridge Control', enabled: false },
    { label: `Status: ${currentStatus}`, enabled: false },
    { label: `WS: ws://127.0.0.1:${server.port}`, enabled: false },
    { type: 'separator' },
    { label: 'Show Monitor', click: () => showMonitor() },
    { type: 'separator' },
    { label: 'Run Self-Test…',     click: () => runSelfTestDialog(server) },
    { label: 'Check for Updates',  click: () => { showMonitor(); checkForUpdates(); } },
    ...updateSection,
    { type: 'separator' },
    ...uninstallSection,
    { label: 'Quit Eptim Bridge Control', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
}

// ── macOS clean uninstall ─────────────────────────────────────────────────────

async function promptUninstall(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type:    'warning',
    title:   'Uninstall Eptim Bridge Control',
    message: 'Remove all app data?',
    detail:
      'This will delete logs, settings, and update cache from:\n' +
      `  ${app.getPath('userData')}\n\n` +
      'After clicking Remove, also drag Eptim Bridge Control.app\n' +
      'from /Applications to the Trash to complete the uninstall.',
    buttons: ['Remove App Data & Quit', 'Cancel'],
    defaultId: 1,
    cancelId:  1,
  });

  if (response !== 0) return;

  const userData = app.getPath('userData');
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch (err) {
    await dialog.showMessageBox({
      type:    'error',
      title:   'Uninstall',
      message: 'Could not remove app data',
      detail:  (err as Error).message,
    });
    return;
  }

  await dialog.showMessageBox({
    type:    'info',
    title:   'Uninstall',
    message: 'App data removed.',
    detail:  'Now drag Eptim Bridge Control.app from /Applications to the Trash.',
    buttons: ['Open Applications Folder', 'Done'],
    defaultId: 0,
  }).then(({ response: r }) => {
    if (r === 0) shell.openPath('/Applications');
  });

  app.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadIcon(): Electron.NativeImage {
  const iconFile = path.join(__dirname, '..', 'assets', 'icon.png');
  try {
    const img = nativeImage.createFromPath(iconFile);
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  } catch { /**/ }
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII='
  );
}

async function runSelfTestDialog(server: BridgeWebSocketServer): Promise<void> {
  const result = await server.droneConnection.runSelfTest();
  const { response } = await dialog.showMessageBox({
    type:    'info',
    title:   'Eptim Bridge — Self-Test',
    message: 'Self-Test Results',
    detail:  result,
    buttons: ['Copy to Clipboard', 'Close'],
    defaultId: 0,
  });
  if (response === 0) clipboard.writeText(result);
}
