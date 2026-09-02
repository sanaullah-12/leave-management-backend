/**
 * routes/agent.js
 * ---------------
 * The server half of the Local ZKTeco Agent link.
 *
 * Everything under /api/agent except /status is authenticated by the agent
 * shared secret, not a user JWT. The agent always initiates: it announces
 * itself, long-polls for device commands, posts results back, and pushes
 * attendance batches. No inbound connection to the office network is ever
 * required, so no router port has to be opened.
 */

const express = require("express");
const router = express.Router();

const { authenticateAgent } = require("../middleware/agentAuth");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const agentRegistry = require("../services/agentRegistry");
const deviceGateway = require("../services/deviceGateway");
const AttendanceSyncService = require("../services/AttendanceSyncService");
const AttendanceLog = require("../models/AttendanceLog");
const Company = require("../models/Company");

/** Upper bound on how long a long-poll is held open. */
const MAX_POLL_WAIT_MS = 25_000;

/** Largest attendance batch accepted in one push. */
const MAX_BATCH_SIZE = 2000;

/**
 * The company that agent-collected attendance belongs to.
 *
 * The agent authenticates as a machine, so it carries no user and therefore no
 * company. AGENT_COMPANY_ID pins it explicitly; without that, a single-company
 * deployment is unambiguous and resolves on its own. More than one company and
 * no pin is a configuration error, not something to guess - guessing would file
 * one tenant's punches under another.
 */
let cachedCompanyId = null;
async function resolveAgentCompany() {
  if (cachedCompanyId) return cachedCompanyId;

  const pinned = (process.env.AGENT_COMPANY_ID || "").trim();
  if (pinned) {
    cachedCompanyId = pinned;
    return cachedCompanyId;
  }

  const companies = await Company.find({}).select("_id name").limit(2).lean();

  if (companies.length === 1) {
    cachedCompanyId = companies[0]._id.toString();
    console.log(
      `Agent attendance will be filed under the only company present: ${companies[0].name}`
    );
    return cachedCompanyId;
  }

  const error = new Error(
    companies.length === 0
      ? "No company exists, so agent attendance cannot be filed."
      : "Several companies exist. Set AGENT_COMPANY_ID so agent attendance is filed under the right one."
  );
  error.code = "COMPANY_UNRESOLVED";
  throw error;
}

/**
 * POST /api/agent/hello
 * Announce presence and report configuration. Called on start and whenever the
 * agent reconnects after a network drop.
 */
router.post("/hello", authenticateAgent, (req, res) => {
  const { device, version, hostname, status } = req.body || {};

  const record = agentRegistry.touch(req.agentId, {
    device: device || null,
    version: version || null,
    hostname: hostname || null,
    status: status || agentRegistry.AGENT_STATUS.ONLINE,
    connectedAt: new Date(),
    lastError: null,
  });

  console.log(
    `Local Agent "${req.agentId}" connected from ${req.ip}` +
      (device?.ip ? ` (device ${device.ip}:${device.port})` : "")
  );

  res.json({
    success: true,
    agentId: record.agentId,
    serverTime: new Date().toISOString(),
    pollWaitMs: MAX_POLL_WAIT_MS,
    maxBatchSize: MAX_BATCH_SIZE,
  });
});

/**
 * GET /api/agent/commands
 * Long-poll for work. Returns as soon as a command is queued, or empty when the
 * wait window expires. Each call also refreshes the agent's heartbeat, so the
 * absence of polls is what marks the office PC offline.
 */
router.get("/commands", authenticateAgent, async (req, res) => {
  const requested = parseInt(req.query.wait, 10);
  const waitMs = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : MAX_POLL_WAIT_MS,
    MAX_POLL_WAIT_MS
  );

  agentRegistry.touch(req.agentId, {
    status: req.query.status || undefined,
    deviceStatus: req.query.deviceStatus || undefined,
  });

  // A dropped poll connection is the earliest evidence the office PC is gone.
  // Without this the agent would keep reading as online until its heartbeat
  // lapsed, and the app would offer device actions that cannot succeed.
  req.on("close", () => {
    if (!res.writableEnded) agentRegistry.noteDisconnect(req.agentId);
  });

  try {
    const commands = await agentRegistry.waitForCommands(req.agentId, waitMs);
    if (res.writableEnded) return;
    res.json({ success: true, commands, serverTime: new Date().toISOString() });
  } catch (error) {
    console.error(`Agent poll failed for ${req.agentId}:`, error.message);
    res.status(500).json({ success: false, code: "POLL_ERROR", message: error.message });
  }
});

/**
 * POST /api/agent/commands/:id/result
 * Report the outcome of one command. A failure here must stay a failure: the
 * waiting HTTP caller is rejected rather than told the device responded.
 */
