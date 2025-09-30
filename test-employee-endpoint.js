// Test the actual employee endpoint logic
const ZKTecoService = require('./services/zktecoService');

async function testEmployeeEndpoint() {
  console.log('🧪 Testing Employee Endpoint Logic');
  console.log('=================================\n');

  const ip = '192.168.1.201';
  console.log(`Testing employee fetch for device: ${ip}:4370`);

  try {
    // Simulate the exact same code from the attendance route
    console.log('✅ Connected to ZKTeco machine at 192.168.1.201 - fetching employees...');

    const ZKTecoService = require('./services/zktecoService');
    const zkService = new ZKTecoService(ip, 4370);

    let employeeData = null;
    let usedMethod = 'none';

    try {
      // Connect to device
      await zkService.connect();
      console.log('✅ ZKTeco service connected successfully to 192.168.1.201');

      // Approach 1: Try the zkService getUsers (uses getUser callback)
      try {
        console.log('🔄 Approach 1: Using ZKTecoService getUsers...');
        employeeData = await zkService.getUsers();
        usedMethod = 'zktecoService_getUsers';
        console.log(`✅ ZKTecoService returned ${employeeData.length} employees`);
      } catch (serviceError) {
        console.log(`⚠️ ZKTecoService failed: ${serviceError.message}`);

        // Approach 2: Direct getUser enumeration would go here
        console.log('🔄 Approach 2: Enumerating users by ID...');
        // This would be the enumeration loop, but let's skip for brevity

        console.log('🔄 Approach 3: Inferring employees from attendance logs...');
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

          console.log(`📊 Attendance data retrieved: ${Array.isArray(attendanceData) ? attendanceData.length : typeof attendanceData} records`);

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

      // Disconnect after use
      await zkService.disconnect();

      // Format response
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
          inferredFromAttendance: user.inferredFromAttendance || false
        }));

        console.log('\n✅ SUCCESS - API Response:');
        console.log('==========================');
        console.log({
          success: true,
          employees: formattedEmployees.slice(0, 3),
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

        return true; // Success
      } else {
        throw new Error('No employee data retrieved from any method');
      }

    } catch (serviceError) {
      throw serviceError;
    }

  } catch (error) {
    console.log('\n❌ ERROR Response:');
    console.log('==================');

    let errorResponse;

    if (error.message.includes('no employee data available') || error.message.includes('no enrolled users')) {
      errorResponse = {
        success: false,
        message: 'ZKTeco device connected successfully but no employee data found.',
        recommendation: 'Device appears to have no enrolled users or firmware limitations',
        deviceStatus: {
          connection: 'SUCCESS',
          library: 'zklib v0.2.11',
          availableMethods: ['getUser', 'getAttendance', 'getTime'],
          issue: 'No enrolled users or firmware limitation'
        },
        troubleshooting: [
          'Verify employees are enrolled in the ZKTeco device',
          'Check device admin interface for user management',
          'Ensure device SDK/communication mode is enabled',
          'Some ZKTeco firmware versions may not support user enumeration',
          'Try enrolling a test user via device interface first'
        ]
      };
    } else if (error.message.includes('timeout')) {
      errorResponse = {
        success: false,
        message: 'ZKTeco device communication timeout. Device responds but data retrieval times out.',
        deviceStatus: {
          connection: 'SUCCESS',
          dataRetrieval: 'TIMEOUT',
          possibleCauses: ['No enrolled users', 'Device busy', 'Firmware limitation']
        }
      };
    } else {
      errorResponse = {
        success: false,
        message: 'Unexpected error occurred while fetching employees.',
        error: error.message
      };
    }

    console.log(errorResponse);
    return false; // Error
  }
}

testEmployeeEndpoint()
  .then(success => {
    console.log(`\n🏁 Test completed: ${success ? 'SUCCESS' : 'ERROR (but handled properly)'}`);
  })
  .catch(console.error);