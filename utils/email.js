const nodemailer = require('nodemailer');
const { sendEmailWithSendGrid, isConfigured: isSendGridConfigured } = require('./sendgridEmail');

// Create fresh transporter for each request to prevent hanging
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false, // Use STARTTLS
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD
    },
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    },
    // Connection timeouts and limits
    connectionTimeout: 10000, // 10 seconds to connect
    greetingTimeout: 5000,    // 5 seconds for greeting
    socketTimeout: 15000,     // 15 seconds for socket inactivity
    // Pool settings for better performance
    pool: false, // Don't use connection pooling to prevent hanging
    maxConnections: 1,
    maxMessages: 1
  });
};

// Smart email function - tries SendGrid first, falls back to SMTP
const sendEmail = async ({ email, subject, html, text, fromName }) => {
  // Try SendGrid first if configured (recommended for Railway)
  if (isSendGridConfigured()) {
    try {
      console.log('🚀 Using SendGrid API for email delivery');
      return await sendEmailWithSendGrid({ email, subject, html, text, fromName });
    } catch (error) {
      console.error('⚠️ SendGrid failed, falling back to SMTP:', error.message);
      // Continue to SMTP fallback below
    }
  }

  // Fallback to SMTP (requires proper Gmail App Password on Railway)
  try {
    console.log('📧 Using SMTP for email delivery');
    console.log('📧 Recipient:', email);
    console.log('📧 Subject:', subject);

    const transporter = createTransporter();

    // Verify connection
    console.log('🔍 Verifying SMTP connection...');
    await transporter.verify();
    console.log('✅ SMTP connection verified');

    // Generate text from HTML if not provided
    const textContent = text || html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

    const mailOptions = {
      from: `${fromName || process.env.FROM_NAME || 'Leave Management System'} <${process.env.FROM_EMAIL || process.env.SMTP_EMAIL}>`,
      to: email,
      subject: subject,
      text: textContent,
      html: html,
      headers: {
        'X-Mailer': 'Leave Management System',
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal',
        'Importance': 'Normal'
      }
    };

    console.log('📤 Sending email via SMTP...');
    const result = await transporter.sendMail(mailOptions);

    console.log('✅ Email sent successfully via SMTP!');
    console.log('📧 Message ID:', result.messageId);
    console.log('📧 Response:', result.response);
    console.log('📧 Accepted recipients:', result.accepted);

    // Close transporter to prevent hanging connections
    transporter.close();
    console.log('🔐 SMTP connection closed');

    return {
      success: true,
      messageId: result.messageId,
      response: result.response,
      accepted: result.accepted,
      rejected: result.rejected,
      provider: 'SMTP-Fallback'
    };

  } catch (error) {
    console.error('❌ SMTP email failed:', error.message);
    console.error('Full error:', error);

    // Close transporter on error
    if (typeof transporter !== 'undefined' && transporter) {
      transporter.close();
      console.log('🔐 SMTP connection closed (error)');
    }

    throw new Error(`Email delivery failed: ${error.message}`);
  }
};

// Employee invitation email
const sendInvitationEmail = async (employee, token, inviterName, role = 'employee') => {
  try {
    const inviteUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/invite/${token}`;

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
        <h1 style="margin: 0; font-size: 28px; font-weight: 300;">Welcome to ${employee.company}!</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">You've been invited to join our team</p>
    </div>

    <div style="background: #ffffff; padding: 40px; border: 1px solid #e1e5e9; border-top: none; border-radius: 0 0 10px 10px;">
        <h2 style="color: #2c3e50; margin-top: 0;">Hello ${employee.name}!</h2>

        <p>Great news! <strong>${inviterName}</strong> has invited you to join <strong>${employee.company}</strong> as a <strong>${employee.position}</strong> in the <strong>${employee.department}</strong> department.</p>

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
        <p>This email was sent by ${employee.company} Leave Management System</p>
        <p>If you didn't expect this invitation, please ignore this email.</p>
    </div>
</body>
</html>`;

    return await sendEmail({
      email: employee.email,
      subject,
      html,
      fromName: employee.company
    });

  } catch (error) {
    console.error('❌ Failed to send invitation email:', error);
    throw error;
  }
};

// Password reset email
const sendPasswordResetEmail = async (user, token) => {
  try {
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${token}`;

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
        <p>This email was sent by ${user.company} Leave Management System</p>
        <p>For security reasons, never share this reset link with anyone.</p>
    </div>
</body>
</html>`;

    return await sendEmail({
      email: user.email,
      subject,
      html,
      fromName: user.company
    });

  } catch (error) {
    console.error('❌ Failed to send password reset email:', error);
    throw error;
  }
};

module.exports = {
  sendEmail,
  sendInvitationEmail,
  sendPasswordResetEmail
};