// Comprehensive employee data retrieval solution for ZKTeco devices
const ZKTecoService = require('./services/zktecoService');

class ZKTecoEmployeeRetrieval {
  constructor(ip, port = 4370) {
    this.ip = ip;
    this.port = port;
    this.zkService = null;
  }

  async initialize() {
    this.zkService = new ZKTecoService(this.ip, this.port);
    await this.zkService.connect();
    return this.zkService.isDeviceConnected();
  }

  async cleanup() {
    if (this.zkService) {
      await this.zkService.disconnect();
    }
  }

  // Method 1: Standard getUser approach (what we've been using)
  async getEmployeesStandard() {
    console.log('🔄 Method 1: Standard getUser approach...');

    try {
      // Enable device for communication
      if (typeof this.zkService.zkInstance.enableDevice === 'function') {
        await new Promise((resolve) => {
          this.zkService.zkInstance.enableDevice((err) => {
            resolve(); // Continue regardless of enable result
          });
        });
      }

      const employees = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Standard getUser timeout'));
        }, 20000);

        this.zkService.zkInstance.getUser((err, data) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            resolve(data || []);
          }
        });
      });

      console.log(`   ✅ Standard method returned: ${Array.isArray(employees) ? employees.length : typeof employees}`);
      return Array.isArray(employees) ? employees : (employees ? [employees] : []);

    } catch (error) {
      console.log(`   ❌ Standard method failed: ${error.message}`);
      return [];
    }
  }

  // Method 2: Individual user enumeration by ID
  async getEmployeesByEnumeration() {
    console.log('🔄 Method 2: User enumeration by ID...');

    const employees = [];

    try {
      // Try IDs from 1 to 1000 (common range for ZKTeco)
      for (let userId = 1; userId <= 1000; userId++) {
        try {
          const userData = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('Enumeration timeout'));
            }, 2000); // Short timeout for individual users

            // Try to get specific user by ID
            this.zkService.zkInstance.getUser(userId, (err, data) => {
              clearTimeout(timeout);
              if (err || !data) {
                reject(err || new Error('No user data'));
              } else {
                resolve(data);
              }
            });
          });

          if (userData) {
            employees.push(userData);
            console.log(`   📋 Found user ID ${userId}: ${userData.name || userData.uid || 'Unknown'}`);
          }

        } catch (userError) {
          // Expected for non-existent users - continue silently
          if (employees.length === 0 && userId <= 10) {
            // Only log first few failures for debugging
            console.log(`   ❌ No user at ID ${userId}`);
          }

          // Stop after finding 20 consecutive empty IDs
          if (userId > 20 && employees.length === 0) {
            break;
          }
        }

        // Progress indication for every 50 IDs
        if (userId % 50 === 0) {
          console.log(`   📊 Checked ${userId} IDs, found ${employees.length} employees`);
        }
      }

      console.log(`   ✅ Enumeration found ${employees.length} employees`);
      return employees;

    } catch (error) {
      console.log(`   ❌ Enumeration failed: ${error.message}`);
      return employees; // Return whatever we found
    }
  }

  // Method 3: Extract employees from attendance logs
  async getEmployeesFromAttendance() {
    console.log('🔄 Method 3: Extract from attendance logs...');

    try {
      const attendanceData = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Attendance fetch timeout'));
        }, 25000);

        this.zkService.zkInstance.getAttendance((err, data) => {
          clearTimeout(timeout);
          if (err) {
            reject(err);
          } else {
            resolve(data || []);
          }
        });
      });

      const logs = Array.isArray(attendanceData) ? attendanceData : [];
      console.log(`   📊 Retrieved ${logs.length} attendance records`);

      const uniqueUsers = new Map();

      // Extract unique users from attendance logs
      logs.forEach(log => {
        const uid = log.uid || log.userId || log.deviceUserId;
        if (uid && !uniqueUsers.has(uid)) {
          const user = {
            uid: uid,
            name: log.name || `Employee ${uid}`,
            cardno: log.cardno || uid,
            role: '1', // Default role
            timestamp: log.timestamp || log.recordTime,
            inferredFromAttendance: true,
            lastSeen: log.timestamp || log.recordTime
          };
          uniqueUsers.set(uid, user);
        }
      });

      const employees = Array.from(uniqueUsers.values());
      console.log(`   ✅ Extracted ${employees.length} unique employees from attendance`);

      return employees;

    } catch (error) {
      console.log(`   ❌ Attendance extraction failed: ${error.message}`);
      return [];
    }
  }

  // Method 4: Try different library methods
  async getEmployeesAlternativeMethods() {
    console.log('🔄 Method 4: Alternative library methods...');

    const methodsToTry = [
      'getAllUsers',
      'getUsers',
      'getUserInfo',
      'readUser',
      'getuser', // deprecated but might work
      'fetchUsers'
    ];

    for (const methodName of methodsToTry) {
      if (typeof this.zkService.zkInstance[methodName] === 'function') {
        console.log(`   🔄 Trying method: ${methodName}()`);

        try {
          const result = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error(`${methodName} timeout`));
            }, 15000);

            // Check if method expects callback or returns promise
            try {
              const methodResult = this.zkService.zkInstance[methodName]((err, data) => {
                clearTimeout(timeout);
                if (err) {
                  reject(err);
                } else {
                  resolve(data || []);
                }
              });

              // If method doesn't use callback, handle as promise or sync
              if (methodResult !== undefined) {
                clearTimeout(timeout);
                if (methodResult && typeof methodResult.then === 'function') {
                  methodResult.then(resolve).catch(reject);
                } else {
                  resolve(methodResult);
                }
              }
            } catch (syncError) {
              clearTimeout(timeout);
              reject(syncError);
            }
          });

          if (result && (Array.isArray(result) ? result.length > 0 : result)) {
            console.log(`   ✅ ${methodName}() returned data:`, Array.isArray(result) ? `${result.length} items` : typeof result);
            return Array.isArray(result) ? result : [result];
          } else {
            console.log(`   ⚠️ ${methodName}() returned empty result`);
          }

        } catch (error) {
          console.log(`   ❌ ${methodName}() failed: ${error.message}`);
        }
      } else {
        console.log(`   ❌ ${methodName}() not available`);
      }
    }

    return [];
  }

  // Method 5: Device-specific commands
  async getEmployeesDeviceSpecific() {
    console.log('🔄 Method 5: Device-specific commands...');

    try {
      // Try sending raw commands that might work with specific firmware
      const commands = [
        { cmd: 'CMD_USER_WRQ', desc: 'User write request' },
        { cmd: 'CMD_USERTEMP_WRQ', desc: 'User template write request' },
        { cmd: 'CMD_GET_FREE_SIZES', desc: 'Get storage info' }
      ];

      // For now, return empty since raw commands need specific implementation
      console.log('   ⚠️ Device-specific commands require firmware-specific implementation');
      return [];

    } catch (error) {
      console.log(`   ❌ Device-specific commands failed: ${error.message}`);
      return [];
    }
  }

  // Main method that tries all approaches
  async getAllEmployees() {
    console.log('🚀 Starting comprehensive employee data retrieval...\n');

    const methods = [
      { name: 'Standard getUser', fn: () => this.getEmployeesStandard() },
      { name: 'ID Enumeration', fn: () => this.getEmployeesByEnumeration() },
      { name: 'Attendance Inference', fn: () => this.getEmployeesFromAttendance() },
      { name: 'Alternative Methods', fn: () => this.getEmployeesAlternativeMethods() },
      { name: 'Device Specific', fn: () => this.getEmployeesDeviceSpecific() }
    ];

    let finalEmployees = [];
    let successMethod = 'none';

    for (const method of methods) {
      try {
        console.log(`\n📋 Trying: ${method.name}`);
        console.log('=' .repeat(method.name.length + 10));

        const employees = await method.fn();

        if (employees && employees.length > 0) {
          console.log(`✅ SUCCESS: ${method.name} found ${employees.length} employees!`);
          finalEmployees = employees;
          successMethod = method.name;
          break; // Stop on first success
        } else {
          console.log(`⚠️ ${method.name}: No employees found`);
        }

      } catch (error) {
        console.log(`❌ ${method.name} error: ${error.message}`);
      }
    }

    return {
      success: finalEmployees.length > 0,
      employees: finalEmployees,
      count: finalEmployees.length,
      method: successMethod,
      deviceIp: this.ip
    };
  }
}

