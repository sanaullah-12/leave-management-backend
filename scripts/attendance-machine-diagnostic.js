#!/usr/bin/env node
/**
 * Attendance machine connectivity diagnostic.
 *
 * Walks the physical-to-application chain in order and stops being useful only
 * when it tells you exactly which link is broken:
 *
 *   local network config -> ICMP/ARP reachability -> UDP 4370 ZK handshake
 *   -> subnet-wide ZK discovery -> ZKTecoService connect / users / attendance
 *
 * Usage:
 *   node scripts/attendance-machine-diagnostic.js [ip] [port]
 *   node scripts/attendance-machine-diagnostic.js --discover [subnet]
 *
 * Defaults come from ZKTECO_IP / ZKTECO_PORT, then 192.168.1.201:4370.
 */

require("dotenv").config();

const dgram = require("dgram");
const net = require("net");
const os = require("os");
const { execSync } = require("child_process");

const USHRT_MAX = 65535;
const CMD_CONNECT = 1000;
const CMD_ACK_OK = 2000;
const CMD_ACK_OK_2 = 2005;

const args = process.argv.slice(2);
const discoverMode = args.includes("--discover");
const positional = args.filter((a) => !a.startsWith("--"));

const TARGET_IP = positional[0] || process.env.ZKTECO_IP || "192.168.1.201";
const TARGET_PORT = parseInt(
  positional[1] || process.env.ZKTECO_PORT || "4370",
  10
);

let failures = 0;
let warnings = 0;

function section(title) {
  console.log(`\n${"=".repeat(68)}\n${title}\n${"=".repeat(68)}`);
}
function pass(msg) {
  console.log(`  [PASS] ${msg}`);
}
function fail(msg) {
  failures += 1;
  console.log(`  [FAIL] ${msg}`);
}
function warn(msg) {
  warnings += 1;
  console.log(`  [WARN] ${msg}`);
}
function info(msg) {
  console.log(`         ${msg}`);
}

// ---------------------------------------------------------------- ZK protocol

function createChkSum(buf) {
  let chksum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (i === buf.length - 1) chksum += buf[i];
    else chksum += buf.readUInt16LE(i);
    chksum %= USHRT_MAX;
  }
  return USHRT_MAX - chksum - 1;
}

function zkConnectPacket() {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(CMD_CONNECT, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(createChkSum(buf), 2);
  return buf;
}

/**
 * Send a real CMD_CONNECT and wait for the device to answer.
 * @returns {Promise<{ok: boolean, cmd?: number, ms?: number}>}
 */
function zkHandshake(ip, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const started = Date.now();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch (_) {
        /* already closed */
      }
      resolve(result);
    };

    socket.on("message", (msg) => {
      const cmd = msg.length >= 2 ? msg.readUInt16LE(0) : -1;
      finish({
        ok: cmd === CMD_ACK_OK || cmd === CMD_ACK_OK_2,
        cmd,
        ms: Date.now() - started,
      });
    });
    socket.on("error", () => finish({ ok: false }));

    socket.send(zkConnectPacket(), port, ip, (err) => {
      if (err) finish({ ok: false });
    });

    setTimeout(() => finish({ ok: false }), timeoutMs);
  });
}

function tcpProbe(ip, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ip);
  });
}

// ------------------------------------------------------------------- helpers

/**
 * Pick the interface that actually carries traffic to `target`.
 *
 * Taking the first non-internal IPv4 is wrong on developer machines: os
 * .networkInterfaces() has no defined order, so virtual adapters (WSL, Docker,
 * VPN) can win and the subnet comparison then reports nonsense - e.g. claiming
 * the device is off-subnet because it was compared against 172.29.128.1/20.
 *
 * Prefer an interface whose own subnet contains the target; otherwise fall back
 * to the first physical-looking one.
 * @param {string} [target] - Device IP the diagnostic is aimed at
 */
