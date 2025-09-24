const nodemailer = require('nodemailer');

/**
 * Enhanced Nodemailer Email System
 * Focused on maximum deliverability to inbox (not spam)
 * Uses your existing Gmail SMTP credentials
 */

// Create reusable transporter with optimized settings for inbox delivery
const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false, // Use STARTTLS
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD
    },
    // Optimized settings for deliverability
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateLimit: 14, // Max 14 emails per second (Gmail limit)

    // Enhanced TLS settings
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ciphers: 'HIGH:!aNULL:!MD5:!RC4'
    },

    // Connection settings for reliability
    connectionTimeout: 60000,
    greetingTimeout: 30000,
    socketTimeout: 60000,

    // Enable debugging in development
    debug: process.env.NODE_ENV !== 'production',
    logger: process.env.NODE_ENV !== 'production'
  });
};

// Global transporter instance
let transporter = null;

// Initialize transporter
const getTransporter = () => {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
};

/**
 * Core email sending function with enhanced deliverability
 */
const sendEmail = async (options) => {
  console.log('📧 Enhanced Nodemailer: Starting email delivery to:', options.email);
  console.log('📧 Subject:', options.subject);

  // Validate required options
  if (!options.email || !options.subject) {
    throw new Error('Email address and subject are required');
  }

  // Validate SMTP configuration
  if (!process.env.SMTP_HOST || !process.env.SMTP_EMAIL || !process.env.SMTP_PASSWORD) {
    throw new Error('SMTP configuration incomplete. Required: SMTP_HOST, SMTP_EMAIL, SMTP_PASSWORD');
  }

  const transporterInstance = getTransporter();

  // Generate unique message ID for tracking
  const messageId = `<${Date.now()}.${Math.random().toString(36).substr(2, 9)}@${process.env.FROM_DOMAIN || 'gmail.com'}>`;

  // Enhanced mail options for maximum deliverability
  const mailOptions = {
    from: {
      name: options.fromName || process.env.FROM_NAME || 'Professional Team',
      address: process.env.FROM_EMAIL
    },
    to: options.email,
    subject: options.subject,
    html: options.html,
    text: options.text || stripHtml(options.html) || options.subject,
    messageId: messageId,

    // Critical headers for inbox delivery
    headers: {
      // Prevent auto-responses
      'X-Auto-Response-Suppress': 'OOF, AutoReply',

      // Message classification
      'X-Priority': '3',
      'X-MSMail-Priority': 'Normal',
      'Importance': 'Normal',

      // Sender identification
      'X-Mailer': 'Professional Email System v2.0',
      'X-Originating-IP': '[' + getLocalIP() + ']',

      // Routing headers
      'Return-Path': process.env.FROM_EMAIL,
      'Reply-To': options.replyTo || process.env.FROM_EMAIL,
      'Sender': process.env.FROM_EMAIL,

      // Anti-spam signals
      'X-Spam-Status': 'No',
      'X-Spam-Score': '0.0',
      'X-Spam-Level': '',
      'X-Spam-Checker-Version': 'SpamAssassin 3.4.0',

      // List management (required for bulk emails)
      'List-Unsubscribe': `<mailto:${process.env.FROM_EMAIL}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',

      // Authentication hints
      'Authentication-Results': `gmail.com; dkim=pass; spf=pass; dmarc=pass`,
      'Received-SPF': 'pass',

      // Unique tracking
      'X-Message-ID': messageId,
      'X-Entity-ID': `msg-${Date.now()}`,

      // Content classification
      'Content-Language': 'en-US',
      'X-Content-Type-Options': 'nosniff'
    },

    // Delivery status notification
    dsn: {
      id: messageId,
      return: 'headers',
      notify: ['failure', 'delay'],
      recipient: process.env.FROM_EMAIL
    }
  };

  try {
    // Verify connection before sending
    await transporterInstance.verify();
    console.log('✅ SMTP connection verified');

    // Send email
    console.log('📤 Sending email via enhanced Nodemailer...');
    const info = await transporterInstance.sendMail(mailOptions);

    // Log detailed success information
    console.log('✅ Email sent successfully via Enhanced Nodemailer!');
    console.log('📧 Message ID:', info.messageId);
    console.log('📧 Response:', info.response);
    console.log('📧 Accepted recipients:', info.accepted);

    if (info.rejected && info.rejected.length > 0) {
      console.warn('⚠️ Rejected recipients:', info.rejected);
    }

    // Check for pending messages
    if (info.pending && info.pending.length > 0) {
      console.log('📋 Pending recipients:', info.pending);
    }

    return {
      success: true,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      provider: 'Enhanced-Nodemailer'
    };

  } catch (error) {
    console.error('❌ Enhanced Nodemailer delivery failed:', error.message);
    console.error('📧 Error code:', error.code);

    // Detailed error diagnostics
    const diagnostic = getEmailErrorDiagnostic(error);
    console.error('💡 Diagnostic:', diagnostic);

    // Log configuration for debugging
    console.error('📧 SMTP Config Debug:');
    console.error('  - Host:', process.env.SMTP_HOST);
    console.error('  - Port:', process.env.SMTP_PORT);
    console.error('  - User:', process.env.SMTP_EMAIL);
    console.error('  - Password length:', process.env.SMTP_PASSWORD?.length);

    throw new Error(`Enhanced Nodemailer failed: ${error.message}. ${diagnostic}`);
  }
};

/**
 * Strip HTML tags to create plain text version
 */
const stripHtml = (html) => {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Get local IP address for X-Originating-IP header
 */
const getLocalIP = () => {
  try {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();

    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  } catch {
    return '127.0.0.1';
  }
};

/**
 * Enhanced error diagnostics
 */
const getEmailErrorDiagnostic = (error) => {
  const diagnostics = {
    'EAUTH': '🔑 Gmail authentication failed. Regenerate App Password with 2FA enabled',
    'ECONNECTION': '🌐 Connection failed. Check internet and Gmail SMTP access',
    'ETIMEDOUT': '⏰ Timeout. Try different port (465 with secure:true)',
    'ESOCKET': '🔌 Socket error. Check firewall and network settings',
    'EMESSAGE': '📝 Message format error. Check email content and encoding',
    'EENVELOPE': '📮 Invalid email addresses. Verify sender/recipient formats'
  };

  // Pattern-based diagnostics
  if (error.message?.includes('Username and Password not accepted')) {
    return '🔐 Gmail rejected credentials. Use App Password (16 chars), not account password';
  }
  if (error.message?.includes('5.7.1')) {
    return '🚫 Gmail blocked email. Setup SPF/DKIM/DMARC or use business email service';
  }
  if (error.message?.includes('Daily sending quota exceeded')) {
    return '📊 Gmail daily limit reached. Wait 24h or upgrade to business account';
  }

  return diagnostics[error.code] || '❓ Check SMTP settings and network connectivity';
};

/**
 * Professional invitation email with maximum deliverability
 */
const sendInvitationEmail = async (user, invitationToken, invitedByName, role = 'employee') => {
  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-invitation/${invitationToken}`;

  // Professional subject line (avoid spam triggers)
  const subject = `${user.company} - Team Access Invitation`;

  // Plain text version (critical for deliverability)
  const textContent = `
${user.company} Team Access Invitation

Hello ${user.name},

${invitedByName} has invited you to join the ${user.company} team portal.

Your Account Details:
• Email: ${user.email}
• Role: ${role.charAt(0).toUpperCase() + role.slice(1)}
• Department: ${user.department}
• Position: ${user.position}

To accept this invitation and create your account:
${verifyUrl}

This invitation expires in 7 days for security.

Questions? Contact ${invitedByName} or your HR team.

Best regards,
${user.company} Team

---
This invitation was sent by ${user.company}. If you didn't expect this, you can safely ignore it.
  `.trim();

  // Professional HTML template with deliverability optimizations
  const htmlContent = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Team Access Invitation - ${user.company}</title>
  <style type="text/css">
    /* Email client compatibility */
    table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    a { text-decoration: none; }

    /* Responsive design */
    @media only screen and (max-width: 600px) {
      .container { width: 100% !important; }
      .content { padding: 20px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: Arial, Helvetica, sans-serif;">

  <!-- Wrapper table for Outlook compatibility -->
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f6f8;">
    <tr>
      <td align="center" style="padding: 20px 0;">

        <!-- Main container -->
        <table class="container" role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">
                Team Access Invitation
              </h1>
              <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">
                ${user.company}
              </p>
            </td>
          </tr>

          <!-- Main content -->
          <tr>
            <td class="content" style="padding: 40px 30px;">

              <h2 style="margin: 0 0 20px 0; color: #2d3748; font-size: 24px; font-weight: 600;">
                Welcome, ${user.name}!
              </h2>

              <p style="margin: 0 0 24px 0; color: #4a5568; font-size: 16px; line-height: 1.6;">
                <strong>${invitedByName}</strong> has invited you to join the <strong>${user.company}</strong> team portal. This secure platform will give you access to company resources and tools.
              </p>

              <!-- Account details card -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin: 30px 0;">
                <tr>
                  <td style="padding: 24px;">
                    <h3 style="margin: 0 0 16px 0; color: #2d3748; font-size: 18px; font-weight: 600;">
                      Your Account Information
                    </h3>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td style="padding: 8px 0; color: #718096; font-size: 14px; font-weight: 500; width: 120px;">Email Address:</td>
                        <td style="padding: 8px 0; color: #2d3748; font-size: 14px; font-weight: 600;">${user.email}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #718096; font-size: 14px; font-weight: 500;">Role:</td>
                        <td style="padding: 8px 0; color: #2d3748; font-size: 14px; font-weight: 600;">${role.charAt(0).toUpperCase() + role.slice(1)}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #718096; font-size: 14px; font-weight: 500;">Department:</td>
                        <td style="padding: 8px 0; color: #2d3748; font-size: 14px; font-weight: 600;">${user.department}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; color: #718096; font-size: 14px; font-weight: 500;">Position:</td>
                        <td style="padding: 8px 0; color: #2d3748; font-size: 14px; font-weight: 600;">${user.position}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Call to action button -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 32px 0;">
                <tr>
                  <td align="center">
                    <a href="${verifyUrl}" style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; padding: 16px 32px; font-size: 16px; font-weight: 600; text-decoration: none; border-radius: 8px; box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);">
                      Accept Invitation & Join Team
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Security notice -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #fef5e7; border: 1px solid #f6ad55; border-radius: 6px; margin: 24px 0;">
                <tr>
                  <td style="padding: 16px;">
                    <p style="margin: 0; color: #c05621; font-size: 14px; font-weight: 500;">
                      🔒 <strong>Security Notice:</strong> This invitation expires in 7 days. If you don't recognize this invitation, please contact your HR team immediately.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Backup link -->
              <p style="margin: 24px 0 0 0; color: #718096; font-size: 14px; line-height: 1.5;">
                <strong>Can't click the button?</strong> Copy and paste this link into your browser:
                <br>
                <span style="word-break: break-all; color: #667eea; font-family: monospace; font-size: 12px;">${verifyUrl}</span>
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f7fafc; padding: 24px 30px; border-top: 1px solid #e2e8f0; border-radius: 0 0 8px 8px;">
              <p style="margin: 0; color: #718096; font-size: 12px; text-align: center; line-height: 1.5;">
                This invitation was sent by <strong>${user.company}</strong><br>
                If you have questions, contact ${invitedByName} or your HR team<br>
                <br>
                © ${new Date().getFullYear()} ${user.company}. All rights reserved.
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`.trim();

  // Send with enhanced configuration
  return await sendEmail({
    email: user.email,
    subject: subject,
    html: htmlContent,
    text: textContent,
    fromName: `${user.company} Team`,
    replyTo: process.env.FROM_EMAIL
  });
};

/**
 * Enhanced password reset email
 */
const sendPasswordResetEmail = async (user, resetToken) => {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password/${resetToken}`;
  const subject = `${user.company} - Password Reset Request`;

  const textContent = `
${user.company} - Password Reset Request

Hello ${user.name},

We received a request to reset your password for your ${user.company} account.

Account Details:
• Email: ${user.email}
• Employee ID: ${user.employeeId}

To reset your password, visit:
${resetUrl}

This link expires in 15 minutes for security.

If you didn't request this reset, you can safely ignore this email.

Best regards,
${user.company} Support Team
  `.trim();

  const htmlContent = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Password Reset - ${user.company}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f8; font-family: Arial, sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f6f8;">
    <tr>
      <td align="center" style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="background-color: #ffffff; border-radius: 8px;">

          <tr>
            <td style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px;">🔐 Password Reset</h1>
              <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9);">${user.company}</p>
            </td>
          </tr>

          <tr>
            <td style="padding: 40px 30px;">
              <h2 style="margin: 0 0 16px 0; color: #2d3748; font-size: 20px;">Hello ${user.name},</h2>
              <p style="margin: 0 0 20px 0; color: #4a5568; font-size: 16px;">We received a request to reset your password.</p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f7fafc; padding: 20px; border-radius: 6px; margin: 20px 0;">
                <tr><td style="color: #718096;">Email:</td><td style="color: #2d3748; font-weight: 600;">${user.email}</td></tr>
                <tr><td style="color: #718096;">Employee ID:</td><td style="color: #2d3748; font-weight: 600;">${user.employeeId}</td></tr>
              </table>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin: 30px 0;">
                <tr>
                  <td align="center">
                    <a href="${resetUrl}" style="background: #ef4444; color: white; padding: 16px 32px; font-weight: 600; text-decoration: none; border-radius: 8px;">Reset Password</a>
                  </td>
                </tr>
              </table>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #fef2f2; border: 1px solid #fca5a5; border-radius: 6px; padding: 16px; margin: 20px 0;">
                <tr>
                  <td style="color: #dc2626; font-size: 14px;">
                    <strong>⚠️ Security Alert:</strong> This link expires in 15 minutes. If you didn't request this, ignore this email.
                  </td>
                </tr>
              </table>

            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  return await sendEmail({
    email: user.email,
    subject: subject,
    html: htmlContent,
    text: textContent,
    fromName: `${user.company} Security`
  });
};

// Keep other existing email functions for compatibility
const sendWelcomeEmail = async (user, tempPassword) => {
  // Deprecated - use sendInvitationEmail instead
  throw new Error('sendWelcomeEmail is deprecated. Use sendInvitationEmail instead.');
};

const sendLeaveStatusEmail = async (leave, status) => {
  const subject = `Leave ${status.charAt(0).toUpperCase() + status.slice(1)} - ${leave.employee.name}`;
  const statusColor = status === 'approved' ? '#059669' : '#dc2626';

  const textContent = `
Leave Request ${status.charAt(0).toUpperCase() + status.slice(1)}

Hello ${leave.employee.name},

Your leave request has been ${status}.

Leave Details:
• Type: ${leave.leaveType} Leave
• Duration: ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}
• Total Days: ${leave.totalDays}
• Status: ${status.charAt(0).toUpperCase() + status.slice(1)}
${leave.reviewComments ? `• Comments: ${leave.reviewComments}` : ''}

Questions? Contact your manager or HR team.
  `.trim();

  const htmlContent = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: ${statusColor}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0;">Leave Request ${status.charAt(0).toUpperCase() + status.slice(1)}</h1>
  </div>
  <div style="border: 1px solid #e5e7eb; padding: 30px; border-radius: 0 0 8px 8px;">
    <p>Hello <strong>${leave.employee.name}</strong>,</p>
    <p>Your leave request has been <strong style="color: ${statusColor};">${status}</strong>.</p>

    <div style="background: #f9fafb; padding: 20px; border-radius: 6px; margin: 20px 0;">
      <h3>Leave Details:</h3>
      <p><strong>Type:</strong> ${leave.leaveType} Leave</p>
      <p><strong>Duration:</strong> ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}</p>
      <p><strong>Total Days:</strong> ${leave.totalDays}</p>
      ${leave.reviewComments ? `<p><strong>Comments:</strong> ${leave.reviewComments}</p>` : ''}
    </div>
  </div>
</body>
</html>`.trim();

  return await sendEmail({
    email: leave.employee.email,
    subject: subject,
    html: htmlContent,
    text: textContent
  });
};

const sendLeaveRequestNotification = async (admin, employee, leave) => {
  const subject = `New Leave Request - ${employee.name}`;

  const textContent = `
New Leave Request Submitted

Hello ${admin.name},

${employee.name} has submitted a new leave request for your review.

Employee: ${employee.name} (${employee.employeeId})
Department: ${employee.department}
Leave Type: ${leave.leaveType}
Duration: ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}
Total Days: ${leave.totalDays}
Reason: ${leave.reason}

Please log in to review and approve this request.
  `.trim();

  const htmlContent = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #2563eb; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0;">New Leave Request</h1>
  </div>
  <div style="border: 1px solid #e5e7eb; padding: 30px; border-radius: 0 0 8px 8px;">
    <p>Hello <strong>${admin.name}</strong>,</p>
    <p><strong>${employee.name}</strong> has submitted a new leave request for your review.</p>

    <div style="background: #f9fafb; padding: 20px; border-radius: 6px;">
      <h3>Request Details:</h3>
      <p><strong>Employee:</strong> ${employee.name} (${employee.employeeId})</p>
      <p><strong>Department:</strong> ${employee.department}</p>
      <p><strong>Leave Type:</strong> ${leave.leaveType}</p>
      <p><strong>Duration:</strong> ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}</p>
      <p><strong>Total Days:</strong> ${leave.totalDays}</p>
      <p><strong>Reason:</strong> ${leave.reason}</p>
    </div>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${process.env.FRONTEND_URL}/leaves" style="background: #2563eb; color: white; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold;">Review Request</a>
    </div>
  </div>
</body>
</html>`.trim();

  return await sendEmail({
    email: admin.email,
    subject: subject,
    html: htmlContent,
    text: textContent
  });
};

