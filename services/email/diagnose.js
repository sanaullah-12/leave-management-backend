/**
 * Layered diagnostics — shared by the CLI harness and the HTTP debug endpoint.
 *
 * Single responsibility: probe each layer of the delivery path independently,
 * so a failure points at one cause instead of "email didn't arrive".
 *
 * Resend runs over plain HTTPS (443), so the SMTP-era port-blocking checks are
 * gone — 443 is open essentially everywhere, which is precisely why this
 * provider sidesteps the outbound-SMTP problem entirely.
 */

const dns = require("dns").promises;
const net = require("net");

const { loadEmailConfig } = require("./config");

const API_HOST = "api.resend.com";

/** Plain TCP connect to the API host — proves outbound HTTPS is possible. */
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
    socket.once("timeout", () => done(false, "TIMEOUT — no reply (blocked or filtered)"));
    socket.once("error", (err) => done(false, `${err.code || "ERROR"} — ${err.message}`));
    socket.connect(port, host);
  });

/** Run the full sweep. Never throws — failures are returned as data. */
const runDiagnostics = async ({ timeoutMs = 8000, includeAuth = true } = {}) => {
  const out = {
    provider: "Resend",
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
      from: config.from,
      usingTestSender: config.isTestSender,
      apiKeyLength: String(config.apiKey).length, // length only — never the value
      apiKeyPrefixValid: String(config.apiKey).startsWith("re_"),
      replyTo: config.replyTo || null,
    };
  } catch (error) {
    out.config = { ok: false, error: error.message };
    out.blocker = "CONFIG";
    out.verdict = "Configuration is invalid — fix the variable named above.";
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
      reason: "Cannot reach api.resend.com — an API call would just hang.",
    };
  }

  // ---- verdict ------------------------------------------------------------
  if (!probe.ok) {
    out.blocker = "NETWORK_HTTPS_BLOCKED";
    out.verdict =
      "Cannot open an outbound HTTPS connection to api.resend.com. This is unusual — " +
      "port 443 is open on virtually every host — and points to a severe network egress " +
      "restriction or a DNS failure.";
  } else if (out.auth && out.auth.ok === false && !out.auth.skipped) {
    out.blocker = "AUTH";
    out.verdict = `Network is fine — Resend rejected the request. ${out.auth.solution || ""}`.trim();
  } else if (out.auth && out.auth.ok) {
    if (config.isTestSender) {
      out.blocker = null;
      out.verdict =
        "Config, network and API key all pass. IMPORTANT: you are using Resend's shared " +
        "test sender (onboarding@resend.dev), which can ONLY deliver to the email address " +
        "that owns the Resend account. Sends to anyone else return success but never " +
        "arrive. Verify a domain and set EMAIL_FROM to send to real recipients.";
    } else {
      out.blocker = null;
      out.verdict =
        "Config, network, API key and sender domain all pass. If mail is still not " +
        "received, the issue is deliverability (spam filtering), not sending.";
    }
  } else {
    out.verdict = "Config and network pass. The API key was not tested.";
  }

  return out;
};

module.exports = { probeTcp, runDiagnostics };