router.post("/commands/:id/result", authenticateAgent, (req, res) => {
  const { ok, result, error, code } = req.body || {};

  agentRegistry.touch(req.agentId, {
    lastError: ok ? null : error || "device command failed",
  });

  const settled = agentRegistry.settle(req.params.id, { ok, result, error, code });

  res.json({
    success: true,
    // Not an error: the caller may already have timed out and stopped waiting.
    settled,
  });
});

/**
 * POST /api/agent/attendance
 * Ingest a batch of device punches.
 *
 * The agent may resend the same records after a network failure, so this is
 * idempotent by construction: the unique index on
 * {machineIp, employeeId, timestamp} turns a repeat into a skip.
 */
router.post("/attendance", authenticateAgent, async (req, res) => {
  const { deviceIp, logs, syncId } = req.body || {};

  if (!deviceIp || typeof deviceIp !== "string") {
    return res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      message: "deviceIp is required.",
    });
  }

  if (!Array.isArray(logs)) {
    return res.status(400).json({
      success: false,
      code: "BAD_REQUEST",
      message: "logs must be an array.",
    });
  }

  if (logs.length > MAX_BATCH_SIZE) {
    return res.status(413).json({
      success: false,
      code: "BATCH_TOO_LARGE",
      message: `Send at most ${MAX_BATCH_SIZE} records per request.`,
    });
  }

  try {
    const companyId = await resolveAgentCompany();

    agentRegistry.touch(req.agentId, {
      status: agentRegistry.AGENT_STATUS.SYNCING,
    });

    const result = await AttendanceSyncService.persistDeviceLogs(
      deviceIp,
      companyId,
      logs
    );

    agentRegistry.touch(req.agentId, {
      status: agentRegistry.AGENT_STATUS.SYNCED,
      lastSyncAt: new Date(),
      lastSyncResult: {
        inserted: result.inserted,
        skipped: result.skipped,
        total: result.total,
      },
      lastError: null,
    });

    console.log(
      `Agent "${req.agentId}" pushed ${result.total} records from ${deviceIp}: ` +
        `${result.inserted} inserted, ${result.skipped} duplicate` +
        (syncId ? ` (sync ${syncId})` : "")
    );

    res.json({ success: true, ...result });
  } catch (error) {
    console.error(`Agent attendance ingest failed:`, error.message);

    agentRegistry.touch(req.agentId, {
      status: agentRegistry.AGENT_STATUS.DEVICE_ERROR,
      lastError: error.message,
    });

    res.status(error.code === "COMPANY_UNRESOLVED" ? 409 : 500).json({
      success: false,
      code: error.code || "INGEST_ERROR",
      message: error.message,
    });
  }
});

/**
 * POST /api/agent/bye
 * Clean shutdown. Marks the agent offline immediately instead of waiting for
 * the heartbeat to lapse, so a stopped service is reported as such at once.
 */
router.post("/bye", authenticateAgent, (req, res) => {
  console.log(`Local Agent "${req.agentId}" disconnected cleanly`);
  agentRegistry.markOffline(req.agentId, "agent shut down");
  res.json({ success: true });
});

/**
 * GET /api/agent/status
 * Admin view of agent and device availability. User-authenticated, not
 * agent-authenticated - this is the endpoint the app uses to decide whether to
 * offer device actions at all.
 */
router.get("/status", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  const availability = deviceGateway.availability();
  const snapshot = agentRegistry.snapshot();

  let lastRecord = null;
  try {
    lastRecord = await AttendanceLog.findOne({ company: req.user.company })
      .sort({ timestamp: -1 })
      .select("timestamp machineIp")
      .lean();
  } catch (error) {
    console.error("Failed to read last attendance record:", error.message);
  }

  res.json({
    success: true,
    mode: availability.mode,
    deviceAvailable: availability.available,
    reason: availability.reason,
    ...snapshot,
    lastAttendanceRecord: lastRecord
      ? { timestamp: lastRecord.timestamp, machineIp: lastRecord.machineIp }
      : null,
  });
});

/**
 * POST /api/agent/sync
 * Ask the connected agent to pull the device log now instead of waiting for its
 * next scheduled sync.
 */
router.post("/sync", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  const ip = req.body?.ip || process.env.ZKTECO_IP || "192.168.1.201";
  const port = parseInt(req.body?.port || process.env.ZKTECO_PORT || 4370, 10);

  if (!deviceGateway.isAgentMode()) {
    return res.status(400).json({
      success: false,
      code: "NOT_AGENT_MODE",
      message:
        "This server talks to the device directly. Use /api/attendance-sync/incremental/:ip instead.",
    });
  }

  try {
    const result = await deviceGateway.requestSync(ip, port, {
      // full re-reads the entire device log instead of the incremental window.
      // Every record is deduplicated on write, so this is safe to run at will.
      full: req.body?.full === true,
      since: req.body?.since || null,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const offline = error.code === "DEVICE_OFFLINE";
    res.status(offline ? 503 : 502).json({
      success: false,
      code: error.code || "SYNC_ERROR",
      message: error.message,
    });
  }
});

module.exports = router;
