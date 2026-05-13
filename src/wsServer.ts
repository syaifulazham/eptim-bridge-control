import { WebSocketServer, WebSocket } from 'ws';
import type { InboundFrame, OutboundFrame, SendFrame } from './lib/droneBridge/protocol';
import { DroneConnection } from './droneConnection';

const WS_PORTS = [48714, 48713, 48712];

export class BridgeWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private readonly drone: DroneConnection;
  private _port = 0;

  /** Called for every outbound frame — lets main.ts react to status changes. */
  onFrame?: (frame: OutboundFrame) => void;

  constructor() {
    this.drone = new DroneConnection(this.broadcast.bind(this));
  }

  async start(): Promise<number> {
    for (const port of WS_PORTS) {
      try {
        await this.tryBind(port);
        console.log(`[ws] listening on ws://127.0.0.1:${port}`);
        return port;
      } catch {
        console.warn(`[ws] port ${port} unavailable`);
      }
    }
    throw new Error('All WS ports (48714/48713/48712) are in use.');
  }

  private tryBind(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port });

      wss.once('listening', () => {
        this._port = port;
        this.wss = wss;
        wss.on('connection', this.handleConnection.bind(this));
        resolve();
      });

      wss.once('error', reject);
    });
  }

  private handleConnection(ws: WebSocket): void {
    console.log('[ws] webapp connected');
    this.clients.add(ws);

    ws.on('message', async (raw) => {
      let frame: InboundFrame;
      try {
        frame = JSON.parse(raw.toString()) as InboundFrame;
      } catch {
        return;
      }

      console.log('[ws] ←', JSON.stringify(frame));

      switch (frame.type) {
        case 'connect':
          await this.drone.connect();
          break;
        case 'disconnect':
          await this.drone.disconnect();
          break;
        case 'send':
          await this.drone.sendOp(frame as SendFrame);
          break;
      }
    });

    ws.on('close', () => {
      console.log('[ws] webapp disconnected');
      this.clients.delete(ws);
    });

    ws.on('error', (err) => {
      console.error('[ws] client error:', err.message);
      this.clients.delete(ws);
    });
  }

  broadcast(frame: OutboundFrame): void {
    const msg = JSON.stringify(frame);
    console.log('[ws] →', msg);

    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }

    this.onFrame?.(frame);
  }

  get port(): number {
    return this._port;
  }

  get droneConnection(): DroneConnection {
    return this.drone;
  }

  async stop(): Promise<void> {
    this.drone.cleanup();
    await new Promise<void>((resolve) => {
      if (!this.wss) { resolve(); return; }
      this.wss.close(() => resolve());
    });
  }
}
