/**
 * Email service — public API.
 *
 * Provider: Resend (official SDK, HTTPS API).
 *
 * Architecture (one responsibility per module) — unchanged from the previous
 * provider; only provider.js and errors.js are provider-specific:
 *   config.js     env validation + the single sender value
 *   provider.js   Resend client singleton          <-- swap point for providers
 *   errors.js     error classification (cause / fix / retryable)
 *   retry.js      exponential backoff, permanent-vs-transient
 *   logger.js     formatting + credential masking
 *   templates/    one file per email type, pure functions
 *
 * Guarantees:
 *   - The API key is read from env only, never hardcoded, never logged.
 *   - Every failure is classified before it leaves this module.
 *   - Transient failures retry (2s/4s/8s); permanent ones fail fast.
 */

const { loadEmailConfig, getFrontendUrl, EmailConfigError } = require("./config");
const { getClient, resetClient, closeProvider } = require("./provider");
const { classifyEmailError } = require("./errors");
const { withRetry, MAX_ATTEMPTS } = require("./retry");
const { log, maskEmail, logFailure } = require("./logger");
const templates = require("./templates");

/** Derive a plaintext alternative when a template didn't supply one. */
const htmlToText = (html) =>
  String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Config errors are permanent by definition. Everything else defers to the
 * classifier, defaulting to "don't retry" when unknown — surfacing an
 * unclassified failure quickly beats burning three attempts on it.
 */
const isRetryable = (error) => {
  if (error instanceof EmailConfigError || error?.isConfigError) return false;
  return error?.emailDiagnosis?.retryable === true;
};

/**
 * Send a single email.
 *
 * @param {object}  params
 * @param {string}  params.email     recipient
 * @param {string}  params.subject
 * @param {string}  params.html
 * @param {string} [params.text]     derived from html when omitted
 * @param {string} [params.fromName] per-message sender NAME override (the
 *                                   address always comes from config.from)
 * @returns {Promise<{success:true, messageId:string, provider:'Resend', attempts:number}>}
 * @throws  {Error} with `.emailDiagnosis` describing cause + fix
 */
const sendEmail = async ({ email, subject, html, text, fromName }) => {
  if (!email) throw new EmailConfigError("Cannot send email: no recipient address provided.");
  if (!subject) {
    throw new EmailConfigError(`Cannot send email to ${maskEmail(email)}: no subject provided.`);
  }

  log("");
  log(`──── Sending to ${maskEmail(email)} ────`);
  log(`Subject: ${subject}`);

  let attemptsUsed = 0;
  let config;

  try {
    const result = await withRetry(
      async (attempt) => {
        attemptsUsed = attempt;

        const entry = getClient();
        config = entry.config;

        // The sender ADDRESS always comes from config (the single swap point).
        // A caller-supplied fromName only relabels it, so an individual send can
        // never accidentally use an unverified address.
        const from = fromName
          ? `${fromName} <${extractAddress(config.from)}>`
          : config.from;

        const payload = {
          from,
          to: Array.isArray(email) ? email : [email],
          subject,
          html,
          text: text || htmlToText(html),
          ...(config.replyTo ? { replyTo: config.replyTo } : {}),
        };

        // The Resend SDK resolves (rather than throws) on API errors, returning
        // { data, error }. Both shapes are normalised into a thrown, classified
        // error so retry/logging behave identically to the previous provider.
        const { data, error } = await entry.client.emails.send(payload);

        if (error) {
          const err = new Error(error.message || "Resend returned an error");
          err.name = error.name || "resend_error";
          err.statusCode = error.statusCode;
          err.emailDiagnosis = classifyEmailError({ ...error, message: error.message }, config);
          throw err;
        }

        log(`✅ Sent — id ${data?.id}`);
        return data;
      },
      isRetryable,
      `deliver to ${maskEmail(email)} via Resend`
    );

    return {
      success: true,
      messageId: result?.id,
      provider: "Resend",
      attempts: attemptsUsed,
    };
  } catch (error) {
    const diagnosis = error.emailDiagnosis || classifyEmailError(error, config || {});

    logFailure({
      ...diagnosis,
      host: "api.resend.com",
      port: 443,
      secure: true,
    });
    if (diagnosis.retryable) log(`Gave up after ${MAX_ATTEMPTS} attempts.`);

    const wrapped = new Error(`Email delivery failed: ${diagnosis.title}`);
    wrapped.emailDiagnosis = diagnosis;
    wrapped.code = diagnosis.code;
    wrapped.cause = error;
    throw wrapped;
  }
};

/** Pull the bare address out of "Name <addr@domain>". */
const extractAddress = (from) => {
  const match = String(from).match(/<([^>]+)>/);
  return match ? match[1] : from;
};

