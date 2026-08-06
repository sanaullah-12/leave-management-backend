/**
 * Layered diagnostics - shared by the CLI harness and the HTTP debug endpoint.
 *
 * Single responsibility: probe each layer of the delivery path independently,
 * so a failure points at one cause instead of "email didn't arrive".
 *
 * Brevo runs over plain HTTPS (443), so the SMTP-era port-blocking checks are
 * gone - 443 is open essentially everywhere, which is precisely why this
 * provider sidesteps the outbound-SMTP problem entirely.
 */

const dns = require("dns").promises;
const net = require("net");

const { loadEmailConfig } = require("./config");

const API_HOST = "api.brevo.com";

/** Plain TCP connect to the API host - proves outbound HTTPS is possible. */
const probeTcp = (host, port, timeoutMs = 10000) =>
  new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, ok, reason, ms: Date.now() - started });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, "connected"));
    socket.once("timeout", () => done(false, "TIMEOUT - no reply (blocked or filtered)"));
    socket.once("error", (err) => done(false, `${err.code || "ERROR"} - ${err.message}`));
    socket.connect(port, host);
  });

/** Run the full sweep. Never throws - failures are returned as data. */
const runDiagnostics = async ({ timeoutMs = 8000, includeAuth = true } = {}) => {
  const out = {
    provider: "Brevo",
    environment: {
      nodeEnv: process.env.NODE_ENV || null,
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
      onRailway: !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME),
      platform: process.platform,
      nodeVersion: process.version,
      frontendUrl: process.env.FRONTEND_URL || null,
    },
    config: null,
    dns: null,
    https: null,
    auth: null,
    verdict: null,
    blocker: null,
  };

  // ---- config -------------------------------------------------------------
  let config;
  try {
    config = loadEmailConfig();
    out.config = {
      ok: true,
      from: `${config.fromName} <${config.fromEmail}>`,
      apiKeyLength: String(config.apiKey).length, // length only - never the value
      apiKeyPrefixValid: String(config.apiKey).startsWith("xkeysib-"),
      replyTo: config.replyTo || null,
    };
  } catch (error) {
    out.config = { ok: false, error: error.message };
    out.blocker = "CONFIG";
    out.verdict = "Configuration is invalid - fix the variable named above.";
    return out;
  }

  // ---- DNS ----------------------------------------------------------------
  try {
    const addrs = await dns.lookup(API_HOST, { all: true });
    out.dns = { ok: true, host: API_HOST, addresses: addrs.map((a) => a.address) };
  } catch (error) {
    out.dns = { ok: false, host: API_HOST, code: error.code, error: error.message };
  }

  // ---- outbound HTTPS -----------------------------------------------------
  const probe = await probeTcp(API_HOST, 443, timeoutMs);
  out.https = { ok: probe.ok, ...probe };

  // ---- API key / auth -----------------------------------------------------
  if (includeAuth && probe.ok) {
    out.auth = await require("./index").checkEmailHealth();
  } else if (includeAuth) {
    out.auth = {
      ok: false,
      skipped: true,
      reason: "Cannot reach api.brevo.com - an API call would just hang.",
    };
  }

  // ---- verdict ------------------------------------------------------------
  if (!probe.ok) {
    out.blocker = "NETWORK_HTTPS_BLOCKED";
    out.verdict =
      "Cannot open an outbound HTTPS connection to api.brevo.com. This is unusual - " +
      "port 443 is open on virtually every host - and points to a severe network egress " +
      "restriction or a DNS failure.";
  } else if (out.auth && out.auth.ok === false && !out.auth.skipped) {
    out.blocker = "AUTH";
    out.verdict = `Network is fine - Brevo rejected the request. ${out.auth.solution || ""}`.trim();
  } else if (out.auth && out.auth.ok) {
    if (out.auth.senderVerified === false) {
      // The key works but the sender isn't verified - sends will be rejected,
      // so this is a genuine blocker even though authentication succeeded.
      out.blocker = "SENDER_NOT_VERIFIED";
      out.verdict =
        `Config, network and API key all pass, but EMAIL_FROM (${config.fromEmail}) is NOT ` +
        `a verified sender in Brevo - every send will be rejected. Add and confirm it at ` +
        `https://app.brevo.com/senders, or verify the domain at ` +
        `https://app.brevo.com/senders/domain.`;
    } else {
      out.blocker = null;
      out.verdict =
        "Config, network, API key and sender all pass. If mail is still not received, " +
        "the issue is deliverability (spam filtering), not sending - check the Brevo " +
        "logs at https://app.brevo.com/statistics/email.";
    }
  } else {
    out.verdict = "Config and network pass. The API key was not tested.";
  }

  return out;
};

module.exports = { probeTcp, runDiagnostics };
