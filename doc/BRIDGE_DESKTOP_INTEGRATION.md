# Drone Bridge - Desktop Integration Guide

Audience: the engineer building the desktop "Bridge Control" tray app that sits
between the webapp (running in the browser) and a LiteBee Wing drone on WiFi.

The webapp is already shipping and opens a WebSocket client to
`ws://127.0.0.1:48714` (falling back to `48713`, `48712`). The tray app owns the
WebSocket **server** on one of those ports, plus everything on the drone side:
interface selection, UDP handshake, telemetry, video, and keep-alive.

The canonical wire protocol lives in
[`src/lib/droneBridge/protocol.ts`](../src/lib/droneBridge/protocol.ts). Keep
both sides in sync with that file.

---

## 1. Current symptom the user is seeing

From the screenshots:

- Desktop OS shows `LiteBee Wing_65b10134` **WiFi Connected**.
- Webapp shows `Bridge ready` on `:48714` (so the WS server is up).
- The webapp sends `{type:"connect"}` and waits.
- After 8 s the webapp fires the timeout:
  `Drone did not respond within 8s. Check drone power and WiFi link.`
- No `{type:"connected"}`, no `{type:"status"}`, no `{type:"telemetry"}` ever
  arrives back on the socket.

That means the WS plumbing is fine; the **tray app is not completing the UDP
handshake with the drone** (or it is completing it but never replying on the
WS). Two classes of bugs cover almost every case:

1. The tray bound its UDP socket to the wrong network interface (usually the
   one that had internet when the tray launched, not the drone SSID that the
   user joined a minute later).
2. The tray did complete the handshake but never wrote back the `connected`
   frame, so the webapp has no way to know.

Section 3 and section 5 cover each of those.

---

## 2. System split and responsibilities

| Layer              | Owner    | Detail                                                  |
| ------------------ | -------- | ------------------------------------------------------- |
| Blockly -> IR      | Webapp   | Already done.                                           |
| WS client          | Webapp   | See `src/lib/droneBridge/client.ts`.                    |
| WS server          | Tray     | Must bind to `127.0.0.1` on one of `48714/48713/48712`. |
| Interface picker   | Tray     | Pick the NIC in the drone subnet on every `connect`.    |
| UDP command socket | Tray     | `192.168.10.1:8889` for LiteBee / Tello family.         |
| Telemetry listener | Tray     | `0.0.0.0:8890`, forwarded to webapp as `telemetry`.     |
| Video listener     | Tray     | `0.0.0.0:11111`, optional.                              |
| Keep-alive         | Tray     | 1 Hz `command` so drone does not auto-land.             |
| Diagnostics        | Tray     | Must emit `error` frames on failure (never silence).    |

---

## 3. Pre-flight network checks the tray must run on every `connect`

Re-run these checks inside the `connect` handler. Do **not** cache interface
selection at launch - the user joins the drone SSID after the tray is already
running.

1. Enumerate IPv4 interfaces. Filter for ones in the LiteBee/Tello subnet:
   typically `192.168.10.0/24` with gateway `192.168.10.1`. LiteBee Wing
   firmware may also use `192.168.43.0/24`; pick whichever is present.
2. If no matching interface is found, emit
   `{type:"error", code:"NO_INTERFACE", msg:"Join the drone WiFi (LiteBee Wing_...) and try again"}`
   and return. Do not time out silently.
3. If multiple interfaces match (rare, e.g. a USB WiFi dongle), prefer the one
   whose SSID starts with `LiteBee`.
4. ARP or ICMP-probe the gateway (`192.168.10.1`). If no reply within 500 ms,
   emit `{type:"error", code:"DRONE_UNREACHABLE", msg:"Drone WiFi joined but drone is not answering. Power-cycle the drone."}`.
5. Log the chosen interface name, local IP, drone IP, and timestamp in the
   tray's status panel so the user can see what was selected.

