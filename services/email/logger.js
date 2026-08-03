/**
 * Email logging helpers.
 *
 * Single responsibility: consistent, readable output for the mail layer, with
 * credential masking built in so a secret can never reach the logs by accident.
 */

/** "employee@gmail.com" -> "em***@gmail.com" */
const maskEmail = (email) => {
  if (!email || typeof email !== "string") return "NOT SET";
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
};

/**
 * Describe a secret without revealing it. Length matters here: a Gmail App
 * Password is always 16 characters once spaces are stripped, so a different
 * length is an immediate tell that an account password was pasted instead.
 */
const describeSecret = (secret) => {
  if (!secret) return "MISSING";
  const normalized = String(secret).replace(/\s+/g, "");
  return `SET (${normalized.length} chars)`;
};

const log = (msg) => console.log(`[email] ${msg}`);
const warn = (msg) => console.warn(`[email] ⚠️  ${msg}`);
const error = (msg) => console.error(`[email] ❌ ${msg}`);

/** Render a classified failure as a readable, self-explaining block. */
const logFailure = ({ code, command, host, port, secure, title, cause, solution, rawMessage }) => {
  console.error("");
  console.error("[email] ❌ ──────── EMAIL DELIVERY FAILED ────────");
  console.error(`[email]   Reason:     ${title}`);
  console.error(`[email]   Error code: ${code || "n/a"}`);
  console.error(`[email]   Command:    ${command || "n/a"}`);
  console.error(`[email]   Target:     ${host}:${port} (secure=${secure})`);
  console.error(`[email]   Raw:        ${rawMessage || "n/a"}`);
  console.error(`[email]   Cause:      ${cause}`);
  console.error(`[email]   Fix:        ${solution}`);
  console.error("[email] ───────────────────────────────────────────");
  console.error("");
};

module.exports = { maskEmail, describeSecret, log, warn, error, logFailure };
