const express = require("express");
const net = require("net");
const mongoose = require("mongoose");
const { zonedParts, today: officeToday } = require("../utils/timezone");const router = express.Router();
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
// Import ZKTeco libraries with fallback patterns
let ZKLib, JSZKLib;

try {
  ZKLib = require("zklib");
  console.log("zklib imported successfully");
} catch (importError) {
  console.log("zklib import failed:", importError.message);
  try {
    ZKLib = require("node-zklib");
    console.log("node-zklib imported as fallback");
  } catch (nodeZklibError) {
    console.log("node-zklib import also failed:", nodeZklibError.message);
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
      "Caught js-zklib buffer overflow (unhandled rejection): ",
      reason.message
    );
    console.error(
      "This is a known issue with js-zklib library when handling large data"
    );
    // Don't crash the process, just log the error
    return;
  }

  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Log but don't crash for other unhandled rejections in attendance module
});

// Global handler for uncaught exceptions (zklib callback issues)
process.on("uncaughtException", (error) => {
  if (
    error.message.includes("cb is not a function") ||
    error.stack.includes("zklib.js")
  ) {
    console.error(
      "Caught zklib callback error (uncaught exception):",
      error.message
    );
    console.error(
      "This is a known issue with zklib library callback handling"
    );
    console.error("Connection may still work despite this error");
    // Don't crash the process for zklib callback errors
    return;
  }

  // For other uncaught exceptions, check if it's a critical system error
  if (error.code === "EADDRINUSE" || error.syscall === "listen") {
    console.error(
      "Server startup error (port already in use):",
      error.message
    );
    console.error(
      "This usually means another instance is running on the same port"
    );
    // Don't crash the process for port conflicts - let the main server handle it
    return;
  }

  // For truly critical errors, log but don't throw to prevent crashes
  console.error("Uncaught Exception:", error);
  console.error("Stack trace:", error.stack);
  console.error(
    "Process will continue running, but this error should be investigated"
  );
  // Don't throw error - just log it to prevent server crashes
});

// Store connection status and ZKTeco instances (in production, you might use Redis or database)
let machineConnections = new Map();
let zkInstances = new Map(); // Store ZKTeco SDK instances

/**
 * Allow admins through, and let an employee read their OWN attendance only.
 *
 * The "View My Attendance" control on the attendance page renders exclusively
 * for role === "employee", but the endpoint behind it was authorizeRoles("admin"),
 * so the one audience the feature exists for always received 403 and saw an
 * empty modal. Employees are still blocked from every other employee's records:
 * the id in the URL must match their own.
 */
const allowSelfOrAdmin = (req, res, next) => {
  if (req.user.role === "admin") return next();

  const requested = String(req.params.employeeId || "");
  const own = String(req.user.employeeId || "");
  if (own && requested === own) return next();

  return res.status(403).json({
    success: false,
    message: "You can only view your own attendance records.",
  });
};

