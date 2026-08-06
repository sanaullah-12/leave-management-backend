/** Invitation email - sent when an admin invites a new employee or admin. */

const { baseLayout, button, detailsBox, fallbackLink, greeting, p, esc, COLORS } = require("./layout");

module.exports = ({ employee, inviteUrl, inviterName, role = "employee" }) => {
  const roleLabel = role === "admin" ? "an administrator" : "a team member";

  const body = `
    ${greeting(employee.name)}
    ${p(
      `<strong>${esc(inviterName)}</strong> has invited you to join <strong>${esc(
        employee.company
      )}</strong> as ${roleLabel}.`
    )}
    ${detailsBox([
      ["Position", employee.position],
      ["Department", employee.department],
      ["Company", employee.company],
    ])}
    ${p("To activate your account and set your password, click below:")}
    ${button(inviteUrl, "Accept Invitation")}
    ${fallbackLink(inviteUrl)}
    <p style="margin: 22px 0 0 0; padding-top: 16px; border-top: 1px solid ${COLORS.border};
              font-family: Arial, sans-serif; font-size: 13px; color: ${COLORS.muted};">
      <strong>Note:</strong> this invitation expires in 7 days. If you weren't expecting it,
      you can safely ignore this email.
    </p>`;

  return {
    subject: `${employee.company} - You're invited to join the team`,
    html: baseLayout({
      title: "Team Invitation",
      heading: `Welcome to ${employee.company}`,
      subheading: "You've been invited to join the team",
      body,
    }),
    text:
      `Hello ${employee.name},\n\n` +
      `${inviterName} has invited you to join ${employee.company} as ${roleLabel}.\n\n` +
      `Position: ${employee.position}\nDepartment: ${employee.department}\n\n` +
      `Accept your invitation: ${inviteUrl}\n\n` +
      `This invitation expires in 7 days.`,
  };
};
