const express = require("express");
const mongoose = require("mongoose");
const { authenticateToken } = require("../middleware/auth");
const router = express.Router();

/**
 * SIMPLE Machine Performance Dashboard
 * Uses REAL attendance data structure: uid, state, timestamp, id
 */

// Helper function to calculate working days
function getWorkingDays(startDate, endDate) {
  let count = 0;
  const start = new Date(startDate);
  const end = new Date(endDate);

  while (start <= end) {
    const dayOfWeek = start.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      // Exclude weekends
      count++;
    }
    start.setDate(start.getDate() + 1);
  }

  return count;
}

// Get simple performance analysis for real data
router.get("/simple-leaderboard", authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, limit = 10 } = req.query;

    // Default to last 30 days if no dates provided
    const defaultEndDate = new Date();
    const defaultStartDate = new Date();
    defaultStartDate.setDate(defaultStartDate.getDate() - 30);

    const queryStartDate = startDate ? new Date(startDate) : defaultStartDate;
    const queryEndDate = endDate ? new Date(endDate) : defaultEndDate;

    console.log("🔍 Simple Leaderboard Query:", {
      queryStartDate,
      queryEndDate,
      limit,
    });

    const attendanceCollection =
      mongoose.connection.db.collection("attendancelogs");

    // Get employee performance data
    const employeeStats = await attendanceCollection
      .aggregate([
        {
          $match: {
            timestamp: {
              $gte: queryStartDate,
              $lte: queryEndDate,
            },
          },
        },
        {
          $group: {
            _id: "$uid",
            totalRecords: { $sum: 1 },
            firstRecord: { $min: "$timestamp" },
            lastRecord: { $max: "$timestamp" },
            states: { $addToSet: "$state" },
            // Count different attendance types
            checkIns: {
              $sum: {
                $cond: [{ $in: ["$state", [1, 4]] }, 1, 0], // States 1,4 = check in
              },
            },
            checkOuts: {
              $sum: {
                $cond: [{ $in: ["$state", [2, 3]] }, 1, 0], // States 2,3 = check out
              },
            },
            // Calculate daily presence (days with at least one record)
            allDates: {
              $addToSet: {
                $dateToString: { format: "%Y-%m-%d", date: "$timestamp" },
              },
            },
          },
        },
        {
          $addFields: {
            uniqueDaysPresent: { $size: "$allDates" },
            avgRecordsPerDay: {
              $divide: ["$totalRecords", { $size: "$allDates" }],
            },
          },
        },
        {
          $sort: { totalRecords: -1 },
        },
        {
          $limit: parseInt(limit),
        },
      ])
      .toArray();

    console.log(`📊 Found ${employeeStats.length} employees with data`);

    // Calculate working days in period
    const totalWorkingDays = getWorkingDays(queryStartDate, queryEndDate);

    // Create leaderboard with performance metrics
    const leaderboard = employeeStats.map((empStat, index) => {
      const attendanceRate = Math.round(
        (empStat.uniqueDaysPresent / totalWorkingDays) * 100
      );
      const absentDays = Math.max(
        0,
        totalWorkingDays - empStat.uniqueDaysPresent
      );

      // Simple performance scoring
      let performanceLevel = "poor";
      let badges = [];

      if (attendanceRate >= 95) {
        performanceLevel = "excellent";
        badges.push("PERFECT_ATTENDANCE");
      } else if (attendanceRate >= 85) {
        performanceLevel = "good";
        badges.push("REGULAR_ATTENDEE");
      } else if (attendanceRate >= 70) {
        performanceLevel = "average";
      }

      if (empStat.avgRecordsPerDay >= 4) {
        badges.push("ACTIVE_USER");
      }

      if (empStat.checkIns > 0 && empStat.checkOuts > 0) {
        badges.push("COMPLETE_CYCLES");
      }

      const finalScore = Math.round(
        attendanceRate * 0.7 + Math.min(empStat.avgRecordsPerDay * 5, 30) * 0.3
      );

      return {
        rank: index + 1,
        employee: {
          uid: empStat._id,
          name: `Employee ${empStat._id}`, // You can map this to real names later
          id: empStat._id,
        },
        performance: {
          attendanceRate,
          presentDays: empStat.uniqueDaysPresent,
          totalWorkingDays,
          absentDays,
          totalRecords: empStat.totalRecords,
          avgRecordsPerDay: Math.round(empStat.avgRecordsPerDay * 10) / 10,
          checkIns: empStat.checkIns,
          checkOuts: empStat.checkOuts,
          finalScore,
          performanceLevel,
          badges,
          states: empStat.states,
        },
        dataInfo: {
          totalRecords: empStat.totalRecords,
          firstRecord: empStat.firstRecord,
          lastRecord: empStat.lastRecord,
          dateRange: {
            from: queryStartDate,
            to: queryEndDate,
            days: totalWorkingDays,
          },
        },
      };
    });

    res.json({
      success: true,
      data: {
        leaderboard,
        summary: {
          totalEmployees: employeeStats.length,
          dateRange: {
            from: queryStartDate,
            to: queryEndDate,
            workingDays: totalWorkingDays,
          },
          totalRecordsAnalyzed: employeeStats.reduce(
            (sum, emp) => sum + emp.totalRecords,
            0
          ),
        },
      },
    });
  } catch (error) {
    console.error("❌ Simple leaderboard error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch attendance performance",
      error: error.message,
    });
  }
});

// Get overall attendance statistics
router.get("/simple-stats", authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const defaultEndDate = new Date();
    const defaultStartDate = new Date();
    defaultStartDate.setDate(defaultStartDate.getDate() - 30);

    const queryStartDate = startDate ? new Date(startDate) : defaultStartDate;
    const queryEndDate = endDate ? new Date(endDate) : defaultEndDate;

    const attendanceCollection =
      mongoose.connection.db.collection("attendancelogs");

    // Overall statistics
    const totalRecords = await attendanceCollection.countDocuments({
      timestamp: { $gte: queryStartDate, $lte: queryEndDate },
    });

    const uniqueEmployees = await attendanceCollection.distinct("uid", {
      timestamp: { $gte: queryStartDate, $lte: queryEndDate },
    });

    const stateDistribution = await attendanceCollection
      .aggregate([
        {
          $match: {
            timestamp: { $gte: queryStartDate, $lte: queryEndDate },
          },
        },
        {
          $group: {
            _id: "$state",
            count: { $sum: 1 },
          },
        },
        {
          $sort: { _id: 1 },
        },
      ])
      .toArray();

    const workingDays = getWorkingDays(queryStartDate, queryEndDate);
    const avgRecordsPerDay = totalRecords / Math.max(1, workingDays);

    res.json({
      success: true,
      data: {
        totalRecords,
        uniqueEmployeeCount: uniqueEmployees.length,
        workingDays,
        avgRecordsPerDay: Math.round(avgRecordsPerDay * 10) / 10,
        stateDistribution,
        dateRange: {
          from: queryStartDate,
          to: queryEndDate,
        },
      },
    });
  } catch (error) {
    console.error("❌ Simple stats error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch attendance statistics",
      error: error.message,
    });
  }
});

module.exports = router;
