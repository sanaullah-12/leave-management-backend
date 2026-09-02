/**
 * agentAuth.js
 * ------------
 * Authenticates a Local ZKTeco Agent.
 *
 * Agents are machines, not people, so they carry a shared secret rather than a
 * user JWT: the agent runs unattended on an office PC and must survive a
 * password change or a session expiry. The secret only ever authorises device
 * relay work - it grants no access to user, leave or payroll data.
 *
 * The token never reaches the browser. It lives in Railway's environment and in
 * the agent's local .env, and nothing in this file logs it.
 */

const crypto = require("crypto");

/**
 * Constant-time string compare.
 *
 * A plain === leaks the length of the matching prefix through its timing, which
 * is enough to recover a secret one character at a time. Hash both sides first
 * so the compared buffers are always the same length regardless of input.
 */
function secretsMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Minimum length for the shared secret. Short tokens are brute-forceable. */
const MIN_TOKEN_LENGTH = 32;

const authenticateAgent = (req, res, next) => {
  const expected = process.env.AGENT_TOKEN;

  if (!expected) {
    return res.status(503).json({
      success: false,
      code: "AGENT_NOT_CONFIGURED",
      message:
        "AGENT_TOKEN is not set on the server, so Local Agents cannot authenticate.",
    });
  }

  if (expected.length < MIN_TOKEN_LENGTH) {
    console.error(
      `AGENT_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters. Refusing agent authentication.`
    );
    return res.status(503).json({
      success: false,
      code: "AGENT_NOT_CONFIGURED",
      message: "The configured agent token is too short to be used.",
    });
  }

  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token || !secretsMatch(token, expected)) {
    // Log that a rejection happened, never what was presented.
    console.warn(
      `Agent authentication rejected on ${req.method} ${req.path} from ${req.ip}`
    );
    return res.status(401).json({
      success: false,
      code: "AUTH_ERROR",
      message: "Invalid agent credentials.",
    });
  }

  const claimedId = String(req.headers["x-agent-id"] || "").trim();
  if (!claimedId) {
    return res.status(400).json({
      success: false,
      code: "AUTH_ERROR",
      message: "X-Agent-Id header is required.",
    });
  }

  // Pinning the id is optional but recommended: with it set, a leaked token
  // alone cannot register an agent under an unexpected identity.
  const allowedId = process.env.AGENT_ID;
  if (allowedId && allowedId !== claimedId) {
    console.warn(`Agent id mismatch: expected ${allowedId}, got ${claimedId}`);
    return res.status(403).json({
      success: false,
      code: "AUTH_ERROR",
      message: "This agent id is not permitted.",
    });
  }

  req.agentId = claimedId;
  next();
};

module.exports = { authenticateAgent, secretsMatch };
