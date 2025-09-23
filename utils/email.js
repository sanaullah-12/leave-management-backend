const nodemailer = require('nodemailer');
const { getDeliverabilityTips } = require('./emailDeliverability');

const sendEmail = async (options) => {
  console.log('📧 Email delivery process started for:', options.email);
  console.log('📧 Email subject:', options.subject);

  // Production email configuration
  const isProduction = process.env.NODE_ENV === 'production';
  console.log('🌍 Environment:', process.env.NODE_ENV);

  let transporter;

  // Check if SendGrid is properly configured (prioritize Railway variable name)
  const sendGridKey = process.env.SendGrid_Key || process.env.SENDGRID_API_KEY;
  const isSendGridConfigured = sendGridKey &&
                               sendGridKey !== 'your_sendgrid_api_key_here' &&
                               sendGridKey.startsWith('SG.') &&
                               sendGridKey.length > 50; // SendGrid keys are typically 69 characters

  console.log('🔍 Email provider check:');
  console.log('  - Is Production:', isProduction);
  console.log('  - NODE_ENV:', process.env.NODE_ENV);
  console.log('  - SendGrid_Key exists:', !!process.env.SendGrid_Key);
  console.log('  - SendGrid_Key value:', process.env.SendGrid_Key ? `${process.env.SendGrid_Key.substring(0, 10)}...` : 'NOT SET');
  console.log('  - SENDGRID_API_KEY exists:', !!process.env.SENDGRID_API_KEY);
  console.log('  - Final SendGrid Key exists:', !!sendGridKey);
  console.log('  - SendGrid Key length:', sendGridKey?.length || 0);
  console.log('  - SendGrid configured:', isSendGridConfigured);
  console.log('  - Will use:', (isProduction && isSendGridConfigured) ? 'SendGrid' : 'SMTP');
  console.log('  - Production check:', isProduction, '&& SendGrid check:', isSendGridConfigured, '=', (isProduction && isSendGridConfigured));

  if (isProduction && isSendGridConfigured) {
    // Use SendGrid for production (recommended for deliverability)
    console.log('🔑 Using SendGrid for email delivery...');
    console.log('🔑 SendGrid API Key configured:', sendGridKey ? `${sendGridKey.substring(0, 10)}...` : 'None');

    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(sendGridKey);

    // SendGrid configuration for better deliverability
    const mailOptions = {
      from: {
        email: process.env.FROM_EMAIL,
        name: process.env.FROM_NAME || 'Leave Management System'
      },
      to: options.email,
      subject: options.subject,
      html: options.html,
      text: options.text,
      categories: ['leave-management', options.category || 'general'],
      headers: {
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal',
        'Importance': 'Normal',
        'X-Mailer': 'Leave Management System v1.0',
        'List-Unsubscribe': `<mailto:${process.env.FROM_EMAIL}?subject=unsubscribe>`,
        'Return-Path': process.env.FROM_EMAIL,
        'Reply-To': process.env.FROM_EMAIL,
        'X-Entity-Ref-ID': `lms-${Date.now()}`,
        'Message-ID': `<${Date.now()}.${Math.random().toString(36).substr(2, 9)}@leavemanagement.system>`,
        'X-Spam-Status': 'No',
        'X-Authenticated-Sender': process.env.FROM_EMAIL
      },
      trackingSettings: {
        clickTracking: { enable: false },
        openTracking: { enable: false },
        subscriptionTracking: { enable: false }
      },
      asm: {
        group_id: 1, // Use default unsubscribe group
        groups_to_display: [1]
      }
    };

    try {
      console.log('📤 Sending via SendGrid to:', options.email);
      console.log('📤 Subject:', options.subject);
      console.log('📤 From:', mailOptions.from);

      const response = await sgMail.send(mailOptions);

      console.log('✅ Email sent successfully via SendGrid!');
      console.log('📧 Response status:', response[0]?.statusCode);
      console.log('📧 Message ID:', response[0]?.headers?.['x-message-id']);

      return {
        success: true,
        messageId: response[0]?.headers?.['x-message-id'],
        provider: 'SendGrid',
        statusCode: response[0]?.statusCode
      };
    } catch (error) {
      console.error('❌ SendGrid delivery failed:');
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
      console.error('Error response:', error.response?.body);
      console.error('Full error object:', JSON.stringify(error, null, 2));

      // Provide specific SendGrid error diagnostics
      let errorHint = '';
      if (error.code === 401) {
        errorHint = '💡 Invalid API Key - check your SendGrid API key configuration';
      } else if (error.code === 403) {
        errorHint = '💡 Forbidden - check SendGrid account permissions and verify sender email';
      } else if (error.code === 413) {
        errorHint = '💡 Email too large - reduce email size or attachments';
      } else if (error.message?.includes('verify')) {
        errorHint = '💡 Sender email not verified - verify your sender email in SendGrid dashboard';
      } else if (error.message?.includes('The from address does not match a verified Sender Identity')) {
        errorHint = '💡 Sender email not verified in SendGrid - add and verify your sender email in SendGrid dashboard';
      }

      console.error(errorHint);
      console.error('📧 Email config debug info:');
      console.error('  - From email:', process.env.FROM_EMAIL);
      console.error('  - SendGrid Key (first 10 chars):', sendGridKey ? sendGridKey.substring(0, 10) : 'NOT SET');

      // PRODUCTION FIX: Fall back to SMTP if SendGrid fails
      console.warn('🔄 SendGrid failed, attempting SMTP fallback...');

      // Validate SMTP configuration
      if (!process.env.SMTP_HOST || !process.env.SMTP_EMAIL || !process.env.SMTP_PASSWORD) {
        throw new Error(`SendGrid failed and SMTP not configured. SendGrid error: ${error.message}. ${errorHint}`);
      }

      // Create SMTP transporter for fallback
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: process.env.SMTP_PORT === '465',
        auth: {
          user: process.env.SMTP_EMAIL,
          pass: process.env.SMTP_PASSWORD,
        },
        pool: true,
        rateLimit: true,
        maxConnections: 3,
        maxMessages: 100,
        connectionTimeout: 60000,
        greetingTimeout: 30000,
        socketTimeout: 60000,
        dnsTimeout: 30000,
        tls: {
          rejectUnauthorized: isProduction,
          ciphers: 'SSLv3'
        }
      });

      const mailOptions = {
        from: {
          name: process.env.FROM_NAME || 'Leave Management System',
          address: process.env.FROM_EMAIL,
        },
        to: options.email,
        subject: options.subject,
        html: options.html,
        text: options.text,
        headers: {
          'X-Priority': '3',
          'X-MSMail-Priority': 'Normal',
          'Importance': 'Normal',
          'List-Unsubscribe': `<mailto:${process.env.FROM_EMAIL}?subject=unsubscribe>`,
          'X-Entity-Ref-ID': `lms-${Date.now()}`,
          'Return-Path': process.env.FROM_EMAIL,
          'Reply-To': process.env.FROM_EMAIL
        },
        dsn: {
          id: `lms-${Date.now()}`,
          return: 'headers',
          notify: ['success', 'failure', 'delay'],
          recipient: process.env.FROM_EMAIL,
        },
      };

      try {
        console.log('📤 Sending via SMTP fallback after SendGrid failure...');
        const info = await transporter.sendMail(mailOptions);
        console.log('✅ Email sent successfully via SMTP fallback!');
        console.log('✉️ Message ID:', info.messageId);
        return { success: true, messageId: info.messageId, provider: 'SMTP-Fallback' };
      } catch (smtpError) {
        console.error('❌ SMTP fallback also failed:', smtpError.message);
        throw new Error(`Both SendGrid and SMTP failed. SendGrid: ${error.message}. SMTP: ${smtpError.message}`);
      }
    }
  } else {
    // Use SMTP for development or fallback
    console.log('📤 Using SMTP fallback...');

    if (isProduction && !isSendGridConfigured) {
      console.warn('⚠️ Production environment detected but SendGrid not configured properly');
      console.warn('⚠️ Falling back to SMTP - consider setting up SendGrid for better deliverability');
    }

    // Validate SMTP configuration
    if (!process.env.SMTP_HOST || !process.env.SMTP_EMAIL || !process.env.SMTP_PASSWORD) {
      throw new Error('SMTP configuration incomplete. Required: SMTP_HOST, SMTP_EMAIL, SMTP_PASSWORD');
    }

    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD,
      },
      pool: true, // Use connection pooling
      rateLimit: true, // Enable rate limiting
      maxConnections: 3, // Max 3 connections
      maxMessages: 100, // Max 100 messages per connection
      // Additional production-grade SMTP settings
      connectionTimeout: 60000, // 60 seconds
      greetingTimeout: 30000, // 30 seconds
      socketTimeout: 60000, // 60 seconds
      dnsTimeout: 30000, // 30 seconds
      tls: {
        rejectUnauthorized: isProduction, // Strict TLS in production
        ciphers: 'SSLv3'
      }
    });
  }

  // For SMTP fallback, define the email options with deliverability enhancements
  if (!isProduction || !isSendGridConfigured) {
    const mailOptions = {
      from: {
        name: process.env.FROM_NAME || 'Leave Management System',
        address: process.env.FROM_EMAIL,
      },
      to: options.email,
      subject: options.subject,
      html: options.html,
      text: options.text,
      headers: {
        'X-Priority': '3',
        'X-MSMail-Priority': 'Normal',
        'Importance': 'Normal',
        'List-Unsubscribe': `<mailto:${process.env.FROM_EMAIL}?subject=unsubscribe>`,
        'X-Entity-Ref-ID': `lms-${Date.now()}`,
        'Return-Path': process.env.FROM_EMAIL,
        'Reply-To': process.env.FROM_EMAIL,
        'X-Spam-Status': 'No',
        'X-Authenticated-Sender': process.env.FROM_EMAIL,
        'DKIM-Signature': `v=1; a=rsa-sha256; c=relaxed/relaxed; d=gmail.com; s=default`,
        'SPF-Record': 'v=spf1 include:_spf.google.com ~all'
      },
      dsn: {
        id: `lms-${Date.now()}`,
        return: 'headers',
        notify: ['success', 'failure', 'delay'],
        recipient: process.env.FROM_EMAIL,
      },
    };

    try {
      console.log('📤 Sending via SMTP with enhanced deliverability...');
      const info = await transporter.sendMail(mailOptions);
      console.log('✅ Email sent successfully via SMTP!');
      console.log('✉️ Message ID:', info.messageId);
      console.log('📧 Recipients:', info.accepted);
      console.log('📧 Rejected:', info.rejected);
      console.log('📧 Response:', info.response);

      // Log delivery status for debugging
      if (info.rejected && info.rejected.length > 0) {
        console.warn('⚠️ Some recipients were rejected:', info.rejected);
      }

      return {
        success: true,
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response
      };
    } catch (error) {
      console.error('❌ SMTP delivery failed:', error.message);
      console.error('🔍 Error code:', error.code);
      console.error('🔍 Error details:', error);

      // Provide specific error diagnostics
      let errorHint = '';
      if (error.code === 'EAUTH') {
        errorHint = '💡 Authentication failed - check Gmail app password. Ensure 2FA is enabled and use app-specific password.';
      } else if (error.code === 'ECONNECTION') {
        errorHint = '💡 Connection failed - check SMTP host/port settings';
      } else if (error.code === 'ETIMEDOUT') {
        errorHint = '💡 Connection timeout - check network connectivity and firewall settings';
      } else if (error.code === 'ESOCKET') {
        errorHint = '💡 Socket error - check SMTP server availability';
      } else if (error.message.includes('Username and Password not accepted')) {
        errorHint = '💡 Gmail rejected credentials - regenerate app password and ensure 2FA is enabled';
      }

      console.error(errorHint);
      console.log('💡 Email troubleshooting tips:');
      console.log('1. Verify Gmail app password (16 characters, no spaces)');
      console.log('2. Enable 2-Factor Authentication on Gmail account');
      console.log('3. Check Gmail security settings');
      console.log('4. Consider using SendGrid for production');

      throw new Error(`SMTP sending failed: ${error.message}. ${errorHint}`);
    }
  }
};

