// Test script for ZKTeco functionality
const ZKTecoService = require('./services/zktecoService');
const zktecoRealDataService = require('./services/zktecoRealDataService');
const attendanceSyncService = require('./services/attendanceSync');

async function testZKTecoConnection() {
  console.log('🚀 Starting comprehensive ZKTeco functionality test...\n');

  // Test 1: Basic ZKTeco connection
  console.log('📡 Test 1: Basic ZKTeco Connection');
  console.log('================================');

  const zkService = new ZKTecoService('192.168.1.201', 4370);

  try {
    console.log('Connecting to ZKTeco device...');
    const connectionResult = await zkService.connect();
    console.log('✅ Connection successful:', connectionResult);

    // Test 2: Check available methods
    console.log('\n🔍 Test 2: Available Methods');
    console.log('============================');
    const availableMethods = zkService.getAvailableMethods();
    console.log('Available methods:', availableMethods);

    // Test 3: Get device info if possible
    console.log('\n📋 Test 3: Device Information');
    console.log('=============================');
    if (zkService.isDeviceConnected()) {
      console.log('Device is connected, trying to get more info...');

      if (zkService.zkInstance && typeof zkService.zkInstance.getInfo === 'function') {
        try {
          const deviceInfo = await zkService.zkInstance.getInfo();
          console.log('✅ Device info:', deviceInfo);
        } catch (infoError) {
          console.log('⚠️ Could not get device info:', infoError.message);
        }
      } else {
        console.log('⚠️ getInfo method not available');
      }
    }

    // Test 4: Try to get users
    console.log('\n👥 Test 4: Get Users');
    console.log('====================');
    try {
      const users = await zkService.getUsers();
      console.log(`✅ Retrieved ${users.length} users:`);
      users.slice(0, 5).forEach((user, index) => {
        console.log(`  ${index + 1}. ${user.name} (UID: ${user.uid}, Card: ${user.cardno})`);
      });
      if (users.length > 5) {
        console.log(`  ... and ${users.length - 5} more users`);
      }
    } catch (usersError) {
      console.log('⚠️ Could not get users:', usersError.message);
    }

    // Test 5: Try to get attendance logs
    console.log('\n📊 Test 5: Get Attendance Logs');
    console.log('===============================');
    try {
      const logs = await zkService.getAttendanceLogs();
      console.log(`✅ Retrieved ${logs.length} attendance logs:`);
      logs.slice(0, 5).forEach((log, index) => {
        console.log(`  ${index + 1}. UID: ${log.uid}, Time: ${log.timestamp}, Type: ${log.type}`);
      });
      if (logs.length > 5) {
        console.log(`  ... and ${logs.length - 5} more logs`);
      }
    } catch (logsError) {
      console.log('⚠️ Could not get attendance logs:', logsError.message);
    }

    // Test 6: Test real data service
    console.log('\n🔄 Test 6: Real Data Service');
    console.log('=============================');

    // Initialize the real data service with mock data
    const zkInstances = new Map();
    zkInstances.set('192.168.1.201', zkService.zkInstance);

    const machineConnections = new Map();
    machineConnections.set('192.168.1.201', { status: 'connected' });

    zktecoRealDataService.initialize(zkInstances, machineConnections);
    attendanceSyncService.initialize(zkInstances, machineConnections);

    // Test verification
    try {
      const verification = await zktecoRealDataService.verifyConnection(zkService.zkInstance, '192.168.1.201');
      console.log('✅ Connection verification:', verification);
    } catch (verifyError) {
      console.log('⚠️ Verification failed:', verifyError.message);
    }

    // Test real logs fetch
    try {
      const realLogs = await zktecoRealDataService.fetchRealAttendanceLogs('192.168.1.201');
      console.log(`✅ Real data service retrieved ${realLogs.count} logs`);
    } catch (realLogsError) {
      console.log('⚠️ Real logs fetch failed:', realLogsError.message);
    }

    // Disconnect
    console.log('\n🔌 Disconnecting...');
    await zkService.disconnect();
    console.log('✅ Disconnected successfully');

  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    console.log('\n🔍 Attempting basic network connectivity test...');

    // Test basic network connectivity
    const net = require('net');
    const socket = new net.Socket();

    socket.setTimeout(5000);

    socket.on('connect', () => {
      console.log('✅ Network connectivity to device successful');
      socket.destroy();
    });

    socket.on('timeout', () => {
      console.log('❌ Network connectivity timeout');
      socket.destroy();
    });

    socket.on('error', (err) => {
      console.log('❌ Network connectivity failed:', err.message);
    });

    try {
      socket.connect(4370, '192.168.1.201');
    } catch (netError) {
      console.log('❌ Network test failed:', netError.message);
    }
  }

  console.log('\n🏁 ZKTeco functionality test completed!');
}

// Run the test
testZKTecoConnection().catch(console.error);
