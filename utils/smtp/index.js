/**
 * SMTP email service — public entry point.
 *
 * Single responsibility: orchestrate the isolated pieces (config → transport →
 * verify → send) behind one function, with retry and diagnostics applied
 * consistently.
 *
 * Design notes:
 *  - SMTP is the only delivery mechanism. There is no provider fallback.
 *  - Every failure is classified before it leaves this module, so callers and
 *    logs get a cause and a fix rather than a bare error code.
 *  - Credentials are never logged; recipients are masked.
 */

const { loadSmtpConfig, logSmtpConfig, SmtpConfigError } = require("./config");
const { createTransport, verifyConnection } = require("./transport");
const { classifySmtpError } = require("./errors");
const { withRetry, MAX_ATTEMPTS } = require("./retry");
const { log, maskEmail, logFailure } = require("./logger");

/** Strip HTML to a plaintext alternative when the caller didn't supply one. */
const htmlToText = (html) =>
  String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * A config error is permanent by definition. Everything else defers to the
 * classifier's verdict, defaulting to "don't retry" when unknown — surfacing
 * an unclassified failure fast beats silently burning three attempts on it.
 */
const isRetryableError = (error) => {
  if (error instanceof SmtpConfigError || error?.isConfigError) return false;
  return error?.smtpDiagnosis?.retryable === true;
};

/**
 * Send one email over SMTP.
 *
 * @param {object}  params
 * @param {string}  params.email     recipient address
 * @param {string}  params.subject
 * @param {string}  params.html
 * @param {string} [params.text]     plaintext alternative (derived if omitted)
 * @param {string} [params.fromName] overrides FROM_NAME for this message
 * @returns {Promise<{success: true, messageId: string, response: string,
 *                    accepted: string[], rejected: string[], provider: 'SMTP',
 *                    attempts: number}>}
 * @throws  {Error} with `.smtpDiagnosis` attached describing cause + fix
 */
const sendMail = async ({ email, subject, html, text, fromName }) => {
  if (!email) {
    throw new SmtpConfigError("Cannot send email: no recipient address was provided.");
  }
  if (!subject) {
    throw new SmtpConfigError(`Cannot send email to ${maskEmail(email)}: no subject provided.`);
  }

  // Validate configuration first. Failing here means no connection is even
  // attempted, and the log names the exact missing/invalid variable.
  const config = loadSmtpConfig();

  log("");
  log(`───────── Sending email to ${maskEmail(email)} ─────────`);
  log(`Subject: ${subject}`);
  logSmtpConfig(config);

  let attemptsUsed = 0;

  try {
    const result = await withRetry(
      async (attempt) => {
        attemptsUsed = attempt;

        // A fresh transporter per attempt — reusing one whose connection just
        // failed would re-fail for stale-socket reasons unrelated to the
        // original cause.
        const transporter = createTransport(config);

        try {
          await verifyConnection(transporter, config);

          const mailOptions = {
            from: `${fromName || config.fromName} <${config.fromEmail}>`,
            to: email,
            subject,
            text: text || htmlToText(html),
            html,
            ...(config.replyTo ? { replyTo: config.replyTo } : {}),
            headers: {
              "X-Mailer": "Nexora",
              "X-Priority": "3",
              "X-MSMail-Priority": "Normal",
              Importance: "Normal",
            },
          };

          log("Sending message...");
          const info = await transporter.sendMail(mailOptions);

          log(`✅ Email sent successfully`);
          log(`   Message ID: ${info.messageId}`);
          log(`   Server response: ${info.response}`);
          log(`   Accepted: ${(info.accepted || []).map(maskEmail).join(", ") || "none"}`);
          if (info.rejected && info.rejected.length > 0) {
            log(`   Rejected: ${info.rejected.map(maskEmail).join(", ")}`);
          }

          return info;
        } catch (error) {
          // Attach a diagnosis if verifyConnection didn't already (i.e. the
          // failure happened during sendMail rather than during verify).
          if (!error.smtpDiagnosis) {
            error.smtpDiagnosis = classifySmtpError(error, config);
          }
          throw error;
        } finally {
          // Always release the socket, success or failure — a leaked half-open
          // connection is what makes this path "hang" instead of erroring.
          try {
            transporter.close();
          } catch {
            /* closing a already-dead transport is not itself an error */
          }
        }
      },
      isRetryableError,
      `deliver to ${maskEmail(email)} via ${config.host}:${config.port}`
    );

    return {
      success: true,
      messageId: result.messageId,
      response: result.response,
      accepted: result.accepted,
      rejected: result.rejected,
      provider: "SMTP",
      attempts: attemptsUsed,
    };
  } catch (error) {
    const diagnosis =
      error.smtpDiagnosis || classifySmtpError(error, config);

    logFailure({
      ...diagnosis,
      host: config.host,
      port: config.port,
      secure: config.secure,
    });

    if (diagnosis.retryable) {
      log(`Gave up after ${MAX_ATTEMPTS} attempts.`);
    }

    const wrapped = new Error(`Email delivery failed: ${diagnosis.title}`);
    wrapped.smtpDiagnosis = diagnosis;
    wrapped.code = diagnosis.code;
    wrapped.cause = error;
    throw wrapped;
  }
};

/**
 * Connection-only health check for debug endpoints — validates config and
 * proves reachability/auth without sending a message.
 */
const checkSmtpHealth = async () => {
  try {
    const config = loadSmtpConfig();
    logSmtpConfig(config);

    const transporter = createTransport(config);
    try {
      await verifyConnection(transporter, config);
      return {
        ok: true,
        host: config.host,
        port: config.port,
        secure: config.secure,
        tlsMode: config.tlsDescription,
        user: maskEmail(config.user),
        message: "SMTP server is reachable and credentials were accepted.",
      };
    } finally {
      try {
        transporter.close();
      } catch {
        /* noop */
      }
    }
  } catch (error) {
    const diagnosis = error.smtpDiagnosis || {
      code: error.code || "CONFIG",
      title: error.message,
      cause: error.isConfigError ? "Configuration problem." : "See raw message.",
      solution: error.isConfigError
        ? "Set the missing/invalid environment variable named above."
        : "See the diagnosis above.",
      retryable: false,
    };

    return {
      ok: false,
      code: diagnosis.code,
      reason: diagnosis.title,
      cause: diagnosis.cause,
      solution: diagnosis.solution,
      retryable: diagnosis.retryable,
    };
  }
};

module.exports = { sendMail, checkSmtpHealth, SmtpConfigError };
