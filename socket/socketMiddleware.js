/**
 * socketMiddleware.js
 * -------------------
 * JWT authentication for Socket.IO. Runs once per connection (io.use). An
 * unauthenticated or inactive user is rejected before any event handler runs,
 * so the rest of the socket layer can trust `socket.user`.
 *
 * The token is read from the handshake `auth.token` (preferred) or the
 * Authorization header - matching how the REST API authenticates.
 */
const { verifyToken } = require("../utils/jwt");
const User = require("../models/User");

const extractToken = (socket) => {
  const authToken = socket.handshake?.auth?.token;
  if (authToken) return authToken;
  const header = socket.handshake?.headers?.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
};

/**
 * @param {import('socket.io').Socket} socket
 * @param {(err?: Error) => void} next
 */
const socketAuthMiddleware = async (socket, next) => {
  try {
    const token = extractToken(socket);
    if (!token) return next(new Error("UNAUTHORIZED: missing token"));

    const decoded = verifyToken(token);
    const user = await User.findById(decoded.id).select(
      "_id name role company isActive status"
    );

    if (!user || !user.isActive || user.status !== "active") {
      return next(new Error("UNAUTHORIZED: invalid or inactive user"));
    }

    const companyId = (user.company && (user.company._id || user.company)) || null;
    if (!companyId) return next(new Error("UNAUTHORIZED: no company"));

    // Trusted identity attached to the socket for the rest of its lifecycle.
    socket.user = {
      id: user._id.toString(),
      name: user.name,
      role: user.role, // 'admin' | 'employee'
      company: companyId.toString(),
    };

    return next();
  } catch (err) {
    return next(new Error("UNAUTHORIZED: token verification failed"));
  }
};

module.exports = socketAuthMiddleware;
