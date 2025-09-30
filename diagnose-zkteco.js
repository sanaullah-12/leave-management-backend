// Diagnostic script to identify the exact ZKTeco issue
const ZKTecoService = require('./services/zktecoService');
const EnhancedZKTecoService = require('./services/enhancedZktecoService');

async function runZKTecoDiagnostics() {
  console.log('🔍 Starting ZKTeco Diagnostics...\n');
  
  // Use your actual IP and port from environment or defaults
  const deviceIp = process.env.ZKTECO_IP || '192.168.1.201';
  const devicePort = parseInt(process.env.ZKTECO_PORT) || 4370;
  
  console.log(`📡 Testing device connection to: ${deviceIp}:${devicePort}\n`);
  
  // Test with existing service first
  console.log('🧪 Testing existing ZKTecoService...');
  const existingService = new ZKTecoService(deviceIp, devicePort);
  
  try {
    const connectionResult = await existingService.connect();
    console.log('✅ Existing service connection successful');
    console.log('📋 Connection result:', connectionResult);
    
    // Check available methods
    const methods = existingService.getAvailableMethods();
    console.log('🔧 Available methods:', methods);
    
    // Try getUsers with existing service
    try {
      console.log('\n👥 Testing getUsers with existing service...');
      const users = await existingService.getUsers();
      console.log(`✅ getUsers returned ${users.length} users:`, users.slice(0, 3)); // Show first 3
    } catch (usersError) {
      console.log('❌ getUsers failed with existing service:', usersError.message);
    }
    
    await existingService.disconnect();
    
  } catch (connectionError) {
    console.log('❌ Existing service connection failed:', connectionError.message);
  }
  
  // Test with enhanced service
  console.log('\n🧪 Testing enhanced ZKTecoService...');
  const enhancedService = new EnhancedZKTecoService(deviceIp, devicePort);
  
  try {
    const enhancedConnection = await enhancedService.connect();
    console.log('✅ Enhanced service connection successful');
    console.log('📋 Enhanced connection result:', enhancedConnection);
    
    // Check available methods in enhanced service
    const enhancedMethods = enhancedService.getAvailableMethods();
    console.log('🔧 Available methods in enhanced service:', enhancedMethods.slice(0, 15)); // Show first 15
    
    // Try getUsers with enhanced service
    try {
      console.log('\n👥 Testing getUsers with enhanced service...');
      const enhancedUsers = await enhancedService.getUsers();
      console.log(`✅ Enhanced getUsers returned ${enhancedUsers.length} users:`, enhancedUsers.slice(0, 3)); // Show first 3
    } catch (enhancedUsersError) {
      console.log('❌ Enhanced getUsers failed:', enhancedUsersError.message);
    }
    
    // Try getAttendance as well
    try {
      console.log('\n📊 Testing getAttendance with enhanced service...');
      const attendance = await enhancedService.getAttendanceLogs();
      console.log(`✅ Enhanced getAttendance returned ${attendance.length} records:`, attendance.slice(0, 3)); // Show first 3
    } catch (attendanceError) {
      console.log('❌ Enhanced getAttendance failed:', attendanceError.message);
    }
    
    await enhancedService.disconnect();
    
  } catch (enhancedConnectionError) {
    console.log('❌ Enhanced service connection failed:', enhancedConnectionError.message);
  }
  
  // Network connectivity test
  console.log('\n🌐 Testing network connectivity...');
  const net = require('net');
  
  const connectivityTest = new Promise((resolve) => {
    const socket = new net.Socket();
    const timeoutDuration = 5000;
    
    socket.setTimeout(timeoutDuration);
    
    socket.on('connect', () => {
      console.log('✅ Network connectivity to device successful');
      socket.destroy();
      resolve('connected');
    });
    
    socket.on('timeout', () => {
      console.log('❌ Network connectivity timeout');
      socket.destroy();
      resolve('timeout');
    });
    
    socket.on('error', (err) => {
      console.log('❌ Network connectivity failed:', err.message);
      resolve('error');
    });
    
    socket.connect(devicePort, deviceIp);
  });
  
  await connectivityTest;
  
  console.log('\n🎯 ZKTeco Diagnostics Completed!');
}

// Run the diagnostics
runZKTecoDiagnostics().catch(console.error);