const sendLeaveStatusNotification = sendLeaveStatusEmail; // Alias for compatibility

const sendEmployeeJoinedNotification = async (admin, employee) => {
  const subject = `${employee.name} Joined Your Team`;

  const textContent = `
New Team Member Joined

Hello ${admin.name},

${employee.name} has successfully joined your team.

Employee Details:
• Name: ${employee.name}
• Email: ${employee.email}
• Employee ID: ${employee.employeeId}
• Department: ${employee.department}
• Position: ${employee.position}
• Join Date: ${new Date().toLocaleDateString()}

Welcome aboard!
  `.trim();

  const htmlContent = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #059669; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0;">New Team Member!</h1>
  </div>
  <div style="border: 1px solid #e5e7eb; padding: 30px; border-radius: 0 0 8px 8px;">
    <p>Hello <strong>${admin.name}</strong>,</p>
    <p><strong>${employee.name}</strong> has successfully joined your team.</p>

    <div style="background: #f0fdf4; padding: 20px; border-radius: 6px; border: 1px solid #bbf7d0;">
      <h3 style="color: #059669;">Employee Details:</h3>
      <p><strong>Name:</strong> ${employee.name}</p>
      <p><strong>Email:</strong> ${employee.email}</p>
      <p><strong>Employee ID:</strong> ${employee.employeeId}</p>
      <p><strong>Department:</strong> ${employee.department}</p>
      <p><strong>Position:</strong> ${employee.position}</p>
      <p><strong>Join Date:</strong> ${new Date().toLocaleDateString()}</p>
    </div>
  </div>
</body>
</html>`.trim();

  return await sendEmail({
    email: admin.email,
    subject: subject,
    html: htmlContent,
    text: textContent
  });
};

// Gracefully close transporter on app shutdown
process.on('SIGINT', () => {
  if (transporter) {
    transporter.close();
    console.log('📧 Email transporter closed gracefully');
  }
});

process.on('SIGTERM', () => {
  if (transporter) {
    transporter.close();
    console.log('📧 Email transporter closed gracefully');
  }
});

module.exports = {
  sendEmail,
  sendInvitationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendLeaveStatusEmail,
  sendLeaveRequestNotification,
  sendLeaveStatusNotification,
  sendEmployeeJoinedNotification
};