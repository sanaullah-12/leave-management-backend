require('dotenv').config({ path: '.env.production' });

console.log('🔍 Production Email Configuration Check');
console.log('================================');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('SendGrid_Key exists:', !!process.env.SendGrid_Key);
console.log('SendGrid_Key length:', process.env.SendGrid_Key ? process.env.SendGrid_Key.length : 0);
console.log('SendGrid_Key prefix:', process.env.SendGrid_Key ? process.env.SendGrid_Key.substring(0, 10) : 'NOT SET');
console.log('SMTP_EMAIL:', process.env.SMTP_EMAIL);
console.log('FROM_EMAIL:', process.env.FROM_EMAIL);
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);

// Test SendGrid configuration
const sendGridKey = process.env.SendGrid_Key || process.env.SENDGRID_API_KEY;
const isSendGridConfigured = sendGridKey &&
                             sendGridKey !== 'your_sendgrid_api_key_here' &&
                             sendGridKey.length > 10;

console.log('');
console.log('🎯 Email Provider Logic:');
console.log('Is Production:', process.env.NODE_ENV === 'production');
console.log('SendGrid Configured:', isSendGridConfigured);
console.log('Will use SendGrid:', (process.env.NODE_ENV === 'production' && isSendGridConfigured));

// Test SendGrid API key validity
if (isSendGridConfigured) {
  console.log('');
  console.log('🧪 Testing SendGrid API Key...');

  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(sendGridKey);

  // Test the API key by attempting to send a test email
  const msg = {
    to: 'qazisanaullah612@gmail.com',
    from: process.env.FROM_EMAIL,
    subject: 'SendGrid Production Test',
    text: 'Testing SendGrid configuration in production',
    html: '<h2>SendGrid Production Test</h2><p>Testing SendGrid configuration in production</p>',
  };

  sgMail
    .send(msg)
    .then(() => {
      console.log('✅ SendGrid test email sent successfully!');
    })
    .catch((error) => {
      console.error('❌ SendGrid test failed:');
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);
      if (error.response) {
        console.error('Response body:', error.response.body);
      }
    });
} else {
  console.log('❌ SendGrid not configured properly');
}