// Canonical wire protocol between the webapp WS client and this tray WS server.
// Keep this file in sync with the corresponding file in the webapp (eptim-edu) repo.

export type MoveDir = 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down';
export type MoveSpeed = 'slow' | 'normal' | 'fast';
export type YawDir = 'cw' | 'ccw';

// ── Inbound frames (tray receives from webapp) ──────────────────────────────

export type InboundFrame =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'send'; op: 'takeoff' }
  | { type: 'send'; op: 'land' }
  | { type: 'send'; op: 'emergency' }
  | { type: 'send'; op: 'rotate_360' }
  | { type: 'send'; op: 'move'; dir: MoveDir; speed: MoveSpeed }
  | { type: 'send'; op: 'set_position'; x: number; y: number; z: number }
  | { type: 'send'; op: 'yaw'; dir: YawDir; angle: number }
  | { type: 'send'; op: 'photo' }
  | { type: 'send'; op: 'video_start' }
  | { type: 'send'; op: 'video_stop' };

export type SendFrame = Extract<InboundFrame, { type: 'send' }>;

// ── Outbound frames (tray sends to webapp) ──────────────────────────────────

export type OutboundFrame =
  | { type: 'connected'; drone: string; ip: string }
  | { type: 'disconnected' }
  | { type: 'status'; tcp: boolean; udp: boolean }
  | {
      type: 'telemetry';
      x: number; y: number; z: number;
      vol?: number; mode?: string;
      yaw?: number; pitch?: number; roll?: number;
    }
  | { type: 'error'; code: ErrorCode; msg: string }
  | { type: 'diag'; step: string; ok: boolean; detail: string };

export type ErrorCode =
  | 'NO_INTERFACE'
  | 'DRONE_UNREACHABLE'
  | 'HANDSHAKE_TIMEOUT'
  | 'HANDSHAKE_SLOW'
  | 'SOCKET_BUSY'
  | 'FIREWALL_BLOCKED'
  | 'BAD_RANGE'
  | 'DRONE_LOST';
