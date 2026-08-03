/** Company announcement notification. */

const { baseLayout, button, detailsBox, greeting, p, esc, COLORS } = require("./layout");

const PRIORITY_ACCENT = {
  urgent: COLORS.danger,
  high: COLORS.warning,
  normal: COLORS.primary,
  low: COLORS.muted,
};

module.exports = ({ recipient, announcement, actionUrl }) => {
  const priority = String(announcement.priority || "normal").toLowerCase();
  const accent = PRIORITY_ACCENT[priority] || COLORS.primary;

  const body = `
    ${greeting(recipient.name)}
    ${p(`A new announcement has been posted${announcement.author ? ` by <strong>${esc(announcement.author)}</strong>` : ""}.`)}
    <h2 style="margin: 22px 0 12px 0; font-family: Arial, sans-serif; font-size: 19px; color: #0f172a;">
      ${esc(announcement.title)}
    </h2>
    ${p(esc(announcement.content || announcement.message || "").replace(/\n/g, "<br>"))}
    ${detailsBox(
      [
        ["Category", announcement.category],
        ["Priority", announcement.priority],
        ["Posted", announcement.createdAt ? new Date(announcement.createdAt).toLocaleString() : undefined],
      ],
      accent
    )}
    ${actionUrl ? button(actionUrl, "View Announcement", accent) : ""}`;

  return {
    subject: `${priority === "urgent" ? "[URGENT] " : ""}${announcement.title}`,
    html: baseLayout({
      title: "Announcement",
      heading: "New announcement",
      subheading: announcement.category || "Company update",
      body,
      accent,
    }),
    text:
      `Hello ${recipient.name},\n\n` +
      `${announcement.title}\n\n` +
      `${announcement.content || announcement.message || ""}\n\n` +
      (actionUrl ? `View it: ${actionUrl}` : ""),
  };
};
