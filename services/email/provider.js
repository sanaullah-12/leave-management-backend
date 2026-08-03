/**
 * Resend client lifecycle.
 *
 * Single responsibility: own exactly one Resend client and hand it out for
 * reuse. Replaces the previous SMTP transporter module — this is the only
 * file that knows which provider SDK is in use.
 *
 * Unlike SMTP there is no connection to pool or verify: Resend is a stateless
 * HTTPS API, so "connecting" is just an HTTPS request. That also means none of
 * the SMTP failure modes (port blocking, TLS handshake mismatch, greeting
 * timeouts) can occur — outbound 443 is all that is required.
 */

const { Resend } = require("resend");

const { loadEmailConfig, logEmailConfig } = require("./config");
const { log } = require("./logger");

let cached = null; // { client, config }

/** Get (or lazily create) the shared Resend client. */
const getClient = () => {
  if (cached) return cached;

  const config = loadEmailConfig();
  logEmailConfig(config);

  cached = { client: new Resend(config.apiKey), config };
  return cached;
};

/**
 * Drop the cached client so the next call rebuilds it — used when the API key
 * changes at runtime, or by tests.
 */
const resetClient = () => {
  cached = null;
  log("Resend client reset — the next send will rebuild it.");
};

/** Symmetry with the previous SMTP module so shutdown hooks keep working. */
const closeProvider = () => {
  cached = null;
};

module.exports = { getClient, resetClient, closeProvider };
