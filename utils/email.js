/**
 * Backward-compatibility facade.
 *
 * The email implementation lives in ../services/email (Brevo HTTPS API,
 * split by responsibility, with templates in services/email/templates).
 *
 * This file exists so existing callers - routes/auth.js, routes/users.js,
 * routes/leaves.js, utils/emailQueue.js - keep working unchanged. Prefer
 * importing from "../services/email" directly in new code.
 */

const emailService = require("../services/email");

module.exports = {
  sendEmail: emailService.sendEmail,
  sendInvitationEmail: emailService.sendInvitationEmail,
  sendWelcomeEmail: emailService.sendWelcomeEmail,
  sendPasswordResetEmail: emailService.sendPasswordResetEmail,
  sendPasswordChangedEmail: emailService.sendPasswordChangedEmail,
  sendLeaveRequestNotification: emailService.sendLeaveRequestNotification,
  sendLeaveStatusNotification: emailService.sendLeaveStatusNotification,
  sendEmployeeVoiceNotification: emailService.sendEmployeeVoiceNotification,
  sendAnnouncementNotification: emailService.sendAnnouncementNotification,
};
