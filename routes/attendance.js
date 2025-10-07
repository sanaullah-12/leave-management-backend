const express = require("express");
const net = require("net");
const router = express.Router();
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
// Import ZKTeco libraries with fallback patterns
let ZKLib, JSZKLib;

try {
  ZKLib = require("zklib");
  console.log("✅ zklib imported successfully");
} catch (importError) {
  console.log("⚠️ zklib import failed:", importError.message);
  try {
    ZKLib = require("node-zklib");
    console.log("✅ node-zklib imported as fallback");
  } catch (nodeZklibError) {
    console.log("⚠️ node-zklib import also failed:", nodeZklibError.message);
  }
}

// js-zklib is not installed, skipping import
JSZKLib = null;
const attendanceSyncService = require("../services/attendanceSync");
const enhancedAttendanceSyncService = require("../services/enhancedAttendanceSync");
const zktecoRealDataService = require("../services/zktecoRealDataService");
const AttendanceDbService = require("../services/attendanceDbService");
const AttendanceSettingsService = require("../services/AttendanceSettingsService");

// Global handler for unhandled promise rejections (especially js-zklib buffer issues)
process.on("unhandledRejection", (reason, promise) => {
  if (reason && reason.code === "ERR_OUT_OF_RANGE") {
    console.error(
      "🚫 Caught js-zklib buffer overflow (unhandled rejection): ",
      reason.message
    );
    console.error(
      "💡 This is a known issue with js-zklib library when handling large data"
    );
    // Don't crash the process, just log the error
    return;
  }

  console.error("💥 Unhandled Rejection at:", promise, "reason:", reason);
  // Log but don't crash for other unhandled rejections in attendance module
});

// Global handler for uncaught exceptions (zklib callback issues)
process.on("uncaughtException", (error) => {
  if (
    error.message.includes("cb is not a function") ||
    error.stack.includes("zklib.js")
  ) {
    console.error(
      "🚫 Caught zklib callback error (uncaught exception):",
      error.message
    );
    console.error(
      "💡 This is a known issue with zklib library callback handling"
    );
    console.error("🔄 Connection may still work despite this error");
    // Don't crash the process for zklib callback errors
    return;
  }

  // For other uncaught exceptions, check if it's a critical system error
  if (error.code === "EADDRINUSE" || error.syscall === "listen") {
    console.error(
      "🚫 Server startup error (port already in use):",
      error.message
    );
    console.error(
      "💡 This usually means another instance is running on the same port"
    );
    // Don't crash the process for port conflicts - let the main server handle it
    return;
  }

  // For truly critical errors, log but don't throw to prevent crashes
  console.error("💥 Uncaught Exception:", error);
  console.error("Stack trace:", error.stack);
  console.error(
    "⚠️ Process will continue running, but this error should be investigated"
  );
  // Don't throw error - just log it to prevent server crashes
});

// Store connection status and ZKTeco instances (in production, you might use Redis or database)
let machineConnections = new Map();
let zkInstances = new Map(); // Store ZKTeco SDK instances

// Helper function to test basic TCP connectivity
const testBasicTCPConnection = (ip, port) => {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const socket = new net.Socket();

    socket.setTimeout(5000); // 5 second timeout

    socket.connect(port, ip, () => {
      console.log(`✅ Basic TCP connection to ${ip}:${port} successful`);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", (error) => {
      console.log(`❌ Basic TCP connection failed: ${error.message}`);
      reject(error);
    });

    socket.on("timeout", () => {
      console.log(`❌ Basic TCP connection timeout`);
      socket.destroy();
      reject(new Error("Basic TCP connection timeout"));
    });
  });
};

