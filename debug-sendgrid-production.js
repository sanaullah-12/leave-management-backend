// Test SendGrid configuration that matches production exactly
console.log('🔍 PRODUCTION SendGrid Debug Test');
console.log('=================================');

// Use production configuration
const sgMail = require('@sendgrid/mail');

// Use the exact same configuration as production
const sendGridKey = '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';
const fromEmail = 'qazisanaullah612@gmail.com';
const fromName = 'Leave Management System';

console.log('SendGrid Key:', sendGridKey.substring(0, 15) + '...');
console.log('From Email:', fromEmail);
console.log('From Name:', fromName);

sgMail.setApiKey(sendGridKey);

const mailOptions = {
  from: {
    email: fromEmail,
    name: fromName
  },
  to: 'qazisanaullah612@gmail.com',
  subject: '🧪 Production SendGrid Diagnostic Test',
  html: `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>SendGrid Production Test</title>
    </head>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #2563eb;">SendGrid Production Diagnostic Test</h2>
      <p>This email was sent from production SendGrid configuration to diagnose delivery issues.</p>

      <div style="background: #f8f9fa; padding: 15px; border-radius: 6px; margin: 15px 0;">
        <h3>Configuration Details:</h3>
        <ul>
          <li><strong>SendGrid Key:</strong> ${sendGridKey.substring(0, 15)}...</li>
          <li><strong>From Email:</strong> ${fromEmail}</li>
          <li><strong>Timestamp:</strong> ${new Date().toISOString()}</li>
          <li><strong>Environment:</strong> Production Test</li>
        </ul>
      </div>

      <p><strong>If you receive this email:</strong> SendGrid configuration is working</p>
      <p><strong>If you don't receive this email:</strong> There's a delivery or authentication issue</p>

      <hr style="margin: 20px 0;">
      <p style="color: #666; font-size: 12px;">
        This is a diagnostic email for Leave Management System production troubleshooting.
      </p>
    </body>
    </html>
  `,
  text: `
SendGrid Production Diagnostic Test

This email was sent from production SendGrid configuration to diagnose delivery issues.

Configuration Details:
- SendGrid Key: ${sendGridKey.substring(0, 15)}...
- From Email: ${fromEmail}
- Timestamp: ${new Date().toISOString()}
- Environment: Production Test

If you receive this email: SendGrid configuration is working
If you don't receive this email: There's a delivery or authentication issue
  `,
  categories: ['production-test', 'diagnostic'],
  mailSettings: {
    spamCheck: {
      enable: true,
      threshold: 1
    }
  },
  trackingSettings: {
    clickTracking: { enable: false },
    openTracking: { enable: false },
    subscriptionTracking: { enable: false }
  }
};

console.log('\n📤 Sending diagnostic email...');
console.log('To:', mailOptions.to);
console.log('Subject:', mailOptions.subject);

const startTime = Date.now();

sgMail.send(mailOptions)
  .then((response) => {
    const endTime = Date.now();
    console.log('\n✅ SUCCESS: Email sent via SendGrid');
    console.log('Response Time:', endTime - startTime, 'ms');
    console.log('Status Code:', response[0]?.statusCode);
    console.log('Message ID:', response[0]?.headers?.['x-message-id']);

    if (response[0]?.headers) {
      console.log('\n📧 Response Headers:');
      Object.keys(response[0].headers).forEach(key => {
        if (key.startsWith('x-')) {
          console.log(`  ${key}: ${response[0].headers[key]}`);
        }
      });
    }

    console.log('\n💡 SUCCESS INDICATORS:');
    console.log('- Status 202: Email accepted for delivery');
    console.log('- Check your inbox/spam for the diagnostic email');
    console.log('- If email doesn\'t arrive, the issue is delivery/reputation');
  })
  .catch((error) => {
    const endTime = Date.now();
    console.log('\n❌ FAILED: SendGrid error');
    console.log('Response Time:', endTime - startTime, 'ms');
    console.log('Error Code:', error.code);
    console.log('Error Message:', error.message);

    if (error.response?.body) {
      console.log('\n📄 Detailed Error Response:');
      console.log(JSON.stringify(error.response.body, null, 2));

      const errors = error.response.body.errors || [];
      console.log('\n🔍 Error Analysis:');
      errors.forEach((err, index) => {
        console.log(`${index + 1}. ${err.message}`);
        if (err.field) console.log(`   Field: ${err.field}`);
        if (err.help) console.log(`   Help: ${err.help}`);
      });
    }

    console.log('\n💡 COMMON SOLUTIONS:');
    if (error.code === 400) {
      console.log('- Verify sender email in SendGrid dashboard');
      console.log('- Check email format and content');
      console.log('- Ensure sender authentication is complete');
    } else if (error.code === 401) {
      console.log('- API key is invalid or expired');
      console.log('- Generate new API key with proper permissions');
    } else if (error.code === 403) {
      console.log('- Sender email not verified in SendGrid');
      console.log('- Complete sender authentication process');
    }
  });