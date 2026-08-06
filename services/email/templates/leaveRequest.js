/** New leave request notification - sent to admins/approvers for review. */

const { baseLayout, button, detailsBox, greeting, p, esc, COLORS } = require("./layout");

const fmt = (d) => (d ? new Date(d).toLocaleDateString() : "-");

module.exports = ({ admin, employee, leave, reviewUrl }) => {
  const body = `
    ${greeting(admin.name)}
    ${p(`<strong>${esc(employee.name)}</strong> has submitted a leave request that needs your review.`)}
    ${detailsBox([
      ["Employee", `${employee.name} (${employee.employeeId || "-"})`],
      ["Department", employee.department],
      ["Leave type", leave.leaveType],
      ["From", fmt(leave.startDate)],
      ["To", fmt(leave.endDate)],
      ["Total days", leave.totalDays],
      ["Reason", leave.reason],
    ])}
    ${reviewUrl ? button(reviewUrl, "Review Request") : ""}`;

  return {
    subject: `Leave request from ${employee.name} - needs review`,
    html: baseLayout({
      title: "New Leave Request",
      heading: "New leave request",
      subheading: "A request is awaiting your review",
      body,
    }),
    text:
      `Hello ${admin.name},\n\n` +
      `${employee.name} submitted a leave request.\n\n` +
      `Type: ${leave.leaveType}\nFrom: ${fmt(leave.startDate)}\nTo: ${fmt(leave.endDate)}\n` +
      `Days: ${leave.totalDays}\nReason: ${leave.reason}\n\n` +
      (reviewUrl ? `Review it: ${reviewUrl}` : ""),
  };
};
