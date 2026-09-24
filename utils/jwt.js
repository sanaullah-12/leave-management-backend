const jwt = require("jsonwebtoken");

/**
 * Access tokens.
 *
 * Short-lived and bound to a server-side session (`sid`). The signature alone
 * never authorises a request: middleware/auth.js also requires the session to
 * exist and be unrevoked, so logout, password change and deactivation take
 * effect immediately instead of when the token happens to expire.
 *
 * Only identifiers travel in the token. Role and company are always read from
 * the database on each request, so a token can never carry a stale or forged
 * privilege.
 */

const ALGORITHM = "HS256";
const ISSUER = "nexora-api";
const AUDIENCE = "nexora-app";

const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || "15m";

const generateAccessToken = ({ userId, sessionId }) =>
  jwt.sign({ sid: String(sessionId) }, process.env.JWT_SECRET, {
    algorithm: ALGORITHM,
    subject: String(userId),
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ACCESS_TOKEN_TTL,
  });

/**
 * Verify signature, algorithm, issuer, audience and expiry. The algorithm is
 * pinned so a token signed with anything else (including "none") is rejected.
 */
const verifyAccessToken = (token) => {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: [ALGORITHM],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (!decoded || typeof decoded.sub !== "string" || typeof decoded.sid !== "string") {
    throw new jwt.JsonWebTokenError("token is missing required claims");
  }
  return decoded;
};

/** Seconds until the access token issued now expires; sent to the client. */
const accessTokenTtlSeconds = () => {
  const decoded = jwt.decode(
    jwt.sign({}, "ttl-probe", { expiresIn: ACCESS_TOKEN_TTL })
  );
  return decoded.exp - decoded.iat;
};

module.exports = {
  generateAccessToken,
  verifyAccessToken,
  accessTokenTtlSeconds,
};
