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

const loadEmailConfig = () => {
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
    apiKey,
    fromEmail,
    fromName: process.env.EMAIL_FROM_NAME || DEFAULT_FROM_NAME,
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
  };
};

/** Log resolved config. The API key is described, never printed. */
const logEmailConfig = (config) => {
  log("Email configuration:");
  log(`   Provider: Brevo (HTTPS API)`);
  log(`   API key:  ${describeSecret(config.apiKey)}`);
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
  EmailConfigError,
  REQUIRED_VARS,
};
