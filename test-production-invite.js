// Test production invite flow with exact same environment loading as server
const path = require('path');
const fs = require('fs');

// Use same environment loading logic as server.js
if (process.env.NODE_ENV === 'production') {
  require('dotenv').config({ path: path.join(__dirname, '.env.production') });
} else {
  require('dotenv').config();
}

console.log('🔍 PRODUCTION INVITE DEBUG TEST');
console.log('================================');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('Environment loading method:', process.env.NODE_ENV === 'production' ? '.env.production' : '.env');

// Debug environment variables (same as server.js)
console.log("=== ENVIRONMENT VARIABLES ===");
console.log("NODE_ENV:", process.env.NODE_ENV);
console.log("FRONTEND_URL:", process.env.FRONTEND_URL ? "✅ Set" : "❌ Missing");
console.log("📧 EMAIL CONFIGURATION:");
console.log("SMTP_HOST:", process.env.SMTP_HOST ? "✅ Set" : "❌ Missing");
console.log("SMTP_PORT:", process.env.SMTP_PORT ? "✅ Set" : "❌ Missing");
console.log("SMTP_EMAIL:", process.env.SMTP_EMAIL ? "✅ Set" : "❌ Missing");
console.log("SMTP_PASSWORD:", process.env.SMTP_PASSWORD ? "✅ Set" : "❌ Missing");
console.log("FROM_EMAIL:", process.env.FROM_EMAIL ? "✅ Set" : "❌ Missing");
console.log("FROM_NAME:", process.env.FROM_NAME ? "✅ Set" : "❌ Missing");
console.log("===============================");

const { sendInvitationEmail } = require('./utils/email');

const testProductionInvite = async () => {
  console.log('\n🧪 Testing Exact Production Invite Flow');

  const testEmployee = {
    name: 'Production Test Employee',
    email: 'external.production.test@gmail.com',
    company: 'Production Test Corp',
    department: 'Engineering',
    position: 'Software Engineer',
    _id: '507f1f77bcf86cd799439011', // Mock ObjectId
    employeeId: 'EMP001'
  };

  const testToken = 'test-invitation-token-' + Date.now();
  const testInviter = 'Production Admin';

  console.log('\n🔍 Test Parameters:');
  console.log('Employee:', testEmployee.name);
  console.log('Email:', testEmployee.email);
  console.log('Company:', testEmployee.company);
  console.log('Token length:', testToken.length);
  console.log('Inviter:', testInviter);

  try {
    console.log('\n📤 Sending invitation email...');
    const result = await sendInvitationEmail(
      testEmployee,
      testToken,
      testInviter,
      'employee'
    );

    console.log('\n✅ SUCCESS - Production invite email sent!');
    console.log('📧 Message ID:', result.messageId);
    console.log('📧 Provider:', result.provider);
    console.log('📧 Response:', result.response);
    console.log('📧 Accepted:', result.accepted);
    console.log('📧 Rejected:', result.rejected);
    console.log('📧 Full result:', JSON.stringify(result, null, 2));

  } catch (error) {
    console.error('\n❌ FAILED - Production invite email error');
    console.error('Error message:', error.message);
    console.error('Error code:', error.code);
    console.error('Error response:', error.response);
    console.error('Error responseCode:', error.responseCode);
    console.error('Full error stack:', error.stack);
    console.error('Full error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
  }

  console.log('\n🎯 COMPARISON RESULTS:');
  console.log('1. Environment loading: Same as production server ✓');
  console.log('2. Email function: Same sendInvitationEmail ✓');
  console.log('3. SMTP credentials: Same as test script ✓');
  console.log('4. Execution: Synchronous (like test) vs Async (like invite) ⚠️');
};

testProductionInvite().catch(error => {
  console.error('\n💥 Test suite crashed:', error);
  process.exit(1);
});