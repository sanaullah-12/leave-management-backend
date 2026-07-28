/**
 * socketService.js
 * ----------------
 * The ONLY interface business code (routes, utils) uses to emit real-time
 * events. This keeps Socket.IO out of controllers: callers say *what* happened
 * and *who* should hear it, never how sockets work.
 *
 * All emits are best-effort and fail-safe: if the socket server isn't ready
 * (e.g. during tests or before init), emits are silently skipped so they can
 * never break a REST request.
 */
const { getIO } = require("./socketServer");
const { EVENTS, ROOMS } = require("./socketEvents");

const safeEmit = (room, event, payload) => {
  try {
    getIO().to(room).emit(event, payload);
  } catch (err) {
    // io not initialised or emit failed — never propagate to the caller.
    if (process.env.NODE_ENV !== "production") {
      console.warn(`⚡ emit skipped (${event}):`, err?.message || err);
    }
  }
};

const SocketService = {
  events: EVENTS,

  /** Emit to one user (all their tabs/devices). */
  toUser: (userId, event, payload) =>
    safeEmit(ROOMS.user(String(userId)), event, payload),

  /** Emit to every member of a company. */
  toCompany: (companyId, event, payload) =>
    safeEmit(ROOMS.company(String(companyId)), event, payload),

  /** Emit to all admins of a company. */
  toCompanyAdmins: (companyId, event, payload) =>
    safeEmit(ROOMS.companyAdmins(String(companyId)), event, payload),

  /** Emit to all employees of a company. */
  toCompanyEmployees: (companyId, event, payload) =>
    safeEmit(ROOMS.companyEmployees(String(companyId)), event, payload),

  /** Ask a company's clients to refetch a given statistics scope. */
  statsUpdate: (companyId, scope) =>
    safeEmit(ROOMS.company(String(companyId)), EVENTS.STATS_UPDATE, { scope }),
};

module.exports = SocketService;
