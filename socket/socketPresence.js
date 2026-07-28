/**
 * socketPresence.js
 * -----------------
 * Tracks which users are currently online, per company. In-memory for now
 * (single instance); the interface is deliberately small so it can be swapped
 * for a Redis-backed implementation when horizontally scaling — without any
 * change to callers.
 *
 * A user may have multiple sockets (tabs/devices); we reference-count them so
 * a user is only "offline" once their last socket disconnects.
 */

// company -> Map<userId, Set<socketId>>
const registry = new Map();

const forCompany = (companyId) => {
  if (!registry.has(companyId)) registry.set(companyId, new Map());
  return registry.get(companyId);
};

/** Register a connected socket. Returns true if the user just came online. */
const add = (companyId, userId, socketId) => {
  const users = forCompany(companyId);
  const wasOnline = users.has(userId);
  if (!wasOnline) users.set(userId, new Set());
  users.get(userId).add(socketId);
  return !wasOnline;
};

/** Deregister a socket. Returns true if the user just went offline. */
const remove = (companyId, userId, socketId) => {
  const users = registry.get(companyId);
  if (!users || !users.has(userId)) return false;
  const sockets = users.get(userId);
  sockets.delete(socketId);
  if (sockets.size === 0) {
    users.delete(userId);
    if (users.size === 0) registry.delete(companyId);
    return true;
  }
  return false;
};

/** List of online user ids for a company. */
const online = (companyId) => {
  const users = registry.get(companyId);
  return users ? Array.from(users.keys()) : [];
};

const isOnline = (companyId, userId) => {
  const users = registry.get(companyId);
  return Boolean(users && users.has(userId));
};

module.exports = { add, remove, online, isOnline };
