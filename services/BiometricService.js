const ZKLib = require('zklib');

class BiometricService {
  constructor(ip, port = 4370) {
    this.ip = ip;
    this.port = port;
    this.zkInstance = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      console.log(`Connecting to biometric device at ${this.ip}:${this.port}`);

      if (!ZKLib) {
        throw new Error('ZKLib not available. Please install zklib package.');
      }

      // Create the ZK instance.
      //
      // `port` and `inport` are NOT the same thing:
      //   port   = the DEVICE's UDP port (4370) we send to
      //   inport = the LOCAL port we bind to in order to receive the reply
      //
      // This previously passed `inport: this.port` and omitted `port` entirely,
      // so the device port only worked by falling back to zklib's 4370 default
      // while the process tried to bind locally to 4370 - an EADDRINUSE on the
      // second connection attempt. Bind a random high local port instead.
      const localPort = Math.floor(Math.random() * 10000) + 40000;

      this.zkInstance = new ZKLib({
        ip: this.ip,
        port: parseInt(this.port) || 4370, // device port
        inport: localPort,                 // local bind port
        timeout: 5000
      });
      console.log(`ZK instance created (device ${this.ip}:${this.port}, local inport ${localPort})`);

      if (!this.zkInstance) {
        throw new Error('Failed to create ZK instance');
      }

      // Connect with promise wrapper
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout (10s)'));
        }, 10000);

        this.zkInstance.connect((err) => {
          clearTimeout(timeout);
          if (err) {
            console.error('Connection failed:', err);
            reject(new Error(`Connection failed: ${err}`));
          } else {
            console.log(`Connected to biometric device at ${this.ip}:${this.port}`);
            this.isConnected = true;
            resolve();
          }
        });
      });

      return {
        success: true,
        message: `Connected to biometric device at ${this.ip}:${this.port}`,
        connectedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error(`BiometricService connection failed:`, error.message);
      this.isConnected = false;
      throw error;
    }
  }

  async disconnect() {
    if (this.zkInstance && this.isConnected) {
      try {
        await new Promise((resolve) => {
          this.zkInstance.disconnect((err) => {
            if (err) {
              console.warn('Disconnect warning:', err);
            }
            resolve();
          });
        });

        this.isConnected = false;
        this.zkInstance = null;
        console.log(`Disconnected from biometric device at ${this.ip}:${this.port}`);
      } catch (error) {
        console.warn(`Disconnect error: ${error.message}`);
        this.isConnected = false;
        this.zkInstance = null;
      }
    }
  }

  async getEmployees() {
    if (!this.isConnected || !this.zkInstance) {
      await this.connect();
    }

    try {
      console.log(`Fetching employees from biometric device...`);

      // Disable device to prevent interference
      if (typeof this.zkInstance.disableDevice === 'function') {
        await new Promise((resolve) => {
          this.zkInstance.disableDevice((err) => {
            if (err) console.log('Could not disable device:', err);
            resolve();
          });
        });
      }

      // Get users with promise wrapper
      const users = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Get users timeout (30s)'));
        }, 30000);

        this.zkInstance.getUser((err, usersData) => {
          clearTimeout(timeout);
          if (err) {
            reject(new Error(`Failed to get users: ${err}`));
          } else {
            resolve(usersData || []);
          }
        });
      });

      // Re-enable device
      if (typeof this.zkInstance.enableDevice === 'function') {
        await new Promise((resolve) => {
          this.zkInstance.enableDevice((err) => {
            if (err) console.log('Could not re-enable device:', err);
            resolve();
          });
        });
      }

      // Process and format users
      const userArray = Array.isArray(users) ? users : [];
      const formattedEmployees = userArray.map(user => ({
        machineId: user.uid || user.userId || user.id || 'unknown',
        name: user.name || `Employee ${user.uid || 'Unknown'}`,
        employeeId: user.cardno || user.cardNumber || user.employeeId || user.uid || 'NO_CARD',
        department: user.department || 'Unknown',
        role: user.role || 0,
        privilege: user.privilege || 0,
        isActive: user.role !== '0' && user.role !== 0,
        enrolledAt: user.timestamp || new Date().toISOString(),
        rawData: user
      }));

      console.log(`Retrieved ${formattedEmployees.length} employees from biometric device`);
      return formattedEmployees;

    } catch (error) {
      console.error(`Failed to get employees:`, error.message);
      throw error;
    }
  }

  async getAttendanceLogs(startDate = null) {
    if (!this.isConnected || !this.zkInstance) {
      await this.connect();
    }

    try {
      console.log(`Fetching attendance logs from biometric device...`);

      // Disable device
      if (typeof this.zkInstance.disableDevice === 'function') {
        await new Promise((resolve) => {
          this.zkInstance.disableDevice((err) => {
            if (err) console.log('Could not disable device:', err);
            resolve();
          });
        });
      }

      // Get attendance with promise wrapper
      const attendance = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Get attendance timeout (45s)'));
        }, 45000);

        this.zkInstance.getAttendance((err, attendanceData) => {
          clearTimeout(timeout);
          if (err) {
            reject(new Error(`Failed to get attendance: ${err}`));
          } else {
            resolve(attendanceData || []);
          }
        });
      });

      // Re-enable device
      if (typeof this.zkInstance.enableDevice === 'function') {
        await new Promise((resolve) => {
          this.zkInstance.enableDevice((err) => {
            if (err) console.log('Could not re-enable device:', err);
            resolve();
          });
        });
      }

      // Process and format attendance
      let logsArray = Array.isArray(attendance) ? attendance : [];

      // Filter by start date if provided
      if (startDate) {
        const filterDate = new Date(startDate);
        logsArray = logsArray.filter(log => {
          const logDate = new Date(log.timestamp || log.recordTime);
          return logDate >= filterDate;
        });
      }

      // zklib's legacy parser returns {uid, id, state, timestamp}, where `id` is
      // the enrolled User ID that identifies the employee and `uid` is the
      // device record slot. On these machines uid is 0 for virtually every
      // record, so `userId` below - not uid - is what callers must match on.
      const formattedLogs = logsArray.map(log => ({
        uid: log.uid ?? 'unknown',
        userId: log.id ?? log.userId ?? log.deviceUserId ?? log.uid,
        state: log.state,
        timestamp: log.timestamp || log.recordTime || new Date().toISOString(),
        type: log.type || log.mode || 'attendance',
        mode: log.mode || log.type || 'unknown',
        ip: this.ip,
        date: new Date(log.timestamp || log.recordTime || new Date()).toISOString().split('T')[0],
        rawData: log
      }));

      console.log(`Retrieved ${formattedLogs.length} attendance logs from biometric device`);
      return formattedLogs;

    } catch (error) {
      console.error(`Failed to get attendance logs:`, error.message);
      throw error;
    }
  }

  // Test connection to device
  async testConnection() {
    try {
      const result = await this.connect();
      await this.disconnect();
      return result;
    } catch (error) {
      return {
        success: false,
        message: error.message,
        testedAt: new Date().toISOString()
      };
    }
  }
}

module.exports = BiometricService;