import { app, dialog, ipcMain, type Event as ElectronEvent } from 'electron';
import * as dgram from 'dgram';
import { BridgeWebSocketServer } from './wsServer';
import { createTray, setTrayStatus, setTrayUpdateAvailable } from './tray';
import { createMonitorWindow, sendToRenderer, showMonitor } from './window';
import { initUpdater, checkForUpdates } from './updater';
import type { OutboundFrame } from './lib/droneBridge/protocol';

// Single-instance guard
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => showMonitor());

let server: BridgeWebSocketServer | null = null;

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  server = new BridgeWebSocketServer();

  try {
    await server.start();
  } catch {
    await dialog.showMessageBox({
      type:    'error',
      title:   'Eptim Bridge Control',
      message: 'Could not start WebSocket server',
      detail:  'Ports 48714, 48713, and 48712 are all in use.\nClose other Bridge Control instances and try again.',
    });
    app.quit();
    return;
  }

  createMonitorWindow();
  createTray(server);

  sendToRenderer('bridge:ready', { port: server.port });

  server.onFrame = (frame: OutboundFrame) => {
    if (!server) return;
    sendToRenderer('bridge:frame', frame);
    switch (frame.type) {
      case 'connected':    setTrayStatus(`Connected — ${frame.drone}`, server); break;
      case 'disconnected': setTrayStatus('Disconnected', server); break;
      case 'error':
        if (frame.code !== 'HANDSHAKE_SLOW') setTrayStatus(`Error: ${frame.code}`, server);
        break;
    }
  };

  // Bridge IPC
  ipcMain.handle('bridge:connect',    () => server?.droneConnection.connect());
  ipcMain.handle('bridge:disconnect', () => server?.droneConnection.disconnect());
  ipcMain.handle('bridge:selftest',   () => server?.droneConnection.runSelfTest());

  // Update IPC — renderer can request an immediate check
  ipcMain.on('update:check', () => checkForUpdates());

  // Wire updater — forwards update:status events to renderer;
  // also updates the tray badge when an update is available/ready
  initUpdater();

  // Re-broadcast update status to tray when state changes
  // (initUpdater calls sendToRenderer directly; we also watch from main)
  ipcMain.on('_update:tray', (_e, { version }: { version: string | null }) => {
    if (server) setTrayUpdateAvailable(version, server);
  });

  triggerLocalNetworkPermission();
});

app.on('window-all-closed', () => { /* tray-only — keep running */ });

app.on('will-quit', (e: ElectronEvent) => {
  e.preventDefault();
  server?.stop().then(() => app.exit(0));
});

function triggerLocalNetworkPermission(): void {
  if (process.platform !== 'darwin') return;
  for (const ip of ['192.168.10.1', '192.168.43.1', '192.168.100.1']) {
    const sock = dgram.createSocket('udp4');
    sock.send(Buffer.alloc(0), 8889, ip, () => {
      try { sock.close(); } catch { /**/ }
    });
  }
}
