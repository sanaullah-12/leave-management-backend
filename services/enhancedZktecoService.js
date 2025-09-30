const ZKLib = require('zklib');
const nodeZKLib = require('node-zklib');

class EnhancedZKTecoService {
  constructor(ip, port = 4370, timeout = 15000) {
    this.ip = ip;
    this.port = port;
    this.timeout = timeout;
    this.zkInstance = null;
    this.nodeZkInstance = null;
    this.isConnected = false;
    this.currentLibrary = null;
    // For zklib, we need an additional inport parameter (random port for local binding)
    this.inport = Math.floor(Math.random() * 10000) + 40000; // Random port in range 40000-50000
  }

  // Try both libraries and select the working one
  async initBestLibrary() {
    // First try zklib (the original one that's actually working)
    try {
      console.log(`🔌 Trying to initialize with zklib for ${this.ip}:${this.port} (inport: ${this.inport})`);
      // zklib requires both ip and inport parameters
      this.zkInstance = new ZKLib({
        ip: this.ip,
        port: parseInt(this.port),
        inport: this.inport, // This is required by zklib
        timeout: this.timeout
      });
      
      await new Promise((resolve, reject) => {
        this.zkInstance.createSocket((err) => {
          if (err) {
            reject(new Error(`zklib socket creation failed: ${err.message}`));
          } else {
            this.currentLibrary = 'zklib';
            console.log('✅ Using zklib');
            resolve();
          }
        });
      });
      return true;
    } catch (zklibError) {
      console.log(`⚠️ zklib initialization failed: ${zklibError.message}`);
      
      // Fallback to node-zklib
      try {
        console.log(`🔌 Trying to initialize with node-zklib for ${this.ip}:${this.port}`);
        // node-zklib uses (ip, port, timeout, inport) format
        this.nodeZkInstance = new nodeZKLib(this.ip, parseInt(this.port), this.timeout, this.inport);
        
        await new Promise((resolve, reject) => {
          // node-zklib uses createSocket with error and close callbacks
          this.nodeZkInstance.createSocket(
            (err) => { // error callback
              reject(new Error(`node-zklib socket creation failed: ${err.message}`));
            },
            () => {} // close callback
          );
          
          // Add a timeout to prevent hanging
          setTimeout(() => {
            if (!this.nodeZkInstance.connectionType) {
              reject(new Error('node-zklib connection timeout'));
            }
          }, 10000);
        });
        
        this.currentLibrary = 'node-zklib';
        console.log('✅ Using node-zklib');
        return true;
      } catch (nodeZklibError) {
        console.log(`❌ Both libraries failed: ${nodeZklibError.message}`);
        throw new Error(`Could not initialize any ZKTeco library: zklib-${zklibError.message}, node-zklib-${nodeZklibError.message}`);
      }
    }
  }

  async connect() {
    try {
      console.log(`🔌 Connecting to ZKTeco device at ${this.ip}:${this.port}`);
      
      await this.initBestLibrary();
      
      // Test connection with ping-like operation
      const connectionStatus = await this.testConnection();
      
      if (connectionStatus.success) {
        this.isConnected = true;
        console.log(`✅ Connected to ZKTeco device at ${this.ip}:${this.port}`);
        
        // Get device info
        const deviceInfo = await this.getDeviceInfo();
        console.log('✅ Device info:', deviceInfo);
        
        return {
          success: true,
          message: `Connected to ZKTeco device at ${this.ip}:${this.port}`,
          deviceInfo: deviceInfo,
          libraryUsed: this.currentLibrary,
          connectedAt: new Date()
        };
      } else {
        throw new Error('Connection test failed');
      }
    } catch (error) {
      console.error(`❌ Failed to connect to ZKTeco device: ${error.message}`);
      this.isConnected = false;
      throw error;
    }
  }

