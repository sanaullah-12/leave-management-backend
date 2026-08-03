/**
 * Email configuration loading + validation.
 *
 * Single responsibility: turn process.env into a validated config object, or
 * fail loudly with an actionable message. This is the ONLY module that reads
 * email environment variables, so "what did we configure?" has one answer.
 *
 * Provider: Resend (HTTPS API). No credential is ever hardcoded.
 */

const { log, warn, describeSecret, maskEmail } = require("./logger");

const REQUIRED_VARS = ["RESEND_API_KEY"];

/**
 * THE SENDER — this is the one value to change when the verified domain is
 * ready. Swap the default below (or set EMAIL_FROM in the environment) to
 * "Nexora <no-reply@nexora.com>" and nothing else in the codebase changes.
 *
 * onboarding@resend.dev is Resend's shared testing sender. It works without
 * domain verification, but ONLY delivers to the email address that owns the
 * Resend account — that restriction is Resend's, not this code's, and it is
 * the usual reason a test send "succeeds" but never arrives for anyone else.
 */
const DEFAULT_FROM = "Nexora <onboarding@resend.dev>";

/** Configuration problems are permanent — never retried. */
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
      `Email is not configured — missing environment variable(s): ${missing.join(", ")}. ` +
        `Add RESEND_API_KEY in Railway → service → Variables (or the local .env). ` +
        `Get a key at https://resend.com/api-keys.`
    );
  }

  const apiKey = process.env.RESEND_API_KEY;

  // Resend keys always start with "re_". Catching this here turns a confusing
  // 401 from the API into an obvious local misconfiguration message.
  if (!apiKey.startsWith("re_")) {
    throw new EmailConfigError(
      `RESEND_API_KEY looks invalid — Resend API keys start with "re_". ` +
        `Check the value in Railway → Variables (a key from a different service ` +
        `will be rejected with a 401).`
    );
  }

  const from = process.env.EMAIL_FROM || DEFAULT_FROM;

  return {
    apiKey,
    from,
    replyTo: process.env.EMAIL_REPLY_TO || undefined,
    // Retained so templates/helpers keep a display name available.
    fromName: process.env.FROM_NAME || "Nexora",
    isTestSender: from.includes("onboarding@resend.dev"),
  };
};

/** Log resolved config. The API key is described, never printed. */
const logEmailConfig = (config) => {
  log("Email configuration:");
  log(`   Provider: Resend (HTTPS API)`);
  log(`   API key:  ${describeSecret(config.apiKey)}`);
  log(`   From:     ${config.from}`);
  if (config.replyTo) log(`   Reply-To: ${maskEmail(config.replyTo)}`);

  if (config.isTestSender) {
    warn(
      "Using Resend's shared test sender (onboarding@resend.dev). It can ONLY " +
        "deliver to the address that owns the Resend account — sending to anyone " +
        "else returns success but never arrives. Verify a domain and set " +
        "EMAIL_FROM to send to real recipients."
    );
  }
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
    warn("FRONTEND_URL is not set — links in emails will be broken.");
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
  DEFAULT_FROM,
};
