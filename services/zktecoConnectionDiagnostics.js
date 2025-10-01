// Enhanced ZKTeco connection diagnostics and timeout fix
const net = require('net');

class ZKTecoConnectionDiagnostics {
  static async diagnoseConnection(ip, port = 4370) {
    console.log(`🔍 Diagnosing ZKTeco connection to ${ip}:${port}`);
    console.log('='.repeat(50));
    
    const results = {
      networkReachable: false,
      deviceResponsive: false,
      recommendedAction: '',
      issues: []
    };
    
    // Test 1: Basic network connectivity
    console.log('\n1. Testing basic network connectivity...');
    try {
      const isReachable = await this.testNetworkConnectivity(ip, port);
      results.networkReachable = isReachable;
      
      if (isReachable) {
        console.log('✅ Network: Device is reachable');
      } else {
        console.log('❌ Network: Device is not reachable');
        results.issues.push('Device network connectivity failed');
      }
    } catch (error) {
      console.log('❌ Network test failed:', error.message);
      results.issues.push(`Network test error: ${error.message}`);
    }
    
    // Test 2: Check if IP is in correct subnet
    console.log('\n2. Checking IP address format...');
    if (this.isValidZKTecoIP(ip)) {
      console.log('✅ IP format: Valid ZKTeco device IP');
    } else {
      console.log('⚠️ IP format: Non-standard IP, may need network configuration');
      results.issues.push('IP address may not be correctly configured');
    }
    
    // Test 3: Port accessibility
    console.log('\n3. Testing port accessibility...');
    try {
      const portOpen = await this.testPortConnectivity(ip, port);
      if (portOpen) {
        console.log(`✅ Port: ${port} is accessible`);
        results.deviceResponsive = true;
      } else {
        console.log(`❌ Port: ${port} is not accessible or filtered`);
        results.issues.push(`Port ${port} is not accessible`);
      }
    } catch (error) {
      console.log('❌ Port test failed:', error.message);
      results.issues.push(`Port test error: ${error.message}`);
    }
    
    // Generate recommendations
    this.generateRecommendations(results);
    
    return results;
  }
  
  static async testNetworkConnectivity(ip, port, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let connected = false;
      
      socket.setTimeout(timeoutMs);
      
      socket.on('connect', () => {
        connected = true;
        socket.destroy();
        resolve(true);
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      
      try {
        socket.connect(port, ip);
      } catch (error) {
        resolve(false);
      }
    });
  }
  
  static async testPortConnectivity(ip, port) {
    // Additional port-specific test
    return this.testNetworkConnectivity(ip, port, 3000);
  }
  
  static isValidZKTecoIP(ip) {
    // Check if IP is in common ZKTeco ranges
    const commonRanges = [
      /^192\.168\./, // Local network
      /^10\./, // Private network
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./ // Private network
    ];
    
    return commonRanges.some(range => range.test(ip));
  }
  
  static generateRecommendations(results) {
    console.log('\n🎯 DIAGNOSIS RESULTS:');
    console.log('====================');
    
    if (results.networkReachable && results.deviceResponsive) {
      results.recommendedAction = 'Device is reachable - ZKTeco configuration issue';
      console.log('✅ Device appears to be online and accessible');
      console.log('💡 Recommended action: Check ZKTeco device settings and authentication');
    } else if (results.networkReachable && !results.deviceResponsive) {
      results.recommendedAction = 'Device reachable but port blocked';
      console.log('⚠️ Device is on network but port 4370 may be blocked');
      console.log('💡 Recommended action: Check firewall settings or device port configuration');
    } else {
      results.recommendedAction = 'Device not reachable on network';
      console.log('❌ Device is not reachable on the network');
      console.log('💡 Recommended actions:');
      console.log('   1. Verify device IP address (current:', results.ip, ')');
      console.log('   2. Check device power and network connection');
      console.log('   3. Verify device is on same network segment');
      console.log('   4. Try pinging the device from command line');
    }
    
    if (results.issues.length > 0) {
      console.log('\n🚨 Issues detected:');
      results.issues.forEach((issue, index) => {
        console.log(`   ${index + 1}. ${issue}`);
      });
    }
  }
}

// Enhanced ZKTeco service with better timeout handling
class EnhancedZKTecoService {
  static async getEmployeeAttendanceWithDiagnostics(ip, employeeId, startDate, endDate, companyId) {
    console.log(`🔧 Enhanced ZKTeco connection for ${employeeId} from ${ip}`);
    
    try {
      // First, diagnose the connection
      const diagnosis = await ZKTecoConnectionDiagnostics.diagnoseConnection(ip);
      
      if (!diagnosis.networkReachable) {
        return {
          success: false,
          error: `Device not reachable: ${diagnosis.recommendedAction}`,
          diagnosis: diagnosis,
          fetchedAt: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          dataSource: 'Real-Time Machine (Network Error)',
          syncInfo: {
            lastSyncTime: null,
            lastSyncTimeFormatted: 'Network connectivity failed',
            dataSource: 'Real-Time Machine',
            realTime: true,
            note: 'Device network diagnostics failed'
          }
        };
      }
      
      // If network is reachable, try the actual ZKTeco connection
      const zktecoRealDataService = require('./zktecoRealDataService');
      const result = await zktecoRealDataService.getEmployeeAttendanceReal(
        ip, employeeId, startDate, endDate, companyId, false
      );
      
      // Add diagnosis info to successful results
      result.diagnosis = diagnosis;
      return result;
      
    } catch (error) {
      console.error('❌ Enhanced ZKTeco service failed:', error.message);
      
      return {
        success: false,
        error: `Connection failed: ${error.message}`,
        fetchedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        dataSource: 'Real-Time Machine (Service Error)',
        syncInfo: {
          lastSyncTime: null,
          lastSyncTimeFormatted: 'Service connection failed',
          dataSource: 'Real-Time Machine',
          realTime: true,
          note: `Service error: ${error.message}`
        }
      };
    }
  }
}

module.exports = {
  ZKTecoConnectionDiagnostics,
  EnhancedZKTecoService
};