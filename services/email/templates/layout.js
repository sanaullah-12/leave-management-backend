/**
 * Shared email layout primitives.
 *
 * Single responsibility: the visual shell every template composes into, so
 * branding and email-client compatibility live in one place instead of being
 * copy-pasted into each template.
 *
 * Constraints this markup works within: email clients strip <style> blocks and
 * ignore most modern CSS, so everything is inline styles on tables/divs.
 */

const BRAND = "Nexora";
const BRAND_TAGLINE = "The HRMS System";

const COLORS = {
  primary: "#2563eb",
  success: "#059669",
  danger: "#dc2626",
  warning: "#d97706",
  slate: "#334155",
  muted: "#64748b",
  border: "#e2e8f0",
  surface: "#f8fafc",
};

/** Escape untrusted values before interpolating them into HTML. */
const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Call-to-action button. Uses a table so Outlook renders it. */
const button = (url, label, color = COLORS.primary) => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 28px auto;">
    <tr>
      <td align="center" style="border-radius: 6px; background: ${color};">
        <a href="${esc(url)}"
           style="display: inline-block; padding: 14px 32px; font-family: Arial, sans-serif;
                  font-size: 15px; font-weight: bold; color: #ffffff; text-decoration: none;
                  border-radius: 6px;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;

/** Key/value detail panel. `rows` is an array of [label, value] pairs. */
const detailsBox = (rows, accent = COLORS.primary) => `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
         style="background: ${COLORS.surface}; border-left: 4px solid ${accent};
                border-radius: 4px; margin: 24px 0;">
    <tr><td style="padding: 18px 20px;">
      ${rows
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(
          ([label, value]) => `
        <p style="margin: 0 0 8px 0; font-family: Arial, sans-serif; font-size: 14px;
                  color: ${COLORS.slate};">
          <strong style="color: ${COLORS.muted};">${esc(label)}:</strong> ${esc(value)}
        </p>`
        )
        .join("")}
    </td></tr>
  </table>`;

/** Fallback link shown when the button doesn't render or can't be clicked. */
const fallbackLink = (url) => `
  <p style="margin: 20px 0 6px 0; font-family: Arial, sans-serif; font-size: 13px; color: ${COLORS.muted};">
    If the button doesn't work, copy and paste this link into your browser:
  </p>
  <p style="margin: 0; font-family: Arial, sans-serif; font-size: 12px; word-break: break-all;
            background: ${COLORS.surface}; padding: 10px; border-radius: 4px; color: ${COLORS.slate};">
    ${esc(url)}
  </p>`;

/**
 * Wrap body content in the branded shell.
 *
 * @param {object} opts
 * @param {string} opts.title      <title> / preheader text
 * @param {string} opts.heading    banner heading
 * @param {string} [opts.subheading]
 * @param {string} opts.body       inner HTML
 * @param {string} [opts.accent]   banner colour
 * @param {string} [opts.footer]   extra footer note
 */
const baseLayout = ({ title, heading, subheading, body, accent = COLORS.primary, footer }) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
</head>
<body style="margin: 0; padding: 0; background: #f1f5f9;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background: #f1f5f9; padding: 24px 12px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid ${COLORS.border};">

        <tr><td style="background: ${accent}; padding: 28px 32px; text-align: center;">
          <h1 style="margin: 0; font-family: Arial, sans-serif; font-size: 24px; font-weight: normal; color: #ffffff;">
            ${esc(heading)}
          </h1>
          ${
            subheading
              ? `<p style="margin: 8px 0 0 0; font-family: Arial, sans-serif; font-size: 14px; color: rgba(255,255,255,0.9);">${esc(
                  subheading
                )}</p>`
              : ""
          }
        </td></tr>

        <tr><td style="padding: 32px;">
          ${body}
        </td></tr>

        <tr><td style="padding: 20px 32px; background: ${COLORS.surface}; border-top: 1px solid ${COLORS.border}; text-align: center;">
          <p style="margin: 0 0 4px 0; font-family: Arial, sans-serif; font-size: 13px; font-weight: bold; color: ${COLORS.slate};">
            ${BRAND} <span style="font-weight: normal; color: ${COLORS.muted};">${BRAND_TAGLINE}</span>
          </p>
          ${
            footer
              ? `<p style="margin: 6px 0 0 0; font-family: Arial, sans-serif; font-size: 12px; color: ${COLORS.muted};">${esc(
                  footer
                )}</p>`
              : ""
          }
          <p style="margin: 6px 0 0 0; font-family: Arial, sans-serif; font-size: 11px; color: #94a3b8;">
            This is an automated message. Please do not reply directly to this email.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

/** Paragraph helper for template bodies. */
const p = (html) =>
  `<p style="margin: 0 0 14px 0; font-family: Arial, sans-serif; font-size: 15px; line-height: 1.6; color: ${COLORS.slate};">${html}</p>`;

/** Greeting line. */
const greeting = (name) =>
  `<p style="margin: 0 0 16px 0; font-family: Arial, sans-serif; font-size: 17px; color: #0f172a;"><strong>Hello ${esc(
    name
  )},</strong></p>`;

module.exports = {
  baseLayout,
  button,
  detailsBox,
  fallbackLink,
  greeting,
  p,
  esc,
  COLORS,
  BRAND,
};