const sendInvitationEmail = async (user, invitationToken, invitedByName, role = 'employee') => {
  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-invitation/${invitationToken}`;
  
  // Plain text version for better deliverability
  const textContent = `
Account Setup Required - ${user.company}

Hello ${user.name},

${invitedByName} has invited you to join the Leave Management System for ${user.company} as ${role === 'admin' ? 'an Administrator' : 'an Employee'}.

Your Account Details:
- Email Address: ${user.email}
- Role: ${role.charAt(0).toUpperCase() + role.slice(1)}
- Department: ${user.department}
- Position: ${user.position}

To complete your account setup and create your password, please visit:
${verifyUrl}

Important Information:
- This setup link will expire in 7 days for security reasons
- If you did not expect this invitation, please ignore this email
- For assistance, contact your system administrator

---
This is an automated message from ${user.company} Leave Management System.
Do not reply to this email address.
  `;
  
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Invitation to Join ${user.company}</title>
      <!--[if mso]>
      <noscript>
        <xml>
          <o:OfficeDocumentSettings>
            <o:PixelsPerInch>96</o:PixelsPerInch>
          </o:OfficeDocumentSettings>
        </xml>
      </noscript>
      <![endif]-->
      <style>
        @media only screen and (max-width: 600px) {
          .container { width: 100% !important; padding: 10px !important; }
          .button { padding: 12px 20px !important; font-size: 14px !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
      <div style="padding: 20px 0;">
        <div class="container" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; background: white; padding: 40px 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #f0f0f0; padding-bottom: 20px;">
            <h1 style="color: #2563eb; margin: 0; font-size: 28px; font-weight: 600;">Leave Management System</h1>
            <p style="color: #666; margin: 5px 0 0 0; font-size: 14px;">${user.company}</p>
          </div>
          
          <div style="margin-bottom: 30px;">
            <h2 style="color: #1a1a1a; margin-bottom: 10px; font-size: 24px; font-weight: 600;">Account Setup Required</h2>
            
            <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin-bottom: 20px;">Hello <strong>${user.name}</strong>,</p>
            
            <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin-bottom: 25px;">
              <strong>${invitedByName}</strong> has invited you to join the Leave Management System for <strong>${user.company}</strong> as <strong>${role === 'admin' ? 'an Administrator' : 'an Employee'}</strong>.
            </p>
          </div>
          
          <div style="background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%); padding: 25px; border-radius: 8px; margin: 25px 0; border-left: 4px solid #2563eb;">
            <h3 style="color: #1e293b; margin-top: 0; margin-bottom: 15px; font-size: 18px; font-weight: 600;">📋 Your Account Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Email Address:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">${user.email}</td></tr>
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Role:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">${role.charAt(0).toUpperCase() + role.slice(1)}</td></tr>
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Department:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">${user.department}</td></tr>
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Position:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">${user.position}</td></tr>
            </table>
          </div>
          
          <div style="text-align: center; margin: 40px 0;">
            <a href="${verifyUrl}" class="button" style="display: inline-block; background: #2563eb; color: white; padding: 16px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">
              Complete Account Setup
            </a>
          </div>
          
          <div style="background: #fef3cd; border: 1px solid #f6cc2f; padding: 15px; border-radius: 6px; margin: 25px 0;">
            <p style="font-size: 14px; color: #8b5a00; margin: 0; font-weight: 500;">
              ⏰ <strong>Important:</strong> This invitation link expires in 7 days for security reasons. If you don't recognize this invitation, please ignore this email.
            </p>
          </div>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 25px 0;">
            <p style="font-size: 13px; color: #666; margin: 0; line-height: 1.5;">
              <strong>Having trouble with the button?</strong> Copy and paste this link into your browser:
              <br><span style="font-family: monospace; color: #2563eb; word-break: break-all; font-size: 12px;">${verifyUrl}</span>
            </p>
          </div>
          
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
          <div style="text-align: center;">
            <p style="color: #9ca3af; font-size: 12px; margin: 0; line-height: 1.4;">
              This email was sent by Leave Management System<br>
              This is an automated message, please do not reply to this email.
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  await sendEmail({
    email: user.email,
    subject: `Welcome to ${user.company} - Account Setup Required`,
    html,
    text: textContent,
    category: 'invitation'
  });
};

const sendWelcomeEmail = async (user, tempPassword) => {
  // This is now deprecated in favor of sendInvitationEmail
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Welcome to Leave Management System</h2>
      <p>Hello ${user.name},</p>
      <p>You have been invited to join the Leave Management System for ${user.company}.</p>
      <p><strong>Your login credentials:</strong></p>
      <ul>
        <li>Email: ${user.email}</li>
        <li>Temporary Password: <code style="background: #f4f4f4; padding: 2px 4px;">${tempPassword}</code></li>
      </ul>
      <p style="color: #d63031;"><strong>Important:</strong> Please change your password after your first login.</p>
      <p>You can access the system at: <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}">Login Here</a></p>
      <p>If you have any questions, please contact your administrator.</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="color: #666; font-size: 12px;">This is an automated email. Please do not reply to this message.</p>
    </div>
  `;

  await sendEmail({
    email: user.email,
    subject: 'Welcome to Leave Management System',
    html
  });
};

