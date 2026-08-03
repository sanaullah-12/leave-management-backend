// Email delivery is SMTP-only. The transport itself — config validation, TLS
// mode selection, connection verification, retry/backoff, error diagnosis and
// logging — lives in ./smtp, split by responsibility. This file owns only the
// message templates and the app-level send API.
const { sendMail } = require("./smtp");

/**
 * Send an email over SMTP.
 * Throws on failure with `.smtpDiagnosis` describing cause and suggested fix.
 */
const sendEmail = async ({ email, subject, html, text, fromName }) =>
  sendMail({ email, subject, html, text, fromName });

// Employee invitation email
const sendInvitationEmail = async (
  employee,
  token,
  inviterName,
  role = "employee"
) => {
  try {
    // Smart URL detection:
    // - In production use FRONTEND_URL (required)
    // - In development prefer FRONTEND_URL_DEV if provided, otherwise localhost
    let frontendUrl;
    if (process.env.NODE_ENV === "production") {
      frontendUrl = process.env.FRONTEND_URL || "https://your-app.vercel.app";
    } else {
      frontendUrl =
        process.env.FRONTEND_URL_DEV ||
        process.env.FRONTEND_URL ||
        "http://localhost:3000";
    }

    console.log("🌐 Using frontend URL for invites:", frontendUrl);
    console.log("🌐 NODE_ENV:", process.env.NODE_ENV);

    const inviteUrl = `${frontendUrl.replace(/\/+$/, "")}/invite/${token}`;

    const subject = `${employee.company} - Team Access Invitation`;

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Team Invitation</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 28px; font-weight: 300;">Welcome to ${
          employee.company
        }!</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">You've been invited to join our team</p>
    </div>

    <div style="background: #ffffff; padding: 40px; border: 1px solid #e1e5e9; border-top: none; border-radius: 0 0 10px 10px;">
        <h2 style="color: #2c3e50; margin-top: 0;">Hello ${employee.name}!</h2>

        <p>Great news! <strong>${inviterName}</strong> has invited you to join <strong>${
      employee.company
    }</strong> as a <strong>${employee.position}</strong> in the <strong>${
      employee.department
    }</strong> department.</p>

        <div style="background: #f8f9fa; border-left: 4px solid #007bff; padding: 20px; margin: 25px 0;">
            <h3 style="margin-top: 0; color: #007bff;">Your Role Details:</h3>
            <ul style="margin: 0; padding-left: 20px;">
                <li><strong>Position:</strong> ${employee.position}</li>
                <li><strong>Department:</strong> ${employee.department}</li>
                <li><strong>Company:</strong> ${employee.company}</li>
            </ul>
        </div>

        <p>To complete your registration and set up your account, please click the button below:</p>

        <div style="text-align: center; margin: 30px 0;">
            <a href="${inviteUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 50px; font-weight: bold; font-size: 16px;">Accept Invitation</a>
        </div>

        <p style="font-size: 14px; color: #6c757d;">If the button doesn't work, copy and paste this link into your browser:</p>
        <p style="font-size: 12px; word-break: break-all; background: #f8f9fa; padding: 10px; border-radius: 5px;">${inviteUrl}</p>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 14px; color: #6c757d;">
            <p><strong>Important:</strong> This invitation will expire in 7 days for security reasons.</p>
            <p>If you have any questions, please contact your team administrator or reply to this email.</p>
        </div>
    </div>

    <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #6c757d;">
        <p>This email was sent by ${
          employee.company
        } Nexora</p>
        <p>If you didn't expect this invitation, please ignore this email.</p>
        <p style="margin-top: 10px; color: #999;">Environment: ${
          process.env.NODE_ENV || "development"
        }</p>
    </div>
</body>
</html>`;

    return await sendEmail({
      email: employee.email,
      subject,
      html,
      fromName: employee.company,
    });
  } catch (error) {
    console.error("❌ Failed to send invitation email:", error);
    throw error;
  }
};

// Password reset email - apply same URL logic
const sendPasswordResetEmail = async (user, token) => {
  try {
    let frontendUrl;
    if (process.env.NODE_ENV === "production") {
      frontendUrl = process.env.FRONTEND_URL || "https://your-app.vercel.app";
    } else {
      frontendUrl =
        process.env.FRONTEND_URL_DEV ||
        process.env.FRONTEND_URL ||
        "http://localhost:3000";
    }

    console.log("🌐 Using frontend URL for password reset:", frontendUrl);

    // Must be a PATH param (/reset-password/:token) to match the frontend
    // route in App.tsx. A ?token= query string leaves the page with an
    // undefined token and the reset silently fails.
    const resetUrl = `${frontendUrl.replace(
      /\/+$/,
      ""
    )}/reset-password/${token}`;

    const subject = `${user.company} - Password Reset Request`;

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Password Reset</title>
</head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%); color: white; padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
        <h1 style="margin: 0; font-size: 28px; font-weight: 300;">Password Reset</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">Secure password reset for your account</p>
    </div>

    <div style="background: #ffffff; padding: 40px; border: 1px solid #e1e5e9; border-top: none; border-radius: 0 0 10px 10px;">
        <h2 style="color: #2c3e50; margin-top: 0;">Hello ${user.name}!</h2>

        <p>You requested a password reset for your account at <strong>${user.company}</strong>.</p>

        <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 20px; margin: 25px 0;">
            <h3 style="margin-top: 0; color: #856404;">Security Information:</h3>
            <ul style="margin: 0; padding-left: 20px;">
                <li><strong>Account:</strong> ${user.email}</li>
                <li><strong>Employee ID:</strong> ${user.employeeId}</li>
                <li><strong>Company:</strong> ${user.company}</li>
            </ul>
        </div>

        <p>To reset your password, click the button below:</p>

        <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%); color: white; text-decoration: none; padding: 15px 30px; border-radius: 50px; font-weight: bold; font-size: 16px;">Reset Password</a>
        </div>

        <p style="font-size: 14px; color: #6c757d;">If the button doesn't work, copy and paste this link into your browser:</p>
        <p style="font-size: 12px; word-break: break-all; background: #f8f9fa; padding: 10px; border-radius: 5px;">${resetUrl}</p>

        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 14px; color: #6c757d;">
            <p><strong>Important:</strong> This reset link will expire in 15 minutes for security reasons.</p>
            <p>If you didn't request this password reset, please ignore this email and your password will remain unchanged.</p>
        </div>
    </div>

    <div style="text-align: center; margin-top: 20px; font-size: 12px; color: #6c757d;">
        <p>This email was sent by ${user.company} Nexora</p>
        <p>For security reasons, never share this reset link with anyone.</p>
    </div>
</body>
</html>`;

    return await sendEmail({
      email: user.email,
      subject,
      html,
      fromName: user.company,
    });
  } catch (error) {
    console.error("❌ Failed to send password reset email:", error);
    throw error;
  }
};

