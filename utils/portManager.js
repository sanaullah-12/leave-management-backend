// Port management utility to prevent EADDRINUSE errors
// Provides retry logic and port conflict resolution

class PortManager {
  static generateRandomPort(minPort = 5000, maxPort = 9999) {
    return minPort + Math.floor(Math.random() * (maxPort - minPort + 1));
  }

  static async createZKLibWithRetry(ip, devicePort = 4370, timeout = 10000, maxRetries = 3) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const randomInport = this.generateRandomPort();
      
      try {
        console.log(`🔌 Attempt ${attempt}/${maxRetries}: Connecting to ${ip}:${devicePort} using local port ${randomInport}`);
        
        // Import the ZK library
        let ZKLib;
        try {
          ZKLib = require('zklib');
        } catch (e) {
          ZKLib = require('node-zklib');
        }
        
        // Create instance with retry logic
        const zkInstance = new ZKLib({
          ip: ip,
          port: devicePort,
          inport: randomInport,
          timeout: timeout
        });
        
        // Test the connection immediately
        await new Promise((resolve, reject) => {
          const testSocket = require('net').createSocket('udp4');
          
          testSocket.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
              console.log(`⚠️ Port ${randomInport} is in use, will try another port`);
              reject(err);
            } else {
              reject(err);
            }
          });
          
          testSocket.bind(randomInport, () => {
            testSocket.close();
            console.log(`✅ Port ${randomInport} is available`);
            resolve();
          });
        });
        
        return zkInstance;
        
      } catch (error) {
        lastError = error;
        console.log(`❌ Attempt ${attempt} failed: ${error.message}`);
        
        if (error.code === 'EADDRINUSE') {
          console.log(`🔄 Port ${randomInport} in use, retrying with different port...`);
          // Add small delay to prevent rapid retries
          await new Promise(resolve => setTimeout(resolve, 100 * attempt));
          continue;
        } else {
          // Non-port-related error, don't retry
          throw error;
        }
      }
    }
    
    throw new Error(`Failed to create ZKLib connection after ${maxRetries} attempts. Last error: ${lastError.message}`);
  }

  static async createNodeZKLibWithRetry(ip, devicePort = 4370, timeout = 10000, maxRetries = 3) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const randomInport = this.generateRandomPort();
      
      try {
        console.log(`🔌 Attempt ${attempt}/${maxRetries}: Creating NodeZKLib for ${ip}:${devicePort} using local port ${randomInport}`);
        
        const NodeZKLib = require('node-zklib');
        const zkInstance = new NodeZKLib(ip, devicePort, timeout, randomInport);
        
        // Test the connection by creating socket
        await zkInstance.createSocket();
        console.log(`✅ NodeZKLib created successfully with port ${randomInport}`);
        
        return zkInstance;
        
      } catch (error) {
        lastError = error;
        console.log(`❌ Attempt ${attempt} failed: ${error.message}`);
        
        if (error.message.includes('EADDRINUSE') || error.code === 'EADDRINUSE') {
          console.log(`🔄 Port ${randomInport} in use, retrying with different port...`);
          // Add small delay to prevent rapid retries
          await new Promise(resolve => setTimeout(resolve, 100 * attempt));
          continue;
        } else {
          // Non-port-related error, don't retry
          throw error;
        }
      }
    }
    
    throw new Error(`Failed to create NodeZKLib connection after ${maxRetries} attempts. Last error: ${lastError.message}`);
  }
}

module.exports = PortManager;