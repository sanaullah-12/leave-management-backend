/**
 * Password-changed confirmation.
 *
 * Sent AFTER a successful password change - a security notification, not a
 * link. If the user didn't do it, this is how they find out.
 */

const { baseLayout, button, detailsBox, greeting, p, COLORS } = require("./layout");

module.exports = ({ user, loginUrl, changedAt = new Date() }) => {
  const body = `
    ${greeting(user.name)}
    ${p(`The password for your <strong>${user.company}</strong> account was changed successfully.`)}
    ${detailsBox(
      [
        ["Account", user.email],
        ["Changed at", changedAt.toLocaleString()],
      ],
      COLORS.success
    )}
    ${p("You can now sign in with your new password.")}
    ${button(loginUrl, "Sign In", COLORS.success)}
    <p style="margin: 22px 0 0 0; padding-top: 16px; border-top: 1px solid ${COLORS.border};
              font-family: Arial, sans-serif; font-size: 13px; color: ${COLORS.danger};">
      <strong>Didn't do this?</strong> Contact your administrator immediately - your account
      may be compromised.
    </p>`;

  return {
    subject: `${user.company} - Your password was changed`,
    html: baseLayout({
      title: "Password Changed",
      heading: "Password changed",
      subheading: "Your account password was updated",
      body,
      accent: COLORS.success,
    }),
    text:
      `Hello ${user.name},\n\n` +
      `The password for your ${user.company} account (${user.email}) was changed on ` +
      `${changedAt.toLocaleString()}.\n\n` +
      `Sign in: ${loginUrl}\n\n` +
      `If you did not make this change, contact your administrator immediately.`,
  };
};
