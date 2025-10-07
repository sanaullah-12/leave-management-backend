const express = require("express");
const mongoose = require("mongoose");
const { authenticateToken } = require("../middleware/auth");
const ZKTecoService = require("../services/zktecoService");

const router = express.Router();

/**
 * REAL Machine Performance Dashboard
 * Step 1: Get users from machine
 * Step 2: Get their attendance from attendancelogs
 * Step 3: Calculate performance
 */

// Helper function to get working days between dates
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

// Get machine users with their performance
router.get(
  "/machine-users-performance/:ip",
  authenticateToken,
  async (req, res) => {
    try {
      const { ip } = req.params;
      const { startDate, endDate, limit = 10 } = req.query;

      console.log(`🔍 Fetching performance for machine ${ip}`);

      // Default to last 30 days
      const defaultEndDate = new Date();
      const defaultStartDate = new Date();
      defaultStartDate.setDate(defaultStartDate.getDate() - 30);

      const queryStartDate = startDate ? new Date(startDate) : defaultStartDate;
      const queryEndDate = endDate ? new Date(endDate) : defaultEndDate;

      // Step 1: Get users from machine
      console.log(`📋 Step 1: Getting users from machine ${ip}`);
      const zkService = new ZKTecoService(ip, 4370);
      await zkService.connect();
      const machineUsers = await zkService.getUsers();
      await zkService.disconnect();

      console.log(`👥 Found ${machineUsers.length} users in machine`);

      // Step 2: Get attendance data for these users
      console.log(`📊 Step 2: Getting attendance data`);
      const attendanceCollection =
        mongoose.connection.db.collection("attendancelogs");

      // Check which users have actual attendance data
      const usersWithData = [];

      for (const user of machineUsers) {
        const userId = user.userId || user.uid;
        const userAttendance = await attendanceCollection
          .find({
            uid: userId,
            timestamp: { $gte: queryStartDate, $lte: queryEndDate },
          })
          .sort({ timestamp: -1 })
          .toArray();

        if (userAttendance.length > 0) {
          usersWithData.push({ user, attendance: userAttendance });
          console.log(
            `✅ User ${user.name} (UID: ${userId}): ${userAttendance.length} records`
          );
        } else {
          console.log(
            `⚠️ User ${user.name} (UID: ${userId}): No records found`
          );
        }
      }

      // If no machine users have data, get users with actual attendance data
      if (usersWithData.length === 0) {
        console.log(
          `🔍 No machine users have attendance data. Getting users with actual data...`
        );

        const activeUIDs = await attendanceCollection.distinct("uid", {
          timestamp: { $gte: queryStartDate, $lte: queryEndDate },
        });

        console.log(`📊 Found active UIDs: ${activeUIDs}`);

        for (const uid of activeUIDs) {
          const userAttendance = await attendanceCollection
            .find({
              uid: uid,
              timestamp: { $gte: queryStartDate, $lte: queryEndDate },
            })
            .sort({ timestamp: -1 })
            .toArray();

          if (userAttendance.length > 0) {
            const virtualUser = {
              userId: uid,
              uid: uid,
              name: `Employee ${uid}`,
              role: 0,
              cardno: null,
            };

            usersWithData.push({
              user: virtualUser,
              attendance: userAttendance,
            });
            console.log(
              `✅ Virtual User ${uid}: ${userAttendance.length} records`
            );
          }
        }
      }

      console.log(
        `📈 Processing ${usersWithData.length} users with actual attendance data`
      );

      // Create performance array
      const performanceData = [];

      for (const { user, attendance: userAttendance } of usersWithData) {
        const userId = user.userId || user.uid;

        // Calculate performance metrics
        const uniqueDates = [
          ...new Set(
            userAttendance.map(
              (record) => record.timestamp.toISOString().split("T")[0]
            )
          ),
        ];

        const totalWorkingDays = getWorkingDays(queryStartDate, queryEndDate);
        const presentDays = uniqueDates.length;
        const absentDays = Math.max(0, totalWorkingDays - presentDays);
        const attendanceRate = Math.round(
          (presentDays / totalWorkingDays) * 100
        );

        // Count different states
        const stateCounts = {};
        userAttendance.forEach((record) => {
          stateCounts[record.state] = (stateCounts[record.state] || 0) + 1;
        });

        // Performance scoring
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

        if (userAttendance.length >= presentDays * 2) {
          badges.push("ACTIVE_USER");
        }

        const avgRecordsPerDay = userAttendance.length / presentDays;
        const finalScore = Math.round(
          attendanceRate * 0.7 + Math.min(avgRecordsPerDay * 10, 30) * 0.3
        );

        performanceData.push({
          user: {
            userId: userId,
            name: user.name,
            machineId: user.uid,
            role: user.role,
            cardNumber: user.cardno,
            department:
              user.role === 14
                ? "Admin"
                : user.role === 0
                ? "Employee"
                : `Role ${user.role}`,
          },
          performance: {
            attendanceRate,
            presentDays,
            totalWorkingDays,
            absentDays,
            totalRecords: userAttendance.length,
            avgRecordsPerDay: Math.round(avgRecordsPerDay * 10) / 10,
            stateCounts,
            finalScore,
            performanceLevel,
            badges,
            checkIns: stateCounts[1] || 0,
            checkOuts: stateCounts[0] || 0,
          },
          attendanceDetails: {
            firstRecord: userAttendance[userAttendance.length - 1]?.timestamp,
            lastRecord: userAttendance[0]?.timestamp,
            recentStates: userAttendance.slice(0, 5).map((r) => ({
              state: r.state,
              timestamp: r.timestamp,
            })),
          },
        });
      }

      // Sort by performance score
      performanceData.sort(
        (a, b) => b.performance.finalScore - a.performance.finalScore
      );

      // Add rankings
      const leaderboard = performanceData
        .slice(0, parseInt(limit))
        .map((entry, index) => ({
          rank: index + 1,
          ...entry,
        }));

      // Summary statistics
      const totalRecords = performanceData.reduce(
        (sum, entry) => sum + entry.performance.totalRecords,
        0
      );
      const activeUsers = performanceData.filter(
        (entry) => entry.performance.totalRecords > 0
      ).length;

      console.log(
        `✅ Performance analysis complete: ${leaderboard.length} users ranked`
      );

      res.json({
        success: true,
        data: {
          leaderboard,
          machineInfo: {
            ip,
            totalUsers: machineUsers.length,
            activeUsers,
            inactiveUsers: machineUsers.length - activeUsers,
          },
          summary: {
            dateRange: {
              from: queryStartDate,
              to: queryEndDate,
              workingDays: getWorkingDays(queryStartDate, queryEndDate),
            },
            totalRecords,
            avgRecordsPerUser:
              Math.round(
                (totalRecords / Math.max(performanceData.length, 1)) * 10
              ) / 10,
          },
        },
      });
    } catch (error) {
      console.error("❌ Machine users performance error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch machine users performance",
        error: error.message,
      });
    }
  }
);

// Get quick machine summary
router.get("/machine-summary/:ip", authenticateToken, async (req, res) => {
  try {
    const { ip } = req.params;

    // Get users from machine
    const zkService = new ZKTecoService(ip, 4370);
    await zkService.connect();
    const machineUsers = await zkService.getUsers();
    await zkService.disconnect();

    // Get total attendance records for this machine's users
    const attendanceCollection =
      mongoose.connection.db.collection("attendancelogs");
    const userIds = machineUsers.map((user) => user.userId || user.uid);

    const totalRecords = await attendanceCollection.countDocuments({
      uid: { $in: userIds },
    });

    // Get recent activity (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentRecords = await attendanceCollection.countDocuments({
      uid: { $in: userIds },
      timestamp: { $gte: sevenDaysAgo },
    });

    res.json({
      success: true,
      data: {
        machineIP: ip,
        totalUsers: machineUsers.length,
        totalAttendanceRecords: totalRecords,
        recentActivity: recentRecords,
        isActive: recentRecords > 0,
        lastAnalyzed: new Date(),
      },
    });
  } catch (error) {
    console.error("❌ Machine summary error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch machine summary",
      error: error.message,
    });
  }
});

module.exports = router;
