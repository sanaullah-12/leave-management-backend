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
const { createTCPHeader, decodeRecordData40 } = zkUtils;
const {
  COMMANDS,
  REQUEST_DATA,
  MAX_CHUNK,
} = require("node-zklib/constants");


/**
 * How long a single device request may take.
 *
 * ZKLib's signature is (ip, port, timeout, inport): the third argument is the
 * timeout for every request, and the fourth is a UDP source port. Passing the
 * command timeout in the fourth slot left every request on the library's third
 * argument - ten seconds - on a device whose getInfo alone can take nine, so
 * each attendance read timed out before the device had answered once.
 *
 * The connect handshake is unaffected: writeMessage() uses a fixed two seconds
 * for CMD_CONNECT, so a device that is off still fails fast.
 */
const COMMAND_TIMEOUT_MS = 60_000;

/** UDP source port. Unused on the TCP path this reader takes. */
const UDP_INPORT = 10_000;

/**
 * The attendance export is read one chunk at a time, in this file, rather than
 * through node-zklib's getAttendances().
 *
 * The library asks the device for the whole export at once: it works out how
 * many 65,472-byte chunks the payload needs and fires every CMD_DATA_RDY in a
 * loop with no flow control. With 22,874 records that is fourteen simultaneous
 * requests, and this firmware answers them with 69 bytes of acknowledgement
 * and then nothing - the transfer stalls, every time, on a device that has
 * just been power cycled and answers everything else in seconds.
 *
 * Traced on the live unit: fourteen at once yields 69 bytes in 43 seconds, and
 * one chunk on its own yields all 64,008 bytes in 13. So the device is not
 * broken and the log is not too big - the request pattern is wrong.
 *
 * Reading backwards from the newest record also means an incremental sync
 * stops as soon as it is past its window instead of pulling the entire log
 * every ten minutes. Records are stored oldest first, which is what makes that
 * safe; one extra chunk is always read past the cutoff so a device that files
 * a punch slightly out of order still gets picked up.
 */
const RECORD_SIZE = 40;
/** The payload opens with a four-byte count before the first record. */
const PAYLOAD_PREFIX = 4;
/** Each delivered chunk arrives behind its own eight-byte header. */
const CHUNK_HEADER = 8;
/** Whole records per chunk, so a chunk boundary is never mid-record. */
const RECORDS_PER_CHUNK = Math.floor(MAX_CHUNK / RECORD_SIZE);
/** A single chunk is answered in about 13s on this hardware. */
const CHUNK_TIMEOUT_MS = 45_000;

/**
 * The window a decoded punch must fall in to be believed.
 *
 * A chunk that arrives misframed is decoded from whatever bytes are at the
 * record boundary, so the timestamp it yields is arbitrary rather than wrong by
 * a little. One such record dated 2046 is what pinned this agent's sync
 * watermark twenty years into the future and stopped it collecting anything for
 * three days. The device cannot hold a punch from before its own epoch or from
 * after now, so a timestamp outside this window is a decoding artifact and not
 * an attendance event.
 */
const DEVICE_EPOCH_MS = Date.UTC(2000, 0, 1);

/** Allows for a device clock running a little ahead of this machine's. */
const CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function isPlausiblePunch(timestamp) {
  const time = timestamp.getTime();
  return time >= DEVICE_EPOCH_MS && time <= Date.now() + CLOCK_SKEW_MS;
}

/**
 * Ask for one slice of the export and collect exactly that slice.
 *
 * @param {object} tcp     The library's TCP connection object
 * @param {number} start   Byte offset into the payload
 * @param {number} length  Bytes wanted
 */
function readChunk(tcp, start, length) {
  return new Promise((resolve, reject) => {
    let frame = Buffer.alloc(0);
    let payload = Buffer.alloc(0);
    let timer = null;

    const finish = (error) => {
      clearTimeout(timer);
      tcp.socket.removeListener("data", onData);
      if (error) reject(error);
      else resolve(payload);
    };

    // The clock is restarted by every packet, so a slow but progressing
    // transfer is never cut off - only a silent one.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          finish(
            new Error(
              `Device stopped sending at offset ${start}: ${payload.length} of ${length} bytes`
            )
          ),
        CHUNK_TIMEOUT_MS
      );
    };

    const onData = (reply) => {
      arm();
      frame = Buffer.concat([frame, reply]);

      // Device packets are an 8-byte frame header, then the ZK packet whose
      // own 8-byte header is skipped to leave the data.
      while (frame.length >= CHUNK_HEADER) {
        const packetLength = frame.readUIntLE(4, 2);
        if (frame.length < CHUNK_HEADER + packetLength) break;
        payload = Buffer.concat([
          payload,
          frame.subarray(16, CHUNK_HEADER + packetLength),
        ]);
        frame = frame.subarray(CHUNK_HEADER + packetLength);
      }

      if (payload.length >= length + CHUNK_HEADER) finish(null);
    };

    tcp.socket.on("data", onData);
    arm();
    tcp.sendChunkRequest(start, length);
  });
}

/**
 * The device's attendance records, newest chunk first, stopping once the
 * requested window has been covered.
 *
 * @param {object} tcp
 * @param {Date|null} cutoff Stop once a chunk is entirely older than this.
 */
