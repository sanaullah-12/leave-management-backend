const nodemailer = require('nodemailer');

// Create Ethereal test account for development
const createTestEmailConfig = async () => {
  try {
    const testAccount = await nodemailer.createTestAccount();
    
    console.log('🧪 Test Email Account Created:');
    console.log('📧 Email:', testAccount.user);
    console.log('🔑 Password:', testAccount.pass);
    console.log('🌐 SMTP Host:', testAccount.smtp.host);
    console.log('🚪 SMTP Port:', testAccount.smtp.port);
    console.log('\n📝 Add these to your .env file:');
    console.log(`SMTP_HOST=${testAccount.smtp.host}`);
    console.log(`SMTP_PORT=${testAccount.smtp.port}`);
    console.log(`SMTP_EMAIL=${testAccount.user}`);
    console.log(`SMTP_PASSWORD=${testAccount.pass}`);
    console.log(`FROM_EMAIL=${testAccount.user}`);
    
    return testAccount;
  } catch (error) {
    console.error('Failed to create test account:', error);
  }
};

module.exports = { createTestEmailConfig };