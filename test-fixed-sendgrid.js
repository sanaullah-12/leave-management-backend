// Test fixed SendGrid configuration
console.log('🔧 FIXED SendGrid Configuration Test');
console.log('===================================');

const sgMail = require('@sendgrid/mail');

const sendGridKey = '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';
const fromEmail = 'qazisanaullah612@gmail.com';

sgMail.setApiKey(sendGridKey);

// Simplified configuration without problematic spam check
const mailOptions = {
  from: {
    email: fromEmail,
    name: 'Leave Management System'
  },
  to: 'qazisanaullah612@gmail.com',
  subject: '✅ Fixed SendGrid Production Test',
  html: `
    <h2>Fixed SendGrid Configuration</h2>
    <p>This email tests the corrected SendGrid configuration without spam_check issues.</p>
    <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
    <p>If you receive this, SendGrid is working correctly in production.</p>
  `,
  text: `Fixed SendGrid Configuration Test

This email tests the corrected SendGrid configuration without spam_check issues.
Timestamp: ${new Date().toISOString()}
If you receive this, SendGrid is working correctly in production.`,
  categories: ['production-test'],
  trackingSettings: {
    clickTracking: { enable: false },
    openTracking: { enable: false },
    subscriptionTracking: { enable: false }
  }
};

console.log('📤 Testing fixed configuration...');

const startTime = Date.now();

sgMail.send(mailOptions)
  .then((response) => {
    const endTime = Date.now();
    console.log('✅ SUCCESS: Email sent successfully!');
    console.log('Response Time:', endTime - startTime, 'ms');
    console.log('Status Code:', response[0]?.statusCode);
    console.log('Message ID:', response[0]?.headers?.['x-message-id']);

    console.log('\n🎉 SendGrid is now working correctly!');
    console.log('Check your inbox for the test email.');
  })
  .catch((error) => {
    const endTime = Date.now();
    console.log('❌ Error:', error.message);
    console.log('Response Time:', endTime - startTime, 'ms');

    if (error.response?.body) {
      console.log('Error details:', JSON.stringify(error.response.body, null, 2));
    }
  });