// Comprehensive ZKTeco device diagnostics
const ZKTecoService = require('./services/zktecoService');

async function comprehensiveDeviceDiagnostics() {
  console.log('🔍 ZKTeco Device Comprehensive Diagnostics');
  console.log('===========================================\n');

  const zkService = new ZKTecoService('192.168.1.201', 4370);

  try {
    // Step 1: Basic connection test
    console.log('📡 Step 1: Testing basic connection...');
    await zkService.connect();
    console.log('✅ Connection established successfully');

    if (!zkService.zkInstance) {
      throw new Error('ZKTeco instance not available after connection');
    }

    // Step 2: Get all available methods and properties
    console.log('\n🔧 Step 2: Analyzing device capabilities...');
    console.log('================================================');

    const allMethods = [];
    const allProperties = [];

    // Get instance methods and properties
    let obj = zkService.zkInstance;
    while (obj && obj !== Object.prototype) {
      const props = Object.getOwnPropertyNames(obj);
      props.forEach(prop => {
        if (prop !== 'constructor' && !prop.startsWith('_')) {
          try {
            const type = typeof zkService.zkInstance[prop];
            const item = { name: prop, type, source: obj.constructor.name };

            if (type === 'function') {
              allMethods.push(item);
            } else {
              allProperties.push(item);
            }
          } catch (e) {
            // Skip inaccessible properties
          }
        }
      });
      obj = Object.getPrototypeOf(obj);
    }

    console.log(`🔧 Available methods (${allMethods.length}):`);
    allMethods.sort((a, b) => a.name.localeCompare(b.name)).forEach(method => {
      console.log(`  - ${method.name}() [${method.source}]`);
    });

    console.log(`\n📊 Available properties (${allProperties.length}):`);
    allProperties.sort((a, b) => a.name.localeCompare(b.name)).forEach(prop => {
      console.log(`  - ${prop.name}: ${prop.type} [${prop.source}]`);
    });

    // Step 3: Test specific user-related methods
    console.log('\n👥 Step 3: Testing user-related methods...');
    console.log('===========================================');

    const userMethods = [
      'getUser', 'getUsers', 'getuser', 'getAllUsers', 'getAllUserID',
      'getUserInfo', 'readUser', 'fetchUsers', 'enumerateUsers',
      'getUserTemplate', 'getEmployees', 'getPersons'
    ];

    const availableUserMethods = [];
    const unavailableUserMethods = [];

    for (const methodName of userMethods) {
      if (typeof zkService.zkInstance[methodName] === 'function') {
        availableUserMethods.push(methodName);
        console.log(`✅ ${methodName}() - Available`);

        try {
          // Try to call the method with timeout
          console.log(`   🔄 Testing ${methodName}()...`);

          const testPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error(`${methodName} timeout (10s)`));
            }, 10000);

            try {
              if (methodName === 'getUser' || methodName === 'getuser') {
                // Callback-style method
                zkService.zkInstance[methodName]((err, data) => {
                  clearTimeout(timeout);
                  if (err) {
                    reject(err);
                  } else {
                    resolve(data);
                  }
                });
              } else {
                // Promise-style or sync method
                const result = zkService.zkInstance[methodName]();
                if (result && typeof result.then === 'function') {
                  result.then(resolve).catch(reject);
                } else {
                  clearTimeout(timeout);
                  resolve(result);
                }
              }
            } catch (callError) {
              clearTimeout(timeout);
              reject(callError);
            }
          });

          const result = await testPromise;
          console.log(`   ✅ ${methodName}() returned:`, typeof result, Array.isArray(result) ? `Array[${result.length}]` : result ? 'Data' : 'Empty');

          if (Array.isArray(result) && result.length > 0) {
            console.log(`   📋 Sample data:`, result[0]);
          }
        } catch (testError) {
          console.log(`   ⚠️ ${methodName}() failed:`, testError.message);
        }
      } else {
        unavailableUserMethods.push(methodName);
        console.log(`❌ ${methodName}() - Not Available`);
      }
    }

    // Step 4: Test device info methods
    console.log('\n📋 Step 4: Getting device information...');
    console.log('=======================================');

    const infoMethods = [
      'getInfo', 'getDeviceInfo', 'getinfo', 'version', 'serialNumber',
      'getVersion', 'getFirmwareVersion', 'getTime', 'gettime'
    ];

    for (const methodName of infoMethods) {
      if (typeof zkService.zkInstance[methodName] === 'function') {
        console.log(`✅ ${methodName}() - Available`);

        try {
          console.log(`   🔄 Calling ${methodName}()...`);

          const infoPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error(`${methodName} timeout (8s)`));
            }, 8000);

            try {
              if (methodName.includes('getInfo') || methodName === 'getinfo') {
                // Might be callback-style
                if (zkService.zkInstance[methodName].length > 0) {
                  zkService.zkInstance[methodName]((err, data) => {
                    clearTimeout(timeout);
                    if (err) reject(err);
                    else resolve(data);
                  });
                } else {
                  const result = zkService.zkInstance[methodName]();
                  if (result && typeof result.then === 'function') {
                    result.then(resolve).catch(reject);
                  } else {
                    clearTimeout(timeout);
                    resolve(result);
                  }
                }
              } else {
                const result = zkService.zkInstance[methodName]();
                if (result && typeof result.then === 'function') {
                  result.then(resolve).catch(reject);
                } else {
                  clearTimeout(timeout);
                  resolve(result);
                }
              }
            } catch (callError) {
              clearTimeout(timeout);
              reject(callError);
            }
          });

          const info = await infoPromise;
          console.log(`   ✅ ${methodName}() result:`, info);
        } catch (infoError) {
          console.log(`   ⚠️ ${methodName}() failed:`, infoError.message);
        }
      } else {
        console.log(`❌ ${methodName}() - Not Available`);
      }
    }

    // Step 5: Check library information
    console.log('\n📦 Step 5: Library information...');
    console.log('==================================');

    try {
      const packageInfo = require('./node_modules/zklib/package.json');
      console.log(`Library: ${packageInfo.name}`);
      console.log(`Version: ${packageInfo.version}`);
      console.log(`Description: ${packageInfo.description}`);
      console.log(`Author: ${packageInfo.author || 'Not specified'}`);
      console.log(`Repository: ${packageInfo.repository?.url || 'Not specified'}`);
    } catch (pkgError) {
      console.log('⚠️ Could not read library package info');
    }

    console.log(`\nZKTeco instance constructor: ${zkService.zkInstance.constructor.name}`);
    console.log(`Connection type: ${zkService.zkInstance.connectionType || 'Not specified'}`);

    await zkService.disconnect();
    console.log('\n✅ Diagnostics completed successfully');

    // Summary
    console.log('\n📊 DIAGNOSTIC SUMMARY');
    console.log('====================');
    console.log(`✅ Connection: SUCCESS`);
    console.log(`📋 Total methods: ${allMethods.length}`);
    console.log(`👥 User methods available: ${availableUserMethods.length}`);
    console.log(`👥 User methods unavailable: ${unavailableUserMethods.length}`);

    if (availableUserMethods.length > 0) {
      console.log(`💡 Recommended user methods: ${availableUserMethods.join(', ')}`);
    } else {
      console.log('⚠️ NO user-related methods available - this device/firmware may not support user enumeration');
    }

  } catch (error) {
    console.error('❌ Diagnostics failed:', error.message);

    // Try basic network test
    console.log('\n🔍 Network connectivity test...');
    const net = require('net');
    const socket = new net.Socket();

    socket.setTimeout(5000);
    socket.on('connect', () => {
      console.log('✅ Network connectivity OK');
      socket.destroy();
    });
    socket.on('timeout', () => {
      console.log('❌ Network timeout');
      socket.destroy();
    });
    socket.on('error', (err) => {
      console.log('❌ Network error:', err.message);
    });

    try {
      socket.connect(4370, '192.168.1.201');
    } catch (netError) {
      console.log('❌ Cannot establish network connection:', netError.message);
    }
  }

  console.log('\n🏁 Device diagnostics completed!');
}

comprehensiveDeviceDiagnostics().catch(console.error);