/** Render a registered template and send it. */
const sendTemplate = async (templateName, data, { fromName } = {}) => {
  const template = templates[templateName];
  if (!template) {
    throw new EmailConfigError(
      `Unknown email template "${templateName}". Available: ${Object.keys(templates).join(", ")}`
    );
  }
  const { subject, html, text } = template(data);
  return sendEmail({ email: data.to || data.recipientEmail, subject, html, text, fromName });
};

// ---------------------------------------------------------------------------
// Typed helpers — one per email type. Each resolves its own URL so no caller
// has to remember which env var to use. Signatures are unchanged.
// ---------------------------------------------------------------------------

const sendInvitationEmail = async (employee, token, inviterName, role = "employee") => {
  const inviteUrl = `${getFrontendUrl()}/invite/${token}`;
  const { subject, html, text } = templates.invitation({ employee, inviteUrl, inviterName, role });
  log(`Invite link: ${inviteUrl}`);
  return sendEmail({ email: employee.email, subject, html, text, fromName: employee.company });
};

const sendWelcomeEmail = async (user) => {
  const { subject, html, text } = templates.welcome({
    user,
    loginUrl: `${getFrontendUrl()}/login`,
  });
  return sendEmail({ email: user.email, subject, html, text, fromName: user.company });
};

const sendPasswordResetEmail = async (user, token) => {
  // Path param, not a query string — must match the frontend route
  // /reset-password/:token, or the page loads with an undefined token.
  const resetUrl = `${getFrontendUrl()}/reset-password/${token}`;
  const { subject, html, text } = templates.forgotPassword({ user, resetUrl });
  return sendEmail({ email: user.email, subject, html, text, fromName: user.company });
};

const sendPasswordChangedEmail = async (user) => {
  const { subject, html, text } = templates.passwordReset({
    user,
    loginUrl: `${getFrontendUrl()}/login`,
  });
  return sendEmail({ email: user.email, subject, html, text, fromName: user.company });
};

const sendLeaveRequestNotification = async (admin, employee, leave) => {
  const { subject, html, text } = templates.leaveRequest({
    admin,
    employee,
    leave,
    reviewUrl: `${getFrontendUrl()}/leaves`,
  });
  return sendEmail({ email: admin.email, subject, html, text });
};

const sendLeaveStatusNotification = async (employee, leave, reviewedBy) => {
  const approved = String(leave.status).toLowerCase() === "approved";
  const template = approved ? templates.leaveApproved : templates.leaveRejected;
  const { subject, html, text } = template({
    employee,
    leave,
    reviewedBy,
    dashboardUrl: `${getFrontendUrl()}/leaves`,
  });
  return sendEmail({ email: employee.email, subject, html, text });
};

const sendEmployeeVoiceNotification = async (recipient, voice, opts = {}) => {
  const { subject, html, text } = templates.employeeVoice({
    recipient,
    voice,
    submittedBy: opts.submittedBy,
    isResponse: !!opts.isResponse,
    actionUrl: `${getFrontendUrl()}/employee-voice`,
  });
  return sendEmail({ email: recipient.email, subject, html, text });
};

const sendAnnouncementNotification = async (recipient, announcement) => {
  const { subject, html, text } = templates.announcement({
    recipient,
    announcement,
    actionUrl: `${getFrontendUrl()}/announcements`,
  });
  return sendEmail({ email: recipient.email, subject, html, text });
};

/**
 * Health check — validates config and confirms the API key is accepted,
 * without sending an email. Uses a lightweight authenticated read (domains
 * list) so a 401 surfaces immediately.
 */
const checkEmailHealth = async () => {
  try {
    const { client, config } = getClient();
    const { error } = await client.domains.list();

    if (error) {
      const d = classifyEmailError({ ...error, message: error.message }, config);
      return {
        ok: false,
        code: d.code,
        reason: d.title,
        cause: d.cause,
        solution: d.solution,
        retryable: d.retryable,
      };
    }

    return {
      ok: true,
      provider: "Resend",
      from: config.from,
      usingTestSender: config.isTestSender,
      message: config.isTestSender
        ? "Resend API key is valid. NOTE: the test sender only delivers to the Resend account owner's address."
        : "Resend API key is valid and the sender domain is configured.",
    };
  } catch (error) {
    const d = error.emailDiagnosis || classifyEmailError(error, {});
    return {
      ok: false,
      code: d.code,
      reason: d.title || error.message,
      cause: d.cause,
      solution: d.solution,
      retryable: d.retryable,
    };
  }
};

module.exports = {
  // core
  sendEmail,
  sendTemplate,
  checkEmailHealth,
  closeTransporter: closeProvider, // name retained for existing shutdown hooks
  closeProvider,
  resetClient,
  templates,
  // typed helpers
  sendInvitationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendLeaveRequestNotification,
  sendLeaveStatusNotification,
  sendEmployeeVoiceNotification,
  sendAnnouncementNotification,
};
