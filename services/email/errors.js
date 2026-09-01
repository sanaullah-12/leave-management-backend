/**
 * Brevo error classification.
 *
 * Single responsibility: turn a Brevo API error into a verdict - what
 * happened, why, how to fix it, and whether retrying could ever help.
 *
 * The retryable flag matters: retrying a bad API key or an unverified sender
 * just burns attempts and delays the real error reaching the logs, while
 * retrying a 429/5xx is exactly right.
 *
 * Brevo's SDK throws a BrevoError carrying `statusCode` and `body`, where the
 * body is `{ code, message }` using Brevo's documented error codes.
 */

const classifyEmailError = (error, config = {}) => {
  const status = error?.statusCode ?? error?.status ?? error?.response?.status;
  const body = error?.body ?? error?.response?.body ?? {};
  const brevoCode = body?.code || error?.code || "";
  const rawMessage = body?.message || error?.message || String(error);
  const nodeCode = error?.code;
  const message = String(rawMessage).toLowerCase();

  const base = {
    code: brevoCode || nodeCode || (status ? `HTTP_${status}` : "UNKNOWN"),
    command: undefined,
    rawMessage,
    statusCode: status,
  };

  // ---- Local configuration - never retried --------------------------------
  // A missing/invalid variable never reaches Brevo, so without this branch it
  // fell through to "Unclassified Brevo error" and the actionable message
  // naming the missing variable was hidden from the caller.
  if (error?.isConfigError || error?.name === "EmailConfigError") {
    return {
      ...base,
      code: "EMAIL_CONFIG",
      title: "Email is not configured",
      cause: rawMessage,
      solution:
        "Set the variable(s) named above. Locally that means backend/.env; on Railway, " +
        "service -> Variables. Nothing was sent to Brevo.",
      retryable: false,
    };
  }

  // ---- Network / transport (thrown before any HTTP response) --------------
  // Brevo needs only outbound HTTPS (443), so these are genuine connectivity
  // faults rather than the port-blocking that affects SMTP.
  if (nodeCode === "ENOTFOUND" || nodeCode === "EAI_AGAIN") {
    return {
      ...base,
      title: "Could not resolve the Brevo API host",
      cause: "DNS lookup for api.brevo.com failed - no DNS, or no outbound network.",
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
    error?.name === "BrevoTimeoutError" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("timeout")
  ) {
    return {
      ...base,
      title: "Network error reaching the Brevo API",
      cause: `A connection-level failure occurred calling api.brevo.com (${nodeCode || "network"}).`,
      solution:
        "Confirm the host allows outbound HTTPS on port 443. Usually transient - the " +
        "retry logic will attempt again.",
      retryable: true,
    };
  }

  // ---- SMTP authentication (local development) - never retried ------------
  // Gmail rejects normal account passwords outright; only an App Password
  // works, and that is by far the most common local setup mistake.
  if (nodeCode === "EAUTH" || status === 535 || message.includes("invalid login")) {
    return {
      ...base,
      title: "SMTP server rejected the credentials",
      cause:
        "SMTP_EMAIL / SMTP_PASSWORD were refused. For Gmail this normally means a regular " +
        "account password was used instead of a 16-character App Password, or 2-Step " +
        "Verification is not enabled on the account.",
      solution:
        "Enable 2-Step Verification, then create an App Password at " +
        "https://myaccount.google.com/apppasswords and set it as SMTP_PASSWORD in " +
        "backend/.env (no spaces).",
      retryable: false,
    };
  }

  // ---- Authentication - never retried -------------------------------------
  if (status === 401 || brevoCode === "unauthorized") {
    return {
      ...base,
      title: "Brevo rejected the API key",
      cause:
        "BREVO_API_KEY is missing, malformed, revoked, or is an SMTP key rather than an " +
        "API (v3) key.",
      solution:
        "Generate a v3 API key at https://app.brevo.com/settings/keys/api (it starts with " +
        '"xkeysib-") and set BREVO_API_KEY in Railway → Variables. SMTP keys will not work.',
      retryable: false,
    };
  }

  // ---- Sender verification - the most common real-world blocker -----------
  // Brevo only sends from a verified sender address or verified domain.
  if (
    message.includes("sender") &&
    (message.includes("not valid") ||
      message.includes("invalid") ||
      message.includes("not been validated") ||
      message.includes("does not exist"))
  ) {
    return {
      ...base,
      title: "Sender address rejected - not verified in Brevo",
      cause:
        `Brevo will only send from a verified sender. EMAIL_FROM (${
          config.fromEmail || "unset"
        }) is not a verified sender address, and its domain is not verified either.`,
      solution:
        "Add and confirm the address at https://app.brevo.com/senders (a confirmation email " +
        "is sent to it), or verify the whole domain at https://app.brevo.com/senders/domain " +
        "and set EMAIL_FROM to any address on it.",
      retryable: false,
    };
  }

  // ---- Credits / quota ----------------------------------------------------
  if (status === 402 || brevoCode === "not_enough_credits") {
    return {
      ...base,
      title: "Brevo account is out of sending credits",
      cause:
        "The account's email credits are exhausted. Brevo's free plan allows 300 emails/day.",
      solution:
        "Wait for the daily allowance to reset, or upgrade the plan at " +
        "https://app.brevo.com/billing. Retrying now cannot succeed.",
      retryable: false,
    };
  }

  if (status === 403 || brevoCode === "permission_denied" || brevoCode === "reseller_permission_denied") {
    return {
      ...base,
      title: "Brevo denied permission for this request",
      cause: "The API key is valid but lacks permission for transactional sending.",
      solution:
        "Check the key's scopes in the Brevo dashboard, and that the account is activated " +
        "(new accounts sometimes require validation before they may send).",
      retryable: false,
    };
  }

  // ---- Rate limiting - retry, it may clear --------------------------------
  if (status === 429) {
    return {
      ...base,
      title: "Brevo rate limit exceeded",
      cause: "Too many requests in a short window.",
      solution:
        "The retry logic backs off automatically. If it persists, reduce send concurrency " +
        "or check limits at https://app.brevo.com.",
      retryable: true,
    };
  }

  // ---- Request shape - permanent ------------------------------------------
  if (
    status === 400 ||
    brevoCode === "invalid_parameter" ||
    brevoCode === "missing_parameter" ||
    brevoCode === "out_of_range" ||
    brevoCode === "duplicate_parameter"
  ) {
    return {
      ...base,
      title: "Brevo rejected the request payload",
      cause: `A field is missing or malformed: ${rawMessage}`,
      solution:
        "Check that sender, to, subject and htmlContent are all present and well-formed. " +
        "This usually indicates a bug in the send call rather than configuration.",
      retryable: false,
    };
  }

  if (status === 404 || brevoCode === "document_not_found") {
    return {
      ...base,
      title: "Brevo endpoint or resource not found",
      cause: "The API responded 404 - usually an SDK/endpoint mismatch.",
      solution: "Ensure @getbrevo/brevo is up to date (npm install @getbrevo/brevo@latest).",
      retryable: false,
    };
  }

  if (status === 405 || brevoCode === "method_not_allowed") {
    return {
      ...base,
      title: "Brevo rejected the HTTP method",
      cause: "The SDK called an endpoint in an unsupported way.",
      solution: "Update @getbrevo/brevo to the latest version.",
      retryable: false,
    };
  }

  // ---- Server-side - retry ------------------------------------------------
  if (status >= 500) {
    return {
      ...base,
      title: "Brevo API server error",
      cause: `Brevo returned ${status} - a problem on their side, not yours.`,
      solution:
        "Transient; the retry logic will attempt again. Check https://status.brevo.com " +
        "if it persists.",
      retryable: true,
    };
  }

  // ---- Unknown ------------------------------------------------------------
  return {
    ...base,
    title: "Unclassified Brevo error",
    cause: "This error is not specifically handled yet; the raw message is the best signal.",
    solution:
      `Inspect the raw message${status ? ` (HTTP ${status})` : ""}. If it recurs, add an ` +
      "explicit case in services/email/errors.js.",
    retryable: true,
  };
};

module.exports = { classifyEmailError };
