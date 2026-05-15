# Drone Bridge - Desktop Integration Guide

Audience: the engineer building the desktop "Bridge Control" tray app that sits
between the webapp (running in the browser) and a LiteBee Wing drone on WiFi.

The webapp opens a WebSocket client to `ws://127.0.0.1:48714` (falling back to
`48713`, `48712`). The tray app owns the WebSocket **server** on one of those
ports, plus everything on the drone side: interface selection, UDP binary
protocol, telemetry parsing, and keep-alive heartbeat.

The canonical WS wire protocol lives in
[`src/lib/droneBridge/protocol.ts`](../src/lib/droneBridge/protocol.ts).
The binary drone protocol is implemented in `droneProtocol.js` (the file you
already have in the desktop codebase). Keep both sides in sync.

---

## 1. Current symptom

- Desktop OS shows `LiteBee Wing_65b10134` **WiFi Connected** (subnet
  `192.168.100.x`, drone at `192.168.100.1`).
- Webapp shows `Bridge ready` on `:48714` (WS server is up and reachable).
- Webapp sends `{type:"connect"}` and waits 8 s.
- Tray never replies with `{type:"connected"}` or `{type:"error"}`.
- Webapp fires timeout: "Bridge cannot see a drone on WiFi."

The WS plumbing works. The failure is between the tray and the drone on UDP.

---

## 2. Root cause (most likely)

The tray's UDP socket is **bound to the wrong network interface**. When the tray
launched, the default interface was the one with internet (en0/ethernet). The
user joined the drone WiFi afterward, creating a secondary interface on
`192.168.100.0/24`. The tray's outbound datagrams go out the default route and
never reach `192.168.100.1`.

Secondary possibility: the socket is bound correctly but the tray does not emit
the `{type:"connected"}` WS frame after receiving the first telemetry reply.

---

## 3. LiteBee Wing binary protocol summary

The LiteBee Wing does **NOT** use the Tello text protocol. It uses a proprietary
binary frame protocol over **UDP port 9696**. Reference: `droneProtocol.js`
(reverse-engineered from APK `com.makerfire.mkf`).

### Key parameters

| Parameter        | Value                                      |
| ---------------- | ------------------------------------------ |
| Drone IP         | `192.168.100.1`                            |
| Command port     | UDP `9696`                                 |
| Telemetry port   | Same socket (drone replies to sender port) |
| Heartbeat rate   | Every 500 ms                               |
| Link timeout     | 8000 ms (match webapp timer)               |
| Drone subnet     | `192.168.100.0/24`                         |
| Frame header     | `0xFA`                                     |
| CRC              | CRC-16 CCITT 0x8408 reflected, init 0xFFFF |

### Frame structure

```
[0xFA] [len - 7] [ID_SRC] [chan] [subch] [payload...] [CRC16_lo] [CRC16_hi]
```

- `ID_SRC`: `0x00` for frames from the tray, `0x01` for frames from the drone.
- CRC is computed over all bytes after the `0xFA` header (index 1 onward).

---

## 4. Connection sequence (what the tray must do on `{type:"connect"}`)

```
1. Enumerate IPv4 interfaces
2. Find the one in 192.168.100.0/24
   → If not found: emit {type:"error", code:"NO_INTERFACE", msg:"..."}
   → RETURN (do NOT time out silently)
3. Create UDP socket, bind to <local_ip_in_192.168.100.x>:<any ephemeral port>
4. Set destination: 192.168.100.1:9696
5. Send buildTelemSubscribe() once (9-byte frame — triggers telemetry streaming)
6. Start heartbeat interval: buildHeartbeat() every 500 ms
7. Listen for incoming datagrams on the same socket
8. On first valid reply (buf[0] === 0xFA && buf[2] === 0x01):
   → Emit over WS: {type:"connected", drone:"LiteBee Wing_65b10134", ip:"192.168.100.1"}
   → Emit over WS: {type:"status", tcp:false, udp:true}
   → Begin forwarding parseTelemetry() results at ≤10 Hz
9. If no reply within 8000 ms:
   → Stop heartbeat
   → Emit {type:"error", code:"HANDSHAKE_TIMEOUT", msg:"No response from drone on UDP 9696"}
```

