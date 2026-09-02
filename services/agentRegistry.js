/**
 * agentRegistry.js
 * ----------------
 * Presence tracking and a command queue for Local ZKTeco Agents.
 *
 * The ZKTeco device lives on a private office LAN that a cloud-hosted backend
 * has no route to. Rather than exposing the device, a Local Agent running on an
 * office PC opens the connection OUTBOUND to this server and long-polls for
 * work. Every device operation therefore becomes: enqueue a command here, let
 * the agent pick it up on its next poll, and resolve the caller's promise when
 * the agent posts the result back.
 *
 * State is deliberately in-process: a command is only meaningful while the HTTP
 * request that created it is still waiting, so it must never outlive the
 * process. The consequence is that the backend must run as a single instance -
 * with two replicas, an agent polling replica A cannot see a command enqueued
 * on replica B. Railway's default single-instance deployment satisfies this.
 */

const crypto = require("crypto");

/** An agent that has not polled within this window counts as offline. */
const OFFLINE_AFTER_MS = 60_000;

/** Longest a caller will wait for an agent to answer a device command. */
const DEFAULT_COMMAND_TIMEOUT_MS = 45_000;

/** Cap on undelivered commands per agent, so a dead agent cannot leak memory. */
const MAX_PENDING_PER_AGENT = 50;

/** Agent-reported lifecycle states, surfaced to admins in the UI. */
const AGENT_STATUS = {
  ONLINE: "ONLINE",
  OFFLINE: "OFFLINE",
  CONNECTING: "CONNECTING",
  SYNCING: "SYNCING",
  SYNCED: "SYNCED",
  DEVICE_ERROR: "DEVICE_ERROR",
  AUTH_ERROR: "AUTH_ERROR",
};

/** agentId -> presence record */
const agents = new Map();

/** agentId -> commands accepted but not yet handed to the agent */
const pending = new Map();

/** commandId -> { resolve, reject, timer, agentId } for commands in flight */
const inflight = new Map();

/** agentId -> { resolve, timer } for a long-poll currently held open */
const waiters = new Map();

const now = () => Date.now();

const isFresh = (agent) =>
  !!agent && now() - agent.lastSeenAt <= OFFLINE_AFTER_MS;

/**
 * Record that an agent is alive and merge whatever it reported about itself.
 * Called on every poll, so it doubles as the heartbeat.
 */
function touch(agentId, patch = {}) {
  const existing = agents.get(agentId);
  const record = {
    agentId,
    connectedAt: existing?.connectedAt || new Date(),
    ...existing,
    ...patch,
    lastSeenAt: now(),
    lastSeen: new Date(),
  };
  agents.set(agentId, record);
  return record;
}

/** Explicitly mark an agent gone (clean shutdown). Queued work is discarded. */
function markOffline(agentId, reason = "agent reported shutdown") {
  const agent = agents.get(agentId);
  if (agent) {
    agent.status = AGENT_STATUS.OFFLINE;
    agent.lastSeenAt = 0;
    agent.offlineReason = reason;
  }
  releaseWaiter(agentId, []);
  failPending(agentId, reason);
}

/**
 * The agent currently able to run device commands.
 *
 * The deployment has exactly one office PC, so callers that do not name an
 * agent get whichever one is online. When several are registered, the most
 * recently seen wins - a stale record must never shadow a live agent.
 */
function getOnlineAgent(agentId = null) {
  if (agentId) {
    const agent = agents.get(agentId);
    return isFresh(agent) ? agent : null;
  }

  let best = null;
  for (const agent of agents.values()) {
    if (!isFresh(agent)) continue;
    if (!best || agent.lastSeenAt > best.lastSeenAt) best = agent;
  }
  return best;
}

function isOnline(agentId = null) {
  return !!getOnlineAgent(agentId);
}

/**
 * Queue a device command and resolve once the agent reports its outcome.
 *
 * Rejects with code DEVICE_OFFLINE when no agent is connected and
 * AGENT_TIMEOUT when one is connected but does not answer in time. Neither is
 * ever reported to the caller as success: a door that was not opened must not
 * read as opened.
 */
function enqueue(type, payload = {}, options = {}) {
  const { agentId = null, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = options;

  const agent = getOnlineAgent(agentId);
  if (!agent) {
    const error = new Error(
      "The Local Agent on the office PC is not connected, so the ZKTeco device cannot be reached."
    );
    error.code = "DEVICE_OFFLINE";
    return Promise.reject(error);
  }

  const queue = pending.get(agent.agentId) || [];
  if (queue.length >= MAX_PENDING_PER_AGENT) {
    const error = new Error(
      "The Local Agent has too many unprocessed commands queued. It may be stalled."
    );
    error.code = "AGENT_BUSY";
    return Promise.reject(error);
  }

  const command = {
    id: crypto.randomUUID(),
    type,
    payload,
    createdAt: new Date().toISOString(),
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(command.id);
      removeFromQueue(agent.agentId, command.id);
      const error = new Error(
        `The Local Agent did not return a result for "${type}" within ${Math.round(
          timeoutMs / 1000
        )}s.`
      );
      error.code = "AGENT_TIMEOUT";
      reject(error);
    }, timeoutMs);

    inflight.set(command.id, {
      resolve,
      reject,
      timer,
      agentId: agent.agentId,
      type,
    });

    queue.push(command);
    pending.set(agent.agentId, queue);

    // An agent parked in a long-poll gets the command immediately instead of
    // waiting out the remainder of its poll window.
    releaseWaiter(agent.agentId, drainQueue(agent.agentId));
  });
}

