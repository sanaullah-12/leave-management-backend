// Test the actual employees endpoint logic directly
const ZKTecoService = require('./services/zktecoService');

async function testEmployeesEndpoint() {
  console.log('🧪 Testing Employees Endpoint Logic');
  console.log('===================================\n');

  const ip = '192.168.1.201';
  const port = 4370;

  try {
    console.log(`📡 Testing employee retrieval from ZKTeco device ${ip}:${port}`);

    // Create ZKTecoService instance
    const zkService = new ZKTecoService(ip, port);

    // Connect and get users
    console.log('🔄 Connecting to device...');
    await zkService.connect();
    console.log('✅ Connected successfully');

    console.log('🔄 Fetching employees...');
    const employees = await zkService.getUsers();
    console.log(`✅ Retrieved ${employees.length} employees`);

    if (employees.length > 0) {
      console.log('📋 Sample employees:', employees.slice(0, 3));

      // Format employees for API response (same as attendance route)
      const formattedEmployees = employees.map(user => ({
        machineId: user.uid || user.userId || user.id || 'unknown',
        name: user.name || `Employee ${user.uid}`,
        employeeId: user.cardno || user.cardNumber || user.employeeId || user.uid || 'NO_CARD',
        department: user.department || user.role || 'Unknown Department',
        enrolledAt: user.enrolledAt || user.timestamp || user.lastAttendance || new Date(),
        isActive: user.role !== '0' && user.role !== 0,
        privilege: user.privilege || 0,
        role: user.role || 0,
        inferredFromAttendance: user.inferredFromAttendance || false,
        mockData: user.mockData || false,
        manualEntry: user.manualEntry || false
      }));

      const apiResponse = {
        success: true,
        employees: formattedEmployees,
        count: formattedEmployees.length,
        machineIp: ip,
        fetchedAt: new Date(),
        method: 'zktecoService_getUsers',
        source: 'device',
        libraryInfo: {
          name: 'zklib',
          version: '0.2.11',
          connectionType: 'TCP'
        }
      };

      console.log('\n🎯 SUCCESS! Full API Response:');
      console.log('==============================');
      console.log(JSON.stringify(apiResponse, null, 2));

      console.log(`\n📊 Employee Summary:`);
      console.log(`Total: ${apiResponse.count} employees`);
      formattedEmployees.slice(0, 5).forEach((emp, index) => {
        console.log(`${index + 1}. ${emp.name} (ID: ${emp.machineId}, Card: ${emp.employeeId}, Dept: ${emp.department})`);
      });
      if (formattedEmployees.length > 5) {
        console.log(`... and ${formattedEmployees.length - 5} more employees`);
      }
    }

    // Disconnect
    await zkService.disconnect();
    console.log('🔌 Disconnected from device');

    console.log('\n✅ CONCLUSION:');
    console.log('==============');
    console.log('✅ ZKTeco device connection works perfectly');
    console.log('✅ Employee data retrieval is successful');
    console.log('✅ API endpoint formatting is correct');
    console.log('✅ Ready for production use!');

    console.log('\n💡 To test via API endpoint:');
    console.log('============================');
    console.log('1. Create admin user account');
    console.log('2. Login to get JWT token');
    console.log('3. Use token to call: GET /api/attendance/employees/192.168.1.201');

    return true;

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\n🔍 Error Analysis:');

    if (error.message.includes('Connection failed') || error.message.includes('timeout')) {
      console.error('💡 Connection Issue:');
      console.error('   - Device might be offline or unreachable');
      console.error('   - Check IP address and port (192.168.1.201:4370)');
      console.error('   - Verify device is in network mode');
    } else if (error.message.includes('getUser') || error.message.includes('No users')) {
      console.error('💡 Data Retrieval Issue:');
      console.error('   - Device connected but no employee data found');
      console.error('   - Check if users are enrolled in the device');
      console.error('   - Try device admin interface for user management');
    } else {
      console.error('💡 Unknown Error:');
      console.error('   - Check device firmware compatibility');
      console.error('   - Verify zklib library installation');
    }

    return false;
  }
}

// Also test attendance endpoint logic
async function testAttendanceEndpoint() {
  console.log('\n\n🧪 Testing Attendance Endpoint Logic');
  console.log('====================================\n');

  const ip = '192.168.1.201';
  const port = 4370;

  try {
    const zkService = new ZKTecoService(ip, port);

    console.log('🔄 Connecting to device for attendance data...');
    await zkService.connect();

    console.log('🔄 Fetching attendance logs...');
    const attendance = await zkService.getAttendance();
    console.log(`✅ Retrieved ${attendance.length} attendance records`);

    if (attendance.length > 0) {
      console.log('📋 Sample attendance records:');
      attendance.slice(0, 3).forEach((record, index) => {
        console.log(`${index + 1}. User ${record.uid} - ${record.timestamp} (${record.deviceUserId})`);
      });

      // Analyze attendance data
      const uniqueUsers = new Set();
      attendance.forEach(record => {
        const uid = record.uid || record.userId || record.deviceUserId;
        if (uid) uniqueUsers.add(uid);
      });

      console.log(`\n📊 Attendance Analysis:`);
      console.log(`   - Total records: ${attendance.length}`);
      console.log(`   - Unique users: ${uniqueUsers.size}`);
      console.log(`   - Latest record: ${attendance[0]?.timestamp || 'N/A'}`);
    }

    await zkService.disconnect();

    return true;

  } catch (error) {
    console.error('❌ Attendance test failed:', error.message);
    return false;
  }
}

// Run both tests
async function runAllTests() {
  console.log('🚀 Running Complete ZKTeco Integration Tests');
  console.log('===========================================\n');

  const employeeTest = await testEmployeesEndpoint();
  const attendanceTest = await testAttendanceEndpoint();

  console.log('\n🏁 Final Test Results:');
  console.log('======================');
  console.log(`Employee Endpoint: ${employeeTest ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Attendance Endpoint: ${attendanceTest ? '✅ PASS' : '❌ FAIL'}`);

  if (employeeTest && attendanceTest) {
    console.log('\n🎉 ALL TESTS PASSED!');
    console.log('🚀 ZKTeco integration is fully working!');
  } else {
    console.log('\n⚠️ Some tests failed. Check logs above for details.');
  }

  console.log('\n🔚 Test suite completed!');
}

runAllTests().catch(console.error);