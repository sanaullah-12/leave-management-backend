require('dotenv').config({ path: '.env.production' });

console.log('🔍 DETAILED SendGrid Error Analysis');
console.log('===================================');

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SendGrid_Key);

const msg = {
  to: 'qazisanaullah612@gmail.com',
  from: process.env.FROM_EMAIL, // This is the issue - sender email not verified
  subject: 'SendGrid Verification Test',
  text: 'Testing SendGrid with detailed error logging',
  html: '<h2>SendGrid Test</h2><p>Testing SendGrid with detailed error logging</p>',
};

console.log('📧 Attempting to send with configuration:');
console.log('From:', msg.from);
console.log('To:', msg.to);
console.log('SendGrid Key:', process.env.SendGrid_Key.substring(0, 15) + '...');

sgMail.send(msg)
  .then((response) => {
    console.log('✅ SendGrid email sent successfully!');
    console.log('Response:', response[0].statusCode);
  })
  .catch((error) => {
    console.error('❌ SendGrid error details:');
    console.error('Code:', error.code);
    console.error('Message:', error.message);

    if (error.response && error.response.body) {
      console.error('Response Body:', JSON.stringify(error.response.body, null, 2));

      // Check for specific error types
      const errors = error.response.body.errors || [];
      errors.forEach((err, index) => {
        console.error(`Error ${index + 1}:`, err.message);
        if (err.field) console.error(`Field:`, err.field);
        if (err.help) console.error(`Help:`, err.help);
      });
    }

    console.log('\n💡 SOLUTION NEEDED:');
    if (error.code === 400) {
      console.log('1. Go to SendGrid Dashboard: https://app.sendgrid.com');
      console.log('2. Settings → Sender Authentication → Single Sender Verification');
      console.log('3. Add and verify email:', process.env.FROM_EMAIL);
      console.log('4. Check your email inbox for verification link');
    }
  });