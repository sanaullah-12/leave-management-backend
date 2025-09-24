const nodemailer = require('nodemailer');

/**
 * Enhanced email sending utility with proper deliverability configuration
 * Addresses common Gmail blocking issues (550 5.7.1) with authentication and DNS records
 */
const sendEmail = async (options) => {
  console.log('📧 Email delivery process started for:', options.email);
  console.log('📧 Email subject:', options.subject);

  const isProduction = process.env.NODE_ENV === 'production';
  console.log('🌍 Environment:', process.env.NODE_ENV);

  // Check if SendGrid is properly configured (prioritize for production)
  const sendGridKey = process.env.SendGrid_Key || process.env.SENDGRID_API_KEY;
  const isSendGridConfigured = sendGridKey &&
                               sendGridKey !== 'your_sendgrid_api_key_here' &&
                               sendGridKey.startsWith('SG.') &&
                               sendGridKey.length > 50;

  console.log('🔍 Email provider check:');
  console.log('  - Will use:', (isProduction && isSendGridConfigured) ? 'SendGrid' : 'Enhanced SMTP');

  if (isProduction && isSendGridConfigured) {
    return await sendViaTransactionalService(options, sendGridKey);
  } else {
    return await sendViaEnhancedSMTP(options, isProduction);
  }
};

/**
 * Send via transactional email service (SendGrid) - Best for production
 */