// Test the comprehensive employee retrieval
async function testEmployeeRetrieval() {
  console.log('🎯 ZKTeco Employee Data Retrieval - Comprehensive Test');
  console.log('=====================================================\n');

  const retriever = new ZKTecoEmployeeRetrieval('192.168.1.201', 4370);

  try {
    console.log('📡 Initializing connection...');
    const connected = await retriever.initialize();

    if (!connected) {
      throw new Error('Failed to connect to ZKTeco device');
    }

    console.log('✅ Connected successfully to ZKTeco device\n');

    const result = await retriever.getAllEmployees();

    console.log('\n🎯 FINAL RESULTS');
    console.log('================');
    console.log('Success:', result.success);
    console.log('Method used:', result.method);
    console.log('Employees found:', result.count);

    if (result.employees.length > 0) {
      console.log('\n👥 Employee Data:');
      console.log('-----------------');
      result.employees.slice(0, 5).forEach((emp, index) => {
        console.log(`${index + 1}. ${emp.name || emp.uid} (ID: ${emp.uid}, Card: ${emp.cardno || 'N/A'})`);
      });

      if (result.employees.length > 5) {
        console.log(`... and ${result.employees.length - 5} more employees`);
      }

      console.log('\n📊 API Response Format:');
      console.log({
        success: true,
        employees: result.employees.slice(0, 2), // Show first 2
        count: result.count,
        method: result.method,
        deviceIp: result.deviceIp,
        timestamp: new Date()
      });

    } else {
      console.log('\n⚠️ No employee data found using any method');
      console.log('\n🔍 Possible reasons:');
      console.log('- Device has no enrolled users');
      console.log('- Firmware doesn\'t support user enumeration');
      console.log('- Device is in standalone mode');
      console.log('- SDK access is disabled on device');
      console.log('- Device needs restart or configuration change');
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await retriever.cleanup();
    console.log('\n🔌 Disconnected from device');
  }

  console.log('\n🏁 Employee retrieval test completed!');
}

// Run the test
testEmployeeRetrieval().catch(console.error);