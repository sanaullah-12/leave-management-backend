/** Employee Voice notification — sent when feedback is submitted or answered. */

const { baseLayout, button, detailsBox, greeting, p, esc, COLORS } = require("./layout");

module.exports = ({ recipient, voice, submittedBy, actionUrl, isResponse = false }) => {
  const body = isResponse
    ? `
      ${greeting(recipient.name)}
      ${p("Your submission to Employee Voice has received a response.")}
      ${detailsBox(
        [
          ["Subject", voice.subject || voice.title],
          ["Category", voice.category],
          ["Status", voice.status],
        ],
        COLORS.primary
      )}
      ${voice.response ? p(`<em>"${esc(voice.response)}"</em>`) : ""}
      ${actionUrl ? button(actionUrl, "View Response") : ""}`
    : `
      ${greeting(recipient.name)}
      ${p(
        `A new Employee Voice submission has been received${
          submittedBy ? ` from <strong>${esc(submittedBy)}</strong>` : " anonymously"
        }.`
      )}
      ${detailsBox([
        ["Subject", voice.subject || voice.title],
        ["Category", voice.category],
        ["Priority", voice.priority],
      ])}
      ${voice.message ? p(`<em>"${esc(String(voice.message).slice(0, 400))}"</em>`) : ""}
      ${actionUrl ? button(actionUrl, "Review Submission") : ""}`;

  return {
    subject: isResponse
      ? `Your Employee Voice submission has a response`
      : `New Employee Voice submission — ${voice.subject || voice.title || "feedback"}`,
    html: baseLayout({
      title: "Employee Voice",
      heading: isResponse ? "You have a response" : "New submission",
      subheading: "Employee Voice",
      body,
    }),
    text: isResponse
      ? `Hello ${recipient.name},\n\nYour Employee Voice submission received a response.\n\n` +
        `Subject: ${voice.subject || voice.title}\n` +
        (voice.response ? `Response: ${voice.response}\n` : "") +
        (actionUrl ? `\nView it: ${actionUrl}` : "")
      : `Hello ${recipient.name},\n\nA new Employee Voice submission was received.\n\n` +
        `Subject: ${voice.subject || voice.title}\nCategory: ${voice.category}\n` +
        (actionUrl ? `\nReview it: ${actionUrl}` : ""),
  };
};
