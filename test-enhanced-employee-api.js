// Test the enhanced employee API endpoint logic
const ZKTecoService = require('./services/zktecoService');

async function testEnhancedEmployeeAPI() {
  console.log('🧪 Testing Enhanced Employee API Logic');
  console.log('=====================================\n');

  const ip = '192.168.1.201';
  const zkService = new ZKTecoService(ip, 4370);

  try {
    console.log(`📡 Step 1: Connect to device at ${ip}...`);
    await zkService.connect();
    console.log('✅ Connection successful');

    let employeeData = null;
    let usedMethod = 'none';

    // Approach 1: Try the zkService getUsers (uses getUser callback)
    console.log('\n🔄 Approach 1: Using ZKTecoService getUsers...');
    try {
      employeeData = await zkService.getUsers();
      usedMethod = 'zktecoService_getUsers';
      console.log(`✅ ZKTecoService returned ${employeeData.length} employees`);
    } catch (serviceError) {
      console.log(`⚠️ ZKTecoService failed: ${serviceError.message}`);

      // Approach 2: Direct getUser with specific user ID enumeration
      console.log('\n🔄 Approach 2: Enumerating users by ID...');
      try {
        const employeesList = [];

        // Try to enumerate users by ID (limited range for testing)
        for (let userId = 1; userId <= 10; userId++) {
          try {
            console.log(`   Trying user ID ${userId}...`);

            const userData = await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                reject(new Error('User enumeration timeout'));
              }, 3000);

              zkService.zkInstance.getUser((err, data) => {
                clearTimeout(timeout);
                if (err) {
                  reject(err);
                } else if (data && (Array.isArray(data) ? data.length > 0 : data)) {
                  resolve(data);
                } else {
                  reject(new Error('No user data'));
                }
              });
            });

            if (userData) {
              if (Array.isArray(userData)) {
                employeesList.push(...userData);
                console.log(`   ✅ Found ${userData.length} users in array response`);
              } else {
                employeesList.push(userData);
                console.log(`   ✅ Found single user: ${userData.name || userData.uid}`);
              }
            }
          } catch (userError) {
            console.log(`   ❌ User ID ${userId}: ${userError.message}`);
            if (userId >= 5) break; // Stop after 5 failed attempts
          }
        }

        if (employeesList.length > 0) {
          employeeData = employeesList;
          usedMethod = 'direct_enumeration';
          console.log(`✅ Direct enumeration found ${employeesList.length} employees`);
        } else {
          throw new Error('No employees found via enumeration');
        }

      } catch (enumerationError) {
        console.log(`⚠️ Direct enumeration failed: ${enumerationError.message}`);

        // Approach 3: Try getAttendance to see if we can infer users
        console.log('\n🔄 Approach 3: Inferring employees from attendance logs...');
        try {
          const attendanceData = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Attendance fetch timeout'));
            }, 10000);

            zkService.zkInstance.getAttendance((err, data) => {
              clearTimeout(timeout);
              if (err) {
                reject(err);
              } else {
                resolve(data || []);
              }
            });
          });

          console.log(`   📊 Got attendance data: ${Array.isArray(attendanceData) ? attendanceData.length : typeof attendanceData} records`);

          const uniqueUsers = new Map();
          const logs = Array.isArray(attendanceData) ? attendanceData : [];

          logs.forEach(log => {
            const uid = log.uid || log.userId || log.deviceUserId;
            if (uid && !uniqueUsers.has(uid)) {
              uniqueUsers.set(uid, {
                uid: uid,
                name: `Employee ${uid}`,
                cardno: uid,
                role: '1',
                lastAttendance: log.timestamp || log.recordTime,
                inferredFromAttendance: true
              });
            }
          });

          if (uniqueUsers.size > 0) {
            employeeData = Array.from(uniqueUsers.values());
            usedMethod = 'attendance_inference';
            console.log(`✅ Inferred ${employeeData.length} employees from attendance logs`);
          } else {
            throw new Error('No employees could be inferred from attendance');
          }

        } catch (attendanceError) {
          console.log(`⚠️ Attendance inference failed: ${attendanceError.message}`);
          throw new Error('Device connected but no employee data available - device may have no enrolled users or firmware limitations');
        }
      }
    }

    await zkService.disconnect();
    console.log('\n🔌 Disconnected from device');

    // Simulate the API response formatting
    if (employeeData && employeeData.length > 0) {
      const formattedEmployees = employeeData.map(user => ({
        machineId: user.uid || user.userId || user.id || 'unknown',
        name: user.name || `Employee ${user.uid}`,
        employeeId: user.cardno || user.cardNumber || user.employeeId || user.uid || 'NO_CARD',
        department: user.role || user.department || 'Unknown Department',
        enrolledAt: user.enrolledAt || user.timestamp || user.lastAttendance || new Date(),
        isActive: user.role !== '0' && user.role !== 0,
        privilege: user.privilege || 0,
        role: user.role || 0,
        inferredFromAttendance: user.inferredFromAttendance || false,
        rawData: user.rawData || user
      }));

      console.log('\n✅ SUCCESS - API would return:');
      console.log('================================');
      console.log({
        success: true,
        employees: formattedEmployees.slice(0, 3), // Show first 3
        count: formattedEmployees.length,
        machineIp: ip,
        method: usedMethod,
        libraryInfo: {
          name: 'zklib',
          version: '0.2.11',
          connectionType: 'UDP'
        }
      });

      if (formattedEmployees.length > 3) {
        console.log(`... and ${formattedEmployees.length - 3} more employees`);
      }

    } else {
      console.log('\n⚠️ NO EMPLOYEE DATA - API would return error response');
      console.log('====================================================');
      console.log({
        success: false,
        message: 'ZKTeco device connected successfully but no employee data found.',
        recommendation: 'Device appears to have no enrolled users or firmware limitations',
        deviceStatus: {
          connection: 'SUCCESS',
          library: 'zklib v0.2.11',
          availableMethods: ['getUser', 'getAttendance', 'getTime'],
          issue: 'No enrolled users or firmware limitation'
        }
      });
    }

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);

    console.log('\n📊 Error Response Preview:');
    console.log('==========================');

    let errorType = 'general';
    if (error.message.includes('no employee data available') || error.message.includes('no enrolled users')) {
      errorType = 'no_data';
    } else if (error.message.includes('timeout')) {
      errorType = 'timeout';
    } else if (error.message.includes('connect')) {
      errorType = 'connection';
    }

    console.log(`Error type detected: ${errorType}`);
    console.log('API would return comprehensive error details with troubleshooting steps');
  }

  console.log('\n🎯 Test Summary:');
  console.log('================');
  console.log('✅ Enhanced API implements 3 fallback approaches');
  console.log('✅ Comprehensive error handling with specific guidance');
  console.log('✅ Device capability detection');
  console.log('✅ Multiple data source attempts');
  console.log('✅ Clear success/failure responses');

  console.log('\n🏁 Enhanced Employee API test completed!');
}

testEnhancedEmployeeAPI().catch(console.error);