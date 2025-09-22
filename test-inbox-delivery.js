require('dotenv').config({ path: '.env.production' });

console.log('📧 TESTING IMPROVED INBOX DELIVERY');
console.log('==================================');

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SendGrid_Key || process.env.SENDGRID_API_KEY);

// Test email with improved deliverability configuration
const mailOptions = {
  from: {
    email: process.env.FROM_EMAIL,
    name: 'Leave Management System'
  },
  to: 'qazisanaullah612@gmail.com',
  subject: 'Account Setup Required - Test Company',
  html: `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Account Setup Required</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, sans-serif;">
      <div style="padding: 20px 0;">
        <div style="max-width: 600px; margin: 0 auto; background: white; padding: 40px 30px; border-radius: 8px;">
          <div style="text-align: center; margin-bottom: 30px; border-bottom: 2px solid #f0f0f0; padding-bottom: 20px;">
            <h1 style="color: #2563eb; margin: 0; font-size: 28px; font-weight: 600;">Leave Management System</h1>
            <p style="color: #666; margin: 5px 0 0 0; font-size: 14px;">Test Company</p>
          </div>

          <div style="margin-bottom: 30px;">
            <h2 style="color: #1a1a1a; margin-bottom: 10px; font-size: 24px; font-weight: 600;">Account Setup Required</h2>

            <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin-bottom: 20px;">Hello <strong>Test User</strong>,</p>

            <p style="font-size: 16px; line-height: 1.6; color: #4a4a4a; margin-bottom: 25px;">
              An administrator has invited you to join the Leave Management System for <strong>Test Company</strong> as an Employee.
            </p>
          </div>

          <div style="background: #f8fafc; padding: 25px; border-radius: 8px; margin: 25px 0; border-left: 4px solid #2563eb;">
            <h3 style="color: #1e293b; margin-top: 0; margin-bottom: 15px; font-size: 18px; font-weight: 600;">Your Account Details</h3>
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Email Address:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">qazisanaullah612@gmail.com</td></tr>
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Role:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">Employee</td></tr>
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Department:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">Engineering</td></tr>
              <tr><td style="padding: 8px 0; color: #64748b; font-weight: 500;">Position:</td><td style="padding: 8px 0; color: #1e293b; font-weight: 600;">Software Developer</td></tr>
            </table>
          </div>

          <div style="text-align: center; margin: 40px 0;">
            <a href="#" style="display: inline-block; background: #2563eb; color: white; padding: 16px 32px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">
              Complete Account Setup
            </a>
          </div>

          <div style="background: #fef3cd; border: 1px solid #f6cc2f; padding: 15px; border-radius: 6px; margin: 25px 0;">
            <p style="font-size: 14px; color: #8b5a00; margin: 0; font-weight: 500;">
              Important: This setup link expires in 7 days for security reasons. If you did not expect this invitation, please ignore this email.
            </p>
          </div>

          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
          <div style="text-align: center;">
            <p style="color: #9ca3af; font-size: 12px; margin: 0; line-height: 1.4;">
              This is an automated message from Test Company Leave Management System<br>
              Do not reply to this email address.
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `,
  text: `Account Setup Required - Test Company

Hello Test User,

An administrator has invited you to join the Leave Management System for Test Company as an Employee.

Your Account Details:
- Email Address: qazisanaullah612@gmail.com
- Role: Employee
- Department: Engineering
- Position: Software Developer

To complete your account setup and create your password, please visit the link provided.

Important Information:
- This setup link will expire in 7 days for security reasons
- If you did not expect this invitation, please ignore this email
- For assistance, contact your system administrator

---
This is an automated message from Test Company Leave Management System.
Do not reply to this email address.`,
  categories: ['leave-management', 'invitation'],
  headers: {
    'X-Priority': '3',
    'X-MSMail-Priority': 'Normal',
    'Importance': 'Normal',
    'X-Mailer': 'Leave Management System v1.0',
    'List-Unsubscribe': `<mailto:${process.env.FROM_EMAIL}?subject=unsubscribe>`,
    'Return-Path': process.env.FROM_EMAIL,
    'Reply-To': process.env.FROM_EMAIL,
    'X-Entity-Ref-ID': `lms-${Date.now()}`,
    'Message-ID': `<${Date.now()}.${Math.random().toString(36).substr(2, 9)}@leavemanagement.system>`
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

console.log('📤 Sending improved inbox delivery test...');
console.log('To:', mailOptions.to);
console.log('Subject:', mailOptions.subject);

const startTime = Date.now();

sgMail.send(mailOptions)
  .then((response) => {
    const endTime = Date.now();
    console.log('\n✅ SUCCESS: Improved email sent!');
    console.log('Response Time:', endTime - startTime, 'ms');
    console.log('Status Code:', response[0]?.statusCode);
    console.log('Message ID:', response[0]?.headers?.['x-message-id']);

    console.log('\n📧 INBOX DELIVERY IMPROVEMENTS APPLIED:');
    console.log('✅ Professional subject line (no emojis/exclamation)');
    console.log('✅ Enhanced email headers for authentication');
    console.log('✅ Unsubscribe link included');
    console.log('✅ Message-ID for thread tracking');
    console.log('✅ Proper text/HTML ratio');
    console.log('✅ Professional business tone');
    console.log('\n📥 Check your INBOX (not spam) for the email!');
  })
  .catch((error) => {
    const endTime = Date.now();
    console.log('\n❌ Error:', error.message);
    console.log('Response Time:', endTime - startTime, 'ms');

    if (error.response?.body) {
      console.log('Error details:', JSON.stringify(error.response.body, null, 2));
    }
  });