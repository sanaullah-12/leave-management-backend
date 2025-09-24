const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  console.log('📧 Email delivery process started for:', options.email);
  console.log('📧 Email subject:', options.subject);

  // Check SendGrid API key (support both variable names)
  const apiKey = process.env.SENDGRID_API_KEY || process.env.SendGrid_Key;

  if (apiKey && apiKey.startsWith('SG.')) {
    // Use SendGrid - the working method from commit 38173de
    console.log('📧 Using SendGrid for email delivery...');
    sgMail.setApiKey(apiKey);

    const msg = {
      to: options.email,
      from: process.env.FROM_EMAIL || 'qazisanaullah612@gmail.com', // Must be verified in SendGrid
      subject: options.subject,
      html: options.html
    };

    try {
      console.log('📤 Sending via SendGrid...');
      const result = await sgMail.send(msg);

      console.log('✅ SendGrid email sent successfully!');
      console.log('📨 Response status:', result[0].statusCode);
      console.log('📧 Message ID:', result[0].headers['x-message-id']);

      return {
        success: true,
        messageId: result[0].headers['x-message-id'],
        statusCode: result[0].statusCode
      };

    } catch (error) {
      console.error('❌ SendGrid email failed:', error.message);

      // SendGrid specific error handling
      if (error.response) {
        console.error('❌ SendGrid error details:', error.response.body);
        throw new Error(`SendGrid error: ${error.response.body.errors[0].message}`);
      }

      throw new Error(`Email sending failed: ${error.message}`);
    }
  } else {
    // Fallback to SMTP using your current credentials
    console.log('📧 Using SMTP fallback (no SendGrid key found)...');

    // Validate SMTP configuration
    if (!process.env.SMTP_HOST || !process.env.SMTP_EMAIL || !process.env.SMTP_PASSWORD) {
      throw new Error('SMTP configuration incomplete. Required: SMTP_HOST, SMTP_EMAIL, SMTP_PASSWORD');
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD,
      },
      debug: process.env.NODE_ENV !== 'production',
      logger: process.env.NODE_ENV !== 'production'
    });

    const mailOptions = {
      from: {
        name: process.env.FROM_NAME || 'Leave Management System',
        address: process.env.FROM_EMAIL,
      },
      to: options.email,
      subject: options.subject,
      html: options.html,
      text: options.text || options.html?.replace(/<[^>]*>/g, '') || options.subject
    };

    try {
      console.log('📤 Sending via SMTP...');
      const info = await transporter.sendMail(mailOptions);
      console.log('✅ Email sent successfully via SMTP!');
      console.log('✉️ Message ID:', info.messageId);

      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error) {
      console.error('❌ SMTP delivery failed:', error.message);
      throw new Error(`SMTP sending failed: ${error.message}`);
    }
  }
};

const sendInvitationEmail = async (user, invitationToken, invitedByName, role = 'employee') => {
  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-invitation/${invitationToken}`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #2563eb; margin: 0;">Leave Management System</h1>
      </div>

      <h2 style="color: #333; margin-bottom: 20px;">You're Invited!</h2>

      <p style="font-size: 16px; line-height: 1.6; color: #444;">Hello ${user.name},</p>

      <p style="font-size: 16px; line-height: 1.6; color: #444;">
        ${invitedByName} has invited you to join the Leave Management System for <strong>${user.company}</strong> as ${role === 'admin' ? 'an Administrator' : 'an Employee'}.
      </p>

      <div style="background: #f8f9fa; padding: 20px; border-radius: 6px; margin: 25px 0;">
        <h3 style="color: #333; margin-top: 0;">Your Account Details:</h3>
        <ul style="list-style: none; padding: 0; margin: 0;">
          <li style="padding: 5px 0;"><strong>Email:</strong> ${user.email}</li>
          <li style="padding: 5px 0;"><strong>Role:</strong> ${role.charAt(0).toUpperCase() + role.slice(1)}</li>
          <li style="padding: 5px 0;"><strong>Department:</strong> ${user.department}</li>
          <li style="padding: 5px 0;"><strong>Position:</strong> ${user.position}</li>
        </ul>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${verifyUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
          Accept Invitation & Set Password
        </a>
      </div>

      <p style="font-size: 14px; color: #666; line-height: 1.5;">
        <strong>Note:</strong> This invitation link will expire in 7 days. If you don't recognize this invitation, you can safely ignore this email.
      </p>

      <p style="font-size: 14px; color: #666; line-height: 1.5;">
        If the button above doesn't work, copy and paste this link into your browser:
        <br><a href="${verifyUrl}" style="color: #2563eb; word-break: break-all;">${verifyUrl}</a>
      </p>

      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      <p style="color: #999; font-size: 12px; text-align: center;">
        This is an automated email from Leave Management System. Please do not reply to this message.
      </p>
    </div>
  `;

  await sendEmail({
    email: user.email,
    subject: `Invitation to join ${user.company} - Leave Management System`,
    html
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

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #2563eb; margin: 0;">Leave Management System</h1>
      </div>

      <h2 style="color: #333; margin-bottom: 20px;">Reset Your Password</h2>

      <p style="font-size: 16px; line-height: 1.6; color: #444;">Hello ${user.name},</p>

      <p style="font-size: 16px; line-height: 1.6; color: #444;">
        We received a request to reset your password for your Leave Management System account at <strong>${user.company}</strong>.
      </p>

      <div style="background: #f8f9fa; padding: 20px; border-radius: 6px; margin: 25px 0;">
        <h3 style="color: #333; margin-top: 0;">Account Details:</h3>
        <ul style="list-style: none; padding: 0; margin: 0;">
          <li style="padding: 5px 0;"><strong>Email:</strong> ${user.email}</li>
          <li style="padding: 5px 0;"><strong>Employee ID:</strong> ${user.employeeId}</li>
        </ul>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetUrl}" style="display: inline-block; background: #dc2626; color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
          Reset Password
        </a>
      </div>

      <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 15px; border-radius: 6px; margin: 25px 0;">
        <p style="font-size: 14px; color: #dc2626; margin: 0; font-weight: bold;">
          ⚠️ Important Security Notice:
        </p>
        <ul style="font-size: 14px; color: #7f1d1d; margin: 10px 0 0 0;">
          <li>This reset link will expire in 15 minutes for security reasons.</li>
          <li>If you didn't request this password reset, please ignore this email.</li>
          <li>Never share this link with anyone else.</li>
        </ul>
      </div>

      <p style="font-size: 14px; color: #666; line-height: 1.5;">
        If the button above doesn't work, copy and paste this link into your browser:
        <br><a href="${resetUrl}" style="color: #2563eb; word-break: break-all;">${resetUrl}</a>
      </p>

      <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
      <p style="color: #999; font-size: 12px; text-align: center;">
        This is an automated email from Leave Management System. Please do not reply to this message.
        <br>If you continue to have problems, please contact your system administrator.
      </p>
    </div>
  `;

  await sendEmail({
    email: user.email,
    subject: 'Password Reset Request - Leave Management System',
    html
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