**Non-negotiable:** every `{type:"connect"}` must produce either a `connected`
or an `error` frame within 8 seconds. Silence is the current bug.

---

## 5. Interface selection (the critical step)

Re-run on **every** `connect` request. Do not cache at startup.

```pseudocode
interfaces = os.networkInterfaces()
candidates = interfaces.filter(iface =>
    iface.family === 'IPv4' &&
    iface.address.startsWith('192.168.100.')
)

if (candidates.length === 0) {
    ws.send({type:"error", code:"NO_INTERFACE",
             msg:"No interface in 192.168.100.0/24. Join the LiteBee Wing WiFi."})
    return
}

// Prefer SSID starting with "LiteBee" if multiple match
chosen = candidates[0]
socket.bind(chosen.address, 0)
```

Platform APIs:
- **macOS**: `getifaddrs()` or `SCNetworkInterfaceCopyAll`
- **Windows**: `GetAdaptersAddresses()` — filter out Hyper-V/WSL adapters by
  `IfType === IF_TYPE_IEEE80211`
- **Node.js**: `os.networkInterfaces()` — check `.internal === false`

---

## 6. Heartbeat and keep-alive

The drone auto-lands if it receives no heartbeat for ~2-3 seconds.

```javascript
// From droneProtocol.js
const heartbeat = buildHeartbeat();  // 8 bytes
setInterval(() => {
    socket.send(heartbeat, 0, heartbeat.length, 9696, '192.168.100.1');
}, 500);
```

The heartbeat includes a rolling counter (1-255) per the APK's
`FlyContronl.getHeartData()`.

---

## 7. Telemetry subscription

The drone does NOT stream telemetry by default. You must send the 9-byte
subscription frame first:

```javascript
const telemSub = buildTelemSubscribe();
socket.send(telemSub, 0, telemSub.length, 9696, '192.168.100.1');
```

After this, the drone replies with 60-byte telemetry frames on the same socket
at ~20 Hz. Throttle to 10 Hz before forwarding over WS.

---

## 8. Telemetry parsing

Use `parseTelemetry(buf)` from `droneProtocol.js`. It returns:

```javascript
{
  x: number,     // cm (UWB X * 100)
  y: number,     // cm (UWB Y * 100)
  z: number,     // cm (height * 100)
  roll: number,  // degrees
  pitch: number, // degrees
  yaw: number,   // degrees
  vol: number,   // battery percent (0-100)
  mode: 0        // reserved
}
```

Forward as the WS `telemetry` frame:

```json
{"type":"telemetry","x":443,"y":148,"z":0,"yaw":0,"pitch":0,"roll":0,"vol":85}
```

---

## 9. Command encoding (BridgeOp -> binary frame)

Use `encodeFrame(bridgeOp)` from `droneProtocol.js`. It translates each
webapp BridgeOp into a 16-byte binary command frame.

| BridgeOp                          | Binary opcode | Notes                                |
| --------------------------------- | ------------- | ------------------------------------ |
| `{op:"takeoff"}`                  | 0x03          | flag9=1, flag13=1 (both required!)   |
| `{op:"land"}`                     | 0x04          | flag9=0, flag13=0 — **sustained**    |
| `{op:"emergency"}`                | 0x0A          |                                      |
| `{op:"rotate_360"}`               | 0x0B          | flag9=1, flag13=1                    |
| `{op:"move", dir, speed}`         | 0x16          | payload: [dirCode, speedTier]        |
| `{op:"set_position", x, y, z}`    | 0x15          | payload: LE int16 x, y, z (cm)      |
| `{op:"yaw", dir, angle}`          | 0x17          | payload: [dirCode, angle_lo, angle_hi] |
| `{op:"photo"}`                    | N/A           | Capture from video stream client-side |
| `{op:"video_start"}`              | N/A           | Not in binary protocol               |
| `{op:"video_stop"}`               | N/A           | Not in binary protocol               |

Direction codes: forward=1, backward=2, left=3, right=4, up=5, down=6, hold=7

Speed tiers: slow=1, normal=2, fast=3