async function fetchRecords(tcp, cutoff) {
  try {
    await tcp.freeData();
  } catch (_) {
    /* a stale buffer on the device is not a reason to abandon the read */
  }

  // Opening the export tells us how much there is; nothing is sent yet.
  tcp.replyId += 1;
  const request = createTCPHeader(
    COMMANDS.CMD_DATA_WRRQ,
    tcp.sessionId,
    tcp.replyId,
    REQUEST_DATA.GET_ATTENDANCE_LOGS
  );

  const reply = await tcp.requestData(request);
  const size = reply.subarray(16).readUIntLE(1, 4);
  const totalRecords = Math.max(
    0,
    Math.floor((size - PAYLOAD_PREFIX) / RECORD_SIZE)
  );
  if (!totalRecords) return { records: [], totalRecords: 0, chunksRead: 0 };

  const records = [];
  let end = totalRecords;
  let chunksRead = 0;
  // One chunk of margin past the cutoff, for a punch filed out of order.
  let marginChunks = 1;

  while (end > 0) {
    const take = Math.min(RECORDS_PER_CHUNK, end);
    const from = end - take;
    const payload = await readChunk(
      tcp,
      PAYLOAD_PREFIX + from * RECORD_SIZE,
      take * RECORD_SIZE
    );
    chunksRead += 1;

    let data = payload.subarray(CHUNK_HEADER);
    const chunk = [];
    while (data.length >= RECORD_SIZE) {
      chunk.push({
        ...decodeRecordData40(data.subarray(0, RECORD_SIZE)),
        ip: tcp.ip,
      });
      data = data.subarray(RECORD_SIZE);
    }

    records.unshift(...chunk);
    end = from;

    if (!cutoff) continue;

    const oldest = chunk
      .map((record) => new Date(record.recordTime).getTime())
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => a - b)[0];

    if (oldest !== undefined && oldest < cutoff.getTime()) {
      if (marginChunks <= 0) break;
      marginChunks -= 1;
    }
  }

  try {
    await tcp.freeData();
  } catch (_) {
    /* best-effort cleanup */
  }

  return { records, totalRecords, chunksRead };
}

/**
 * A device failure with something readable in it.
 *
 * node-zklib rejects a failed connect with a ZKError, which is not an Error
 * and carries no `message` at all - the real one is hidden under `.err` and
 * only reachable through `toast()`. Anything logging `error.message` therefore
 * printed an empty string, which is how a device that never answered the
 * handshake produced "getAttendanceLogs failed" with nothing after it.
 */
function deviceError(error, stage) {
  if (error && typeof error.toast === "function") {
    let detail;
    try {
      detail = error.toast();
    } catch (_) {
      /* toast() reads through .err and throws when there is none */
    }
    detail = detail || error.err?.code || error.err?.message || "no reply";
    return new Error(`${stage}: ${detail}`);
  }
  if (error instanceof Error) {
    return error.message ? error : new Error(`${stage}: ${error.name}`);
  }
  return new Error(`${stage}: ${String(error)}`);
}

/**
 * Fetch attendance records from the device.
 *
 * @param {string} ip
 * @param {number} port
 * @param {string|Date|null} startDate Drop records older than this.
 * @returns {Promise<Array>} Records shaped like ZKTecoService.getAttendanceLogs()
 */
async function readAttendanceLogs(ip, port = 4370, startDate = null) {
  const zk = new ZKLib(
    ip,
    parseInt(port, 10) || 4370,
    COMMAND_TIMEOUT_MS,
    UDP_INPORT
  );

  try {
    try {
      await zk.createSocket();
    } catch (error) {
      throw deviceError(
        error,
        "Device did not answer the ZKTeco handshake at " + ip
      );
    }

    // The export is read over TCP because that is the transport the chunked
    // request pattern below speaks. A device that only answered UDP would
    // otherwise fail deep inside the read with an unhelpful error.
    if (zk.connectionType !== "tcp") {
      throw new Error(
        `Device at ${ip} accepted only a ${zk.connectionType || "unknown"} session; the attendance export needs TCP`
      );
    }

    const cutoff = startDate ? new Date(startDate) : null;
    const { records, totalRecords, chunksRead } = await fetchRecords(
      zk.zklibTcp,
      cutoff && !Number.isNaN(cutoff.getTime()) ? cutoff : null
    );

    if (!records.length && totalRecords) {
      throw new Error(
        `Device offered ${totalRecords} records over ${chunksRead} chunk(s) and delivered none`
      );
    }

    if (!records.length) {
      // A device that holds records and hands back none has not said there is
      // nothing to sync - it has failed to deliver. Only checked on the empty
      // path, because getInfo costs seconds on a slow unit.
      let stored = null;
      try {
        stored = (await zk.getInfo())?.logCounts ?? null;
      } catch (_) {
        /* the counter is a diagnostic, not a precondition */
      }
      if (stored) {
        throw new Error(
          `Device delivered no attendance records although it reports ${stored} stored`
        );
      }
    }

    let discarded = 0;
    let logs = records
      .map((record) => {
        const timestamp = new Date(record.recordTime);
        if (Number.isNaN(timestamp.getTime())) return null;

        if (!isPlausiblePunch(timestamp)) {
          discarded += 1;
          return null;
        }

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

    if (discarded) {
      // Loud on purpose: a misframed chunk is the one fault in this reader that
      // produces plausible-looking records rather than an error.
      console.warn(
        `Discarded ${discarded} record(s) from ${ip} with an impossible timestamp`
      );
    }

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
  const zk = new ZKLib(
    ip,
    parseInt(port, 10) || 4370,
    COMMAND_TIMEOUT_MS,
    UDP_INPORT
  );
  try {
    try {
      await zk.createSocket();
    } catch (error) {
      throw deviceError(
        error,
        "Device did not answer the ZKTeco handshake at " + ip
      );
    }
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
