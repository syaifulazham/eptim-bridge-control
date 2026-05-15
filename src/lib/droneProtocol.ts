// Binary protocol for LiteBee Wing (reverse-engineered from APK).
// All drone traffic flows through ONE bidirectional UDP socket on port 9696.
// The drone replies to whichever source port it received packets from — there
// is no separate telemetry port.
// Framing: 0xFA header, CRC-16 (CCITT 0x8408 reflected, init 0xFFFF).

import type { SendFrame } from './droneBridge/protocol';

export const DRONE_CMD_PORT  = 9696;
export const HEARTBEAT_MS    = 500;
export const LINK_TIMEOUT_MS = 8000; // match webapp timer

// z field value (in telemetry float units) at or below which land is complete.
// Calibrate against observed z when grounded; 8s timeout is the real safety net.
export const LAND_Z_THRESHOLD = 2;

// ── CRC-16 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const tbl = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0x8408) : (c >>> 1);
    tbl[i] = c & 0xFFFF;
  }
  return tbl;
})();

function crc16(bytes: number[], len = bytes.length): number {
  let crc = 0xFFFF;
  for (let i = 0; i < len; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  return crc & 0xFFFF;
}

// ── Frame constants ───────────────────────────────────────────────────────────

const HEADER   = 0xFA;
const ID_SRC   = 0x00;
const CHAN_CTRL = 0x02;
const CHAN_HB   = 0x00;
const SUB_MODE  = 0x03;
const SUB_PARAM = 0x03;
const SUB_TELEM = 0x01;

// ── Heartbeat counter ─────────────────────────────────────────────────────────

let heartCount = 0;
function nextHeart(): number {
  heartCount = (heartCount + 1) & 0xFF;
  if (heartCount === 0) heartCount = 1;
  return heartCount;
}

// ── Frame builders ────────────────────────────────────────────────────────────

interface B16 { subch: number; op: number; payload?: number[]; flag?: number }

function build16({ subch, op, payload = [], flag = 0 }: B16): Buffer {
  const inner = [0x09, ID_SRC, CHAN_CTRL, subch, op, 0, 0, 0, 0, 0, 0, 0, flag];
  for (let i = 0; i < payload.length; i++) inner[5 + i] = payload[i] & 0xFF;
  const crc = crc16(inner, 13);
  const buf = Buffer.alloc(16);
  buf[0] = HEADER;
  for (let i = 0; i < 13; i++) buf[i + 1] = inner[i];
  buf[14] = crc & 0xFF;
  buf[15] = (crc >>> 8) & 0xFF;
  return buf;
}

// 8-byte heartbeat — sent every 500 ms; drone auto-lands if these stop
export function buildHeartbeat(): Buffer {
  const inner = [0x01, ID_SRC, CHAN_HB, SUB_MODE, nextHeart()];
  const crc = crc16(inner, 5);
  const buf = Buffer.alloc(8);
  buf[0] = HEADER;
  for (let i = 0; i < 5; i++) buf[i + 1] = inner[i];
  buf[6] = crc & 0xFF;
  buf[7] = (crc >>> 8) & 0xFF;
  return buf;
}

// 9-byte telemetry-subscription request (getBaseInfo).
// Drone only starts streaming 60-byte telemetry after receiving this.
export function buildTelemSubscribe(): Buffer {
  const inner = [0x02, ID_SRC, CHAN_CTRL, SUB_TELEM, 0x00, 0x14];
  const crc = crc16(inner, 6);
  const buf = Buffer.alloc(9);
  buf[0] = HEADER;
  for (let i = 0; i < 6; i++) buf[i + 1] = inner[i];
  buf[7] = crc & 0xFF;
  buf[8] = (crc >>> 8) & 0xFF;
  return buf;
}

// ── Opcode table ──────────────────────────────────────────────────────────────

const OP = {
  TAKEOFF:    { subch: SUB_MODE,  op: 0x03, flag: 1 },
  LAND:       { subch: SUB_MODE,  op: 0x04, flag: 0 },
  EMERGENCY:  { subch: SUB_MODE,  op: 0x0A, flag: 1 },
  ROTATE_360: { subch: SUB_MODE,  op: 0x0B, flag: 1 },
  DIRECTION:  { subch: SUB_PARAM, op: 0x16, flag: 0 },
  POSITION:   { subch: SUB_PARAM, op: 0x15, flag: 0 },
  HEAD_DIR:   { subch: SUB_PARAM, op: 0x17, flag: 0 },
  LED_RGB:    { subch: SUB_PARAM, op: 0x1B, flag: 0 },
};

const SPEED_TIER: Record<string, number> = { slow: 1, normal: 2, fast: 3 };
const DIR_CODE:   Record<string, number> = {
  forward: 1, backward: 2, left: 3, right: 4, up: 5, down: 6, hold: 7,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ── Command encoder ───────────────────────────────────────────────────────────

// Returns null for commands with no binary representation (photo, video).
export function encodeFrame(frame: SendFrame): Buffer | null {
  switch (frame.op) {
    case 'takeoff':    return build16(OP.TAKEOFF);
    case 'land':       return build16(OP.LAND);
    case 'emergency':  return build16(OP.EMERGENCY);
    case 'rotate_360': return build16(OP.ROTATE_360);

    case 'move':
      return build16({ ...OP.DIRECTION, payload: [DIR_CODE[frame.dir] ?? 7, SPEED_TIER[frame.speed] ?? 2] });

    case 'set_position': {
      const x = frame.x | 0;
      const y = frame.y | 0;
      const z = clamp(frame.z | 0, 30, 200);
      return build16({
        ...OP.POSITION,
        payload: [x & 0xFF, (x >> 8) & 0xFF, y & 0xFF, (y >> 8) & 0xFF, z & 0xFF, (z >> 8) & 0xFF],
      });
    }

    case 'yaw': {
      const dirCode = frame.dir === 'ccw' ? 2 : 1;
      const angle   = clamp(frame.angle | 0, 0, 180);
      return build16({ ...OP.HEAD_DIR, payload: [dirCode, angle & 0xFF, (angle >> 8) & 0xFF] });
    }

    case 'photo': case 'video_start': case 'video_stop':
      return null;

    default: return null;
  }
}

// ── Frame classifier ──────────────────────────────────────────────────────────

// Any 0xFA-framed packet with ID_SRC=0x01 is a valid drone reply.
// Used to confirm connection before telemetry starts flowing.
export function isValidDroneFrame(buf: Buffer): boolean {
  return buf.length >= 8 && buf[0] === 0xFA && buf[2] === 0x01;
}

// ── Telemetry parser ──────────────────────────────────────────────────────────

export interface TelemetryData {
  x: number; y: number; z: number;
  roll: number; pitch: number; yaw: number;
  vol: number; mode: number;
}

// Observed live capture: drone sends 60-byte frames, chan=0x01, subch=0x00.
// Payload (buf[5..57]) = 13 × float32LE + 1 byte.
// Frame structure: [0xFA][len-7][ID_SRC=0x01][chan][subch][floats...][CRC16_lo][CRC16_hi]
// Field order approximated from APK — z is used for sustained-land stop condition.
export function parseTelemetry(buf: Buffer): TelemetryData | null {
  if (!isValidDroneFrame(buf)) return null;
  if (buf[3] !== 0x01 || buf[4] !== 0x00 || buf.length !== 60) return null;

  const f = (off: number) => buf.readFloatLE(off);
  return {
    x:     f(5),
    y:     f(9),
    z:     f(13),
    roll:  f(17),
    pitch: f(21),
    yaw:   f(25),
    vol:   f(29),
    mode:  buf[33] ?? 0,
  };
}
