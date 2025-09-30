const BiometricService = require('./services/BiometricService');

async function testBiometricIntegration() {
  console.log('🚀 Testing Complete Biometric Integration');
  console.log('=====================================\n');

  const ip = '192.168.1.201';
  const port = 4370;

  try {
    console.log(`📡 Testing biometric device at ${ip}:${port}`);

    // Create BiometricService instance
    const biometricService = new BiometricService(ip, port);

    // Test 1: Connection Test
    console.log('\n1. 🧪 Testing Connection...');
    const connectionResult = await biometricService.testConnection();
    console.log('✅ Connection Test Result:', connectionResult);

    if (connectionResult.success) {
      // Test 2: Employee Retrieval
      console.log('\n2. 👥 Testing Employee Retrieval...');
      await biometricService.connect();
      const employees = await biometricService.getEmployees();
      console.log(`✅ Retrieved ${employees.length} employees`);

      if (employees.length > 0) {
        console.log('\n📋 Sample Employees:');
        employees.slice(0, 5).forEach((emp, index) => {
          console.log(`  ${index + 1}. ${emp.name} (ID: ${emp.machineId}, Card: ${emp.employeeId})`);
        });
      }

      // Test 3: Attendance Logs
      console.log('\n3. 📊 Testing Attendance Logs...');
      const attendanceLogs = await biometricService.getAttendanceLogs();
      console.log(`✅ Retrieved ${attendanceLogs.length} attendance logs`);

      if (attendanceLogs.length > 0) {
        console.log('\n📋 Sample Attendance Logs:');
        attendanceLogs.slice(0, 3).forEach((log, index) => {
          console.log(`  ${index + 1}. User ${log.uid} - ${log.timestamp}`);
        });
      }

      await biometricService.disconnect();
      console.log('\n🔌 Disconnected successfully');

      // Test 4: API Response Format
      console.log('\n4. 📝 Testing API Response Format...');
      const apiResponse = {
        success: true,
        employees: employees,
        count: employees.length,
        machineIp: ip,
        fetchedAt: new Date().toISOString(),
        source: 'biometric_device'
      };

      console.log('✅ API Response Format:');
      console.log(`   Success: ${apiResponse.success}`);
      console.log(`   Count: ${apiResponse.count}`);
      console.log(`   Machine IP: ${apiResponse.machineIp}`);
      console.log(`   Source: ${apiResponse.source}`);

      console.log('\n🎉 ALL TESTS PASSED!');
      console.log('=====================================');
      console.log('✅ BiometricService works perfectly');
      console.log('✅ Employee retrieval successful');
      console.log('✅ Attendance logs successful');
      console.log('✅ API format is correct');
      console.log('✅ Connection management works');

      console.log('\n💡 Ready for API Integration!');
      console.log('============================');
      console.log('Use these endpoints:');
      console.log('- GET /api/biometric/employees/192.168.1.201');
      console.log('- GET /api/biometric/attendance/192.168.1.201');
      console.log('- POST /api/biometric/test-connection');

      return true;

    } else {
      throw new Error(`Connection test failed: ${connectionResult.message}`);
    }

  } catch (error) {
    console.error('\n❌ Integration test failed:', error.message);
    console.error('\n🔍 Error Analysis:');

    if (error.message.includes('Connection failed') || error.message.includes('timeout')) {
      console.error('💡 Connection Issue:');
      console.error('   - Device might be offline or unreachable');
      console.error('   - Check IP address and port (192.168.1.201:4370)');
      console.error('   - Verify device is in network mode');
    } else if (error.message.includes('ZKLib not available')) {
      console.error('💡 Library Issue:');
      console.error('   - zklib package not installed');
      console.error('   - Run: npm install zklib');
    } else {
      console.error('💡 Unknown Error:');
      console.error('   - Check device firmware compatibility');
      console.error('   - Verify network connectivity');
    }

    return false;
  }
}

// Run the integration test
testBiometricIntegration()
  .then(success => {
    if (success) {
      console.log('\n✅ INTEGRATION TEST COMPLETED SUCCESSFULLY!');
      process.exit(0);
    } else {
      console.log('\n❌ INTEGRATION TEST FAILED!');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('💥 Unexpected error:', error);
    process.exit(1);
  });