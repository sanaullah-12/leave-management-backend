const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const User = require("../models/User");

/**
 * 🏆 EMPLOYEE PERFORMANCE DASHBOARD API
 * Dedicated endpoints for employee-only performance tracking
 * Excludes admins and focuses on employee competition & analytics
 */

// Get Employee Leaderboard (Top performers ranking)
router.get(
  "/leaderboard",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
      const { startDate, endDate, limit = 10, department } = req.query;
      const companyId = req.user.company;

      // Default to last 2 months if no date range provided
      const defaultEndDate = new Date().toISOString().split("T")[0];
      const defaultStartDate = new Date();
      defaultStartDate.setMonth(defaultStartDate.getMonth() - 2);
      const defaultStartDateStr = defaultStartDate.toISOString().split("T")[0];

      const queryStartDate = startDate || defaultStartDateStr;
      const queryEndDate = endDate || defaultEndDate;

      console.log(
        `🏆 Generating employee leaderboard (${queryStartDate} to ${queryEndDate})`
      );

      // Get all employees (exclude admins)
      const employeeFilter = {
        role: "employee",
        status: "active",
        ...(companyId && { company: companyId }),
        ...(department && { department: department }),
      };

      const employees = await User.find(employeeFilter).select(
        "name employeeId email department position profilePicture joinDate"
      );

      if (employees.length === 0) {
        return res.json({
          success: true,
          leaderboard: [],
          message: "No employees found for the specified criteria",
          totalEmployees: 0,
          dateRange: { from: queryStartDate, to: queryEndDate },
        });
      }

      console.log(`📊 Found ${employees.length} employees to analyze`);

      // Get attendance collection
      const attendanceCollection =
        mongoose.connection.db.collection("attendancelogs");

      // Analyze performance for each employee
      const leaderboardData = [];

      for (const employee of employees) {
        try {
          // Get attendance logs for this employee
          const attendanceLogs = await attendanceCollection
            .find({
              id: employee.employeeId,
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

          // Group logs by date
          const logsByDate = {};
          let totalLateMinutes = 0;
          let lateDays = 0;

          attendanceLogs.forEach((log) => {
            const date = log.timestamp.toISOString().split("T")[0];
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
          });

          // Filter working days only
          const workingDaysWithRecords = Object.keys(logsByDate).filter(
            (date) => {
              const dayOfWeek = new Date(date).getDay();
              return dayOfWeek !== 0 && dayOfWeek !== 6; // Exclude weekends
            }
          );

          const presentDays = workingDaysWithRecords.length;
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

          // Assign badges
          const badges = [];
          if (absentDays === 0) badges.push("PERFECT_ATTENDANCE");
          if (avgLateMinutes <= 5) badges.push("PUNCTUALITY_KING");
          if (attendanceRate >= 95) badges.push("STAR_PERFORMER");
          if (lateDays === 0) badges.push("ZERO_LATE_DAYS");

          leaderboardData.push({
            employee: {
              _id: employee._id,
              name: employee.name,
              employeeId: employee.employeeId,
              department: employee.department,
              position: employee.position,
              profilePicture: employee.profilePicture,
              email: employee.email,
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
          });
        } catch (error) {
          console.error(`❌ Error analyzing employee ${employee.name}:`, error);
          // Continue with other employees
        }
      }

      // Sort by final score (descending)
      leaderboardData.sort(
        (a, b) => b.performance.finalScore - a.performance.finalScore
      );

      // Add ranks
      const rankedLeaderboard = leaderboardData
        .slice(0, parseInt(limit))
        .map((item, index) => ({
          rank: index + 1,
          ...item,
        }));

      console.log(
        `✅ Generated leaderboard with ${rankedLeaderboard.length} employees`
      );

      res.json({
        success: true,
        leaderboard: rankedLeaderboard,
        dateRange: { from: queryStartDate, to: queryEndDate },
        totalEmployees: employees.length,
        analyzedEmployees: leaderboardData.length,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Employee leaderboard generation failed:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate employee leaderboard",
        error: error.message,
      });
    }
  }
);

// Get Department Performance Comparison
router.get(
  "/department-performance",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
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
        `📊 Analyzing department performance (${queryStartDate} to ${queryEndDate})`
      );

      // Get all employees grouped by department
      const employeesByDepartment = await User.aggregate([
        {
          $match: {
            role: "employee",
            status: "active",
            department: { $exists: true, $ne: null, $ne: "" },
            ...(companyId && { company: companyId }),
          },
        },
        {
          $group: {
            _id: "$department",
            employees: {
              $push: {
                _id: "$_id",
                name: "$name",
                employeeId: "$employeeId",
                email: "$email",
              },
            },
            employeeCount: { $sum: 1 },
          },
        },
        { $sort: { employeeCount: -1 } },
      ]);

      if (employeesByDepartment.length === 0) {
        return res.json({
          success: true,
          departments: [],
          message: "No departments found with employees",
          dateRange: { from: queryStartDate, to: queryEndDate },
        });
      }

      const attendanceCollection =
        mongoose.connection.db.collection("attendancelogs");
      const departmentPerformance = [];

      for (const dept of employeesByDepartment) {
        const departmentName = dept._id;
        const employees = dept.employees;

        let totalAttendanceRate = 0;
        let totalPresentDays = 0;
        let totalWorkingDays = 0;
        let totalLateMinutes = 0;
        let topPerformer = null;
        let topPerformanceScore = 0;

        for (const employee of employees) {
          try {
            // Get attendance for this employee
            const attendanceLogs = await attendanceCollection
              .find({
                id: employee.employeeId,
                timestamp: {
                  $gte: new Date(queryStartDate + "T00:00:00.000Z"),
                  $lte: new Date(queryEndDate + "T23:59:59.999Z"),
                },
              })
              .toArray();

            const workingDays = calculateWorkingDays(
              queryStartDate,
              queryEndDate
            );
            const logsByDate = {};
            let lateMinutes = 0;

            attendanceLogs.forEach((log) => {
              const date = log.timestamp.toISOString().split("T")[0];
              const dayOfWeek = new Date(date).getDay();
              if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                // Working days only
                logsByDate[date] = true;
              }

              // Calculate late time
              const logTime = new Date(log.timestamp);
              const cutoffTime = new Date(logTime);
              cutoffTime.setHours(9, 0, 0, 0);
              if (logTime > cutoffTime) {
                lateMinutes += Math.floor((logTime - cutoffTime) / (1000 * 60));
              }
            });

            const presentDays = Object.keys(logsByDate).length;
            const attendanceRate =
              workingDays > 0 ? (presentDays / workingDays) * 100 : 0;

            // Track top performer
            if (attendanceRate > topPerformanceScore) {
              topPerformanceScore = attendanceRate;
              topPerformer = employee.name;
            }

            totalAttendanceRate += attendanceRate;
            totalPresentDays += presentDays;
            totalWorkingDays += workingDays;
            totalLateMinutes += lateMinutes;
          } catch (error) {
            console.error(
              `❌ Error analyzing employee ${employee.name} in ${departmentName}:`,
              error
            );
          }
        }

        const avgAttendanceRate =
          employees.length > 0 ? totalAttendanceRate / employees.length : 0;
        const avgLateMinutes =
          employees.length > 0 ? totalLateMinutes / employees.length : 0;

        departmentPerformance.push({
          name: departmentName,
          employeeCount: employees.length,
          avgAttendanceRate: Math.round(avgAttendanceRate * 10) / 10,
          totalPresentDays,
          totalWorkingDays,
          avgLateMinutes: Math.round(avgLateMinutes * 10) / 10,
          topPerformer,
          topPerformanceScore: Math.round(topPerformanceScore * 10) / 10,
        });
      }

      // Sort by average attendance rate (descending) and assign ranks
      departmentPerformance.sort(
        (a, b) => b.avgAttendanceRate - a.avgAttendanceRate
      );
      const rankedDepartments = departmentPerformance.map((dept, index) => ({
        ...dept,
        rank: index + 1,
      }));

      console.log(`✅ Analyzed ${rankedDepartments.length} departments`);

      res.json({
        success: true,
        departments: rankedDepartments,
        dateRange: { from: queryStartDate, to: queryEndDate },
        totalDepartments: rankedDepartments.length,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Department performance analysis failed:", error);
      res.status(500).json({
        success: false,
        message: "Failed to analyze department performance",
        error: error.message,
      });
    }
  }
);