const sendPasswordResetEmail = async (user, resetToken) => {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password/${resetToken}`;
  
  // Plain text version for better deliverability
  const textContent = `
Password Reset Request - ${user.company}

Hello ${user.name},

We received a request to reset your password for your Leave Management System account at ${user.company}.

Account Details:
- Email: ${user.email}
- Employee ID: ${user.employeeId}

To reset your password, please visit:
${resetUrl}

IMPORTANT SECURITY NOTICE:
- This reset link will expire in 15 minutes for security reasons.
- If you didn't request this password reset, please ignore this email.
- Never share this link with anyone else.

---
This is an automated email from Leave Management System. Please do not reply to this message.
If you continue to have problems, please contact your system administrator.
  `;
  
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Password Reset Request</title>
      <style>
        @media only screen and (max-width: 600px) {
          .container { width: 100% !important; padding: 10px !important; }
          .button { padding: 12px 20px !important; font-size: 14px !important; }
        }
      </style>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
      <div style="padding: 20px 0;">
        <div class="container" style="max-width: 600px; margin: 0 auto; background: white; padding: 40px 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #f0f0f0; padding-bottom: 20px;">
            <h1 style="color: #dc2626; margin: 0; font-size: 28px; font-weight: 600;">🔐 Password Reset</h1>
            <p style="color: #666; margin: 5px 0 0 0; font-size: 14px;">Leave Management System - ${user.company}</p>
          </div>
          
          <div style="margin-bottom: 30px;">
            <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin-bottom: 20px;">Hello <strong>${user.name}</strong>,</p>
            
            <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin-bottom: 25px;">
              We received a request to reset your password for your Leave Management System account at <strong>${user.company}</strong>.
            </p>
          </div>
          
          <div style="background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%); padding: 25px; border-radius: 8px; margin: 25px 0; border-left: 4px solid #dc2626;">
            <h3 style="color: #1e293b; margin-top: 0; margin-bottom: 15px; font-size: 18px; font-weight: 600;">👤 Account Information</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Email Address:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">${user.email}</td></tr>
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Employee ID:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">${user.employeeId}</td></tr>
            </table>
          </div>
          
          <div style="text-align: center; margin: 40px 0;">
            <a href="${resetUrl}" class="button" style="display: inline-block; background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%); color: white; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(220, 38, 38, 0.3);">
              🔑 Reset My Password
            </a>
          </div>
          
          <div style="background: #fef2f2; border: 2px solid #fecaca; padding: 20px; border-radius: 8px; margin: 25px 0;">
            <h4 style="color: #dc2626; margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">
              ⚠️ Security Notice - Please Read
            </h4>
            <ul style="font-size: 14px; color: #7f1d1d; margin: 0; padding-left: 20px; line-height: 1.5;">
              <li style="margin-bottom: 5px;">This reset link expires in <strong>15 minutes</strong> for your security</li>
              <li style="margin-bottom: 5px;">If you didn't request this, you can safely ignore this email</li>
              <li style="margin-bottom: 5px;">Never share this link with anyone</li>
              <li>Your password won't change until you use this link</li>
            </ul>
          </div>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 25px 0;">
            <p style="font-size: 13px; color: #666; margin: 0; line-height: 1.5;">
              <strong>Button not working?</strong> Copy and paste this link into your browser:
              <br><span style="font-family: monospace; color: #dc2626; word-break: break-all; font-size: 12px;">${resetUrl}</span>
            </p>
          </div>
          
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
          <div style="text-align: center;">
            <p style="color: #9ca3af; font-size: 12px; margin: 0; line-height: 1.4;">
              This email was sent by Leave Management System<br>
              This is an automated security message. Please do not reply.<br>
              Need help? Contact your system administrator.
            </p>
          </div>
        </div>
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

const sendLeaveStatusEmail = async (leave, status) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Leave Request ${status.charAt(0).toUpperCase() + status.slice(1)}</h2>
      <p>Hello ${leave.employee.name},</p>
      <p>Your leave request has been <strong style="color: ${status === 'approved' ? '#00b894' : '#d63031'};">${status}</strong>.</p>
      
      <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0;">
        <h3 style="margin-top: 0;">Leave Details:</h3>
        <ul style="list-style: none; padding: 0;">
          <li><strong>Type:</strong> ${leave.leaveType.charAt(0).toUpperCase() + leave.leaveType.slice(1)} Leave</li>
          <li><strong>Duration:</strong> ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}</li>
          <li><strong>Total Days:</strong> ${leave.totalDays}</li>
          <li><strong>Reason:</strong> ${leave.reason}</li>
          ${leave.reviewComments ? `<li><strong>Admin Comments:</strong> ${leave.reviewComments}</li>` : ''}
        </ul>
      </div>
      
      <p>If you have any questions, please contact your administrator.</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="color: #666; font-size: 12px;">This is an automated email. Please do not reply to this message.</p>
    </div>
  `;

  await sendEmail({
    email: leave.employee.email,
    subject: `Leave Request ${status.charAt(0).toUpperCase() + status.slice(1)} - ${leave.leaveType.charAt(0).toUpperCase() + leave.leaveType.slice(1)} Leave`,
    html
  });
};

