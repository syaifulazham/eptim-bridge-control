import * as dgram from 'dgram';
import * as child_process from 'child_process';
import { pickDroneInterface, listAllInterfaces, DroneInterface } from './interfacePicker';
import {
  DRONE_CMD_PORT, HEARTBEAT_MS, LINK_TIMEOUT_MS, LAND_Z_THRESHOLD,
  buildHeartbeat, buildTelemSubscribe, encodeFrame,
  isValidDroneFrame, parseTelemetry,
  type TelemetryData,
} from './lib/droneProtocol';
import type { OutboundFrame, ErrorCode, SendFrame } from './lib/droneBridge/protocol';

export type BroadcastFn = (frame: OutboundFrame) => void;

const TELEM_SUBSCRIBE_INTERVAL_MS = 2000;
const TELEM_SUBSCRIBE_MAX         = 5;
const SUSTAINED_LAND_INTERVAL_MS  = 300;
const SUSTAINED_LAND_TIMEOUT_MS   = 8000;
const TELEM_THROTTLE_MS           = 100;  // forward at ≤ 10 Hz
const DRONE_LOST_AFTER_CONNECT_MS = 3000; // silence threshold once connected

export class DroneConnection {
  private socket:   dgram.Socket | null = null;

  private heartbeatTimer:   NodeJS.Timeout | null = null;
  private subscribeTimer:   NodeJS.Timeout | null = null;
  private linkWatchTimer:   NodeJS.Timeout | null = null;
  private sustainedLandInt: NodeJS.Timeout | null = null;
  private sustainedLandOut: NodeJS.Timeout | null = null;

  private connected        = false;
  private connecting       = false;
  private connectedEmitted = false; // true once we've told the webapp we're up
  private droneIface: DroneInterface | null = null;

  private connectTime      = 0;
  private lastDroneReplyMs = 0; // last packet received from drone (any valid frame)
  private lastTelemBroadMs = 0; // last time we forwarded a telemetry frame
  private _telemetryCount  = 0;

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
    if (!this.connected || !this.socket || !this.droneIface) {
      this.emitError('NO_INTERFACE', 'Not connected to drone. Connect first.');
      return;
    }

    // Any new command cancels an in-progress sustained land
    this.stopSustainedLand();

    const buf = encodeFrame(frame);
    if (buf === null) {
      this.emitDiag(frame.op, false, `${frame.op} has no binary representation in this build.`);
      return;
    }

    this.sendBinary(buf);

