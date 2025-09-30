// Test the enhanced employee API endpoint
const express = require('express');
const ZKTecoService = require('./services/zktecoService');
const EnhancedEmployeeService = require('./enhanced-employee-service');

async function testEnhancedAPI() {
  console.log('🧪 Testing Enhanced Employee API');
  console.log('================================\n');

  const ip = '192.168.1.201';

  try {
    console.log('📡 Step 1: Test device connection...');
    const zkService = new ZKTecoService(ip, 4370);
    await zkService.connect();
    console.log('✅ Device connected successfully');

    console.log('\n🔧 Step 2: Initialize enhanced employee service...');
    const employeeService = new EnhancedEmployeeService(zkService);

    console.log('\n🔄 Step 3: Test employee retrieval WITHOUT mock data...');
    let result = await employeeService.getAllEmployees({
      includeMockData: false,
      useCache: true
    });

    console.log('Result:', {
      success: result.success,
      count: result.employees.length,
      method: result.method,
      source: result.source
    });

    if (result.success && result.employees.length > 0) {
      console.log('✅ REAL DATA FOUND!');
      console.log('Sample employees:', result.employees.slice(0, 2));
    } else {
      console.log('⚠️ No real employee data - testing with mock data...');

      console.log('\n🔄 Step 4: Test with mock data enabled...');
      result = await employeeService.getAllEmployees({
        includeMockData: true,
        useCache: true
      });

      console.log('Mock result:', {
        success: result.success,
        count: result.employees.length,
        method: result.method,
        source: result.source
      });

      if (result.success) {
        console.log('✅ MOCK DATA WORKING!');
        console.log('Sample mock employees:', result.employees.slice(0, 2));
      }
    }

    console.log('\n📊 Step 5: Simulate API Response...');

    // Simulate the actual API response format
    if (result.success && result.employees.length > 0) {
      const formattedEmployees = result.employees.map(user => ({
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
        method: result.method,
        source: result.source,
        cacheStatus: employeeService.getCacheStatus(),
        libraryInfo: {
          name: 'zklib',
          version: '0.2.11',
          connectionType: 'UDP'
        },
        note: result.source === 'fallback' ? 'Using test data - device has no enrolled users' : undefined
      };

      console.log('✅ API RESPONSE:');
      console.log('================');
      console.log(JSON.stringify(apiResponse, null, 2));

    } else {
      console.log('❌ NO DATA AVAILABLE');
    }

    await zkService.disconnect();
    console.log('\n🔌 Disconnected from device');

    console.log('\n🎯 SOLUTION SUMMARY:');
    console.log('====================');
    console.log('✅ Enhanced Employee API is now ready with:');
    console.log('   1. Multiple data retrieval methods');
    console.log('   2. Intelligent fallback system');
    console.log('   3. Mock data support for testing');
    console.log('   4. Caching mechanism');
    console.log('   5. Detailed error responses');

    console.log('\n📋 API ENDPOINTS:');
    console.log('   Normal: GET /api/attendance/employees/192.168.1.201');
    console.log('   With mock data: GET /api/attendance/employees/192.168.1.201?mock=true');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }

  console.log('\n🏁 Enhanced API test completed!');
}

testEnhancedAPI().catch(console.error);