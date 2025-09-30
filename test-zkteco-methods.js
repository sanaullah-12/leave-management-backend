// Advanced test to check all available ZKTeco methods
const ZKTecoService = require('./services/zktecoService');

async function inspectZKTecoMethods() {
  console.log('🔍 Inspecting ZKTeco device methods and capabilities...\n');

  const zkService = new ZKTecoService('192.168.1.201', 4370);

  try {
    console.log('Connecting to device...');
    await zkService.connect();

    if (zkService.zkInstance) {
      console.log('\n📋 Available properties and methods on zkInstance:');
      console.log('=====================================================');

      // Get all properties and methods
      const allProps = [];
      let obj = zkService.zkInstance;

      // Get own properties
      const ownProps = Object.getOwnPropertyNames(obj);
      allProps.push(...ownProps.map(prop => ({ name: prop, source: 'own' })));

      // Get prototype properties
      while (obj = Object.getPrototypeOf(obj)) {
        if (obj === Object.prototype) break;
        const prototypeProps = Object.getOwnPropertyNames(obj);
        allProps.push(...prototypeProps.map(prop => ({ name: prop, source: 'prototype' })));
      }

      // Filter and categorize
      const methods = [];
      const properties = [];

      allProps.forEach(({ name, source }) => {
        if (name !== 'constructor' && !name.startsWith('_')) {
          try {
            const type = typeof zkService.zkInstance[name];
            if (type === 'function') {
              methods.push(`${name} (${source})`);
            } else {
              properties.push(`${name}: ${type} (${source})`);
            }
          } catch (e) {
            // Skip inaccessible properties
          }
        }
      });

      console.log(`\n🔧 Methods (${methods.length}):`);
      methods.sort().forEach(method => console.log(`  - ${method}`));

      console.log(`\n📊 Properties (${properties.length}):`);
      properties.sort().forEach(prop => console.log(`  - ${prop}`));

      // Test getTime method since it's available
      console.log('\n⏰ Testing getTime method:');
      console.log('=========================');
      try {
        if (typeof zkService.zkInstance.getTime === 'function') {
          const deviceTime = await zkService.zkInstance.getTime();
          console.log('✅ Device time:', deviceTime);
        }
      } catch (timeError) {
        console.log('⚠️ getTime failed:', timeError.message);
      }

      // Test other common methods that might exist
      const methodsToTest = [
        'getRealTimeLogs',
        'getLogs',
        'getRecords',
        'getRealTimeData',
        'getAttendance',
        'getUserInfo',
        'getAllUserID',
        'readAttLog',
        'getAttendanceSize',
        'getUserTemplate'
      ];

      console.log('\n🧪 Testing other potential methods:');
      console.log('====================================');

      for (const methodName of methodsToTest) {
        if (typeof zkService.zkInstance[methodName] === 'function') {
          console.log(`✅ Method available: ${methodName}`);
          try {
            // Try calling the method (some might need parameters)
            const result = await zkService.zkInstance[methodName]();
            console.log(`  → ${methodName} result:`, typeof result === 'object' ? JSON.stringify(result).substring(0, 100) + '...' : result);
          } catch (methodError) {
            console.log(`  ⚠️ ${methodName} call failed: ${methodError.message}`);
          }
        } else {
          console.log(`❌ Method not available: ${methodName}`);
        }
      }

      // Check zklib package info
      console.log('\n📦 ZKLib Package Information:');
      console.log('=============================');
      try {
        const packageInfo = require('./node_modules/zklib/package.json');
        console.log(`Name: ${packageInfo.name}`);
        console.log(`Version: ${packageInfo.version}`);
        console.log(`Description: ${packageInfo.description}`);
      } catch (pkgError) {
        console.log('⚠️ Could not read package info:', pkgError.message);
      }
    }

    await zkService.disconnect();
    console.log('\n✅ Inspection completed successfully');

  } catch (error) {
    console.error('❌ Inspection failed:', error.message);
  }
}

inspectZKTecoMethods().catch(console.error);