macOS specific: `SCNetworkInterfaceCopyAll` or `getifaddrs` both work. On
Windows use `GetAdaptersAddresses`. Do **not** rely on `InetAddress.getLocalHost`
or `socket.gethostbyname(socket.gethostname())` - they return the default-route
interface, which on a laptop with cellular/ethernet uplink will be the wrong
one.

---

## 4. LiteBee Wing / Tello-family handshake

The LiteBee Wing speaks the Tello SDK 2.0 text protocol over UDP.

```
socket.bind(<chosen_local_ip>, 0)        # ephemeral, but bind to the drone NIC
socket.sendto(b"command", ("192.168.10.1", 8889))
# wait up to 2000 ms for b"ok"
# retry up to 3 times with 500 ms backoff
```

Only after receiving `ok`:

1. Open telemetry listener on `0.0.0.0:8890`.
2. Start 1 Hz keep-alive thread that sends `command` (or `battery?`) so the
   drone does not drop the link and auto-land after ~15 s of silence.
3. Optionally open video listener on `0.0.0.0:11111` (send `streamon` when the
   webapp requests video).
4. Immediately emit to the webapp:

   ```json
   {"type":"connected","drone":"LiteBee Wing_65b10134","ip":"192.168.10.1"}
   {"type":"status","tcp":false,"udp":true}
   ```

If any step fails, emit an `error` frame with a specific code (section 7).

---

## 5. WebSocket frames (must match `protocol.ts`)

### Inbound (tray receives)

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

### Outbound (tray must produce)

```ts
{ type: "connected", drone: string, ip: string }
{ type: "disconnected" }
{ type: "status", tcp: boolean, udp: boolean }
{ type: "telemetry", x, y, z, vol?, mode?, yaw?, pitch?, roll? }   // <= 10 Hz
{ type: "error", code: string, msg: string }
```

**Non-negotiable rule:** every `{type:"connect"}` must be answered within the
webapp's 8 s budget with *either* `connected` *or* `error`. Silence is the
current bug. Even if handshake is still in flight at 7 s, send an interim
`{type:"error", code:"HANDSHAKE_SLOW", msg:"still trying..."}` so the UI can
surface progress.

---

## 6. Command mapping (BridgeOp -> Tello/LiteBee SDK)

| BridgeOp                                | UDP text                           |
| --------------------------------------- | ---------------------------------- |
| `takeoff`                               | `takeoff`                          |
| `land`                                  | `land`                             |
| `emergency`                             | `emergency`                        |
| `rotate_360`                            | `cw 360`                           |
| `move forward slow`                     | `forward 20`                       |
| `move forward normal`                   | `forward 50`                       |
| `move forward fast`                     | `forward 100`                      |
| `move backward \| left \| right \| up \| down` | `back|left|right|up|down <cm>`|
| `yaw cw 90`                             | `cw 90`                            |
| `yaw ccw 45`                            | `ccw 45`                           |
| `set_position x y z`                    | `go <x> <y> <z> 50` (cm, -500..500)|
| `photo`                                 | capture frame from :11111 stream   |
| `video_start`                           | `streamon`                         |
| `video_stop`                            | `streamoff`                        |

Speed buckets `slow|normal|fast` -> `20|50|100` cm. Clamp `go` to the drone's
legal range and reject anything outside it with `{type:"error", code:"BAD_RANGE"}`.

---

## 7. Error codes the webapp expects

| Code              | When to emit                                                   |
| ----------------- | -------------------------------------------------------------- |
| `NO_INTERFACE`    | No NIC in drone subnet. Tell user to join drone WiFi.          |
| `DRONE_UNREACHABLE` | Interface found, gateway ARP/ICMP fails.                     |
| `HANDSHAKE_TIMEOUT` | 3 x `command` attempts got no `ok`.                          |
| `SOCKET_BUSY`     | `EADDRINUSE` on 8890/11111 (OEM app or OBS holding it).        |
| `FIREWALL_BLOCKED`| OS firewall denied bind/send.                                  |
| `HANDSHAKE_SLOW`  | Interim heartbeat while still trying (keeps webapp UI alive).  |
| `BAD_RANGE`       | `set_position` outside drone-legal range.                      |
| `DRONE_LOST`      | Keep-alive stopped getting replies after connect.              |

