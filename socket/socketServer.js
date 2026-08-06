/**
 * socketServer.js
 * ---------------
 * Owns the single Socket.IO server instance: creates it, wires the JWT auth
 * middleware and connection handlers, and exposes `getIO()` for the emitter
 * service. Lazy-initialised from the HTTP server in server.js.
 *
 * Scalability: to run multiple backend instances, attach the Redis adapter in
 * `init()` (io.adapter(createAdapter(pub, sub))) - nothing else changes because
 * all emits go through room names.
 */
const { Server } = require("socket.io");
const socketAuthMiddleware = require("./socketMiddleware");
const registerHandlers = require("./socketHandlers");

/** @type {import('socket.io').Server | null} */
let io = null;

const resolveAllowedOrigins = () => {
  const origins = new Set([
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
  ]);
  if (process.env.FRONTEND_URL) origins.add(process.env.FRONTEND_URL);
  if (process.env.ALLOWED_ORIGINS) {
    process.env.ALLOWED_ORIGINS.split(",").forEach((o) => origins.add(o.trim()));
  }
  return Array.from(origins);
};

/**
 * Initialise Socket.IO on an existing HTTP server.
 * @param {import('http').Server} httpServer
 * @returns {import('socket.io').Server}
 */
const init = (httpServer) => {
  if (io) return io;

  io = new Server(httpServer, {
    cors: {
      origin: resolveAllowedOrigins(),
      credentials: true,
      methods: ["GET", "POST"],
    },
    // Resilient transport: WebSocket with polling fallback + auto-reconnect
    // (client side). Ping settings detect dead connections quickly.
    pingInterval: 25000,
    pingTimeout: 20000,
    transports: ["websocket", "polling"],
  });

  // 1) Authenticate every connection (JWT) before any handler runs.
  io.use(socketAuthMiddleware);

  // 2) Wire per-connection lifecycle (rooms, presence, cleanup).
  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.user?.id} (${socket.user?.role})`);
    registerHandlers(io, socket);
  });

  console.log("Socket.IO initialised");
  return io;
};

/** Get the initialised io instance (throws if called before init). */
const getIO = () => {
  if (!io) throw new Error("Socket.IO not initialised - call init() first");
  return io;
};

module.exports = { init, getIO };