function removeFromQueue(agentId, commandId) {
  const queue = pending.get(agentId);
  if (!queue) return;
  const next = queue.filter((c) => c.id !== commandId);
  if (next.length) pending.set(agentId, next);
  else pending.delete(agentId);
}

function drainQueue(agentId) {
  const queue = pending.get(agentId) || [];
  pending.delete(agentId);
  return queue;
}

/**
 * Long-poll: resolve as soon as there is work, otherwise hold the request open
 * until maxWaitMs and resolve empty. Holding the connection is what removes the
 * need for any inbound path into the office network.
 */
function waitForCommands(agentId, maxWaitMs) {
  const ready = drainQueue(agentId);
  if (ready.length) return Promise.resolve(ready);

  // One poll per agent. A reconnecting agent must not leave the previous
  // request hanging, so the old waiter is released empty first.
  releaseWaiter(agentId, []);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(agentId);
      resolve(drainQueue(agentId));
    }, maxWaitMs);

    waiters.set(agentId, { resolve, timer });
  });
}

function releaseWaiter(agentId, commands) {
  const waiter = waiters.get(agentId);
  if (!waiter) return false;
  waiters.delete(agentId);
  clearTimeout(waiter.timer);
  waiter.resolve(commands);
  return true;
}

/**
 * Apply an agent's reported outcome for one command.
 * Unknown ids are ignored: they belong to a command that already timed out.
 */
function settle(commandId, { ok, result, error, code } = {}) {
  const entry = inflight.get(commandId);
  if (!entry) return false;

  inflight.delete(commandId);
  clearTimeout(entry.timer);

  if (ok) {
    entry.resolve(result);
  } else {
    const err = new Error(error || `Local Agent failed to run "${entry.type}".`);
    err.code = code || "DEVICE_ERROR";
    entry.reject(err);
  }
  return true;
}

/**
 * The agent's held poll connection dropped.
 *
 * Only meaningful while a poll is actually parked, which is precisely the case
 * where the agent process or the whole PC disappeared: the TCP connection
 * resets at once, whereas the heartbeat would take a full OFFLINE_AFTER_MS to
 * lapse. Marking it offline here means the app stops offering device actions
 * within a second of the office PC going away rather than a minute.
 *
 * A poll that was answered normally has no parked waiter, so a routine
 * completion never reaches this path.
 */
function noteDisconnect(agentId) {
  if (!releaseWaiter(agentId, [])) return false;

  const agent = agents.get(agentId);
  if (agent) {
    agent.lastSeenAt = 0;
    agent.status = AGENT_STATUS.OFFLINE;
    agent.offlineReason = "poll connection dropped";
  }
  failPending(agentId, "The Local Agent's connection dropped.");
  return true;
}

/** Reject everything queued or in flight for an agent that went away. */
function failPending(agentId, reason) {
  for (const [id, entry] of inflight.entries()) {
    if (entry.agentId !== agentId) continue;
    inflight.delete(id);
    clearTimeout(entry.timer);
    const error = new Error(reason);
    error.code = "DEVICE_OFFLINE";
    entry.reject(error);
  }
  pending.delete(agentId);
}

/** Admin-facing view. Contains no secrets - never include the agent token. */
function snapshot() {
  const list = Array.from(agents.values()).map((agent) => {
    const online = isFresh(agent);
    return {
      agentId: agent.agentId,
      status: online ? agent.status || AGENT_STATUS.ONLINE : AGENT_STATUS.OFFLINE,
      online,
      device: agent.device || null,
      deviceStatus: online ? agent.deviceStatus || "UNKNOWN" : "OFFLINE",
      version: agent.version || null,
      hostname: agent.hostname || null,
      connectedAt: agent.connectedAt || null,
      lastSeen: agent.lastSeen || null,
      lastSyncAt: agent.lastSyncAt || null,
      lastSyncResult: agent.lastSyncResult || null,
      lastError: agent.lastError || null,
      pendingCommands: (pending.get(agent.agentId) || []).length,
    };
  });

  return {
    agents: list,
    onlineCount: list.filter((a) => a.online).length,
  };
}

module.exports = {
  AGENT_STATUS,
  OFFLINE_AFTER_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  touch,
  markOffline,
  noteDisconnect,
  isOnline,
  getOnlineAgent,
  enqueue,
  waitForCommands,
  settle,
  snapshot,
};