When `encodeFrame()` returns `null` (photo, video, sleep), do not send anything
over UDP.

Send each command via:

```javascript
const buf = encodeFrame(bridgeOp);
if (buf) {
    socket.send(buf, 0, buf.length, 9696, '192.168.100.1');
}
```

---

## 9b. Sustained commands (CRITICAL for land)

The LiteBee Wing firmware treats certain mode commands as **transient** — the
drone only acts on them while it keeps receiving the frame. The official APK
re-sends these continuously until the action completes.

### Commands that require sustained repetition by the tray:

| Command       | Repeat interval | Stop condition                              |
| ------------- | --------------- | ------------------------------------------- |
| `land` (0x04) | Every 300 ms    | Telemetry z <= 2 cm OR 8 s timeout          |
| `emergency`   | Send once       | Immediate motor cut — do NOT repeat         |

### Implementation for `land`:

When the tray receives `{type:"send", op:"land"}` from the webapp:

```javascript
// Start a sustained-send loop for land
let landInterval = null;
let landTimeout = null;

function startSustainedLand() {
  const landBuf = encodeFrame({ op: 'land' });
  
  // Send immediately
  socket.send(landBuf, 0, landBuf.length, 9696, '192.168.100.1');
  
  // Then repeat every 300ms
  landInterval = setInterval(() => {
    socket.send(landBuf, 0, landBuf.length, 9696, '192.168.100.1');
  }, 300);
  
  // Safety timeout: stop after 8s regardless
  landTimeout = setTimeout(() => {
    stopSustainedLand();
  }, 8000);
}

function stopSustainedLand() {
  if (landInterval) { clearInterval(landInterval); landInterval = null; }
  if (landTimeout) { clearTimeout(landTimeout); landTimeout = null; }
}

// Stop conditions — call stopSustainedLand() when:
// 1. Telemetry z <= 2 (drone has touched down)
// 2. Another command arrives (any new {type:"send"} frame)
// 3. Webapp sends {type:"disconnect"}
// 4. The 8s safety timeout fires
```

### Why this matters:

Without sustained repetition, the drone receives one land frame and may revert
to hover (position hold) after ~200ms when no follow-up land frames arrive.
This is the root cause of "auto land not working" — the webapp sends land once,
the drone briefly initiates descent, then reverts to hover.

### Commands that are one-shot (send once, drone latches):

| Command         | Behavior                                          |
| --------------- | ------------------------------------------------- |
| `takeoff` (0x03) | Drone latches after receiving; arms + climbs     |
| `set_position`  | Drone moves to target position autonomously       |
| `yaw`           | Drone rotates specified angle then stops          |
| `move`          | Drone moves until next command or ~1-2s timeout   |

### What the webapp does on its side:

The webapp handles pacing via `sleep` ops (client-side timers). It sends:
- `{op:"land"}` → then waits 3s locally before proceeding
- `{op:"takeoff"}` → then waits 4s locally
- `{op:"move"}` → then waits 1s locally
- `{op:"sleep"}` → NEVER reaches the bridge (filtered client-side)

The tray's sustained-land loop runs independently of the webapp's 3s wait.
The webapp trusts that after 3s the drone has landed. If the tray's telemetry
shows z > 2cm after 3s, the tray should continue the land loop anyway (the 8s
timeout is the real stop).

---

## 10. WebSocket frames (must match `protocol.ts`)

### Inbound (tray receives from webapp)

```ts
{ type: "connect" }
{ type: "disconnect" }
{ type: "send", op: "takeoff" }
{ type: "send", op: "land" }
{ type: "send", op: "emergency" }
{ type: "send", op: "rotate_360" }
{ type: "send", op: "move", dir: "forward"|"backward"|"left"|"right"|"up"|"down",
                            speed: "slow"|"normal"|"fast" }
{ type: "send", op: "set_position", x: number, y: number, z: number }
{ type: "send", op: "yaw", dir: "cw"|"ccw", angle: number }
{ type: "send", op: "photo" }
{ type: "send", op: "video_start" }
{ type: "send", op: "video_stop" }
```

### Outbound (tray must produce for webapp)

