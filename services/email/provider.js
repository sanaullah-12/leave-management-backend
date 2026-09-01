/**
 * Email transport lifecycle.
 *
 * Single responsibility: own exactly one transport and hand it out for reuse.
 * This is the only file that knows which provider SDK is in use - swapping
 * providers means rewriting this file and errors.js, nothing else.
 *
 * Two transports are supported, chosen by config.resolveProvider():
 *
 *   brevo - HTTPS API, used in production. There is no connection to pool or
 *           verify: "connecting" is just an HTTPS request, so none of the SMTP
 *           failure modes (port blocking, TLS mismatch, greeting timeouts) can
 *           occur - outbound 443 is all that is required.
 *
 *   smtp  - nodemailer, used for local development, where a Brevo production
 *           key is deliberately not available. Unlike Brevo this does hold a
 *           pooled connection, so closeProvider() actually has work to do.
 */

const { BrevoClient } = require("@getbrevo/brevo");
const nodemailer = require("nodemailer");

const { loadEmailConfig, logEmailConfig } = require("./config");
const { log } = require("./logger");

let cached = null; // { kind, client | transporter, config }

/** Get (or lazily create) the shared transport. */
const getClient = () => {
  if (cached) return cached;

  const config = loadEmailConfig();
  logEmailConfig(config);

  if (config.provider === "smtp") {
    cached = {
      kind: "smtp",
      transporter: nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.pass },
      }),
      config,
    };
    return cached;
  }

  cached = {
    kind: "brevo",
    client: new BrevoClient({ apiKey: config.apiKey }),
    config,
  };
  return cached;
};

/**
 * Verify the transport can actually be used. For SMTP this opens a real
 * connection and authenticates, which is the only way to catch a bad app
 * password before a user-facing send fails. Brevo has nothing to verify.
 * @returns {Promise<void>} rejects with the transport's own error
 */
const verifyProvider = async () => {
  const entry = getClient();
  if (entry.kind !== "smtp") return;
  await entry.transporter.verify();
};

/**
 * Drop the cached transport so the next call rebuilds it - used when
 * credentials change at runtime, or by tests.
 */
const resetClient = () => {
  if (cached?.kind === "smtp") {
    try {
      cached.transporter.close();
    } catch (_) {
      /* best-effort */
    }
  }
  cached = null;
  log("Email transport reset - the next send will rebuild it.");
};

/** Release pooled SMTP sockets so shutdown hooks keep working. */
const closeProvider = () => {
  if (cached?.kind === "smtp") {
    try {
      cached.transporter.close();
    } catch (_) {
      /* best-effort */
    }
  }
  cached = null;
};

module.exports = { getClient, verifyProvider, resetClient, closeProvider };