---

## 8. OS-specific gotchas

**macOS**
- System Settings -> Network -> Firewall: allow the tray binary. Fresh code
  signatures trigger a re-prompt.
- Local Network permission prompt (macOS 14+) will block UDP to `192.168.10.1`
  until accepted. Trigger it explicitly at first launch; do not assume it is
  granted.
- `en0` is Wi-Fi on most Macs but not all - pick by subnet, not by name.

**Windows**
- Inbound + outbound rules for UDP 8889, 8890, 11111.
- Hyper-V / WSL2 virtual adapters will show up in `GetAdaptersAddresses` with a
  `192.168.x.x` IP and can spoof the subnet match. Filter them out by
  `IfType != IF_TYPE_ETHERNET_CSMACD && IfType != IF_TYPE_IEEE80211`.

**Linux**
- `NetworkManager` may keep the default route on ethernet; bind the UDP socket
  to the drone interface with `SO_BINDTODEVICE` rather than trusting routing.

---

## 9. Self-test button (strongly recommended)

Add a "Self-test" action in the tray menu that runs and prints each step:

1. `interfaces[]` and which one was picked
2. `ping 192.168.10.1` result
3. `command` -> `ok` latency
4. `battery?` -> value
5. Telemetry packet count over 2 s

Ship the result as copy-pasteable text. Most support tickets get resolved in
one round-trip from this button.

---

## 10. Minimum reproducible test script

If this Python snippet works on the user's machine but the tray does not, the
bug is in the tray (interface selection, bind, or WS reply), not the drone.

```python
import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", 0))                # or bind to the LiteBee interface IP
s.settimeout(2.0)
s.sendto(b"command", ("192.168.10.1", 8889))
print("cmd:", s.recv(1024))           # expect b"ok"
s.sendto(b"battery?", ("192.168.10.1", 8889))
print("bat:", s.recv(1024))
```

---

## 11. Optional: Supabase diagnostic breadcrumbs

The webapp already writes `drone_bridge_sessions` and
`drone_bridge_preferences` (see migration
`20260512040234_create_drone_bridge_tables.sql`). To make failed pairings
self-report, the tray can send a new `diag` frame over the existing WS:

```json
{"type":"diag","step":"interface_pick","ok":true,"detail":"en0 192.168.10.2"}
{"type":"diag","step":"udp_handshake","ok":false,"detail":"timeout after 3 tries"}
```

The webapp can forward those rows into a Supabase table, e.g.:

```sql
create table if not exists drone_bridge_diagnostics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  session_id uuid,
  step text not null,
  ok boolean not null default false,
  detail text default '',
  created_at timestamptz default now()
);
alter table drone_bridge_diagnostics enable row level security;

create policy "users read own diagnostics"
  on drone_bridge_diagnostics for select to authenticated
  using (auth.uid() = user_id);

create policy "users insert own diagnostics"
  on drone_bridge_diagnostics for insert to authenticated
  with check (auth.uid() = user_id);
```

This lets support ask "run it again, then share your tray email" instead of
asking for screenshots.

---

## Checklist for the desktop dev

- [ ] WS server binds `127.0.0.1:48714` (fall back 48713, 48712).
- [ ] On `connect`, re-pick the interface in the drone subnet.
- [ ] UDP `command` handshake with 3 retries.
- [ ] Emit `connected` + `status` on success, `error` on every failure path.
- [ ] 1 Hz keep-alive after connect.
- [ ] Telemetry listener on 8890, forwarded at <= 10 Hz.
- [ ] Command mapping table (section 6) wired end to end.
- [ ] macOS Local Network permission prompt triggered at first run.
- [ ] Self-test button.
- [ ] (Optional) `diag` frames for Supabase breadcrumbs.
