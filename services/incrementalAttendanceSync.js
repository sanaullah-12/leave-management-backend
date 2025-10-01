const AttendanceLog = require("../models/AttendanceLog");
const User = require("../models/User");

class IncrementalAttendanceSyncService {
  constructor() {
    this.isRunning = false;
    this.syncInterval = null;
    this.zkInstances = new Map();
    this.machineConnections = new Map();
    this.lastSyncMap = new Map(); // Track last sync timestamp per machine
  }

  // Initialize with ZKTeco instances from attendance routes
  initialize(zkInstances, machineConnections) {
    this.zkInstances = zkInstances;
    this.machineConnections = machineConnections;
    console.log("📡 Incremental Attendance Sync Service initialized");
  }

  // Start scheduled incremental sync (every 6 hours)
  startScheduledSync() {
    if (this.syncInterval) {
      console.log("📡 Incremental attendance sync already running");
      return;
    }

    console.log(
      "📡 Starting scheduled incremental attendance sync (every 6 hours)"
    );

    // Sync immediately on start (last 24 hours)
    this.syncAllConnectedMachinesIncremental();

    // Schedule regular syncs every 6 hours
    this.syncInterval = setInterval(() => {
      this.syncAllConnectedMachinesIncremental();
    }, 6 * 60 * 60 * 1000); // 6 hours
  }

