const express = require("express");
const router = express.Router();
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const AttendanceLog = require("../models/AttendanceLog");
const incrementalAttendanceSyncService = require("../services/incrementalAttendanceSync");

// Get attendance records from DATABASE with date filtering (FAST)
router.get("/logs/:ip/:employeeId", authenticateToken, async (req, res) => {
  try {
    const { ip, employeeId } = req.params;
    const { startDate, endDate } = req.query;

    // Validate required parameters
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message:
          "startDate and endDate query parameters are required (YYYY-MM-DD format)",
      });
    }

    console.log(
      `📊 Fetching attendance from DATABASE for employee ${employeeId} at machine ${ip}`
    );
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    // Fetch data from DATABASE (not device) - INSTANT response
    const result =
      await incrementalAttendanceSyncService.getAttendanceFromDatabase(
        ip,
        employeeId,
        startDate,
        endDate,
        req.user.company
      );

    // Add metadata about sync status
    const syncStatus = incrementalAttendanceSyncService.getSyncStatus();
    const lastSyncForMachine = syncStatus.lastSyncTimes[ip];

    res.json({
      ...result,
      syncInfo: {
        lastSyncTime: lastSyncForMachine || null,
        lastSyncTimeFormatted: lastSyncForMachine ? new Date(lastSyncForMachine).toISOString() : "Never synced",
        dataSource: "database",
        realTime: false,
        note: "Data served from database for instant response. Use /sync endpoints to update from device.",
      },
    });
  } catch (error) {
    console.error("❌ Failed to fetch attendance from database:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch attendance records from database",
      error: error.message,
    });
  }
});

// Get attendance for ALL employees from DATABASE (FAST)
router.get("/logs/:ip/all", authenticateToken, async (req, res) => {
  try {
    const { ip } = req.params;
    const { startDate, endDate } = req.query;

    // Validate required parameters
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message:
          "startDate and endDate query parameters are required (YYYY-MM-DD format)",
      });
    }

    console.log(`📊 Fetching ALL attendance from DATABASE for machine ${ip}`);
    console.log(`📅 Date range: ${startDate} to ${endDate}`);

    // Fetch ALL attendance data from DATABASE
    const result =
      await incrementalAttendanceSyncService.getAttendanceFromDatabase(
        ip,
        "all", // Special keyword for all employees
        startDate,
        endDate,
        req.user.company
      );

    // Group by employee for easier frontend processing
    const groupedByEmployee = {};
    result.attendance.forEach((log) => {
      if (!groupedByEmployee[log.employeeId]) {
        groupedByEmployee[log.employeeId] = [];
      }
      groupedByEmployee[log.employeeId].push(log);
    });

    // Add metadata
    const syncStatus = incrementalAttendanceSyncService.getSyncStatus();
    const lastSyncForMachine = syncStatus.lastSyncTimes[ip];

    res.json({
      success: true,
      attendanceByEmployee: groupedByEmployee,
      totalRecords: result.attendance.length,
      uniqueEmployees: Object.keys(groupedByEmployee).length,
      dateRange: { startDate, endDate },
      machineIp: ip,
      syncInfo: {
        lastSyncTime: lastSyncForMachine || null,
        lastSyncTimeFormatted: lastSyncForMachine ? new Date(lastSyncForMachine).toISOString() : "Never synced",
        dataSource: "database",
        realTime: false,
        note: "All employee data served from database for instant response.",
      },
    });
  } catch (error) {
    console.error("❌ Failed to fetch all attendance from database:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch all attendance records from database",
      error: error.message,
    });
  }
});

// Trigger incremental sync from device to database (ASYNC background task)
router.post(
  "/sync/incremental/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;
      const { days = 7 } = req.body; // Default: sync last 7 days

      console.log(
        `🔄 Triggering incremental sync for machine ${ip} (last ${days} days)`
      );

      // Trigger sync in background (don't wait for completion)
      incrementalAttendanceSyncService
        .triggerManualSync(ip, req.user.company, days)
        .then((result) => {
          console.log(`✅ Background sync completed for ${ip}:`, result);
        })
        .catch((error) => {
          console.error(`❌ Background sync failed for ${ip}:`, error.message);
        });

      // Return immediate response
      res.json({
        success: true,
        message: `Incremental sync started for machine ${ip} (${days} days)`,
        machineIp: ip,
        syncDays: days,
        status: "background_sync_started",
        note: "Sync is running in background. Check sync status endpoint for progress.",
      });
    } catch (error) {
      console.error("❌ Failed to trigger incremental sync:", error);
      res.status(500).json({
        success: false,
        message: "Failed to trigger incremental sync",
        error: error.message,
      });
    }
  }
);

// Force sync specific date range from device to database
router.post(
  "/sync/daterange/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;
      const { startDate, endDate } = req.body;

      // Validate required parameters
      if (!startDate || !endDate) {
        return res.status(400).json({
          success: false,
          message:
            "startDate and endDate are required in request body (YYYY-MM-DD format)",
        });
      }

      console.log(
        `🔄 Force syncing date range ${startDate} to ${endDate} for machine ${ip}`
      );

      // Start sync and wait for completion (for specific date ranges)
      const result = await incrementalAttendanceSyncService.forceSyncDateRange(
        ip,
        startDate,
        endDate,
        req.user.company
      );

      res.json({
        success: true,
        message: `Force sync completed for machine ${ip}`,
        result,
      });
    } catch (error) {
      console.error("❌ Failed to force sync date range:", error);
      res.status(500).json({
        success: false,
        message: "Failed to force sync date range",
        error: error.message,
      });
    }
  }
);

