/**
 * Session lifecycle: sign-in, refresh-token rotation, revocation.
 *
 * Refresh tokens have the form "<sessionId>.<256 random bits>". Only their
 * SHA-256 hash is stored. Every refresh replaces the token; presenting an
 * already-replaced token outside a short grace window is treated as theft and
 * revokes the whole session, which also cuts off whoever holds the newer one.
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const Session = require("../models/Session");
const { generateAccessToken, accessTokenTtlSeconds } = require("../utils/jwt");

const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_TTL_MS = (Number(process.env.SESSION_IDLE_DAYS) || 7) * DAY_MS;
const ABSOLUTE_TTL_MS = (Number(process.env.SESSION_MAX_DAYS) || 30) * DAY_MS;
// Two tabs refreshing at the same instant both present the same token; the
// loser must be told to retry, not be treated as an attacker.
const ROTATION_GRACE_MS = 60 * 1000;

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const newSecret = () => crypto.randomBytes(32).toString("base64url");

const safeEqualHex = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
};

class SessionError extends Error {
  constructor(code, status = 401) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const clientInfo = (req) => ({
  userAgent: req ? String(req.headers["user-agent"] || "").slice(0, 200) : undefined,
  ip: req ? String(req.ip || "").slice(0, 64) : undefined,
});

const issueTokens = (userId, sessionId, secret) => ({
  token: generateAccessToken({ userId, sessionId }),
  refreshToken: `${sessionId}.${secret}`,
  expiresIn: accessTokenTtlSeconds(),
});

/** Start a new session for a user who has just proven who they are. */
const createSession = async (user, req) => {
  const now = Date.now();
  const secret = newSecret();
  const session = await Session.create({
    user: user._id,
    company: user.company && (user.company._id || user.company),
    refreshTokenHash: sha256(secret),
    expiresAt: new Date(now + IDLE_TTL_MS),
    absoluteExpiresAt: new Date(now + ABSOLUTE_TTL_MS),
    ...clientInfo(req),
  });
  return { session, ...issueTokens(user._id, session._id, secret) };
};

const parseRefreshToken = (refreshToken) => {
  if (typeof refreshToken !== "string" || refreshToken.length > 200) return null;
  const dot = refreshToken.indexOf(".");
  if (dot <= 0) return null;
  const sessionId = refreshToken.slice(0, dot);
  const secret = refreshToken.slice(dot + 1);
  if (!mongoose.isValidObjectId(sessionId) || secret.length < 32) return null;
  return { sessionId, secret };
};

/**
 * Exchange a refresh token for a new access + refresh token pair.
 * Throws SessionError on any failure; the caller maps it to a response.
 */
const rotateSession = async (refreshToken, req) => {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) throw new SessionError("REFRESH_INVALID");

  const presentedHash = sha256(parsed.secret);
  const now = new Date();

  const session = await Session.findById(parsed.sessionId).select(
    "+refreshTokenHash +previousRefreshTokenHash"
  );
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= now ||
    session.absoluteExpiresAt <= now
  ) {
    throw new SessionError("REFRESH_INVALID");
  }

  if (!safeEqualHex(presentedHash, session.refreshTokenHash)) {
    const isPrevious = safeEqualHex(presentedHash, session.previousRefreshTokenHash);
    if (
      isPrevious &&
      session.rotatedAt &&
      now - session.rotatedAt < ROTATION_GRACE_MS
    ) {
      throw new SessionError("REFRESH_RACE", 409);
    }
    // A replaced token came back after the grace window: it was copied.
    await revokeSession(session._id, isPrevious ? "refresh_token_reuse" : "refresh_token_mismatch");
    const err = new SessionError("REFRESH_REUSED");
    err.userId = session.user;
    err.companyId = session.company;
    throw err;
  }

  const secret = newSecret();
  const newExpiry = new Date(
    Math.min(now.getTime() + IDLE_TTL_MS, session.absoluteExpiresAt.getTime())
  );

  // Conditional on the hash we checked, so two concurrent refreshes cannot
  // both succeed with the same token.
  const updated = await Session.findOneAndUpdate(
    { _id: session._id, refreshTokenHash: presentedHash, revokedAt: null },
    {
      $set: {
        refreshTokenHash: sha256(secret),
        previousRefreshTokenHash: presentedHash,
        rotatedAt: now,
        lastUsedAt: now,
        expiresAt: newExpiry,
        ...clientInfo(req),
      },
    },
    { new: true }
  );
  if (!updated) throw new SessionError("REFRESH_RACE", 409);

  return { session: updated, ...issueTokens(session.user, session._id, secret) };
};

/** The live session behind an access token, or null. */
const findActiveSession = (sessionId, userId) => {
  if (!mongoose.isValidObjectId(sessionId)) return Promise.resolve(null);
  const now = new Date();
  return Session.findOne({
    _id: sessionId,
    user: userId,
    revokedAt: null,
    expiresAt: { $gt: now },
    absoluteExpiresAt: { $gt: now },
  })
    .select("_id user company")
    .lean();
};

/** Drop live sockets so a revoked session stops receiving real-time events. */
const disconnectSockets = (room) => {
  try {
    const { getIO } = require("../socket/socketServer");
    getIO().in(room).disconnectSockets(true);
  } catch (_) {
    // Socket layer not initialised (scripts, tests): nothing to disconnect.
  }
};

const revokeSession = async (sessionId, reason = "logout") => {
  await Session.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  disconnectSockets(`session:${sessionId}`);
};

/**
 * Revoke every session a user has, optionally keeping the one making the
 * request (e.g. after a password change on this device).
 */
const revokeAllForUser = async (userId, reason, exceptSessionId) => {
  const filter = { user: userId, revokedAt: null };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  const sessions = await Session.find(filter).select("_id").lean();
  if (!sessions.length) return 0;
  await Session.updateMany(
    { _id: { $in: sessions.map((s) => s._id) } },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  sessions.forEach((s) => disconnectSockets(`session:${s._id}`));
  return sessions.length;
};

module.exports = {
  SessionError,
  createSession,
  rotateSession,
  findActiveSession,
  revokeSession,
  revokeAllForUser,
};
