/**
 * SMTP error classification.
 *
 * Single responsibility: turn an opaque Nodemailer/Node socket error into a
 * structured verdict — what happened, why, how to fix it, and crucially
 * whether retrying could ever help.
 *
 * The retryable flag is the important part: retrying a bad password just
 * burns time and can trip the provider's rate limiting, while retrying a
 * transient network blip is exactly the right move.
 */

/**
 * @returns {{
 *   code: string,
 *   command: string|undefined,
 *   title: string,
 *   cause: string,
 *   solution: string,
 *   retryable: boolean,
 *   rawMessage: string
 * }}
 */
const classifySmtpError = (error, config = {}) => {
  const reportedCode = error?.code || error?.errno || "UNKNOWN";
  const command = error?.command;
  const rawMessage = error?.message || String(error);
  const responseCode = error?.responseCode;
  const message = rawMessage.toLowerCase();
  const { host, port, secure } = config;

  // Nodemailer reports most connection-phase failures as the generic ESOCKET
  // / ECONNECTION, keeping the real OS-level reason only in the message
  // ("connect ECONNREFUSED 127.0.0.1:1"). Unwrap it so the specific, more
  // actionable diagnosis below is reached instead of the generic one.
  let code = reportedCode;
  if (code === "ESOCKET" || code === "ECONNECTION" || code === "UNKNOWN") {
    if (message.includes("econnrefused")) code = "ECONNREFUSED";
    else if (message.includes("etimedout")) code = "ETIMEDOUT";
    else if (message.includes("enotfound")) code = "ENOTFOUND";
    else if (message.includes("eai_again")) code = "EAI_AGAIN";
    else if (message.includes("econnreset")) code = "ECONNRESET";
  }

  // Report the code Nodemailer actually surfaced, so it matches the raw logs.
  const base = { code: reportedCode, command, rawMessage };

  // ---- Authentication -----------------------------------------------------
  // Never retried: the credentials will be just as wrong on the next attempt.
  if (code === "EAUTH" || responseCode === 535 || message.includes("invalid login")) {
    return {
      ...base,
      title: "Authentication failed — the mail server rejected the credentials",
      cause:
        "The SMTP server accepted the TCP/TLS connection but refused the username/password pair.",
      solution:
        "Verify SMTP_EMAIL is the full address. For Gmail, SMTP_PASSWORD must be a " +
        "16-character App Password (Google Account → Security → 2-Step Verification → " +
        "App passwords), not the normal account password. Regenerate the App Password " +
        "if 2FA was recently changed.",
      retryable: false,
    };
  }

  // ---- TLS / protocol mismatch -------------------------------------------
  // Distinct from a generic socket error: this is a config bug, so retrying
  // is pointless. "wrong version number" is the classic signature of talking
  // plaintext to an implicit-TLS port (or vice versa).
  if (
    message.includes("wrong version number") ||
    message.includes("ssl routines") ||
    message.includes("packet length too long")
  ) {
    return {
      ...base,
      title: "TLS handshake mismatch — port and encryption mode disagree",
      cause:
        `The client and server disagree about when TLS starts. Port ${port} was used with ` +
        `secure=${secure}. Port 465 requires secure=true (implicit TLS); port 587 requires ` +
        `secure=false with STARTTLS.`,
      solution:
        "Set SMTP_PORT to 587 (STARTTLS) or 465 (implicit TLS). The transport derives the " +
        "correct TLS mode from the port automatically, so only SMTP_PORT needs changing.",
      retryable: false,
    };
  }

  if (
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    message.includes("self signed certificate") ||
    message.includes("certificate")
  ) {
    return {
      ...base,
      title: "TLS certificate validation failed",
      cause:
        `The certificate presented by ${host} could not be validated (self-signed, expired, ` +
        `or issued for a different hostname).`,
      solution:
        "Confirm SMTP_HOST exactly matches the provider's documented hostname (e.g. " +
        "smtp.gmail.com). Do not disable certificate validation in production — that " +
        "silently exposes credentials to interception.",
      retryable: false,
    };
  }

  // ---- DNS ---------------------------------------------------------------
  if (code === "ENOTFOUND") {
    return {
      ...base,
      title: "SMTP hostname could not be resolved",
      cause: `DNS lookup for "${host}" returned no result — the hostname is wrong or does not exist.`,
      solution:
        "Check SMTP_HOST for typos. Gmail is smtp.gmail.com. Note this is the mail host, " +
        "not your app's domain.",
      retryable: false,
    };
  }

  if (code === "EAI_AGAIN") {
    return {
      ...base,
      title: "Temporary DNS failure",
      cause:
        "The DNS resolver timed out or was briefly unavailable. This is usually transient " +
        "infrastructure noise rather than a misconfiguration.",
      solution:
        "Normally self-resolving — the retry logic will attempt again. If it persists across " +
        "all attempts, the host's DNS resolver is degraded.",
      retryable: true,
    };
  }

  // ---- Connectivity -------------------------------------------------------
  // ETIMEDOUT with command CONN is the signature of an outbound port block:
  // the TCP handshake never completed at all.
  if (code === "ETIMEDOUT" || code === "ETIME" || message.includes("timeout")) {
    const duringConnect = command === "CONN" || message.includes("connection timeout");
    return {
      ...base,
      title: duringConnect
        ? "Connection timed out — could not open a TCP socket to the SMTP server"
        : "SMTP operation timed out",
      cause: duringConnect
        ? `No TCP connection to ${host}:${port} could be established before the timeout. ` +
          `This is a network-reachability problem, not an authentication problem — the ` +
          `server was never reached, so credentials were never even offered. Cloud hosts ` +
          `commonly block outbound SMTP ports (25/465/587) to limit spam.`
        : "The connection opened but the server stopped responding mid-conversation.",
      solution: duringConnect
        ? `Confirm the host allows outbound traffic on port ${port}. Try the alternate port ` +
          `(587 <-> 465) — some providers block only one. If every SMTP port times out, the ` +
          `platform blocks outbound SMTP entirely and no SMTP configuration will work there; ` +
          `an HTTPS-based mail API would be required instead.`
        : "Usually transient server-side slowness; the retry logic will attempt again.",
      retryable: true,
    };
  }

  if (code === "ECONNREFUSED") {
    return {
      ...base,
      title: "Connection refused by the SMTP server",
      cause: `${host}:${port} actively rejected the connection — nothing is listening on that port, or a firewall sent a reset.`,
      solution:
        "Verify SMTP_PORT is correct for this provider (587 or 465 for Gmail). A refusal " +
        "differs from a timeout: something replied, it just said no.",
      retryable: true,
    };
  }

  if (code === "ECONNRESET" || code === "EPIPE") {
    return {
      ...base,
      title: "Connection reset by the SMTP server",
      cause:
        "The server closed the connection unexpectedly mid-exchange. Often transient, but " +
        "can also indicate throttling of the sending account.",
      solution:
        "Allow the retry logic to attempt again. If it recurs consistently, check whether the " +
        "sending account has hit a provider rate limit.",
      retryable: true,
    };
  }

  if (code === "ESOCKET" || code === "ECONNECTION") {
    return {
      ...base,
      title: "Socket error while communicating with the SMTP server",
      cause: `A low-level network failure occurred against ${host}:${port}.`,
      solution:
        "Check host/port/TLS settings first, then network egress rules. The retry logic will " +
        "attempt again in case it was transient.",
      retryable: true,
    };
  }

  // ---- Message-level rejections ------------------------------------------
  // The mail system works fine here; this specific message was refused, so a
  // retry would just be refused identically.
  if (code === "EENVELOPE" || responseCode === 550 || responseCode === 553) {
    return {
      ...base,
      title: "Message rejected — invalid sender or recipient address",
      cause:
        "The server accepted the connection and login but refused the envelope, usually " +
        "because a recipient address is malformed or the From address is not permitted.",
      solution:
        "Verify the recipient address is valid and that FROM_EMAIL matches an address the " +
        "authenticated account is allowed to send as.",
      retryable: false,
    };
  }

  if (code === "EMESSAGE") {
    return {
      ...base,
      title: "Message rejected by the SMTP server",
      cause: "The server refused the message content or size.",
      solution: "Check message size limits and content; retrying will not change the outcome.",
      retryable: false,
    };
  }

  // ---- Unknown ------------------------------------------------------------
  // Retry once in case it was transient, but surface it clearly as unclassified
  // so it can be added to this list rather than silently guessed at.
  return {
    ...base,
    title: "Unclassified SMTP error",
    cause:
      "This error code is not yet specifically handled. The raw message above is the best " +
      "signal for diagnosis.",
    solution:
      `Inspect the raw message. Connection details were ${host}:${port} (secure=${secure}). ` +
      "If this recurs, add an explicit case for it in utils/smtp/errors.js.",
    retryable: true,
  };
};

module.exports = { classifySmtpError };