// Get Employee Achievements and Badges
router.get(
  "/achievements",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
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
        `🎖️ Analyzing employee achievements (${queryStartDate} to ${queryEndDate})`
      );

      // Get leaderboard data to extract achievements
      const leaderboardResponse = await new Promise((resolve, reject) => {
        // Simulate internal API call to leaderboard
        req.query = {
          startDate: queryStartDate,
          endDate: queryEndDate,
          limit: 100,
        };

        // We'll use the same logic as leaderboard but extract achievements
        resolve({ success: true, leaderboard: [] }); // Placeholder for now
      });

      const achievements = {
        perfectAttendance: [],
        punctualityKing: null,
        mostImproved: null,
        consistencyChampion: null,
        starPerformers: [],
        topDepartment: null,
        zeroLateDays: [],
      };

      // This will be populated when we get actual leaderboard data
      // For now, return structure

      res.json({
        success: true,
        achievements,
        dateRange: { from: queryStartDate, to: queryEndDate },
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Employee achievements analysis failed:", error);
      res.status(500).json({
        success: false,
        message: "Failed to analyze employee achievements",
        error: error.message,
      });
    }
  }
);

// Get Performance Overview Stats
router.get(
  "/overview",
  authenticateToken,
  authorizeRoles("admin"),
  async (req, res) => {
    try {
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
        `📈 Generating performance overview (${queryStartDate} to ${queryEndDate})`
      );

      // Get total employee count
      const totalEmployees = await User.countDocuments({
        role: "employee",
        status: "active",
        ...(companyId && { company: companyId }),
      });

      // Get attendance collection for stats
      const attendanceCollection =
        mongoose.connection.db.collection("attendancelogs");

      const totalRecords = await attendanceCollection.countDocuments({
        timestamp: {
          $gte: new Date(queryStartDate + "T00:00:00.000Z"),
          $lte: new Date(queryEndDate + "T23:59:59.999Z"),
        },
        ...(companyId && { company: companyId }),
      });

      const overview = {
        totalEmployees,
        totalRecords,
        dateRange: { from: queryStartDate, to: queryEndDate },
        workingDays: calculateWorkingDays(queryStartDate, queryEndDate),
        categories: {
          starPerformers: 0, // 95%+
          excellent: 0, // 90-94%
          good: 0, // 80-89%
          needsImprovement: 0, // <80%
        },
      };

      console.log(
        `✅ Generated overview: ${totalEmployees} employees, ${totalRecords} records`
      );

      res.json({
        success: true,
        overview,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ Performance overview generation failed:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate performance overview",
        error: error.message,
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
