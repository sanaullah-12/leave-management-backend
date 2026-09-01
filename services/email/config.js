/**
 * Email configuration loading + validation.
 *
 * Single responsibility: turn process.env into a validated config object, or
 * fail loudly with an actionable message. This is the ONLY module that reads
 * email environment variables, so "what did we configure?" has one answer.
 *
 * Provider: Brevo (HTTPS API). No credential is ever hardcoded.
 */

const { log, warn, describeSecret, maskEmail } = require("./logger");

const REQUIRED_VARS = ["BREVO_API_KEY", "EMAIL_FROM"];

/**
 * THE SENDER - the values to change when moving to a new domain.
 * Brevo requires the sender to be either a verified sender address or an
 * address on a verified domain; anything else is rejected at send time.
 */
const DEFAULT_FROM_NAME = "Nexora";

/** Configuration problems are permanent - never retried. */
class EmailConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmailConfigError";
    this.isConfigError = true;
  }
}

/**
 * Which transport to use. Production is always Brevo - local development uses
 * SMTP, because a Brevo key is a production secret that is not distributed to
 * developer machines.
 *
 * The production checks come first and are not overridable by SMTP_* being
 * present, so adding SMTP credentials to a deployed environment can never
 * silently divert real mail away from Brevo. EMAIL_PROVIDER is the explicit
 * override for anything else.
 *
 * @returns {"smtp"|"brevo"}
 */
const resolveProvider = () => {
  // Production is decided FIRST and cannot be overridden. EMAIL_PROVIDER lives
  // in the local .env, so if that file (or the variable) ever reaches a
  // deployed environment, checking it first would silently divert real customer
  // mail through a developer's personal Gmail account.
  const isProduction =
    process.env.NODE_ENV === "production" ||
    !!process.env.RAILWAY_ENVIRONMENT ||
    !!process.env.RAILWAY_ENVIRONMENT_NAME ||
    !!process.env.RAILWAY_PROJECT_ID;

  if (isProduction) return "brevo";

  const explicit = (process.env.EMAIL_PROVIDER || "").trim().toLowerCase();
  if (explicit === "smtp" || explicit === "brevo") return explicit;

  const hasSmtp =
    !!process.env.SMTP_HOST && !!process.env.SMTP_EMAIL && !!process.env.SMTP_PASSWORD;

  return hasSmtp ? "smtp" : "brevo";
};

/** SMTP (local development) configuration. */
const loadSmtpConfig = () => {
  const required = ["SMTP_HOST", "SMTP_EMAIL", "SMTP_PASSWORD"];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new EmailConfigError(
      `Email is not configured for SMTP - missing environment variable(s): ${missing.join(", ")}. ` +
        `Set them in backend/.env, or set EMAIL_PROVIDER=brevo to use the Brevo API instead.`
    );
  }

  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const fromEmail = process.env.FROM_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_EMAIL;

  // Google shows an App Password as four space-separated groups ("abcd efgh
  // ijkl mnop"), and it is normally pasted in verbatim - 19 characters. Gmail
  // only accepts the 16-character form, so the spaces produce an EAUTH that
  // reads exactly like a wrong password. Strip them rather than make every
  // developer rediscover this.
  const pass = (process.env.SMTP_PASSWORD || "").replace(/\s+/g, "");

  return {
    provider: "smtp",
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587 upgrades via STARTTLS.
    secure: port === 465,
    user: process.env.SMTP_EMAIL,
    pass,
    fromEmail,
    fromName: process.env.FROM_NAME || process.env.EMAIL_FROM_NAME || DEFAULT_FROM_NAME,
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
  };
};

const loadEmailConfig = () => {
  if (resolveProvider() === "smtp") return loadSmtpConfig();

  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new EmailConfigError(
      `Email is not configured - missing environment variable(s): ${missing.join(", ")}. ` +
        `Set BREVO_API_KEY (https://app.brevo.com/settings/keys/api) and EMAIL_FROM ` +
        `in Railway → service → Variables, or in the local .env.`
    );
  }

  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.EMAIL_FROM;

  // Brevo v3 keys start with "xkeysib-". Catching this here turns a confusing
  // 401 from the API into an obvious local misconfiguration message.
  if (!apiKey.startsWith("xkeysib-")) {
    warn(
      `BREVO_API_KEY does not start with "xkeysib-" - Brevo v3 API keys normally do. ` +
        `If sending fails with 401, regenerate the key at ` +
        `https://app.brevo.com/settings/keys/api (an SMTP key will not work here).`
    );
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail)) {
    throw new EmailConfigError(
      `EMAIL_FROM is not a valid email address: "${fromEmail}". ` +
        `It must be a bare address (e.g. no-reply@nexora.com) - the display name ` +
        `goes in EMAIL_FROM_NAME.`
    );
  }

  return {
    provider: "brevo",
    apiKey,
    fromEmail,
    fromName: process.env.EMAIL_FROM_NAME || DEFAULT_FROM_NAME,
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
  };
};

/** Log resolved config. Secrets are described, never printed. */
const logEmailConfig = (config) => {
  log("Email configuration:");

  if (config.provider === "smtp") {
    log(`   Provider: SMTP (local development)`);
    log(`   Host:     ${config.host}:${config.port} ${config.secure ? "(TLS)" : "(STARTTLS)"}`);
    log(`   User:     ${maskEmail(config.user)}`);
    log(`   Password: ${describeSecret(config.pass)}`);
  } else {
    log(`   Provider: Brevo (HTTPS API)`);
    log(`   API key:  ${describeSecret(config.apiKey)}`);
  }

  log(`   From:     ${config.fromName} <${maskEmail(config.fromEmail)}>`);
  if (config.replyTo) log(`   Reply-To: ${maskEmail(config.replyTo)}`);
};

/**
 * Frontend base URL for links inside emails. Getting this wrong produces
 * emails that send fine but contain a localhost link no recipient can open.
 */
const getFrontendUrl = () => {
  const url =
    process.env.NODE_ENV === "production"
      ? process.env.FRONTEND_URL
      : process.env.FRONTEND_URL_DEV || process.env.FRONTEND_URL || "http://localhost:3000";

  if (!url) {
    warn("FRONTEND_URL is not set - links in emails will be broken.");
    return "";
  }
  return url.replace(/\/+$/, "");
};

module.exports = {
  loadEmailConfig,
  logEmailConfig,
  getFrontendUrl,
  resolveProvider,
  EmailConfigError,
  REQUIRED_VARS,
};
