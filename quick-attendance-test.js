// Quick test of attendance functionality
const ZKTecoService = require('./services/zktecoService');

async function testAttendance() {
  console.log('🧪 Quick Attendance Test');
  console.log('========================\n');

  const zkService = new ZKTecoService('192.168.1.201', 4370);

  try {
    console.log('🔄 Connecting...');
    await zkService.connect();

    console.log('🔄 Getting attendance...');
    const attendance = await zkService.getAttendance();

    console.log(`✅ Got ${attendance.length} attendance records`);
    if (attendance.length > 0) {
      console.log('📋 Sample records:', attendance.slice(0, 3));
    }

    await zkService.disconnect();
    console.log('✅ Attendance test passed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testAttendance();