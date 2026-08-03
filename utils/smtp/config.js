/**
 * SMTP configuration loading + validation.
 *
 * Single responsibility: turn process.env into a validated, fully-resolved
 * config object — or fail loudly with an actionable message. Nothing else in
 * the mail layer reads process.env directly, so there is exactly one place
 * where "what did we configure?" is answered.
 */

const { log, warn, describeSecret, maskEmail } = require("./logger");

const REQUIRED_VARS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_EMAIL",
  "SMTP_PASSWORD",
];

/** Thrown for configuration problems. Never retried — retrying can't fix it. */
class SmtpConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmtpConfigError";
    this.isConfigError = true;
  }
}

/**
 * Resolve the TLS mode from the port. Getting this pair wrong is the single
 * most common SMTP misconfiguration, and it fails in a confusing way (a hung
 * handshake rather than a clean error), so it is derived here rather than
 * left to a hardcoded flag:
 *
 *   465 -> implicit TLS      : the socket is TLS from the very first byte.
 *   587 -> STARTTLS          : starts plaintext, then MUST upgrade to TLS.
 *    25 -> STARTTLS (legacy) : widely blocked by cloud hosts.
 */
const resolveTlsMode = (port) => {
  if (port === 465) {
    return {
      secure: true,
      requireTLS: false,
      description: "implicit TLS (secure=true)",
    };
  }
  if (port === 587 || port === 25) {
    return {
      secure: false,
      requireTLS: true,
      description: "STARTTLS (secure=false, requireTLS=true)",
    };
  }
  return {
    secure: false,
    requireTLS: true,
    description: `non-standard port — defaulting to STARTTLS (secure=false, requireTLS=true)`,
    nonStandard: true,
  };
};

/**
 * Validate and build the SMTP config. Throws SmtpConfigError naming the exact
 * missing/invalid variable rather than failing silently downstream.
 */
const loadSmtpConfig = () => {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    const message =
      `SMTP is not configured — missing required environment variable(s): ${missing.join(
        ", "
      )}. ` +
      `Set them in your deployment platform's variables (Railway → service → Variables) ` +
      `or in the local .env file. Email cannot be sent until every one of ` +
      `${REQUIRED_VARS.join(", ")} is present.`;
    throw new SmtpConfigError(message);
  }

  const rawPort = process.env.SMTP_PORT;
  const port = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SmtpConfigError(
      `SMTP_PORT is invalid: "${rawPort}". It must be a whole number between 1 and 65535 ` +
        `(use 587 for STARTTLS or 465 for implicit TLS).`
    );
  }

  const tls = resolveTlsMode(port);

  const config = {
    host: process.env.SMTP_HOST,
    port,
    secure: tls.secure,
    requireTLS: tls.requireTLS,
    tlsDescription: tls.description,
    nonStandardPort: !!tls.nonStandard,
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
    fromEmail: process.env.FROM_EMAIL || process.env.SMTP_EMAIL,
    fromName: process.env.FROM_NAME || "Nexora",
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
  };

  return config;
};

/**
 * Log the resolved configuration. Credentials are described, never printed.
 */
const logSmtpConfig = (config) => {
  log(`Configuration resolved:`);
  log(`   Host:       ${config.host}`);
  log(`   Port:       ${config.port}`);
  log(`   TLS mode:   ${config.tlsDescription}`);
  log(`   Username:   ${maskEmail(config.user)}`);
  log(`   Password:   ${describeSecret(config.pass)}`);
  log(`   From:       ${config.fromName} <${maskEmail(config.fromEmail)}>`);

  if (config.nonStandardPort) {
    warn(
      `Port ${config.port} is not a standard SMTP port (expected 587 or 465). ` +
        `Assuming STARTTLS — if this host expects implicit TLS, use port 465 instead.`
    );
  }

  // Gmail App Passwords are exactly 16 characters. A 6+ char "normal" password
  // here almost always means the account password was pasted instead, which
  // fails with EAUTH once the connection actually succeeds.
  const normalizedPass = String(config.pass).replace(/\s+/g, "");
  if (/gmail\.com$/i.test(config.host) && normalizedPass.length !== 16) {
    warn(
      `SMTP_HOST is Gmail but SMTP_PASSWORD is ${normalizedPass.length} characters. ` +
        `Gmail App Passwords are exactly 16 characters — a regular account password ` +
        `will be rejected with EAUTH.`
    );
  }
};

module.exports = {
  loadSmtpConfig,
  logSmtpConfig,
  resolveTlsMode,
  SmtpConfigError,
  REQUIRED_VARS,
};
