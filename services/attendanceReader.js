/**
 * attendanceReader.js
 * -------------------
 * Reads the attendance log off a ZKTeco device.
 *
 * Why this is not zklib like the rest of the device code:
 *
 * zklib@0.2.11 assumes the first reply to ATTLOG_RRQ carries a 16-byte data
 * header and reads the record count with readUInt32LE(8). The firmware in this
 * fleet answers with a bare 8-byte acknowledgement first, so that read runs off
 * the end of the datagram and throws RangeError from inside the socket's
 * "message" handler. Nothing can catch it there - it is not on the promise
 * chain - so the exception reaches the process and kills it. Verified against
 * the live device at 192.168.1.201: every getAttendance() call terminates the
 * process before returning a single record.
 *
 * node-zklib implements the chunked PREPARE_DATA/DATA exchange over TCP and
 * reads the same log correctly (22,631 records off that same device). It is
 * therefore used for attendance only. Connect, user enumeration and door unlock
 * stay on zklib, which is proven on this hardware.
 *
 * The output shape is identical to ZKTecoService.getAttendanceLogs(), so
 * callers and the database transform are unchanged.
 */

/**
 * node-zklib decodes a 40-byte record into {userSn, deviceUserId, recordTime}
 * and drops the verification byte. The historical import in this database
 * stored that byte as "State" - its distribution over the 82,668 legacy records
 * matches the device byte for byte - so it must be preserved or new records
 * would read back differently from old ones.
 *
 * This patch MUST run before node-zklib itself is required: zklibtcp.js
 * destructures { decodeRecordData40 } from utils at load time, capturing the
 * function by value. Patching afterwards rebinds the property that nothing
 * reads any more, and the extra field silently never appears.
 */
const zkUtils = require("node-zklib/utils");
if (!zkUtils.__verifyModePatched) {
  const decode40 = zkUtils.decodeRecordData40;
  zkUtils.decodeRecordData40 = (recordData) => ({
    ...decode40(recordData),
    // Offset 26 in the ZK 40-byte ATTLOG record: the verification method
    // (1 fingerprint, 2 face, 3 password, 4 card).
    verifyMode: recordData[26],
  });
  zkUtils.__verifyModePatched = true;
}

const ZKLib = require("node-zklib");

/** Socket and per-command timeouts, in milliseconds. */
const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * Fetch attendance records from the device.
 *
 * @param {string} ip
 * @param {number} port
 * @param {string|Date|null} startDate Drop records older than this.
 * @returns {Promise<Array>} Records shaped like ZKTecoService.getAttendanceLogs()
 */
async function readAttendanceLogs(ip, port = 4370, startDate = null) {
  const zk = new ZKLib(ip, parseInt(port, 10) || 4370, CONNECT_TIMEOUT_MS, COMMAND_TIMEOUT_MS);

  try {
    await zk.createSocket();

    const response = await zk.getAttendances();
    const records = Array.isArray(response) ? response : response?.data || [];

    let logs = records
      .map((record) => {
        const timestamp = new Date(record.recordTime);
        if (Number.isNaN(timestamp.getTime())) return null;

        // deviceUserId is the enrolled User ID that identifies the employee.
        // userSn is the device's record slot and is not an employee identifier.
        return {
          uid: record.userSn ?? "unknown",
          userId: record.deviceUserId,
          state: record.verifyMode,
          timestamp,
          type: "attendance",
          mode: verifyModeName(record.verifyMode),
          verifyMode: record.verifyMode,
          ip,
          date: timestamp.toISOString().split("T")[0],
          rawData: record,
        };
      })
      .filter(Boolean);

    if (startDate) {
      const from = new Date(startDate);
      if (!Number.isNaN(from.getTime())) {
        logs = logs.filter((log) => log.timestamp >= from);
      }
    }

    return logs;
  } finally {
    try {
      await zk.disconnect();
    } catch (_) {
      /* best-effort cleanup */
    }
  }
}

// The `date` field above is derived in UTC on purpose. The device records local
// wall-clock time, but every consumer of this data - AttendanceSyncService's
// transform, attendanceDbService's range filter and its record builder - derives
// the calendar day from toISOString(). Deriving it locally here would put this
// one field on a different calendar from the rest of the pipeline.

function verifyModeName(mode) {
  const names = { 1: "fingerprint", 2: "face", 3: "password", 4: "card" };
  return names[mode] || "unknown";
}

/** Device counters, useful for confirming a sync read everything. */
async function readDeviceInfo(ip, port = 4370) {
  const zk = new ZKLib(ip, parseInt(port, 10) || 4370, CONNECT_TIMEOUT_MS, COMMAND_TIMEOUT_MS);
  try {
    await zk.createSocket();
    return await zk.getInfo();
  } finally {
    try {
      await zk.disconnect();
    } catch (_) {
      /* best-effort cleanup */
    }
  }
}

module.exports = { readAttendanceLogs, readDeviceInfo };
