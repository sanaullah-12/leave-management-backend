/** Welcome email — sent once an invited user has completed registration. */

const { baseLayout, button, detailsBox, greeting, p, COLORS } = require("./layout");

module.exports = ({ user, loginUrl }) => {
  const body = `
    ${greeting(user.name)}
    ${p(
      `Your account at <strong>${user.company}</strong> is now active. You can sign in and start using the system right away.`
    )}
    ${detailsBox(
      [
        ["Email", user.email],
        ["Employee ID", user.employeeId],
        ["Department", user.department],
        ["Position", user.position],
      ],
      COLORS.success
    )}
    ${p("From your dashboard you can request leave, track approvals, and view your balances.")}
    ${button(loginUrl, "Go to Dashboard", COLORS.success)}`;

  return {
    subject: `Welcome to ${user.company} — your account is ready`,
    html: baseLayout({
      title: "Welcome",
      heading: "Your account is ready",
      subheading: `Welcome aboard, ${user.name}`,
      body,
      accent: COLORS.success,
    }),
    text:
      `Hello ${user.name},\n\n` +
      `Your account at ${user.company} is now active.\n\n` +
      `Email: ${user.email}\nEmployee ID: ${user.employeeId}\n\n` +
      `Sign in: ${loginUrl}`,
  };
};
