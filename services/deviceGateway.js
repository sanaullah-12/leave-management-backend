/**
 * deviceGateway.js
 * ----------------
 * The single seam between "run a ZKTeco operation" and "how that operation
 * physically reaches the device".
 *
 * Two transports exist:
 *
 *   direct - this process opens the ZKTeco protocol connection itself. Correct
 *            only when the server shares a LAN with the device, which is the
 *            case in local development.
 *   agent  - the operation is relayed to a Local Agent running on an office PC,
 *            which holds the only reachable path to the device. Correct for any
 *            cloud deployment, where 192.168.x.x is unroutable.
 *
 * Routes call this module instead of instantiating ZKTecoService, so neither
 * the API contract nor the frontend changes when the transport does.
 */

const agentRegistry = require("./agentRegistry");

/** Device commands the Local Agent understands. Keep in sync with the agent. */
const COMMANDS = {
  PING: "device.ping",
  GET_USERS: "device.getUsers",
  UNLOCK_DOOR: "device.unlockDoor",
  SYNC: "device.sync",
};

/**
 * Which transport to use.
 *
 * DEVICE_MODE forces one explicitly; "auto" picks agent on a deployed host and
 * direct otherwise. RAILWAY_ENVIRONMENT is injected by the platform on every
 * deploy, so it detects production even if NODE_ENV was never configured in the
 * dashboard - the same reasoning server.js uses to pick its database.
 */
function resolveMode() {
  const explicit = (process.env.DEVICE_MODE || "").trim().toLowerCase();
  if (explicit === "direct" || explicit === "agent") return explicit;

  const isDeployed =
    process.env.NODE_ENV === "production" ||
    !!process.env.RAILWAY_ENVIRONMENT_NAME ||
    !!process.env.RAILWAY_ENVIRONMENT ||
    !!process.env.RAILWAY_PROJECT_ID;

  return isDeployed ? "agent" : "direct";
}

const isAgentMode = () => resolveMode() === "agent";

/** Load the existing device driver lazily so direct mode is the only user of it. */
function directService(ip, port) {
  const ZKTecoService = require("./zktecoService");
  return new ZKTecoService(ip, parseInt(port, 10) || 4370);
}

/**
 * Run one operation against the device, whichever transport applies.
 *
 * In direct mode the connection is opened and closed around the call, matching
 * what the routes did before this module existed. In agent mode the whole
 * operation is one queued command, because the agent owns its own connection
 * lifecycle on the office LAN.
 */
async function run(command, { ip, port = 4370, ...payload }, options = {}) {
  if (isAgentMode()) {
    return agentRegistry.enqueue(
      command,
      { ip, port: parseInt(port, 10) || 4370, ...payload },
      options
    );
  }

  const service = directService(ip, port);
  try {
    switch (command) {
      case COMMANDS.PING: {
        const result = await service.connect();
        let deviceInfo = { connection: "verified", library: "ZKLib" };
        try {
          const users = await service.getUsers();
          deviceInfo.enrolledUsers = Array.isArray(users) ? users.length : 0;
        } catch (probeError) {
          deviceInfo.note = `handshake ok; data probe failed: ${probeError.message}`;
        }
        return { deviceInfo, transport: result.transport || "udp" };
      }

      case COMMANDS.GET_USERS: {
        await service.connect();
        return { users: await service.getUsers() };
      }

      case COMMANDS.UNLOCK_DOOR: {
        await service.connect();
        const result = await service.unlockDoor(payload.durationSeconds || 10);
        return { durationSeconds: result.durationSeconds };
      }

      default:
        throw new Error(`Unknown device command: ${command}`);
    }
  } finally {
    try {
      await service.disconnect();
    } catch (_) {
      /* best-effort cleanup */
    }
  }
}

/** Verify the device answers, and report what it knows about itself. */
const ping = (ip, port) => run(COMMANDS.PING, { ip, port }, { timeoutMs: 60_000 });

/** Enrolled users as ZKTecoService.getUsers() shapes them. */
const getUsers = (ip, port) =>
  run(COMMANDS.GET_USERS, { ip, port }, { timeoutMs: 60_000 });

/** Trigger the access-control relay for durationSeconds. */
const unlockDoor = (ip, port, durationSeconds = 10) =>
  run(
    COMMANDS.UNLOCK_DOOR,
    { ip, port, durationSeconds },
    { timeoutMs: 30_000 }
  );

/**
 * Ask the agent to pull the device log and push it to the ingest endpoint.
 *
 * Only meaningful in agent mode. Direct mode already has AttendanceSyncService,
 * which the existing /api/attendance-sync routes call, so this does not
 * duplicate it.
 */
const requestSync = (ip, port, options = {}) =>
  agentRegistry.enqueue(
    COMMANDS.SYNC,
    { ip, port: parseInt(port, 10) || 4370, ...options },
    { timeoutMs: 120_000 }
  );

/**
 * Whether a device operation can be attempted at all right now.
 * In agent mode this is false whenever the office PC is off.
 */
function availability() {
  const mode = resolveMode();
  if (mode === "direct") {
    return { available: true, mode, reason: null };
  }

  const agent = agentRegistry.getOnlineAgent();
  return {
    available: !!agent,
    mode,
    agent: agent
      ? { agentId: agent.agentId, status: agent.status, lastSeen: agent.lastSeen }
      : null,
    reason: agent
      ? null
      : "The Local Agent on the office PC is not connected.",
  };
}

module.exports = {
  COMMANDS,
  resolveMode,
  isAgentMode,
  ping,
  getUsers,
  unlockDoor,
  requestSync,
  availability,
};
