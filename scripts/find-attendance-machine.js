#!/usr/bin/env node
/**
 * find-attendance-machine.js
 * --------------------------
 * Sweep every local subnet for a ZKTeco attendance device and report the IPs
 * that answer, so the app can be pointed at the device wherever DHCP put it.
 *
 * Why a ZK protocol probe rather than ping or a port scan:
 *  - Some firmware does not answer ICMP, so a ping sweep produces false
 *    negatives. A real CMD_CONNECT is answered by every working unit.
 *  - A bare TCP connect proves only that something listens on 4370, not that
 *    it is an attendance device that will answer commands.
 *
 * Both transports are probed. These units answer on 4370 over UDP and/or TCP
 * depending on model and firmware - the October 2025 logs for this deployment
 * show the device answering on both - so a UDP-only sweep can miss a device
 * that is present and healthy.
 *
 * Usage:
 *   node scripts/find-attendance-machine.js              # every local /24
 *   node scripts/find-attendance-machine.js 192.168.1    # one subnet
 */
const dgram = require("dgram");
const os = require("os");

// Packet construction and reply validation live in services/zkProbe.js so this
// script and the app agree byte for byte. They were duplicated once, and the
// copies drifted: this one still sent reply_id = 0 and only accepted ACK_OK,
// which real hardware ignores and answers with ACK_OK_2 respectively.
const { connectPacket, isAck, unframe } = require("../services/zkProbe");

const PORT = 4370;
const WAIT_MS = 6000;

/** Local IPv4 /24 prefixes, skipping loopback and link-local (169.254.x). */
const localSubnets = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (i) =>
        i &&
        i.family === "IPv4" &&
        !i.internal &&
        !i.address.startsWith("169.254.")
    )
    .map((i) => i.address.split(".").slice(0, 3).join("."));

/**
 * TCP half of the sweep: open a socket, send the same CMD_CONNECT (wrapped in
 * zklib's 8-byte TCP prefix) and require a real ACK_OK back.
 */
const scanTcp = (prefixes) => {
  const net = require("net");
  const found = [];
  const targets = [];
  for (const prefix of prefixes) {
    for (let host = 1; host <= 254; host++) targets.push(`${prefix}.${host}`);
  }

  const body = connectPacket();
  const framed = Buffer.concat([
    Buffer.from([0x50, 0x50, 0x82, 0x7d]),
    (() => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(body.length, 0);
      return len;
    })(),
    body,
  ]);

  return Promise.all(
    targets.map(
      (ip) =>
        new Promise((resolve) => {
          const socket = new net.Socket();
          const done = () => {
            socket.destroy();
            resolve();
          };
          socket.setTimeout(WAIT_MS);
          socket.on("timeout", done);
          socket.on("error", done);
          socket.on("connect", () => socket.write(framed));
          socket.on("data", (buf) => {
            const payload = unframe(buf);
            if (isAck(payload)) found.push(ip);
            done();
          });
          socket.connect(PORT, ip);
        })
    )
  ).then(() => found);
};

const scan = (prefixes) =>
  new Promise((resolve) => {
    const found = [];
    const socket = dgram.createSocket("udp4");

    socket.on("error", () => {});
    socket.on("message", (msg, rinfo) => {
      if (isAck(msg) && !found.includes(rinfo.address)) {
        found.push(rinfo.address);
      }
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      const packet = connectPacket();
      for (const prefix of prefixes) {
        for (let host = 1; host <= 254; host++) {
          socket.send(packet, 0, packet.length, PORT, `${prefix}.${host}`, () => {});
        }
        socket.send(packet, 0, packet.length, PORT, `${prefix}.255`, () => {});
      }
      setTimeout(() => {
        socket.close();
        resolve(found);
      }, WAIT_MS);
    });
  });

(async () => {
  const arg = process.argv[2];
  const prefixes = arg ? [arg.replace(/\.$/, "")] : [...new Set(localSubnets())];

  if (prefixes.length === 0) {
    console.log("No usable network interface found.");
    process.exit(1);
  }

  console.log(`Scanning for ZKTeco devices on UDP and TCP ${PORT}:`);
  prefixes.forEach((p) => console.log(`  ${p}.1-254`));
  console.log(`Waiting ${WAIT_MS / 1000}s for replies...\n`);

  const [udp, tcp] = await Promise.all([scan(prefixes), scanTcp(prefixes)]);
  const found = [...new Set([...udp, ...tcp])].map(
    (ip) =>
      `${ip} (${[udp.includes(ip) && "UDP", tcp.includes(ip) && "TCP"]
        .filter(Boolean)
        .join(" + ")})`
  );

  if (found.length === 0) {
    console.log("No ZKTeco device answered.");
    console.log("");
    console.log("This means the device is not reachable on these networks. Check, in order:");
    console.log("  1. Is the device powered on?");
    console.log("  2. Is its network cable seated, with a link light on both ends?");
    console.log("  3. On the device: Menu > Comm > Ethernet - read its actual IP.");
    console.log("     If that IP is on a different subnet than this computer, the");
    console.log("     device cannot be reached without changing one of them.");
    console.log("  4. If the device is on Wi-Fi, confirm the router does not have");
    console.log("     client/AP isolation enabled - that blocks device-to-device");
    console.log("     traffic between wireless clients even on the same network.");
    process.exit(2);
  }

  console.log(`Found ${found.length} device(s):`);
  found.forEach((f) => console.log(`  ${f.replace(" (", `:${PORT} (`)}`));
  console.log("");
  console.log("Set this address in the app (Attendance page IP selector), and as");
  console.log("ZKTECO_IP in backend/.env, then restart the backend.");
})();
