const express = require('express');
const router = express.Router();
const AttendanceSyncService = require('../services/AttendanceSyncService');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

/**
 * POST /api/attendance-sync/manual/:ip
 * Trigger manual sync from device to database
 * Body: { companyId, startDate?, endDate? }
 */
router.post('/manual/:ip', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const { ip } = req.params;
  const { startDate, endDate } = req.body;

  // Get companyId from authenticated user
  const companyId = req.user.company;

  try {
    console.log(`\n=== Manual Sync Requested ===`);
    console.log(`Device: ${ip}`);
    console.log(`Company: ${companyId}`);
    console.log(`Date Range: ${startDate || 'all'} to ${endDate || 'now'}`);

    const result = await AttendanceSyncService.syncAttendanceLogs(ip, companyId, {
      startDate,
      endDate,
      force: true
    });

    res.json({
      success: true,
      message: 'Sync completed successfully',
      ...result
    });

  } catch (error) {
    console.error('Manual sync failed:', error);
    res.status(500).json({
      success: false,
      message: `Sync failed: ${error.message}`,
      error: error.message
    });
  }
});

/**
 * POST /api/attendance-sync/incremental/:ip
 * Incremental sync - only fetch new records since last sync
 */
router.post('/incremental/:ip', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const { ip } = req.params;

  // Get companyId from authenticated user
  const companyId = req.user.company;

  try {
    console.log(`\n=== Incremental Sync Requested ===`);
    console.log(`Device: ${ip}`);
    console.log(`Company: ${companyId}`);

    const result = await AttendanceSyncService.incrementalSync(ip, companyId);

    res.json({
      success: true,
      message: 'Incremental sync completed',
      ...result
    });

  } catch (error) {
    console.error('Incremental sync failed:', error);
    res.status(500).json({
      success: false,
      message: `Incremental sync failed: ${error.message}`,
      error: error.message
    });
  }
});

/**
 * GET /api/attendance-sync/from-database/:ip?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Query attendance logs from database (NOT from device) - FAST
 * This is what frontend should use for attendance reports
 */
router.get('/from-database/:ip', authenticateToken, async (req, res) => {
  const { ip } = req.params;
  const { startDate, endDate } = req.query;

  // Get companyId from authenticated user
  const companyId = req.user.company;

  try {
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate are required'
      });
    }

    console.log(`Querying database: ${ip}, ${startDate} to ${endDate}`);

    const logs = await AttendanceSyncService.getAttendanceFromDatabase(
      ip,
      companyId,
      startDate,
      endDate
    );

    res.json({
      success: true,
      attendance: logs,
      count: logs.length,
      source: 'database',
      machineIp: ip,
      startDate,
      endDate,
      queriedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Database query failed:', error);
    res.status(500).json({
      success: false,
      message: `Failed to query database: ${error.message}`,
      error: error.message
    });
  }
});

/**
 * GET /api/attendance-sync/status/:ip
 * Get sync statistics and last sync time
 */
router.get('/status/:ip', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const { ip } = req.params;

  // Get companyId from authenticated user
  const companyId = req.user.company;

  try {
    const stats = await AttendanceSyncService.getSyncStats(ip, companyId);

    res.json({
      success: true,
      ...stats
    });

  } catch (error) {
    console.error('Failed to get sync stats:', error);
    res.status(500).json({
      success: false,
      message: `Failed to get sync status: ${error.message}`,
      error: error.message
    });
  }
});

module.exports = router;