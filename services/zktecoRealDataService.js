// Import ZKTeco libraries with fallback patterns
let ZKLib, JSZKLib;

try {
  ZKLib = require("zklib");
  console.log("zklib imported successfully for ZKTecoService");
} catch (importError) {
  console.log("zklib import failed for ZKTecoService:", importError.message);
  try {
    ZKLib = require("node-zklib");
    console.log("node-zklib imported as fallback for ZKTecoService");
  } catch (nodeZklibError) {
    console.log(
      "node-zklib import also failed for ZKTecoService:",
      nodeZklibError.message,
    );
  }
}

// NOTE: `js-zklib` is not a dependency of this project and was never installed -
// the previous require() here only ever threw, printing an alarming require-stack
// on every startup that looked like a device connection failure. JSZKLib is not
// used anywhere in this file, so it stays null.
JSZKLib = null;

class ZKTecoService {
  constructor(ip, port = 4370) {
    this.ip = ip;
    this.port = port;
    this.zkInstance = null;
    this.isConnected = false;
  }

  // Generate random port to avoid conflicts
  generateRandomInport() {
    return Math.floor(Math.random() * 10000) + 50000; // Random port between 50000-60000 (different range from zktecoService)
  }

  async connect() {
    try {
      console.log(`Connecting to ZKTeco device at ${this.ip}:${this.port}`);

      if (!ZKLib) {
        throw new Error(
          "ZKTeco libraries not available. Please ensure zklib is properly installed.",
        );
      }

      // Try different constructor patterns with enhanced error handling
      const randomInport = this.generateRandomInport();
      console.log(`Using random inport: ${randomInport} to avoid conflicts`);

      try {
        // Pattern 1: Options object with correct parameter names
        this.zkInstance = new ZKLib({
          inport: randomInport, // Dynamic local UDP port to avoid conflicts
          ip: this.ip,
          port: parseInt(this.port), // Device port (4370)
          timeout: 10000,
        });
        console.log(
          `Options object constructor success (inport: ${randomInport})`,
        );
      } catch (optionsError) {
        console.log(
          `Options constructor (inport) failed: ${optionsError.message}`,
        );

        try {
          // Pattern 2: Alternative options format with new random port
          const fallbackInport = this.generateRandomInport();
          this.zkInstance = new ZKLib({
            ip: this.ip,
            inport: fallbackInport, // Different random port for fallback
            port: parseInt(this.port), // Device port (4370)
            timeout: 10000,
          });
          console.log(
            `Alternative options constructor success (inport: ${fallbackInport})`,
          );
        } catch (altOptionsError) {
          console.log(
            `Alternative options constructor failed: ${altOptionsError.message}`,
          );

          try {
            // Pattern 3: Simple constructor (no inport)
            this.zkInstance = new ZKLib(this.ip, parseInt(this.port));
            console.log(`Simple constructor success`);
          } catch (simpleError) {
            console.log(`Simple constructor failed: ${simpleError.message}`);

            try {
              // Pattern 4: With timeout parameter (last resort)
              this.zkInstance = new ZKLib(this.ip, parseInt(this.port), 15000);
              console.log(`Constructor with timeout success`);
            } catch (timeoutError) {
              console.log(`All zklib constructor patterns failed`);
              console.log(
                `Error details: ${optionsError.message} | ${altOptionsError.message} | ${simpleError.message} | ${timeoutError.message}`,
              );
              throw new Error(
                `ZKTeco library connection failed - all constructor patterns exhausted. This may be due to port conflicts or device connectivity issues.`,
              );
            }
          }
        }
      }

      // Connect to the device with timeout
      const connectPromise = new Promise((resolve, reject) => {
        try {
          // Try connect method first (correct zklib method)
          if (typeof this.zkInstance.connect === "function") {
            this.zkInstance.connect((err) => {
              if (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
              } else {
                resolve("Connected successfully");
              }
            });
          } else if (typeof this.zkInstance.createConnection === "function") {
            this.zkInstance.createConnection((err) => {
              if (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
              } else {
                resolve("Connected successfully");
              }
            });
          } else if (typeof this.zkInstance.createSocket === "function") {
            // Fallback to createSocket
            const result = this.zkInstance.createSocket((err) => {
              if (err) {
                reject(new Error(`Socket creation failed: ${err}`));
              } else {
                resolve("Socket created successfully");
              }
            });

            // If createSocket returns a promise, handle it
            if (result && typeof result.then === "function") {
              result.then(resolve).catch(reject);
            } else if (result && !result.then) {
              resolve("Socket created synchronously");
            }
          } else {
            reject(new Error("No connection method available"));
          }
        } catch (syncError) {
          // Try without callback if callback version fails
          try {
            let result;
            if (typeof this.zkInstance.connect === "function") {
              result = this.zkInstance.connect();
            } else if (typeof this.zkInstance.createSocket === "function") {
              result = this.zkInstance.createSocket();
            }

            if (result && typeof result.then === "function") {
              result.then(resolve).catch(reject);
            } else {
              resolve("Connected without callback");
            }
          } catch (noCallbackError) {
            reject(
              new Error(
                `Connection failed: ${syncError.message} | ${noCallbackError.message}`,
              ),
            );
          }
        }
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Connection timeout (20s) - Device may be unreachable or network issue",
              ),
            ),
          20000,
        ),
      );

