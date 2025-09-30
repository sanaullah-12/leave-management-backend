// Enhanced Employee Service with multiple data sources
class EnhancedEmployeeService {
  constructor(zkService) {
    this.zkService = zkService;
    this.cachedEmployees = new Map();
    this.lastSync = null;
  }

  // Method 1: Try to get real employee data from device
  async getEmployeesFromDevice() {
    const methods = [
      {
        name: 'getUser',
        fn: () => this.tryGetUser()
      },
      {
        name: 'getAttendanceUsers',
        fn: () => this.getEmployeesFromAttendance()
      },
      {
        name: 'directEnumeration',
        fn: () => this.enumerateUsers()
      }
    ];

    for (const method of methods) {
      try {
        console.log(`🔄 Trying ${method.name}...`);
        const employees = await method.fn();

        if (employees && employees.length > 0) {
          console.log(`✅ ${method.name} found ${employees.length} employees`);
          return {
            success: true,
            employees: employees,
            method: method.name,
            source: 'device'
          };
        }
      } catch (error) {
        console.log(`⚠️ ${method.name} failed: ${error.message}`);
      }
    }

    return {
      success: false,
      employees: [],
      method: 'none',
      source: 'device'
    };
  }

  async tryGetUser() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('getUser timeout'));
      }, 10000);

      this.zkService.zkInstance.getUser((err, data) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
        } else if (data && Array.isArray(data) && data.length > 0) {
          resolve(data);
        } else {
          reject(new Error('No user data returned'));
        }
      });
    });
  }

  async getEmployeesFromAttendance() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Attendance timeout'));
      }, 15000);

      this.zkService.zkInstance.getAttendance((err, data) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
        } else {
          const logs = Array.isArray(data) ? data : [];
          const uniqueUsers = new Map();

          logs.forEach(log => {
            const uid = log.uid || log.userId || log.deviceUserId;
            if (uid && !uniqueUsers.has(uid)) {
              uniqueUsers.set(uid, {
                uid: uid,
                name: `Employee ${uid}`,
                cardno: uid,
                role: '1',
                inferredFromAttendance: true,
                lastSeen: log.timestamp || log.recordTime
              });
            }
          });

          const employees = Array.from(uniqueUsers.values());
          if (employees.length > 0) {
            resolve(employees);
          } else {
            reject(new Error('No employees in attendance logs'));
          }
        }
      });
    });
  }

  async enumerateUsers() {
    // Try a smaller range for faster testing
    const employees = [];

    for (let id = 1; id <= 100; id++) {
      try {
        const user = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('timeout')), 1000);

          this.zkService.zkInstance.getUser(id, (err, data) => {
            clearTimeout(timeout);
            if (err || !data) reject(err || new Error('No data'));
            else resolve(data);
          });
        });

        if (user) {
          employees.push(user);
        }
      } catch (error) {
        // Expected for non-existent users
        continue;
      }
    }

    if (employees.length === 0) {
      throw new Error('No users found in enumeration');
    }

    return employees;
  }

  // Method 2: Fallback to mock/test data when device has no users
  getMockEmployeesForTesting() {
    return {
      success: true,
      employees: [
        {
          uid: '001',
          name: 'John Doe',
          cardno: 'CARD001',
          role: '1',
          department: 'IT',
          enrolledAt: new Date('2025-01-15'),
          isActive: true,
          mockData: true
        },
        {
          uid: '002',
          name: 'Jane Smith',
          cardno: 'CARD002',
          role: '1',
          department: 'HR',
          enrolledAt: new Date('2025-01-16'),
          isActive: true,
          mockData: true
        },
        {
          uid: '003',
          name: 'Mike Johnson',
          cardno: 'CARD003',
          role: '1',
          department: 'Finance',
          enrolledAt: new Date('2025-01-17'),
          isActive: true,
          mockData: true
        }
      ],
      method: 'mock_data',
      source: 'fallback'
    };
  }

  // Method 3: Load from database/cache if available
  async getEmployeesFromCache() {
    if (this.cachedEmployees.size > 0) {
      return {
        success: true,
        employees: Array.from(this.cachedEmployees.values()),
        method: 'cached_data',
        source: 'cache'
      };
    }
    return { success: false, employees: [], source: 'cache' };
  }

  // Method 4: Manual employee data (for immediate solution)
  getManualEmployeeData() {
    // This is where you can manually add known employees
    const knownEmployees = [
      {
        uid: '101',
        name: 'Admin User',
        cardno: 'ADMIN001',
        role: '2',
        department: 'Administration',
        enrolledAt: new Date(),
        isActive: true,
        manualEntry: true
      }
      // Add more known employees here
    ];

    if (knownEmployees.length > 0) {
      return {
        success: true,
        employees: knownEmployees,
        method: 'manual_data',
        source: 'manual'
      };
    }

    return { success: false, employees: [], source: 'manual' };
  }

  // Main method that tries all approaches
  async getAllEmployees(options = {}) {
    const { includeMockData = false, useCache = true } = options;

    console.log('🔍 Starting enhanced employee retrieval...');

    // Try 1: Device data
    const deviceResult = await this.getEmployeesFromDevice();
    if (deviceResult.success) {
      // Cache successful results
      deviceResult.employees.forEach(emp => {
        this.cachedEmployees.set(emp.uid, emp);
      });
      this.lastSync = new Date();
      return deviceResult;
    }

    // Try 2: Cached data
    if (useCache) {
      const cacheResult = await this.getEmployeesFromCache();
      if (cacheResult.success) {
        console.log('✅ Using cached employee data');
        return cacheResult;
      }
    }

    // Try 3: Manual data
    const manualResult = this.getManualEmployeeData();
    if (manualResult.success) {
      console.log('✅ Using manual employee data');
      return manualResult;
    }

    // Try 4: Mock data for testing (if enabled)
    if (includeMockData) {
      console.log('✅ Using mock employee data for testing');
      return this.getMockEmployeesForTesting();
    }

    // Final fallback: detailed error response
    return {
      success: false,
      employees: [],
      method: 'none',
      source: 'none',
      message: 'No employee data available from any source',
      recommendations: [
        'Check if employees are enrolled in the ZKTeco device',
        'Verify device is in Network mode (not Standalone)',
        'Restart the ZKTeco device',
        'Re-enroll employees if they were cleared',
        'Enable mock data for testing: /api/attendance/employees/192.168.1.201?mock=true'
      ]
    };
  }

  // Cache management
  cacheEmployee(employee) {
    this.cachedEmployees.set(employee.uid, employee);
  }

  clearCache() {
    this.cachedEmployees.clear();
    this.lastSync = null;
  }

  getCacheStatus() {
    return {
      cachedCount: this.cachedEmployees.size,
      lastSync: this.lastSync,
      cacheAge: this.lastSync ? Date.now() - this.lastSync.getTime() : null
    };
  }
}

module.exports = EnhancedEmployeeService;