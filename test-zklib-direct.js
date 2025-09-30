// Direct test of zklib functionality without port conflicts
console.log('🧪 Testing ZKLib Direct Connection');
console.log('=================================\n');

const ZKLib = require('zklib');

async function testDirectConnection() {
  const ip = '192.168.1.201';
  const port = 4370;

  console.log(`📡 Testing direct connection to ${ip}:${port}`);

  try {
    // Create zklib instance with different connection options
    const connectionOptions = [
      { ip, port, inport: 4371, timeout: 5000 },
      { ip, port, timeout: 5000 },
      { ip, port, inport: 4372, timeout: 5000 }
    ];

    for (let i = 0; i < connectionOptions.length; i++) {
      const options = connectionOptions[i];
      console.log(`\n🔄 Attempt ${i + 1}: Testing with options:`, options);

      try {
        const zkInstance = new ZKLib(options);
        console.log('   ✅ ZKLib instance created');

        // Test connection - zklib uses connect() method
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Connection timeout'));
          }, 8000);

          // Try different connection methods
          if (typeof zkInstance.connect === 'function') {
            zkInstance.connect((err) => {
              clearTimeout(timeout);
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          } else if (typeof zkInstance.createConnection === 'function') {
            zkInstance.createConnection((err) => {
              clearTimeout(timeout);
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          } else {
            clearTimeout(timeout);
            reject(new Error('No connection method available'));
          }
        });

        console.log('   ✅ Connection established successfully!');

        // Test getInfo if available
        if (typeof zkInstance.getInfo === 'function') {
          console.log('   🔍 Testing getInfo...');
          const info = await new Promise((resolve, reject) => {
            zkInstance.getInfo((err, data) => {
              if (err) {
                reject(err);
              } else {
                resolve(data);
              }
            });
          });
          console.log('   ✅ Device Info:', info);
        } else {
          console.log('   ⚠️ getInfo method not available');
        }

        // Test getUser
        console.log('   🔍 Testing getUser...');
        try {
          const users = await new Promise((resolve, reject) => {
            const userTimeout = setTimeout(() => {
              reject(new Error('getUser timeout'));
            }, 10000);

            zkInstance.getUser((err, data) => {
              clearTimeout(userTimeout);
              if (err) {
                reject(err);
              } else {
                resolve(data || []);
              }
            });
          });

          console.log(`   ✅ Users retrieved: ${Array.isArray(users) ? users.length : typeof users}`);
          if (Array.isArray(users) && users.length > 0) {
            console.log('   📋 Sample users:', users.slice(0, 2));

            // We found users! Let's format them properly
            const formattedUsers = users.map(user => ({
              machineId: user.uid || user.userId || 'unknown',
              name: user.name || `Employee ${user.uid}`,
              employeeId: user.cardno || user.cardNumber || user.uid || 'NO_CARD',
              department: user.role || 'Unknown',
              privilege: user.privilege || 0,
              role: user.role || 0
            }));

            console.log('\n🎯 SUCCESS! Employee API Response Format:');
            console.log('==========================================');
            console.log({
              success: true,
              employees: formattedUsers.slice(0, 3),
              count: formattedUsers.length,
              machineIp: ip,
              method: 'standard_getUser',
              libraryInfo: {
                name: 'zklib',
                version: '1.0.0',
                connectionType: 'TCP'
              }
            });

            // Test done, disconnect
            try {
              await new Promise((resolve) => {
                if (typeof zkInstance.disconnect === 'function') {
                  zkInstance.disconnect((err) => {
                    resolve();
                  });
                } else if (typeof zkInstance.close === 'function') {
                  zkInstance.close();
                  resolve();
                } else {
                  resolve();
                }
              });
              console.log('   🔌 Disconnected successfully');
            } catch (disconnectError) {
              console.log('   ⚠️ Disconnect error (non-critical):', disconnectError.message);
            }

            return true; // Success!
          }

        } catch (userError) {
          console.log(`   ⚠️ getUser failed: ${userError.message}`);

          // Try attendance logs as fallback
          console.log('   🔄 Trying attendance logs as fallback...');
          try {
            const attendance = await new Promise((resolve, reject) => {
              const attTimeout = setTimeout(() => {
                reject(new Error('getAttendance timeout'));
              }, 15000);

              zkInstance.getAttendance((err, data) => {
                clearTimeout(attTimeout);
                if (err) {
                  reject(err);
                } else {
                  resolve(data || []);
                }
              });
            });

            console.log(`   📊 Attendance records: ${Array.isArray(attendance) ? attendance.length : typeof attendance}`);

            if (Array.isArray(attendance) && attendance.length > 0) {
              // Extract unique users from attendance
              const uniqueUsers = new Map();
              attendance.forEach(record => {
                const uid = record.uid || record.userId || record.deviceUserId;
                if (uid && !uniqueUsers.has(uid)) {
                  uniqueUsers.set(uid, {
                    uid: uid,
                    name: `Employee ${uid}`,
                    cardno: uid,
                    role: '1',
                    inferredFromAttendance: true,
                    lastSeen: record.timestamp || record.recordTime
                  });
                }
              });

              const inferredUsers = Array.from(uniqueUsers.values());
              console.log(`   ✅ Inferred ${inferredUsers.length} users from attendance`);

              if (inferredUsers.length > 0) {
                const formattedUsers = inferredUsers.map(user => ({
                  machineId: user.uid,
                  name: user.name,
                  employeeId: user.cardno,
                  department: 'Inferred from Attendance',
                  inferredFromAttendance: true,
                  lastSeen: user.lastSeen
                }));

                console.log('\n🎯 SUCCESS (Attendance Fallback)! Employee API Response:');
                console.log('======================================================');
                console.log({
                  success: true,
                  employees: formattedUsers.slice(0, 3),
                  count: formattedUsers.length,
                  machineIp: ip,
                  method: 'attendance_inference',
                  note: 'Users inferred from attendance logs',
                  libraryInfo: {
                    name: 'zklib',
                    version: '1.0.0',
                    connectionType: 'TCP'
                  }
                });

                // Test done, disconnect
                try {
                  await new Promise((resolve) => {
                    if (typeof zkInstance.disconnect === 'function') {
                      zkInstance.disconnect((err) => {
                        resolve();
                      });
                    } else if (typeof zkInstance.close === 'function') {
                      zkInstance.close();
                      resolve();
                    } else {
                      resolve();
                    }
                  });
                  console.log('   🔌 Disconnected successfully');
                } catch (disconnectError) {
                  console.log('   ⚠️ Disconnect error (non-critical):', disconnectError.message);
                }

                return true; // Success!
              }
            }

          } catch (attendanceError) {
            console.log(`   ❌ Attendance fallback failed: ${attendanceError.message}`);
          }
        }

        // Clean disconnect
        try {
          await new Promise((resolve) => {
            if (typeof zkInstance.disconnect === 'function') {
              zkInstance.disconnect((err) => {
                resolve();
              });
            } else if (typeof zkInstance.close === 'function') {
              zkInstance.close();
              resolve();
            } else {
              resolve();
            }
          });
          console.log('   🔌 Disconnected');
        } catch (disconnectError) {
          console.log('   ⚠️ Disconnect error (non-critical):', disconnectError.message);
        }

        return false; // No data found but connection worked

      } catch (connectionError) {
        console.log(`   ❌ Connection failed: ${connectionError.message}`);
      }
    }

    console.log('\n❌ All connection attempts failed');
    return false;

  } catch (error) {
    console.error('💥 Test failed:', error);
    return false;
  }
}

