const express = require('express');
const router = express.Router();
const NodeZKLib = require('node-zklib');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

// Get attendance statistics and date ranges
router.get('/stats/:ip', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  let zkInstance = null;

  try {
    const { ip } = req.params;
    const devicePort = parseInt(req.query.port) || 4370; // Allow port override via query param

    console.log(`Analyzing attendance data for ${ip}:${devicePort}...`);
    // Generate random local port to avoid EADDRINUSE errors (wider range)
    const randomInport = 5000 + Math.floor(Math.random() * 5000); // Range: 5000-9999
    zkInstance = new NodeZKLib(ip, devicePort, 10000, randomInport);
    await zkInstance.createSocket();

    // Get device info
    let deviceInfo = {};
    try {
      deviceInfo = await zkInstance.getInfo();
    } catch (e) {
      deviceInfo = { error: 'Could not fetch device info' };
    }

    // Fetch all logs
    const response = await zkInstance.getAttendances();
    const logs = response.data || [];

    // Analyze
    const yearCounts = {};
    const monthCounts = {};
    let oldestDate = null;
    let newestDate = null;
    let invalidCount = 0;

    logs.forEach(log => {
      const date = new Date(log.recordTime || log.timestamp);
      const year = date.getFullYear();

      // Count invalid dates (year 2000 or before 2010)
      if (year < 2010) {
        invalidCount++;
      }

      if (!oldestDate || date < oldestDate) oldestDate = date;
      if (!newestDate || date > newestDate) newestDate = date;

      yearCounts[year] = (yearCounts[year] || 0) + 1;

      const month = `${year}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      monthCounts[month] = (monthCounts[month] || 0) + 1;
    });

    await zkInstance.disconnect();

    res.json({
      success: true,
      machineIp: ip,
      deviceInfo,
      summary: {
        totalRecords: logs.length,
        invalidRecords: invalidCount,
        validRecords: logs.length - invalidCount,
        oldestRecord: oldestDate,
        newestRecord: newestDate
      },
      byYear: yearCounts,
      recentMonths: Object.keys(monthCounts)
        .sort()
        .reverse()
        .slice(0, 12)
        .reduce((acc, month) => {
          acc[month] = monthCounts[month];
          return acc;
        }, {}),
      recommendations: [
        invalidCount > 0 ? `Clear ${invalidCount} invalid records (year < 2010)` : null,
        logs.length > 50000 ? 'Device has >50k logs, consider archiving old data' : null,
        newestDate && (new Date() - newestDate) > 30 * 24 * 60 * 60 * 1000
          ? 'No recent attendance (>30 days old), check device operation'
          : null
      ].filter(Boolean)
    });

  } catch (error) {
    console.error('Failed to analyze attendance:', error.message);

    if (zkInstance) {
      try {
        await zkInstance.disconnect();
      } catch (e) {
        // Ignore
      }
    }

    res.status(500).json({
      success: false,
      message: error.message,
      error: 'Failed to analyze attendance data'
    });
  }
});

// Clear attendance logs from device
router.post('/clear/:ip', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  let zkInstance = null;

  try {
    const { ip } = req.params;
    const { confirmClear } = req.body;
    const devicePort = parseInt(req.body.port || req.query.port) || 4370; // Allow port override

    if (!confirmClear) {
      return res.status(400).json({
        success: false,
        message: 'Please confirm by sending confirmClear: true in request body'
      });
    }

    console.log(`⚠️  Clearing ALL attendance logs from ${ip}:${devicePort}...`);
    // Generate random local port to avoid EADDRINUSE errors (wider range)
    const randomInport = 5000 + Math.floor(Math.random() * 5000); // Range: 5000-9999
    zkInstance = new NodeZKLib(ip, devicePort, 10000, randomInport);
    await zkInstance.createSocket();

    // Clear logs
    await zkInstance.clearAttendanceLog();

    await zkInstance.disconnect();

    console.log(`✅ Attendance logs cleared from ${ip}`);

    res.json({
      success: true,
      message: 'All attendance logs have been cleared from device',
      machineIp: ip,
      clearedAt: new Date().toISOString(),
      warning: 'This action cannot be undone. Logs are permanently deleted from device.'
    });

  } catch (error) {
    console.error('Failed to clear attendance logs:', error.message);

    if (zkInstance) {
      try {
        await zkInstance.disconnect();
      } catch (e) {
        // Ignore
      }
    }

    res.status(500).json({
      success: false,
      message: error.message,
      error: 'Failed to clear attendance logs'
    });
  }
});

module.exports = router;