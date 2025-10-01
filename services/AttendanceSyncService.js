const BiometricService = require('./BiometricService');
const AttendanceLog = require('../models/AttendanceLog');

class AttendanceSyncService {
  /**
   * Sync attendance logs from ZKTeco device to database
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @param {object} options - Sync options
   * @returns {Promise<object>} Sync result
   */
  static async syncAttendanceLogs(deviceIp, companyId, options = {}) {
    const {
      startDate = null, // Optional: only sync from this date
      endDate = null,   // Optional: only sync until this date
      force = false      // Force full sync even if recently synced
    } = options;

    console.log(`\n${'='.repeat(70)}`);
    console.log(`ATTENDANCE SYNC: ${deviceIp} -> Database`);
    console.log(`${'='.repeat(70)}\n`);

    const biometricService = new BiometricService(deviceIp, 4370);
    const syncStartTime = Date.now();

    try {
      // Step 1: Connect to device
      console.log('Step 1: Connecting to device...');
      await biometricService.connect();
      console.log('✅ Connected\n');

      // Step 2: Fetch logs from device
      console.log('Step 2: Fetching attendance logs from device...');
      if (startDate || endDate) {
        console.log(`Date range: ${startDate || 'beginning'} to ${endDate || 'now'}`);
      } else {
        console.log('Fetching ALL logs');
      }

      const deviceLogs = await biometricService.getAttendanceLogs(startDate, endDate);
      console.log(`✅ Retrieved ${deviceLogs.length} logs from device\n`);

      // Step 3: Disconnect from device
      await biometricService.disconnect();
      console.log('✅ Disconnected from device\n');

      if (deviceLogs.length === 0) {
        console.log('No logs to sync');
        return {
          success: true,
          deviceIp,
          companyId,
          inserted: 0,
          skipped: 0,
          total: 0,
          duration: ((Date.now() - syncStartTime) / 1000).toFixed(2)
        };
      }

      // Step 4: Transform logs for database
      console.log('Step 3: Transforming logs for database...');
      const transformedLogs = deviceLogs.map(log => {
        const timestamp = new Date(log.timestamp);
        const date = timestamp.toISOString().split('T')[0];

        return {
          machineIp: deviceIp,
          employeeId: log.uid || 'unknown',
          machineUserId: log.uid || 'unknown',
          timestamp,
          date,
          type: log.type || 'unknown',
          mode: log.mode || 'unknown',
          rawData: log.rawData || log,
          company: companyId,
          syncedAt: new Date()
        };
      });

      console.log(`✅ Transformed ${transformedLogs.length} logs\n`);

      // Step 5: Bulk insert into database
      console.log('Step 4: Inserting logs into database...');
      const result = await AttendanceLog.bulkInsertLogs(transformedLogs);

      const duration = ((Date.now() - syncStartTime) / 1000).toFixed(2);

      console.log(`\n${'='.repeat(70)}`);
      console.log('SYNC COMPLETE');
      console.log(`${'='.repeat(70)}`);
      console.log(`✅ Inserted: ${result.inserted}`);
      console.log(`⏭️  Skipped (duplicates): ${result.skipped}`);
      console.log(`📊 Total: ${result.total}`);
      console.log(`⏱️  Duration: ${duration}s`);
      console.log(`${'='.repeat(70)}\n`);

      return {
        success: true,
        deviceIp,
        companyId,
        inserted: result.inserted,
        updated: result.updated || 0,
        skipped: result.skipped,
        total: result.total,
        duration,
        syncedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('\n❌ Sync failed:', error.message);

      // Ensure device is disconnected
      try {
        await biometricService.disconnect();
      } catch (e) {
        // Ignore
      }

      throw error;
    }
  }

  /**
   * Get attendance logs from database (not from device)
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @param {string} startDate - Start date (YYYY-MM-DD)
   * @param {string} endDate - End date (YYYY-MM-DD)
   * @returns {Promise<Array>} Attendance logs from database
   */
  static async getAttendanceFromDatabase(deviceIp, companyId, startDate, endDate) {
    console.log(`Querying database for attendance: ${deviceIp}, ${startDate} to ${endDate}`);

    const query = {
      machineIp: deviceIp,
      company: companyId,
      date: {
        $gte: startDate,
        $lte: endDate
      }
    };

    const logs = await AttendanceLog.find(query)
      .sort({ timestamp: 1 })
      .lean();

    console.log(`Found ${logs.length} logs in database`);

    return logs.map(log => ({
      uid: log.employeeId || log.machineUserId,
      timestamp: log.timestamp.toISOString(),
      date: log.date,
      type: log.type,
      mode: log.mode,
      ip: log.machineIp,
      rawData: log.rawData
    }));
  }

  /**
   * Get last sync time for a device
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @returns {Promise<Date|null>} Last sync timestamp
   */
  static async getLastSyncTime(deviceIp, companyId) {
    const lastLog = await AttendanceLog.findOne({
      machineIp: deviceIp,
      company: companyId
    })
    .sort({ timestamp: -1 })
    .select('timestamp syncedAt')
    .lean();

    return lastLog;
  }

  /**
   * Get sync statistics
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @returns {Promise<object>} Sync statistics
   */
  static async getSyncStats(deviceIp, companyId) {
    const query = { machineIp: deviceIp, company: companyId };

    const [totalLogs, lastSync, oldestLog, newestLog] = await Promise.all([
      AttendanceLog.countDocuments(query),
      AttendanceLog.findOne(query).sort({ syncedAt: -1 }).select('syncedAt').lean(),
      AttendanceLog.findOne(query).sort({ timestamp: 1 }).select('timestamp date').lean(),
      AttendanceLog.findOne(query).sort({ timestamp: -1 }).select('timestamp date').lean()
    ]);

    return {
      deviceIp,
      companyId,
      totalLogs,
      lastSyncTime: lastSync?.syncedAt || null,
      oldestRecord: oldestLog ? { timestamp: oldestLog.timestamp, date: oldestLog.date } : null,
      newestRecord: newestLog ? { timestamp: newestLog.timestamp, date: newestLog.date } : null
    };
  }

  /**
   * Incremental sync - only fetch new logs since last sync
   * @param {string} deviceIp - Device IP address
   * @param {string} companyId - Company MongoDB ID
   * @returns {Promise<object>} Sync result
   */
  static async incrementalSync(deviceIp, companyId) {
    const lastSync = await this.getLastSyncTime(deviceIp, companyId);

    let startDate = null;

    if (lastSync && lastSync.timestamp) {
      // Sync from last record date (overlap 1 day for safety)
      const lastDate = new Date(lastSync.timestamp);
      lastDate.setDate(lastDate.getDate() - 1); // Go back 1 day
      startDate = lastDate.toISOString().split('T')[0];
      console.log(`Incremental sync from ${startDate} (last sync: ${lastSync.timestamp})`);
    } else {
      console.log('First sync - fetching all logs');
    }

    return await this.syncAttendanceLogs(deviceIp, companyId, {
      startDate,
      endDate: null // Up to current date
    });
  }
}

module.exports = AttendanceSyncService;