function primaryInterface(target) {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) {
        candidates.push({ name, ...addr });
      }
    }
  }
  if (candidates.length === 0) return null;

  if (target) {
    const onSubnet = candidates.find((c) => sameSubnet(c.address, target, c.netmask));
    if (onSubnet) return onSubnet;
  }

  const VIRTUAL = /vethernet|wsl|docker|hyper-v|virtualbox|vmware|loopback|tap|tun|vpn/i;
  return candidates.find((c) => !VIRTUAL.test(c.name)) || candidates[0];
}

function sameSubnet(ipA, ipB, netmask) {
  const toInt = (ip) =>
    ip.split(".").reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
  const mask = toInt(netmask);
  return (toInt(ipA) & mask) === (toInt(ipB) & mask);
}

function pingHost(ip) {
  try {
    const cmd =
      process.platform === "win32"
        ? `ping -n 2 -w 1500 ${ip}`
        : `ping -c 2 -W 2 ${ip}`;
    const out = execSync(cmd, { encoding: "utf8", stdio: "pipe" });
    return { ok: !/unreachable|100% (packet )?loss|timed out/i.test(out), out };
  } catch (e) {
    return { ok: false, out: (e.stdout || "") + (e.stderr || "") };
  }
}

function arpEntry(ip) {
  try {
    const out = execSync(
      process.platform === "win32" ? `arp -a ${ip}` : `arp -n ${ip}`,
      { encoding: "utf8", stdio: "pipe" }
    );
    const line = out.split(/\r?\n/).find((l) => l.includes(ip));
    if (!line) return null;
    const mac = line.match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
    return mac ? mac[0] : null;
  } catch (_) {
    return null;
  }
}

// --------------------------------------------------------------- diagnostics

async function discover(subnet) {
  section(`ZK DEVICE DISCOVERY on ${subnet}.0/24 (UDP ${TARGET_PORT})`);
  info("Sending a real ZK CMD_CONNECT to every host. This takes a few seconds.");

  const socket = dgram.createSocket("udp4");
  const found = [];

  await new Promise((resolve) => {
    socket.on("message", (msg, rinfo) => {
      const cmd = msg.length >= 2 ? msg.readUInt16LE(0) : -1;
      if (cmd === CMD_ACK_OK || cmd === CMD_ACK_OK_2) found.push(rinfo.address);
    });
    socket.on("error", () => resolve());
    socket.bind(() => {
      const pkt = zkConnectPacket();
      for (let i = 1; i <= 254; i += 1) {
        socket.send(pkt, TARGET_PORT, `${subnet}.${i}`);
      }
      setTimeout(() => {
        try {
          socket.close();
        } catch (_) {
          /* already closed */
        }
        resolve();
      }, 6000);
    });
  });

  if (found.length === 0) {
    fail(`No ZK device answered on ${subnet}.0/24`);
    info("The machine is powered off, unplugged, or on another network/VLAN.");
  } else {
    found.forEach((ip) => pass(`ZK device answered at ${ip}:${TARGET_PORT}`));
  }
  return found;
}

