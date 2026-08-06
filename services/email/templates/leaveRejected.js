/** Leave rejected notification - sent to the employee. */

const { baseLayout, button, detailsBox, greeting, p, esc, COLORS } = require("./layout");

const fmt = (d) => (d ? new Date(d).toLocaleDateString() : "-");

module.exports = ({ employee, leave, reviewedBy, dashboardUrl }) => {
  const body = `
    ${greeting(employee.name)}
    ${p(
      `Your leave request was <strong style="color: ${COLORS.danger};">not approved</strong>${
        reviewedBy ? ` by ${esc(reviewedBy.name)}` : ""
      }.`
    )}
    ${detailsBox(
      [
        ["Leave type", leave.leaveType],
        ["From", fmt(leave.startDate)],
        ["To", fmt(leave.endDate)],
        ["Total days", leave.totalDays],
        ["Reason given", leave.reviewComments],
      ],
      COLORS.danger
    )}
    ${p(
      "If you have questions about this decision, please speak with your manager or HR - they can explain the reasoning and discuss alternatives."
    )}
    ${dashboardUrl ? button(dashboardUrl, "View My Leave", COLORS.primary) : ""}`;

  return {
    subject: `Leave request declined - ${leave.leaveType} (${fmt(leave.startDate)})`,
    html: baseLayout({
      title: "Leave Request Declined",
      heading: "Leave request declined",
      subheading: "Your request was not approved",
      body,
      accent: COLORS.danger,
    }),
    text:
      `Hello ${employee.name},\n\n` +
      `Your leave request was DECLINED${reviewedBy ? ` by ${reviewedBy.name}` : ""}.\n\n` +
      `Type: ${leave.leaveType}\nFrom: ${fmt(leave.startDate)}\nTo: ${fmt(leave.endDate)}\n` +
      (leave.reviewComments ? `Reason: ${leave.reviewComments}\n` : "") +
      `\nContact your manager or HR if you have questions.`,
  };
};