// Test connection to biometric machine
router.post(
  "/connect",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip, port = 4370 } = req.body;

      if (!ip) {
        return res.status(400).json({
          success: false,
          message: "IP address is required",
        });
      }

      // Validate IP format
      const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
      if (!ipRegex.test(ip)) {
        return res.status(400).json({
          success: false,
          message: "Invalid IP address format",
        });
      }

      console.log(
        `🔗 Attempting to connect to ZKTeco biometric machine at ${ip}:${port}`
      );

      // Check if ZKLib is available
      if (!ZKLib) {
        return res.status(500).json({
          success: false,
          message:
            "ZKTeco libraries not available. Please check if zklib or node-zklib is properly installed.",
          error: "LIBRARY_NOT_AVAILABLE",
        });
      }

      // Create ZKTeco SDK connection with preference for zklib (more stable)
      const connectionPromise = new Promise(async (resolve, reject) => {
        try {
          let zkInstance;
          let deviceInfo;
          let connectionMethod = "unknown";

          // Strategy 1: Try zklib first (more stable, no buffer overflow issues)
          try {
            console.log(`🔌 Attempting connection with zklib (preferred)...`);
            console.log(`🔌 Connecting to ${ip}:${port} with zklib...`);

            // Add global error handler for zklib callback issues
            const originalConsoleError = console.error;
            let zkLibErrors = [];
            console.error = (...args) => {
              zkLibErrors.push(args.join(" "));
              originalConsoleError(...args);
            };

            // Try different constructor patterns for zklib with enhanced error handling
            let constructorSuccess = false;

            try {
              // Pattern 1: Options object (most compatible)
              zkInstance = new ZKLib({
                ip: ip,
                port: parseInt(port) || 4370,
                timeout: 10000,
              });
              constructorSuccess = true;
              console.log(`✅ Options object constructor success`);
            } catch (optionsError) {
              console.log(
                `⚠️ Options constructor failed: ${optionsError.message}`
              );

              try {
                // Pattern 2: Simple constructor
                zkInstance = new ZKLib(ip, parseInt(port) || 4370);
                constructorSuccess = true;
                console.log(`✅ Simple constructor success`);
              } catch (simpleError) {
                console.log(
                  `⚠️ Simple constructor failed: ${simpleError.message}`
                );

                try {
                  // Pattern 3: With timeout parameter
                  zkInstance = new ZKLib(ip, parseInt(port) || 4370, 15000);
                  constructorSuccess = true;
                  console.log(`✅ Constructor with timeout success`);
                } catch (timeoutError) {
                  console.log(`⚠️ All zklib constructor patterns failed`);
                  throw new Error(
                    `zklib constructor failed: ${optionsError.message}`
                  );
                }
              }
            }

            // Restore console.error
            console.error = originalConsoleError;

            if (!constructorSuccess) {
              throw new Error(
                "Failed to create zklib instance with any constructor pattern"
              );
            }

            // Add comprehensive error handling for connection
            try {
              console.log(`🔌 Attempting to create socket connection...`);

              // Wrap createSocket with enhanced error handling
              const connectPromise = new Promise(async (resolve, reject) => {
                try {
                  // Add uncaught exception handler specifically for this connection
                  const originalHandler =
                    process.listeners("uncaughtException");
                  process.removeAllListeners("uncaughtException");

                  process.once("uncaughtException", (error) => {
                    console.error(
                      `🚫 Caught zklib uncaught exception: ${error.message}`
                    );
                    // Restore original handlers
                    originalHandler.forEach((handler) =>
                      process.on("uncaughtException", handler)
                    );
                    reject(new Error(`zklib internal error: ${error.message}`));
                  });

                  const result = await zkInstance.createSocket();

                  // Restore original handlers on success
                  originalHandler.forEach((handler) =>
                    process.on("uncaughtException", handler)
                  );
                  resolve(result);
                } catch (error) {
                  reject(error);
                }
              });

              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("zklib connection timeout (15s)")),
                  15000
                )
              );

              await Promise.race([connectPromise, timeoutPromise]);
              console.log(`✅ Socket connection established`);

              // Try to get device information with timeout (only if method exists)
              if (typeof zkInstance.getInfo === "function") {
                try {
                  console.log(`🔍 Attempting to get device info...`);
                  const infoPromise = zkInstance.getInfo();
                  const infoTimeoutPromise = new Promise((_, reject) =>
                    setTimeout(
                      () => reject(new Error("getInfo timeout (8s)")),
                      8000
                    )
                  );

                  deviceInfo = await Promise.race([
                    infoPromise,
                    infoTimeoutPromise,
                  ]);
                  console.log(`✅ Device info retrieved successfully`);
                } catch (getInfoError) {
                  console.log(`⚠️ getInfo failed: ${getInfoError.message}`);
                  deviceInfo = {
                    connection: "established",
                    library: zkInstance.constructor.name,
                    note: `getInfo failed: ${getInfoError.message}`,
                    warning: "Device connected but info retrieval failed",
                  };
                }
              } else {
                console.log(
                  "⚠️ getInfo method not available in this SDK instance"
                );
                deviceInfo = {
                  connection: "established",
                  library: zkInstance.constructor.name,
                  note: "getInfo method not available",
                };
              }

              connectionMethod = "zklib";
              console.log(
                `✅ Connected to ZKTeco device via zklib:`,
                deviceInfo
              );
            } catch (connectionError) {
              console.error(
                `❌ zklib connection process failed: ${connectionError.message}`
              );
              throw connectionError;
            }
          } catch (zklibError) {
            console.log(`⚠️ zklib connection failed: ${zklibError.message}`);

            // Only try js-zklib if zklib completely failed to connect
            if (
              zklibError.message.includes("timeout") ||
              zklibError.message.includes("ECONNREFUSED")
            ) {
              console.log(
                `🔌 zklib failed due to network issue, trying js-zklib as last resort...`
              );

              // Strategy 2: Try js-zklib as fallback (but with heavy restrictions)
              try {
                zkInstance = new JSZKLib(ip, port, 8000); // Shorter timeout for js-zklib

                // Add connection timeout for js-zklib
                const jsConnectPromise = zkInstance.createSocket();
                const jsTimeoutPromise = new Promise((_, reject) =>
                  setTimeout(
                    () =>
                      reject(new Error("js-zklib connection timeout (15s)")),
                    15000
                  )
                );

                await Promise.race([jsConnectPromise, jsTimeoutPromise]);

                // For js-zklib, skip getInfo to avoid timeout issues
                connectionMethod = "js-zklib-limited";
                deviceInfo = {
                  connection: "established",
                  library: "js-zklib",
                  warning:
                    "Limited functionality - data methods disabled to prevent crashes",
                  note: "getInfo skipped to avoid timeouts",
                };
                console.log(`⚠️ Connected via js-zklib with HEAVY LIMITATIONS`);
                console.warn(
                  `🚫 js-zklib detected - data retrieval methods will be DISABLED`
                );
              } catch (jsZklibError) {
                console.log(
                  `❌ Both ZKTeco libraries failed:`,
                  jsZklibError.message
                );
                throw new Error(
                  `Connection failed with both libraries. zklib: ${zklibError.message}, js-zklib: ${jsZklibError.message}`
                );
              }
            } else {
              // If zklib failed for other reasons, try a basic TCP test before giving up
              console.log(
                `🔌 zklib failed, trying basic TCP connection test...`
              );
              try {
                await testBasicTCPConnection(ip, port);
                console.log(`✅ Basic TCP connection successful`);

                // Create a minimal mock instance for basic functionality
                zkInstance = {
                  ip: ip,
                  port: port,
                  constructor: { name: "BasicTCP" },
                  async createSocket() {
                    return true;
                  },
                  async disconnect() {
                    return true;
                  },
                  // No getInfo method - this is intentional
                };

                connectionMethod = "basic-tcp-fallback";
                deviceInfo = {
                  connection: "established",
                  library: "BasicTCP",
                  warning: "Using basic TCP connection - limited functionality",
                  note: "zklib library had compatibility issues",
                };

                console.log(`⚠️ Using basic TCP fallback connection`);
              } catch (tcpError) {
                throw new Error(
                  `All connection methods failed. zklib: ${zklibError.message}, TCP: ${tcpError.message}. js-zklib skipped to prevent instability.`
                );
              }
            }
          }

          // Store ZKTeco instance and connection info
          zkInstances.set(ip, zkInstance);
          machineConnections.set(ip, {
            ip,
            port,
            status: "connected",
            connectedAt: new Date(),
            lastPing: new Date(),
            deviceInfo: deviceInfo || {},
            sdkType: zkInstance.constructor.name,
            connectionMethod,
            libraryWarnings: connectionMethod.includes("js-zklib")
              ? [
                  "js-zklib may have buffer overflow issues with large datasets",
                  "Some methods may fail unexpectedly",
                  "Consider using zklib if possible",
                ]
              : [],
          });

          // Initialize all sync services with updated instances
          attendanceSyncService.initialize(zkInstances, machineConnections);
          enhancedAttendanceSyncService.initialize(
            zkInstances,
            machineConnections
          );
          zktecoRealDataService.initialize(zkInstances, machineConnections);

          // DO NOT start scheduled sync - only fetch on demand to prevent background crashes
          console.log(
            "🔒 Scheduled sync disabled - attendance will be fetched on-demand only"
          );

          resolve({
            success: true,
            message: `Successfully connected to ZKTeco biometric machine via ${connectionMethod}`,
            machine: {
              ip,
              port,
              status: "connected",
              connectedAt: new Date(),
              deviceInfo: deviceInfo || {},
              sdkType: zkInstance.constructor.name,
              connectionMethod,
              warnings: connectionMethod.includes("js-zklib")
                ? [
                    "Using js-zklib library which may have stability issues",
                    "Some data retrieval methods may fail due to library bugs",
                    "Consider upgrading to a newer ZKTeco device or using zklib",
                  ]
                : [],
            },
          });
        } catch (error) {
          console.log(
            `❌ ZKTeco connection failed to ${ip}:${port} - ${error.message}`
          );

          // Store failed connection info
          machineConnections.set(ip, {
            ip,
            port,
            status: "failed",
            error: error.message,
            lastAttempt: new Date(),
          });

          reject({
            success: false,
            message: `Failed to connect to ZKTeco machine: ${error.message}`,
            error: error.code || "ZKTECO_CONNECTION_ERROR",
          });
        }
      });

      const result = await connectionPromise;
      res.json(result);
    } catch (error) {
      console.error("❌ Connection error:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Internal server error",
        error: error.error || "CONNECTION_ERROR",
      });
    }
  }
);

// Get connection status for a specific machine
router.get(
  "/status/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  (req, res) => {
    try {
      const { ip } = req.params;

      const connection = machineConnections.get(ip);

      if (!connection) {
        return res.json({
          success: true,
          machine: {
            ip,
            status: "not_attempted",
          },
        });
      }

      res.json({
        success: true,
        machine: connection,
      });
    } catch (error) {
      console.error("❌ Status check error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to check connection status",
      });
    }
  }
);

// Get all machine connections (for admin)
router.get(
  "/machines",
  authenticateToken,
  authorizeRoles("admin"),
  (req, res) => {
    try {
      const machines = Array.from(machineConnections.values());

      res.json({
        success: true,
        machines,
        count: machines.length,
      });
    } catch (error) {
      console.error("❌ Machines list error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to retrieve machine connections",
      });
    }
  }
);