async function main() {
  console.log("Attendance machine diagnostic");
  console.log(`Target: ${TARGET_IP}:${TARGET_PORT}`);
  console.log(`Host:   ${os.hostname()} (${process.platform})`);

  // 1. Local network -------------------------------------------------------
  section("1. LOCAL NETWORK CONFIGURATION");
  const iface = primaryInterface(TARGET_IP);
  if (!iface) {
    fail("No active non-loopback IPv4 interface found");
  } else {
    pass(`Interface ${iface.name}: ${iface.address} / ${iface.netmask}`);
    info(`MAC ${iface.mac}`);
    if (sameSubnet(iface.address, TARGET_IP, iface.netmask)) {
      pass(`${TARGET_IP} is on the same subnet - direct layer-2 delivery`);
    } else {
      warn(
        `${TARGET_IP} is NOT on ${iface.address}/${iface.netmask} - traffic must be routed`
      );
      info("A cloud-hosted backend can never reach an RFC1918 device this way.");
    }
  }

  const subnet = TARGET_IP.split(".").slice(0, 3).join(".");
  if (discoverMode) {
    await discover(positional[0] ? subnet : subnet);
    return;
  }

  // 2. Reachability --------------------------------------------------------
  section("2. IP REACHABILITY (ICMP + ARP)");
  const ping = pingHost(TARGET_IP);
  if (ping.ok) pass(`${TARGET_IP} replies to ping`);
  else fail(`${TARGET_IP} does not reply to ping`);

  // ARP only means anything for a real remote host on the local segment.
  // Loopback and our own address never appear in the table.
  const arpApplicable =
    !TARGET_IP.startsWith("127.") && (!iface || TARGET_IP !== iface.address);

  if (!arpApplicable) {
    info(`ARP check not applicable for ${TARGET_IP} (local/loopback address)`);
  } else {
    const mac = arpEntry(TARGET_IP);
    if (mac) {
      pass(`ARP resolves ${TARGET_IP} -> ${mac}`);
      if (/^00[:-]17[:-]61/i.test(mac)) {
        info("MAC prefix matches ZKTeco (00:17:61)");
      }
    } else {
      fail(`No ARP entry for ${TARGET_IP} - nothing is answering at layer 2`);
      info("This means the device is absent, not merely firewalled.");
    }
  }

  // 3. Port ----------------------------------------------------------------
  section("3. PORT REACHABILITY");
  const tcpOpen = await tcpProbe(TARGET_IP, TARGET_PORT);
  if (tcpOpen) pass(`TCP ${TARGET_PORT} is open`);
  else
    info(
      `TCP ${TARGET_PORT} closed - expected, zklib speaks UDP. Not a failure by itself.`
    );

  // 4. ZK protocol ---------------------------------------------------------
  section("4. ZK PROTOCOL HANDSHAKE (UDP)");
  const hs = await zkHandshake(TARGET_IP, TARGET_PORT);
  if (hs.ok) {
    pass(`Device answered CMD_CONNECT with ACK_OK in ${hs.ms}ms`);
  } else {
    fail(`No valid ZK reply from ${TARGET_IP}:${TARGET_PORT}`);
    info("Run with --discover to sweep the subnet for the machine's real IP.");
  }

  // 5. Application layer ---------------------------------------------------
  section("5. APPLICATION LAYER (ZKTecoService)");
  if (!hs.ok) {
    info("Skipped - the device did not answer the protocol handshake.");
  } else {
    const ZKTecoService = require("../services/zktecoService");
    const svc = new ZKTecoService(TARGET_IP, TARGET_PORT);
    try {
      await svc.connect();
      pass("ZKTecoService.connect() succeeded");

      try {
        const users = await svc.getUsers();
        pass(`getUsers() returned ${users.length} enrolled users`);
        users.slice(0, 3).forEach((u) =>
          info(`user uid=${u.uid} userId=${u.rawData?.userid} name=${u.name}`)
        );
      } catch (e) {
        fail(`getUsers() failed: ${e.message}`);
      }

      try {
        const logs = await svc.getAttendanceLogs();
        pass(`getAttendanceLogs() returned ${logs.length} records`);
        logs.slice(0, 3).forEach((l) =>
          info(`log userId=${l.userId} state=${l.state} at ${l.timestamp}`)
        );
      } catch (e) {
        fail(`getAttendanceLogs() failed: ${e.message}`);
      }
    } catch (e) {
      fail(`ZKTecoService.connect() failed: ${e.message}`);
    } finally {
      try {
        await svc.disconnect();
      } catch (_) {
        /* best-effort */
      }
    }
  }

  // Summary ----------------------------------------------------------------
  section("SUMMARY");
  console.log(`  failures: ${failures}   warnings: ${warnings}`);
  if (failures === 0) {
    console.log("  Machine is reachable and the application layer works.");
  } else {
    console.log("  Chain is broken. Fix the first [FAIL] above, then re-run.");
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Diagnostic crashed:", e);
  process.exit(2);
});
