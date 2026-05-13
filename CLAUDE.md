# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # tsc → dist/  (must run before start)
npm start          # build + launch Electron app
npm run watch      # tsc --watch  (recompile on save; run alongside Electron)
npm run package    # electron-builder → DMG / NSIS / AppImage
npm run make-icon  # generate assets/icon.png (requires: npm install canvas)
```

**Critical:** Always launch via `npm start`, never `npx electron dist/main.js` directly from a VS Code / Claude Code terminal. The integrated terminal inherits `ELECTRON_RUN_AS_NODE=1` from the extension host, which silently disables the Electron main-process APIs (`app`, `Tray`, `dialog`, `require('electron')` returns a path string instead of the API). The `start` script prefixes `ELECTRON_RUN_AS_NODE=` to clear it. Running from a regular macOS Terminal.app / iTerm2 is always safe.

The renderer (`renderer/index.html`) is plain HTML + inline JS — no compile step. Changes to it are live on next `npm start` without rebuilding TypeScript.

## Architecture

This is an Electron tray app that bridges the eptim-edu webapp (running in the browser) to a LiteBee Wing / Tello-family drone over local WiFi. There are three distinct communication paths wired together in `main.ts`:

```
Browser (eptim-edu)
  │  WebSocket  ws://127.0.0.1:48714
  ▼
BridgeWebSocketServer   (src/wsServer.ts)
  │  DroneConnection.broadcast()  ← single callback for all outbound frames
  ▼
DroneConnection         (src/droneConnection.ts)
  │  UDP dgram  192.168.100.1:9696   (binary commands)
  │  UDP dgram  0.0.0.0:12345        (binary telemetry, inbound)
  ▼
LiteBee Wing drone (proprietary binary protocol, 0xFA-framed, CRC-16)
```

A fourth path handles the monitor UI via Electron IPC:

```
DroneConnection.broadcast()
  │  via server.onFrame hook in main.ts
  ▼
sendToRenderer('bridge:frame', …)   (src/window.ts)
  │  IPC over contextBridge
  ▼
renderer/index.html  (window.bridge.onFrame)
```

### Data flow in detail

Every outbound message to the webapp and to the renderer goes through one function: `DroneConnection.broadcast()` (a `BroadcastFn` injected at construction). `DroneConnection` never touches `WebSocket` or `ipcMain` directly — it only calls `broadcast`. `BridgeWebSocketServer.broadcast()` is the implementation: it sends to all WS clients AND calls the `onFrame` hook. `main.ts` sets that hook to forward frames to the renderer and update the tray label.

Inbound path: WS message → `wsServer.handleConnection` → `drone.connect()` / `drone.disconnect()` / `drone.sendOp()`. The renderer buttons go through `ipcMain.handle('bridge:connect' | 'bridge:disconnect' | 'bridge:selftest')` wired in `main.ts`, which call the same `DroneConnection` methods.

### Protocol types

`src/lib/droneBridge/protocol.ts` is the canonical source of truth for every JSON frame that crosses the WebSocket. Keep it in sync with the matching file in the eptim-edu webapp repo. Both `InboundFrame` and `OutboundFrame` are discriminated unions keyed on `type`.

### Connection sequence (`DroneConnection._connect`)

The sequence is deliberately re-run on every `connect` call — interface selection is never cached because the user typically joins the drone WiFi after the app is already running:

1. `pickDroneInterface()` — scans `os.networkInterfaces()` for a NIC in `192.168.10/24`, `192.168.43/24`, or `192.168.100/24`, skipping virtual adapters (Hyper-V, WSL, Docker, etc.)
2. `probeGateway()` — spawns `ping -c 1` to confirm the drone is reachable before opening sockets
3. `openTelemSocket()` — binds `0.0.0.0:12345`; non-fatal if busy (logs diag and continues without telemetry)
4. `openCmdSocket()` — binds a random port on the local IP
5. `startSubscribeBurst()` — sends `buildTelemSubscribe()` immediately, then up to 4 retries every 2 s; stops once telemetry flows
6. `startHeartbeat()` — 500 ms binary heartbeat frames; drone goes silent if these stop
7. `startLinkWatchdog()` — declares `DRONE_LOST` after 3 s without a telemetry packet

Every failure path emits both an `error` frame and a `diag` frame — never silent.

### Electron process split

| Process | File | Responsibilities |
|---|---|---|
| Main | `src/main.ts` | App lifecycle, IPC handlers, tray + window creation, `server.onFrame` wiring |
| Main | `src/wsServer.ts` | WS server, routes inbound frames to `DroneConnection` |
| Main | `src/droneConnection.ts` | All UDP networking, drone state machine |
| Main | `src/preload.ts` | Exposes `window.bridge` API to renderer via `contextBridge` |
| Renderer | `renderer/index.html` | Dashboard UI — plain JS, no framework, accesses only `window.bridge` |

`contextIsolation: true`, `nodeIntegration: false` — the renderer has zero Node.js access; everything goes through the five `window.bridge` methods exposed in `preload.ts`.

### IPC channels

| Channel | Direction | Payload |
|---|---|---|
| `bridge:ready` | main → renderer | `{ port: number }` |
| `bridge:frame` | main → renderer | `OutboundFrame` (any frame type) |
| `bridge:connect` | renderer → main | — (invoke, returns void) |
| `bridge:disconnect` | renderer → main | — (invoke, returns void) |
| `bridge:selftest` | renderer → main | — (invoke, returns `string`) |

### Adding a new drone command

1. Add the op variant to `InboundFrame` in `src/lib/droneBridge/protocol.ts`
2. Add the binary encoding case in `src/lib/droneProtocol.ts` (`encodeFrame` switch)
   - Use `build16()` with the correct opcode from the APK reverse-engineering notes
3. Mirror the type change in the eptim-edu webapp's copy of `protocol.ts`

### Drone wire protocol (`src/lib/droneProtocol.ts`)

- **Commands**: port 9696, binary, 0xFA-framed, CRC-16 (CCITT 0x8408 reflected, init 0xFFFF)
- **Telemetry**: port 12345, inbound binary; drone only streams after receiving `buildTelemSubscribe()` on connect
- **Heartbeat**: 8-byte frame every 500 ms; drone goes silent if heartbeats stop
- **Connection**: no request/response handshake — open sockets, send subscribe burst, start heartbeat, wait for telemetry
- **Link watchdog**: 3 s without telemetry → `DRONE_LOST`

### Tray icon

`assets/icon.png` is not committed. The tray falls back to a 1×1 transparent placeholder and shows the text label `EBC` instead. Run `npm run make-icon` (requires `canvas` installed separately) to generate a proper 22×22 white circle suitable for macOS template images.
