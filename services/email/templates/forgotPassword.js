/**
 * Forgot-password email - carries the reset link.
 *
 * Distinct from passwordReset.js, which confirms a password was changed.
 */

const { baseLayout, button, detailsBox, fallbackLink, greeting, p, COLORS } = require("./layout");

module.exports = ({ user, resetUrl, expiryMinutes = 15 }) => {
  const body = `
    ${greeting(user.name)}
    ${p(`We received a request to reset the password for your <strong>${user.company}</strong> account.`)}
    ${detailsBox(
      [
        ["Account", user.email],
        ["Employee ID", user.employeeId],
      ],
      COLORS.warning
    )}
    ${button(resetUrl, "Reset Password", COLORS.warning)}
    ${fallbackLink(resetUrl)}
    <p style="margin: 22px 0 0 0; padding-top: 16px; border-top: 1px solid ${COLORS.border};
              font-family: Arial, sans-serif; font-size: 13px; color: ${COLORS.muted};">
      <strong>This link expires in ${expiryMinutes} minutes.</strong> If you didn't request a
      reset, ignore this email - your password will stay unchanged. Never share this link.
    </p>`;

  return {
    subject: `${user.company} - Password reset request`,
    html: baseLayout({
      title: "Password Reset",
      heading: "Reset your password",
      subheading: "A password reset was requested for your account",
      body,
      accent: COLORS.warning,
    }),
    text:
      `Hello ${user.name},\n\n` +
      `A password reset was requested for your ${user.company} account (${user.email}).\n\n` +
      `Reset your password: ${resetUrl}\n\n` +
      `This link expires in ${expiryMinutes} minutes. If you didn't request this, ignore this email.`,
  };
};
