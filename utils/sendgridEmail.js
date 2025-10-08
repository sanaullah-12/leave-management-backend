// Safe SendGrid import - handle missing package gracefully
let sgMail;
try {
  sgMail = require("@sendgrid/mail");
} catch (error) {
  console.warn(
    "⚠️ @sendgrid/mail package not found - SendGrid features disabled"
  );
  sgMail = null;
}

// Configure SendGrid API key
const sendGridApiKey = process.env.SENDGRID_API_KEY || process.env.SendGrid_Key;

if (sgMail && sendGridApiKey) {
  sgMail.setApiKey(sendGridApiKey);
  console.log("✅ SendGrid configured with API key");
  console.log(
    "🔑 Using API key source:",
    process.env.SENDGRID_API_KEY ? "SENDGRID_API_KEY" : "SendGrid_Key"
  );
} else {
  console.warn(
    "⚠️ SendGrid API key not found or package missing - falling back to SMTP"
  );
  console.warn(
    "🔍 Checking for: SENDGRID_API_KEY =",
    !!process.env.SENDGRID_API_KEY
  );
  console.warn("🔍 Checking for: SendGrid_Key =", !!process.env.SendGrid_Key);
}

// SendGrid email function
const sendEmailWithSendGrid = async ({
  email,
  subject,
  html,
  text,
  fromName,
}) => {
  // Check if SendGrid is available
  if (!sgMail) {
    throw new Error(
      "SendGrid package not available - @sendgrid/mail not installed"
    );
  }

  try {
    console.log("📧 SendGrid: Sending email to:", email);

    // Generate text from HTML if not provided
    const textContent =
      text ||
      html
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const msg = {
      to: email,
      from: {
        email: process.env.FROM_EMAIL || process.env.SMTP_EMAIL,
        name: fromName || process.env.FROM_NAME || "Leave Management System",
      },
      replyTo: {
        email:
          process.env.EMAIL_REPLY_TO ||
          process.env.FROM_EMAIL ||
          process.env.SMTP_EMAIL,
        name: "HR Support - Leave Management",
      },
      subject: subject,
      text: textContent,
      html: html,
      // SendGrid Headers for Better Deliverability
      headers: {
        "X-Mailer": "Leave Management System v1.0",
        "X-Priority": "3",
        "X-MSMail-Priority": "Normal",
        Importance: "Normal",
        "X-Entity-Ref-ID": new Date().getTime().toString(),
        "List-Unsubscribe": `<mailto:unsubscribe@${
          process.env.EMAIL_DOMAIN || "gmail.com"
        }>, <${process.env.FRONTEND_URL}/unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Auto-Response-Suppress": "OOF",
      },
      // SendGrid Categories for Analytics
      categories: ["transactional", "leave-management", "hr-system"],
      // Custom Args for Tracking
      customArgs: {
        system: "leave-management",
        version: "1.0",
        environment: process.env.NODE_ENV || "production",
      },
      // SendGrid specific settings
      trackingSettings: {
        clickTracking: {
          enable: true,
          enableText: false,
        },
        openTracking: {
          enable: true,
          substitutionTag: "%open_tracking%",
        },
        subscriptionTracking: {
          enable: true,
          text: "If you would like to unsubscribe and stop receiving these emails click here: <%click here%>",
          html: '<p>If you would like to unsubscribe and stop receiving these emails <a href="<%click here%>">click here</a></p>',
          substitutionTag: "<%unsubscribe%>",
        },
      },
      mailSettings: {
        sandboxMode: {
          enable: process.env.NODE_ENV === "test", // Enable sandbox in test mode
        },
        footerSettings: {
          enable: true,
          text: `\n\n---\n${
            process.env.COMPANY_NAME || "Leave Management System"
          }\nThis email was sent by an automated system. Please do not reply directly to this email.\nFor support, contact: ${
            process.env.COMPANY_SUPPORT || "support@company.com"
          }`,
          html: `<div style="margin-top: 20px; padding: 15px; border-top: 1px solid #eee; font-size: 12px; color: #666;">
            <p><strong>${
              process.env.COMPANY_NAME || "Leave Management System"
            }</strong></p>
            <p>This email was sent by an automated system. Please do not reply directly to this email.</p>
            <p>For support, contact: <a href="mailto:${
              process.env.COMPANY_SUPPORT || "support@company.com"
            }">${process.env.COMPANY_SUPPORT || "support@company.com"}</a></p>
          </div>`,
        },
        spamCheck: {
          enable: true,
          threshold: 1,
        },
      },
    };

    console.log("📤 Sending via SendGrid API...");
    const response = await sgMail.send(msg);

    console.log("✅ Email sent successfully via SendGrid!");
    console.log("📧 Response status:", response[0]?.statusCode);
    console.log("📧 Message ID:", response[0]?.headers?.["x-message-id"]);

    return {
      success: true,
      messageId: response[0]?.headers?.["x-message-id"],
      response: `SendGrid API - Status: ${response[0]?.statusCode}`,
      provider: "SendGrid API",
      statusCode: response[0]?.statusCode,
    };
  } catch (error) {
    console.error("❌ SendGrid email failed:", error.message);

    if (error.response?.body) {
      console.error(
        "SendGrid error details:",
        JSON.stringify(error.response.body, null, 2)
      );
    }

    throw new Error(`SendGrid email delivery failed: ${error.message}`);
  }
};

module.exports = {
  sendEmailWithSendGrid,
  isConfigured: () =>
    !!(sgMail && (process.env.SENDGRID_API_KEY || process.env.SendGrid_Key)),
};