// Send leave request notification to admins
const sendLeaveRequestNotification = async (admin, employee, leave) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #2563eb; margin: 0;">Leave Management System</h1>
      </div>
      
      <h2 style="color: #333; margin-bottom: 20px;">New Leave Request</h2>
      
      <p style="font-size: 16px; line-height: 1.6; color: #444;">Hello ${admin.name},</p>
      
      <p style="font-size: 16px; line-height: 1.6; color: #444;">
        <strong>${employee.name}</strong> has submitted a new leave request that requires your review.
      </p>
      
      <div style="background: #f8f9fa; padding: 20px; border-radius: 6px; margin: 25px 0;">
        <h3 style="color: #333; margin-top: 0;">Request Details:</h3>
        <ul style="list-style: none; padding: 0; margin: 0;">
          <li style="padding: 5px 0;"><strong>Employee:</strong> ${employee.name} (${employee.employeeId})</li>
          <li style="padding: 5px 0;"><strong>Department:</strong> ${employee.department}</li>
          <li style="padding: 5px 0;"><strong>Leave Type:</strong> ${leave.leaveType.charAt(0).toUpperCase() + leave.leaveType.slice(1)}</li>
          <li style="padding: 5px 0;"><strong>Duration:</strong> ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}</li>
          <li style="padding: 5px 0;"><strong>Total Days:</strong> ${leave.totalDays}</li>
          <li style="padding: 5px 0;"><strong>Reason:</strong> ${leave.reason}</li>
          <li style="padding: 5px 0;"><strong>Applied Date:</strong> ${new Date(leave.appliedDate).toLocaleDateString()}</li>
        </ul>
      </div>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/leaves" style="display: inline-block; background: #2563eb; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
          Review Leave Request
        </a>
      </div>
      
      <p style="font-size: 14px; color: #666; line-height: 1.5;">
        Please log in to the Leave Management System to review and respond to this leave request.
      </p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      <p style="color: #999; font-size: 12px; text-align: center;">
        This is an automated email from Leave Management System. Please do not reply to this message.
      </p>
    </div>
  `;

  await sendEmail({
    email: admin.email,
    subject: `New Leave Request from ${employee.name} - Requires Review`,
    html
  });
};

// Send leave status notification to employee
const sendLeaveStatusNotification = async (employee, leave, reviewedBy) => {
  const statusColor = leave.status === 'approved' ? '#059669' : '#dc2626';
  const statusText = leave.status.charAt(0).toUpperCase() + leave.status.slice(1);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #2563eb; margin: 0;">Leave Management System</h1>
      </div>
      
      <h2 style="color: ${statusColor}; margin-bottom: 20px;">Leave Request ${statusText}</h2>
      
      <p style="font-size: 16px; line-height: 1.6; color: #444;">Hello ${employee.name},</p>
      
      <p style="font-size: 16px; line-height: 1.6; color: #444;">
        Your leave request has been <strong style="color: ${statusColor};">${leave.status}</strong> by ${reviewedBy.name}.
      </p>
      
      <div style="background: #f8f9fa; padding: 20px; border-radius: 6px; margin: 25px 0;">
        <h3 style="color: #333; margin-top: 0;">Leave Details:</h3>
        <ul style="list-style: none; padding: 0; margin: 0;">
          <li style="padding: 5px 0;"><strong>Leave Type:</strong> ${leave.leaveType.charAt(0).toUpperCase() + leave.leaveType.slice(1)}</li>
          <li style="padding: 5px 0;"><strong>Duration:</strong> ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()}</li>
          <li style="padding: 5px 0;"><strong>Total Days:</strong> ${leave.totalDays}</li>
          <li style="padding: 5px 0;"><strong>Reason:</strong> ${leave.reason}</li>
          <li style="padding: 5px 0;"><strong>Status:</strong> <span style="color: ${statusColor}; font-weight: bold;">${statusText}</span></li>
          <li style="padding: 5px 0;"><strong>Reviewed By:</strong> ${reviewedBy.name}</li>
          <li style="padding: 5px 0;"><strong>Reviewed Date:</strong> ${new Date(leave.reviewedDate).toLocaleDateString()}</li>
          ${leave.reviewComments ? `<li style="padding: 5px 0;"><strong>Admin Comments:</strong> ${leave.reviewComments}</li>` : ''}
        </ul>
      </div>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/leaves" style="display: inline-block; background: #2563eb; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
          View Leave History
        </a>
      </div>
      
      <p style="font-size: 14px; color: #666; line-height: 1.5;">
        If you have any questions about this decision, please contact your administrator.
      </p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      <p style="color: #999; font-size: 12px; text-align: center;">
        This is an automated email from Leave Management System. Please do not reply to this message.
      </p>
    </div>
  `;

  await sendEmail({
    email: employee.email,
    subject: `Leave Request ${statusText} - ${leave.leaveType.charAt(0).toUpperCase() + leave.leaveType.slice(1)} Leave`,
    html
  });
};

