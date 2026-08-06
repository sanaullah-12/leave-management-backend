/**
 * Email service - public API.
 *
 * Provider: Brevo (official @getbrevo/brevo SDK, HTTPS API).
 *
 * Architecture (one responsibility per module) - unchanged across provider
 * swaps; only provider.js and errors.js are provider-specific:
 *   config.js     env validation + sender configuration
 *   provider.js   Brevo client singleton           <-- swap point for providers
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
 * classifier, defaulting to "don't retry" when unknown - surfacing an
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
 *                                   address always comes from config)
 * @returns {Promise<{success:true, messageId:string, provider:'Brevo', attempts:number}>}
 * @throws  {Error} with `.emailDiagnosis` describing cause + fix
 */
const sendEmail = async ({ email, subject, html, text, fromName }) => {
  if (!email) throw new EmailConfigError("Cannot send email: no recipient address provided.");
  if (!subject) {
    throw new EmailConfigError(`Cannot send email to ${maskEmail(email)}: no subject provided.`);
  }

  log("");
  log(`---- Sending to ${maskEmail(email)} ----`);
  log(`Subject: ${subject}`);

  let attemptsUsed = 0;
  let config;

  try {
    const result = await withRetry(
      async (attempt) => {
        attemptsUsed = attempt;

        const entry = getClient();
        config = entry.config;

        const recipients = (Array.isArray(email) ? email : [email]).map((addr) => ({
          email: addr,
        }));

        // The sender ADDRESS always comes from config. A caller-supplied
        // fromName only relabels it, so an individual send can never
        // accidentally use an address that isn't verified in Brevo.
        const payload = {
          sender: {
            email: config.fromEmail,
            name: fromName || config.fromName,
          },
          to: recipients,
          subject,
          htmlContent: html,
          textContent: text || htmlToText(html),
          ...(config.replyTo ? { replyTo: { email: config.replyTo } } : {}),
        };

        try {
          const data = await entry.client.transactionalEmails.sendTransacEmail(payload);
          log(`Sent - messageId ${data?.messageId}`);
          return data;
        } catch (error) {
          // The Brevo SDK throws on API errors. Classify here so retry and
          // logging behave identically to previous providers.
          if (!error.emailDiagnosis) {
            error.emailDiagnosis = classifyEmailError(error, config);
          }
          throw error;
        }
      },
      isRetryable,
      `deliver to ${maskEmail(email)} via Brevo`
    );

    return {
      success: true,
      messageId: result?.messageId,
      provider: "Brevo",
      attempts: attemptsUsed,
    };
  } catch (error) {
    const diagnosis = error.emailDiagnosis || classifyEmailError(error, config || {});

    logFailure({
      ...diagnosis,
      host: "api.brevo.com",
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
// Typed helpers - one per email type. Each resolves its own URL so no caller
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
  // Path param, not a query string - must match the frontend route
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
 * Health check - validates config and confirms the API key is accepted,
 * without sending an email. Uses a lightweight authenticated read (account
 * details) so a 401 surfaces immediately.
 *
 * Also reports whether EMAIL_FROM is actually a verified sender, since an
 * unverified sender is the most common reason sends fail once the key is fine.
 */
const checkEmailHealth = async () => {
  let config;
  try {
    const entry = getClient();
    config = entry.config;

    const account = await entry.client.account.getAccount();

    // Best-effort sender verification check - informational only, so a
    // permissions error here must not fail the whole health check.
    let senderVerified = null;
    try {
      const senders = await entry.client.senders.getSenders();
      const list = senders?.senders || [];
      if (list.length > 0) {
        senderVerified = list.some(
          (s) =>
            String(s.email).toLowerCase() === String(config.fromEmail).toLowerCase() &&
            s.active !== false
        );
      }
    } catch {
      /* sender listing is optional - ignore and report null */
    }

    return {
      ok: true,
      provider: "Brevo",
      from: `${config.fromName} <${config.fromEmail}>`,
      account: account?.companyName || account?.email || undefined,
      plan: Array.isArray(account?.plan) ? account.plan[0]?.type : undefined,
      senderVerified,
      message:
        senderVerified === false
          ? "Brevo API key is valid, but EMAIL_FROM is NOT a verified sender - sends will be rejected."
          : "Brevo API key is valid and the account is reachable.",
    };
  } catch (error) {
    const d = error.emailDiagnosis || classifyEmailError(error, config || {});
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
