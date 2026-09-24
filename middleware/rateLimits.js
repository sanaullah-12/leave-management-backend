/**
 * Abuse limits for security-sensitive and expensive endpoints.
 *
 * The global limiter in server.js is a coarse ceiling. These are tighter and,
 * where it matters, keyed by something other than the IP address:
 *
 *  - by target account (login, password reset): stops a distributed attack on
 *    one account, and behaves identically whether or not the account exists,
 *    so the limit itself does not reveal which emails are registered;
 *  - by authenticated user (uploads, invitations, submissions): an office
 *    behind one NAT address is not throttled as a single client.
 *
 * Stores are in-memory, which is correct for a single instance. Running more
 * than one instance needs a shared store (e.g. rate-limit-redis) so the limits
 * are not multiplied by the instance count.
 */
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const tooMany = (message) => ({
  message: message || "Too many attempts. Please wait a few minutes and try again.",
  code: "RATE_LIMITED",
});

const ipKey = (req) => ipKeyGenerator(req.ip || "");

const userKey = (req) => (req.user ? `user:${req.user._id}` : `ip:${ipKey(req)}`);

const normalizedEmail = (req) => {
  const email = req.body && req.body.email;
  return typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "";
};

const make = (options) =>
  rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
    message: tooMany(options.message),
  });

/** Failed sign-ins per IP. Successful ones do not count. */
const loginIpLimiter = make({
  windowMs: 15 * MINUTE,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: ipKey,
});

/**
 * Failed sign-ins per target email, from any IP. This is the account lockout:
 * after 5 failures the address is locked for the rest of the window.
 */
const loginAccountLimiter = make({
  windowMs: 15 * MINUTE,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `login:${normalizedEmail(req) || ipKey(req)}`,
  message: "Too many failed sign-in attempts for this account. Please wait 15 minutes or reset your password.",
});

const passwordResetIpLimiter = make({
  windowMs: HOUR,
  limit: 10,
  keyGenerator: ipKey,
});

const passwordResetAccountLimiter = make({
  windowMs: HOUR,
  limit: 3,
  keyGenerator: (req) => `reset:${normalizedEmail(req) || ipKey(req)}`,
});

/** Public token-bearing endpoints (reset/invitation links). */
const tokenLinkLimiter = make({
  windowMs: 15 * MINUTE,
  limit: 30,
  keyGenerator: ipKey,
});

const registerLimiter = make({
  windowMs: HOUR,
  limit: 5,
  keyGenerator: ipKey,
});

/** Every signed-in tab refreshes about every 15 minutes. */
const refreshLimiter = make({
  windowMs: 15 * MINUTE,
  limit: 300,
  keyGenerator: ipKey,
});

const changePasswordLimiter = make({
  windowMs: 15 * MINUTE,
  limit: 10,
  keyGenerator: userKey,
});

const inviteLimiter = make({
  windowMs: HOUR,
  limit: 60,
  keyGenerator: userKey,
});

const uploadLimiter = make({
  windowMs: HOUR,
  limit: 30,
  keyGenerator: userKey,
});

const submissionLimiter = make({
  windowMs: HOUR,
  limit: 20,
  keyGenerator: userKey,
});

/** Actions that send messages or push notifications to many people. */
const broadcastLimiter = make({
  windowMs: HOUR,
  limit: 10,
  keyGenerator: userKey,
});

/** Device operations (door, sync, direct machine reads). */
const deviceLimiter = make({
  windowMs: 15 * MINUTE,
  limit: 60,
  keyGenerator: userKey,
});

module.exports = {
  loginIpLimiter,
  loginAccountLimiter,
  passwordResetIpLimiter,
  passwordResetAccountLimiter,
  tokenLinkLimiter,
  registerLimiter,
  refreshLimiter,
  changePasswordLimiter,
  inviteLimiter,
  uploadLimiter,
  submissionLimiter,
  broadcastLimiter,
  deviceLimiter,
};
