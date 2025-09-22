require('dotenv').config({ path: '.env.production' });
const { sendEmail } = require('./utils/email');

console.log('🧪 Testing Production Email with Fallback...');
console.log('==============================================');

async function testProductionEmail() {
  try {
    const result = await sendEmail({
      email: 'qazisanaullah612@gmail.com',
      subject: 'Production Test - Fallback Mechanism',
      html: '<h2>Production Email Test</h2><p>Testing production email delivery with SMTP fallback.</p>',
      text: 'Production Email Test - Testing production email delivery with SMTP fallback.',
      category: 'production-test'
    });

    console.log('✅ Production email sent successfully!');
    console.log('Result:', result);
  } catch (error) {
    console.error('❌ Production email failed:');
    console.error('Error:', error.message);
  }
}

testProductionEmail();