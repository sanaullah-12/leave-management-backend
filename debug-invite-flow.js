// Debug the exact invite flow to find where it hangs
const path = require('path');

// Load environment exactly like server.js
if (process.env.NODE_ENV === 'production') {
  require('dotenv').config({ path: path.join(__dirname, '.env.production') });
} else {
  require('dotenv').config();
}

const mongoose = require('mongoose');

async function debugInviteFlow() {
  console.log('🔍 DEBUGGING EXACT INVITE FLOW');
  console.log('==============================');

  try {
    console.log('1. 🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/leave-management-dev', {
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ 1. MongoDB connected');

    console.log('2. 📊 Loading User model...');
    const User = require('./models/User');
    console.log('✅ 2. User model loaded');

    console.log('3. 👤 Creating test employee...');
    const testEmployee = new User({
      name: 'Debug Test Employee',
      email: 'debug.test.employee@gmail.com',
      role: 'employee',
      department: 'Engineering',
      position: 'Test Engineer',
      joinDate: new Date(),
      company: new mongoose.Types.ObjectId(),
      invitedBy: new mongoose.Types.ObjectId(),
      status: 'pending'
    });
    console.log('✅ 3. Test employee created');

    console.log('4. 🔑 Generating invitation token...');
    const startTokenTime = Date.now();
    const invitationToken = testEmployee.generateInvitationToken();
    const tokenTime = Date.now() - startTokenTime;
    console.log(`✅ 4. Token generated in ${tokenTime}ms, length: ${invitationToken.length}`);

    console.log('5. 💾 Saving employee to database...');
    const startSaveTime = Date.now();
    await testEmployee.save();
    const saveTime = Date.now() - startSaveTime;
    console.log(`✅ 5. Employee saved in ${saveTime}ms`);

    console.log('6. 📧 Testing email sending...');
    const startEmailTime = Date.now();

    // Import email function
    const { sendInvitationEmail } = require('./utils/email');

    const emailPayload = {
      ...testEmployee.toObject(),
      company: 'Debug Test Corp'
    };

    console.log('6a. 📧 Calling sendInvitationEmail...');
    const emailResult = await sendInvitationEmail(
      emailPayload,
      invitationToken,
      'Debug Admin',
      'employee'
    );
    const emailTime = Date.now() - startEmailTime;
    console.log(`✅ 6. Email sent in ${emailTime}ms`);
    console.log('📧 Email result:', {
      messageId: emailResult.messageId,
      provider: emailResult.provider,
      accepted: emailResult.accepted?.length || 0
    });

    console.log('7. 🧹 Cleanup - removing test employee...');
    await User.findByIdAndDelete(testEmployee._id);
    console.log('✅ 7. Test employee removed');

    console.log('\n🎯 TIMING ANALYSIS:');
    console.log(`- Token generation: ${tokenTime}ms`);
    console.log(`- Database save: ${saveTime}ms`);
    console.log(`- Email sending: ${emailTime}ms`);
    console.log(`- Total time: ${Date.now() - startTokenTime}ms`);

    if (emailTime > 25000) {
      console.log('⚠️  EMAIL TOOK TOO LONG - This would cause frontend timeout!');
    } else {
      console.log('✅ All operations completed within acceptable time');
    }

  } catch (error) {
    console.error('❌ DEBUG FLOW FAILED:', error.message);
    console.error('❌ Error at step:', error.step || 'unknown');
    console.error('❌ Full error:', error);
  } finally {
    console.log('\n🔌 Closing MongoDB connection...');
    await mongoose.connection.close();
    console.log('✅ Connection closed');
    process.exit(0);
  }
}

// Set timeout to kill if it hangs
const timeout = setTimeout(() => {
  console.error('\n💥 DEBUG FLOW TIMED OUT AFTER 35 SECONDS');
  console.error('This indicates the same hanging issue exists in the flow');
  process.exit(1);
}, 35000);

debugInviteFlow().then(() => {
  clearTimeout(timeout);
}).catch(error => {
  clearTimeout(timeout);
  console.error('\n💥 DEBUG FLOW CRASHED:', error);
  process.exit(1);
});