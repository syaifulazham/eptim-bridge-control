import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bridge', {
  onReady(cb: (info: { port: number }) => void): void {
    ipcRenderer.once('bridge:ready', (_e, info) => cb(info));
  },

  onFrame(cb: (frame: unknown) => void): void {
    ipcRenderer.on('bridge:frame', (_e, frame) => cb(frame));
  },

  connect(): Promise<void> {
    return ipcRenderer.invoke('bridge:connect');
  },

  disconnect(): Promise<void> {
    return ipcRenderer.invoke('bridge:disconnect');
  },

  selfTest(): Promise<string> {
    return ipcRenderer.invoke('bridge:selftest');
  },
});