```ts
{ type: "connected", drone: string, ip: string }
{ type: "disconnected" }
{ type: "status", tcp: boolean, udp: boolean }
{ type: "telemetry", x, y, z, vol?, mode?, yaw?, pitch?, roll? }   // ≤ 10 Hz
{ type: "error", code: string, msg: string }
```

---

## 11. Error codes the webapp expects

| Code                | When to emit                                                      |
| ------------------- | ----------------------------------------------------------------- |
| `NO_INTERFACE`      | No NIC in `192.168.100.0/24`. User hasn't joined drone WiFi.     |
| `DRONE_UNREACHABLE` | Interface found, but no UDP reply from `192.168.100.1:9696`.      |
| `HANDSHAKE_TIMEOUT` | Heartbeat sent for 8 s with no telemetry reply.                   |
| `SOCKET_BUSY`       | `EADDRINUSE` on the UDP socket (another app holding it).          |
| `FIREWALL_BLOCKED`  | OS firewall denied bind/send (macOS Local Network prompt).        |
| `HANDSHAKE_SLOW`    | Optional interim frame while still trying (keeps UI alive).       |
| `BAD_RANGE`         | `set_position` z outside 30-200 cm.                               |
| `DRONE_LOST`        | Telemetry stopped arriving after previously being connected.      |

---

## 12. Disconnect handling

On `{type:"disconnect"}` from webapp:

1. Stop heartbeat interval.
2. Close UDP socket.
3. Emit `{type:"disconnected"}` over WS.

On telemetry silence (no frames for >3 s after previously connected):

1. Stop heartbeat.
2. Close socket.
3. Emit `{type:"error", code:"DRONE_LOST", msg:"Telemetry stopped. Drone may have landed or lost power."}`.
4. Emit `{type:"disconnected"}`.

---

## 13. OS-specific gotchas

**macOS**
- System Settings -> Network -> Firewall: allow the tray binary.
- **Local Network permission** (macOS 14+) blocks UDP to LAN addresses until
  the user accepts the prompt. Trigger at first launch — if denied, the socket
  silently drops packets. Detect by checking for zero replies and emit
  `FIREWALL_BLOCKED`.
- `en0` is WiFi on most Macs but not all — always pick by subnet
  (`192.168.100.x`), never by interface name.

**Windows**
- Inbound + outbound firewall rules for UDP port 9696.
- Hyper-V / WSL2 virtual adapters appear with `192.168.x.x` IPs and can false-
  match. Filter by `IfType === IF_TYPE_IEEE80211` (wireless only).

**Linux**
- `NetworkManager` keeps the default route on ethernet; use `SO_BINDTODEVICE`
  to force the UDP socket onto the drone WiFi interface.

---

## 14. Self-test button (strongly recommended)

Add a "Self-test" action in the tray menu:

1. List interfaces, show which one matches `192.168.100.0/24`.
2. Bind UDP socket to that interface.
3. Send `buildHeartbeat()` to `192.168.100.1:9696`.
4. Wait 2 s, count incoming packets.
5. If packets received: send `buildTelemSubscribe()`, parse one telemetry frame,
   print battery %.
6. Print pass/fail for each step.

Ship as copyable text for support tickets.

---

## 15. Minimum reproducible test script (Node.js)

If this works but the tray does not, the bug is in the tray's interface
selection or WS reply logic.

```javascript
const dgram = require('dgram');
const { buildHeartbeat, buildTelemSubscribe, parseTelemetry,
        DRONE_CMD_PORT } = require('./droneProtocol');

const DRONE_IP = '192.168.100.1';
const sock = dgram.createSocket('udp4');

// Bind to the drone-subnet interface explicitly
sock.bind(0, '192.168.100.2', () => {  // <-- replace with your local IP
  console.log('Bound to', sock.address());

  // Subscribe to telemetry
  const sub = buildTelemSubscribe();
  sock.send(sub, 0, sub.length, DRONE_CMD_PORT, DRONE_IP);

  // Start heartbeat
  const hb = setInterval(() => {
    const beat = buildHeartbeat();
    sock.send(beat, 0, beat.length, DRONE_CMD_PORT, DRONE_IP);
  }, 500);

  // Listen for replies
  sock.on('message', (buf, rinfo) => {
    const telem = parseTelemetry(buf);
    if (telem) {
      console.log('TELEMETRY:', JSON.stringify(telem));
      clearInterval(hb);
      sock.close();
      process.exit(0);
    }
  });

  // Timeout
  setTimeout(() => {
    console.error('FAIL: No telemetry received in 5s');
    console.error('Check: is WiFi connected to LiteBee Wing SSID?');
    console.error('Check: is local IP in 192.168.100.x subnet?');
    clearInterval(hb);
    sock.close();
    process.exit(1);
  }, 5000);
});
```

