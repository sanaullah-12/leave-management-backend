const nodemailer = require('nodemailer');
require('dotenv').config();

// Comprehensive email diagnosis script
const diagnoseEmailConfig = async () => {
  console.log('🔍 DIAGNOSING EMAIL CONFIGURATION...\n');

  // 1. Check environment variables
  console.log('📋 Environment Variables:');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('SENDGRID_API_KEY:', process.env.SENDGRID_API_KEY ? 'SET' : 'NOT SET');
  console.log('SMTP_HOST:', process.env.SMTP_HOST);
  console.log('SMTP_PORT:', process.env.SMTP_PORT);
  console.log('SMTP_EMAIL:', process.env.SMTP_EMAIL);
  console.log('SMTP_PASSWORD:', process.env.SMTP_PASSWORD ? 'SET (length: ' + process.env.SMTP_PASSWORD.length + ')' : 'NOT SET');
  console.log('FROM_EMAIL:', process.env.FROM_EMAIL);
  console.log('FROM_NAME:', process.env.FROM_NAME);
  console.log('');

  // 2. Check SendGrid configuration
  if (process.env.NODE_ENV === 'production' && process.env.SENDGRID_API_KEY) {
    console.log('📧 SendGrid Configuration:');
    if (process.env.SENDGRID_API_KEY === 'your_sendgrid_api_key_here') {
      console.log('❌ SendGrid API key is placeholder - needs real key');
    } else {
      console.log('✅ SendGrid API key appears to be configured');

      try {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        console.log('✅ SendGrid module loaded successfully');
      } catch (error) {
        console.log('❌ SendGrid module error:', error.message);
      }
    }
    console.log('');
  }

  // 3. Test SMTP connection
  console.log('🔌 Testing SMTP Connection:');
  try {
    const transporter = nodemailer.createTransporter({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD,
      },
      tls: {
        rejectUnauthorized: false // For testing
      }
    });

    console.log('📤 Verifying SMTP connection...');
    await transporter.verify();
    console.log('✅ SMTP connection successful');

    // Test sending an email
    console.log('📧 Sending test email...');
    const testEmail = {
      from: {
        name: process.env.FROM_NAME || 'Leave Management System',
        address: process.env.FROM_EMAIL,
      },
      to: process.env.SMTP_EMAIL, // Send to self for testing
      subject: 'Test Email - Leave Management System',
      html: `
        <h2>Email Test Successful!</h2>
        <p>This is a test email sent at ${new Date().toISOString()}</p>
        <p>Email configuration is working correctly.</p>
      `,
      text: `Email Test Successful!\n\nThis is a test email sent at ${new Date().toISOString()}\nEmail configuration is working correctly.`
    };

    const info = await transporter.sendMail(testEmail);
    console.log('✅ Test email sent successfully!');
    console.log('📧 Message ID:', info.messageId);
    console.log('📨 Response:', info.response);

  } catch (error) {
    console.log('❌ SMTP Error:', error.message);

    // Provide specific error diagnostics
    if (error.code === 'EAUTH') {
      console.log('💡 Authentication failed - check username/password');
    } else if (error.code === 'ECONNECTION') {
      console.log('💡 Connection failed - check host/port');
    } else if (error.code === 'ETIMEDOUT') {
      console.log('💡 Connection timeout - check network/firewall');
    }
  }

  console.log('');

  // 4. Provide recommendations
  console.log('💡 RECOMMENDATIONS:');

  if (process.env.NODE_ENV === 'production') {
    if (!process.env.SENDGRID_API_KEY || process.env.SENDGRID_API_KEY === 'your_sendgrid_api_key_here') {
      console.log('🔧 Set up SendGrid for production:');
      console.log('   1. Sign up at https://sendgrid.com');
      console.log('   2. Generate API key');
      console.log('   3. Update SENDGRID_API_KEY environment variable');
      console.log('');
    }
  }

  console.log('🔧 Gmail SMTP troubleshooting:');
  console.log('   1. Enable 2-Factor Authentication');
  console.log('   2. Generate App Password (16 characters)');
  console.log('   3. Use App Password instead of regular password');
  console.log('   4. Check Gmail security settings');
  console.log('');

  console.log('🔧 Alternative solutions:');
  console.log('   1. Use Mailgun (good free tier)');
  console.log('   2. Use AWS SES (reliable and cheap)');
  console.log('   3. Use Nodemailer with OAuth2');
  console.log('');

  console.log('🔍 Diagnosis complete!');
};

// Run diagnosis if called directly
if (require.main === module) {
  diagnoseEmailConfig().catch(console.error);
}

module.exports = { diagnoseEmailConfig };