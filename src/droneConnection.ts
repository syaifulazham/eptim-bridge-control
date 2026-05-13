import * as dgram from 'dgram';
import * as child_process from 'child_process';
import { pickDroneInterface, listAllInterfaces, DroneInterface } from './interfacePicker';
import {
  DRONE_CMD_PORT, HEARTBEAT_MS, LINK_TIMEOUT_MS,
  buildHeartbeat, buildTelemSubscribe, encodeFrame, parseTelemetry,
  type TelemetryData,
} from './lib/droneProtocol';
import type { OutboundFrame, ErrorCode, SendFrame } from './lib/droneBridge/protocol';

export type BroadcastFn = (frame: OutboundFrame) => void;

const TELEM_SUBSCRIBE_INTERVAL_MS = 2000;
const TELEM_SUBSCRIBE_MAX         = 5;

export class DroneConnection {
  private cmdSocket:  dgram.Socket | null = null;
  private heartbeatTimer:  NodeJS.Timeout | null = null;
  private subscribeTimer:  NodeJS.Timeout | null = null;
  private linkWatchTimer:  NodeJS.Timeout | null = null;
  private connected  = false;
  private connecting = false;
  private droneIface: DroneInterface | null = null;
  private lastAnyResponseMs = 0; // timestamp of last packet received from drone
  private lastTelemMs = 0;
  private connectTime = 0;
  private _telemetryCount = 0;
  private readonly broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connecting) return;
    if (this.connected) await this.disconnect();
    this.connecting = true;
    try { await this._connect(); } finally { this.connecting = false; }
  }

  async disconnect(): Promise<void> {
    if (!this.connected && !this.connecting) return;
    this.cleanup();
    this.broadcast({ type: 'disconnected' });
  }

  async sendOp(frame: SendFrame): Promise<void> {
    if (!this.connected || !this.cmdSocket || !this.droneIface) {
      this.emitError('NO_INTERFACE', 'Not connected to drone. Connect first.');
      return;
    }

    const buf = encodeFrame(frame);
    if (buf === null) {
      this.emitDiag(frame.op, false, `${frame.op} has no binary representation in this build.`);
      return;
    }
    this.sendBinary(buf);
  }

  isConnected(): boolean { return this.connected; }
  get telemetryCount(): number { return this._telemetryCount; }

  cleanup(): void {
    this.connected  = false;
    this.connecting = false;
    for (const t of [this.heartbeatTimer, this.subscribeTimer, this.linkWatchTimer]) {
      if (t) clearInterval(t);
    }
    this.heartbeatTimer = this.subscribeTimer = this.linkWatchTimer = null;
    if (this.cmdSocket) { try { this.cmdSocket.close(); } catch { /**/ } this.cmdSocket = null; }
    this.droneIface = null;
  }

  // ── Connection sequence ────────────────────────────────────────────────────

  private async _connect(): Promise<void> {
    const iface = pickDroneInterface();
    this.emitDiag('interface_pick', !!iface,
      iface ? `${iface.name} ${iface.localIp} → ${iface.droneIp}` : listAllInterfaces());
    if (!iface) {
      this.emitError('NO_INTERFACE', 'Join the drone WiFi (LiteBee Wing_...) and try again.');
      return;
    }
    this.droneIface = iface;

    const reachable = await this.probeGateway(iface.droneIp);
    this.emitDiag('gateway_probe', reachable,
      reachable ? `${iface.droneIp} responded` : `${iface.droneIp} — no reply within 1 s`);
    if (!reachable) {
      this.emitError('DRONE_UNREACHABLE', 'Drone is not answering ping. Power-cycle the drone.');
      return;
    }

    // Single bidirectional socket — drone replies to our source port
    try {
      await this.openCmdSocket(iface.localIp);
      this.emitDiag('cmd_socket', true, `bound to ${iface.localIp}`);
    } catch (err) {
      this.emitError('FIREWALL_BLOCKED', `Command socket: ${(err as Error).message}`);
      this.cleanup();
      return;
    }

    this.connected  = true;
    this.connectTime = Date.now();
    this.lastAnyResponseMs = 0;
    this.lastTelemMs = 0;

    this.startSubscribeBurst();
    this.startHeartbeat();
    this.startLinkWatchdog();

    this.broadcast({ type: 'connected', drone: 'LiteBee Wing', ip: iface.droneIp });
    this.broadcast({ type: 'status', tcp: false, udp: true });
  }

  // ── Sockets ────────────────────────────────────────────────────────────────

  // Single socket used for both sending commands and receiving all drone responses.
  // The drone sends telemetry/acks back to whichever source port it received packets from.
  private openCmdSocket(localIp: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.once('error', reject);
      sock.on('message', (buf) => {
        this.lastAnyResponseMs = Date.now();
        const t = parseTelemetry(buf);
        if (t) {
          this.handleTelemetry(t);
        }
        // Non-telemetry frames (heartbeat acks, subscribe acks) are silently consumed —
        // lastAnyResponseMs is already updated above so the link watchdog stays happy.
      });
      sock.bind({ address: localIp, port: 0 }, () => {
        this.cmdSocket = sock;
        resolve();
      });
    });
  }

  // ── Telemetry subscribe burst ──────────────────────────────────────────────
  // Send getBaseInfo several times — drone only starts streaming after it sees one.

  private startSubscribeBurst(): void {
    let attempts = 0;
    const sub = buildTelemSubscribe();

    const send = () => {
      this.sendBinary(sub);
      attempts++;
      this.emitDiag('telem_subscribe', true, `sent (attempt ${attempts})`);
    };

    send();

    this.subscribeTimer = setInterval(() => {
      if (this.lastTelemMs > 0) {
        clearInterval(this.subscribeTimer!);
        this.subscribeTimer = null;
        this.emitDiag('telem_subscribe', true, 'telemetry flowing — subscribe burst done');
        return;
      }
      if (attempts >= TELEM_SUBSCRIBE_MAX) {
        clearInterval(this.subscribeTimer!);
        this.subscribeTimer = null;
        this.emitDiag('telem_subscribe', false, `no telemetry after ${TELEM_SUBSCRIBE_MAX} subscribes`);
        return;
      }
      send();
    }, TELEM_SUBSCRIBE_INTERVAL_MS);
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.cmdSocket) this.sendBinary(buildHeartbeat());
    }, HEARTBEAT_MS);
  }

  // ── Link watchdog ──────────────────────────────────────────────────────────

  private startLinkWatchdog(): void {
    this.linkWatchTimer = setInterval(() => {
      if (!this.connected) return;

      // Use any packet from drone (not just telemetry) to gauge link health
      const idleMs = this.lastAnyResponseMs === 0
        ? Date.now() - this.connectTime
        : Date.now() - this.lastAnyResponseMs;

      if (idleMs > LINK_TIMEOUT_MS) {
        const msg = `No response from drone for ${(idleMs / 1000).toFixed(1)} s — drone may have powered off or moved out of range.`;
        this.emitError('DRONE_LOST', msg);
        this.cleanup();
        this.broadcast({ type: 'disconnected' });
      }
    }, 1000);
  }

  // ── Telemetry handler ──────────────────────────────────────────────────────

  private handleTelemetry(t: TelemetryData): void {
    this.lastTelemMs = Date.now();
    this._telemetryCount++;

    this.broadcast({
      type:  'telemetry',
      x:     t.x,
      y:     t.y,
      z:     t.z,
      vol:   t.vol,
      yaw:   t.yaw,
      pitch: t.pitch,
      roll:  t.roll,
    });
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  private sendBinary(buf: Buffer): void {
    if (!this.cmdSocket || !this.droneIface) return;
    this.cmdSocket.send(buf, DRONE_CMD_PORT, this.droneIface.droneIp, (err) => {
      if (err) console.error('[drone] send error:', err.message);
    });
  }

  // ── Gateway probe ──────────────────────────────────────────────────────────

  probeGateway(ip: string): Promise<boolean> {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const [cmd, ...args] = isWin
        ? ['ping', '-n', '1', '-w', '500', ip]
        : ['ping', '-c', '1', '-W', '1', ip];

      const proc = child_process.spawn(cmd, args, { stdio: 'ignore' });
      let done = false;
      proc.on('close', (code) => { if (!done) { done = true; resolve(code === 0); } });
      proc.on('error', ()     => { if (!done) { done = true; resolve(false); } });
      setTimeout(() => { if (!done) { done = true; try { proc.kill(); } catch { /**/ } resolve(false); } }, 1500);
    });
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  private emitError(code: ErrorCode, msg: string): void {
    this.broadcast({ type: 'error', code, msg });
    this.emitDiag(code.toLowerCase(), false, msg);
  }

  private emitDiag(step: string, ok: boolean, detail: string): void {
    this.broadcast({ type: 'diag', step, ok, detail });
    console.log(`[diag] ${step}: ${ok ? 'OK' : 'FAIL'} — ${detail}`);
  }

  // ── Self-test ──────────────────────────────────────────────────────────────

  async runSelfTest(): Promise<string> {
    const lines: string[] = ['=== Eptim Bridge Control — Self-Test ===', ''];

    const iface = pickDroneInterface();
    lines.push('1. Network interfaces:');
    lines.push(listAllInterfaces());
    if (iface) {
      lines.push(`   ✓ Picked: ${iface.name}  local=${iface.localIp}  drone=${iface.droneIp}`);
    } else {
      lines.push('   ✗ No interface found in drone subnet');
      lines.push('   → Join the drone WiFi (LiteBee Wing_...) and run self-test again.');
      return lines.join('\n');
    }
    lines.push('');

    const pingOk = await this.probeGateway(iface.droneIp);
    lines.push(`2. Ping ${iface.droneIp}: ${pingOk ? '✓ OK' : '✗ FAIL — no reply'}`);
    if (!pingOk) {
      lines.push('   → Power-cycle the drone and try again.');
      return lines.join('\n');
    }
    lines.push('');

    lines.push(`3. Protocol: binary on port ${DRONE_CMD_PORT} (bidirectional — drone replies to our source port)`);
    lines.push(`   Telemetry packets received so far: ${this._telemetryCount}`);
    lines.push('');

    if (this.connected) {
      const idleMs = this.lastTelemMs > 0 ? Date.now() - this.lastTelemMs : null;
      lines.push(`4. Connection: ✓ active  last telem: ${idleMs !== null ? `${idleMs} ms ago` : 'none yet'}`);
    } else {
      lines.push('4. Connection: not connected');
    }
    lines.push('');
    lines.push('Self-test complete. Copy and paste this text when filing a support ticket.');
    return lines.join('\n');
  }
}