Run with: `node test_drone_link.js`

---

## 16. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (webapp)                                                     │
│                                                                       │
│  BlocklyWorkspace → IR → pushProgram() → BridgeOps                   │
│       ↓                                                               │
│  DroneBridgeClient (WS client)                                        │
│       │  ws://127.0.0.1:48714                                         │
└───────┼──────────────────────────────────────────────────────────────┘
        │
        │ JSON over WebSocket (localhost)
        ↓
┌───────────────────────────────────────────────────────────────────────┐
│  Desktop Tray App (WS server)                                         │
│                                                                       │
│  ┌─────────────────┐    ┌────────────────────┐                        │
│  │ WS Server :48714│    │ Interface Picker    │                        │
│  │ (handles JSON)  │───→│ find 192.168.100.x  │                        │
│  └────────┬────────┘    └────────┬───────────┘                        │
│           │                      │                                    │
│           ↓                      ↓                                    │
│  ┌─────────────────────────────────────────┐                          │
│  │ droneProtocol.js                         │                          │
│  │  encodeFrame() → 16-byte binary          │                          │
│  │  buildHeartbeat() → 8-byte binary        │                          │
│  │  buildTelemSubscribe() → 9-byte binary   │                          │
│  │  parseTelemetry() → {x,y,z,vol,...}      │                          │
│  └────────────────────┬────────────────────┘                          │
│                       │                                               │
│                       │ UDP 9696                                       │
└───────────────────────┼───────────────────────────────────────────────┘
                        │
                        ↓
              ┌───────────────────┐
              │  LiteBee Wing     │
              │  192.168.100.1    │
              │  UDP :9696        │
              └───────────────────┘
```

---

## 17. Optional: Supabase diagnostic breadcrumbs

The webapp writes `drone_bridge_sessions` and `drone_bridge_preferences`. To
make failed pairings self-report, the tray can send `diag` frames over the WS:

```json
{"type":"diag","step":"interface_pick","ok":true,"detail":"en0 192.168.100.2"}
{"type":"diag","step":"heartbeat_sent","ok":true,"detail":"3 packets"}
{"type":"diag","step":"telemetry_rx","ok":false,"detail":"0 packets in 5s"}
```

The webapp can forward these into Supabase for support debugging without
requiring user screenshots.

---

## Checklist

- [ ] WS server binds `127.0.0.1:48714` (fall back 48713, 48712)
- [ ] On `{type:"connect"}`, re-pick interface in `192.168.100.0/24`
- [ ] Send `buildTelemSubscribe()` once at connect
- [ ] Start 500 ms heartbeat with `buildHeartbeat()`
- [ ] On first telemetry reply: emit `{type:"connected"}` + `{type:"status"}`
- [ ] On 8 s timeout with no reply: emit `{type:"error", code:"HANDSHAKE_TIMEOUT"}`
- [ ] Forward `parseTelemetry()` results as `{type:"telemetry"}` at ≤10 Hz
- [ ] On `{type:"send", ...}`: call `encodeFrame()` and UDP-send the buffer
- [ ] On `{type:"send", op:"land"}`: start sustained-send loop (every 300ms, stop on z<=2 or 8s)
- [ ] Any new `{type:"send"}` cancels any active sustained-land loop
- [ ] On `{type:"disconnect"}`: stop heartbeat, stop sustained loops, close socket, emit `{type:"disconnected"}`
- [ ] Detect telemetry silence (>3 s) and emit `DRONE_LOST`
- [ ] macOS Local Network permission triggered at first run
- [ ] Self-test button with step-by-step results
