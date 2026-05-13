import * as os from 'os';

export interface DroneInterface {
  name: string;
  localIp: string;
  droneIp: string;
}

// LiteBee Wing and Tello-family subnets.
// 192.168.100.x is used by some LiteBee Wing firmware variants.
const DRONE_SUBNETS = [
  { prefix: '192.168.10.',  gateway: '192.168.10.1' },
  { prefix: '192.168.43.',  gateway: '192.168.43.1' },
  { prefix: '192.168.100.', gateway: '192.168.100.1' },
];

// Windows Hyper-V / WSL virtual adapter name fragments to skip.
const VIRTUAL_FRAGMENTS = [
  'vethernet', 'hyper-v', 'wsl', 'vmware', 'virtualbox',
  'docker', 'loopback', 'bluetooth', 'tap', 'vpn',
];

function isVirtual(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_FRAGMENTS.some(f => lower.includes(f));
}

function isWifiLike(name: string): boolean {
  // macOS: en0 / en1; Windows: "Wi-Fi"; Linux: wlan0
  return /^(en\d|wi-?fi|wlan\d)/i.test(name) || name.toLowerCase().includes('litebee');
}

export function pickDroneInterface(): DroneInterface | null {
  const ifaces = os.networkInterfaces();
  const candidates: Array<DroneInterface & { preferred: boolean }> = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || isVirtual(name)) continue;

    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;

      for (const { prefix, gateway } of DRONE_SUBNETS) {
        if (addr.address.startsWith(prefix)) {
          candidates.push({
            name,
            localIp: addr.address,
            droneIp: gateway,
            preferred: isWifiLike(name),
          });
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  const best = candidates.find(c => c.preferred) ?? candidates[0];
  return { name: best.name, localIp: best.localIp, droneIp: best.droneIp };
}

export function listAllInterfaces(): string {
  const ifaces = os.networkInterfaces();
  const lines: string[] = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4') {
        lines.push(`  ${name}: ${addr.address}${addr.internal ? ' (loopback)' : ''}`);
      }
    }
  }

  return lines.join('\n') || '  (none found)';
}