// Helper function to test basic TCP connectivity
const testBasicTCPConnection = (ip, port) => {
  return new Promise((resolve, reject) => {
    const net = require("net");
    const socket = new net.Socket();

    socket.setTimeout(5000); // 5 second timeout

    socket.connect(port, ip, () => {
      console.log(`Basic TCP connection to ${ip}:${port} successful`);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", (error) => {
      console.log(`Basic TCP connection failed: ${error.message}`);
      reject(error);
    });

    socket.on("timeout", () => {
      console.log(`Basic TCP connection timeout`);
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

      // Validate IP format. The octet range check matters: the old regex
      // accepted values like 999.999.999.999, which then failed much later
      // as an opaque "device unreachable" timeout instead of a clear 400.
      const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
      const octetsInRange =
        ipRegex.test(ip) &&
        ip.split(".").every((octet) => parseInt(octet, 10) <= 255);

      if (!octetsInRange) {
        return res.status(400).json({
          success: false,
          message: "Invalid IP address format",
        });
      }

      console.log(
        `Attempting to connect to ZKTeco biometric machine at ${ip}:${port}`
      );

      // ============================================================
      // REAL protocol handshake (not just a local UDP socket bind).
      // Uses ZKTecoService.connect(), which sends the ZKTeco
      // CMD_CONNECT packet and waits for the device to reply - the
      // SAME path employee-sync and door-unlock use. This makes all
      // three agree: "Connected" now means the device actually
      // answered, not that a UDP socket bound locally (which always
      // "succeeds" and produced the old false-positive).
      // ============================================================
      // deviceGateway owns HOW the device is reached: this process opens the
      // connection when it shares a LAN with the device, and relays through the
      // Local Agent on the office PC when it does not. The handshake itself is
      // unchanged either way, so "connected" keeps meaning the device answered.
      const deviceGateway = require("../services/deviceGateway");

      try {
        const probeResult = await deviceGateway.ping(ip, parseInt(port) || 4370);
        const deviceInfo = probeResult.deviceInfo || { connection: "verified" };

        // Record the live connection for status + sync services.
        machineConnections.set(ip, {
          ip,
          port: parseInt(port) || 4370,
          status: "connected",
          connectedAt: new Date(),
          lastPing: new Date(),
          deviceInfo,
          sdkType: "ZKLib",
          connectionMethod: deviceGateway.isAgentMode()
            ? "local-agent-relay"
            : "zklib-handshake",
          libraryWarnings: [],
        });

        console.log(
          `Verified ZKTeco connection to ${ip}:${port} (device replied to protocol)`
        );

        return res.json({
          success: true,
          message: `Successfully connected to ZKTeco biometric machine at ${ip}:${port}`,
          machine: {
            ip,
            port: parseInt(port) || 4370,
            status: "connected",
            connectedAt: new Date(),
            deviceInfo,
            sdkType: "ZKLib",
            connectionMethod: deviceGateway.isAgentMode()
              ? "local-agent-relay"
              : "zklib-handshake",
            warnings: [],
          },
        });
      } catch (connectError) {
        // Real failure - device did not respond to the protocol handshake.
        console.error(
          `ZKTeco connection to ${ip}:${port} failed: ${connectError.message}`
        );

        // Clear any stale "connected" record for this IP.
        machineConnections.delete(ip);

        // The office PC is off, so nothing can reach the device. This is a
        // known-unavailable upstream, not a fault in this server or the device.
        if (connectError.code === "DEVICE_OFFLINE" || connectError.code === "AGENT_BUSY") {
          return res.status(503).json({
            success: false,
            code: connectError.code,
            message:
              "The Local Agent on the office PC is not connected, so the ZKTeco device cannot be reached. " +
              "Turn the office PC on and the agent will reconnect by itself.",
            error: connectError.message,
            machine: { ip, port: parseInt(port) || 4370, status: "agent_offline" },
          });
        }

        // A missing/broken zklib install throws from inside connect() too, and
        // previously produced a 502 whose text was indistinguishable from an
        // unreachable device - sending people to debug their network when the
        // real fault was a server-side dependency. Separate the two.
        if (/librar(y|ies) not available|cannot find module/i.test(connectError.message)) {
          return res.status(500).json({
            success: false,
            message:
              "Server misconfiguration: the ZKTeco driver library is not installed on the backend. " +
              "This is not a network problem - run `npm install` in the backend directory.",
            error: connectError.message,
            machine: { ip, port: parseInt(port) || 4370, status: "driver_missing" },
          });
        }

        return res.status(502).json({
          success: false,
          message:
            "Unable to reach the ZKTeco device. It did not respond to the connection request. " +
            "Check that the device is powered on, on the same network as this server, and reachable at the configured IP/port.",
          error: connectError.message,
          machine: { ip, port: parseInt(port) || 4370, status: "failed" },
        });
      }

    } catch (error) {
      console.error("Connection error:", error);
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
      console.error("Status check error:", error);
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
      console.error("Machines list error:", error);
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
        `Force reconnecting to ${ip}:${port} using ONLY zklib (avoiding js-zklib)`
      );

      // First disconnect existing connection
      const existingConnection = machineConnections.get(ip);
      if (existingConnection) {
        const zkInstance = zkInstances.get(ip);
        if (zkInstance) {
          try {
            await zkInstance.disconnect();
          } catch (disconnectError) {
            console.warn(`Disconnect warning: ${disconnectError.message}`);
          }
        }
        zkInstances.delete(ip);
        machineConnections.delete(ip);
        console.log(`Cleaned up existing connection for ${ip}`);
      }

      // Try ONLY zklib (no fallback to js-zklib)
      try {
        console.log(`Attempting connection with zklib ONLY...`);

        let zkInstance;
        // Try different constructor patterns for zklib
        try {
          // `inport` is the LOCAL port we bind to and must NOT be the device
          // port (4370), or the bind collides. Use a random high port.
          const forceInport = Math.floor(Math.random() * 10000) + 40000;
          zkInstance = new ZKLib({
            ip: ip,
            port: parseInt(port) || 4370,
            inport: forceInport,
            timeout: 10000,
          });
          console.log(
            `Force reconnect Pattern 1 success (inport: ${forceInport})`
          );
        } catch (optionsError) {
          console.log(`Options pattern failed: ${optionsError.message}`);
          try {
            // Retry with a different local port in case the first was in use.
            const retryInport = Math.floor(Math.random() * 10000) + 40000;
            zkInstance = new ZKLib({
              ip: ip,
              port: parseInt(port) || 4370,
              inport: retryInport,
              timeout: 15000,
            });
            console.log(
              `Force reconnect Pattern 2 success (inport: ${retryInport})`
            );
          } catch (directError) {
            console.log(`Retry with new inport failed: ${directError.message}`);
            {
              // Last attempt before giving up: one more distinct local port.
              const lastInport = Math.floor(Math.random() * 10000) + 40000;
              zkInstance = new ZKLib({
                ip: ip,
                port: parseInt(port) || 4370,
                inport: lastInport,
                timeout: 20000,
              });
              console.log(
                `Force reconnect Pattern 3 success (inport: ${lastInport})`
              );
            }
          }
        }

        await zkInstance.createSocket();

        // Verify connection (only if method exists)
        let deviceInfo;
        if (typeof zkInstance.getInfo === "function") {
          deviceInfo = await zkInstance.getInfo();
          console.log(`Connected to ZKTeco device via zklib:`, deviceInfo);
        } else {
          console.log("getInfo method not available in this SDK instance");
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
        console.error(`zklib-only connection failed: ${zklibError.message}`);
        res.status(500).json({
          success: false,
          message: `Failed to connect with zklib: ${zklibError.message}`,
          recommendation:
            "Your ZKTeco device may not be compatible with zklib. Consider updating device firmware or using a different device model.",
          error: zklibError.message,
        });
      }
    } catch (error) {
      console.error("Force reconnect error:", error);
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
          console.log(`Disconnected ZKTeco SDK from machine at ${ip}`);
        } catch (error) {
          console.log(`Error disconnecting ZKTeco SDK: ${error.message}`);
        }
      }

      // Remove connection info
      machineConnections.delete(ip);

      console.log(`Disconnected from ZKTeco biometric machine at ${ip}`);

      res.json({
        success: true,
        message: "Successfully disconnected from ZKTeco biometric machine",
      });
    } catch (error) {
      console.error("Disconnect error:", error);
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

      console.log(`Fetching real employees from ZKTeco machine at ${ip}`);

      // No zkInstances lookup here on purpose. Only /force-reconnect ever
      // populates that map, so gating on it made a plain /connect followed by
      // this call fail with "SDK not initialized" even though the device was
      // reachable. The machineConnections check above is the real guard, and
      // the fetch below opens its own ZKTecoService connection regardless.
      try {
        console.log(
          `Connected to ZKTeco machine at ${ip} - fetching employees...`
        );

        // Use the working ZKTecoService directly
        const deviceGateway = require("../services/deviceGateway");

        try {
          // One gateway call covers connect, read and release, whether the read
          // happens here on the LAN or on the office PC running the Local Agent.
          const { users } = await deviceGateway.getUsers(ip, 4370);
          const employees = Array.isArray(users) ? users : [];
          console.log(
            `Retrieved ${employees.length} employees from ZKTeco device`
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

          res.json({
            success: true,
            employees: formattedEmployees,
            count: formattedEmployees.length,
            machineIp: ip,
            fetchedAt: new Date(),
            method: "zktecoService_getUsers",
            source: "device",
            via: deviceGateway.isAgentMode() ? "local-agent" : "direct",
          });
        } catch (serviceError) {
          console.error(`ZKTeco service failed: ${serviceError.message}`);
          throw serviceError;
        }
      } catch (error) {
        console.error(
          `Failed to fetch employees from ZKTeco machine:`,
          error
        );

        if (error.code === "DEVICE_OFFLINE" || error.code === "AGENT_BUSY") {
          return res.status(503).json({
            success: false,
            code: error.code,
            message:
              "The Local Agent on the office PC is not connected, so employees cannot be read from the device.",
            error: error.message,
            machineIp: ip,
          });
        }

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
      console.error("Failed to fetch employees:", error);
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
        `Fetching real attendance for employee ${employeeId} from ZKTeco machine ${ip}`
      );

      // Log the date range being requested
      if (startDateParam && endDateParam) {
        console.log(`Date range: ${startDateParam} to ${endDateParam}`);
      } else {
        console.log(`Using days fallback: ${days} days`);
      }

      // No zkInstances gate here: only /force-reconnect populates that map, and
      // the fetch below opens its own ZKTecoService connection.
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
          `Fetching attendance: ${startDateStr} to ${endDateStr}, forceSync: ${forceSync}`
        );

        // Use REAL ZKTeco data service (no more mock data)
        console.log("Using REAL ZKTeco data service for attendance fetch");
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
          `Failed to fetch attendance from ZKTeco machine:`,
          error
        );
        res.status(500).json({
          success: false,
          message: `Failed to fetch attendance records from ZKTeco machine: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("Failed to fetch attendance records:", error);
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
        `Fetching attendance from DATABASE for employee ${employeeId}`
      );

      // Calculate date range
      let startDateStr, endDateStr;

      if (startDate && endDate) {
        startDateStr = startDate;
        endDateStr = endDate;
      } else {
        // Fallback to days-based logic
        // Anchored on the office's current day. Before the zone offset each
        // morning the UTC date is still yesterday, which silently dropped
        // today from the default range.
        endDateStr = officeToday();
        const [ty, tm, td] = endDateStr.split("-").map(Number);
        const startDateObj = new Date(Date.UTC(ty, tm - 1, td));
        startDateObj.setUTCDate(startDateObj.getUTCDate() - parseInt(days));
        startDateStr = startDateObj.toISOString().split("T")[0];
      }

      console.log(
        `Fetching from database: ${startDateStr} to ${endDateStr}`
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
        `Successfully fetched ${result.totalRecords} records from database`
      );

      res.json(result);
    } catch (error) {
      console.error("Failed to fetch attendance from database:", error);
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
        `Fetching attendance summary from DATABASE for employee ${employeeId}`
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
        `Fetching summary from database: ${startDateStr} to ${endDateStr}`
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
        `Successfully generated summary for ${result.totalDays} days from database`
      );

      res.json(result);
    } catch (error) {
      console.error(
        "Failed to fetch attendance summary from database:",
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

      console.log(`Fetching attendance statistics from DATABASE`);

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
        `Fetching stats from database: ${startDateStr} to ${endDateStr}`
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
        `Successfully generated statistics: ${result.totalRecords} records, ${result.uniqueEmployeeCount} employees`
      );

      res.json(result);
    } catch (error) {
      console.error(
        "Failed to fetch attendance statistics from database:",
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
        `Employee ${req.user.name} (${employeeId}) viewing own attendance`
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

      console.log(`Date range: ${startDateStr} to ${endDateStr}`);

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
  allowSelfOrAdmin,
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { startDate, endDate, days = 7 } = req.query;

      console.log(
        `Fetching attendance for employee ${employeeId} from ${mongoose.connection.db.databaseName}`
      );

      // No host assertion here. Attendance is read from whichever database the
      // server is configured to use, which is Atlas on any deployed host - the
      // records this route serves live there, not on a local mongod. Requiring
      // a localhost connection made this endpoint fail on every production
      // request, which is the whole employee attendance screen.

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
        `Fetching from LOCAL database: ${startDateStr} to ${endDateStr}`
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
          `Could not fetch late time settings, using default: ${cutoffTime}`
        );
      }

      // Get attendance data from LOCAL database
      const result = await AttendanceDbService.getEmployeeAttendance(
        employeeId,
        startDateStr,
        endDateStr,
        req.user.company
      );

      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: `Failed to fetch attendance from LOCAL database: ${result.error}`,
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
        `Successfully transformed ${result.totalRecords} records from LOCAL database`
      );
      console.log(
        `Confirmed database: ${mongoose.connection.db.databaseName} on ${mongoose.connection.host}`
      );

      res.json({
        success: true,
        ...transformedData,
        databaseInfo: {
          host: mongoose.connection.host,
          database: mongoose.connection.db.databaseName,
          isLocal:
            mongoose.connection.host === "127.0.0.1" ||
            mongoose.connection.host === "localhost",
        },
      });
    } catch (error) {
      console.error(
        "Failed to fetch attendance from LOCAL database:",
        error
      );
      res.status(500).json({
        success: false,
        message: "Failed to fetch attendance records from LOCAL database",
        error: error.message,
        databaseHost: mongoose.connection.host,
        databaseName: mongoose.connection.db?.databaseName,
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
    const [wy, wm, wd] = record.date.split("-").map(Number);
    const dayOfWeek = new Date(Date.UTC(wy, wm - 1, wd)).getUTCDay();
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
    const [cutoffHour, cutoffMinute] = cutoffTime.split(":").map(Number);

    // Compare wall clock to wall clock in the office timezone. Date.setHours()
    // applies the SERVER's zone, which is UTC on a deployed host - a 09:00
    // cutoff then meant 14:00 in the office and nobody was ever late.
    const { hour, minute } = zonedParts(new Date(timestamp));
    const minutesIntoDay = Number(hour) * 60 + Number(minute);
    const cutoffMinutes = cutoffHour * 60 + cutoffMinute;

    if (minutesIntoDay > cutoffMinutes) {
      const lateMinutes = minutesIntoDay - cutoffMinutes;
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
        `Skipping weekend record: ${record.date} (${
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

  console.log(`WEEKEND EXCLUSION STATS:`);
  console.log(`Date Range: ${startDate} to ${endDate}`);
  console.log(`Total Calendar Days: ${totalCalendarDays}`);
  console.log(
          `Total Working Days: ${totalWorkingDays} (excluded ${
      totalCalendarDays - totalWorkingDays
    } weekend days)`
  );
  console.log(`Original Records: ${totalOriginalRecords}`);
  console.log(`Weekend Records Filtered: ${weekendRecordsFiltered}`);
  console.log(`Working Day Records Shown: ${filteredRecords.length}`);
  console.log(`Present Working Days: ${presentWorkingDays}`);
  console.log(`Absent Working Days: ${absentWorkingDays}`);
  console.log(`Working Days Attendance Rate: ${attendanceRate}%`);
  console.log(
          `Calendar Days Attendance Rate: ${
      totalCalendarDays > 0
        ? Math.round((presentDays / totalCalendarDays) * 100)
        : 0
    }%`
  );
  console.log(
          `Improvement: +${
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
      console.error("Failed to update late time settings:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update late time settings",
        error: error.message,
      });
    }
  }
);

// Get late time calculation settings. Readable by any signed-in user - the
// cutoff is what renders the "late" badge on a person's own records. Changing
// it stays admin-only (see the PUT above).
router.get(
  "/settings/late-time",
  authenticateToken,
  async (req, res) => {
    try {
      let machineSettings = null;
      let machineDefaultTime = "09:00";

      // Try to fetch time settings from any connected ZKTeco device
      for (const [ip, zkInstance] of zkInstances.entries()) {
        try {
          console.log(`Fetching time settings from ZKTeco machine ${ip}`);

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
              console.log(`Got machine time settings:`, machineSettings);
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
                `Got machine timezone/time info:`,
                machineSettings
              );
              break;
            }
          } else {
            console.log(
              `getInfo method not available for machine ${ip} - using default settings`
            );
          }
        } catch (error) {
          console.log(
            `Failed to get time settings from machine ${ip}:`,
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
      console.error("Failed to fetch late time settings:", error);
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

      console.log(`Manual sync triggered for machine ${ip}`);

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
      console.error("Manual sync error:", error);
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
      console.error("Sync status error:", error);
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
      console.log("Manual sync triggered for all connected machines");

      const results = await attendanceSyncService.syncAllConnectedMachines();

      res.json({
        success: true,
        message: "Manual sync completed for all machines",
        results,
      });
    } catch (error) {
      console.error("Sync all machines error:", error);
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
        `Real-time attendance fetch for employee ${employeeId} from ${ip}`
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

      // No zkInstances gate here: only /force-reconnect populates that map, and
      // the fetch below opens its own ZKTecoService connection.
      try {
        // Calculate date range for last N days (3 months)
        const endDate = new Date();
        const startDate = new Date(
          Date.now() - parseInt(days) * 24 * 60 * 60 * 1000
        );

        const startDateStr = startDate.toISOString().split("T")[0];
        const endDateStr = endDate.toISOString().split("T")[0];

        console.log(
          `Real-time fetch for ${days} days: ${startDateStr} to ${endDateStr}`
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
        console.error(`Real-time fetch failed:`, error);
        res.status(500).json({
          success: false,
          message: `Real-time attendance fetch failed: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("Real-time attendance error:", error);
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

      console.log(`Running diagnostics for ZKTeco machine ${ip}`);

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
        console.error(`Diagnostics failed for machine ${ip}:`, error);
        res.status(500).json({
          success: false,
          message: `Diagnostics failed: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("Diagnostic endpoint error:", error);
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
      "Connection verification failed - check network connectivity and device status"
    );
  }

  // Check for js-zklib specific issues
  if (
    diagnostics.capabilities.sdkLibraryIssues &&
    diagnostics.capabilities.sdkLibraryIssues.length > 0
  ) {
    recommendations.push("SDK Library Issues Detected:");
    diagnostics.capabilities.sdkLibraryIssues.forEach((issue) => {
      recommendations.push(`   • ${issue}`);
    });
    recommendations.push(
      "Solution: Try reconnecting to prefer zklib over js-zklib"
    );
  }

  if (diagnostics.capabilities.availableMethods.length === 0) {
    recommendations.push(
      "No SDK methods available - try switching between zklib and js-zklib libraries"
    );
  } else if (diagnostics.capabilities.availableMethods.length < 3) {
    recommendations.push(
      "Limited SDK methods available - some functionality may be restricted"
    );
  }

  if (!diagnostics.capabilities.connectionStable) {
    recommendations.push(
      "Connection appears unstable - consider network optimization or device restart"
    );
  }

  if (
    !diagnostics.capabilities.availableMethods.includes("getAttendances") &&
    !diagnostics.capabilities.availableMethods.includes("getLogs")
  ) {
    recommendations.push(
      "No attendance data methods available - attendance sync will not work"
    );
  }

  if (
    diagnostics.capabilities.deviceInfo &&
    diagnostics.capabilities.deviceInfo.logCounts > 50000
  ) {
    recommendations.push(
      "Large number of logs on device - consider using smaller batch sizes"
    );
  }

  // Check for js-zklib buffer overflow risk
  if (
    diagnostics.capabilities.sdkLibraryIssues.some((issue) =>
      issue.includes("buffer overflow")
    )
  ) {
    recommendations.push("Critical: js-zklib buffer overflow detected");
    recommendations.push("Workaround: Reconnect to try zklib instead");
    recommendations.push(
      "Alternative: Use smaller date ranges in data requests"
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "All diagnostics passed - device should work optimally"
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

      console.log(`On-demand attendance fetch requested for machine ${ip}`);

      // Default to last 2 months if no dates provided
      if (!startDate || !endDate) {
        const now = new Date();
        endDate = now.toISOString().split("T")[0];

        const twoMonthsAgo = new Date();
        twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
        startDate = twoMonthsAgo.toISOString().split("T")[0];

        console.log(
          `Using default date range: ${startDate} to ${endDate} (last 2 months)`
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

      // No zkInstances gate here: only /force-reconnect populates that map, and
      // the fetch below opens its own ZKTecoService connection.
      console.log(
        `Fetching attendance data from ${ip} for period: ${startDate} to ${endDate}`
      );

      try {
        // Calculate date range and use intelligent batching
        const diffTime = Math.abs(endDateObj - startDateObj);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        console.log(`Date range spans ${diffDays} days`);

        let result;

        if (diffDays > 60) {
          // For large date ranges, use 7-day batches
          console.log(
            `Using batch processing (7-day batches) for large date range`
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
          console.log(`Using standard fetch for small date range`);
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
          `Failed to fetch attendance data from machine:`,
          error
        );
        res.status(500).json({
          success: false,
          message: `Failed to fetch attendance data: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("Attendance fetch error:", error);
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
        `Force fetching REAL data from ${ip}: ${startDate} to ${endDate}`
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
        console.error(`Failed to fetch real data from machine:`, error);
        res.status(500).json({
          success: false,
          message: `Failed to fetch real attendance data: ${error.message}`,
          error: error.message,
        });
      }
    } catch (error) {
      console.error("Real data fetch error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch real attendance data from machine",
      });
    }
  }
);

// ============================================================
// Remote Door Unlock (access-control relay)
// Reuses the SAME ZKTeco integration, service, and config that
// attendance sync uses. Admin only. Opens the magnetic lock for
// 10s; the device relay auto-releases (re-locks) afterward.
// ============================================================
router.post(
  "/door/unlock",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    // Reuse the configured device IP/port (env-driven, same as attendance).
    const ip = req.body?.ip || process.env.ZKTECO_IP || "192.168.1.201";
    const port = parseInt(
      req.body?.port || process.env.ZKTECO_PORT || 4370,
      10
    );
    const DURATION_SECONDS = 10;

    // Audit context for logging (user, timestamp, target device).
    const actor = {
      id: req.user?._id?.toString(),
      email: req.user?.email,
      name: req.user?.name,
    };
    const requestedAt = new Date().toISOString();
    console.log(
      ` [DOOR-UNLOCK] Requested by ${actor.email || actor.id} at ${requestedAt} → device ${ip}:${port}`
    );

    // Same ZKTeco unlock command either way. deviceGateway only decides which
    // machine issues it: this server on the LAN, or the office PC running the
    // Local Agent when the server is hosted off-site.
    const deviceGateway = require("../services/deviceGateway");

    try {
      const result = await deviceGateway.unlockDoor(ip, port, DURATION_SECONDS);

      console.log(
        ` [DOOR-UNLOCK] SUCCESS - ${actor.email || actor.id} opened door ${ip} for ${DURATION_SECONDS}s at ${requestedAt}`
      );

      return res.status(200).json({
        success: true,
        message: `Door unlocked for ${DURATION_SECONDS} seconds. It will lock automatically.`,
        durationSeconds: result.durationSeconds || DURATION_SECONDS,
        device: { ip, port },
        via: deviceGateway.isAgentMode() ? "local-agent" : "direct",
        unlockedBy: actor.email || actor.name || actor.id,
        timestamp: requestedAt,
      });
    } catch (error) {
      console.error(
        ` [DOOR-UNLOCK] FAILED - requested by ${actor.email || actor.id} for device ${ip} at ${requestedAt}: ${error.message}`
      );

      // Classify the failure the same way /connect does. Returning a blanket
      // 500 "please try again" for an unreachable device is wrong twice over:
      // it reports a server fault for what is an upstream one, and it invites a
      // retry that cannot succeed. This matters most in production, where the
      // device sits on a private LAN the cloud host has no route to at all.
      const reason = (error.message || "").toLowerCase();

      if (error.code === "DEVICE_OFFLINE" || error.code === "AGENT_BUSY") {
        return res.status(503).json({
          success: false,
          code: error.code,
          message:
            "The door was NOT unlocked. The Local Agent on the office PC is not connected, " +
            "so the command could not reach the door controller. Turn the office PC on and try again.",
          error: error.message,
          device: { ip, port, status: "agent_offline" },
          timestamp: requestedAt,
        });
      }

      if (error.code === "AGENT_TIMEOUT") {
        return res.status(504).json({
          success: false,
          code: "AGENT_TIMEOUT",
          message:
            "The door unlock could not be confirmed. The Local Agent did not report a result in time, " +
            "so treat the door as still locked.",
          error: error.message,
          device: { ip, port, status: "unconfirmed" },
          timestamp: requestedAt,
        });
      }

      if (/librar(y|ies) not available|cannot find module/i.test(error.message)) {
        return res.status(500).json({
          success: false,
          message:
            "Server misconfiguration: the ZKTeco driver library is not installed on the backend. " +
            "This is not a network problem - run `npm install` in the backend directory.",
          error: error.message,
          device: { ip, port, status: "driver_missing" },
          timestamp: requestedAt,
        });
      }

      if (
        reason.includes("did not answer") ||
        reason.includes("not responding") ||
        reason.includes("timeout") ||
        reason.includes("refused") ||
        reason.includes("ehostunreach") ||
        reason.includes("enetunreach")
      ) {
        return res.status(502).json({
          success: false,
          message:
            `Unable to reach the door controller at ${ip}:${port}. It did not respond. ` +
            "Check that the device is powered on and that this server is on the same network as it - " +
            "a device on a private LAN is not reachable from a cloud-hosted backend.",
          error: error.message,
          device: { ip, port, status: "unreachable" },
          timestamp: requestedAt,
        });
      }

      return res.status(500).json({
        success: false,
        message: "Failed to unlock door.",
        error: error.message,
        device: { ip, port },
        timestamp: requestedAt,
      });
    }
  }
);

module.exports = router;
