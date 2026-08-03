/**
 * Resend error classification.
 *
 * Single responsibility: turn a Resend API error into a verdict — what
 * happened, why, how to fix it, and whether retrying could ever help.
 *
 * The retryable flag matters: retrying a bad API key or an unverified domain
 * just burns attempts and delays the real error reaching the logs, while
 * retrying a 429/5xx is exactly right.
 *
 * Resend surfaces failures two ways:
 *   1. A resolved response with an `error` object: { name, message } plus a
 *      statusCode. This is the normal path — the SDK does not throw.
 *   2. A thrown exception for transport-level problems (DNS, socket, abort).
 */

const classifyEmailError = (error, config = {}) => {
  // Resend's error object, a thrown Error, or something in between.
  const name = error?.name || error?.error?.name || "";
  const rawMessage = error?.message || error?.error?.message || String(error);
  const status =
    error?.statusCode ?? error?.status ?? error?.response?.status ?? undefined;
  const nodeCode = error?.code;
  const message = String(rawMessage).toLowerCase();

  const base = {
    code: name || nodeCode || (status ? `HTTP_${status}` : "UNKNOWN"),
    command: undefined,
    rawMessage,
    statusCode: status,
  };

  // ---- Network / transport (thrown, not returned) -------------------------
  // Resend only needs outbound HTTPS (443), so these are genuine connectivity
  // faults rather than the port-blocking that affects SMTP.
  if (nodeCode === "ENOTFOUND" || nodeCode === "EAI_AGAIN") {
    return {
      ...base,
      title: "Could not resolve the Resend API host",
      cause: "DNS lookup for api.resend.com failed — no DNS, or no outbound network.",
      solution:
        "Confirm the host has working DNS and outbound HTTPS access. Transient DNS " +
        "failures usually clear on retry.",
      retryable: true,
    };
  }

  if (
    nodeCode === "ETIMEDOUT" ||
    nodeCode === "ECONNRESET" ||
    nodeCode === "ECONNREFUSED" ||
    nodeCode === "EPIPE" ||
    message.includes("fetch failed") ||
    message.includes("network")
  ) {
    return {
      ...base,
      title: "Network error reaching the Resend API",
      cause: `A connection-level failure occurred calling api.resend.com (${nodeCode || "network"}).`,
      solution:
        "Confirm the host allows outbound HTTPS on port 443. Usually transient — the " +
        "retry logic will attempt again.",
      retryable: true,
    };
  }

  if (name === "AbortError" || message.includes("aborted") || message.includes("timeout")) {
    return {
      ...base,
      title: "Request to the Resend API timed out",
      cause: "The API did not respond before the request was aborted.",
      solution: "Usually transient; the retry logic will attempt again.",
      retryable: true,
    };
  }

  // ---- Authentication / authorisation — never retried ---------------------
  if (
    status === 401 ||
    name === "missing_api_key" ||
    name === "restricted_api_key" ||
    message.includes("api key is invalid") ||
    message.includes("unauthorized")
  ) {
    return {
      ...base,
      title: "Resend rejected the API key",
      cause:
        "RESEND_API_KEY is missing, malformed, revoked, or lacks permission for this action.",
      solution:
        "Regenerate a key at https://resend.com/api-keys with 'Sending access' and set " +
        "RESEND_API_KEY in Railway → Variables. Keys start with 're_'.",
      retryable: false,
    };
  }

  // ---- Test-sender restriction — THE most common real-world failure -------
  // With onboarding@resend.dev, Resend permits delivery only to the account
  // owner's own address. Inviting anyone else fails here. Checked first
  // because the generic 403 handler would bury the actual explanation.
  if (
    message.includes("only send testing emails") ||
    message.includes("your own email address")
  ) {
    return {
      ...base,
      title: "Test sender can only email the Resend account owner",
      cause:
        "EMAIL_FROM is Resend's shared test sender (onboarding@resend.dev), which is " +
        "restricted to delivering to the email address that owns the Resend account. " +
        "Sending to any other recipient is rejected.",
      solution:
        "Verify a domain at https://resend.com/domains, then set EMAIL_FROM to an address " +
        'on it (e.g. "Nexora <no-reply@nexora.com>"). That single change enables sending ' +
        "to real recipients — no other code needs to change.",
      retryable: false,
    };
  }

  // ---- Domain / sender verification — the most common real-world blocker --
  // Checked BEFORE the generic 403 below: Resend returns 403 for an unverified
  // domain, and "verify your domain" is far more actionable than "forbidden".
  if (
    name === "validation_error" ||
    status === 422 ||
    message.includes("domain is not verified") ||
    message.includes("not verified")
  ) {
    return {
      ...base,
      title: "Sender address rejected — domain not verified",
      cause:
        "Resend only sends from a verified domain, or from its shared test sender " +
        "(onboarding@resend.dev) which can ONLY deliver to the account owner's own address.",
      solution:
        "Either verify your domain at https://resend.com/domains and set EMAIL_FROM to an " +
        "address on it (e.g. \"Nexora <no-reply@nexora.com>\"), or, while testing, send only " +
        "to the email address that owns the Resend account.",
      retryable: false,
    };
  }

  if (status === 403 || name === "forbidden") {
    return {
      ...base,
      title: "Resend forbade this request",
      cause: "The API key is valid but not permitted to perform this action.",
      solution: "Check the key's permissions in the Resend dashboard (it may be read-only).",
      retryable: false,
    };
  }

  if (name === "invalid_from_address" || message.includes("from address")) {
    return {
      ...base,
      title: "Invalid 'from' address",
      cause: `Resend rejected the sender: ${rawMessage}`,
      solution:
        'EMAIL_FROM must look like "Name <address@domain>" and use a verified domain ' +
        "(or onboarding@resend.dev while testing).",
      retryable: false,
    };
  }

  if (
    name === "invalid_to_address" ||
    message.includes("invalid `to`") ||
    message.includes("invalid to")
  ) {
    return {
      ...base,
      title: "Invalid recipient address",
      cause: `Resend rejected the recipient: ${rawMessage}`,
      solution:
        "Verify the recipient address is well-formed. Note: with the test sender, Resend " +
        "only permits delivery to the Resend account owner's address.",
      retryable: false,
    };
  }

  // ---- Rate limiting / quota — retry, it may clear ------------------------
  if (status === 429 || name === "rate_limit_exceeded" || message.includes("rate limit")) {
    return {
      ...base,
      title: "Resend rate limit exceeded",
      cause: "Too many requests in a short window, or the plan's sending quota is exhausted.",
      solution:
        "The retry logic backs off automatically. If it persists, check usage and limits at " +
        "https://resend.com/settings (the free tier allows 100 emails/day).",
      retryable: true,
    };
  }

  if (name === "daily_quota_exceeded" || message.includes("quota")) {
    return {
      ...base,
      title: "Resend sending quota exceeded",
      cause: "The account's daily/monthly sending allowance is used up.",
      solution:
        "Wait for the quota to reset or upgrade the plan at https://resend.com/settings. " +
        "Retrying now cannot succeed.",
      retryable: false,
    };
  }

  // ---- Request shape — permanent ------------------------------------------
  if (status === 400 || name === "invalid_parameter" || name === "missing_required_field") {
    return {
      ...base,
      title: "Resend rejected the request payload",
      cause: `A required field is missing or malformed: ${rawMessage}`,
      solution:
        "This indicates a bug in the send call rather than configuration — check subject, " +
        "html and to fields are all present.",
      retryable: false,
    };
  }

  if (status === 404) {
    return {
      ...base,
      title: "Resend endpoint not found",
      cause: "The API responded 404 — usually an SDK/endpoint mismatch.",
      solution: "Ensure the 'resend' package is up to date (npm install resend@latest).",
      retryable: false,
    };
  }

  // ---- Server-side — retry ------------------------------------------------
  if (status >= 500 || name === "internal_server_error" || name === "application_error") {
    return {
      ...base,
      title: "Resend API server error",
      cause: `Resend returned ${status || "a 5xx"} — a problem on their side, not yours.`,
      solution:
        "Transient; the retry logic will attempt again. Check https://status.resend.com " +
        "if it persists.",
      retryable: true,
    };
  }

  // ---- Unknown ------------------------------------------------------------
  return {
    ...base,
    title: "Unclassified Resend error",
    cause: "This error is not specifically handled yet; the raw message is the best signal.",
    solution:
      `Inspect the raw message${status ? ` (HTTP ${status})` : ""}. If it recurs, add an ` +
      "explicit case in services/email/errors.js.",
    retryable: true,
  };
};

module.exports = { classifyEmailError };
