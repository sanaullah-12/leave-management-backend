// Email Diagnosis & Fix Test
require('dotenv').config({ path: '.env.production' });
const { sendEmail } = require('./utils/email');

const testEmailDelivery = async () => {
  console.log('🔍 EMAIL DELIVERY DIAGNOSIS');
  console.log('='.repeat(50));

  // 1. Check Environment Variables
  console.log('\n📋 Environment Check:');
  console.log(`SMTP_HOST: ${process.env.SMTP_HOST || 'NOT SET'}`);
  console.log(`SMTP_PORT: ${process.env.SMTP_PORT || 'NOT SET'}`);
  console.log(`SMTP_EMAIL: ${process.env.SMTP_EMAIL || 'NOT SET'}`);
  console.log(`SMTP_PASSWORD: ${process.env.SMTP_PASSWORD ? '[SET - Length: ' + process.env.SMTP_PASSWORD.length + ']' : 'NOT SET'}`);
  console.log(`SENDGRID_API_KEY: ${process.env.SENDGRID_API_KEY ? '[SET - Length: ' + process.env.SENDGRID_API_KEY.length + ']' : 'NOT SET'}`);
  console.log(`FROM_EMAIL: ${process.env.FROM_EMAIL || 'NOT SET'}`);
  console.log(`FROM_NAME: ${process.env.FROM_NAME || 'NOT SET'}`);

  // 2. Check Gmail Password Type
  console.log('\n🔐 Gmail Authentication Check:');
  if (process.env.SMTP_PASSWORD && process.env.SMTP_EMAIL?.includes('gmail.com')) {
    const password = process.env.SMTP_PASSWORD;
    if (password.length === 16 && /^[a-z]{16}$/.test(password)) {
      console.log('✅ Gmail App Password format detected (16 lowercase chars)');
    } else {
      console.log('❌ ISSUE: Not a Gmail App Password!');
      console.log('   Current password format: Length=' + password.length);
      console.log('   Expected: 16 lowercase characters (App Password)');
      console.log('   🔧 FIX: Generate Gmail App Password at https://myaccount.google.com/apppasswords');
    }
  }

  // 3. Check Railway Hosting Issues
  console.log('\n🚂 Railway Hosting Check:');
  if (process.env.NODE_ENV === 'production') {
    console.log('⚠️  Running in production (Railway)');
    console.log('   Railway blocks SMTP ports 25, 465, 587 by default');
    if (process.env.SENDGRID_API_KEY) {
      console.log('✅ SendGrid API key found - this will work on Railway');
    } else {
      console.log('❌ No SendGrid API key - SMTP will likely fail on Railway');
      console.log('   🔧 FIX: Get SendGrid API key at https://sendgrid.com/');
    }
  }

  // 4. Test Email Delivery
  console.log('\n📧 Testing Email Delivery:');

  const testEmails = [
    {
      name: 'Primary Test',
      email: 'qazisanaullah612@gmail.com',
      subject: '✅ Email Diagnosis Test - Primary'
    },
    {
      name: 'External Test',
      email: 'test.external.2024@gmail.com',
      subject: '📬 Email Diagnosis Test - External'
    }
  ];

  for (const test of testEmails) {
    console.log(`\n🧪 ${test.name} → ${test.email}`);

    try {
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">🔧 Email System Diagnosis</h2>
          <p><strong>Test:</strong> ${test.name}</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <div style="background: #f0f9ff; border: 2px solid #2563eb; padding: 15px; border-radius: 8px;">
            <h3>✅ Email Delivery Working!</h3>
            <p>If you receive this email, your system is properly configured.</p>
            <ul>
              <li>Provider: ${process.env.SENDGRID_API_KEY ? 'SendGrid API' : 'SMTP'}</li>
              <li>From: ${process.env.FROM_EMAIL}</li>
              <li>Environment: ${process.env.NODE_ENV}</li>
            </ul>
          </div>
          <p><em>Leave Management System - Email Diagnosis</em></p>
        </div>
      `;

      const startTime = Date.now();
      const result = await sendEmail({
        email: test.email,
        subject: test.subject,
        html: html,
        fromName: 'Email Diagnosis System'
      });

      const duration = Date.now() - startTime;

      console.log(`   ✅ SUCCESS (${duration}ms)`);
      console.log(`   📧 Provider: ${result.provider}`);
      console.log(`   📧 Message ID: ${result.messageId}`);
      console.log(`   📧 Status: ${result.response}`);

    } catch (error) {
      console.log(`   ❌ FAILED: ${error.message}`);

      // Specific error analysis
      if (error.message.includes('authentication')) {
        console.log('   🔧 FIX: Check Gmail App Password');
      } else if (error.message.includes('connection')) {
        console.log('   🔧 FIX: Railway blocking SMTP - use SendGrid');
      } else if (error.message.includes('timeout')) {
        console.log('   🔧 FIX: Network timeout - try SendGrid API');
      }
    }

    // Wait between tests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // 5. DNS & Deliverability Check
  console.log('\n🌐 DNS & Deliverability Notes:');
  console.log('For production email deliverability:');
  console.log('1. 📧 Use SendGrid (recommended for Railway)');
  console.log('2. 🔐 Set up SPF record: "v=spf1 include:sendgrid.net ~all"');
  console.log('3. 🔑 Set up DKIM via SendGrid dashboard');
  console.log('4. 📝 Set up DMARC: "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com"');
  console.log('5. ✅ Use verified sender domain in SendGrid');

  // 6. Next Steps
  console.log('\n🚀 Next Steps:');
  console.log('1. If using Gmail: Generate App Password (not regular password)');
  console.log('2. For Railway: Add SENDGRID_API_KEY environment variable');
  console.log('3. Test invite employee feature after fixes');
  console.log('4. Check spam folders if emails still missing');
  console.log('5. Monitor Railway logs for email delivery status');
};

// Run diagnosis
testEmailDelivery().catch(error => {
  console.error('\n💥 Diagnosis failed:', error);
  process.exit(1);
});