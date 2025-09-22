require('dotenv').config({ path: '.env.production' });

console.log('🔍 COMPREHENSIVE EMAIL SYSTEM ANALYSIS');
console.log('=====================================');

// Test 1: Environment Configuration
console.log('\n📋 1. ENVIRONMENT CONFIGURATION');
console.log('--------------------------------');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('SMTP_HOST:', process.env.SMTP_HOST);
console.log('SMTP_PORT:', process.env.SMTP_PORT);
console.log('SMTP_EMAIL:', process.env.SMTP_EMAIL);
console.log('SMTP_PASSWORD:', process.env.SMTP_PASSWORD ? `${process.env.SMTP_PASSWORD.substring(0, 4)}...` : 'NOT SET');
console.log('SendGrid_Key:', process.env.SendGrid_Key ? `${process.env.SendGrid_Key.substring(0, 10)}...` : 'NOT SET');
console.log('FROM_EMAIL:', process.env.FROM_EMAIL);
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);

// Test 2: Email Logic Analysis
console.log('\n🎯 2. EMAIL PROVIDER LOGIC');
console.log('--------------------------');
const isProduction = process.env.NODE_ENV === 'production';
const sendGridKey = process.env.SendGrid_Key || process.env.SENDGRID_API_KEY;
const isSendGridConfigured = sendGridKey &&
                             sendGridKey !== 'your_sendgrid_api_key_here' &&
                             sendGridKey.length > 10;
const willUseSendGrid = isProduction && isSendGridConfigured;

console.log('Is Production:', isProduction);
console.log('SendGrid Key Present:', !!sendGridKey);
console.log('SendGrid Key Length:', sendGridKey?.length || 0);
console.log('SendGrid Configured:', isSendGridConfigured);
console.log('Will Use SendGrid:', willUseSendGrid);
console.log('Will Use SMTP:', !willUseSendGrid);

// Test 3: SendGrid API Key Validation
console.log('\n🔑 3. SENDGRID VALIDATION');
console.log('------------------------');

if (sendGridKey) {
  console.log('Testing SendGrid API key...');

  try {
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(sendGridKey);

    // Test API key by attempting to send a test email
    sgMail.send({
      to: 'qazisanaullah612@gmail.com',
      from: process.env.FROM_EMAIL,
      subject: 'SendGrid Production Validation Test',
      text: 'Testing SendGrid API key validation',
      html: '<h2>SendGrid Test</h2><p>Testing SendGrid API key validation</p>',
    })
    .then(() => {
      console.log('✅ SendGrid API key is VALID and working');
    })
    .catch((error) => {
      console.error('❌ SendGrid API key FAILED:');
      console.error('Status:', error.code);
      console.error('Message:', error.message);
      if (error.response?.body) {
        console.error('Details:', error.response.body);
      }
    });
  } catch (error) {
    console.error('❌ SendGrid module error:', error.message);
  }
} else {
  console.log('❌ No SendGrid API key found');
}

// Test 4: SMTP Configuration Validation
console.log('\n📧 4. SMTP VALIDATION');
console.log('---------------------');

const nodemailer = require('nodemailer');

if (process.env.SMTP_HOST && process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
  console.log('Testing SMTP configuration...');

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  transporter.verify((error, success) => {
    if (error) {
      console.error('❌ SMTP verification FAILED:');
      console.error('Error code:', error.code);
      console.error('Error message:', error.message);

      // Analyze specific SMTP errors
      if (error.code === 'EAUTH') {
        console.error('💡 CAUSE: Gmail authentication failed');
        console.error('💡 SOLUTION: Generate new Gmail App Password');
      } else if (error.code === 'ECONNECTION') {
        console.error('💡 CAUSE: Cannot connect to Gmail SMTP server');
        console.error('💡 SOLUTION: Check network/firewall settings');
      }
    } else {
      console.log('✅ SMTP configuration is VALID and ready');

      // Test actual email sending
      transporter.sendMail({
        from: process.env.FROM_EMAIL,
        to: 'qazisanaullah612@gmail.com',
        subject: 'SMTP Production Validation Test',
        text: 'Testing SMTP configuration in production environment',
        html: '<h2>SMTP Test</h2><p>Testing SMTP configuration in production environment</p>',
      })
      .then((info) => {
        console.log('✅ SMTP test email sent successfully');
        console.log('Message ID:', info.messageId);
      })
      .catch((error) => {
        console.error('❌ SMTP test email failed:', error.message);
      });
    }
  });
} else {
  console.log('❌ SMTP configuration incomplete');
  console.log('Missing variables:', {
    SMTP_HOST: !process.env.SMTP_HOST,
    SMTP_EMAIL: !process.env.SMTP_EMAIL,
    SMTP_PASSWORD: !process.env.SMTP_PASSWORD
  });
}

// Test 5: Production Environment Analysis
console.log('\n🚀 5. PRODUCTION ENVIRONMENT ANALYSIS');
console.log('-------------------------------------');

if (isProduction) {
  console.log('Production mode detected');

  if (isSendGridConfigured) {
    console.log('✅ SendGrid is configured for production');
    console.log('📧 Emails will be sent via SendGrid');
  } else {
    console.log('⚠️ SendGrid NOT configured for production');

    if (process.env.SMTP_HOST && process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
      console.log('📧 Will fall back to SMTP');
    } else {
      console.log('❌ NO EMAIL PROVIDER CONFIGURED!');
      console.log('💡 This explains why emails are not being sent');
    }
  }
} else {
  console.log('Development mode - using SMTP');
}

// Test 6: Railway Environment Analysis
console.log('\n🚂 6. RAILWAY DEPLOYMENT ANALYSIS');
console.log('---------------------------------');
console.log('⚠️ IMPORTANT: Railway does NOT automatically load .env.production files!');
console.log('📝 Environment variables must be set manually in Railway dashboard');
console.log('');
console.log('Required Railway Environment Variables:');
console.log('• NODE_ENV=production');
console.log('• SMTP_HOST=smtp.gmail.com');
console.log('• SMTP_PORT=587');
console.log('• SMTP_EMAIL=qazisanaullah612@gmail.com');
console.log('• SMTP_PASSWORD=tiep jsal jfkz nysb');
console.log('• FROM_EMAIL=qazisanaullah612@gmail.com');
console.log('• FROM_NAME=Leave Management System');
console.log('• SendGrid_Key=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');
console.log('• FRONTEND_URL=https://leave-management-frontend-neon.vercel.app');

console.log('\n🎯 DIAGNOSIS COMPLETE');
console.log('====================');