const sendViaTransactionalService = async (options, sendGridKey) => {
  console.log('🔑 Using SendGrid for email delivery...');

  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(sendGridKey);

  // Enhanced SendGrid configuration for maximum deliverability
  const mailOptions = {
    from: {
      email: process.env.FROM_EMAIL,
      name: options.fromName || process.env.FROM_NAME || 'Leave Management System'
    },
    to: options.email,
    subject: options.subject,
    html: options.html,
    text: options.text,
    categories: ['leave-management', options.category || 'general'],
    customArgs: {
      'system': 'leave-management',
      'version': '1.0',
      'environment': process.env.NODE_ENV || 'development'
    },
    headers: {
      'X-Priority': '3',
      'X-MSMail-Priority': 'Normal',
      'Importance': 'Normal',
      'X-Mailer': 'Leave Management System v1.0',
      'List-Unsubscribe': `<mailto:${process.env.FROM_EMAIL}?subject=unsubscribe>`,
      'Return-Path': process.env.FROM_EMAIL,
      'Reply-To': process.env.REPLY_TO_EMAIL || process.env.FROM_EMAIL,
      'X-Entity-Ref-ID': `lms-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      'Message-ID': `<${Date.now()}.${Math.random().toString(36).substr(2, 9)}@${process.env.FROM_DOMAIN || 'leavemanagement.system'}>`,
      'X-Authenticated-Sender': process.env.FROM_EMAIL,
      'X-Auto-Response-Suppress': 'OOF, DR, RN, NRN, AutoReply'
    },
    trackingSettings: {
      clickTracking: { enable: false },
      openTracking: { enable: false },
      subscriptionTracking: { enable: false }
    },
    asm: {
      group_id: 1,
      groups_to_display: [1]
    }
  };

  try {
    console.log('📤 Sending via SendGrid to:', options.email);
    const response = await sgMail.send(mailOptions);

    console.log('✅ Email sent successfully via SendGrid!');
    console.log('📧 Response status:', response[0]?.statusCode);

    return {
      success: true,
      messageId: response[0]?.headers?.['x-message-id'],
      provider: 'SendGrid',
      statusCode: response[0]?.statusCode
    };
  } catch (error) {
    console.error('❌ SendGrid delivery failed:', error.message);

    // Detailed error diagnostics
    if (error.code === 401) {
      console.error('💡 Invalid API Key - verify SendGrid configuration');
    } else if (error.code === 403) {
      console.error('💡 Sender email not verified in SendGrid dashboard');
    } else if (error.message?.includes('verify')) {
      console.error('💡 Add and verify sender email in SendGrid dashboard');
    }

    // Fallback to SMTP if configured
    if (process.env.SMTP_HOST && process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
      console.warn('🔄 Falling back to enhanced SMTP...');
      return await sendViaEnhancedSMTP(options, true);
    }

    throw new Error(`SendGrid failed: ${error.message}`);
  }
};

/**
 * Send via enhanced SMTP with proper authentication and deliverability settings
 */
const sendViaEnhancedSMTP = async (options, isProduction) => {
  console.log('📤 Using enhanced SMTP configuration...');

  // Validate SMTP configuration
  const requiredVars = ['SMTP_HOST', 'SMTP_EMAIL', 'SMTP_PASSWORD'];
  const missing = requiredVars.filter(varName => !process.env[varName]);
  if (missing.length > 0) {
    throw new Error(`Missing SMTP configuration: ${missing.join(', ')}`);
  }

  // Enhanced SMTP transporter configuration
  const transporter = nodemailer.createTransporter({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT === '465', // true for 465, false for 587
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD
    },
    // Connection pool settings for better performance
    pool: true,
    rateLimit: true,
    maxConnections: 3,
    maxMessages: 100,

    // Enhanced timeout settings
    connectionTimeout: 60000,
    greetingTimeout: 30000,
    socketTimeout: 60000,

    // Enhanced TLS/SSL configuration
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      // Use modern cipher suites
      ciphers: [
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES256-SHA384',
        'ECDHE-RSA-AES128-SHA256'
      ].join(':'),
      servername: process.env.SMTP_HOST
    },

    // DKIM configuration (if available)
    dkim: process.env.DKIM_PRIVATE_KEY ? {
      domainName: process.env.DKIM_DOMAIN || process.env.FROM_DOMAIN,
      keySelector: process.env.DKIM_SELECTOR || 'default',
      privateKey: process.env.DKIM_PRIVATE_KEY
    } : undefined,

    // Debug settings
    logger: process.env.NODE_ENV !== 'production',
    debug: process.env.NODE_ENV !== 'production'
  });

  // Enhanced mail options with proper headers for deliverability
  const mailOptions = {
    from: {
      name: options.fromName || process.env.FROM_NAME || 'Leave Management System',
      address: process.env.FROM_EMAIL
    },
    to: options.email,
    subject: options.subject,
    html: options.html,
    text: options.text,

    // Deliverability headers
    headers: {
      'X-Priority': '3',
      'X-MSMail-Priority': 'Normal',
      'Importance': 'Normal',
      'X-Mailer': 'Leave Management System v1.0',

      // Authentication and routing headers
      'Return-Path': process.env.FROM_EMAIL,
      'Reply-To': process.env.REPLY_TO_EMAIL || process.env.FROM_EMAIL,
      'Sender': process.env.FROM_EMAIL,

      // Unique identifiers
      'Message-ID': `<${Date.now()}.${Math.random().toString(36).substr(2, 9)}@${process.env.FROM_DOMAIN || 'localhost'}>`,
      'X-Entity-Ref-ID': `lms-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,

      // Anti-spam headers
      'X-Spam-Status': 'No',
      'X-Auto-Response-Suppress': 'OOF, DR, RN, NRN, AutoReply',
      'Precedence': 'bulk',

      // Unsubscribe compliance
      'List-Unsubscribe': `<mailto:${process.env.FROM_EMAIL}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',

      // Custom tracking
      'X-Campaign-Name': options.category || 'general',
      'X-Application': 'leave-management-system'
    },

    // DSN (Delivery Status Notification) settings
    dsn: {
      id: `lms-${Date.now()}`,
      return: 'hdrs',
      notify: ['success', 'failure', 'delay'],
      recipient: process.env.FROM_EMAIL
    }
  };

  try {
    console.log('📤 Sending via enhanced SMTP...');
    console.log('📧 SMTP Host:', process.env.SMTP_HOST);
    console.log('📧 SMTP Port:', process.env.SMTP_PORT || 587);
    console.log('📧 From:', mailOptions.from);

    const info = await transporter.sendMail(mailOptions);

    console.log('✅ Email sent successfully via SMTP!');
    console.log('✉️ Message ID:', info.messageId);
    console.log('📧 Accepted:', info.accepted);
    console.log('📧 Rejected:', info.rejected);

    // Log warnings for rejected recipients
    if (info.rejected && info.rejected.length > 0) {
      console.warn('⚠️ Some recipients were rejected:', info.rejected);
    }

    return {
      success: true,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      provider: 'Enhanced-SMTP'
    };

  } catch (error) {
    console.error('❌ Enhanced SMTP delivery failed:', error.message);
    console.error('🔍 Error code:', error.code);

    // Provide specific error diagnostics and solutions
    let errorHint = getEmailErrorDiagnostic(error);
    console.error(errorHint);

    throw new Error(`Enhanced SMTP failed: ${error.message}. ${errorHint}`);
  }
};

/**
 * Get diagnostic information for email errors
 */
const getEmailErrorDiagnostic = (error) => {
  const diagnostics = {
    'EAUTH': '💡 Authentication failed. For Gmail: Enable 2FA and use App Password (16 chars, no spaces)',
    'ECONNECTION': '💡 Connection failed. Check SMTP host/port. For Gmail use smtp.gmail.com:587',
    'ETIMEDOUT': '💡 Timeout. Check network/firewall. Try port 465 (SSL) instead of 587 (STARTTLS)',
    'ESOCKET': '💡 Socket error. Verify SMTP server is accessible',
    'EENVELOPE': '💡 Invalid email addresses. Check FROM_EMAIL format',
    'EMESSAGE': '💡 Message format error. Check email content encoding'
  };

  // Check for specific error patterns
  if (error.message?.includes('Username and Password not accepted')) {
    return '💡 Gmail rejected credentials. Generate new App Password with 2FA enabled';
  }
  if (error.message?.includes('Invalid login')) {
    return '💡 Invalid credentials. For Gmail: use email + App Password, not account password';
  }
  if (error.message?.includes('5.7.1')) {
    return '💡 Gmail blocked (5.7.1). Setup SPF/DKIM/DMARC DNS records and verify sender domain';
  }

  return diagnostics[error.code] || '💡 Check SMTP configuration and DNS records';
};

// Keep all existing email template functions unchanged...
const sendInvitationEmail = async (user, invitationToken, invitedByName, role = 'employee') => {
  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-invitation/${invitationToken}`;

  const textContent = `
Welcome to ${user.company} - Account Setup

Hello ${user.name},

You have been invited by ${invitedByName} to join ${user.company} through our Leave Management System.

Your Account Information:
- Email: ${user.email}
- Role: ${role.charAt(0).toUpperCase() + role.slice(1)}
- Department: ${user.department}
- Position: ${user.position}

To complete your account setup, please visit: ${verifyUrl}

Important Notes:
- This invitation expires in 7 days
- If you did not expect this invitation, please contact your administrator
- You will create your own password during setup

Best regards,
${user.company} Team

This is an automated message from your company's Leave Management System.
  `;

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Invitation to Join ${user.company}</title>
      <style>
        @media only screen and (max-width: 600px) {
          .container { width: 100% !important; padding: 10px !important; }
          .button { padding: 12px 20px !important; font-size: 14px !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, sans-serif;">
      <div style="padding: 20px 0;">
        <div class="container" style="max-width: 600px; margin: 0 auto; background: white; padding: 40px 30px; border-radius: 8px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #2563eb; margin: 0; font-size: 28px;">Leave Management System</h1>
            <p style="color: #666; margin: 5px 0 0 0;">${user.company}</p>
          </div>

          <h2 style="color: #1a1a1a; margin-bottom: 10px;">Welcome to ${user.company}</h2>
          <p style="font-size: 16px; color: #4a4a4a;">Hello <strong>${user.name}</strong>,</p>
          <p style="font-size: 16px; color: #4a4a4a;">
            You have been invited by <strong>${invitedByName}</strong> to join <strong>${user.company}</strong>.
          </p>

          <div style="background: #f8fafc; padding: 25px; border-radius: 8px; margin: 25px 0;">
            <h3 style="color: #1e293b; margin-top: 0;">📋 Your Account Details</h3>
            <p><strong>Email:</strong> ${user.email}</p>
            <p><strong>Role:</strong> ${role.charAt(0).toUpperCase() + role.slice(1)}</p>
            <p><strong>Department:</strong> ${user.department}</p>
            <p><strong>Position:</strong> ${user.position}</p>
          </div>

          <div style="text-align: center; margin: 40px 0;">
            <a href="${verifyUrl}" style="background: #2563eb; color: white; padding: 16px 32px; text-decoration: none; border-radius: 6px; font-weight: bold;">
              Access Your Account
            </a>
          </div>

          <div style="background: #fef3cd; padding: 15px; border-radius: 6px;">
            <p style="color: #8b5a00; margin: 0;">
              ⏰ This invitation expires in 7 days for security reasons.
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  await sendEmail({
    email: user.email,
    subject: `Welcome to ${user.company} - Join Our Team`,
    html,
    text: textContent,
    category: 'invitation',
    fromName: `${user.company} Team`
  });
};

const sendPasswordResetEmail = async (user, resetToken) => {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password/${resetToken}`;

  const textContent = `
Password Reset Request - ${user.company}

Hello ${user.name},

We received a request to reset your password for your Leave Management System account.

To reset your password, visit: ${resetUrl}

This link expires in 15 minutes for security.
If you didn't request this, please ignore this email.

Best regards,
${user.company} Team
  `;

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #dc2626;">🔐 Password Reset Request</h2>
      <p>Hello <strong>${user.name}</strong>,</p>
      <p>We received a request to reset your password.</p>

      <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Email:</strong> ${user.email}</p>
        <p><strong>Employee ID:</strong> ${user.employeeId}</p>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetUrl}" style="background: #dc2626; color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: bold;">
          🔑 Reset My Password
        </a>
      </div>

      <div style="background: #fef2f2; padding: 15px; border-radius: 6px;">
        <p style="color: #dc2626; margin: 0;">
          ⚠️ This link expires in 15 minutes. If you didn't request this, ignore this email.
        </p>
      </div>
    </body>
    </html>
  `;

  await sendEmail({
    email: user.email,
    subject: `🔐 Password reset requested for ${user.company}`,
    html,
    text: textContent,
    category: 'password-reset'
  });
};

// Keep other email functions from original file...
const sendLeaveRequestNotification = async (admin, employee, leave) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1 style="color: #2563eb;">Leave Management System</h1>
      <h2 style="color: #333;">New Leave Request</h2>
      <p>Hello ${admin.name},</p>
      <p><strong>${employee.name}</strong> has submitted a new leave request.</p>

      <div style="background: #f8f9fa; padding: 20px; border-radius: 6px; margin: 25px 0;">
        <h3>Request Details:</h3>
        <p><strong>Employee:</strong> ${employee.name} (${employee.employeeId})</p>
        <p><strong>Department:</strong> ${employee.department}</p>
        <p><strong>Leave Type:</strong> ${leave.leaveType}</p>
        <p><strong>Duration:</strong> ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}</p>
        <p><strong>Total Days:</strong> ${leave.totalDays}</p>
        <p><strong>Reason:</strong> ${leave.reason}</p>
      </div>

      <div style="text-align: center;">
        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/leaves" style="background: #2563eb; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Review Leave Request
        </a>
      </div>
    </div>
  `;

  await sendEmail({
    email: admin.email,
    subject: `New Leave Request from ${employee.name} - Requires Review`,
    html,
    category: 'leave-notification'
  });
};

const sendLeaveStatusNotification = async (employee, leave, reviewedBy) => {
  const statusColor = leave.status === 'approved' ? '#059669' : '#dc2626';
  const statusText = leave.status.charAt(0).toUpperCase() + leave.status.slice(1);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1 style="color: #2563eb;">Leave Management System</h1>
      <h2 style="color: ${statusColor};">Leave Request ${statusText}</h2>
      <p>Hello ${employee.name},</p>
      <p>Your leave request has been <strong style="color: ${statusColor};">${leave.status}</strong> by ${reviewedBy.name}.</p>

      <div style="background: #f8f9fa; padding: 20px; border-radius: 6px;">
        <h3>Leave Details:</h3>
        <p><strong>Leave Type:</strong> ${leave.leaveType}</p>
        <p><strong>Duration:</strong> ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}</p>
        <p><strong>Status:</strong> <span style="color: ${statusColor};">${statusText}</span></p>
        ${leave.reviewComments ? `<p><strong>Comments:</strong> ${leave.reviewComments}</p>` : ''}
      </div>
    </div>
  `;

  await sendEmail({
    email: employee.email,
    subject: `Leave Request ${statusText} - ${leave.leaveType} Leave`,
    html,
    category: 'leave-status'
  });
};

module.exports = {
  sendEmail,
  sendInvitationEmail,
  sendPasswordResetEmail,
  sendLeaveRequestNotification,
  sendLeaveStatusNotification
};