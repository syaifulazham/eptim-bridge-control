import { autoUpdater } from 'electron-updater';
import { ipcMain, app } from 'electron';
import { sendToRenderer } from './window';

export type UpdateState =
  | 'idle' | 'checking' | 'available' | 'not-available'
  | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  error?: string;
}

function emit(status: UpdateStatus): void {
  sendToRenderer('update:status', status);
}

export function initUpdater(): void {
  // In dev (not packaged) disable auto-download to avoid spamming GitHub API
  autoUpdater.autoDownload    = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    emit({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    emit({ state: 'available', version: info.version });
    ipcMain.emit('_update:tray', null, { version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    emit({ state: 'not-available' });
    // Revert to idle quickly — only show "no update" if user triggered the check
    setTimeout(() => emit({ state: 'idle' }), 4000);
  });

  autoUpdater.on('download-progress', (p) => {
    emit({ state: 'downloading', percent: Math.round(p.percent) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'ready', version: info.version });
    ipcMain.emit('_update:tray', null, { version: info.version });
  });

  autoUpdater.on('error', (err) => {
    const msg = err?.message ?? String(err);
    // Swallow "no published versions" in dev — not a real error
    if (!msg.includes('No published versions')) {
      emit({ state: 'error', error: msg });
    }
    setTimeout(() => emit({ state: 'idle' }), 6000);
  });

  // Renderer → main: user clicked Download
  ipcMain.on('update:download', () => {
    autoUpdater.downloadUpdate().catch(console.error);
  });

  // Renderer → main: user clicked Restart & Install
  ipcMain.on('update:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // Check 12 s after launch so startup isn't delayed
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => { /* network offline etc. */ });
  }, 12_000);
}

export function checkForUpdates(): void {
  autoUpdater.checkForUpdates().catch(console.error);
}
