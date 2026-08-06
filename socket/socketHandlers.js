/**
 * socketHandlers.js
 * -----------------
 * Per-connection lifecycle: joins the authenticated user into their scoped
 * rooms (user / company / role), maintains presence, and cleans everything up
 * on disconnect. Contains NO business logic - only connection wiring.
 */
const { EVENTS, CLIENT_EVENTS, ROOMS } = require("./socketEvents");
const presence = require("./socketPresence");

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
const registerHandlers = (io, socket) => {
  const { id, role, company } = socket.user;

  // Scoped rooms - the basis for targeted, tenant-safe emits.
  socket.join(ROOMS.user(id));
  socket.join(ROOMS.company(company));
  socket.join(ROOMS.companyRole(company, role));

  // Presence: broadcast the updated online list to the company on change.
  const cameOnline = presence.add(company, id, socket.id);
  if (cameOnline) {
    io.to(ROOMS.company(company)).emit(EVENTS.PRESENCE_UPDATE, {
      online: presence.online(company),
    });
  }

  // Ack so the client knows auth + join succeeded.
  socket.emit(EVENTS.CONNECTED, { id, role, company });

  // Client can request the current presence snapshot on demand.
  socket.on(CLIENT_EVENTS.PRESENCE_GET, () => {
    socket.emit(EVENTS.PRESENCE_UPDATE, { online: presence.online(company) });
  });

  socket.on("disconnect", () => {
    const wentOffline = presence.remove(company, id, socket.id);
    if (wentOffline) {
      io.to(ROOMS.company(company)).emit(EVENTS.PRESENCE_UPDATE, {
        online: presence.online(company),
      });
    }
  });

  socket.on("error", (err) => {
    // Never crash the process on a socket-level error.
    console.error("Socket error:", err?.message || err);
  });
};

module.exports = registerHandlers;
