const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");

/**
 * 🏆 MACHINE-BASED EMPLOYEE PERFORMANCE DASHBOARD
 * Focus: Employees from biometric machines + their attendance data
 * Data Source: Machine employees + attendancelogs collection
 */

// Get Machine Employee Leaderboard
router.get(
  "/machine-leaderboard/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;
      const { startDate, endDate, limit = 10 } = req.query;
      const companyId = req.user.company;

      // Default to last 2 months if no date range provided
      const defaultEndDate = new Date().toISOString().split("T")[0];
      const defaultStartDate = new Date();
      defaultStartDate.setMonth(defaultStartDate.getMonth() - 2);
      const defaultStartDateStr = defaultStartDate.toISOString().split("T")[0];

      const queryStartDate = startDate || defaultStartDateStr;
      const queryEndDate = endDate || defaultEndDate;

      console.log(
        `🏆 Generating machine employee leaderboard for ${ip} (${queryStartDate} to ${queryEndDate})`
      );

      // Step 1: Get employees from machine (simulated - normally would call machine API)
      // For now, we'll get unique employees from attendancelogs for this machine
      const attendanceCollection =
        mongoose.connection.db.collection("attendancelogs");

      // Get unique employees who have records in this machine
      const uniqueEmployees = await attendanceCollection.distinct("id", {
        machineIp: ip,
        timestamp: {
          $gte: new Date(queryStartDate + "T00:00:00.000Z"),
          $lte: new Date(queryEndDate + "T23:59:59.999Z"),
        },
        ...(companyId && { company: companyId }),
      });

      if (uniqueEmployees.length === 0) {
        return res.json({
          success: true,
          leaderboard: [],
          message: `No employees found for machine ${ip} in the specified date range`,
          machineIP: ip,
          totalEmployees: 0,
          dateRange: { from: queryStartDate, to: queryEndDate },
        });
      }

      console.log(
        `📊 Found ${uniqueEmployees.length} employees in machine ${ip} logs`
      );

      // Step 2: Analyze performance for each machine employee
      const leaderboardData = [];

      for (const employeeId of uniqueEmployees) {
        try {
          // Get attendance logs for this employee from this machine
          const attendanceLogs = await attendanceCollection
            .find({
              machineIp: ip,
              id: employeeId,
              timestamp: {
                $gte: new Date(queryStartDate + "T00:00:00.000Z"),
                $lte: new Date(queryEndDate + "T23:59:59.999Z"),
              },
              ...(companyId && { company: companyId }),
            })
            .toArray();

          // Calculate working days in the range
          const totalWorkingDays = calculateWorkingDays(
            queryStartDate,
            queryEndDate
          );

          // Group logs by date and calculate metrics
          const logsByDate = {};
          let totalLateMinutes = 0;
          let lateDays = 0;

          attendanceLogs.forEach((log) => {
            const date = log.timestamp.toISOString().split("T")[0];
            const dayOfWeek = new Date(date).getDay();

            // Only count working days (Monday to Friday)
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
              if (!logsByDate[date]) {
                logsByDate[date] = [];
              }
              logsByDate[date].push(log);

              // Calculate late time (assuming 9:00 AM cutoff)
              const logTime = new Date(log.timestamp);
              const cutoffTime = new Date(logTime);
              cutoffTime.setHours(9, 0, 0, 0);

              if (logTime > cutoffTime) {
                const lateMinutes = Math.floor(
                  (logTime - cutoffTime) / (1000 * 60)
                );
                totalLateMinutes += lateMinutes;
                if (!logsByDate[date].hasLateMarked) {
                  lateDays++;
                  logsByDate[date].hasLateMarked = true;
                }
              }
            }
          });

          const presentDays = Object.keys(logsByDate).length;
          const absentDays = Math.max(0, totalWorkingDays - presentDays);
          const attendanceRate =
            totalWorkingDays > 0 ? (presentDays / totalWorkingDays) * 100 : 0;
          const avgLateMinutes =
            lateDays > 0 ? Math.round(totalLateMinutes / lateDays) : 0;

          // Calculate performance score
          const attendanceScore = attendanceRate;
          const punctualityScore = Math.max(0, 100 - totalLateMinutes / 10);
          const consistencyScore = Math.max(0, 100 - absentDays * 15);

          const finalScore =
            attendanceScore * 0.6 +
            punctualityScore * 0.25 +
            consistencyScore * 0.15;

          // Assign performance level
          let performanceLevel = "critical";
          if (attendanceRate >= 95) performanceLevel = "star";
          else if (attendanceRate >= 90) performanceLevel = "excellent";
          else if (attendanceRate >= 80) performanceLevel = "good";
          else if (attendanceRate >= 70) performanceLevel = "poor";

          // Assign badges based on machine performance
          const badges = [];
          if (absentDays === 0) badges.push("PERFECT_ATTENDANCE");
          if (avgLateMinutes <= 5) badges.push("PUNCTUALITY_CHAMPION");
          if (attendanceRate >= 95) badges.push("MACHINE_STAR");
          if (lateDays === 0) badges.push("NEVER_LATE");

          // Get employee name from recent log (fallback)
          const recentLog = attendanceLogs[0];
          const employeeName = recentLog?.name || `Employee ${employeeId}`;

          leaderboardData.push({
            machineEmployee: {
              employeeId: employeeId,
              name: employeeName,
              machineId: recentLog?.uid || employeeId,
              machineIP: ip,
              department: "Unknown", // Machine doesn't provide department
              lastSeen: recentLog?.timestamp,
            },
            performance: {
              attendanceRate: Math.round(attendanceRate * 10) / 10,
              presentDays,
              totalWorkingDays,
              absentDays,
              lateDays,
              totalLateMinutes,
              avgLateMinutes,
              finalScore: Math.round(finalScore * 10) / 10,
              performanceLevel,
              badges,
              breakdown: {
                attendanceScore: Math.round(attendanceScore * 10) / 10,
                punctualityScore: Math.round(punctualityScore * 10) / 10,
                consistencyScore: Math.round(consistencyScore * 10) / 10,
              },
            },
            machineData: {
              totalRecords: attendanceLogs.length,
              firstRecord: attendanceLogs[attendanceLogs.length - 1]?.timestamp,
              lastRecord: attendanceLogs[0]?.timestamp,
            },
          });
        } catch (error) {
          console.error(
            `❌ Error analyzing machine employee ${employeeId}:`,
            error
          );
          // Continue with other employees
        }
      }

      // Sort by final score (descending)
      leaderboardData.sort(
        (a, b) => b.performance.finalScore - a.performance.finalScore
      );

      // Add ranks and limit results
      const rankedLeaderboard = leaderboardData
        .slice(0, parseInt(limit))
        .map((item, index) => ({
          rank: index + 1,
          ...item,
        }));

      console.log(
        `✅ Generated machine leaderboard with ${rankedLeaderboard.length} employees`
      );

      res.json({
        success: true,
        leaderboard: rankedLeaderboard,
        machineIP: ip,
        dateRange: { from: queryStartDate, to: queryEndDate },
        totalEmployees: uniqueEmployees.length,
        analyzedEmployees: leaderboardData.length,
        machineStats: {
          connectedEmployees: uniqueEmployees.length,
          totalRecords: attendanceLogs.length,
          dateRange: { from: queryStartDate, to: queryEndDate },
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        "❌ Machine employee leaderboard generation failed:",
        error
      );
      res.status(500).json({
        success: false,
        message: "Failed to generate machine employee leaderboard",
        error: error.message,
        machineIP: req.params.ip,
      });
    }
  }
);