  // Stop scheduled sync
  stopScheduledSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log("📡 Stopped scheduled incremental attendance sync");
    }
  }

  // Sync attendance logs from all connected machines incrementally
  async syncAllConnectedMachinesIncremental() {
    if (!this.zkInstances || !this.machineConnections) {
      console.log("⚠️ Incremental sync service not initialized properly");
      return [];
    }

    if (this.isRunning) {
      console.log("📡 Incremental sync already in progress, skipping...");
      return [];
    }

    this.isRunning = true;
    console.log(
      "📡 Starting incremental attendance sync for all connected machines"
    );

    const results = [];

    for (const [machineIp, connection] of this.machineConnections.entries()) {
      if (connection.status === "connected") {
        try {
          console.log(
            `📡 Incremental syncing attendance from machine ${machineIp}`
          );
          const result = await this.syncMachineAttendanceIncremental(machineIp);
          results.push({ machineIp, ...result });
        } catch (error) {
          console.error(
            `❌ Failed to incrementally sync machine ${machineIp}:`,
            error.message
          );
          results.push({
            machineIp,
            success: false,
            error: error.message,
            synced: 0,
            syncType: "incremental",
          });
        }
      }
    }

    this.isRunning = false;
    console.log(
      "📡 Incremental attendance sync completed for all machines:",
      results
    );
    return results;
  }

  // Sync attendance logs from a specific machine incrementally
  async syncMachineAttendanceIncremental(
    machineIp,
    companyId = null,
    forceDays = null
  ) {
    const zkInstance = this.zkInstances.get(machineIp);
    if (!zkInstance) {
      throw new Error(`ZKTeco instance not found for machine ${machineIp}`);
    }

    try {
      console.log(`📊 Starting incremental sync for machine ${machineIp}`);

      // Determine sync period
      const lastSync = this.lastSyncMap.get(machineIp);
      let syncFromDate;

      if (forceDays) {
        // Force sync specific number of days
        syncFromDate = new Date();
        syncFromDate.setDate(syncFromDate.getDate() - forceDays);
        console.log(
          `🔄 Force syncing last ${forceDays} days from ${
            syncFromDate.toISOString().split("T")[0]
          }`
        );
      } else if (lastSync) {
        // Sync from last successful sync date (with 1-day overlap for safety)
        syncFromDate = new Date(lastSync);
        syncFromDate.setDate(syncFromDate.getDate() - 1);
        console.log(
          `🔄 Incremental sync from last sync date: ${
            syncFromDate.toISOString().split("T")[0]
          }`
        );
      } else {
        // First sync - get last 7 days
        syncFromDate = new Date();
        syncFromDate.setDate(syncFromDate.getDate() - 7);
        console.log(
          `🔄 First sync - getting last 7 days from ${
            syncFromDate.toISOString().split("T")[0]
          }`
        );
      }

      const today = new Date();
      const startDateStr = syncFromDate.toISOString().split("T")[0];
      const endDateStr = today.toISOString().split("T")[0];

      console.log(
        `📅 Syncing attendance from ${startDateStr} to ${endDateStr}`
      );

      // Fetch attendance logs from ZKTeco device with shorter timeout
      const attendanceLogs = await this.fetchAttendanceFromDevice(
        zkInstance,
        machineIp,
        startDateStr,
        endDateStr
      );

      if (attendanceLogs.length === 0) {
        console.log(`ℹ️ No new attendance logs found for machine ${machineIp}`);
        this.lastSyncMap.set(machineIp, new Date());
        return {
          success: true,
          synced: 0,
          message: "No new attendance logs found",
          dateRange: { startDate: startDateStr, endDate: endDateStr },
          syncType: "incremental",
        };
      }

      // Process and store logs in database
      const storedCount = await this.storeAttendanceLogsInDatabase(
        attendanceLogs,
        machineIp,
        companyId
      );

      // Update last sync timestamp
      this.lastSyncMap.set(machineIp, new Date());

      console.log(
        `✅ Successfully synced ${storedCount} attendance logs for machine ${machineIp}`
      );

      return {
        success: true,
        synced: storedCount,
        totalFetched: attendanceLogs.length,
        dateRange: { startDate: startDateStr, endDate: endDateStr },
        syncType: "incremental",
        message: `Successfully synced ${storedCount} attendance logs`,
      };
    } catch (error) {
      console.error(
        `❌ Failed to incrementally sync machine ${machineIp}:`,
        error
      );
      throw error;
    }
  }

  // Fetch attendance from ZKTeco device with optimized approach
  async fetchAttendanceFromDevice(zkInstance, machineIp, startDate, endDate) {
    try {
      console.log(
        `🔧 Fetching attendance from device ${machineIp} (${startDate} to ${endDate})`
      );

      // Use shorter timeout for incremental sync
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("Device fetch timeout (60s) - incremental sync")),
          60000
        )
      );

      const fetchPromise = new Promise((resolve, reject) => {
        if (typeof zkInstance.getAttendance !== "function") {
          reject(new Error("getAttendance method not available on device"));
          return;
        }

        zkInstance.getAttendance((err, attendanceData) => {
          if (err) {
            reject(new Error(`Device getAttendance error: ${err}`));
          } else {
            resolve(attendanceData || []);
          }
        });
      });

      const rawLogs = await Promise.race([fetchPromise, timeoutPromise]);

      // Filter logs by date range (ZKTeco sometimes returns all logs)
      const start = new Date(startDate + "T00:00:00");
      const end = new Date(endDate + "T23:59:59");

      const filteredLogs = rawLogs.filter((log) => {
        if (!log.timestamp) return false;
        const logDate = new Date(log.timestamp);
        return logDate >= start && logDate <= end;
      });

      console.log(
        `📊 Device returned ${rawLogs.length} total logs, ${filteredLogs.length} in date range`
      );
      return filteredLogs;
    } catch (error) {
      console.error(
        `❌ Failed to fetch from device ${machineIp}:`,
        error.message
      );

      if (error.message.includes("timeout")) {
        // For timeout, try to continue with empty result rather than fail
        console.log(
          `⚠️ Device timeout - continuing with empty result for incremental sync`
        );
        return [];
      }

      throw error;
    }
  }

  // Store attendance logs in database with duplicate prevention
  async storeAttendanceLogsInDatabase(attendanceLogs, machineIp, companyId) {
    try {
      console.log(
        `💾 Storing ${attendanceLogs.length} attendance logs in database`
      );

      let storedCount = 0;
      const batchSize = 100; // Process in batches to avoid memory issues

      for (let i = 0; i < attendanceLogs.length; i += batchSize) {
        const batch = attendanceLogs.slice(i, i + batchSize);

        for (const log of batch) {
          try {
            // Create unique key to prevent duplicates
            const uniqueKey = `${machineIp}_${log.uid || log.userId}_${new Date(
              log.timestamp
            ).getTime()}`;

            // Check if log already exists
            const existingLog = await AttendanceLog.findOne({ uniqueKey });
            if (existingLog) {
              continue; // Skip duplicate
            }

            // Create new attendance log
            const attendanceLog = new AttendanceLog({
              machineIp: machineIp,
              employeeId: log.uid || log.userId || log.employeeId || "unknown",
              machineUserId: log.uid || log.userId || "unknown",
              timestamp: new Date(log.timestamp),
              date: new Date(log.timestamp).toISOString().split("T")[0],
              type: this.determineAttendanceType(log),
              mode: log.mode || log.type || "unknown",
              processed: false,
              rawData: log,
              company: companyId,
              uniqueKey: uniqueKey,
              syncedAt: new Date(),
            });

            await attendanceLog.save();
            storedCount++;
          } catch (saveError) {
            if (saveError.code === 11000) {
              // Duplicate key error - skip
              continue;
            }
            console.error(
              `❌ Failed to save attendance log:`,
              saveError.message
            );
          }
        }

        // Log progress for large batches
        if (attendanceLogs.length > batchSize) {
          console.log(
            `💾 Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
              attendanceLogs.length / batchSize
            )}`
          );
        }
      }

      console.log(
        `✅ Successfully stored ${storedCount} new attendance logs in database`
      );
      return storedCount;
    } catch (error) {
      console.error(`❌ Failed to store attendance logs:`, error);
      throw error;
    }
  }

  // Determine attendance type from log data
  determineAttendanceType(log) {
    if (log.type) {
      return log.type;
    }

    if (log.mode) {
      // Map ZKTeco modes to our types
      switch (log.mode) {
        case 0:
          return "check-in";
        case 1:
          return "check-out";
        case 2:
          return "break-out";
        case 3:
          return "break-in";
        case 4:
          return "overtime-in";
        case 5:
          return "overtime-out";
        default:
          return "unknown";
      }
    }

    return "unknown";
  }

  // Get attendance logs from database (not device) with date filtering
  async getAttendanceFromDatabase(
    machineIp,
    employeeId,
    startDate,
    endDate,
    companyId
  ) {
    try {
      console.log(
        `📊 Fetching attendance from database for employee ${employeeId} (${startDate} to ${endDate})`
      );

      const query = {
        machineIp: machineIp,
        date: {
          $gte: startDate,
          $lte: endDate,
        },
      };

      // Add employee filter if specified
      if (employeeId && employeeId !== "all") {
        query.employeeId = employeeId;
      }

      // Add company filter if specified
      if (companyId) {
        query.company = companyId;
      }

      const attendanceLogs = await AttendanceLog.find(query)
        .sort({ timestamp: 1 })
        .lean();

      console.log(
        `✅ Found ${attendanceLogs.length} attendance logs in database`
      );

      return {
        success: true,
        attendance: attendanceLogs,
        employeeId: employeeId,
        dateRange: { startDate, endDate },
        totalRecords: attendanceLogs.length,
        source: "database",
        fetchedAt: new Date(),
      };
    } catch (error) {
      console.error(`❌ Failed to fetch attendance from database:`, error);
      return {
        success: false,
        error: error.message,
        attendance: [],
      };
    }
  }

  // Force sync specific date range (for manual sync or catch-up)
  async forceSyncDateRange(machineIp, startDate, endDate, companyId) {
    try {
      console.log(
        `🔄 Force syncing date range ${startDate} to ${endDate} for machine ${machineIp}`
      );

      const zkInstance = this.zkInstances.get(machineIp);
      if (!zkInstance) {
        throw new Error(`ZKTeco instance not found for machine ${machineIp}`);
      }

      // Calculate number of days
      const start = new Date(startDate);
      const end = new Date(endDate);
      const diffDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

      console.log(`📅 Force syncing ${diffDays} days of data`);

      // Fetch attendance logs from device
      const attendanceLogs = await this.fetchAttendanceFromDevice(
        zkInstance,
        machineIp,
        startDate,
        endDate
      );

      // Store in database
      const storedCount = await this.storeAttendanceLogsInDatabase(
        attendanceLogs,
        machineIp,
        companyId
      );

      // Update last sync timestamp
      this.lastSyncMap.set(machineIp, new Date());

      return {
        success: true,
        synced: storedCount,
        totalFetched: attendanceLogs.length,
        dateRange: { startDate, endDate },
        syncType: "force",
        message: `Force synced ${storedCount} attendance logs for ${diffDays} days`,
      };
    } catch (error) {
      console.error(`❌ Force sync failed:`, error);
      throw error;
    }
  }

  // Get sync status for all machines
  getSyncStatus() {
    const status = {
      isRunning: this.isRunning,
      lastSyncTimes: {},
      connectedMachines: Array.from(this.machineConnections.keys()),
      nextScheduledSync: null,
    };

    // Get last sync times with proper validation
    for (const [machineIp, lastSync] of this.lastSyncMap.entries()) {
      // Ensure lastSync is a valid Date object or null
      if (lastSync && lastSync instanceof Date && !isNaN(lastSync.getTime())) {
        status.lastSyncTimes[machineIp] = lastSync;
      } else {
        status.lastSyncTimes[machineIp] = null;
      }
    }

    // Calculate next scheduled sync time
    if (this.syncInterval) {
      status.nextScheduledSync = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6 hours from now
    }

    return status;
  }

  // Helper method to validate and format dates safely
  _validateDate(date) {
    if (!date) return null;
    if (date instanceof Date && !isNaN(date.getTime())) {
      return date;
    }
    if (typeof date === 'string' || typeof date === 'number') {
      const parsedDate = new Date(date);
      if (!isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    }
    return null;
  }

  // Helper method to format dates safely for display
  _formatDateSafely(date) {
    const validDate = this._validateDate(date);
    if (validDate) {
      return validDate.toISOString();
    }
    return "Never synced";
  }

  // Manual trigger for specific machine
  async triggerManualSync(machineIp, companyId, days = 7) {
    try {
      console.log(
        `🔄 Manual sync triggered for machine ${machineIp} (last ${days} days)`
      );

      const result = await this.syncMachineAttendanceIncremental(
        machineIp,
        companyId,
        days
      );

      return {
        success: true,
        message: `Manual sync completed for machine ${machineIp}`,
        result,
      };
    } catch (error) {
      console.error(`❌ Manual sync failed for machine ${machineIp}:`, error);
      throw error;
    }
  }
}

// Create singleton instance
const incrementalAttendanceSyncService = new IncrementalAttendanceSyncService();

module.exports = incrementalAttendanceSyncService;
