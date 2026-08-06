/**
 * config.js
 * ---------
 * Single source of truth for every notification-layer setting. Everything is
 * env-driven so the same build runs in dev, staging and production without a
 * code change, and so nothing (least of all a phone number) is ever hardcoded.
 *
 * Reading env here rather than at call sites means a missing variable produces
 * one clear warning at boot instead of an undefined deep inside a provider.
 */

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};

const int = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value, fallback = []) => {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const config = {
  // -- Channels ------------------------------------------------------------
  channels: {
    // The in-app channel is not switchable: it is the product's core
    // notification surface and must never be disabled by configuration.
    socket: { enabled: true },
    whatsapp: {
      enabled: bool(process.env.WHATSAPP_ENABLED, false),
    },
  },

  // -- WhatsApp ------------------------------------------------------------
  whatsapp: {
    // Which driver in notifications/providers/ handles the actual HTTP call.
    // "log" writes the rendered message to stdout and is the safe default so
    // a misconfigured environment can never message real people.
    provider: (process.env.WHATSAPP_PROVIDER || "log").trim().toLowerCase(),

    // Meta WhatsApp Cloud API
    meta: {
      apiVersion: process.env.WHATSAPP_CLOUD_API_VERSION || "v21.0",
      phoneNumberId: process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID || "",
      accessToken: process.env.WHATSAPP_CLOUD_ACCESS_TOKEN || "",
      // Meta only accepts free-form text inside the 24-hour customer service
      // window. Outside it, only pre-approved message templates are delivered.
      // See docs/WHATSAPP_NOTIFICATION_ARCHITECTURE.md - "24-hour window".
      useApprovedTemplates: bool(process.env.WHATSAPP_USE_APPROVED_TEMPLATES, false),
      templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
    },

    // Twilio WhatsApp
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || "",
      authToken: process.env.TWILIO_AUTH_TOKEN || "",
      // Twilio expects the sender in "whatsapp:+1..." form; the provider adds
      // the prefix so operators can paste a plain E.164 number here.
      from: process.env.TWILIO_WHATSAPP_FROM || "",
    },

    // Per-request HTTP timeout. A hung provider must not pin a queue worker.
    timeoutMs: int(process.env.WHATSAPP_TIMEOUT_MS, 10000),

    // Recipients whose number is missing or unparseable are skipped, not
    // retried - retrying cannot conjure a phone number.
    defaultCountryCode: process.env.PHONE_DEFAULT_COUNTRY_CODE || "",

    // Safety valve for non-production environments: when set, every WhatsApp
    // message is redirected to this number instead of the real recipient.
    redirectAllTo: process.env.WHATSAPP_REDIRECT_ALL_TO || "",
  },

  // -- Queue ---------------------------------------------------------------
  queue: {
    concurrency: int(process.env.NOTIFICATION_QUEUE_CONCURRENCY, 4),
    maxAttempts: int(process.env.NOTIFICATION_QUEUE_MAX_ATTEMPTS, 3),
    // Exponential backoff: baseDelay * 2^(attempt - 1), capped at maxDelay,
    // plus jitter so a provider outage does not produce a retry thundering herd.
    baseDelayMs: int(process.env.NOTIFICATION_QUEUE_BASE_DELAY_MS, 2000),
    maxDelayMs: int(process.env.NOTIFICATION_QUEUE_MAX_DELAY_MS, 60000),
    // Bound the in-memory buffer. Past this the oldest pending job is dropped
    // rather than letting an outage exhaust the process heap.
    maxSize: int(process.env.NOTIFICATION_QUEUE_MAX_SIZE, 5000),
    // How many finished jobs to retain for the /health endpoint.
    historySize: int(process.env.NOTIFICATION_QUEUE_HISTORY_SIZE, 100),
  },

  // -- Recipients ----------------------------------------------------------
  recipients: {
    // Roles treated as "notify the back office". The system ships with a
    // single `admin` role; adding `hr` to this list is all that is needed the
    // day an HR role exists. Never hardcode individuals.
    adminRoles: list(process.env.NOTIFICATION_ADMIN_ROLES, ["admin"]),
    // Only users in these states are messaged. Pending invitees have not
    // accepted yet and inactive users have left.
    activeStatuses: list(process.env.NOTIFICATION_ACTIVE_STATUSES, ["active"]),
  },

  // -- Logging -------------------------------------------------------------
  logging: {
    level: (process.env.NOTIFICATION_LOG_LEVEL || "info").trim().toLowerCase(),
    // Phone numbers are personal data: log them masked unless an operator
    // explicitly opts in while debugging.
    logFullPhoneNumbers: bool(process.env.NOTIFICATION_LOG_FULL_PHONES, false),
  },

  // -- Product -------------------------------------------------------------
  branding: {
    productName: process.env.NOTIFICATION_PRODUCT_NAME || "Nexora HRMS",
    appUrl: process.env.FRONTEND_URL || "",
  },
};

/**
 * Reports configuration problems that would silently disable delivery.
 * Called once at boot so operators see them in the startup log rather than
 * discovering them from an absent message weeks later.
 */
config.validate = () => {
  const problems = [];

  if (!config.channels.whatsapp.enabled) {
    return problems; // Nothing to validate for a disabled channel.
  }

  const { provider, meta, twilio } = config.whatsapp;

  if (provider === "meta") {
    if (!meta.phoneNumberId) problems.push("WHATSAPP_CLOUD_PHONE_NUMBER_ID is not set");
    if (!meta.accessToken) problems.push("WHATSAPP_CLOUD_ACCESS_TOKEN is not set");
  } else if (provider === "twilio") {
    if (!twilio.accountSid) problems.push("TWILIO_ACCOUNT_SID is not set");
    if (!twilio.authToken) problems.push("TWILIO_AUTH_TOKEN is not set");
    if (!twilio.from) problems.push("TWILIO_WHATSAPP_FROM is not set");
  } else if (provider !== "log") {
    problems.push(`Unknown WHATSAPP_PROVIDER "${provider}" (expected: meta, twilio, log)`);
  }

  if (provider === "log" && process.env.NODE_ENV === "production") {
    problems.push(
      'WHATSAPP_PROVIDER is "log" in production - messages are written to stdout, not delivered'
    );
  }

  return problems;
};

module.exports = config;
