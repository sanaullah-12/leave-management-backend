/** Leave approved notification - sent to the employee. */

const { baseLayout, button, detailsBox, greeting, p, esc, COLORS } = require("./layout");

const fmt = (d) => (d ? new Date(d).toLocaleDateString() : "-");

module.exports = ({ employee, leave, reviewedBy, dashboardUrl }) => {
  const body = `
    ${greeting(employee.name)}
    ${p(
      `Good news - your leave request has been <strong style="color: ${COLORS.success};">approved</strong>${
        reviewedBy ? ` by ${esc(reviewedBy.name)}` : ""
      }.`
    )}
    ${detailsBox(
      [
        ["Leave type", leave.leaveType],
        ["From", fmt(leave.startDate)],
        ["To", fmt(leave.endDate)],
        ["Total days", leave.totalDays],
        ["Comments", leave.reviewComments],
      ],
      COLORS.success
    )}
    ${p("Enjoy your time off. Your leave balance has been updated accordingly.")}
    ${dashboardUrl ? button(dashboardUrl, "View My Leave", COLORS.success) : ""}`;

  return {
    subject: `Leave approved - ${leave.leaveType} (${fmt(leave.startDate)} to ${fmt(leave.endDate)})`,
    html: baseLayout({
      title: "Leave Approved",
      heading: "Leave approved",
      subheading: "Your request has been accepted",
      body,
      accent: COLORS.success,
    }),
    text:
      `Hello ${employee.name},\n\n` +
      `Your leave request has been APPROVED${reviewedBy ? ` by ${reviewedBy.name}` : ""}.\n\n` +
      `Type: ${leave.leaveType}\nFrom: ${fmt(leave.startDate)}\nTo: ${fmt(leave.endDate)}\n` +
      `Days: ${leave.totalDays}\n` +
      (leave.reviewComments ? `Comments: ${leave.reviewComments}\n` : ""),
  };
};