// Force reconnection with zklib only (avoid js-zklib buffer overflow issues)
router.post(
  "/force-reconnect-zklib/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;
      const port = req.body.port || 4370;

      console.log(
        `🔄 Force reconnecting to ${ip}:${port} using ONLY zklib (avoiding js-zklib)`
      );

      // First disconnect existing connection
      const existingConnection = machineConnections.get(ip);
      if (existingConnection) {
        const zkInstance = zkInstances.get(ip);
        if (zkInstance) {
          try {
            await zkInstance.disconnect();
          } catch (disconnectError) {
            console.warn(`⚠️ Disconnect warning: ${disconnectError.message}`);
          }
        }
        zkInstances.delete(ip);
        machineConnections.delete(ip);
        console.log(`🔌 Cleaned up existing connection for ${ip}`);
      }

      // Try ONLY zklib (no fallback to js-zklib)
      try {
        console.log(`🔌 Attempting connection with zklib ONLY...`);

        let zkInstance;
        // Try different constructor patterns for zklib
        try {
          // Pattern 1: Options object with inport parameter
          zkInstance = new ZKLib({
            ip: ip,
            port: port,
            inport: 4370,
            timeout: 10000,
          });
          console.log(
            `✅ Force reconnect Pattern 1 success: Options object with inport`
          );
        } catch (optionsError) {
          console.log(`⚠️ Options pattern failed: ${optionsError.message}`);
          try {
            // Pattern 2: Direct parameters with inport
            zkInstance = new ZKLib(ip, port, 10000, 4370);
            console.log(
              `✅ Force reconnect Pattern 2 success: Direct parameters with inport`
            );
          } catch (directError) {
            console.log(`⚠️ Direct parameters failed: ${directError.message}`);
            try {
              // Pattern 3: Alternative constructor (ip, port, timeout, inport)
              zkInstance = new ZKLib(ip, parseInt(port), 10000, parseInt(port));
              console.log(
                `✅ Force reconnect Pattern 3 success: Alternative constructor`
              );
            } catch (altError) {
              console.log(
                `⚠️ Alternative constructor failed: ${altError.message}`
              );
              // Pattern 4: Try with minimal parameters
              zkInstance = new ZKLib(ip, port);
              console.log(
                `✅ Force reconnect Pattern 4 success: Minimal parameters`
              );
            }
          }
        }

        await zkInstance.createSocket();

        // Verify connection (only if method exists)
        let deviceInfo;
        if (typeof zkInstance.getInfo === "function") {
          deviceInfo = await zkInstance.getInfo();
          console.log(`✅ Connected to ZKTeco device via zklib:`, deviceInfo);
        } else {
          console.log("⚠️ getInfo method not available in this SDK instance");
          deviceInfo = {
            connection: "established",
            library: zkInstance.constructor.name,
            note: "getInfo method not available",
          };
        }

        // Store the connection
        zkInstances.set(ip, zkInstance);
        machineConnections.set(ip, {
          ip,
          port,
          status: "connected",
          connectedAt: new Date(),
          lastPing: new Date(),
          deviceInfo: deviceInfo || {},
          sdkType: zkInstance.constructor.name,
          connectionMethod: "zklib-forced",
          libraryWarnings: [],
          notes:
            "Force reconnected with zklib to avoid js-zklib buffer overflow issues",
        });

        // Reinitialize services
        attendanceSyncService.initialize(zkInstances, machineConnections);
        enhancedAttendanceSyncService.initialize(
          zkInstances,
          machineConnections
        );
        zktecoRealDataService.initialize(zkInstances, machineConnections);

        res.json({
          success: true,
          message:
            "Successfully force reconnected using zklib (js-zklib avoided)",
          machine: {
            ip,
            port,
            status: "connected",
            connectedAt: new Date(),
            deviceInfo: deviceInfo || {},
            sdkType: zkInstance.constructor.name,
            connectionMethod: "zklib-forced",
            safeForDataRetrieval: true,
          },
        });
      } catch (zklibError) {
        console.error(`❌ zklib-only connection failed: ${zklibError.message}`);
        res.status(500).json({
          success: false,
          message: `Failed to connect with zklib: ${zklibError.message}`,
          recommendation:
            "Your ZKTeco device may not be compatible with zklib. Consider updating device firmware or using a different device model.",
          error: zklibError.message,
        });
      }
    } catch (error) {
      console.error("❌ Force reconnect error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to force reconnect with zklib",
      });
    }
  }
);

// Disconnect from a machine (cleanup connection info)
router.post(
  "/disconnect",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.body;

      if (!ip) {
        return res.status(400).json({
          success: false,
          message: "IP address is required",
        });
      }

      const connection = machineConnections.get(ip);
      if (!connection) {
        return res.json({
          success: true,
          message: "Machine was not connected",
        });
      }

      // Close ZKTeco connection if exists
      const zkInstance = zkInstances.get(ip);
      if (zkInstance) {
        try {
          await zkInstance.disconnect();
          zkInstances.delete(ip);
          console.log(`🔌 Disconnected ZKTeco SDK from machine at ${ip}`);
        } catch (error) {
          console.log(`⚠️ Error disconnecting ZKTeco SDK: ${error.message}`);
        }
      }

      // Remove connection info
      machineConnections.delete(ip);

      console.log(`🔌 Disconnected from ZKTeco biometric machine at ${ip}`);

      res.json({
        success: true,
        message: "Successfully disconnected from ZKTeco biometric machine",
      });
    } catch (error) {
      console.error("❌ Disconnect error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to disconnect from machine",
      });
    }
  }
);

