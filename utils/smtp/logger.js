/**
 * SMTP logging helpers.
 *
 * Single responsibility: consistent, readable log output for the mail layer,
 * with credential masking baked in so a secret can never reach the logs by
 * accident.
 */

/**
 * Mask an email address for logs: "qazimubashir@gmail.com" -> "qa***@gmail.com".
 * Keeps just enough to correlate a log line with a recipient without writing
 * the full address into Railway's (retained, shareable) log stream.
 */
const maskEmail = (email) => {
  if (!email || typeof email !== "string") return "NOT SET";
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***${domain}`;
};

/**
 * Never log the password itself — only whether it is present and how long it
 * is. Length is useful because a Gmail App Password is always 16 characters
 * (ignoring spaces), so a wrong length is an instant tell.
 */
const describeSecret = (secret) => {
  if (!secret) return "MISSING";
  const normalized = String(secret).replace(/\s+/g, "");
  return `SET (${normalized.length} chars, spaces ${
    /\s/.test(String(secret)) ? "present" : "none"
  })`;
};

const log = (message) => console.log(`[smtp] ${message}`);
const warn = (message) => console.warn(`[smtp] ⚠️  ${message}`);
const error = (message) => console.error(`[smtp] ❌ ${message}`);

/**
 * Render a classified failure as a readable block. The goal is that a future
 * failure can be diagnosed from the log alone, without re-deriving what an
 * error code means.
 */
const logFailure = (details) => {
  const {
    code,
    command,
    host,
    port,
    secure,
    title,
    cause,
    solution,
    rawMessage,
  } = details;

  console.error("");
  console.error("[smtp] ❌ ───────── EMAIL DELIVERY FAILED ─────────");
  console.error(`[smtp]    Reason:      ${title}`);
  console.error(`[smtp]    Error code:  ${code || "n/a"}`);
  console.error(`[smtp]    SMTP command:${command ? ` ${command}` : " n/a"}`);
  console.error(
    `[smtp]    Target:      ${host || "n/a"}:${port || "n/a"} (secure=${secure})`
  );
  console.error(`[smtp]    Raw message: ${rawMessage || "n/a"}`);
  console.error(`[smtp]    Likely cause: ${cause}`);
  console.error(`[smtp]    Suggested fix: ${solution}`);
  console.error("[smtp] ────────────────────────────────────────────");
  console.error("");
};

module.exports = {
  maskEmail,
  describeSecret,
  log,
  warn,
  error,
  logFailure,
};