// Get sync status for all machines
router.get("/sync/status", authenticateToken, async (req, res) => {
  try {
    const status = incrementalAttendanceSyncService.getSyncStatus();

    // Add database statistics with proper date formatting
    const dbStats = {};
    for (const machineIp of status.connectedMachines) {
      try {
        const count = await AttendanceLog.countDocuments({ machineIp });
        const latest = await AttendanceLog.findOne({ machineIp })
          .sort({ timestamp: -1 })
          .select("timestamp")
          .lean();
        const oldest = await AttendanceLog.findOne({ machineIp })
          .sort({ timestamp: 1 })
          .select("timestamp")
          .lean();

        dbStats[machineIp] = {
          totalLogs: count,
          latestLogTime: latest?.timestamp || null,
          latestLogTimeFormatted: latest?.timestamp ? new Date(latest.timestamp).toISOString() : "No logs",
          oldestLogTime: oldest?.timestamp || null,
          oldestLogTimeFormatted: oldest?.timestamp ? new Date(oldest.timestamp).toISOString() : "No logs",
        };
      } catch (error) {
        dbStats[machineIp] = { error: error.message };
      }
    }

    // Format lastSyncTimes properly
    const formattedStatus = {
      ...status,
      lastSyncTimesFormatted: {}
    };
    
    for (const [machineIp, lastSync] of Object.entries(status.lastSyncTimes)) {
      formattedStatus.lastSyncTimesFormatted[machineIp] = lastSync ? new Date(lastSync).toISOString() : "Never synced";
    }

    res.json({
      success: true,
      syncStatus: formattedStatus,
      databaseStats: dbStats,
      note: "Sync status shows when data was last synchronized from devices to database",
    });
  } catch (error) {
    console.error("❌ Failed to get sync status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get sync status",
      error: error.message,
    });
  }
});

// Start automatic scheduled sync (every 6 hours)
router.post(
  "/sync/schedule/start",
  authenticateToken,
  authorizeRoles("admin"),
  (req, res) => {
    try {
      incrementalAttendanceSyncService.startScheduledSync();

      res.json({
        success: true,
        message: "Scheduled attendance sync started (every 6 hours)",
        schedule: "Every 6 hours",
        note: "Attendance data will be automatically synchronized from devices to database",
      });
    } catch (error) {
      console.error("❌ Failed to start scheduled sync:", error);
      res.status(500).json({
        success: false,
        message: "Failed to start scheduled sync",
        error: error.message,
      });
    }
  }
);

// Stop automatic scheduled sync
router.post(
  "/sync/schedule/stop",
  authenticateToken,
  authorizeRoles("admin"),
  (req, res) => {
    try {
      incrementalAttendanceSyncService.stopScheduledSync();

      res.json({
        success: true,
        message: "Scheduled attendance sync stopped",
        note: "Manual sync can still be triggered via API endpoints",
      });
    } catch (error) {
      console.error("❌ Failed to stop scheduled sync:", error);
      res.status(500).json({
        success: false,
        message: "Failed to stop scheduled sync",
        error: error.message,
      });
    }
  }
);

// Get attendance summary/statistics from database
router.get("/summary/:ip", authenticateToken, async (req, res) => {
  try {
    const { ip } = req.params;
    const { startDate, endDate } = req.query;

    // Validate required parameters
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message:
          "startDate and endDate query parameters are required (YYYY-MM-DD format)",
      });
    }

    console.log(
      `📈 Generating attendance summary for machine ${ip} (${startDate} to ${endDate})`
    );

    // Get attendance statistics from database
    const pipeline = [
      {
        $match: {
          machineIp: ip,
          date: { $gte: startDate, $lte: endDate },
          ...(req.user.company && { company: req.user.company }),
        },
      },
      {
        $group: {
          _id: {
            employeeId: "$employeeId",
            date: "$date",
          },
          logs: { $push: "$$ROOT" },
          logCount: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: "$_id.employeeId",
          totalDays: { $sum: 1 },
          totalLogs: { $sum: "$logCount" },
          dailyBreakdown: {
            $push: {
              date: "$_id.date",
              logCount: "$logCount",
              logs: "$logs",
            },
          },
        },
      },
    ];

    const summary = await AttendanceLog.aggregate(pipeline);

    // Calculate overall statistics
    const totalEmployees = summary.length;
    const totalLogs = summary.reduce((sum, emp) => sum + emp.totalLogs, 0);
    const avgLogsPerEmployee =
      totalEmployees > 0 ? (totalLogs / totalEmployees).toFixed(2) : 0;

    res.json({
      success: true,
      summary: {
        totalEmployees,
        totalLogs,
        avgLogsPerEmployee,
        dateRange: { startDate, endDate },
        machineIp: ip,
        employeeBreakdown: summary,
      },
      generatedAt: new Date(),
      dataSource: "database",
    });
  } catch (error) {
    console.error("❌ Failed to generate attendance summary:", error);
    res.status(500).json({
      success: false,
      message: "Failed to generate attendance summary",
      error: error.message,
    });
  }
});

module.exports = router;
