import type { SendFrame, MoveDir, MoveSpeed, YawDir } from './lib/droneBridge/protocol';

const SPEED_CM: Record<MoveSpeed, number> = { slow: 20, normal: 50, fast: 100 };

const DIR_CMD: Record<MoveDir, string> = {
  forward:  'forward',
  backward: 'back',
  left:     'left',
  right:    'right',
  up:       'up',
  down:     'down',
};

const GO_MIN = -500;
const GO_MAX = 500;

export type MapResult =
  | { ok: true; cmd: string }
  | { ok: false; errorCode: string; errorMsg: string };

export function mapFrame(frame: SendFrame): MapResult {
  switch (frame.op) {
    case 'takeoff':
      return { ok: true, cmd: 'takeoff' };

    case 'land':
      return { ok: true, cmd: 'land' };

    case 'emergency':
      return { ok: true, cmd: 'emergency' };

    case 'rotate_360':
      return { ok: true, cmd: 'cw 360' };

    case 'move':
      return { ok: true, cmd: `${DIR_CMD[frame.dir]} ${SPEED_CM[frame.speed]}` };

    case 'yaw':
      return { ok: true, cmd: `${frame.dir} ${Math.abs(Math.round(frame.angle))}` };

    case 'set_position': {
      const { x, y, z } = frame;
      if (x < GO_MIN || x > GO_MAX || y < GO_MIN || y > GO_MAX || z < GO_MIN || z > GO_MAX) {
        return {
          ok: false,
          errorCode: 'BAD_RANGE',
          errorMsg: `set_position out of range (${GO_MIN}..${GO_MAX} cm): x=${x} y=${y} z=${z}`,
        };
      }
      return { ok: true, cmd: `go ${x} ${y} ${z} 50` };
    }

    case 'video_start':
      return { ok: true, cmd: 'streamon' };

    case 'video_stop':
      return { ok: true, cmd: 'streamoff' };

    case 'photo':
      // Photo capture requires the H.264 video stream decoder (port 11111).
      // Return a sentinel so DroneConnection can handle it separately.
      return { ok: true, cmd: '__photo__' };

    default:
      return { ok: false, errorCode: 'BAD_RANGE', errorMsg: `Unknown op: ${(frame as { op: string }).op}` };
  }
}
