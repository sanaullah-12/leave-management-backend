/**
 * zkProbe.js
 * ----------
 * Positive proof that a ZKTeco device is actually there: send a real
 * CMD_CONNECT and require the device's CMD_ACK_OK back.
 *
 * Why this exists: zklib's own connect() callback fires with no error even when
 * nothing is listening. A UDP send succeeds locally whether or not anything
 * receives it, so "the callback did not error" is evidence that a packet left
 * this machine - not that a device answered. Trusting it produced a
 * "Connected" status, and worse a "Door unlocked" confirmation, against an
 * absent device.
 *
 * The device may answer on UDP or TCP depending on model and firmware, so both
 * are supported and the caller decides which to try.
 */
const dgram = require("dgram");
const net = require("net");

const USHRT_MAX = 65535;
const CMD_CONNECT = 1000;
// Real hardware answers CMD_CONNECT with ACK_OK_2 (2005), not ACK_OK (2000).
// Both are a device saying "I am here", so both count as proof.
const CMD_ACK_OK = 2000;
const CMD_ACK_OK_2 = 2005;
/** zklib's TCP framing prefix: magic 0x7d825050 followed by a LE payload length. */
const TCP_MAGIC = 0x7d825050;

/** zklib's checksum - must match byte for byte or the device ignores the packet. */
const chksum = (buf) => {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    sum += i === buf.length - 1 ? buf[i] : buf.readUInt16LE(i);
    sum %= USHRT_MAX;
  }
  return USHRT_MAX - sum - 1;
};

const connectPacket = () => {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(CMD_CONNECT, 0);
  buf.writeUInt16LE(0, 2); // checksum placeholder
  buf.writeUInt16LE(0, 4); // session id
  buf.writeUInt16LE(0, 6); // reply id
  buf.writeUInt16LE(chksum(buf), 2);
  // zklib bumps reply_id AFTER checksumming, so the bytes on the wire carry
  // reply_id = 1 with a checksum computed over reply_id = 0. Tested hardware
  // ignores a packet that does not match this exact layout, so reproduce it
  // rather than sending the "clean" version.
  buf.writeUInt16LE(1, 6);
  return buf;
};

/** Strip zklib's 8-byte TCP prefix when present. */
const unframe = (buf) =>
  buf.length > 8 && buf.readUInt32LE(0) === TCP_MAGIC ? buf.slice(8) : buf;

const isAck = (buf) => {
  if (buf.length < 8) return false;
  const cmd = buf.readUInt16LE(0);
  return cmd === CMD_ACK_OK || cmd === CMD_ACK_OK_2;
};

const probeUdp = (ip, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch (_) {
        /* already closed */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", () => finish(false));
    socket.on("message", (msg) => finish(isAck(msg)));
    socket.bind(() => {
      const packet = connectPacket();
      socket.send(packet, 0, packet.length, port, ip, (err) => {
        if (err) finish(false);
      });
    });
  });

const probeTcp = (ip, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("data", (buf) => finish(isAck(unframe(buf))));
    socket.on("connect", () => {
      const body = connectPacket();
      const len = Buffer.alloc(4);
      len.writeUInt32LE(body.length, 0);
      socket.write(
        Buffer.concat([Buffer.from([0x50, 0x50, 0x82, 0x7d]), len, body])
      );
    });
    socket.connect(port, ip);
  });

/**
 * @param {string} ip
 * @param {number} port
 * @param {"udp"|"tcp"} transport
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true only if the device replied with ACK_OK.
 */
const probe = (ip, port, transport = "udp", timeoutMs = 5000) =>
  transport === "tcp"
    ? probeTcp(ip, port, timeoutMs)
    : probeUdp(ip, port, timeoutMs);

module.exports = { probe, connectPacket, chksum, isAck, unframe, CMD_ACK_OK, CMD_ACK_OK_2 };
