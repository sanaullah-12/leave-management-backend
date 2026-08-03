/**
 * SMTP transport creation + connection verification.
 *
 * Single responsibility: build a correctly-configured Nodemailer transporter
 * from a validated config, and prove the connection works before any message
 * is handed to it.
 */

const nodemailer = require("nodemailer");
const { log } = require("./logger");
const { classifySmtpError } = require("./errors");

/**
 * Timeouts are deliberately generous. Values that are too tight produce
 * spurious ETIMEDOUTs on a cold container whose first outbound connection
 * also pays DNS + TLS setup cost, which then get misdiagnosed as a network
 * block. These are long enough to distinguish "slow" from "unreachable".
 */
const TIMEOUTS = {
  connectionTimeout: 30000, // 30s to establish the TCP connection
  greetingTimeout: 15000, // 15s for the server's opening banner
  socketTimeout: 45000, // 45s of socket inactivity mid-conversation
};

/**
 * Build a transporter. A fresh one per send (pool: false) keeps a failed or
 * half-open connection from poisoning later sends — this path is low volume,
 * so the reuse savings are not worth the failure mode.
 */
const createTransport = (config) => {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      // Keep certificate validation ON. Disabling it would mask the TLS
      // misconfigurations this module exists to surface, and would send
      // credentials over a connection that could be intercepted.
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    },
    ...TIMEOUTS,
    pool: false,
    maxConnections: 1,
    maxMessages: 1,
  });
};

/**
 * Verify connectivity + authentication before sending. This is what makes a
 * failure diagnosable: verify() failing tells us the problem is the
 * connection or the credentials, cleanly separated from a problem with the
 * message itself.
 *
 * Rethrows the original error with a `.smtpDiagnosis` attached so the retry
 * layer can decide whether another attempt is worthwhile.
 */
const verifyConnection = async (transporter, config) => {
  log(`Connecting to ${config.host}:${config.port} (${config.tlsDescription})...`);

  try {
    await transporter.verify();
    log("✅ Connection verified — server reachable and credentials accepted");
    return true;
  } catch (error) {
    error.smtpDiagnosis = classifySmtpError(error, config);
    throw error;
  }
};

module.exports = { createTransport, verifyConnection, TIMEOUTS };
