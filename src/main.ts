import { app, dialog, ipcMain, type Event as ElectronEvent } from 'electron';
import * as dgram from 'dgram';
import { BridgeWebSocketServer } from './wsServer';
import { createTray, setTrayStatus } from './tray';
import { createMonitorWindow, sendToRenderer, showMonitor } from './window';
import type { OutboundFrame } from './lib/droneBridge/protocol';

// Single-instance guard
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Re-focus the window when a second instance tries to open
app.on('second-instance', () => showMonitor());

let server: BridgeWebSocketServer | null = null;

app.whenReady().then(async () => {
  // macOS: tray-only — don't show in Dock
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }

  server = new BridgeWebSocketServer();

  try {
    await server.start();
  } catch (err) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Eptim Bridge Control',
      message: 'Could not start WebSocket server',
      detail: 'Ports 48714, 48713, and 48712 are all in use.\nClose other Bridge Control instances and try again.',
    });
    app.quit();
    return;
  }

  // Create monitor window and system tray
  createMonitorWindow();
  createTray(server);

  // Tell the renderer which port the bridge is on
  sendToRenderer('bridge:ready', { port: server.port });

  // Forward every outbound frame to the renderer AND update the tray status
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

  // IPC handlers — renderer buttons call these
  ipcMain.handle('bridge:connect',    () => server?.droneConnection.connect());
  ipcMain.handle('bridge:disconnect', () => server?.droneConnection.disconnect());
  ipcMain.handle('bridge:selftest',   () => server?.droneConnection.runSelfTest());

  // macOS 14+: trigger Local Network permission prompt at first launch
  triggerLocalNetworkPermission();
});

// Prevent automatic quit when all (zero) windows are closed.
app.on('window-all-closed', () => {
  // Intentionally empty — tray-only app stays running
});

app.on('will-quit', (e: ElectronEvent) => {
  e.preventDefault();
  server?.stop().then(() => app.exit(0));
});

function triggerLocalNetworkPermission(): void {
  if (process.platform !== 'darwin') return;
  // Send a zero-byte UDP packet to each known drone gateway subnet so macOS 14+
  // shows the Local Network permission dialog before the user clicks Connect.
  // One dialog covers all local network access for the app.
  for (const ip of ['192.168.10.1', '192.168.43.1', '192.168.100.1']) {
    const sock = dgram.createSocket('udp4');
    sock.send(Buffer.alloc(0), 8889, ip, () => {
      try { sock.close(); } catch { /**/ }
    });
  }
}
