// Load environment variables
const path = require('path');
process.env.NODE_ENV = 'production';
require('dotenv').config({ path: path.join(__dirname, '.env.production') });

const { sendEmail, sendInvitationEmail, sendPasswordResetEmail } = require('./utils/email');

const testCleanNodemailer = async () => {
  console.log('🚀 Testing Clean Nodemailer System (ONLY Nodemailer)');
  console.log('=================================================');

  console.log('\n📧 Environment Check:');
  console.log('  - SMTP Host:', process.env.SMTP_HOST);
  console.log('  - SMTP Port:', process.env.SMTP_PORT);
  console.log('  - SMTP Email:', process.env.SMTP_EMAIL);
  console.log('  - Password Length:', process.env.SMTP_PASSWORD?.length);

  const testCases = [
    {
      type: 'Basic Email Test',
      email: 'qazisanaullah612@gmail.com',
      test: async () => {
        return await sendEmail({
          email: 'qazisanaullah612@gmail.com',
          subject: 'Clean Nodemailer Test - Basic Email',
          html: '<h2>✅ Clean Nodemailer Working!</h2><p>This email was sent using ONLY Nodemailer with your SMTP credentials.</p>',
          fromName: 'Leave Management System'
        });
      }
    },
    {
      type: 'External Email Test',
      email: 'test.external.2024@gmail.com',
      test: async () => {
        return await sendEmail({
          email: 'test.external.2024@gmail.com',
          subject: 'Clean Nodemailer Test - External Delivery',
          html: '<h2>📬 External Delivery Test</h2><p>Testing external email delivery with clean Nodemailer implementation.</p>',
          fromName: 'Leave Management System'
        });
      }
    },
    {
      type: 'Employee Invitation Test',
      email: 'qazisanaullah612@gmail.com',
      test: async () => {
        return await sendInvitationEmail(
          {
            name: 'Test Employee',
            email: 'qazisanaullah612@gmail.com',
            company: 'Test Company Corp',
            department: 'Engineering',
            position: 'Software Engineer'
          },
          `invitation-token-${Date.now()}`,
          'Admin User',
          'employee'
        );
      }
    },
    {
      type: 'External Employee Invitation',
      email: 'external.test.invite@gmail.com',
      test: async () => {
        return await sendInvitationEmail(
          {
            name: 'External Test Employee',
            email: 'external.test.invite@gmail.com',
            company: 'Test Company Corp',
            department: 'Marketing',
            position: 'Marketing Specialist'
          },
          `external-invitation-token-${Date.now()}`,
          'HR Manager',
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
            company: 'Test Company Corp',
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

      // Wait 2 seconds between tests
      await new Promise(resolve => setTimeout(resolve, 2000));

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
    console.log('\n🎉 ALL TESTS PASSED - CLEAN NODEMAILER WORKING!');
    console.log('\n📧 What to verify:');
    console.log('1. Check your Gmail inbox for test emails');
    console.log('2. Look for invitation emails with professional formatting');
    console.log('3. Verify external emails reach recipients');
    console.log('4. Confirm employee invitations work in production');
    console.log('\n💡 Clean Nodemailer implementation:');
    console.log('- Uses ONLY Nodemailer with your SMTP credentials');
    console.log('- No fallback systems or complex routing');
    console.log('- Professional email templates');
    console.log('- Simple and reliable delivery');
  } else {
    console.log('\n⚠️ Some tests failed. Check the errors above for details.');
  }

  console.log('\n📈 Next Steps:');
  console.log('1. Test the "Invite Employee" feature in your production app');
  console.log('2. Verify emails reach external recipients');
  console.log('3. Check spam folders if emails are not in inbox');
};

// Run the test
testCleanNodemailer().catch(error => {
  console.error('\n💥 Test suite failed:', error.message);
  console.error('Full error:', error);
  process.exit(1);
});