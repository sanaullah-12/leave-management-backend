// Load environment variables
const path = require('path');
process.env.NODE_ENV = 'production';
require('dotenv').config({ path: path.join(__dirname, '.env.production') });

const { sendEmail, sendInvitationEmail, sendPasswordResetEmail } = require('./utils/email');

const testEnhancedNodemailer = async () => {
  console.log('🚀 Testing Enhanced Nodemailer System');
  console.log('=====================================');

  console.log('\n📧 Environment Check:');
  console.log('  - SMTP Host:', process.env.SMTP_HOST);
  console.log('  - SMTP Port:', process.env.SMTP_PORT);
  console.log('  - SMTP Email:', process.env.SMTP_EMAIL);
  console.log('  - Password Length:', process.env.SMTP_PASSWORD?.length);
  console.log('  - From Email:', process.env.FROM_EMAIL);
  console.log('  - From Name:', process.env.FROM_NAME);

  const testCases = [
    {
      type: 'Basic Email Test',
      email: 'qazisanaullah612@gmail.com',
      test: async () => {
        return await sendEmail({
          email: 'qazisanaullah612@gmail.com',
          subject: 'Enhanced Nodemailer Test - Basic',
          html: '<h2>✅ Enhanced Nodemailer Working!</h2><p>This email was sent using the new enhanced Nodemailer system with maximum deliverability features.</p>',
          text: 'Enhanced Nodemailer Working! This email was sent using the new enhanced system.',
          fromName: 'Test System'
        });
      }
    },
    {
      type: 'External Gmail Test',
      email: 'test.recipient.2024@gmail.com',
      test: async () => {
        return await sendEmail({
          email: 'test.recipient.2024@gmail.com',
          subject: 'Deliverability Test - Enhanced System',
          html: '<h2>📬 Inbox Delivery Test</h2><p>This email tests delivery to external Gmail accounts using enhanced headers and professional formatting.</p>',
          text: 'Inbox Delivery Test - This email tests delivery to external Gmail accounts.',
          fromName: 'Professional Team'
        });
      }
    },
    {
      type: 'Team Invitation Test',
      email: 'qazisanaullah612@gmail.com',
      test: async () => {
        return await sendInvitationEmail(
          {
            name: 'Test Employee',
            email: 'qazisanaullah612@gmail.com',
            company: 'Enhanced Systems Corp',
            department: 'Technology',
            position: 'Developer'
          },
          `test-token-${Date.now()}`,
          'HR Manager',
          'employee'
        );
      }
    },
    {
      type: 'External Team Invitation',
      email: 'external.invite.test@gmail.com',
      test: async () => {
        return await sendInvitationEmail(
          {
            name: 'External Test User',
            email: 'external.invite.test@gmail.com',
            company: 'Enhanced Systems Corp',
            department: 'Marketing',
            position: 'Marketing Specialist'
          },
          `external-token-${Date.now()}`,
          'Admin User',
          'employee'
        );
      }
    },
    {
      type: 'Password Reset Test',
      email: 'qazisanaullah612@gmail.com',
      test: async () => {
        return await sendPasswordResetEmail(
          {
            name: 'Test User',
            email: 'qazisanaullah612@gmail.com',
            company: 'Enhanced Systems Corp',
            employeeId: 'EMP001'
          },
          `reset-token-${Date.now()}`
        );
      }
    }
  ];

  let successCount = 0;
  let failureCount = 0;

  for (const testCase of testCases) {
    console.log(`\n🧪 Running: ${testCase.type}`);
    console.log(`📧 To: ${testCase.email}`);

    const startTime = Date.now();

    try {
      const result = await testCase.test();
      const endTime = Date.now();

      console.log(`✅ ${testCase.type} - SUCCESS (${endTime - startTime}ms)`);
      console.log(`📧 Message ID: ${result.messageId}`);
      console.log(`📧 Provider: ${result.provider}`);
      console.log(`📧 Response: ${result.response}`);

      if (result.accepted && result.accepted.length > 0) {
        console.log(`✅ Recipients accepted: ${result.accepted.join(', ')}`);
      }

      if (result.rejected && result.rejected.length > 0) {
        console.log(`⚠️ Recipients rejected: ${result.rejected.join(', ')}`);
      }

      successCount++;

      // Wait 3 seconds between tests to respect Gmail rate limits
      await new Promise(resolve => setTimeout(resolve, 3000));

    } catch (error) {
      console.error(`❌ ${testCase.type} - FAILED`);
      console.error(`Error: ${error.message}`);
      failureCount++;
    }
  }

  console.log('\n🎯 Test Summary:');
  console.log(`✅ Successful: ${successCount}/${testCases.length}`);
  console.log(`❌ Failed: ${failureCount}/${testCases.length}`);

  if (successCount === testCases.length) {
    console.log('\n🎉 ALL TESTS PASSED!');
    console.log('\n📧 What to verify:');
    console.log('1. Check your Gmail inbox for test emails');
    console.log('2. Look for "Enhanced Nodemailer Test", "Deliverability Test", team invitations');
    console.log('3. Verify emails have professional formatting and headers');
    console.log('4. Check if external test emails reach recipients (may take a few minutes)');
    console.log('\n💡 Key improvements in Enhanced Nodemailer:');
    console.log('- Professional email templates with XHTML compatibility');
    console.log('- Enhanced SMTP headers for better deliverability');
    console.log('- Automatic text version generation from HTML');
    console.log('- Connection pooling and rate limiting');
    console.log('- Better error diagnostics and retry logic');
    console.log('- Anti-spam headers and authentication hints');
  } else {
    console.log('\n⚠️ Some tests failed. Check the errors above for details.');
  }

  console.log('\n📈 Next Steps:');
  console.log('1. Monitor inbox delivery for 10-15 minutes');
  console.log('2. If external emails still don\'t arrive, they may be filtered by providers');
  console.log('3. Consider setting up SPF/DKIM/DMARC records for your domain');
  console.log('4. For maximum deliverability, consider a business email service');
};

// Run the test
testEnhancedNodemailer().catch(error => {
  console.error('\n💥 Test suite failed:', error.message);
  console.error('Full error:', error);
  process.exit(1);
});