// Send leave request notification to admins
const sendLeaveRequestNotification = async (admin, employee, leave) => {
  const frontendUrl =
    process.env.NODE_ENV === "production"
      ? process.env.FRONTEND_URL || "https://your-app.vercel.app"
      : process.env.FRONTEND_URL_DEV ||
        process.env.FRONTEND_URL ||
        "http://localhost:3000";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1 style="color: #2563eb;">Nexora</h1>
      <h2 style="color: #333;">New Leave Request</h2>
      <p>Hello ${admin.name},</p>
      <p><strong>${
        employee.name
      }</strong> has submitted a new leave request.</p>

      <div style="background: #f8f9fa; padding: 20px; border-radius: 6px; margin: 25px 0;">
        <h3>Request Details:</h3>
        <p><strong>Employee:</strong> ${employee.name} (${
    employee.employeeId
  })</p>
        <p><strong>Department:</strong> ${employee.department}</p>
        <p><strong>Leave Type:</strong> ${leave.leaveType}</p>
        <p><strong>Duration:</strong> ${new Date(
          leave.startDate
        ).toLocaleDateString()} to ${new Date(
    leave.endDate
  ).toLocaleDateString()}</p>
        <p><strong>Total Days:</strong> ${leave.totalDays}</p>
        <p><strong>Reason:</strong> ${leave.reason}</p>
      </div>

      <div style="text-align: center;">
        <a href="${frontendUrl.replace(
          /\/+$/,
          ""
        )}/leaves" style="background: #2563eb; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Review Leave Request
        </a>
      </div>
    </div>
  `;

  await sendEmail({
    email: admin.email,
    subject: `New Leave Request from ${employee.name} - Requires Review`,
    html,
    category: "leave-notification",
  });
};

// Send leave status notification to employee
const sendLeaveStatusNotification = async (employee, leave, reviewedBy) => {
  const statusColor = leave.status === "approved" ? "#059669" : "#dc2626";
  const statusText =
    leave.status.charAt(0).toUpperCase() + leave.status.slice(1);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1 style="color: #2563eb;">Nexora</h1>
      <h2 style="color: ${statusColor};">Leave Request ${statusText}</h2>
      <p>Hello ${employee.name},</p>
      <p>Your leave request has been <strong style="color: ${statusColor};">${
    leave.status
  }</strong> by ${reviewedBy.name}.</p>

      <div style="background: #f8f9fa; padding: 20px; border-radius: 6px;">
        <h3>Leave Details:</h3>
        <p><strong>Leave Type:</strong> ${leave.leaveType}</p>
        <p><strong>Duration:</strong> ${new Date(
          leave.startDate
        ).toLocaleDateString()} to ${new Date(
    leave.endDate
  ).toLocaleDateString()}</p>
        <p><strong>Status:</strong> <span style="color: ${statusColor};">${statusText}</span></p>
        ${
          leave.reviewComments
            ? `<p><strong>Comments:</strong> ${leave.reviewComments}</p>`
            : ""
        }
      </div>
    </div>
  `;

  await sendEmail({
    email: employee.email,
    subject: `Leave Request ${statusText} - ${leave.leaveType} Leave`,
    html,
    category: "leave-status",
  });
};

module.exports = {
  sendEmail,
  sendInvitationEmail,
  sendPasswordResetEmail,
  sendLeaveRequestNotification,
  sendLeaveStatusNotification,
};