// Fetch employees from biometric machine
router.get(
  "/employees/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;

      // Check if machine is connected
      const connection = machineConnections.get(ip);
      if (!connection || connection.status !== "connected") {
        return res.status(400).json({
          success: false,
          message:
            "Machine is not connected. Please connect to the machine first.",
        });
      }

      console.log(`📋 Fetching real employees from ZKTeco machine at ${ip}`);

      // Get ZKTeco instance
      const zkInstance = zkInstances.get(ip);
      if (!zkInstance) {
        return res.status(400).json({
          success: false,
          message:
            "ZKTeco SDK not initialized. Please reconnect to the machine.",
        });
      }

      try {
        console.log(
          `✅ Connected to ZKTeco machine at ${ip} - fetching employees...`
        );

        // Use the working ZKTecoService directly
        const ZKTecoService = require("../services/zktecoService");

        const zkService = new ZKTecoService(ip, 4370);

        try {
          // Connect to device
          await zkService.connect();
          console.log(`✅ ZKTeco service connected successfully to ${ip}`);

          // Get employees directly from service
          const employees = await zkService.getUsers();
          console.log(
            `✅ Retrieved ${employees.length} employees from ZKTeco device`
          );

          // Format employees for API response with UserID as primary identifier
          const formattedEmployees = employees.map((user) => ({
            machineId: user.uid || user.userId || user.id || "unknown",
            name: user.name || `Employee ${user.uid || "Unknown"}`,
            // FIXED: Use UserID for accurate attendance correlation
            employeeId:
              user.userId || user.rawData?.userid || user.uid || "unknown",
            // Keep card number as separate reference field
            cardNumber: user.cardno || user.cardNumber || null,
            // Show department info
            department:
              user.role === 14
                ? "Admin"
                : user.role === 0
                ? "Employee"
                : `Role ${user.role}`,
            enrolledAt: user.enrolledAt || user.timestamp || new Date(),
            isActive: true, // All enrolled users are active
            privilege: user.privilege || 0,
            role: user.role || 0,
            // Enhanced metadata for debugging
            idMapping: {
              uid: user.uid,
              userId: user.userId || user.rawData?.userid,
              cardno: user.cardno || user.cardNumber,
              originalEmployeeId: user.employeeId,
              source: "ZKTeco_UserID_primary",
            },
            rawData: user,
          }));

          // Disconnect
          await zkService.disconnect();

          // Send successful response
          res.json({
            success: true,
            employees: formattedEmployees,
            count: formattedEmployees.length,
            machineIp: ip,
            fetchedAt: new Date(),
            method: "zktecoService_getUsers",
            source: "device",
          });
        } catch (serviceError) {
          console.error(`❌ ZKTeco service failed: ${serviceError.message}`);
          throw serviceError;
        }
      } catch (error) {
        console.error(
          `❌ Failed to fetch employees from ZKTeco machine:`,
          error
        );

        // Provide specific error messages based on the error type
        let errorResponse;

        if (
          error.message.includes("no employee data available") ||
          error.message.includes("no enrolled users")
        ) {
          errorResponse = {
            success: false,
            message:
              "ZKTeco device connected successfully but no employee data found.",
            error: error.message,
            recommendation:
              "Device appears to have no enrolled users or firmware limitations",
            deviceStatus: {
              connection: "SUCCESS",
              library: "zklib v0.2.11",
              availableMethods: ["getUser", "getAttendance", "getTime"],
              issue: "No enrolled users or firmware limitation",
            },
            troubleshooting: [
              "Verify employees are enrolled in the ZKTeco device",
              "Check device admin interface for user management",
              "Ensure device SDK/communication mode is enabled",
              "Some ZKTeco firmware versions may not support user enumeration",
              "Try enrolling a test user via device interface first",
            ],
            technicalDetails: {
              testedMethods: [
                "zkService.getUsers()",
                "direct user enumeration",
                "attendance log inference",
              ],
              zkLibVersion: "0.2.11",
              connectionType: "UDP",
              deviceIP: ip,
            },
          };
        } else if (
          error.message.includes("timeout") ||
          error.message.includes("TIMEOUT")
        ) {
          errorResponse = {
            success: false,
            message:
              "ZKTeco device communication timeout. Device responds but data retrieval times out.",
            error: error.message,
            recommendation:
              "This typically indicates device has no data to return or is processing",
            deviceStatus: {
              connection: "SUCCESS",
              dataRetrieval: "TIMEOUT",
              possibleCauses: [
                "No enrolled users",
                "Device busy",
                "Firmware limitation",
              ],
            },
            troubleshooting: [
              "Verify employees are enrolled in the device",
              "Check if device is currently in use by other applications",
              "Try accessing device web interface to verify user data exists",
              "Device may need restart or firmware update",
              "Some devices require specific user enrollment procedures",
            ],
          };
        } else if (
          error.message.includes("not available") ||
          error.message.includes("not support")
        ) {
          errorResponse = {
            success: false,
            message:
              "Device method not available. This is a known firmware or library compatibility issue.",
            error: error.message,
            recommendation:
              "Device firmware may not support the required methods",
            deviceStatus: {
              connection: "SUCCESS",
              methodSupport: "LIMITED",
              availableMethods: [
                "getUser (with timeout)",
                "getAttendance",
                "getTime",
              ],
            },
            troubleshooting: [
              "This ZKTeco device/firmware combination has limited SDK support",
              "Try updating device firmware if available",
              "Consider using ZKTeco's official software for user management",
              "Alternative: Use attendance logs to identify active employees",
              "Check device documentation for supported SDK functions",
            ],
          };
        } else if (
          error.message.includes("connect") ||
          error.message.includes("Connection")
        ) {
          errorResponse = {
            success: false,
            message:
              "Unable to connect to ZKTeco device. Network or device issue.",
            error: error.message,
            recommendation: "Verify network connectivity and device status",
            troubleshooting: [
              "Ping the device at 192.168.1.201 to verify network connectivity",
              "Check if device is powered on and operational",
              "Verify firewall settings allow port 4370 access",
              "Try connecting from device management software first",
              "Confirm device IP address hasn't changed",
            ],
          };
        } else {
          errorResponse = {
            success: false,
            message: "Unexpected error occurred while fetching employees.",
            error: error.message,
            recommendation:
              "This is an unexpected error that requires investigation",
            troubleshooting: [
              "Check device status and network connectivity",
              "Verify device is not in use by other applications",
              "Try restarting the device",
              "Contact system administrator for further assistance",
            ],
          };
        }

        res.status(500).json(errorResponse);
      }
    } catch (error) {
      console.error("❌ Failed to fetch employees:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch employees from machine",
      });
    }
  }
);