      await Promise.race([connectPromise, timeoutPromise]);

      this.isConnected = true;
      console.log(`Connected to ZKTeco device at ${this.ip}:${this.port}`);

      // Try to get device info if available
      let deviceInfo = null;
      if (typeof this.zkInstance.getInfo === "function") {
        try {
          const infoPromise = this.zkInstance.getInfo();
          const infoTimeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("getInfo timeout (8s)")), 8000),
          );

          deviceInfo = await Promise.race([infoPromise, infoTimeoutPromise]);
          console.log(`Device info retrieved:`, deviceInfo);
        } catch (infoError) {
          console.log(`Could not get device info: ${infoError.message}`);
          deviceInfo = {
            connection: "established",
            note: `getInfo failed: ${infoError.message}`,
          };
        }
      } else {
        console.log("getInfo method not available");
        deviceInfo = {
          connection: "established",
          note: "getInfo method not available",
        };
      }

      return {
        success: true,
        message: `Connected to ZKTeco device at ${this.ip}:${this.port}`,
        deviceInfo: deviceInfo,
        connectedAt: new Date(),
      };
    } catch (error) {
      console.error(`Failed to connect to ZKTeco device: ${error.message}`);
      this.isConnected = false;

      // Enhanced error reporting.
      // NOTE: match case-insensitively - zklib emits "Timeout error" (capital T),
      // which a lowercase includes("timeout") silently missed, suppressing the
      // most useful diagnostic below and falling through to the generic branch.
      const reason = error.message.toLowerCase();

      if (reason.includes("timeout")) {
        throw new Error(
          `Connection failed: Device at ${this.ip}:${this.port} is not responding. Please check device power, network connection, and IP address.`,
        );
      } else if (reason.includes("eaddrinuse")) {
        throw new Error(
          `Connection failed: Port conflict detected. Please restart the application or check for other ZKTeco connections.`,
        );
      } else if (reason.includes("econnrefused")) {
        throw new Error(
          `Connection failed: Device at ${this.ip}:${this.port} refused connection. Check device IP and port settings.`,
        );
      } else {
        throw new Error(
          `Connection failed: ${error.message}. Please verify device connectivity and configuration.`,
        );
      }
    }
  }

  async disconnect() {
    if (this.zkInstance && this.isConnected) {
      try {
        if (typeof this.zkInstance.disconnect === "function") {
          await new Promise((resolve) => {
            this.zkInstance.disconnect((err) => {
              resolve(); // Always resolve, even on error
            });
          });
        } else if (typeof this.zkInstance.close === "function") {
          this.zkInstance.close();
        }
        this.isConnected = false;
        this.zkInstance = null;
        console.log(
          `Disconnected from ZKTeco device at ${this.ip}:${this.port}`,
        );
      } catch (error) {
        console.warn(`Disconnect warning: ${error.message}`);
        this.isConnected = false;
        this.zkInstance = null;
      }
    }
  }

  async getUsers() {
    if (!this.isConnected || !this.zkInstance) {
      await this.connect();
    }

    try {
      // Check if getUser method is available (callback-style)
      if (typeof this.zkInstance.getUser !== "function") {
        throw new Error(
          "getUser method not available - device may not support user management via SDK",
        );
      }

      console.log(`Fetching users from ZKTeco device...`);

      // Disable device first to prevent interference
      if (typeof this.zkInstance.disableDevice === "function") {
        await new Promise((resolve, reject) => {
          this.zkInstance.disableDevice((err) => {
            if (err) {
              console.log(
                "Could not disable device, continuing anyway:",
                err.message || err,
              );
            }
            resolve(); // Continue regardless of disable result
          });
        });
      }

      const getUsersPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("getUser timeout (30s)"));
        }, 30000); // Increased timeout

        this.zkInstance.getUser((err, usersData) => {
          clearTimeout(timeout);
          if (err) {
            reject(new Error(`Failed to get users: ${err.message || err}`));
          } else {
            resolve(usersData);
          }
        });
      });

      const usersData = await getUsersPromise;

      // Re-enable device after data retrieval
      if (typeof this.zkInstance.enableDevice === "function") {
        await new Promise((resolve) => {
          this.zkInstance.enableDevice((err) => {
            if (err) {
              console.log("Could not re-enable device:", err.message || err);
            }
            resolve(); // Continue regardless
          });
        });
      }
      console.log(
        `Retrieved users data:`,
        typeof usersData,
        Array.isArray(usersData) ? usersData.length : "unknown",
      );

      // Handle different response formats
      let userArray = [];
      if (Array.isArray(usersData)) {
        userArray = usersData;
      } else if (usersData && typeof usersData === "object") {
        userArray = usersData.data ||
          usersData.users ||
          usersData.result || [usersData];
      } else {
        console.log("Unexpected users response format, returning empty array");
        userArray = [];
      }

      // Transform user data to consistent format
      const formattedUsers = userArray.map((user) => ({
        uid: user.uid || user.userId || user.id || "unknown",
        name: user.name || "Unknown Name",
        cardno:
          user.cardno ||
          user.cardNumber ||
          user.employeeId ||
          user.uid ||
          "NO_CARD",
        role: user.role || 0,
        privilege: user.privilege || 0,
        password: user.password || "",
        enrolledAt: user.timestamp || new Date(),
        isActive: user.role !== "0" && user.role !== 0,
        rawData: user,
      }));

      console.log(
        `Processed ${formattedUsers.length} users from ZKTeco device`,
      );
      return formattedUsers;
    } catch (error) {
      console.error(`Failed to get users: ${error.message}`);
      throw error;
    }
  }

  async getAttendanceLogs(startDate = null) {
    if (!this.isConnected || !this.zkInstance) {
      await this.connect();
    }

    try {
      // Check if getAttendance method is available (callback-style)
      if (typeof this.zkInstance.getAttendance !== "function") {
        throw new Error(
          "getAttendance method not available - device may not support attendance log retrieval via SDK",
        );
      }

      console.log(`Fetching attendance logs from ZKTeco device...`);

      // Disable device first to prevent interference
      if (typeof this.zkInstance.disableDevice === "function") {
        await new Promise((resolve) => {
          this.zkInstance.disableDevice((err) => {
            if (err) {
              console.log(
                "Could not disable device, continuing anyway:",
                err.message || err,
              );
            }
            resolve(); // Continue regardless
          });
        });
      }

      const getAttendancePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("getAttendance timeout (30s)"));
        }, 30000); // Increased timeout

        this.zkInstance.getAttendance((err, attendanceData) => {
          clearTimeout(timeout);
          if (err) {
            reject(
              new Error(`Failed to get attendance logs: ${err.message || err}`),
            );
          } else {
            resolve(attendanceData);
          }
        });
      });

      const attendanceData = await getAttendancePromise;

      // Re-enable device after data retrieval
      if (typeof this.zkInstance.enableDevice === "function") {
        await new Promise((resolve) => {
          this.zkInstance.enableDevice((err) => {
            if (err) {
              console.log("Could not re-enable device:", err.message || err);
            }
            resolve(); // Continue regardless
          });
        });
      }
      console.log(
        `Retrieved attendance data:`,
        typeof attendanceData,
        Array.isArray(attendanceData) ? attendanceData.length : "unknown",
      );

      // Handle different response formats
      let logsArray = [];
      if (Array.isArray(attendanceData)) {
        logsArray = attendanceData;
      } else if (attendanceData && typeof attendanceData === "object") {
        logsArray = attendanceData.data ||
          attendanceData.logs ||
          attendanceData.records ||
          attendanceData.result || [attendanceData];
      } else {
        console.log(
          "Unexpected attendance response format, returning empty array",
        );
        logsArray = [];
      }

      // Filter by start date if provided
      if (startDate) {
        const filterDate = new Date(startDate);
        logsArray = logsArray.filter((log) => {
          const logDate = new Date(log.timestamp || log.recordTime);
          return logDate >= filterDate;
        });
      }

      // Transform logs to consistent format.
      // zklib's legacy parser returns {uid, id, state, timestamp}, where `id` is
      // the enrolled User ID that identifies the employee and `uid` is the
      // device record slot. On these machines uid is 0 for virtually every
      // record, so `userId` below - not uid - is what callers must match on.
      const formattedLogs = logsArray.map((log) => ({
        uid: log.uid ?? "unknown",
        userId: log.id ?? log.userId ?? log.deviceUserId ?? log.uid,
        state: log.state,
        timestamp: log.timestamp || log.recordTime || new Date(),
        type: log.type || log.mode || "attendance",
        mode: log.mode || log.type || "unknown",
        ip: this.ip,
        date: new Date(log.timestamp || log.recordTime || new Date())
          .toISOString()
          .split("T")[0],
        rawData: log,
      }));

      console.log(
        `Processed ${formattedLogs.length} attendance logs from ZKTeco device`,
      );
      return formattedLogs;
    } catch (error) {
      console.error(`Failed to get attendance logs: ${error.message}`);
      throw error;
    }
  }

  // Check connection status
  isDeviceConnected() {
    return this.isConnected && this.zkInstance !== null;
  }

  async getAttendance() {
    if (!this.isConnected || !this.zkInstance) {
      await this.connect();
    }

    try {
      // Check if getAttendance method is available
      if (typeof this.zkInstance.getAttendance !== "function") {
        throw new Error("getAttendance method not available");
      }

      console.log(`Fetching attendance logs from ZKTeco device...`);

      // Disable device to prevent interference
      if (typeof this.zkInstance.disableDevice === "function") {
        await new Promise((resolve) => {
          this.zkInstance.disableDevice((err) => {
            if (err) {
              console.log(
                "Could not disable device, continuing anyway:",
                err.message || err,
              );
            }
            resolve();
          });
        });
      }

      const getAttendancePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("getAttendance timeout (45s)"));
        }, 45000); // Longer timeout for attendance data

        this.zkInstance.getAttendance((err, attendanceData) => {
          clearTimeout(timeout);
          if (err) {
            reject(
              new Error(`Failed to get attendance: ${err.message || err}`),
            );
          } else {
            resolve(attendanceData || []);
          }
        });
      });

      const attendanceData = await getAttendancePromise;

      // Re-enable device
      if (typeof this.zkInstance.enableDevice === "function") {
        await new Promise((resolve) => {
          this.zkInstance.enableDevice((err) => {
            if (err) {
              console.log("Could not re-enable device:", err.message || err);
            }
            resolve();
          });
        });
      }

      console.log(
        `Retrieved attendance data: ${
          Array.isArray(attendanceData)
            ? attendanceData.length
            : typeof attendanceData
        } records`,
      );

      return Array.isArray(attendanceData) ? attendanceData : [];
    } catch (error) {
      console.error(`getAttendance failed: ${error.message}`);
      throw error;
    }
  }

  // Get available methods on the ZK instance
  getAvailableMethods() {
    if (!this.zkInstance) {
      return [];
    }

    const methodsToCheck = [
      "getUsers",
      "getAttendances",
      "getInfo",
      "getTime",
      "getLogs",
      "getRecords",
      "getRealTimeData",
    ];

    return methodsToCheck.filter(
      (method) => typeof this.zkInstance[method] === "function",
    );
  }

  // Initialize method required by attendance.js
  initialize(zkInstances, machineConnections) {
    try {
      console.log("Initializing zktecoRealDataService...");

      // Store references for potential future use
      this.zkInstances = zkInstances || {};
      this.machineConnections = machineConnections || {};

      console.log(
        `zktecoRealDataService initialized with ${
          Object.keys(zkInstances || {}).length
        } ZK instances and ${
          Object.keys(machineConnections || {}).length
        } machine connections`,
      );

      return {
        success: true,
        message: "zktecoRealDataService initialized successfully",
        zkInstanceCount: Object.keys(zkInstances || {}).length,
        machineConnectionCount: Object.keys(machineConnections || {}).length,
      };
    } catch (error) {
      console.error(
        "Failed to initialize zktecoRealDataService:",
        error.message,
      );
      throw error;
    }
  }

  // Static initialize method for global service initialization
  static initialize(zkInstances, machineConnections) {
    try {
      console.log("Initializing zktecoRealDataService (static)...");

      // Store references globally for service methods
      ZKTecoService.globalZkInstances = zkInstances || {};
      ZKTecoService.globalMachineConnections = machineConnections || {};

      console.log(
        `zktecoRealDataService initialized with ${
          Object.keys(zkInstances || {}).length
        } ZK instances and ${
          Object.keys(machineConnections || {}).length
        } machine connections`,
      );

      return {
        success: true,
        message: "zktecoRealDataService initialized successfully",
        zkInstanceCount: Object.keys(zkInstances || {}).length,
        machineConnectionCount: Object.keys(machineConnections || {}).length,
      };
    } catch (error) {
      console.error(
        "Failed to initialize zktecoRealDataService:",
        error.message,
      );
      throw error;
    }
  }

  // Static method to get employee attendance data
  static async getEmployeeAttendanceReal(
    ip,
    employeeId,
    startDate,
    endDate,
    companyId,
    forceSync = false,
  ) {
    try {
      console.log(
        `Getting employee attendance: ${employeeId} from ${ip} (${startDate} to ${endDate})`,
      );

      const zkService = new ZKTecoService(ip, 4370);
      await zkService.connect();

      const attendanceLogs = await zkService.getAttendanceLogs(startDate);
      await zkService.disconnect();

      // Filter logs for specific employee.
      // employeeId arrives from the route params as a string while the device
      // reports numbers, so compare as strings. userId carries the enrolled
      // User ID; uid is only a fallback for firmware that omits it.
      const target = String(employeeId);
      const employeeLogs = attendanceLogs.filter(
        (log) => String(log.userId) === target || String(log.uid) === target,
      );

      // Filter by date range. endDate is a plain YYYY-MM-DD, which parses to
      // midnight, so it has to be pushed to the end of that day or every punch
      // made on the final day is dropped.
      const start = new Date(`${startDate}T00:00:00.000Z`);
      const end = new Date(`${endDate}T23:59:59.999Z`);
      const filteredLogs = employeeLogs.filter((log) => {
        const logDate = new Date(log.timestamp);
        return logDate >= start && logDate <= end;
      });

      return {
        success: true,
        attendance: filteredLogs,
        employeeId,
        dateRange: { startDate, endDate },
        totalRecords: filteredLogs.length,
        source: "real-time",
      };
    } catch (error) {
      console.error(`getEmployeeAttendanceReal failed:`, error);
      return {
        success: false,
        error: error.message,
        attendance: [],
      };
    }
  }

  // Static method to verify connection
  static async verifyConnection(zkInstance, ip) {
    try {
      console.log(`Verifying connection to ${ip}...`);

      const diagnostics = {
        success: true,
        ip: ip,
        connectionTime: new Date(),
        capabilities: {
          connectionStable: true,
          availableMethods: [],
          sdkLibraryIssues: [],
          deviceInfo: null,
        },
      };

      // Check available methods
      const methodsToCheck = ["getUser", "getAttendance", "getInfo", "getTime"];
      for (const method of methodsToCheck) {
        if (zkInstance && typeof zkInstance[method] === "function") {
          diagnostics.capabilities.availableMethods.push(method);
        }
      }

      // Try to get device info if available
      if (zkInstance && typeof zkInstance.getInfo === "function") {
        try {
          diagnostics.capabilities.deviceInfo = await zkInstance.getInfo();
        } catch (error) {
          diagnostics.capabilities.sdkLibraryIssues.push(
            `getInfo failed: ${error.message}`,
          );
        }
      }

      return diagnostics;
    } catch (error) {
      console.error(`verifyConnection failed:`, error);
      return {
        success: false,
        error: error.message,
        ip: ip,
        capabilities: {
          connectionStable: false,
          availableMethods: [],
          sdkLibraryIssues: [error.message],
        },
      };
    }
  }

  // Static method to fetch real attendance logs (batched)
  static async fetchRealAttendanceLogsBatched(
    ip,
    startDate,
    endDate,
    companyId,
    batchSizeDays = 7,
  ) {
    try {
      console.log(`Fetching real attendance logs (batched) from ${ip}`);

      const zkService = new ZKTecoService(ip, 4370);
      await zkService.connect();

      const attendanceLogs = await zkService.getAttendanceLogs(startDate);
      await zkService.disconnect();

      // Filter by date range
      const start = new Date(startDate);
      const end = new Date(endDate);
      const filteredLogs = attendanceLogs.filter((log) => {
        const logDate = new Date(log.timestamp);
        return logDate >= start && logDate <= end;
      });

      return {
        success: true,
        logs: filteredLogs,
        totalRecords: filteredLogs.length,
        dateRange: { startDate, endDate },
        batchSize: batchSizeDays,
        source: "real-time-batched",
      };
    } catch (error) {
      console.error(`fetchRealAttendanceLogsBatched failed:`, error);
      return {
        success: false,
        error: error.message,
        logs: [],
      };
    }
  }

  // Static method to fetch real attendance logs
  static async fetchRealAttendanceLogs(ip, startDate, endDate, companyId) {
    try {
      console.log(`Fetching real attendance logs from ${ip}`);

      const zkService = new ZKTecoService(ip, 4370);
      await zkService.connect();

      const attendanceLogs = await zkService.getAttendanceLogs(startDate);
      await zkService.disconnect();

      // Filter by date range
      const start = new Date(startDate);
      const end = new Date(endDate);
      const filteredLogs = attendanceLogs.filter((log) => {
        const logDate = new Date(log.timestamp);
        return logDate >= start && logDate <= end;
      });

      return {
        success: true,
        logs: filteredLogs,
        totalRecords: filteredLogs.length,
        dateRange: { startDate, endDate },
        source: "real-time",
      };
    } catch (error) {
      console.error(`fetchRealAttendanceLogs failed:`, error);
      return {
        success: false,
        error: error.message,
        logs: [],
      };
    }
  }
}

module.exports = ZKTecoService;