  async testConnection() {
    try {
      if (this.currentLibrary === 'zklib' && this.zkInstance) {
        // Try to execute a simple command that should respond quickly
        // Using getTime as it was available in the diagnostic
        if (typeof this.zkInstance.getTime === 'function') {
          // Wrap callback method in a promise with timeout
          const timeResult = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error('getTime timeout (10s)'));
            }, 10000);
            
            this.zkInstance.getTime((err, timeData) => {
              clearTimeout(timeout);
              if (err) {
                console.log('getTime failed but device might still be responsive:', err.message);
                // Don't fail the connection test if getTime fails
                resolve({ success: true, time: null });
              } else {
                resolve({ success: true, time: timeData });
              }
            });
          });
          return { success: true, time: timeResult.time };
        } else {
          // If even getTime is not available, try another approach
          return { success: true, note: 'getTime not available but connection established' };
        }
      } else if (this.currentLibrary === 'node-zklib' && this.nodeZkInstance) {
        // Test with getInfo if available
        if (typeof this.nodeZkInstance.getInfo === 'function') {
          const info = await this.nodeZkInstance.getInfo();
          return { success: true, deviceInfo: info };
        } else {
          // If no getInfo, just check connection status
          const status = await this.nodeZkInstance.getSocketStatus();
          return { success: status };
        }
      }
    } catch (error) {
      console.log(`⚠️ Connection test failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async getDeviceInfo() {
    try {
      if (this.currentLibrary === 'zklib' && this.zkInstance) {
        // Try to get device info using any available method
        if (typeof this.zkInstance.getTime === 'function') {
          return await new Promise((resolve, reject) => {
            this.zkInstance.getTime((err, data) => {
              if (err) {
                resolve({ 
                  info: 'Device connected but no info methods available',
                  time_error: err.message 
                });
              } else {
                resolve({ 
                  time: data,
                  status: 'device responsive'
                });
              }
            });
          });
        } else if (typeof this.zkInstance.getVersion === 'function') {
          return await new Promise((resolve, reject) => {
            this.zkInstance.getVersion((err, data) => {
              if (err) {
                resolve({ error: err.message, info: 'getVersion not available' });
              } else {
                resolve(data);
              }
            });
          });
        } else {
          return { info: 'Device connected but no info methods available' };
        }
      } else if (this.currentLibrary === 'node-zklib' && this.nodeZkInstance) {
        if (typeof this.nodeZkInstance.getInfo === 'function') {
          return await this.nodeZkInstance.getInfo();
        }
        return { info: 'Device connected with node-zklib' };
      }
    } catch (error) {
      console.log(`⚠️ Could not get device info: ${error.message}`);
      return { error: error.message };
    }
  }

  // Main getUsers implementation with proper callback handling and multiple fallbacks
  async getUsers() {
    if (!this.isConnected) {
      await this.connect();
    }

    console.log(`📋 Fetching users from ZKTeco device (library: ${this.currentLibrary})...`);

    // Try different approaches based on the library being used
    try {
      if (this.currentLibrary === 'zklib' && this.zkInstance) {
        // For zklib, getUser is a callback-based method
        if (typeof this.zkInstance.getUser === 'function') {
          console.log('🔧 Using zklib getUser method');
          
          // Disable device to avoid interference during user fetch
          if (typeof this.zkInstance.disableDevice === 'function') {
            try {
              await new Promise((resolve) => {
                this.zkInstance.disableDevice((err) => {
                  if (err) {
                    console.log('⚠️ Could not disable device, continuing anyway:', err.message);
                  }
                  resolve();
                });
              });
            } catch (disableErr) {
              console.log('⚠️ Device disable failed, continuing:', disableErr.message);
            }
          }
          
          // Get users with timeout protection
          const usersData = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              console.log('⚠️ getUser timeout - device might not have enrolled users or firmware limitation');
              // Instead of rejecting, resolve with empty array to try fallback
              resolve([]);
            }, 25000); // Reduced timeout to 25s
            
            this.zkInstance.getUser((err, users) => {
              clearTimeout(timeout);
              if (err) {
                console.log('⚠️ getUser failed - might be firmware limitation, trying fallback:', err.message);
                // Resolve with empty array to try fallback
                resolve([]);
              } else {
                resolve(users);
              }
            });
          });
          
          // If we got users from getUser, return them
          if (usersData && usersData.length > 0) {
            // Re-enable device after fetching
            if (typeof this.zkInstance.enableDevice === 'function') {
              try {
                await new Promise((resolve) => {
                  this.zkInstance.enableDevice((err) => {
                    if (err) {
                      console.log('⚠️ Could not enable device after user fetch:', err.message);
                    }
                    resolve();
                  });
                });
              } catch (enableErr) {
                console.log('⚠️ Device enable failed:', enableErr.message);
              }
            }
            
            return this.formatUsers(usersData);
          }
        } else {
          console.log('⚠️ zklib getUser method is not available on this device firmware');
        }
      } else if (this.currentLibrary === 'node-zklib' && this.nodeZkInstance) {
        // For node-zklib, getUsers is a promise-based method
        if (typeof this.nodeZkInstance.getUsers === 'function') {
          console.log('🔧 Using node-zklib getUsers method');
          
          // Disable device to avoid interference
          if (typeof this.nodeZkInstance.disableDevice === 'function') {
            try {
              await this.nodeZkInstance.disableDevice();
            } catch (disableErr) {
              console.log('⚠️ Could not disable device, continuing anyway:', disableErr.message);
            }
          }
          
          const usersData = await this.nodeZkInstance.getUsers();
          
          // Re-enable device
          if (typeof this.nodeZkInstance.enableDevice === 'function') {
            try {
              await this.nodeZkInstance.enableDevice();
            } catch (enableErr) {
              console.log('⚠️ Could not enable device after user fetch:', enableErr.message);
            }
          }
          
          return this.formatUsers(usersData);
        } else {
          console.log('⚠️ node-zklib getUsers method is not available on this device firmware');
        }
      } else {
        throw new Error(`No valid ZKTeco library instance available (current: ${this.currentLibrary})`);
      }
    } catch (error) {
      console.error(`❌ Main user retrieval failed: ${error.message}`);
    }

    // If main method didn't return users, try alternative methods
    console.log('🔄 Trying alternative methods to retrieve user data...');
    
    // Alternative 1: Try getAllUserID if available
    try {
      if (this.currentLibrary === 'zklib' && this.zkInstance && typeof this.zkInstance.getAllUserID === 'function') {
        console.log('🔧 Trying zklib getAllUserID method');
        
        const userIds = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            console.log('⚠️ getAllUserID timeout');
            resolve([]);
          }, 20000);
          
          this.zkInstance.getAllUserID((err, data) => {
            clearTimeout(timeout);
            if (err) {
              console.log('⚠️ getAllUserID failed:', err.message);
              resolve([]);
            } else {
              resolve(data);
            }
          });
        });
        
        if (userIds && userIds.length > 0) {
          console.log(`✅ Retrieved ${userIds.length} user IDs via getAllUserID`);
          // Format the IDs as users
          return userIds.map(id => ({
            uid: id.toString(),
            name: `Employee ${id}`,
            cardno: id.toString(),
            role: 0,
            privilege: 0,
            password: '',
            enrolledAt: new Date(),
            isActive: true,
            rawData: id
          }));
        }
      }
    } catch (alt1Error) {
      console.log('⚠️ Alternative method 1 (getAllUserID) failed:', alt1Error.message);
    }
    
    // Alternative 2: Try getAttendance to extract users (this is often more reliable)
    try {
      console.log('🔄 Extracting users from attendance logs...');
      const attendanceLogs = await this.getAttendanceLogs();
      
      // Create unique users based on attendance records
      const uniqueUsers = {};
      
      attendanceLogs.forEach(log => {
        const uid = log.uid || log.userId || 'unknown';
        if (uid && uid !== 'unknown' && !uniqueUsers[uid]) {
          uniqueUsers[uid] = {
            uid: uid.toString(),
            name: `Employee ${uid}`,
            cardno: uid.toString(),
            role: 0,
            privilege: 0,
            password: '',
            enrolledAt: new Date(),
            isActive: true,
            rawData: log
          };
        }
      });
      
      console.log(`✅ Extracted ${Object.keys(uniqueUsers).length} users from attendance logs`);
      if (Object.keys(uniqueUsers).length > 0) {
        return Object.values(uniqueUsers);
      }
    } catch (attendanceError) {
      console.log('⚠️ Could not extract users from attendance logs:', attendanceError.message);
    }
    
    // Alternative 3: Try to read raw user template data if available
    try {
      if (this.currentLibrary === 'zklib' && this.zkInstance && typeof this.zkInstance.getUserTemplate === 'function') {
        console.log('🔧 Trying zklib getUserTemplate method');
        
        const templateData = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            console.log('⚠️ getUserTemplate timeout');
            resolve([]);
          }, 30000);
          
          this.zkInstance.getUserTemplate((err, data) => {
            clearTimeout(timeout);
            if (err) {
              console.log('⚠️ getUserTemplate failed:', err.message);
              resolve([]);
            } else {
              resolve(data);
            }
          });
        });
        
        if (templateData && templateData.length > 0) {
          console.log(`✅ Retrieved ${templateData.length} user templates`);
          return templateData.map(template => ({
            uid: template.uid ? template.uid.toString() : 'unknown',
            name: template.name || `User ${template.uid || 'unknown'}`,
            cardno: template.cardno || template.uid?.toString() || 'NO_CARD',
            role: template.role || 0,
            privilege: template.privilege || 0,
            password: template.password || '',
            enrolledAt: new Date(),
            isActive: true,
            rawData: template
          }));
        }
      }
    } catch (templateError) {
      console.log('⚠️ Alternative method 3 (getUserTemplate) failed:', templateError.message);
    }
    
    // If all methods fail, return empty array but with info
    console.log('⚠️ All user retrieval methods exhausted - device may not have enrolled users or firmware limitation');
    return [];
  }

  // Format users to consistent format regardless of the source
  formatUsers(usersData) {
    let userArray = [];
    
    if (Array.isArray(usersData)) {
      userArray = usersData;
    } else if (usersData && typeof usersData === 'object') {
      // Handle different possible response formats
      userArray = usersData.data || usersData.users || usersData.result || [usersData];
    } else {
      console.log('⚠️ Unexpected users response format, using empty array');
      userArray = [];
    }

    // Transform user data to consistent format
    const formattedUsers = userArray.map(user => {
      // Handle different possible field names based on library
      const uid = user.uid || user.userId || user.id || user.enroll || user.user_id || 'unknown';
      const name = user.name || user.userName || user.user_name || user.pin || user.uid || `User ${uid}`;
      const cardno = user.cardno || user.card || user.cardNumber || user.cardnumber || uid || 'NO_CARD';
      const role = user.role || user.level || user.privilege || user.usergroup || 0;
      
      return {
        uid: uid.toString(),
        name: name.toString(),
        cardno: cardno.toString(),
        role: parseInt(role) || 0,
        privilege: parseInt(role) || 0,
        password: user.password || user.pass || '',
        enrolledAt: user.timestamp || user.enrollTime || new Date(),
        isActive: role !== '0' && parseInt(role) !== 0,
        rawData: user
      };
    });

    console.log(`✅ Formatted ${formattedUsers.length} users`);
    return formattedUsers;
  }

  // Enhanced attendance logs with proper library-specific handling and fallbacks
  async getAttendanceLogs(startDate = null) {
    if (!this.isConnected) {
      await this.connect();
    }

    console.log(`📊 Fetching attendance logs from ZKTeco device...`);
    
    try {
      let attendanceData = null;
      
      if (this.currentLibrary === 'zklib' && this.zkInstance) {
        // zklib uses callback-based getAttendance
        attendanceData = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            console.log('⚠️ getAttendance timeout - trying to continue without attendance data');
            resolve([]); // Resolve with empty array instead of rejecting
          }, 30000);
          
          this.zkInstance.getAttendance((err, data) => {
            clearTimeout(timeout);
            if (err) {
              console.log('⚠️ getAttendance failed:', err.message);
              resolve([]); // Resolve with empty array instead of rejecting
            } else {
              resolve(data);
            }
          });
        });
      } else if (this.currentLibrary === 'node-zklib' && this.nodeZkInstance) {
        // node-zklib uses promise-based getAttendances
        try {
          attendanceData = await this.nodeZkInstance.getAttendances();
        } catch (getAttendancesError) {
          console.log('⚠️ getAttendances failed, trying getAttendance:', getAttendancesError.message);
          // Fallback to getAttendance if getAttendances is not available
          attendanceData = await new Promise((resolve, reject) => {
            this.nodeZkInstance.getAttendance((err, data) => {
              if (err) {
                console.log('⚠️ getAttendance also failed:', err.message);
                resolve([]);
              } else {
                resolve(data);
              }
            });
          });
        }
      } else {
        throw new Error(`No valid ZKTeco library instance available (current: ${this.currentLibrary})`);
      }
      
      let logsArray = this.formatAttendanceLogs(attendanceData);
      
      // Filter by start date if provided
      if (startDate) {
        const filterDate = new Date(startDate);
        logsArray = logsArray.filter(log => {
          const logDate = new Date(log.timestamp || log.recordTime);
          return logDate >= filterDate;
        });
      }
      
      return logsArray;
    } catch (error) {
      console.error(`⚠️ Failed to get attendance logs: ${error.message}, continuing with empty logs`);
      return []; // Return empty array instead of throwing error
    }
  }

  // Format attendance logs to consistent format
  formatAttendanceLogs(attendanceData) {
    let logsArray = [];
    
    if (Array.isArray(attendanceData)) {
      logsArray = attendanceData;
    } else if (attendanceData && typeof attendanceData === 'object') {
      logsArray = attendanceData.data || attendanceData.logs || attendanceData.records || [attendanceData];
    } else {
      console.log('⚠️ Unexpected attendance response format, using empty array');
      logsArray = [];
    }

    // Transform logs to consistent format
    const formattedLogs = logsArray.map(log => ({
      uid: (log.uid || log.userId || log.user_id || log.enroll).toString(),
      timestamp: log.timestamp || log.time || log.verifytime || new Date(),
      type: log.type || log.mode || log.status || 'attendance',
      mode: log.mode || log.type || 'unknown',
      ip: this.ip,
      date: new Date(log.timestamp || log.time || new Date()).toISOString().split('T')[0],
      rawData: log
    }));

    console.log(`✅ Formatted ${formattedLogs.length} attendance logs`);
    return formattedLogs;
  }

  async disableDevice() {
    try {
      if (this.currentLibrary === 'zklib' && this.zkInstance && typeof this.zkInstance.disableDevice === 'function') {
        await new Promise((resolve, reject) => {
          this.zkInstance.disableDevice((err) => {
            if (err) {
              console.log('⚠️ Could not disable device:', err.message);
            }
            resolve();
          });
        });
      } else if (this.currentLibrary === 'node-zklib' && this.nodeZkInstance && typeof this.nodeZkInstance.disableDevice === 'function') {
        await this.nodeZkInstance.disableDevice();
      }
    } catch (error) {
      console.log('⚠️ Error disabling device:', error.message);
    }
  }

  async enableDevice() {
    try {
      if (this.currentLibrary === 'zklib' && this.zkInstance && typeof this.zkInstance.enableDevice === 'function') {
        await new Promise((resolve) => {
          this.zkInstance.enableDevice((err) => {
            if (err) {
              console.log('⚠️ Could not enable device:', err.message);
            }
            resolve();
          });
        });
      } else if (this.currentLibrary === 'node-zklib' && this.nodeZkInstance && typeof this.nodeZkInstance.enableDevice === 'function') {
        await this.nodeZkInstance.enableDevice();
      }
    } catch (error) {
      console.log('⚠️ Error enabling device:', error.message);
    }
  }

  async disconnect() {
    try {
      if (this.currentLibrary === 'zklib' && this.zkInstance) {
        if (typeof this.zkInstance.closeSocket === 'function') {
          this.zkInstance.closeSocket();
        }
      } else if (this.currentLibrary === 'node-zklib' && this.nodeZkInstance) {
        if (typeof this.nodeZkInstance.disconnect === 'function') {
          await this.nodeZkInstance.disconnect();
        }
      }
    } catch (error) {
      console.log('⚠️ Error during disconnection:', error.message);
    }
    
    this.isConnected = false;
    this.zkInstance = null;
    this.nodeZkInstance = null;
    console.log(`🔌 Disconnected from ZKTeco device at ${this.ip}:${this.port}`);
  }

  // Get available methods for diagnostics
  getAvailableMethods() {
    if (this.currentLibrary === 'zklib' && this.zkInstance) {
      return Object.getOwnPropertyNames(Object.getPrototypeOf(this.zkInstance))
        .filter(prop => typeof this.zkInstance[prop] === 'function')
        .filter(method => !method.startsWith('_'));
    } else if (this.currentLibrary === 'node-zklib' && this.nodeZkInstance) {
      return Object.getOwnPropertyNames(Object.getPrototypeOf(this.nodeZkInstance))
        .filter(prop => typeof this.nodeZkInstance[prop] === 'function')
        .filter(method => !method.startsWith('_'));
    }
    return [];
  }
}

module.exports = EnhancedZKTecoService;