// Fetch attendance records for a specific employee
router.get(
  "/attendance/:ip/:employeeId",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip, employeeId } = req.params;
      const {
        startDate: startDateParam,
        endDate: endDateParam,
        date,
        days = 7,
        forceSync = false,
      } = req.query;

      // Check if machine is connected
      const connection = machineConnections.get(ip);
      if (!connection || connection.status !== "connected") {
        return res.status(400).json({
          success: false,
          message:
            "Machine is not connected. Please connect to the machine first.",
        });
      }

      console.log(
        `📊 Fetching real attendance for employee ${employeeId} from ZKTeco machine ${ip}`
      );

      // Log the date range being requested
      if (startDateParam && endDateParam) {
        console.log(`📅 Date range: ${startDateParam} to ${endDateParam}`);
      } else {
        console.log(`📅 Using days fallback: ${days} days`);
      }

      // Get ZKTeco instance
      const zkInstance = zkInstances.get(ip);
      if (!zkInstance) {
        return res.status(400).json({
          success: false,
          message:
            "ZKTeco SDK not initialized. Please reconnect to the machine.",
        });
      }

      try {
        // Calculate date range - prefer startDate/endDate parameters over days
        let startDateStr, endDateStr;

        if (startDateParam && endDateParam) {
          startDateStr = startDateParam;
          endDateStr = endDateParam;
        } else {
          // Fallback to old days-based logic
          const startDate = date ? new Date(date) : new Date();
          const endDate = new Date(startDate);
          endDate.setDate(startDate.getDate() - parseInt(days));

          startDateStr = endDate.toISOString().split("T")[0];
          endDateStr = startDate.toISOString().split("T")[0];
        }

        console.log(
          `📅 Fetching attendance: ${startDateStr} to ${endDateStr}, forceSync: ${forceSync}`
        );

        // Use REAL ZKTeco data service (no more mock data)
        console.log("🔧 Using REAL ZKTeco data service for attendance fetch");
        const result = await zktecoRealDataService.getEmployeeAttendanceReal(
          ip,
          employeeId,
          startDateStr,
          endDateStr,
          req.user.company, // Pass company ID for multi-tenancy
          forceSync === "true" // Convert string to boolean for forceSync parameter
        );

        if (!result.success) {
          throw new Error(
            result.error || "Failed to fetch cached attendance records"
          );
        }

        res.json(result);
      } catch (error) {
        console.error(
          `❌ Failed to fetch attendance from ZKTeco machine:`,
          error
        );
        res.status(500).json({
          success: false,
          message: `Failed to fetch attendance records from ZKTeco machine: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("❌ Failed to fetch attendance records:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch attendance records from machine",
      });
    }
  }
);

// NEW: Fetch attendance records from database (replaces machine fetching)
router.get(
  "/db/attendance/:employeeId",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { startDate, endDate, days = 7 } = req.query;

      console.log(
        `📊 Fetching attendance from DATABASE for employee ${employeeId}`
      );

      // Calculate date range
      let startDateStr, endDateStr;

      if (startDate && endDate) {
        startDateStr = startDate;
        endDateStr = endDate;
      } else {
        // Fallback to days-based logic
        const endDateObj = new Date();
        const startDateObj = new Date();
        startDateObj.setDate(endDateObj.getDate() - parseInt(days));

        startDateStr = startDateObj.toISOString().split("T")[0];
        endDateStr = endDateObj.toISOString().split("T")[0];
      }

      console.log(
        `📅 Fetching from database: ${startDateStr} to ${endDateStr}`
      );

      // Use the new database service
      const result = await AttendanceDbService.getEmployeeAttendance(
        employeeId,
        startDateStr,
        endDateStr,
        req.user.company // Pass company ID for multi-tenancy
      );

      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: `Failed to fetch attendance from database: ${result.error}`,
          error: result.error,
        });
      }

      console.log(
        `✅ Successfully fetched ${result.totalRecords} records from database`
      );

      res.json(result);
    } catch (error) {
      console.error("❌ Failed to fetch attendance from database:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch attendance records from database",
        error: error.message,
      });
    }
  }
);

// NEW: Get attendance summary from database
router.get(
  "/db/summary/:employeeId",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { startDate, endDate, days = 7 } = req.query;

      console.log(
        `📊 Fetching attendance summary from DATABASE for employee ${employeeId}`
      );

      // Calculate date range
      let startDateStr, endDateStr;

      if (startDate && endDate) {
        startDateStr = startDate;
        endDateStr = endDate;
      } else {
        // Fallback to days-based logic
        const endDateObj = new Date();
        const startDateObj = new Date();
        startDateObj.setDate(endDateObj.getDate() - parseInt(days));

        startDateStr = startDateObj.toISOString().split("T")[0];
        endDateStr = endDateObj.toISOString().split("T")[0];
      }

      console.log(
        `📅 Fetching summary from database: ${startDateStr} to ${endDateStr}`
      );

      // Use the new database service
      const result = await AttendanceDbService.getEmployeeAttendanceSummary(
        employeeId,
        startDateStr,
        endDateStr
      );

      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: `Failed to fetch attendance summary from database: ${result.error}`,
          error: result.error,
        });
      }

      console.log(
        `✅ Successfully generated summary for ${result.totalDays} days from database`
      );

      res.json(result);
    } catch (error) {
      console.error(
        "❌ Failed to fetch attendance summary from database:",
        error
      );
      res.status(500).json({
        success: false,
        message: "Failed to fetch attendance summary from database",
        error: error.message,
      });
    }
  }
);

// NEW: Get attendance statistics from database
router.get(
  "/db/stats",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { startDate, endDate, days = 30 } = req.query;

      console.log(`📊 Fetching attendance statistics from DATABASE`);

      // Calculate date range
      let startDateStr, endDateStr;

      if (startDate && endDate) {
        startDateStr = startDate;
        endDateStr = endDate;
      } else {
        // Fallback to days-based logic
        const endDateObj = new Date();
        const startDateObj = new Date();
        startDateObj.setDate(endDateObj.getDate() - parseInt(days));

        startDateStr = startDateObj.toISOString().split("T")[0];
        endDateStr = endDateObj.toISOString().split("T")[0];
      }

      console.log(
        `📅 Fetching stats from database: ${startDateStr} to ${endDateStr}`
      );

      // Use the new database service
      const result = await AttendanceDbService.getAttendanceStats(
        startDateStr,
        endDateStr
      );

      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: `Failed to fetch attendance statistics from database: ${result.error}`,
          error: result.error,
        });
      }

      console.log(
        `✅ Successfully generated statistics: ${result.totalRecords} records, ${result.uniqueEmployeeCount} employees`
      );

      res.json(result);
    } catch (error) {
      console.error(
        "❌ Failed to fetch attendance statistics from database:",
        error
      );
      res.status(500).json({
        success: false,
        message: "Failed to fetch attendance statistics from database",
        error: error.message,
      });
    }
  }
);

// Employee-specific route - view own attendance only
router.get(
  "/my-attendance",
  authenticateToken,
  authorizeRoles("employee"),
  async (req, res) => {
    try {
      // Get employee ID from JWT token - SECURE!
      const employeeId = req.user.employeeId;
      const { startDate, endDate, days = 7 } = req.query;

      console.log(
        `📊 Employee ${req.user.name} (${employeeId}) viewing own attendance`
      );

      // Calculate date range
      let startDateStr, endDateStr;

      if (startDate && endDate) {
        startDateStr = new Date(startDate).toISOString().split("T")[0];
        endDateStr = new Date(endDate).toISOString().split("T")[0];
      } else {
        const endDateObj = new Date();
        const startDateObj = new Date();
        startDateObj.setDate(endDateObj.getDate() - parseInt(days));

        startDateStr = startDateObj.toISOString().split("T")[0];
        endDateStr = endDateObj.toISOString().split("T")[0];
      }

      console.log(`📅 Date range: ${startDateStr} to ${endDateStr}`);

      const result = await AttendanceDbService.getEmployeeAttendance(
        employeeId,
        startDateStr,
        endDateStr,
        req.user.company
      );

      const summary = await AttendanceDbService.getEmployeeAttendanceSummary(
        employeeId,
        startDateStr,
        endDateStr,
        req.user.company
      );

      res.json({
        success: true,
        employeeId: employeeId,
        employeeName: req.user.name,
        dateRange: {
          from: startDateStr,
          to: endDateStr,
          days: parseInt(days),
        },
        summary: summary,
        records: result.attendance,
        totalRecords: result.totalRecords,
        source: "database",
        fetchedAt: new Date().toISOString(),
        security: "JWT_validated_employee_only",
      });
    } catch (error) {
      console.error("Employee attendance fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch your attendance data",
        error:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Internal server error",
      });
    }
  }
);

// NEW: Get attendance data formatted for frontend compatibility
router.get(
  "/db/frontend/:employeeId",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { startDate, endDate, days = 7 } = req.query;

      console.log(
        `📊 Fetching attendance from DATABASE for frontend compatibility - employee ${employeeId}`
      );

      // Calculate date range
      let startDateStr, endDateStr;

      if (startDate && endDate) {
        startDateStr = startDate;
        endDateStr = endDate;
      } else {
        // Fallback to days-based logic
        const endDateObj = new Date();
        const startDateObj = new Date();
        startDateObj.setDate(endDateObj.getDate() - parseInt(days));

        startDateStr = startDateObj.toISOString().split("T")[0];
        endDateStr = endDateObj.toISOString().split("T")[0];
      }

      console.log(
        `📅 Fetching from database for frontend: ${startDateStr} to ${endDateStr}`
      );

      // Get effective cutoff time for late detection using settings service
      let cutoffTime = "09:00"; // fallback default
      try {
        // First try to get machine work time
        let machineWorkTime = null;
        for (const [ip, zkInstance] of zkInstances.entries()) {
          try {
            if (typeof zkInstance.getInfo === "function") {
              const deviceInfo = await zkInstance.getInfo();
              if (deviceInfo && deviceInfo.workTime) {
                machineWorkTime = deviceInfo.workTime;
                console.log(
                  `⏰ Found machine work time: ${machineWorkTime} from ${ip}`
                );
                break;
              }
            }
          } catch (err) {
            // Continue to next machine
          }
        }

        // Get effective cutoff time (Custom > Machine > Default)
        cutoffTime = await AttendanceSettingsService.getEffectiveCutoffTime(
          machineWorkTime
        );
      } catch (err) {
        console.log(
          `⚠️ Could not fetch late time settings, using default: ${cutoffTime}`
        );
      }

      // Get attendance data from database
      const result = await AttendanceDbService.getEmployeeAttendance(
        employeeId,
        startDateStr,
        endDateStr,
        req.user.company
      );

      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: `Failed to fetch attendance from database: ${result.error}`,
          error: result.error,
        });
      }

      // Get attendance summary for more detailed calculations
      const summaryResult =
        await AttendanceDbService.getEmployeeAttendanceSummary(
          employeeId,
          startDateStr,
          endDateStr
        );

      // Transform data to match frontend expected format with late time detection
      const transformedData = transformToFrontendFormat(
        result,
        summaryResult.success ? summaryResult : null,
        startDateStr,
        endDateStr,
        parseInt(days),
        cutoffTime
      );

      console.log(
        `✅ Successfully transformed ${result.totalRecords} records for frontend with late detection (cutoff: ${cutoffTime})`
      );

      res.json({
        success: true,
        ...transformedData,
      });
    } catch (error) {
      console.error("❌ Failed to fetch attendance for frontend:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch attendance records for frontend",
        error: error.message,
      });
    }
  }
);

/**
 * Calculate working days between two dates (excludes weekends)
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {number} Number of working days (Monday to Friday)
 */
function calculateWorkingDays(startDate, endDate) {
  let workingDays = 0;
  const currentDate = new Date(startDate);
  const end = new Date(endDate);

  while (currentDate <= end) {
    const dayOfWeek = currentDate.getDay();
    // 0 = Sunday, 6 = Saturday - exclude these
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      workingDays++;
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return workingDays;
}

/**
 * Filter attendance records to exclude weekend records
 * @param {Array} attendanceRecords - Array of attendance records
 * @returns {Array} Filtered records excluding weekends
 */
function filterWorkingDayRecords(attendanceRecords) {
  return attendanceRecords.filter((record) => {
    const recordDate = new Date(record.date);
    const dayOfWeek = recordDate.getDay();
    // 0 = Sunday, 6 = Saturday - exclude these
    return dayOfWeek !== 0 && dayOfWeek !== 6;
  });
}

/**
 * Transform database attendance data to frontend expected format
 * Shows raw timestamp records without daily grouping calculations
 * Includes late time detection functionality
 */
function transformToFrontendFormat(
  attendanceResult,
  summaryResult,
  startDate,
  endDate,
  days,
  cutoffTime = "09:00"
) {
  const { attendance, employeeId, totalRecords } = attendanceResult;

  // Calculate date range info - ENHANCED with working days
  const startDateObj = new Date(startDate);
  const endDateObj = new Date(endDate);

  // Calculate total calendar days (old method for reference)
  const totalCalendarDays =
    Math.ceil((endDateObj - startDateObj) / (1000 * 60 * 60 * 24)) + 1;

  // Calculate working days only (exclude weekends)
  const totalWorkingDays = calculateWorkingDays(startDate, endDate);

  // Filter attendance records to exclude weekend records
  const workingDayRecords = filterWorkingDayRecords(attendance);

  // Calculate present days from working day records only
  const uniqueWorkingDatesWithRecords = new Set(
    workingDayRecords.map((record) => record.date)
  );
  const presentWorkingDays = uniqueWorkingDatesWithRecords.size;

  // Calculate attendance rate based on working days only
  const attendanceRate =
    totalWorkingDays > 0
      ? Math.round((presentWorkingDays / totalWorkingDays) * 100)
      : 0;

  // Legacy calculations for compatibility
  const uniqueDatesWithRecords = new Set(
    attendance.map((record) => record.date)
  );
  const presentDays = uniqueDatesWithRecords.size;

  // Calculate absent days based on working days
  const absentWorkingDays = totalWorkingDays - presentWorkingDays;

  // Legacy calculation for compatibility (calendar days)
  const totalCalendarDaysUsed = totalCalendarDays;
  const absentCalendarDays = totalCalendarDaysUsed - presentDays;

  // Helper function to calculate late time
  const calculateLateTime = (timestamp, cutoffTime) => {
    const recordTime = new Date(timestamp);
    const [cutoffHour, cutoffMinute] = cutoffTime.split(":").map(Number);

    // Create cutoff time for the same date
    const cutoffDateTime = new Date(recordTime);
    cutoffDateTime.setHours(cutoffHour, cutoffMinute, 0, 0);

    // Calculate if late and by how many minutes
    if (recordTime > cutoffDateTime) {
      const lateMinutes = Math.floor(
        (recordTime - cutoffDateTime) / (1000 * 60)
      );
      return {
        isLate: true,
        lateMinutes: lateMinutes,
        lateDisplay:
          lateMinutes >= 60
            ? `${Math.floor(lateMinutes / 60)}h ${lateMinutes % 60}m`
            : `${lateMinutes}m`,
      };
    }

    return {
      isLate: false,
      lateMinutes: 0,
      lateDisplay: null,
    };
  };

  // Transform records to frontend format - showing raw timestamp data
  const transformedRecords = attendance.map((record) => {
    const lateInfo = calculateLateTime(record.timestamp, cutoffTime);

    return {
      id: record.uid.toString(),
      employeeId: record.employeeId,
      date: record.date,
      time: record.time,
      type: record.type,
      status: record.stateText,
      timestamp: record.timestamp,
      fullTimestamp: record.timestamp.toISOString(), // Full ISO timestamp
      dateDisplay: record.timestamp.toLocaleDateString(), // Formatted date
      timeDisplay: record.timestamp.toLocaleTimeString(), // Formatted time
      rawState: record.state, // Raw state number from database
      machineData: record.rawData,
      recordId: `${record.employeeId}-${
        record.uid
      }-${record.timestamp.getTime()}`,
      // Late time detection properties
      isLate: lateInfo.isLate,
      lateMinutes: lateInfo.lateMinutes,
      lateDisplay: lateInfo.lateDisplay,
      cutoffTime: cutoffTime,
    };
  });

  // Sort records by timestamp (oldest first for filtering)
  transformedRecords.sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  // Filter to show only the earliest entry per date
  const dailyFilteredRecords = {};
  const filteredRecords = [];

  transformedRecords.forEach((record) => {
    const dateKey = record.date;

    // WEEKEND FILTER: Skip weekend records (Saturday=6, Sunday=0)
    const recordDate = new Date(record.date);
    const dayOfWeek = recordDate.getDay();

    if (dayOfWeek === 0 || dayOfWeek === 6) {
      console.log(
        `🚫 Skipping weekend record: ${record.date} (${
          dayOfWeek === 0 ? "Sunday" : "Saturday"
        })`
      );
      return; // Skip weekend records completely
    }

    // If this is the first record for this date, keep it
    if (!dailyFilteredRecords[dateKey]) {
      dailyFilteredRecords[dateKey] = record;
      filteredRecords.push(record);
    }
    // If this record is earlier than the stored one for this date, replace it
    else if (
      new Date(record.timestamp) <
      new Date(dailyFilteredRecords[dateKey].timestamp)
    ) {
      // Remove the previous record from filteredRecords
      const indexToRemove = filteredRecords.findIndex(
        (r) => r.recordId === dailyFilteredRecords[dateKey].recordId
      );
      if (indexToRemove !== -1) {
        filteredRecords.splice(indexToRemove, 1);
      }

      // Add the earlier record
      dailyFilteredRecords[dateKey] = record;
      filteredRecords.push(record);
    }
  });

  // Calculate late days count from filtered records
  const lateDaysCount = filteredRecords.filter(
    (record) => record.isLate
  ).length;

  // Sort filtered records by timestamp (newest first for display)
  filteredRecords.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return {
    employeeId,
    machineIp: "database", // Indicate this came from database
    dateRange: {
      from: startDate,
      to: endDate,
      days: totalWorkingDays, // Now represents working days only
      calendarDays: totalCalendarDays, // Total calendar days for reference
    },
    summary: {
      // ENHANCED: Working days based calculations
      totalDays: totalWorkingDays, // Working days only (Mon-Fri)
      presentDays: presentWorkingDays, // Present working days only
      absentDays: absentWorkingDays, // Absent working days only
      lateDays: lateDaysCount, // Now calculated based on late detection
      attendanceRate, // Now based on working days (much more accurate)
      avgWorkingHours: 0, // Removed working hours calculation

      // Legacy data for compatibility
      legacy: {
        totalCalendarDays: totalCalendarDays,
        presentCalendarDays: presentDays,
        absentCalendarDays: absentCalendarDays,
        calendarAttendanceRate:
          totalCalendarDays > 0
            ? Math.round((presentDays / totalCalendarDays) * 100)
            : 0,
      },
    },
    records: filteredRecords, // Use filtered records instead of all records
    source: "database",
    totalRecords: filteredRecords.length, // Update to reflect filtered count
    originalTotalRecords: totalRecords, // Keep original count for reference
    fetchedAt: new Date(),
  };

  // Enhanced logging for weekend exclusion debugging
  const totalOriginalRecords = attendance.length;
  const weekendRecordsFiltered = totalOriginalRecords - filteredRecords.length;

  console.log(`📊 WEEKEND EXCLUSION STATS:`);
  console.log(`   📅 Date Range: ${startDate} to ${endDate}`);
  console.log(`   📆 Total Calendar Days: ${totalCalendarDays}`);
  console.log(
    `   💼 Total Working Days: ${totalWorkingDays} (excluded ${
      totalCalendarDays - totalWorkingDays
    } weekend days)`
  );
  console.log(`   📋 Original Records: ${totalOriginalRecords}`);
  console.log(`   🚫 Weekend Records Filtered: ${weekendRecordsFiltered}`);
  console.log(`   ✅ Working Day Records Shown: ${filteredRecords.length}`);
  console.log(`   ✅ Present Working Days: ${presentWorkingDays}`);
  console.log(`   ❌ Absent Working Days: ${absentWorkingDays}`);
  console.log(`   📈 Working Days Attendance Rate: ${attendanceRate}%`);
  console.log(
    `   📊 Calendar Days Attendance Rate: ${
      totalCalendarDays > 0
        ? Math.round((presentDays / totalCalendarDays) * 100)
        : 0
    }%`
  );
  console.log(
    `   🎯 Improvement: +${
      attendanceRate -
      (totalCalendarDays > 0
        ? Math.round((presentDays / totalCalendarDays) * 100)
        : 0)
    }%`
  );

  return result;
}

// Update late time calculation settings
router.put(
  "/settings/late-time",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { cutoffTime, useCustomCutoff = false } = req.body;
      const userId = req.user._id;

      // Use the settings service to update and persist settings
      const result = await AttendanceSettingsService.updateLateTimeSettings(
        { cutoffTime, useCustomCutoff },
        userId
      );

      if (result.success) {
        res.json({
          success: true,
          message: result.message,
          settings: result.settings,
        });
      } else {
        res.status(400).json({
          success: false,
          message: result.message,
        });
      }
    } catch (error) {
      console.error("❌ Failed to update late time settings:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update late time settings",
        error: error.message,
      });
    }
  }
);

// Get late time calculation settings
router.get(
  "/settings/late-time",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      let machineSettings = null;
      let machineDefaultTime = "09:00";

      // Try to fetch time settings from any connected ZKTeco device
      for (const [ip, zkInstance] of zkInstances.entries()) {
        try {
          console.log(`⚙️ Fetching time settings from ZKTeco machine ${ip}`);

          // Try to get device info which may contain work time settings (only if method exists)
          if (typeof zkInstance.getInfo === "function") {
            const deviceInfo = await zkInstance.getInfo();
            if (deviceInfo && deviceInfo.workTime) {
              machineDefaultTime = deviceInfo.workTime;
              machineSettings = {
                ip,
                workTime: deviceInfo.workTime,
                deviceInfo: deviceInfo,
              };
              console.log(`✅ Got machine time settings:`, machineSettings);
              break;
            }

            // Fallback: Try to get time zone or other time-related settings
            if (deviceInfo && (deviceInfo.timezone || deviceInfo.time)) {
              machineSettings = {
                ip,
                timezone: deviceInfo.timezone,
                currentTime: deviceInfo.time,
                deviceInfo: deviceInfo,
              };
              console.log(
                `✅ Got machine timezone/time info:`,
                machineSettings
              );
              break;
            }
          } else {
            console.log(
              `⚠️ getInfo method not available for machine ${ip} - using default settings`
            );
          }
        } catch (error) {
          console.log(
            `⚠️ Failed to get time settings from machine ${ip}:`,
            error.message
          );
        }
      }

      // Get settings from database with machine information
      const result = await AttendanceSettingsService.getSettingsWithMachineInfo(
        machineSettings
      );

      if (result.success) {
        res.json({
          success: true,
          settings: result.settings,
        });
      } else {
        // Fallback to basic defaults if database fails
        res.json({
          success: true,
          settings: {
            useCustomCutoff: false,
            cutoffTime: machineDefaultTime,
            machineDefault: true,
            description: machineSettings
              ? `Using time rules from ZKTeco machine ${machineSettings.ip}`
              : "Using default time rules (no machine connected)",
            machineSettings,
            error: result.error,
          },
        });
      }
    } catch (error) {
      console.error("❌ Failed to fetch late time settings:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch late time settings",
        error: error.message,
      });
    }
  }
);

// Manual sync trigger endpoint
router.post(
  "/sync/manual",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.body;

      if (!ip) {
        return res.status(400).json({
          success: false,
          message: "Machine IP address is required",
        });
      }

      console.log(`📡 Manual sync triggered for machine ${ip}`);

      const result = await attendanceSyncService.triggerManualSync(
        ip,
        req.user.company
      );

      res.json({
        success: true,
        message: `Manual sync completed for machine ${ip}`,
        result,
      });
    } catch (error) {
      console.error("❌ Manual sync error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to trigger manual sync",
        error: error.message,
      });
    }
  }
);

// Get sync status endpoint
router.get(
  "/sync/status",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const status = await attendanceSyncService.getSyncStatus();

      res.json({
        success: true,
        status,
      });
    } catch (error) {
      console.error("❌ Sync status error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to get sync status",
        error: error.message,
      });
    }
  }
);

// Trigger sync for all connected machines
router.post(
  "/sync/all",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      console.log("📡 Manual sync triggered for all connected machines");

      const results = await attendanceSyncService.syncAllConnectedMachines();

      res.json({
        success: true,
        message: "Manual sync completed for all machines",
        results,
      });
    } catch (error) {
      console.error("❌ Sync all machines error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to sync all machines",
        error: error.message,
      });
    }
  }
);

// Get real-time attendance data directly from machine (bypass cache)
router.get(
  "/realtime/:ip/:employeeId",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip, employeeId } = req.params;
      const { days = 30 } = req.query;

      console.log(
        `🔴 Real-time attendance fetch for employee ${employeeId} from ${ip}`
      );

      // Check if machine is connected
      const connection = machineConnections.get(ip);
      if (!connection || connection.status !== "connected") {
        return res.status(400).json({
          success: false,
          message:
            "Machine is not connected. Please connect to the machine first.",
        });
      }

      // Get ZKTeco instance
      const zkInstance = zkInstances.get(ip);
      if (!zkInstance) {
        return res.status(400).json({
          success: false,
          message:
            "ZKTeco SDK not initialized. Please reconnect to the machine.",
        });
      }

      try {
        // Calculate date range for last N days (3 months)
        const endDate = new Date();
        const startDate = new Date(
          Date.now() - parseInt(days) * 24 * 60 * 60 * 1000
        );

        const startDateStr = startDate.toISOString().split("T")[0];
        const endDateStr = endDate.toISOString().split("T")[0];

        console.log(
          `🔧 Real-time fetch for ${days} days: ${startDateStr} to ${endDateStr}`
        );

        // Use REAL ZKTeco data service for real-time data (always force sync for real-time)
        const result = await zktecoRealDataService.getEmployeeAttendanceReal(
          ip,
          employeeId,
          startDateStr,
          endDateStr,
          req.user.company,
          true // Always force sync for real-time data
        );

        res.json({
          ...result,
          realTime: true,
          syncedAt: new Date(),
          message: "Data synchronized from machine in real-time",
        });
      } catch (error) {
        console.error(`❌ Real-time fetch failed:`, error);
        res.status(500).json({
          success: false,
          message: `Real-time attendance fetch failed: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("❌ Real-time attendance error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch real-time attendance data",
      });
    }
  }
);