// Get Machine Analytics Dashboard
router.get(
  "/machine-analytics/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;
      const { startDate, endDate } = req.query;
      const companyId = req.user.company;

      // Default to last 2 months if no date range provided
      const defaultEndDate = new Date().toISOString().split("T")[0];
      const defaultStartDate = new Date();
      defaultStartDate.setMonth(defaultStartDate.getMonth() - 2);
      const defaultStartDateStr = defaultStartDate.toISOString().split("T")[0];

      const queryStartDate = startDate || defaultStartDateStr;
      const queryEndDate = endDate || defaultEndDate;

      console.log(
        `📊 Generating machine analytics for ${ip} (${queryStartDate} to ${queryEndDate})`
      );

      const attendanceCollection =
        mongoose.connection.db.collection("attendancelogs");

      // Get machine statistics
      const machineStats = await attendanceCollection
        .aggregate([
          {
            $match: {
              machineIp: ip,
              timestamp: {
                $gte: new Date(queryStartDate + "T00:00:00.000Z"),
                $lte: new Date(queryEndDate + "T23:59:59.999Z"),
              },
              ...(companyId && { company: companyId }),
            },
          },
          {
            $group: {
              _id: null,
              totalRecords: { $sum: 1 },
              uniqueEmployees: { $addToSet: "$id" },
              avgRecordsPerDay: { $avg: 1 },
              oldestRecord: { $min: "$timestamp" },
              newestRecord: { $max: "$timestamp" },
            },
          },
        ])
        .toArray();

      // Get daily attendance patterns
      const dailyPatterns = await attendanceCollection
        .aggregate([
          {
            $match: {
              machineIp: ip,
              timestamp: {
                $gte: new Date(queryStartDate + "T00:00:00.000Z"),
                $lte: new Date(queryEndDate + "T23:59:59.999Z"),
              },
              ...(companyId && { company: companyId }),
            },
          },
          {
            $group: {
              _id: {
                date: {
                  $dateToString: { format: "%Y-%m-%d", date: "$timestamp" },
                },
                hour: { $hour: "$timestamp" },
              },
              count: { $sum: 1 },
              uniqueEmployees: { $addToSet: "$id" },
            },
          },
          {
            $group: {
              _id: "$_id.date",
              hourlyBreakdown: {
                $push: {
                  hour: "$_id.hour",
                  records: "$count",
                  employees: { $size: "$uniqueEmployees" },
                },
              },
              totalRecords: { $sum: "$count" },
              uniqueEmployees: { $addToSet: "$uniqueEmployees" },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray();

      // Get performance distribution
      const performanceDistribution = {
        starPerformers: 0,
        excellent: 0,
        good: 0,
        needsImprovement: 0,
      };

      const analytics = {
        machineIP: ip,
        dateRange: { from: queryStartDate, to: queryEndDate },
        statistics: machineStats[0] || {
          totalRecords: 0,
          uniqueEmployees: [],
          avgRecordsPerDay: 0,
          oldestRecord: null,
          newestRecord: null,
        },
        dailyPatterns: dailyPatterns,
        performanceDistribution,
        workingDays: calculateWorkingDays(queryStartDate, queryEndDate),
        machineHealth: {
          isActive: machineStats[0]?.totalRecords > 0,
          lastActivity: machineStats[0]?.newestRecord,
          dataQuality: machineStats[0]?.totalRecords > 100 ? "Good" : "Limited",
        },
      };

      // Calculate unique employee count
      analytics.statistics.uniqueEmployeeCount =
        analytics.statistics.uniqueEmployees?.length || 0;

      console.log(
        `✅ Generated machine analytics: ${analytics.statistics.totalRecords} records, ${analytics.statistics.uniqueEmployeeCount} employees`
      );

      res.json({
        success: true,
        analytics,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Machine analytics generation failed:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate machine analytics",
        error: error.message,
        machineIP: req.params.ip,
      });
    }
  }
);

// Get Complete Machine Dashboard
router.get(
  "/machine-dashboard/:ip",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { ip } = req.params;
      const { startDate, endDate } = req.query;

      console.log(`🎯 Generating complete machine dashboard for ${ip}`);

      // For now, we'll create a simplified dashboard without internal API calls
      // Get basic machine data directly
      const attendanceCollection =
        mongoose.connection.db.collection("attendancelogs");

      // Get basic stats
      const basicStats = await attendanceCollection
        .aggregate([
          {
            $match: {
              machineIp: ip,
              timestamp: {
                $gte: new Date(
                  (startDate ||
                    new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
                      .toISOString()
                      .split("T")[0]) + "T00:00:00.000Z"
                ),
                $lte: new Date(
                  (endDate || new Date().toISOString().split("T")[0]) +
                    "T23:59:59.999Z"
                ),
              },
            },
          },
          {
            $group: {
              _id: null,
              totalRecords: { $sum: 1 },
              uniqueEmployees: { $addToSet: "$id" },
              newestRecord: { $max: "$timestamp" },
            },
          },
        ])
        .toArray();

      const stats = basicStats[0] || {
        totalRecords: 0,
        uniqueEmployees: [],
        newestRecord: null,
      };

      const dashboard = {
        machineIP: ip,
        connectionStatus: "unknown", // Will be determined by frontend
        topPerformers: [], // Will be populated by separate API call
        analytics: {},
        summary: {
          totalEmployees: stats.uniqueEmployees.length,
          totalRecords: stats.totalRecords,
          avgAttendanceRate: 0,
          lastActivity: stats.newestRecord,
          dataQuality: stats.totalRecords > 100 ? "Good" : "Limited",
        },
        dateRange: {
          from:
            startDate ||
            new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
              .toISOString()
              .split("T")[0],
          to: endDate || new Date().toISOString().split("T")[0],
        },
      };

      console.log(`✅ Generated complete machine dashboard for ${ip}`);

      res.json({
        success: true,
        dashboard,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Machine dashboard generation failed:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate machine dashboard",
        error: error.message,
        machineIP: req.params.ip,
      });
    }
  }
);

/**
 * Helper function to calculate working days between two dates
 * Excludes weekends (Saturday = 6, Sunday = 0)
 */
function calculateWorkingDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let workingDays = 0;

  const currentDate = new Date(start);
  while (currentDate <= end) {
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      // Not Sunday (0) or Saturday (6)
      workingDays++;
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return workingDays;
}

module.exports = router;