// Test device availability first
async function testDeviceAvailability() {
  const net = require('net');
  const ip = '192.168.1.201';
  const port = 4370;

  console.log('🔍 Testing device availability...');

  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(3000);

    socket.connect(port, ip, () => {
      console.log('✅ Device is reachable');
      socket.destroy();
      resolve(true);
    });

    socket.on('error', (error) => {
      console.log(`❌ Device not reachable: ${error.message}`);
      resolve(false);
    });

    socket.on('timeout', () => {
      console.log('❌ Device connection timeout');
      socket.destroy();
      resolve(false);
    });
  });
}

// Run the test
async function runTest() {
  const isAvailable = await testDeviceAvailability();

  if (!isAvailable) {
    console.log('🚫 Device is not available. Make sure:');
    console.log('   - Device IP 192.168.1.201 is correct');
    console.log('   - Device is powered on and connected to network');
    console.log('   - Port 4370 is not blocked by firewall');
    console.log('   - Device is in network mode (not standalone)');
    return;
  }

  const success = await testDirectConnection();

  console.log('\n🏁 Test Summary:');
  console.log('===============');
  if (success) {
    console.log('✅ ZKTeco integration is working!');
    console.log('✅ Employee data can be retrieved');
    console.log('✅ API endpoint should work properly');
  } else {
    console.log('⚠️ ZKTeco device is reachable but no employee data found');
    console.log('💡 Possible reasons:');
    console.log('   - Device has no enrolled users');
    console.log('   - Firmware doesn\'t support user enumeration');
    console.log('   - SDK communication is disabled on device');
    console.log('💡 Solutions:');
    console.log('   - Enroll test users via device admin interface');
    console.log('   - Enable SDK/network mode in device settings');
    console.log('   - Use mock data endpoint for testing: ?mock=true');
  }

  console.log('\n🔚 Test completed!');
}

runTest().catch(console.error);