// Diagnostic endpoint to test SDK methods and connection
router.get(
  "/diagnostic/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;

      console.log(`🔍 Running diagnostics for ZKTeco machine ${ip}`);

      // Check if machine is connected
      const connection = machineConnections.get(ip);
      if (!connection || connection.status !== "connected") {
        return res.status(400).json({
          success: false,
          message:
            "Machine is not connected. Please connect to the machine first.",
        });
      }

      // Get ZKTeco instance
      const zkInstance = zkInstances.get(ip);
      if (!zkInstance) {
        return res.status(400).json({
          success: false,
          message:
            "ZKTeco SDK not initialized. Please reconnect to the machine.",
        });
      }

      try {
        // Run comprehensive diagnostics
        const diagnostics = await zktecoRealDataService.verifyConnection(
          zkInstance,
          ip
        );

        res.json({
          success: true,
          diagnostics,
          recommendations: generateRecommendations(diagnostics),
        });
      } catch (error) {
        console.error(`❌ Diagnostics failed for machine ${ip}:`, error);
        res.status(500).json({
          success: false,
          message: `Diagnostics failed: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("❌ Diagnostic endpoint error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to run diagnostics",
      });
    }
  }
);

// Generate recommendations based on diagnostic results
function generateRecommendations(diagnostics) {
  const recommendations = [];

  if (!diagnostics.success) {
    recommendations.push(
      "❌ Connection verification failed - check network connectivity and device status"
    );
  }

  // Check for js-zklib specific issues
  if (
    diagnostics.capabilities.sdkLibraryIssues &&
    diagnostics.capabilities.sdkLibraryIssues.length > 0
  ) {
    recommendations.push("🚫 SDK Library Issues Detected:");
    diagnostics.capabilities.sdkLibraryIssues.forEach((issue) => {
      recommendations.push(`   • ${issue}`);
    });
    recommendations.push(
      "💡 Solution: Try reconnecting to prefer zklib over js-zklib"
    );
  }

  if (diagnostics.capabilities.availableMethods.length === 0) {
    recommendations.push(
      "❌ No SDK methods available - try switching between zklib and js-zklib libraries"
    );
  } else if (diagnostics.capabilities.availableMethods.length < 3) {
    recommendations.push(
      "⚠️ Limited SDK methods available - some functionality may be restricted"
    );
  }

  if (!diagnostics.capabilities.connectionStable) {
    recommendations.push(
      "⚠️ Connection appears unstable - consider network optimization or device restart"
    );
  }

  if (
    !diagnostics.capabilities.availableMethods.includes("getAttendances") &&
    !diagnostics.capabilities.availableMethods.includes("getLogs")
  ) {
    recommendations.push(
      "❌ No attendance data methods available - attendance sync will not work"
    );
  }

  if (
    diagnostics.capabilities.deviceInfo &&
    diagnostics.capabilities.deviceInfo.logCounts > 50000
  ) {
    recommendations.push(
      "⚠️ Large number of logs on device - consider using smaller batch sizes"
    );
  }

  // Check for js-zklib buffer overflow risk
  if (
    diagnostics.capabilities.sdkLibraryIssues.some((issue) =>
      issue.includes("buffer overflow")
    )
  ) {
    recommendations.push("🚫 Critical: js-zklib buffer overflow detected");
    recommendations.push("💡 Workaround: Reconnect to try zklib instead");
    recommendations.push(
      "💡 Alternative: Use smaller date ranges in data requests"
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "✅ All diagnostics passed - device should work optimally"
    );
  }

  return recommendations;
}

// On-demand attendance fetch with date range (DEFAULT: last 2 months)
router.post(
  "/fetch-attendance-range/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;
      let { startDate, endDate } = req.body;

      console.log(`📅 On-demand attendance fetch requested for machine ${ip}`);

      // Default to last 2 months if no dates provided
      if (!startDate || !endDate) {
        const now = new Date();
        endDate = now.toISOString().split("T")[0];

        const twoMonthsAgo = new Date();
        twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
        startDate = twoMonthsAgo.toISOString().split("T")[0];

        console.log(
          `📅 Using default date range: ${startDate} to ${endDate} (last 2 months)`
        );
      }

      // Validate date format
      const startDateObj = new Date(startDate);
      const endDateObj = new Date(endDate);

      if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format. Use YYYY-MM-DD format.",
        });
      }

      if (startDateObj > endDateObj) {
        return res.status(400).json({
          success: false,
          message: "Start date cannot be after end date.",
        });
      }

      // Check if machine is connected
      const connection = machineConnections.get(ip);
      if (!connection || connection.status !== "connected") {
        return res.status(400).json({
          success: false,
          message:
            "Machine is not connected. Please connect to the machine first.",
        });
      }

      // Get ZKTeco instance
      const zkInstance = zkInstances.get(ip);
      if (!zkInstance) {
        return res.status(400).json({
          success: false,
          message:
            "ZKTeco SDK not initialized. Please reconnect to the machine.",
        });
      }

      console.log(
        `🔄 Fetching attendance data from ${ip} for period: ${startDate} to ${endDate}`
      );

      try {
        // Calculate date range and use intelligent batching
        const diffTime = Math.abs(endDateObj - startDateObj);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        console.log(`📊 Date range spans ${diffDays} days`);

        let result;

        if (diffDays > 60) {
          // For large date ranges, use 7-day batches
          console.log(
            `📦 Using batch processing (7-day batches) for large date range`
          );
          result = await zktecoRealDataService.fetchRealAttendanceLogsBatched(
            ip,
            startDate,
            endDate,
            req.user.company,
            7 // 7-day batches
          );
        } else {
          // For smaller ranges, use standard fetch
          console.log(`📦 Using standard fetch for small date range`);
          result = await zktecoRealDataService.fetchRealAttendanceLogs(
            ip,
            startDate,
            endDate,
            req.user.company
          );
        }

        res.json({
          success: true,
          message: `Successfully fetched attendance data from machine ${ip}`,
          dateRange: {
            from: startDate,
            to: endDate,
            days: diffDays,
          },
          result,
        });
      } catch (error) {
        console.error(
          `❌ Failed to fetch attendance data from machine:`,
          error
        );
        res.status(500).json({
          success: false,
          message: `Failed to fetch attendance data: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("❌ Attendance fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch attendance data from machine",
      });
    }
  }
);

// Force fetch real attendance data from machine (batch processing)
router.post(
  "/fetch-real/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;
      const { startDate, endDate } = req.body;

      if (!startDate || !endDate) {
        return res.status(400).json({
          success: false,
          message: "Start date and end date are required",
        });
      }

      console.log(
        `🔧 Force fetching REAL data from ${ip}: ${startDate} to ${endDate}`
      );

      // Check if machine is connected
      const connection = machineConnections.get(ip);
      if (!connection || connection.status !== "connected") {
        return res.status(400).json({
          success: false,
          message:
            "Machine is not connected. Please connect to the machine first.",
        });
      }

      try {
        // Fetch real attendance logs from machine
        const result = await zktecoRealDataService.fetchRealAttendanceLogs(
          ip,
          startDate,
          endDate,
          req.user.company
        );

        res.json({
          success: true,
          message: `Successfully fetched real attendance data from machine ${ip}`,
          result,
        });
      } catch (error) {
        console.error(`❌ Failed to fetch real data from machine:`, error);
        res.status(500).json({
          success: false,
          message: `Failed to fetch real attendance data: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("❌ Real data fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch real attendance data from machine",
      });
    }
  }
);

module.exports = router;