    // land must be repeated every 300 ms — drone reverts to hover if it stops receiving it
    if (frame.op === 'land') this.startSustainedLand(buf);
  }

  isConnected(): boolean { return this.connected; }
  get telemetryCount(): number { return this._telemetryCount; }

  cleanup(): void {
    this.connected        = false;
    this.connecting       = false;
    this.connectedEmitted = false;
    this.stopSustainedLand();
    for (const t of [this.heartbeatTimer, this.subscribeTimer, this.linkWatchTimer]) {
      if (t) clearInterval(t);
    }
    this.heartbeatTimer = this.subscribeTimer = this.linkWatchTimer = null;
    if (this.socket) { try { this.socket.close(); } catch { /**/ } this.socket = null; }
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

    // Single bidirectional socket — drone replies to our source port (not a fixed telem port)
    try {
      await this.openSocket(iface.localIp);
      this.emitDiag('udp_socket', true, `bound to ${iface.localIp}`);
    } catch (err) {
      this.emitError('FIREWALL_BLOCKED', `UDP socket: ${(err as Error).message}`);
      return;
    }

    this.connected        = true;
    this.connectedEmitted = false;
    this.connectTime      = Date.now();
    this.lastDroneReplyMs = 0;

    this.startSubscribeBurst();
    this.startHeartbeat();
    this.startLinkWatchdog();
    // 'connected' frame is deferred until first valid drone reply (see handleFrame)
  }

  // ── Socket ─────────────────────────────────────────────────────────────────

  // One socket handles both sending (commands/heartbeats) and receiving (telemetry/acks).
  // The drone identifies us by source IP:port and replies to that exact address.
  private openSocket(localIp: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.once('error', reject);
      sock.on('message', (buf) => this.handleFrame(buf));
      sock.bind({ address: localIp, port: 0 }, () => {
        this.socket = sock;
        resolve();
      });
    });
  }

  // ── Inbound frame handler ──────────────────────────────────────────────────

  private handleFrame(buf: Buffer): void {
    if (!isValidDroneFrame(buf)) return;

    this.lastDroneReplyMs = Date.now();

    // Emit 'connected' the first time the drone replies — confirms our packets reach it
    if (!this.connectedEmitted && this.droneIface) {
      this.connectedEmitted = true;
      this.broadcast({ type: 'connected', drone: 'LiteBee Wing', ip: this.droneIface.droneIp });
      this.broadcast({ type: 'status', tcp: false, udp: true });
    }

    const t = parseTelemetry(buf);
    if (t) this.handleTelemetry(t);
  }

  // ── Telemetry handler ──────────────────────────────────────────────────────

  private handleTelemetry(t: TelemetryData): void {
    this._telemetryCount++;

    // Stop sustained land if the drone has touched down
    if (this.sustainedLandInt !== null && t.z <= LAND_Z_THRESHOLD) {
      this.emitDiag('land', true, `touchdown confirmed (z=${t.z.toFixed(2)})`);
      this.stopSustainedLand();
    }

    // Throttle WS forwarding to 10 Hz
    const now = Date.now();
    if (now - this.lastTelemBroadMs < TELEM_THROTTLE_MS) return;
    this.lastTelemBroadMs = now;

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

  // ── Sustained land ─────────────────────────────────────────────────────────
  //
  // The firmware treats 'land' as transient — it must be re-sent continuously.
  // Without repetition the drone briefly descends then reverts to position-hold.

  private startSustainedLand(landBuf: Buffer): void {
    this.sustainedLandInt = setInterval(() => {
      this.sendBinary(landBuf);
    }, SUSTAINED_LAND_INTERVAL_MS);

    this.sustainedLandOut = setTimeout(() => {
      this.emitDiag('land', false, 'sustained land timed out after 8 s');
      this.stopSustainedLand();
    }, SUSTAINED_LAND_TIMEOUT_MS);
  }

  private stopSustainedLand(): void {
    if (this.sustainedLandInt) { clearInterval(this.sustainedLandInt);  this.sustainedLandInt = null; }
    if (this.sustainedLandOut) { clearTimeout(this.sustainedLandOut);   this.sustainedLandOut = null; }
  }

  // ── Telemetry subscribe burst ──────────────────────────────────────────────

  private startSubscribeBurst(): void {
    let attempts = 0;
    const sub = buildTelemSubscribe();
    const send = () => {
      this.sendBinary(sub);
      this.emitDiag('telem_subscribe', true, `sent (attempt ${++attempts})`);
    };
    send();
    this.subscribeTimer = setInterval(() => {
      if (this._telemetryCount > 0) {
        clearInterval(this.subscribeTimer!); this.subscribeTimer = null;
        this.emitDiag('telem_subscribe', true, 'telemetry flowing — burst done');
        return;
      }
      if (attempts >= TELEM_SUBSCRIBE_MAX) {
        clearInterval(this.subscribeTimer!); this.subscribeTimer = null;
        this.emitDiag('telem_subscribe', false, `no telemetry after ${TELEM_SUBSCRIBE_MAX} subscribes`);
        return;
      }
      send();
    }, TELEM_SUBSCRIBE_INTERVAL_MS);
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.socket) this.sendBinary(buildHeartbeat());
    }, HEARTBEAT_MS);
  }

  // ── Link watchdog ──────────────────────────────────────────────────────────

  private startLinkWatchdog(): void {
    this.linkWatchTimer = setInterval(() => {
      if (!this.connected) return;

      const now    = Date.now();
      const idleMs = this.lastDroneReplyMs > 0
        ? now - this.lastDroneReplyMs
        : now - this.connectTime;

      if (!this.connectedEmitted) {
        // Still waiting for first drone reply — give it the full 8 s handshake window
        if (idleMs > LINK_TIMEOUT_MS) {
          this.emitError('HANDSHAKE_TIMEOUT',
            `No response from drone on UDP ${DRONE_CMD_PORT} after 8 s. ` +
            'Check System Settings → Privacy & Security → Local Network and ensure Electron is allowed.');
          this.cleanup();
          this.broadcast({ type: 'disconnected' });
        }
      } else {
        // Previously connected — 3 s silence means link is gone
        if (idleMs > DRONE_LOST_AFTER_CONNECT_MS) {
          this.emitError('DRONE_LOST',
            `Telemetry stopped for ${(idleMs / 1000).toFixed(1)} s — drone may have powered off.`);
          this.cleanup();
          this.broadcast({ type: 'disconnected' });
        }
      }
    }, 1000);
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  private sendBinary(buf: Buffer): void {
    if (!this.socket || !this.droneIface) return;
    this.socket.send(buf, DRONE_CMD_PORT, this.droneIface.droneIp, (err) => {
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
      lines.push('   ✗ No interface found in drone subnet (192.168.10/100/43.x)');
      lines.push('   → Join the LiteBee Wing WiFi and run self-test again.');
      return lines.join('\n');
    }
    lines.push('');

    const pingOk = await this.probeGateway(iface.droneIp);
    lines.push(`2. Ping ${iface.droneIp}: ${pingOk ? '✓ OK' : '✗ FAIL — no reply'}`);
    if (!pingOk) { lines.push('   → Power-cycle the drone.'); return lines.join('\n'); }
    lines.push('');

    lines.push(`3. Protocol: binary, port ${DRONE_CMD_PORT}, bidirectional single socket`);
    lines.push(`   Telemetry frames received this session: ${this._telemetryCount}`);
    lines.push('');

    if (this.connected && this.connectedEmitted) {
      const idle = this.lastDroneReplyMs > 0 ? Date.now() - this.lastDroneReplyMs : null;
      lines.push(`4. Link: ✓ connected  last drone reply: ${idle !== null ? `${idle} ms ago` : 'none yet'}`);
    } else {
      lines.push('4. Link: not connected — click Connect first, then re-run self-test.');
    }
    lines.push('');
    lines.push('Copy this text when filing a support ticket.');
    return lines.join('\n');
  }
}
