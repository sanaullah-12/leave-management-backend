const express = require('express');
const router = express.Router();
const BiometricService = require('../services/BiometricService');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// Generate attendance report with work time, late time, absent days
router.get('/report/:ip', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  let biometricService = null;

  try {
    const { ip } = req.params;
    const { startDate, endDate, workStartTime = '09:00', lateThreshold = 15 } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate are required'
      });
    }

    console.log(`📊 Generating attendance report for ${ip} from ${startDate} to ${endDate}`);

    // Create fresh connection
    biometricService = new BiometricService(ip, 4370);
    await biometricService.connect();

    // Get attendance logs
    const logs = await biometricService.getAttendanceLogs(startDate, endDate);

    // Disconnect immediately
    await biometricService.disconnect();

    // Process logs into employee reports
    const employeeData = {};
    const workStart = new Date(`2000-01-01T${workStartTime}:00`);

    logs.forEach(log => {
      const uid = log.uid;
      const timestamp = new Date(log.timestamp);
      const dateStr = timestamp.toISOString().split('T')[0];

      if (!employeeData[uid]) {
        employeeData[uid] = {
          employeeId: uid,
          name: `Employee ${uid}`,
          totalDays: 0,
          presentDays: 0,
          absentDays: 0,
          lateDays: 0,
          totalWorkMinutes: 0,
          totalLateMinutes: 0,
          dailyRecords: {}
        };
      }

      if (!employeeData[uid].dailyRecords[dateStr]) {
        employeeData[uid].dailyRecords[dateStr] = {
          date: dateStr,
          checkIn: null,
          checkOut: null,
          workMinutes: 0,
          lateMinutes: 0,
          isLate: false,
          status: 'present'
        };
      }

      const dayRecord = employeeData[uid].dailyRecords[dateStr];

      // Track first punch (check-in) and last punch (check-out)
      if (!dayRecord.checkIn || timestamp < new Date(dayRecord.checkIn)) {
        dayRecord.checkIn = timestamp.toISOString();

        // Calculate if late
        const checkInTime = new Date(`2000-01-01T${timestamp.toTimeString().split(' ')[0]}`);
        const lateMs = checkInTime - workStart;
        const lateMin = Math.floor(lateMs / (1000 * 60));

        if (lateMin > lateThreshold) {
          dayRecord.isLate = true;
          dayRecord.lateMinutes = lateMin - lateThreshold;
        }
      }

      if (!dayRecord.checkOut || timestamp > new Date(dayRecord.checkOut)) {
        dayRecord.checkOut = timestamp.toISOString();
      }
    });

    // Calculate totals and add absent days
    const start = new Date(startDate);
    const end = new Date(endDate);
    const totalWorkingDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;

    Object.values(employeeData).forEach(emp => {
      // Count present days and calculate work time
      Object.values(emp.dailyRecords).forEach(day => {
        if (day.checkIn && day.checkOut) {
          const checkIn = new Date(day.checkIn);
          const checkOut = new Date(day.checkOut);
          day.workMinutes = Math.floor((checkOut - checkIn) / (1000 * 60));
          emp.totalWorkMinutes += day.workMinutes;
        }

        if (day.isLate) {
          emp.lateDays++;
          emp.totalLateMinutes += day.lateMinutes;
        }
      });

      emp.presentDays = Object.keys(emp.dailyRecords).length;
      emp.totalDays = totalWorkingDays;
      emp.absentDays = totalWorkingDays - emp.presentDays;

      // Convert minutes to hours for readability
      emp.totalWorkHours = (emp.totalWorkMinutes / 60).toFixed(2);
      emp.totalLateHours = (emp.totalLateMinutes / 60).toFixed(2);
      emp.averageWorkHoursPerDay = emp.presentDays > 0
        ? (emp.totalWorkMinutes / emp.presentDays / 60).toFixed(2)
        : 0;

      // Convert daily records to array sorted by date
      emp.dailyRecords = Object.values(emp.dailyRecords).sort((a, b) =>
        new Date(a.date) - new Date(b.date)
      );

      // Format times for display
      emp.dailyRecords.forEach(day => {
        if (day.checkIn) {
          day.checkInTime = new Date(day.checkIn).toLocaleTimeString('en-US', { hour12: false });
        }
        if (day.checkOut) {
          day.checkOutTime = new Date(day.checkOut).toLocaleTimeString('en-US', { hour12: false });
        }
        day.workHours = (day.workMinutes / 60).toFixed(2);
        day.lateHours = (day.lateMinutes / 60).toFixed(2);
      });
    });

    const employees = Object.values(employeeData).sort((a, b) =>
      a.employeeId.localeCompare(b.employeeId)
    );

    res.json({
      success: true,
      reportPeriod: {
        startDate,
        endDate,
        totalWorkingDays
      },
      settings: {
        workStartTime,
        lateThreshold: `${lateThreshold} minutes`
      },
      summary: {
        totalEmployees: employees.length,
        totalAttendanceLogs: logs.length
      },
      employees,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Failed to generate attendance report:', error.message);

    if (biometricService) {
      try {
        await biometricService.disconnect();
      } catch (e) {
        // Ignore cleanup error
      }
    }

    res.status(500).json({
      success: false,
      message: error.message,
      error: 'Failed to generate attendance report'
    });
  }
});

module.exports = router;