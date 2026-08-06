/**
 * Brevo client lifecycle.
 *
 * Single responsibility: own exactly one Brevo client and hand it out for
 * reuse. This is the only file that knows which provider SDK is in use -
 * swapping providers means rewriting this file and errors.js, nothing else.
 *
 * Like any HTTPS API there is no connection to pool or verify: "connecting"
 * is just an HTTPS request. None of the SMTP failure modes (port blocking,
 * TLS handshake mismatch, greeting timeouts) can occur - outbound 443 is all
 * that is required.
 */

const { BrevoClient } = require("@getbrevo/brevo");

const { loadEmailConfig, logEmailConfig } = require("./config");
const { log } = require("./logger");

let cached = null; // { client, config }

/** Get (or lazily create) the shared Brevo client. */
const getClient = () => {
  if (cached) return cached;

  const config = loadEmailConfig();
  logEmailConfig(config);

  cached = { client: new BrevoClient({ apiKey: config.apiKey }), config };
  return cached;
};

/**
 * Drop the cached client so the next call rebuilds it - used when the API key
 * changes at runtime, or by tests.
 */
const resetClient = () => {
  cached = null;
  log("Brevo client reset - the next send will rebuild it.");
};

/** Symmetry with previous providers so shutdown hooks keep working. */
const closeProvider = () => {
  cached = null;
};

module.exports = { getClient, resetClient, closeProvider };