// Send notification when employee accepts invitation
const sendEmployeeJoinedNotification = async (admin, employee) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #2563eb; margin: 0;">Leave Management System</h1>
      </div>
      
      <h2 style="color: #059669; margin-bottom: 20px;">Employee Joined Successfully</h2>
      
      <p style="font-size: 16px; line-height: 1.6; color: #444;">Hello ${admin.name},</p>
      
      <p style="font-size: 16px; line-height: 1.6; color: #444;">
        <strong>${employee.name}</strong> has successfully accepted their invitation and joined your organization.
      </p>
      
      <div style="background: #f0fdf4; padding: 20px; border-radius: 6px; margin: 25px 0; border: 1px solid #bbf7d0;">
        <h3 style="color: #059669; margin-top: 0;">Employee Details:</h3>
        <ul style="list-style: none; padding: 0; margin: 0;">
          <li style="padding: 5px 0;"><strong>Name:</strong> ${employee.name}</li>
          <li style="padding: 5px 0;"><strong>Email:</strong> ${employee.email}</li>
          <li style="padding: 5px 0;"><strong>Employee ID:</strong> ${employee.employeeId}</li>
          <li style="padding: 5px 0;"><strong>Department:</strong> ${employee.department}</li>
          <li style="padding: 5px 0;"><strong>Position:</strong> ${employee.position}</li>
          <li style="padding: 5px 0;"><strong>Role:</strong> ${employee.role.charAt(0).toUpperCase() + employee.role.slice(1)}</li>
          <li style="padding: 5px 0;"><strong>Join Date:</strong> ${new Date().toLocaleDateString()}</li>
        </ul>
      </div>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/employees" style="display: inline-block; background: #2563eb; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
          View Employee List
        </a>
      </div>
      
      <p style="font-size: 14px; color: #666; line-height: 1.5;">
        The employee can now access the Leave Management System and submit leave requests.
      </p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      <p style="color: #999; font-size: 12px; text-align: center;">
        This is an automated email from Leave Management System. Please do not reply to this message.
      </p>
    </div>
  `;

  await sendEmail({
    email: admin.email,
    subject: `${employee.name} has joined your organization`,
    html
  });
};

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